/**
 * Pocket Studio, the local editor service shipped with the Pocket SDK.
 *
 * This is intentionally a thin adapter around the checked-in PocketJS
 * compiler and the repository's signed-update packager.  It never turns a
 * source entry into a "bytecode" file by renaming/compressing it: every
 * publish goes through pocketjs_bytecode and package_update.ts with
 * entryFormat=quickjs-bytecode.
 */

import { constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync, watch as watchFs, type FSWatcher } from "node:fs";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  cp,
  open,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDevKey,
  packageArtifacts,
  pocketReleaseDirectory,
  sha256Hex,
  verifySignedManifest,
  type PackageResult,
  type PublicKeyConfig,
  type SignedManifest,
} from "../scripts/package_update.ts";
import { buildGuest } from "../scripts/build_guest.ts";
import { createStudioCodex, type StudioExecutionContext, type StudioScope } from "./codex.ts";
import { compositorSurfacesFromProject, createPreviewManager } from "./preview.ts";
import { handleNovelRoute, serveNovelLive2dCore } from "./novel.ts";
import { createNovelBackup } from "./novel-backups.ts";
import { createLocalBluetoothProvider } from "./local_bluetooth.ts";
import { previewDevice } from "./preview_device.ts";
import { createEditorDeviceManager, type DeploymentSnapshot } from "./devices.ts";
import { createWechatPreviewManager } from "./wechat.ts";
import { createStudioDiagnostics, handleDiagnosticsRequest } from "./diagnostics.ts";
import { createStudioUpgradeManager, readInstalledSdkInfo } from "../scripts/studio_upgrade.mjs";
import { resolveProjectTemplate } from "../scripts/project_templates.ts";
import { chooseUpdateHost, isLocalNetworkAddress, startUpdateEndpoint } from "./update_endpoint.ts";
import {
  currentVersion,
  emptyVersionHistory,
  newReleaseId,
  readVersionHistory,
  versionBranchKey,
  versionHistoryPath,
  writeVersionHistoryAtomic,
  type PublishedVersion,
  type PublishedVersionPackage,
  type PublishedVersionReusedPackage,
  type VersionHistory,
  type VersionSlot,
} from "./version_store.ts";
import {
  applyResourcePlacements,
  buildResourceSnapshot,
  copyBuiltNativeModels,
  emptyResourceInventory,
  loadValidatedResourceCatalog,
  readResourcePolicy,
  readResourceSnapshot,
  resourceArtifactDirectory,
  resourceInventory,
  resourcePackageNetwork,
  RESOURCE_POLICY_FILE,
  RESOURCE_SNAPSHOT_FILE,
} from "./resources.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const pocketNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const outputPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const frameworkPattern = /^(solid|vue-vapor|octane)$/;
const maxSourceBytes = 16 * 1024 * 1024;
const maxJsonBytes = 256 * 1024;
const maxAssetBytes = 32 * 1024 * 1024;

export type EditorConfig = {
  id: string;
  appId: string;
  name: string;
  title: string;
  version: string;
  build: number;
  tickHz: number;
  entry: string;
  output: string;
  framework: string;
  template: "app" | "game";
  reusePublishedPackages?: string[];
};

export type ArtifactInfo = {
  revision: number;
  generation?: string;
  appJs: string;
  bytecode: string;
  metadata: string;
  pak: string;
  manifest: string;
  build: string;
  resources: string;
};

export type BuildDiagnostic = {
  /** Project-relative, "/"-separated; never absolute. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  severity: "error" | "warning";
  message: string;
};

export type EditorStatus = {
  id: string;
  revision: number;
  builtRevision: number | null;
  busy: boolean;
  error?: string;
  /** Present only while `error` is set by a failed build. */
  diagnostics?: BuildDiagnostic[];
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  artifacts?: ArtifactInfo;
  publish?: {
    revision: number;
    updateUrl: string;
    manifestUrl: string;
    hostConfigUrl: string;
    archiveUrl: string;
    appConfigUrl?: string;
    keyId: string;
    runtimeAbi: string;
    payloadSha256: string;
    version?: string;
    build?: number;
    channel?: "test" | "release";
    hostVersion?: string;
    packageVersion?: string;
    lanOrigin?: string;
    releaseId?: string;
    publishedAt?: string;
    packages?: Array<{
      id: string;
      updateUrl: string;
      manifestUrl: string;
      hostConfigUrl: string;
      keyId: string;
      version: string;
      build: number;
    }>;
    reusedPackages?: PublishedVersionReusedPackage[];
  };
};

type BuildOutput = {
  appJs: string;
  pak: string;
  bytecode: string;
  metadata: string;
  runtimeAbi: string;
  bytecodeMetadata: Record<string, unknown>;
};

type BuildRunner = (input: {
  id: string;
  projectDir: string;
  outDir: string;
  config: EditorConfig;
  log: (line: string) => void;
  /** Aborts when the Studio user cancels the build. */
  signal?: AbortSignal;
}) => Promise<BuildOutput>;

export type StartEditorOptions = {
  host?: string;
  port?: number;
  /** Optional LAN interface for the read-only signed version backend. */
  updateHost?: string;
  updatePort?: number;
  /** Studio build timeout in ms (default 15 min; env POCKET_EDITOR_BUILD_TIMEOUT_MS). A hung build is aborted with "build timed out". */
  buildTimeoutMs?: number;
  /** Global budget for buffered (uncommitted) upload bytes (default 64 MiB). */
  maxBufferedUploadBytes?: number;
  /** Route segment used by the local version backend. Defaults to `editor`. */
  updateHostVersion?: string;
  /** Frozen compatibility branch used by the single App host URL. */
  updatePackageVersion?: string;
  workspace?: string;
  /** Edit/build one explicit external SDK project instead of copying guest/. */
  projectRoot?: string;
  /** Trusted Flutter consumer directory, bound to the configured JS project. */
  flutterRoot?: string;
  /** Optional SDK root override for Studio self-upgrade tests. */
  upgradeSdkRoot?: string;
  /** Optional Studio self-upgrade release/transport overrides for tests. */
  upgradeOptions?: Record<string, unknown>;
  /** Used by service tests; production always uses the real runner below. */
  buildRunner?: BuildRunner;
};

type EditorState = {
  revision: number;
  builtRevision: number | null;
  busy: boolean;
  error?: string;
  diagnostics?: BuildDiagnostic[];
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  artifacts?: ArtifactInfo;
  publish?: EditorStatus["publish"];
  /** Stable identity of a root-catalog source registered as this project. */
  sourceProjectIdentity?: string;
  novelBackup?: { intervalMinutes: number; lastRunAt?: string; lastBackupId?: string; error?: string };
  novelRestoreEpoch?: number;
};

type Workspace = {
  root: string;
  projects: string;
  builds: string;
  updates: string;
  keys: string;
  states: string;
  projectRoot?: string;
  projectId?: string;
  projectSources?: Map<string, CatalogProjectSource>;
};

type CatalogProjectSource = {
  root: string;
  appId: string;
  identity: string;
  parentProjectId?: string;
  sourceProjectTitle?: string;
  sourcePath?: string;
};

type CatalogProjectProvenance = Pick<CatalogProjectSource,
  "parentProjectId" | "sourceProjectTitle" | "sourcePath"> & { kind: "catalog-miniapp" };

type EditorServer = ReturnType<typeof Bun.serve>;

function now(): string {
  return new Date().toISOString();
}

