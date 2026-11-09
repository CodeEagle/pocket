import { HostBridgeAbiError, type HostBridge, type HostEvent, type JsonObject } from "./host.ts";

/** Commands understood by the Flutter video surface. */
export type VideoPlaybackMethod = "video.play" | "video.pause" | "video.release";
export type VideoRequestMethod = "video.inspect" | "video.seek";
export type VideoConfigureMethod = "video.configure";
export type VideoMediaMethod = VideoPlaybackMethod | VideoRequestMethod | VideoConfigureMethod;

const MAX_MEDIA_ENTRIES = 128;
const MAX_MEDIA_ID_LENGTH = 128;
const MAX_PENDING_VIDEO_REQUESTS = 16;
const DEFAULT_VIDEO_REQUEST_TIMEOUT_MS = 3_000;
const MAX_VIDEO_REQUEST_TIMEOUT_MS = 60_000;
const MAX_VIDEO_REQUEST_ID_LENGTH = 128;

export interface VideoSnapshot {
  readonly id: string;
  /** Correlation generation for the native fact; null for legacy hosts. */
  readonly token: string | null;
  readonly asset: string;
  readonly state: string;
  readonly playing: boolean;
  readonly visible: boolean;
  readonly active: boolean;
  /** Null until the native player has initialized. */
  readonly positionMs: number | null;
  /** Null until the native player has initialized. */
  readonly durationMs: number | null;
  readonly error: string | null;
}

export class VideoMediaRequestError extends Error {
  readonly code: string;
  readonly requestId?: string;

