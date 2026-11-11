/**
 * Pocket Studio's real web preview bridge.
 *
 * The browser is a Canvas2D/optical-shader projection. Guest source is
 * built by the ordinary Editor pipeline and executed by the pinned native
 * PocketJS runtime (`pocket_probe`).  The probe returns the same FrameResult
 * DrawOps/resources used by the Flutter host; no screenshot or second layout
 * engine is involved here.
 *
 * HTTP integration is intentionally opt-in.  `startEditor` owns the listener;
 * an embedding server can route its preview URL to `manager.handle(request,
 * projectId)`.  The manager itself never opens another port.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveNativeProbePath } from "../scripts/native_probe_path.ts";
import { servePreviewMedia } from "./preview_media_assets.ts";
import type { LocalBluetoothProvider } from "./local_bluetooth.ts";
import { hotCommandSource, hotIdentity, type HotIdentity } from "./hot_reload.ts";
import { createPreviewLive2d } from "./live2d.ts";
import { encodeMessage } from "../targets/wechat/template/binary-bridge.js";
import type { DiagnosticsCollector } from "../packages/pocket_diagnostics/src/types.ts";

export type PreviewArtifactPaths = {
  /** Absolute path to the current Editor qjbc artifact. */
  bytecodePath?: string;
  /** BuildOutput-compatible alias for bytecodePath. */
  bytecode?: string;
  /** Absolute path to the current Editor PAK artifact. */
  pakPath?: string;
  /** BuildOutput-compatible alias for pakPath. */
  pak?: string;
  /** Absolute path to a diagnostic JS artifact (used only when qjbc is absent). */
  sourcePath?: string;
  /** BuildOutput-compatible alias for sourcePath. */
  appJs?: string;
  metadataPath?: string;
  /** BuildOutput-compatible alias for metadataPath. */
  metadata?: string;
  /** Optional independent Worker QJBC artifact. When omitted, preview derives
   * app.worker.qjbc beside the UI artifact and reads the worker descriptor
   * from app.bytecode.json/guest-manifest.json. */
  workerBytecodePath?: string;
  /** BuildOutput-compatible alias for workerBytecodePath. */
  workerBytecode?: string;
  /** Optional compiler metadata for the Worker QJBC. The signed descriptor
   * itself still comes from the UI metadata/guest manifest. */
  workerMetadataPath?: string;
  /** BuildOutput-compatible alias for workerMetadataPath. */
  workerMetadata?: string;
  /** Explicit worker descriptor for embedders whose metadata is not colocated
   * with the staged artifacts. Package admission remains the caller's trust
   * boundary; native still validates the QJBC envelope and policy shape. */
  workerDescriptor?: Record<string, unknown>;
  /** Exact HTTP(S) origins granted by the preview host for this artifact. */
  workerHttpOrigins?: string[];
  /** Trusted System catalog package-to-surface handles, or derive from pocket.system.json. */
  compositorSurfaces?: Record<string, number>;
  /** Trusted installed child guest artifacts, keyed by catalog package ID. */
  applications?: Record<string, PreviewArtifactPaths>;
  /** Optional package identity for an installed child artifact. */
  appId?: string;
  /** Source directory used for loose preview media (for a child app). */
  projectDirectory?: string;
  revision?: number;
  /** Completed-build identity; callers keep it unchanged while building. */
  generation?: string | number;
  tickHz?: number;
};

export type PreviewProject = PreviewArtifactPaths & {
  /** Optional project root, retained for host diagnostics and integrations. */
  projectDirectory?: string;
};

type ResolvedPreviewProject = PreviewProject & {
  /** Validated size/mtime identity used when no completed-build token exists. */
  artifactFingerprint?: string;
  worker?: ResolvedPreviewWorker;
};

type ResolvedPreviewWorker = {
  bytecodePath: string;
  descriptor: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type PreviewResolver<T> = T | ((projectId: string) => T | Promise<T>);

export type PreviewManagerOptions = {
  /** Optional durable collector owned by the embedding host. */
  diagnostics?: Pick<DiagnosticsCollector, "recordLog" | "recordCrash">;
  /** Resolve the project directory used by the caller's Editor state. */
  projectDirectory?: PreviewResolver<string>;
  /** Resolve real artifact paths. `artifact` is an accepted singular alias. */
  artifacts?: PreviewResolver<PreviewArtifactPaths>;
  artifact?: PreviewResolver<PreviewArtifactPaths>;
  /** Override the discovered native probe, primarily for tests/CI. */
  probePath?: string;
  width?: number;
  height?: number;
  /** Logical safe-area insets for the root preview viewport. */
  safeArea?: Partial<PreviewSafeArea>;
  rasterDensity?: number;
  tickHz?: number;
  /** Exact HTTP(S) origins granted to Worker HTTP nodes in preview. Empty
   * (the default) denies every network destination. */
  workerHttpOrigins?: PreviewResolver<readonly string[]>;
  commandTimeoutMs?: number;
  /** Bound retained project sessions; idle sessions are evicted first. */
  maxSessions?: number;
  /** Release an idle native probe after the last SSE client disconnects. */
  idleDisposeMs?: number;
  /** Override the checked-in browser projection file for an embedding build. */
  clientPath?: string;
  /** Explicit local native IO provider; never enabled by merely opening preview. */
  localBluetooth?: LocalBluetoothProvider;
};

/** Safe-area coordinates are in the same logical pixels as a PreviewFrame. */
export type PreviewSafeArea = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type PreviewFrame = {
  frame: number;
  width: number;
  height: number;
  /**
   * The focused native child surface's input rectangle in root coordinates.
   * This is emitted by the compositor adapter only when that child exists;
   * the browser uses it to keep synthetic wheel contacts inside the child's
   * accepted coordinate range.
   */
  inputBounds?: { x: number; y: number; w: number; h: number };
  /** Browser acknowledges these after decoding and painting the prepared child. */
  presentationTokens?: string[];
  ops: Array<Record<string, unknown>>;
  auxiliary?: { width: number; height: number; ops: Array<Record<string, unknown>> };
  events: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  releasedResources?: string[];
};

export type PreviewStatus = {
  projectId: string;
  state: "starting" | "ready" | "error" | "stopped";
  revision?: number;
  width: number;
  height: number;
  tickHz: number;
  nextWakeDelayMs: number | null;
  lastFrame: number | null;
  /** The native probe currently emits full FrameResult JSON on every tick. */
  transport: "native-probe-full-frames";
  /** Capabilities intentionally not emulated by this Canvas2D projection. */
  unsupported: string[];
  error?: string;
  hotReload?: { mode: "replace" | "reload"; reason?: string };
};

type JsonRecord = Record<string, unknown>;
type PreviewAccessibilityPreferences = {
  reduceMotion: boolean;
  increaseContrast: boolean;
  textScale: number;
  accessibleNavigation: boolean;
  /** null means that the browser/host cannot observe this preference. */
  reduceTransparency: boolean | null;
};

const accessibilityPreferencesEvent = "accessibility.preferences";
const accessibilitySnapshotEvent = "accessibility.snapshot";
const accessibilityActionEvent = "accessibility.action";
const maxAccessibilityControls = 128;
const maxAccessibilityLabelLength = 1024;
const EMPTY_PREVIEW_SAFE_AREA: PreviewSafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxInputBytes = 64 * 1024;
const maxFrameBytes = 64 * 1024 * 1024;
// A native response's UTF-8 size bounds the size of its nested frame. Keep
// that fact at the parse boundary instead of serializing texture arrays a
// second time merely to check the same limit. Oversized envelopes and frames
// constructed by tooling still take the exact frame-only check below.
const nativeFrameWireBytes = new WeakMap<object, number>();
const maxBrowserPluginPending = 64;
// A hot replacement can publish one old generation's cleanup edges together
// with the next generation's media state. The SDK permits 128 media entries,
// so 512 leaves room for both generations (including text-input cleanup)
// while remaining a hard, finite bound for a malformed guest.
const maxPendingBrowserEvents = 512;
const browserPluginTimeoutMs = 120_000;
const previewRecordingMaxEntries = 8192;
const previewRecordingMaxBytes = 8 * 1024 * 1024;
const previewRecordingMaxAssets = 128 * 1024 * 1024;
// Keep the web archive within PocketRecordingLibrary's canonical runtime
// bound. A destroyed/recreated child consumes a new capture identity.
const previewRecordingMaxRuntimes = 8;

/** Frame elapsed time must not jump when wall-clock time is adjusted. */
function monotonicNow(): number {
  return performance.now();
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function failure(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function finitePositive(value: unknown, label: string, maximum = 32000): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > maximum) throw new Error(`${label} must be a finite number in (0, ${maximum}]`);
  return number;
}

function finiteNonNegative(value: unknown, label: string, maximum = 1024): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error(`${label} must be a finite number in [0, ${maximum}]`);
  return number;
}

function parseAccessibilityPreferences(value: unknown): PreviewAccessibilityPreferences {
  const record = asRecord(value, "accessibility preferences");
  const booleanField = (name: keyof Pick<PreviewAccessibilityPreferences, "reduceMotion" | "increaseContrast" | "accessibleNavigation">): boolean => {
    if (typeof record[name] !== "boolean") throw new Error(`accessibility preferences ${name} must be boolean`);
    return record[name] as boolean;
  };
  const textScale = Number(record.textScale);
  if (!Number.isFinite(textScale) || textScale < 0.1 || textScale > 8) {
    throw new Error("accessibility preferences textScale must be finite in [0.1, 8]");
  }
  const reduceTransparency = record.reduceTransparency;
  if (reduceTransparency !== null && typeof reduceTransparency !== "boolean") {
    throw new Error("accessibility preferences reduceTransparency must be boolean or null");
  }
  return {
    reduceMotion: booleanField("reduceMotion"),
    increaseContrast: booleanField("increaseContrast"),
    textScale,
    accessibleNavigation: booleanField("accessibleNavigation"),
    reduceTransparency,
  };
}

type PreviewAccessibilityRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PreviewAccessibilityControl = {
  guestId: string;
  nativeId: number;
  label: string;
  role: "button" | "tab";
  selected: boolean;
  disabled: boolean;
  enabled: boolean;
  checked?: boolean;
  rect: PreviewAccessibilityRect;
};

type PreviewAccessibilitySnapshot = {
  generation: number;
  controls: PreviewAccessibilityControl[];
};

function isAccessibilitySnapshotEvent(event: JsonRecord): boolean {
  return eventName(event) === accessibilitySnapshotEvent;
}

function parseAccessibilityRect(value: unknown): PreviewAccessibilityRect | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as JsonRecord;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width ?? record.w);
  const height = Number(record.height ?? record.h);
  if (![x, y, width, height].every(Number.isFinite) ||
      Math.abs(x) > 32000 || Math.abs(y) > 32000 || width <= 0 || height <= 0 || width > 32000 || height > 32000) {
    return undefined;
  }
  return { x, y, width, height };
}

function parseAccessibilitySnapshot(event: JsonRecord): PreviewAccessibilitySnapshot | undefined {
  if (!isAccessibilitySnapshotEvent(event)) return undefined;
  const payload = eventPayload(event);
  if (!payload) return undefined;
  const generation = Number(payload.generation);
  const rawControls = payload.controls ?? payload.nodes;
  if (!Number.isInteger(generation) || generation < 0 || generation > 0x7fffffff || !Array.isArray(rawControls)) return undefined;
  const controls: PreviewAccessibilityControl[] = [];
  const seen = new Set<string>();
  for (const raw of rawControls) {
    if (controls.length >= maxAccessibilityControls || !raw || typeof raw !== "object" || Array.isArray(raw)) break;
    const record = raw as JsonRecord;
    const guestId = typeof record.guestId === "string" ? record.guestId : typeof record.id === "string" ? record.id : "";
    const label = typeof record.label === "string" ? record.label : undefined;
    const nativeId = Number(record.nativeId);
    const role = record.role === "tab" ? "tab" : record.role === "button" ? "button" : undefined;
    const rect = parseAccessibilityRect(record.rect);
    if (!guestId || guestId.length > 256 || seen.has(guestId) || label === undefined ||
        !Number.isInteger(nativeId) || nativeId < 0 || nativeId > 0x7fffffff || !role || !rect) continue;
    seen.add(guestId);
    const disabled = record.disabled === true;
    const enabled = record.enabled !== false && !disabled;
    controls.push({
      guestId,
      nativeId,
      label: label.slice(0, maxAccessibilityLabelLength),
      role,
      selected: record.selected === true,
      disabled,
      enabled,
      ...(typeof record.checked === "boolean" ? { checked: record.checked } : {}),
      rect,
    });
  }
  return { generation, controls };
}

function canonicalAccessibilitySnapshotEvent(snapshot: PreviewAccessibilitySnapshot): JsonRecord {
  return {
    name: accessibilitySnapshotEvent,
    payload: {
      generation: snapshot.generation,
      controls: snapshot.controls.map((control) => ({
        guestId: control.guestId,
        nativeId: control.nativeId,
        label: control.label,
        role: control.role,
        selected: control.selected,
        disabled: control.disabled,
        enabled: control.enabled,
        ...(control.checked === undefined ? {} : { checked: control.checked }),
        rect: { ...control.rect },
      })),
    },
  };
}

function parseAccessibilityAction(input: JsonRecord): {
  action: "activate";
  guestId: string;
  nativeId: number;
  generation: number;
  runtime?: string;
  runtimeToken?: string;
} {
  if (input.action !== "activate") throw new Error("semantic action must be activate");
  const guestId = typeof input.guestId === "string" ? input.guestId : "";
  if (!guestId || guestId.length > 256) throw new Error("semantic action guestId is invalid");
  const nativeId = integerIn(input.nativeId, "semantic action nativeId", 0, 0x7fffffff);
  const generation = integerIn(input.generation, "semantic action generation", 0, 0x7fffffff);
  const runtime = input.runtime === undefined ? undefined : typeof input.runtime === "string" && input.runtime ? input.runtime : (() => { throw new Error("semantic action runtime is invalid"); })();
  const runtimeToken = input.runtimeToken === undefined ? undefined : typeof input.runtimeToken === "string" && input.runtimeToken ? input.runtimeToken : (() => { throw new Error("semantic action runtimeToken is invalid"); })();
  return { action: "activate", guestId, nativeId, generation, ...(runtime ? { runtime } : {}), ...(runtimeToken ? { runtimeToken } : {}) };
}

function normalizeSafeArea(value: unknown, fallback: PreviewSafeArea = EMPTY_PREVIEW_SAFE_AREA): PreviewSafeArea {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const record = value as Record<string, unknown>;
  const inset = (key: keyof PreviewSafeArea): number => {
    const number = Number(record[key]);
    return Number.isFinite(number) && number >= 0 ? Math.min(32000, number) : fallback[key];
  };
  return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
}

function sameSafeArea(left: PreviewSafeArea, right: PreviewSafeArea): boolean {
  return left.top === right.top && left.right === right.right &&
    left.bottom === right.bottom && left.left === right.left;
}

function boundedSafeArea(area: PreviewSafeArea, width: number, height: number): PreviewSafeArea {
  return {
    top: Math.min(Math.max(0, area.top), height),
    right: Math.min(Math.max(0, area.right), width),
    bottom: Math.min(Math.max(0, area.bottom), height),
    left: Math.min(Math.max(0, area.left), width),
  };
}

function surfaceSafeArea(
  slot: SurfaceSlot | undefined,
  rootWidth: number,
  rootHeight: number,
  rootArea: PreviewSafeArea,
): PreviewSafeArea {
  const area = boundedSafeArea(rootArea, rootWidth, rootHeight);
  if (!slot || slot.w <= 0 || slot.h <= 0) return area;
  // A slot already clipped below/inside the root safe rectangle receives no
  // duplicate padding. A slot spanning the full root inherits every inset.
  const topEdge = Math.max(0, Math.min(slot.h, area.top - slot.y));
  const leftEdge = Math.max(0, Math.min(slot.w, area.left - slot.x));
  const bottomBoundary = rootHeight - area.bottom;
  const rightBoundary = rootWidth - area.right;
  const bottomEdge = Math.max(0, Math.min(slot.h, slot.y + slot.h - Math.max(slot.y, bottomBoundary)));
  const rightEdge = Math.max(0, Math.min(slot.w, slot.x + slot.w - Math.max(slot.x, rightBoundary)));
  return { top: topEdge, right: rightEdge, bottom: bottomEdge, left: leftEdge };
}

async function sendDisplayViewport(
  probe: NativeProbe,
  width: number,
  height: number,
  safeArea: PreviewSafeArea,
): Promise<void> {
  await probe.checked({
    op: "send",
    message: {
      method: "display.viewport",
      params: { width, height, safeArea: boundedSafeArea(safeArea, width, height) },
    },
  });
}

