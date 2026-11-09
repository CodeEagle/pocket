import { after } from "@pocketjs/framework/clock";
import { createMediaController, VideoMediaRequestError, type MediaController, type VideoSnapshot } from "@pocket/ui/media";
import type { HostBridge, HostEvent } from "@pocket/ui/host";
import { novelVideoSeekIssue } from "./video-schema.ts";
import type { EngineUpdate, NovelEngine, NovelSaveData, NovelVideoPlaybackFact } from "./types.ts";

export interface NovelVideoAdapterHost extends Pick<HostBridge, "emit" | "onEvent"> {}

export interface NovelVideoAdapterOptions {
  /** Override the stable surface id when a consumer needs deterministic diagnostics. */
  readonly id?: string;
  /** Test/embedding override for the existing Pocket virtual-clock timeout scheduler. */
  readonly scheduleTimeoutMs?: (timeoutMs: number, callback: () => void) => () => void;
  readonly onError?: (error: unknown) => void;
}

export interface NovelVideoAdapter {
  /** One existing MediaController shared by NovelView and the retained Video node. */
  readonly media: MediaController;
  /** Stable for this adapter lifetime; distinct adapters never share a native surface. */
  readonly surfaceId: string;
  /** Bind to the currently displayed engine and route its events/native facts. */
  bind(engine: NovelEngine, onError?: (error: unknown) => void): () => void;
  /** Capture one real native position/duration before synchronously saving this same engine. */
  captureForSave(engine: NovelEngine, isCurrent: () => boolean): Promise<NovelSaveData>;
  /** Inspect native position, validate the target, and issue a persistent VN seek command. */
  seekBy(engine: NovelEngine, deltaMs: number, isCurrent?: () => boolean): Promise<EngineUpdate>;
  /** Seek to an absolute native position using the same engine command path. */
  seekTo(engine: NovelEngine, positionMs: number, isCurrent?: () => boolean): Promise<EngineUpdate>;
  /** Dispose this adapter's media registrations and bridge subscription. */
  dispose(): void;
}

interface Binding {
  readonly engine: NovelEngine;
  onError?: (error: unknown) => void;
  removeEngine?: () => void;
  lastToken: string | null;
  lastCue: string | null;
}

interface RestoreRequest {
  readonly binding: Binding;
  readonly token: string;
  readonly cue: string;
  readonly positionMs: number;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  cancelTimeout?: () => void;
  started: boolean;
}

let nextVideoAdapterSequence = 0;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nativeFact(snapshot: VideoSnapshot, token: string, loop: boolean): NovelVideoPlaybackFact {
  return {
    token,
    status: snapshot.state === "ended" && !loop ? "ended" : snapshot.playing ? "playing" : "paused",
    positionMs: snapshot.positionMs,
    durationMs: snapshot.durationMs,
  };
}

function staleOperation(message: string): VideoMediaRequestError {
  return new VideoMediaRequestError("stale_generation", message);
}

/**
 * Adapt one canonical VN stage video to Pocket's existing retained Video and
 * MediaController. It has no decoder, clock, or persisted state of its own.
 */
