import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";
import { showcaseCompositorSurfaces } from "../official_demos.ts";

export type JsonObject = Record<string, any>;

export type DrawOp = {
  type?: string;
  text?: string;
  color?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: Array<{ x: number; y: number }>;
  uvs?: number[];
  repeatTexture?: boolean;
  clip?: { x?: number; y?: number; w?: number; h?: number };
};

export type FrameEvent = { name?: string; payload?: JsonObject };
export type Frame = {
  events?: FrameEvent[];
  ops?: DrawOp[];
  frame?: number;
  width?: number;
  height?: number;
};

type ProbeOutput = { ok?: boolean; error?: string; frame?: Frame; runtimeAbi?: string };
export type HostRequest = { requestId: string; capability: string; params: JsonObject };

export type NativeArtifacts = {
  bytecodePath: string;
  pakPath: string;
  metadataPath: string;
  runtimeAbi: string;
};

type NativeStorageBatchOperation =
  | { type: "set"; key: string; value: unknown }
  | { type: "remove"; key: string };

class NativeStorageBatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeStorageBatchError";
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotStorageJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NativeStorageBatchError("invalid_json", "Storage values must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new NativeStorageBatchError("invalid_json", "Storage values cannot contain cycles.");
    ancestors.add(value);
    try { return value.map(item => snapshotStorageJson(item, ancestors)); }
    finally { ancestors.delete(value); }
  }
  if (isObjectRecord(value)) {
    if (ancestors.has(value)) throw new NativeStorageBatchError("invalid_json", "Storage values cannot contain cycles.");
    ancestors.add(value);
    try {
      const copied: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(copied, key, {
          value: snapshotStorageJson(item, ancestors),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return copied;
    } finally { ancestors.delete(value); }
  }
  throw new NativeStorageBatchError("invalid_json", "Storage values must be JSON-safe.");
}

function storageJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validStorageKey(key: string): boolean {
  return key.length > 0 && key !== "." && key !== ".." && !key.includes("/") &&
    !key.includes("\\") && !/[\u0000-\u001f\u007f]/.test(key) &&
    Buffer.byteLength(key, "utf8") <= 256;
}

/** Validate and deep-copy a whole batch before the test host mutates its store. */
function snapshotStorageBatch(value: unknown): NativeStorageBatchOperation[] {
  if (!Array.isArray(value)) throw new NativeStorageBatchError("invalid_storage_batch", "Storage batch operations must be an array.");
  if (value.length > 256) throw new NativeStorageBatchError("too_many_storage_operations", "Storage batches are limited to 256 operations.");
  const seen = new Set<string>();
  const copied: NativeStorageBatchOperation[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isObjectRecord(raw) || (raw.type !== "set" && raw.type !== "remove") || typeof raw.key !== "string" || !validStorageKey(raw.key)) {
      throw new NativeStorageBatchError("invalid_storage_operation", `Storage batch operation ${index} is invalid.`);
    }
    const allowed = raw.type === "set" ? ["type", "key", "value"] : ["type", "key"];
    if (Object.keys(raw).length !== allowed.length || Object.keys(raw).some(key => !allowed.includes(key)) ||
        raw.type === "set" && !Object.hasOwn(raw, "value")) {
      throw new NativeStorageBatchError("invalid_storage_operation", `Storage batch operation ${index} has an invalid shape.`);
    }
    if (seen.has(raw.key)) throw new NativeStorageBatchError("duplicate_storage_key", `Storage batch contains duplicate key '${raw.key}'.`);
    seen.add(raw.key);
    if (raw.type === "set") {
      const snapshot = snapshotStorageJson(raw.value);
      if (storageJsonBytes(snapshot) > 65_536) throw new NativeStorageBatchError("value_too_large", `Value for '${raw.key}' exceeds 64 KiB.`);
      copied.push({ type: "set", key: raw.key, value: snapshot });
    } else {
      copied.push({ type: "remove", key: raw.key });
    }
  }
  return copied;
}

const testRoot = resolve(import.meta.dir, "..");
const sdkRoot = resolve(testRoot, "..", "..", "sdk");
const flutterRoot = resolve(testRoot, "..");

function artifactPath(environment: string, fallback: string): string {
  return process.env[environment] ?? fallback;
}

function bytecodeCapable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path).includes(Buffer.from("compositorSurfaces"));
  } catch {
    return false;
  }
}

function probePath(): string {
  const configured = process.env.POCKET_NATIVE_PROBE;
  if (configured) return resolve(configured);
  const candidates = [
    join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
    join(sdkRoot, "native/target/release/pocket_probe"),
    join(sdkRoot, "native/target/debug/pocket_probe"),
  ];
  const candidate = candidates.find((path) => bytecodeCapable(path));
  assert.ok(candidate, "navigation_native: pocket_probe is required");
  return candidate!;
}

