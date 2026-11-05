import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";

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
  readonly storage: Record<string, any>;
  readonly width: number;
  readonly height: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly artifacts: NativeArtifacts;
  private output = "";
  private stderr = "";
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly deferredCapabilities: Set<string>;
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
      deferCapabilities?: readonly string[];
      deadlineMs?: number;
    } = {},
  ) {
    this.artifacts = artifacts;
    this.width = options.width ?? 390;
    this.height = options.height ?? 760;
    this.storage = options.storage ?? {};
    this.deferredCapabilities = new Set(options.deferCapabilities ?? []);
    this.child = spawn(probePath(), [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.acceptOutput(chunk.toString("utf8")));
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

  private response(request: HostRequest, result: unknown, ok = true): void {
    this.send(event("host.response", {
      requestId: request.requestId,
      capability: request.capability,
      ok,
      ...(ok ? { result } : { error: { code: "capability_unavailable", message: "navigation probe capability unavailable" } }),
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
    this.send({ op: "create", width: this.width, height: this.height, compositorSurfaces: { "pocket.demo.profile": 2, "pocket.demo.lobby": 3 } });
    assert.equal((await this.waitLine()).ok, true, "pocket_probe create failed");
    this.send({ op: "loadBytecode", bytecodePath: this.artifacts.bytecodePath, pakPath: this.artifacts.pakPath });
    assert.equal((await this.waitLine()).ok, true, "pocket_probe bytecode load failed");
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
