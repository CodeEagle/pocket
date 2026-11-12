/**
 * Editor mini-application resource inventory and immutable build snapshots.
 *
 * The Editor owns the placement policy, but it does not own a second runtime
 * package format.  Every package below is produced by the pinned buildGuest
 * pipeline and every on-demand selection is passed to package_update.ts when
 * the signed package is published.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildGuest, type BuildGuestResult } from "../scripts/build_guest.ts";
import { parsePakLayout, type PakLayoutPart } from "../scripts/package_update.ts";
import { validateSystemFile, type ValidatedSystemPackage } from "../scripts/build_system.ts";

export const RESOURCE_POLICY_VERSION = 1 as const;
export const RESOURCE_POLICY_FILE = "pocket.resources.json" as const;
export const RESOURCE_SNAPSHOT_FILE = "resources.json" as const;

export type ResourcePlacement = "pak" | "network";
export type ResourceKind = "pak" | "asset";

export type ResourcePolicy = {
  version: typeof RESOURCE_POLICY_VERSION;
  packages: Record<string, { network: string[] }>;
};

export type ResourceEntry = {
  /** Editor-only immutable source thumbnail, relative to the package snapshot. */
  previewFile?: string;
  previewUrl?: string;
  key: string;
  kind: ResourceKind;
  bytes: number;
  placement: ResourcePlacement;
  locked?: boolean;
  reason?: string;
};

export type ResourcePackageInventory = {
  id: string;
  title: string;
  manifest: string;
  /** Relative to the immutable build revision directory. */
  artifactDirectory: string;
  version: string;
  build: number;
  runtimeAbi: string;
  resources: ResourceEntry[];
};

export type ResourceSnapshot = {
  version: typeof RESOURCE_POLICY_VERSION;
  revision: number;
  policy: ResourcePolicy;
  packages: ResourcePackageInventory[];
};

export type PublicResourceInventory = {
  revision: number;
  /** Last immutable build represented by the inventory; absent before first build. */
  builtRevision?: number;
  packages: Array<{
    id: string;
    title: string;
    manifest: string;
    resources: ResourceEntry[];
    updateUrl?: string;
    hostConfigUrl?: string;
  }>;
};

export type BuildResourceSnapshotOptions = {
  projectRoot: string;
  buildDirectory: string;
  revision: number;
  rootPackageId: string;
  rootTitle: string;
  rootManifest: string;
  rootVersion?: string;
  rootBuild?: number;
  rootRuntimeAbi?: string;
  tickHz: number;
  systemFile?: string;
  policyFile?: string;
  log?: (line: string) => void;
  /** Test-only injected runners may return opaque fixture bytes. */
  strictPak?: boolean;
};

const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const policyKeyPattern = /^(?:pak:.+|asset:.+)$/;
const protectedCatalogDirectories = new Set([".git", "node_modules", ".pocket-build", "build", "builds", "dist", "out", "updates", "keys"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safePackageDirectory(id: string): string {
  if (!appIdPattern.test(id)) throw new Error(`resource package id is unsafe: ${id}`);
  // Keep the directory name reversible and portable. App IDs already exclude
  // path separators, so no hashing or alias table is needed.
  return id;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function safeProjectPath(projectRoot: string, relativePath: string, mustExist = true): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("resource path must stay inside the project");
  }
  const rootStat = lstatSync(projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("resource project root must be a real directory");
  const rootReal = realpathSync(projectRoot);
  let current = resolve(projectRoot);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (mustExist) throw new Error(`resource path does not exist: ${normalized}`);
        return resolve(projectRoot, normalized);
      }
      throw error;
    }
    if (entry.isSymbolicLink()) throw new Error(`resource path contains a symbolic link: ${normalized}`);
    const real = realpathSync(current);
    if (!insideRoot(rootReal, real)) throw new Error("resource path escapes project through a symlink");
    if (index < parts.length - 1 && !entry.isDirectory()) throw new Error(`resource path parent is not a directory: ${normalized}`);
  }
  const final = resolve(projectRoot, normalized);
  const finalStat = lstatSync(final);
  if (mustExist && !finalStat.isFile()) throw new Error(`resource path is not a regular file: ${normalized}`);
  return final;
}

