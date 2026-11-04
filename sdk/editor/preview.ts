/**
 * Pocket Studio's real web preview bridge.
 *
 * The browser is deliberately only a Canvas2D projection.  Guest source is
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
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

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
  /** Trusted System catalog package-to-surface handles, or derive from pocket.system.json. */
  compositorSurfaces?: Record<string, number>;
  /** Trusted installed child guest artifacts, keyed by catalog package ID. */
  applications?: Record<string, PreviewArtifactPaths>;
  /** Optional package identity for an installed child artifact. */
  appId?: string;
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
};

export type PreviewResolver<T> = T | ((projectId: string) => T | Promise<T>);

export type PreviewManagerOptions = {
  /** Resolve the project directory used by the caller's Editor state. */
  projectDirectory?: PreviewResolver<string>;
  /** Resolve real artifact paths. `artifact` is an accepted singular alias. */
  artifacts?: PreviewResolver<PreviewArtifactPaths>;
  artifact?: PreviewResolver<PreviewArtifactPaths>;
  /** Override the discovered native probe, primarily for tests/CI. */
  probePath?: string;
  width?: number;
  height?: number;
  rasterDensity?: number;
  tickHz?: number;
  commandTimeoutMs?: number;
  /** Bound retained project sessions; idle sessions are evicted first. */
  maxSessions?: number;
  /** Release an idle native probe after the last SSE client disconnects. */
  idleDisposeMs?: number;
  /** Override the checked-in browser projection file for an embedding build. */
  clientPath?: string;
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
};

type JsonRecord = Record<string, unknown>;
const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProbeCandidates = [
  join(editorRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
  join(editorRoot, "native/target/release/pocket_probe"),
  join(editorRoot, "native/target/debug/pocket_probe"),
];
const maxInputBytes = 64 * 1024;
const maxFrameBytes = 64 * 1024 * 1024;

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
    message.startsWith("preview input type") ||
    message.includes("input.pointer") ||
    message.includes("input.text");
}

function resolveValue<T>(value: PreviewResolver<T> | undefined, projectId: string): Promise<T | undefined> {
  if (value === undefined) return Promise.resolve(undefined);
  return Promise.resolve(typeof value === "function" ? (value as (id: string) => T | Promise<T>)(projectId) : value);
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
  return { systemUI, installed, catalog };
}

/**
 * The SystemUI guest validates the complete installed-child registry before
 * its first layout. Flutter normally supplies this through
 * PocketView.compositorSurfaces; a local Editor has no Flutter widget, so use
 * the same trusted source manifest when it is present. This only allocates
 * handles for installed catalog children and never fabricates a child guest.
 */
async function compositorSurfacesFromProject(projectDirectory: string | undefined): Promise<Record<string, number> | undefined> {
  const system = await systemCatalogFromProject(projectDirectory);
  if (!system) return undefined;
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
  return "page";
}

async function requestJson(request: Request): Promise<JsonRecord> {
  const text = await request.text();
  if (Buffer.byteLength(text) > maxInputBytes) throw new Error("preview input is too large");
  if (!text) return {};
  return asRecord(JSON.parse(text), "preview input");
}

/** A serialized line-oriented client for the checked-in native probe. */
class NativeProbe {
  readonly path: string;
  readonly timeoutMs: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending: Array<{ resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly stderr: string[] = [];
  private closed = false;

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
    const next = this.pending.shift();
    if (!next) return;
    clearTimeout(next.timer);
    try {
      const parsed = JSON.parse(line) as unknown;
      next.resolve(asRecord(parsed, "probe response"));
    } catch (error) {
      next.reject(new Error(`invalid pocket_probe response: ${errorText(error)}`));
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    while (this.pending.length) {
      const next = this.pending.shift()!;
      clearTimeout(next.timer);
      next.reject(new Error(`${error.message}${this.stderr.length ? `: ${this.stderr.join("").trim()}` : ""}`));
    }
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
    const response = await this.command(command);
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "pocket_probe operation failed");
    return response;
  }