function integerIn(value: unknown, label: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  return number;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function asFrame(value: unknown): PreviewFrame {
  const record = asRecord(value, "native frame");
  if (typeof record.frame !== "number" || typeof record.width !== "number" || typeof record.height !== "number") {
    throw new Error("native frame is missing frame/width/height");
  }
  if (!Array.isArray(record.ops) || !Array.isArray(record.events) || !Array.isArray(record.resources)) {
    throw new Error("native frame has an invalid DrawOps/resources shape");
  }
  return record as unknown as PreviewFrame;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableInputFailure(message: string): boolean {
  return message.startsWith("pointer ") ||
    message.startsWith("pointer phase") ||
    message.startsWith("pointer id") ||
    message.startsWith("pointer x") ||
    message.startsWith("pointer y") ||
    message.startsWith("text ") ||
    message.startsWith("unsupported text event") ||
    message.includes("textInput") ||
    message.startsWith("preview input type") ||
    message.startsWith("accessibility preferences") ||
    message.startsWith("semantic action") ||
    message.includes("input.pointer") ||
    message.includes("input.text") ||
    message.startsWith("Noble Bluetooth adapter");
}

function resolveValue<T>(value: PreviewResolver<T> | undefined, projectId: string): Promise<T | undefined> {
  if (value === undefined) return Promise.resolve(undefined);
  return Promise.resolve(typeof value === "function" ? (value as (id: string) => T | Promise<T>)(projectId) : value);
}

function existingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function workerInteger(value: unknown, label: string, minimum = 1, maximum = 0xffffffff): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`preview worker ${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return number;
}

function workerString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`preview worker ${label} must be a non-empty string`);
  }
  return value;
}

function workerStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`preview worker ${label} must be a string array`);
  }
  const result = value.map((item) => String(item));
  if (new Set(result).size !== result.length) throw new Error(`preview worker ${label} must not contain duplicates`);
  return result;
}

async function readJsonObjectFile(path: string, label: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return asRecord(JSON.parse(await readFile(path, "utf8")), label);
  } catch (error) {
    throw new Error(`preview: invalid ${label}: ${errorText(error)}`);
  }
}

/**
 * Resolve the signed worker descriptor and sibling QJBC used by one preview
 * runtime. The descriptor is read from the same app.bytecode.json/guest-
 * manifest files consumed by Flutter; this adapter does not compile or
 * interpret Worker source in the Editor process.
 */
async function resolvePreviewWorker(
  project: PreviewProject,
  origins: readonly string[],
): Promise<ResolvedPreviewWorker | undefined> {
  const uiBytecode = project.bytecodePath ?? project.bytecode;
  const uiMetadata = project.metadataPath ?? project.metadata;
  const artifactDirectory = uiBytecode ? dirname(resolve(uiBytecode)) : undefined;
  const projectDirectory = project.projectDirectory;
  const descriptorFromMetadata = uiMetadata
    ? (await readJsonObjectFile(uiMetadata, "app.bytecode.json"))?.worker
    : undefined;
  const manifestCandidates = [
    ...(projectDirectory ? [join(projectDirectory, "guest-manifest.json")] : []),
    ...(artifactDirectory ? [join(artifactDirectory, "guest-manifest.json")] : []),
  ];
  let manifest: Record<string, unknown> | undefined;
  let descriptor: unknown = project.workerDescriptor ?? descriptorFromMetadata;
  for (const path of manifestCandidates) {
    const candidate = await readJsonObjectFile(path, "guest-manifest.json");
    if (!manifest && candidate) manifest = candidate;
    if (descriptor === undefined && candidate?.worker !== undefined) {
      descriptor = candidate.worker;
      break;
    }
  }
  const workerBytecode = project.workerBytecodePath ?? project.workerBytecode ?? existingPath([
    ...(artifactDirectory ? [join(artifactDirectory, "app.worker.qjbc")] : []),
    ...(projectDirectory ? [join(projectDirectory, "app.worker.qjbc")] : []),
  ]);
  if (descriptor === undefined) {
    if (workerBytecode) throw new Error("preview worker bytecode exists without a signed worker descriptor");
    return undefined;
  }
  if (!workerBytecode) throw new Error("preview worker descriptor exists but app.worker.qjbc is missing");
  const raw = asRecord(descriptor, "worker descriptor");
  if (raw.kind !== "quickjs-bytecode") throw new Error("preview worker kind must be quickjs-bytecode");
  if (workerInteger(raw.protocolVersion, "protocolVersion", 1, 1) !== 1) throw new Error("unsupported preview worker protocol version");
  const bytecodeDescriptor = asRecord(raw.bytecode, "worker bytecode descriptor");
  const descriptorPath = workerString(bytecodeDescriptor.path, "bytecode path");
  if (descriptorPath.startsWith("/") || descriptorPath.includes("\\") || descriptorPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("preview worker bytecode path must be canonical and relative");
  }
  const workerBytes = new Uint8Array(await readFile(workerBytecode));
  const expectedBytes = workerInteger(bytecodeDescriptor.bytes, "bytecode bytes", 1, 64 * 1024 * 1024);
  const expectedHash = workerString(bytecodeDescriptor.sha256, "bytecode sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || workerBytes.byteLength !== expectedBytes || sha256Hex(workerBytes) !== expectedHash) {
    throw new Error("preview worker bytecode integrity does not match its descriptor");
  }
  const declaration = asRecord(raw.declaration, "worker declaration");
  const requiredCapabilities = workerStringList(raw.requiredCaps, "requiredCaps");
  if (!requiredCapabilities.includes("runtime.worker")) throw new Error("preview worker must require runtime.worker");
  const manifestRequires = manifest?.capabilities && typeof manifest.capabilities === "object" && !Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as Record<string, unknown>).requires
    : undefined;
  if (manifestRequires !== undefined) {
    const admitted = new Set(workerStringList(manifestRequires, "manifest capabilities.requires"));
    if (requiredCapabilities.some((capability) => !admitted.has(capability))) {
      throw new Error("preview worker requires a capability missing from guest-manifest.json");
    }
  }
  const runtimeAbi = workerString(raw.runtimeAbi, "runtimeAbi");
  const bindingGeneration = workerInteger(raw.bindingGeneration, "bindingGeneration");
  const tickHz = workerInteger(raw.tickHz, "tickHz", 1, 120);
  // The main metadata's ABI/tick are the UI host contract. Native performs the
  // final ABI/binding admission; rejecting an obvious mismatch here keeps the
  // error attached to the preview artifact instead of a later eval boundary.
  const uiMetadataRecord = uiMetadata ? await readJsonObjectFile(uiMetadata, "app.bytecode.json") : undefined;
  if (uiMetadataRecord?.runtimeAbi !== undefined && uiMetadataRecord.runtimeAbi !== runtimeAbi) {
    throw new Error("preview worker runtime ABI differs from the UI bytecode");
  }
  if (project.tickHz !== undefined && project.tickHz !== tickHz) {
    throw new Error(`preview worker tickHz ${tickHz} differs from UI tickHz ${project.tickHz}`);
  }
  const declarationNodes = Array.isArray(declaration.nodes) ? declaration.nodes : [];
  const expectedCapabilities = new Set(["runtime.worker"]);
  for (const rawNode of declarationNodes) {
    const node = asRecord(rawNode, "worker node");
    if (node.kind === "http") expectedCapabilities.add("net.http");
    else if (node.kind === "i2c") expectedCapabilities.add("io.i2c");
    else if (node.kind === "uart") expectedCapabilities.add("io.uart");
    else throw new Error("preview worker declaration contains an unsupported node kind");
  }
  if (requiredCapabilities.length !== expectedCapabilities.size || requiredCapabilities.some((capability) => !expectedCapabilities.has(capability))) {
    throw new Error("preview worker requiredCaps do not match runtime.worker and its declared nodes");
  }
  const config: Record<string, unknown> = {
    protocolVersion: 1,
    nativeGeneration: 1,
    bindingGeneration,
    tickHz,
    expectedRuntimeAbi: runtimeAbi,
    declaration,
    policy: {
      requiredCapabilities: [...requiredCapabilities].sort(),
      allowedHttpOrigins: [...new Set(origins.map((origin) => String(origin)))].sort(),
    },
    limits: {
      heapBytes: 16 * 1024 * 1024,
      stackBytes: 1024 * 1024,
      turnBudgetMicros: 10_000,
      windowMicros: 50_000,
      quotaMicros: 10_000,
    },
  };
  return { bytecodePath: resolve(workerBytecode), descriptor: raw, config };
}

type SystemCatalogEntry = {
  package: string;
  manifest: string;
  required: boolean;
};

type SystemCatalog = {
  systemUI: string;
  installed: Set<string>;
  catalog: SystemCatalogEntry[];
};

/** Read the same trusted catalog used by Flutter's PocketSystemHost. */
async function systemCatalogFromProject(projectDirectory: string | undefined): Promise<SystemCatalog | undefined> {
  if (!projectDirectory) return undefined;
  const path = join(projectDirectory, "pocket.system.json");
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`preview: invalid pocket.system.json: ${errorText(error)}`);
  }
  const root = asRecord(value, "pocket.system.json");
  const roles = asRecord(root.roles, "pocket.system.json.roles");
  const systemUI = roles.systemUI;
  if (typeof systemUI !== "string" || !systemUI) throw new Error("preview: pocket.system.json.roles.systemUI is required");
  const applications = asRecord(root.applications, "pocket.system.json.applications");
  if (!Array.isArray(applications.catalog)) throw new Error("preview: pocket.system.json applications.catalog must be an array");
  const installation = asRecord(root.installation, "pocket.system.json.installation");
  if (!Array.isArray(installation.installedPackages)) throw new Error("preview: pocket.system.json installation.installedPackages must be an array");
  const installed = new Set(installation.installedPackages.filter((item): item is string => typeof item === "string"));
  const catalog: SystemCatalogEntry[] = [];
  for (const entry of applications.catalog) {
    const record = asRecord(entry, "pocket.system.json catalog entry");
    const packageId = record.package;
    const manifest = record.manifest;
    if (typeof packageId !== "string" || !packageId || typeof manifest !== "string" || !manifest) {
      throw new Error("preview: System catalog entries require package and manifest");
    }
    catalog.push({ package: packageId, manifest, required: record.required === true });
  }
  const generatedPath = join(projectDirectory, "generated", "compositor-surfaces.json");
  if (existsSync(generatedPath)) {
    let generated: unknown;
    try {
      generated = JSON.parse(await readFile(generatedPath, "utf8"));
    } catch (error) {
      throw new Error(`preview: invalid generated compositor registry: ${errorText(error)}`);
    }
    const document = asRecord(generated, "generated compositor registry");
    if (document.schemaVersion !== 1) throw new Error("preview: unsupported generated compositor registry schema");
    const surfaces = asRecord(document.surfaces, "generated compositor registry surfaces");
    const generatedApplications = document.applications === undefined
      ? {}
      : asRecord(document.applications, "generated compositor registry applications");
    for (const appId of Object.keys(generatedApplications)) {
      if (appId === systemUI || typeof surfaces[appId] !== "number" || !Number.isInteger(surfaces[appId])) {
        throw new Error("preview: generated application must have a compositor surface");
      }
      installed.add(appId);
      if (!catalog.some((entry) => entry.package === appId)) {
        catalog.push({ package: appId, manifest: `generated/${appId}`, required: false });
      }
    }
  }
  return { systemUI, installed, catalog };
}

/**
 * The SystemUI guest validates the complete installed-child registry before
 * its first layout. Flutter normally supplies this through
 * PocketView.compositorSurfaces; a local Editor has no Flutter widget, so use
 * the same trusted source manifest when it is present. This only allocates
 * handles for installed catalog children and never fabricates a child guest.
 */
export async function compositorSurfacesFromProject(projectDirectory: string | undefined): Promise<Record<string, number> | undefined> {
  const system = await systemCatalogFromProject(projectDirectory);
  if (!system) return undefined;
  const generatedPath = join(projectDirectory!, "generated", "compositor-surfaces.json");
  if (existsSync(generatedPath)) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(generatedPath, "utf8"));
    } catch (error) {
      throw new Error(`preview: invalid generated compositor registry: ${errorText(error)}`);
    }
    const document = asRecord(value, "generated compositor registry");
    if (document.schemaVersion !== 1) throw new Error("preview: unsupported generated compositor registry schema");
    const raw = asRecord(document.surfaces, "generated compositor registry surfaces");
    const result: Record<string, number> = {};
    const handles = new Set<number>();
    for (const [appId, handle] of Object.entries(raw)) {
      if (!appId || typeof handle !== "number" || !Number.isInteger(handle) || handle < 2 || handle > 63 || handles.has(handle)) {
        throw new Error("preview: generated compositor handles must be unique integers from 2 through 63");
      }
      if (appId === system.systemUI) throw new Error("preview: generated compositor registry must not contain the SystemUI");
      handles.add(handle);
      result[appId] = handle;
    }
    const requiredChildren = system.catalog
      .filter((entry) => entry.package !== system.systemUI && system.installed.has(entry.package))
      .map((entry) => entry.package);
    if (requiredChildren.some((appId) => result[appId] === undefined)) {
      throw new Error("preview: generated compositor registry omits an installed manifest child");
    }
    return result;
  }
  const result: Record<string, number> = {};
  let handle = 2;
  for (const entry of system.catalog) {
    if (entry.package === system.systemUI || !system.installed.has(entry.package)) continue;
    if (handle > 63) throw new Error("preview: System catalog has more than 62 installed child applications");
    result[entry.package] = handle;
    handle += 1;
  }
  return result;
}

function childArtifactCandidates(projectDirectory: string, entry: SystemCatalogEntry): string[] {
  const manifestDirectory = resolve(projectDirectory, entry.manifest, "..");
  const appName = basename(manifestDirectory);
  const candidates = [
    // `demo/js/scripts/build_mini_apps.ts` writes host assets here.
    join(projectDirectory, "..", "assets", "apps", appName),
    join(projectDirectory, "assets", "apps", appName),
    // External consumers commonly keep child build snapshots beside their
    // source project or in a package-id keyed build directory.
    join(projectDirectory, "build", "apps", appName),
    join(projectDirectory, "build", entry.package),
    join(projectDirectory, "apps", appName, ".pocket-build"),
  ];
  return candidates;
}

async function discoverChildArtifacts(
  projectDirectory: string | undefined,
  catalog: SystemCatalog | undefined,
  explicit: Record<string, PreviewArtifactPaths> | undefined,
): Promise<Record<string, PreviewArtifactPaths> | undefined> {
  if (!catalog) return explicit;
  const result: Record<string, PreviewArtifactPaths> = { ...(explicit ?? {}) };
  for (const entry of catalog.catalog) {
    if (entry.package === catalog.systemUI || !catalog.installed.has(entry.package) || result[entry.package]) continue;
    if (!projectDirectory) continue;
    for (const directory of childArtifactCandidates(projectDirectory, entry)) {
      const bytecodePath = join(directory, "app.qjbc");
      const pakPath = join(directory, "app.pak");
      const sourcePath = join(directory, "app.js");
      if (!existsSync(pakPath) || (!existsSync(bytecodePath) && !existsSync(sourcePath))) continue;
      result[entry.package] = {
        ...(existsSync(bytecodePath) ? { bytecodePath } : { sourcePath }),
        pakPath,
        metadataPath: join(directory, "app.bytecode.json"),
        appId: entry.package,
        // Loose media is owned by the source package, not by its generated
        // qjbc/pak snapshot. Keep this directory alongside the child
        // artifact so the browser route can serve the same `assets/...`
        // contract that the native host receives.
        projectDirectory: resolve(projectDirectory, entry.manifest, ".."),
      };
      break;
    }
  }
  return Object.keys(result).length > 0 ? result : explicit;
}

function routeName(request: Request, explicit?: string): string {
  if (explicit) return explicit.replace(/^\/+|\/+$/g, "") || "page";
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/stream")) return "stream";
  if (pathname.endsWith("/input")) return "input";
  if (pathname.endsWith("/snapshot")) return "snapshot";
  if (pathname.endsWith("/status")) return "status";
  if (pathname.endsWith("/media")) return "media";
  if (pathname.endsWith("/resource")) return "resource";
  return "page";
}

async function requestJson(request: Request): Promise<JsonRecord> {
  const text = await request.text();
  if (Buffer.byteLength(text) > maxInputBytes) throw new Error("preview input is too large");
  if (!text) return {};
  return asRecord(JSON.parse(text), "preview input");
}

/** A serialized line-oriented client for the checked-in native probe. */
type NativeProbeObserver = (command: JsonRecord, response: JsonRecord) => void | Promise<void>;
type NativeProbeCommandDecorator = (command: JsonRecord) => JsonRecord;

class NativeProbe {
  readonly path: string;
  readonly timeoutMs: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending: Array<{ resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly stderr: string[] = [];
  private closed = false;
  private stopping = false;
  private errorHandler?: (error: Error) => void;
  private observer?: NativeProbeObserver;
  private decorator?: NativeProbeCommandDecorator;
  private wakeHandler?: () => void;

  constructor(path: string, timeoutMs: number) {
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr.push(String(chunk));
      if (this.stderr.length > 32) this.stderr.splice(0, this.stderr.length - 32);
    });
    this.child.on("error", (error) => this.close(error instanceof Error ? error : new Error(String(error))));
    this.child.on("exit", (code, signal) => this.close(new Error(`pocket_probe exited (${signal ?? code ?? "unknown"})`)));
  }

  private onLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      const response = asRecord(parsed, "probe response");
      if (response.frame && typeof response.frame === "object") {
        nativeFrameWireBytes.set(response.frame, Buffer.byteLength(line));
      }
      // pocket_probe emits this record from the native Worker/provider wake
      // callback. It is deliberately not a command response and must leave
      // the serialized request queue untouched.
      if (response.__pocket_probe_event === "worker") {
        this.wakeHandler?.();
        return;
      }
      const next = this.pending.shift();
      if (!next) return;
      clearTimeout(next.timer);
      next.resolve(response);
    } catch (error) {
      const next = this.pending.shift();
      if (!next) return;
      clearTimeout(next.timer);
      next.reject(new Error(`invalid pocket_probe response: ${errorText(error)}`));
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    const failure = new Error(`${error.message}${this.stderr.length ? `: ${this.stderr.join("").trim()}` : ""}`);
    while (this.pending.length) {
      const next = this.pending.shift()!;
      clearTimeout(next.timer);
      next.reject(failure);
    }
    if (!this.stopping) this.errorHandler?.(failure);
  }

  async command(command: JsonRecord): Promise<JsonRecord> {
    if (this.closed) throw new Error("pocket_probe is not running");
    return new Promise<JsonRecord>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.resolve === resolveResponse);
        if (index >= 0) this.pending.splice(index, 1);
        rejectResponse(new Error(`pocket_probe command timed out after ${this.timeoutMs}ms`));
        this.child.kill("SIGTERM");
      }, this.timeoutMs);
      this.pending.push({ resolve: resolveResponse, reject: rejectResponse, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        clearTimeout(timer);
        const index = this.pending.findIndex((item) => item.resolve === resolveResponse);
        if (index >= 0) this.pending.splice(index, 1);
        rejectResponse(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async checked(command: JsonRecord): Promise<JsonRecord> {
    const decorated = this.decorator?.(command) ?? command;
    const returnsFrame = decorated.op === "frame" || decorated.render === true &&
      ["load", "loadBytecode", "eval"].includes(String(decorated.op));
    const actualCommand = returnsFrame ? { ...decorated, resourceEncoding: "base64" } : decorated;
    const response = await this.command(actualCommand);
    if (response.ok !== true) {
      throw new Error(typeof response.error === "string" ? response.error : "pocket_probe operation failed");
    }
    await this.observer?.(actualCommand, response);
    return response;
  }

  setObserver(observer: NativeProbeObserver | undefined): void {
    this.observer = observer;
  }

  setDecorator(decorator: NativeProbeCommandDecorator | undefined): void {
    this.decorator = decorator;
  }

  setWakeHandler(handler: (() => void) | undefined): void {
    this.wakeHandler = handler;
  }

  setErrorHandler(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.closed) return;
    try {
      await this.checked({ op: "quit" });
    } catch {
      this.child.kill("SIGTERM");
    }
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        if (!this.closed) this.child.kill("SIGKILL");
        resolveStop();
      }, 1000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  }
}

type PreviewProbeHistoryEntry = {
  command: JsonRecord;
  response: JsonRecord;
  frameSummary?: JsonRecord;
};

type PreviewRecordingEntry = {
  index: number;
  kind: string;
  args: JsonRecord;
  result: JsonRecord;
  error: null;
};

type PreviewRecordingAsset = {
  descriptor: JsonRecord;
  path: string;
  bytes: Uint8Array;
};

type PreviewRecordingCapture = {
  id: string;
  appId: string;
  runtime: PreviewRuntime;
  entries: PreviewRecordingEntry[];
  bytes: number;
  createArgs?: JsonRecord;
  assets: Map<string, PreviewRecordingAsset>;
  contentHashes: Record<string, string>;
  engineAbi?: string;
  incompleteReason?: string;
  stopped: boolean;
};

type PreviewRecordingState = {
  enabled: boolean;
  stopped: boolean;
  /** The live guest is being replaced with a trace-enabled probe. */
  pendingRestart: boolean;
  captures: Map<PreviewRuntime, PreviewRecordingCapture>;
  incompleteReason?: string;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Canonical JSON mirrors pocketCanonicalJson for preview-local digests. */
const previewNumberKind = Symbol("preview-number-kind");
type PreviewNumber = { [previewNumberKind]: "int" | "double"; value: number };

function previewInteger(value: unknown): unknown {
  return typeof value === "number" ? { [previewNumberKind]: "int", value } as PreviewNumber : value;
}

function previewDouble(value: unknown): unknown {
  return typeof value === "number" ? { [previewNumberKind]: "double", value } as PreviewNumber : value;
}

function canonicalPreviewJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("recording JSON contains a non-finite number");
    return Object.is(value, -0) ? "-0.0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPreviewJson).join(",")}]`;
  if (typeof value === "object") {
    const number = value as Partial<PreviewNumber>;
    if (number[previewNumberKind] !== undefined) {
      if (typeof number.value !== "number" || !Number.isFinite(number.value)) throw new Error("recording JSON contains a non-finite number");
      if (number[previewNumberKind] === "int") return String(number.value);
      return Object.is(number.value, -0) ? "-0.0" : number.value === 0 ? "0" : Number.isInteger(number.value) ? `${number.value}.0` : String(number.value);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalPreviewJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`recording JSON contains unsupported ${typeof value}`);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function previewBytes(value: unknown, encoding?: unknown): Uint8Array {
  if (encoding === "base64" && typeof value === "string") return Buffer.from(value, "base64");
  if (!Array.isArray(value)) return new Uint8Array();
  return new Uint8Array(value.map((item) => {
    const number = Number(item);
    return Number.isFinite(number) ? Math.max(0, Math.min(255, Math.trunc(number))) : 0;
  }));
}

function previewClip(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clip = value as JsonRecord;
  return {
    x: previewDouble(Number(clip.x ?? 0)),
    y: previewDouble(Number(clip.y ?? 0)),
    width: previewDouble(Number(clip.width ?? clip.w ?? 0)),
    height: previewDouble(Number(clip.height ?? clip.h ?? 0)),
  };
}

function previewOpSummary(value: unknown): JsonRecord {
  const op = asRecord(value, "recording frame op");
  const type = typeof op.type === "string" ? op.type : "unknown";
  const result: JsonRecord = {
    type,
    x: previewDouble(Number(op.x ?? 0)),
    y: previewDouble(Number(op.y ?? 0)),
    width: previewDouble(Number(op.width ?? op.w ?? 0)),
    height: previewDouble(Number(op.height ?? op.h ?? 0)),
    clip: previewClip(op.clip),
  };
  if (type === "rect") result.color = previewInteger(op.color);
  else if (type === "rounded") {
    result.color = previewInteger(op.color);
    result.radius = previewDouble(op.radius);
    const borderWidth = Number(op.borderWidth ?? op.border_width ?? 0);
    if (Number.isFinite(borderWidth) && borderWidth > 0) result.borderWidth = previewDouble(borderWidth);
  } else if (type === "arc") {
    result.color = previewInteger(op.color);
    result.radius = previewDouble(Number(op.radius ?? 0));
    result.strokeWidth = previewDouble(Number(op.strokeWidth ?? op.borderWidth ?? op.border_width ?? 0));
    result.startAngle = previewDouble(Number(op.startAngle ?? op.start_angle ?? 0));
    result.sweepAngle = previewDouble(Number(op.sweepAngle ?? op.sweep_angle ?? 0));
  } else if (type === "gradient") {
    result.fromColor = previewInteger(op.from ?? op.fromColor);
    result.toColor = previewInteger(op.to ?? op.toColor);
    result.direction = previewInteger(op.direction);
  } else if (type === "roundedGradient") {
    result.fromColor = previewInteger(op.from ?? op.fromColor ?? op.from_color);
    result.toColor = previewInteger(op.to ?? op.toColor ?? op.to_color);
    result.direction = previewInteger(op.direction ?? op.dir);
    result.radius = previewDouble(op.radius);
    const viaColor = op.viaColor ?? op.via_color;
    const viaPosition = op.viaPosition ?? op.via_position;
    if (viaColor !== undefined && viaColor !== null) result.viaColor = previewInteger(viaColor);
    if (viaPosition !== undefined && viaPosition !== null) result.viaPosition = previewDouble(Number(viaPosition));
  } else if (type === "triangle") {
    result.points = Array.isArray(op.points) ? op.points.map((point) => {
      const item = asRecord(point, "recording triangle point");
      return { x: previewDouble(Number(item.x)), y: previewDouble(Number(item.y)) };
    }) : [];
    result.colors = Array.isArray(op.colors) ? op.colors.map((color) => previewInteger(color)) : op.colors;
  } else if (type === "textureTriangle") {
    result.asset = op.asset;
    result.color = previewInteger(op.color);
    result.points = Array.isArray(op.points) ? op.points.map((point) => {
      const item = asRecord(point, "recording texture triangle point");
      return { x: previewDouble(Number(item.x)), y: previewDouble(Number(item.y)) };
    }) : [];
    result.uvs = Array.isArray(op.uvs) ? op.uvs.map((uv) => previewDouble(uv)) : op.uvs;
  } else if (type === "text") {
    result.text = op.text;
    result.size = previewDouble(op.size);
    result.color = previewInteger(op.color);
    result.fontSlot = op.fontSlot === undefined ? null : previewInteger(op.fontSlot);
    result.align = previewInteger(op.align);
  } else if (type === "image") {
    result.asset = op.asset;
    result.uv = op.uv === undefined ? null : Array.isArray(op.uv) ? op.uv.map((uv) => previewDouble(uv)) : op.uv;
    // The native FrameOp schema calls this ARGB modulation word `color`;
    // PocketImageOp exposes the same value as `tint` after decoding. Keep
    // the preview digest on the canonical Dart field rather than relying on
    // a non-existent native `tint` key.
    result.tint = op.color === undefined && op.tint === undefined ? null : previewInteger(op.color ?? op.tint);
  } else if (type === "hostSurface") {
    // Host-surface parameters travel in the native asset descriptor. The
    // Flutter decoder reads that descriptor before constructing
    // PocketHostSurfaceOp, so do the same before hashing the frame. This
    // keeps application/glass providers replay-equivalent without inventing
    // a second host-surface schema in the editor.
    let descriptor: JsonRecord | undefined;
    if (typeof op.asset === "string") {
      try {
        const parsed = JSON.parse(op.asset);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) descriptor = parsed as JsonRecord;
      } catch {
        // A malformed descriptor is rejected by the canonical Flutter
        // decoder; retain the raw fallback so the digest remains diagnostic.
      }
    }
    result.id = op.id;
    result.kind = descriptor?.kind ?? op.kind;
    result.surfaceHandle = previewInteger(op.surfaceHandle);
    result.focused = op.focused;
    result.parameters = descriptor?.parameters ?? op.parameters ?? {};
  } else if (type === "video") {
    result.id = op.id;
    result.asset = op.asset;
    result.autoplay = op.autoplay;
    result.fit = op.fit;
  }
  return result;
}

function previewEventSummary(value: unknown): JsonRecord {
  const event = asRecord(value, "recording frame event");
  const payload = event.payload ?? event.params ?? {};
  const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as JsonRecord
    : {};
  return {
    id: String(event.id ?? ""),
    method: String(event.method ?? event.name ?? ""),
    params: payloadRecord,
  };
}

function previewResourceSummary(value: unknown): JsonRecord {
  const resource = asRecord(value, "recording frame resource");
  const pixels = previewBytes(resource.pixels, resource.bytesEncoding);
  const palette = resource.palette === undefined || resource.palette === null ? undefined : previewBytes(resource.palette, resource.bytesEncoding);
  return {
    asset: resource.asset,
    revision: previewInteger(resource.revision),
    width: previewInteger(resource.width),
    height: previewInteger(resource.height),
    psm: previewInteger(resource.psm),
    linear: resource.linear,
    pixelsBytes: previewInteger(pixels.byteLength),
    pixelsSha256: sha256Hex(pixels),
    paletteBytes: palette === undefined ? null : previewInteger(palette.byteLength),
    paletteSha256: palette === undefined ? null : sha256Hex(palette),
  };
}

/**
 * Some preview/resource providers omit the native revision field. Compare
 * their actual pixel payload before forwarding a resource delta; otherwise a
 * static atlas is decoded and dropped by the browser on every animation
 * frame. Revision-bearing native resources retain the cheaper revision path
 * at the compositor boundary below.
 */
function samePreviewResourceBytes(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftAbsent = left === undefined || left === null;
  const rightAbsent = right === undefined || right === null;
  if (leftAbsent || rightAbsent) return leftAbsent && rightAbsent;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function samePreviewResourcePayload(left: JsonRecord, right: JsonRecord): boolean {
  return left.width === right.width && left.height === right.height &&
    left.psm === right.psm && left.linear === right.linear &&
    samePreviewResourceBytes(left.pixels, right.pixels) &&
    samePreviewResourceBytes(left.palette, right.palette);
}

function previewFrameSummary(value: PreviewFrame): JsonRecord {
  const canonical: JsonRecord = {
    width: previewDouble(value.width),
    height: previewDouble(value.height),
    ops: value.ops.map(previewOpSummary),
    events: value.events.map(previewEventSummary),
    resources: value.resources.map(previewResourceSummary),
    releasedResources: value.releasedResources ?? [],
    auxiliary: value.auxiliary === undefined ? null : {
      width: previewDouble(value.auxiliary.width),
      height: previewDouble(value.auxiliary.height),
      ops: value.auxiliary.ops.map(previewOpSummary),
    },
  };
  const digest = (item: unknown): string => sha256Hex(canonicalPreviewJson(item));
  return {
    sha256: digest(canonical),
    opsSha: digest(canonical.ops),
    eventsSha: digest(canonical.events),
    resourcesSha: digest(canonical.resources),
    auxSha: digest(canonical.auxiliary),
    width: value.width,
    height: value.height,
    ops: value.ops.length,
    events: value.events.length,
    resources: value.resources.length,
    releasedResources: (value.releasedResources ?? []).length,
    auxiliaryOps: value.auxiliary?.ops.length ?? 0,
  };
}

type PreviewRuntime = {
  live2d?: ReturnType<typeof createPreviewLive2d>;
  appId: string;
  instanceId: string;
  generation: number;
  probe: NativeProbe;
  artifacts: PreviewProject;
  worker?: ResolvedPreviewWorker;
  /** Native guest viewport; child guests are resized to their selected host
   * surface rather than inheriting the browser/root viewport. */
  viewportWidth: number;
  viewportHeight: number;
  safeArea: PreviewSafeArea;
  frame?: PreviewFrame;
  resources: Map<string, JsonRecord>;
  initialEvents: JsonRecord[];
  /** Browser lifecycle edges are transient native frame events. Keep video
   * and text-input edges together until the composite frame is published
   * because pumpRuntime may settle several native frames before tickNow emits
   * the browser projection. */
  pendingBrowserEvents: PendingBrowserEvent[];
  /** Latest validated semantic snapshot, retained across settled frames. */
  accessibilitySnapshot?: PreviewAccessibilitySnapshot;
  needsPump: boolean;
  pumping: number;
  /** Keep one child native frame request off the root session queue. */
  frameInFlight?: { generation: number };
  /** Elapsed child time accumulated while its native frame request is pending. */
  pendingFrameDeltaMs?: number;
  /** A slot resize observed during a child frame is applied after that response. */
  pendingViewport?: { width: number; height: number; safeArea: PreviewSafeArea };
};

/** Keep lifecycle edges tied to the runtime generation that emitted them. */
type PendingBrowserEvent = {
  event: JsonRecord;
  generation: number;
};

type PendingSystemRequest = {
  source: PreviewRuntime;
  requestId: string;
  capability: string;
  params: JsonRecord;
  sent: boolean;
  /** Deferred requests use the outer root pump instead of recursively pumping a live frame. */
  deferred?: boolean;
  /** Preserve a finite 48-pump failure contract across outer turns. */
  deferredPumps?: number;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
};

type PendingChildRuntimeLoad = {
  rootRuntime: PreviewRuntime;
  rootGeneration: number;
  cancelled: boolean;
  promise?: Promise<PreviewRuntime>;
  probe?: NativeProbe;
  stopPromise?: Promise<void>;
};

type SurfaceSlot = {
  handle: number;
  appId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
};

type PointerTarget = {
  runtime: PreviewRuntime;
  /** Preserve the DOWN surface transform until UP/CANCEL even if the pointer
   * leaves the focused surface or presentation changes. */
  slot?: SurfaceSlot;
  /** Last native-space point admitted for this captured contact. */
  lastPoint?: { x: number; y: number };
  /** Keep auxiliary-surface captures on their original native surface. */
  surface?: unknown;
};

function eventPayload(event: JsonRecord): JsonRecord | undefined {
  const payload = event.payload ?? event.params;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as JsonRecord;
}

function eventName(event: JsonRecord): string {
  return typeof event.name === "string" ? event.name : typeof event.method === "string" ? event.method : "";
}

function isVideoPlaybackEvent(event: JsonRecord): boolean {
  const name = eventName(event);
  return name === "video.play" || name === "video.pause" || name === "video.release";
}

function isTextInputLifecycleEvent(event: JsonRecord): boolean {
  const name = eventName(event);
  return name === "textInput.open" || name === "textInput.update" || name === "textInput.close";
}

/**
 * Cleanup edges must survive a busy replacement boundary.  They are the
 * browser projection's only signal that an overlay/media resource owned by
 * the old guest is no longer live. The queue never silently evicts an edge:
 * repeatable video state is coalesced and a hard-bound violation fails
 * explicitly so the caller can reload the guest.
 */
function isBrowserCleanupEvent(event: JsonRecord): boolean {
  const name = eventName(event);
  return name === "textInput.close" || name === "video.release";
}

function browserEventIdentity(event: JsonRecord): string | undefined {
  const name = eventName(event);
  const payload = eventPayload(event);
  if (name === accessibilitySnapshotEvent) return accessibilitySnapshotEvent;
  if (isVideoPlaybackEvent(event)) {
    const id = payload?.id;
    return typeof id === "string" && id.length > 0 ? `${name}:${id}` : undefined;
  }
  // Text input updates carry revision/selection state and must retain their
  // full sequence; coalescing a rect-only update can overwrite a value-bearing
  // update before the browser projection observes it.
  return undefined;
}

function enqueueBrowserEvent(
  queue: PendingBrowserEvent[],
  event: JsonRecord,
  generation: number,
): void {
  const identity = browserEventIdentity(event);
  if (identity) {
    const existing = queue.findIndex((item) => item.generation === generation && browserEventIdentity(item.event) === identity);
    if (existing >= 0) {
      // Move the replacement to the tail so repeated playback commands
      // preserve the actual latest state ordering.
      queue.splice(existing, 1);
    }
  }
  if (queue.length >= maxPendingBrowserEvents) {
    const cleanupCount = queue.filter(({ event: queued }) => isBrowserCleanupEvent(queued)).length;
    throw new Error(`preview browser lifecycle queue exceeded ${maxPendingBrowserEvents} events (${cleanupCount} cleanup edges retained); reload required`);
  }
  queue.push({ event, generation });
}

function hostError(code: string, message: string): JsonRecord {
  return { code, message };
}

function transformedChildOp(
  op: JsonRecord,
  slot: SurfaceSlot,
  child: PreviewFrame,
  assetPrefix: string,
): JsonRecord {
  const scaleX = slot.w / Math.max(1, child.width);
  const scaleY = slot.h / Math.max(1, child.height);
  const transformed: JsonRecord = { ...op };
  const number = (key: string, scale: number, offset = 0): void => {
    if (typeof op[key] === "number" && Number.isFinite(op[key])) transformed[key] = Number(op[key]) * scale + offset;
  };
  number("x", scaleX, slot.x);
  number("y", scaleY, slot.y);
  number("w", scaleX);
  number("h", scaleY);
  if (typeof op.radius === "number" && Number.isFinite(op.radius)) transformed.radius = op.radius * Math.min(scaleX, scaleY);
  if (typeof op.asset === "string" && op.asset) transformed.asset = `${assetPrefix}${op.asset}`;
  // Every child operation must be clipped to its host-surface rect. Native
  // DrawOps normally carry a nested clip, but keeping the host bound here is
  // required for ops produced by a guest/plugin without one and prevents a
  // malformed child op from painting over the SystemUI/root layer.
  const clip = op.clip && typeof op.clip === "object" && !Array.isArray(op.clip) ? op.clip as JsonRecord : undefined;
  const clipX = typeof clip?.x === "number" && Number.isFinite(clip.x) ? clip.x * scaleX + slot.x : slot.x;
  const clipY = typeof clip?.y === "number" && Number.isFinite(clip.y) ? clip.y * scaleY + slot.y : slot.y;
  const clipW = typeof clip?.w === "number" && Number.isFinite(clip.w) ? clip.w * scaleX : slot.w;
  const clipH = typeof clip?.h === "number" && Number.isFinite(clip.h) ? clip.h * scaleY : slot.h;
  const left = Math.max(slot.x, clipX);
  const top = Math.max(slot.y, clipY);
  const right = Math.min(slot.x + slot.w, clipX + clipW);
  const bottom = Math.min(slot.y + slot.h, clipY + clipH);
  transformed.clip = {
    ...(clip ?? {}),
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
  if (Array.isArray(op.points)) {
    transformed.points = op.points.map((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) return point;
      const value = point as JsonRecord;
      return {
        ...value,
        ...(typeof value.x === "number" ? { x: value.x * scaleX + slot.x } : {}),
        ...(typeof value.y === "number" ? { y: value.y * scaleY + slot.y } : {}),
      };
    });
  }
  return transformed;
}

function transformedTextInputEvent(
  event: JsonRecord,
  slot: SurfaceSlot,
  child: PreviewFrame,
  runtimeToken: string,
): JsonRecord {
  const payload = eventPayload(event);
  if (!payload) return { ...event, runtime: slot.appId, runtimeToken };
  const scaleX = slot.w / Math.max(1, child.width);
  const scaleY = slot.h / Math.max(1, child.height);
  const rect = (value: unknown): JsonRecord | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as JsonRecord;
    const x = Number(source.x);
    const y = Number(source.y);
    const width = Number(source.width ?? source.w);
    const height = Number(source.height ?? source.h);
    if (![x, y, width, height].every(Number.isFinite)) return undefined;
    return {
      ...source,
      x: x * scaleX + slot.x,
      y: y * scaleY + slot.y,
      width: width * scaleX,
      height: height * scaleY,
    };
  };
  const transformed: JsonRecord = { ...event, runtime: slot.appId, runtimeToken };
  const nextPayload: JsonRecord = { ...payload };
  const nextRect = rect(payload.rect);
  if (nextRect) nextPayload.rect = nextRect;
  const nextClip = rect(payload.clip);
  if (nextClip) nextPayload.clip = nextClip;
  transformed.payload = nextPayload;
  if (event.params !== undefined && event.payload === undefined) transformed.params = nextPayload;
  return transformed;
}

function clippedAccessibilityRect(
  rect: PreviewAccessibilityRect,
  bounds: { x: number; y: number; width: number; height: number },
): PreviewAccessibilityRect | undefined {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function projectedAccessibilityEvent(
  snapshot: PreviewAccessibilitySnapshot,
  root: PreviewFrame,
  runtimeToken: string,
  slot?: SurfaceSlot,
  child?: PreviewFrame,
  runtime?: string,
): JsonRecord {
  const rootBounds = { x: 0, y: 0, width: Math.max(1, root.width), height: Math.max(1, root.height) };
  const scaleX = slot && child ? slot.w / Math.max(1, child.width) : 1;
  const scaleY = slot && child ? slot.h / Math.max(1, child.height) : 1;
  const bounds = slot && child
    ? { x: slot.x, y: slot.y, width: slot.w, height: slot.h }
    : rootBounds;
  const controls = snapshot.controls.flatMap((control) => {
    const rect = slot && child
      ? {
          x: control.rect.x * scaleX + slot.x,
          y: control.rect.y * scaleY + slot.y,
          width: control.rect.width * scaleX,
          height: control.rect.height * scaleY,
        }
      : control.rect;
    const rootClipped = clippedAccessibilityRect(rect, rootBounds);
    const clipped = rootClipped ? clippedAccessibilityRect(rootClipped, bounds) : undefined;
    if (!clipped) return [];
    return [{
      guestId: control.guestId,
      nativeId: control.nativeId,
      label: control.label,
      role: control.role,
      selected: control.selected,
      disabled: control.disabled,
      enabled: control.enabled,
      ...(control.checked === undefined ? {} : { checked: control.checked }),
      rect: clipped,
    }];
  });
  return {
    name: accessibilitySnapshotEvent,
    payload: {
      generation: snapshot.generation,
      controls,
      runtimeToken,
      ...(runtime ? { runtime } : {}),
    },
  };
}

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  browserPresentation: boolean;
  compactResources: boolean;
  externalResources: boolean;
  webBluetooth?: { clientId: string; lease: string };
};

/** Browser wire encoding only; native frames, recordings and resource caches stay canonical. */
export function encodePreviewStreamPacket(value: unknown, compactResources = false): Uint8Array {
  let packet = value;
  const candidate = value as { type?: string; frame?: PreviewFrame } | null;
  if (compactResources && candidate?.type === "frame" && Array.isArray(candidate.frame?.resources)) {
    packet = {
      ...candidate,
      frame: {
        ...candidate.frame,
        resources: candidate.frame.resources.map(resource => {
          if (!Array.isArray(resource.pixels)) return resource;
          const { pixels, palette, ...metadata } = resource;
          return {
            ...metadata,
            bytesEncoding: "base64",
            pixels: Buffer.from(pixels).toString("base64"),
            ...(Array.isArray(palette) ? { palette: Buffer.from(palette).toString("base64") } : {}),
          };
        }),
      },
    };
  }
  return new TextEncoder().encode(`data: ${JSON.stringify(packet)}\n\n`);
}

type BrowserPluginRequest = {
  token: string;
  clientId: string;
  lease: string;
  runtime: PreviewRuntime;
  requestId?: string;
  capability?: string;
  streamId?: string;
  kind: "request" | "stream.open" | "stream.cancel" | "scope.dispose";
  timer?: ReturnType<typeof setTimeout>;
};

class PreviewSession {
  readonly id: string;
  private readonly manager: PreviewManagerImpl;
  private readonly subscribers = new Set<Subscriber>();
  private readonly operationTail: { promise: Promise<void> } = { promise: Promise.resolve() };
  private probe?: NativeProbe;
  /** Root SystemUI plus independently mounted child guests. Each handle is a
   * real native runtime; the browser still receives one compositor frame. */
  private rootRuntime?: PreviewRuntime;
  private readonly childRuntimes = new Map<string, PreviewRuntime>();
  /** Coalesce child starts and let stopProbe cancel native loads that have
   * not yet reached the point where the child is in childRuntimes. */
  private readonly childRuntimeLoads = new Map<string, PendingChildRuntimeLoad>();
  private readonly pendingSystemRequests = new Map<string, PendingSystemRequest>();
  private readonly pendingPresentations = new Map<string, {
    child: PreviewRuntime; published: boolean;
    respond: (result: unknown, error?: JsonRecord) => Promise<void>;
  }>();
  /**
   * The editor has one Bluetooth transport: the local Noble helper.  The
   * browser projection is intentionally not allowed to claim a second
   * browser Bluetooth provider; keeping one owner also prevents two
   * previews from racing the same host adapter.
   */
  private webBluetoothOwner?: { clientId: string; lease: string; provider: "local"; queue: JsonRecord[] };
  private readonly localBluetoothScopes = new Set<string>();
  private readonly browserPluginRequests = new Map<string, BrowserPluginRequest>();
  private readonly browserPluginStreams = new Map<string, BrowserPluginRequest>();
  private readonly pointerTargets = new Map<number, PointerTarget>();
  private readonly storage = new Map<string, JsonRecord | null>();
  private previewRecording?: PreviewRecordingState;
  private previewRecordingRestartScheduled = false;
  private nextRecordingRuntimeId = 0;
  private systemCatalog?: SystemCatalog;
  private systemConfigured = false;
  private nextInstanceId = 0;
  /** Root runtime identity changes on every probe rebuild so late browser
   * text-input edits cannot enter a fresh guest with a reused field id. */
  private rootGeneration = 0;
  private nextSystemRequestId = 0;
  private childArtifacts: Record<string, PreviewArtifactPaths> = {};
  /** Root source directory used for browser-served loose media. */
  private mediaProjectDirectory?: string;
  private starting?: Promise<void>;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private tickDeadlineAt?: number;
  // `schedule()` probes are asynchronous and may overlap a tick, input edge,
  // stream subscription, or disposal.  Only the newest probe result may
  // mutate the timer; an older response must not clear a timer installed by a
  // newer demand evaluation.
  private scheduleGeneration = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastUsedAt = monotonicNow();
  private lastTickAt = monotonicNow();
  private nextWakeDelay: number | null = null;
  private artifactRevision?: number;
  private artifactSignature?: string;
  private readonly hotSession = randomUUID();
  private hotVersion?: string;
  private hotBuild?: HotIdentity;
  private hotAcknowledgement?: { nonce: string; result?: JsonRecord };
  private hotReload?: PreviewStatus["hotReload"];
  private frame?: PreviewFrame;
  /** Native FrameResult resources are deltas; retain live assets for a fresh
   * SSE subscriber/snapshot without inflating every animation frame. */
  private readonly resourceCache = new Map<string, Record<string, unknown>>();
  private resourceScope = randomUUID();
  private readonly resourceWireVersions = new WeakMap<object, string>();
  /** Resources removed between compositor frames must be explicitly retired
   * in the browser projection; deleting only the server cache cannot update an
   * already-connected canvas client. */
  private readonly pendingReleasedResources = new Set<string>();
  private state: PreviewStatus["state"] = "stopped";
  private error?: string;
  private width: number;
  private height: number;
  private safeArea: PreviewSafeArea;
  private tickHz: number;
  /** Latest browser accessibility facts, replayed to every newly loaded guest. */
  private accessibilityPreferences?: PreviewAccessibilityPreferences;

  constructor(manager: PreviewManagerImpl, id: string) {
    this.manager = manager;
    this.id = id;
    this.width = manager.options.width ?? 390;
    this.height = manager.options.height ?? 844;
    this.safeArea = boundedSafeArea(
      normalizeSafeArea(manager.options.safeArea),
      this.width,
      this.height,
    );
    this.tickHz = manager.options.tickHz ?? 60;
  }

  private async replayAccessibilityPreferences(runtime: PreviewRuntime): Promise<void> {
    const preferences = this.accessibilityPreferences;
    if (!preferences) return;
    await runtime.probe.checked({
      op: "send",
      message: {
        type: "event",
        name: accessibilityPreferencesEvent,
        payload: { ...preferences },
      },
    });
    runtime.needsPump = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.promise;
    const result = previous.then(operation, operation);
    this.operationTail.promise = result.then(() => undefined, () => undefined);
    return result;
  }

  private signature(artifacts: ResolvedPreviewProject): string {
    // A completed-build token avoids observing a half-written same-revision
    // directory while a build is busy. Generic embedders that do not provide
    // one use the validated file size/mtime fallback below.
    const artifactIdentity = artifacts.generation === undefined
      ? artifacts.artifactFingerprint ?? ""
      : `generation:${String(artifacts.generation)}`;
    return [
      artifacts.revision ?? "",
      artifacts.bytecodePath ?? "",
      artifacts.sourcePath ?? "",
      artifacts.pakPath ?? "",
      artifacts.workerBytecodePath ?? artifacts.workerBytecode ?? "",
      artifacts.workerMetadataPath ?? artifacts.workerMetadata ?? "",
      JSON.stringify(artifacts.workerDescriptor ?? {}),
      JSON.stringify(artifacts.workerHttpOrigins ?? []),
      artifactIdentity,
      JSON.stringify(artifacts.compositorSurfaces ?? {}),
      JSON.stringify(artifacts.applications ?? {}),
    ].join("|");
  }

  private async resolvedArtifacts(): Promise<ResolvedPreviewProject> {
    const artifacts = await this.manager.resolveArtifacts(this.id);
    if (!artifacts) throw new Error(`no preview artifacts were supplied for project ${this.id}`);
    const configuredProjectDirectory = await resolveValue(this.manager.options.projectDirectory, this.id);
    const projectDirectory = configuredProjectDirectory ?? artifacts.projectDirectory;
    const result: PreviewProject = {
      ...artifacts,
      bytecodePath: artifacts.bytecodePath ?? artifacts.bytecode,
      pakPath: artifacts.pakPath ?? artifacts.pak,
      sourcePath: artifacts.sourcePath ?? artifacts.appJs,
      metadataPath: artifacts.metadataPath ?? artifacts.metadata,
      ...(projectDirectory ? { projectDirectory } : {}),
    };
    this.mediaProjectDirectory = projectDirectory;
    this.systemCatalog = await systemCatalogFromProject(projectDirectory);
    this.childArtifacts = (await discoverChildArtifacts(projectDirectory, this.systemCatalog, artifacts.applications)) ?? {};
    if (Object.keys(this.childArtifacts).length > 0) result.applications = this.childArtifacts;
    if (!result.compositorSurfaces) {
      result.compositorSurfaces = await compositorSurfacesFromProject(projectDirectory);
    }
    if (!result.pakPath) throw new Error("preview requires the built app.pak path");
    if (!result.bytecodePath && !result.sourcePath) throw new Error("preview requires app.qjbc or app.js");
    const fingerprints: string[] = [];
    for (const path of [result.bytecodePath, result.sourcePath, result.pakPath]) {
      if (!path) continue;
      if (!existsSync(path)) throw new Error(`preview artifact does not exist: ${path}`);
      const item = await stat(path);
      if (!item.isFile()) throw new Error(`preview artifact is not a regular file: ${path}`);
      fingerprints.push(`${path}:${item.size}:${item.mtimeMs}`);
    }
    for (const [appId, child] of Object.entries(this.childArtifacts)) {
      const bytecodePath = child.bytecodePath ?? child.bytecode;
      const sourcePath = child.sourcePath ?? child.appJs;
      const pakPath = child.pakPath ?? child.pak;
      if (!pakPath || (!bytecodePath && !sourcePath)) throw new Error(`preview child ${appId} requires app.qjbc/app.js and app.pak`);
      for (const path of [bytecodePath, sourcePath, pakPath]) {
        if (!path) continue;
        if (!existsSync(path)) throw new Error(`preview child artifact does not exist: ${path}`);
        const item = await stat(path);
        if (!item.isFile()) throw new Error(`preview child artifact is not a regular file: ${path}`);
        fingerprints.push(`${path}:${item.size}:${item.mtimeMs}`);
      }
    }
    const origins = result.workerHttpOrigins ?? await this.manager.resolveWorkerHttpOrigins(this.id);
    const worker = await resolvePreviewWorker(result, origins);
    if (worker) fingerprints.push(`${worker.bytecodePath}:${(await stat(worker.bytecodePath)).size}:${(await stat(worker.bytecodePath)).mtimeMs}`);
    return { ...result, ...(worker ? { worker } : {}), artifactFingerprint: fingerprints.join(";") };
  }

  /**
   * Resolve the browser's scoped asset name to the source package that owns
   * it. Native child DrawOps are namespaced by `compositeFrame`; keeping the
   * namespace in the URL lets the route reject an arbitrary child/package
   * path instead of trusting a query parameter to select a directory.
   */
  private async mediaSource(asset: string): Promise<{ directory: string; logicalAsset: string } | undefined> {
    const artifacts = await this.resolvedArtifacts();
    const root = this.mediaProjectDirectory ?? artifacts.projectDirectory;
    if (!root || typeof asset !== "string" || !asset) return undefined;
    if (asset.startsWith("pocket.runtime.")) {
      const children = Object.entries(this.childArtifacts)
        .sort(([left], [right]) => right.length - left.length);
      for (const [appId, child] of children) {
        const prefix = `pocket.runtime.${appId}.`;
        if (!asset.startsWith(prefix)) continue;
        const catalogEntry = this.systemCatalog?.catalog.find((entry) => entry.package === appId);
        const directory = child.projectDirectory ??
          (catalogEntry ? resolve(root, catalogEntry.manifest, "..") : resolve(root, "apps", appId));
        return { directory, logicalAsset: asset.slice(prefix.length) };
      }
      return undefined;
    }
    return { directory: root, logicalAsset: asset };
  }

  async serveMedia(request: Request, asset: string | null): Promise<Response> {
    if (!asset) return failure("media asset is required", 400);
    const source = await this.mediaSource(asset);
    if (!source) return failure("preview media scope is unavailable", 404);
    return servePreviewMedia(request, source.directory, source.logicalAsset);
  }

  async ensureStarted(): Promise<void> {
    this.lastUsedAt = monotonicNow();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.disposed) throw new Error("preview session has been disposed");
    const artifacts = await this.resolvedArtifacts();
    const signature = this.signature(artifacts);
    if (this.probe && this.artifactSignature === signature && this.state !== "error") return;
    if (this.starting) return this.starting;
    this.starting = this.enqueue(async () => {
      const nextHotBuild = await hotIdentity(artifacts).catch(() => undefined);
      if (await this.tryHotReplacement(artifacts, signature, nextHotBuild)) return;
      await this.stopProbe();
      this.state = "starting";
      this.error = undefined;
      this.tickHz = artifacts.tickHz ?? this.manager.options.tickHz ?? 60;
      const probePath = await this.manager.findProbe();
      const probe = new NativeProbe(probePath, this.manager.options.commandTimeoutMs ?? 15_000);
      probe.setWakeHandler(() => this.onWorkerWake());
      const recording = this.previewRecordingActive();
      const runtime: PreviewRuntime = {
        appId: this.systemCatalog?.systemUI ?? (artifacts.appId ?? this.id),
        instanceId: "system-ui",
        generation: ++this.rootGeneration,
        probe,
        artifacts,
        ...(artifacts.worker ? { worker: artifacts.worker } : {}),
        viewportWidth: this.width,
        viewportHeight: this.height,
        safeArea: { ...this.safeArea },
        resources: new Map(),
        initialEvents: [],
        pendingBrowserEvents: [],
        needsPump: false,
        pumping: 0,
      };
      probe.setObserver((command, response) => this.observeProbeCommand(runtime, command, response));
      probe.setErrorHandler((error) => this.reportError(error, runtime));
      probe.setDecorator((command) => this.decorateProbeCommand(command));
      this.ensurePreviewRecordingCapture(runtime);
      try {
        await probe.checked({
          op: "create",
          width: this.width,
          height: this.height,
          rasterDensity: this.manager.options.rasterDensity ?? 1,
          tickHz: this.tickHz,
        });
        // Recording is opt-in. A recording request arms a fresh runtime before
        // this method is entered, so the native clock is selected before the
        // first guest load and every transaction can be replayed canonically.
        if (recording) await probe.checked({ op: "traceMode", mode: 1 });
        // The native host attaches the Worker channel bridge during guest
        // initialization, before evaluating UI bytecode. Configure the real
        // QJBC worker first; never eval Worker/UI source in this process.
        if (runtime.worker) {
          await probe.checked({
            op: "configureWorker",
            bytecodePath: runtime.worker.bytecodePath,
            config: { ...runtime.worker.config, nativeGeneration: runtime.generation },
          });
        }
        if (artifacts.compositorSurfaces && Object.keys(artifacts.compositorSurfaces).length > 0) {
          await probe.checked({ op: "compositor", applications: artifacts.compositorSurfaces });
        }
        let loadResponse: JsonRecord;
        if (artifacts.bytecodePath) {
          loadResponse = await probe.checked({
            op: "loadBytecode",
            bytecodePath: artifacts.bytecodePath,
            pakPath: artifacts.pakPath,
            ...(recording ? { render: true, traceClock: {} } : {}),
          });
        } else {
          loadResponse = await probe.checked({
            op: "load",
            sourcePath: artifacts.sourcePath,
            pakPath: artifacts.pakPath,
            ...(recording ? { render: true, traceClock: {} } : {}),
          });
        }
        // A recording load asks the probe to render the first frame in the
        // same native transaction. Install that frame before the normal pump
        // so resources and lifecycle requests are not lost when the browser
        // subscribes after the load response. Host requests are deferred until
        // the runtime is installed below, because SystemUI routing needs the
        // root identity to be visible first.
        if (loadResponse.frame !== undefined) await this.ingestRuntimeFrame(runtime, loadResponse.frame, 0, false);
        // The native resize ABI intentionally remains width/height-only. Send
        // the richer safe-area fact over the existing guest event lane before
        // the first pump so the first admitted frame uses the same geometry as
        // a Flutter host (and never briefly mounts under the notch).
        await sendDisplayViewport(probe, this.width, this.height, this.safeArea);
        await this.replayAccessibilityPreferences(runtime);
        this.probe = probe;
        this.rootRuntime = runtime;
        this.childRuntimes.clear();
        this.pendingSystemRequests.clear();
        this.systemConfigured = false;
        this.nextInstanceId = 0;
        this.nextSystemRequestId = 0;
        this.artifactSignature = signature;
        this.artifactRevision = artifacts.revision;
        this.state = "ready";
        this.lastTickAt = monotonicNow();
        if (runtime.frame) {
          for (const event of runtime.frame.events) {
            if (event && typeof event === "object" && !Array.isArray(event)) {
              await this.handleRuntimeEvent(runtime, event as JsonRecord, 0);
            }
          }
        }
        await this.tickNow(1000 / this.tickHz);
        this.hotBuild = nextHotBuild;
        this.hotVersion = String(artifacts.generation ?? randomUUID());
        if (nextHotBuild) {
          // An ordinary guest does not opt in; it keeps the full QJBC reload path.
          try {
            const bound = await this.hotCommand("bind", { protocol: 1, session: this.hotSession, version: this.hotVersion });
            if (!bound.supported || bound.value !== true) this.hotBuild = undefined;
          }
          catch { this.hotBuild = undefined; }
          // Binding is a native transaction after tickNow's schedule snapshot.
          // Refresh demand so it cannot strand newly due work behind an idle timer.
          await this.schedule();
        }
      } catch (error) {
        await this.finishPreviewRecordingCapture(runtime);
        await probe.stop();
        throw error;
      }
    });
    try {
      await this.starting;
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private async hotCommand(method: "bind" | "prepare" | "commit", argument: unknown): Promise<JsonRecord> {
    const runtime = this.rootRuntime;
    if (!runtime) throw new Error("Hot update has no live root");
    const nonce = randomUUID();
    this.hotAcknowledgement = { nonce };
    try {
      await runtime.probe.checked({ op: "eval", source: hotCommandSource(method, argument, nonce) });
      await this.pumpRuntime(runtime, 0);
      const result = this.hotAcknowledgement.result;
      if (!result) throw new Error("Guest did not acknowledge the hot update");
      return result;
    } finally {
      this.hotAcknowledgement = undefined;
    }
  }

  private async tryHotReplacement(artifacts: ResolvedPreviewProject, signature: string, next?: HotIdentity): Promise<boolean> {
    if (!this.probe || !this.rootRuntime || this.state !== "ready") return false;
    this.hotReload = { mode: "reload", reason: "Guest or build is not compatible with root replacement" };
    if (!next || !this.hotBuild || !this.hotVersion || next.compatibility !== this.hotBuild.compatibility ||
        this.childRuntimes.size || this.childRuntimeLoads.size || this.pointerTargets.size || this.pendingSystemRequests.size ||
        this.browserPluginRequests.size || this.browserPluginStreams.size) return false;
    const transition = { protocol: 1, session: this.hotSession, base: this.hotVersion,
      version: String(artifacts.generation ?? randomUUID()) };
    if (transition.version.length > 128) return false;
    this.scheduleGeneration += 1;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
    this.tickDeadlineAt = undefined;
    try {
      const prepared = await this.hotCommand("prepare", transition);
      if (!prepared.supported) return false;
      // prepare() synchronously disposes the old root. Its lifecycle edges
      // were captured with the old generation above; switch identity before
      // evaluating the replacement so its mount edges receive the new token.
      this.rootRuntime.generation = ++this.rootGeneration;
      await this.probe.checked({ op: "eval", source: next.source });
      const committed = await this.hotCommand("commit", transition);
      if (committed.value !== true) throw new Error("Guest rejected hot update commit");
      this.rootRuntime.artifacts = artifacts;
      this.systemConfigured = false;
      this.artifactSignature = signature;
      this.artifactRevision = artifacts.revision;
      this.hotBuild = next;
      this.hotVersion = transition.version;
      this.hotReload = { mode: "replace" };
      this.lastTickAt = monotonicNow();
      // A hot replacement remounts the root guest without replacing the
      // PreviewSession. Re-emit the cached host fact so the new guest observes
      // the same accessibility state before its first settled frame.
      await this.replayAccessibilityPreferences(this.rootRuntime);
      await this.tickNow(0);
      this.emit({ type: "status", ...this.status() });
      return true;
    } catch (error) {
      // A partly evaluated root cannot be trusted. The caller replaces the VM
      // from the completed QJBC build instead of continuing a damaged realm.
      this.hotReload = { mode: "reload", reason: errorText(error) };
      return false;
    }
  }

  private async stopProbe(): Promise<void> {
    // Invalidate any in-flight root/child schedule probes before tearing down
    // the timer and probe. Their eventual responses must be side-effect free.
    this.scheduleGeneration += 1;
    this.pendingPresentations.clear();
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
    this.tickDeadlineAt = undefined;
    const childLoads = [...this.childRuntimeLoads.values()];
    this.childRuntimeLoads.clear();
    for (const load of childLoads) load.cancelled = true;
    await Promise.all(childLoads.map((load) => this.stopChildRuntimeLoad(load)));
    const stopError = new Error("preview runtime stopped before the SystemUI request completed");
    for (const [requestId, pending] of this.pendingSystemRequests) {
      this.pendingSystemRequests.delete(requestId);
      pending.reject(stopError);
    }
    const probe = this.probe;
    this.probe = undefined;
    const children = [...this.childRuntimes.values()];
    const runtimes = [
      ...(this.rootRuntime ? [this.rootRuntime] : []),
      ...children,
    ];
    // A child may be intentionally destroyed while a recording continues on
    // the root. Close its native trace clock before stopping its probe so the
    // completed capture is exportable instead of being misclassified as a
    // transport failure by the later global teardown.
    for (const runtime of runtimes) {
      await runtime.live2d?.dispose();
      runtime.live2d = undefined;
      await this.finishPreviewRecordingCapture(runtime);
    }
    if (this.rootRuntime) {
      this.emitWebBluetoothScopeDispose(this.rootRuntime);
      await this.failBrowserPluginRuntime(this.rootRuntime, "runtime_stopped", "preview runtime stopped");
    }
    for (const runtime of children) {
      this.emitWebBluetoothScopeDispose(runtime);
      await this.failBrowserPluginRuntime(runtime, "runtime_stopped", "preview runtime stopped");
    }
    this.childRuntimes.clear();
    this.rootRuntime = undefined;
    this.pointerTargets.clear();
    await Promise.all(children.map((runtime) => runtime.probe.stop()));
    this.artifactSignature = undefined;
    this.nextWakeDelay = null;
    for (const asset of this.resourceCache.keys()) this.pendingReleasedResources.add(asset);
    this.resourceCache.clear();
    this.resourceScope = randomUUID();
    if (probe) await probe.stop();
  }

  /** Resource bytes travel independently so a large texture cannot hold up animation SSE. */
  private resourceWireVersion(resource: Record<string, unknown>): string {
    let version = this.resourceWireVersions.get(resource);
    if (!version) {
      version = randomUUID();
      this.resourceWireVersions.set(resource, version);
    }
    return version;
  }

  serveResource(request: Request): Response {
    const query = new URL(request.url).searchParams;
    const resource = this.resourceCache.get(query.get("asset") ?? "");
    const part = query.get("part");
    if (query.get("scope") !== this.resourceScope || !resource ||
        this.resourceWireVersion(resource) !== query.get("revision") ||
        (part !== "pixels" && part !== "palette") ||
        !(Array.isArray(resource[part]) || resource.bytesEncoding === "base64" && typeof resource[part] === "string")) {
      return new Response("resource not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const bytes = previewBytes(resource[part], resource.bytesEncoding);
    return new Response(request.method === "HEAD" ? null : bytes, { headers: {
      "content-type": "application/octet-stream", "cache-control": "no-store",
      "content-length": String(bytes.byteLength),
    } });
  }

  private encodeExternalPacket(value: unknown): Uint8Array {
    const candidate = value as { type?: string; frame?: PreviewFrame } | null;
    if (candidate?.type !== "frame" || !Array.isArray(candidate.frame?.resources)) return encodePreviewStreamPacket(value);
    const resources = candidate.frame.resources.map(resource => {
      const encoded = resource.bytesEncoding === "base64";
      if (!Array.isArray(resource.pixels) && !(encoded && typeof resource.pixels === "string")) return resource;
      const { pixels, palette, ...metadata } = resource;
      const url = (part: string) => {
        const query = new URLSearchParams({ asset: String(resource.asset), revision: this.resourceWireVersion(resource), scope: this.resourceScope, part });
        return `/api/projects/${encodeURIComponent(this.id)}/preview/resource?${query}`;
      };
      const byteLength = (value: unknown) => encoded && typeof value === "string"
        ? Buffer.byteLength(value, "base64") : Array.isArray(value) ? value.length : 0;
      return { ...metadata, bytesEncoding: "external", pixelsUrl: url("pixels"), pixelsBytes: byteLength(pixels),
        ...(Array.isArray(palette) || encoded && typeof palette === "string" ? { paletteUrl: url("palette"), paletteBytes: byteLength(palette) } : {}) };
    });
    return encodePreviewStreamPacket({ ...candidate, frame: { ...candidate.frame, resources } });
  }

  private updateResourceCache(frame: PreviewFrame): void {
    for (const value of frame.resources) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const resource = value as Record<string, unknown>;
      const asset = resource.asset;
      if (typeof asset === "string" && asset.length > 0) this.resourceCache.set(asset, resource);
    }
    for (const value of frame.releasedResources ?? []) {
      if (typeof value === "string") this.resourceCache.delete(value);
    }
  }

  private dropRuntimeResources(appId: string): void {
    const prefix = `pocket.runtime.${appId}.`;
    for (const asset of [...this.resourceCache.keys()]) {
      if (!asset.startsWith(prefix)) continue;
      this.resourceCache.delete(asset);
      this.pendingReleasedResources.add(asset);
    }
  }

  private replayFrame(): PreviewFrame | undefined {
    if (!this.frame) return undefined;
    const liveAssets = new Set(this.resourceCache.keys());
    const releasedResources = new Set<string>();
    for (const asset of [...(this.frame.releasedResources ?? []), ...this.pendingReleasedResources]) {
      if (typeof asset === "string" && asset.length > 0 && !liveAssets.has(asset)) releasedResources.add(asset);
    }
    return {
      ...this.frame,
      resources: [...this.resourceCache.values()],
      releasedResources: [...releasedResources],
    };
  }

  isIdle(): boolean {
    return this.subscribers.size === 0 && !this.starting;
  }

  touch(): void {
    this.lastUsedAt = monotonicNow();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  idleSince(): number {
    return this.lastUsedAt;
  }

  armIdleCleanup(): void {
    this.touch();
    const delay = this.manager.options.idleDisposeMs ?? 5_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.isIdle()) void this.manager.evict(this.id).catch((error) => this.reportError(error));
    }, Math.max(1000, delay));
  }

  private emit(value: unknown): void {
    let canonical: Uint8Array | undefined;
    let compact: Uint8Array | undefined;
    let external: Uint8Array | undefined;
    let subscriberDropped = false;
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      try {
        const bytes = subscriber.externalResources
          ? (external ??= this.encodeExternalPacket(value))
          : subscriber.compactResources
          ? (compact ??= encodePreviewStreamPacket(value, true))
          : (canonical ??= encodePreviewStreamPacket(value));
        subscriber.controller.enqueue(bytes);
      } catch {
        subscriber.closed = true;
        this.subscribers.delete(subscriber);
        subscriberDropped = true;
      }
    }
    if (subscriberDropped) {
      this.failPendingPresentationsIfBrowserGone();
      this.cancelActivePointersIfBrowserGone();
    }
  }

  private pluginRequestKey(token: string, id: string): string {
    return `${token}\u0000${id}`;
  }

  /** Claim the one Noble adapter allowed to service this preview. */
  claimWebBluetooth(clientId: string, provider: "web" | "local" = "local"): { clientId: string; lease: string } | undefined {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) return undefined;
    // `web` is retained as a wire-level compatibility value for older editor
    // links, but it must never select a browser Bluetooth plugin.
    if (provider !== "local" || !this.manager.options.localBluetooth) return undefined;
    const current = this.webBluetoothOwner;
    if (current && (current.clientId !== clientId || current.provider !== provider)) return undefined;
    if (current && this.pluginSubscriber()) return undefined;
    if (!current) this.webBluetoothOwner = { clientId, lease: randomUUID(), provider: "local", queue: [] };
    this.touch();
    return { clientId, lease: this.webBluetoothOwner!.lease };
  }

  private pluginSubscriber(): Subscriber | undefined {
    const owner = this.webBluetoothOwner;
    if (!owner) return undefined;
    return [...this.subscribers].find((subscriber) =>
      !subscriber.closed && subscriber.webBluetooth?.clientId === owner.clientId && subscriber.webBluetooth.lease === owner.lease);
  }

  private emitWebBluetoothRequest(request: BrowserPluginRequest, params: JsonRecord = {}): void {
    const owner = this.webBluetoothOwner;
    if (!owner || owner.clientId !== request.clientId || owner.lease !== request.lease) return;
    const provider = this.manager.options.localBluetooth!;
    const scope = `${this.id}:${owner.lease}:${request.runtime.instanceId}:${request.runtime.generation}`;
    if (request.kind === "scope.dispose") this.localBluetoothScopes.delete(scope);
    else this.localBluetoothScopes.add(scope);
    const deliver = (message: JsonRecord) => {
      void this.enqueue(() => this.handleBrowserPluginMessage({ clientId: owner.clientId, token: request.token, message }))
        .catch((error) => this.reportError(error));
    };
    void provider.handle({ scope, kind: request.kind, requestId: request.requestId, capability: request.capability, streamId: request.streamId, topic: request.kind === "stream.open" ? "hardware.bluetooth.notifications" : undefined, params }, deliver)
      .catch((error) => {
        const failure = hostError("hardware_bluetooth_error", errorText(error));
        if (request.kind === "request") deliver({ type: "event", name: "host.response", payload: { requestId: request.requestId, capability: request.capability, ok: false, error: failure } });
        else if (request.kind === "stream.open") deliver({ type: "event", name: "stream.error", payload: { streamId: request.streamId, error: failure } });
      });
  }

  private emitWebBluetoothScopeDispose(runtime: PreviewRuntime): void {
    const owner = this.webBluetoothOwner;
    if (!owner) return;
    this.emitWebBluetoothRequest({
      token: randomUUID(),
      clientId: owner.clientId,
      lease: owner.lease,
      runtime,
      kind: "scope.dispose",
    }, {});
  }

  private armBrowserPluginTimeout(request: BrowserPluginRequest, stream: boolean): void {
    if (request.kind === "scope.dispose") return;
    request.timer = setTimeout(() => {
      const key = this.pluginRequestKey(request.token, stream ? request.streamId! : request.requestId!);
      const map = stream ? this.browserPluginStreams : this.browserPluginRequests;
      if (map.get(key) !== request) return;
      map.delete(key);
      const failure = hostError("hardware_bluetooth_error", "Noble Bluetooth adapter response timed out");
      void this.enqueue(async () => {
        if (stream) {
          await request.runtime.probe.checked({ op: "send", message: { type: "event", name: "stream.error", payload: { streamId: request.streamId, error: failure } } });
          request.runtime.needsPump = true;
        } else {
          await this.sendHostResponse(request.runtime, request.requestId!, request.capability!, null, failure);
        }
        await this.tickNow(0);
      }).catch((error) => this.reportError(error));
    }, browserPluginTimeoutMs);
  }

  private clearBrowserPluginTimer(request: BrowserPluginRequest | undefined): void {
    if (request?.timer) clearTimeout(request.timer);
    if (request) request.timer = undefined;
  }

  /**
   * Remove browser-plugin work owned by a runtime before its probe can be
   * stopped or replaced.  Keeping the request token alive after teardown
   * would route a late browser reply into a dead probe (or, worse, a rebuilt
   * runtime that happens to reuse the same guest request id).
   */
  private takeBrowserPluginRuntime(runtime: PreviewRuntime): {
    requests: BrowserPluginRequest[];
    streams: BrowserPluginRequest[];
  } {
    const requests = [...this.browserPluginRequests.values()].filter((request) => request.runtime === runtime);
    const streams = [...this.browserPluginStreams.values()].filter((request) => request.runtime === runtime);
    for (const request of [...requests, ...streams]) this.clearBrowserPluginTimer(request);
    for (const [key, request] of this.browserPluginRequests) {
      if (request.runtime === runtime) this.browserPluginRequests.delete(key);
    }
    for (const [key, request] of this.browserPluginStreams) {
      if (request.runtime === runtime) this.browserPluginStreams.delete(key);
    }
    return { requests, streams };
  }

  private async failBrowserPluginRuntime(
    runtime: PreviewRuntime,
    code: string,
    message: string,
  ): Promise<void> {
    const { requests, streams } = this.takeBrowserPluginRuntime(runtime);
    if (requests.length === 0 && streams.length === 0) return;
    const failure = hostError(code, message);
    for (const request of requests) {
      try {
        await this.sendHostResponse(runtime, request.requestId!, request.capability!, null, failure);
      } catch {
        // Runtime teardown is already in progress.  The important invariant
        // is that the token is retired; a stopped probe cannot be repaired by
        // reporting this best-effort rejection as a session error.
      }
    }
    for (const stream of streams) {
      try {
        await runtime.probe.checked({
          op: "send",
          message: { type: "event", name: "stream.error", payload: { streamId: stream.streamId, error: failure } },
        });
        runtime.needsPump = true;
      } catch {
        // See the request path above: stale stream work is intentionally
        // discarded when the owning runtime is no longer usable.
      }
    }
  }

  private releaseWebBluetoothOwner(lease?: string): void {
    const owner = this.webBluetoothOwner;
    if (!owner || (lease && owner.lease !== lease)) return;
    const requests = [...this.browserPluginRequests.values()].filter((request) => request.lease === owner.lease);
    const streams = [...this.browserPluginStreams.values()].filter((request) => request.lease === owner.lease);
    for (const request of [...requests, ...streams]) this.clearBrowserPluginTimer(request);
    for (const [key, request] of this.browserPluginRequests) {
      if (request.lease === owner.lease) this.browserPluginRequests.delete(key);
    }
    for (const [key, request] of this.browserPluginStreams) {
      if (request.lease === owner.lease) this.browserPluginStreams.delete(key);
    }
    this.webBluetoothOwner = undefined;
    if (owner.provider === "local") {
      for (const scope of [...this.localBluetoothScopes]) {
        if (!scope.startsWith(`${this.id}:${owner.lease}:`)) continue;
        this.localBluetoothScopes.delete(scope);
        void this.manager.options.localBluetooth?.handle({ scope, kind: "scope.dispose" }, () => {}).catch(() => {});
      }
    }
    if (requests.length || streams.length) {
      void this.enqueue(async () => {
        const failure = hostError("hardware_bluetooth_disconnected", "Noble Bluetooth preview adapter was disabled");
        for (const request of requests) {
          await this.sendHostResponse(request.runtime, request.requestId!, request.capability!, null, failure);
        }
        for (const stream of streams) {
          await stream.runtime.probe.checked({
            op: "send",
            message: { type: "event", name: "stream.error", payload: { streamId: stream.streamId, error: failure } },
          });
          stream.runtime.needsPump = true;
        }
        if (this.probe) await this.tickNow(0);
      }).catch((error) => this.reportError(error));
    }
  }

  private flushWebBluetoothQueue(subscriber: Subscriber): void {
    const owner = this.webBluetoothOwner;
    if (!owner || !subscriber.webBluetooth || subscriber.webBluetooth.lease !== owner.lease) return;
    const queue = owner.queue.splice(0);
    for (const packet of queue) {
      try { subscriber.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet)}\n\n`)); } catch {
        subscriber.closed = true;
        this.subscribers.delete(subscriber);
        this.releaseWebBluetoothOwner(owner.lease);
        break;
      }
    }
  }

  private hasBrowserPresentationSubscriber(): boolean {
    return [...this.subscribers].some((subscriber) => subscriber.browserPresentation && !subscriber.closed);
  }

  /**
   * A browser presentation ACK is the only successful completion of
   * awaitFirstFrame while a browser projection is connected. If that last
   * projection disappears, reject the native JS request on the serialized
   * session queue and give SystemUI one real pump turn to observe the error.
   * Never turn a lost browser presentation into a synthetic `ready` result.
   */
  private failPendingPresentationsIfBrowserGone(): void {
    if (this.disposed || this.pendingPresentations.size === 0 || this.hasBrowserPresentationSubscriber()) return;
    void this.enqueue(async () => {
      if (this.disposed || this.pendingPresentations.size === 0 || this.hasBrowserPresentationSubscriber()) return;
      let firstError: unknown;
      const failure = hostError("presentation_unavailable", "browser presentation disconnected before the first frame was presented");
      for (const [token, pending] of [...this.pendingPresentations]) {
        if (this.pendingPresentations.get(token) !== pending) continue;
        try {
          await pending.respond(null, failure);
        } catch (error) {
          firstError ??= error;
        } finally {
          this.pendingPresentations.delete(token);
        }
      }
      // The failed host response is queued on the root probe. Pumping here is
      // what lets QuickJS reject its pending awaitFirstFrame promise without
      // waiting for an unrelated input edge or a fabricated presentation ACK.
      if (this.rootRuntime && this.probe) {
        try {
          await this.tickNow(0);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    }).catch((error) => this.reportError(error));
  }

  private runtimeResourceCache(runtime: PreviewRuntime, frame: PreviewFrame): void {
    for (const value of frame.resources) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const resource = value as JsonRecord;
      const asset = resource.asset;
      if (typeof asset === "string" && asset.length > 0) runtime.resources.set(asset, resource);
    }
    for (const value of frame.releasedResources ?? []) {
      if (typeof value === "string") runtime.resources.delete(value);
    }
  }

  private recordableProbeCommand(command: JsonRecord): boolean {
    const operation = command.op;
    if (!["create", "compositor", "configureWorker", "load", "loadBytecode", "eval", "frame", "send", "sendBinary", "resize"].includes(String(operation))) return false;
    // Recording control responses are real guest-visible boundaries. The
    // initial start response is sent while the old runtime is pending restart
    // (and is therefore intentionally not captured); active status/repeated
    // start responses remain part of the canonical send lane.
    return true;
  }

  private previewRecordingActive(): boolean {
    const state = this.previewRecording;
    return !!state?.enabled && !state.stopped && !state.pendingRestart && !state.incompleteReason;
  }

  private decorateProbeCommand(command: JsonRecord): JsonRecord {
    // The native trace clock is installed only on an armed recording runtime.
    // This keeps ordinary preview animation on the same allocation-free probe
    // path as before recording was requested.
    if (!this.previewRecordingActive() || command.op === "create" || !this.recordableProbeCommand(command)) return command;
    const decorated = command.traceClock !== undefined ? command : { ...command, traceClock: {} };
    // PocketReplayRunner's eval lane always returns a canonical frame summary;
    // ask the native probe for that same eval+frame transaction while tracing.
    return command.op === "eval" && command.render === undefined
      ? { ...decorated, render: true }
      : decorated;
  }

  private async observeProbeCommand(runtime: PreviewRuntime, command: JsonRecord, response: JsonRecord): Promise<void> {
    if (command.op === "load" || command.op === "loadBytecode") {
      await this.manager.options.diagnostics?.recordLog({
        source: "studio.preview", projectId: this.id, runtimeId: runtime.appId,
        revision: this.artifactRevision, message: "Guest bytecode loaded",
        data: { generation: runtime.generation, instanceId: runtime.instanceId },
      }).catch((error) => console.error("Preview lifecycle log could not be persisted", error));
    }
    if (!this.previewRecordingActive() || !this.recordableProbeCommand(command)) return;
    const item: PreviewProbeHistoryEntry = {
      command: cloneJson(command),
      // Frame payloads can contain full atlas pixels. Keep only the small
      // transaction result fields in the entry; the digest below reads the
      // live response once without cloning that payload first.
      response: Object.fromEntries(
        Object.entries(response)
          .filter(([key]) => key !== "frame")
          .map(([key, value]) => [key, cloneJson(value)]),
      ),
    };
    if (response.frame && typeof response.frame === "object" && !Array.isArray(response.frame)) {
      try {
        item.frameSummary = previewFrameSummary(asFrame(response.frame));
      } catch {
        // A malformed frame is surfaced by pumpRuntime. History must never
        // turn an ordinary guest failure into an observer failure.
      }
    }
    const state = this.previewRecording;
    if (!state) return;
    const capture = state.captures.get(runtime);
    if (!capture || capture.stopped) return;
    try {
      if (command.op === "create") {
        const args = cloneJson(command);
        delete args.op;
        capture.createArgs = args;
      }
      const entry = await this.recordingEntryFromHistory(capture, item);
      if (entry) this.appendPreviewRecordingEntry(capture, entry);
    } catch (error) {
      capture.incompleteReason ??= `probe boundary capture failed: ${errorText(error)}`;
      state.incompleteReason ??= capture.incompleteReason;
    }
  }

  private appendPreviewRecordingEntry(capture: PreviewRecordingCapture, entry: PreviewRecordingEntry): void {
    if (capture.entries.length >= previewRecordingMaxEntries) {
      capture.incompleteReason ??= "maxEntries exceeded";
      return;
    }
    entry.index = capture.entries.length;
    const bytes = new TextEncoder().encode(canonicalPreviewJson(entry)).byteLength;
    if (bytes > previewRecordingMaxBytes - capture.bytes) {
      capture.incompleteReason ??= "maxBytes exceeded";
      return;
    }
    capture.entries.push(entry);
    capture.bytes += bytes;
  }

  private async recordingAsset(
    capture: PreviewRecordingCapture,
    kind: string,
    path: string,
  ): Promise<JsonRecord> {
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength > previewRecordingMaxAssets) throw new Error(`${kind} asset exceeds preview recording limit`);
    const sha256 = sha256Hex(bytes);
    const key = `${kind}:${sha256.slice(0, 16)}`;
    const existing = capture.assets.get(sha256);
    if (existing) return cloneJson(existing.descriptor);
    const descriptor: JsonRecord = { bytes: bytes.byteLength, sha256, key };
    capture.assets.set(sha256, { descriptor, path, bytes });
    capture.contentHashes[kind] = sha256;
    return cloneJson(descriptor);
  }

  private async recordingEntryFromHistory(
    capture: PreviewRecordingCapture,
    item: PreviewProbeHistoryEntry,
  ): Promise<PreviewRecordingEntry | undefined> {
    const command = item.command;
    const operation = command.op;
    // `create` is a native runtime setup boundary, not the canonical
    // auxiliary-surface entry. PocketReplayRunner creates the runtime from
    // recording metadata and only accepts `auxiliary` for its actual
    // enableAuxiliary(width,height) transaction, so retain create arguments
    // on the capture metadata and omit a synthetic entry.
    if (operation === "create") return undefined;
    const rawTraceClock = item.response.traceClock;
    if (!rawTraceClock || typeof rawTraceClock !== "object" || Array.isArray(rawTraceClock)) {
      throw new Error(`native trace clock missing for ${String(operation)}`);
    }
    const traceClock = cloneJson(rawTraceClock);
    if (!Array.isArray(traceClock.idleMs) || !Array.isArray(traceClock.scalars)) {
      throw new Error(`native trace clock envelope is incomplete for ${String(operation)}`);
    }
    if (operation === "compositor") {
      return {
        index: 0,
        kind: "compositor",
        args: { applications: cloneJson(command.applications) },
        result: { configured: true, traceClock },
        error: null,
      };
    }
    if (operation === "configureWorker") {
      if (typeof command.bytecodePath !== "string" || !command.config || typeof command.config !== "object" || Array.isArray(command.config)) {
        throw new Error("configureWorker paths/config are missing");
      }
      const config = cloneJson(command.config) as JsonRecord;
      const configSha256 = sha256Hex(canonicalPreviewJson(config));
      return {
        index: 0,
        kind: "workerConfigure",
        args: {
          workerBytecode: await this.recordingAsset(capture, "workerBytecode", command.bytecodePath),
          config,
          configSha256,
        },
        result: { configured: true, traceClock },
        error: null,
      };
    }
    if (operation === "loadBytecode" || operation === "load") {
      const args: JsonRecord = {};
      if (operation === "loadBytecode") {
        if (typeof command.bytecodePath !== "string" || typeof command.pakPath !== "string") throw new Error("loadBytecode paths are missing");
        args.bytecode = await this.recordingAsset(capture, "bytecode", command.bytecodePath);
        args.pak = await this.recordingAsset(capture, "pak", command.pakPath);
        if (typeof item.response.runtimeAbi === "string") {
          capture.engineAbi = item.response.runtimeAbi;
          args.expectedRuntimeAbi = item.response.runtimeAbi;
        }
      } else {
        if (typeof command.sourcePath !== "string" || typeof command.pakPath !== "string") throw new Error("load paths are missing");
        args.source = await this.recordingAsset(capture, "source", command.sourcePath);
        args.pak = await this.recordingAsset(capture, "pak", command.pakPath);
      }
      if (item.frameSummary) return { index: 0, kind: operation, args, result: { frame: item.frameSummary, traceClock }, error: null };
      return { index: 0, kind: operation, args, result: { traceClock }, error: null };
    }
    if (operation === "frame") {
      const result: JsonRecord = { traceClock };
      if (item.frameSummary) result.frame = item.frameSummary;
      return { index: 0, kind: "frame", args: { deltaMs: command.deltaMs }, result, error: null };
    }
    if (operation === "send") {
      return { index: 0, kind: "send", args: { message: cloneJson(command.message) }, result: { sent: true, traceClock }, error: null };
    }
    if (operation === "sendBinary") {
      return { index: 0, kind: "send", args: { binaryBase64: command.base64 }, result: { sent: true, traceClock }, error: null };
    }
    if (operation === "resize") {
      return { index: 0, kind: "resize", args: { width: command.width, height: command.height }, result: { resized: true, traceClock }, error: null };
    }
    if (operation === "eval") {
      const result: JsonRecord = { traceClock };
      if (item.frameSummary) result.frame = item.frameSummary;
      return { index: 0, kind: "eval", args: { source: command.source }, result, error: null };
    }
    return undefined;
  }

  private createPreviewRecordingCapture(runtime: PreviewRuntime): PreviewRecordingCapture {
    return {
      id: `${++this.nextRecordingRuntimeId}-${runtime.appId}`,
      appId: runtime.appId,
      runtime,
      entries: [],
      bytes: 0,
      assets: new Map(),
      contentHashes: {},
      stopped: false,
    };
  }

  private ensurePreviewRecordingCapture(runtime: PreviewRuntime): PreviewRecordingCapture | undefined {
    const state = this.previewRecording;
    if (!state || !state.enabled || state.stopped || state.pendingRestart) return undefined;
    const existing = state.captures.get(runtime);
    if (existing) return existing;
    if (state.captures.size >= previewRecordingMaxRuntimes) {
      state.incompleteReason ??= `maxRuntimes exceeded (${previewRecordingMaxRuntimes})`;
      return undefined;
    }
    const capture = this.createPreviewRecordingCapture(runtime);
    state.captures.set(runtime, capture);
    return capture;
  }

  /** Finish one live capture before its native probe is destroyed. */
  private async finishPreviewRecordingCapture(runtime: PreviewRuntime): Promise<void> {
    const state = this.previewRecording;
    const capture = state?.captures.get(runtime);
    if (!state || !capture || capture.stopped || state.pendingRestart) return;
    try {
      await runtime.probe.checked({ op: "traceMode", mode: 0 });
    } catch (error) {
      capture.incompleteReason ??= `native trace clock stop failed: ${errorText(error)}`;
      state.incompleteReason ??= capture.incompleteReason;
    } finally {
      // A successful child destroy is a completed runtime boundary. Mark it
      // stopped even when the probe reports a close error; the error remains
      // explicit above and export will reject rather than silently omit it.
      capture.stopped = true;
    }
  }

  private previewRecordingStatus(): JsonRecord {
    const state = this.previewRecording;
    if (!state) return { enabled: false, recording: false, stopped: false, incomplete: false, runtimes: [] };
    const runtimes = [...state.captures.values()].map((capture) => ({
      id: capture.id,
      appId: capture.appId,
      entries: capture.entries.length,
      bytes: capture.bytes,
      finished: capture.stopped,
      incomplete: capture.incompleteReason !== undefined,
    }));
    const incomplete = state.incompleteReason !== undefined || [...state.captures.values()].some((capture) => capture.incompleteReason !== undefined);
    return {
      enabled: state.enabled,
      recording: state.enabled && !state.stopped && !incomplete,
      stopped: state.stopped,
      restarting: state.pendingRestart,
      incomplete,
      ...(state.incompleteReason ? { reason: state.incompleteReason } : {}),
      runtimes,
    };
  }

  private async publishPreviewRecordingStarted(): Promise<void> {
    const state = this.previewRecording;
    const runtime = this.rootRuntime;
    if (!state || state.stopped || state.pendingRestart || !runtime) return;
    const status = this.previewRecordingStatus();
    await runtime.probe.checked({
      op: "send",
      message: { type: "event", name: "diagnostics.recording.started", payload: status },
    });
    runtime.needsPump = true;
    // The event is a real guest input boundary. Deliver it on the new probe
    // before exposing the first post-start frame to subscribers.
    await this.tickNow(0);
  }

  private async restartPreviewRuntimeForRecording(state: PreviewRecordingState): Promise<void> {
    if (this.previewRecording !== state || state.stopped) return;
    await this.stopProbe();
    if (this.previewRecording !== state || state.stopped) return;
    state.pendingRestart = false;
    await this.ensureStarted();
    await this.publishPreviewRecordingStarted();
  }

  private schedulePreviewRecordingRestart(state: PreviewRecordingState): void {
    if (this.previewRecordingRestartScheduled) return;
    this.previewRecordingRestartScheduled = true;
    // The start request is handled while the old runtime is pumping. Wait for
    // that serialized turn to finish before destroying its probe; otherwise
    // the host.response would be sent to a closed transport.
    const tail = this.operationTail.promise;
    void tail
      .then(() => this.restartPreviewRuntimeForRecording(state))
      .catch((error) => {
        if (this.previewRecording === state) {
          state.incompleteReason ??= `preview recording start failed: ${errorText(error)}`;
          state.pendingRestart = false;
        }
        this.reportError(error);
      })
      .finally(() => { this.previewRecordingRestartScheduled = false; });
  }

  private async startPreviewRecording(runtime: PreviewRuntime): Promise<JsonRecord> {
    if (this.previewRecording?.enabled && !this.previewRecording.stopped) return this.previewRecordingStatus();
    const state: PreviewRecordingState = {
      enabled: true,
      stopped: false,
      pendingRestart: true,
      captures: new Map(),
    };
    this.previewRecording = state;
    this.nextRecordingRuntimeId = 0;
    try {
      // A native trace clock must be selected before load. Rebuild the live
      // probe only for an explicit recording request; ordinary preview never
      // pays for trace envelopes, command history, or frame digests.
      if (runtime.pumping > 0) this.schedulePreviewRecordingRestart(state);
      else await this.restartPreviewRuntimeForRecording(state);
      return this.previewRecordingStatus();
    } catch (error) {
      if (this.previewRecording === state) this.previewRecording = undefined;
      throw new Error(`preview recording start failed: ${errorText(error)}`);
    }
  }

  private async stopPreviewRecording(): Promise<JsonRecord> {
    const state = this.previewRecording;
    if (!state) return this.previewRecordingStatus();
    if (!state.pendingRestart) {
      for (const capture of state.captures.values()) await this.finishPreviewRecordingCapture(capture.runtime);
    }
    state.stopped = true;
    state.pendingRestart = false;
    for (const capture of state.captures.values()) capture.stopped = true;
    return this.previewRecordingStatus();
  }

  private previewRecordingDocument(capture: PreviewRecordingCapture): JsonRecord {
    const create = capture.createArgs;
    const width = Number(create?.width ?? capture.runtime.viewportWidth);
    const height = Number(create?.height ?? capture.runtime.viewportHeight);
    const density = Number(create?.rasterDensity ?? this.manager.options.rasterDensity ?? 1);
    const tickHz = Number(create?.tickHz ?? this.tickHz);
    const bytes = capture.bytes;
    const memory = create?.memory && typeof create.memory === "object" && !Array.isArray(create.memory)
      ? cloneJson(create.memory)
      : undefined;
    const version = capture.entries.some((entry) => {
      const clock = entry.result.traceClock;
      return !!clock && typeof clock === "object" && (clock as JsonRecord).version === 2;
    }) ? 2 : 1;
    const recording: JsonRecord = {
      schema: "pocket.runtime.recording",
      version,
      metadata: {
        width,
        height,
        density,
        tickHz,
        engineAbi: capture.engineAbi ?? null,
        contentHashes: capture.contentHashes,
        ...(memory && Object.keys(memory).length > 0 ? { memory } : {}),
      },
      limits: { maxEntries: previewRecordingMaxEntries, maxBytes: previewRecordingMaxBytes },
      bytes,
      incomplete: capture.incompleteReason !== undefined,
      incompleteReason: capture.incompleteReason ?? null,
      entries: capture.entries,
    };
    return recording;
  }

  private async exportPreviewRecording(params: JsonRecord): Promise<JsonRecord> {
    const state = this.previewRecording;
    if (!state || state.captures.size === 0) throw new Error("No guest has been recorded");
    if (!state.stopped) await this.stopPreviewRecording();
    if (state.incompleteReason || [...state.captures.values()].some((capture) => capture.incompleteReason)) {
      throw new Error(state.incompleteReason ?? "Incomplete guest recording");
    }
    const recordings: Record<string, JsonRecord> = {};
    const assets = new Map<string, Uint8Array>();
    for (const capture of state.captures.values()) {
      const recording = this.previewRecordingDocument(capture);
      recordings[capture.id] = recording;
      for (const [sha256, asset] of capture.assets) assets.set(sha256, asset.bytes);
    }
    if (assets.size > 128 || [...assets.values()].reduce((total, bytes) => total + bytes.byteLength, 0) > previewRecordingMaxAssets) {
      throw new Error("Archive asset limits exceeded");
    }
    const status = this.previewRecordingStatus();
    const inputTape = params.inputTape;
    if (inputTape !== undefined && (!inputTape || typeof inputTape !== "object" || Array.isArray(inputTape) || new TextEncoder().encode(JSON.stringify(inputTape)).byteLength > 256 * 1024)) {
      throw new Error("Upstream input tape must be a bounded object");
    }
    const document: JsonRecord = {
      schema: "pocket.recording.archive",
      version: 1,
      status,
      ...(inputTape === undefined ? {} : { upstreamInputTape: cloneJson(inputTape) }),
      recordings,
    };
    const directory = join(tmpdir(), `pocket-preview-recording-${this.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${randomUUID()}`);
    await mkdir(join(directory, "assets"), { recursive: true });
    for (const [sha256, bytes] of assets) await writeFile(join(directory, "assets", `${sha256}.bin`), bytes);
    const manifest = join(directory, "recordings.json");
    await writeFile(manifest, JSON.stringify(document));
    return { path: manifest, runtimeCount: Object.keys(recordings).length, ...status };
  }

  private previewAssetPath(capture: PreviewRecordingCapture, descriptor: unknown): string {
    const value = asRecord(descriptor, "recording asset descriptor");
    const sha256 = value.sha256;
    if (typeof sha256 !== "string") throw new Error("recording asset SHA-256 is missing");
    const asset = capture.assets.get(sha256);
    if (!asset) throw new Error(`recording asset ${sha256} is unavailable`);
    return asset.path;
  }

  private async replayPreviewCapture(capture: PreviewRecordingCapture): Promise<JsonRecord> {
    if (capture.incompleteReason || capture.entries.length === 0) {
      return {
        matched: false,
        replayable: false,
        entriesReplayed: 0,
        framesCompared: 0,
        rejection: capture.incompleteReason ?? "recording contains no transactions",
      };
    }
    const probe = new NativeProbe(await this.manager.findProbe(), this.manager.options.commandTimeoutMs ?? 15_000);
    let entriesReplayed = 0;
    let framesCompared = 0;
    try {
      // `create` is runtime setup rather than a PocketRecording entry. Reopen
      // the probe from the captured metadata, then select native replay mode
      // before the first traced load/compositor transaction.
      const create = cloneJson(capture.createArgs ?? {
        width: capture.runtime.viewportWidth,
        height: capture.runtime.viewportHeight,
        rasterDensity: this.manager.options.rasterDensity ?? 1,
        tickHz: this.tickHz,
      });
      delete create.op;
      await probe.checked({ op: "create", ...create });
      await probe.checked({ op: "traceMode", mode: 2 });
      for (const entry of capture.entries) {
        let response: JsonRecord;
        if (entry.kind === "compositor") {
          const command: JsonRecord = { op: "compositor", applications: cloneJson(entry.args.applications) };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
        } else if (entry.kind === "workerConfigure") {
          const config = asRecord(entry.args.config, "workerConfigure config");
          const command: JsonRecord = {
            op: "configureWorker",
            bytecodePath: this.previewAssetPath(capture, entry.args.workerBytecode),
            config,
          };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
        } else if (entry.kind === "loadBytecode") {
          const command: JsonRecord = {
            op: "loadBytecode",
            bytecodePath: this.previewAssetPath(capture, entry.args.bytecode),
            pakPath: this.previewAssetPath(capture, entry.args.pak),
            render: true,
          };
          if (typeof entry.args.expectedRuntimeAbi === "string") command.expectedRuntimeAbi = entry.args.expectedRuntimeAbi;
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
          if (entry.result.frame && response.frame && canonicalPreviewJson(entry.result.frame) !== canonicalPreviewJson(previewFrameSummary(asFrame(response.frame)))) {
            return { matched: false, replayable: true, entriesReplayed: entriesReplayed + 1, framesCompared: framesCompared + 1, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "load frame summary differs", expected: entry.result.frame, actual: previewFrameSummary(asFrame(response.frame)) } };
          }
          if (response.frame) framesCompared += 1;
          if (typeof response.runtimeAbi === "string" && capture.engineAbi && response.runtimeAbi !== capture.engineAbi) {
            return { matched: false, replayable: true, entriesReplayed, framesCompared, firstMismatch: { transaction: entry.kind, reason: "engine ABI mismatch", expected: capture.engineAbi, actual: response.runtimeAbi } };
          }
        } else if (entry.kind === "load") {
          const command: JsonRecord = {
            op: "load",
            sourcePath: this.previewAssetPath(capture, entry.args.source),
            pakPath: this.previewAssetPath(capture, entry.args.pak),
            render: true,
          };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
          if (entry.result.frame && response.frame && canonicalPreviewJson(entry.result.frame) !== canonicalPreviewJson(previewFrameSummary(asFrame(response.frame)))) {
            return { matched: false, replayable: true, entriesReplayed: entriesReplayed + 1, framesCompared: framesCompared + 1, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "load frame summary differs", expected: entry.result.frame, actual: previewFrameSummary(asFrame(response.frame)) } };
          }
          if (response.frame) framesCompared += 1;
        } else if (entry.kind === "frame") {
          const command: JsonRecord = { op: "frame", deltaMs: entry.args.deltaMs };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
          if (!response.frame || typeof response.frame !== "object" || Array.isArray(response.frame)) throw new Error("replay frame is missing");
          const actual = previewFrameSummary(asFrame(response.frame));
          const expected = entry.result.frame;
          if (expected && canonicalPreviewJson(expected) !== canonicalPreviewJson(actual)) {
            return { matched: false, replayable: true, entriesReplayed: entriesReplayed + 1, framesCompared: framesCompared + 1, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "frame summary differs", expected, actual } };
          }
          framesCompared += 1;
        } else if (entry.kind === "send") {
          const command: JsonRecord = typeof entry.args.binaryBase64 === "string"
            ? { op: "sendBinary", base64: entry.args.binaryBase64 }
            : { op: "send", message: cloneJson(entry.args.message) };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
        } else if (entry.kind === "resize") {
          const command: JsonRecord = { op: "resize", width: entry.args.width, height: entry.args.height };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
        } else if (entry.kind === "eval") {
          const command: JsonRecord = { op: "eval", source: entry.args.source, render: true };
          if (entry.result.traceClock) command.traceClock = cloneJson(entry.result.traceClock);
          response = await probe.checked(command);
          if (entry.result.frame && response.frame && canonicalPreviewJson(entry.result.frame) !== canonicalPreviewJson(previewFrameSummary(asFrame(response.frame)))) {
            return { matched: false, replayable: true, entriesReplayed: entriesReplayed + 1, framesCompared: framesCompared + 1, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "eval frame summary differs", expected: entry.result.frame, actual: previewFrameSummary(asFrame(response.frame)) } };
          }
          if (response.frame) framesCompared += 1;
        } else {
          return { matched: false, replayable: true, entriesReplayed, framesCompared, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "unsupported preview recording entry" } };
        }
        const expectedTrace = entry.result.traceClock;
        if (expectedTrace && response.traceClock && canonicalPreviewJson(expectedTrace) !== canonicalPreviewJson(response.traceClock)) {
          return { matched: false, replayable: true, entriesReplayed: entriesReplayed + 1, framesCompared, firstMismatch: { transaction: entry.kind, entryIndex: entry.index, reason: "native trace clock differs", expected: expectedTrace, actual: response.traceClock } };
        }
        entriesReplayed += 1;
      }
      return { matched: true, replayable: true, entriesReplayed, framesCompared };
    } catch (error) {
      return { matched: false, replayable: true, entriesReplayed, framesCompared, firstMismatch: { transaction: "runner", entryIndex: entriesReplayed, reason: errorText(error) } };
    } finally {
      await probe.stop();
    }
  }

  private async replayPreviewRecording(): Promise<JsonRecord> {
    const state = this.previewRecording;
    if (!state || state.captures.size === 0) throw new Error("No guest has been recorded");
    if (!state.stopped) await this.stopPreviewRecording();
    const runtimes: Record<string, JsonRecord> = {};
    for (const capture of state.captures.values()) runtimes[capture.id] = await this.replayPreviewCapture(capture);
    return { ok: Object.values(runtimes).every((value) => value.matched === true), runtimes };
  }

  private async sendHostResponse(
    runtime: PreviewRuntime,
    requestId: string,
    capability: string,
    result: unknown,
    error?: JsonRecord,
  ): Promise<void> {
    const payload: JsonRecord = {
      requestId,
      capability,
      ok: !error,
      ...(error ? { error } : { result: result === undefined ? null : result }),
    };
    const message = { type: "event", name: "host.response", payload };
    if (capability.startsWith("media.live2d.model.")) {
      const bytes = encodeMessage(message, 4 * 1024 * 1024);
      await runtime.probe.checked({ op: "sendBinary", base64: Buffer.from(bytes).toString("base64") });
    } else {
      await runtime.probe.checked({ op: "send", message });
    }
    runtime.needsPump = true;
  }

  private publishCompositedFrame(root: PreviewFrame): void {
    this.frame = this.compositeFrame(root);
    this.updateResourceCache(this.frame);
    // The release delta has now been published in `this.frame`; retain it
    // there for replay, but do not repeat it on every subsequent frame.
    this.pendingReleasedResources.clear();
    for (const token of this.frame.presentationTokens ?? []) {
      const pending = this.pendingPresentations.get(token);
      if (pending && !pending.published) {
        pending.published = true;
        // Launch/decoding is a resource barrier, not elapsed animation time.
        // Native still owns idle settlement after this published boundary.
        this.lastTickAt = monotonicNow();
      }
    }
    this.emit({ type: "frame", revision: this.artifactRevision ?? null, frame: this.frame });
    if (this.rootRuntime) this.rootRuntime.pendingBrowserEvents.length = 0;
    for (const child of this.childRuntimes.values()) child.pendingBrowserEvents.length = 0;
  }

  /**
   * Run a child native frame outside the root's serialized turn. The probe
   * response is installed only after re-entering `operationTail`; the retained
   * child frame remains composited while texture extraction is in progress.
   */
  private startChildFramePump(
    runtime: PreviewRuntime,
    deltaMs: number,
    settlePasses = 0,
    pass = 0,
    depth = 0,
  ): void {
    const inFlight = runtime.frameInFlight;
    if (inFlight) {
      if (inFlight.generation === runtime.generation && deltaMs > 0 && this.hasFocusedVisibleSurface(runtime)) {
        runtime.pendingFrameDeltaMs = (runtime.pendingFrameDeltaMs ?? 0) + Math.max(0, deltaMs);
      }
      return;
    }
    const root = this.rootRuntime;
    if (this.disposed || this.childRuntimes.get(runtime.appId) !== runtime || !root) return;

    const generation = runtime.generation;
    const rootGeneration = root.generation;
    const requestedPump = runtime.needsPump;
    runtime.needsPump = false;
    const frameDelta = Math.max(0, deltaMs) + (runtime.pendingFrameDeltaMs ?? 0);
    runtime.pendingFrameDeltaMs = 0;
    const flight = { generation };
    runtime.frameInFlight = flight;
    void runtime.probe.checked({ op: "frame", deltaMs: frameDelta, rawFrame: true }).then(
      (response) => {
        void this.enqueue(async () => {
          if (runtime.frameInFlight !== flight) return;
          const stillResident = !this.disposed && this.rootRuntime === root && root.generation === rootGeneration &&
            this.childRuntimes.get(runtime.appId) === runtime;
          const sameGeneration = stillResident && runtime.generation === generation;
          let frame: PreviewFrame | undefined;
          try {
            if (sameGeneration && response.frame !== undefined) {
              frame = await this.ingestRuntimeFrame(runtime, response.frame, depth + 1);
            }
            if (sameGeneration && runtime.pendingViewport) {
              const viewport = runtime.pendingViewport;
              runtime.pendingViewport = undefined;
              if (runtime.viewportWidth !== viewport.width || runtime.viewportHeight !== viewport.height) {
                await runtime.probe.checked({ op: "resize", width: viewport.width, height: viewport.height });
              }
              await sendDisplayViewport(runtime.probe, viewport.width, viewport.height, viewport.safeArea);
              runtime.viewportWidth = viewport.width;
              runtime.viewportHeight = viewport.height;
              runtime.safeArea = viewport.safeArea;
              runtime.needsPump = true;
            }
          } finally {
            if (runtime.frameInFlight === flight) runtime.frameInFlight = undefined;
          }

          if (!stillResident) return;
          if (!sameGeneration) {
            // A response from an older guest generation must not replace its
            // resources or DrawOps. The same probe is still serialized, so the
            // current generation may start only after this response settles.
            runtime.pendingFrameDeltaMs = 0;
            this.startChildFramePump(runtime, 0, 0, 0, depth);
          }

          const needsSettle = !frame || runtime.needsPump || requestedPump ||
            (frame?.events.length ?? 0) > 0 || settlePasses > 0;
          if (sameGeneration && needsSettle && pass < 31) {
            const nextSettlePasses = runtime.needsPump
              ? 1
              : settlePasses > 0 ? settlePasses - 1 : 1;
            this.startChildFramePump(runtime, 0, nextSettlePasses, pass + 1, depth);
          } else if (sameGeneration) {
            const focusedVisible = this.hasFocusedVisibleSurface(runtime);
            if (!focusedVisible) runtime.pendingFrameDeltaMs = 0;
            if (frame && root.frame && this.rootRuntime === root && root.generation === rootGeneration) {
              // Match synchronous pumpRuntime: settle frames update runtime
              // state and lifecycle queues, but only the settled composite is
              // sent to the browser. This avoids duplicate large frame packets.
              this.publishCompositedFrame(root.frame!);
            }
            if (focusedVisible && (runtime.pendingFrameDeltaMs ?? 0) > 0) {
              this.startChildFramePump(runtime, 0, 0, 0, depth);
            }
          }
          await this.schedule();
        }).catch((error) => this.reportError(error));
      },
      (error) => {
        void this.enqueue(async () => {
          if (runtime.frameInFlight !== flight) return;
          runtime.frameInFlight = undefined;
          if (!this.disposed && this.rootRuntime === root && root.generation === rootGeneration &&
              this.childRuntimes.get(runtime.appId) === runtime && runtime.generation === generation) {
            throw error;
          }
          if (!this.disposed && this.rootRuntime === root && root.generation === rootGeneration &&
              this.childRuntimes.get(runtime.appId) === runtime) {
            runtime.pendingFrameDeltaMs = 0;
            this.startChildFramePump(runtime, 0, 0, 0, depth);
          }
          await this.schedule();
        }).catch((failure) => this.reportError(failure));
      },
    );
  }

  private async pumpRuntime(runtime: PreviewRuntime, deltaMs: number, depth = 0): Promise<void> {
    if (this.disposed) return;
    if (depth > 48) throw new Error("preview system runtime event depth exceeded");
    if (runtime.frameInFlight) {
      // Async child frames own the next response on this probe. Mark the
      // runtime for a follow-up instead of installing a newer synchronous
      // frame ahead of it.
      runtime.needsPump = true;
      if (deltaMs > 0 && this.hasFocusedVisibleSurface(runtime)) {
        runtime.pendingFrameDeltaMs = (runtime.pendingFrameDeltaMs ?? 0) + Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
      }
      return;
    }
    runtime.pumping += 1;
    if (runtime.pumping > 16) {
      runtime.pumping -= 1;
      throw new Error(`preview runtime ${runtime.appId} event recursion exceeded`);
    }
    try {
      // Native settles wall time at external boundaries and credits that same
      // elapsed interval against the next display delta. Truncating it here
      // leaves seconds of credit that swallow subsequent animation ticks.
      // Native already bounds active catch-up and skips proven idle frames.
      let delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
      // A host.response is delivered from the adapter between native frames.
      // QuickJS queues the promise continuation after the frame that observed
      // that response, so one additional settle turn is required before the
      // next host.request becomes visible. Without this turn the System
      // kernel's lifecycle/launch queue stalls until unrelated input arrives.
      let settlePasses = 0;
      for (let pass = 0; pass < 32; pass += 1) {
        const requestedPump = runtime.needsPump;
        runtime.needsPump = false;
        const response = await runtime.probe.checked({ op: "frame", deltaMs: delta, rawFrame: true });
        delta = 0;
        if (response.frame === undefined) continue;
        const frame = await this.ingestRuntimeFrame(runtime, response.frame, depth + 1);
        if (runtime.needsPump) {
          settlePasses = 1;
          continue;
        }
        if (requestedPump || frame.events.length > 0 || settlePasses > 0) {
          if (settlePasses > 0) settlePasses -= 1;
          else settlePasses = 1;
          continue;
        }
        break;
      }
    } finally {
      runtime.pumping -= 1;
    }
  }

  /** Install one native frame, including resource/lifecycle/event edges. */
  private async ingestRuntimeFrame(
    runtime: PreviewRuntime,
    value: unknown,
    depth: number,
    processEvents = true,
  ): Promise<PreviewFrame> {
    const wireBytes = value && typeof value === "object" ? nativeFrameWireBytes.get(value) : undefined;
    if (wireBytes === undefined || wireBytes > maxFrameBytes) {
      const frameJson = JSON.stringify(value);
      if (Buffer.byteLength(frameJson) > maxFrameBytes) throw new Error(`native preview frame for ${runtime.appId} exceeds the safety limit`);
    }
    const frame = asFrame(value);
    runtime.frame = frame;
    for (const event of frame.events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const browserEvent = event as JsonRecord;
      const snapshot = parseAccessibilitySnapshot(browserEvent);
      if (snapshot) {
        if (!runtime.accessibilitySnapshot || snapshot.generation >= runtime.accessibilitySnapshot.generation) {
          runtime.accessibilitySnapshot = snapshot;
          enqueueBrowserEvent(runtime.pendingBrowserEvents, canonicalAccessibilitySnapshotEvent(snapshot), runtime.generation);
        }
        continue;
      }
      if (!isVideoPlaybackEvent(browserEvent) && !isTextInputLifecycleEvent(browserEvent)) continue;
      enqueueBrowserEvent(runtime.pendingBrowserEvents, browserEvent, runtime.generation);
    }
    // A guest can emit several control edges while native settles one input
    // boundary. enqueueBrowserEvent coalesces repeated state for one
    // generation/identity and throws on an actual bound violation; cleanup
    // edges are therefore never silently discarded.
    if (runtime.initialEvents.length === 0) {
      runtime.initialEvents = frame.events.filter((event): event is JsonRecord =>
        !!event && typeof event === "object" && !Array.isArray(event) && eventName(event as JsonRecord) === "host.request",
      ) as JsonRecord[];
    }
    this.runtimeResourceCache(runtime, frame);
    if (!processEvents) return frame;
    for (const event of frame.events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      await this.handleRuntimeEvent(runtime, event as JsonRecord, depth + 1);
    }
    return frame;
  }

  private async handleRuntimeEvent(runtime: PreviewRuntime, event: JsonRecord, depth: number): Promise<void> {
    const name = eventName(event);
    const eventValue = eventPayload(event);
    if (name === "pocket.dev.hot.ack") {
      if (runtime === this.rootRuntime && this.hotAcknowledgement &&
          eventValue?.nonce === this.hotAcknowledgement.nonce && eventValue.result &&
          typeof eventValue.result === "object" && !Array.isArray(eventValue.result)) {
        this.hotAcknowledgement.result = eventValue.result as JsonRecord;
      }
      return;
    }
    if (name === "stream.open" && eventValue && typeof eventValue.streamId === "string" && eventValue.topic === "hardware.bluetooth.notifications") {
      const owner = this.webBluetoothOwner;
      if (owner) {
        const streamId = eventValue.streamId;
        const request: BrowserPluginRequest = {
          token: randomUUID(),
          clientId: owner.clientId,
          lease: owner.lease,
          runtime,
          streamId,
          kind: "stream.open",
        };
        if (this.browserPluginStreams.size >= maxBrowserPluginPending) {
          await runtime.probe.checked({ op: "send", message: { type: "event", name: "stream.error", payload: { streamId, error: hostError("hardware_busy", "Noble Bluetooth stream limit reached") } } });
          runtime.needsPump = true;
          return;
        }
        this.browserPluginStreams.set(this.pluginRequestKey(request.token, streamId), request);
        this.armBrowserPluginTimeout(request, true);
        this.emitWebBluetoothRequest(request, eventValue.params && typeof eventValue.params === "object" && !Array.isArray(eventValue.params)
          ? eventValue.params as JsonRecord
          : {});
      } else {
        await runtime.probe.checked({
          op: "send",
          message: { type: "event", name: "stream.error", payload: {
            streamId: eventValue.streamId,
            error: hostError("unsupported_capability", "Noble Bluetooth preview adapter is unavailable"),
          } },
        });
        runtime.needsPump = true;
      }
      return;
    }
    if ((name === "stream.cancel" || name === "stream.end") && eventValue && typeof eventValue.streamId === "string") {
      const owner = this.webBluetoothOwner;
      if (owner) {
        const request = [...this.browserPluginStreams.values()].find((candidate) =>
          candidate.lease === owner.lease && candidate.runtime === runtime && candidate.streamId === eventValue.streamId);
        if (request) {
          const key = this.pluginRequestKey(request.token, request.streamId!);
          this.clearBrowserPluginTimer(request);
          this.browserPluginStreams.delete(key);
          this.emitWebBluetoothRequest({ ...request, kind: "stream.cancel" }, {
            reason: typeof eventValue.reason === "string"
              ? eventValue.reason
              : name === "stream.end" ? "guest_ended" : "guest_cancelled",
          });
        }
      }
      return;
    }
    if (name !== "host.request") return;
    const payload = eventValue;
    if (!payload || typeof payload.requestId !== "string" || typeof payload.capability !== "string") return;
    const requestId = payload.requestId;
    const capability = payload.capability;
    const params = payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? payload.params as JsonRecord
      : {};

    const isBluetoothPermissionRequest = capability === "hardware.permissions.request" &&
      params.permission === "hardware.bluetooth";
    if (capability.startsWith("hardware.bluetooth.") || isBluetoothPermissionRequest) {
      const owner = this.webBluetoothOwner;
      if (owner) {
        if (this.browserPluginRequests.size >= maxBrowserPluginPending) {
          await this.sendHostResponse(runtime, requestId, capability, null, hostError("hardware_busy", "Noble Bluetooth request limit reached"));
          return;
        }
        const request: BrowserPluginRequest = {
          token: randomUUID(),
          clientId: owner.clientId,
          lease: owner.lease,
          runtime,
          requestId,
          capability,
          kind: "request",
        };
        this.browserPluginRequests.set(this.pluginRequestKey(request.token, requestId), request);
        this.armBrowserPluginTimeout(request, false);
        this.emitWebBluetoothRequest(request, params);
        return;
      }
    }

    if (capability.startsWith("system.runtime.") || capability.startsWith("system.storage.")) {
      await this.handleSystemRuntimeRequest(runtime, requestId, capability, params, depth);
      return;
    }
    if (!this.systemCatalog && capability.startsWith("platform.storage.")) {
      await this.handleLocalStorageRequest(runtime, requestId, capability, params);
      return;
    }
    if (this.systemCatalog && (
      capability === "platform.apps.list" ||
      capability === "platform.apps.open" ||
      capability === "platform.apps.cancel" ||
      capability === "platform.apps.return" ||
      capability === "platform.apps.prewarm" ||
      capability.startsWith("platform.storage.") ||
      capability === "platform.messages.send" ||
      capability === "platform.messages.receive"
    )) {
      await this.dispatchSystemRequest(runtime, requestId, capability, params, depth);
      return;
    }
    try {
      await this.sendHostResponse(runtime, requestId, capability, await this.genericCapabilityResult(runtime, capability, params));
    } catch (error) {
      // Keep the guest's host.request contract finite even when the browser
      // cannot provide a native plugin. An explicit rejected response lets
      // JS handle the unsupported capability; leaving the request pending
      // would strand the serialized guest queue and look like a dead preview.
      await this.sendHostResponse(runtime, requestId, capability, null, hostError("unsupported_capability", errorText(error)));
    }
  }

  private async handleLocalStorageRequest(
    runtime: PreviewRuntime,
    requestId: string,
    capability: string,
    params: JsonRecord,
  ): Promise<void> {
    const operation = capability.slice("platform.storage.".length);
    const namespace = typeof params.namespace === "string" ? params.namespace : "";
    const key = typeof params.key === "string" ? params.key : "";
    const prefix = namespace ? `shared\u0000${namespace}\u0000` : `app\u0000${runtime.appId}\u0000`;
    const storageKey = prefix + key;
    if (operation === "get") await this.sendHostResponse(runtime, requestId, capability, this.storage.get(storageKey) ?? null);
    else if (operation === "set") {
      const value = params.value && typeof params.value === "object" && !Array.isArray(params.value)
        ? params.value as JsonRecord
        : params.value === null || params.value === undefined ? null : { value: params.value };
      this.storage.set(storageKey, value);
      await this.sendHostResponse(runtime, requestId, capability, null);
    } else if (operation === "remove") {
      this.storage.delete(storageKey);
      await this.sendHostResponse(runtime, requestId, capability, null);
    } else if (operation === "keys") {
      await this.sendHostResponse(runtime, requestId, capability, [...this.storage.keys()]
        .filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length)));
    } else {
      await this.sendHostResponse(runtime, requestId, capability, null, hostError("unsupported_capability", `unsupported preview capability: ${capability}`));
    }
  }

  private async genericCapabilityResult(runtime: PreviewRuntime, capability: string, params: JsonRecord): Promise<unknown> {
    if (["media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release"].includes(capability)) {
      const bytecode = runtime.artifacts.bytecodePath ?? runtime.artifacts.bytecode;
      if (!bytecode) throw new Error("Live2D preview requires compiled Guest artifacts");
      runtime.live2d ??= createPreviewLive2d(bytecode);
      return runtime.live2d.invoke(capability, params, {});
    }
    if (capability === "runtime.info") {
      return {
        entryFormat: "quickjs-bytecode",
        runtimeAbi: "native-pocket-probe",
        source: "editor-preview",
        appId: runtime.appId,
      };
    }
    if (capability === "runtime.performance") return { supported: false, context: params.context ?? null };
    if (capability === "plugins.list") {
      return this.webBluetoothOwner
        ? [{ id: "local-noble-bluetooth", provider: "noble", enabled: true, capabilities: ["hardware.permissions.request", "hardware.bluetooth.scan", "hardware.bluetooth.connect", "hardware.bluetooth.read", "hardware.bluetooth.write", "hardware.bluetooth.notifications"] }]
        : [];
    }
    if (capability === "plugins.packageInfo") return { provider: "editor-preview", appId: runtime.appId };
    if (capability === "updates.status") return { configured: false, stage: "disabled", activeVersion: null, availableVersion: null };
    if (capability === "platform.systemUi.set") return { accepted: true };
    if (capability === "platform.messages.send" || capability === "platform.messages.receive") {
      return { supported: false, reason: "System catalog is required for app messaging in the preview" };
    }
    if (capability === "diagnostics.recording.start") return this.startPreviewRecording(runtime);
    if (capability === "diagnostics.recording.status") return this.previewRecordingStatus();
    if (capability === "diagnostics.recording.stop") return await this.stopPreviewRecording();
    if (capability === "diagnostics.recording.export") return this.exportPreviewRecording(params);
    if (capability === "diagnostics.recording.replay") return this.replayPreviewRecording();
    // Hardware and other native-only plugins remain explicitly non-emulated.
    // Video DrawOps are a browser media projection, but native video/plugin
    // capability requests still require their real host adapter.
    throw new Error(`unsupported preview capability: ${capability}`);
  }

  private async dispatchSystemRequest(
    source: PreviewRuntime,
    originalRequestId: string,
    capability: string,
    params: JsonRecord,
    depth: number,
  ): Promise<void> {
    const root = this.rootRuntime;
    if (!root) throw new Error("preview SystemUI runtime is not ready");
    const requestId = `preview-system-${++this.nextSystemRequestId}`;
    // Any runtime can issue a platform request while the root is synchronously
    // pumping. Re-entering the same QuickJS realm from that frame can deadlock
    // SystemUI's serialized request queue (including root-owned startup
    // storage reads while initialize() is still awaiting host work). Keep it
    // pending until the outer root turn unwinds; its normal system.request /
    // system.runtime.respond flow will deliver the real JS-owned result.
    const deferToOuterRootTurn = root.pumping > 0;
    const response = deferToOuterRootTurn
      ? undefined
      : new Promise<boolean>((resolveResponse, rejectResponse) => {
        this.pendingSystemRequests.set(requestId, {
          source,
          requestId: originalRequestId,
          capability,
          params,
          sent: false,
          deferred: false,
          resolve: resolveResponse,
          reject: rejectResponse,
        });
      });
    // A stop/transport failure can reject this promise while dispatch still
    // awaits a probe command; attach a handler immediately so disposal cannot
    // surface it as a process-level unhandled rejection.
    if (response) void response.catch(() => false);
    if (deferToOuterRootTurn) {
      this.pendingSystemRequests.set(requestId, {
        source,
        requestId: originalRequestId,
        capability,
        params,
        sent: false,
        deferred: true,
        deferredPumps: 0,
        resolve: () => {},
        reject: () => {},
      });
      // Do not enter root's native realm while it is executing a frame. The
      // outer tick sends this exact request after the root turn unwinds.
      return;
    }
    try {
      await this.sendPendingSystemRequest(requestId, root);
      // The System kernel is JS-owned. Pumping the real root runtime until it
      // acknowledges the request keeps platform policy and result routing in
      // installPocketSystem instead of duplicating it in this adapter.
      for (let attempt = 0; attempt < 48 && this.pendingSystemRequests.has(requestId); attempt += 1) {
        await this.pumpRuntime(root, 1000 / this.tickHz, depth + 1);
        // Browser presentation is an asynchronous execution boundary. Yield
        // this transport turn so its prepared frame and ACK can be delivered;
        // the existing pending request receives its real JS response later.
        if (this.pendingPresentations.size > 0) return;
        // A dismiss hook may intentionally keep the SystemUI frame loop alive
        // while its reverse animation settles.  Do not consume that whole
        // animation inside this one serialized system.request turn: query the
        // official native demand after each pending pump so a hook that starts
        // on a later queue turn can still hand the request back to the normal
        // ticker. A non-continuous root retains the bounded 48-pump contract.
        if (this.pendingSystemRequests.has(requestId)) {
          const schedule = await root.probe.checked({ op: "schedule" });
          if (Number(schedule.nextWakeDelayMs) === 0) return;
        }
      }
      if (this.pendingSystemRequests.has(requestId)) {
        throw new Error(`SystemUI did not respond to ${capability}`);
      }
      await response;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const pending = this.pendingSystemRequests.get(requestId);
      this.pendingSystemRequests.delete(requestId);
      pending?.reject(failure);
      // Timeout/transport failure exits before the normal response await.
      // Consume the rejected promise or Bun treats it as an unhandled
      // rejection and may terminate the editor process.
      if (response) await response.catch(() => false);
      throw failure;
    }
  }

  private async sendPendingSystemRequest(requestId: string, root: PreviewRuntime): Promise<void> {
    const pending = this.pendingSystemRequests.get(requestId);
    if (!pending || pending.sent) return;
    await root.probe.checked({
      op: "send",
      message: {
        type: "event",
        name: "system.request",
        payload: {
          requestId,
          sourceAppId: pending.source.appId,
          sourceInstanceId: pending.source.instanceId,
          sourceGeneration: pending.source.generation,
          capability: pending.capability,
          params: pending.params,
        },
      },
    });
    pending.sent = true;
    root.needsPump = true;
  }

  /** Keep SystemUI lifecycle posts from waiting behind a child texture frame. */
  private deferChildRuntimePost(
    root: PreviewRuntime,
    child: PreviewRuntime,
    requestId: string,
    event: string,
    params: JsonRecord,
  ): void {
    const generation = child.generation;
    const rootGeneration = root.generation;
    const post = child.probe.checked({
      op: "send",
      message: { type: "event", name: event, payload: params },
    });
    const finish = (error?: unknown): void => {
      void this.enqueue(async () => {
        if (this.disposed || this.rootRuntime !== root || root.generation !== rootGeneration) return;
        if (error) {
          await this.sendHostResponse(root, requestId, "system.runtime.post", null,
            hostError("runtime_post_failed", errorText(error)));
        } else if (this.childRuntimes.get(child.appId) !== child || child.generation !== generation) {
          await this.sendHostResponse(root, requestId, "system.runtime.post", null,
            hostError("runtime_destroyed", "runtime was destroyed before its post was accepted"));
        } else {
          child.needsPump = true;
          await this.sendHostResponse(root, requestId, "system.runtime.post", { accepted: true });
        }
        if (this.rootRuntime === root && root.generation === rootGeneration && this.probe) await this.tickNow(0);
      }).catch((failure) => this.reportError(failure));
    };
    void post.then(() => finish(), finish);
  }

  private async handleSystemRuntimeRequest(
    requester: PreviewRuntime,
    requestId: string,
    capability: string,
    params: JsonRecord,
    depth: number,
  ): Promise<void> {
    const respond = (result: unknown, error?: JsonRecord) => this.sendHostResponse(requester, requestId, capability, result, error);
    if (requester !== this.rootRuntime) {
      await respond(null, hostError("system_context_denied", "System runtime capabilities are restricted to SystemUI"));
      return;
    }
    try {
      if (capability === "system.runtime.configure") {
        if (params.systemUI !== this.rootRuntime.appId) throw new Error("configured SystemUI does not match the trusted preview package");
        this.systemConfigured = true;
        await respond({ systemInstanceId: "system-ui", generation: this.rootRuntime.generation });
        return;
      }
      if (capability === "system.runtime.create") {
        const appId = params.appId;
        if (typeof appId !== "string" || !appId) throw new Error("runtime.create requires appId");
        const memory = params.memory && typeof params.memory === "object" && !Array.isArray(params.memory)
          ? params.memory as JsonRecord
          : undefined;
        const child = this.childRuntimes.get(appId);
        if (child) {
          await respond({
            instanceId: child.instanceId,
            appId: child.appId,
            generation: child.generation,
            ...(params.prepareForOpen === true ? { preparedForOpen: true } : {}),
          });
          return;
        }
        // Child artifact resolution and QJBC evaluation can take seconds.
        // Do not await them from ingestRuntimeFrame: that call runs inside
        // operationTail and otherwise blocks root frames and browser input.
        this.beginChildRuntimeRequest(requester, requestId, capability, appId, memory, params.prepareForOpen === true);
        return;
      }
      if (capability === "system.runtime.prepareOpen") {
        const child = this.runtimeByInstance(params.instanceId);
        if (!child || child === this.rootRuntime) throw new Error("runtime.prepareOpen instance does not exist");
        if (Number(params.generation) !== child.generation) throw new Error("runtime.prepareOpen generation is stale");
        // Editor preview has no trusted OTA resolver. Keep the resident native
        // runtime and generation unchanged instead of claiming an update.
        await respond({
          instanceId: child.instanceId,
          appId: child.appId,
          previousGeneration: child.generation,
          generation: child.generation,
          updated: false,
          configured: false,
        });
        return;
      }
      if (capability === "system.runtime.awaitFirstFrame") {
        const child = this.runtimeByInstance(params.instanceId);
        if (!child || child === this.rootRuntime) throw new Error("runtime.awaitFirstFrame instance does not exist");
        if (Number(params.generation) !== child.generation) throw new Error("runtime.awaitFirstFrame generation is stale");
        for (let attempt = 0; attempt < 48 && !child.frame; attempt += 1) await this.pumpRuntime(child, 1000 / this.tickHz, depth + 1);
        if (!child.frame) throw new Error(`child ${child.appId} did not produce its first frame`);
        if ([...this.subscribers].some(subscriber => subscriber.browserPresentation && !subscriber.closed)) {
          // Native first frame is available, but browser resource decoding and
          // its first paint are still outstanding. Keep the existing JS launch
          // pending until the actual projection acknowledges this frame.
          this.pendingPresentations.set(randomUUID(), { child, respond, published: false });
        } else {
          await respond({ ready: true, generation: child.generation });
        }
        return;
      }
      if (capability === "system.runtime.destroy") {
        const child = this.runtimeByInstance(params.instanceId);
        if (!child || child === this.rootRuntime) throw new Error("runtime.destroy instance does not exist");
        this.childRuntimes.delete(child.appId);
        this.emitWebBluetoothScopeDispose(child);
        await this.failBrowserPluginRuntime(child, "runtime_destroyed", `runtime ${child.appId} was destroyed`);
        for (const [token, pending] of this.pendingPresentations) {
          if (pending.child !== child) continue;
          this.pendingPresentations.delete(token);
          await pending.respond(null, hostError("runtime_destroyed", "runtime was destroyed before its browser frame was presented"));
        }
        for (const [pointerId, target] of this.pointerTargets) {
          if (target.runtime === child) this.pointerTargets.delete(pointerId);
        }
        for (const [pendingId, pending] of this.pendingSystemRequests) {
          if (pending.source !== child) continue;
          this.pendingSystemRequests.delete(pendingId);
          pending.reject(new Error(`runtime ${child.appId} was destroyed before ${pending.capability} completed`));
          try {
            await this.sendHostResponse(child, pending.requestId, pending.capability, null,
              hostError("runtime_destroyed", `runtime ${child.appId} was destroyed`));
          } catch {
            // The child may already have stopped; its remaining events are
            // intentionally discarded with the runtime.
          }
        }
        this.dropRuntimeResources(child.appId);
        await child.live2d?.dispose();
        child.live2d = undefined;
        await this.finishPreviewRecordingCapture(child);
        await child.probe.stop();
        await respond({ destroyed: true });
        return;
      }
      if (capability === "system.runtime.post") {
        const child = this.runtimeByInstance(params.instanceId);
        const event = params.event;
        if (!child || typeof event !== "string" || !event) throw new Error("runtime.post target/event is invalid");
        const eventParams = params.params && typeof params.params === "object" && !Array.isArray(params.params) ? params.params : {};
        if (child.frameInFlight && !this.previewRecordingActive()) {
          // Queue the child post behind its current native frame, but let
          // SystemUI and the root animation continue while that frame settles.
          this.deferChildRuntimePost(requester, child, requestId, event, eventParams);
          return;
        }
        await child.probe.checked({ op: "send", message: { type: "event", name: event, payload: eventParams } });
        child.needsPump = true;
        await respond({ accepted: true });
        return;
      }
      if (capability === "system.runtime.respond") {
        const pending = typeof params.requestId === "string" ? this.pendingSystemRequests.get(params.requestId) : undefined;
        if (!pending) {
          // A child can be destroyed while SystemUI is still finishing a
          // response for it. Acknowledge this control request so the root
          // queue remains live, while deliberately not fabricating a result
          // for the discarded child request.
          await respond({ accepted: true, stale: true });
          return;
        }
        this.pendingSystemRequests.delete(params.requestId as string);
        if (params.ok === true) {
          await this.sendHostResponse(pending.source, pending.requestId, pending.capability, params.value ?? null);
        } else {
          const error = params.error && typeof params.error === "object" && !Array.isArray(params.error)
            ? params.error as JsonRecord
            : hostError("system_request_failed", "SystemUI rejected the platform request");
          await this.sendHostResponse(pending.source, pending.requestId, pending.capability, null, error);
        }
        if (pending.source.pumping > 0 || pending.source.frameInFlight) pending.source.needsPump = true;
        else await this.pumpRuntime(pending.source, 0, depth + 1);
        pending.resolve(params.ok === true);
        // Acknowledge the SystemUI host request itself as well as forwarding
        // its result to the original app request. Omitting this leaves the
        // kernel's serialized queue awaiting system.runtime.respond forever,
        // which blocks every later system.request (notably app return).
        await respond({ accepted: true });
        return;
      }
      if (capability.startsWith("system.storage.")) {
        const operation = capability.slice("system.storage.".length);
        const appId = typeof params.appId === "string" ? params.appId : requester.appId;
        const namespace = typeof params.namespace === "string" ? params.namespace : "";
        const key = typeof params.key === "string" ? params.key : "";
        // The JS kernel has already checked the caller’s namespace grant.
        // Match PocketPlatformData: shared buckets belong to the namespace,
        // private buckets belong to the app.
        const prefix = namespace ? `shared\u0000${namespace}\u0000` : `app\u0000${appId}\u0000`;
        const storageKey = prefix + key;
        if (operation === "get") await respond(this.storage.get(storageKey) ?? null);
        else if (operation === "set") {
          const value = params.value && typeof params.value === "object" && !Array.isArray(params.value)
            ? params.value as JsonRecord
            : params.value === null || params.value === undefined ? null : { value: params.value };
          this.storage.set(storageKey, value);
          await respond(null);
        } else if (operation === "remove") {
          this.storage.delete(storageKey);
          await respond(null);
        } else if (operation === "keys") {
          await respond([...this.storage.keys()].filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length)));
        } else throw new Error(`unsupported system storage operation: ${operation}`);
        return;
      }
      throw new Error(`unsupported System runtime capability: ${capability}`);
    } catch (error) {
      await respond(null, hostError("system_runtime_error", errorText(error)));
    }
  }

  private runtimeByInstance(instanceId: unknown): PreviewRuntime | undefined {
    if (instanceId === "system-ui") return this.rootRuntime;
    if (typeof instanceId !== "string") return undefined;
    return [...this.childRuntimes.values()].find((runtime) => runtime.instanceId === instanceId);
  }

  private beginChildRuntimeRequest(
    requester: PreviewRuntime,
    requestId: string,
    capability: string,
    appId: string,
    memory: JsonRecord | undefined,
    prepareForOpen: boolean,
  ): void {
    const requesterGeneration = requester.generation;
    const isCurrent = () => !this.disposed && this.rootRuntime === requester &&
      this.probe === requester.probe && requester.generation === requesterGeneration &&
      this.rootGeneration === requesterGeneration;
    const deliver = (result: unknown, error?: JsonRecord) => {
      void this.enqueue(async () => {
        if (!isCurrent()) return;
        await this.sendHostResponse(requester, requestId, capability, result, error);
        // Resume the JS system queue now that the asynchronous native load has
        // completed; the next display tick must not depend on unrelated input.
        await this.tickNow(0);
      }).catch((error) => {
        if (isCurrent()) this.reportError(error);
      });
    };
    void this.createChildRuntime(appId, memory, requester).then(
      (child) => deliver({
        instanceId: child.instanceId,
        appId: child.appId,
        generation: child.generation,
        // The admitted child is a real native runtime loaded from its artifact.
        ...(prepareForOpen ? { preparedForOpen: true } : {}),
      }),
      (error) => deliver(null, hostError("system_runtime_error", errorText(error))),
    );
  }

  private isCurrentChildRuntimeLoad(appId: string, load: PendingChildRuntimeLoad): boolean {
    return !load.cancelled && !this.disposed && this.childRuntimeLoads.get(appId) === load &&
      this.rootRuntime === load.rootRuntime && this.probe === load.rootRuntime.probe &&
      load.rootRuntime.generation === load.rootGeneration;
  }

  private stopChildRuntimeLoad(load: PendingChildRuntimeLoad): Promise<void> {
    if (!load.probe) return Promise.resolve();
    load.stopPromise ??= load.probe.stop();
    return load.stopPromise;
  }

  private createChildRuntime(appId: string, memory: JsonRecord | undefined, rootRuntime: PreviewRuntime): Promise<PreviewRuntime> {
    const existing = this.childRuntimes.get(appId);
    if (existing) return Promise.resolve(existing);
    const pending = this.childRuntimeLoads.get(appId);
    if (pending && this.isCurrentChildRuntimeLoad(appId, pending) && pending.promise) return pending.promise;
    const load: PendingChildRuntimeLoad = {
      rootRuntime,
      rootGeneration: rootRuntime.generation,
      cancelled: false,
    };
    this.childRuntimeLoads.set(appId, load);
    const promise = this.loadChildRuntime(appId, memory, load).finally(() => {
      if (this.childRuntimeLoads.get(appId) === load) this.childRuntimeLoads.delete(appId);
    });
    load.promise = promise;
    return promise;
  }

  private async loadChildRuntime(appId: string, memory: JsonRecord | undefined, load: PendingChildRuntimeLoad): Promise<PreviewRuntime> {
    if (!this.systemCatalog?.installed.has(appId)) throw new Error(`app is not installed: ${appId}`);
    const existing = this.childRuntimes.get(appId);
    if (existing) return existing;
    const raw = this.childArtifacts[appId];
    if (!raw) throw new Error(`preview child artifacts are unavailable for ${appId}`);
    const artifacts: PreviewProject = {
      ...raw,
      bytecodePath: raw.bytecodePath ?? raw.bytecode,
      sourcePath: raw.sourcePath ?? raw.appJs,
      pakPath: raw.pakPath ?? raw.pak,
      appId,
    };
    const workerOrigins = artifacts.workerHttpOrigins ?? await this.manager.resolveWorkerHttpOrigins(this.id);
    if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
    const worker = await resolvePreviewWorker(artifacts, workerOrigins);
    if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
    const probePath = await this.manager.findProbe();
    if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
    const probe = new NativeProbe(probePath, this.manager.options.commandTimeoutMs ?? 15_000);
    load.probe = probe;
    probe.setWakeHandler(() => this.onWorkerWake());
    const initialSlot = this.preferredViewportSlots(this.rootRuntime?.frame).get(appId);
    const initialWidth = initialSlot ? Math.max(1, Math.round(initialSlot.w)) : this.width;
    const initialHeight = initialSlot ? Math.max(1, Math.round(initialSlot.h)) : this.height;
    const rootWidth = this.rootRuntime?.viewportWidth ?? this.width;
    const rootHeight = this.rootRuntime?.viewportHeight ?? this.height;
    const initialSafeArea = surfaceSafeArea(
      initialSlot,
      rootWidth,
      rootHeight,
      this.rootRuntime?.safeArea ?? this.safeArea,
    );
    const runtime: PreviewRuntime = {
      appId,
      instanceId: `pocket-app-${++this.nextInstanceId}`,
      generation: 1,
      probe,
      artifacts,
      ...(worker ? { worker } : {}),
      viewportWidth: initialWidth,
      viewportHeight: initialHeight,
      safeArea: initialSafeArea,
      resources: new Map(),
      initialEvents: [],
      pendingBrowserEvents: [],
      needsPump: false,
      pumping: 0,
    };
    const recording = this.previewRecordingActive();
    probe.setObserver((command, response) => this.observeProbeCommand(runtime, command, response));
    probe.setErrorHandler((error) => this.reportError(error, runtime));
    probe.setDecorator((command) => this.decorateProbeCommand(command));
    this.ensurePreviewRecordingCapture(runtime);
    try {
      await probe.checked({
        op: "create",
        width: initialWidth,
        height: initialHeight,
        rasterDensity: this.manager.options.rasterDensity ?? 1,
        tickHz: this.tickHz,
        ...(memory ? { memory } : {}),
      });
      if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
      if (recording) await probe.checked({ op: "traceMode", mode: 1 });
      if (worker) {
        await probe.checked({
          op: "configureWorker",
          bytecodePath: worker.bytecodePath,
          config: { ...worker.config, nativeGeneration: runtime.generation },
        });
      }
      if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
      let loadResponse: JsonRecord;
      if (artifacts.bytecodePath) loadResponse = await probe.checked({
        op: "loadBytecode",
        bytecodePath: artifacts.bytecodePath,
        pakPath: artifacts.pakPath,
        ...(recording ? { render: true, traceClock: {} } : {}),
      });
      else loadResponse = await probe.checked({
        op: "load",
        sourcePath: artifacts.sourcePath,
        pakPath: artifacts.pakPath,
        ...(recording ? { render: true, traceClock: {} } : {}),
      });
      if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
      await sendDisplayViewport(probe, initialWidth, initialHeight, initialSafeArea);
      await this.replayAccessibilityPreferences(runtime);
      await this.enqueue(async () => {
        if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
        if (loadResponse.frame !== undefined) await this.ingestRuntimeFrame(runtime, loadResponse.frame, 0, false);
        if (!this.isCurrentChildRuntimeLoad(appId, load)) throw new Error("child runtime startup was cancelled");
        this.childRuntimes.set(appId, runtime);
        if (runtime.frame) {
          for (const event of runtime.frame.events) {
            if (event && typeof event === "object" && !Array.isArray(event)) {
              await this.handleRuntimeEvent(runtime, event as JsonRecord, 0);
            }
          }
        }
      });
      return runtime;
    } catch (error) {
      if (this.childRuntimes.get(appId) === runtime) this.childRuntimes.delete(appId);
      await this.finishPreviewRecordingCapture(runtime);
      await this.stopChildRuntimeLoad(load);
      throw error;
    }
  }

  private surfaceSlots(frame: PreviewFrame): SurfaceSlot[] {
    return frame.ops.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "hostSurface") return [];
      let kind = typeof value.kind === "string" ? value.kind : undefined;
      if (typeof value.asset === "string") {
        try {
          const descriptor = JSON.parse(value.asset);
          if (descriptor && typeof descriptor.kind === "string") kind = descriptor.kind;
        } catch { /* Legacy application surfaces have no descriptor. */ }
      }
      // Optical/texture surfaces share the native handle/id fields with apps.
      // They must survive composition in paint order for their host provider.
      if (kind !== undefined && kind !== "application") return [];
      const handle = typeof value.surfaceHandle === "number" ? value.surfaceHandle : Number(value.surfaceHandle);
      const appId = typeof value.id === "string" ? value.id : "";
      const x = Number(value.x);
      const y = Number(value.y);
      const w = Number(value.w);
      const h = Number(value.h);
      if (!Number.isInteger(handle) || !appId || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return [];
      return [{ handle, appId, x, y, w, h, focused: value.focused === true }];
    });
  }

  /**
   * Pick one native viewport for each app. A catalog can expose the same app
   * in more than one host surface, but one child runtime cannot have two
   * native sizes simultaneously. Prefer the focused surface (the one that
   * owns input) and otherwise keep the first deterministic visible slot.
   */
  private preferredViewportSlots(frame: PreviewFrame | undefined): Map<string, SurfaceSlot> {
    const result = new Map<string, SurfaceSlot>();
    if (!frame) return result;
    for (const slot of this.surfaceSlots(frame)) {
      const previous = result.get(slot.appId);
      if (!previous || (slot.focused && !previous.focused)) result.set(slot.appId, slot);
    }
    return result;
  }

  private hasFocusedVisibleSurface(runtime: PreviewRuntime): boolean {
    const root = this.rootRuntime?.frame;
    const slot = this.preferredViewportSlots(root).get(runtime.appId);
    return !!root && !!slot && slot.focused && slot.x < Number(root.width) && slot.y < Number(root.height) &&
      slot.x + slot.w > 0 && slot.y + slot.h > 0;
  }

  /** Resize only mounted children that have a current host surface. A child
   * kept alive in the background must retain its own last viewport; forcing
   * it to the root size would diverge from Flutter's surface constraints and
   * can enqueue work while no surface is presented. This is also the source
   * of the 390x844 -> 390x788 seam: resizing the child first keeps its native
   * clip/rounded-fill boundaries in slot coordinates instead of asking the
   * compositor to post-scale them by 788/844. See
   * sdk/docs/EDITOR_PREVIEW_RENDERING.md. */
  private async syncChildViewports(frame: PreviewFrame): Promise<Set<PreviewRuntime>> {
    const resized = new Set<PreviewRuntime>();
    const rootWidth = Math.max(1, Number(frame.width));
    const rootHeight = Math.max(1, Number(frame.height));
    const rootArea = this.rootRuntime?.safeArea ?? this.safeArea;
    for (const [appId, slot] of this.preferredViewportSlots(frame)) {
      const runtime = this.childRuntimes.get(appId);
      if (!runtime) continue;
      const width = Math.max(1, Math.round(slot.w));
      const height = Math.max(1, Math.round(slot.h));
      const safeArea = surfaceSafeArea(slot, rootWidth, rootHeight, rootArea);
      const sizeChanged = runtime.viewportWidth !== width || runtime.viewportHeight !== height;
      const safeAreaChanged = !sameSafeArea(runtime.safeArea, safeArea);
      if (!sizeChanged && !safeAreaChanged) continue;
      if (runtime.frameInFlight) {
        // Do not put a resize command behind the expensive child frame and
        // make the root's serialized animation turn wait for it.
        runtime.pendingViewport = { width, height, safeArea };
        resized.add(runtime);
        continue;
      }
      if (sizeChanged) await runtime.probe.checked({ op: "resize", width, height });
      // Native resize emits a width/height-only fact. Always follow it with
      // the slot's safe-area projection, including when only the root insets
      // changed while the child kept the same physical size.
      await sendDisplayViewport(runtime.probe, width, height, safeArea);
      runtime.viewportWidth = width;
      runtime.viewportHeight = height;
      runtime.safeArea = safeArea;
      runtime.needsPump = true;
      resized.add(runtime);
    }
    return resized;
  }

  private focusedSurface(frame = this.rootRuntime?.frame): SurfaceSlot | undefined {
    if (!frame) return undefined;
    return this.surfaceSlots(frame).find((slot) => slot.focused);
  }

  private compositeFrame(root: PreviewFrame): PreviewFrame {
    const slots = this.surfaceSlots(root);
    const byHandle = new Map(slots.map((slot) => [slot.handle, slot]));
    const focusedSlot = slots.find((slot) => slot.focused);
    const focusedChildRuntime = focusedSlot ? this.childRuntimes.get(focusedSlot.appId) : undefined;
    const focusedChild = focusedChildRuntime?.frame;
    // Pointer coordinates are carried over the native 10-bit touch wire. A
    // child can have a larger logical frame than that wire, so expose the
    // largest root-space rectangle that maps to an accepted child coordinate.
    // The slot itself is the only source of this geometry; do not infer it
    // from the flattened child DrawOps.
    const inputBounds = (() => {
      if (!focusedSlot || !focusedChild) return undefined;
      const rootWidth = Math.max(1, root.width);
      const rootHeight = Math.max(1, root.height);
      const childWidth = Math.max(1, focusedChild.width);
      const childHeight = Math.max(1, focusedChild.height);
      // The child-to-slot transform must also respect the native ten-bit
      // pointer wire. Then intersect that usable slot with the root frame:
      // during the mini-app entry animation a 390x844 slot can begin at
      // y=701, so advertising its unclipped bottom would route input outside
      // the browser canvas and violate the preview contract.
      const usableWidth = focusedSlot.w * Math.min(childWidth, 1023) / childWidth;
      const usableHeight = focusedSlot.h * Math.min(childHeight, 1023) / childHeight;
      const left = Math.max(0, focusedSlot.x);
      const top = Math.max(0, focusedSlot.y);
      const right = Math.min(rootWidth, focusedSlot.x + usableWidth);
      const bottom = Math.min(rootHeight, focusedSlot.y + usableHeight);
      return right > left && bottom > top
        ? { x: left, y: top, w: right - left, h: bottom - top }
        : undefined;
    })();
    const childOps = new Map<number, JsonRecord[]>();
    const childResources: JsonRecord[] = [];
    const releasedResources = new Set<string>();
    for (const asset of [...this.pendingReleasedResources, ...(root.releasedResources ?? [])]) {
      if (typeof asset === "string" && asset.length > 0) releasedResources.add(asset);
    }
    for (const slot of slots) {
      const child = this.childRuntimes.get(slot.appId);
      if (!child?.frame) continue;
      const prefix = `pocket.runtime.${slot.appId}.`;
      const runtimeToken = `${child.instanceId}:${child.generation}`;
      childOps.set(slot.handle, child.frame.ops.map((op) => {
        const transformed = transformedChildOp(op, slot, child.frame!, prefix);
        return op.type === "video" ? { ...transformed, runtimeToken } : transformed;
      }));
      for (const value of child.resources.values()) {
        const asset = value.asset;
        if (typeof asset !== "string" || !asset) continue;
        childResources.push({ ...value, asset: `${prefix}${asset}` });
      }
      for (const asset of child.frame.releasedResources ?? []) {
        if (typeof asset === "string" && asset) releasedResources.add(`${prefix}${asset}`);
      }
    }
    // Replace each surface in its original paint position. Appending every
    // child after the root hides SystemUI controls that float over content.
    const ops = root.ops.flatMap((op) => {
      if (!op || typeof op !== "object" || Array.isArray(op) || op.type !== "hostSurface") return [op];
      const handle = Number(op.surfaceHandle);
      return byHandle.has(handle) ? (childOps.get(handle) ?? []) : [op];
    });
    const rootResources = this.rootRuntime ? [...this.rootRuntime.resources.values()] : root.resources;
    // A restarted child can reuse the same prefixed asset names. A release
    // and replacement in one frame must be ordered as replacement-only from
    // the browser's perspective; otherwise installFrame would delete the new
    // resource immediately after decoding it.
    for (const resource of [...rootResources, ...childResources]) {
      const asset = resource.asset;
      if (typeof asset === "string") releasedResources.delete(asset);
    }
    // Child runtimes execute their own JS media/text controllers. Forward only
    // browser lifecycle edges, tagging the owning app so IDs may safely repeat
    // across runtime instances. Host requests remain private to this adapter
    // and are handled above.
    const rootRuntimeToken = this.rootRuntime
      ? `${this.rootRuntime.instanceId}:${this.rootRuntime.generation}`
      : undefined;
    const projectedOps = ops.map((op) => op?.type === "video" && rootRuntimeToken
      ? { ...op, runtimeToken: rootRuntimeToken }
      : op);
    const rootEvents = (root.events.length > 0 ? root.events : (this.rootRuntime?.initialEvents ?? []))
      .filter((event) => !isVideoPlaybackEvent(event) && !isTextInputLifecycleEvent(event) && !isAccessibilitySnapshotEvent(event))
      .map((event) => rootRuntimeToken ? { ...event, runtimeToken: rootRuntimeToken } : event);
    // Playback/text edges are consumed by native while it settles an input and
    // can disappear from the final settled frame. The shared runtime queue
    // retains them until this exact browser publication boundary. Include
    // every live child for video, even when its surface is culled, so media
    // intent is not lost during coverage/scroll transitions.
    const rootBrowserEvents = (this.rootRuntime?.pendingBrowserEvents ?? [])
      .filter(({ event }) => !isAccessibilitySnapshotEvent(event))
      .map(({ event, generation }) => rootRuntimeToken
        ? { ...event, runtimeToken: `${this.rootRuntime!.instanceId}:${generation}` }
        : event);
    const childVideoEvents = [...this.childRuntimes.entries()].flatMap(([appId, child]) => {
      return (child.pendingBrowserEvents ?? [])
        .filter(({ event }) => isVideoPlaybackEvent(event))
        .map(({ event, generation }) => ({
          ...event,
          runtime: appId,
          runtimeToken: `${child.instanceId}:${generation}`,
        }));
    });
    // Only the focused child owns the single browser text editor overlay. Keep
    // its lifecycle edges ordered with the root frame and tag the runtime
    // identity so a destroyed/recreated child cannot consume late DOM edits.
    const childTextInputEvents = focusedSlot && focusedChild
      ? (focusedChildRuntime?.pendingBrowserEvents ?? [])
        .filter(({ event }) => isTextInputLifecycleEvent(event))
        .map(({ event, generation }) => transformedTextInputEvent(
          event,
          focusedSlot,
          focusedChild,
          focusedChildRuntime ? `${focusedChildRuntime.instanceId}:${generation}` : "",
        ))
      : [];
    const accessibilityEvents: JsonRecord[] = [];
    if (this.rootRuntime?.accessibilitySnapshot && rootRuntimeToken) {
      accessibilityEvents.push(projectedAccessibilityEvent(
        this.rootRuntime.accessibilitySnapshot,
        root,
        rootRuntimeToken,
      ));
    }
    if (focusedSlot && focusedChildRuntime?.accessibilitySnapshot && focusedChild && focusedChildRuntime) {
      accessibilityEvents.push(projectedAccessibilityEvent(
        focusedChildRuntime.accessibilitySnapshot,
        root,
        `${focusedChildRuntime.instanceId}:${focusedChildRuntime.generation}`,
        focusedSlot,
        focusedChild,
        focusedSlot.appId,
      ));
    }
    const { inputBounds: _nativeInputBounds, ...rootFrame } = root;
    return {
      ...rootFrame,
      ...(inputBounds ? { inputBounds } : {}),
      presentationTokens: [...this.pendingPresentations].filter(([, pending]) =>
        slots.some(slot => slot.appId === pending.child.appId && slot.w > 0 && slot.h > 0 &&
          slot.x < root.width && slot.y < root.height && slot.x + slot.w > 0 && slot.y + slot.h > 0))
        .map(([token]) => token),
      ops: projectedOps,
      // SSE carries native resource deltas. A reconnect gets the full cache
      // through replayFrame(); retransmitting every atlas on every animation
      // tick makes the browser decode megabytes instead of painting frames.
      resources: [...rootResources, ...childResources].filter(resource => {
        const previous = this.resourceCache.get(String(resource.asset));
        if (!previous) return true;
        // Native FrameResource revisions are the authoritative cheap path.
        // A legacy/preview provider may omit them, so compare the actual
        // payload rather than retransmitting unchanged pixels forever.
        if (previous.revision !== undefined && resource.revision !== undefined) {
          return previous.revision !== resource.revision || previous.width !== resource.width ||
            previous.height !== resource.height || previous.psm !== resource.psm || previous.linear !== resource.linear;
        }
        return previous.revision !== resource.revision || !samePreviewResourcePayload(previous, resource);
      }),
      releasedResources: [...releasedResources],
      events: [...rootEvents, ...rootBrowserEvents, ...childVideoEvents, ...childTextInputEvents, ...accessibilityEvents],
    };
  }

  private childForInput(x: number, y: number): { runtime: PreviewRuntime; slot: SurfaceSlot } | undefined {
    const slot = this.focusedSurface();
    if (!slot || x < slot.x || y < slot.y || x > slot.x + slot.w || y > slot.y + slot.h) return undefined;
    // Root paint after this surface represents content over the child.
    // Preserve that stacking order for DOWN routing too; the native root
    // still owns exact hit testing, pressed state and the captured contact.
    const rootOps = this.rootRuntime?.frame?.ops ?? [];
    const index = rootOps.findIndex(op => op.type === "hostSurface" && Number(op.surfaceHandle) === slot.handle);
    const coversPoint = (op: JsonRecord): boolean => {
      if (op.type === "hostSurface" || op.type === "clear") return false;
      if (op.color !== undefined && (Number(op.color) >>> 24) === 0) return false;
      const left = Number(op.x), top = Number(op.y), width = Number(op.w), height = Number(op.h);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
        x < left || y < top || x > left + width || y > top + height) return false;
      const clip = op.clip as JsonRecord | undefined;
      return !clip || (x >= Number(clip.x) && y >= Number(clip.y) &&
        x <= Number(clip.x) + Number(clip.w) && y <= Number(clip.y) + Number(clip.h));
    };
    if (index >= 0 && rootOps.slice(index + 1).some(coversPoint)) return undefined;
    const runtime = this.childRuntimes.get(slot.appId);
    if (!runtime?.frame) return undefined;
    return { runtime, slot };
  }

  private pointForPointer(target: PointerTarget, x: number, y: number): { x: number; y: number } {
    const frame = target.runtime.frame;
    if (!frame || !target.slot) return { x, y };
    const slot = target.slot;
    // A pointer stays on its original child after it exits the host surface.
    // Native touch admission requires child viewport coordinates, so clamp the
    // transformed point; never synthesize a replacement DOWN on the root.
    return {
      x: Math.max(0, Math.min(frame.width, (x - slot.x) * frame.width / slot.w)),
      y: Math.max(0, Math.min(frame.height, (y - slot.y) * frame.height / slot.h)),
    };
  }

  private async cancelPointerTarget(id: number, target: PointerTarget): Promise<void> {
    const point = target.lastPoint;
    if (!point) throw new Error(`pointer ${id} has no admitted target to cancel`);
    // A resize can shrink the captured runtime after DOWN. Native validates
    // CANCEL coordinates against the current viewport too, so clamp the
    // original target point without changing its captured runtime/surface.
    const frame = target.runtime.frame;
    const auxiliary = target.surface === 1 || target.surface === "auxiliary";
    const viewport = auxiliary ? frame?.auxiliary : frame;
    const viewportWidth = Number(viewport?.width ?? 1023);
    const viewportHeight = Number(viewport?.height ?? 1023);
    const maxX = Number.isFinite(viewportWidth) ? Math.min(1023, Math.max(0, viewportWidth)) : 1023;
    const maxY = Number.isFinite(viewportHeight) ? Math.min(1023, Math.max(0, viewportHeight)) : 1023;
    const payload: JsonRecord = {
      phase: "cancel",
      id,
      x: Math.max(0, Math.min(maxX, point.x)),
      y: Math.max(0, Math.min(maxY, point.y)),
    };
    if (target.surface !== undefined) payload.surface = target.surface;
    await target.runtime.probe.checked({
      op: "send",
      message: { type: "event", name: "input.pointer", payload },
    });
  }

  /**
   * Native input admission and the following pump are separate boundaries.
   * If either fails after a contact was admitted, cancel the captured target
   * before retiring it; deleting only the map entry would leave native's
   * touch slot active and make the next browser DOWN look duplicated.
   */
  private async recoverPointerTarget(id: number, target: PointerTarget, originalError: unknown): Promise<void> {
    try {
      await this.cancelPointerTarget(id, target);
      if (this.pointerTargets.get(id) === target) this.pointerTargets.delete(id);
    } catch (cancelError) {
      // Keep the target in the map when cancellation itself failed: native
      // may still own the contact. Surface the transport failure so the next
      // session generation can tear down the probe and clear the capture.
      this.reportError(cancelError);
      if (originalError instanceof Error && !("cause" in originalError)) {
        try { originalError.cause = cancelError; } catch { /* immutable error */ }
      }
    }
  }

  private cancelActivePointersIfBrowserGone(): void {
    if (this.pointerTargets.size === 0 || this.hasBrowserPresentationSubscriber()) return;
    void this.enqueue(async () => {
      if (this.pointerTargets.size === 0 || this.hasBrowserPresentationSubscriber()) return;
      let firstError: unknown;
      let cancelled = false;
      for (const [id, target] of [...this.pointerTargets]) {
        if (this.pointerTargets.get(id) !== target) continue;
        try {
          await this.cancelPointerTarget(id, target);
          this.pointerTargets.delete(id);
          cancelled = true;
        } catch (error) {
          firstError ??= error;
        }
      }
      // Deliver the real cancel edge to the guest when the transport is still
      // healthy. A later session restart remains the fallback for a dead probe.
      if (cancelled && this.rootRuntime && this.probe) await this.tickNow(0);
      if (firstError) throw firstError;
    }).catch((error) => this.reportError(error));
  }

  private async schedule(): Promise<void> {
    if (!this.probe || this.disposed || this.subscribers.size === 0) return;
    const generation = ++this.scheduleGeneration;
    const delays: number[] = [];
    const rootResponse = await this.probe.checked({ op: "schedule" });
    if (generation !== this.scheduleGeneration || !this.probe || this.disposed || this.subscribers.size === 0) return;
    const rootDelay = Number(rootResponse.nextWakeDelayMs);
    if (Number.isFinite(rootDelay) && rootDelay >= -1) delays.push(rootDelay);
    // tickNow pumps the presented child with the same elapsed delta as the
    // root. Ask that child for demand too: a quiescent SystemUI root must not
    // stop the timer while the visible app is still flinging/animating.
    const focused = this.focusedSurface();
    const child = focused ? this.childRuntimes.get(focused.appId) : undefined;
    if (child && !child.frameInFlight) {
      const childResponse = await child.probe.checked({ op: "schedule" });
      if (generation !== this.scheduleGeneration || !this.probe || this.disposed || this.subscribers.size === 0) return;
      const childDelay = Number(childResponse.nextWakeDelayMs);
      if (Number.isFinite(childDelay) && childDelay >= -1) delays.push(childDelay);
    }
    if (generation !== this.scheduleGeneration || !this.probe || this.disposed || this.subscribers.size === 0) return;
    const activeDelays = delays.filter((delay) => delay >= 0);
    this.nextWakeDelay = activeDelays.length > 0 ? Math.min(...activeDelays) : delays.length > 0 ? -1 : null;
    if (this.nextWakeDelay === null || this.nextWakeDelay < 0) {
      if (this.tickTimer) clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
      this.tickDeadlineAt = undefined;
      return;
    }
    // A native full-frame probe cannot run faster than the guest's fixed-step
    // cadence. A zero demand delay means continuous work, so keep a bounded
    // vsync-like timer instead of a microtask/busy loop.
    // Continuous work is due one period after the previous display tick,
    // not one period after rendering and querying the probe have finished.
    // Adding a full sleep after that work reduces a 60 Hz guest to ~50 Hz
    // even with no optical surfaces. Input-only delta=0 pumps deliberately
    // leave lastTickAt untouched, so they cannot postpone this cadence.
    const now = monotonicNow();
    const period = 1000 / this.tickHz;
    const due = this.nextWakeDelay === 0
      // Keep a fixed clock phase: rounded millisecond timers and a late wake
      // must not add their overshoot to every following frame. No catch-up
      // loop is needed; tickNow still supplies the actual elapsed delta.
      ? (Math.floor(this.lastTickAt / period) + 1) * period
      : now + this.nextWakeDelay;
    const delay = Math.max(1, Math.ceil(due - now));
    const deadline = now + delay;
    // Input edges call schedule() with delta=0. Do not move an already
    // earlier timer deadline on every edge, or a continuous drag can starve
    // the real display pump indefinitely. A newly-active runtime may still
    // pull an older, later timer forward.
    if (this.tickTimer && this.tickDeadlineAt !== undefined && this.tickDeadlineAt <= deadline) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickDeadlineAt = deadline;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.tickDeadlineAt = undefined;
      void this.enqueue(() => this.tickNow()).catch((error) => this.reportError(error));
    }, delay);
  }

  /** Native Worker/provider completions arrive on a probe-owned thread. The
   * probe forwards a coalesced wake record; serialize one zero-delta UI turn
   * so the existing WorkerUiBridge latch and frame publication remain the
   * only channel path. */
  private onWorkerWake(): void {
    if (this.disposed || this.subscribers.size === 0) return;
    void this.enqueue(async () => {
      if (this.disposed || this.subscribers.size === 0 || !this.rootRuntime) return;
      await this.tickNow(0);
    }).catch((error) => this.reportError(error));
  }

  private async tickNow(explicitDelta?: number): Promise<void> {
    const runtime = this.rootRuntime;
    if (!runtime || this.disposed) return;
    const now = monotonicNow();
    const delta = explicitDelta === undefined
      ? Math.max(0, now - this.lastTickAt)
      : Math.max(0, explicitDelta);
    // Input edges are pumped with delta=0 so DOWN/UP/CANCEL remains visible
    // immediately. They must not consume the elapsed-time baseline: otherwise
    // a fast stream of pointer requests continually resets the clock and the
    // next real display tick loses the time spent processing those requests.
    if (explicitDelta === undefined || delta > 0) this.lastTickAt = now;
    await this.pumpRuntime(runtime, delta);
    const visibleSlots = this.preferredViewportSlots(runtime.frame);
    for (const child of this.childRuntimes.values()) {
      if (child.frameInFlight && !this.hasFocusedVisibleSurface(child)) child.pendingFrameDeltaMs = 0;
    }
    const resizedChildren = runtime.frame ? await this.syncChildViewports(runtime.frame) : new Set<PreviewRuntime>();
    // Resize-induced host requests must be consumed even for a currently
    // inactive surface. Focused children receive the real elapsed delta;
    // background children get a settle turn only, avoiding animation work
    // while still draining resize/host responses.
    for (const [appId, slot] of visibleSlots) {
      const child = this.childRuntimes.get(appId);
      if (!child || (!slot.focused && !resizedChildren.has(child))) continue;
      const childDelta = slot.focused && this.hasFocusedVisibleSurface(child) ? delta : 0;
      if (this.previewRecordingActive()) {
        // Recordings replay the exact serialized probe transaction sequence.
        await this.pumpRuntime(child, childDelta);
      } else {
        this.startChildFramePump(child, childDelta);
      }
    }
    // A runtime may emit a host request while the root is inside a frame (for
    // example the root's startup storage read while SystemUI.initialize is
    // still awaiting async host work). Service deferred requests after the
    // root turn has unwound. A missing SystemUI response remains bounded by
    // the same 48-pump contract as the synchronous request path.
    const rootAfterTurn = this.rootRuntime;
    for (let attempt = 0; attempt < 48 && rootAfterTurn; attempt += 1) {
      const deferred = [...this.pendingSystemRequests.entries()]
        .filter(([, pending]) => pending.deferred === true);
      if (deferred.length === 0) break;
      for (const [requestId, pending] of deferred) {
        if (!pending.sent) await this.sendPendingSystemRequest(requestId, rootAfterTurn);
      }
      // The root queue may be waiting for these asynchronous host boundaries;
      // a zero-delta pump cannot resolve them while this operation owns the
      // serialized editor lane. Resume from their existing completion turn.
      if (this.childRuntimeLoads.size > 0 || this.pendingPresentations.size > 0) break;
      await this.pumpRuntime(rootAfterTurn, 0);
      const stillPending = [...this.pendingSystemRequests.entries()]
        .filter(([, pending]) => pending.deferred === true && pending.sent);
      if (stillPending.length === 0) continue;
      // Child creation and browser presentation are external boundaries. Let
      // their existing completion callbacks enter the operation queue before
      // spending the remaining finite pump budget.
      if (this.childRuntimeLoads.size > 0 || this.pendingPresentations.size > 0) break;
      const schedule = await rootAfterTurn.probe.checked({ op: "schedule" });
      if (Number(schedule.nextWakeDelayMs) === 0) break;
      for (const [, pending] of stillPending) pending.deferredPumps = (pending.deferredPumps ?? 0) + 1;
      const expired = stillPending.find(([, pending]) => (pending.deferredPumps ?? 0) >= 48);
      if (expired) {
        const message = `SystemUI did not respond to ${expired[1].capability}`;
        const failure = new Error(message);
        for (const [requestId, pending] of stillPending) {
          this.pendingSystemRequests.delete(requestId);
          pending.reject(failure);
        }
        throw failure;
      }
    }
    if (runtime.frame) {
      this.publishCompositedFrame(runtime.frame);
    }
    await this.schedule();
  }

  async sendInput(input: JsonRecord): Promise<void> {
    await this.ensureStarted();
    return this.enqueue(async () => {
      const probe = this.probe;
      if (!probe) throw new Error("preview runtime is not ready");
      const kind = typeof input.type === "string" ? input.type : "";
      if (kind === "presented") {
        const tokens = Array.isArray(input.tokens) ? input.tokens : [];
        for (const token of tokens) {
          if (typeof token !== "string") continue;
          const pending = this.pendingPresentations.get(token);
          if (!pending?.published) continue;
          if (this.childRuntimes.get(pending.child.appId) !== pending.child) {
            // A destroyed/restarted child cannot consume this stale token;
            // there is no valid host response left to retry.
            this.pendingPresentations.delete(token);
            continue;
          }
          await pending.respond({ ready: true, generation: pending.child.generation });
          // Preserve the token if the native response transport failed. A
          // reconnect may retry the real ACK; only a successful response
          // completes the browser presentation barrier.
          this.pendingPresentations.delete(token);
        }
      } else if (kind === "resize") {
        this.width = finitePositive(input.width, "width");
        this.height = finitePositive(input.height, "height");
        // A resize without an explicit safeArea is an intentional zero-inset
        // profile (for example the tablet/desktop picker), not permission to
        // retain the previous phone notch/home-indicator values.
        this.safeArea = boundedSafeArea(
          normalizeSafeArea(input.safeArea),
          this.width,
          this.height,
        );
        await probe.checked({ op: "resize", width: this.width, height: this.height });
        if (this.rootRuntime) {
          this.rootRuntime.viewportWidth = this.width;
          this.rootRuntime.viewportHeight = this.height;
          this.rootRuntime.safeArea = { ...this.safeArea };
        }
        await sendDisplayViewport(probe, this.width, this.height, this.safeArea);
      } else if (kind === "pointer") {
        const phase = input.phase;
        if (!["down", "move", "up", "cancel"].includes(String(phase))) throw new Error("pointer phase must be down, move, up, or cancel");
        const id = integerIn(input.id ?? 0, "pointer id", 0, 255);
        const x = finiteNonNegative(input.x, "pointer x", 1023);
        const y = finiteNonNegative(input.y, "pointer y", 1023);
        let pointerTarget = this.pointerTargets.get(id);
        // CANCEL is an idempotent browser cleanup edge. If a failed DOWN
        // never reached this session, there is no safe native target to send
        // it to; acknowledge the cleanup without inventing a DOWN or routing
        // it to a different runtime.
        if (phase === "cancel" && !pointerTarget) return;
        if (phase === "down") {
          if (pointerTarget) {
            // Browser reconnects can replay a new DOWN while the old native
            // contact is still captured. Cancel the old target first instead
            // of deleting the map entry and leaking its native touch slot.
            await this.cancelPointerTarget(id, pointerTarget);
            if (this.pointerTargets.get(id) === pointerTarget) this.pointerTargets.delete(id);
          }
          const childInput = this.childForInput(x, y);
          pointerTarget = childInput
            ? { runtime: childInput.runtime, slot: childInput.slot }
            : { runtime: this.rootRuntime! };
        } else if (!pointerTarget) {
          // The native runtime rejects MOVE/UP for an unknown contact. Keep
          // that contract and avoid silently inventing a DOWN.
          throw new Error(`pointer ${phase} for unknown contact id ${id}`);
        }
        const target = pointerTarget.runtime;
        if (!target.frame) {
          const failure = new Error("pointer target runtime has no frame");
          if (phase === "down") throw failure;
          await this.recoverPointerTarget(id, pointerTarget, failure);
          throw failure;
        }
        const point = this.pointForPointer(pointerTarget, x, y);
        const targetX = point.x;
        const targetY = point.y;
        if (!target) throw new Error("preview runtime is not ready");
        if (phase === "down") {
          pointerTarget.surface = input.surface;
          this.pointerTargets.set(id, pointerTarget);
        }
        const payload: JsonRecord = { phase, id, x: targetX, y: targetY };
        const surface = pointerTarget.surface;
        if (surface !== undefined) payload.surface = surface;
        let nativeAccepted = false;
        try {
          await target.probe.checked({ op: "send", message: { type: "event", name: "input.pointer", payload } });
          nativeAccepted = true;
          pointerTarget.lastPoint = point;
          if (phase === "up" || phase === "cancel") {
            this.pointerTargets.delete(id);
            if (this.pointerTargets.size === 0) {
              // Native settled the preceding idle interval on pointer DOWN.
              // Keep that interval in the next display delta so it can repay
              // native's elapsed credit; resetting here stalls new animation
              // ticks until subsequent deltas repay the discarded idle time.
              if (this.tickTimer) {
                clearTimeout(this.tickTimer);
                this.tickTimer = undefined;
                this.tickDeadlineAt = undefined;
              }
            }
          }
          await this.tickNow(0);
        } catch (error) {
          if (phase === "down" && !nativeAccepted) {
            // Native rejected admission, so no CANCEL can be safely routed;
            // remove only this exact tentative target and preserve the error.
            if (this.pointerTargets.get(id) === pointerTarget) this.pointerTargets.delete(id);
          } else if (phase === "down" || phase === "move" || !nativeAccepted) {
            await this.recoverPointerTarget(id, pointerTarget, error);
          }
          throw error;
        }
        return;
      } else if (kind === "text" || kind === "key") {
        const events = Array.isArray(input.events) ? input.events : [input];
        const admitted = events.map((event) => this.validateTextEvent(asRecord(event, "text event")));
        const target = this.focusedSurface() ? this.childRuntimes.get(this.focusedSurface()!.appId) : this.rootRuntime;
        if (!target) throw new Error("preview runtime is not ready");
        await target.probe.checked({ op: "send", message: { method: "input.text", params: admitted } });
      } else if (kind === "accessibility") {
        const preferences = parseAccessibilityPreferences(input.preferences);
        this.accessibilityPreferences = preferences;
        const root = this.rootRuntime;
        if (!root) throw new Error("preview runtime is not ready");
        await this.replayAccessibilityPreferences(root);
        for (const child of this.childRuntimes.values()) {
          await this.replayAccessibilityPreferences(child);
        }
      } else if (kind === "semantic") {
        const action = parseAccessibilityAction(input);
        let target: PreviewRuntime | undefined;
        if (action.runtime) {
          target = this.childRuntimes.get(action.runtime);
          const focused = this.focusedSurface();
          if (!target || !focused || focused.appId !== action.runtime ||
              action.runtimeToken !== `${target.instanceId}:${target.generation}`) return;
        } else {
          target = this.rootRuntime;
          if (!target || (action.runtimeToken !== undefined && action.runtimeToken !== `${target.instanceId}:${target.generation}`)) return;
        }
        const snapshot = target.accessibilitySnapshot;
        const control = snapshot?.generation === action.generation
          ? snapshot.controls.find((candidate) => candidate.guestId === action.guestId && candidate.nativeId === action.nativeId)
          : undefined;
        if (!control || control.disabled || !control.enabled) return;
        await target.probe.checked({
          op: "send",
          message: {
            type: "event",
            name: accessibilityActionEvent,
            payload: {
              action: action.action,
              guestId: action.guestId,
              nativeId: action.nativeId,
              generation: action.generation,
            },
          },
        });
        target.needsPump = true;
      } else if (kind === "message") {
        const message = asRecord(input.message, "message");
        // Browser media diagnostics use the same guest event lane as the
        // Flutter decoder. Composite child frames carry a private runtime
        // tag so the state is delivered to the owning child probe; the tag
        // itself is not part of the guest-facing `video.state` payload.
        const messageName = typeof message.name === "string" ? message.name : "";
        const messagePayload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
          ? message.payload as JsonRecord
          : undefined;
        const runtimeId = messageName === "video.state" && typeof messagePayload?.runtime === "string"
          ? messagePayload.runtime
          : undefined;
        if (runtimeId) {
          const target = this.childRuntimes.get(runtimeId);
          const runtimeToken = typeof messagePayload?.runtimeToken === "string" ? messagePayload.runtimeToken : "";
          // A decoder can finish or report an error after its child runtime
          // was destroyed. Treat that diagnostic as an acknowledged stale
          // fact; never poison the session or deliver it to a newly-created
          // child with the same app id.
          if (!target || runtimeToken !== `${target.instanceId}:${target.generation}`) return;
          const { runtime: _runtime, runtimeToken: _runtimeToken, ...guestPayload } = messagePayload!;
          await target.probe.checked({ op: "send", message: { ...message, payload: guestPayload } });
          target.needsPump = true;
        } else if (typeof input.runtime === "string" && input.runtime) {
          // Browser text-input events carry their owning child runtime on the
          // outer request. Validate its instance generation before dispatching
          // so a late DOM edit cannot enter a newly-created child with the
          // same catalog app id.
          const target = this.childRuntimes.get(input.runtime);
          const runtimeToken = typeof input.runtimeToken === "string" ? input.runtimeToken : "";
          if (!target || runtimeToken !== `${target.instanceId}:${target.generation}`) return;
          await target.probe.checked({ op: "send", message });
          target.needsPump = true;
        } else if (typeof input.runtimeToken === "string" && input.runtimeToken) {
          // Root SystemUI uses a stable instance name but a monotonically
          // increasing generation across probe rebuilds. Keep the same stale
          // edit protection as child video/text events without adding a
          // second root routing protocol.
          if (!this.rootRuntime || input.runtimeToken !== `${this.rootRuntime.instanceId}:${this.rootRuntime.generation}`) return;
          await this.rootRuntime.probe.checked({ op: "send", message });
          this.rootRuntime.needsPump = true;
        } else {
          await probe.checked({ op: "send", message });
        }
      } else if (kind === "plugin-message") {
        await this.handleBrowserPluginMessage(input);
      } else if (kind === "plugin-disable") {
        this.handleBrowserPluginDisable(input);
      } else {
        throw new Error("preview input type must be pointer, text, key, accessibility, semantic, resize, message, plugin-message, or plugin-disable");
      }
      await this.tickNow(0);
      if (kind === "accessibility") {
        // tickNow settles the root and focused child. A cached preference is a
        // fact for every existing guest, including background children; drain
        // those marked runtimes once without changing elapsed animation time.
        const focusedAppId = this.focusedSurface()?.appId;
        let pumpedBackgroundChild = false;
        for (const child of this.childRuntimes.values()) {
          if (child.appId === focusedAppId || !child.needsPump) continue;
          await this.pumpRuntime(child, 0);
          pumpedBackgroundChild = true;
        }
        if (pumpedBackgroundChild) await this.schedule();
      }
    });
  }

  private validateTextEvent(event: JsonRecord): JsonRecord {
    const kind = event.kind;
    if (kind === "keyDown" || kind === "keyUp") {
      if (typeof event.key !== "string" || event.key.length === 0 || event.key.length > 128) throw new Error("text key must be a non-empty string of at most 128 characters");
      return { kind, key: event.key, repeat: event.repeat === true };
    }
    if (kind === "commit") {
      if (typeof event.text !== "string" || event.text.length > 4096) throw new Error("text commit is too long");
      return { kind, text: event.text };
    }
    if (kind === "composition") {
      if (typeof event.text !== "string" || event.text.length > 4096) throw new Error("text composition is too long");
      const start = integerIn(event.selectionStart, "selectionStart", 0, 1_000_000);
      const end = integerIn(event.selectionEnd, "selectionEnd", start, 1_000_000);
      return { kind, text: event.text, selectionStart: start, selectionEnd: end };
    }
    if (kind === "compositionEnd") return { kind };
    throw new Error(`unsupported text event kind: ${String(kind)}`);
  }

  private async handleBrowserPluginMessage(input: JsonRecord): Promise<void> {
    const owner = this.webBluetoothOwner;
    const clientId = typeof input.clientId === "string" ? input.clientId : "";
    const token = typeof input.token === "string" ? input.token : "";
    // A reply racing a disabled/reconnected browser adapter is stale input,
    // not a native preview failure. Ignore it so the session remains usable.
    if (!owner || owner.clientId !== clientId || !token) return;
    const message = input.message && typeof input.message === "object" && !Array.isArray(input.message)
      ? input.message as JsonRecord
      : undefined;
    if (!message) throw new Error("Noble Bluetooth adapter message is invalid");
    const name = eventName(message);
    const payload = eventPayload(message);
    if (!payload) throw new Error("Noble Bluetooth adapter message payload is invalid");
    if (name === "host.response") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
      const request = this.browserPluginRequests.get(this.pluginRequestKey(token, requestId));
      if (!request || request.lease !== owner.lease || payload.capability !== request.capability) return;
      this.clearBrowserPluginTimer(request);
      this.browserPluginRequests.delete(this.pluginRequestKey(token, requestId));
      await request.runtime.probe.checked({ op: "send", message });
      request.runtime.needsPump = true;
      await this.tickNow(0);
      return;
    }
    const streamId = typeof payload.streamId === "string" ? payload.streamId : "";
    const stream = this.browserPluginStreams.get(this.pluginRequestKey(token, streamId));
    if (!stream || stream.lease !== owner.lease) return;
    if (name === "stream.data" || name === "stream.error" || name === "stream.end") {
      await stream.runtime.probe.checked({ op: "send", message });
      stream.runtime.needsPump = true;
      if (name === "stream.end" || name === "stream.error") {
        this.clearBrowserPluginTimer(stream);
        this.browserPluginStreams.delete(this.pluginRequestKey(token, streamId));
      }
      await this.tickNow(0);
      return;
    }
    if (name === "stream.open") {
      this.clearBrowserPluginTimer(stream);
      return;
    }
    throw new Error(`unsupported Noble Bluetooth adapter message: ${name}`);
  }

  private handleBrowserPluginDisable(input: JsonRecord): void {
    const owner = this.webBluetoothOwner;
    const clientId = typeof input.clientId === "string" ? input.clientId : "";
    if (!owner || owner.clientId !== clientId) return;
    this.releaseWebBluetoothOwner(owner.lease);
  }

  stream(browserPresentation = false, webBluetooth?: { clientId: string; lease: string }, compactResources = false, externalResources = false): Response {
    this.touch();
    const encoder = new TextEncoder();
    let subscriber!: Subscriber;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { controller, closed: false, browserPresentation, compactResources, externalResources, ...(webBluetooth ? { webBluetooth } : {}) };
        this.subscribers.add(subscriber);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", status: this.status() })}\n\n`));
        const replay = this.replayFrame();
        if (replay) controller.enqueue(externalResources ? this.encodeExternalPacket({ type: "frame", revision: this.artifactRevision ?? null, frame: replay }) : encodePreviewStreamPacket({ type: "frame", revision: this.artifactRevision ?? null, frame: replay }, compactResources));
        this.flushWebBluetoothQueue(subscriber);
        void this.schedule().catch((error) => this.reportError(error));
      },
      cancel: () => {
        subscriber.closed = true;
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0 && this.tickTimer) {
          clearTimeout(this.tickTimer);
          this.tickTimer = undefined;
          this.tickDeadlineAt = undefined;
        }
        if (this.subscribers.size === 0) this.armIdleCleanup();
        if (subscriber.webBluetooth && this.webBluetoothOwner?.lease === subscriber.webBluetooth.lease) {
          const ownerStillConnected = [...this.subscribers].some((candidate) =>
            !candidate.closed && candidate.webBluetooth?.lease === subscriber.webBluetooth?.lease);
          if (!ownerStillConnected) this.releaseWebBluetoothOwner(subscriber.webBluetooth.lease);
        }
        this.failPendingPresentationsIfBrowserGone();
        if (subscriber.browserPresentation) this.cancelActivePointersIfBrowserGone();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
        connection: "keep-alive",
        "x-pocket-preview-transport": "native-probe-full-frames",
      },
    });
  }

  reportError(error: unknown, runtime = this.rootRuntime): void {
    const repeated = this.state === "error" && this.error === errorText(error);
    this.state = "error";
    this.error = errorText(error);
    if (!repeated) void this.manager.options.diagnostics?.recordCrash(error, {
      source: "studio.preview", projectId: this.id, revision: this.artifactRevision,
      runtimeId: runtime?.appId,
      data: { frame: this.frame?.frame, children: [...this.childRuntimes.keys()] },
    }).catch((failure) => console.error("Preview crash record could not be persisted", failure));
    this.emit({ type: "error", error: this.error });
  }

  status(): PreviewStatus {
    return {
      projectId: this.id,
      state: this.state,
      ...(this.artifactRevision === undefined ? {} : { revision: this.artifactRevision }),
      width: this.width,
      height: this.height,
      tickHz: this.tickHz,
      nextWakeDelayMs: this.nextWakeDelay,
      lastFrame: this.frame?.frame ?? null,
      transport: "native-probe-full-frames",
      unsupported: ["native hardware/plugins"],
      ...(this.error ? { error: this.error } : {}),
      ...(this.hotReload ? { hotReload: this.hotReload } : {}),
    };
  }

  snapshot(): JsonRecord {
    return { status: this.status(), frame: this.replayFrame() ?? null };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.stopProbe();
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      try { subscriber.controller.close(); } catch { /* client already disconnected */ }
    }
    this.subscribers.clear();
    this.releaseWebBluetoothOwner();
    this.state = "stopped";
  }
}

