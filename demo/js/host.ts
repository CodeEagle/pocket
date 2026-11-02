/**
 * Minimal host capability bridge.
 *
 * Wire contract (shared with the Flutter shell):
 *
 *   event/host.request  { requestId, capability, params }
 *   event/host.response { requestId, capability, ok, result?, error? }
 *
 * The native runtime exposes `pocket._emit` for outbound packets and invokes
 * `__pocketDeliver` for response packets.  Keeping this adapter in the guest
 * means UI code only deals with promises and never knows about Dart objects.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface HostErrorShape {
  code: string;
  message: string;
}

export interface HostResponse {
  requestId: string;
  capability: string;
  ok: boolean;
  result?: JsonValue;
  error?: HostErrorShape | string;
}

export interface HostBridge {
  request<T extends JsonValue = JsonValue>(capability: string, params?: JsonObject): Promise<T>;
  handle(packet: string | Record<string, unknown>): boolean;
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
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
    result: nested.result as JsonValue | undefined,
    error,
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
}

export function createHostBridge(sendOverride?: HostSend, options: HostBridgeOptions = {}): HostBridge {
  const globalObject = globalThis as typeof globalThis & {
    pocket?: { _emit?: (line: string) => boolean };
    __pocketDeliver?: (line: string) => void;
  };
  const send: HostSend = sendOverride ?? ((line) => {
    const emit = globalObject.pocket?._emit;
    return typeof emit === "function" && emit(line) === true;
  });
  const maxPendingRequests = options.maxPendingRequests ?? 32;
  const timeoutFrames = options.timeoutFrames ?? 180;
  if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 256) {
    throw new RangeError("maxPendingRequests must be an integer between 1 and 256");
  }
  if (!Number.isInteger(timeoutFrames) || timeoutFrames < 1 || timeoutFrames > 3600) {
    throw new RangeError("timeoutFrames must be an integer between 1 and 3600");
  }
  const pending = new Map<string, {
    resolve: (value: JsonValue) => void;
    reject: (error: Error) => void;
    remainingFrames: number;
  }>();
  let nextId = 1;
  let disposed = false;
  const previousDeliver = globalObject.__pocketDeliver;

  const handle = (packet: string | Record<string, unknown>): boolean => {
    if (disposed) return false;
    const decoded = decode(packet);
    if (!decoded) return false;
    const response = responseFrom(decoded);
    if (!response) return false;
    const entry = pending.get(response.requestId);
    if (!entry) return false;
    pending.delete(response.requestId);
    if (!response.ok || response.error !== undefined) entry.reject(errorOf(response));
    else entry.resolve(response.result === undefined ? null : response.result);
    return true;
  };

  const tick = (): void => {
    if (disposed) return;
    for (const [requestId, entry] of pending) {
      entry.remainingFrames -= 1;
      if (entry.remainingFrames > 0) continue;
      pending.delete(requestId);
      entry.reject(new HostRequestError(requestId, "timeout", "Host response timed out"));
    }
  };

  const deliver = (line: string): void => {
    handle(line);
    previousDeliver?.(line);
  };
  globalObject.__pocketDeliver = deliver;

  const bridge: HostBridge = {
    request<T extends JsonValue = JsonValue>(capability: string, params: JsonObject = {}): Promise<T> {
      if (disposed) return Promise.reject(new Error("Host bridge is disposed"));
      if (!capability) return Promise.reject(new TypeError("Host capability must be non-empty"));
      if (!isJsonObject(params)) return Promise.reject(new TypeError("Host capability params must be an object"));
      if (pending.size >= maxPendingRequests) return Promise.reject(new HostRequestError("", "request_quota", "Host request limit reached"));
      const requestId = `guest-${nextId++}`;
      const line = JSON.stringify({
        type: "event",
        name: "host.request",
        payload: { requestId, capability, params },
      });
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, {
          resolve: resolve as (value: JsonValue) => void,
          reject,
          remainingFrames: timeoutFrames,
        });
        let accepted = false;
        try {
          accepted = send(line);
        } catch (error) {
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (!accepted) {
          pending.delete(requestId);
          reject(new HostRequestError(requestId, "unconfigured", `Host capability is not configured: ${capability}`));
        }
      });
    },

    handle,

    tick,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      globalObject.__pocketDeliver = previousDeliver;
      const error = new Error("Host bridge disposed");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    },
  };
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

