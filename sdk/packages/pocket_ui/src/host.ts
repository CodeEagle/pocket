/**
 * Minimal host capability bridge.
 *
 * Wire contract (shared with the Flutter shell):
 *
 *   event/host.request  { requestId, capability, params }
 *   event/host.response { requestId, capability, ok, result?, error? }
 *
 * The native runtime exposes `pocket._emit` for outbound packets and routes
 * event envelopes through `__pocketEvent` (with raw response compatibility on
 * `__pocketDeliver`). Keeping this adapter in the guest means UI code only
 * deals with promises and never knows about Dart objects.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type BridgeValue = JsonPrimitive | Uint8Array | BridgeValue[] | { [key: string]: BridgeValue };
export type BridgeObject = { [key: string]: BridgeValue };

export interface HostErrorShape {
  code: string;
  message: string;
}

export interface HostResponse {
  requestId: string;
  capability: string;
  ok: boolean;
  result?: BridgeValue;
  error?: HostErrorShape | string;
}

/** A bounded, observable report for an isolated host callback failure. */
export type HostBridgeDiagnosticKind =
  | "event_listener"
  | "tick_listener"
  | "previous_event_sink"
  | "previous_deliver_sink"
  | "bridge_dispatch";

export interface HostBridgeDiagnostic {
  readonly kind: HostBridgeDiagnosticKind;
  readonly method?: string;
  readonly error: HostErrorShape;
}

/** A guest event delivered by the native host event sink. */
export interface HostEvent {
  readonly id: string;
  readonly method: string;
  readonly params: BridgeObject;
  /** The decoded packet, retained for capability-specific adapters. */
  readonly raw: Record<string, unknown>;
}

export type HostEventListener = (event: HostEvent) => void;

/** Override one long-running operation without changing ordinary requests. */
export interface HostRequestOptions {
  timeoutFrames?: number;
}

export interface HostBridge {
  request<T extends BridgeValue = BridgeValue>(capability: string, params?: BridgeObject, options?: HostRequestOptions): Promise<T>;
  handle(packet: string | Record<string, unknown>): boolean;
  /**
   * Emit a host event on the same Pocket event transport used by requests.
   * Optional keeps existing injected bridges source-compatible.
   */
  emit?(method: string, params?: BridgeObject): boolean;
  /** Subscribe to host-originated events. Optional for legacy request-only bridges. */
  onEvent?(listener: HostEventListener): () => void;
  /** Subscribe to the deterministic guest clock used for bounded operations. */
  onTick?(listener: () => void): () => void;
  /** Official guest-clock deadline scheduling, which wakes an idle runtime. */
  scheduleTimeout?(frames: number, callback: () => void): () => void;
  /** Advance bounded request deadlines on the deterministic guest clock. */
  tick(): void;
  dispose(): void;
}

export type HostSend = (line: string) => boolean;