  async stop(): Promise<void> {
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

type PreviewRuntime = {
  appId: string;
  instanceId: string;
  generation: number;
  probe: NativeProbe;
  artifacts: PreviewProject;
  /** Native guest viewport; child guests are resized to their selected host
   * surface rather than inheriting the browser/root viewport. */
  viewportWidth: number;
  viewportHeight: number;
  frame?: PreviewFrame;
  resources: Map<string, JsonRecord>;
  initialEvents: JsonRecord[];
  needsPump: boolean;
  pumping: number;
};

type PendingSystemRequest = {
  source: PreviewRuntime;
  requestId: string;
  capability: string;
  params: JsonRecord;
  sent: boolean;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
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

type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean; browserPresentation: boolean };

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
  private readonly pendingSystemRequests = new Map<string, PendingSystemRequest>();
  private readonly pendingPresentations = new Map<string, {
    child: PreviewRuntime; published: boolean;
    respond: (result: unknown, error?: JsonRecord) => Promise<void>;
  }>();
  private readonly pointerTargets = new Map<number, PointerTarget>();
  private readonly storage = new Map<string, JsonRecord | null>();
  private systemCatalog?: SystemCatalog;
  private systemConfigured = false;
  private nextInstanceId = 0;
  private nextSystemRequestId = 0;
  private childArtifacts: Record<string, PreviewArtifactPaths> = {};
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
  private frame?: PreviewFrame;
  /** Native FrameResult resources are deltas; retain live assets for a fresh
   * SSE subscriber/snapshot without inflating every animation frame. */
  private readonly resourceCache = new Map<string, Record<string, unknown>>();
  /** Resources removed between compositor frames must be explicitly retired
   * in the browser projection; deleting only the server cache cannot update an
   * already-connected canvas client. */
  private readonly pendingReleasedResources = new Set<string>();
  private state: PreviewStatus["state"] = "stopped";
  private error?: string;
  private width: number;
  private height: number;
  private tickHz: number;

  constructor(manager: PreviewManagerImpl, id: string) {
    this.manager = manager;
    this.id = id;
    this.width = manager.options.width ?? 390;
    this.height = manager.options.height ?? 844;
    this.tickHz = manager.options.tickHz ?? 60;
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
      artifactIdentity,
      JSON.stringify(artifacts.compositorSurfaces ?? {}),
      JSON.stringify(artifacts.applications ?? {}),
    ].join("|");
  }

