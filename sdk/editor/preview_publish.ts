import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  generateDevKey,
  packageArtifacts,
  pocketReleaseDirectory,
  sha256Hex,
  type PublicKeyConfig,
} from "../scripts/package_update.ts";

/**
 * Pocket Studio signed preview slot.
 *
 * The preview child is an ordinary signed package under one fixed app id. It
 * is published into its own `preview` slot so the `test`/`stable` slots, their
 * package-slot ownership checks and the version history journal never see it.
 * Nothing here loads unsigned bytes: the host fetches the slot through the
 * normal update coordinator, which performs the usual signature, hash, ABI and
 * anti-downgrade checks.
 */
export const PREVIEW_APP_ID = "dev.pocket.studio.preview";
export const PREVIEW_PACKAGE_VERSION = "preview";
const PREVIEW_ROOT = ".preview";
const COUNTER_FILE = "preview-slots.json";
const KEY_FILE = "editor-preview-key.json";

type PreviewCounters = {
  schemaVersion: 1;
  slots: Record<string, { build: number; version: string; projectId: string; publishedAt: string }>;
};

export type PreviewWorkspace = { updates: string; states: string; keys: string };

export type PreviewPublishInput = {
  workspace: PreviewWorkspace;
  projectId: string;
  /** Request origin used to build absolute URLs returned to the caller. */
  origin: string;
  hostVersion: string;
  previewAppId?: string;
  /** Directory holding the built `app.qjbc`, `app.pak`, `app.bytecode.json`, `guest-manifest.json` and optional `assets/`. */
  buildDirectory: string;
  revision: number;
  generation: string;
  /** Project config version/build; the preview build number always exceeds the build. */
  version: string;
  build: number;
  networkPak?: string[];
  networkAssets?: string[];
};

export type PreviewPublishResult = {
  buildId: string;
  revision: number;
  generation: string;
  version: string;
  build: number;
  packageId: string;
  manifestUrl: string;
  hostConfigUrl: string;
  payloadSha256: string;
  runtimeAbi: string;
  keyId: string;
  timingsMs: { package: number; sign: number; total: number };
};

const slotLocks = new Set<string>();

function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  return writeFile(temporary, JSON.stringify(value, null, 2) + "\n").then(() => rename(temporary, path));
}

async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** Dedicated Ed25519 preview signing key, generated like the editor dev key. */
export async function previewTrust(workspace: PreviewWorkspace): Promise<{ keyPath: string; key: PublicKeyConfig }> {
  const keyPath = join(workspace.keys, KEY_FILE);
  await mkdir(workspace.keys, { recursive: true });
  if (!existsSync(keyPath)) generateDevKey(keyPath, "editor-preview");
  const stored = await readJson<PublicKeyConfig>(keyPath);
  return { keyPath, key: { keyId: stored.keyId, publicKeyBase64: stored.publicKeyBase64 } };
}

export function previewSlotDirectory(workspace: PreviewWorkspace, hostVersion: string, packageId: string): string {
  return pocketReleaseDirectory(join(workspace.updates, PREVIEW_ROOT), hostVersion, packageId, PREVIEW_PACKAGE_VERSION);
}

export function previewRoute(hostVersion: string, packageId: string): string {
  return `/preview/pocket/${hostVersion}/${encodeURIComponent(packageId)}/${PREVIEW_PACKAGE_VERSION}`;
}

async function pruneUnreferenced(directory: string, keep: Set<string>): Promise<void> {
  for (const sub of ["blobs", "bundles"]) {
    const dir = join(directory, sub);
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (!keep.has(`${sub}/${name}`) && !keep.has(name)) await rm(join(dir, name), { force: true });
    }
  }
}

/**
 * Package the current successful build into the preview slot. The previous
 * preview's content-addressed files stay readable until the next publish so a
 * host that is still downloading them is not broken by the pointer move.
 */