function safeArtifactDirectory(buildDirectory: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized === ".") {
    const rootStat = lstatSync(buildDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("resource build directory is not a real directory");
    if (!insideRoot(realpathSync(buildDirectory), realpathSync(buildDirectory))) throw new Error("resource build directory escapes workspace");
    return resolve(buildDirectory);
  }
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("resource artifact path is invalid");
  }
  const rootReal = realpathSync(buildDirectory);
  let current = resolve(buildDirectory);
  for (const part of parts) {
    current = join(current, part);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error(`resource artifact contains a symbolic link: ${normalized}`);
    if (!insideRoot(rootReal, realpathSync(current))) throw new Error("resource artifact escapes the build snapshot");
  }
  if (!lstatSync(current).isDirectory()) throw new Error("resource artifact directory is not a directory");
  return current;
}

function parsePolicy(value: unknown): ResourcePolicy {
  if (!isRecord(value)) throw new Error("pocket.resources.json must contain an object");
  if (value.version !== RESOURCE_POLICY_VERSION) throw new Error("pocket.resources.json version must be 1");
  if (!isRecord(value.packages)) throw new Error("pocket.resources.json packages must be an object");
  const packages: Record<string, { network: string[] }> = {};
  for (const [id, raw] of Object.entries(value.packages)) {
    if (!appIdPattern.test(id)) throw new Error(`pocket.resources.json package id is unsafe: ${id}`);
    if (!isRecord(raw)) throw new Error(`pocket.resources.json packages.${id} must be an object`);
    const keys = raw.network;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !policyKeyPattern.test(key))) {
      throw new Error(`pocket.resources.json packages.${id}.network must contain resource keys`);
    }
    const network = keys as string[];
    if (new Set(network).size !== network.length) throw new Error(`pocket.resources.json packages.${id}.network contains duplicates`);
    packages[id] = { network: [...network] };
  }
  return { version: RESOURCE_POLICY_VERSION, packages };
}

function emptyResourcePolicy(): ResourcePolicy {
  return { version: RESOURCE_POLICY_VERSION, packages: {} };
}

export async function readResourcePolicy(policyFile: string): Promise<ResourcePolicy> {
  try {
    const parsed = JSON.parse(await readFile(policyFile, "utf8")) as unknown;
    return parsePolicy(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyResourcePolicy();
    throw error;
  }
}

function policyNetwork(policy: ResourcePolicy, packageId: string): Set<string> {
  return new Set(policy.packages[packageId]?.network ?? []);
}

function applyPolicyToResources(resources: ResourceEntry[], network: Set<string>): ResourceEntry[] {
  return resources.map((resource) => {
    const selected = network.has(resource.key);
    if (selected && resource.locked) {
      throw new Error(`resource ${resource.key} is locked: ${resource.reason ?? "host-critical resource"}`);
    }
    return { ...resource, placement: selected ? "network" : "pak" };
  });
}

function resourceKeyForPakPart(part: PakLayoutPart): string {
  if (part.key !== undefined) return `pak:${part.key}`;
  return `pak:metadata:${part.offset}`;
}

async function listLooseAssets(directory: string): Promise<Array<{ key: string; bytes: number }>> {
  const result: Array<{ key: string; bytes: number }> = [];
  if (!existsSync(directory)) return result;
  const rootStat = lstatSync(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("resource assets directory must be a real directory");
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      const logical = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`resource asset contains a symbolic link: ${logical}`);
      if (entry.isDirectory()) {
        await walk(next, logical);
      } else if (entry.isFile()) {
        result.push({ key: `asset:assets/${logical.replaceAll("\\", "/")}`, bytes: (await stat(next)).size });
      } else {
        throw new Error(`resource asset is not a regular file: ${logical}`);
      }
    }
  };
  await walk(directory, "");
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

