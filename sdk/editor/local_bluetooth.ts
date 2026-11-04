/**
 * Local CoreBluetooth transport used by the browser preview.
 *
 * Web pages cannot observe the candidate list produced by the browser's
 * Bluetooth chooser. This adapter talks to a small macOS CoreBluetooth app
 * helper over JSONL instead. The helper owns native BLE IO; this module owns
 * preview scopes, request routing and the browser-plugin wire shape.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LocalBluetoothPacket = {
  scope: string;
  kind: string;
  requestId?: string;
  capability?: string;
  streamId?: string;
  topic?: string;
  params?: Record<string, unknown>;
};

export type LocalBluetoothMessage = Record<string, unknown>;
export type LocalBluetoothSend = (message: LocalBluetoothMessage) => void;

type ProcessLike = {
  stdin: { write(value: string): unknown; end?: () => unknown };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  once?: (event: string, listener: (...args: any[]) => void) => unknown;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
};

export type LocalBluetoothProviderOptions = {
  /** Directory in which a built helper may be cached by the host. */
  cacheDirectory?: string;
  /** Explicit helper path, useful for packaged builds and tests. */
  helperPath?: string;
  /** Test-only process injection. Production never supplies this callback. */
  processFactory?: (helperPath: string) => ProcessLike | Promise<ProcessLike>;
  /** Test-only platform override. Defaults to the current Node/Bun platform. */
  platform?: string;
  requestTimeoutMs?: number;
  maxPending?: number;
};

export interface LocalBluetoothProvider {
  handle(packet: LocalBluetoothPacket, send: LocalBluetoothSend): Promise<void>;
  dispose(): Promise<void>;
}

type Pending = {
  id: string;
  packet: LocalBluetoothPacket;
  send: LocalBluetoothSend;
  timer: ReturnType<typeof setTimeout>;
  stream: boolean;
  nativeStreamId?: string;
};

type Stream = {
  scope: string;
  guestStreamId: string;
  nativeStreamId: string;
  send: LocalBluetoothSend;
};

type LocalBluetoothProcessFactory = (helperPath: string) => ProcessLike | Promise<ProcessLike>;

const LOCAL_SOURCE = "local-core-bluetooth";
const HELPER_SHUTDOWN_GRACE_MS = 250;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function error(code: string, message: string): Record<string, string> {
  return { code, message };
}

function defaultHelperPath(cacheDirectory?: string): string {
  const candidates = [
    process.env.POCKET_EDITOR_BLUETOOTH_HELPER,
    cacheDirectory ? join(cacheDirectory, "pocket-bluetooth") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "pocket-bluetooth";
}

function defaultProcessFactory(helperPath: string): ProcessLike {
  return spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams;
}

/**
 * Build the helper lazily. The cache key includes every source file that is
 * copied/compiled, so a changed CoreBluetooth core cannot reuse an old app
 * identity. Ad-hoc signing gives macOS TCC a stable bundle identity without
 * requiring or reading a developer certificate or any external secret.
 */
// Keep the cold build bounded below the preview's plugin request deadline.
// Swift/CoreBluetooth compilation is normally a few seconds; a wedged tool
// must return a normal unavailable response rather than block a preview.
const HELPER_BUILD_TIMEOUT_MS = 15_000;

function runCommand(command: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const process = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    timer = setTimeout(() => {
      try { process.kill(); } catch { /* process may already have exited */ }
      finish(-1);
    }, timeoutMs);
    process.once("error", () => finish(-1));
    process.once("exit", (status: number | null) => finish(typeof status === "number" ? status : -1));
  });
}

