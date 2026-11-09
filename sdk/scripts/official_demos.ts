#!/usr/bin/env bun
/**
 * Build and benchmark the official PocketJS app sources pinned in .cache.
 * Sources stay in the pinned upstream tree; generated artifacts live under
 * demo/build/official-demos and are ignored by git.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolveManagedBun, resolvePrebuiltTools, UPSTREAM_REVISION } from "./prebuilt_tools.mjs";

type JsonObject = Record<string, any>;
type Motion = "continuous" | "static";
type Status = "passed" | "build_failed" | "runtime_failed" | "platform_limited";
type Mode = "all" | "build" | "benchmark";

type WorkerDescriptor = JsonObject & {
  kind: "quickjs-bytecode";
  protocolVersion: number;
  bytecode: { path: string; bytes: number; sha256: string };
  declaration: JsonObject;
  requiredCaps: string[];
  runtimeAbi: string;
  bindingGeneration: number;
  tickHz: number;
};

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(sdkRoot, "..");
const upstreamRoot = join(sdkRoot, ".cache/pocketjs");
const defaultOutputRoot = join(repositoryRoot, "demo/build/official-demos");
const pocketBenchManifest = join(sdkRoot, "native/Cargo.toml");
const pocketBenchBinary = join(sdkRoot, "native/target/release/pocket_bench");
const pocketSessionSource = join(sdkRoot, "lib/src/pocket_session.dart");
const SESSION_CAPABILITY_MARKER = "Set<String> get capabilities => {";
const CONTINUOUS_SOURCE_PATTERN = /\bonFrame(?:Delta)?\s*\(|\buseFrame\s*\(|\brequestAnimationFrame\s*\(|\bsetInterval\s*\(|\binfinite\b/;
const RAW_BENCH_NOT_EXERCISED = new Set([
  "input.buttons", "input.analog.left", "input.analog.right", "input.touch", "input.touch.auxiliary",
  "input.pointer", "input.cursor", "input.text", "input.ime", "display.auxiliary", "display.viewport.live",
  "ui.physics", "io.offload", "text.layout.offload", "audio.pcm", "system.agent",
]);
const POINTER_FALLBACK_CAPABILITIES = new Set([
  "input.buttons", "input.pointer", "input.touch",
]);
const CAPABILITY_PLATFORM_HINTS: Record<string, string> = {
  "input.buttons": "Flutter keyboard buttons require explicit keyboardInputEnabled; physical controllers require a real host input provider. Pointer fallback alone does not provide button bits.",
  "input.analog.left": "The current Flutter host does not provide analog gamepad axes.",
  "input.analog.right": "The current Flutter host does not provide right analog gamepad axes.",
  "input.touch.auxiliary": "The current Flutter host does not provide an auxiliary touch surface.",
  "display.auxiliary": "The current Flutter host does not provide a second display surface.",
  "ui.physics": "The native frame benchmark enables the runtime core, but does not validate PocketSession capability admission or Flutter physics projection.",
  "runtime.worker": "The worker-aware native benchmark attaches the Worker bytecode domain before UI evaluation; a plain benchmark without a worker descriptor cannot validate this capability.",
  "io.offload": "pocket_bench has no offload provider.",
};

function runCaptured(command: string[], cwd: string, timeout = 300_000): { stdout: string; stderr: string } {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || `command exited ${result.status}`).trim();
    throw new Error(`${command.join(" ")} exited ${result.status ?? 1}: ${output}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface Demo {
  id: string;
  title: string;
  packageId: string | null;
  version: string | null;
  sourceEntry: string;
  sourceManifest: string | null;
  sourceSha256: string;
  manifestSha256: string | null;
  framework: string;
  capabilities: string[];
  requiredCapabilities: string[];
  enhancedCapabilities: string[];
  viewport: { width: number; height: number } | null;
  auxiliaryViewport: { width: number; height: number } | null;
  motion: Motion;
  qjbcPath: string;
  pakPath: string;
  metadataPath: string;
  guestManifestPath?: string;
  workerDeclaration?: JsonObject;
  workerQjbcPath?: string;
  workerMetadataPath?: string;
  workerConfigPath?: string;
  worker?: WorkerDescriptor;
  sourceAdaptation?: JsonObject;
  status?: Status;
  statusReason?: string;
  hostCompatibility?: JsonObject;
  launchable?: boolean;
  launchability?: string;
  launchabilityDetails?: JsonObject;
  build?: JsonObject;
  nativeBenchmark?: JsonObject;
}

/**
 * Classifies a compiled demo against this host's capability facts once, at
 * catalog generation time. A pointer fallback is only a launch recommendation
 * and never grants a gamepad capability to the native host.
 */
export function classifyOfficialDemoLaunchability(demo: {
  status?: string;
  hostCompatibility?: { missingSessionCapabilities?: unknown };
}): {
  launchable: boolean;
  launchability: "direct" | "portable_pointer_fallback" | "platform_limited";
  launchabilityDetails: {
    pointerFallbackCapabilities: string[];
    blockedCapabilities: string[];
  };
} {
  const missing = Array.isArray(demo.hostCompatibility?.missingSessionCapabilities)
    ? [...new Set(demo.hostCompatibility.missingSessionCapabilities.filter((value): value is string => typeof value === "string"))]
    : [];
  const pointerFallbackCapabilities = missing.filter(value => POINTER_FALLBACK_CAPABILITIES.has(value));
  const blockedCapabilities = missing.filter(value => !POINTER_FALLBACK_CAPABILITIES.has(value));
  return {
    launchable: demo.status === "passed" && blockedCapabilities.length === 0,
    launchability: blockedCapabilities.length > 0
      ? "platform_limited"
      : pointerFallbackCapabilities.length > 0
        ? "portable_pointer_fallback"
        : "direct",
    launchabilityDetails: { pointerFallbackCapabilities, blockedCapabilities },
  };
}