async function scanPackageResources(directory: string, policy: ResourcePolicy, packageId: string, strictPak = true): Promise<ResourceEntry[]> {
  const pakPath = join(directory, "app.pak");
  const pak = new Uint8Array(await readFile(pakPath));
  let layout: PakLayoutPart[];
  try {
    layout = parsePakLayout(pak);
  } catch (error) {
    if (strictPak) throw error;
    // Existing Editor unit fixtures inject opaque PAK bytes to exercise state
    // transitions. Production realBuild always leaves strictPak enabled.
    layout = [];
  }
  const resources: ResourceEntry[] = [];
  // Directory metadata precedes most blobs in the canonical layout. Present
  // selectable image entries first so the inventory is useful at a glance;
  // metadata remains visible and locked at the end.
  for (const part of [...layout.filter((item) => item.kind === "blob"), ...layout.filter((item) => item.kind === "metadata")]) {
    const key = resourceKeyForPakPart(part);
    const isImage = part.kind === "blob" && typeof part.key === "string" && part.key.startsWith("ui:img.");
    const locked = !isImage;
    resources.push({
      key,
      kind: "pak",
      bytes: part.size,
      placement: "pak",
      ...(locked ? { locked: true, reason: part.kind === "metadata" ? "PAK metadata is required for package integrity" : part.key?.startsWith("ui:font.") ? "font resources are required for text rendering" : "this PAK entry is required by the runtime" } : {}),
    });
  }
  for (const asset of await listLooseAssets(join(directory, "assets"))) {
    resources.push({ key: asset.key, kind: "asset", bytes: asset.bytes, placement: "pak" });
  }
  const known = new Set(resources.map((resource) => resource.key));
  const configured = policyNetwork(policy, packageId);
  for (const key of configured) {
    if (!known.has(key)) throw new Error(`resource policy references unknown resource ${packageId}/${key}`);
  }
  return applyPolicyToResources(resources, configured);
}

async function copyAssetTree(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return;
  const rootStat = lstatSync(source);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`resource assets path is unsafe: ${source}`);
  await mkdir(destination, { recursive: true });
  const walk = async (current: string, target: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const from = join(current, entry.name);
      const to = join(target, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`resource asset contains a symbolic link: ${from}`);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true });
        await walk(from, to);
      } else if (entry.isFile()) {
        await cp(from, to);
      } else {
        throw new Error(`resource asset is not a regular file: ${from}`);
      }
    }
  };
  await walk(source, destination);
}

const LIVE2D_CATALOG_FILENAME = "novel.native-assets.json" as const;
const LIVE2D_MAX_MODEL_BYTES = 32 * 1024 * 1024;
const live2dBundlePathPattern = /^native-models\/([a-f0-9]{64})\.moc3$/;

