import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolvePrebuiltTools } from "./prebuilt_tools.mjs";

/**
 * The native cache invalidation inputs used by pocket.ts prepareNative.
 *
 * Keep this list explicit. In particular, never walk native/target: build
 * outputs are candidates, not inputs that can make another candidate fresh.
 */
const nativeInputPaths = [
  "native/src",
  "native/Cargo.toml",
  "native/build.rs",
  "native/Cargo.lock",
  "native/patches",
  "scripts/build_native.sh",
  "scripts/prepare_upstream.py",
  ".cache/pocketjs/.pocketjs-revision",
  ".cache/pocketjs/Cargo.lock",
  ".cache/pocketjs/bun.lock",
  ".cache/pocketjs/package.json",
] as const;

export type NativeProbeSelectionOptions = {
  /** Existing explicit override. It is intentionally trusted when present. */
  configuredPath?: string;
  /** Candidate binaries to inspect when no explicit override is supplied. */
  candidates: readonly string[];
  /** Native source files/directories used for the freshness lower bound. */
  sourceInputs: readonly string[];
};

type NativeInput = {
  path: string;
  mtimeMs: number;
};

type Candidate = {
  path: string;
  mtimeMs: number;
  order: number;
};

function tryStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Expand a source input into regular files without following symlinks.
 * Skipping a directory named target is deliberate defence in depth for
 * callers that pass a broad native source directory in a test fixture.
 */
function collectNativeInputs(path: string, output: NativeInput[]): void {
  const info = tryStat(path);
  if (!info || info.isSymbolicLink()) return;
  if (info.isFile()) {
    output.push({ path, mtimeMs: info.mtimeMs });
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "target") continue;
    collectNativeInputs(join(path, entry.name), output);
  }
}

function collectSourceInputs(sourceInputs: readonly string[]): NativeInput[] {
  const inputs: NativeInput[] = [];
  for (const source of sourceInputs) collectNativeInputs(resolve(source), inputs);
  return inputs;
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sourceDescription(path: string): string {
  const cwdRelative = relative(process.cwd(), path);
  return cwdRelative && !cwdRelative.startsWith("..") ? cwdRelative : path;
}

/**
 * Select a bytecode-capable native probe.
 *
 * The default path is a conservative timestamp guard: a candidate must be at
 * least as new as every tracked native input. This is intentionally not a
 * content-identity claim; callers that need a specific build can use the
 * explicit POCKET_NATIVE_PROBE override. No build or rebuild is attempted.
 */
export function selectNativeProbe(options: NativeProbeSelectionOptions): string {
  const configured = options.configuredPath?.trim();
  if (configured) {
    const path = resolve(configured);
    if (!regularFile(path)) {
      throw new Error(
        `POCKET_NATIVE_PROBE points to a missing or non-file probe: ${path}; ` +
        "build pocket_probe or unset POCKET_NATIVE_PROBE to use default selection",
      );
    }
    return path;
  }

  const inputs = collectSourceInputs(options.sourceInputs);
  if (inputs.length === 0) {
    throw new Error(
      "native pocket_probe freshness check found no tracked native inputs; " +
      "refusing to select a probe without native/src and Cargo.lock",
    );
  }
  const newestInput = inputs.reduce((latest, input) =>
    input.mtimeMs > latest.mtimeMs ? input : latest,
  );

  const existing: Candidate[] = [];
  const status: string[] = [];
  for (const [order, candidatePath] of options.candidates.entries()) {
    const path = resolve(candidatePath);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      status.push(`${path} (missing)`);
      continue;
    }
    if (!info.isFile()) {
      status.push(`${path} (not a regular file)`);
      continue;
    }
    if (info.mtimeMs < newestInput.mtimeMs) {
      status.push(`${path} (older than ${sourceDescription(newestInput.path)})`);
      continue;
    }
    existing.push({ path, mtimeMs: info.mtimeMs, order });
    status.push(`${path} (fresh)`);
  }

  if (existing.length > 0) {
    existing.sort((left, right) => right.mtimeMs - left.mtimeMs || left.order - right.order);
    return existing[0].path;
  }

  throw new Error(
    "No fresh default pocket_probe was found. Candidates must be at least as " +
    `new as every tracked native input (newest: ${sourceDescription(newestInput.path)}). ` +
    `Checked: ${status.join(", ") || "no candidates"}. ` +
    "Build pocket_probe once, or set POCKET_NATIVE_PROBE to an existing explicit probe; " +
    "tests never rebuild it automatically.",
  );
}

/** Return the same native input roots used by the SDK native build cache. */
export function nativeProbeSourceInputs(sdkRoot: string): string[] {
  const root = resolve(sdkRoot);
  return nativeInputPaths.map((path) => join(root, path));
}

/** Return known local probe locations, without scanning target directories. */
export function nativeProbeCandidates(sdkRoot: string): string[] {
  const root = resolve(sdkRoot);
  return [
    join(root, "native/target/debug/pocket_probe"),
    join(root, "native/target/release/pocket_probe"),
    join(root, "native/target/debug/pocket_probe.exe"),
    join(root, "native/target/release/pocket_probe.exe"),
    join(root, "native/target/x86_64-pc-windows-msvc/debug/pocket_probe.exe"),
    join(root, "native/target/x86_64-pc-windows-msvc/release/pocket_probe.exe"),
    join(root, "native/target/aarch64-pc-windows-msvc/debug/pocket_probe.exe"),
    join(root, "native/target/aarch64-pc-windows-msvc/release/pocket_probe.exe"),
    join(root, "native/target/aarch64-apple-darwin/debug/pocket_probe"),
    join(root, "native/target/aarch64-apple-darwin/release/pocket_probe"),
  ];
}

/** Resolve the shared Editor/test probe, optionally honoring an explicit build. */
export function resolveNativeProbePath(sdkRoot: string, configuredPath = process.env.POCKET_NATIVE_PROBE): string {
  if (!configuredPath && process.env.POCKET_SOURCE_BUILD !== "1") return resolvePrebuiltTools(sdkRoot).probe;
  return selectNativeProbe({
    configuredPath,
    candidates: nativeProbeCandidates(sdkRoot),
    sourceInputs: nativeProbeSourceInputs(sdkRoot),
  });
}