export async function publishPreview(input: PreviewPublishInput): Promise<PreviewPublishResult> {
  const started = performance.now();
  const packageId = input.previewAppId ?? PREVIEW_APP_ID;
  const slotKey = `${input.hostVersion}/${packageId}`;
  if (slotLocks.has(slotKey)) {
    const error = new Error("another preview publish is using this slot; retry when it completes");
    (error as unknown as { status: number }).status = 409;
    throw error;
  }
  slotLocks.add(slotKey);
  try {
    const { keyPath, key } = await previewTrust(input.workspace);
    const countersPath = join(input.workspace.states, COUNTER_FILE);
    const counters = await readJson<PreviewCounters>(countersPath, { schemaVersion: 1, slots: {} });
    const previousBuild = Number(counters.slots[slotKey]?.build ?? 0);
    const metadata = await readJson<Record<string, unknown>>(join(input.buildDirectory, "app.bytecode.json"));
    if (typeof metadata.runtimeAbi !== "string" || !metadata.runtimeAbi) throw new Error("build metadata has no runtime ABI");
    // Strictly above the project's own build, the bootstrap floor and every
    // earlier preview build, so the host's anti-downgrade floor only moves up.
    const build = Math.max(input.build, Number(metadata.build ?? 0), previousBuild) + 1;
    if (!Number.isSafeInteger(build)) throw new Error("preview build number is outside the safe integer range");
    const version = `${input.version}-preview.${build}`;

    const slotDirectory = previewSlotDirectory(input.workspace, input.hostVersion, packageId);
    const stagingRoot = join(input.workspace.updates, PREVIEW_ROOT, `.staging-${randomUUID()}`);
    const staging = join(stagingRoot, "package");
    await mkdir(staging, { recursive: true });
    let signMs = 0;
    const packageStarted = performance.now();
    try {
      const assetDirectory = join(input.buildDirectory, "assets");
      const hasAssets = existsSync(assetDirectory) && readdirSync(assetDirectory).length > 0;
      // The signed payload carries the fixed preview id; the project's own
      // appId in pocket.json and source is never touched.
      const result = packageArtifacts({
        appId: packageId,
        version,
        build,
        bytecodePath: join(input.buildDirectory, "app.qjbc"),
        entryFormat: "quickjs-bytecode",
        runtimeAbi: metadata.runtimeAbi,
        pakPath: join(input.buildDirectory, "app.pak"),
        outDir: staging,
        keyFile: keyPath,
        ...(existsSync(join(input.buildDirectory, "guest-manifest.json"))
          ? { guestManifestPath: join(input.buildDirectory, "guest-manifest.json") }
          : {}),
        ...(hasAssets ? { assetDir: assetDirectory, assetPrefix: "assets" } : {}),
        networkPakKeys: input.networkPak ?? [],
        networkAssets: input.networkAssets ?? [],
        // No one-shot archive: a preview is re-published on every save, the
        // granular blob path only downloads what changed, and it needs no
        // native archive extractor in the host.
        includeBundle: false,
        onSignTiming: (ms) => { signMs = ms; },
      });
      const packageMs = performance.now() - packageStarted;
      const payloadSha256 = sha256Hex(result.payloadBytes);

      // Bootstrap metadata is public, small and pinned by the host config; the
      // signed package remains the only source of executable bytes.
      await mkdir(join(staging, "bootstrap"), { recursive: true });
      await writeFile(join(staging, "bootstrap", "app.bytecode.json"), JSON.stringify(metadata, null, 2) + "\n");
      if (existsSync(join(input.buildDirectory, "guest-manifest.json"))) {
        await cp(join(input.buildDirectory, "guest-manifest.json"), join(staging, "bootstrap", "guest-manifest.json"));
      }
      const route = previewRoute(input.hostVersion, packageId);
      await writeFile(join(staging, "host.json"), JSON.stringify({
        kind: "pocket-studio-preview-host",
        schemaVersion: 1,
        appId: packageId,
        hostVersion: input.hostVersion,
        packageVersion: PREVIEW_PACKAGE_VERSION,
        // Absolute URLs are filled from the request origin when served.
        POCKET_UPDATE_URL: `${route}/latest.json`,
        POCKET_UPDATE_KEY_ID: key.keyId,
        POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
        POCKET_HOST_VERSION: input.hostVersion,
        POCKET_STORE_NAMESPACE: "studio-preview",
        version,
        build,
        runtimeAbi: metadata.runtimeAbi,
        payloadSha256,
      }, null, 2) + "\n");

      // Persist the build counter before any pointer file so a crash cannot reuse a build number.
      counters.slots[slotKey] = { build, version, projectId: input.projectId, publishedAt: new Date().toISOString() };
      await mkdir(input.workspace.states, { recursive: true });
      await atomicJson(countersPath, counters);

      // Swap in: immutable content-addressed files first, pointer files last.
      const previousPayload = await readJson<{ files?: Array<{ url: string }> }>(join(slotDirectory, "payload.json"), {});
      await mkdir(slotDirectory, { recursive: true });
      for (const sub of ["blobs", "bundles", "bootstrap"]) {
        const source = join(staging, sub);
        if (!existsSync(source)) continue;
        await mkdir(join(slotDirectory, sub), { recursive: true });
        for (const name of await readdir(source)) {
          const target = join(slotDirectory, sub, name);
          if (sub !== "bootstrap" && existsSync(target)) continue; // content addressed
          await rename(join(source, name), target);
        }
      }
      for (const name of ["bundle.7z", "bundle.zip", "payload.json", "signed-manifest.json", "host.json", "latest.json"]) {
        const source = join(staging, name);
        if (!existsSync(source)) continue;
        const temporary = join(slotDirectory, `.${name}.${randomUUID()}.tmp`);
        await rename(source, temporary);
        await rename(temporary, join(slotDirectory, name));
      }
      const keep = new Set<string>();
      for (const file of [...result.payload.files, ...(previousPayload.files ?? [])]) keep.add(file.url);
      if (result.payload.bundle) keep.add(result.payload.bundle.url);
      await pruneUnreferenced(slotDirectory, keep);

      return {
        buildId: `${input.projectId}@${input.revision}`,
        revision: input.revision,
        generation: input.generation,
        version,
        build,
        packageId,
        manifestUrl: `${input.origin}${route}/latest.json`,
        hostConfigUrl: `${input.origin}${route}/host.json`,
        payloadSha256,
        runtimeAbi: metadata.runtimeAbi,
        keyId: key.keyId,
        timingsMs: {
          package: round(packageMs - signMs),
          sign: round(signMs),
          total: round(performance.now() - started),
        },
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } finally {
    slotLocks.delete(slotKey);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const artifactRoots = new Set([
  "latest.json", "signed-manifest.json", "payload.json", "host.json",
  "bundle.7z", "bundle.zip", "bundles", "blobs", "bootstrap",
]);

/**
 * Serve `/preview/pocket/<host>/<packageId>/preview/<artifact>`. Same public,
 * read-only artifact set as the test/stable slots; nothing outside the slot
 * directory is reachable.
 */
export async function readPreviewSlot(workspace: PreviewWorkspace, path: string, servingOrigin: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean);
  const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
  if (parts[0] !== "preview" || parts[1] !== "pocket" || parts.length < 6 || parts[4] !== PREVIEW_PACKAGE_VERSION) return notFound();
  const host = parts[2]!;
  let packageId: string;
  try { packageId = decodeURIComponent(parts[3]!); } catch { return notFound(); }
  const artifact = parts.slice(5);
  if (!artifactRoots.has(artifact[0]!) || artifact.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return notFound();
  let directory: string;
  try { directory = previewSlotDirectory(workspace, host, packageId); } catch { return notFound(); }
  const file = join(directory, ...artifact);
  if (relative(directory, file).startsWith("..") || !existsSync(file)) return notFound();
  let bytes: Uint8Array = new Uint8Array(await readFile(file));
  if (artifact.length === 1 && artifact[0] === "host.json") {
    const config = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof config.POCKET_UPDATE_URL === "string" && config.POCKET_UPDATE_URL.startsWith("/")) {
      config.POCKET_UPDATE_URL = `${servingOrigin}${config.POCKET_UPDATE_URL}`;
    }
    bytes = new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n");
  }
  const type = artifact[0] === "bundles" || artifact[0] === "blobs" || artifact[0]!.startsWith("bundle.")
    ? "application/octet-stream"
    : "application/json; charset=utf-8";
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
}