  private async resolvedArtifacts(): Promise<ResolvedPreviewProject> {
    const artifacts = await this.manager.resolveArtifacts(this.id);
    if (!artifacts) throw new Error(`no preview artifacts were supplied for project ${this.id}`);
    const projectDirectory = await resolveValue(this.manager.options.projectDirectory, this.id);
    const result: PreviewProject = {
      ...artifacts,
      bytecodePath: artifacts.bytecodePath ?? artifacts.bytecode,
      pakPath: artifacts.pakPath ?? artifacts.pak,
      sourcePath: artifacts.sourcePath ?? artifacts.appJs,
      metadataPath: artifacts.metadataPath ?? artifacts.metadata,
      ...(projectDirectory ? { projectDirectory } : {}),
    };
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
    return { ...result, artifactFingerprint: fingerprints.join(";") };
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
    this.starting = (async () => {
      await this.stopProbe();
      this.state = "starting";
      this.error = undefined;
      this.tickHz = artifacts.tickHz ?? this.manager.options.tickHz ?? 60;
      const probePath = await this.manager.findProbe();
      const probe = new NativeProbe(probePath, this.manager.options.commandTimeoutMs ?? 15_000);
      try {
        await probe.checked({
          op: "create",
          width: this.width,
          height: this.height,
          rasterDensity: this.manager.options.rasterDensity ?? 1,
          tickHz: this.tickHz,
          ...(artifacts.compositorSurfaces && Object.keys(artifacts.compositorSurfaces).length > 0
            ? { compositorSurfaces: artifacts.compositorSurfaces }
            : {}),
        });
        if (artifacts.bytecodePath) {
          await probe.checked({ op: "loadBytecode", bytecodePath: artifacts.bytecodePath, pakPath: artifacts.pakPath });
        } else {
          await probe.checked({ op: "load", sourcePath: artifacts.sourcePath, pakPath: artifacts.pakPath });
        }
        this.probe = probe;
        this.rootRuntime = {
          appId: this.systemCatalog?.systemUI ?? (artifacts.appId ?? this.id),
          instanceId: "system-ui",
          generation: 1,
          probe,
          artifacts,
          viewportWidth: this.width,
          viewportHeight: this.height,
          resources: new Map(),
          initialEvents: [],
          needsPump: false,
          pumping: 0,
        };
        this.childRuntimes.clear();
        this.pendingSystemRequests.clear();
        this.systemConfigured = false;
        this.nextInstanceId = 0;
        this.nextSystemRequestId = 0;
        this.artifactSignature = signature;
        this.artifactRevision = artifacts.revision;
        this.state = "ready";
        this.lastTickAt = monotonicNow();
        await this.tickNow(1000 / this.tickHz);
      } catch (error) {
        await probe.stop();
        throw error;
      }
    })();
    try {
      await this.starting;
    } catch (error) {
      this.state = "error";
      this.error = errorText(error);
      this.emit({ type: "error", error: this.error });
      throw error;
    } finally {
      this.starting = undefined;
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
    const stopError = new Error("preview runtime stopped before the SystemUI request completed");
    for (const [requestId, pending] of this.pendingSystemRequests) {
      this.pendingSystemRequests.delete(requestId);
      pending.reject(stopError);
    }
    const probe = this.probe;
    this.probe = undefined;
    const children = [...this.childRuntimes.values()];
    this.childRuntimes.clear();
    this.rootRuntime = undefined;
    this.pointerTargets.clear();
    await Promise.all(children.map((runtime) => runtime.probe.stop()));
    this.artifactSignature = undefined;
    this.nextWakeDelay = null;
    for (const asset of this.resourceCache.keys()) this.pendingReleasedResources.add(asset);
    this.resourceCache.clear();
    if (probe) await probe.stop();
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
    const packet = `data: ${JSON.stringify(value)}\n\n`;
    const bytes = new TextEncoder().encode(packet);
    let subscriberDropped = false;
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      try {
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
    await runtime.probe.checked({
      op: "send",
      message: { type: "event", name: "host.response", payload },
    });
    runtime.needsPump = true;
  }

  private async pumpRuntime(runtime: PreviewRuntime, deltaMs: number, depth = 0): Promise<void> {
    if (this.disposed) return;
    if (depth > 48) throw new Error("preview system runtime event depth exceeded");
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
        const response = await runtime.probe.checked({ op: "frame", deltaMs: delta });
        delta = 0;
        if (response.frame === undefined) continue;
        const frameJson = JSON.stringify(response.frame);
        if (Buffer.byteLength(frameJson) > maxFrameBytes) throw new Error(`native preview frame for ${runtime.appId} exceeds the safety limit`);
        const frame = asFrame(response.frame);
        runtime.frame = frame;
        if (runtime.initialEvents.length === 0) {
          runtime.initialEvents = frame.events.filter((event): event is JsonRecord =>
            !!event && typeof event === "object" && !Array.isArray(event) && eventName(event as JsonRecord) === "host.request",
          ) as JsonRecord[];
        }
        this.runtimeResourceCache(runtime, frame);
        for (const event of frame.events) {
          if (!event || typeof event !== "object" || Array.isArray(event)) continue;
          await this.handleRuntimeEvent(runtime, event as JsonRecord, depth + 1);
        }
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

  private async handleRuntimeEvent(runtime: PreviewRuntime, event: JsonRecord, depth: number): Promise<void> {
    if (eventName(event) !== "host.request") return;
    const payload = eventPayload(event);
    if (!payload || typeof payload.requestId !== "string" || typeof payload.capability !== "string") return;
    const requestId = payload.requestId;
    const capability = payload.capability;
    const params = payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? payload.params as JsonRecord
      : {};

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
      await this.sendHostResponse(runtime, requestId, capability, this.genericCapabilityResult(runtime, capability, params));
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

  private genericCapabilityResult(runtime: PreviewRuntime, capability: string, params: JsonRecord): unknown {
    if (capability === "runtime.info") {
      return {
        entryFormat: "quickjs-bytecode",
        runtimeAbi: "native-pocket-probe",
        source: "editor-preview",
        appId: runtime.appId,
      };
    }
    if (capability === "runtime.performance") return { supported: false, context: params.context ?? null };
    if (capability === "plugins.list") return [];
    if (capability === "plugins.packageInfo") return { provider: "editor-preview", appId: runtime.appId };
    if (capability === "updates.status") return { configured: false, stage: "disabled", activeVersion: null, availableVersion: null };
    if (capability === "platform.systemUi.set") return { accepted: true };
    if (capability === "platform.messages.send" || capability === "platform.messages.receive") {
      return { supported: false, reason: "System catalog is required for app messaging in the preview" };
    }
    // Hardware, video and other native-only plugins remain explicitly
    // non-emulated. Return a real failure so an app cannot wait forever or
    // mistake the browser projection for device capability success.
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
    // A child can issue storage/message/app requests while SystemUI is
    // synchronously servicing its own runtime.awaitFirstFrame. Pumping the
    // root recursively in that window deadlocks JS SystemUI's serialized
    // queue. Keep the request pending and let the outer root turn service it
    // after awaitFirstFrame returns; the later system.runtime.respond path
    // pumps the child again.
    const deferToOuterRootTurn = source !== root && root.pumping > 0;
    const response = deferToOuterRootTurn
      ? undefined
      : new Promise<boolean>((resolveResponse, rejectResponse) => {
        this.pendingSystemRequests.set(requestId, {
          source,
          requestId: originalRequestId,
          capability,
          params,
          sent: false,
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
        const child = await this.createChildRuntime(appId, memory);
        await respond({ instanceId: child.instanceId, appId: child.appId, generation: child.generation });
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
        await child.probe.stop();
        await respond({ destroyed: true });
        return;
      }
      if (capability === "system.runtime.post") {
        const child = this.runtimeByInstance(params.instanceId);
        const event = params.event;
        if (!child || typeof event !== "string" || !event) throw new Error("runtime.post target/event is invalid");
        const eventParams = params.params && typeof params.params === "object" && !Array.isArray(params.params) ? params.params : {};
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
        if (pending.source.pumping > 0) pending.source.needsPump = true;
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

  private async createChildRuntime(appId: string, memory?: JsonRecord): Promise<PreviewRuntime> {
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
    const probePath = await this.manager.findProbe();
    const probe = new NativeProbe(probePath, this.manager.options.commandTimeoutMs ?? 15_000);
    const initialSlot = this.preferredViewportSlots(this.rootRuntime?.frame).get(appId);
    const initialWidth = initialSlot ? Math.max(1, Math.round(initialSlot.w)) : this.width;
    const initialHeight = initialSlot ? Math.max(1, Math.round(initialSlot.h)) : this.height;
    const runtime: PreviewRuntime = {
      appId,
      instanceId: `pocket-app-${++this.nextInstanceId}`,
      generation: 1,
      probe,
      artifacts,
      viewportWidth: initialWidth,
      viewportHeight: initialHeight,
      resources: new Map(),
      initialEvents: [],
      needsPump: false,
      pumping: 0,
    };
    try {
      await probe.checked({
        op: "create",
        width: initialWidth,
        height: initialHeight,
        rasterDensity: this.manager.options.rasterDensity ?? 1,
        tickHz: this.tickHz,
        ...(memory ? { memory } : {}),
      });
      if (artifacts.bytecodePath) await probe.checked({ op: "loadBytecode", bytecodePath: artifacts.bytecodePath, pakPath: artifacts.pakPath });
      else await probe.checked({ op: "load", sourcePath: artifacts.sourcePath, pakPath: artifacts.pakPath });
      this.childRuntimes.set(appId, runtime);
      return runtime;
    } catch (error) {
      await probe.stop();
      throw error;
    }
  }

  private surfaceSlots(frame: PreviewFrame): SurfaceSlot[] {
    return frame.ops.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "hostSurface") return [];
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
    for (const [appId, slot] of this.preferredViewportSlots(frame)) {
      const runtime = this.childRuntimes.get(appId);
      if (!runtime) continue;
      const width = Math.max(1, Math.round(slot.w));
      const height = Math.max(1, Math.round(slot.h));
      if (runtime.viewportWidth === width && runtime.viewportHeight === height) continue;
      await runtime.probe.checked({ op: "resize", width, height });
      runtime.viewportWidth = width;
      runtime.viewportHeight = height;
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
    const focusedChild = focusedSlot ? this.childRuntimes.get(focusedSlot.appId)?.frame : undefined;
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
      childOps.set(slot.handle, child.frame.ops.map((op) => transformedChildOp(op, slot, child.frame!, prefix)));
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
    const { inputBounds: _nativeInputBounds, ...rootFrame } = root;
    return {
      ...rootFrame,
      ...(inputBounds ? { inputBounds } : {}),
      presentationTokens: [...this.pendingPresentations].filter(([, pending]) =>
        slots.some(slot => slot.appId === pending.child.appId && slot.w > 0 && slot.h > 0 &&
          slot.x < root.width && slot.y < root.height && slot.x + slot.w > 0 && slot.y + slot.h > 0))
        .map(([token]) => token),
      ops,
      // SSE carries native resource deltas. A reconnect gets the full cache
      // through replayFrame(); retransmitting every atlas on every animation
      // tick makes the browser decode megabytes instead of painting frames.
      resources: [...rootResources, ...childResources].filter(resource => {
        const previous = this.resourceCache.get(String(resource.asset));
        return !previous || previous.revision === undefined || resource.revision === undefined ||
          previous.revision !== resource.revision || previous.width !== resource.width ||
          previous.height !== resource.height || previous.psm !== resource.psm;
      }),
      releasedResources: [...releasedResources],
      events: root.events.length > 0 ? root.events : (this.rootRuntime?.initialEvents ?? []),
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
    if (child) {
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
    const minimum = this.nextWakeDelay === 0 ? 1000 / this.tickHz : this.nextWakeDelay;
    const delay = Math.max(1, Math.ceil(minimum));
    const deadline = monotonicNow() + delay;
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
    const resizedChildren = runtime.frame ? await this.syncChildViewports(runtime.frame) : new Set<PreviewRuntime>();
    // Resize-induced host requests must be consumed even for a currently
    // inactive surface. Focused children receive the real elapsed delta;
    // background children get a settle turn only, avoiding animation work
    // while still draining resize/host responses.
    for (const [appId, slot] of visibleSlots) {
      const child = this.childRuntimes.get(appId);
      if (!child || (!slot.focused && !resizedChildren.has(child))) continue;
      await this.pumpRuntime(child, slot.focused ? delta : 0);
    }
    // A child may emit its first-frame host request while the root is inside
    // system.runtime.awaitFirstFrame. That request is deferred to avoid
    // re-entering JS SystemUI's serialized queue; give the root a post-child
    // turn so it cannot remain pending until unrelated input arrives.
    for (
      let attempt = 0;
      attempt < 4 && this.rootRuntime && [...this.pendingSystemRequests.values()].some((pending) => pending.source !== this.rootRuntime && !pending.sent);
      attempt += 1
    ) {
      for (const [requestId, pending] of this.pendingSystemRequests) {
        if (pending.source !== this.rootRuntime && !pending.sent) await this.sendPendingSystemRequest(requestId, this.rootRuntime);
      }
      await this.pumpRuntime(this.rootRuntime, 0);
    }
    if (runtime.frame) {
      this.frame = this.compositeFrame(runtime.frame);
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
        await probe.checked({ op: "resize", width: this.width, height: this.height });
        if (this.rootRuntime) {
          this.rootRuntime.viewportWidth = this.width;
          this.rootRuntime.viewportHeight = this.height;
        }
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
              this.lastTickAt = monotonicNow();
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
      } else if (kind === "message") {
        const message = asRecord(input.message, "message");
        await probe.checked({ op: "send", message });
      } else {
        throw new Error("preview input type must be pointer, text, key, resize, or message");
      }
      await this.tickNow(0);
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

  stream(browserPresentation = false): Response {
    this.touch();
    const encoder = new TextEncoder();
    let subscriber!: Subscriber;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { controller, closed: false, browserPresentation };
        this.subscribers.add(subscriber);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", status: this.status() })}\n\n`));
        const replay = this.replayFrame();
        if (replay) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "frame", revision: this.artifactRevision ?? null, frame: replay })}\n\n`));
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

  reportError(error: unknown): void {
    this.state = "error";
    this.error = errorText(error);
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
      unsupported: ["video", "native hardware/plugins"],
      ...(this.error ? { error: this.error } : {}),
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

  async findProbe(): Promise<string> {
    if (!this.probePathPromise) {
      this.probePathPromise = (async () => {
        const configured = this.options.probePath ?? process.env.POCKET_NATIVE_PROBE;
        const candidates = configured ? [configured] : defaultProbeCandidates;
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            const resolved = await realpath(candidate);
            const item = await stat(resolved);
            if (item.isFile()) return resolved;
          }
        }
        throw new Error(`pocket_probe was not found; build sdk/native/target/{debug,release}/pocket_probe or set POCKET_NATIVE_PROBE`);
      })();
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
    return readFile(path, "utf8");
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
      if (route === "page" && request.method === "GET") {
        const page = await this.document(projectId);
        session.armIdleCleanup();
        return page;
      }
      if (route === "stream" && request.method === "GET") {
        await session.ensureStarted();
        return session.stream(new URL(request.url).searchParams.get("presentation") === "browser");
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
      return failure(message, message.includes("not found") ? 404 : 400);
    }
  }

  async status(projectId: string): Promise<PreviewStatus> {
    return this.session(projectId).status();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.dispose()));
    this.sessions.clear();
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
  wheel: "browser wheel is translated to a real pointer drag; native probe has no wheel method",
  resize: "{type:'resize',width,height}",
} as const;

