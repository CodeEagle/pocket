import type { BridgeObject, BridgeValue, HostBridge, HostEvent } from "./host.ts";

/** Terminal states for a Pocket host stream. */
export type PocketStreamState =
  "open" | "ended" | "errored" | "cancelled" | "disposed";

export interface PocketStreamClose {
  readonly state: PocketStreamState;
  readonly reason?: BridgeValue;
  readonly error?: PocketStreamError;
}

/** A protocol, quota, deadline, or remote-host stream failure. */
export class PocketStreamError extends Error {
  readonly code: string;
  readonly streamId?: string;
  readonly reason?: BridgeValue;

  constructor(
    code: string,
    message: string,
    streamId?: string,
    reason?: BridgeValue,
  ) {
    super(message);
    this.name = "PocketStreamError";
    this.code = code;
    this.streamId = streamId;
    this.reason = reason;
  }
}

export type PocketStreamDataListener<T extends BridgeValue> = (value: T) => void;
export type PocketStreamErrorListener = (error: PocketStreamError) => void;
export type PocketStreamEndListener = (close: PocketStreamClose) => void;

export interface PocketStreamOpenOptions {
  /** Idle guest frames before this stream is failed; omitted means no deadline. */
  deadlineFrames?: number;
  /** Per-stream queue bound. Defaults to the adapter bound. */
  maxBufferedMessages?: number;
  /** Explicit IDs must use the guest prefix and must not already be in use. */
  id?: string;
}

export interface PocketStreamAdapterOptions {
  /** Maximum resident streams in this adapter; defaults to 16. */
  maxActiveStreams?: number;
  /** Default queue bound for streams opened by this adapter. */
  maxBufferedMessages?: number;
  /** Default idle deadline. Omitted means streams stay open until ended/cancelled. */
  deadlineFrames?: number;
  /** Guest-owned ID prefix. `host-stream` is reserved by the Dart bridge. */
  idPrefix?: string;
}

type StreamEventSender = (method: string, params: BridgeObject) => boolean;
type StreamClosedCallback = (stream: PocketStream<BridgeValue>) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isJsonValue(value: unknown): value is BridgeValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 16384 || depth > 32) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (item instanceof Uint8Array) return true;
    if (typeof item !== "object" || ArrayBuffer.isView(item) || ancestors.has(item)) return false;
    ancestors.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    const valid = values.every((child) => visit(child, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0);
}

function jsonObject(value: unknown, message: string): BridgeObject {
  if (!isObject(value) || !Object.values(value).every(isJsonValue))
    throw new TypeError(message);
  return value as BridgeObject;
}

function boundedInteger(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** Keep JS admission aligned with the native event transport's hard bounds. */
export const POCKET_STREAM_MAX_BATCH_EVENTS = 256;
export const POCKET_STREAM_MAX_BATCH_BYTES = 256 * 1024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const JSON_SIZE_INVALID = Symbol("json-size-invalid");
const JSON_SIZE_TOO_LARGE = Symbol("json-size-too-large");
type JsonSizeResult = number | typeof JSON_SIZE_INVALID | typeof JSON_SIZE_TOO_LARGE;

function quotedJsonStringByteLength(value: string, maxBytes: number): JsonSizeResult {
  let bytes = 2; // opening and closing quotes
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes <= maxBytes;
  };
  if (bytes > maxBytes) return JSON_SIZE_TOO_LARGE;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      if (!add(2)) return JSON_SIZE_TOO_LARGE;
    } else if (code <= 0x1f) {
      // JSON.stringify uses the short escapes where they exist.
      if (!add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6)) return JSON_SIZE_TOO_LARGE;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (!add(4)) return JSON_SIZE_TOO_LARGE;
        index += 1;
      } else if (!add(6)) {
        return JSON_SIZE_TOO_LARGE;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (!add(6)) return JSON_SIZE_TOO_LARGE;
    } else if (code <= 0x7f) {
      if (!add(1)) return JSON_SIZE_TOO_LARGE;
    } else if (code <= 0x7ff) {
      if (!add(2)) return JSON_SIZE_TOO_LARGE;
    } else if (!add(3)) {
      return JSON_SIZE_TOO_LARGE;
    }
  }
  return bytes;
}