function live2dAssetKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid Live2D native asset key: ${String(value)}`);
  }
  return value;
}

/**
 * Copy only `buildGuest`'s validated `novel.native-assets.json` catalog and
 * its allowlisted `native-models/<sha256>.moc3` files into an immutable
 * package snapshot or preview staging directory.
 */
export async function copyBuiltNativeModels(
  sourceDirectory: string,
  destinationDirectory: string,
  confinementRoot = sourceDirectory,
): Promise<void> {
  const catalogPath = join(sourceDirectory, LIVE2D_CATALOG_FILENAME);
  let catalogStat: ReturnType<typeof lstatSync>;
  try {
    catalogStat = lstatSync(catalogPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (catalogStat.isSymbolicLink() || !catalogStat.isFile()) {
    throw new Error(`${LIVE2D_CATALOG_FILENAME} is not a regular file: ${catalogPath}`);
  }
  const canonicalRoot = realpathSync(confinementRoot);
  const catalogReal = realpathSync(catalogPath);
  if (catalogReal !== canonicalRoot && !catalogReal.startsWith(canonicalRoot + sep)) {
    throw new Error(`${LIVE2D_CATALOG_FILENAME} escapes package root: ${catalogPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${LIVE2D_CATALOG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.assets)) {
    throw new Error(`invalid ${LIVE2D_CATALOG_FILENAME}; expected { version: 1, assets: Record<string, string> }`);
  }
  const sourceModelsDir = join(sourceDirectory, "native-models");
  try {
    const dirStat = lstatSync(sourceModelsDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`native-models is not a regular directory: ${sourceModelsDir}`);
    }
    const dirReal = realpathSync(sourceModelsDir);
    if (dirReal !== canonicalRoot && !dirReal.startsWith(canonicalRoot + sep)) {
      throw new Error(`native-models escapes package root: ${sourceModelsDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const assets: Record<string, string> = Object.create(null);
  const copied = new Set<string>();
  await mkdir(join(destinationDirectory, "native-models"), { recursive: true });
  for (const [rawKey, rawPath] of Object.entries(parsed.assets)) {
    const key = live2dAssetKey(rawKey);
    const match = typeof rawPath === "string" ? live2dBundlePathPattern.exec(rawPath) : null;
    if (!match) {
      throw new Error(`${LIVE2D_CATALOG_FILENAME} contains a non-allowlisted Live2D native model path for ${key}`);
    }
    const relativePath = rawPath as string;
    const expectedHash = match[1]!;
    assets[key] = relativePath;
    if (copied.has(relativePath)) continue;
    const modelSource = join(sourceDirectory, relativePath);
    let modelStat: ReturnType<typeof lstatSync>;
    try {
      modelStat = lstatSync(modelSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`allowlisted Live2D model is missing: ${modelSource}`);
      }
      throw error;
    }
    if (modelStat.isSymbolicLink() || !modelStat.isFile()) {
      throw new Error(`allowlisted Live2D model is not a regular file: ${modelSource}`);
    }
    const modelReal = realpathSync(modelSource);
    if (!modelReal.startsWith(canonicalRoot + sep)) {
      throw new Error(`allowlisted Live2D model escapes package root: ${modelSource}`);
    }
    if (modelStat.size > LIVE2D_MAX_MODEL_BYTES) {
      throw new Error(`allowlisted Live2D model exceeds 32 MiB: ${modelSource}`);
    }
    const bytes = new Uint8Array(await readFile(modelSource));
    if (bytes.byteLength > LIVE2D_MAX_MODEL_BYTES || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new Error(`allowlisted Live2D model hash mismatch: ${modelSource}`);
    }
    await writeFile(join(destinationDirectory, relativePath), bytes);
    copied.add(relativePath);
  }
  await writeFile(
    join(destinationDirectory, LIVE2D_CATALOG_FILENAME),
    `${JSON.stringify({ version: 1, assets }, null, 2)}\n`,
  );
}

async function copyBuiltPackage(source: BuildGuestResult, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const copy = async (name: string, sourcePath: string | undefined): Promise<void> => {
    if (sourcePath && existsSync(sourcePath)) await cp(sourcePath, join(destination, name));
  };
  await copy("app.js", source.source);
  await copy("app.pak", source.pak);
  await copy("app.qjbc", source.bytecode);
  await copy("app.bytecode.json", source.metadata);
  await copy("guest-manifest.json", join(source.outDir, "guest-manifest.json"));
  await copy("app.worker.qjbc", source.worker?.bytecode);
  await copy("app.worker.bytecode.json", source.worker?.metadata);
  await copyBuiltNativeModels(source.outDir, destination);
}

function packageTitle(entry: ValidatedSystemPackage | undefined, fallback: string, id: string): string {
  const title = entry?.manifest && isRecord(entry.manifest) && typeof (entry.manifest as Record<string, unknown>).title === "string"
    ? String((entry.manifest as Record<string, unknown>).title).trim()
    : "";
  return title || fallback || id;
}

function packageBuildIdentity(directory: string, fallback?: { version?: string; build?: number; runtimeAbi?: string }): { version: string; build: number; runtimeAbi: string } {
  const metadata = JSON.parse(readFileSync(join(directory, "app.bytecode.json"), "utf8")) as Record<string, unknown>;
  const runtimeAbi = typeof metadata.runtimeAbi === "string" && metadata.runtimeAbi ? metadata.runtimeAbi : fallback?.runtimeAbi;
  const version = typeof metadata.version === "string" && metadata.version ? metadata.version : fallback?.version;
  const build = Number.isSafeInteger(metadata.build) && Number(metadata.build) >= 1 ? Number(metadata.build) : fallback?.build;
  if (!runtimeAbi) throw new Error(`resource package metadata has no runtimeAbi: ${directory}`);
  if (!version) throw new Error(`resource package metadata has no version: ${directory}`);
  if (!Number.isSafeInteger(build) || Number(build) < 1) throw new Error(`resource package metadata has no valid build: ${directory}`);
  return { version, build: Number(build), runtimeAbi };
}

function validateCatalogSource(projectRoot: string, source: string): string {
  const normalized = source.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const leaf = segments.at(-1) ?? "";
  if (segments.some((segment) => protectedCatalogDirectories.has(segment.toLowerCase()))) {
    throw new Error(`catalog manifest path is in a protected directory: ${source}`);
  }
  if (/^(?:editor(?:-state)?|host|payload|latest|signed-manifest|build|private|secret)\.json$/i.test(leaf) || /\.(?:pem|key|qjbc|pak|tar|gz)$/i.test(leaf)) {
    throw new Error(`catalog manifest path is protected: ${source}`);
  }
  const manifestPath = safeProjectPath(projectRoot, source, true);
  if (!lstatSync(manifestPath).isFile()) throw new Error(`catalog manifest is not a regular file: ${source}`);
  return manifestPath;
}

export async function loadValidatedResourceCatalog(projectRoot: string, systemFile: string): Promise<ValidatedSystemPackage[]> {
  const systemRelative = relative(projectRoot, resolve(systemFile)).replaceAll("\\", "/");
  const systemPath = validateCatalogSource(projectRoot, systemRelative);
  // The pinned validator reads catalog manifests itself. Establish the
  // Editor's no-symlink/in-project boundary before handing it that input.
  const rawSystem = JSON.parse(readFileSync(systemPath, "utf8")) as Record<string, unknown>;
  const rawApplications = isRecord(rawSystem.applications) ? rawSystem.applications : undefined;
  const rawCatalog = rawApplications?.catalog;
  if (Array.isArray(rawCatalog)) {
    for (const rawEntry of rawCatalog) {
      if (isRecord(rawEntry) && typeof rawEntry.manifest === "string") validateCatalogSource(projectRoot, rawEntry.manifest);
    }
  }
  const validated = await validateSystemFile(systemPath);
  if (!validated.ok) throw new Error(validated.diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`).join("; "));
  return [...validated.value.packages];
}