export interface PreviewManager {
  handle(request: Request, projectId: string, endpoint?: string): Promise<Response>;
  status(projectId: string): Promise<PreviewStatus>;
  dispose(): Promise<void>;
}

class PreviewManagerImpl implements PreviewManager {
  readonly options: PreviewManagerOptions;
  private readonly sessions = new Map<string, PreviewSession>();
  private probePathPromise?: Promise<string>;

  constructor(options: PreviewManagerOptions) {
    this.options = options;
  }

  async resolveArtifacts(projectId: string): Promise<PreviewProject | undefined> {
    const value = this.options.artifacts ?? this.options.artifact;
    const artifacts = await resolveValue(value, projectId);
    return artifacts ? { ...artifacts } : undefined;
  }

  async resolveWorkerHttpOrigins(projectId: string): Promise<readonly string[]> {
    const origins = await resolveValue(this.options.workerHttpOrigins, projectId);
    if (origins === undefined) return [];
    if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string" || origin.length === 0 || origin.length > 512)) {
      throw new Error("preview workerHttpOrigins must be a string array");
    }
    return [...new Set(origins)];
  }

  async findProbe(): Promise<string> {
    if (!this.probePathPromise) {
      this.probePathPromise = Promise.resolve(resolveNativeProbePath(editorRoot, this.options.probePath ?? process.env.POCKET_NATIVE_PROBE));
    }
    return this.probePathPromise;
  }

  private session(projectId: string): PreviewSession {
    const id = String(projectId);
    let value = this.sessions.get(id);
    if (!value) {
      const maxSessions = Math.max(1, Math.min(64, this.options.maxSessions ?? 8));
      if (this.sessions.size >= maxSessions) {
        const idle = [...this.sessions.values()]
          .filter((candidate) => candidate.isIdle())
          .sort((left, right) => left.idleSince() - right.idleSince())[0];
        if (idle) {
          this.sessions.delete(idle.id);
          void idle.dispose().catch((error) => idle.reportError(error));
        } else {
          throw new Error(`preview session limit reached (${maxSessions}); close an existing preview first`);
        }
      }
      value = new PreviewSession(this, id);
      this.sessions.set(id, value);
    }
    value.touch();
    return value;
  }

  async evict(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || !session.isIdle()) return;
    this.sessions.delete(projectId);
    await session.dispose();
  }

  private async clientSource(): Promise<string> {
    const path = this.options.clientPath ?? join(dirname(fileURLToPath(import.meta.url)), "client/preview.js");
    const source = await readFile(path, "utf8");
    const editorDirectory = dirname(fileURLToPath(import.meta.url));
    const [optics, shader] = await Promise.all([
      readFile(join(editorDirectory, "client/liquid-glass.js"), "utf8"),
      readFile(join(editorDirectory, "../packages/pocket_flutter/shaders/liquid_glass.frag"), "utf8"),
    ]);
    const projection = optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
    // Bluetooth is served by the local Noble helper. Do not inject a browser
    // browser Bluetooth adapter into the projection document.
    return `${projection}\n${source}`;
  }

  private async document(projectId: string): Promise<Response> {
    const source = (await this.clientSource()).replace(/<\/script/gi, "<\\/script");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PocketJS Preview</title></head>
<body data-pocket-preview data-project-id=${JSON.stringify(projectId)}><script>${source}</script></body></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'self'",
        "x-frame-options": "SAMEORIGIN",
      },
    });
  }

  async handle(request: Request, projectId: string, endpoint?: string): Promise<Response> {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(projectId)) return failure("invalid preview project id", 400);
    const route = routeName(request, endpoint);
    let session: PreviewSession | undefined;
    try {
      session = this.session(projectId);
      if (route === "resource" && (request.method === "GET" || request.method === "HEAD")) return session.serveResource(request);
      if (route === "media" && (request.method === "GET" || request.method === "HEAD")) {
        // Media is an ordinary loose project asset. It must not start a
        // native runtime merely because a browser decoder asks for bytes.
        return await session.serveMedia(request, new URL(request.url).searchParams.get("asset"));
      }
      if (route === "page" && request.method === "GET") {
        const page = await this.document(projectId);
        session.armIdleCleanup();
        return page;
      }
      if (route === "stream" && request.method === "GET") {
        const query = new URL(request.url).searchParams;
        const webBluetooth = query.get("webBluetooth") === "1" || query.get("bluetooth") === "1";
        const clientId = query.get("clientId") ?? "";
        // The legacy `bluetoothProvider` query is ignored deliberately. Noble
        // is the only supported editor transport.
        if (webBluetooth && !this.options.localBluetooth) return failure("Noble Bluetooth is unavailable on this editor host", 400);
        const pluginOwner = webBluetooth ? session.claimWebBluetooth(clientId, "local") : undefined;
        if (webBluetooth && !pluginOwner) return failure("Noble Bluetooth client could not claim the preview", 409);
        await session.ensureStarted();
        return session.stream(query.get("presentation") === "browser", pluginOwner, query.get("resources") === "base64", query.get("resources") === "http");
      }
      if (route === "status" && request.method === "GET") return json(session.status());
      if (route === "snapshot" && request.method === "GET") return json(session.snapshot());
      if (route === "input" && request.method === "POST") {
        const body = await requestJson(request);
        await session.sendInput(body);
        if (session.isIdle()) session.armIdleCleanup();
        return json({ ok: true, status: session.status() });
      }
      return failure("not found", 404);
    } catch (error) {
      const message = errorText(error);
      // A rejected browser event must not poison an otherwise healthy native
      // runtime. Native guest/transport failures still move the session to
      // error so the UI can show a real fault rather than silently stalling.
      if (route !== "input" || !isRecoverableInputFailure(message)) session?.reportError(error);
      else await this.options.diagnostics?.recordLog({
        source: "studio.preview.input", projectId, severity: "warn", message,
        data: { route },
      }).catch((failure) => console.error("Preview input record could not be persisted", failure));
      return failure(message, message.includes("not found") ? 404 : 400);
    }
  }

  async status(projectId: string): Promise<PreviewStatus> {
    return this.session(projectId).status();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.dispose()));
    this.sessions.clear();
    await this.options.localBluetooth?.dispose();
  }
}

/** Create a no-listener manager for the Editor server or another local host. */
export function createPreviewManager(options: PreviewManagerOptions = {}): PreviewManager {
  return new PreviewManagerImpl(options);
}

export const previewProtocol = {
  version: 1,
  stream: "GET /api/projects/:id/preview/stream (SSE)",
  input: "POST /api/projects/:id/preview/input",
  frame: "data: {type:'frame',revision,frame:FrameResult}",
  pointer: "{type:'pointer',phase:'down|move|up|cancel',id,x,y,surface?}",
  text: "{type:'text',events:[{kind:'keyDown|keyUp|commit|composition|compositionEnd',...}]} ",
  semantic: "{type:'semantic',action:'activate',guestId,nativeId,generation,runtime?,runtimeToken?}",
  wheel: "browser wheel is translated to a real pointer drag; native probe has no wheel method",
  resize: "{type:'resize',width,height,safeArea?:{top,right,bottom,left}}",
  media: "GET|HEAD /api/projects/:id/preview/media?asset=<scope-prefixed assets/...>",
} as const;