export function createNovelVideoAdapter(
  host: NovelVideoAdapterHost,
  options: NovelVideoAdapterOptions = {},
): NovelVideoAdapter {
  const surfaceId = options.id ?? `novel-vn-video-${++nextVideoAdapterSequence}`;
  if (!nonEmpty(surfaceId) || surfaceId.length > 128) throw new TypeError("Video adapter id must be a non-empty string up to 128 characters");
  const scheduleTimeoutMs = options.scheduleTimeoutMs ?? ((timeoutMs, callback) => after(timeoutMs / 1000, callback));
  const media = createMediaController({
    bridge: host,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    scheduleTimeoutMs,
  });

  let disposed = false;
  let binding: Binding | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  let currentOperation: { readonly token: string; readonly promise: Promise<void> } | null = null;
  let pendingRestore: RestoreRequest | null = null;
  let stopRestoreCoverage: (() => void) | null = null;

  const releaseRestoreCoverageIfIdle = (): void => {
    if (pendingRestore || !stopRestoreCoverage) return;
    const stop = stopRestoreCoverage;
    stopRestoreCoverage = null;
    stop();
  };

  const ensureRestoreCoverage = (): void => {
    if (!stopRestoreCoverage) stopRestoreCoverage = media.beginCoverage("novel video position restore");
  };

  const currentSnapshot = (expected: Binding) => {
    if (disposed || binding !== expected) throw staleOperation("The video engine is no longer active");
    const snapshot = expected.engine.getSnapshot();
    if (snapshot.phase === "disposed") throw staleOperation("The video engine has been disposed");
    const video = snapshot.stage.video;
    if (!video || !snapshot.videoToken) throw new VideoMediaRequestError("video_closed", "There is no active VN video");
    return { snapshot, video, token: snapshot.videoToken };
  };

  const isCurrent = (expected: Binding, token: string, cue: string, predicate?: () => boolean): boolean => {
    if (disposed || binding !== expected) return false;
    try {
      if (predicate && !predicate()) return false;
      const snapshot = expected.engine.getSnapshot();
      return snapshot.phase !== "disposed" && snapshot.videoToken === token && snapshot.stage.video?.cue === cue;
    } catch {
      return false;
    }
  };

  const reportNativeSnapshot = (expected: Binding, token: string, cue: string, snapshot: VideoSnapshot): void => {
    if (snapshot.token !== token || !isCurrent(expected, token, cue)) return;
    if (snapshot.error || snapshot.state === "error") {
      expected.onError?.(new VideoMediaRequestError("native_video_error", snapshot.error ?? "Native video player failed"));
      return;
    }
    const current = expected.engine.getSnapshot().stage.video;
    if (!current) return;
    if (snapshot.state === "ended" && current.loop) return;
    if (snapshot.positionMs === null && snapshot.durationMs === null && snapshot.state !== "loading") return;
    expected.engine.reportVideo(nativeFact(snapshot, token, current.loop));
  };

  const settleRestore = (restore: RestoreRequest, error?: unknown): void => {
    if (pendingRestore !== restore) return;
    pendingRestore = null;
    restore.cancelTimeout?.();
    restore.cancelTimeout = undefined;
    if (error === undefined) restore.resolve();
    else restore.reject(error);
    releaseRestoreCoverageIfIdle();
  };

  const enqueue = (expected: Binding, token: string, task: () => Promise<void>): Promise<void> => {
    const run = operationQueue.catch(() => {}).then(async () => {
      if (disposed || binding !== expected) throw staleOperation("The video engine changed before the native operation ran");
      await task();
    });
    operationQueue = run.catch(() => {});
    const operation = { token, promise: run };
    currentOperation = operation;
    void run.then(
      () => { if (currentOperation === operation) currentOperation = null; },
      () => { if (currentOperation === operation) currentOperation = null; },
    );
    void run.catch(error => {
      const current = expected.engine.getSnapshot();
      if (binding === expected && !disposed && current.videoToken === token) expected.onError?.(error);
    });
    return run;
  };

  const executeSeek = (expected: Binding, token: string, cue: string, positionMs: number): Promise<void> => enqueue(expected, token, async () => {
    if (!isCurrent(expected, token, cue)) throw staleOperation("The VN video changed before seeking");
    const native = await media.inspect(surfaceId);
    if (!isCurrent(expected, token, cue) || native.token !== token) throw staleOperation("The VN video changed during seek inspection");
    if (native.error || native.state === "error") throw new VideoMediaRequestError("native_video_error", native.error ?? "Native video player failed");
    const issue = novelVideoSeekIssue(positionMs, native.durationMs);
    if (issue !== null) throw new VideoMediaRequestError("seek_range", issue);
    const result = await media.seek(surfaceId, positionMs);
    if (!isCurrent(expected, token, cue) || result.token !== token) throw staleOperation("The VN video changed while seeking");
    reportNativeSnapshot(expected, token, cue, result);
  });

  const startRestore = (restore: RestoreRequest): void => {
    if (restore.started || pendingRestore !== restore) return;
    restore.started = true;
    restore.cancelTimeout?.();
    restore.cancelTimeout = undefined;
    void enqueue(restore.binding, restore.token, async () => {
      if (!isCurrent(restore.binding, restore.token, restore.cue)) throw staleOperation("The VN video changed before restoration");
      const native = await media.inspect(surfaceId);
      if (!isCurrent(restore.binding, restore.token, restore.cue) || native.token !== restore.token) {
        throw staleOperation("The VN video changed during restoration");
      }
      if (native.error || native.state === "error") throw new VideoMediaRequestError("native_video_error", native.error ?? "Native video player failed");
      if (native.positionMs === null || native.durationMs === null || native.state === "loading" || native.state === "disposed") {
        throw new VideoMediaRequestError("video_not_ready", "The native video is not ready to restore its saved position");
      }
      const issue = novelVideoSeekIssue(restore.positionMs, native.durationMs);
      if (issue !== null) throw new VideoMediaRequestError("saved_position", issue);
      if (native.positionMs === restore.positionMs) {
        reportNativeSnapshot(restore.binding, restore.token, restore.cue, native);
        settleRestore(restore);
        return;
      }
      const result = await media.seek(surfaceId, restore.positionMs);
      if (!isCurrent(restore.binding, restore.token, restore.cue) || result.token !== restore.token) {
        throw staleOperation("The VN video changed while restoring its saved position");
      }
      reportNativeSnapshot(restore.binding, restore.token, restore.cue, result);
      settleRestore(restore);
    }).catch(error => {
      const stillCurrent = isCurrent(restore.binding, restore.token, restore.cue);
      if (stillCurrent) {
        restore.started = false;
        settleRestore(restore, error);
      } else {
        settleRestore(restore);
      }
    });
  };

  const requestRestore = (expected: Binding, token: string, cue: string, positionMs: number, canInspect: boolean): void => {
    if (!finiteNonNegative(positionMs) || !isCurrent(expected, token, cue)) return;
    if (pendingRestore && pendingRestore.token === token && pendingRestore.cue === cue && pendingRestore.positionMs === positionMs) {
      if (canInspect) startRestore(pendingRestore);
      return;
    }
    const previous = pendingRestore;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    void promise.catch(() => {});
    const restore: RestoreRequest = { binding: expected, token, cue, positionMs, promise, resolve, reject, started: false };
    pendingRestore = restore;
    if (previous) {
      previous.cancelTimeout?.();
      previous.cancelTimeout = undefined;
      previous.resolve();
    }
    ensureRestoreCoverage();
    restore.cancelTimeout = scheduleTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, () => {
      const error = new VideoMediaRequestError("restore_timeout", "Timed out waiting for an initialized native video");
      if (pendingRestore !== restore) return;
      if (restore.started) return; // The active inspect/seek owns its own guest-clock deadline.
      restore.binding.onError?.(error);
      settleRestore(restore, error);
    });
    if (canInspect) startRestore(restore);
  };

  const onEngineUpdate = (expected: Binding, update: EngineUpdate): void => {
    if (disposed || binding !== expected) return;
    const snapshot = update.snapshot;
    const video = snapshot.stage.video;
    const token = snapshot.videoToken;
    const cueEvent = update.events.find(event => event.type === "videoCue" && event.token === token);
    if (!video || !token) {
      if (expected.lastToken !== null) media.configure(surfaceId, { playing: false });
      if (pendingRestore) settleRestore(pendingRestore);
      expected.lastToken = token;
      expected.lastCue = null;
      return;
    }

    const tokenChanged = expected.lastToken !== token || expected.lastCue !== video.cue;
    const restoreNeeded = tokenChanged && !cueEvent;
    if (restoreNeeded) ensureRestoreCoverage();
    const accepted = media.configure(surfaceId, {
      token,
      loop: video.loop,
      playing: video.status === "playing",
    });
    if (restoreNeeded) requestRestore(expected, token, video.cue, video.positionMs, accepted);
    expected.lastToken = token;
    expected.lastCue = video.cue;

    if (cueEvent?.type === "videoCue" && cueEvent.action === "seek" && cueEvent.positionMs !== undefined) {
      const operation = executeSeek(expected, token, video.cue, cueEvent.positionMs);
      if (pendingRestore) settleRestore(pendingRestore);
      void operation.catch(() => {});
    }
  };

  const onNativeEvent = (event: HostEvent): void => {
    if (disposed || event.method !== "video.state") return;
    const expected = binding;
    if (!expected || event.params.id !== surfaceId || typeof event.params.token !== "string") return;
    const token = event.params.token;
    const current = expected.engine.getSnapshot();
    const overlay = current.stage.video;
    if (current.videoToken !== token || !overlay || !isCurrent(expected, token, overlay.cue)) return;
    if (event.params.state === "error" || typeof event.params.error === "string" && event.params.error.length > 0) {
      const error = new VideoMediaRequestError("native_video_error", String(event.params.error ?? "Native video player failed"));
      media.configure(surfaceId, { playing: false });
      if (pendingRestore && pendingRestore.token === token && pendingRestore.cue === overlay.cue) settleRestore(pendingRestore, error);
      expected.onError?.(error);
      return;
    }
    const state = event.params.state;
    if (state === "ready" || state === "playing" || state === "paused" || state === "ended") {
      const snapshot: VideoSnapshot = {
        id: surfaceId,
        token,
        asset: typeof event.params.asset === "string" ? event.params.asset : "",
        state,
        playing: event.params.playing === true,
        visible: event.params.visible === true,
        active: event.params.active === true,
        positionMs: finiteNonNegative(event.params.positionMs) ? event.params.positionMs : null,
        durationMs: finiteNonNegative(event.params.durationMs) ? event.params.durationMs : null,
        error: null,
      };
      reportNativeSnapshot(expected, token, overlay.cue, snapshot);
      if (pendingRestore && pendingRestore.token === token && pendingRestore.cue === overlay.cue && state === "ready") {
        startRestore(pendingRestore);
      }
    }
  };

  const removeNativeEvents = host.onEvent?.(onNativeEvent);

  const assertBound = (engine: NovelEngine, predicate?: () => boolean): Binding => {
    const expected = binding;
    if (!expected || expected.engine !== engine || disposed || predicate && !predicate()) {
      throw staleOperation("The requested video engine is no longer active");
    }
    return expected;
  };

  const waitForQuiescence = async (expected: Binding, token: string): Promise<void> => {
    // Engine listeners are synchronous; one microtask lets the adapter's
    // listener enqueue the command emitted by the same core transaction.
    await Promise.resolve();
    const operation = currentOperation;
    if (operation?.token === token) {
      try { await operation.promise; }
      catch (error) { throw error; }
    }
    const restore = pendingRestore;
    if (restore && restore.binding === expected && restore.token === token) await restore.promise;
    if (!isCurrent(expected, token, expected.engine.getSnapshot().stage.video?.cue ?? "")) {
      throw staleOperation("The VN video changed while waiting for native playback");
    }
  };

  return {
    media,
    surfaceId,
    bind(engine: NovelEngine, onError?: (error: unknown) => void): () => void {
      if (disposed) throw new VideoMediaRequestError("adapter_disposed", "Novel video adapter is disposed");
      if (binding?.engine === engine) {
        const expected = binding;
        if (onError) expected.onError = onError;
        return () => { if (binding === expected) expected.removeEngine?.(); };
      }
      if (binding) binding.removeEngine?.();
      const expected: Binding = {
        engine,
        ...(onError ? { onError } : options.onError ? { onError: options.onError } : {}),
        lastToken: null,
        lastCue: null,
      };
      binding = expected;
      const unsubscribe = engine.subscribe(update => onEngineUpdate(expected, update));
      expected.removeEngine = () => {
        unsubscribe();
        if (binding === expected) {
          media.configure(surfaceId, { playing: false });
          binding = null;
          if (pendingRestore?.binding === expected) settleRestore(pendingRestore);
        }
      };
      onEngineUpdate(expected, { snapshot: engine.getSnapshot(), events: [] });
      return expected.removeEngine;
    },
    async captureForSave(engine: NovelEngine, isCurrentPredicate: () => boolean): Promise<NovelSaveData> {
      const expected = assertBound(engine, isCurrentPredicate);
      const initial = engine.getSnapshot();
      if (initial.stage.video === null || initial.videoToken === null) return engine.save();
      const token = initial.videoToken;
      const cue = initial.stage.video.cue;
      await waitForQuiescence(expected, token);
      if (!isCurrent(expected, token, cue, isCurrentPredicate)) throw staleOperation("The VN video changed before save capture");
      const native = await media.inspect(surfaceId);
      if (native.token !== token || !isCurrent(expected, token, cue, isCurrentPredicate)) {
        throw staleOperation("The VN video changed during save capture");
      }
      if (native.error || native.state === "error") throw new VideoMediaRequestError("native_video_error", native.error ?? "Native video player failed");
      reportNativeSnapshot(expected, token, cue, native);
      if (!isCurrent(expected, token, cue, isCurrentPredicate)) throw staleOperation("The VN video changed while applying save facts");
      return engine.save();
    },
    async seekBy(engine: NovelEngine, deltaMs: number, isCurrentPredicate?: () => boolean): Promise<EngineUpdate> {
      if (!Number.isSafeInteger(deltaMs)) throw new RangeError("Video seek delta must be a safe integer number of milliseconds");
      const expected = assertBound(engine, isCurrentPredicate);
      const { video, token } = currentSnapshot(expected);
      await waitForQuiescence(expected, token);
      const native = await media.inspect(surfaceId);
      if (native.token !== token || !isCurrent(expected, token, video.cue, isCurrentPredicate)) throw staleOperation("The VN video changed during seek inspection");
      if (native.error || native.state === "error") throw new VideoMediaRequestError("native_video_error", native.error ?? "Native video player failed");
      if (native.positionMs === null || native.durationMs === null) throw new VideoMediaRequestError("video_not_ready", "Video position and duration must be known before seeking");
      const target = native.positionMs + deltaMs;
      const issue = novelVideoSeekIssue(target, native.durationMs);
      if (issue !== null) throw new VideoMediaRequestError("seek_range", issue);
      engine.reportVideo(nativeFact(native, token, video.loop));
      if (!isCurrent(expected, token, video.cue, isCurrentPredicate)) throw staleOperation("The VN video changed before issuing seek");
      const update = engine.controlVideo({ type: "video", action: "seek", positionMs: target });
      await waitForQuiescence(expected, update.snapshot.videoToken ?? token);
      return update;
    },
    async seekTo(engine: NovelEngine, positionMs: number, isCurrentPredicate?: () => boolean): Promise<EngineUpdate> {
      const expected = assertBound(engine, isCurrentPredicate);
      const { video, token } = currentSnapshot(expected);
      await waitForQuiescence(expected, token);
      const native = await media.inspect(surfaceId);
      if (native.token !== token || !isCurrent(expected, token, video.cue, isCurrentPredicate)) throw staleOperation("The VN video changed during seek inspection");
      if (native.error || native.state === "error") throw new VideoMediaRequestError("native_video_error", native.error ?? "Native video player failed");
      const issue = novelVideoSeekIssue(positionMs, native.durationMs);
      if (issue !== null) throw new VideoMediaRequestError("seek_range", issue);
      engine.reportVideo(nativeFact(native, token, video.loop));
      if (!isCurrent(expected, token, video.cue, isCurrentPredicate)) throw staleOperation("The VN video changed before issuing seek");
      const update = engine.controlVideo({ type: "video", action: "seek", positionMs });
      await waitForQuiescence(expected, update.snapshot.videoToken ?? token);
      return update;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      binding?.removeEngine?.();
      removeNativeEvents?.();
      media.dispose();
      if (pendingRestore) settleRestore(pendingRestore);
      binding = null;
    },
  };
}