function hasUnsafeJsonProperties(value: object): boolean {
  try {
    // JSON.stringify invokes inherited toJSON even when it is non-enumerable;
    // reject it without reading the property so a hostile getter cannot run.
    if ("toJSON" in value) return true;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 16384) return true;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Accessors are not stable between the bounded preflight and the final
      // host.emit stringify. JSON data objects must expose value descriptors.
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Calculate a JSON value's encoded size without allocating its encoded text.
 * The explicit result symbols distinguish malformed values from values that
 * are valid but cannot fit the caller's remaining byte budget.
 */
function boundedJsonByteLength(value: unknown, maxBytes: number): JsonSizeResult {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonSizeResult => {
    if (++nodes > 16384 || depth > 32) return JSON_SIZE_INVALID;
    if (item === null) return maxBytes >= 4 ? 4 : JSON_SIZE_TOO_LARGE;
    if (typeof item === "string") return quotedJsonStringByteLength(item, maxBytes);
    if (typeof item === "boolean") return item ? (maxBytes >= 4 ? 4 : JSON_SIZE_TOO_LARGE) : (maxBytes >= 5 ? 5 : JSON_SIZE_TOO_LARGE);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return JSON_SIZE_INVALID;
      const encoded = JSON.stringify(item);
      if (encoded === undefined) return JSON_SIZE_INVALID;
      return encoded.length <= maxBytes ? encoded.length : JSON_SIZE_TOO_LARGE;
    }
    if (item instanceof Uint8Array) {
      const size = 5 + item.byteLength;
      return size <= maxBytes ? size : JSON_SIZE_TOO_LARGE;
    }
    if (typeof item !== "object" || ArrayBuffer.isView(item) || ancestors.has(item)) return JSON_SIZE_INVALID;
    if (hasUnsafeJsonProperties(item)) return JSON_SIZE_INVALID;
    ancestors.add(item);
    let bytes = 1;
    const add = (amount: number): boolean => {
      bytes += amount;
      return bytes <= maxBytes;
    };
    try {
      if (Array.isArray(item)) {
        for (let index = 0; index < item.length; index += 1) {
          // JSON.stringify serializes sparse array holes as null. Explicit
          // undefined values remain invalid JSON values.
          const child = index in item ? visit(item[index], depth + 1) : 4;
          if (child === JSON_SIZE_INVALID || child === JSON_SIZE_TOO_LARGE) return child;
          if (!add(child + (index === 0 ? 0 : 1))) return JSON_SIZE_TOO_LARGE;
        }
      } else {
        let first = true;
        for (const key in item) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          const keyBytes = quotedJsonStringByteLength(key, maxBytes - bytes);
          if (keyBytes === JSON_SIZE_INVALID || keyBytes === JSON_SIZE_TOO_LARGE) return keyBytes;
          if (!add(keyBytes + 1 + (first ? 0 : 1))) return JSON_SIZE_TOO_LARGE;
          first = false;
          const child = visit((item as Record<string, unknown>)[key], depth + 1);
          if (child === JSON_SIZE_INVALID || child === JSON_SIZE_TOO_LARGE) return child;
          if (!add(child)) return JSON_SIZE_TOO_LARGE;
        }
      }
      return add(1) ? bytes : JSON_SIZE_TOO_LARGE; // closing ] or }
    } catch {
      return JSON_SIZE_INVALID;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

function reasonMessage(
  reason: BridgeValue | undefined,
  fallback: string,
): string {
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (
    isObject(reason) &&
    typeof reason.message === "string" &&
    reason.message.length > 0
  )
    return reason.message;
  return fallback;
}

function remoteError(
  value: unknown,
  streamId: string,
  fallbackCode: string,
): PocketStreamError {
  if (typeof value === "string")
    return new PocketStreamError(fallbackCode, value, streamId, value);
  if (isObject(value)) {
    const code =
      typeof value.code === "string" && value.code.length > 0
        ? value.code
        : fallbackCode;
    const message =
      typeof value.message === "string" && value.message.length > 0
        ? value.message
        : "Remote host stream failed";
    return new PocketStreamError(code, message, streamId, value as BridgeObject);
  }
  return new PocketStreamError(
    fallbackCode,
    "Remote host stream failed",
    streamId,
  );
}

interface StreamReadWaiter<T extends BridgeValue> {
  resolve: (value: T | undefined) => void;
  reject: (error: PocketStreamError) => void;
}

/**
 * One bounded duplex stream.  Data is delivered through callbacks, `read`, or
 * an async iterator; all three consume the same bounded queue.
 */
export class PocketStream<T extends BridgeValue = BridgeValue> {
  readonly id: string;
  readonly streamId: string;
  readonly topic?: string;
  readonly params: BridgeObject;
  readonly closed: Promise<PocketStreamClose>;

  private readonly sendEvent: StreamEventSender;
  private readonly onClosed: StreamClosedCallback;
  private readonly maxBufferedMessages: number;
  private readonly deadlineFrames?: number;
  private readonly dataListeners = new Set<PocketStreamDataListener<T>>();
  private readonly errorListeners = new Set<PocketStreamErrorListener>();
  private readonly endListeners = new Set<PocketStreamEndListener>();
  private readonly queue: T[] = [];
  private readonly readers: Array<StreamReadWaiter<T>> = [];
  private resolveClosed!: (value: PocketStreamClose) => void;
  private terminal?: PocketStreamClose;
  private idleFrames = 0;
  private cancelDeadline?: () => void;

  /** @internal Constructed by `createPocketStreamAdapter`. */
  constructor(
    id: string,
    topic: string | undefined,
    params: BridgeObject,
    sendEvent: StreamEventSender,
    onClosed: StreamClosedCallback,
    maxBufferedMessages: number,
    deadlineFrames?: number,
    private readonly scheduleDeadline?: (frames: number, callback: () => void) => () => void,
  ) {
    this.id = id;
    this.streamId = id;
    this.topic = topic;
    this.params = params;
    this.sendEvent = sendEvent;
    this.onClosed = onClosed;
    this.maxBufferedMessages = maxBufferedMessages;
    this.deadlineFrames = deadlineFrames;
    this.closed = new Promise<PocketStreamClose>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get state(): PocketStreamState {
    return this.terminal?.state ?? "open";
  }

  get isClosed(): boolean {
    return this.terminal !== undefined;
  }

  onData(listener: PocketStreamDataListener<T>): () => void {
    if (this.terminal) return () => {};
    this.dataListeners.add(listener);
    this.drainDataListener(listener);
    return () => this.dataListeners.delete(listener);
  }

  onError(listener: PocketStreamErrorListener): () => void {
    if (this.terminal?.error) {
      try {
        listener(this.terminal.error);
      } catch {
        // Consumer callback errors are isolated from stream delivery.
      }
    }
    if (!this.terminal) this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onEnd(listener: PocketStreamEndListener): () => void {
    if (this.terminal) {
      try {
        listener(this.terminal);
      } catch {
        // Consumer callback errors are isolated from stream delivery.
      }
    }
    if (!this.terminal) this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Read one queued value, or `undefined` after a normal end. */
  read(): Promise<T | undefined> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.terminal) {
      if (this.terminal.error) return Promise.reject(this.terminal.error);
      return Promise.resolve(undefined);
    }
    if (this.readers.length >= this.maxBufferedMessages) {
      const error = new PocketStreamError("stream_read_quota", "Too many pending stream reads", this.id);
      this.failLocal(error, true);
      return Promise.reject(error);
    }
    return new Promise<T | undefined>((resolve, reject) =>
      this.readers.push({ resolve, reject }),
    );
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    try {
      while (true) {
        const value = await this.read();
        if (value === undefined) return;
        yield value;
      }
    } finally {
      if (!this.terminal) this.cancel("iterator_closed");
    }
  }

  send(value: T): boolean {
    if (this.terminal) return false;
    if (!isJsonValue(value))
      throw new TypeError("Stream data must be JSON serializable");
    this.touch();
    if (!this.sendEvent("stream.data", { streamId: this.id, data: value })) {
      this.failLocal(
        new PocketStreamError(
          "stream_send_failed",
          `Unable to send stream data for ${this.id}`,
          this.id,
        ),
        true,
      );
      return false;
    }
    return true;
  }

  sendBatch(values: readonly T[]): boolean {
    if (this.terminal) return false;
    if (values.length === 0) return true;
    if (values.length > POCKET_STREAM_MAX_BATCH_EVENTS) {
      throw new PocketStreamError(
        "stream_batch_too_large",
        `Stream batch exceeds the ${POCKET_STREAM_MAX_BATCH_EVENTS}-event limit`,
        this.id,
        { count: values.length, maxEvents: POCKET_STREAM_MAX_BATCH_EVENTS },
      );
    }

    // Count against the complete event envelope before handing a large array
    // to the host. The bounded walk avoids allocating item JSON text, and the
    // events array is never built for an over-limit batch.
    const emptyPacket = JSON.stringify({
      type: "event",
      name: "stream.batch",
      payload: { events: [] },
    });
    // Keep the array's two bracket bytes from the empty envelope; each item
    // is added between those brackets.
    let packetBytes = utf8ByteLength(emptyPacket);
    const events: BridgeValue[] = [];
    for (const data of values) {
      const event: BridgeValue = {
        method: "stream.data",
        params: { streamId: this.id, data },
      };
      const separatorBytes = events.length === 0 ? 0 : 1;
      const itemBytes = boundedJsonByteLength(
        event,
        POCKET_STREAM_MAX_BATCH_BYTES - packetBytes - separatorBytes,
      );
      if (itemBytes === JSON_SIZE_INVALID) {
        throw new TypeError("Stream data must be JSON serializable");
      }
      if (itemBytes === JSON_SIZE_TOO_LARGE) {
        throw new PocketStreamError(
          "stream_batch_too_large",
          `Stream batch exceeds the ${POCKET_STREAM_MAX_BATCH_BYTES}-byte limit`,
          this.id,
          {
            bytes: POCKET_STREAM_MAX_BATCH_BYTES + 1,
            maxBytes: POCKET_STREAM_MAX_BATCH_BYTES,
            count: values.length,
          },
        );
      }
      packetBytes += separatorBytes + itemBytes;
      events.push(event);
    }
    this.touch();
    if (!this.sendEvent("stream.batch", { events })) {
      this.failLocal(
        new PocketStreamError(
          "stream_send_failed",
          `Unable to send stream batch for ${this.id}`,
          this.id,
        ),
        true,
      );
      return false;
    }
    return true;
  }

  /** End the stream and optionally provide a host-readable reason. */
  end(reason?: BridgeValue): boolean {
    return this.finishWith("stream.end", "ended", reason);
  }

  close(reason?: BridgeValue): boolean {
    return this.end(reason);
  }

  cancel(reason?: BridgeValue): boolean {
    return this.finishWith("stream.cancel", "cancelled", reason);
  }

  dispose(reason: BridgeValue = "disposed"): boolean {
    if (this.terminal) return false;
    const accepted = this.sendEvent("stream.cancel", {
      streamId: this.id,
      reason,
    });
    const error = new PocketStreamError(
      "stream_disposed",
      `Stream ${this.id} was disposed`,
      this.id,
      reason,
    );
    this.terminate({ state: "disposed", reason, error });
    return accepted;
  }

  fail(error: PocketStreamError | Error | string): boolean {
    if (this.terminal) return false;
    const normalized = normalizeError(error, this.id, "stream_error");
    const accepted = this.sendEvent("stream.error", {
      streamId: this.id,
      error: { code: normalized.code, message: normalized.message },
    });
    this.terminate({ state: "errored", error: normalized });
    return accepted;
  }

  /** @internal Called by the adapter for host-originated data. */
  receive(value: T): boolean {
    if (this.terminal) return false;
    this.touch();
    if (this.readers.length > 0) {
      this.readers.shift()!.resolve(value);
      return true;
    }
    if (this.dataListeners.size > 0) {
      for (const listener of [...this.dataListeners]) {
        try {
          listener(value);
        } catch {
          // A consumer callback must not tear down the host transport.
        }
      }
      return true;
    }
    if (this.queue.length >= this.maxBufferedMessages) {
      this.failLocal(
        new PocketStreamError(
          "stream_buffer_overflow",
          `Stream ${this.id} exceeded its ${this.maxBufferedMessages}-message buffer`,
          this.id,
        ),
        true,
      );
      return false;
    }
    this.queue.push(value);
    return true;
  }

  /** @internal Called by the adapter for host-originated terminal packets. */
  receiveEnd(reason?: BridgeValue): void {
    if (this.terminal) return;
    this.touch();
    const close: PocketStreamClose =
      reason === undefined ? { state: "ended" } : { state: "ended", reason };
    this.terminate(close);
  }

  /** @internal Called by the adapter for host-originated failures. */
  receiveError(error: PocketStreamError, cancelled = false): void {
    if (this.terminal) return;
    this.touch();
    const close: PocketStreamClose =
      cancelled && error.reason !== undefined
        ? { state: "cancelled", reason: error.reason, error }
        : { state: cancelled ? "cancelled" : "errored", error };
    this.terminate(close);
  }

  /** @internal Called by the adapter's deterministic tick listener. */
  advanceFrame(): void {
    if (this.terminal || this.deadlineFrames === undefined || this.scheduleDeadline) return;
    this.idleFrames += 1;
    if (this.idleFrames < this.deadlineFrames) return;
    this.expireDeadline();
  }

  /** @internal Arm only after the stream has been published on the wire. */
  startDeadline(): void {
    this.touch();
  }

  private expireDeadline(): void {
    this.failLocal(
      new PocketStreamError(
        "stream_deadline",
        `Stream ${this.id} exceeded its ${this.deadlineFrames}-frame idle deadline`,
        this.id,
      ),
      true,
    );
  }

  private touch(): void {
    this.idleFrames = 0;
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    if (!this.terminal && this.deadlineFrames !== undefined && this.scheduleDeadline) {
      this.cancelDeadline = this.scheduleDeadline(this.deadlineFrames, () => this.expireDeadline());
    }
  }

  private finishWith(
    method: "stream.end" | "stream.cancel",
    state: "ended" | "cancelled",
    reason?: BridgeValue,
  ): boolean {
    if (this.terminal) return false;
    this.touch();
    const params: BridgeObject = { streamId: this.id };
    if (reason !== undefined) params.reason = reason;
    const accepted = this.sendEvent(method, params);
    if (!accepted) {
      const error = new PocketStreamError(
        "stream_send_failed",
        `Unable to close stream ${this.id}`,
        this.id,
      );
      this.terminate({ state: "errored", error });
      return false;
    }
    const close: PocketStreamClose = state === "cancelled"
      ? { state, reason, error: new PocketStreamError("stream_cancelled", reasonMessage(reason, "Stream cancelled"), this.id, reason) }
      : reason === undefined ? { state } : { state, reason };
    this.terminate(close);
    return true;
  }

  private failLocal(error: PocketStreamError, sendRemote: boolean): void {
    if (this.terminal) return;
    if (sendRemote) {
      try {
        this.sendEvent("stream.error", {
          streamId: this.id,
          error: { code: error.code, message: error.message },
        });
      } catch {
        // Preserve the local quota/deadline error even if transport is gone.
      }
    }
    this.terminate({ state: "errored", error });
  }

  private terminate(close: PocketStreamClose): void {
    if (this.terminal) return;
    this.terminal = close;
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    // A normal end still allows already-buffered values to be read.  Error,
    // cancellation, and disposal discard queued values because the pending
    // reads must reject with the terminal failure.
    if (close.state !== "ended") this.queue.length = 0;
    const readers = this.readers.splice(0);
    for (const reader of readers) {
      if (close.error) reader.reject(close.error);
      else reader.resolve(undefined);
    }
    if (close.error) {
      for (const listener of [...this.errorListeners]) {
        try {
          listener(close.error);
        } catch {
          // Consumer callback errors are isolated from stream delivery.
        }
      }
    }
    for (const listener of [...this.endListeners]) {
      try {
        listener(close);
      } catch {
        // Consumer callback errors are isolated from stream delivery.
      }
    }
    this.dataListeners.clear();
    this.errorListeners.clear();
    this.endListeners.clear();
    this.resolveClosed(close);
    this.onClosed(this as unknown as PocketStream<BridgeValue>);
  }

  private drainDataListener(listener: PocketStreamDataListener<T>): void {
    while (this.queue.length > 0 && !this.terminal) {
      const value = this.queue.shift()!;
      try {
        listener(value);
      } catch {
        // Consumer callback errors are isolated from stream delivery.
      }
    }
  }
}

function normalizeError(
  error: PocketStreamError | Error | string,
  streamId: string,
  fallbackCode: string,
): PocketStreamError {
  if (error instanceof PocketStreamError) return error;
  if (error instanceof Error)
    return new PocketStreamError(fallbackCode, error.message, streamId);
  return new PocketStreamError(fallbackCode, error, streamId, error);
}

export type PocketIncomingStreamListener = (stream: PocketStream) => void;

/**
 * Adapter for the Dart `PocketStreamBridge` wire.  It consumes events from
 * the existing HostBridge event sink and emits packets through its existing
 * `pocket._emit` request transport; it does not create a second bus or poll.
 */
export interface PocketStreamAdapter {
  open<T extends BridgeValue = BridgeValue>(
    topic: string,
    params?: BridgeObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  /** Compatibility spelling used by older JS service wrappers. */
  openStream<T extends BridgeValue = BridgeValue>(
    topic: string,
    params?: BridgeObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  stream<T extends BridgeValue = BridgeValue>(
    topic: string,
    params?: BridgeObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  onStream(listener: PocketIncomingStreamListener): () => void;
  get(streamId: string): PocketStream | undefined;
  dispose(reason?: BridgeValue): void;
}

const DEFAULT_BUFFER = 64;
const MAX_BUFFER = 4096;
const MAX_DEADLINE = 3600;
const RESERVED_HOST_PREFIX = "host-stream";
interface HostStreamRegistry {
  readonly owners: Map<string, PocketStreamAdapterImpl>;
}

// A HostBridge is the single event transport.  Keep ownership alongside it so
// two adapters can share the bridge without both materializing a host stream.
const hostStreamRegistries = new WeakMap<object, HostStreamRegistry>();
let nextAdapterId = 1;

class PocketStreamAdapterImpl implements PocketStreamAdapter {
  private readonly host: HostBridge;
  private readonly registry: HostStreamRegistry;
  private readonly sendEvent: StreamEventSender;
  private readonly maxBufferedMessages: number;
  private readonly maxActiveStreams: number;
  private readonly defaultDeadline?: number;
  private readonly idPrefix: string;
  private readonly streams = new Map<string, PocketStream>();
  private readonly incomingListeners = new Set<PocketIncomingStreamListener>();
  private readonly removeEvent: () => void;
  private readonly removeTick?: () => void;
  private nextId = 1;
  private disposed = false;

  constructor(host: HostBridge, options: PocketStreamAdapterOptions = {}) {
    if (typeof host.emit !== "function" || typeof host.onEvent !== "function") {
      throw new PocketStreamError(
        "stream_adapter_unavailable",
        "The HostBridge must provide emit() and onEvent() for Pocket streams",
      );
    }
    this.host = host;
    let registry = hostStreamRegistries.get(host as object);
    if (!registry) {
      registry = { owners: new Map() };
      hostStreamRegistries.set(host as object, registry);
    }
    this.registry = registry;
    this.sendEvent = (method, params) => {
      try {
        return host.emit!(method, params) === true;
      } catch {
        return false;
      }
    };
    this.maxBufferedMessages = boundedInteger(
      options.maxBufferedMessages ?? DEFAULT_BUFFER,
      "maxBufferedMessages",
      1,
      MAX_BUFFER,
    )!;
    this.maxActiveStreams = boundedInteger(options.maxActiveStreams ?? 16, "maxActiveStreams", 1, 128)!;
    this.defaultDeadline = boundedInteger(
      options.deadlineFrames,
      "deadlineFrames",
      1,
      MAX_DEADLINE,
    );
    this.idPrefix = options.idPrefix ?? `guest-stream-${nextAdapterId++}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(this.idPrefix)) {
      throw new RangeError("idPrefix must be a short alphanumeric prefix");
    }
    if (
      this.idPrefix === RESERVED_HOST_PREFIX ||
      this.idPrefix.startsWith(`${RESERVED_HOST_PREFIX}-`)
    ) {
      throw new RangeError("idPrefix is reserved for host-owned streams");
    }
    this.removeEvent = host.onEvent((event) => this.handle(event));
    if (
      this.defaultDeadline !== undefined &&
      typeof host.onTick !== "function" && typeof host.scheduleTimeout !== "function"
    ) {
      this.removeEvent();
      throw new PocketStreamError(
        "stream_adapter_unavailable",
        "A deadline requires HostBridge.onTick()",
      );
    }
    if (typeof host.onTick === "function" && typeof host.scheduleTimeout !== "function")
      this.removeTick = host.onTick(() => this.advanceFrames());
  }

  open<T extends BridgeValue = BridgeValue>(
    topic: string,
    params: BridgeObject = {},
    options: PocketStreamOpenOptions = {},
  ): PocketStream<T> {
    if (this.disposed)
      throw new PocketStreamError(
        "stream_disposed",
        "Stream adapter is disposed",
      );
    if (this.streams.size >= this.maxActiveStreams) {
      throw new PocketStreamError("stream_quota", "Active stream limit reached");
    }
    if (typeof topic !== "string" || topic.length === 0 || topic.length > 128) {
      throw new TypeError(
        "Stream topic must be a non-empty string up to 128 characters",
      );
    }
    const normalizedParams = jsonObject(
      params,
      "Stream params must be a JSON object",
    );
    const maxBufferedMessages = boundedInteger(
      options.maxBufferedMessages ?? this.maxBufferedMessages,
      "maxBufferedMessages",
      1,
      MAX_BUFFER,
    )!;
    const deadlineFrames = boundedInteger(
      options.deadlineFrames === undefined
        ? this.defaultDeadline
        : options.deadlineFrames,
      "deadlineFrames",
      1,
      MAX_DEADLINE,
    );
    if (
      deadlineFrames !== undefined &&
      typeof this.host.onTick !== "function" && typeof this.host.scheduleTimeout !== "function"
    ) {
      throw new PocketStreamError(
        "stream_adapter_unavailable",
        "A deadline requires HostBridge.onTick()",
      );
    }
    const id = options.id ?? `${this.idPrefix}-${this.nextId++}`;
    if (!id.startsWith(`${this.idPrefix}-`) || id.length > 96) {
      throw new PocketStreamError(
        "stream_id_conflict",
        `Stream ID must use the ${this.idPrefix}- prefix`,
        id,
      );
    }
    if (this.streams.has(id))
      throw new PocketStreamError(
        "stream_id_conflict",
        `Stream ID is already in use: ${id}`,
        id,
      );
    const stream = new PocketStream<T>(
      id,
      topic,
      normalizedParams,
      this.sendEvent,
      (closed) => this.removeClosed(closed.id),
      maxBufferedMessages,
      deadlineFrames,
      this.host.scheduleTimeout,
    );
    this.streams.set(id, stream as unknown as PocketStream);
    const openParams: BridgeObject = { streamId: id, topic };
    if (Object.keys(normalizedParams).length > 0) {
      openParams.params = normalizedParams;
    }
    if (!this.sendEvent("stream.open", openParams)) {
      this.streams.delete(id);
      const error = new PocketStreamError(
        "stream_unconfigured",
        `Unable to open stream capability: ${topic}`,
        id,
      );
      stream.receiveError(error);
      throw error;
    } else {
      stream.startDeadline();
    }
    return stream;
  }

  stream<T extends BridgeValue = BridgeValue>(
    topic: string,
    params: BridgeObject = {},
    options: PocketStreamOpenOptions = {},
  ): PocketStream<T> {
    return this.open<T>(topic, params, options);
  }

  openStream<T extends BridgeValue = BridgeValue>(
    topic: string,
    params: BridgeObject = {},
    options: PocketStreamOpenOptions = {},
  ): PocketStream<T> {
    return this.open<T>(topic, params, options);
  }

  onStream(listener: PocketIncomingStreamListener): () => void {
    if (this.disposed) return () => {};
    this.incomingListeners.add(listener);
    return () => this.incomingListeners.delete(listener);
  }

  get(streamId: string): PocketStream | undefined {
    return this.streams.get(streamId);
  }

  dispose(reason: BridgeValue = "adapter_disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeEvent();
    this.removeTick?.();
    for (const stream of [...this.streams.values()]) stream.dispose(reason);
    this.streams.clear();
    for (const [streamId, owner] of this.registry.owners) {
      if (owner === this) this.registry.owners.delete(streamId);
    }
    this.incomingListeners.clear();
  }

  private removeClosed(streamId: string): void {
    this.streams.delete(streamId);
    if (this.registry.owners.get(streamId) === this) {
      this.registry.owners.delete(streamId);
    }
  }

  private advanceFrames(): void {
    if (this.disposed) return;
    for (const stream of [...this.streams.values()]) stream.advanceFrame();
  }

  private handle(event: HostEvent): void {
    if (this.disposed) return;
    if (event.method === "stream.batch") {
      const events = event.params.events;
      if (!Array.isArray(events)) return;
      for (const item of events) {
        if (!isObject(item)) continue;
        const method =
          typeof item.method === "string"
            ? item.method
            : typeof item.name === "string"
              ? item.name
              : "";
        if (!method) continue;
        const nested = item.params ?? item.payload;
        const params = isObject(nested) ? (nested as BridgeObject) : {};
        this.handle({ id: event.id, method, params, raw: item });
      }
      return;
    }
    if (!event.method.startsWith("stream.")) return;
    const streamIdValue = event.params.streamId ?? event.params.id;
    if (typeof streamIdValue !== "string" || streamIdValue.length === 0) return;
    const streamId = streamIdValue;
    if (event.method === "stream.open") {
      this.openIncoming(streamId, event.params);
      return;
    }
    const owner = this.registry.owners.get(streamId);
    // Guest-owned streams are intentionally absent from the shared registry;
    // only host-originated IDs need cross-adapter ownership arbitration.
    if (owner && owner !== this) return;
    const stream = this.streams.get(streamId);
    if (!stream) return;
    if (event.method === "stream.data") {
      const raw =
        event.params.data !== undefined && event.params.data !== null
          ? event.params.data
          : (event.params.value ?? null);
      if (isJsonValue(raw)) stream.receive(raw);
      return;
    }
    if (event.method === "stream.end") {
      stream.receiveEnd(event.params.reason);
      return;
    }
    if (event.method === "stream.error") {
      stream.receiveError(
        remoteError(event.params.error, streamId, "stream_remote_error"),
      );
      return;
    }
    if (event.method === "stream.cancel") {
      const reason = event.params.reason;
      const cancellationCode =
        reason === "capability_denied" || reason === "capability_unavailable"
          ? reason
          : "stream_cancelled";
      stream.receiveError(
        new PocketStreamError(
          cancellationCode,
          reasonMessage(reason, "Remote host cancelled stream"),
          streamId,
          reason,
        ),
        true,
      );
    }
  }

  private openIncoming(streamId: string, params: BridgeObject): void {
    // A host-originated stream is only meaningful to an adapter that has an
    // active consumer.  In particular, a newly-created adapter with no
    // onStream listener must not steal the stream from another adapter.
    if (this.incomingListeners.size === 0) return;
    const owner = this.registry.owners.get(streamId);
    if (owner && owner !== this) return;
    if (streamId.startsWith(`${this.idPrefix}-`)) {
      this.sendEvent("stream.cancel", {
        streamId,
        reason: "stream_id_conflict",
      });
      return;
    }
    if (this.streams.has(streamId)) {
      // PocketStreamBridge ignores a duplicate open for an existing ID. Keep
      // the same idempotent behavior; the guest-owned prefix is handled above
      // before any host stream can claim it.
      return;
    }
    if (this.streams.size >= this.maxActiveStreams) {
      this.sendEvent("stream.cancel", { streamId, reason: "stream_quota" });
      return;
    }
    this.registry.owners.set(streamId, this);
    const topic = typeof params.topic === "string" ? params.topic : undefined;
    let streamParams: BridgeObject;
    try {
      streamParams =
        params.params === undefined
          ? {}
          : jsonObject(
              params.params,
              "Incoming stream params must be a JSON object",
            );
    } catch {
      if (this.registry.owners.get(streamId) === this) this.registry.owners.delete(streamId);
      this.sendEvent("stream.error", {
        streamId,
        error: {
          code: "stream_protocol_error",
          message: "Incoming stream params must be a JSON object",
        },
      });
      return;
    }
    const stream = new PocketStream<BridgeValue>(
      streamId,
      topic,
      streamParams,
      this.sendEvent,
      (closed) => this.removeClosed(closed.id),
      this.maxBufferedMessages,
      this.defaultDeadline,
      this.host.scheduleTimeout,
    );
    this.streams.set(streamId, stream);
    stream.startDeadline();
    for (const listener of [...this.incomingListeners]) {
      try {
        listener(stream);
      } catch {
        // A consumer setup error must not tear down the host event sink.
      }
    }
  }
}

export function createPocketStreamAdapter(
  host: HostBridge,
  options: PocketStreamAdapterOptions = {},
): PocketStreamAdapter {
  return new PocketStreamAdapterImpl(host, options);
}

export const createHostStreamAdapter = createPocketStreamAdapter;
export const createPocketStreams = createPocketStreamAdapter;