function pubspecHostVersion(directory: string): string | undefined {
  try {
    const raw = readFileSync(join(directory, "pubspec.yaml"), "utf8");
    const match = raw.match(/^version:\s*([^\s#]+)\s*$/m);
    if (!match) return undefined;
    const version = match[1]!.split("+")[0]!;
    return appIdPattern.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function bytecodeAssetVersion(directory: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "assets", "app.bytecode.json"), "utf8")) as Record<string, unknown>;
    return typeof parsed.version === "string" && appIdPattern.test(parsed.version) ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function failure(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function asProjectId(value: unknown): string {
  const id = asString(value, "id", 48);
  if (!projectIdPattern.test(id)) throw new Error("id must match [a-z][a-z0-9-]{0,47}");
  return id;
}

function safeChild(parent: string, child: string): string {
  const resolved = resolve(parent, child);
  const rel = relative(resolve(parent), resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes workspace");
  return resolved;
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

type FileStat = ReturnType<typeof lstatSync>;

/**
 * `existsSync` follows symlinks and returns false for a dangling symlink. A
 * project editor must distinguish a missing path (which is valid for a first
 * write) from a symlink whose target has not been created yet.
 */
function lstatIfExists(path: string): FileStat | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function pathFailure(message: string, status = 400): never {
  const error = new Error(message);
  (error as unknown as { status: number }).status = status;
  throw error;
}

const editableFilePattern = /\.(?:ts|tsx|js|jsx|json|svg|css|md)$/i;
const protectedFilePattern = /^(?:editor(?:-state)?|pocket|pocket\.system|pocket\.resources|host|payload|latest|signed-manifest|build|app\.bytecode|private|secret)\.json$|\.(?:pem|key|qjbc|pak|tar|gz)$/i;
const protectedDirectoryNames = new Set(["assets", "builds", "updates", "keys", "node_modules", ".git", ".pocket-build"]);
// These directories are not consumer source inputs. In particular, a
// package-manager SDK link under node_modules and a generated build cache may
// legitimately point outside the project; neither is followed by the editor
// input scanner.
const ignoredProjectInputDirectories = new Set([
  "node_modules",
  ".git",
  ".pocket-build",
  "build",
  "builds",
  "dist",
  "out",
  "updates",
  "keys",
]);

function isAllowedExternalSdkLink(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/") === "vendor/pocket-ui";
}

type SafeProjectFileOptions = {
  allowAssets?: boolean;
  isDirectory?: boolean;
  allowProtected?: boolean;
  allowConfig?: boolean;
  mustExist?: boolean;
};

/**
 * Resolve a guest text file without following a symlink out of the project.
 * Build outputs, editor state, package keys and update artifacts are never
 * exposed through this API, even if a caller guesses their path.
 */
function safeProjectFile(projectDir: string, relativePath: string, options: SafeProjectFileOptions = {}): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const leaf = segments.at(-1) ?? "";
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((part) => !part || part === "." || part === "..")) {
    pathFailure("file path must stay inside the project");
  }
  const isConfigFile = leaf === "editor.json" || leaf === "pocket.json" || leaf === "pocket.system.json" || leaf === RESOURCE_POLICY_FILE;
  if (!options.allowAssets && !(options.allowConfig && isConfigFile) && segments.some((part) => protectedDirectoryNames.has(part.toLowerCase()))) {
    pathFailure("file is not an editable guest source file");
  }
  if (!options.allowProtected && !(options.allowConfig && isConfigFile) && protectedFilePattern.test(leaf)) {
    pathFailure("file is not an editable guest source file");
  }
  if (!options.isDirectory && !options.allowAssets && !(options.allowConfig && isConfigFile) && !editableFilePattern.test(leaf)) {
    pathFailure("file is not an editable guest source file");
  }

  const resolved = safeChild(projectDir, normalized);
  const projectStat = lstatIfExists(projectDir);
  if (!projectStat) pathFailure("project directory does not exist", 404);
  if (projectStat.isSymbolicLink()) pathFailure("project directory must not be a symlink");
  if (!projectStat.isDirectory()) pathFailure("project path is not a directory");
  const projectReal = realpathSync(projectDir);

  let currentPath = resolve(projectDir);
  let deepestExistingAncestor = projectReal;

  for (const [index, segment] of segments.entries()) {
    const nextPath = join(currentPath, segment);
    const entry = lstatIfExists(nextPath);
    if (!entry) {
      if (!isInside(projectReal, deepestExistingAncestor)) pathFailure("file path escapes project through a symlink");
      currentPath = nextPath;
      continue;
    }
    // lstat(), unlike existsSync(), sees dangling links. Never treat one as a
    // permissible first-write path.
    if (entry.isSymbolicLink()) pathFailure(`symbolic links are not allowed: ${segment}`);
    const realNext = realpathSync(nextPath);
    if (!isInside(projectReal, realNext)) pathFailure("file path escapes project through a symlink");
    if (index < segments.length - 1 && !entry.isDirectory()) pathFailure("project path parent is not a directory");
    currentPath = nextPath;
    deepestExistingAncestor = realNext;
  }

  const finalEntry = lstatIfExists(resolved);
  if (finalEntry) {
    if (finalEntry.isSymbolicLink()) pathFailure("symbolic links are not allowed");
    if (!isInside(projectReal, realpathSync(resolved))) pathFailure("file path escapes project through a symlink");
    if (options.isDirectory) {
      if (!finalEntry.isDirectory()) pathFailure("path is not a directory");
    } else {
      if (!finalEntry.isFile()) pathFailure("project file is not a regular file");
    }
  } else if (options.mustExist) {
    pathFailure("file not found", 404);
  }

  return resolved;
}

/**
 * Create project parents only after the path has passed the lstat boundary,
 * then re-check them. The final open uses O_NOFOLLOW so a static leaf symlink
 * cannot redirect the write. A hostile same-UID process can still race a
 * string-path parent replacement between these syscalls; eliminating that
 * class requires directory-fd traversal and is intentionally outside this
 * local editor's compatibility-preserving patch.
 */
async function writeProjectFile(
  projectDir: string,
  relativePath: string,
  contents: string | Uint8Array,
  options: SafeProjectFileOptions = {},
): Promise<void> {
  const initialPath = safeProjectFile(projectDir, relativePath, options);
  await mkdir(dirname(initialPath), { recursive: true });
  const filePath = safeProjectFile(projectDir, relativePath, options);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow;
  const handle = await open(filePath, flags, 0o644);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Verify that the final path is still a regular in-project file after the
  // write. This also catches a platform that lacks O_NOFOLLOW.
  safeProjectFile(projectDir, relativePath, options);
}

function safeArtifactFile(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((part) => !part || part === "." || part === "..")) {
    const err = new Error("invalid artifact path");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  let resolved: string;
  try {
    resolved = safeChild(rootDir, normalized);
  } catch {
    const err = new Error("artifact path escapes workspace");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (!existsSync(rootDir)) {
    const err = new Error("artifact directory does not exist");
    (err as unknown as { status: number }).status = 404;
    throw err;
  }
  if (lstatSync(rootDir).isSymbolicLink()) {
    const err = new Error("symbolic links are not allowed");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  const rootReal = realpathSync(rootDir);

  let currentPath = resolve(rootDir);
  for (const segment of segments) {
    const nextPath = join(currentPath, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(nextPath);
    } catch {
      const err = new Error("artifact not found");
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    if (entry.isSymbolicLink()) {
      const err = new Error(`symbolic links are not allowed: ${segment}`);
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    if (!existsSync(nextPath)) {
      const err = new Error("artifact not found");
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    const realNext = realpathSync(nextPath);
    if (!isInside(rootReal, realNext)) {
      const err = new Error("artifact path escapes workspace through a symlink");
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    currentPath = nextPath;
  }

  const finalEntry = lstatSync(resolved);
  if (!finalEntry.isFile()) {
    const err = new Error("artifact is not a regular file");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }

  return resolved;
}

function versionSlot(channel: "test" | "release"): VersionSlot {
  return channel === "test" ? "test" : "stable";
}

function compatibilityVersion(value: string): string {
  const testSuffix = value.match(/^(.*)-test\.[0-9]+$/);
  return testSuffix?.[1] || value;
}

function legacySemanticRouteVersion(version: string, build: number, slot: VersionSlot): string {
  return slot === "stable" ? `${version}-build.${build}` : version;
}

function legacyPayloadMatchesRoute(payload: Record<string, unknown>, routeVersion: string): boolean {
  if (payload.version === routeVersion) return true;
  const build = Number(payload.build);
  return typeof payload.version === "string" && Number.isSafeInteger(build) && build >= 0 &&
    `${payload.version}-build.${build}` === routeVersion;
}

function channelUpdatePrefix(channel: "test" | "release"): string {
  return channel === "test" ? "test" : "stable";
}

function updateNamespace(projectId: string, hostVersion: string, compatVersion: string, channel: "test" | "release", releaseId?: string): string {
  const material = `${projectId}\n${hostVersion}\n${compatVersion}\n${channel}\n${releaseId ?? "branch"}`;
  return `editor_${sha256Hex(new TextEncoder().encode(material)).slice(0, 24)}`;
}

function packageArtifactRoot(workspace: Workspace, projectId: string, releaseId: string, hostVersion: string, packageId: string, packageVersion: string): string {
  return relative(
    workspace.updates,
    pocketReleaseDirectory(join(workspace.updates, ".history", projectId, releaseId), hostVersion, packageId, packageVersion),
  ).replaceAll("\\", "/");
}

function historyPackagePath(hostVersion: string, packageId: string, releaseId: string): string {
  return `/pocket/${hostVersion}/${encodeURIComponent(packageId)}/${releaseId}`;
}

function semanticPayload(payload: Record<string, unknown>): string {
  const { signedAt: _signedAt, ...withoutSigningTime } = payload;
  return JSON.stringify(withoutSigningTime);
}

function payloadsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return semanticPayload(left) === semanticPayload(right);
}

function resultFromPublishedDirectory(directory: string): PackageResult {
  const payload = JSON.parse(readFileSync(join(directory, "payload.json"), "utf8")) as PackageResult["payload"];
  const envelope = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")) as PackageResult["envelope"];
  return {
    payload,
    envelope,
    payloadBytes: Buffer.from(envelope.payload, "base64"),
    manifestPath: join(directory, "latest.json"),
    bundlePath: existsSync(join(directory, "bundle.7z")) ? join(directory, "bundle.7z") : undefined,
    pakParts: payload.pak.parts as PackageResult["pakParts"],
  };
}

async function rewriteImmutableHostConfig(file: string, hostVersion: string, packageId: string, slot: VersionSlot, releaseId: string, channelBaseUrl?: string): Promise<void> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const oldPrefix = `/pocket/${hostVersion}/${encodeURIComponent(packageId)}/${slot}/`;
  const newPrefix = `/pocket/${hostVersion}/${encodeURIComponent(packageId)}/${releaseId}/`;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll(oldPrefix, newPrefix);
    if (Array.isArray(value)) return value.map(rewrite);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  const rewritten = rewrite(raw) as Record<string, unknown>;
  if (typeof rewritten.POCKET_PACKAGE_VERSION === "string") rewritten.POCKET_PACKAGE_VERSION = releaseId;
  if (channelBaseUrl && typeof rewritten.POCKET_UPDATE_BASE_URL === "string") rewritten.POCKET_UPDATE_BASE_URL = channelBaseUrl;
  if (channelBaseUrl && isObject(rewritten.config) && isObject(rewritten.config.updates)) rewritten.config.updates.baseUrl = channelBaseUrl;
  if (isObject(rewritten.config) && isObject(rewritten.config.updates)) rewritten.config.updates.packageVersion = releaseId;
  await writeFile(file, JSON.stringify(rewritten, null, 2) + "\n");
}

type AggregateHostPackage = Record<string, unknown>;

/**
 * Build the one host descriptor consumed by an App. The old flat POCKET_*
 * keys remain at the top level for the existing Flutter updater; structured
 * fields are the source of truth for SystemUI and mini apps.
 */
function aggregateHostConfig(input: {
  rootHost: Record<string, unknown>;
  hostVersion: string;
  rootAppId: string;
  version: string;
  build: number;
  compatVersion: string;
  channel: "test" | "release";
  slot: VersionSlot;
  routeVersion: string;
  releaseId: string | null;
  branchNamespace?: string;
  packages: AggregateHostPackage[];
  hostVersionSource?: string;
  compositorSurfaces?: Record<string, number>;
}): Record<string, unknown> {
  const rootPackage = input.packages.find((pkg) => pkg.id === input.rootAppId);
  const baseUrl = typeof input.rootHost.POCKET_UPDATE_BASE_URL === "string"
    ? input.rootHost.POCKET_UPDATE_BASE_URL
    : undefined;
  const keyId = typeof input.rootHost.POCKET_UPDATE_KEY_ID === "string" ? input.rootHost.POCKET_UPDATE_KEY_ID : "";
  const publicKey = typeof input.rootHost.POCKET_UPDATE_PUBLIC_KEY === "string" ? input.rootHost.POCKET_UPDATE_PUBLIC_KEY : "";
  const packageVersion = typeof rootPackage?.packageVersion === "string"
    ? rootPackage.packageVersion
    : typeof input.rootHost.POCKET_PACKAGE_VERSION === "string"
      ? input.rootHost.POCKET_PACKAGE_VERSION
      : input.slot;
  const namespace = typeof input.rootHost.POCKET_STORE_NAMESPACE === "string"
    ? input.rootHost.POCKET_STORE_NAMESPACE
    : `editor_${input.rootAppId}`;
  const updates = {
    baseUrl,
    hostVersion: input.hostVersion,
    packageVersion,
    keyId,
    publicKey,
    namespace,
    ...(typeof input.rootHost.POCKET_UPDATE_DEBUG_HTTP_HOST === "string"
      ? { debugHttpHosts: [input.rootHost.POCKET_UPDATE_DEBUG_HTTP_HOST] }
      : {}),
  };
  const applications: Record<string, AggregateHostPackage> = {};
  for (const pkg of input.packages) {
    const descriptor = { ...pkg, role: pkg.id === input.rootAppId ? "systemUI" : "miniapp" };
    applications[String(pkg.id)] = descriptor;
  }
  const compositorSurfaces = input.compositorSurfaces
    ? Object.fromEntries(
      Object.entries(input.compositorSurfaces).filter(([appId]) => appId !== input.rootAppId && Object.hasOwn(applications, appId)),
    )
    : undefined;
  return {
    ...input.rootHost,
    schemaVersion: 1,
    kind: "pocket-editor-app-host",
    ...(input.hostVersionSource ? { hostVersionSource: input.hostVersionSource } : {}),
    systemUI: input.rootAppId,
    release: {
      appId: input.rootAppId,
      version: input.version,
      build: input.build,
      ...(typeof rootPackage?.rootPayloadSha256 === "string" ? { rootPayloadSha256: rootPackage.rootPayloadSha256 } : {}),
      compatVersion: input.compatVersion,
      channel: input.channel,
      slot: input.slot,
      routeVersion: input.routeVersion,
      releaseId: input.releaseId,
      ...(input.branchNamespace ? { branchNamespace: input.branchNamespace } : {}),
    },
    updates,
    applications,
    ...(compositorSurfaces ? { compositorSurfaces } : {}),
  };
}

async function listEditableFiles(projectDir: string): Promise<Array<{ path: string; bytes: number }>> {
  await validateProjectInputTree(projectDir);
  const result: Array<{ path: string; bytes: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoredProjectInputDirectories.has(entry.name)) continue;
      if (entry.name === "assets") {
        if (entry.isSymbolicLink()) pathFailure("project contains unsupported source symlink: assets");
        continue;
      }
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const filePath = join(directory, entry.name);
      const relativePath = relative(projectDir, filePath).replaceAll("\\", "/");
      if (entry.isSymbolicLink() && isAllowedExternalSdkLink(relativePath)) continue;
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile() && editableFilePattern.test(entry.name) && !protectedFilePattern.test(entry.name)) {
        // Reuse the same symlink/path policy used for reads and writes.
        safeProjectFile(projectDir, relativePath);
        result.push({ path: relativePath, bytes: (await stat(filePath)).size });
      } else if (entry.isSymbolicLink()) {
        throw new Error(`project contains unsupported source symlink: ${entry.name}`);
      }
    }
  };
  await walk(projectDir);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Validate the project-local source/assets tree that Editor treats as input.
 * node_modules and the explicit vendor/pocket-ui package boundary are trusted
 * dependencies and are not traversed; generated build/cache directories are
 * not traversed either. This is not a JavaScript dependency-graph sandbox:
 * build_guest/compiler resolution of external imports remains its existing
 * local-development behavior. Assets are scanned separately because they are
 * runtime inputs, and a nested dangling link there is still unsafe.
 */
async function validateProjectInputTree(projectDir: string): Promise<void> {
  const walk = async (directory: string, insideAssets: boolean): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      const relativePath = relative(projectDir, filePath).replaceAll("\\", "/");

      if (!insideAssets && (ignoredProjectInputDirectories.has(entry.name) || /^\.pocket-ui-backup-[A-Za-z0-9]+$/.test(entry.name))) {
        // node_modules is an explicit package-manager dependency boundary; a
        // symlinked package tree there is allowed and is handled by
        // build_guest. Build/cache directories are not dependency boundaries,
        // so do not let a directory symlink hide a source tree from this
        // editor check.
        if (entry.isSymbolicLink() && entry.name !== "node_modules") {
          pathFailure(`project contains unsupported source symlink: ${relativePath}`);
        }
        continue;
      }
      if (!insideAssets && entry.name === "assets") {
        if (entry.isSymbolicLink()) pathFailure(`project contains unsupported asset symlink: ${relativePath} (symbolic links are not allowed)`);
        if (!entry.isDirectory()) pathFailure(`project asset path is not a directory: ${relativePath}`);
        await walk(filePath, true);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (insideAssets) pathFailure(`project contains unsupported asset symlink: ${relativePath} (symbolic links are not allowed)`);
        if (isAllowedExternalSdkLink(relativePath)) {
          // A valid external UI package is an explicit build_guest input. Do
          // not follow it here; build_guest handles its package boundary.
          try {
            realpathSync(filePath);
          } catch {
            pathFailure(`external SDK link is dangling: ${relativePath}`);
          }
          continue;
        }
        pathFailure(`project contains unsupported source symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await walk(filePath, insideAssets);
      } else if (!entry.isFile()) {
        pathFailure(`project contains unsupported input: ${relativePath}`);
      }
    }
  };
  await walk(projectDir, false);
}

async function readJsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}


const maxChunkBytes = 131072;
const maxOpenUploads = 8;
const maxOpenUploadsPerProject = 4;
const defaultMaxBufferedUploadBytes = 64 * 1024 * 1024;
const defaultBuildTimeoutMs = 15 * 60_000;
/** A stream whose consumer has this many unread events queued is dropped. */
const sseMaxQueuedEvents = 256;
const uploadIdleMs = 10 * 60_000;
const maxWatchClients = 16;
const maxBuildEventClients = 32;
const watchDebounceMs = 100;
const sha256Cache = new Map<string, string>();

/** New mutating routes never accept dot-prefixed segments (`.ssh`, `.env`, ...). */
function rejectHiddenSegments(relativePath: string): void {
  if (relativePath.replaceAll("\\", "/").split("/").some((part) => part.startsWith("."))) {
    pathFailure("hidden (dot-prefixed) path segments are not allowed", 400);
  }
}

function httpFailure(message: string, status: number): never {
  return pathFailure(message, status);
}

function parseNonNegativeInteger(value: unknown, label: string, fallback?: number): number {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    return httpFailure(`${label} is required`, 400);
  }
  const number = typeof value === "number" ? value : /^\d{1,16}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) return httpFailure(`${label} must be a non-negative integer`, 400);
  return number;
}

function decodeBase64Strict(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return httpFailure(`${label} must be canonical base64`, 400);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return httpFailure(`${label} must be canonical base64`, 400);
  return bytes;
}

function parseSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return httpFailure("sha256 must be 64 hex characters", 400);
  return value.toLowerCase();
}

/** Open a validated project file read-only without following a final symlink. */
async function openProjectFileForRead(path: string): Promise<import("node:fs/promises").FileHandle> {
  return open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
}

async function wholeFileSha256(handle: import("node:fs/promises").FileHandle, key: string): Promise<string> {
  const cached = sha256Cache.get(key);
  if (cached) return cached;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65536);
  for (let position = 0; ;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const digest = hash.digest("hex");
  if (sha256Cache.size >= 64) sha256Cache.delete(sha256Cache.keys().next().value!);
  sha256Cache.set(key, digest);
  return digest;
}

/** Cheap early filter: hidden and generated/protected trees never enter the pending map. */
function watchPathIgnored(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/").split("/").some((part) => part.startsWith(".") ||
    ignoredProjectInputDirectories.has(part.toLowerCase()) || protectedDirectoryNames.has(part.toLowerCase()));
}

/** Watch-event path filter: the same trees/files the Studio file API exposes. */
function watchablePath(projectDir: string, relativePath: string): { relativePath: string; kind: "file" | "directory" } | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || segments.some((part) => !part || part === "." || part === ".." || part.startsWith(".") ||
      ignoredProjectInputDirectories.has(part.toLowerCase()) || protectedDirectoryNames.has(part.toLowerCase()))) return undefined;
  const leaf = segments.at(-1)!;
  const editable = editableFilePattern.test(leaf) && !protectedFilePattern.test(leaf);
  const info = lstatIfExists(join(projectDir, normalized));
  try {
    if (!info) {
      // Already gone: classify by name. A dotted non-editable leaf was a file we never expose.
      if (editable) return { relativePath: normalized, kind: "file" };
      return leaf.includes(".") ? undefined : { relativePath: normalized, kind: "directory" };
    }
    if (info.isSymbolicLink()) return undefined;
    if (info.isDirectory()) {
      safeProjectFile(projectDir, normalized, { isDirectory: true });
      return { relativePath: normalized, kind: "directory" };
    }
    if (info.isFile() && editable) {
      safeProjectFile(projectDir, normalized);
      return { relativePath: normalized, kind: "file" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** @internal exported for tests. */
export function sseResponse(request: Request, attach: (send: (value: unknown) => void, close: () => void) => () => void): Response {
  const encoder = new TextEncoder();
  let detach: (() => void) | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        detach?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (value: unknown): void => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { close(); return; }
        // Slow consumer: the queue is full. Drop the subscriber instead of buffering without bound.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) close();
      };
      detach = attach(send, close);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      closed = true;
      detach?.();
    },
  }, new CountQueuingStrategy({ highWaterMark: sseMaxQueuedEvents }));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function parseJsonBody(request: Request, maxBytes = maxJsonBytes): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const err = new Error("unsupported media type: expected application/json");
    (err as unknown as { status: number }).status = 415;
    throw err;
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new Error("request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("request body is too large");
  const value: unknown = JSON.parse(raw || "{}");
  if (!isObject(value)) throw new Error("request body must be a JSON object");
  return value;
}

const readBody = parseJsonBody;

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await cp(from, to);
    else throw new Error(`template contains unsupported entry: ${entry.name}`);
  }
}

function defaultConfig(id: string, input: Record<string, unknown>): EditorConfig {
  const requestedName = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : id;
  // The current Flutter HostSession is intentionally a single app host. A
  // project can still opt into another app id explicitly, but a fresh
  // scaffold is immediately consumable by that host without extra edits.
  const appId = typeof input.appId === "string" && appIdPattern.test(input.appId) ? input.appId : "pocket.host.demo";
  const version = typeof input.version === "string" && versionPattern.test(input.version) ? input.version : "0.1.0";
  const build = Number.isSafeInteger(Number(input.build)) && Number(input.build) >= 1 ? Number(input.build) : 1;
  const tickHz = Number.isSafeInteger(input.tickHz) && Number(input.tickHz) >= 1 && Number(input.tickHz) <= 120 ? Number(input.tickHz) : 60;
  const entry = input.entry === undefined ? "app.tsx" : asString(input.entry, "entry", 256).trim();
  const output = input.output === undefined ? "app" : asString(input.output, "output", 128).trim();
  const framework = input.framework === undefined ? "solid" : asString(input.framework, "framework", 32).trim();
  const template = resolveProjectTemplate(input.template);
  return { id, appId, name: requestedName, title: requestedName, version, build, tickHz, entry, output, framework, template };
}

function validateConfig(id: string, input: Record<string, unknown>): EditorConfig {
  const config = defaultConfig(id, input);
  if (typeof input.appId !== "undefined" && !appIdPattern.test(config.appId)) throw new Error("appId contains unsafe characters");
  if (typeof input.version !== "undefined" && !versionPattern.test(config.version)) throw new Error("version contains unsafe characters");
  if (typeof input.name !== "undefined") config.name = asString(input.name, "name", 160).trim();
  if (!config.name) throw new Error("name must not be empty");
  if (typeof input.title !== "undefined") config.title = asString(input.title, "title", 160).trim();
  if (!config.title) throw new Error("title must not be empty");
  if (typeof input.appId === "string" && !appIdPattern.test(input.appId)) throw new Error("appId contains unsafe characters");
  if (typeof input.version === "string" && !versionPattern.test(input.version)) throw new Error("version contains unsafe characters");
  if (input.build !== undefined && (!Number.isSafeInteger(Number(input.build)) || Number(input.build) < 1)) {
    const err = new Error("build must be a positive safe integer");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (input.tickHz !== undefined && (!Number.isSafeInteger(input.tickHz) || Number(input.tickHz) < 1 || Number(input.tickHz) > 120)) throw new Error("tickHz must be an integer from 1 through 120");
  if (input.reusePublishedPackages !== undefined) {
    if (!Array.isArray(input.reusePublishedPackages) || input.reusePublishedPackages.some((packageId) => typeof packageId !== "string" || !appIdPattern.test(packageId))) {
      throw new Error("reusePublishedPackages must be an array of valid package IDs");
    }
    const packageIds = input.reusePublishedPackages as string[];
    if (new Set(packageIds).size !== packageIds.length) throw new Error("reusePublishedPackages cannot contain duplicate package IDs");
    config.reusePublishedPackages = [...packageIds];
  }
  if (!config.entry || isAbsolute(config.entry) || config.entry.includes("\0") || config.entry.split(/[\\/]+/).includes("..")) throw new Error("entry must be a project-relative path");
  if (!outputPattern.test(config.output)) throw new Error("output contains unsafe characters");
  if (!frameworkPattern.test(config.framework)) throw new Error("framework is unsupported");
  config.appId = typeof input.appId === "string" ? input.appId : config.appId;
  config.version = typeof input.version === "string" ? input.version : config.version;
  config.build = input.build === undefined ? config.build : Number(input.build);
  config.tickHz = input.tickHz === undefined ? config.tickHz : Number(input.tickHz);
  config.title = typeof input.title === "string" ? input.title.trim() : config.name;
  if (config.reusePublishedPackages?.includes(config.appId)) throw new Error("the root app cannot reuse its own published package");
  return config;
}

async function loadConfig(projectDir: string, id: string): Promise<EditorConfig> {
  const editorPath = safeProjectFile(projectDir, "editor.json", { allowConfig: true });
  // Editor release identity is authoritative when present, while the Pocket
  // app object remains the runtime source for entry/output/framework. Both
  // config paths are validated before either one is read.
  const pocketPath = safeProjectFile(projectDir, "pocket.json", { allowConfig: true });
  const editor = await readJsonFile<Record<string, unknown>>(editorPath, {});
  const pocket = await readJsonFile<Record<string, unknown>>(pocketPath, {});
  const app = isObject(pocket.app) ? pocket.app : {};
  const release = [editor, pocket].find((value) => Object.hasOwn(value, "version") || Object.hasOwn(value, "build")) ?? {};
  return validateConfig(id, {
    ...editor,
    id,
    // pocket.json is the runtime contract; use its app identity and app
    // fields when present, while editor.json remains authoritative for the
    // release identity (version/build).
    appId: typeof editor.appId === "string" ? editor.appId : pocket.id,
    name: typeof pocket.title === "string" && pocket.title.trim()
      ? pocket.title
      : typeof editor.title === "string" && editor.title.trim()
        ? editor.title
        : typeof editor.name === "string" && editor.name.trim()
          ? editor.name
          : pocket.name,
    title: typeof pocket.title === "string" && pocket.title.trim() ? pocket.title : editor.title ?? editor.name ?? pocket.name,
    version: release.version,
    build: release.build,
    tickHz: editor.tickHz ?? 60,
    entry: typeof app.entry === "string" ? app.entry : editor.entry,
    output: typeof app.output === "string" ? app.output : editor.output,
    framework: typeof app.framework === "string" ? app.framework : editor.framework,
  });
}

async function loadCatalogProjectSources(
  projectRoot: string,
  rootProjectId: string,
  existingProjectsDirectory: string,
): Promise<Map<string, CatalogProjectSource>> {
  if (!existsSync(join(projectRoot, "pocket.system.json"))) return new Map();
  const systemPath = safeProjectFile(projectRoot, "pocket.system.json", { allowConfig: true });
  const catalog = await loadValidatedResourceCatalog(projectRoot, systemPath);
  const rootConfig = await loadConfig(projectRoot, rootProjectId);
  const sources = new Map<string, CatalogProjectSource>();
  const ambiguous = new Set<string>();
  const canonicalProjectRoot = realpathSync(projectRoot);
  for (const entry of catalog) {
    if (entry.package === rootConfig.appId || !rootConfig.reusePublishedPackages?.includes(entry.package)) continue;
    const packageRoot = dirname(entry.path);
    let editor: Record<string, unknown> = {};
    try {
      editor = await readJsonFile<Record<string, unknown>>(safeProjectFile(packageRoot, "editor.json", { allowConfig: true }), {});
    } catch {
      // Catalog packages normally have only pocket.json until first edited.
    }
    const candidateName = typeof editor.id === "string"
      ? editor.id
      : typeof entry.manifest.name === "string"
        ? entry.manifest.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
        : "";
    if (!projectIdPattern.test(candidateName) || candidateName === rootProjectId || ambiguous.has(candidateName)) continue;
    // A normal workspace project remains the canonical editable owner when it
    // already exists. Catalog mapping only restores a missing external source.
    if (existsSync(safeChild(existingProjectsDirectory, candidateName))) continue;
    const config = await loadConfig(packageRoot, candidateName);
    if (config.appId !== entry.package) continue;
    const canonicalPackageRoot = realpathSync(packageRoot);
    const relativeSourcePath = relative(canonicalProjectRoot, canonicalPackageRoot);
    const isNestedSource = Boolean(relativeSourcePath && relativeSourcePath !== "." && relativeSourcePath !== ".." &&
      !relativeSourcePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relativeSourcePath));
    const source = {
      root: canonicalPackageRoot,
      appId: entry.package,
      identity: `${canonicalPackageRoot}\n${entry.package}`,
      ...(isNestedSource ? {
        parentProjectId: rootProjectId,
        sourceProjectTitle: rootConfig.title || rootConfig.name || rootProjectId,
        sourcePath: relativeSourcePath.split(/[\\/]+/u).join("/"),
      } : {}),
    };
    const previous = sources.get(candidateName);
    if (previous && (previous.root !== source.root || previous.appId !== source.appId)) {
      sources.delete(candidateName);
      ambiguous.add(candidateName);
      continue;
    }
    sources.set(candidateName, source);
  }
  return sources;
}

async function writeConfig(projectDir: string, config: EditorConfig): Promise<void> {
  // Validate both destinations before mutating either one. A malformed
  // external project must not get a partial config update when its second
  // config file is a symlink.
  const editorPath = safeProjectFile(projectDir, "editor.json", { allowConfig: true });
  const pocketPath = safeProjectFile(projectDir, "pocket.json", { allowConfig: true });
  const editor = await readJsonFile<Record<string, unknown>>(editorPath, {});
  const pocket = await readJsonFile<Record<string, unknown>>(pocketPath, {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  });
  pocket.id = config.appId;
  pocket.name = typeof pocket.name === "string" && pocketNamePattern.test(pocket.name) ? pocket.name : config.id;
  pocket.title = config.title;
  pocket.version = config.version;
  const app = isObject(pocket.app) ? pocket.app : {};
  pocket.app = { ...app, entry: config.entry, output: config.output, framework: config.framework };
  await writeProjectFile(projectDir, "editor.json", JSON.stringify({ ...editor, ...config }, null, 2) + "\n", { allowConfig: true });
  await writeProjectFile(projectDir, "pocket.json", JSON.stringify(pocket, null, 2) + "\n", { allowConfig: true });
}

async function createProject(workspace: Workspace, id: string, input: Record<string, unknown>): Promise<EditorConfig> {
  const projectDir = safeChild(workspace.projects, id);
  if (existsSync(projectDir)) throw new Error(`project already exists: ${id}`);
  const config = validateConfig(id, input);
  // New projects start from an SDK-owned template. The Showcase lives in the
  // sibling demo entry and is deliberately not copied into editor projects.
  await mkdir(workspace.projects, { recursive: true });
  await copyTree(join(root, "templates", config.template), projectDir);
  await writeConfig(projectDir, config);
  await mkdir(join(projectDir, "assets"), { recursive: true });
  return config;
}

function projectDirectory(workspace: Workspace, id: string): string {
  if (workspace.projectRoot && id === workspace.projectId) return workspace.projectRoot;
  const source = workspace.projectSources?.get(id);
  if (source) return source.root;
  return safeChild(workspace.projects, id);
}

async function workspaceProjectIds(workspace: Workspace): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await readdir(workspace.projects, { withFileTypes: true });
  } catch {
    // The configured project and catalog roots may still be available.
  }
  const ids = entries.filter((entry) => entry.isDirectory() && projectIdPattern.test(entry.name)).map((entry) => entry.name);
  if (workspace.projectRoot && workspace.projectId) ids.push(workspace.projectId);
  for (const id of workspace.projectSources?.keys() ?? []) ids.push(id);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

async function bindCatalogProjectState(workspace: Workspace, id: string, state: EditorState): Promise<EditorState> {
  const source = workspace.projectSources?.get(id);
  if (!source || state.sourceProjectIdentity === source.identity) return state;
  // A restored catalog source must not inherit a build made from a
  // missing/older source directory. Persist the binding and invalidate that
  // old build exactly once; keep the immutable publish mirror visible until a
  // fresh build/publish replaces it.
  if (state.sourceProjectIdentity !== undefined || state.builtRevision !== null || state.artifacts || state.publish) {
    state.revision += 1;
    state.error = undefined;
  }
  state.sourceProjectIdentity = source.identity;
  await saveState(workspace, id, state);
  return state;
}

async function listProjects(workspace: Workspace, getState: (id: string) => Promise<EditorState>): Promise<Array<EditorConfig & { status: EditorStatus; source?: CatalogProjectProvenance }>> {
  await mkdir(workspace.projects, { recursive: true });
  const projects: Array<EditorConfig & { status: EditorStatus; source?: CatalogProjectProvenance }> = [];
  for (const id of await workspaceProjectIds(workspace)) {
    try {
      const config = await loadConfig(projectDirectory(workspace, id), id);
      const state = await getState(id);
      const source = workspace.projectSources?.get(id);
      const provenance = source?.parentProjectId && source.sourceProjectTitle && source.sourcePath
        ? {
          kind: "catalog-miniapp" as const,
          parentProjectId: source.parentProjectId,
          sourceProjectTitle: source.sourceProjectTitle,
          sourcePath: source.sourcePath,
        }
        : undefined;
      projects.push({
        ...config,
        status: publicStatus(id, state),
        ...(provenance ? { source: provenance } : {}),
      });
    } catch {
      // A partially copied project is not allowed to take down the editor.
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadState(workspace: Workspace, id: string): Promise<EditorState> {
  const statePath = join(workspace.states, `${id}.json`);
  let state: EditorState;
  try {
    state = await readJsonFile<EditorState>(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Preserve a pre-existing editor state once, but keep new state outside
    // the external guest project so build inputs never see it.
    const legacyStatePath = safeProjectFile(projectDirectory(workspace, id), "editor-state.json", { allowProtected: true });
    state = await readJsonFile<EditorState>(legacyStatePath, {
      revision: 1,
      builtRevision: null,
      busy: false,
      logs: [],
    });
  }
  // A process restart cannot resume an in-flight compiler process.  Treat a
  // persisted busy bit as an interrupted build so the UI can start a fresh
  // one and retain the previous completed snapshot, if any.
  return { ...state, busy: false };
}

/**
 * Push channel for build/watch SSE streams. Every state mutation already goes
 * through pushLog() and saveState(), so those two emit; there is no timer.
 */
type StateBusEvent =
  | { type: "status"; status: EditorStatus }
  | { type: "log"; line: string }
  | { type: "done"; ok: boolean; builtRevision: number | null; diagnostics: BuildDiagnostic[] };
const stateSubscribers = new WeakMap<EditorState, Set<(event: StateBusEvent) => void>>();

function emitState(state: EditorState, event: StateBusEvent): void {
  for (const listener of [...(stateSubscribers.get(state) ?? [])]) {
    try { listener(event); } catch { /* a broken stream must not break a mutation */ }
  }
}

function subscribeState(state: EditorState, listener: (event: StateBusEvent) => void): () => void {
  let set = stateSubscribers.get(state);
  if (!set) stateSubscribers.set(state, set = new Set());
  set.add(listener);
  return () => { set.delete(listener); };
}

async function saveState(workspace: Workspace, id: string, state: EditorState): Promise<void> {
  await mkdir(workspace.states, { recursive: true });
  await writeFile(join(workspace.states, `${id}.json`), JSON.stringify(state, null, 2) + "\n");
  if (stateSubscribers.get(state)?.size) emitState(state, { type: "status", status: publicStatus(id, state) });
}

function publicStatus(id: string, state: EditorState): EditorStatus {
  return {
    id,
    revision: state.revision,
    builtRevision: state.builtRevision,
    busy: state.busy,
    ...(state.error ? { error: state.error } : {}),
    ...(state.error && state.diagnostics ? { diagnostics: state.diagnostics } : {}),
    logs: state.logs.slice(-200),
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.artifacts ? { artifacts: state.artifacts } : {}),
    ...(state.publish ? { publish: state.publish } : {}),
  };
}

function pushLog(state: EditorState, line: string): void {
  const clipped = line.slice(0, 4096);
  state.logs.push(clipped);
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
  if (stateSubscribers.get(state)?.size) emitState(state, { type: "log", line: clipped });
}

/**
 * Turn compiler output into structured diagnostics. Formats observed from the
 * pinned toolchain: Babel parse errors ("SyntaxError: <file>: msg (L:C)",
 * 0-based column), `bun build` errors ("error: msg" + "    at <file>:L:C"), and
 * the generic "<file>:L:C: error: msg". Files outside the project are dropped
 * and the project directory is stripped from messages.
 */
function parseBuildDiagnostics(lines: string[], projectDir: string): BuildDiagnostic[] {
  const roots = [resolve(projectDir)];
  try { roots.push(realpathSync(projectDir)); } catch { /* project vanished */ }
  const toRelative = (file: string): string | undefined => {
    const candidate = isAbsolute(file) ? file : resolve(projectDir, file);
    for (const base of roots) {
      const rel = relative(base, candidate);
      if (rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel)) return rel.replaceAll("\\", "/");
    }
    return undefined;
  };
  const clean = (message: string): string => {
    let out = message;
    for (const base of roots) out = out.replaceAll(`${base}/`, "").replaceAll(`${base}\\`, "");
    return out.trim().slice(0, 1000);
  };
  const out: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number, column: number, severity: "error" | "warning", message: string): void => {
    const rel = toRelative(file);
    if (!rel || out.length >= 100 || !Number.isSafeInteger(line) || line < 1) return;
    const diagnostic = { file: rel, line, column: Math.max(1, column), severity, message: clean(message) };
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(diagnostic);
  };
  const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  for (let index = 0; index < plain.length; index += 1) {
    const line = plain[index]!;
    const babel = /^\w*Error: ((?:[A-Za-z]:)?[^:]+?): (.+) \((\d+):(\d+)\)$/.exec(line);
    if (babel) { add(babel[1]!, Number(babel[3]), Number(babel[4]) + 1, "error", babel[2]!); continue; }
    const colon = /^((?:[A-Za-z]:)?[^:\s][^:]*):(\d+):(\d+): (error|warning|ERROR|WARNING):? (.*)$/.exec(line);
    if (colon) { add(colon[1]!, Number(colon[2]), Number(colon[3]), colon[4]!.toLowerCase() as "error" | "warning", colon[5]!); continue; }
    const bun = /^(error|warning): (.*)$/.exec(line);
    if (bun) {
      for (let next = index + 1; next < Math.min(plain.length, index + 6); next += 1) {
        const at = /^\s+at ((?:[A-Za-z]:)?[^():]+?):(\d+):(\d+)$/.exec(plain[next]!);
        if (at) { add(at[1]!, Number(at[2]), Number(at[3]), bun[1] as "error" | "warning", bun[2]!); break; }
        if (/^(error|warning): /.test(plain[next]!)) break;
      }
    }
  }
  return out;
}

async function runProcess(command: string[], cwd: string, log: (line: string) => void): Promise<void> {
  log(`$ ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, process.exited]);
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean)) log(line);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
}

async function realBuild(input: Parameters<BuildRunner>[0]): Promise<BuildOutput> {
  await mkdir(input.outDir, { recursive: true });
  const built = await buildGuest({
    projectRoot: input.projectDir,
    outDir: input.outDir,
    tickHz: input.config.tickHz,
    log: input.log,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const bytecodeMetadata = await readJsonFile<Record<string, unknown>>(built.metadata);
  if (bytecodeMetadata.entryFormat !== "quickjs-bytecode" || typeof bytecodeMetadata.runtimeAbi !== "string" || !bytecodeMetadata.runtimeAbi) {
    throw new Error("bytecode metadata is not a real quickjs-bytecode artifact");
  }
  const bytecodeStat = await stat(built.bytecode);
  if (bytecodeMetadata.bytecodeBytes !== bytecodeStat.size) throw new Error("bytecode metadata size does not match qjbc");
  return {
    appJs: built.source,
    pak: built.pak,
    bytecode: built.bytecode,
    metadata: built.metadata,
    runtimeAbi: bytecodeMetadata.runtimeAbi,
    bytecodeMetadata,
  };
}

type GeneratedPreviewApplication = {
  title: string;
  assetDirectory: string;
};

function generatedPreviewApplications(value: unknown): Record<string, GeneratedPreviewApplication> {
  if (!isObject(value) || value.schemaVersion !== 1 || value.applications === undefined) return {};
  if (!isObject(value.surfaces) || !isObject(value.applications)) {
    throw new Error("generated compositor registry applications must be an object");
  }
  const result: Record<string, GeneratedPreviewApplication> = {};
  for (const [appId, raw] of Object.entries(value.applications)) {
    if (!appIdPattern.test(appId) || !isObject(raw) || typeof raw.title !== "string" || !raw.title.trim() ||
        typeof raw.assetDirectory !== "string" || !raw.assetDirectory ||
        raw.assetDirectory.startsWith("/") || raw.assetDirectory.includes("\\") ||
        raw.assetDirectory.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`generated preview application is invalid: ${appId}`);
    }
    const handle = value.surfaces[appId];
    if (!Number.isInteger(handle) || Number(handle) < 2 || Number(handle) > 63) {
      throw new Error(`generated preview application has no compositor surface: ${appId}`);
    }
    result[appId] = { title: raw.title.trim(), assetDirectory: raw.assetDirectory };
  }
  return result;
}

async function stageGeneratedPreviewApplications(
  projectDir: string,
  stagingDir: string,
  registryPath: string,
): Promise<number> {
  const registry = await readJsonFile<Record<string, unknown>>(registryPath);
  const applications = generatedPreviewApplications(registry);
  const entries = Object.entries(applications);
  if (entries.length === 0) return 0;
  // A Showcase JS project is a direct child of its Flutter consumer. The
  // generated catalog names paths below that consumer's assets root; it never
  // grants arbitrary filesystem access to a preview build.
  const assetRoot = resolve(projectDir, "..", "assets");
  const rootInfo = lstatSync(assetRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("generated preview applications require a regular Flutter assets directory");
  }
  const canonicalRoot = realpathSync(assetRoot);
  const targetRoot = join(stagingDir, "preview-applications");
  await mkdir(targetRoot, { recursive: true });
  const requiredFiles = ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"] as const;
  for (const [appId, application] of entries) {
    const sourceDirectory = resolve(assetRoot, application.assetDirectory);
    const sourceRelative = relative(canonicalRoot, realpathSync(sourceDirectory));
    if (isAbsolute(sourceRelative) || sourceRelative === ".." || sourceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`generated preview application escapes Flutter assets: ${appId}`);
    }
    const targetDirectory = join(targetRoot, appId);
    await mkdir(targetDirectory, { recursive: true });
    const manifest = await readJsonFile<Record<string, unknown>>(join(sourceDirectory, "guest-manifest.json"));
    const files: readonly string[] = manifest.worker
      ? [...requiredFiles, "app.worker.qjbc", "app.worker.bytecode.json"]
      : requiredFiles;
    for (const name of files) {
      const source = join(sourceDirectory, name);
      const info = lstatSync(source);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`generated preview artifact is not a regular file: ${appId}/${name}`);
      const artifactRelative = relative(canonicalRoot, realpathSync(source));
      if (isAbsolute(artifactRelative) || artifactRelative === ".." || artifactRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`generated preview artifact escapes Flutter assets: ${appId}/${name}`);
      }
      await cp(source, join(targetDirectory, name));
    }
    await copyBuiltNativeModels(sourceDirectory, targetDirectory, canonicalRoot);
  }
  return entries.length;
}

async function buildProject(workspace: Workspace, id: string, state: EditorState, config: EditorConfig, runner: BuildRunner, signal?: AbortSignal, captured?: string[]): Promise<void> {
  signal?.throwIfAborted();
  const revision = state.revision;
  const projectDir = projectDirectory(workspace, id);
  // All build configuration paths are checked before parsing. The effective
  // entry comes from legacy pocket.json when present, so a custom entry must
  // receive the same no-symlink/existing-file policy as app.tsx.
  safeProjectFile(projectDir, "editor.json", { allowConfig: true });
  const pocketPath = safeProjectFile(projectDir, "pocket.json", { allowConfig: true });
  const projectManifest = safeProjectFile(projectDir, "manifest.json", { mustExist: true });
  const systemFile = existsSync(join(projectDir, "pocket.system.json"))
    ? safeProjectFile(projectDir, "pocket.system.json", { allowConfig: true, mustExist: true })
    : undefined;
  const policyFile = safeProjectFile(projectDir, RESOURCE_POLICY_FILE, { allowConfig: true });
  const pocket = await readJsonFile<Record<string, unknown>>(pocketPath, {});
  const app = isObject(pocket.app) ? pocket.app : {};
  const configuredEntry = typeof app.entry === "string" ? app.entry : config.entry;
  safeProjectFile(projectDir, configuredEntry, { mustExist: true });
  await validateProjectInputTree(projectDir);
  const buildDir = safeChild(workspace.builds, `${id}/${revision}`);
  const revisionRoot = safeChild(workspace.builds, id);
  await mkdir(revisionRoot, { recursive: true });
  const existingBuild = lstatIfExists(buildDir);
  if (existingBuild?.isSymbolicLink()) throw new Error("build snapshot must not be a symlink");
  const stagingDir = await mkdtemp(join(revisionRoot, ".staging-"));
  const temp = await mkdtemp(join(tmpdir(), "pocket-editor-build-"));
  try {
    const output = await runner({
      id, projectDir, outDir: temp, config, signal,
      log: (line) => { pushLog(state, line); if (captured && captured.length < 20000) captured.push(line); },
    });
    signal?.throwIfAborted();
    const copy = async (name: string, source: string) => { await cp(source, join(stagingDir, name)); };
    await copy("app.js", output.appJs);
    await copy("app.pak", output.pak);
    await copy("app.qjbc", output.bytecode);
    await copy("app.bytecode.json", output.metadata);
    if (existsSync(join(temp, "app.worker.qjbc"))) {
      await copy("app.worker.qjbc", join(temp, "app.worker.qjbc"));
    }
    if (existsSync(join(temp, "app.worker.bytecode.json"))) {
      await copy("app.worker.bytecode.json", join(temp, "app.worker.bytecode.json"));
    }
    await copyBuiltNativeModels(temp, stagingDir);
    // The source manifest is the protocol/capability declaration. Generate
    // the artifact from the safe source path so injected/mock runners and the
    // real compiler follow the same release identity from the current Editor
    // config. Never let a stale source version/build pin this snapshot.
    const baseManifest = existsSync(join(temp, "guest-manifest.json"))
      ? await readJsonFile<Record<string, unknown>>(join(temp, "guest-manifest.json"))
      : existsSync(join(buildDir, "guest-manifest.json"))
        ? await readJsonFile<Record<string, unknown>>(join(buildDir, "guest-manifest.json"))
        : await readJsonFile<Record<string, unknown>>(projectManifest);
    const artifactManifest = {
      ...(await readJsonFile<Record<string, unknown>>(projectManifest)),
      ...baseManifest,
      version: config.version,
      build: config.build,
    };
    await writeFile(join(stagingDir, "guest-manifest.json"), JSON.stringify(artifactManifest, null, 2) + "\n");
    const resourceSnapshot = await buildResourceSnapshot({
      projectRoot: projectDir,
      buildDirectory: stagingDir,
      revision,
      rootPackageId: config.appId,
      rootTitle: config.title,
      rootManifest: "pocket.json",
      rootVersion: config.version,
      rootBuild: config.build,
      rootRuntimeAbi: output.runtimeAbi,
      tickHz: config.tickHz,
      ...(systemFile ? { systemFile } : {}),
      policyFile,
      strictPak: runner === realBuild,
      ...(signal ? { signal } : {}),
      log: (line) => pushLog(state, line),
    });
    const generatedCompositorRegistry = join(projectDir, "generated", "compositor-surfaces.json");
    if (existsSync(generatedCompositorRegistry)) {
      safeProjectFile(projectDir, "generated/compositor-surfaces.json", { mustExist: true });
      const previewApplicationCount = await stageGeneratedPreviewApplications(projectDir, stagingDir, generatedCompositorRegistry);
      if (previewApplicationCount > 0) pushLog(state, `staged ${previewApplicationCount} generated preview application(s)`);
      await mkdir(join(stagingDir, "generated"), { recursive: true });
      await cp(generatedCompositorRegistry, join(stagingDir, "generated", "compositor-surfaces.json"));
    }
    const generation = randomUUID();
    const buildInfo = {
      generation,
      id,
      revision,
      appId: config.appId,
      version: config.version,
      build: config.build,
      tickHz: config.tickHz,
      entryFormat: "quickjs-bytecode",
      runtimeAbi: output.runtimeAbi,
      bytecode: output.bytecodeMetadata,
      resources: {
        snapshot: RESOURCE_SNAPSHOT_FILE,
        packages: resourceSnapshot.packages.map((pkg) => ({ id: pkg.id, artifactDirectory: pkg.artifactDirectory, version: pkg.version, build: pkg.build })),
      },
      generatedAt: now(),
    };
    await writeFile(join(stagingDir, "build.json"), JSON.stringify(buildInfo, null, 2) + "\n");
    signal?.throwIfAborted();
    const backupDir = `${buildDir}.backup-${randomUUID()}`;
    let movedExisting = false;
    try {
      if (existingBuild) {
        await rename(buildDir, backupDir);
        movedExisting = true;
      }
      await rename(stagingDir, buildDir);
    } catch (error) {
      if (movedExisting && !existsSync(buildDir)) {
        await rename(backupDir, buildDir).catch(() => undefined);
      }
      throw error;
    }
    if (movedExisting) await rm(backupDir, { recursive: true, force: true });
    await writeFile(join(revisionRoot, "current.json"), JSON.stringify({ revision }, null, 2) + "\n");
    state.builtRevision = revision;
    state.artifacts = {
      revision,
      generation,
      appJs: `/api/projects/${id}/artifacts/app.js`,
      bytecode: `/api/projects/${id}/artifacts/app.qjbc`,
      metadata: `/api/projects/${id}/artifacts/app.bytecode.json`,
      pak: `/api/projects/${id}/artifacts/app.pak`,
      manifest: `/api/projects/${id}/artifacts/guest-manifest.json`,
      build: `/api/projects/${id}/artifacts/build.json`,
      resources: `/api/projects/${id}/resources`,
    };
    state.error = undefined;
    pushLog(state, `build ready: revision ${revision}, runtimeAbi=${output.runtimeAbi}`);
  } finally {
    // This directory is a private, disposable staging area.  A failed build
    // leaves the previous snapshot intact and its diagnostics in state.logs.
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const buildAborts = new WeakMap<EditorState, AbortController>();
const buildSettled = new WeakMap<EditorState, Promise<void>>();

/** Abort the running/queued build of this project. False when none is active. */
function cancelBuild(state: EditorState): boolean {
  const controller = buildAborts.get(state);
  if (!controller || !state.busy || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

type BuildScope = { controllers: Set<AbortController>; timeoutMs: number };

function queueBuild(
  workspace: Workspace,
  id: string,
  states: Map<string, EditorState>,
  runner: BuildRunner,
  scope: BuildScope,
): void {
  const state = states.get(id)!;
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  state.diagnostics = undefined;
  state.startedAt = now();
  const controller = new AbortController();
  buildAborts.set(state, controller);
  scope.controllers.add(controller);
  let timedOut = false;
  const projectDir = projectDirectory(workspace, id);
  buildSettled.set(state, (async () => {
    try {
      do {
        const revision = state.revision;
        const captured: string[] = [];
        // The build timeout bounds one build attempt; it aborts the whole process group like a cancel.
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, scope.timeoutMs);
        timeout.unref?.();
        try {
          controller.signal.throwIfAborted();
          const config = await loadConfig(projectDir, id);
          pushLog(state, `build started: revision ${revision}`);
          await saveState(workspace, id, state);
          await buildProject(workspace, id, state, config, runner, controller.signal, captured);
          state.diagnostics = undefined;
        } catch (error) {
          if (controller.signal.aborted) {
            state.error = timedOut ? "build timed out" : "build cancelled";
            state.diagnostics = [];
            pushLog(state, state.error);
          } else {
            state.error = error instanceof Error ? error.message : String(error);
            state.diagnostics = parseBuildDiagnostics(captured, projectDir);
            pushLog(state, `ERROR: ${state.error}`);
          }
        } finally {
          clearTimeout(timeout);
        }
      } while (state.revision !== state.builtRevision && !state.error);
    } finally {
      scope.controllers.delete(controller);
      buildAborts.delete(state);
      state.busy = false;
      state.finishedAt = now();
      try { await saveState(workspace, id, state); } catch { /* reported by the next mutation */ }
      emitState(state, { type: "done", ok: !state.error, builtRevision: state.builtRevision, diagnostics: state.diagnostics ?? [] });
    }
  })());
}

async function readArtifact(workspace: Workspace, id: string, file: string, state: EditorState): Promise<Uint8Array | undefined> {
  if (!state.artifacts || state.builtRevision === null) return undefined;
  const name = basename(file);
  const allowed = new Set(["app.js", "app.qjbc", "app.bytecode.json", "app.pak", "guest-manifest.json", "build.json", "app.worker.qjbc", "app.worker.bytecode.json"]);
  if (!allowed.has(name)) return undefined;
  let path: string;
  try {
    path = safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${name}`);
  } catch (error) {
    const status = (error as unknown as { status?: number })?.status;
    if (status === 404) return undefined;
    throw error;
  }
  try { return new Uint8Array(await readFile(path)); } catch { return undefined; }
}

type PublishResult = PackageResult & {
  releaseId?: string;
  offlineArchivePath?: string;
  offlineFilename?: string;
};

async function publishProject(
  workspace: Workspace,
  id: string,
  config: EditorConfig,
  state: EditorState,
  origin: string,
  hostVersion: string,
  channel: "test" | "release" = "release",
  options: { offline?: boolean; hostVersionSource?: string; packageVersion?: string; reusedPackages?: AggregateHostPackage[] } = {},
): Promise<PublishResult> {
  if (state.builtRevision !== state.revision || !state.artifacts) throw new Error("build the current source before publishing");
  const offline = options.offline === true;
  const parsedOrigin = new URL(origin);
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/") {
    throw new Error("Editor version backend origin must be an HTTP(S) origin without credentials or a path");
  }
  const safeOrigin = parsedOrigin.origin;
  const slot = versionSlot(channel);
  const releaseId = newReleaseId(slot, id);
  const historyPath = versionHistoryPath(workspace.states, id);
  const history = offline ? emptyVersionHistory() : await readVersionHistory(historyPath);
  const compatVersion = options.packageVersion
    ?? history.entries.find((entry) => entry.hostVersion === hostVersion && entry.compatVersion)?.compatVersion
    ?? compatibilityVersion(state.publish?.version ?? config.version);
  if (!appIdPattern.test(compatVersion)) throw new Error("Editor update package compatibility version is invalid");
  const buildDir = join(workspace.builds, id, String(state.builtRevision));
  const snapshotPath = safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`);
  const resourceSnapshot = await readResourceSnapshot(snapshotPath);
  const rootPackage = resourceSnapshot.packages.find((pkg) => pkg.id === config.appId);
  if (!rootPackage) throw new Error(`resource snapshot does not contain root package ${config.appId}`);
  const reuseIds = config.reusePublishedPackages ?? [];
  const snapshotPackageIds = new Set(resourceSnapshot.packages.map((pkg) => pkg.id));
  if (reuseIds.some((packageId) => packageId === config.appId || !snapshotPackageIds.has(packageId))) {
    throw new Error("reusePublishedPackages must name catalog child packages in the current build");
  }
  if (offline && reuseIds.length > 0) throw new Error("offline archives cannot reuse packages published by another project");
  const reusedPackages = options.reusedPackages ?? [];
  const reusedPackageIds = new Set(reusedPackages.map((pkg) => pkg.id));
  if (new Set(reusedPackages.map((pkg) => pkg.id)).size !== reusedPackages.length ||
      reuseIds.length !== reusedPackages.length || reuseIds.some((packageId) => !reusedPackages.some((pkg) => pkg.id === packageId))) {
    throw new Error("reused package descriptors do not match reusePublishedPackages");
  }
  const reusedPackageRecords: PublishedVersionReusedPackage[] = reusedPackages.map((pkg) => {
    if (typeof pkg.id !== "string" || typeof pkg.version !== "string" || !Number.isSafeInteger(pkg.build) ||
        typeof pkg.reusedProjectId !== "string" || typeof pkg.reusedReleaseId !== "string") {
      throw new Error("reused package descriptor is missing its immutable owner reference");
    }
    return {
      id: pkg.id,
      version: pkg.version,
      build: Number(pkg.build),
      ownerProjectId: pkg.reusedProjectId,
      releaseId: pkg.reusedReleaseId,
    };
  });
  const sameReusedPackages = (left: PublishedVersionReusedPackage[] | undefined, right: PublishedVersionReusedPackage[]) => {
    const previous = left ?? [];
    return previous.length === right.length && previous.every((pkg, index) => {
      const next = right[index];
      return !!next && pkg.id === next.id && pkg.version === next.version && pkg.build === next.build &&
        pkg.ownerProjectId === next.ownerProjectId && pkg.releaseId === next.releaseId;
    });
  };
  const packageVersion = slot;
  // A fixed package index follows the newest host/slot release across every
  // compatibility branch. Keep anti-rollback floors equally broad; otherwise
  // a new compat branch could publish a lower stable build that the shared
  // client namespace would correctly reject after downloading the index.
  const slotEntries = offline
    ? []
    : history.entries.filter((entry) => entry.hostVersion === hostVersion && entry.slot === slot);
  const historicalRootBuild = slotEntries.reduce((maximum, entry) => Math.max(maximum, entry.build), 0);
  const historicalTestBuild = history.entries
    .filter((entry) => entry.hostVersion === hostVersion && entry.slot === "test")
    .reduce((maximum, entry) => Math.max(maximum, entry.build), 0);
  const historicalPackageBuild = (packageId: string): number => slotEntries.reduce((maximum, entry) => {
    const pkg = entry.packages.find((candidate) => candidate.id === packageId);
    return Math.max(maximum, pkg?.build ?? 0);
  }, 0);
  const previousEntry = currentVersion(history, slot, hostVersion, compatVersion);
  const previousRootPackage = previousEntry?.packages.find((pkg) => pkg.id === config.appId);
  const legacyHostVersion = [hostVersion, state.publish?.hostVersion, "editor"]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .find((candidate) => existsSync(join(pocketReleaseDirectory(workspace.updates, candidate, config.appId, packageVersion), "latest.json")))
    ?? hostVersion;
  const legacyRootDir = pocketReleaseDirectory(workspace.updates, legacyHostVersion, config.appId, packageVersion);
  const readPayload = async (artifactRoot: string | undefined): Promise<Record<string, unknown>> => {
    if (!artifactRoot) return {};
    try {
      return await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.updates, `${artifactRoot}/payload.json`));
    } catch {
      return {};
    }
  };
  const previousRootPayload = offline
    ? {}
    : previousRootPackage
      ? await readPayload(previousRootPackage.artifactRoot)
      : await readJsonFile<Record<string, unknown>>(join(legacyRootDir, "payload.json"), {});
  const previousRootBuild = Number(previousEntry?.build ?? previousRootPayload.build ?? 0);
  const stableRootBuildFloor = Math.max(previousRootBuild, historicalRootBuild);
  if (!offline && channel === "release" && Number.isSafeInteger(stableRootBuildFloor) && config.build < stableRootBuildFloor) {
    throw new Error(`stable release build ${config.build} is older than the current build ${stableRootBuildFloor}`);
  }
  const { keyPath, key } = await editorUpdateTrust(workspace, id);
  const legacyCounterPath = join(workspace.states, `${id}-test-release.json`);
  const branchCounterPath = join(workspace.states, `${id}-${sha256Hex(new TextEncoder().encode(`${hostVersion}\n${compatVersion}\ntest`)).slice(0, 16)}-test-release.json`);
  const counterPath = branchCounterPath;
  const counter = offline
    ? {}
    : await readJsonFile<{ build?: number }>(counterPath, Object.keys(history.current).length === 0 ? await readJsonFile<{ build?: number }>(legacyCounterPath, {}) : {});
  const metadata = await readJsonFile<Record<string, unknown>>(join(buildDir, "app.bytecode.json"));
  // Test packages must advance beyond both the installed built-in package and
  // earlier published test packages. Do not weaken the host's replay checks.
  const build = channel === "test"
    ? Math.max(config.build, Number(previousRootPayload.build ?? 0), Number(metadata.build ?? 0), Number(counter.build ?? 0), historicalTestBuild) + 1
    : config.build;
  if (!Number.isSafeInteger(build) || build < 0) throw new Error("test package build is outside the safe integer range");
  const version = channel === "test" ? `${config.version}-test.${build}` : config.version;
  const rootDirectory = resourceArtifactDirectory(buildDir, rootPackage);
  const releaseRoot = offline
    ? join(workspace.updates, ".downloads", id, releaseId)
    : join(workspace.updates, ".history", id, releaseId);
  const immutablePackageVersion = releaseId;
  const routeVersion = offline
    ? immutablePackageVersion
    : channel === "test"
      ? version
      : history.entries.some((entry) => entry.hostVersion === hostVersion && entry.slot === "stable" && entry.version === version && entry.build !== build)
        ? `${version}-build.${build}`
        : version;
  const releaseDir = pocketReleaseDirectory(releaseRoot, hostVersion, config.appId, immutablePackageVersion);
  const channelPrefix = channelUpdatePrefix(channel);
  const releasePath = `/${channelPrefix}/pocket/${hostVersion}/${encodeURIComponent(config.appId)}/${compatVersion}`;
  const manifestUrl = `${safeOrigin}${releasePath}/latest.json`;
  const aggregateHostConfigUrl = `${safeOrigin}/pocket/${hostVersion}/${encodeURIComponent(config.appId)}/${compatVersion}/host.json`;
  const packageIndexUrl = `${safeOrigin}/${channelPrefix}/pocket/${hostVersion}/${encodeURIComponent(config.appId)}/latest.json`;
  const hostConfigUrl = aggregateHostConfigUrl;
  const packagePayloads = new Map<string, Record<string, unknown>>();
  const packageRecords: PublishedVersionPackage[] = [];
  const publishedPackages: NonNullable<EditorStatus["publish"]>["packages"] = [];
  const legacyStablePublish = !offline && channel === "release" && !previousEntry && Object.keys(previousRootPayload).length > 0 &&
    (typeof previousRootPayload.version !== "string" || compatibilityVersion(previousRootPayload.version) === compatVersion);
  let legacyStableEquivalent = legacyStablePublish && config.build === previousRootBuild;
  let historyCommitted = false;
  let archivePath = "";
  try {
    await mkdir(releaseDir, { recursive: true });
    const rootAssets = join(rootDirectory, "assets");
    const hasRootAssets = existsSync(rootAssets) && (await readdir(rootAssets)).length > 0;
    const rootNetwork = resourcePackageNetwork(resourceSnapshot, rootPackage.id);
    const rootPackageOptions = {
      appId: config.appId,
      version,
      build,
      bytecodePath: join(rootDirectory, "app.qjbc"),
      entryFormat: "quickjs-bytecode",
      runtimeAbi: String(metadata.runtimeAbi),
      pakPath: join(rootDirectory, "app.pak"),
      outDir: releaseDir,
      keyFile: keyPath,
      guestManifestPath: join(rootDirectory, "guest-manifest.json"),
      ...(hasRootAssets ? { assetDir: rootAssets, assetPrefix: "assets" } : {}),
      networkPakKeys: rootNetwork.pak,
      networkAssets: rootNetwork.assets,
      ...(offline ? { includeBundle: false } : {}),
    } as Parameters<typeof packageArtifacts>[0];
    let result = packageArtifacts(rootPackageOptions);
    packagePayloads.set(rootPackage.id, result.payload as unknown as Record<string, unknown>);
    if (legacyStablePublish) {
      if (config.build === previousRootBuild && !payloadsEqual(result.payload as unknown as Record<string, unknown>, previousRootPayload)) {
        throw new Error(`stable release build ${config.build} already exists with different package contents`);
      }
      if (config.build !== previousRootBuild) legacyStableEquivalent = false;
    }
    if (!offline && channel === "release") {
      const currentPackageIds = new Set(resourceSnapshot.packages.filter((pkg) => !reusedPackageIds.has(pkg.id)).map((pkg) => pkg.id));
      for (const prior of slotEntries.filter((entry) => entry.build === config.build)) {
        const priorPackageIds = new Set(prior.packages.map((pkg) => pkg.id));
        if (priorPackageIds.size !== currentPackageIds.size || [...priorPackageIds].some((packageId) => !currentPackageIds.has(packageId))) {
          throw new Error(`stable release build ${config.build} already exists with different package contents`);
        }
        const priorRoot = prior.packages.find((pkg) => pkg.id === config.appId);
        const priorPayload = await readPayload(priorRoot?.artifactRoot);
        if (Object.keys(priorPayload).length > 0 && !payloadsEqual(result.payload as unknown as Record<string, unknown>, priorPayload)) {
          throw new Error(`stable release build ${config.build} already exists with different package contents`);
        }
      }
    }
    packageRecords.push({
      id: rootPackage.id,
      version,
      build,
      artifactRoot: packageArtifactRoot(workspace, id, releaseId, hostVersion, rootPackage.id, immutablePackageVersion),
    });
    await writeFile(join(releaseDir, "host.json"), JSON.stringify({
      POCKET_UPDATE_BASE_URL: safeOrigin,
      POCKET_HOST_VERSION: hostVersion,
      POCKET_PACKAGE_VERSION: immutablePackageVersion,
      POCKET_UPDATE_KEY_ID: key.keyId,
      POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
      POCKET_STORE_NAMESPACE: updateNamespace(id, hostVersion, compatVersion, channel, releaseId),
      POCKET_UPDATE_BRANCH_NAMESPACE: updateNamespace(id, hostVersion, compatVersion, channel),
      ...(parsedOrigin.protocol === "http:" ? { POCKET_UPDATE_DEBUG_HTTP_HOST: parsedOrigin.hostname } : {}),
    }, null, 2) + "\n");
    for (const pkg of resourceSnapshot.packages) {
      if (pkg.id === rootPackage.id || reusedPackageIds.has(pkg.id)) continue;
      const packageDirectory = resourceArtifactDirectory(buildDir, pkg);
      const packageMetadata = await readJsonFile<Record<string, unknown>>(join(packageDirectory, "app.bytecode.json"));
      const previousPackage = previousEntry?.packages.find((entry) => entry.id === pkg.id);
      const legacyPackageDir = pocketReleaseDirectory(workspace.updates, legacyHostVersion, pkg.id, packageVersion);
      const previousPackagePayload = offline
        ? {}
        : previousPackage
          ? await readPayload(previousPackage.artifactRoot)
          : await readJsonFile<Record<string, unknown>>(join(legacyPackageDir, "payload.json"), {});
      if (legacyStablePublish && Object.keys(previousPackagePayload).length === 0) legacyStableEquivalent = false;
      const packageBaseBuild = Number(packageMetadata.build ?? pkg.build);
      const historicalChildBuild = historicalPackageBuild(pkg.id);
      const packageBuild = channel === "test"
        ? Math.max(config.build, pkg.build, packageBaseBuild, Number(previousPackagePayload.build ?? 0), historicalChildBuild) + 1
        : pkg.build;
      if (!offline && channel === "release" && packageBuild < historicalChildBuild) {
        throw new Error(`stable package ${pkg.id} build ${packageBuild} is older than the current build ${historicalChildBuild}`);
      }
      if (channel === "release" && previousPackage && packageBuild < previousPackage.build) {
        throw new Error(`stable package ${pkg.id} build ${packageBuild} is older than the current build ${previousPackage.build}`);
      }
      const childVersion = channel === "test" ? `${pkg.version}-test.${packageBuild}` : pkg.version;
      const packageReleaseDir = pocketReleaseDirectory(releaseRoot, hostVersion, pkg.id, immutablePackageVersion);
      await mkdir(packageReleaseDir, { recursive: true });
      const packageAssets = join(packageDirectory, "assets");
      const hasPackageAssets = existsSync(packageAssets) && (await readdir(packageAssets)).length > 0;
      const packageNetwork = resourcePackageNetwork(resourceSnapshot, pkg.id);
      const packageOptions = {
        appId: pkg.id,
        version: childVersion,
        build: packageBuild,
        bytecodePath: join(packageDirectory, "app.qjbc"),
        entryFormat: "quickjs-bytecode",
        runtimeAbi: pkg.runtimeAbi,
        pakPath: join(packageDirectory, "app.pak"),
        outDir: packageReleaseDir,
        keyFile: keyPath,
        ...(existsSync(join(packageDirectory, "guest-manifest.json")) ? { guestManifestPath: join(packageDirectory, "guest-manifest.json") } : {}),
        ...(hasPackageAssets ? { assetDir: packageAssets, assetPrefix: "assets" } : {}),
        networkPakKeys: packageNetwork.pak,
        networkAssets: packageNetwork.assets,
        ...(offline ? { includeBundle: false } : {}),
      } as Parameters<typeof packageArtifacts>[0];
      const packageResult = packageArtifacts(packageOptions);
      packagePayloads.set(pkg.id, packageResult.payload as unknown as Record<string, unknown>);
      if (channel === "release" && !previousEntry && Object.keys(previousPackagePayload).length > 0) {
        const previousBuild = Number(previousPackagePayload.build ?? 0);
        if (packageBuild < previousBuild) {
          throw new Error(`stable package ${pkg.id} build ${packageBuild} is older than the current build ${previousBuild}`);
        }
        if (packageBuild === previousBuild && !payloadsEqual(packageResult.payload as unknown as Record<string, unknown>, previousPackagePayload)) {
          throw new Error(`stable package ${pkg.id} build ${packageBuild} already exists with different package contents`);
        }
        if (packageBuild !== previousBuild) legacyStableEquivalent = false;
      }
      if (!offline && channel === "release") {
        for (const prior of slotEntries) {
          const priorPackage = prior.packages.find((candidate) => candidate.id === pkg.id && candidate.build === packageBuild);
          if (!priorPackage) continue;
          const priorPayload = await readPayload(priorPackage.artifactRoot);
          if (Object.keys(priorPayload).length > 0 && !payloadsEqual(packageResult.payload as unknown as Record<string, unknown>, priorPayload)) {
            throw new Error(`stable package ${pkg.id} build ${packageBuild} already exists with different package contents`);
          }
        }
      }
      packageRecords.push({
        id: pkg.id,
        version: childVersion,
        build: packageBuild,
        artifactRoot: packageArtifactRoot(workspace, id, releaseId, hostVersion, pkg.id, immutablePackageVersion),
      });
      const packageReleasePath = `/${channelPrefix}/pocket/${hostVersion}/${encodeURIComponent(pkg.id)}/${compatVersion}`;
      const immutablePackageReleasePath = historyPackagePath(hostVersion, pkg.id, releaseId);
      const packageManifestPath = `${packageReleasePath}/latest.json`;
      const packageHostConfigPath = `${packageReleasePath}/host.json`;
      const packageManifestUrl = `${safeOrigin}${packageManifestPath}`;
      const bootstrapDirectory = join(packageReleaseDir, "bootstrap");
      await mkdir(bootstrapDirectory, { recursive: true });
      await cp(join(packageDirectory, "app.bytecode.json"), join(bootstrapDirectory, "app.bytecode.json"));
      const hasGuestManifest = existsSync(join(packageDirectory, "guest-manifest.json"));
      if (hasGuestManifest) await cp(join(packageDirectory, "guest-manifest.json"), join(bootstrapDirectory, "guest-manifest.json"));
      const packageNamespace = updateNamespace(id, hostVersion, compatVersion, channel, releaseId);
      const branchNamespace = updateNamespace(id, hostVersion, compatVersion, channel);
      const metadataAsset = `assets/apps/${pkg.id}/app.bytecode.json`;
      const manifestAsset = `assets/apps/${pkg.id}/guest-manifest.json`;
      const bootstrapAssets: Record<string, { url: string; sha256: string; size: number }> = {};
      const bootstrapFiles: Array<[string, string]> = [[metadataAsset, "app.bytecode.json"]];
      if (hasGuestManifest) bootstrapFiles.push([manifestAsset, "guest-manifest.json"]);
      for (const [asset, name] of bootstrapFiles) {
        const bytes = new Uint8Array(await readFile(join(bootstrapDirectory, name)));
        bootstrapAssets[asset] = { url: `${safeOrigin}${immutablePackageReleasePath}/bootstrap/${name}`, sha256: sha256Hex(bytes), size: bytes.length };
      }
      await writeFile(join(packageReleaseDir, "host.json"), JSON.stringify({
        kind: "pocket-mini-app-host-template",
        requiresLocalBootstrap: true,
        config: {
          appId: pkg.id,
          downloadOnOpen: true,
          metadataAsset,
          ...(hasGuestManifest ? { manifestAsset } : {}),
          updates: { baseUrl: `${safeOrigin}/${channelPrefix}`, hostVersion, packageVersion: immutablePackageVersion, compatVersion, keyId: packageResult.envelope.keyId, publicKey: key.publicKeyBase64, namespace: packageNamespace, branchNamespace,
            ...(parsedOrigin.protocol === "http:" ? { debugHttpHosts: [parsedOrigin.hostname] } : {}) },
        },
        bootstrapAssets,
      }, null, 2) + "\n");
      publishedPackages.push({
        id: pkg.id,
        updateUrl: packageManifestPath,
        manifestUrl: packageManifestUrl,
        hostConfigUrl: packageHostConfigPath,
        keyId: packageResult.envelope.keyId,
        version: childVersion,
        build: packageBuild,
      });
    }

    if (legacyStableEquivalent) {
      // A pre-journal Editor may already own the exact stable bytes in the
      // mutable slot. Migrate those files into the first immutable release
      // instead of re-signing them with a new signedAt timestamp.
      await rm(releaseRoot, { recursive: true, force: true });
      for (const pkg of packageRecords) {
        const source = pocketReleaseDirectory(workspace.updates, legacyHostVersion, pkg.id, packageVersion);
        if (!existsSync(join(source, "latest.json"))) {
          throw new Error(`legacy stable package ${pkg.id} is missing its published manifest`);
        }
        const destination = pocketReleaseDirectory(releaseRoot, hostVersion, pkg.id, immutablePackageVersion);
        await cp(source, destination, { recursive: true });
        await rewriteImmutableHostConfig(join(destination, "host.json"), legacyHostVersion, pkg.id, packageVersion, releaseId, `${safeOrigin}/${channelPrefix}`);
      }
      if (legacyStableEquivalent) {
        result = resultFromPublishedDirectory(pocketReleaseDirectory(releaseRoot, hostVersion, config.appId, immutablePackageVersion));
      }
    }

    // Every package, including the root SystemUI package, gets a small
    // immutable bootstrap descriptor. The root package used to omit this
    // metadata, which made a single aggregate host config unable to describe
    // how to hydrate all trusted applications after a cold start.
    const snapshotPackages = new Map(resourceSnapshot.packages.map((pkg) => [pkg.id, pkg]));
    for (const pkg of packageRecords) {
      const packageReleaseDir = pocketReleaseDirectory(releaseRoot, hostVersion, pkg.id, immutablePackageVersion);
      const sourceDirectory = pkg.id === rootPackage.id
        ? rootDirectory
        : resourceArtifactDirectory(buildDir, snapshotPackages.get(pkg.id)!);
      const bootstrapDirectory = join(packageReleaseDir, "bootstrap");
      await mkdir(bootstrapDirectory, { recursive: true });
      const bootstrapFiles: Array<[string, string]> = [["app.bytecode.json", "app.bytecode.json"]];
      if (existsSync(join(sourceDirectory, "guest-manifest.json"))) bootstrapFiles.push(["guest-manifest.json", "guest-manifest.json"]);
      for (const [sourceName, destinationName] of bootstrapFiles) {
        const destination = join(bootstrapDirectory, destinationName);
        if (!existsSync(destination)) await cp(join(sourceDirectory, sourceName), destination);
      }
    }

    const aggregatePackages: AggregateHostPackage[] = [];
    for (const pkg of packageRecords) {
      const packageReleaseDir = pocketReleaseDirectory(releaseRoot, hostVersion, pkg.id, immutablePackageVersion);
      const packageHost = await readJsonFile<Record<string, unknown>>(join(packageReleaseDir, "host.json"), {});
      let packagePayloadSha256: string | undefined;
      try {
        const packageEnvelope = await readJsonFile<Record<string, unknown>>(join(packageReleaseDir, "latest.json"));
        if (typeof packageEnvelope.payload === "string") packagePayloadSha256 = sha256Hex(Buffer.from(packageEnvelope.payload, "base64"));
      } catch {
        // The signed manifest remains authoritative if a legacy package lacks
        // an optional digest field.
      }
      const packageUpdates = isObject(packageHost.config) && isObject(packageHost.config.updates) ? packageHost.config.updates : undefined;
      const packageKeyId = pkg.id === rootPackage.id
        ? (typeof packageHost.POCKET_UPDATE_KEY_ID === "string" ? packageHost.POCKET_UPDATE_KEY_ID : result.envelope.keyId)
        : (typeof packageUpdates?.keyId === "string" ? packageUpdates.keyId : result.envelope.keyId);
      const packagePublicKey = pkg.id === rootPackage.id
        ? (typeof packageHost.POCKET_UPDATE_PUBLIC_KEY === "string" ? packageHost.POCKET_UPDATE_PUBLIC_KEY : key.publicKeyBase64)
        : (typeof packageUpdates?.publicKey === "string" ? packageUpdates.publicKey : key.publicKeyBase64);
      const packagePath = historyPackagePath(hostVersion, pkg.id, releaseId);
      const bootstrapAssets: Record<string, { url: string; sha256: string; size: number }> = {};
      for (const name of ["app.bytecode.json", "guest-manifest.json"]) {
        const bootstrapFile = join(packageReleaseDir, "bootstrap", name);
        if (!existsSync(bootstrapFile)) continue;
        const bytes = new Uint8Array(await readFile(bootstrapFile));
        const asset = `assets/apps/${pkg.id}/${name}`;
        bootstrapAssets[asset] = { url: `${safeOrigin}${packagePath}/bootstrap/${name}`, sha256: sha256Hex(bytes), size: bytes.length };
      }
      const descriptor: AggregateHostPackage = {
        id: pkg.id,
        appId: pkg.id,
        version: pkg.version,
        build: pkg.build,
        packageVersion: immutablePackageVersion,
        updateUrl: `${safeOrigin}${packagePath}/latest.json`,
        manifestUrl: `${safeOrigin}${packagePath}/latest.json`,
        hostConfigUrl: `${safeOrigin}${packagePath}/host.json`,
        keyId: packageKeyId,
        publicKey: packagePublicKey,
        ...(packagePayloadSha256 ? { payloadSha256: packagePayloadSha256 } : {}),
        ...(pkg.id === rootPackage.id && packagePayloadSha256 ? { rootPayloadSha256: packagePayloadSha256 } : {}),
        bootstrapAssets,
        ...(isObject(packageHost.config) ? { config: packageHost.config } : {}),
      };
      aggregatePackages.push(descriptor);
    }
    aggregatePackages.push(...reusedPackages);
    const rootHostPath = join(releaseDir, "host.json");
    const rootHost = await readJsonFile<Record<string, unknown>>(rootHostPath, {});
    // Immutable descriptors keep the channel prefix they were published
    // under. The fixed index chooses the branch; an archive must not silently
    // switch a release's base to the other channel after export.
    rootHost.POCKET_UPDATE_BASE_URL = `${safeOrigin}/${channelPrefix}`;
    // Keep the compositor handle allocation in the signed aggregate
    // descriptor. This is derived from the same build snapshot/catalog used
    // by Preview, so remote SystemUI does not need a native hard-coded child
    // map to discover mini apps.
    const compositorSurfaces = await compositorSurfacesFromProject(buildDir);
    const aggregateHost = aggregateHostConfig({
      rootHost,
      hostVersion,
      rootAppId: config.appId,
      version,
      build,
      compatVersion,
      channel,
      slot,
      routeVersion,
      releaseId,
      branchNamespace: updateNamespace(id, hostVersion, compatVersion, channel),
      packages: aggregatePackages,
      hostVersionSource: options.hostVersionSource,
      ...(compositorSurfaces ? { compositorSurfaces } : {}),
    });
    await writeFile(rootHostPath, JSON.stringify(aggregateHost, null, 2) + "\n");
    // Include the semantic root entry point in exported archives. The
    // descriptor itself points at immutable releaseId package URLs, so this
    // alias is self-contained and does not depend on the live journal.
    for (const alias of new Set([routeVersion, compatVersion])) {
      const aggregateAliasDirectory = pocketReleaseDirectory(releaseRoot, hostVersion, config.appId, alias);
      if (aggregateAliasDirectory === releaseDir) continue;
      await mkdir(aggregateAliasDirectory, { recursive: true });
      await cp(rootHostPath, join(aggregateAliasDirectory, "host.json"));
    }

    if (channel === "release" && previousEntry) {
      const allCurrentPackages = new Set(packageRecords.map((pkg) => pkg.id));
      if (config.build === previousEntry.build) {
        if (!payloadsEqual(packagePayloads.get(config.appId) ?? {}, previousRootPayload)) {
          throw new Error(`stable release build ${config.build} already exists with different package contents`);
        }
        if (allCurrentPackages.size !== previousEntry.packages.length) {
          throw new Error(`stable release build ${config.build} already exists with different package contents`);
        }
      }
      let stableEquivalent = config.build === previousEntry.build && packageRecords.length === previousEntry.packages.length &&
        sameReusedPackages(previousEntry.reusedPackages, reusedPackageRecords);
      for (const previousPackage of previousEntry.packages) {
        const nextPackage = packageRecords.find((pkg) => pkg.id === previousPackage.id);
        if (!nextPackage) {
          stableEquivalent = false;
          continue;
        }
        if (nextPackage.build < previousPackage.build) {
          throw new Error(`stable package ${nextPackage.id} build ${nextPackage.build} is older than the current build ${previousPackage.build}`);
        }
        const equivalentPackage = nextPackage.build === previousPackage.build && payloadsEqual(packagePayloads.get(nextPackage.id) ?? {}, await readPayload(previousPackage.artifactRoot));
        if (nextPackage.build === previousPackage.build && !equivalentPackage) {
          throw new Error(`stable package ${nextPackage.id} build ${nextPackage.build} already exists with different package contents`);
        }
        if (!equivalentPackage) stableEquivalent = false;
      }
      if (config.build === previousEntry.build && !stableEquivalent) {
        throw new Error(`stable release build ${config.build} already exists with different package contents`);
      }
      if (stableEquivalent) {
        // The package comparison above already checked each payload against its
        // prior immutable copy. Do not create a second audit entry for a
        // semantically identical stable publish merely because signedAt moved.
        await rm(releaseRoot, { recursive: true, force: true });
        const oldRoot = previousEntry.packages.find((pkg) => pkg.id === config.appId);
        if (!oldRoot) throw new Error("stable history is missing its root package");
        state.publish = {
          revision: state.revision,
          updateUrl: `${releasePath}/latest.json`,
          manifestUrl,
          hostConfigUrl: `${safeOrigin}/pocket/${hostVersion}/${encodeURIComponent(config.appId)}/${previousEntry.compatVersion ?? compatVersion}/host.json`,
          appConfigUrl: packageIndexUrl,
          archiveUrl: `/releases/${id}.tar.gz`,
          keyId: previousEntry.keyId,
          runtimeAbi: previousEntry.runtimeAbi,
          payloadSha256: previousEntry.payloadSha256,
          version: previousEntry.version,
          build: previousEntry.build,
          channel: "release",
          hostVersion,
          packageVersion: compatVersion,
          releaseId: previousEntry.releaseId,
          publishedAt: previousEntry.publishedAt,
          ...(parsedOrigin.hostname === "127.0.0.1" ? {} : { lanOrigin: safeOrigin }),
          ...(publishedPackages.length > 0 ? { packages: publishedPackages } : {}),
          ...(reusedPackageRecords.length > 0 ? { reusedPackages: reusedPackageRecords } : {}),
        };
        await saveState(workspace, id, state);
        return resultFromPublishedDirectory(safeChild(workspace.updates, oldRoot.artifactRoot));
      }
    }

    const archiveFilename = offline ? `offline-${releaseId}.tar.gz` : `${releaseId}.tar.gz`;
    archivePath = join(workspace.updates, offline ? ".downloads" : ".history", id, archiveFilename);
    await runProcess(["tar", "-czf", archivePath, "-C", releaseRoot, "."], root, offline ? () => {} : (line) => pushLog(state, line));
    if (offline) {
      await rm(releaseRoot, { recursive: true, force: true });
      return { ...result, releaseId, offlineArchivePath: archivePath, offlineFilename: archiveFilename };
    }
    const entry: PublishedVersion = {
      id: releaseId,
      releaseId,
      slot,
      channel,
      version,
      build,
      compatVersion,
      routeVersion,
      revision: state.revision,
      publishedAt: now(),
      hostVersion,
      packageVersion: immutablePackageVersion,
      keyId: result.envelope.keyId,
      runtimeAbi: String(metadata.runtimeAbi),
      payloadSha256: sha256Hex(result.payloadBytes),
      archivePath: relative(workspace.updates, archivePath).replaceAll("\\", "/"),
      packages: packageRecords,
      ...(reusedPackageRecords.length > 0 ? { reusedPackages: reusedPackageRecords } : {}),
    };
    const nextHistory: VersionHistory = {
      schemaVersion: 1,
      current: {
        ...history.current,
        [versionBranchKey(hostVersion, compatVersion, slot)]: releaseId,
        ...(history.entries.length === 0 && !history.current[slot] ? { [slot]: releaseId } : {}),
      },
      entries: [entry, ...history.entries],
    };
    await writeVersionHistoryAtomic(historyPath, nextHistory);
    historyCommitted = true;
    if (channel === "test") {
      try {
        await writeFile(counterPath, JSON.stringify({ build }) + "\n");
        // Keep the pre-branch sidecar for older Editor readers. New branches
        // never consume it once their own counter exists.
        await writeFile(legacyCounterPath, JSON.stringify({ build }) + "\n");
      } catch (error) {
        pushLog(state, `test release counter could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.publish = {
      revision: state.revision,
      updateUrl: `${releasePath}/latest.json`,
      manifestUrl,
      hostConfigUrl,
      appConfigUrl: packageIndexUrl,
      archiveUrl: `/releases/${id}.tar.gz`,
      keyId: result.envelope.keyId,
      runtimeAbi: String(metadata.runtimeAbi),
      payloadSha256: sha256Hex(result.payloadBytes),
      version, build, channel, hostVersion, packageVersion: compatVersion,
      releaseId,
      publishedAt: entry.publishedAt,
      ...(parsedOrigin.hostname === "127.0.0.1" ? {} : { lanOrigin: safeOrigin }),
      ...(publishedPackages.length > 0 ? { packages: publishedPackages } : {}),
      ...(reusedPackageRecords.length > 0 ? { reusedPackages: reusedPackageRecords } : {}),
    };
    try {
      await saveState(workspace, id, state);
    } catch (error) {
      // The history journal is the publish commit point. A state mirror write
      // must not turn an already-downloadable immutable release into a failed
      // HTTP publish response.
      pushLog(state, `publish state mirror could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  } catch (error) {
    if (!historyCommitted) {
      await rm(releaseRoot, { recursive: true, force: true });
      if (archivePath) await rm(archivePath, { force: true });
    }
    throw error;
  }
}

async function editorUpdateTrust(workspace: Workspace, id: string): Promise<{ keyPath: string; key: PublicKeyConfig }> {
  const keyPath = join(workspace.keys, "editor-dev-key.json");
  await mkdir(workspace.keys, { recursive: true });
  if (!existsSync(keyPath)) generateDevKey(keyPath, `editor-${id}`);
  // The signing helper owns the private key file. Only public fields leave
  // this function or enter Flutter's compile-time configuration.
  const stored = await readJsonFile<PublicKeyConfig>(keyPath);
  return { keyPath, key: { keyId: stored.keyId, publicKeyBase64: stored.publicKeyBase64 } };
}

async function listAssets(projectDir: string): Promise<string[]> {
  const directory = safeProjectFile(projectDir, "assets", { allowAssets: true, isDirectory: true });
  await mkdir(directory, { recursive: true });
  const checkedDirectory = safeProjectFile(projectDir, "assets", { allowAssets: true, isDirectory: true });
  const entries = await readdir(checkedDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) pathFailure(`symbolic links are not allowed: assets/${entry.name}`);
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".qjbc": return "application/octet-stream";
    case ".pak": return "application/octet-stream";
    case ".gz": return "application/gzip";
    default: return "application/octet-stream";
  }
}

/** Same-origin comparison shared by the write guard and the new read routes. */
function checkSameOrigin(originHeader: string | null, url: URL, hostUrl: URL, serverPort: number): Response | null {
  if (originHeader === null) return null;
  if (originHeader === "null") {
    return failure("forbidden: null Origin not allowed", 403);
  }
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return failure("forbidden: invalid Origin header", 403);
  }
  const originPort = originUrl.port || "80";
  if (
    originUrl.protocol !== url.protocol ||
    originUrl.origin !== hostUrl.origin ||
    originPort !== String(serverPort)
  ) {
    return failure("forbidden: cross-origin requests not allowed", 403);
  }
  return null;
}

/**
 * GET guard for the Studio watch/build-events/chunks/stat routes only: a page on another origin must not
 * hold watch slots or read project bytes. Requests without Origin/Sec-Fetch-Site (the Flutter host,
 * curl, tests) are unaffected.
 */
function validateNewReadRoute(req: Request, url: URL, serverPort: number): Response | null {
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return failure("forbidden: cross-origin fetch-site not allowed", 403);
  const hostHeader = req.headers.get("host") ?? "";
  let hostUrl: URL;
  try { hostUrl = new URL(`http://${hostHeader}`); } catch { return failure("forbidden: invalid Host header", 403); }
  return checkSameOrigin(req.headers.get("origin"), url, hostUrl, serverPort);
}

function validateRequestSecurity(req: Request, url: URL, serverPort: number, csrfToken: string, bindHost: string): Response | null {
  const allowedHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(bindHost)) {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue;
        allowedHostnames.add(entry.family === "IPv6" ? `[${entry.address}]` : entry.address);
      }
    }
  }

  const hostHeader = req.headers.get("host");
  if (!hostHeader) {
    return failure("forbidden: missing Host header", 403);
  }
  let dummyUrl: URL;
  try {
    dummyUrl = new URL(`http://${hostHeader}`);
  } catch {
    return failure("forbidden: invalid Host header", 403);
  }
  if (!allowedHostnames.has(dummyUrl.hostname)) {
    return failure("forbidden: host not allowed", 403);
  }
  if (dummyUrl.port !== "") {
    if (Number(dummyUrl.port) !== serverPort) {
      return failure("forbidden: host port mismatch", 403);
    }
  }

  const method = req.method.toUpperCase();
  const mutatingMethods = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  if (mutatingMethods.has(method)) {
    const secFetchSite = req.headers.get("sec-fetch-site");
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return failure("forbidden: cross-origin fetch-site not allowed", 403);
    }

    const secFetchMode = req.headers.get("sec-fetch-mode");
    if (secFetchMode && (secFetchMode === "navigate" || secFetchMode === "no-cors")) {
      return failure("forbidden: browser navigation/no-cors write not allowed", 403);
    }

    const originFailure = checkSameOrigin(req.headers.get("origin"), url, dummyUrl, serverPort);
    if (originFailure) return originFailure;

    const refererHeader = req.headers.get("referer");
    if (refererHeader !== null) {
      let refererUrl: URL;
      try {
        refererUrl = new URL(refererHeader);
      } catch {
        return failure("forbidden: cross-origin referer not allowed", 403);
      }
      const refererPort = refererUrl.port || "80";
      if (
        refererUrl.protocol !== url.protocol ||
        refererUrl.origin !== dummyUrl.origin ||
        refererPort !== String(serverPort)
      ) {
        return failure("forbidden: cross-origin referer not allowed", 403);
      }
    }

    if (req.headers.has("x-pocket-csrf") && req.headers.get("x-pocket-csrf") !== csrfToken) {
      return failure("forbidden: invalid CSRF token", 403);
    }

    const isAssetUpload = method === "POST" && /^\/api\/projects\/[^/]+\/assets$/i.test(url.pathname);
    const hasCsrf = req.headers.get("x-pocket-csrf") === csrfToken;
    const hasEditor = req.headers.get("x-pocket-editor") === "1";
    if (!isAssetUpload && !hasCsrf && !hasEditor) {
      return failure("forbidden: missing CSRF token or editor credential", 403);
    }
  }

  return null;
}