function parseArgs(argv: string[]): { mode: Mode; apps: string[] | null; outputRoot: string; frames: number; warmup: number; tickHz: number; density: number } {
  let mode: Mode = "all";
  let modeSet = false;
  let apps: string[] | null = null;
  let outputRoot = defaultOutputRoot;
  let frames = 300;
  let warmup = 10;
  let tickHz = 60;
  let density = 1;
  for (const arg of argv) {
    if (["all", "build", "benchmark"].includes(arg)) {
      if (modeSet) throw new Error("Use only one mode: all, build, or benchmark");
      mode = arg as Mode;
      modeSet = true;
    } else if (arg.startsWith("--apps=")) {
      const values = arg.slice("--apps=".length).split(",").map(value => value.trim()).filter(Boolean);
      apps = values.includes("all") ? null : values;
    } else if (arg.startsWith("--out-dir=")) {
      outputRoot = resolve(arg.slice("--out-dir=".length));
    } else if (arg.startsWith("--frames=")) {
      frames = positiveInteger(arg.slice("--frames=".length), "frames");
    } else if (arg.startsWith("--warmup=")) {
      warmup = nonNegativeInteger(arg.slice("--warmup=".length), "warmup");
    } else if (arg.startsWith("--tick-hz=")) {
      tickHz = positiveInteger(arg.slice("--tick-hz=".length), "tick-hz");
      if (tickHz > 120) throw new Error("tick-hz must be <= 120");
    } else if (arg.startsWith("--density=")) {
      density = positiveInteger(arg.slice("--density=".length), "density");
      if (density > 4) throw new Error("density must be <= 4");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode, apps, outputRoot, frames, warmup, tickHz, density };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/official_demos.ts [all|build|benchmark] [options]

Modes:
  all         Build each selected mounted official app and run pocket_bench (default)
  build       Build JS/PAK/QJBC/metadata only; writes build-report.json
  benchmark   Run pocket_bench on existing artifacts; writes catalog.json and report.json

Options:
  --apps=hero,motions   Select IDs (default: every apps/<app>/main.tsx)
  --out-dir=PATH        Ignored artifact directory (default: demo/build/official-demos)
  --frames=N            Native measured frames (default: 300)
  --warmup=N            Native warmup frames (default: 10)
  --tick-hz=N           Guest tick rate (default: 60)
  --density=N           Raster density, 1..4 (default: 1)

Worker demos pass --worker-bytecode and a canonical --worker-config to
pocket_bench. Their report distinguishes Worker attachment from HTTP request
I/O and device/Flutter FPS claims.`);
}

function relativeSlash(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(directory: string): string[] {
  const result: string[] = [];
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === "node_modules" || item.name === ".git" || item.name === "target" || item.name === "dist") continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...filesUnder(path));
    else if (item.isFile()) result.push(path);
  }
  return result;
}

function readJson(path: string): JsonObject | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

function nearestManifest(entryPath: string): { path: string; value: JsonObject } | null {
  let directory = dirname(entryPath);
  while (directory.startsWith(upstreamRoot)) {
    const candidates = readdirSync(directory)
      .filter(name => /^pocket(?:\.[^.]+)?\.json$/.test(name))
      .map(name => join(directory, name));
    const entryRelative = relativeSlash(upstreamRoot, entryPath);
    const matches = candidates.map(path => ({ path, value: readJson(path) }))
      .filter((candidate): candidate is { path: string; value: JsonObject } => candidate.value !== null);
    const matching = matches.find(candidate => candidate.value.app?.entry === entryRelative);
    if (matching) return matching;
    const primary = matches.find(candidate => candidate.path === join(directory, "pocket.json"));
    if (primary) return primary;
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return null;
}

function logicalViewport(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const shape = value as JsonObject;
  const logical = Array.isArray(shape.logical) ? shape.logical : null;
  if (logical && typeof logical[0] === "number" && typeof logical[1] === "number") {
    return { width: logical[0], height: logical[1] };
  }
  return null;
}

function appViewport(app: JsonObject): { width: number; height: number } | null {
  const fixed = logicalViewport(app.viewport?.fixed);
  if (fixed) return fixed;
  const dynamic = app.viewport?.dynamic;
  if (dynamic && Array.isArray(dynamic.default)) {
    return logicalViewport({ logical: dynamic.default });
  }
  return null;
}

function capabilitiesFor(manifest: JsonObject | null): { required: string[]; enhanced: string[] } {
  const section = manifest?.engine?.capabilities ?? manifest?.capabilities ?? {};
  const required = Array.isArray(section.requires) ? section.requires.filter((value: unknown): value is string => typeof value === "string") : [];
  const enhanced = Array.isArray(section.enhances) ? section.enhances.filter((value: unknown): value is string => typeof value === "string") : [];
  return { required: [...new Set(required)].sort(), enhanced: [...new Set(enhanced)].sort() };
}

function motionFor(entryPath: string, manifestPath: string | null): Motion {
  const appDirectory = dirname(entryPath);
  const sources = filesUnder(appDirectory).filter(path => /\.(tsx?|json)$/.test(path));
  if (manifestPath) sources.push(manifestPath);
  for (const path of new Set(sources)) {
    const source = readFileSync(path, "utf8");
    if (CONTINUOUS_SOURCE_PATTERN.test(source)) return "continuous";
    if (/\b(?:for|while)\s*\([^)]*\)\s*\{[\s\S]{0,500}\bawait\s+after\s*\(/.test(source)) return "continuous";
    // Themes can express perpetual/native-timeline motion without a JS frame hook.
    if (/"(?:loop|iterations)"\s*:\s*(?:"infinite"|\d+)|"value"\s*:\s*"[^"]*infinite/.test(source)) return "continuous";
  }
  return "static";
}

function discover(outputRoot: string): Demo[] {
  if (!existsSync(upstreamRoot)) throw new Error(`Pinned PocketJS cache is missing: ${upstreamRoot}`);
  const markerPath = join(upstreamRoot, ".pocketjs-revision");
  const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
  if (marker !== UPSTREAM_REVISION) {
    throw new Error(`Pinned PocketJS revision mismatch: expected ${UPSTREAM_REVISION}, found ${marker || "no marker"}`);
  }
  const appsRoot = join(upstreamRoot, "apps");
  // Each direct child of apps/ is one installable package. Nested entries such
  // as nexus-touch/e7/main.tsx are target variants that deliberately retain
  // the parent package ID; registering them as another app creates duplicate
  // identities in the host catalog.
  const entries = readdirSync(appsRoot, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => join(appsRoot, item.name, "main.tsx"))
    .filter(existsSync)
    .sort((a, b) => a.localeCompare(b));
  return entries.map(entryPath => {
    const relativeEntry = relativeSlash(upstreamRoot, entryPath);
    const directoryId = relativeSlash(appsRoot, dirname(entryPath));
    const id = directoryId.replaceAll("/", "-");
    const located = nearestManifest(entryPath);
    const manifest = located?.value ?? null;
    const caps = capabilitiesFor(manifest);
    const manifestPath = located?.path ?? null;
    const app = manifest?.app ?? {};
    const workerDeclaration = manifest?.domains?.worker;
    const sourceFiles = [entryPath, ...(manifestPath ? [manifestPath] : [])];
    const sourceSha256 = createHash("sha256").update(sourceFiles.map(path => `${relativeSlash(upstreamRoot, path)}\0${hashFile(path)}`).join("\n")).digest("hex");
    const viewport = appViewport(app);
    const auxiliaryViewport = logicalViewport(app.surfaces?.auxiliary?.fixed);
    const outputDir = join(outputRoot, "demos", id);
    return {
      id,
      title: typeof manifest?.title === "string" ? manifest.title : id,
      packageId: typeof manifest?.id === "string" ? manifest.id : null,
      version: typeof manifest?.version === "string" ? manifest.version : null,
      sourceEntry: relativeEntry,
      sourceManifest: manifestPath ? relativeSlash(upstreamRoot, manifestPath) : null,
      sourceSha256,
      manifestSha256: manifestPath ? hashFile(manifestPath) : null,
      framework: typeof app.framework === "string" ? app.framework : "solid",
      capabilities: [...new Set([...caps.required, ...caps.enhanced])].sort(),
      requiredCapabilities: caps.required,
      enhancedCapabilities: caps.enhanced,
      viewport,
      auxiliaryViewport,
      motion: motionFor(entryPath, manifestPath),
      qjbcPath: relativeSlash(outputRoot, join(outputDir, "app.qjbc")),
      pakPath: relativeSlash(outputRoot, join(outputDir, "app.pak")),
      metadataPath: relativeSlash(outputRoot, join(outputDir, "app.bytecode.json")),
      ...(workerDeclaration && typeof workerDeclaration === "object" && !Array.isArray(workerDeclaration)
        ? { workerDeclaration: workerDeclaration as JsonObject }
        : {}),
    } satisfies Demo;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function readSessionCapabilityState(): { defaults: string[]; conditional: string[]; additionalCapabilities: boolean } {
  const source = readFileSync(pocketSessionSource, "utf8");
  function getterBody(marker: string): string {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Cannot find PocketSession capability getter ${marker}`);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
    }
    throw new Error("PocketSession capability getter is not balanced");
  }
  let body = getterBody(SESSION_CAPABILITY_MARKER);
  if (body.includes("..._builtInCapabilities")) body += getterBody("Set<String> get _builtInCapabilities => {");
  // Conditions may contain a nested call (for example Set.contains). Remove
  // their full expressions before reading unconditional entries, so a string
  // in a condition can never accidentally advertise a default host grant.
  const conditionalPattern = /if\s*\((?:[^()]|\([^()]*\))*\)\s*'([^']+)'/g;
  const conditional = new Set([...body.matchAll(conditionalPattern)].map(match => match[1]!));
  const all = [...body.replace(conditionalPattern, "").matchAll(/'([^']+)'/g)].map(match => match[1]!);
  const defaults = all.filter(value => !conditional.has(value));
  return {
    defaults: [...new Set(defaults)].sort(),
    conditional: [...conditional].sort(),
    additionalCapabilities: body.includes("config.additionalCapabilities"),
  };
}

