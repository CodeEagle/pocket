import type { HostBridge, HostEvent, JsonObject } from "./host.ts";

/** Commands understood by the Flutter video surface. */
export type VideoPlaybackMethod = "video.play" | "video.pause" | "video.release";

const MAX_MEDIA_ENTRIES = 128;
const MAX_MEDIA_ID_LENGTH = 128;

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
}

export interface MediaRegistration {
  readonly id: string;
  readonly group?: string;
  readonly page?: string;
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
  /** Existing host bridge. Its emit() is the native frame-event transport. */
  bridge?: Pick<HostBridge, "emit" | "onEvent">;
  /** Set false when an owning platform client forwards lifecycle events itself. */
  subscribeLifecycle?: boolean;
  /** Optional app filter for shared host bridges. */
  appId?: string;
  /** Optional runtime-instance filter for shared host bridges. */
  instanceId?: string;
  /** Replace the bridge's event emitter in deterministic tests or adapters. */
  emit?: (method: VideoPlaybackMethod, params: JsonObject) => boolean;
}

export interface MediaController {
  /** Register one retained Flutter video id. Duplicate ids are rejected. */
  register(id: string, options?: MediaEntryOptions): MediaRegistration;
  /** Switch the page gate; entries without a page are always eligible. */
  setCurrentPage(page: string | undefined): void;
  /** Begin a temporary coverage gate (nested launches are reference-counted). */
  beginCoverage(reason?: string): () => void;
  /** Apply a platform.lifecycle event from the existing host/client event lane. */
  handleLifecycle(event: MediaLifecycleEvent): void;
  /** Stop playback, detach lifecycle listeners, and release every registration. */
  dispose(): void;
}

interface Entry {
  readonly id: string;
  readonly group?: string;
  readonly page?: string;
  intent: boolean;
  active: boolean;
  /** undefined means the retained native player has not received a policy yet. */
  applied: boolean | undefined;
  disposed: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lifecycleFromEvent(event: HostEvent): MediaLifecycleEvent | undefined {
  if (event.method !== "platform.lifecycle") return undefined;
  return isObject(event.params) ? event.params as MediaLifecycleEvent : undefined;
}

function defaultEmitter(method: VideoPlaybackMethod, params: JsonObject): boolean {
  const globalObject = globalThis as typeof globalThis & {
    pocket?: { _emit?: (line: string) => boolean };
  };
  const emit = globalObject.pocket?._emit;
  if (typeof emit !== "function") return false;
  try {
    return emit(JSON.stringify({ type: "event", name: method, payload: params })) === true;
  } catch {
    return false;
  }
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
  const bridge = options.bridge;
  const emit = options.emit ?? ((method: VideoPlaybackMethod, params: JsonObject) => {
    if (typeof bridge?.emit === "function") return bridge.emit(method, params);
    return defaultEmitter(method, params);
  });
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
      accepted = emit(method, { id: entry.id });
    } catch {
      accepted = false;
    }
    if (accepted) entry.applied = playing;
    return accepted;
  };

  const sync = (entry: Entry): boolean => {
    const next = shouldPlay(entry);
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

  if (options.subscribeLifecycle !== false && typeof bridge?.onEvent === "function") {
    removeHostEvents = bridge.onEvent((event) => {
      const lifecycle = lifecycleFromEvent(event);
      if (lifecycle) handleLifecycle(lifecycle);
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
        intent: entryOptions.playing === true,
        active: entryOptions.active !== false,
        applied: undefined,
        disposed: false,
      };
      entries.set(id, entry);
      // An explicit initial intent is real playback, not an implicit autoplay
      // policy; group peers are resolved before the first event is emitted.
      if (entry.intent) pauseGroupPeers(entry);
      sync(entry);

      const registration: MediaRegistration = {
        id: entry.id,
        ...(entry.group !== undefined ? { group: entry.group } : {}),
        ...(entry.page !== undefined ? { page: entry.page } : {}),
        play(): boolean {
          if (entry.disposed || disposed) return false;
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
          // `video.release` is a permanent lifecycle boundary. It clears the
          // Flutter desired-command cache as well as the retained decoder;
          // unlike a temporary visibility pause it must be emitted even when
          // the player was already paused.
          try { emit("video.release", { id: entry.id }); } catch { /* release is best effort */ }
          entries.delete(entry.id);
          entry.applied = false;
          entry.intent = false;
          entry.active = false;
        },
      };
      return registration;
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeHostEvents?.();
      removeHostEvents = undefined;
      for (const entry of entries.values()) {
        entry.disposed = true;
        try { emit("video.release", { id: entry.id }); } catch { /* release is best effort */ }
      }
      entries.clear();
      coverageDepth = 0;
    },
  };
  return controller;
}