export async function startEditor(options: StartEditorOptions = {}): Promise<EditorServer> {
  const csrfToken = randomUUID();
  const workspaceRoot = resolve(options.workspace ?? process.env.POCKET_EDITOR_WORKSPACE ?? join(root, ".pocket-build/editor-workspace"));
  const configuredProject = options.projectRoot ?? process.env.POCKET_EDITOR_PROJECT_ROOT;
  let projectRoot: string | undefined;
  let projectId: string | undefined;
  if (configuredProject) {
    projectRoot = resolve(configuredProject);
    if (!existsSync(projectRoot) || !lstatSync(projectRoot).isDirectory()) {
      throw new Error(`editor project root is not a directory: ${projectRoot}`);
    }
    if (lstatSync(projectRoot).isSymbolicLink()) throw new Error("editor project root must not be a symlink");
    // Check config paths via safeProjectFile before reading either one during
    // startup ID discovery. Never follow a symlinked config file; defer the 400
    // rejection to the config/project API routes.
    let editor: Record<string, unknown> = {};
    let pocket: Record<string, unknown> = {};
    try {
      const editorPath = safeProjectFile(projectRoot, "editor.json", { allowConfig: true });
      editor = await readJsonFile<Record<string, unknown>>(editorPath, {});
    } catch {
      editor = {};
    }
    try {
      const pocketPath = safeProjectFile(projectRoot, "pocket.json", { allowConfig: true });
      pocket = await readJsonFile<Record<string, unknown>>(pocketPath, {});
    } catch {
      pocket = {};
    }
    const candidate = typeof editor.id === "string"
      ? editor.id
      : typeof pocket.name === "string"
      ? pocket.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
      : basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    projectId = asProjectId(candidate || "external-project");
  }
  const workspace: Workspace = {
    root: workspaceRoot,
    projects: join(workspaceRoot, "projects"),
    builds: join(workspaceRoot, "builds"),
    updates: join(workspaceRoot, "updates"),
    keys: join(workspaceRoot, "keys"),
    states: join(workspaceRoot, "states"),
    ...(projectRoot ? { projectRoot, projectId } : {}),
  };
  workspace.projectSources = new Map();
  if (projectRoot && projectId) {
    try {
      workspace.projectSources = await loadCatalogProjectSources(projectRoot, projectId, workspace.projects);
    } catch (error) {
      console.warn(`Editor catalog-backed projects are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const flutterRoot = options.flutterRoot ?? process.env.POCKET_EDITOR_FLUTTER_ROOT;
  if (flutterRoot && !workspace.projectRoot) throw new Error("a Flutter consumer must be bound to an explicit JS project root");
  const explicitHostVersion = options.updateHostVersion ?? process.env.POCKET_EDITOR_HOST_VERSION;
  const inferredHostVersion = pubspecHostVersion(flutterRoot ?? root);
  const updateHostVersion = explicitHostVersion ?? inferredHostVersion ?? "editor";
  const updateHostVersionSource = explicitHostVersion ? "explicit" : inferredHostVersion ? (flutterRoot ? "flutter-pubspec" : "sdk-pubspec") : "legacy-fallback";
  const explicitPackageVersion = options.updatePackageVersion ?? process.env.POCKET_EDITOR_PACKAGE_VERSION;
  const inferredPackageVersion = flutterRoot ? bytecodeAssetVersion(flutterRoot) : undefined;
  const updatePackageVersion = explicitPackageVersion ?? inferredPackageVersion;
  const updatePackageVersionSource = explicitPackageVersion ? "explicit" : inferredPackageVersion ? "flutter-asset" : "project-first-publish";
  await Promise.all([mkdir(workspace.projects, { recursive: true }), mkdir(workspace.builds, { recursive: true }), mkdir(workspace.updates, { recursive: true }), mkdir(workspace.keys, { recursive: true }), mkdir(workspace.states, { recursive: true })]);
  const states = new Map<string, EditorState>();
  const stateLoads = new Map<string, Promise<EditorState>>();
  const projectWrites = new Set<string>();
  const backupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let backupSchedulerStopped = false;
  const publishSlots = new Set<string>();
  type UploadSession = { projectId: string; path: string; totalBytes: number; sha256: string; chunks: Buffer[]; received: number; timer: ReturnType<typeof setTimeout> };
  const uploads = new Map<string, UploadSession>();
  let bufferedUploadBytes = 0;
  const maxBufferedUploadBytes = options.maxBufferedUploadBytes ?? defaultMaxBufferedUploadBytes;
  const buildScope: BuildScope = {
    controllers: new Set(),
    timeoutMs: options.buildTimeoutMs ?? (Number(process.env.POCKET_EDITOR_BUILD_TIMEOUT_MS) > 0 ? Number(process.env.POCKET_EDITOR_BUILD_TIMEOUT_MS) : defaultBuildTimeoutMs),
  };
  const dropUpload = (uploadId: string): void => {
    const session = uploads.get(uploadId);
    if (session) {
      clearTimeout(session.timer);
      bufferedUploadBytes -= session.received;
    }
    uploads.delete(uploadId);
  };
  const touchUpload = (uploadId: string, session: UploadSession): void => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => dropUpload(uploadId), uploadIdleMs);
    session.timer.unref?.();
  };
  type WatchClient = { send: (value: unknown) => void; close: () => void; revision: number };
  type ProjectWatch = { watcher: FSWatcher; clients: Set<WatchClient>; pending: Map<string, boolean>; timer?: ReturnType<typeof setTimeout>; unsubscribe: () => void };
  const projectWatches = new Map<string, ProjectWatch>();
  let watchClientCount = 0;
  let buildEventClientCount = 0;
  const closeProjectWatch = (id: string): void => {
    const entry = projectWatches.get(id);
    if (!entry) return;
    projectWatches.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.unsubscribe();
    try { entry.watcher.close(); } catch { /* closed */ }
  };
  const runner = options.buildRunner ?? realBuild;
  if (!appIdPattern.test(updateHostVersion)) throw new Error("Editor update host version is invalid");
  if (updatePackageVersion !== undefined && !appIdPattern.test(updatePackageVersion)) throw new Error("Editor update package version is invalid");
  const getState = async (id: string): Promise<EditorState> => {
    const cached = states.get(id);
    if (cached) return cached;
    let loading = stateLoads.get(id);
    if (!loading) {
      loading = loadState(workspace, id).then(async (loaded) => {
        const state = await bindCatalogProjectState(workspace, id, loaded);
        states.set(id, state);
        armNovelBackup(id, state);
        return state;
      }).finally(() => stateLoads.delete(id));
      stateLoads.set(id, loading);
    }
    return loading;
  };
  const projectDir = (id: string) => projectDirectory(workspace, id);
  const diagnostics = createStudioDiagnostics(workspace.root);
  await mkdir(join(workspace.root, "wechat-preview"), { recursive: true });
  const wechat = createWechatPreviewManager({ projectDirectory: projectDir, workspaceRoot: join(workspace.root, "wechat-preview") });
  const sdkRoot = root;
  const sdkRootStat = lstatIfExists(sdkRoot);
  if (!sdkRootStat?.isDirectory() || sdkRootStat.isSymbolicLink()) throw new Error("editor SDK root must be a real directory");
  const upgradeTargetRoot = resolve(options.upgradeSdkRoot ?? process.env.POCKET_STUDIO_UPGRADE_SDK_ROOT ?? sdkRoot);
  const installedSdkVersion = readInstalledSdkInfo(upgradeTargetRoot).currentVersion;
  let canApplyStudioUpgrade = (): { allowed: boolean; reason?: string } => ({ allowed: true });
  const studioUpgrade = createStudioUpgradeManager({
    sdkRoot: upgradeTargetRoot,
    canApplyUpgrade: () => canApplyStudioUpgrade(),
    ...(options.upgradeOptions ?? {}),
  });
  type ResolvedPublishedPackage = { projectId: string; entry: PublishedVersion; package: PublishedVersionPackage };
  const resolveCompatVersion = async (id: string, config: EditorConfig, state?: EditorState, history?: VersionHistory): Promise<string> => {
    if (updatePackageVersion) return updatePackageVersion;
    const sourceHistory = history ?? await readVersionHistory(versionHistoryPath(workspace.states, id));
    const existing = sourceHistory.entries.find((entry) => entry.hostVersion === updateHostVersion && (entry.compatVersion ?? entry.version));
    if (existing?.compatVersion) return existing.compatVersion;
    if (existing?.version && !state?.publish) return existing.version;
    return config.version;
  };
  // Resolve the root from its published signed payload, never package order.
  const entryRootPackage = async (entry: PublishedVersion): Promise<PublishedVersionPackage | undefined> => {
    for (const pkg of entry.packages) {
      try {
        const envelope = await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/latest.json`));
        if (typeof envelope.payload === "string" && sha256Hex(Buffer.from(envelope.payload, "base64")) === entry.payloadSha256) return pkg;
      } catch {
        // A missing artifact cannot establish the root identity.
      }
    }
    return undefined;
  };
  const findPublishedPackage = async (host: string, packageId: string, packageVersion?: string, slot?: VersionSlot, allEntries = false, artifactPath?: string): Promise<ResolvedPublishedPackage | undefined> => {
    let files: Array<import("node:fs").Dirent> = [];
    try {
      files = await readdir(workspace.states, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".versions.json")) continue;
      const projectId = file.name.slice(0, -".versions.json".length);
      if (!projectIdPattern.test(projectId)) continue;
      let history: VersionHistory;
      try {
        history = await readVersionHistory(join(workspace.states, file.name));
      } catch {
        continue;
      }
      let preferredSlot = slot;
      if (!preferredSlot && packageVersion !== undefined) {
        try {
          const projectState = await loadState(workspace, projectId);
          preferredSlot = projectState.publish?.channel === "test" ? "test" : projectState.publish?.channel === "release" ? "stable" : undefined;
        } catch {
          // A missing state mirror must not hide an immutable history entry.
        }
      }
      const candidates = slot && !allEntries
        ? (packageVersion === undefined
          ? [history.entries.find((entry) => entry.slot === slot && entry.hostVersion === host)]
          : [
            currentVersion(history, slot, host, packageVersion),
            history.entries.find((entry) => entry.slot === slot && entry.hostVersion === host && entry.packageVersion === packageVersion),
          ]).filter((entry, index, all): entry is PublishedVersion => !!entry && all.findIndex((candidate) => candidate?.id === entry.id) === index)
        : slot
          ? history.entries.filter((entry) => entry.slot === slot)
          : preferredSlot && packageVersion !== undefined
            ? [currentVersion(history, preferredSlot, host, packageVersion), ...history.entries].filter((entry, index, all): entry is PublishedVersion => !!entry && all.findIndex((candidate) => candidate?.id === entry.id) === index)
            : history.entries;
      for (const entry of candidates) {
        const packageEntry = entry.packages.find((candidate) => candidate.id === packageId);
        if (!packageEntry) continue;
        const isRootPackage = (await entryRootPackage(entry))?.id === packageId;
        const routeVersion = entry.routeVersion ?? entry.version;
        const matchesVersion = packageVersion === undefined || entry.packageVersion === packageVersion || (entry.compatVersion ?? entry.version) === packageVersion || (isRootPackage && routeVersion === packageVersion);
        if (entry.hostVersion !== host || !matchesVersion) continue;
        if (artifactPath) {
          try {
            safeArtifactFile(workspace.updates, `${packageEntry.artifactRoot}/${artifactPath}`);
          } catch {
            continue;
          }
        }
        return { projectId, entry, package: packageEntry };
      }
    }
    return undefined;
  };
  const resolveReusePublishedPackage = async (
    packageId: string,
    host: string,
    channel: "test" | "release",
    origin: string,
    publishingKey: PublicKeyConfig,
    exceptProjectId: string,
  ): Promise<AggregateHostPackage> => {
    const slot = versionSlot(channel);
    const files = await readdir(workspace.states, { withFileTypes: true });
    const owners: ResolvedPublishedPackage[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".versions.json")) continue;
      const ownerId = file.name.slice(0, -".versions.json".length);
      if (!projectIdPattern.test(ownerId)) continue;
      let history: VersionHistory;
      try {
        history = await readVersionHistory(join(workspace.states, file.name));
      } catch {
        continue;
      }
      const entry = history.entries.find((candidate) =>
        candidate.hostVersion === host && candidate.slot === slot && candidate.channel === channel &&
        candidate.packages.some((candidatePackage) => candidatePackage.id === packageId));
      const pkg = entry?.packages.find((candidate) => candidate.id === packageId);
      if (entry && pkg) owners.push({ projectId: ownerId, entry, package: pkg });
    }
    const ownerIds = new Set(owners.map((owner) => owner.projectId));
    if (ownerIds.size !== 1 || owners.length === 0) throw new Error(`reused package ${packageId} has no unique published ${channel} owner for host ${host}`);
    const owner = owners[0]!;
    if (owner.projectId === exceptProjectId) throw new Error(`reused package ${packageId} must be owned by a different project`);
    const { entry, package: pkg } = owner;
    if (!entry.releaseId || entry.packageVersion !== entry.releaseId) throw new Error(`reused package ${packageId} has no immutable owner release`);

    const rootPackage = await entryRootPackage(entry);
    if (!rootPackage) throw new Error(`reused package ${packageId} owner release has no verifiable root package`);
    const rootEnvelope = await readJsonFile<SignedManifest>(safeArtifactFile(workspace.updates, `${rootPackage.artifactRoot}/latest.json`));
    const rootHost = await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.updates, `${rootPackage.artifactRoot}/host.json`));
    const release = isObject(rootHost.release) ? rootHost.release : undefined;
    const rootKeyId = rootHost.POCKET_UPDATE_KEY_ID;
    const rootPublicKey = rootHost.POCKET_UPDATE_PUBLIC_KEY;
    if (rootHost.kind !== "pocket-editor-app-host" || rootHost.systemUI !== rootPackage.id ||
        release?.appId !== rootPackage.id || release.releaseId !== entry.releaseId ||
        release.channel !== channel || release.slot !== slot || rootHost.POCKET_HOST_VERSION !== host ||
        typeof rootKeyId !== "string" || typeof rootPublicKey !== "string" ||
        rootKeyId !== entry.keyId || rootKeyId !== publishingKey.keyId || rootPublicKey !== publishingKey.publicKeyBase64 ||
        typeof rootEnvelope.payload !== "string" || sha256Hex(Buffer.from(rootEnvelope.payload, "base64")) !== entry.payloadSha256 ||
        rootEnvelope.keyId !== rootKeyId) {
      throw new Error(`reused package ${packageId} owner root descriptor does not match the signed host release`);
    }
    const publicBytes = Buffer.from(rootPublicKey, "base64");
    if (publicBytes.byteLength !== 32) throw new Error(`reused package ${packageId} has an invalid Ed25519 trust key`);
    const publicPem = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]),
      format: "der",
      type: "spki",
    }).export({ format: "pem", type: "spki" }).toString();
    const decodePayload = (envelope: SignedManifest): Record<string, unknown> => {
      const bytes = verifySignedManifest(envelope, publicPem);
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!isObject(value)) throw new Error("signed package payload is not an object");
      return value;
    };
    const rootPayload = decodePayload(rootEnvelope);
    if (rootPayload.appId !== rootPackage.id || rootPayload.version !== entry.version || Number(rootPayload.build) !== entry.build) {
      throw new Error(`reused package ${packageId} owner root signature does not match its release journal`);
    }

    const immutablePath = historyPackagePath(host, packageId, entry.releaseId);
    const manifestUrl = `${origin}${immutablePath}/latest.json`;
    const hostConfigUrl = `${origin}${immutablePath}/host.json`;
    const envelope = await readJsonFile<SignedManifest>(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/latest.json`));
    const packageHost = await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/host.json`));
    const rootApplications = isObject(rootHost.applications) ? rootHost.applications : undefined;
    const storedDescriptor = rootApplications && isObject(rootApplications[packageId]) ? rootApplications[packageId] : undefined;
    if (!storedDescriptor || storedDescriptor.id !== packageId || storedDescriptor.appId !== packageId ||
        storedDescriptor.version !== pkg.version || Number(storedDescriptor.build) !== pkg.build ||
        storedDescriptor.packageVersion !== entry.packageVersion || storedDescriptor.keyId !== rootKeyId ||
        storedDescriptor.publicKey !== rootPublicKey || typeof storedDescriptor.manifestUrl !== "string" ||
        typeof storedDescriptor.hostConfigUrl !== "string" || typeof storedDescriptor.updateUrl !== "string") {
      throw new Error(`reused package ${packageId} owner aggregate descriptor does not match its release`);
    }
    const expectedPath = `${immutablePath}/latest.json`;
    for (const field of ["manifestUrl", "updateUrl"] as const) {
      if (new URL(String(storedDescriptor[field]), origin).pathname !== expectedPath) throw new Error(`reused package ${packageId} has a mutable package URL`);
    }
    if (new URL(storedDescriptor.hostConfigUrl, origin).pathname !== `${immutablePath}/host.json`) throw new Error(`reused package ${packageId} has a mutable host config URL`);
    if (typeof envelope.payload !== "string" || envelope.keyId !== rootKeyId ||
        sha256Hex(Buffer.from(envelope.payload, "base64")) !== storedDescriptor.payloadSha256) {
      throw new Error(`reused package ${packageId} signed manifest does not match its descriptor`);
    }
    const payload = decodePayload(envelope);
    if (payload.appId !== packageId || payload.version !== pkg.version || Number(payload.build) !== pkg.build || !Array.isArray(payload.files)) {
      throw new Error(`reused package ${packageId} signature does not match its owner journal`);
    }
    for (const file of payload.files) {
      if (!isObject(file) || typeof file.url !== "string" || !Number.isSafeInteger(file.size) || typeof file.sha256 !== "string") {
        throw new Error(`reused package ${packageId} signed file list is invalid`);
      }
      const bytes = new Uint8Array(await readFile(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/${file.url}`)));
      if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) throw new Error(`reused package ${packageId} signed artifact is missing or corrupt`);
    }

    const isRootPackage = rootPackage.id === packageId;
    let packageConfig: Record<string, unknown>;
    let packageBootstrap: unknown;
    if (isRootPackage) {
      if (packageHost.kind !== "pocket-editor-app-host") throw new Error(`reused root package ${packageId} has no aggregate host descriptor`);
      packageBootstrap = storedDescriptor.bootstrapAssets;
      const packageUpdates: Record<string, unknown> = {
        baseUrl: `${origin}/${channelUpdatePrefix(channel)}`,
        hostVersion: host,
        packageVersion: entry.packageVersion,
        compatVersion: entry.compatVersion,
        keyId: rootKeyId,
        publicKey: rootPublicKey,
        namespace: rootHost.POCKET_STORE_NAMESPACE,
        branchNamespace: rootHost.POCKET_UPDATE_BRANCH_NAMESPACE,
      };
      if (typeof rootHost.POCKET_UPDATE_DEBUG_HTTP_HOST === "string") packageUpdates.debugHttpHosts = [rootHost.POCKET_UPDATE_DEBUG_HTTP_HOST];
      packageConfig = {
        appId: packageId,
        downloadOnOpen: true,
        metadataAsset: `assets/apps/${packageId}/app.bytecode.json`,
        updates: packageUpdates,
      };
      if (isObject(packageBootstrap) && Object.hasOwn(packageBootstrap, `assets/apps/${packageId}/guest-manifest.json`)) {
        packageConfig.manifestAsset = `assets/apps/${packageId}/guest-manifest.json`;
      }
    } else {
      if (packageHost.kind !== "pocket-mini-app-host-template" || !isObject(packageHost.config) ||
          packageHost.config.appId !== packageId || !isObject(packageHost.config.updates)) {
        throw new Error(`reused package ${packageId} has no mini-app host configuration`);
      }
      const childUpdates = packageHost.config.updates;
      if (childUpdates.hostVersion !== host || childUpdates.packageVersion !== entry.packageVersion ||
          childUpdates.compatVersion !== entry.compatVersion || childUpdates.keyId !== rootKeyId ||
          childUpdates.publicKey !== rootPublicKey || !isObject(packageHost.bootstrapAssets)) {
        throw new Error(`reused package ${packageId} mini-app trust configuration does not match its owner release`);
      }
      packageBootstrap = packageHost.bootstrapAssets;
      packageConfig = structuredClone(packageHost.config);
      const updates = packageConfig.updates as Record<string, unknown>;
      updates.baseUrl = `${origin}/${channelUpdatePrefix(channel)}`;
    }
    if (!isObject(packageBootstrap) || !isObject(storedDescriptor.bootstrapAssets) ||
        JSON.stringify(packageBootstrap) !== JSON.stringify(storedDescriptor.bootstrapAssets)) {
      throw new Error(`reused package ${packageId} bootstrap descriptor was not retained`);
    }
    const bootstrapAssets: Record<string, { url: string; sha256: string; size: number }> = {};
    for (const [asset, value] of Object.entries(packageBootstrap)) {
      const prefix = `assets/apps/${packageId}/`;
      const name = asset.startsWith(prefix) ? asset.slice(prefix.length) : "";
      if (!["app.bytecode.json", "guest-manifest.json"].includes(name) || !isObject(value) ||
          typeof value.sha256 !== "string" || !Number.isSafeInteger(value.size)) {
        throw new Error(`reused package ${packageId} bootstrap descriptor is invalid`);
      }
      const bytes = new Uint8Array(await readFile(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/bootstrap/${name}`)));
      if (bytes.byteLength !== value.size || sha256Hex(bytes) !== value.sha256) throw new Error(`reused package ${packageId} bootstrap artifact is missing or corrupt`);
      bootstrapAssets[asset] = { url: `${origin}${immutablePath}/bootstrap/${name}`, sha256: value.sha256, size: value.size as number };
    }
    if (!bootstrapAssets[`assets/apps/${packageId}/app.bytecode.json`]) throw new Error(`reused package ${packageId} is missing its bootstrap metadata`);
    return {
      ...storedDescriptor,
      id: packageId,
      appId: packageId,
      version: pkg.version,
      build: pkg.build,
      packageVersion: entry.packageVersion,
      updateUrl: manifestUrl,
      manifestUrl,
      hostConfigUrl,
      keyId: rootKeyId,
      publicKey: rootPublicKey,
      payloadSha256: sha256Hex(Buffer.from(envelope.payload, "base64")),
      bootstrapAssets,
      config: packageConfig,
      reusedReleaseId: entry.releaseId,
      reusedProjectId: owner.projectId,
    };
  };
  const projectPublishTargets = async (id: string, config: EditorConfig, state: EditorState, channel: "test" | "release") => {
    const slot = versionSlot(channel);
    const history = await readVersionHistory(versionHistoryPath(workspace.states, id));
    const publishedRootEntry = history.entries.find((entry) => entry.hostVersion === updateHostVersion && entry.slot === slot && entry.channel === channel);
    const rootBuilt = state.builtRevision !== null && state.builtRevision === state.revision && !!state.artifacts && !state.error;
    const targets: Array<Record<string, unknown>> = [{
      projectId: id,
      appId: config.appId,
      title: config.name || config.appId,
      kind: "root" as const,
      version: config.version,
      build: config.build,
      revision: state.revision,
      builtRevision: state.builtRevision,
      built: rootBuilt,
      busy: state.busy,
      canSelect: true,
      ...(publishedRootEntry ? {
        publishedVersion: publishedRootEntry.version,
        publishedBuild: publishedRootEntry.build,
        publishedReleaseId: publishedRootEntry.releaseId,
      } : {}),
      canPublish: rootBuilt && !state.busy,
      ...(!rootBuilt ? { reason: state.error ? `The current build failed: ${state.error}` : "Build the current project before publishing." } : state.busy ? { reason: "The current project is busy." } : {}),
    }];
    let allReuseOwnersResolved = true;
    for (const packageId of config.reusePublishedPackages ?? []) {
      const catalogSource = [...(workspace.projectSources?.entries() ?? [])]
        .find(([sourceProjectId, source]) => sourceProjectId !== id && source.parentProjectId === id && source.appId === packageId &&
          Boolean(source.sourceProjectTitle && source.sourcePath))?.[1];
      const sourceDetails = catalogSource?.sourceProjectTitle && catalogSource.sourcePath ? {
        sourceProjectId: catalogSource.parentProjectId,
        sourceProjectTitle: catalogSource.sourceProjectTitle,
        sourcePath: catalogSource.sourcePath,
      } : {};
      const owners: Array<{ projectId: string; entry: PublishedVersion; package: PublishedVersionPackage }> = [];
      let files: Array<import("node:fs").Dirent> = [];
      try {
        files = await readdir(workspace.states, { withFileTypes: true });
      } catch {
        // No journal directory means the package has no signed owner yet.
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".versions.json")) continue;
        const ownerProjectId = file.name.slice(0, -".versions.json".length);
        if (!projectIdPattern.test(ownerProjectId)) continue;
        let ownerHistory: VersionHistory;
        try {
          ownerHistory = await readVersionHistory(join(workspace.states, file.name));
        } catch {
          continue;
        }
        const ownerEntry = ownerHistory.entries.find((entry) => entry.hostVersion === updateHostVersion && entry.slot === slot &&
          entry.channel === channel && entry.packages.some((pkg) => pkg.id === packageId));
        const pkg = ownerEntry?.packages.find((candidate) => candidate.id === packageId);
        if (ownerEntry && pkg) owners.push({ projectId: ownerProjectId, entry: ownerEntry, package: pkg });
      }
      const ownerProjectIds = [...new Set(owners.map((owner) => owner.projectId))];
      if (ownerProjectIds.length === 0) {
        allReuseOwnersResolved = false;
        const sourceCandidates: Array<{ projectId: string; config: EditorConfig; state: EditorState }> = [];
        for (const candidateId of await workspaceProjectIds(workspace)) {
          if (!existsSync(projectDirectory(workspace, candidateId))) continue;
          try {
            const candidateConfig = await loadConfig(projectDirectory(workspace, candidateId), candidateId);
            if (candidateConfig.appId !== packageId) continue;
            sourceCandidates.push({ projectId: candidateId, config: candidateConfig, state: await getState(candidateId) });
          } catch {
            // A malformed unrelated source cannot become an owner target.
          }
        }
        const uniqueSources = [...new Map(sourceCandidates.map((candidate) => [candidate.projectId, candidate])).values()];
        if (uniqueSources.length === 1 && uniqueSources[0]!.projectId !== id) {
          const candidate = uniqueSources[0]!;
          const candidateBuilt = candidate.state.builtRevision !== null && candidate.state.builtRevision === candidate.state.revision &&
            !!candidate.state.artifacts && !candidate.state.error;
          targets.push({
            projectId: candidate.projectId,
            appId: packageId,
            title: candidate.config.title || packageId,
            kind: "reused" as const,
            ...sourceDetails,
            ownerProjectId: candidate.projectId,
            ownerTitle: candidate.config.name || candidate.projectId,
            version: candidate.config.version,
            build: candidate.config.build,
            revision: candidate.state.revision,
            builtRevision: candidate.state.builtRevision,
            built: candidateBuilt,
            busy: candidate.state.busy,
            canSelect: true,
            canPublish: candidateBuilt && !candidate.state.busy,
            ...(!candidateBuilt ? { reason: candidate.state.error ? `The owner build failed: ${candidate.state.error}` : "Build the owner project before publishing this MiniApp." } : candidate.state.busy ? { reason: "The owner project is busy." } : {}),
          });
          continue;
        }
        const reason = uniqueSources.length > 1
          ? `More than one editable project contains ${packageId}; choose or resolve its owner first.`
          : `No ${channel} package owner or unique editable source is available for ${packageId}.`;
        targets.push({
          projectId: "",
          appId: packageId,
          title: packageId,
          kind: "reused" as const,
          ...sourceDetails,
          version: "",
          build: 0,
          revision: 0,
          builtRevision: null,
          built: false,
          busy: false,
          canSelect: false,
          canPublish: false,
          reason,
        });
        continue;
      }
      if (ownerProjectIds.length > 1) {
        allReuseOwnersResolved = false;
        targets.push({
          projectId: "",
          appId: packageId,
          title: packageId,
          kind: "reused" as const,
          ...sourceDetails,
          version: "",
          build: 0,
          revision: 0,
          builtRevision: null,
          built: false,
          busy: false,
          canSelect: false,
          canPublish: false,
          reason: `More than one ${channel} project owns ${packageId}; resolve the package owner before publishing.`,
        });
        continue;
      }
      const ownerProjectId = ownerProjectIds[0]!;
      const owner = owners.find((candidate) => candidate.projectId === ownerProjectId)!;
      if (ownerProjectId === id || !existsSync(projectDirectory(workspace, ownerProjectId))) {
        if (ownerProjectId === id) allReuseOwnersResolved = false;
        targets.push({
          projectId: ownerProjectId,
          appId: packageId,
          title: packageId,
          kind: "reused" as const,
          ...sourceDetails,
          ownerProjectId,
          ownerTitle: ownerProjectId,
          version: owner.entry.version,
          build: owner.entry.build,
          revision: 0,
          builtRevision: null,
          built: false,
          busy: false,
          canSelect: false,
          publishedVersion: owner.package.version,
          publishedBuild: owner.package.build,
          publishedReleaseId: owner.entry.releaseId,
          canPublish: false,
          reason: ownerProjectId === id ? "The reused package is owned by this project." : "The published owner project is missing.",
        });
        continue;
      }
      try {
        const ownerConfig = await loadConfig(projectDirectory(workspace, ownerProjectId), ownerProjectId);
        const ownerState = await getState(ownerProjectId);
        const ownerBuilt = ownerState.builtRevision !== null && ownerState.builtRevision === ownerState.revision && !!ownerState.artifacts && !ownerState.error;
        const title = packageId === ownerConfig.appId ? ownerConfig.title : packageId;
        targets.push({
          projectId: ownerProjectId,
          appId: packageId,
          title,
          kind: "reused" as const,
          ...sourceDetails,
          ownerProjectId,
          ownerTitle: ownerConfig.name || ownerProjectId,
          version: ownerConfig.version,
          build: ownerConfig.build,
          revision: ownerState.revision,
          builtRevision: ownerState.builtRevision,
          built: ownerBuilt,
          busy: ownerState.busy,
          canSelect: true,
          publishedVersion: owner.package.version,
          publishedBuild: owner.package.build,
          publishedReleaseId: owner.entry.releaseId,
          canPublish: ownerBuilt && !ownerState.busy,
          ...(!ownerBuilt ? { reason: ownerState.error ? `The owner build failed: ${ownerState.error}` : "Build the owner project before publishing this MiniApp." } : ownerState.busy ? { reason: "The owner project is busy." } : {}),
        });
      } catch {
        targets.push({
          projectId: ownerProjectId,
          appId: packageId,
          title: packageId,
          kind: "reused" as const,
          ...sourceDetails,
          ownerProjectId,
          ownerTitle: ownerProjectId,
          version: owner.entry.version,
          build: owner.entry.build,
          revision: 0,
          builtRevision: null,
          built: false,
          busy: false,
          canSelect: false,
          publishedVersion: owner.package.version,
          publishedBuild: owner.package.build,
          publishedReleaseId: owner.entry.releaseId,
          canPublish: false,
          reason: "The published owner project configuration is unavailable.",
        });
      }
    }
    if (targets[0]?.canPublish === true && !allReuseOwnersResolved) {
      targets[0].canPublish = false;
      targets[0].reason = "Cannot publish while a reused package has no unique owner for this channel.";
    }
    return { currentProjectId: id, channel, targets };
  };
  const findLegacyPublishedOwner = async (host: string, packageId: string, slot: VersionSlot, exceptProjectId: string): Promise<string | undefined> => {
    for (const projectId of await workspaceProjectIds(workspace)) {
      if (projectId === exceptProjectId) continue;
      try {
        const projectConfig = await loadConfig(projectDirectory(workspace, projectId), projectId);
        const packageIds = new Set<string>([projectConfig.appId]);
        const projectState = await loadState(workspace, projectId);
        if (projectState.builtRevision !== null) {
          try {
            const snapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${projectId}/${projectState.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`));
            for (const pkg of snapshot.packages) packageIds.add(pkg.id);
          } catch {
            // Root ownership above is still sufficient for a legacy project
            // whose child resource snapshot is no longer readable.
          }
        }
        if (!packageIds.has(packageId)) continue;
        const physicalHosts = new Set<string>([host, "editor"]);
        if (projectState.publish?.hostVersion) physicalHosts.add(projectState.publish.hostVersion);
        for (const physicalHost of physicalHosts) {
          const directory = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
          if (existsSync(join(directory, "latest.json"))) return projectId;
        }
      } catch {
        // Ignore malformed unrelated projects while checking slot ownership.
      }
    }
    return undefined;
  };
  let deviceUpdates: ReturnType<typeof startUpdateEndpoint> | undefined;
  const readPublishedArtifact = async (file: string, mutableSlot?: VersionSlot): Promise<Response> => {
    let bytes = new Uint8Array(await readFile(file));
    if (mutableSlot && basename(file) === "host.json") {
      try {
        const config = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const updates = isObject(config.config) && isObject(config.config.updates) ? config.config.updates : undefined;
        const release = isObject(config.release) ? config.release : undefined;
        const branchNamespace = typeof release?.branchNamespace === "string"
          ? release.branchNamespace
          : typeof updates?.branchNamespace === "string"
            ? updates.branchNamespace
            : typeof config.POCKET_UPDATE_BRANCH_NAMESPACE === "string"
              ? config.POCKET_UPDATE_BRANCH_NAMESPACE
              : undefined;
        const compatVersion = typeof release?.compatVersion === "string"
          ? release.compatVersion
          : typeof updates?.compatVersion === "string"
            ? updates.compatVersion
            : undefined;
        const rawBaseUrl = typeof config.POCKET_UPDATE_BASE_URL === "string"
          ? config.POCKET_UPDATE_BASE_URL
          : typeof updates?.baseUrl === "string"
            ? updates.baseUrl
            : "";
        const baseOrigin = rawBaseUrl.replace(/\/(?:test|stable)\/$/, "").replace(/\/(?:test|stable)$/, "");
        const channelBaseUrl = compatVersion ? `${baseOrigin}/${mutableSlot}` : rawBaseUrl;
        if (typeof config.POCKET_UPDATE_BASE_URL === "string") config.POCKET_UPDATE_BASE_URL = channelBaseUrl;
        if (typeof config.POCKET_PACKAGE_VERSION === "string") config.POCKET_PACKAGE_VERSION = compatVersion ?? mutableSlot;
        if (branchNamespace && typeof config.POCKET_STORE_NAMESPACE === "string") config.POCKET_STORE_NAMESPACE = branchNamespace;
        if (updates) {
          updates.baseUrl = channelBaseUrl;
          updates.packageVersion = compatVersion ?? mutableSlot;
          if (branchNamespace) updates.namespace = branchNamespace;
        }
        if (config.kind === "pocket-editor-app-host") {
          const baseUrl = channelBaseUrl;
          const hostVersion = typeof config.POCKET_HOST_VERSION === "string" ? config.POCKET_HOST_VERSION : "";
          const routePackageVersion = compatVersion ?? mutableSlot;
          const rewritePackage = (value: unknown): void => {
            if (!isObject(value) || typeof value.id !== "string") return;
            // Reused packages belong to another immutable release. Keep that
            // child's owner-specific fixed index namespace and release pin;
            // rewriting it to the root compat branch would break both trust
            // and the original package URL.
            if (typeof value.reusedReleaseId === "string" && typeof value.reusedProjectId === "string") return;
            const packagePath = `/pocket/${hostVersion}/${encodeURIComponent(value.id)}/${routePackageVersion}`;
            value.packageVersion = routePackageVersion;
            value.updateUrl = `${baseUrl}${packagePath}/latest.json`;
            value.manifestUrl = `${baseUrl}${packagePath}/latest.json`;
            value.hostConfigUrl = `${baseUrl}${packagePath}/host.json`;
            if (isObject(value.config) && isObject(value.config.updates)) {
              value.config.updates.baseUrl = baseUrl;
              value.config.updates.packageVersion = routePackageVersion;
              if (branchNamespace) value.config.updates.namespace = branchNamespace;
            }
          };
          if (Array.isArray(config.packages)) for (const value of config.packages) rewritePackage(value);
          if (isObject(config.applications)) for (const value of Object.values(config.applications)) rewritePackage(value);
          if (Array.isArray(config.applications)) for (const value of config.applications) rewritePackage(value);
          if (isObject(config.updates)) {
            config.updates.baseUrl = baseUrl;
            config.updates.packageVersion = routePackageVersion;
          if (branchNamespace) config.updates.namespace = branchNamespace;
          }
        }
        bytes = new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n");
      } catch {
        // packageArtifacts already emitted this file; preserve the signed
        // bytes if a future host template uses a non-JSON format.
      }
    }
    return new Response(bytes, { headers: { "content-type": contentType(file), "cache-control": "no-store" } });
  };
  const findLegacyArtifact = async (host: string, packageId: string, slot: VersionSlot, artifactPath: string, routeVersion?: string): Promise<string | undefined> => {
    for (const projectId of await workspaceProjectIds(workspace)) {
      try {
        const projectConfig = await loadConfig(projectDirectory(workspace, projectId), projectId);
        const projectState = await loadState(workspace, projectId);
        const packageIds = new Set<string>([projectConfig.appId]);
        if (projectState.builtRevision !== null) {
          try {
            const snapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${projectId}/${projectState.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`));
            for (const pkg of snapshot.packages) packageIds.add(pkg.id);
          } catch {
            // The root id remains enough for a legacy root manifest.
          }
        }
        if (!packageIds.has(packageId)) continue;
        const physicalHosts = new Set<string>([host, "editor"]);
        if (projectState.publish?.hostVersion) physicalHosts.add(projectState.publish.hostVersion);
        for (const physicalHost of physicalHosts) {
          const directory = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
          if (!existsSync(join(directory, "latest.json"))) continue;
          if (routeVersion) {
            const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
            if (!legacyPayloadMatchesRoute(payload, routeVersion)) continue;
          }
          try {
            const candidate = safeArtifactFile(workspace.updates, relative(workspace.updates, join(directory, artifactPath)));
            if (existsSync(candidate)) return candidate;
          } catch {
            // Keep searching another historical host alias.
          }
        }
      } catch {
        // Ignore malformed unrelated projects while resolving legacy aliases.
      }
    }
    // A legacy state file may have been removed while its canonical package
    // directory remains. Scan only the bounded `updates/pocket` host segment
    // as a final read-only compatibility fallback.
    try {
      const hostRoot = join(workspace.updates, "pocket");
      for (const entry of await readdir(hostRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !appIdPattern.test(entry.name)) continue;
        const directory = pocketReleaseDirectory(workspace.updates, entry.name, packageId, slot);
        if (!existsSync(join(directory, "latest.json"))) continue;
        if (routeVersion) {
          const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
          if (!legacyPayloadMatchesRoute(payload, routeVersion)) continue;
        }
        try {
          const candidate = safeArtifactFile(workspace.updates, relative(workspace.updates, join(directory, artifactPath)));
          if (existsSync(candidate)) return candidate;
        } catch {
          // Continue to the next retained host alias.
        }
      }
    } catch {
      // No legacy host directory is a normal pre-publish state.
    }
    return undefined;
  };
  const readLegacyAggregate = async (host: string, rootPackageId: string, routeVersion: string, requestedCompatVersion = routeVersion, revisionOverride?: number, projectIdFilter?: string): Promise<Response | undefined> => {
    for (const projectId of await workspaceProjectIds(workspace)) {
      if (projectIdFilter && projectId !== projectIdFilter) continue;
      let projectConfig: EditorConfig;
      let projectState: EditorState;
      try {
        projectConfig = await loadConfig(projectDirectory(workspace, projectId), projectId);
        if (projectConfig.appId !== rootPackageId) continue;
        projectState = await loadState(workspace, projectId);
      } catch {
        continue;
      }
      const packageIds = new Set<string>([rootPackageId]);
      // Legacy descriptors must describe the revision that was actually
      // published.  The bound project may have been built again since then;
      // using builtRevision here would silently mix newer child packages and
      // bootstrap files into an older root release.
      let matchingRevision: number | undefined;
      try {
        const history = await readVersionHistory(versionHistoryPath(workspace.states, projectId));
        const routeSlot: VersionSlot = /-test\.[0-9]+$/.test(routeVersion) ? "test" : "stable";
        const matchingEntry = history.entries.find((entry) =>
          entry.hostVersion === host &&
          entry.slot === routeSlot &&
          (entry.routeVersion ?? entry.version) === routeVersion,
        );
        if (matchingEntry) matchingRevision = matchingEntry.revision;
      } catch {
        // Legacy workspaces may not have a journal sidecar.
      }
      const publishedRevision = revisionOverride ?? matchingRevision ?? projectState.publish?.revision ?? projectState.builtRevision;
      let snapshot: Awaited<ReturnType<typeof readResourceSnapshot>> | undefined;
      if (publishedRevision !== null && publishedRevision !== undefined) {
        try {
          snapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${projectId}/${publishedRevision}/${RESOURCE_SNAPSHOT_FILE}`));
          for (const pkg of snapshot.packages) packageIds.add(pkg.id);
        } catch {
          // A legacy root package can still be exposed if its child snapshot
          // was removed; do not invent child descriptors in that case.
        }
      }
      const physicalHosts = new Set<string>([host, "editor"]);
      if (projectState.publish?.hostVersion) physicalHosts.add(projectState.publish.hostVersion);
      for (const physicalHost of physicalHosts) {
        for (const slot of ["test", "stable"] as const) {
        const rootDirectory = pocketReleaseDirectory(workspace.updates, physicalHost, rootPackageId, slot);
        const rootPayload = await readJsonFile<Record<string, unknown>>(join(rootDirectory, "payload.json"), {});
        if (typeof rootPayload.version !== "string") continue;
        const build = Number(rootPayload.build);
        if (!Number.isSafeInteger(build) || build < 0) continue;
        const legacyRouteVersion = legacySemanticRouteVersion(String(rootPayload.version), build, slot);
        if (routeVersion !== legacyRouteVersion && routeVersion !== rootPayload.version && routeVersion !== compatibilityVersion(String(rootPayload.version))) continue;
        const rootHost = await readJsonFile<Record<string, unknown>>(join(rootDirectory, "host.json"), {});
        const currentBaseUrl = deviceUpdates?.origin ?? (typeof rootHost.POCKET_UPDATE_BASE_URL === "string" ? rootHost.POCKET_UPDATE_BASE_URL : "");
        const branchNamespace = updateNamespace(projectId, host, requestedCompatVersion, slot === "test" ? "test" : "release");
        const channelBaseUrl = `${currentBaseUrl}/${slot}`.replace(/\/$/, "");
        rootHost.POCKET_UPDATE_BASE_URL = channelBaseUrl;
        rootHost.POCKET_HOST_VERSION = host;
        rootHost.POCKET_PACKAGE_VERSION = legacyRouteVersion;
        rootHost.POCKET_STORE_NAMESPACE = branchNamespace;
        rootHost.POCKET_UPDATE_BRANCH_NAMESPACE = branchNamespace;
        const aggregatePackages: AggregateHostPackage[] = [];
        for (const packageId of packageIds) {
          const packageDirectory = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
          const payload = await readJsonFile<Record<string, unknown>>(join(packageDirectory, "payload.json"), {});
          const packageVersion = typeof payload.version === "string" ? payload.version : rootPayload.version;
          const packageBuild = Number(payload.build);
          if (!existsSync(join(packageDirectory, "latest.json")) || !Number.isSafeInteger(packageBuild) || packageBuild < 0) continue;
          const packageRouteVersion = legacySemanticRouteVersion(packageVersion, packageBuild, slot);
          const packageHost = await readJsonFile<Record<string, unknown>>(join(packageDirectory, "host.json"), {});
          const packageUpdates = isObject(packageHost.config) && isObject(packageHost.config.updates) ? packageHost.config.updates : undefined;
          const packageKeyId = packageId === rootPackageId
            ? (typeof rootHost.POCKET_UPDATE_KEY_ID === "string" ? rootHost.POCKET_UPDATE_KEY_ID : "")
            : (typeof packageUpdates?.keyId === "string" ? packageUpdates.keyId : "");
          const packagePublicKey = packageId === rootPackageId
            ? (typeof rootHost.POCKET_UPDATE_PUBLIC_KEY === "string" ? rootHost.POCKET_UPDATE_PUBLIC_KEY : "")
            : (typeof packageUpdates?.publicKey === "string" ? packageUpdates.publicKey : "");
          let packagePayloadSha256: string | undefined;
          try {
            const packageEnvelope = await readJsonFile<Record<string, unknown>>(join(packageDirectory, "latest.json"));
            if (typeof packageEnvelope.payload === "string") packagePayloadSha256 = sha256Hex(Buffer.from(packageEnvelope.payload, "base64"));
          } catch {
            // Legacy payloads may predate the digest field.
          }
          const packagePath = `/pocket/${host}/${encodeURIComponent(packageId)}/${encodeURIComponent(packageRouteVersion)}`;
          const bootstrapAssets: Record<string, { url: string; sha256: string; size: number }> = {};
          const packageSnapshot = snapshot?.packages.find((pkg) => pkg.id === packageId);
          const sourceDirectory = publishedRevision !== null && publishedRevision !== undefined
            ? packageId === rootPackageId
              ? join(workspace.builds, projectId, String(publishedRevision))
              : packageSnapshot
                ? resourceArtifactDirectory(join(workspace.builds, projectId, String(publishedRevision)), packageSnapshot)
                : undefined
            : undefined;
          const bootstrapDirectory = join(packageDirectory, "bootstrap");
          if (sourceDirectory) {
            await mkdir(bootstrapDirectory, { recursive: true });
            for (const name of ["app.bytecode.json", "guest-manifest.json"]) {
              const source = join(sourceDirectory, name);
              const destination = join(bootstrapDirectory, name);
              if (existsSync(source) && !existsSync(destination)) await cp(source, destination);
            }
          }
          for (const name of ["app.bytecode.json", "guest-manifest.json"]) {
            const bootstrapFile = join(bootstrapDirectory, name);
            if (!existsSync(bootstrapFile)) continue;
            const bytes = new Uint8Array(await readFile(bootstrapFile));
            const asset = `assets/apps/${packageId}/${name}`;
            bootstrapAssets[asset] = { url: `${channelBaseUrl}${packagePath}/bootstrap/${name}`, sha256: sha256Hex(bytes), size: bytes.length };
          }
          let packageConfig: Record<string, unknown> | undefined;
          if (isObject(packageHost.config)) {
            packageConfig = JSON.parse(JSON.stringify(packageHost.config)) as Record<string, unknown>;
            if (isObject(packageConfig.updates)) {
              packageConfig.updates.baseUrl = channelBaseUrl;
              packageConfig.updates.packageVersion = packageRouteVersion;
            }
          }
          aggregatePackages.push({
            id: packageId,
            appId: packageId,
            version: packageVersion,
            build: packageBuild,
            packageVersion: packageRouteVersion,
            updateUrl: `${channelBaseUrl}${packagePath}/latest.json`,
            manifestUrl: `${channelBaseUrl}${packagePath}/latest.json`,
            hostConfigUrl: packageId === rootPackageId
              ? `${currentBaseUrl}/pocket/${host}/${encodeURIComponent(rootPackageId)}/${encodeURIComponent(packageRouteVersion)}/host.json`
              : `${channelBaseUrl}${packagePath}/host.json`,
            keyId: packageKeyId,
            publicKey: packagePublicKey,
            ...(packagePayloadSha256 ? { payloadSha256: packagePayloadSha256 } : {}),
            ...(packageId === rootPackageId && packagePayloadSha256 ? { rootPayloadSha256: packagePayloadSha256 } : {}),
            bootstrapAssets,
            ...(packageConfig ? { config: packageConfig } : {}),
          });
        }
        if (!aggregatePackages.some((pkg) => pkg.id === rootPackageId)) continue;
        const compositorSurfaces = publishedRevision !== null && publishedRevision !== undefined
          ? await compositorSurfacesFromProject(join(workspace.builds, projectId, String(publishedRevision)))
          : undefined;
        return new Response(JSON.stringify(aggregateHostConfig({
          rootHost,
          hostVersion: host,
          rootAppId: rootPackageId,
          version: String(rootPayload.version),
          build,
          compatVersion: requestedCompatVersion,
          channel: slot === "test" ? "test" : "release",
          slot,
          routeVersion: legacyRouteVersion,
          releaseId: null,
          branchNamespace,
          packages: aggregatePackages,
          hostVersionSource: updateHostVersionSource,
          ...(compositorSurfaces ? { compositorSurfaces } : {}),
        }), null, 2) + "\n", {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      }
    }
    return undefined;
  };
  type LegacyArchiveResult = {
    archivePath: string;
    archiveUrl: string;
    releaseId: string;
    version: string;
    build: number;
  };
  const legacyArchiveBuilds = new Map<string, Promise<LegacyArchiveResult | undefined>>();
  const ensureLegacyArchive = async (projectId: string, config: EditorConfig, state: EditorState, host: string, slot: VersionSlot, revisionOverride?: number): Promise<LegacyArchiveResult | undefined> => {
    const revision = revisionOverride ?? state.publish?.revision ?? state.builtRevision;
    if (revision === null || revision === undefined) return undefined;
    const cacheKey = `${projectId}\n${host}\n${slot}\n${revision}`;
    const existing = legacyArchiveBuilds.get(cacheKey);
    if (existing) return existing;
    const build = (async (): Promise<LegacyArchiveResult | undefined> => {
      let snapshot: Awaited<ReturnType<typeof readResourceSnapshot>> | undefined;
      try {
        snapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${projectId}/${revision}/${RESOURCE_SNAPSHOT_FILE}`));
      } catch {
        // A legacy root-only release can still be archived without a child
        // snapshot; never substitute the current built revision here.
      }
      const packageIds = new Set<string>([config.appId]);
      for (const pkg of snapshot?.packages ?? []) packageIds.add(pkg.id);
      const physicalHosts = new Set<string>([host, "editor"]);
      if (state.publish?.hostVersion) physicalHosts.add(state.publish.hostVersion);
      const findDirectory = (packageId: string): string | undefined => {
        for (const physicalHost of physicalHosts) {
          const candidate = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
          if (existsSync(join(candidate, "latest.json"))) return candidate;
        }
        return undefined;
      };
      const rootDirectory = findDirectory(config.appId);
      if (!rootDirectory) return undefined;
      const rootPayload = await readJsonFile<Record<string, unknown>>(join(rootDirectory, "payload.json"), {});
      if (typeof rootPayload.version !== "string") return undefined;
      const rootBuild = Number(rootPayload.build);
      if (!Number.isSafeInteger(rootBuild) || rootBuild < 0) return undefined;
      // Never inherit the current state mirror's compat pointer: after a new
      // branch publishes, that pointer may describe newer bytes than this
      // retained legacy slot. Derive the legacy compat identity solely from
      // the signed payload being archived.
      const legacyCompat = compatibilityVersion(rootPayload.version);
      let aggregateBody: Record<string, unknown> | undefined;
      const legacyRouteVersion = legacySemanticRouteVersion(rootPayload.version, rootBuild, slot);
      const aggregate = await readLegacyAggregate(host, config.appId, legacyRouteVersion, legacyCompat, revision, projectId);
      if (aggregate) {
        try {
          const parsed = await aggregate.json() as Record<string, unknown>;
          if (isObject(parsed.applications)) for (const packageId of Object.keys(parsed.applications)) packageIds.add(packageId);
          aggregateBody = parsed;
        } catch {
          aggregateBody = undefined;
        }
      }
      const packageSources: Array<{ id: string; source: string; manifestHash: string }> = [];
      for (const packageId of packageIds) {
        const source = findDirectory(packageId);
        if (!source) {
          // A published snapshot package must never silently disappear from a
          // legacy backup. A root-only legacy project is the only exception.
          if (snapshot?.packages.some((pkg) => pkg.id === packageId)) return undefined;
          continue;
        }
        const manifestBytes = new Uint8Array(await readFile(join(source, "latest.json")));
        packageSources.push({ id: packageId, source, manifestHash: sha256Hex(manifestBytes) });
      }
      if (!packageSources.some((pkg) => pkg.id === config.appId)) return undefined;
      packageSources.sort((left, right) => left.id.localeCompare(right.id));
      const digest = sha256Hex(new TextEncoder().encode(JSON.stringify({ host, slot, packages: packageSources.map((pkg) => ({ id: pkg.id, manifestHash: pkg.manifestHash })) })));
      const releaseId = `legacy-${digest}`;
      const archiveDirectory = join(workspace.updates, ".downloads", projectId);
      const archivePath = join(archiveDirectory, `${releaseId}.tar.gz`);
      if (!existsSync(archivePath)) {
        const expanded = await mkdtemp(join(tmpdir(), "pocket-editor-legacy-archive-"));
        const temporaryArchive = join(archiveDirectory, `.${releaseId}.${randomUUID()}.tmp.tar.gz`);
        try {
          for (const pkg of packageSources) {
            // The aggregate descriptor points at each package's semantic
            // version/build route, not the mutable `test`/`stable` slot or a
            // shared compat alias. Keep every archive path pinned to the
            // payload it contains.
            const packagePayload = await readJsonFile<Record<string, unknown>>(join(pkg.source, "payload.json"), {});
            const packageVersion = typeof packagePayload.version === "string" ? packagePayload.version : rootPayload.version;
            const packageBuild = Number(packagePayload.build);
            if (!Number.isSafeInteger(packageBuild) || packageBuild < 0) return undefined;
            const packageRouteVersion = legacySemanticRouteVersion(packageVersion, packageBuild, slot);
            await cp(pkg.source, join(expanded, "pocket", host, pkg.id, packageRouteVersion), { recursive: true });
          }
          if (aggregateBody) {
            const aggregateRoot = join(expanded, "pocket", host, config.appId, legacySemanticRouteVersion(rootPayload.version, rootBuild, slot));
            await writeFile(join(aggregateRoot, "host.json"), JSON.stringify(aggregateBody, null, 2) + "\n");
          }
          await mkdir(archiveDirectory, { recursive: true });
          await runProcess(["tar", "-czf", temporaryArchive, "-C", expanded, "."], root, () => {});
          await rename(temporaryArchive, archivePath);
        } finally {
          await rm(expanded, { recursive: true, force: true }).catch(() => undefined);
          await rm(temporaryArchive, { force: true }).catch(() => undefined);
        }
      }
      return { archivePath, archiveUrl: `/releases/${projectId}/${releaseId}.tar.gz`, releaseId, version: rootPayload.version, build: rootBuild };
    })();
    const tracked = build.finally(() => {
      if (legacyArchiveBuilds.get(cacheKey) === tracked) legacyArchiveBuilds.delete(cacheKey);
    });
    legacyArchiveBuilds.set(cacheKey, tracked);
    return tracked;
  };
  const packageIndexRecord = async (projectId: string, entry: PublishedVersion, packageId: string): Promise<Record<string, unknown> | undefined> => {
    const pkg = entry.packages.find((candidate) => candidate.id === packageId);
    if (!pkg) return undefined;
    const compatVersion = entry.compatVersion ?? entry.version;
    const immutable = historyPackagePath(entry.hostVersion, packageId, entry.releaseId);
    let payloadSha256: string | undefined;
    try {
      const envelope = await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.updates, `${pkg.artifactRoot}/latest.json`));
      if (typeof envelope.payload === "string") payloadSha256 = sha256Hex(Buffer.from(envelope.payload, "base64"));
    } catch {
      // A malformed historical package remains listed, but without a false
      // digest. The signed manifest remains the authoritative payload.
    }
    return {
      id: packageId,
      version: pkg.version,
      build: pkg.build,
      releaseId: entry.releaseId,
      channel: entry.channel,
      slot: entry.slot,
      compatVersion,
      routeVersion: entry.routeVersion ?? entry.version,
      packageVersion: entry.packageVersion,
      publishedAt: entry.publishedAt,
      manifestUrl: `${immutable}/latest.json`,
      hostConfigUrl: `${immutable}/host.json`,
      archiveUrl: `/releases/${projectId}/${entry.releaseId}.tar.gz`,
      ...(payloadSha256 ? { payloadSha256 } : {}),
      rootPayloadSha256: entry.payloadSha256,
    };
  };
  const legacyPackageIndexRecord = async (
    projectId: string,
    config: EditorConfig,
    state: EditorState,
    host: string,
    slot: VersionSlot,
    packageId: string,
    historyEntries: PublishedVersion[] = [],
  ): Promise<Record<string, unknown> | undefined> => {
    const physicalHosts = new Set<string>([host, "editor"]);
    if (state.publish?.hostVersion) physicalHosts.add(state.publish.hostVersion);
    let directory: string | undefined;
    for (const physicalHost of physicalHosts) {
      const candidate = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
      if (existsSync(join(candidate, "latest.json"))) {
        directory = candidate;
        break;
      }
    }
    if (!directory) return undefined;
    const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
    if (typeof payload.version !== "string") return undefined;
    const build = Number(payload.build);
    if (!Number.isSafeInteger(build) || build < 0) return undefined;
    let payloadSha256: string | undefined;
    try {
      const envelope = await readJsonFile<Record<string, unknown>>(join(directory, "latest.json"));
      if (typeof envelope.payload === "string") payloadSha256 = sha256Hex(Buffer.from(envelope.payload, "base64"));
    } catch {
      // Keep a pre-journal index usable even when its optional digest is absent.
    }
    const legacyRouteVersion = legacySemanticRouteVersion(payload.version, build, slot);
    const compatVersion = compatibilityVersion(payload.version);
    const revisionOverride = historyEntries.find((entry) =>
      entry.hostVersion === host &&
      entry.slot === slot &&
      (entry.routeVersion ?? entry.version) === legacyRouteVersion,
    )?.revision;
    const archive = await ensureLegacyArchive(projectId, config, state, host, slot, revisionOverride);
    return {
      id: packageId,
      version: legacyRouteVersion,
      build,
      releaseId: archive?.releaseId ?? null,
      channel: slot === "test" ? "test" : "release",
      slot,
      compatVersion,
      routeVersion: legacyRouteVersion,
      // There is no journal releaseId for a legacy package. Keep the
      // semantic route pinned so a later publish cannot move this record to
      // the mutable compatibility branch.
      packageVersion: legacyRouteVersion,
      publishedAt: null,
      manifestUrl: `/pocket/${host}/${encodeURIComponent(packageId)}/${encodeURIComponent(legacyRouteVersion)}/latest.json`,
      hostConfigUrl: `/pocket/${host}/${encodeURIComponent(packageId)}/${encodeURIComponent(legacyRouteVersion)}/host.json`,
      archiveUrl: archive?.archiveUrl ?? null,
      ...(payloadSha256 ? { payloadSha256 } : {}),
      ...(packageId === config.appId && payloadSha256 ? { rootPayloadSha256: payloadSha256 } : {}),
    };
  };
  const indexSystemUI = async (record: Record<string, unknown>, publishedRoot?: string): Promise<string | undefined> => {
    if (typeof record.hostConfigUrl !== "string") return undefined;
    const response = await readPublishedUpdate(record.hostConfigUrl);
    if (!response.ok) return undefined;
    const descriptor = await response.json() as Record<string, unknown>;
    if (descriptor.kind === "pocket-editor-app-host" && typeof descriptor.systemUI === "string" && descriptor.systemUI.length > 0) return descriptor.systemUI;
    // Mini-app descriptors intentionally have no SystemUI. Their parent is
    // established by the owning published release, rather than package order.
    if (descriptor.kind === "pocket-mini-app-host-template" && isObject(descriptor.config) && descriptor.config.appId === record.id) return publishedRoot;
    return undefined;
  };
  const readPackageIndex = async (host: string, packageId: string, requestedSlot?: VersionSlot): Promise<Response | undefined> => {
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await readdir(workspace.states, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const indexedOwners = new Set<string>();
    for (const file of entries) {
      if (!file.isFile() || !file.name.endsWith(".versions.json")) continue;
      const projectId = file.name.slice(0, -".versions.json".length);
      if (!projectIdPattern.test(projectId)) continue;
      try {
        const history = await readVersionHistory(join(workspace.states, file.name));
        if (history.entries.some((entry) => entry.hostVersion === host && (!requestedSlot || entry.slot === requestedSlot) && entry.packages.some((pkg) => pkg.id === packageId))) indexedOwners.add(projectId);
      } catch {
        // Ignore malformed unrelated journals while resolving the index.
      }
    }
    if (indexedOwners.size > 1) return failure("package index has multiple project owners", 409);
    for (const file of entries) {
      if (!file.isFile() || !file.name.endsWith(".versions.json")) continue;
      const projectId = file.name.slice(0, -".versions.json".length);
      if (!projectIdPattern.test(projectId)) continue;
      let history: VersionHistory;
      let state: EditorState;
      try {
        history = await readVersionHistory(join(workspace.states, file.name));
        state = await loadState(workspace, projectId);
      } catch {
        continue;
      }
      // Historical package indexes are journal-derived and must remain
      // available after the editable project source has been removed. The
      // project config is only needed to discover an optional legacy package
      // that predates the version journal.
      let config: EditorConfig | undefined;
      try {
        config = await loadConfig(projectDirectory(workspace, projectId), projectId);
      } catch {
        config = undefined;
      }
      const matching = history.entries.filter((entry) => entry.hostVersion === host && entry.packages.some((pkg) => pkg.id === packageId));
      if (matching.length === 0) continue;
      const slot = requestedSlot ?? (state.publish?.channel === "test" ? "test" : "stable");
      const slotEntries = matching.filter((entry) => entry.slot === slot);
      if (slotEntries.length === 0) continue;
      // The fixed package index represents the newest successful release in
      // this host/slot, independent of whichever compatibility branch the
      // last Editor state mirror happened to record.
      const latestEntry = slotEntries[0]!;
      const compatVersion = latestEntry.compatVersion ?? latestEntry.version;
      // Keep the package's complete channel history in the index. The
      // selected compat branch controls `latest`; older compatibility branches
      // remain available as immutable descriptors for rollback/audit.
      const records = (await Promise.all(slotEntries.map((entry) => packageIndexRecord(projectId, entry, packageId)))).filter((entry): entry is Record<string, unknown> => !!entry);
      const legacyRecord = config
        ? await legacyPackageIndexRecord(projectId, config, state, host, slot, packageId, slotEntries)
        : undefined;
      if (legacyRecord && !records.some((entry) =>
        (legacyRecord.releaseId && entry.releaseId === legacyRecord.releaseId) ||
        (legacyRecord.payloadSha256 && entry.payloadSha256 === legacyRecord.payloadSha256 && entry.version === legacyRecord.version))) {
        records.push(legacyRecord);
      }
      const latestRecord = records.find((entry) => entry.releaseId === latestEntry.releaseId) ?? records[0];
      if (!latestRecord) continue;
      const latest = latestRecord;
      const systemUI = await indexSystemUI(latest, (await entryRootPackage(latestEntry))?.id);
      if (!systemUI) return failure("package index descriptor has no SystemUI", 409);
      return new Response(JSON.stringify({
        schemaVersion: 1,
        kind: "pocket-editor-package-index",
        projectId,
        hostVersion: host,
        rootAppId: systemUI,
        systemUI,
        packageId,
        slot,
        channel: slot === "test" ? "test" : "release",
        compatVersion,
        latest,
        versions: records,
      }, null, 2) + "\n", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    // Pre-journal workspaces still have a mutable slot directory. Return a
    // derived index so a fixed App URL remains usable after an Editor restart;
    // nothing is written and no second catalog is persisted.
    for (const projectId of await workspaceProjectIds(workspace)) {
      let config: EditorConfig;
      let state: EditorState;
      try {
        config = await loadConfig(projectDirectory(workspace, projectId), projectId);
        state = await loadState(workspace, projectId);
      } catch {
        continue;
      }
      if (config.appId !== packageId && !state.publish?.packages?.some((pkg) => pkg.id === packageId)) continue;
      const slot = requestedSlot ?? (state.publish?.channel === "test" ? "test" : "stable");
      const physicalHosts = new Set<string>([host, "editor"]);
      if (state.publish?.hostVersion) physicalHosts.add(state.publish.hostVersion);
      let directory: string | undefined;
      for (const physicalHost of physicalHosts) {
        const candidate = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, slot);
        if (existsSync(join(candidate, "latest.json"))) {
          directory = candidate;
          break;
        }
      }
      if (!directory) continue;
      const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
      if (typeof payload.version !== "string") continue;
      const build = Number(payload.build);
      if (!Number.isSafeInteger(build) || build < 0) continue;
      let payloadSha256: string | null = null;
      try {
        const envelope = await readJsonFile<Record<string, unknown>>(join(directory, "latest.json"));
        if (typeof envelope.payload === "string") payloadSha256 = sha256Hex(Buffer.from(envelope.payload, "base64"));
      } catch {
        // Keep the legacy index readable even if its optional digest is absent.
      }
      const compatVersion = compatibilityVersion(payload.version);
      const legacyArchive = await ensureLegacyArchive(projectId, config, state, host, slot);
      const legacyRouteVersion = legacySemanticRouteVersion(payload.version, build, slot);
      const manifestUrl = `/pocket/${host}/${encodeURIComponent(packageId)}/${encodeURIComponent(legacyRouteVersion)}/latest.json`;
      const hostConfigUrl = `/pocket/${host}/${encodeURIComponent(packageId)}/${encodeURIComponent(legacyRouteVersion)}/host.json`;
      const record = {
        id: packageId,
        version: payload.version,
        build,
        releaseId: legacyArchive?.releaseId ?? null,
        channel: slot === "test" ? "test" : "release",
        slot,
        compatVersion,
        routeVersion: legacyRouteVersion,
        packageVersion: legacyRouteVersion,
        publishedAt: null,
        manifestUrl,
        hostConfigUrl,
        archiveUrl: legacyArchive?.archiveUrl ?? null,
        payloadSha256,
        rootPayloadSha256: payloadSha256,
      };
      const systemUI = await indexSystemUI(record, config.appId);
      if (!systemUI) return failure("package index descriptor has no SystemUI", 409);
      return new Response(JSON.stringify({
        schemaVersion: 1,
        kind: "pocket-editor-package-index",
        projectId,
        hostVersion: host,
        rootAppId: systemUI,
        systemUI,
        packageId,
        slot,
        channel: slot === "test" ? "test" : "release",
        compatVersion,
        latest: record,
        versions: [record],
      }, null, 2) + "\n", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    return undefined;
  };
  const readPublishedUpdate = async (path: string): Promise<Response> => {
    const parts = path.split("/").filter(Boolean);
    let file: string;
    const prefixedSlot = (parts[0] === "test" || parts[0] === "stable") && parts[1] === "pocket"
      ? parts[0] as VersionSlot
      : undefined;
    const canonicalOffset = prefixedSlot ? 1 : 0;
    // The fixed App entrypoint is a journal-derived package index. It has no
    // compat/version segment, so it must be handled before the signed
    // manifest route below; otherwise a client could mistake the directory
    // index for an update envelope.
    if (parts[canonicalOffset] === "pocket" && parts.length === canonicalOffset + 4 && parts[canonicalOffset + 3] === "latest.json") {
      const host = parts[canonicalOffset + 1]!;
      const packageId = decodeURIComponent(parts[canonicalOffset + 2]!);
      const index = await readPackageIndex(host, packageId, prefixedSlot);
      return index ?? failure("not found", 404);
    }
    if (parts[canonicalOffset] === "pocket" && parts.length >= canonicalOffset + 5) {
      const host = parts[canonicalOffset + 1]!;
      const packageId = decodeURIComponent(parts[canonicalOffset + 2]!);
      const packageVersion = parts[canonicalOffset + 3]!;
      const artifactPath = parts.slice(canonicalOffset + 4).join("/");
      const legacySlot = !prefixedSlot && (packageVersion === "test" || packageVersion === "stable")
        ? packageVersion as VersionSlot
        : undefined;
      const slot = prefixedSlot ?? legacySlot;
      const lookupVersion = legacySlot ? undefined : packageVersion;
      const resolved = await findPublishedPackage(host, packageId, lookupVersion, slot);
      if (resolved) {
        try {
          file = safeArtifactFile(workspace.updates, `${resolved.package.artifactRoot}/${artifactPath}`);
          let mutableSlot = slot;
          // A prefixed route may also address an immutable releaseId. Only the
          // compat branch is a mutable pointer; never rewrite a pinned host.
          if (mutableSlot && resolved.entry.packageVersion === packageVersion) mutableSlot = undefined;
          if (!mutableSlot && artifactPath === "host.json" && (await entryRootPackage(resolved.entry))?.id === packageId &&
            packageVersion === (resolved.entry.compatVersion ?? resolved.entry.version)) {
            const history = await readVersionHistory(versionHistoryPath(workspace.states, resolved.projectId));
            const current = currentVersion(history, resolved.entry.slot, resolved.entry.hostVersion, resolved.entry.compatVersion ?? resolved.entry.version);
            if (current?.releaseId === resolved.entry.releaseId) mutableSlot = resolved.entry.slot;
          }
          return readPublishedArtifact(file, mutableSlot);
        } catch (error) {
          if (!slot || !(artifactPath.startsWith("blobs/") || artifactPath.startsWith("bundles/") || artifactPath.startsWith("assets/"))) throw error;
          // A client may have fetched a prior signed manifest and still be
          // downloading its content-addressed blobs after the latest pointer
          // moved. Keep every immutable history entry readable for that race.
          const old = await findPublishedPackage(host, packageId, undefined, slot, true, artifactPath);
          if (old) {
            file = safeArtifactFile(workspace.updates, `${old.package.artifactRoot}/${artifactPath}`);
            return readPublishedArtifact(file);
          }
          throw error;
        }
      }
      if (artifactPath === "host.json" && (prefixedSlot || !slot)) {
        const legacyAggregate = await readLegacyAggregate(host, packageId, packageVersion, packageVersion);
        if (legacyAggregate) return legacyAggregate;
      }
      if (!slot) {
        // A pre-journal semantic route (for example 0.1.0-test.3) is pinned
        // to the retained mutable legacy package, not to today's compat
        // pointer. Match its payload version before serving any artifact so a
        // later publish cannot make an old index record resolve to new bytes.
        const legacySlot = /-test\.[0-9]+$/.test(packageVersion) ? "test" : "stable";
        const legacyFile = await findLegacyArtifact(host, packageId, legacySlot, artifactPath, packageVersion);
        if (legacyFile) return readPublishedArtifact(legacyFile);
        return failure("not found", 404);
      }
      // Keep serving pre-history projects created by an older Editor build.
      const legacyRouteVersion = slot === "test" && !/-test\.[0-9]+$/.test(packageVersion) ? undefined : packageVersion;
      const legacyFile = await findLegacyArtifact(host, packageId, slot, artifactPath, legacyRouteVersion);
      // legacy compatibility resolution intentionally remains read-only
      if (legacyFile) return readPublishedArtifact(legacyFile, slot);
      file = safeArtifactFile(workspace.updates, parts.join("/"));
    } else if (parts[0] === "updates" && parts.length >= 3) {
      const id = asProjectId(parts[1]);
      const state = await getState(id);
      const published = state.publish;
      if (!published?.hostVersion || !published.packageVersion) return failure("not found", 404);
      const config = await loadConfig(projectDir(id), id);
      let packageId = config.appId;
      let artifactParts = parts.slice(2);
      if (artifactParts[0] === "packages" && artifactParts.length >= 3) {
        packageId = artifactParts[1];
        artifactParts = artifactParts.slice(2);
      }
      const slot = published.channel === "test" ? "test" : "stable";
      const history = await readVersionHistory(versionHistoryPath(workspace.states, id));
      const compatVersion = published.packageVersion;
      const current = currentVersion(history, slot, published.hostVersion, compatVersion);
      const packageEntry = current?.packages.find((candidate) => candidate.id === packageId);
      if (current && packageEntry && current.hostVersion === published.hostVersion) {
        file = safeArtifactFile(workspace.updates, `${packageEntry.artifactRoot}/${artifactParts.join("/")}`);
        return readPublishedArtifact(file, slot);
      }
      const legacyReleaseDir = pocketReleaseDirectory(workspace.updates, published.hostVersion, packageId, slot);
      file = safeArtifactFile(legacyReleaseDir, artifactParts.join("/"));
    } else {
      return failure("not found", 404);
    }
    return readPublishedArtifact(file);
  };
  const rebaseAggregateHostResponse = async (response: Response, servingOrigin: string): Promise<Response> => {
    if (response.status < 200 || response.status >= 300) return response;
    const contentTypeHeader = response.headers.get("content-type") ?? "";
    if (!contentTypeHeader.includes("application/json")) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!isObject(parsed) || parsed.kind !== "pocket-editor-app-host") {
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const replaceArtifactOrigin = (value: unknown): unknown => {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        try {
          const url = new URL(value);
          if (/^(?:\/(?:test|stable))?\/pocket\//.test(url.pathname) ||
              /^\/(?:test|stable)(?:\/)?$/.test(url.pathname) ||
              /^\/updates\//.test(url.pathname) ||
              /^\/releases\//.test(url.pathname)) {
            return `${servingOrigin}${url.pathname}${url.search}${url.hash}`;
          }
        } catch {
          // Preserve a non-URL string from a future descriptor extension.
        }
        return value;
      }
      if (Array.isArray(value)) return value.map(replaceArtifactOrigin);
      if (isObject(value)) {
        for (const [key, item] of Object.entries(value)) value[key] = replaceArtifactOrigin(item);
      }
      return value;
    };
    const rebased = replaceArtifactOrigin(parsed);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(rebased, null, 2) + "\n", { status: response.status, statusText: response.statusText, headers });
  };
  const readPublishedResponse = async (path: string, servingOrigin: string): Promise<Response> => {
    const response = await readPublishedUpdate(path);
    if (!path.endsWith("/host.json")) return response;
    return rebaseAggregateHostResponse(response, servingOrigin);
  };
  const versionBackendOrigin = (): string => {
    if (!deviceUpdates) {
      const hostname = options.updateHost ?? (process.env.POCKET_EDITOR_UPDATE_HOST || chooseUpdateHost());
      const port = options.updatePort ?? Number(process.env.POCKET_EDITOR_UPDATE_PORT || server.port);
      // The LAN Editor already serves published packages. Do not bind a
      // second server to an address/port covered by its wildcard listener.
      const localAddress = hostname === "127.0.0.1" || Object.values(networkInterfaces())
        .some(entries => entries?.some(entry => entry.family === "IPv4" && entry.address === hostname));
      if (port === server.port && (server.hostname === hostname || (server.hostname === "0.0.0.0" && localAddress))) {
        return `http://${hostname}:${server.port}`;
      }
      deviceUpdates = startUpdateEndpoint({ hostname, port, read: (path, servingOrigin) => readPublishedResponse(path, servingOrigin) });
      console.log(`Pocket version backend listening at ${deviceUpdates.origin} (signed published packages only)`);
    }
    return deviceUpdates.origin;
  };
  const versionBackendSnapshot = async (id: string, state: EditorState, config: EditorConfig) => {
    let origin = `http://127.0.0.1:${server.port}`;
    let error: string | undefined;
    try {
      origin = versionBackendOrigin();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const packageIds = new Set<string>([config.appId]);
    const publishedRevision = state.publish?.revision ?? state.builtRevision;
    if (publishedRevision !== null && publishedRevision !== undefined) {
      try {
        const snapshot = await readResourceSnapshot(
          safeArtifactFile(workspace.builds, `${id}/${publishedRevision}/${RESOURCE_SNAPSHOT_FILE}`),
        );
        for (const pkg of snapshot.packages) packageIds.add(pkg.id);
      } catch {
        // A version view remains useful for the root package before/after a
        // resource snapshot exists. Never invent child packages on failure.
      }
    }
    const history = await readVersionHistory(versionHistoryPath(workspace.states, id));
    const compatVersion = await resolveCompatVersion(id, config, state, history);
    const visibleHistory = history.entries.filter((entry) => entry.hostVersion === updateHostVersion);
    const historyEntries = visibleHistory.map((entry) => ({
      id: entry.id,
      releaseId: entry.releaseId,
      slot: entry.slot,
      channel: entry.channel,
      version: entry.version,
      build: entry.build,
      revision: entry.revision,
      publishedAt: entry.publishedAt,
      hostVersion: entry.hostVersion,
      packageVersion: entry.packageVersion,
      payloadSha256: entry.payloadSha256,
      compatVersion: entry.compatVersion ?? entry.version,
      routeVersion: entry.routeVersion ?? entry.version,
      archiveUrl: `/releases/${id}/${entry.releaseId}.tar.gz`,
      appConfigUrl: `${origin}${historyPackagePath(entry.hostVersion, config.appId, entry.releaseId)}/host.json`,
      packages: entry.packages.map((pkg) => {
        const route = historyPackagePath(entry.hostVersion, pkg.id, entry.packageVersion);
        return {
          id: pkg.id,
          version: pkg.version,
          build: pkg.build,
          updateUrl: `${origin}${route}/latest.json`,
          manifestUrl: `${origin}${route}/latest.json`,
          hostConfigUrl: `${origin}${route}/host.json`,
        };
      }),
      reusedPackages: (entry.reusedPackages ?? []).map((pkg) => ({ ...pkg })),
    }));
    const slots = [] as Array<{
      name: "test" | "stable";
      version?: string;
      build?: number;
      releaseId?: string | null;
      archiveUrl?: string;
      packages: Array<{ id: string; version: string; build: number; manifestUrl: string; hostConfigUrl: string }>;
      reusedPackages?: PublishedVersionReusedPackage[];
    }>;
    for (const name of ["test", "stable"] as const) {
      const packages = [] as Array<{ id: string; version: string; build: number; manifestUrl: string; hostConfigUrl: string }>;
      // Slot cards follow the newest successful release across all
      // compatibility branches. The fixed index is the public selector;
      // branch current pointers remain only for legacy compat routes.
      const current = history.entries.find((entry) => entry.slot === name && entry.hostVersion === updateHostVersion);
      if (current) {
        const slotCompatVersion = current.compatVersion ?? current.version;
        for (const pkg of current.packages) {
          const route = `/${channelUpdatePrefix(name === "test" ? "test" : "release")}/pocket/${updateHostVersion}/${encodeURIComponent(pkg.id)}/${slotCompatVersion}`;
          packages.push({
            id: pkg.id,
            version: pkg.version,
            build: pkg.build,
            manifestUrl: `${origin}${route}/latest.json`,
            hostConfigUrl: `${origin}${route}/host.json`,
          });
        }
        slots.push({ name, version: current.version, build: current.build, releaseId: current.releaseId, archiveUrl: `/releases/${id}/${current.releaseId}.tar.gz`, packages,
          ...(current.reusedPackages?.length ? { reusedPackages: current.reusedPackages.map((pkg) => ({ ...pkg })) } : {}) });
        continue;
      }
      const physicalHosts = new Set<string>([updateHostVersion, "editor"]);
      if (state.publish?.hostVersion) physicalHosts.add(state.publish.hostVersion);
      let legacyVersion: string | undefined;
      let legacyBuild: number | undefined;
      for (const packageId of packageIds) {
        let directory: string | undefined;
        for (const physicalHost of physicalHosts) {
          const candidate = pocketReleaseDirectory(workspace.updates, physicalHost, packageId, name);
          if (existsSync(join(candidate, "latest.json"))) {
            directory = candidate;
            break;
          }
        }
        if (!directory) continue;
        const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
        const version = payload.version;
        const build = payload.build;
        if (typeof version !== "string" || !Number.isSafeInteger(build) || Number(build) < 0) continue;
        if (packageId === config.appId) {
          legacyVersion = version;
          legacyBuild = Number(build);
        }
        const routeVersion = legacySemanticRouteVersion(version, Number(build), name);
        const route = `/${channelUpdatePrefix(name === "test" ? "test" : "release")}/pocket/${updateHostVersion}/${encodeURIComponent(packageId)}/${encodeURIComponent(routeVersion)}`;
        packages.push({
          id: packageId,
          version,
          build: Number(build),
          manifestUrl: `${origin}${route}/latest.json`,
          hostConfigUrl: `${origin}${route}/host.json`,
        });
      }
      const legacyArchive = packages.length > 0 ? await ensureLegacyArchive(id, config, state, updateHostVersion, name) : undefined;
      slots.push({ name, ...(legacyVersion ? { version: legacyVersion } : {}), ...(legacyBuild !== undefined ? { build: legacyBuild } : {}), releaseId: legacyArchive?.releaseId ?? null, ...(legacyArchive ? { archiveUrl: legacyArchive.archiveUrl } : {}), packages });
    }
    const preferredSlots: VersionSlot[] = state.publish?.channel === "test" ? ["test", "stable"] : ["stable", "test"];
    const selectedEntry = preferredSlots
      .map((slot) => history.entries.find((entry) => entry.slot === slot && entry.hostVersion === updateHostVersion))
      .find((entry): entry is PublishedVersion => !!entry);
    let appConfigUrl: string | undefined;
    if (selectedEntry) {
      appConfigUrl = `${origin}/${channelUpdatePrefix(selectedEntry.slot === "test" ? "test" : "release")}/pocket/${updateHostVersion}/${encodeURIComponent(config.appId)}/latest.json`;
    } else {
      // Pre-journal releases remain discoverable through their signed payload
      // version. This keeps a service restart from hiding an already deployed
      // test.3 package merely because its history sidecar did not exist yet.
      const physicalHosts = new Set<string>([updateHostVersion, "editor"]);
      if (state.publish?.hostVersion) physicalHosts.add(state.publish.hostVersion);
      for (const slot of preferredSlots) {
        for (const physicalHost of physicalHosts) {
          const directory = pocketReleaseDirectory(workspace.updates, physicalHost, config.appId, slot);
          const payload = await readJsonFile<Record<string, unknown>>(join(directory, "payload.json"), {});
          if (typeof payload.version !== "string") continue;
          appConfigUrl = `${origin}/${channelUpdatePrefix(slot === "test" ? "test" : "release")}/pocket/${updateHostVersion}/${encodeURIComponent(config.appId)}/latest.json`;
          break;
        }
        if (appConfigUrl) break;
      }
    }
    return {
      origin,
      hostVersion: updateHostVersion,
      packageVersion: compatVersion,
      packageVersionSource: updatePackageVersionSource,
      hostVersionSource: updateHostVersionSource,
      lan: new URL(origin).hostname !== "127.0.0.1",
      ...(error ? { error } : {}),
      slots,
      current: { ...history.current },
      history: historyEntries,
      ...(appConfigUrl ? { appConfigUrl } : {}),
    };
  };
  const devices = createEditorDeviceManager({
    projectDirectory: (id) => projectDir(asProjectId(id)),
    flutterDirectory: (id) => id === workspace.projectId && flutterRoot ? resolve(flutterRoot) : undefined,
    commandDirectory: root,
    updateConfig: async (id, device) => {
      // A phone's loopback points to the phone. Publish only signed update
      // artifacts on a LAN interface; the Editor APIs stay on loopback.
      const local = device.kind === "ios-simulator" || ["macos", "linux", "windows"].includes(device.platform);
      const origin = local ? `http://127.0.0.1:${server.port}` : versionBackendOrigin();
      if (!local && new URL(origin).hostname === "127.0.0.1") throw new Error("Physical device updates require a LAN address, not loopback");
      const config = await loadConfig(projectDir(id), id);
      const projectState = await getState(id);
      if (!projectState.publish) return undefined;
      const channel = projectState.publish?.channel === "test" ? "test" : "release";
      const hostVersion = projectState.publish.hostVersion ?? updateHostVersion;
      return { hostConfigUrl: `${origin}/${channelUpdatePrefix(channel === "test" ? "test" : "release")}/pocket/${hostVersion}/${encodeURIComponent(config.appId)}/latest.json` };
    },
  });
  const deploymentWriting = (id: string) => devices.isBusy(id) && !devices.listDeployments().some((job) => job.projectId === id && job.state === "running");
  const publicDeployment = (job: DeploymentSnapshot) => ({
    id: job.id, projectId: job.projectId, deviceId: job.device.id,
    status: job.state === "canceled" ? "cancelled" : job.state,
    logs: job.logs.map((entry) => `[${entry.phase}] ${entry.line}`),
    error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt,
  });
  const localBluetooth = ["darwin", "win32"].includes(process.platform) ? createLocalBluetoothProvider() : undefined;
  const preview = createPreviewManager({
    diagnostics,
    localBluetooth,
    width: previewDevice.screenWidth,
    height: previewDevice.screenHeight,
    safeArea: previewDevice.safeArea,
    // Editor preview keeps a fixed 2x native raster for crisp core-generated
    // rounded/shadow masks on desktop Retina displays. This affects texture
    // sampling only: logical viewport geometry, Canvas DPR, and external image
    // resolution remain unchanged; do not recreate the runtime on DPR changes.
    rasterDensity: 2,
    artifacts: async (id) => {
      const state = await getState(asProjectId(id));
      if (!state.artifacts || state.builtRevision == null) throw new Error("Build this project before opening preview");
      const folder = `${id}/${state.builtRevision}`;
      const buildRoot = join(workspace.builds, id, String(state.builtRevision));
      const resourcesPath = safeArtifactFile(workspace.builds, `${folder}/${RESOURCE_SNAPSHOT_FILE}`);
      const resourceSnapshot = await readResourceSnapshot(resourcesPath);
      const buildInfo = await readJsonFile<Record<string, unknown>>(safeArtifactFile(workspace.builds, `${folder}/build.json`));
      const rootAppId = typeof buildInfo.appId === "string"
        ? buildInfo.appId
        : resourceSnapshot.packages.find((pkg) => pkg.artifactDirectory === ".")?.id;
      if (!rootAppId) throw new Error("build snapshot has no root app id");
      const applications: Record<string, {
        bytecodePath: string;
        sourcePath: string;
        pakPath: string;
        metadataPath: string;
        appId: string;
        projectDirectory: string;
        workerHttpOrigins?: string[];
      }> = {};
      for (const pkg of resourceSnapshot.packages) {
        if (pkg.id === rootAppId) continue;
        const packageDir = resourceArtifactDirectory(buildRoot, pkg);
        applications[pkg.id] = {
          bytecodePath: safeArtifactFile(workspace.builds, `${folder}/${pkg.artifactDirectory}/app.qjbc`),
          sourcePath: safeArtifactFile(workspace.builds, `${folder}/${pkg.artifactDirectory}/app.js`),
          pakPath: safeArtifactFile(workspace.builds, `${folder}/${pkg.artifactDirectory}/app.pak`),
          metadataPath: safeArtifactFile(workspace.builds, `${folder}/${pkg.artifactDirectory}/app.bytecode.json`),
          appId: pkg.id,
          projectDirectory: packageDir,
        };
      }
      // Standalone SDK guests have no generated child surface registry.
      // Keep containment/symlink validation when one exists; only absence is optional.
      let generatedRegistryPath: string | undefined;
      try {
        generatedRegistryPath = safeArtifactFile(workspace.builds, `${folder}/generated/compositor-surfaces.json`);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      if (generatedRegistryPath) {
        const generatedRegistry = await readJsonFile<Record<string, unknown>>(generatedRegistryPath);
        for (const appId of Object.keys(generatedPreviewApplications(generatedRegistry))) {
          if (applications[appId]) continue;
          const directory = `preview-applications/${appId}`;
          applications[appId] = {
            bytecodePath: safeArtifactFile(workspace.builds, `${folder}/${directory}/app.qjbc`),
            sourcePath: "",
            pakPath: safeArtifactFile(workspace.builds, `${folder}/${directory}/app.pak`),
            metadataPath: safeArtifactFile(workspace.builds, `${folder}/${directory}/app.bytecode.json`),
            appId,
            projectDirectory: join(buildRoot, directory),
            ...(appId === "dev.pocket-nexus.worker-http" ? { workerHttpOrigins: ["https://example.com"] } : {}),
          };
        }
      }
      return {
        bytecodePath: safeArtifactFile(workspace.builds, `${folder}/app.qjbc`),
        sourcePath: safeArtifactFile(workspace.builds, `${folder}/app.js`),
        pakPath: safeArtifactFile(workspace.builds, `${folder}/app.pak`),
        metadataPath: safeArtifactFile(workspace.builds, `${folder}/app.bytecode.json`),
        revision: state.builtRevision,
        generation: state.artifacts.generation ?? state.finishedAt ?? `legacy:${state.builtRevision}`,
        tickHz: Number.isSafeInteger(buildInfo.tickHz) && Number(buildInfo.tickHz) >= 1 ? Number(buildInfo.tickHz) : 60,
        projectDirectory: buildRoot,
        ...(Object.keys(applications).length > 0 ? { applications } : {}),
      };
    },
  });
  const codex = createStudioCodex({
    projectDirectory: (id) => {
      const directory = projectDir(asProjectId(id));
      safeProjectFile(directory, "pocket.json", { allowConfig: true, mustExist: true });
      return directory;
    },
    resolveContext: (id, scope): StudioExecutionContext => {
      const projectDirectory = projectDir(asProjectId(id));
      safeProjectFile(projectDirectory, "pocket.json", { allowConfig: true, mustExist: true });
      if (scope === "project") {
        return {
          scope,
          cwd: projectDirectory,
          writableRoots: [projectDirectory],
          developerInstructions: `You are editing the currently selected Pocket Studio JS project. Keep UI, routing and app logic in JS. Modify only this project and its files under ${projectDirectory}; preserve user changes. Do not create subagents, read credentials, run deployment, publish, or change files outside this writable root. Explain changes and test results. An attached screenshot may contain a selected region described with pixel coordinates; inspect that region before editing.`,
        };
      }
      // The browser may choose only the scope name. The SDK root is fixed to
      // this server's checked-in SDK directory; no client path is accepted.
      return {
        scope: "sdk" as StudioScope,
        cwd: sdkRoot,
        writableRoots: [projectDirectory, sdkRoot],
        developerInstructions: `You are editing the Pocket SDK source together with the currently selected Pocket Studio project. The only writable roots are the selected project (${projectDirectory}) and the fixed SDK source (${sdkRoot}); preserve user changes and keep any edits within those roots. Keep application UI, routing and component composition in the JS project, and keep SDK changes limited to the requested integration. Do not modify other managed project sources or read/edit Studio private signing material. Do not create subagents, read credentials, run deployment, publish, use network access, or change files outside these writable roots. Explain changes and test results. An attached screenshot may contain a selected region described with pixel coordinates; inspect that region before editing.`,
      };
    },
    onChanged: async (id) => {
      const state = await getState(id);
      state.revision += 1;
      state.publish = undefined;
      pushLog(state, `Codex turn finished; inspect files and rebuild (revision ${state.revision})`);
      await saveState(workspace, id, state);
    },
  });
  const sdkScopeBlocked = (id: string): boolean =>
    [...projectWrites].some((projectId) => projectId !== id) ||
    [...states.keys()].some((projectId) => wechat.isBuilding(projectId)) ||
    [...states.entries()].some(([projectId, state]) => projectId !== id && state.busy) ||
    // Match deploymentWriting: a running device is a read/preview target and
    // must not block SDK edits; only phases that still mutate/build the app
    // share the SDK/project write boundary.
    devices.listDeployments().some((job) => ["queued", "building", "starting", "stopping"].includes(job.state));

  canApplyStudioUpgrade = (): { allowed: boolean; reason?: string } => {
    const busyWork =
      projectWrites.size > 0 ||
      publishSlots.size > 0 ||
      sdkScopeBlocked("") ||
      [...states.values()].some((state) => state.busy) ||
      [...states.keys()].some((projectId) => codex.isBusy(projectId) || wechat.isBuilding(projectId));
    if (busyWork) {
      return {
        allowed: false,
        reason: "当前有正在执行的项目保存、构建、发布或部署任务，已暂缓自动升级",
      };
    }
    return { allowed: true };
  };

  function armNovelBackup(id: string, state: EditorState, retryMs?: number): void {
    const previous = backupTimers.get(id);
    if (previous) clearTimeout(previous);
    backupTimers.delete(id);
    const minutes = state.novelBackup?.intervalMinutes ?? 0;
    if (backupSchedulerStopped || ![1, 5, 10, 30, 60].includes(minutes)) return;
    const timer = setTimeout(async () => {
      backupTimers.delete(id);
      if (backupSchedulerStopped) return;
      if (projectWrites.has(id) || state.busy || codex.isBusy(id) || wechat.isBuilding(id) || deploymentWriting(id)) {
        armNovelBackup(id, state, 30_000);
        return;
      }
      projectWrites.add(id);
      try {
        const backup = await createNovelBackup({ workspaceRoot: workspace.root, projectRoot: projectDir(id), projectId: id, skipUnchanged: true });
        state.novelBackup = { intervalMinutes: minutes, lastRunAt: now(), lastBackupId: backup.id };
      } catch (error) {
        state.novelBackup = { ...state.novelBackup!, error: error instanceof Error ? error.message : String(error) };
      }
      try { await saveState(workspace, id, state); }
      catch (error) { pushLog(state, `automatic backup state could not be saved: ${String(error)}`); }
      finally { projectWrites.delete(id); armNovelBackup(id, state); }
    }, retryMs ?? minutes * 60_000);
    timer.unref?.();
    backupTimers.set(id, timer);
  }

  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? Number(process.env.POCKET_EDITOR_PORT ?? 8791),
    idleTimeout: 120,
    maxRequestBodySize: maxAssetBytes,
    async fetch(request): Promise<Response> {
      const peer = server.requestIP(request);
      if (!peer || !isLocalNetworkAddress(peer.address)) return failure("forbidden: local network access only", 403);
      const url = new URL(request.url);
      const securityError = validateRequestSecurity(request, url, server.port, csrfToken, server.hostname);
      if (securityError) return securityError;
      const path = url.pathname;
      const method = request.method.toUpperCase();
      let releaseProjectWrite: (() => void) | undefined;
      let releasePublishSlot: (() => void) | undefined;
      try {
        if (path === "/api/preview/device" && method === "GET") return json(previewDevice);
        if (path === "/novel/live2d-core.js" && method === "GET") return serveNovelLive2dCore();
        if (path === "/health" && method === "GET") return json({
          ok: true,
          service: "pocket-editor",
          pid: process.pid,
          version: installedSdkVersion,
          csrfToken,
          bluetooth: { local: !!localBluetooth },
          workspace: workspace.root,
          ...(workspace.projectRoot ? { projectRoot: workspace.projectRoot, projectId: workspace.projectId } : {}),
          ...(flutterRoot ? { flutterRoot } : {}),
          ...(updatePackageVersion ? { updatePackageVersion } : {}),
        });
        if (path === "/api/studio/upgrade" && method === "GET") return json(studioUpgrade.status());
        if (path === "/api/studio/upgrade/check" && method === "POST") {
          let body: Record<string, unknown> = {};
          const raw = await request.text();
          if (raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
            } catch {
              return failure("upgrade check payload must be JSON", 400);
            }
          }
          return json(await studioUpgrade.check({
            autoApply: body.autoApply !== false,
            forceApply: body.forceApply === true,
          }));
        }
        if (path === "/api/studio/upgrade/apply" && method === "POST") {
          return json(await studioUpgrade.apply());
        }
        if ((path === "/novel" || path === "/novel/resource") && method === "GET") {
          const id = asProjectId(url.searchParams.get("project"));
          if (!existsSync(projectDir(id))) return failure("project not found", 404);
          const state = await getState(id);
          return handleNovelRoute(request, { projectRoot: projectDir(id), projectId: id, workspaceRoot: workspace.root, novelRestoreEpoch: state.novelRestoreEpoch ?? 0 });
        }
        if (path === "/" && method === "GET") {
          const clientRoot = join(root, "editor/client");
          const indexFile = join(clientRoot, "index.html");
          const cssFile = join(clientRoot, "editor.css");
          const jsFile = join(clientRoot, "editor.js");
          const [index, cssStat, jsStat] = await Promise.all([readFile(indexFile), stat(cssFile), stat(jsFile)]);
          const versionedIndex = index.toString()
            .replace(/\/editor\.css(?=["'])/, `/editor.css?v=${Math.trunc(cssStat.mtimeMs)}`)
            .replace(/\/editor\.js(?=["'])/, `/editor.js?v=${Math.trunc(jsStat.mtimeMs)}`);
          return new Response(versionedIndex, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" } });
        }
        if (/^\/[A-Za-z0-9_-]+\.(?:css|js)$/.test(path) && method === "GET") {
          const file = join(root, "editor/client", path.slice(1));
          return new Response(await readFile(file), { headers: { "content-type": contentType(file), "cache-control": "no-store" } });
        }
        if (path === "/api/codex/status" && method === "GET") return json(await codex.status());
        if (path === "/api/codex/models" && method === "GET") return json(await codex.models());
        if (path === "/api/devices" && method === "GET") return json({ devices: await devices.listDevices() });
        if ((path.startsWith("/updates/") || path.startsWith("/pocket/") || path.startsWith("/test/pocket/") || path.startsWith("/stable/pocket/")) && (method === "GET" || method === "HEAD")) {
          return await readPublishedResponse(path, new URL(request.url).origin);
        }
        if (path.startsWith("/releases/") && method === "GET") {
          const offline = path.match(/^\/releases\/([a-z][a-z0-9-]{0,47})\/(offline-[A-Za-z0-9][A-Za-z0-9._-]{0,127})\.tar\.gz$/);
          if (offline) {
            const archive = safeArtifactFile(join(workspace.updates, ".downloads", offline[1]!), `${offline[2]}.tar.gz`);
            return new Response(await readFile(archive), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${offline[2]}.tar.gz"` } });
          }
          const legacy = path.match(/^\/releases\/([a-z][a-z0-9-]{0,47})\/(legacy-[A-Za-z0-9][A-Za-z0-9._-]{0,127})\.tar\.gz$/);
          if (legacy) {
            const archive = safeArtifactFile(join(workspace.updates, ".downloads", legacy[1]!), `${legacy[2]}.tar.gz`);
            return new Response(await readFile(archive), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${legacy[1]}-${legacy[2]}.tar.gz"` } });
          }
          const historical = path.match(/^\/releases\/([a-z][a-z0-9-]{0,47})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.tar\.gz$/);
          if (historical) {
            const history = await readVersionHistory(versionHistoryPath(workspace.states, historical[1]!));
            const entry = history.entries.find((candidate) => candidate.releaseId === historical[2]);
            if (!entry) return failure("not found", 404);
            const archive = safeArtifactFile(workspace.updates, entry.archivePath);
            return new Response(await readFile(archive), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${historical[1]}-${historical[2]}.tar.gz"` } });
          }
          const match = path.match(/^\/releases\/([a-z][a-z0-9-]{0,47})\.tar\.gz$/);
          if (!match) return failure("not found", 404);
          const state = await getState(match[1]!);
          const slot = state.publish?.channel === "test" ? "test" : "stable";
          const history = await readVersionHistory(versionHistoryPath(workspace.states, match[1]!));
          const current = currentVersion(history, slot);
          let archive: string;
          if (current) {
            archive = safeArtifactFile(workspace.updates, current.archivePath);
          } else {
            const config = await loadConfig(projectDir(match[1]!), match[1]!);
            const legacyArchive = await ensureLegacyArchive(match[1]!, config, state, updateHostVersion, slot);
            archive = legacyArchive?.archivePath ?? safeArtifactFile(workspace.updates, `${match[1]}.tar.gz`);
          }
          return new Response(await readFile(archive), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${match[1]}.tar.gz"` } });
        }
        if (path === "/api/projects" && method === "GET") return json(await listProjects(workspace, getState));
        if (path === "/api/projects" && method === "POST") {
          const body = await parseJsonBody(request);
          const id = asProjectId(body.id);
          if ((workspace.projectRoot && id === workspace.projectId) || workspace.projectSources?.has(id)) {
            return failure("configured project already exists; edit it instead of creating it", 409);
          }
          const config = await createProject(workspace, id, body);
          const state: EditorState = { revision: 1, builtRevision: null, busy: false, logs: [`created from SDK starter at ${now()}`] };
          states.set(id, state);
          await saveState(workspace, id, state);
          return json({ ...config, status: publicStatus(id, state) }, 201);
        }
        const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
        if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) {
          return failure("not found", 404);
        }
        const id = parts[2] ? asProjectId(parts[2]) : "";
        if (method === "GET" && (parts[3] === "watch" || parts[3] === "chunks" || parts[3] === "stat" || (parts[3] === "build" && parts[4] === "events"))) {
          const crossOrigin = validateNewReadRoute(request, url, server.port);
          if (crossOrigin) return crossOrigin;
        }
        const exists = existsSync(projectDir(id));
        if (!exists) return failure("project not found", 404);
        if (parts[3] === "diagnostics" && parts.length === 4) {
          const state = await getState(id);
          return await handleDiagnosticsRequest(diagnostics, request, id, state.builtRevision ?? undefined);
        }
        // Reserve before any awaited validation/body parsing. Manager-level
        // reservations alone cannot exclude a simultaneous source/AI request.
        // Preview input and cancellation remain available during long tasks.
        // DELETE of a file/folder mutates the project like PUT; other DELETE routes keep their own guards.
        const isWriteMethod = ["PUT", "POST", "PATCH"].includes(method) || (method === "DELETE" && (parts[3] === "files" || parts[3] === "folders"));
        if (isWriteMethod && parts[3] !== "preview") {
          if (projectWrites.has(id)) return failure("Another project operation is starting; retry when it completes", 409);
          projectWrites.add(id);
          releaseProjectWrite = () => projectWrites.delete(id);
        }
        const state = await getState(id);
        if (codex.isBusy(id) && isWriteMethod && !["codex", "preview"].includes(parts[3])) return failure("Codex is editing this project; wait or cancel its turn before saving/building", 409);
        if (wechat.isBuilding(id) && isWriteMethod && parts[3] !== "preview") return failure("WeChat build is using this project; stop it before editing/building", 409);
        if (deploymentWriting(id) && isWriteMethod && parts[3] !== "preview") return failure("Device build is using this project; wait or cancel it before editing/building", 409);
        if (parts[0] === "api" && parts[1] === "projects") {
          if (parts[3] === "publish-targets" && parts.length === 4 && method === "GET") {
            const requestedChannel = new URL(request.url).searchParams.get("channel") ?? "test";
            if (requestedChannel !== "test" && requestedChannel !== "release") return failure("publish target channel must be test or release", 400);
            const config = await loadConfig(projectDir(id), id);
            return json(await projectPublishTargets(id, config, state, requestedChannel));
          }
          if (parts[3] === "novel") {
            if (state.busy && ["PUT", "POST"].includes(method)) return failure("Build in progress; retry editing when the build completes", 409);
            if (parts[4] === "backups" && parts[5] === "schedule" && parts.length === 6) {
              if (method === "GET") return json(state.novelBackup ?? { intervalMinutes: 0 });
              if (method !== "POST") return failure("method not allowed", 405);
              const raw = await request.text();
              if (raw.length > 1024) return failure("backup schedule is too large", 413);
              let body: unknown;
              try { body = JSON.parse(raw); } catch { return failure("backup schedule must be JSON", 422); }
              if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || ![0, 1, 5, 10, 30, 60].includes((body as { intervalMinutes: number }).intervalMinutes)) return failure("intervalMinutes must be 0, 1, 5, 10, 30 or 60", 422);
              state.novelBackup = { ...state.novelBackup, intervalMinutes: (body as { intervalMinutes: number }).intervalMinutes };
              await saveState(workspace, id, state);
              armNovelBackup(id, state);
              return json(state.novelBackup);
            }
            const response = await handleNovelRoute(request, { projectRoot: projectDir(id), projectId: id, workspaceRoot: workspace.root, novelRestoreEpoch: state.novelRestoreEpoch ?? 0 });
            const restoredBackup = parts[4] === "backups" && parts[5] === "restore" && parts.length === 6 && method === "POST";
            if (response.ok && (restoredBackup || ["PUT", "POST"].includes(method) && ["story", "assets", "locales"].includes(parts[4] ?? "") && parts.length === 5)) {
              if (restoredBackup) state.novelRestoreEpoch = (state.novelRestoreEpoch ?? 0) + 1;
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, restoredBackup ? `project backup restored: revision ${state.revision}; rebuild the Guest` : `novel ${parts[4]} saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
            }
            return response;
          }
          if (parts[3] === "preview") {
            // Existing SSE clients retain their loaded runtime during a build.
            // New subscriptions/input must not load a partly copied snapshot.
            if (state.busy && !["status", "snapshot"].includes(parts[4] ?? "")) return failure("Build in progress; retry preview when the build completes", 409);
            const response = await preview.handle(request, id);
            // A demand-driven guest can stay silent indefinitely. Keep only
            // successful SSE responses outside the ordinary HTTP idle limit;
            // no polling, synthetic frames or heartbeat timer is necessary.
            if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
              server.timeout(request, 0);
            }
            return response;
          }
          if (parts[3] === "wechat" && parts.length === 4) {
            if (method === "GET") return json(await wechat.status(id));
            if (method === "DELETE") return json(await wechat.stop(id));
            if (method === "POST") {
              if (state.busy) return failure("Editor build is still running", 409);
              await validateProjectInputTree(projectDir(id));
              const body = await parseJsonBody(request);
              return json(await wechat.start(id, asString(body.targetId, "targetId", 200)), 202);
            }
            return failure("method not allowed", 405);
          }
          if (parts[3] === "deploy") {
            if (parts.length === 4 && method === "GET") return json({ jobs: devices.listDeployments().filter((job) => job.projectId === id).map(publicDeployment) });
            if (parts.length === 4 && method === "POST") {
              if (state.busy) return failure("Editor build is still running", 409);
              await validateProjectInputTree(projectDir(id));
              const body = await parseJsonBody(request);
              return json(publicDeployment(await devices.startDeployment({ projectId: id, deviceId: asString(body.deviceId, "deviceId", 200) })), 202);
            }
            if (parts.length === 5 && ["GET", "DELETE"].includes(method)) {
              const job = devices.getStatus(parts[4]);
              if (job.projectId !== id) return failure("deployment not found", 404);
              return json(publicDeployment(method === "DELETE" ? await devices.cancel(job.id) : job));
            }
          }
          if (parts[3] === "codex" && parts[4] === "turn") {
            if (parts.length === 5 && method === "POST") {
              if (state.busy) return failure("build is still running", 409);
              const body = await parseJsonBody(request, 12 * 1024 * 1024);
              await validateProjectInputTree(projectDir(id));
              // Keep this admission check immediately before start(): the
              // latter reserves its SDK/project lock synchronously before its
              // first await. Checking before the tree scan would leave a
              // window for another project operation to begin.
              if (body.scope === "sdk" && sdkScopeBlocked(id)) return failure("SDK scope waits for other project writes, builds, or deployments to finish", 409);
              return json(await codex.start(id, body), 202);
            }
            if (parts.length === 6 && method === "GET") return json(codex.get(id, parts[5]));
            if (parts.length === 6 && method === "DELETE") return json(await codex.cancel(id, parts[5]));
          }
          if (parts.length === 3 && method === "GET") {
            const config = await loadConfig(projectDir(id), id);
            return json({ ...config, status: publicStatus(id, state) });
          }
          if (parts[3] === "config") {
            if (method === "GET") return json(await loadConfig(projectDir(id), id));
            if (method === "PUT") {
              const current = await loadConfig(projectDir(id), id);
              const body = await parseJsonBody(request);
              const merged = { ...current, ...body };
              if (body.name !== undefined && body.title === undefined) merged.title = body.name;
              const config = validateConfig(id, merged);
              await writeConfig(projectDir(id), config);
              if (workspace.projectRoot && id === workspace.projectId) {
                try {
                  workspace.projectSources = await loadCatalogProjectSources(workspace.projectRoot, id, workspace.projects);
                } catch (error) {
                  workspace.projectSources = new Map();
                  console.warn(`Editor catalog-backed projects are unavailable: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `config saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ ...config, status: publicStatus(id, state) });
            }
          }
          if (parts[3] === "resources") {
            if (parts.length === 5 && parts[4] === "preview" && method === "GET") {
              if (state.builtRevision === null || url.searchParams.get("revision") !== String(state.builtRevision)) return failure("preview revision not found", 404);
              const folder = `${id}/${state.builtRevision}`;
              const snapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${folder}/${RESOURCE_SNAPSHOT_FILE}`));
              const pkg = snapshot.packages.find(item => item.id === url.searchParams.get("package"));
              const resource = pkg?.resources.find(item => item.key === url.searchParams.get("key"));
              const thumbnail = resource?.previewFile;
              const allowedPreview = thumbnail && (/^resource-previews\/\d+\.(png|svg|jpe?g|webp|gif)$/.test(thumbnail) ||
                (resource?.kind === "asset" && thumbnail === resource.key.slice("asset:".length) && /^assets\/.+\.(png|svg|jpe?g|webp|gif)$/i.test(thumbnail)));
              if (!pkg || !thumbnail || !allowedPreview) return failure("resource preview not found", 404);
              const directory = pkg.artifactDirectory === "." ? folder : `${folder}/${pkg.artifactDirectory}`;
              const file = safeArtifactFile(workspace.builds, `${directory}/${thumbnail}`);
              const extension = thumbnail.split(".").pop()!;
              const mime = extension === "svg" ? "image/svg+xml" : extension === "jpg" ? "image/jpeg" : `image/${extension}`;
              return new Response(Bun.file(file), { headers: { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-store" } });
            }
            if (parts.length !== 4) return failure("not found", 404);
            const withPreviews = (inventory: ReturnType<typeof resourceInventory>) => ({ ...inventory,
              packages: inventory.packages.map(pkg => ({ ...pkg, resources: pkg.resources.map(({ previewFile, ...resource }) => ({ ...resource,
                ...(previewFile ? { previewUrl: `/api/projects/${id}/resources/preview?${new URLSearchParams({ revision: String(state.builtRevision), package: pkg.id, key: resource.key })}` } : {}),
              })) })),
            });
            if (method === "GET") {
              // Workspaces built by older Editors have artifacts but no resource
              // snapshot. Their real System catalog remains discoverable.
              const hasResourceSnapshot = state.builtRevision !== null && existsSync(join(workspace.builds, id, String(state.builtRevision), RESOURCE_SNAPSHOT_FILE));
              if (state.builtRevision === null || !state.artifacts || !hasResourceSnapshot) {
                const config = await loadConfig(projectDir(id), id);
                const systemFile = existsSync(join(projectDir(id), "pocket.system.json"))
                  ? safeProjectFile(projectDir(id), "pocket.system.json", { allowConfig: true, mustExist: true })
                  : undefined;
                return json(await emptyResourceInventory({ projectRoot: projectDir(id), rootPackageId: config.appId, rootTitle: config.title, revision: state.revision, ...(systemFile ? { systemFile } : {}) }));
              }
              const snapshotPath = safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`);
              const snapshot = await readResourceSnapshot(snapshotPath);
              const policyPath = safeProjectFile(projectDir(id), RESOURCE_POLICY_FILE, { allowConfig: true });
              try {
                const policy = await readResourcePolicy(policyPath);
                return json(withPreviews(resourceInventory(snapshot, state.revision, policy, state.publish?.packages, state.builtRevision ?? undefined)));
              } catch {
                // A failed rebuild must not make the last completed immutable
                // inventory disappear because a newly edited policy is
                // malformed. The next successful build will surface it.
                return json(withPreviews(resourceInventory(snapshot, state.revision, snapshot.policy, state.publish?.packages, state.builtRevision ?? undefined)));
              }
            }
            if (method === "PUT") {
              if (state.busy) return failure("build is still running", 409);
              if (state.builtRevision === null || !state.artifacts) return failure("build the current source before changing resources", 409);
              const snapshotPath = safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`);
              const snapshot = await readResourceSnapshot(snapshotPath);
              const body = await parseJsonBody(request);
              if (!Number.isSafeInteger(body.revision) || Number(body.revision) !== state.revision) {
                return failure("resource revision is stale; reload the project and retry", 409);
              }
              const packageId = asString(body.packageId, "packageId", 128);
              const policyPath = safeProjectFile(projectDir(id), RESOURCE_POLICY_FILE, { allowConfig: true });
              const currentPolicy = await readResourcePolicy(policyPath);
              const nextPolicy = applyResourcePlacements(snapshot, currentPolicy, packageId, body.placements);
              await writeProjectFile(projectDir(id), RESOURCE_POLICY_FILE, JSON.stringify(nextPolicy, null, 2) + "\n", { allowConfig: true });
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `resource placement saved: ${packageId} (revision ${state.revision})`);
              await saveState(workspace, id, state);
              return json(withPreviews(resourceInventory(snapshot, state.revision, nextPolicy, undefined, state.builtRevision ?? undefined)));
            }
            return failure("method not allowed", 405);
          }
          if (parts[3] === "source") {
            const sourcePath = safeProjectFile(projectDir(id), "app.tsx");
            if (method === "GET") {
              const source = await readFile(sourcePath, "utf8");
              return json({ path: "app.tsx", source, bytes: Buffer.byteLength(source), revision: state.revision });
            }
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxSourceBytes);
              const source = asString(body.source, "source", maxSourceBytes);
              if (source.includes("\0")) throw new Error("source contains a NUL byte");
              await writeProjectFile(projectDir(id), "app.tsx", source);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `source saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ path: "app.tsx", bytes: Buffer.byteLength(source), revision: state.revision });
            }
          }
          // ---- Studio filesystem / transfer / watch / build-control routes (additive) ----
          const commitMutation = async (message: string): Promise<void> => {
            state.revision += 1;
            state.error = undefined;
            state.diagnostics = undefined;
            state.publish = undefined;
            pushLog(state, `${message} (revision ${state.revision})`);
            await saveState(workspace, id, state);
          };
          if (parts[3] === "stat" && method === "GET" && parts.length > 4) {
            const relativePath = parts.slice(4).join("/");
            rejectHiddenSegments(relativePath);
            const statSegments = relativePath.replaceAll("\\", "/").split("/");
            let resolvedPath: string;
            let kind: "file" | "directory" = "directory";
            let editable = true;
            if (statSegments[0]!.toLowerCase() === "assets" && statSegments.length > 1) {
              // Only plain files below assets/ (existing allowAssets policy); nested generated/protected trees are not reported.
              if (statSegments.slice(1).some((part) => protectedDirectoryNames.has(part.toLowerCase()) || ignoredProjectInputDirectories.has(part.toLowerCase()))) return failure("path not found", 404);
              try {
                resolvedPath = safeProjectFile(projectDir(id), relativePath, { allowAssets: true });
              } catch (error) {
                if ((error as Error).message === "project file is not a regular file") return failure("path not found", 404);
                throw error;
              }
              kind = "file";
              editable = false;
            } else {
              try {
                resolvedPath = safeProjectFile(projectDir(id), relativePath, { isDirectory: true });
              } catch (error) {
                if ((error as Error).message !== "path is not a directory") throw error;
                // An existing file: only editable source files are reported; everything else is indistinguishable from missing.
                kind = "file";
                try { resolvedPath = safeProjectFile(projectDir(id), relativePath); } catch { return failure("path not found", 404); }
              }
            }
            const info = lstatIfExists(resolvedPath);
            if (!info) return failure("path not found", 404);
            if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) return failure("path is not a regular file or directory", 400);
            return json({ path: relativePath.replaceAll("\\", "/"), kind, bytes: kind === "file" ? info.size : 0, mtimeMs: info.mtimeMs, editable });
          }
          if (parts[3] === "files" && method === "DELETE" && parts.length > 4) {
            const relativePath = parts.slice(4).join("/");
            rejectHiddenSegments(relativePath);
            const filePath = safeProjectFile(projectDir(id), relativePath, { mustExist: true });
            await unlink(filePath);
            await commitMutation(`file deleted: ${relativePath}`);
            return json({ path: relativePath, revision: state.revision });
          }
          if (parts[3] === "files-move" && parts.length === 4 && method === "POST") {
            const body = await parseJsonBody(request);
            const from = asString(body.from, "from", 1024);
            const to = asString(body.to, "to", 1024);
            const overwrite = body.overwrite === true;
            if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") throw new Error("overwrite must be a boolean");
            rejectHiddenSegments(from);
            rejectHiddenSegments(to);
            const source = safeProjectFile(projectDir(id), from, { mustExist: true });
            const target = safeProjectFile(projectDir(id), to);
            if (source === target) throw new Error("from and to are the same path");
            const existing = lstatIfExists(target);
            if (existing?.isDirectory()) return failure("target is a directory; cannot replace a file with a directory", 409);
            if (existing && !overwrite) return failure("target already exists; pass overwrite:true to replace it", 409);
            await mkdir(dirname(target), { recursive: true });
            const checkedSource = safeProjectFile(projectDir(id), from, { mustExist: true });
            const checkedTarget = safeProjectFile(projectDir(id), to);
            await rename(checkedSource, checkedTarget);
            safeProjectFile(projectDir(id), to, { mustExist: true });
            await commitMutation(`file moved: ${from} -> ${to}`);
            return json({ from, to, revision: state.revision });
          }
          if (parts[3] === "folders" && ((parts.length === 4 && method === "POST") || (parts.length > 4 && method === "DELETE"))) {
            const body = method === "POST" ? await parseJsonBody(request) : {};
            const relativePath = method === "POST" ? asString(body.path, "path", 1024) : parts.slice(4).join("/");
            rejectHiddenSegments(relativePath);
            const folderSegments = relativePath.replaceAll("\\", "/").split("/");
            // Generated/dependency trees are not source folders even where file policy allows the name.
            if (folderSegments.some((part) => ignoredProjectInputDirectories.has(part.toLowerCase()))) return failure("folder name is reserved", 400);
            const folderPath = safeProjectFile(projectDir(id), relativePath, { isDirectory: true, ...(method === "DELETE" ? { mustExist: true } : {}) });
            if (method === "POST") {
              const existed = !!lstatIfExists(folderPath);
              await mkdir(folderPath, { recursive: true });
              safeProjectFile(projectDir(id), relativePath, { isDirectory: true, mustExist: true });
              if (!existed) await commitMutation(`folder created: ${relativePath}`);
              return json({ path: relativePath.replaceAll("\\", "/"), created: !existed, revision: state.revision }, existed ? 200 : 201);
            }
            if ((await readdir(folderPath)).length > 0) return failure("folder is not empty", 409);
            await rmdir(folderPath);
            await commitMutation(`folder deleted: ${relativePath}`);
            return json({ path: relativePath.replaceAll("\\", "/"), revision: state.revision });
          }
          if (parts[3] === "chunks" && method === "GET" && parts.length > 4) {
            const relativePath = parts.slice(4).join("/");
            const filePath = safeProjectFile(projectDir(id), relativePath, { mustExist: true });
            const offset = parseNonNegativeInteger(url.searchParams.get("offset"), "offset", 0);
            const requested = parseNonNegativeInteger(url.searchParams.get("length"), "length", maxChunkBytes);
            if (requested < 1) return failure("length must be at least 1", 400);
            const handle = await openProjectFileForRead(filePath);
            try {
              const info = await handle.stat();
              if (!info.isFile()) return failure("project file is not a regular file", 400);
              if (info.size > maxSourceBytes) return failure("file is too large for chunked transfer", 413);
              if (offset > info.size) return failure("offset is beyond the end of the file", 400);
              const length = Math.min(requested, maxChunkBytes, info.size - offset);
              const buffer = Buffer.alloc(length);
              let filled = 0;
              while (filled < length) {
                const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
                if (bytesRead === 0) break;
                filled += bytesRead;
              }
              const sha256 = await wholeFileSha256(handle, `${filePath}|${info.size}|${info.mtimeMs}`);
              return json({ path: relativePath, offset, length: filled, totalBytes: info.size, sha256, mtimeMs: info.mtimeMs, data: buffer.subarray(0, filled).toString("base64") });
            } finally {
              await handle.close();
            }
          }
          if (parts[3] === "uploads") {
            if (parts.length === 4 && method === "POST") {
              const body = await parseJsonBody(request);
              const relativePath = asString(body.path, "path", 1024);
              rejectHiddenSegments(relativePath);
              safeProjectFile(projectDir(id), relativePath);
              const totalBytes = parseNonNegativeInteger(body.totalBytes, "totalBytes");
              if (totalBytes > maxSourceBytes) return failure(`upload exceeds ${maxSourceBytes} bytes`, 413);
              const sha256 = parseSha256(body.sha256);
              if (uploads.size >= maxOpenUploads) return failure("too many open uploads; commit or abort one first", 429);
              let projectUploads = 0;
              for (const open of uploads.values()) if (open.projectId === id) projectUploads += 1;
              if (projectUploads >= maxOpenUploadsPerProject) return failure(`too many open uploads for this project (max ${maxOpenUploadsPerProject}); commit or abort one first`, 429);
              const uploadId = randomUUID();
              const session: UploadSession = { projectId: id, path: relativePath, totalBytes, sha256, chunks: [], received: 0, timer: undefined as never };
              uploads.set(uploadId, session);
              touchUpload(uploadId, session);
              return json({ uploadId, chunkBytes: maxChunkBytes, expiresInMs: uploadIdleMs }, 201);
            }
            const uploadId = parts[4] ?? "";
            const session = uploads.get(uploadId);
            if (parts.length >= 5 && (!session || session.projectId !== id)) return failure("upload not found", 404);
            if (session && parts.length === 5 && method === "PUT") {
              const body = await parseJsonBody(request);
              const offset = parseNonNegativeInteger(body.offset, "offset");
              if (offset !== session.received) return failure(`chunks must be contiguous: expected offset ${session.received}`, 409);
              const bytes = decodeBase64Strict(body.data, "data");
              if (bytes.length < 1 || bytes.length > maxChunkBytes) return failure(`chunk must be 1..${maxChunkBytes} bytes`, 413);
              if (session.received + bytes.length > session.totalBytes) return failure("chunk exceeds declared totalBytes", 413);
              if (bufferedUploadBytes + bytes.length > maxBufferedUploadBytes) return failure(`upload buffer budget exhausted (${maxBufferedUploadBytes} bytes across all uploads); commit or abort an upload and retry`, 429);
              session.chunks.push(bytes);
              session.received += bytes.length;
              bufferedUploadBytes += bytes.length;
              touchUpload(uploadId, session);
              return json({ uploadId, received: session.received, totalBytes: session.totalBytes });
            }
            if (session && parts.length === 5 && method === "DELETE") {
              dropUpload(uploadId);
              return json({ uploadId, aborted: true });
            }
            if (session && parts.length === 6 && parts[5] === "commit" && method === "POST") {
              if (session.received !== session.totalBytes) return failure(`upload is incomplete: ${session.received} of ${session.totalBytes} bytes`, 409);
              const bytes = Buffer.concat(session.chunks, session.totalBytes);
              if (createHash("sha256").update(bytes).digest("hex") !== session.sha256) return failure("sha256 does not match the uploaded bytes", 422);
              if (bytes.includes(0)) return failure("file contains a NUL byte", 400);
              try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return failure("file is not valid UTF-8", 400); }
              await writeProjectFile(projectDir(id), session.path, new Uint8Array(bytes));
              dropUpload(uploadId);
              await commitMutation(`file uploaded: ${session.path}`);
              return json({ path: session.path, bytes: bytes.length, sha256: session.sha256, revision: state.revision });
            }
            return failure("method not allowed", 405);
          }
          if (parts[3] === "watch" && parts.length === 4 && method === "GET") {
            if (watchClientCount >= maxWatchClients) return failure("too many watchers", 429);
            const directory = projectDir(id);
            let entry = projectWatches.get(id);
            if (!entry) {
              safeProjectFile(directory, "pocket.json", { allowConfig: true });
              let watcher: FSWatcher;
              try {
                watcher = watchFs(directory, { recursive: true, persistent: false });
              } catch (error) {
                return failure(`recursive file watching is unavailable on this platform: ${error instanceof Error ? error.message : String(error)}`, 501);
              }
              const created: ProjectWatch = { watcher, clients: new Set(), pending: new Map(), unsubscribe: () => undefined };
              const watchedId = id;
              const flush = (): void => {
                created.timer = undefined;
                const batch = [...created.pending];
                created.pending.clear();
                for (const [rawPath, renamed] of batch) {
                  const accepted = watchablePath(directory, rawPath);
                  if (!accepted) continue;
                  // A directory's own "change" is only entry churn; creation/removal arrives as "rename".
                  if (accepted.kind === "directory" && !renamed) continue;
                  for (const client of created.clients) client.send({ type: "change", path: accepted.relativePath, kind: accepted.kind, event: renamed ? "rename" : "change" });
                }
              };
              watcher.on("change", (eventType, filename) => {
                if (filename === null || filename === undefined) return;
                const name = String(filename);
                if (watchPathIgnored(name)) return;
                created.pending.set(name, (created.pending.get(name) ?? false) || eventType === "rename");
                created.timer ??= setTimeout(flush, watchDebounceMs);
                created.timer.unref?.();
              });
              watcher.on("error", () => {
                for (const client of [...created.clients]) client.close();
                closeProjectWatch(watchedId);
              });
              created.unsubscribe = subscribeState(state, (event) => {
                if (event.type !== "status") return;
                for (const client of created.clients) {
                  if (client.revision !== event.status.revision) {
                    client.revision = event.status.revision;
                    client.send({ type: "revision", revision: event.status.revision });
                  }
                }
              });
              projectWatches.set(id, created);
              entry = created;
            }
            const active = entry;
            const response = sseResponse(request, (send, close) => {
              const client: WatchClient = { send, close, revision: state.revision };
              active.clients.add(client);
              watchClientCount += 1;
              send({ type: "ready", revision: state.revision });
              return () => {
                if (!active.clients.delete(client)) return;
                watchClientCount -= 1;
                if (active.clients.size === 0 && projectWatches.get(id) === active) closeProjectWatch(id);
              };
            });
            server.timeout(request, 0);
            return response;
          }
          if (parts[3] === "build" && parts[4] === "events" && parts.length === 5 && method === "GET") {
            if (buildEventClientCount >= maxBuildEventClients) return failure("too many build event streams", 429);
            const response = sseResponse(request, (send) => {
              buildEventClientCount += 1;
              const unsubscribe = subscribeState(state, send);
              send({ type: "status", status: publicStatus(id, state) });
              let released = false;
              return () => {
                if (released) return;
                released = true;
                buildEventClientCount -= 1;
                unsubscribe();
              };
            });
            server.timeout(request, 0);
            return response;
          }
          if (parts[3] === "build" && parts[4] === "cancel" && parts.length === 5 && method === "POST") {
            await parseJsonBody(request);
            if (!cancelBuild(state)) return failure("no build is queued or running", 409);
            const settled = buildSettled.get(state);
            if (settled) await Promise.race([settled.catch(() => undefined), new Promise((done) => setTimeout(done, 10_000).unref?.())]);
            // Only claim success once the build has really settled; a shared bootstrap step that cannot be
            // interrupted can keep the build busy past the wait, in which case the cancel is still pending.
            const cancelSettled = !state.busy;
            return json({ cancelled: cancelSettled, ...(cancelSettled ? {} : { pending: true }), status: publicStatus(id, state) }, cancelSettled ? 200 : 202);
          }
          if (parts[3] === "files") {
            if (parts.length === 4 && method === "GET") {
              return json({ files: await listEditableFiles(projectDir(id)), revision: state.revision });
            }
            const relativePath = parts.slice(4).join("/");
            const filePath = safeProjectFile(projectDir(id), relativePath);
            if (method === "GET") {
              if (!existsSync(filePath)) return failure("file not found", 404);
              const content = await readFile(filePath, "utf8");
              return json({ path: relativePath, content, bytes: Buffer.byteLength(content), revision: state.revision });
            }
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxSourceBytes);
              const content = asString(body.content, "content", maxSourceBytes);
              if (content.includes("\0")) throw new Error("content contains a NUL byte");
              await writeProjectFile(projectDir(id), relativePath, content);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `file saved: ${relativePath} (revision ${state.revision})`);
              await saveState(workspace, id, state);
              return json({ path: relativePath, bytes: Buffer.byteLength(content), revision: state.revision });
            }
          }
          if (parts[3] === "manifest") {
            const manifestPath = safeProjectFile(projectDir(id), "manifest.json");
            if (method === "GET") return new Response(await readFile(manifestPath), { headers: { "content-type": "application/json; charset=utf-8" } });
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxJsonBytes);
              const content = JSON.stringify(body, null, 2) + "\n";
              await writeProjectFile(projectDir(id), "manifest.json", content);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `manifest saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ path: "manifest.json", bytes: Buffer.byteLength(content), revision: state.revision });
            }
          }
          if (parts[3] === "status" && method === "GET") return json(publicStatus(id, state));
          if (parts[3] === "logs" && method === "GET") return json({ logs: state.logs, error: state.error ?? null });
          if (parts[3] === "assets") {
            if (method === "GET") return json({ assets: await listAssets(projectDir(id)) });
            if (method === "POST") {
              const csrfHeader = request.headers.get("x-pocket-csrf");
              const editorHeader = request.headers.get("x-pocket-editor");
              const form = await request.formData();
              const formCsrf = form.get("csrfToken");
              const hasValidProof =
                csrfHeader === csrfToken ||
                editorHeader === "1" ||
                (typeof formCsrf === "string" && formCsrf === csrfToken);
              if (!hasValidProof) {
                return failure("forbidden: missing CSRF token for asset upload", 403);
              }
              const value = form.get("file");
              if (!(value instanceof File)) throw new Error("multipart field 'file' is required");
              if (value.size > maxAssetBytes) throw new Error("asset is too large");
              const fileName = basename(value.name);
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName)) throw new Error("asset filename is unsafe");
              await writeProjectFile(projectDir(id), `assets/${fileName}`, new Uint8Array(await value.arrayBuffer()), { allowAssets: true });
              state.revision += 1;
              state.publish = undefined;
              pushLog(state, `asset saved: ${fileName}`);
              await saveState(workspace, id, state);
              return json({ assets: await listAssets(projectDir(id)), revision: state.revision });
            }
          }
          if ((parts[3] === "build" || parts[3] === "compile") && method === "POST") {
            await parseJsonBody(request);
            queueBuild(workspace, id, states, runner, buildScope);
            return json({ status: publicStatus(id, state) }, 202);
          }
          if (parts[3] === "versions" && method === "GET") {
            const config = await loadConfig(projectDir(id), id);
            return json(await versionBackendSnapshot(id, state, config));
          }
          if (parts[3] === "package-offline" && method === "POST") {
            if (state.busy) return failure("build is still running", 409);
            const config = await loadConfig(projectDir(id), id);
            const offline = await publishProject(workspace, id, config, state, `http://127.0.0.1:${server.port}`, updateHostVersion, "release", { offline: true, hostVersionSource: updateHostVersionSource, packageVersion: await resolveCompatVersion(id, config, state) });
            if (!offline.offlineFilename) throw new Error("offline package did not produce an archive");
            return json({
              archiveUrl: `/releases/${id}/${offline.offlineFilename}`,
              filename: offline.offlineFilename,
            });
          }
          if ((parts[3] === "publish" || parts[3] === "package") && method === "POST") {
            const body = await parseJsonBody(request);
            if (body.channel !== undefined && !["test", "release"].includes(body.channel as string)) return failure("publish channel must be test or release", 400);
            if (state.busy) return failure("build is still running", 409);
            const config = await loadConfig(projectDir(id), id);
            const publishChannel = body.channel === "test" ? "test" : "release";
            const publishSlot = versionSlot(publishChannel);
            const publishHistory = await readVersionHistory(versionHistoryPath(workspace.states, id));
            const publishCompatVersion = await resolveCompatVersion(id, config, state, publishHistory);
            const reusePackageIds = new Set(config.reusePublishedPackages ?? []);
            const publishPackageIds = new Set<string>([config.appId]);
            let publishSnapshot: Awaited<ReturnType<typeof readResourceSnapshot>> | undefined;
            if (state.builtRevision !== null) {
              try {
                publishSnapshot = await readResourceSnapshot(safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${RESOURCE_SNAPSHOT_FILE}`));
                const packageIds = new Set(publishSnapshot.packages.map((pkg) => pkg.id));
                for (const packageId of reusePackageIds) {
                  if (packageId === config.appId || !packageIds.has(packageId)) return failure(`reusePublishedPackages must name a catalog child package: ${packageId}`, 400);
                }
                for (const pkg of publishSnapshot.packages) {
                  if (!reusePackageIds.has(pkg.id)) publishPackageIds.add(pkg.id);
                }
              } catch {
                // publishProject performs the authoritative snapshot check;
                // retain the root lock when a stale build has no snapshot.
              }
            }
            let boundOrigin = `http://127.0.0.1:${server.port}`;
            try {
              boundOrigin = versionBackendOrigin();
            } catch (error) {
              pushLog(state, `LAN version backend unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
            const reusedPackages: AggregateHostPackage[] = [];
            if (reusePackageIds.size > 0 && publishSnapshot) {
              const { key } = await editorUpdateTrust(workspace, id);
              for (const packageId of reusePackageIds) {
                reusedPackages.push(await resolveReusePublishedPackage(packageId, updateHostVersion, publishChannel, boundOrigin, key, id));
              }
            }
            // The public fixed index omits compatVersion, so a package slot is
            // globally owned across compatibility branches. Serialize by
            // host/slot/package before scanning all journal entries.
            const publishLockKeys = [...publishPackageIds].sort().map((packageId) => `${updateHostVersion}/${packageId}/${publishSlot}`);
            if (publishLockKeys.some((key) => publishSlots.has(key))) return failure("another publish is using this package slot; retry when it completes", 409);
            for (const key of publishLockKeys) publishSlots.add(key);
            releasePublishSlot = () => publishLockKeys.forEach((key) => publishSlots.delete(key));
            for (const packageId of publishPackageIds) {
              const occupied = await findPublishedPackage(updateHostVersion, packageId, undefined, publishSlot, true);
              const legacyOwner = occupied ? undefined : await findLegacyPublishedOwner(updateHostVersion, packageId, publishSlot, id);
              const owner = occupied?.projectId ?? legacyOwner;
              if (owner && owner !== id) {
                return failure(`package ${packageId} ${publishSlot} slot is owned by project ${owner}; use a unique appId`, 409);
              }
            }
            const result = await publishProject(workspace, id, config, state, boundOrigin, updateHostVersion, publishChannel, {
              hostVersionSource: updateHostVersionSource,
              packageVersion: publishCompatVersion,
              reusedPackages,
            });
            return json({
              status: publicStatus(id, state),
              manifest: result.envelope,
              manifestUrl: state.publish?.manifestUrl,
              hostConfigUrl: state.publish?.hostConfigUrl,
              appConfigUrl: state.publish?.appConfigUrl,
              updateUrl: state.publish?.updateUrl,
              archiveUrl: `/releases/${id}.tar.gz`,
              ...(state.publish?.packages ? { packages: state.publish.packages } : {}),
              ...(state.publish?.reusedPackages ? { reusedPackages: state.publish.reusedPackages } : {}),
            });
          }
          if (parts[3] === "artifacts" && method === "GET") {
            const bytes = await readArtifact(workspace, id, parts[4] ?? "", state);
            if (!bytes) return failure("artifact not available; build first", 404);
            return new Response(bytes, { headers: { "content-type": contentType(parts[4] ?? "artifact"), "cache-control": "no-store" } });
          }
          return failure("not found", 404);
        }

        return failure("not found", 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as unknown as { status?: number })?.status ?? (message.includes("not found") ? 404 : 400);
        return failure(message, status);
      } finally {
        releasePublishSlot?.();
        releaseProjectWrite?.();
      }
    },
  });
  if (options.updateHost !== undefined || process.env.POCKET_EDITOR_UPDATE_HOST) {
    versionBackendOrigin();
  }
  const stop = server.stop.bind(server);
  await diagnostics.recordLog({ message: "Studio started", ...(workspace.projectId ? { projectId: workspace.projectId } : {}) });
  server.stop = ((closeActiveConnections?: boolean) => {
    backupSchedulerStopped = true;
    for (const uploadId of [...uploads.keys()]) dropUpload(uploadId);
    // Kill in-flight compiler process groups instead of orphaning them.
    for (const controller of [...buildScope.controllers]) controller.abort();
    for (const [watchId, entry] of [...projectWatches]) { for (const client of [...entry.clients]) client.close(); closeProjectWatch(watchId); }
    for (const timer of backupTimers.values()) clearTimeout(timer);
    backupTimers.clear();
    codex.dispose();
    const cleanup = Promise.all([preview.dispose(), devices.dispose()]);
    wechat.dispose();
    deviceUpdates?.stop();
    return Promise.all([stop(closeActiveConnections), cleanup]).then(() => diagnostics.close());
  }) as typeof server.stop;
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const index = args.findIndex((value) => value.startsWith(prefix));
    if (index < 0) return undefined;
    const value = args.splice(index, 1)[0]!.slice(prefix.length);
    if (!value) throw new Error(`--${name} requires a value`);
    return value;
  };
  const projectRoot = option("project-root");
  const flutterRoot = option("flutter-root");
  const workspace = option("workspace");
  const host = option("host");
  const portValue = option("port");
  const updateHost = option("update-host");
  const updatePortValue = option("update-port");
  const updateHostVersion = option("update-host-version");
  const updatePackageVersion = option("update-package-version");
  if (args.length > 0) throw new Error(`unknown editor option ${args[0]}`);
  const port = portValue === undefined ? undefined : Number(portValue);
  const updatePort = updatePortValue === undefined ? undefined : Number(updatePortValue);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be an integer from 0 through 65535");
  if (updatePort !== undefined && (!Number.isInteger(updatePort) || updatePort < 0 || updatePort > 65535)) throw new Error("--update-port must be an integer from 0 through 65535");
  const server = await startEditor({ projectRoot, flutterRoot, workspace, host, port, updateHost, updatePort, updateHostVersion, updatePackageVersion });
  console.log(`Pocket Studio listening at http://${server.hostname}:${server.port}`);
  console.log(`workspace: ${resolve(workspace ?? process.env.POCKET_EDITOR_WORKSPACE ?? join(root, ".pocket-build/editor-workspace"))}`);
  if (projectRoot) console.log(`project: ${resolve(projectRoot)}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void server.stop(true); });
}