function hostCompatibility(demo: Demo, session: ReturnType<typeof readSessionCapabilityState>): JsonObject {
  const missing = demo.requiredCapabilities.filter(capability =>
    !session.defaults.includes(capability) && !session.conditional.includes(capability),
  );
  const missingEnhancements = demo.enhancedCapabilities.filter(capability =>
    !session.defaults.includes(capability) && !session.conditional.includes(capability),
  );
  const conditional = demo.requiredCapabilities.filter(capability => session.conditional.includes(capability));
  const conditionalEnhancements = demo.enhancedCapabilities.filter(capability => session.conditional.includes(capability));
  const benchNotExercised = demo.requiredCapabilities.filter(capability =>
    (RAW_BENCH_NOT_EXERCISED.has(capability) && !(capability === "runtime.worker" && demo.workerDeclaration))
      || capability.startsWith("input.") || capability.startsWith("audio."),
  );
  const caveats = [...new Set([...missing, ...benchNotExercised])].map(capability => ({
    capability,
    reason: CAPABILITY_PLATFORM_HINTS[capability]
      ?? (missing.includes(capability)
        ? "This capability is not included in PocketSession defaults; a consumer must explicitly configure a provider or additional capability."
        : "pocket_bench does not inject this input or exercise this native capability."),
  }));
  return {
    defaultSessionCapabilities: session.defaults,
    conditionallyAvailableSessionCapabilities: conditional,
    missingSessionCapabilities: missing,
    missingEnhancedSessionCapabilities: missingEnhancements,
    conditionalRequiredCapabilities: conditional,
    conditionalEnhancedCapabilities: conditionalEnhancements,
    rawNativeBenchDoesNotExercise: benchNotExercised,
    caveats,
    touchInput: "Flutter pointer input maps to touch/Focusable; this is not a physical gamepad or input.buttons bitmask source.",
    nativeBenchScope: "Raw QuickJS/native FFI frame timing only; it does not test Flutter Session admission, Dart decode/build, raster, GPU, or a device frame rate.",
  };
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function absoluteArtifactPath(outputRoot: string, relativePath: string): string {
  return resolve(outputRoot, relativePath);
}

/**
 * Keep the official sweep on the same worker descriptor contract as
 * build_guest.ts.  The official source cache is a mounted upstream tree, so
 * it is built by tools/build.ts rather than by buildGuest; the descriptor is
 * nevertheless assembled from the same pinned worker contract and QuickJS
 * metadata fields.  The descriptor is deliberately duplicated only at this
 * boundary so no source or host fallback is introduced for official apps.
 */
async function makeWorkerDescriptor(
  declaration: JsonObject,
  bytecodePath: string,
  metadataPath: string,
): Promise<WorkerDescriptor> {
  const workerSpec = await import(new URL(`../.cache/pocketjs/contracts/spec/worker.ts`, import.meta.url).href) as {
    WORKER_PROTOCOL_VERSION: number;
    WORKER_RESOURCES: Record<string, { capability: string }>;
  };
  const workerMetadata = readJson(metadataPath) ?? {};
  const workerBytes = readFileSync(bytecodePath);
  const resources = workerSpec.WORKER_RESOURCES;
  const nodes = Array.isArray(declaration.nodes) ? declaration.nodes as JsonObject[] : [];
  const requiredCaps = [...new Set([
    "runtime.worker",
    ...nodes.map(node => resources[String(node.kind)]?.capability).filter((value): value is string => typeof value === "string"),
  ])].sort();
  const descriptor: WorkerDescriptor = {
    kind: "quickjs-bytecode",
    protocolVersion: workerSpec.WORKER_PROTOCOL_VERSION,
    bytecode: {
      path: "app.worker.qjbc",
      bytes: workerBytes.byteLength,
      sha256: createHash("sha256").update(workerBytes).digest("hex"),
    },
    declaration,
    requiredCaps,
    formatVersion: workerMetadata.formatVersion,
    sourceSha256: workerMetadata.sourceSha256,
    payloadSha256: workerMetadata.payloadSha256,
    runtimeAbi: workerMetadata.runtimeAbi,
    engineAbi: workerMetadata.engineAbi,
    bindingGeneration: workerMetadata.bindingGeneration,
    tickHz: workerMetadata.tickHz,
  };
  if (typeof descriptor.runtimeAbi !== "string" || typeof descriptor.bindingGeneration !== "number" || typeof descriptor.tickHz !== "number") {
    throw new Error(`Worker metadata is missing ABI/binding/tick fields: ${metadataPath}`);
  }
  return descriptor;
}

/**
 * The upstream worker-http sample is gamepad-first.  Keep its CROSS handler
 * and source provenance, but compile a disposable mounted copy with a
 * Focusable Request control so the Flutter pointer/touch path can exercise
 * the same channel without claiming to emulate input.buttons.
 */
function prepareWorkerHttpSource(demo: Demo, entryAbsolute: string): {
  entry: string;
  projectRoot: string;
  adaptation?: JsonObject;
  cleanup: () => void;
} {
  if (demo.id !== "worker-http" || !demo.requiredCapabilities.includes("input.buttons")) {
    return { entry: entryAbsolute, projectRoot: upstreamRoot, cleanup: () => {} };
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "pocket-official-worker-http-"));
  const appRoot = join(tempRoot, "apps", "worker-http");
  mkdirSync(appRoot, { recursive: true });
  const adaptedEntry = join(appRoot, "worker-http-main.tsx");
  const workerSource = join(dirname(entryAbsolute), "worker.ts");
  const originalWorker = readFileSync(workerSource, "utf8");
  const completionFallback = "if (!ended) publish(5, total, outcome.status);";
  if (!originalWorker.includes(completionFallback)) throw new Error("worker-http completion adaptation did not match pinned source");
  writeFileSync(join(appRoot, "worker.ts"), originalWorker.replace(completionFallback,
    "if (!ended) publish(outcome.status === ResourceStatus.ok ? 4 : 5, total, outcome.status);"));
  const original = readFileSync(entryAbsolute, "utf8");
  const adapted = original
    .replace(
      'import { Text, View } from "@pocketjs/framework/components";',
      'import { Focusable, Text, View } from "@pocketjs/framework/components";',
    )
    .replace(
      '  onButtonPress(BTN.CROSS, () => { request.publish(Uint8Array.of(1)); });',
      '  const requestOnce = () => { request.publish(Uint8Array.of(1)); };\n  onButtonPress(BTN.CROSS, requestOnce);',
    )
    .replace(
      '    <Text class="text-sm text-slate-300">Pair Pocket Link, then press B to request.</Text>',
      '    <Text class="text-sm text-slate-300">Pair Pocket Link, then press B or tap Request.</Text>\n    <Focusable class="rounded bg-blue-600 px-3 py-2" onPress={requestOnce}><Text class="text-sm text-white">Request</Text></Focusable>',
    );
  if (adapted === original || !adapted.includes("onPress={requestOnce}")) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error("worker-http pointer adaptation did not match the pinned source shape");
  }
  writeFileSync(adaptedEntry, adapted);
  writeFileSync(join(appRoot, "pocket.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket-nexus.worker-http",
    name: "pocketjs-worker-http",
    title: "Worker HTTP",
    version: "0.1.0",
    engine: { capabilities: { requires: ["runtime.worker", "net.http", "input.buttons", "text.glyphs.baked"] } },
    app: {
      entry: "apps/worker-http/worker-http-main.tsx",
      output: "worker-http-main",
      framework: "solid",
      viewport: { fixed: { logical: [400, 240], presentation: "native" } },
    },
    domains: JSON.parse(readFileSync(join(dirname(entryAbsolute), "pocket.json"), "utf8")).domains,
  }, null, 2) + "\n");
  const adaptation = {
    kind: "flutter_pointer_fallback",
    source: "sdk/scripts/official_demos.ts",
    originalEntry: relativeSlash(upstreamRoot, entryAbsolute),
    generatedEntry: relativeSlash(tempRoot, adaptedEntry),
    reason: "The upstream sample binds request initiation to BTN.CROSS; the mounted copy keeps that handler and adds a Focusable Request control for Flutter pointer/touch input.",
    upstreamSourceSha256: hashFile(entryAbsolute),
  };
  return {
    entry: adaptedEntry,
    projectRoot: tempRoot,
    adaptation,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

async function buildDemo(demo: Demo, outputRoot: string, tickHz: number, density: number): Promise<void> {
  const entryAbsolute = join(upstreamRoot, demo.sourceEntry);
  const outputAbsolute = absoluteArtifactPath(outputRoot, `demos/${demo.id}`);
  const directAppMain = /^apps\/([^/]+)\/main\.tsx?$/.exec(demo.sourceEntry);
  const baseOutputName = directAppMain
    ? `${directAppMain[1]}-main`
    : demo.sourceEntry.split("/").at(-1)!.replace(/\.tsx?$/, "");
  const frameworkSuffix = demo.framework === "vue-vapor" ? ".vue-vapor" : demo.framework === "octane" ? ".octane" : "";
  const outputName = `${baseOutputName}${frameworkSuffix}`;
  const bun = resolveManagedBun(sdkRoot);
  const pinnedTools = resolvePrebuiltTools(sdkRoot);
  const mounted = prepareWorkerHttpSource(demo, entryAbsolute);
  const upstreamBuildCommand = [bun, join(upstreamRoot, "tools/build.ts"), mounted.entry,
    `--project-root=${mounted.projectRoot}`, `--outdir=${outputAbsolute}`, `--framework=${demo.framework}`, `--hz=${tickHz}`, `--density=${density}`];
  const generatedSource = join(outputAbsolute, `${outputName}.js`);
  const generatedPak = join(outputAbsolute, `${outputName}.pak`);
  const bytecode = join(outputAbsolute, "app.qjbc");
  const metadata = join(outputAbsolute, "app.bytecode.json");
  const workerSource = demo.workerDeclaration ? join(outputAbsolute, `${outputName}.worker.js`) : undefined;
  const workerBytecode = demo.workerDeclaration ? join(outputAbsolute, "app.worker.qjbc") : undefined;
  const workerMetadata = demo.workerDeclaration ? join(outputAbsolute, "app.worker.bytecode.json") : undefined;
  const bytecodeCommand = [pinnedTools.bytecode, "--input", generatedSource, "--output", bytecode,
    "--metadata", metadata, "--kind", "script", "--tick-hz", String(tickHz)];
  const workerBytecodeCommand = workerSource && workerBytecode && workerMetadata
    ? [pinnedTools.bytecode, "--input", workerSource, "--output", workerBytecode,
      "--metadata", workerMetadata, "--kind", "script", "--tick-hz", String(tickHz)]
    : undefined;
  const command = {
    wrapper: ["bun", "scripts/official_demos.ts", "build", `--apps=${demo.id}`],
    upstreamMountedEntry: upstreamBuildCommand,
    sdkPinnedQuickJsCompiler: bytecodeCommand,
    ...(workerBytecodeCommand ? { sdkPinnedQuickJsWorkerCompiler: workerBytecodeCommand } : {}),
    sourceEntry: demo.sourceEntry,
    ...(mounted.adaptation ? { sourceAdaptation: mounted.adaptation } : {}),
  };
  demo.build = { status: "running", command, startedAt: new Date().toISOString() };
  try {
    mkdirSync(outputAbsolute, { recursive: true });
    runCaptured(upstreamBuildCommand, upstreamRoot);
    if (!existsSync(generatedSource) || !existsSync(generatedPak)) {
      throw new Error(`Pinned mounted build did not produce ${outputName}.js and ${outputName}.pak`);
    }
    runCaptured(bytecodeCommand, sdkRoot);
    if (workerSource && workerBytecode && workerMetadata && workerBytecodeCommand) {
      if (!existsSync(workerSource)) {
        throw new Error(`Pinned mounted build declared domains.worker but did not produce ${outputName}.worker.js`);
      }
      runCaptured(workerBytecodeCommand, sdkRoot);
    }
    for (const path of [generatedSource, generatedPak, bytecode, metadata, ...(workerBytecode && workerMetadata ? [workerBytecode, workerMetadata] : [])]) {
      if (!existsSync(path) || statSync(path).size === 0) throw new Error(`Pinned build omitted or emptied artifact: ${path}`);
    }
    if (demo.workerDeclaration && workerBytecode && workerMetadata) {
      demo.worker = await makeWorkerDescriptor(demo.workerDeclaration, workerBytecode, workerMetadata);
      const appMetadata = readJson(metadata) ?? {};
      appMetadata.worker = demo.worker;
      saveJson(metadata, appMetadata);
      demo.workerQjbcPath = relativeSlash(outputRoot, workerBytecode);
      demo.workerMetadataPath = relativeSlash(outputRoot, workerMetadata);
    }
    demo.qjbcPath = relativeSlash(outputRoot, bytecode);
    demo.pakPath = relativeSlash(outputRoot, generatedPak);
    demo.metadataPath = relativeSlash(outputRoot, metadata);
    if (mounted.adaptation) demo.sourceAdaptation = mounted.adaptation;
    demo.guestManifestPath = relativeSlash(outputRoot, join(outputAbsolute, "guest-manifest.json"));
    saveJson(join(outputAbsolute, "guest-manifest.json"), officialGuestManifest(demo));
    demo.build = {
      status: "passed",
      command,
      startedAt: demo.build.startedAt,
      completedAt: new Date().toISOString(),
      sourceEntry: relativeSlash(upstreamRoot, entryAbsolute),
      upstreamBundlePath: relativeSlash(outputRoot, generatedSource),
      upstreamPakPath: relativeSlash(outputRoot, generatedPak),
      qjbcPath: demo.qjbcPath,
      pakPath: demo.pakPath,
      metadataPath: demo.metadataPath,
      ...(demo.workerQjbcPath ? { workerQjbcPath: demo.workerQjbcPath } : {}),
      ...(demo.workerMetadataPath ? { workerMetadataPath: demo.workerMetadataPath } : {}),
      guestManifestPath: demo.guestManifestPath,
      ...(demo.worker ? { worker: demo.worker } : {}),
      ...(demo.sourceAdaptation ? { sourceAdaptation: demo.sourceAdaptation } : {}),
      qjbcBytes: statSync(bytecode).size,
      pakBytes: statSync(generatedPak).size,
      tickHz,
      rasterDensity: density,
      sourceSha256: demo.sourceSha256,
    };
  } catch (error) {
    demo.build = {
      status: "failed",
      command,
      startedAt: demo.build.startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    demo.status = "build_failed";
    demo.statusReason = demo.build.error;
  } finally {
    mounted.cleanup();
  }
}

function workerBenchConfig(demo: Demo, tickHz: number): JsonObject {
  const worker = demo.worker;
  if (!worker) throw new Error(`Worker benchmark requested for ${demo.id} without a worker descriptor`);
  return {
    protocolVersion: worker.protocolVersion,
    nativeGeneration: 1,
    bindingGeneration: worker.bindingGeneration,
    tickHz: worker.tickHz ?? tickHz,
    expectedRuntimeAbi: worker.runtimeAbi,
    declaration: worker.declaration,
    policy: {
      requiredCapabilities: [...worker.requiredCaps].sort(),
      // This is the only network origin used by the pinned worker-http sample.
      // Keep it exact: a broad or implicit grant would make the benchmark
      // exercise a different host policy than the staged guest.
      allowedHttpOrigins: ["https://example.com"],
    },
    limits: {
      heapBytes: 16 * 1024 * 1024,
      stackBytes: 1024 * 1024,
      turnBudgetMicros: 10_000,
      windowMicros: 50_000,
      quotaMicros: 10_000,
    },
  };
}

function officialGuestManifest(demo: Demo): JsonObject {
  const missing = [
    ...(demo.hostCompatibility?.missingSessionCapabilities ?? []),
    ...(demo.hostCompatibility?.conditionalRequiredCapabilities ?? []),
  ].filter((value: unknown): value is string => typeof value === "string");
  const demoted = missing.filter((value: string) => value === "input.buttons" || value === "input.touch" || value === "input.pointer");
  const required = demo.requiredCapabilities.filter(capability => !demoted.includes(capability));
  const optional = [...new Set([...demo.enhancedCapabilities, ...demoted])]
    .filter(capability => !required.includes(capability)).sort();
  return {
    $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
    protocolVersion: 1,
    capabilities: { requires: [...new Set(required)].sort(), optional },
    permissions: { optional: [] },
    version: demo.version ?? "0.0.0",
    build: 1,
    ...(demo.workerDeclaration ? { domains: { worker: demo.workerDeclaration } } : {}),
    ...(demo.worker ? { worker: demo.worker } : {}),
    ...(demoted.length ? {
      hostAdaptation: {
        kind: "flutter_pointer_fallback",
        demotedRequirements: demoted,
        note: "The mounted official source keeps its physical-button handler and adds a Focusable pointer/touch control where needed.",
      },
    } : {}),
  };
}

function hydrateExistingWorker(demo: Demo, outputRoot: string): { missing?: string } {
  const metadataPath = absoluteArtifactPath(outputRoot, demo.metadataPath);
  const metadata = readJson(metadataPath);
  const descriptor = metadata?.worker;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return {};
  const artifact = descriptor.bytecode;
  const workerPath = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? artifact.path
    : undefined;
  if (typeof workerPath !== "string" || workerPath.startsWith("/") || workerPath.includes("\\") || workerPath.split("/").some((part: string) => !part || part === "." || part === "..")) {
    return { missing: `Invalid worker bytecode path in ${metadataPath}` };
  }
  const workerBytecode = resolve(dirname(metadataPath), workerPath);
  const workerDirectory = dirname(workerBytecode);
  const workerMetadata = join(workerDirectory, "app.worker.bytecode.json");
  if (!existsSync(workerBytecode)) return { missing: workerBytecode };
  if (!existsSync(workerMetadata)) return { missing: workerMetadata };
  demo.worker = descriptor as WorkerDescriptor;
  demo.workerDeclaration = demo.worker.declaration;
  demo.workerQjbcPath = relativeSlash(outputRoot, workerBytecode);
  demo.workerMetadataPath = relativeSlash(outputRoot, workerMetadata);
  const manifestPath = join(workerDirectory, "guest-manifest.json");
  if (existsSync(manifestPath)) demo.guestManifestPath = relativeSlash(outputRoot, manifestPath);
  return {};
}

function hydrateExistingPak(demo: Demo, outputRoot: string): string | undefined {
  const expected = absoluteArtifactPath(outputRoot, demo.pakPath);
  if (existsSync(expected)) return expected;
  const directory = dirname(expected);
  if (!existsSync(directory)) return undefined;
  const candidates = readdirSync(directory)
    .filter(name => name.endsWith(".pak"))
    .map(name => join(directory, name));
  if (candidates.length !== 1) return undefined;
  demo.pakPath = relativeSlash(outputRoot, candidates[0]!);
  return candidates[0]!;
}

function benchArgs(
  demo: Demo,
  outputRoot: string,
  frames: number,
  warmup: number,
  tickHz: number,
  density: number,
  workerConfigPath?: string,
): string[] {
  const viewport = demo.viewport ?? { width: 390, height: 844 };
  const args = [
    "--bytecode", absoluteArtifactPath(outputRoot, demo.qjbcPath),
    "--pak", absoluteArtifactPath(outputRoot, demo.pakPath),
    "--frames", String(frames), "--warmup", String(warmup),
    "--width", String(viewport.width), "--height", String(viewport.height),
    "--raster-density", String(density), "--tick-hz", String(tickHz),
  ];
  if (demo.workerQjbcPath) {
    if (!workerConfigPath) throw new Error(`Worker benchmark config is missing for ${demo.id}`);
    args.push("--worker-bytecode", absoluteArtifactPath(outputRoot, demo.workerQjbcPath), "--worker-config", workerConfigPath);
  }
  return args;
}

function runNativeBench(demo: Demo, outputRoot: string, frames: number, warmup: number, tickHz: number, density: number, benchBuild: JsonObject): void {
  const executable = process.platform === "win32" ? `${pocketBenchBinary}.exe` : pocketBenchBinary;
  const workerConfigPath = demo.worker
    ? absoluteArtifactPath(outputRoot, `demos/${demo.id}/worker-config.json`)
    : undefined;
  if (demo.worker && workerConfigPath) {
    saveJson(workerConfigPath, workerBenchConfig(demo, tickHz));
    demo.workerConfigPath = relativeSlash(outputRoot, workerConfigPath);
  }
  const command = [executable, ...benchArgs(demo, outputRoot, frames, warmup, tickHz, density, workerConfigPath)];
  demo.nativeBenchmark = { status: "running", command, startedAt: new Date().toISOString() };
  if (demo.build?.status !== "passed") {
    demo.nativeBenchmark = { status: "skipped", reason: "build_failed", command, completedAt: new Date().toISOString() };
    return;
  }
  if (benchBuild.status !== "passed") {
    demo.status = "runtime_failed";
    demo.statusReason = `pocket_bench build failed: ${benchBuild.error ?? "unknown error"}`;
    demo.nativeBenchmark = { status: "failed", command: benchBuild.command, build: benchBuild, error: demo.statusReason, completedAt: new Date().toISOString() };
    return;
  }
  try {
    const result = runCaptured(command, sdkRoot);
    const parsed = JSON.parse(result.stdout) as JsonObject;
    demo.status = "passed";
    demo.statusReason = demo.worker
      ? "Build and worker-aware native benchmark passed; the Worker realm was attached before UI evaluation. This does not assert Flutter Session admission, an HTTP request result, or device FPS."
      : "Build and raw native benchmark passed; this does not assert Flutter Session admission or device FPS.";
    const benchmarkFile = absoluteArtifactPath(outputRoot, `demos/${demo.id}/native-benchmark.json`);
    saveJson(benchmarkFile, parsed);
    demo.nativeBenchmark = {
      status: "passed",
      command,
      startedAt: demo.nativeBenchmark.startedAt,
      completedAt: new Date().toISOString(),
      outputPath: relativeSlash(outputRoot, benchmarkFile),
      ...(demo.worker ? {
        workerAware: true,
        workerConfigPath: demo.workerConfigPath,
        httpRequestExercised: false,
        fpsMeasured: true,
      } : {}),
      result: parsed,
    };
  } catch (error) {
    demo.statusReason = error instanceof Error ? error.message : String(error);
    const capabilityLimited = demo.requiredCapabilities.some(capability =>
      RAW_BENCH_NOT_EXERCISED.has(capability)
        && demo.statusReason!.toLowerCase().includes(capability.toLowerCase()),
    );
    // A raw runtime failure is platform_limited only when its diagnostic names
    // a required capability this benchmark cannot provide. Other runtime
    // failures remain visible as runtime_failed.
    demo.status = capabilityLimited ? "platform_limited" : "runtime_failed";
    demo.nativeBenchmark = {
      status: "failed",
      command,
      startedAt: demo.nativeBenchmark.startedAt,
      completedAt: new Date().toISOString(),
      error: demo.statusReason,
      ...(capabilityLimited ? { platformLimitation: "The native benchmark cannot provide the required capability named by the runtime diagnostic." } : {}),
    };
  }
}

function selectDemos(all: Demo[], requested: string[] | null): Demo[] {
  if (!requested) return all;
  const byId = new Map(all.map(demo => [demo.id, demo]));
  const missing = requested.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Unknown official demo ID(s): ${missing.join(", ")}`);
  return requested.map(id => byId.get(id)!);
}

function catalogFor(demos: Demo[], session: ReturnType<typeof readSessionCapabilityState>): JsonObject {
  const applications = demos.map(demo => ({
    ...demo,
    ...classifyOfficialDemoLaunchability(demo),
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      repository: "pocket-nexus/pocketjs",
      cachePath: relativeSlash(repositoryRoot, upstreamRoot),
      revision: UPSTREAM_REVISION,
      revisionMarkerPath: relativeSlash(repositoryRoot, join(upstreamRoot, ".pocketjs-revision")),
      provenance: "sdk/scripts/prepare_upstream.py pins the archive revision and reproducible patches; official sources are compiled in place without copying them.",
    },
    hostCompatibilitySource: relativeSlash(repositoryRoot, pocketSessionSource),
    defaultSessionCapabilities: session.defaults,
    conditionallyAvailableSessionCapabilities: session.conditional,
    demos: applications,
  };
}

function reportFor(demos: Demo[], config: ReturnType<typeof parseArgs>, session: ReturnType<typeof readSessionCapabilityState>): JsonObject {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    sourceRevision: UPSTREAM_REVISION,
    artifactRoot: relativeSlash(repositoryRoot, config.outputRoot),
    benchmarkConfig: { frames: config.frames, warmup: config.warmup, tickHz: config.tickHz, rasterDensity: config.density },
    hostCompatibilitySource: relativeSlash(repositoryRoot, pocketSessionSource),
    defaultSessionCapabilities: session.defaults,
    conditionallyAvailableSessionCapabilities: session.conditional,
    summary: Object.fromEntries(["passed", "build_failed", "runtime_failed", "platform_limited"].map(status => [status, demos.filter(demo => demo.status === status).length])),
    demos,
  };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  config.outputRoot = resolve(config.outputRoot);
  const session = readSessionCapabilityState();
  const discovered = selectDemos(discover(config.outputRoot), config.apps);
  mkdirSync(config.outputRoot, { recursive: true });
  const demos = discovered.map(demo => ({ ...demo, hostCompatibility: hostCompatibility(demo, session) }));
  console.log(`official_demos: ${config.mode}, ${demos.length} app(s), upstream ${UPSTREAM_REVISION}`);
  console.log(`official_demos: artifacts=${config.outputRoot}`);

  if (config.mode !== "benchmark") {
    for (const demo of demos) {
      console.log(`official_demos: build ${demo.id} (${demo.sourceEntry})`);
      await buildDemo(demo, config.outputRoot, config.tickHz, config.density);
      if (demo.build?.status === "failed") console.error(`official_demos: build failed ${demo.id}: ${demo.build.error}`);
    }
  } else {
    for (const demo of demos) {
      const qjbc = absoluteArtifactPath(config.outputRoot, demo.qjbcPath);
      const pak = hydrateExistingPak(demo, config.outputRoot);
      const worker = hydrateExistingWorker(demo, config.outputRoot);
      const missing = worker.missing
        ?? (demo.workerDeclaration && !demo.worker ? `Worker descriptor is missing from ${absoluteArtifactPath(config.outputRoot, demo.metadataPath)}` : undefined)
        ?? (!existsSync(qjbc) ? qjbc : !pak ? absoluteArtifactPath(config.outputRoot, demo.pakPath) : undefined);
      if (missing) {
        demo.status = "build_failed";
        demo.statusReason = `Existing benchmark artifacts are missing: ${missing}`;
        demo.build = { status: "missing_artifacts", qjbcPath: demo.qjbcPath, pakPath: demo.pakPath, ...(demo.workerQjbcPath ? { workerQjbcPath: demo.workerQjbcPath } : {}) };
      } else {
        demo.build = {
          status: "passed",
          reusedArtifacts: true,
          qjbcBytes: statSync(qjbc).size,
          pakBytes: statSync(pak).size,
          ...(demo.workerQjbcPath ? { workerQjbcPath: demo.workerQjbcPath, workerMetadataPath: demo.workerMetadataPath } : {}),
        };
      }
    }
  }

  let benchBuild: JsonObject = { status: "not_run" };
  if (config.mode !== "build") {
    const command = ["cargo", "build", "--locked", "--release", "--manifest-path", pocketBenchManifest, "--bin", "pocket_bench"];
    try {
      runCaptured(command, sdkRoot);
      benchBuild = { status: "passed", command, binary: relativeSlash(repositoryRoot, pocketBenchBinary), completedAt: new Date().toISOString() };
    } catch (error) {
      benchBuild = { status: "failed", command, error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() };
      console.error("official_demos: pocket_bench build failed; recording failure for the full benchmark sweep");
    }
    for (const demo of demos) {
      console.log(`official_demos: native benchmark ${demo.id}`);
      runNativeBench(demo, config.outputRoot, config.frames, config.warmup, config.tickHz, config.density, benchBuild);
      console.log(`official_demos: ${demo.id} => ${demo.status}`);
    }
  }

  const catalog = catalogFor(demos, session);
  const report = reportFor(demos, config, session);
  report.pocketBenchBuild = benchBuild;
  if (config.mode !== "build") {
    saveJson(join(config.outputRoot, "catalog.json"), catalog);
    saveJson(join(config.outputRoot, "report.json"), report);
    console.log(`official_demos: catalog=${join(config.outputRoot, "catalog.json")}`);
    console.log(`official_demos: report=${join(config.outputRoot, "report.json")}`);
  } else {
    saveJson(join(config.outputRoot, "build-report.json"), report);
    console.log(`official_demos: build report=${join(config.outputRoot, "build-report.json")}`);
  }
  const failed = demos.some(demo => demo.status === "build_failed" || demo.status === "runtime_failed");
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`official_demos: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
