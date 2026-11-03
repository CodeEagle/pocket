import type { HostBridge, HostEvent, JsonObject, JsonValue } from "./host.ts";

/** Terminal states for a Pocket host stream. */
export type PocketStreamState =
  "open" | "ended" | "errored" | "cancelled" | "disposed";

export interface PocketStreamClose {
  readonly state: PocketStreamState;
  readonly reason?: JsonValue;
  readonly error?: PocketStreamError;
}

/** A protocol, quota, deadline, or remote-host stream failure. */
export class PocketStreamError extends Error {
  readonly code: string;
  readonly streamId?: string;
  readonly reason?: JsonValue;

  constructor(
    code: string,
    message: string,
    streamId?: string,
    reason?: JsonValue,
  ) {
    super(message);
    this.name = "PocketStreamError";
    this.code = code;
    this.streamId = streamId;
    this.reason = reason;
  }
}

export type PocketStreamDataListener<T extends JsonValue> = (value: T) => void;
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

type StreamEventSender = (method: string, params: JsonObject) => boolean;
type StreamClosedCallback = (stream: PocketStream<JsonValue>) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 16384 || depth > 32) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    ancestors.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    const valid = values.every((child) => visit(child, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0);
}

function jsonObject(value: unknown, message: string): JsonObject {
  if (!isObject(value) || !Object.values(value).every(isJsonValue))
    throw new TypeError(message);
  return value as JsonObject;
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

function reasonMessage(
  reason: JsonValue | undefined,
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
    return new PocketStreamError(code, message, streamId, value as JsonObject);
  }
  return new PocketStreamError(
    fallbackCode,
    "Remote host stream failed",
    streamId,
  );
}

interface StreamReadWaiter<T extends JsonValue> {
  resolve: (value: T | undefined) => void;
  reject: (error: PocketStreamError) => void;
}

/**
 * One bounded duplex stream.  Data is delivered through callbacks, `read`, or
 * an async iterator; all three consume the same bounded queue.
 */
export class PocketStream<T extends JsonValue = JsonValue> {
  readonly id: string;
  readonly streamId: string;
  readonly topic?: string;
  readonly params: JsonObject;
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
    params: JsonObject,
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
    if (!values.every(isJsonValue))
      throw new TypeError("Stream data must be JSON serializable");
    if (values.length === 0) return true;
    this.touch();
    const events: JsonValue[] = values.map((data) => ({
      method: "stream.data",
      params: { streamId: this.id, data },
    }));
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
  end(reason?: JsonValue): boolean {
    return this.finishWith("stream.end", "ended", reason);
  }

  close(reason?: JsonValue): boolean {
    return this.end(reason);
  }

  cancel(reason?: JsonValue): boolean {
    return this.finishWith("stream.cancel", "cancelled", reason);
  }

  dispose(reason: JsonValue = "disposed"): boolean {
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
  receiveEnd(reason?: JsonValue): void {
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
    reason?: JsonValue,
  ): boolean {
    if (this.terminal) return false;
    this.touch();
    const params: JsonObject = { streamId: this.id };
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
    this.onClosed(this as unknown as PocketStream<JsonValue>);
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
  open<T extends JsonValue = JsonValue>(
    topic: string,
    params?: JsonObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  /** Compatibility spelling used by older JS service wrappers. */
  openStream<T extends JsonValue = JsonValue>(
    topic: string,
    params?: JsonObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  stream<T extends JsonValue = JsonValue>(
    topic: string,
    params?: JsonObject,
    options?: PocketStreamOpenOptions,
  ): PocketStream<T>;
  onStream(listener: PocketIncomingStreamListener): () => void;
  get(streamId: string): PocketStream | undefined;
  dispose(reason?: JsonValue): void;
}

const DEFAULT_BUFFER = 64;
const MAX_BUFFER = 4096;
const MAX_DEADLINE = 3600;
const RESERVED_HOST_PREFIX = "host-stream";
let nextAdapterId = 1;

class PocketStreamAdapterImpl implements PocketStreamAdapter {
  private readonly host: HostBridge;
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

  open<T extends JsonValue = JsonValue>(
    topic: string,
    params: JsonObject = {},
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
    const openParams: JsonObject = { streamId: id, topic };
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

  stream<T extends JsonValue = JsonValue>(
    topic: string,
    params: JsonObject = {},
    options: PocketStreamOpenOptions = {},
  ): PocketStream<T> {
    return this.open<T>(topic, params, options);
  }

  openStream<T extends JsonValue = JsonValue>(
    topic: string,
    params: JsonObject = {},
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

  dispose(reason: JsonValue = "adapter_disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeEvent();
    this.removeTick?.();
    for (const stream of [...this.streams.values()]) stream.dispose(reason);
    this.streams.clear();
    this.incomingListeners.clear();
  }

  private removeClosed(streamId: string): void {
    this.streams.delete(streamId);
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
        const params = isObject(nested) ? (nested as JsonObject) : {};
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

  private openIncoming(streamId: string, params: JsonObject): void {
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
    const topic = typeof params.topic === "string" ? params.topic : undefined;
    let streamParams: JsonObject;
    try {
      streamParams =
        params.params === undefined
          ? {}
          : jsonObject(
              params.params,
              "Incoming stream params must be a JSON object",
            );
    } catch {
      this.sendEvent("stream.error", {
        streamId,
        error: {
          code: "stream_protocol_error",
          message: "Incoming stream params must be a JSON object",
        },
      });
      return;
    }
    const stream = new PocketStream<JsonValue>(
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