async function buildHelper(cacheDirectory?: string): Promise<string | undefined> {
  const sourceDirectory = resolve(import.meta.dir, "native/macos-bluetooth");
  const corePath = resolve(import.meta.dir, "../packages/pocket_bluetooth/ios/Classes/PocketBluetoothCore.swift");
  const mainPath = join(sourceDirectory, "main.swift");
  const infoPath = join(sourceDirectory, "Info.plist");
  if (![corePath, mainPath, infoPath].every((path) => existsSync(path))) return undefined;

  let digest: string;
  try {
    const hash = createHash("sha256");
    for (const path of [corePath, mainPath, infoPath]) hash.update(readFileSync(path));
    digest = hash.digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }

  const cacheRoot = cacheDirectory ?? join(process.env.TMPDIR || "/tmp", "pocket-editor-bluetooth");
  const bundleDirectory = join(cacheRoot, digest);
  const bundlePath = join(bundleDirectory, "Pocket Bluetooth.app");
  const executablePath = join(bundlePath, "Contents", "MacOS", "pocket-bluetooth");
  const signedMarker = join(bundlePath, "Contents", ".pocket-editor-signed");
  if (existsSync(executablePath) && existsSync(signedMarker)) return executablePath;

  const temporaryBundlePath = join(bundleDirectory, `.Pocket Bluetooth.app.${randomUUID()}.tmp`);
  const temporaryExecutablePath = join(temporaryBundlePath, "Contents", "MacOS", "pocket-bluetooth");

  try {
    mkdirSync(dirname(temporaryExecutablePath), { recursive: true });
    cpSync(infoPath, join(temporaryBundlePath, "Contents", "Info.plist"));
    const compileStatus = await runCommand(
      "swiftc",
      [corePath, mainPath, "-o", temporaryExecutablePath, "-framework", "CoreBluetooth", "-framework", "Foundation"],
      HELPER_BUILD_TIMEOUT_MS,
    );
    if (compileStatus !== 0 || !existsSync(temporaryExecutablePath)) return undefined;
    // The marker is part of the signed bundle. A final bundle is published
    // only after codesign succeeds, so an executable is never reused merely
    // because a previous compile happened to leave it behind.
    writeFileSync(join(temporaryBundlePath, "Contents", ".pocket-editor-signed"), `${digest}\n`);
    const signStatus = await runCommand("codesign", ["--force", "--deep", "--sign", "-", temporaryBundlePath], HELPER_BUILD_TIMEOUT_MS);
    if (signStatus !== 0) return undefined;
    if (existsSync(executablePath) && existsSync(signedMarker)) return executablePath;
    if (existsSync(bundlePath)) rmSync(bundlePath, { recursive: true, force: true });
    renameSync(temporaryBundlePath, bundlePath);
    return existsSync(executablePath) && existsSync(signedMarker) ? executablePath : undefined;
  } catch {
    return undefined;
  } finally {
    if (existsSync(temporaryBundlePath)) rmSync(temporaryBundlePath, { recursive: true, force: true });
  }
}

function nativeError(
  value: Record<string, unknown>,
  fallbackCode: string,
  fallbackMessage: string,
): Record<string, string> | undefined {
  const nested = record(value.error);
  const hasFailure = value.ok === false || typeof value.errorCode === "string" || typeof value.error === "string" || typeof nested.code === "string";
  if (!hasFailure) return undefined;
  const code = text(value.errorCode) || text(nested.code) || fallbackCode;
  const message = text(value.error) || text(nested.message) || text(value.message) || fallbackMessage;
  return error(code, message);
}

/** Normalize the exact CoreBluetooth event shape into the browser stream wire. */
function streamMessage(event: Record<string, unknown>): { name: string; payload: Record<string, unknown> } | undefined {
  const streamId = text(event.streamId);
  if (!streamId) return undefined;
  if (Object.prototype.hasOwnProperty.call(event, "error")) {
    const eventError = nativeError(event, "hardware_bluetooth_error", "Bluetooth stream failed");
    return { name: "stream.error", payload: { streamId, error: eventError ?? error("hardware_bluetooth_error", "Bluetooth stream failed") } };
  }
  if (event.done === true) return { name: "stream.end", payload: { streamId } };
  if (!Object.prototype.hasOwnProperty.call(event, "data")) return undefined;
  const data = record(event.data);
  return {
    name: "stream.data",
    payload: { streamId, data: { ...data, source: LOCAL_SOURCE } },
  };
}