class HostRequestError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(requestId: string, code: string, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.requestId = requestId;
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isJsonObject(value: unknown): value is BridgeObject {
  return isObject(value);
}

function decode(packet: string | Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof packet === "string") {
    try {
      const value: unknown = JSON.parse(packet);
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return isObject(packet) ? packet : undefined;
}

function responseFrom(packet: Record<string, unknown>): HostResponse | undefined {
  const nested = packet.type === "event" && packet.name === "host.response"
    ? packet.payload ?? packet.params
    : packet.type === "response"
      ? packet.payload ?? packet
      : packet.name === "host.response"
        ? packet.payload ?? packet.params
        : undefined;
  if (!isObject(nested) || typeof nested.requestId !== "string") return undefined;
  const capability = typeof nested.capability === "string" ? nested.capability : "";
  const ok = nested.ok !== false;
  let error: HostErrorShape | string | undefined;
  if (typeof nested.error === "string") error = nested.error;
  else if (isObject(nested.error)) {
    error = {
      code: typeof nested.error.code === "string" ? nested.error.code : "host_error",
      message: typeof nested.error.message === "string" ? nested.error.message : "Host request failed",
    };
  }
  return {
    requestId: nested.requestId,
    capability,
    ok,
    result: nested.result as BridgeValue | undefined,
    error,
  };
}

function eventFrom(packet: Record<string, unknown>): HostEvent | undefined {
  const type = typeof packet.type === "string" ? packet.type : "";
  const method = type === "event"
    ? (typeof packet.name === "string" ? packet.name : typeof packet.method === "string" ? packet.method : "")
    : (typeof packet.method === "string" ? packet.method : typeof packet.name === "string" ? packet.name : "");
  if (!method || method === "host.response") return undefined;
  const nested = packet.payload ?? packet.params;
  const params = isObject(nested) ? nested as BridgeObject : {};
  return {
    id: typeof packet.id === "string" ? packet.id : "",
    method,
    params,
    raw: packet,
  };
}

function errorOf(response: HostResponse): HostRequestError {
  if (typeof response.error === "string") return new HostRequestError(response.requestId, "host_error", response.error);
  return new HostRequestError(
    response.requestId,
    response.error?.code ?? "host_error",
    response.error?.message ?? "Host request failed",
  );
}

/** Install one request/response bridge for the lifetime of the guest app. */
export interface HostBridgeOptions {
  maxPendingRequests?: number;
  timeoutFrames?: number;
  /** Supply the guest virtual timer so waiting for a response can sleep. */
  scheduleTimeout?: (frames: number, callback: () => void) => () => void;
  /** Observe isolated callback failures without creating another event bus. */
  onDiagnostic?: (diagnostic: HostBridgeDiagnostic) => void;
}

/** The callback error budget is deliberately finite so a broken consumer cannot
 * turn a high-rate host event stream into an unbounded diagnostics queue. */
export const HOST_BRIDGE_MAX_DIAGNOSTICS = 32;

export type HostPacketHandler = ((packet: string | Record<string, unknown>) => void) & {
  __binaryCapable?: boolean;
};

export function stringifyHostPacket(packet: Record<string, unknown>): string {
  return JSON.stringify(packet, (_key, value) => {
    if (value instanceof Uint8Array) return Array.from(value);
    if (ArrayBuffer.isView(value)) {
      return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return value;
  });
}

export function forwardHostPacket(
  handler: HostPacketHandler | undefined,
  packet: string | Record<string, unknown>,
): void {
  if (!handler) return;
  if (handler.__binaryCapable === true || typeof packet === "string") {
    handler(packet);
    return;
  }
  handler(stringifyHostPacket(packet));
}

export function createHostBridge(sendOverride?: HostSend, options: HostBridgeOptions = {}): HostBridge {
  const globalObject = globalThis as typeof globalThis & {
    pocket?: {
      _emit?: (line: string) => boolean;
      _emitValue?: (packet: Record<string, unknown>) => boolean;
    };
    __pocketDeliver?: HostPacketHandler;
    __pocketEvent?: HostPacketHandler;
    __pocketHostBridge?: HostBridge;
  };
  const send: HostSend = sendOverride ?? ((line) => {
    const emit = globalObject.pocket?._emit;
    return typeof emit === "function" && emit(line) === true;
  });
  const sendPacket = (packet: Record<string, unknown>): boolean => {
    if (!sendOverride) {
      const emitValue = globalObject.pocket?._emitValue;
      if (typeof emitValue === "function") {
        return emitValue(packet) === true;
      }
    }
    const line = stringifyHostPacket(packet);
    return send(line);
  };
  const maxPendingRequests = options.maxPendingRequests ?? 32;
  const timeoutFrames = options.timeoutFrames ?? 180;
  if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 256) {
    throw new RangeError("maxPendingRequests must be an integer between 1 and 256");
  }
  if (!Number.isInteger(timeoutFrames) || timeoutFrames < 1 || timeoutFrames > 28800) {
    throw new RangeError("timeoutFrames must be an integer between 1 and 28800");
  }
  const pending = new Map<string, {
    resolve: (value: BridgeValue) => void;
    reject: (error: Error) => void;
    remainingFrames: number;
    cancelTimeout?: () => void;
  }>();
  let nextId = 1;
  let disposed = false;
  const previousDeliver = globalObject.__pocketDeliver;
  const previousEvent = globalObject.__pocketEvent;
  const previousHostBridge = globalObject.__pocketHostBridge;
  const eventListeners = new Set<HostEventListener>();
  const tickListeners = new Set<() => void>();
  let diagnosticsReported = 0;
  const diagnose = (
    kind: HostBridgeDiagnosticKind,
    error: unknown,
    method?: string,
  ): void => {
    if (!options.onDiagnostic || diagnosticsReported >= HOST_BRIDGE_MAX_DIAGNOSTICS) return;
    diagnosticsReported += 1;
    let normalized: HostErrorShape;
    try {
      normalized = hostError(error);
    } catch {
      normalized = { code: "host_callback_error", message: "Host callback failed" };
    }
    try {
      options.onDiagnostic({
        kind,
        ...(method ? { method } : {}),
        error: {
          code: normalized.code.slice(0, 64),
          message: normalized.message.slice(0, 256),
        },
      });
    } catch {
      // A diagnostic observer is itself untrusted and must not re-enter the
      // transport or make later listeners disappear.
    }
  };
  const dispatchEvent = (event: HostEvent): boolean => {
    if (eventListeners.size === 0) return false;
    for (const listener of [...eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        diagnose("event_listener", error, event.method);
      }
    }
    return true;
  };

  const handle = (packet: string | Record<string, unknown>): boolean => {
    if (disposed) return false;
    const decoded = decode(packet);
    if (!decoded) return false;
    const response = responseFrom(decoded);
    if (response) {
      const entry = pending.get(response.requestId);
      if (!entry) return false;
      pending.delete(response.requestId);
      entry.cancelTimeout?.();
      if (!response.ok || response.error !== undefined) entry.reject(errorOf(response));
      else entry.resolve(response.result === undefined ? null : response.result);
      return true;
    }
    const event = eventFrom(decoded);
    if (!event) return false;
    return dispatchEvent(event);
  };

  const tick = (): void => {
    if (disposed) return;
    for (const [requestId, entry] of pending) {
      if (entry.cancelTimeout) continue;
      entry.remainingFrames -= 1;
      if (entry.remainingFrames > 0) continue;
      pending.delete(requestId);
      entry.reject(new HostRequestError(requestId, "timeout", "Host response timed out"));
    }
    for (const listener of [...tickListeners]) {
      try {
        listener();
      } catch (error) {
        diagnose("tick_listener", error);
      }
    }
  };

  const deliver: HostPacketHandler = (packet: string | Record<string, unknown>): void => {
    try {
      handle(packet);
    } catch (error) {
      diagnose("bridge_dispatch", error);
    }
    try {
      forwardHostPacket(previousDeliver, packet);
    } catch (error) {
      diagnose("previous_deliver_sink", error);
    }
  };
  deliver.__binaryCapable = true;
  const eventDeliver: HostPacketHandler = (packet: string | Record<string, unknown>): void => {
    try {
      handle(packet);
    } catch (error) {
      diagnose("bridge_dispatch", error);
    }
    try {
      forwardHostPacket(previousEvent, packet);
    } catch (error) {
      diagnose("previous_event_sink", error);
    }
  };
  eventDeliver.__binaryCapable = true;
  globalObject.__pocketDeliver = deliver;
  globalObject.__pocketEvent = eventDeliver;

  const emit = (method: string, params: BridgeObject = {}): boolean => {
    if (disposed) return false;
    if (typeof method !== "string" || method.length === 0) return false;
    if (!isJsonObject(params)) return false;
    try {
      return sendPacket({ type: "event", name: method, payload: params });
    } catch {
      return false;
    }
  };

  const bridge: HostBridge = {
    request<T extends BridgeValue = BridgeValue>(capability: string, params: BridgeObject = {}, requestOptions: HostRequestOptions = {}): Promise<T> {
      if (disposed) return Promise.reject(new Error("Host bridge is disposed"));
      if (!capability) return Promise.reject(new TypeError("Host capability must be non-empty"));
      if (!isJsonObject(params)) return Promise.reject(new TypeError("Host capability params must be an object"));
      if (pending.size >= maxPendingRequests) return Promise.reject(new HostRequestError("", "request_quota", "Host request limit reached"));
      const requestTimeout = requestOptions.timeoutFrames ?? timeoutFrames;
      if (!Number.isInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 28800) {
        return Promise.reject(new RangeError("timeoutFrames must be an integer between 1 and 28800"));
      }
      const requestId = `guest-${nextId++}`;
      const packet: Record<string, unknown> = {
        type: "event",
        name: "host.request",
        payload: { requestId, capability, params },
      };
      return new Promise<T>((resolve, reject) => {
        const entry = {
          resolve: resolve as (value: BridgeValue) => void,
          reject,
          remainingFrames: requestTimeout,
          cancelTimeout: undefined as (() => void) | undefined,
        };
        pending.set(requestId, entry);
        let accepted = false;
        try {
          entry.cancelTimeout = options.scheduleTimeout?.(requestTimeout, () => {
            if (!pending.delete(requestId)) return;
            entry.reject(new HostRequestError(requestId, "timeout", "Host response timed out"));
          });
          accepted = sendPacket(packet);
        } catch (error) {
          pending.delete(requestId);
          entry.cancelTimeout?.();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (!accepted) {
          pending.delete(requestId);
          entry.cancelTimeout?.();
          reject(new HostRequestError(requestId, "unconfigured", `Host capability is not configured: ${capability}`));
        }
      });
    },

    handle,

    emit,

    onEvent(listener: HostEventListener): () => void {
      if (disposed) return () => {};
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    onTick(listener: () => void): () => void {
      if (disposed) return () => {};
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    },

    ...(options.scheduleTimeout ? { scheduleTimeout: options.scheduleTimeout } : {}),

    tick,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (globalObject.__pocketDeliver === deliver) globalObject.__pocketDeliver = previousDeliver;
      if (globalObject.__pocketEvent === eventDeliver) globalObject.__pocketEvent = previousEvent;
      if (globalObject.__pocketHostBridge === bridge) globalObject.__pocketHostBridge = previousHostBridge;
      const error = new Error("Host bridge disposed");
      for (const entry of pending.values()) {
        entry.cancelTimeout?.();
        entry.reject(error);
      }
      pending.clear();
      eventListeners.clear();
      tickListeners.clear();
    },
  };
  globalObject.__pocketHostBridge = bridge;
  return bridge;
}

export function hostError(error: unknown): HostErrorShape {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "host_error",
      message: typeof value.message === "string" ? value.message : String(error),
    };
  }
  return { code: "host_error", message: String(error) };
}