export function readNativeArtifacts(prefix = "POCKET_NAVIGATION"): NativeArtifacts {
  const bytecodePath = artifactPath(`${prefix}_GUEST_BYTECODE`, join(flutterRoot, "assets/app.qjbc"));
  const pakPath = artifactPath(`${prefix}_GUEST_PAK`, join(flutterRoot, "assets/app.pak"));
  const metadataPath = artifactPath(`${prefix}_GUEST_METADATA`, join(flutterRoot, "assets/app.bytecode.json"));
  assert.ok(existsSync(bytecodePath), `missing guest bytecode: ${bytecodePath}`);
  assert.ok(existsSync(pakPath), `missing guest pak: ${pakPath}`);
  assert.ok(existsSync(metadataPath), `missing guest metadata: ${metadataPath}`);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as JsonObject;
  assert.equal(metadata.entryFormat, "quickjs-bytecode", "navigation probe must consume QuickJS bytecode");
  assert.equal(metadata.kind, "script", "navigation probe artifact must be a serialized script");
  assert.equal(typeof metadata.runtimeAbi, "string", "navigation metadata must declare runtimeAbi");
  return { bytecodePath, pakPath, metadataPath, runtimeAbi: String(metadata.runtimeAbi) };
}

export function event(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

export function pointer(phase: "down" | "move" | "up", x: number, y: number): JsonObject {
  return event("input.pointer", { phase, id: 0, x, y });
}

export function textOps(frame: Frame, label: string): DrawOp[] {
  return (frame.ops ?? []).filter((op) => op.type === "text" && op.text === label);
}

export function textOp(frame: Frame, label: string, predicate?: (op: DrawOp) => boolean): DrawOp {
  const found = textOps(frame, label).find((op) => predicate?.(op) ?? true);
  assert.ok(found, `frame is missing painted text ${label}`);
  return found!;
}

export function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

export function center(op: DrawOp, label: string): { x: number; y: number } {
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

const activeSessions = new Set<NativeSession>();
process.once("exit", () => {
  for (const session of activeSessions) session.forceKill();
});

export class NativeSession {
  readonly requests: HostRequest[] = [];
  readonly storageGets: JsonObject[] = [];
  readonly storageSets: JsonObject[] = [];
  /** Successfully committed native-test storage batches. */
  readonly storageBatches: NativeStorageBatchOperation[][] = [];
  readonly storage: Record<string, any>;
  width: number;
  height: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly artifacts: NativeArtifacts;
  private readonly memory: { heapLimitBytes?: number; maxPakBytes?: number } | undefined;
  private output = "";
  private stderr = "";
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly deferredCapabilities: Set<string>;
  private readonly supportsStorageBatch: boolean;
  private readonly deferredRequests: HostRequest[] = [];
  private frameWaiters: Array<{ resolve: (frame: Frame) => void; reject: (error: Error) => void }> = [];
  private lineWaiters: Array<{ resolve: (output: ProbeOutput) => void; reject: (error: Error) => void }> = [];
  private exitError: Error | undefined;

  constructor(
    artifacts: NativeArtifacts,
    options: {
      width?: number;
      height?: number;
      storage?: Record<string, any>;
      supportsStorageBatch?: boolean;
      deferCapabilities?: readonly string[];
      deadlineMs?: number;
      memory?: { heapLimitBytes?: number; maxPakBytes?: number };
    } = {},
  ) {
    this.artifacts = artifacts;
    this.memory = options.memory;
    this.width = options.width ?? 390;
    this.height = options.height ?? 760;
    this.storage = options.storage ?? {};
    this.supportsStorageBatch = options.supportsStorageBatch ?? true;
    this.deferredCapabilities = new Set(options.deferCapabilities ?? []);
    this.child = spawn(probePath(), [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutDecoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => this.acceptOutput(stdoutDecoder.write(chunk)));
    this.child.stdout.on("end", () => this.acceptOutput(stdoutDecoder.end()));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (code !== 0 && !this.exitError) {
        this.fail(new Error(`pocket_probe exited ${String(code)} ${String(signal)}: ${this.stderr}`));
      }
    });
    activeSessions.add(this);
    const deadlineMs = options.deadlineMs ?? 40_000;
    this.deadline = setTimeout(() => this.fail(new Error(`native session: pocket_probe session exceeded ${deadlineMs}ms`)), deadlineMs);
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const waiter of this.frameWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.lineWaiters.splice(0)) waiter.reject(error);
    clearTimeout(this.deadline);
    activeSessions.delete(this);
    if (!this.child.killed) this.child.kill();
  }

  private acceptOutput(chunk: string): void {
    this.output += chunk;
    let newline = this.output.indexOf("\n");
    while (newline >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (line) this.acceptLine(line);
      newline = this.output.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    let parsed: ProbeOutput;
    try {
      parsed = JSON.parse(line) as ProbeOutput;
    } catch (error) {
      this.fail(new Error(`invalid pocket_probe JSON: ${String(error)}\n${line}`));
      return;
    }
    if (parsed.frame) {
      this.respondToRequests(parsed.frame);
      this.frameWaiters.shift()?.resolve(parsed.frame);
      return;
    }
    this.lineWaiters.shift()?.resolve(parsed);
  }

  private send(command: JsonObject): void {
    if (this.exitError) throw this.exitError;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  sendEvent(name: string, payload: JsonObject = {}): void {
    this.send(event(name, payload));
  }

  private response(
    request: HostRequest,
    result: unknown,
    ok = true,
    error?: { code: string; message: string },
  ): void {
    this.send(event("host.response", {
      requestId: request.requestId,
      capability: request.capability,
      ok,
      ...(ok ? { result } : { error: error ?? { code: "capability_unavailable", message: "navigation probe capability unavailable" } }),
    }));
  }

  private respondToRequests(frame: Frame): void {
    for (const item of frame.events ?? []) {
      if (item.name !== "host.request" || !item.payload) continue;
      const request: HostRequest = {
        requestId: String(item.payload.requestId),
        capability: String(item.payload.capability),
        params: (item.payload.params && typeof item.payload.params === "object" ? item.payload.params : {}) as JsonObject,
      };
      this.requests.push(request);
      if (this.deferredCapabilities.has(request.capability)) {
        this.deferredRequests.push(request);
        continue;
      }
      switch (request.capability) {
        case "platform.storage.get":
          this.storageGets.push(cloneJson(request.params));
          this.response(request, this.storage[request.params.key] ?? null);
          break;
        case "platform.storage.set":
          this.storageSets.push(cloneJson(request.params));
          this.storage[String(request.params.key)] = cloneJson(request.params.value);
          this.response(request, { stored: true });
          break;
        case "platform.storage.remove":
          delete this.storage[String(request.params.key)];
          this.response(request, { removed: true });
          break;
        case "platform.storage.keys":
          this.response(request, Object.keys(this.storage));
          break;
        case "platform.storage.batch":
          if (!this.supportsStorageBatch) {
            this.response(request, null, false);
            break;
          }
          try {
            const operations = snapshotStorageBatch(request.params.operations);
            if (operations.length === 0) {
              this.response(request, null);
              break;
            }
            const staged = cloneJson(this.storage) as Record<string, any>;
            for (const operation of operations) {
              if (operation.type === "set") {
                Object.defineProperty(staged, operation.key, {
                  value: operation.value,
                  configurable: true,
                  enumerable: true,
                  writable: true,
                });
              }
              else delete staged[operation.key];
            }
            const usage = Object.entries(staged).reduce(
              (total, [key, value]) => total + storageJsonBytes({ [key]: value }),
              0,
            );
            if (usage > 1_048_576) {
              throw new NativeStorageBatchError("quota_exceeded", "Storage bucket exceeds 1 MiB.");
            }
            // All shapes, keys, JSON snapshots, per-value bounds and the final
            // bucket quota are checked before mutating the injected store.
            for (const key of Object.keys(this.storage)) {
              if (!Object.hasOwn(staged, key)) delete this.storage[key];
            }
            const assignable = { ...staged };
            const hasPrototypeKey = Object.hasOwn(assignable, "__proto__");
            const prototypeValue = assignable.__proto__;
            delete assignable.__proto__;
            Object.assign(this.storage, assignable);
            if (hasPrototypeKey) {
              Object.defineProperty(this.storage, "__proto__", {
                value: prototypeValue,
                configurable: true,
                enumerable: true,
                writable: true,
              });
            }
            this.storageBatches.push(cloneJson(operations) as NativeStorageBatchOperation[]);
            this.response(request, null);
          } catch (error) {
            const failure = error instanceof NativeStorageBatchError
              ? { code: error.code, message: error.message }
              : { code: "invalid_storage_batch", message: String(error) };
            this.response(request, null, false, failure);
          }
          break;
        case "platform.systemUi.set":
          this.response(request, { applied: true });
          break;
        case "runtime.info":
          this.response(request, { entryFormat: "quickjs-bytecode", runtimeAbi: this.artifacts.runtimeAbi, version: "embedded", build: 0, source: "embedded" });
          break;
        case "runtime.performance":
          this.response(request, { history: [], recording: false });
          break;
        case "plugins.list":
          this.response(request, { plugins: [] });
          break;
        case "plugins.packageInfo":
          this.response(request, { provider: "pocket_probe", appName: "Pocket Host", packageName: "dev.tryjoy.pocket-host", version: "0.1.0", buildNumber: "1" });
          break;
        case "updates.status":
          this.response(request, { configured: false, stage: "not_configured", activeVersion: "embedded", versions: [], lastError: null });
          break;
        case "system.runtime.configure":
          this.response(request, { systemInstanceId: "system-ui", generation: "probe-system-generation" });
          break;
        case "system.runtime.post":
          this.response(request, { accepted: true });
          break;
        case "system.runtime.respond":
          this.response(request, null);
          break;
        default:
          this.response(request, null, false);
          break;
      }
    }
  }

  respondPending(capability: string, result: unknown, ok = true): void {
    const index = this.deferredRequests.findIndex((request) => request.capability === capability);
    assert.ok(index >= 0, `no deferred ${capability} request is pending`);
    const [request] = this.deferredRequests.splice(index, 1);
    this.response(request!, result, ok);
  }

  private waitLine(): Promise<ProbeOutput> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (output: ProbeOutput) => { clearTimeout(timeout); resolve(output); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      timeout = setTimeout(() => {
        const index = this.lineWaiters.indexOf(waiter);
        if (index >= 0) this.lineWaiters.splice(index, 1);
        waiter.reject(new Error("pocket_probe command timed out"));
      }, 4_000);
      this.lineWaiters.push(waiter);
    });
  }

  async boot(): Promise<Frame> {
    this.send({ op: "create", width: this.width, height: this.height, compositorSurfaces: showcaseCompositorSurfaces(), ...(this.memory ? { memory: this.memory } : {}) });
    assert.equal((await this.waitLine()).ok, true, "pocket_probe create failed");
    this.send({ op: "loadBytecode", bytecodePath: this.artifacts.bytecodePath, pakPath: this.artifacts.pakPath });
    const loaded = await this.waitLine();
    assert.equal(loaded.ok, true, `pocket_probe bytecode load failed: ${loaded.error ?? "unknown load error"}`);
    let latest = await this.frame();
    for (let index = 0; index < 20; index += 1) latest = await this.frame();
    return latest;
  }

  frame(): Promise<Frame> {
    if (this.exitError) return Promise.reject(this.exitError);
    const promise = new Promise<Frame>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (frame: Frame) => { clearTimeout(timeout); resolve(frame); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      timeout = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter);
        if (index >= 0) this.frameWaiters.splice(index, 1);
        waiter.reject(new Error("pocket_probe frame timed out"));
      }, 4_000);
      this.frameWaiters.push(waiter);
    });
    this.send({ op: "frame", deltaMs: 16 });
    return promise;
  }

  async settle(frame: Frame, count = 12): Promise<Frame> {
    let latest = frame;
    for (let index = 0; index < count; index += 1) latest = await this.frame();
    return latest;
  }

  /** Resize the live native guest viewport without replacing its JS session. */
  async resize(width: number, height: number): Promise<Frame> {
    assert.ok(Number.isFinite(width) && width > 0, "resize width must be a positive finite number");
    assert.ok(Number.isFinite(height) && height > 0, "resize height must be a positive finite number");
    const response = this.waitLine();
    this.send({ op: "resize", width, height });
    const result = await response;
    assert.equal(result.ok, true, `pocket_probe resize failed: ${result.error ?? "unknown resize error"}`);
    this.width = width;
    this.height = height;
    const frame = await this.frame();
    assert.equal(frame.width, width, "native frame width must reflect the live resize");
    assert.equal(frame.height, height, "native frame height must reflect the live resize");
    return frame;
  }

  async tapPoint(point: { x: number; y: number }): Promise<Frame> {
    this.send(pointer("down", point.x, point.y));
    await this.frame();
    this.send(pointer("up", point.x, point.y));
    return this.frame();
  }

  async tap(label: string, frame: Frame, predicate?: (op: DrawOp) => boolean): Promise<Frame> {
    return this.tapPoint(center(textOp(frame, label, predicate), label));
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 3, holdFrames = 0): Promise<Frame> {
    this.send(pointer("down", from.x, from.y));
    await this.frame();
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      this.send(pointer("move", from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress));
      await this.frame();
    }
    for (let index = 0; index < holdFrames; index += 1) {
      this.send(pointer("move", to.x, to.y));
      await this.frame();
    }
    this.send(pointer("up", to.x, to.y));
    return this.frame();
  }

  async quit(): Promise<void> {
    try {
      if (!this.child.killed && !this.exitError) {
        this.send({ op: "quit" });
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { this.child.kill(); resolve(); }, 2_000);
          this.child.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
      }
    } finally {
      clearTimeout(this.deadline);
      activeSessions.delete(this);
      if (this.exitError && !this.child.killed) this.child.kill();
    }
  }

  forceKill(): void {
    clearTimeout(this.deadline);
    if (!this.child.killed) this.child.kill();
    activeSessions.delete(this);
  }
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