function deviceId(params: Record<string, unknown>): string {
  return text(params.deviceId) || text(params.device);
}

function isDeviceScopedCapability(packet: LocalBluetoothPacket): boolean {
  return packet.capability === "hardware.bluetooth.connect" ||
    packet.capability === "hardware.bluetooth.read" ||
    packet.capability === "hardware.bluetooth.write" ||
    packet.kind === "stream.open";
}

export function createLocalBluetoothProvider(options: LocalBluetoothProviderOptions = {}): LocalBluetoothProvider {
  const platform = options.platform ?? process.platform;
  const configuredHelperPath = options.helperPath ?? defaultHelperPath(options.cacheDirectory);
  const injectedFactory = options.processFactory;
  const processFactory: LocalBluetoothProcessFactory = injectedFactory ?? defaultProcessFactory;
  const timeoutMs = Math.max(1_000, Math.min(options.requestTimeoutMs ?? 35_000, 120_000));
  const maxPending = Math.max(1, Math.min(options.maxPending ?? 64, 256));
  let child: ProcessLike | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let starting: Promise<boolean> | undefined;
  let childGeneration = 0;
  let disposed = false;
  const pending = new Map<string, Pending>();
  const streams = new Map<string, Stream>();
  const devicesByScope = new Map<string, Set<string>>();
  const retiredScopes = new Set<string>();
  const activeScopes = new Set<string>();
  const openingStreams = new Set<string>();
  const cancelledStreams = new Set<string>();
  let startupFailure: string | undefined;

  const streamKey = (scope: string, streamId: string): string => `${scope}\u0000${streamId}`;

  function retireScope(scope: string): void {
    retiredScopes.add(scope);
    // Scope ids are normally generation-qualified. Keep this guard bounded
    // for long-lived editor servers without making normal late packets useful.
    while (retiredScopes.size > 4096) {
      const oldest = retiredScopes.values().next().value;
      if (typeof oldest !== "string") break;
      retiredScopes.delete(oldest);
    }
  }

  function emitFailure(packet: LocalBluetoothPacket, send: LocalBluetoothSend, failure: Record<string, string>, stream = packet.kind === "stream.open"): void {
    if (stream) send({ type: "event", name: "stream.error", payload: { streamId: packet.streamId, error: failure } });
    else send({ type: "event", name: "host.response", payload: { requestId: packet.requestId, capability: packet.capability, ok: false, error: failure } });
  }

  function removeStream(nativeStreamId: string): void {
    streams.delete(nativeStreamId);
  }

  function stopNativeStream(scope: string, nativeStreamId: string): void {
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: randomUUID(), method: "stopHardwareStream", params: { sessionId: scope, streamId: nativeStreamId } })}\n`);
    } catch {
      // The helper exit path reports a transport failure to pending/active
      // work. There is nothing else to clean up when its stdin is closed.
    }
  }

  function failPendingAndStreams(reason: Record<string, string>): void {
    const failedStreamIds = new Set<string>();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (entry.stream) {
        if (entry.nativeStreamId) failedStreamIds.add(entry.nativeStreamId);
        entry.send({ type: "event", name: "stream.error", payload: { streamId: entry.packet.streamId, error: reason } });
      } else {
        entry.send({ type: "event", name: "host.response", payload: { requestId: entry.packet.requestId, capability: entry.packet.capability, ok: false, error: reason } });
      }
    }
    pending.clear();
    for (const [nativeStreamId, stream] of streams) {
      if (failedStreamIds.has(nativeStreamId)) continue;
      stream.send({ type: "event", name: "stream.error", payload: { streamId: stream.guestStreamId, error: reason } });
    }
    streams.clear();
  }

  function clearScope(scope: string, reason: Record<string, string>): void {
    devicesByScope.delete(scope);
    const pendingStreams = new Set<string>();
    for (const [id, entry] of pending) {
      if (entry.packet.scope !== scope) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      if (entry.nativeStreamId) {
        pendingStreams.add(entry.nativeStreamId);
        streams.delete(entry.nativeStreamId);
      }
      emitFailure(entry.packet, entry.send, reason, entry.stream);
    }
    for (const [nativeStreamId, stream] of streams) {
      if (stream.scope !== scope) continue;
      if (!pendingStreams.has(nativeStreamId)) stream.send({ type: "event", name: "stream.error", payload: { streamId: stream.guestStreamId, error: reason } });
      streams.delete(nativeStreamId);
    }
  }

  function helperFailure(processRef: ProcessLike, generation: number, reason: Record<string, string>): void {
    if (child !== processRef || childGeneration !== generation) return;
    lines?.close();
    lines = undefined;
    child = undefined;
    // CoreBluetooth's discovered map is process-local. Do not allow a new
    // helper instance to use ids discovered by the dead instance.
    devicesByScope.clear();
    if (!disposed) failPendingAndStreams(reason);
  }

  async function ensureChild(): Promise<boolean> {
    if (disposed || platform !== "darwin") return false;
    if (child) return true;
    if (starting) return starting;
    const attempt = (async (): Promise<boolean> => {
      const helperPath = injectedFactory
        ? configuredHelperPath
        : (existsSync(configuredHelperPath) ? configuredHelperPath : await buildHelper(options.cacheDirectory));
      if (!helperPath) {
        startupFailure = "Local Bluetooth helper could not be built; install Xcode Command Line Tools and retry";
        return false;
      }
      if (disposed || activeScopes.size === 0) return false;
      try {
        const processRef = await processFactory(helperPath);
        if (disposed || activeScopes.size === 0) {
          try { processRef.stdin.end?.(); } catch { /* ignore shutdown race */ }
          try { processRef.kill?.(); } catch { /* ignore shutdown race */ }
          return false;
        }
        const generation = ++childGeneration;
        child = processRef;
        lines = createInterface({ input: processRef.stdout });
        processRef.stderr?.on?.("data", () => undefined);
        lines.on("line", (line: string) => {
        let packet: Record<string, unknown>;
        try { packet = JSON.parse(line); } catch { return; }
        const nativeEvent = record(packet.event);
        if (Object.keys(nativeEvent).length) {
          const normalized = streamMessage(nativeEvent);
          if (!normalized) return;
          const nativeStreamId = text(normalized.payload.streamId);
          const stream = streams.get(nativeStreamId);
          if (!stream) return;
          const payload = { ...normalized.payload, streamId: stream.guestStreamId };
          stream.send({ type: "event", name: normalized.name, payload });
          if (normalized.name === "stream.error" || normalized.name === "stream.end") removeStream(nativeStreamId);
          return;
        }
        const id = text(packet.id);
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        const result = record(packet.result);
        const failure = nativeError(result, "hardware_bluetooth_error", entry.stream ? "Bluetooth stream failed" : "Bluetooth operation failed");
        if (failure) {
          if (entry.nativeStreamId) removeStream(entry.nativeStreamId);
          emitFailure(entry.packet, entry.send, failure, entry.stream);
          return;
        }
        const sourcedResult: Record<string, unknown> = { ...result, source: LOCAL_SOURCE };
        if (entry.packet.capability === "hardware.bluetooth.scan") {
          const devices = Array.isArray(result.devices) ? result.devices : [];
          const ids = new Set<string>();
          const normalizedDevices = devices.map((item) => {
            const value = record(item);
            const id = text(value.id);
            if (id) ids.add(id);
            return value;
          });
          devicesByScope.set(entry.packet.scope, ids);
          sourcedResult.devices = normalizedDevices;
          sourcedResult.scanMode = "nearby";
        }
        if (entry.stream && entry.nativeStreamId && sourcedResult.streamId === entry.nativeStreamId) {
          sourcedResult.streamId = entry.packet.streamId;
        }
        if (entry.stream) {
          entry.send({ type: "event", name: "stream.open", payload: { streamId: entry.packet.streamId, ok: true, result: sourcedResult } });
        } else {
          entry.send({ type: "event", name: "host.response", payload: { requestId: entry.packet.requestId, capability: entry.packet.capability, ok: true, result: sourcedResult } });
        }
        });
        processRef.once?.("error", () => helperFailure(processRef, generation, error("hardware_bluetooth_unavailable", "Local Bluetooth helper could not start")));
        processRef.once?.("exit", () => helperFailure(processRef, generation, error("hardware_bluetooth_unavailable", "Local Bluetooth helper exited")));
        startupFailure = undefined;
        return true;
      } catch {
        child = undefined;
        lines = undefined;
        startupFailure = "Local Bluetooth helper could not start; install Xcode Command Line Tools and retry";
        return false;
      }
    })();
    starting = attempt;
    try {
      return await attempt;
    } finally {
      if (starting === attempt) starting = undefined;
    }
  }

  function sendNative(
    id: string,
    method: string,
    params: Record<string, unknown>,
    packet: LocalBluetoothPacket,
    send: LocalBluetoothSend,
    stream: boolean,
    nativeStreamId?: string,
  ): void {
    if (!child || pending.size >= maxPending) {
      emitFailure(packet, send, error("hardware_busy", "Local Bluetooth helper is busy"), stream);
      if (nativeStreamId) removeStream(nativeStreamId);
      return;
    }
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      if (stream && nativeStreamId) stopNativeStream(packet.scope, nativeStreamId);
      if (nativeStreamId) removeStream(nativeStreamId);
      emitFailure(packet, send, error("hardware_bluetooth_error", "Local Bluetooth operation timed out"), stream);
    }, timeoutMs);
    pending.set(id, { id, packet, send, timer, stream, nativeStreamId });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      if (nativeStreamId) removeStream(nativeStreamId);
      emitFailure(packet, send, error("hardware_bluetooth_unavailable", "Local Bluetooth helper is unavailable"), stream);
    }
  }

  async function handle(packet: LocalBluetoothPacket, send: LocalBluetoothSend): Promise<void> {
    if (disposed) return;
    if (packet.kind === "scope.dispose") {
      retireScope(packet.scope);
      activeScopes.delete(packet.scope);
      for (const key of openingStreams) if (key.startsWith(`${packet.scope}\u0000`)) openingStreams.delete(key);
      for (const key of cancelledStreams) if (key.startsWith(`${packet.scope}\u0000`)) cancelledStreams.delete(key);
      clearScope(packet.scope, error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed"));
      // Disposal is deliberately best-effort and must not start a helper just
      // to release a scope that never used native Bluetooth.
      if (child) {
        const id = randomUUID();
        try { child.stdin.write(`${JSON.stringify({ id, method: "disposeSession", params: { sessionId: packet.scope } })}\n`); } catch { /* exit handler reports the transport failure */ }
      }
      return;
    }
    if (retiredScopes.has(packet.scope)) {
      if (packet.kind === "stream.cancel") return;
      emitFailure(packet, send, error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed"));
      return;
    }
    if (packet.kind === "stream.cancel") {
      const guestStreamId = text(packet.streamId);
      const key = streamKey(packet.scope, guestStreamId);
      const nativeStream = [...streams.values()].find((stream) => stream.scope === packet.scope && stream.guestStreamId === guestStreamId);
      if (nativeStream) {
        removeStream(nativeStream.nativeStreamId);
        for (const [id, entry] of pending) {
          if (entry.nativeStreamId !== nativeStream.nativeStreamId) continue;
          clearTimeout(entry.timer);
          pending.delete(id);
        }
        stopNativeStream(packet.scope, nativeStream.nativeStreamId);
      } else if (openingStreams.has(key)) {
        cancelledStreams.add(key);
      }
      return;
    }
    activeScopes.add(packet.scope);
    const openingKey = packet.kind === "stream.open" ? streamKey(packet.scope, text(packet.streamId)) : undefined;
    if (isDeviceScopedCapability(packet)) {
      const id = deviceId(packet.params ?? {});
      if (!id || !devicesByScope.get(packet.scope)?.has(id)) {
        emitFailure(packet, send, error("hardware_not_found", "device was not discovered by this preview scope"), packet.kind === "stream.open");
        return;
      }
    }
    if (openingKey) openingStreams.add(openingKey);
    const childReady = await ensureChild();
    if (disposed || retiredScopes.has(packet.scope)) {
      if (openingKey) {
        openingStreams.delete(openingKey);
        cancelledStreams.delete(openingKey);
      }
      emitFailure(packet, send, error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed"), packet.kind === "stream.open");
      return;
    }
    if (openingKey && cancelledStreams.delete(openingKey)) {
      openingStreams.delete(openingKey);
      emitFailure(packet, send, error("hardware_bluetooth_disconnected", "Bluetooth stream was cancelled before it started"), true);
      return;
    }
    if (!childReady) {
      if (openingKey) openingStreams.delete(openingKey);
      emitFailure(
        packet,
        send,
        error(
          platform === "darwin" ? "hardware_bluetooth_unavailable" : "hardware_unsupported",
          platform === "darwin" ? (startupFailure ?? "Local Bluetooth helper is unavailable") : "Local Bluetooth scanning is supported on macOS preview only",
        ),
      );
      return;
    }
    const capability = text(packet.capability);
    let method = "";
    if (capability === "hardware.permissions.request" && text(packet.params?.permission) === "hardware.bluetooth") method = "requestBlePermission";
    else if (capability === "hardware.bluetooth.scan") method = "startBleScan";
    else if (capability === "hardware.bluetooth.connect") method = "connectBleDevice";
    else if (capability === "hardware.bluetooth.read") method = "readBleCharacteristic";
    else if (capability === "hardware.bluetooth.write") method = "writeBleCharacteristic";
    else if (packet.kind === "stream.open") method = "startHardwareStream";
    else {
      emitFailure(packet, send, error("hardware_unsupported", "Unsupported local Bluetooth capability"), false);
      return;
    }

    const nativeStreamId = packet.kind === "stream.open"
      ? `${packet.scope}\u0000${text(packet.streamId)}\u0000${randomUUID()}`
      : undefined;
    const params = {
      ...(packet.params ?? {}),
      sessionId: packet.scope,
      ...(nativeStreamId ? { streamId: nativeStreamId } : {}),
    };
    if (nativeStreamId) {
      if (openingKey) openingStreams.delete(openingKey);
      streams.set(nativeStreamId, { scope: packet.scope, guestStreamId: text(packet.streamId), nativeStreamId, send });
    }
    sendNative(randomUUID(), method, params, packet, send, packet.kind === "stream.open", nativeStreamId);
  }

  return {
    handle,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      failPendingAndStreams(error("hardware_bluetooth_disconnected", "Local Bluetooth provider disposed"));
      devicesByScope.clear();
      retiredScopes.clear();
      activeScopes.clear();
      openingStreams.clear();
      cancelledStreams.clear();
      const processRef = child;
      lines?.close();
      lines = undefined;
      if (!processRef) {
        child = undefined;
        return;
      }
      // EOF lets main.swift call CoreBluetoothCore.dispose and release its
      // streams before termination. A short grace period prevents shutdown
      // from hanging the editor if the helper is wedged.
      try { processRef.stdin.end?.(); } catch { /* ignore shutdown race */ }
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try { processRef.kill?.(); } catch { /* ignore shutdown race */ }
          finish();
        }, HELPER_SHUTDOWN_GRACE_MS);
        processRef.once?.("exit", finish);
        processRef.once?.("error", finish);
        if (!processRef.once) finish();
      });
      if (child === processRef) child = undefined;
    },
  };
}