export async function buildResourceSnapshot(options: BuildResourceSnapshotOptions): Promise<ResourceSnapshot> {
  const projectRoot = resolve(options.projectRoot);
  const buildDirectory = resolve(options.buildDirectory);
  const policyFile = options.policyFile ?? safeProjectPath(projectRoot, RESOURCE_POLICY_FILE, false);
  const policy = await readResourcePolicy(policyFile);
  const catalog: ValidatedSystemPackage[] = [];
  if (options.systemFile) {
    catalog.push(...await loadValidatedResourceCatalog(projectRoot, options.systemFile));
  }

  let packages: Array<{ id: string; title: string; manifest: string; root: string; catalog?: ValidatedSystemPackage; isRoot: boolean }>;
  if (catalog.length > 0) {
    const rootEntry = catalog.find((entry) => entry.package === options.rootPackageId);
    if (!rootEntry) throw new Error(`pocket.system.json does not catalog root package ${options.rootPackageId}`);
    packages = catalog.map((entry) => ({
      id: entry.package,
      title: packageTitle(entry, entry.package === options.rootPackageId ? options.rootTitle : entry.package, entry.package),
      manifest: entry.source,
      root: dirname(validateCatalogSource(projectRoot, entry.source)),
      catalog: entry,
      isRoot: entry.package === options.rootPackageId,
    }));
  } else {
    packages = [{ id: options.rootPackageId, title: options.rootTitle, manifest: options.rootManifest, root: projectRoot, isRoot: true }];
  }

  const subpackagesRoot = join(buildDirectory, "subpackages");
  await mkdir(subpackagesRoot, { recursive: true });
  const inventories: ResourcePackageInventory[] = [];
  for (const packageInfo of packages) {
    const safeDir = safePackageDirectory(packageInfo.id);
    const artifactDirectory = packageInfo.isRoot ? "." : `subpackages/${safeDir}`;
    const target = packageInfo.isRoot ? buildDirectory : join(buildDirectory, artifactDirectory);
    await mkdir(target, { recursive: true });
    if (packageInfo.isRoot) {
      await copyAssetTree(join(projectRoot, "assets"), join(target, "assets"));
    } else {
      const temporary = await mkdtemp(join(tmpdir(), "pocket-editor-subpackage-"));
      try {
        options.log?.(`building catalog package ${packageInfo.id} from ${packageInfo.root}`);
        const built = await buildGuest({ projectRoot: packageInfo.root, outDir: temporary, tickHz: options.tickHz, log: options.log });
        await copyBuiltPackage(built, target);
        await copyAssetTree(join(packageInfo.root, "assets"), join(target, "assets"));
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const identity = packageBuildIdentity(target, packageInfo.isRoot
      ? { version: options.rootVersion, build: options.rootBuild, runtimeAbi: options.rootRuntimeAbi }
      : undefined);
    const resources = await scanPackageResources(target, policy, packageInfo.id, packageInfo.isRoot ? options.strictPak !== false : true);
    for (const [index, resource] of resources.entries()) {
      const source = resource.key.startsWith("pak:ui:img.") ? resource.key.slice("pak:ui:img.".length)
        : resource.kind === "asset" ? resource.key.slice("asset:".length) : undefined;
      if (!source || !/\.(png|svg|jpe?g|webp|gif)$/i.test(source)) continue;
      if (resource.kind === "asset") {
        // Loose assets already live in this immutable snapshot.
        if (resource.bytes <= 8 * 1024 * 1024) resource.previewFile = source;
        continue;
      }
      // Only project-owned images are copied. Compiler fallback assets do not
      // authorize reading arbitrary SDK or filesystem paths.
      if (!existsSync(join(packageInfo.root, source))) continue;
      const file = safeProjectPath(packageInfo.root, source);
      if ((await stat(file)).size > 8 * 1024 * 1024) continue;
      const extension = source.slice(source.lastIndexOf(".")).toLowerCase();
      resource.previewFile = `resource-previews/${index}${extension}`;
      await mkdir(join(target, "resource-previews"), { recursive: true });
      await cp(file, join(target, resource.previewFile));
    }
    inventories.push({
      id: packageInfo.id,
      title: packageInfo.title,
      manifest: packageInfo.manifest,
      artifactDirectory,
      ...identity,
      resources,
    });
  }

  const builtPackageIds = new Set(inventories.map((pkg) => pkg.id));
  for (const [packageId] of Object.entries(policy.packages)) {
    if (!builtPackageIds.has(packageId)) throw new Error(`resource policy references unknown package ${packageId}`);
  }

  const snapshot: ResourceSnapshot = {
    version: RESOURCE_POLICY_VERSION,
    revision: options.revision,
    policy: {
      version: RESOURCE_POLICY_VERSION,
      packages: Object.fromEntries(Object.entries(policy.packages).map(([id, value]) => [id, { network: [...value.network] }])),
    },
    packages: inventories,
  };
  // Preview must consume the catalog that was validated for this revision,
  // never a mutable source file that may have changed after build completes.
  if (options.systemFile) await cp(options.systemFile, join(buildDirectory, "pocket.system.json"));
  await writeFile(join(buildDirectory, RESOURCE_SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export async function readResourceSnapshot(path: string): Promise<ResourceSnapshot> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== RESOURCE_POLICY_VERSION || !Number.isSafeInteger(parsed.revision)) {
    throw new Error("invalid resource snapshot");
  }
  if (!Array.isArray(parsed.packages)) throw new Error("invalid resource snapshot packages");
  const policy = parsePolicy(parsed.policy);
  const packages = parsed.packages as ResourcePackageInventory[];
  const ids = new Set<string>();
  for (const pkg of packages) {
    if (!isRecord(pkg) || typeof pkg.id !== "string" || !appIdPattern.test(pkg.id) || ids.has(pkg.id)) throw new Error("invalid resource snapshot package id");
    ids.add(pkg.id);
    if (typeof pkg.artifactDirectory !== "string" || (pkg.artifactDirectory !== "." && !pkg.artifactDirectory.startsWith("subpackages/"))) throw new Error("invalid resource snapshot package directory");
    if (typeof pkg.title !== "string" || typeof pkg.manifest !== "string" || typeof pkg.version !== "string" ||
        !Number.isSafeInteger(pkg.build) || pkg.build < 1 || typeof pkg.runtimeAbi !== "string" || !pkg.runtimeAbi ||
        !Array.isArray(pkg.resources)) throw new Error(`invalid resource snapshot package: ${pkg.id}`);
    const resourceKeys = new Set<string>();
    for (const resource of pkg.resources) {
      if (!isRecord(resource) || typeof resource.key !== "string" || !policyKeyPattern.test(resource.key) || resourceKeys.has(resource.key) ||
          !["pak", "asset"].includes(String(resource.kind)) || !Number.isSafeInteger(resource.bytes) || Number(resource.bytes) < 0 ||
          !["pak", "network"].includes(String(resource.placement))) {
        throw new Error(`invalid resource snapshot resource: ${pkg.id}`);
      }
      if (resource.kind === "pak" && !resource.key.startsWith("pak:")) throw new Error(`resource kind/key mismatch: ${pkg.id}/${resource.key}`);
      if (resource.kind === "asset" && !resource.key.startsWith("asset:")) throw new Error(`resource kind/key mismatch: ${pkg.id}/${resource.key}`);
      if (resource.locked && resource.placement === "network") throw new Error(`locked resource is marked network: ${pkg.id}/${resource.key}`);
      resourceKeys.add(resource.key);
    }
  }
  validatePolicyForSnapshot({
    version: RESOURCE_POLICY_VERSION,
    revision: Number(parsed.revision),
    policy,
    packages,
  }, policy);
  return {
    version: RESOURCE_POLICY_VERSION,
    revision: Number(parsed.revision),
    policy,
    packages: packages.map((pkg) => ({
      ...pkg,
      resources: applyPolicyToResources(pkg.resources, policyNetwork(policy, pkg.id)),
    })),
  };
}

function validatePolicyForSnapshot(snapshot: ResourceSnapshot, policy: ResourcePolicy): void {
  const packages = new Map(snapshot.packages.map((pkg) => [pkg.id, pkg]));
  for (const [id, entry] of Object.entries(policy.packages)) {
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`resource policy references unknown package: ${id}`);
    const known = new Set(pkg.resources.map((resource) => resource.key));
    for (const key of entry.network) {
      if (!known.has(key)) throw new Error(`resource policy references unknown resource: ${id}/${key}`);
      const resource = pkg.resources.find((item) => item.key === key)!;
      if (resource.locked) throw new Error(`resource policy selects locked resource: ${id}/${key}`);
    }
  }
}

export function resourceInventory(
  snapshot: ResourceSnapshot,
  revision: number,
  policy = snapshot.policy,
  published?: ReadonlyArray<{ id: string; updateUrl: string; hostConfigUrl: string }>,
  builtRevision?: number,
): PublicResourceInventory {
  validatePolicyForSnapshot(snapshot, policy);
  const links = new Map((published ?? []).map((item) => [item.id, item]));
  return {
    revision,
    ...(builtRevision === undefined ? {} : { builtRevision }),
    packages: snapshot.packages.map((pkg) => ({
      id: pkg.id,
      title: pkg.title,
      manifest: pkg.manifest,
      resources: applyPolicyToResources(pkg.resources, policyNetwork(policy, pkg.id)),
      ...(links.has(pkg.id) ? { updateUrl: links.get(pkg.id)!.updateUrl, hostConfigUrl: links.get(pkg.id)!.hostConfigUrl } : {}),
    })),
  };
}

export function applyResourcePlacements(
  snapshot: ResourceSnapshot,
  policy: ResourcePolicy,
  packageId: string,
  placements: unknown,
): ResourcePolicy {
  if (!Array.isArray(placements)) throw new Error("placements must be an array");
  const pkg = snapshot.packages.find((item) => item.id === packageId);
  if (!pkg) throw new Error(`unknown resource package: ${packageId}`);
  const known = new Map(pkg.resources.map((resource) => [resource.key, resource]));
  const network = new Set(policyNetwork(policy, packageId));
  const seen = new Set<string>();
  for (const raw of placements) {
    if (!isRecord(raw) || typeof raw.key !== "string" || !["pak", "network"].includes(String(raw.placement))) {
      throw new Error("each placement must contain a resource key and placement pak|network");
    }
    if (seen.has(raw.key)) throw new Error(`duplicate placement: ${raw.key}`);
    seen.add(raw.key);
    const resource = known.get(raw.key);
    if (!resource) throw new Error(`unknown resource key: ${packageId}/${raw.key}`);
    if (raw.placement === "network") {
      if (resource.locked) throw new Error(`resource ${raw.key} is locked: ${resource.reason ?? "host-critical resource"}`);
      network.add(raw.key);
    } else {
      network.delete(raw.key);
    }
  }
  return {
    version: RESOURCE_POLICY_VERSION,
    packages: {
      ...policy.packages,
      [packageId]: { network: [...network].sort() },
    },
  };
}

export function resourcePackageNetwork(snapshot: ResourceSnapshot, packageId: string): { pak: string[]; assets: string[] } {
  const pkg = snapshot.packages.find((item) => item.id === packageId);
  if (!pkg) throw new Error(`unknown resource package: ${packageId}`);
  const resources = applyPolicyToResources(pkg.resources, policyNetwork(snapshot.policy, packageId));
  const pak: string[] = [];
  const assets: string[] = [];
  for (const resource of resources) {
    if (resource.placement !== "network") continue;
    if (resource.kind === "pak") pak.push(resource.key.slice("pak:".length));
    else assets.push(resource.key.slice("asset:".length));
  }
  return { pak, assets };
}

export function resourceArtifactDirectory(buildDirectory: string, pkg: ResourcePackageInventory): string {
  return safeArtifactDirectory(buildDirectory, pkg.artifactDirectory);
}

/**
 * Return the catalog shape before the first build. Editor's resource panel
 * needs package IDs/titles to render its controls, but it must not invent
 * byte counts or placements until a pinned build has produced a canonical
 * PAK snapshot.
 */
export async function emptyResourceInventory(options: {
  projectRoot: string;
  rootPackageId: string;
  rootTitle: string;
  revision: number;
  systemFile?: string;
}): Promise<PublicResourceInventory> {
  const projectRoot = resolve(options.projectRoot);
  const packages: Array<{ id: string; title: string; manifest: string }> = [];
  if (options.systemFile) {
    const catalog = await loadValidatedResourceCatalog(projectRoot, options.systemFile);
    for (const entry of catalog) {
      packages.push({ id: entry.package, title: packageTitle(entry, entry.package === options.rootPackageId ? options.rootTitle : entry.package, entry.package), manifest: entry.source });
    }
  } else {
    packages.push({ id: options.rootPackageId, title: options.rootTitle, manifest: "pocket.json" });
  }
  return {
    revision: options.revision,
    packages: packages.map((pkg) => ({ ...pkg, resources: [] })),
  };
}