  constructor(code: string, message: string, requestId?: string) {
    super(message);
    this.name = "VideoMediaRequestError";
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

/** Lifecycle values delivered by the existing platform client. */
export type MediaLifecycleState =
  | "onWillAppear"
  | "onDidAppear"
  | "onWillDisappear"
  | "frozenInStack"
  | "onResume"
  | "onUnload";

export type MediaLifecycleEvent = JsonObject & {
  state?: MediaLifecycleState | string;
  appId?: string;
  instanceId?: string;
};

export interface MediaEntryOptions {
  /** A feed group is exclusive: playing one entry pauses the group's peers. */
  group?: string;
  /** Entries on another page are gated until that page becomes current. */
  page?: string;
  /** Initial user intent. Defaults to false; registering never implies autoplay. */
  playing?: boolean;
  /** Whether this entry is currently in the active/visible set. Defaults to true. */
  active?: boolean;
  /** Mutable native-fact correlation generation. It does not change surface identity. */
  token?: string;
  /** Whether the native controller loops. Legacy callers default to true. */
  loop?: boolean;
}

export interface MediaEntryConfiguration {
  /** Omit to preserve the current token; pass null to return to the legacy uncorrelated mode. */
  token?: string | null;
  /** Omit to preserve the current native loop policy. */
  loop?: boolean;
  /** Optional current JS intent, applied after configuration in the same event turn. */
  playing?: boolean;
}

export interface MediaRegistration {
  readonly id: string;
  readonly group?: string;
  readonly page?: string;
  /** Update generation and/or loop policy without replacing the native surface. */
  configure(configuration: MediaEntryConfiguration): boolean;
  /** Update the correlation generation without changing the stable native id. */
  setToken(token: string | null): boolean;
  /** Update native looping without replacing the controller. */
  setLoop(loop: boolean): boolean;
  /**
   * Express an explicit user play intent. In a group this selects the entry
   * even while it is inactive/gated: peers are paused immediately, while this
   * entry waits for its active/page/lifecycle gates before emitting play.
   */
  play(): boolean;
  /** Express an explicit user pause intent and emit video.pause when needed. */
  pause(): boolean;
  /** Gate presentation without changing the user's play intent. */
  setActive(active: boolean): void;
  /** Permanently release the registration and its retained native decoder. */
  dispose(): void;
}

export interface MediaControllerOptions {
  /** Existing host bridge. Its emit() and onEvent() are the native event lane. */
  bridge?: Pick<HostBridge, "emit" | "onEvent">;
  /** Set false when an owning platform client forwards events via handleHostEvent. */
  subscribeLifecycle?: boolean;
  /** Optional app filter for shared host bridges. */
  appId?: string;
  /** Optional runtime-instance filter for shared host bridges. */
  instanceId?: string;
  /** Per-request deadline. Defaults to 3 seconds and is bounded to 60 seconds. */
  requestTimeoutMs?: number;
  /** Existing guest-clock one-shot scheduler, expressed in milliseconds. */
  scheduleTimeoutMs?: (timeoutMs: number, callback: () => void) => () => void;
  /** Replace media-event emission without changing the existing callback contract. */
  emit?: (method: VideoPlaybackMethod | VideoConfigureMethod, params: JsonObject) => boolean;
  /** Optional request-event emitter for deterministic tests or host adapters. */
  emitRequest?: (method: VideoRequestMethod, params: JsonObject) => boolean;
}

export interface MediaController {
  /** Register one retained Flutter video id. Duplicate ids are rejected. */
  register(id: string, options?: MediaEntryOptions): MediaRegistration;
  /** Reconfigure a registered stable id; useful to an owner that does not hold the component registration. */
  configure(id: string, configuration: MediaEntryConfiguration): boolean;
  /** Switch the page gate; entries without a page are always eligible. */
  setCurrentPage(page: string | undefined): void;
  /** Begin a temporary coverage gate (nested launches are reference-counted). */
  beginCoverage(reason?: string): () => void;
  /** Apply a platform.lifecycle event from the existing host/client event lane. */
  handleLifecycle(event: MediaLifecycleEvent): void;
  /** Forward an event when the owning client already dispatches the bridge lane. */
  handleHostEvent(event: HostEvent): void;
  /** Read the current real native player facts once; this does not poll. */
  inspect(id: string): Promise<VideoSnapshot>;
  /** Seek within the last inspected duration and return the resulting real facts. */
  seek(id: string, positionMs: number): Promise<VideoSnapshot>;
  /** Stop playback, detach lifecycle listeners, and release every registration. */
  dispose(): void;
}

interface Entry {
  readonly id: string;
  readonly group?: string;
  readonly page?: string;
  token: string | undefined;
  loop: boolean;
  intent: boolean;
  /** An ended/seek-to-end native fact blocks same-generation policy replays. */
  endSuppressed: boolean;
  /** Explicit replay requested while gated; consumed by the next play event. */
  restartIntent: boolean;
  active: boolean;
  /** undefined means the retained native player has not received a policy yet. */
  applied: boolean | undefined;
  disposed: boolean;
}

interface PendingVideoRequest {
  readonly id: string;
  readonly token: string | undefined;
  readonly operation: "inspect" | "seek";
  readonly resolve: (snapshot: VideoSnapshot) => void;
  readonly reject: (error: Error) => void;
  cancelTimeout?: () => void;
}

let nextMediaRequestScope = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lifecycleFromEvent(event: HostEvent): MediaLifecycleEvent | undefined {
  if (event.method !== "platform.lifecycle") return undefined;
  return isObject(event.params) ? event.params as MediaLifecycleEvent : undefined;
}

function defaultEmitter(method: VideoMediaMethod, params: JsonObject): boolean {
  const globalObject = globalThis as typeof globalThis & {
    pocket?: { _emitValue?: (packet: Record<string, unknown>) => boolean };
  };
  const emit = globalObject.pocket?._emitValue;
  if (typeof emit !== "function") throw new HostBridgeAbiError();
  try {
    return emit({ type: "event", name: method, payload: params }) === true;
  } catch {
    return false;
  }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseVideoSnapshotItem(id: string, item: unknown): VideoSnapshot {
  if (!isObject(item) || typeof item.state !== "string") {
    throw new VideoMediaRequestError("missing_video", `Native video snapshot did not include ${id}`);
  }
  return {
    id,
    token: nonEmpty(item.token) ?? null,
    asset: typeof item.asset === "string" ? item.asset : "",
    state: item.state,
    playing: item.playing === true,
    visible: item.visible === true,
    active: item.active === true,
    positionMs: finiteNonNegative(item.positionMs),
    durationMs: finiteNonNegative(item.durationMs),
    error: typeof item.error === "string" && item.error.length > 0 ? item.error : null,
  };
}

function parseVideoSnapshot(id: string, params: unknown): VideoSnapshot {
  if (!isObject(params) || !Array.isArray(params.items)) {
    throw new VideoMediaRequestError("invalid_snapshot", "Native video snapshot is malformed");
  }
  const item = params.items.find((candidate) => isObject(candidate) && candidate.id === id);
  return parseVideoSnapshotItem(id, item);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MEDIA_ID_LENGTH
    ? value
    : undefined;
}

/**
 * Event-driven playback policy for retained Flutter video nodes.
 *
 * This is intentionally a policy/controller, not a renderer or a second video
 * runtime: the caller still owns its existing registered video/SURFACE_QUAD node and
 * supplies its stable native video id. Commands become frame events consumed by
 * PocketView's existing video.play/video.pause/video.release handler.
 */
export function createMediaController(options: MediaControllerOptions = {}): MediaController {
  const entries = new Map<string, Entry>();
  const pendingRequests = new Map<string, PendingVideoRequest>();
  const latestSnapshots = new Map<string, VideoSnapshot>();
  const bridge = options.bridge;
  const bridgeEmit = (method: VideoMediaMethod, params: JsonObject): boolean => {
    if (typeof bridge?.emit === "function") return bridge.emit(method, params);
    return defaultEmitter(method, params);
  };
  const emitPlayback = options.emit ?? bridgeEmit;
  const emitRequest = options.emitRequest ?? bridgeEmit;
  // Keep the deadline in milliseconds through the API; the owning platform
  // client adapts it to its existing guest-clock scheduler.
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_VIDEO_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_VIDEO_REQUEST_TIMEOUT_MS) {
    throw new RangeError(`requestTimeoutMs must be an integer between 1 and ${MAX_VIDEO_REQUEST_TIMEOUT_MS}`);
  }
  const scheduleTimeoutMs = options.scheduleTimeoutMs;
  const requestScope = nextMediaRequestScope++;
  let nextRequestSequence = 1;
  let currentPage: string | undefined;
  let coverageDepth = 0;
  let lifecycleActive = true;
  let disposed = false;
  let removeHostEvents: (() => void) | undefined;

  const pageAllowed = (entry: Entry): boolean =>
    entry.page === undefined || (currentPage !== undefined && entry.page === currentPage);
  const shouldPlay = (entry: Entry): boolean =>
    !disposed && lifecycleActive && coverageDepth === 0 && entry.active && pageAllowed(entry) && entry.intent;

  const send = (entry: Entry, playing: boolean): boolean => {
    const method: VideoPlaybackMethod = playing ? "video.play" : "video.pause";
    let accepted = false;
    try {
      accepted = emitPlayback(method, {
        id: entry.id,
        ...(entry.token !== undefined ? { token: entry.token } : {}),
        ...(playing && entry.restartIntent ? { restart: true } : {}),
      });
    } catch (error) {
      if (error instanceof HostBridgeAbiError) throw error;
      accepted = false;
    }
    if (accepted) {
      entry.applied = playing;
      if (playing) entry.restartIntent = false;
    }
    return accepted;
  };

  const sync = (entry: Entry): boolean => {
    const next = shouldPlay(entry);
    if (next && entry.endSuppressed) {
      entry.applied = false;
      return true;
    }
    if (entry.applied === next) return true;
    return send(entry, next);
  };

  const syncAll = (): void => {
    // A page/lifecycle transition must establish all pauses before any new
    // play. This keeps a retained feed's old item from briefly competing with
    // the newly selected item when insertion order differs from visual order.
    for (const entry of entries.values()) {
      if (!shouldPlay(entry)) sync(entry);
    }
    for (const entry of entries.values()) {
      if (shouldPlay(entry)) sync(entry);
    }
  };

  const pauseGroupPeers = (entry: Entry): void => {
    if (!entry.group) return;
    for (const peer of entries.values()) {
      if (peer === entry || peer.group !== entry.group || peer.disposed) continue;
      // `play()` is an explicit feed selection even when the selected entry is
      // currently inactive. Clear the peer's intent immediately so the old
      // item cannot keep playing or restart on a later lifecycle/visibility
      // transition; the selected entry remains gated until it is active.
      peer.intent = false;
      sync(peer);
    }
  };

  const handleLifecycle = (event: MediaLifecycleEvent): void => {
    if (disposed) return;
    if (options.appId !== undefined && event.appId !== options.appId) return;
    if (options.instanceId !== undefined && event.instanceId !== options.instanceId) return;
    const state = nonEmpty(event.state);
    if (state === "onWillDisappear" || state === "frozenInStack" || state === "onUnload") {
      lifecycleActive = false;
      syncAll();
    } else if (state === "onResume" || state === "onDidAppear") {
      lifecycleActive = true;
      syncAll();
    }
  };

  const rejectPending = (requestId: string, error: Error): void => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    pending.cancelTimeout?.();
    pending.reject(error);
  };

  const rejectRequestsForVideo = (id: string, code = "video_released"): void => {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.id === id) {
        rejectPending(requestId, new VideoMediaRequestError(code, code === "video_released" ? `Video ${id} was released` : `Video ${id} changed generation`, requestId));
      }
    }
    latestSnapshots.delete(id);
  };

  const configureEntry = (entry: Entry, configuration: MediaEntryConfiguration): boolean => {
    if (entry.disposed || disposed) return false;
    const nextToken = configuration.token === undefined ? entry.token : configuration.token ?? undefined;
    const nextLoop = configuration.loop === undefined ? entry.loop : configuration.loop;
    const nextIntent = configuration.playing === undefined ? entry.intent : configuration.playing;
    if (configuration.loop !== undefined && typeof configuration.loop !== "boolean") {
      throw new TypeError("Video loop must be a boolean");
    }
    if (configuration.playing !== undefined && typeof configuration.playing !== "boolean") {
      throw new TypeError("Video playing intent must be a boolean");
    }
    if (configuration.token !== undefined && configuration.token !== null && !nonEmpty(configuration.token)) {
      throw new TypeError("Video token must be a non-empty string or null");
    }
    const tokenChanged = nextToken !== entry.token;
    const loopChanged = nextLoop !== entry.loop;
    const intentChanged = nextIntent !== entry.intent;
    if (!tokenChanged && !loopChanged) {
      if (intentChanged) {
        entry.intent = nextIntent;
        if (entry.intent && entry.endSuppressed) {
          entry.endSuppressed = false;
          entry.restartIntent = true;
          entry.applied = false;
        }
        if (entry.intent) pauseGroupPeers(entry);
        return sync(entry);
      }
      return true;
    }
    if (nextIntent && (!entry.intent || tokenChanged)) pauseGroupPeers(entry);
    let accepted = false;
    try {
      accepted = emitPlayback("video.configure", {
        id: entry.id,
        token: nextToken ?? null,
        loop: nextLoop,
      });
    } catch (error) {
      if (error instanceof HostBridgeAbiError) throw error;
      return false;
    }
    if (!accepted) return false;
    if (tokenChanged) {
      rejectRequestsForVideo(entry.id, "video_token_changed");
      entry.applied = undefined;
      entry.endSuppressed = false;
      entry.restartIntent = false;
    }
    entry.token = nextToken;
    entry.loop = nextLoop;
    if (configuration.playing !== undefined) {
      entry.intent = nextIntent;
      if (!tokenChanged && intentChanged && entry.intent && entry.endSuppressed) {
        entry.endSuppressed = false;
        entry.restartIntent = true;
        entry.applied = false;
      }
    }
    if (configuration.playing !== undefined || tokenChanged) sync(entry);
    return true;
  };

  const handleSnapshot = (event: HostEvent): void => {
    if (event.method !== "video.snapshot" || !isObject(event.params)) return;
    const requestId = nonEmpty(event.params.requestId);
    if (!requestId) return; // Legacy broadcasts remain observable but are never treated as a response.
    const pending = pendingRequests.get(requestId);
    if (!pending) return; // Late, duplicate, and unrelated snapshots are ignored.
    if (pending.id !== event.params.id && event.params.id !== undefined) return;
    try {
      if (pending.token !== undefined && event.params.token !== pending.token) {
        throw new VideoMediaRequestError("stale_token", "Native video snapshot has a stale generation", requestId);
      }
      const snapshot = parseVideoSnapshot(pending.id, event.params);
      if (pending.token !== undefined && snapshot.token !== pending.token) {
        throw new VideoMediaRequestError("stale_token", "Native video snapshot has a stale generation", requestId);
      }
      if (
        (snapshot.state === "ready" || snapshot.state === "playing" || snapshot.state === "paused" || snapshot.state === "ended") &&
        (snapshot.positionMs === null || snapshot.durationMs === null)
      ) {
        throw new VideoMediaRequestError("invalid_snapshot", `Initialized video ${snapshot.id} has no native position or duration`, requestId);
      }
      latestSnapshots.set(snapshot.id, snapshot);
      const entry = entries.get(snapshot.id);
      if (entry && entry.token === pending.token) updateEndSuppression(entry, snapshot);
      if (pending.operation === "seek") {
        if (snapshot.error || snapshot.state === "error") {
          throw new VideoMediaRequestError("native_seek_error", snapshot.error ?? "Native video seek failed", requestId);
        }
        if (snapshot.positionMs === null || snapshot.durationMs === null || snapshot.state === "loading" || snapshot.state === "disposed") {
          throw new VideoMediaRequestError("video_not_ready", `Video ${snapshot.id} has no initialized position or duration`, requestId);
        }
      }
      pendingRequests.delete(requestId);
      pending.cancelTimeout?.();
      pending.resolve(snapshot);
    } catch (error) {
      rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
    }
  };

  const updateEndSuppression = (entry: Entry, snapshot: VideoSnapshot): void => {
    const atDuration = snapshot.positionMs !== null && snapshot.durationMs !== null && snapshot.positionMs === snapshot.durationMs;
    if (snapshot.state === "ended") {
      entry.endSuppressed = true;
      entry.intent = false;
      entry.applied = false;
      entry.restartIntent = false;
    } else if (!entry.loop && atDuration) {
      entry.endSuppressed = true;
      entry.applied = false;
    } else if (!atDuration) {
      entry.endSuppressed = false;
    }
  };

  const handleHostEvent = (event: HostEvent): void => {
    if (disposed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle) handleLifecycle(lifecycle);
    handleSnapshot(event);
    if (event.method === "video.state" && isObject(event.params)) {
      const id = nonEmpty(event.params.id);
      const entry = id === undefined ? undefined : entries.get(id);
      if (!entry || event.params.token !== entry.token) return;
      try {
        const snapshot = parseVideoSnapshotItem(entry.id, event.params);
        if (
          (snapshot.state === "ready" || snapshot.state === "playing" || snapshot.state === "paused" || snapshot.state === "ended") &&
          (snapshot.positionMs === null || snapshot.durationMs === null)
        ) return;
        latestSnapshots.set(entry.id, snapshot);
        updateEndSuppression(entry, snapshot);
      } catch {
        return;
      }
    }
  };

  const requestVideo = (
    id: string,
    operation: "inspect" | "seek",
    requestedPositionMs?: number,
  ): Promise<VideoSnapshot> => {
    if (disposed) return Promise.reject(new VideoMediaRequestError("controller_disposed", "Media controller is disposed"));
    const entry = entries.get(id);
    if (!entry || entry.disposed) return Promise.reject(new VideoMediaRequestError("video_unregistered", `Video ${id} is not registered`));
    if (pendingRequests.size >= MAX_PENDING_VIDEO_REQUESTS) {
      return Promise.reject(new VideoMediaRequestError("request_quota", "Too many pending video requests"));
    }
    if (typeof scheduleTimeoutMs !== "function") {
      return Promise.reject(new VideoMediaRequestError("timeout_unavailable", "Video requests require the guest clock deadline scheduler"));
    }
    if (operation === "seek") {
      if (!Number.isInteger(requestedPositionMs) || requestedPositionMs! < 0) {
        return Promise.reject(new RangeError("Video seek position must be a non-negative integer number of milliseconds"));
      }
      const previous = latestSnapshots.get(id);
      if (!previous || previous.token !== (entry.token ?? null) || previous.durationMs === null || previous.positionMs === null || previous.error !== null || previous.state === "loading" || previous.state === "disposed") {
        return Promise.reject(new VideoMediaRequestError("video_not_inspected", `Inspect initialized video ${id} before seeking`));
      }
      if (requestedPositionMs! > previous.durationMs) {
        return Promise.reject(new RangeError(`Video seek position exceeds duration (${previous.durationMs} ms)`));
      }
    }
    const requestId = `vm-${requestScope.toString(36)}-${nextRequestSequence.toString(36)}`;
    nextRequestSequence += 1;
    if (requestId.length > MAX_VIDEO_REQUEST_ID_LENGTH) {
      return Promise.reject(new VideoMediaRequestError("request_id_exhausted", "Video request identifier limit reached"));
    }
    return new Promise<VideoSnapshot>((resolve, reject) => {
      const pending: PendingVideoRequest = {
        id,
        token: entry.token,
        operation,
        resolve,
        reject,
      };
      pendingRequests.set(requestId, pending);
      try {
        pending.cancelTimeout = scheduleTimeoutMs(requestTimeoutMs, () => {
          rejectPending(requestId, new VideoMediaRequestError("timeout", `Video ${operation} request timed out`, requestId));
        });
        const method: VideoRequestMethod = operation === "inspect" ? "video.inspect" : "video.seek";
        const params: JsonObject = {
          id,
          ...(entry.token !== undefined ? { token: entry.token } : {}),
          requestId,
          ...(requestedPositionMs !== undefined ? { positionMs: requestedPositionMs } : {}),
        };
        if (!emitRequest(method, params)) {
          rejectPending(requestId, new VideoMediaRequestError("transport_rejected", `Host rejected ${method} request`, requestId));
        }
      } catch (error) {
        rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  if (typeof bridge?.onEvent === "function" && options.subscribeLifecycle !== false) {
    removeHostEvents = bridge.onEvent((event) => {
      handleHostEvent(event);
    });
  }

  const controller: MediaController = {
    register(id: string, entryOptions: MediaEntryOptions = {}): MediaRegistration {
      if (disposed) throw new Error("Media controller is disposed");
      if (!nonEmpty(id)) throw new TypeError("Media id must be non-empty");
      if (entries.has(id)) throw new Error(`Media id is already registered: ${id}`);
      if (entries.size >= MAX_MEDIA_ENTRIES) throw new Error("Too many media registrations");
      const entry: Entry = {
        id,
        ...(entryOptions.group !== undefined ? { group: entryOptions.group } : {}),
        ...(entryOptions.page !== undefined ? { page: entryOptions.page } : {}),
        token: undefined,
        loop: true,
        intent: entryOptions.playing === true,
        endSuppressed: false,
        restartIntent: false,
        active: entryOptions.active !== false,
        applied: undefined,
        disposed: false,
      };
      entries.set(id, entry);
      // Resolve an exclusive group before initial configuration can re-send
      // this entry's explicit play intent under its new token.
      if (entry.intent) pauseGroupPeers(entry);
      if (entryOptions.token !== undefined || entryOptions.loop !== undefined) {
        configureEntry(entry, {
          ...(entryOptions.token !== undefined ? { token: entryOptions.token } : {}),
          ...(entryOptions.loop !== undefined ? { loop: entryOptions.loop } : {}),
          playing: entry.intent,
        });
      }
      // An explicit initial intent is real playback, not an implicit autoplay
      // policy; group peers were resolved before configuration above.
      sync(entry);

      const registration: MediaRegistration = {
        id: entry.id,
        ...(entry.group !== undefined ? { group: entry.group } : {}),
        ...(entry.page !== undefined ? { page: entry.page } : {}),
        configure(configuration: MediaEntryConfiguration): boolean {
          return configureEntry(entry, configuration);
        },
        setToken(token: string | null): boolean {
          return configureEntry(entry, { token });
        },
        setLoop(loop: boolean): boolean {
          return configureEntry(entry, { loop });
        },
        play(): boolean {
          if (entry.disposed || disposed) return false;
          if (entry.endSuppressed) {
            entry.endSuppressed = false;
            entry.restartIntent = true;
            entry.applied = false;
          }
          entry.intent = true;
          pauseGroupPeers(entry);
          return sync(entry);
        },
        pause(): boolean {
          if (entry.disposed || disposed) return false;
          entry.intent = false;
          return sync(entry);
        },
        setActive(active: boolean): void {
          if (entry.disposed || disposed) return;
          entry.active = active === true;
          sync(entry);
        },
        dispose(): void {
          if (entry.disposed) return;
          entry.disposed = true;
          rejectRequestsForVideo(entry.id);
          // `video.release` is a permanent lifecycle boundary. It clears the
          // Flutter desired-command cache as well as the retained decoder;
          // unlike a temporary visibility pause it must be emitted even when
          // the player was already paused.
          try { emitPlayback("video.release", { id: entry.id, ...(entry.token !== undefined ? { token: entry.token } : {}) }); } catch { /* release is best effort */ }
          entries.delete(entry.id);
          entry.applied = false;
          entry.intent = false;
          entry.active = false;
        },
      };
      return registration;
    },
    configure(id: string, configuration: MediaEntryConfiguration): boolean {
      const entry = entries.get(id);
      if (!entry || entry.disposed) return false;
      return configureEntry(entry, configuration);
    },
    setCurrentPage(page: string | undefined): void {
      if (disposed) return;
      currentPage = page;
      syncAll();
    },
    beginCoverage(_reason?: string): () => void {
      if (disposed) return () => {};
      coverageDepth += 1;
      syncAll();
      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        coverageDepth = Math.max(0, coverageDepth - 1);
        syncAll();
      };
    },
    handleLifecycle,
    handleHostEvent,
    inspect(id: string): Promise<VideoSnapshot> {
      return requestVideo(id, "inspect");
    },
    seek(id: string, positionMs: number): Promise<VideoSnapshot> {
      return requestVideo(id, "seek", positionMs);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeHostEvents?.();
      removeHostEvents = undefined;
      for (const requestId of [...pendingRequests.keys()]) {
        rejectPending(requestId, new VideoMediaRequestError("controller_disposed", "Media controller is disposed", requestId));
      }
      latestSnapshots.clear();
      for (const entry of entries.values()) {
        entry.disposed = true;
        try { emitPlayback("video.release", { id: entry.id, ...(entry.token !== undefined ? { token: entry.token } : {}) }); } catch { /* release is best effort */ }
      }
      entries.clear();
      coverageDepth = 0;
    },
  };
  return controller;
}
