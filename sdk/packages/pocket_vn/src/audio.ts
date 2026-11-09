import type { NovelVoicePlaybackFact, NovelVoicePlaybackState } from "./voice.ts";
import { NOVEL_VOICE_CHANNEL, voiceBlocksAutoAdvance } from "./voice.ts";
import type { EngineUpdate, NovelAudioIntent, NovelAuthoredAudioGroup } from "./types.ts";
import {
  parseNovelTextSounds,
  resolveNovelTextSoundCue,
  type NovelTextSoundsConfig,
} from "./text-sounds.ts";
export {
  parseNovelTextSounds,
  resolveNovelTextSoundCue,
  validateNovelTextSounds,
} from "./text-sounds.ts";
export type { NovelTextSoundsConfig, NovelTextSoundsIssue } from "./text-sounds.ts";

export interface NovelAudioHost {
  request(capability: string, params: Record<string, string | number | boolean>): Promise<unknown>;
  onEvent?(listener: (event: { method: string; params: Readonly<Record<string, unknown>> }) => void): () => void;
}
export interface NovelAudioOptions {
  onStatus?(status: "ready" | "unavailable" | "error", detail?: string): void;
  /** Receives a native playback fact asynchronously, outside engine subscribe. */
  onVoicePlayback?(fact: NovelVoicePlaybackFact): void;
  /** Initial group gains, typically restored from the consumer's JS storage. */
  initialMix?: Partial<NovelAudioMix>;
  /** Optional synthesized samples tied to real JS dialogue reveal progress. */
  textSounds?: NovelTextSoundsConfig;
  /** Defaults off; consumers can restore this preference from JS storage. */
  initialTextSoundsEnabled?: boolean;
}

export type NovelAudioSource = "main" | "replay";

/** Normalized JS-owned gains. The master gain multiplies the selected group. */
export interface NovelAudioMix {
  readonly master: number;
  readonly music: number;
  readonly effects: number;
  readonly voice: number;
}

/** Preserves the adapter's previous single 0.7 playback level. */
export const DEFAULT_NOVEL_AUDIO_MIX: NovelAudioMix = Object.freeze({
  master: 0.7,
  music: 1,
  effects: 1,
  voice: 1,
});

const mixKeys = ["master", "music", "effects", "voice"] as const;
type MixKey = typeof mixKeys[number];
export type NovelAudioGroup = NovelAuthoredAudioGroup | "voice";

function validatedMix(
  base: NovelAudioMix,
  partial: Partial<NovelAudioMix>,
): NovelAudioMix {
  if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
    throw new RangeError("Audio mix must be an object");
  }
  for (const key of Object.keys(partial)) {
    if (!(mixKeys as readonly string[]).includes(key)) throw new RangeError(`Unknown audio mix group '${key}'`);
  }
  const next = { ...base };
  for (const key of mixKeys) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
    const level = partial[key];
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
      throw new RangeError(`Audio mix '${key}' must be between zero and one`);
    }
    next[key] = level;
  }
  return next;
}

interface RetainedIntent extends NovelAudioIntent {
  readonly asset?: string;
}

const terminalVoiceStatus = (status: NovelVoicePlaybackState["status"]): boolean =>
  status === "completed" || status === "error" || status === "unavailable";

/** Cue policy stays in JS; registered native providers only decode/play assets. */
export function createNovelAudioAdapter(
  host: NovelAudioHost,
  initialAssets: Readonly<Record<string, string>>,
  options: NovelAudioOptions = {},
) {
  const intents = new Map<string, RetainedIntent>();
  const replayIntents = new Map<string, RetainedIntent>();
  const replayChannels = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();
  let overlayTask: Promise<void> = Promise.resolve();
  const liveChannels = new Set<string>();
  const channelPlayGeneration = new Map<string, number>();
  let assets: Readonly<Record<string, string>> = { ...initialAssets };
  let mix = validatedMix(DEFAULT_NOVEL_AUDIO_MIX, options.initialMix ?? {});
  const textSounds = parseNovelTextSounds(options.textSounds, new Set(Object.keys(initialAssets)));
  let textSoundsEnabled = options.initialTextSoundsEnabled ?? false;
  if (typeof textSoundsEnabled !== "boolean") throw new RangeError("initialTextSoundsEnabled must be a boolean");
  // Tracks the last requested gain per live channel so repeated settings and
  // frame updates do not duplicate media.audio.volume calls.
  const channelVolumes = new Map<string, number>();
  const channelGains = new Map<string, number>();
  // At most one volume command per channel may be queued or in flight. Updates
  // while it is pending replace its target instead of extending the command
  // chain with one stale request per game tick.
  const pendingChannelVolumes = new Map<string, { latest: number; scheduled: boolean }>();
  let suspended = false;
  let enginePaused = false;
  let disposed = false;
  let oneShot = 0;
  let currentVoice: NovelVoicePlaybackState | null = null;
  let currentVoiceToken: string | null = null;
  let currentVoicePlaybackId: string | null = null;
  let voicePlaybackSequence = 0;
  let terminalVoiceToken: string | null = null;
  let voiceResumeRequestedToken: string | null = null;
  let previousTextReveal: { id: string; progress: number; revealedCharacters: number } | null = null;
  let textSoundElapsedMs = 0;
  let textSoundPending = false;
  let textSoundDispatchGeneration = 0;
  let activeSource: NovelAudioSource = "main";
  let replayMusicIntent: { cue: string; loop: boolean; gain: number } | null = null;
  let musicPreviewCue: string | null = null;
  let overlayMusicCue: string | null = null;
  let overlayMusicAsset: string | null = null;
  let overlayMusicLoop = false;
  let overlayMusicGain = 1;
  let overlayMusicOwner = false;
  let overlayMusicGeneration = 0;
  let mainMusicHeldForOverlay = false;
  let mainMusicPauseRequest: Promise<void> | null = null;

  const stopVoiceChannel = (): void => {
    if (liveChannels.delete(NOVEL_VOICE_CHANNEL)) {
      void command(NOVEL_VOICE_CHANNEL, "media.audio.stop");
    }
    channelVolumes.delete(NOVEL_VOICE_CHANNEL);
    channelGains.delete(NOVEL_VOICE_CHANNEL);
    pendingChannelVolumes.delete(NOVEL_VOICE_CHANNEL);
  };

  const deliverVoice = (
    fact: NovelVoicePlaybackFact,
    releaseNative = true,
    expectedPlaybackId: string | null = currentVoicePlaybackId,
  ): void => {
    // Engine listeners can synchronously call reportVoice, which publishes a
    // nested snapshot. Deferring this callback keeps it outside apply/subscribe.
    void Promise.resolve().then(() => {
      if (disposed || fact.token !== currentVoiceToken || expectedPlaybackId !== currentVoicePlaybackId ||
          terminalVoiceToken === fact.token) return;
      if (fact.status === "completed" || fact.status === "error" || fact.status === "unavailable") {
        terminalVoiceToken = fact.token;
      }
      try { options.onVoicePlayback?.(fact); }
      catch (error) {
        options.onStatus?.("error", error instanceof Error ? error.message : String(error));
      }
      if (releaseNative && terminalVoiceToken === fact.token) stopVoiceChannel();
    });
  };

  const command = (
    channel: string,
    capability: string,
    params: Record<string, string | number | boolean> = {},
    onFailure?: (status: "unavailable" | "error", detail: string) => void,
    shouldDispatch?: () => boolean,
    onSkipped?: () => void,
  ): Promise<void> => {
    const previous = queues.get(channel) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (disposed && capability !== "media.audio.stop") return;
      if (shouldDispatch && !shouldDispatch()) {
        onSkipped?.();
        return;
      }
      try {
        await host.request(capability, { channel, ...params });
        options.onStatus?.("ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /unavailable|unconfigured|unsupported|asset_denied/i.test(message)
          ? "unavailable" as const
          : "error" as const;
        options.onStatus?.(status, message);
        onFailure?.(status, message);
      }
    });
    queues.set(channel, next);
    void next.finally(() => { if (queues.get(channel) === next) queues.delete(channel); });
    return next;
  };

  const reportUnknownVoiceCue = (voice: NovelVoicePlaybackState, releaseNative: boolean): void => {
    deliverVoice(
      { token: voice.token, status: "error", error: `Unknown audio cue: ${voice.cue}` },
      releaseNative,
      currentVoicePlaybackId,
    );
    options.onStatus?.("error", `Unknown audio cue: ${voice.cue}`);
  };

  const groupForIntent = (logicalChannel: string, intent: NovelAudioIntent): NovelAuthoredAudioGroup =>
    intent.group ?? (logicalChannel === "music" ? "music" : "effects");

  const groupForChannel = (channel: string): NovelAudioGroup => {
    if (channel === NOVEL_VOICE_CHANNEL) return "voice";
    if (channel === "music" || channel === "music-preview") return "music";
    const mainIntent = intents.get(channel);
    if (mainIntent) return groupForIntent(channel, mainIntent);
    // The existing replay mapping is the source of truth for transport names.
    // Scan it instead of maintaining a second native-channel/category index.
    for (const [logicalChannel, replayNativeChannel] of replayChannels) {
      if (replayNativeChannel !== channel) continue;
      const replayIntent = replayIntents.get(logicalChannel);
      if (replayIntent) return groupForIntent(logicalChannel, replayIntent);
    }
    return "effects";
  };

  const volumeForChannel = (channel: string, intentGain = channelGains.get(channel) ?? 1): number => {
    const group = groupForChannel(channel);
    return mix.master * mix[group] * intentGain;
  };

  const gainOfIntent = (intent: NovelAudioIntent): number => intent.gain ?? 1;

  const setChannelGain = (channel: string, gain: number): boolean => {
    const previous = channelGains.get(channel) ?? 1;
    if (gain === 1) channelGains.delete(channel);
    else channelGains.set(channel, gain);
    return previous !== gain;
  };

  const replayChannel = (channel: string): string => {
    const existing = replayChannels.get(channel);
    if (existing) return existing;
    let hash = 2166136261;
    for (let index = 0; index < channel.length; index++) {
      hash = Math.imul(hash ^ channel.charCodeAt(index), 16777619);
    }
    const readable = channel.length <= 57 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel);
    const base = readable ? `replay-${channel}` : `replay-${(hash >>> 0).toString(16).padStart(8, "0")}`;
    let nativeChannel = base;
    let collision = 0;
    const belongsToMain = (candidate: string): boolean => intents.has(candidate) || liveChannels.has(candidate) ||
      candidate === "music" || candidate === "music-preview" || candidate === NOVEL_VOICE_CHANNEL ||
      /^effect-[0-3]$/.test(candidate);
    while ([...replayChannels.values()].includes(nativeChannel) || belongsToMain(nativeChannel)) {
      const suffix = `-${++collision}`;
      nativeChannel = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    replayChannels.set(channel, nativeChannel);
    return nativeChannel;
  };

  const releaseReplayChannel = (channel: string): void => {
    replayChannels.delete(channel);
  };

  const dispatchLatestChannelVolume = (channel: string): void => {
    const pending = pendingChannelVolumes.get(channel);
    if (!pending || pending.scheduled) return;
    if (!liveChannels.has(channel)) {
      pendingChannelVolumes.delete(channel);
      return;
    }
    const volume = pending.latest;
    pending.scheduled = true;
    void command(
      channel,
      "media.audio.volume",
      { volume },
      (_status, _detail) => {
        if (pendingChannelVolumes.get(channel) === pending &&
            pending.latest === volume && channelVolumes.get(channel) === volume) {
          channelVolumes.delete(channel);
        }
      },
      () => pendingChannelVolumes.get(channel) === pending && pending.latest === volume &&
        liveChannels.has(channel) && channelVolumes.get(channel) === volume,
    ).finally(() => {
      if (pendingChannelVolumes.get(channel) !== pending) return;
      pending.scheduled = false;
      if (!liveChannels.has(channel) || channelVolumes.get(channel) === undefined) {
        pendingChannelVolumes.delete(channel);
        return;
      }
      const latest = channelVolumes.get(channel)!;
      if (latest !== volume || pending.latest !== volume) {
        pending.latest = latest;
        dispatchLatestChannelVolume(channel);
      } else {
        pendingChannelVolumes.delete(channel);
      }
    });
  };

  const clearChannel = (channel: string): void => {
    liveChannels.delete(channel);
    channelVolumes.delete(channel);
    channelGains.delete(channel);
    pendingChannelVolumes.delete(channel);
  };

  const applyChannelVolume = (channel: string): void => {
    const volume = volumeForChannel(channel);
    if (channelVolumes.get(channel) === volume) return;
    channelVolumes.set(channel, volume);
    const pending = pendingChannelVolumes.get(channel);
    if (pending) pending.latest = volume;
    else pendingChannelVolumes.set(channel, { latest: volume, scheduled: false });
    dispatchLatestChannelVolume(channel);
  };

  const play = (
    channel: string,
    cue: string,
    loop: boolean,
    playOptions: { restart?: boolean; gain?: number; shouldDispatch?: () => boolean; onSkipped?: () => void } = {},
  ): Promise<void> => {
    const asset = assets[cue];
    if (!asset) {
      options.onStatus?.("error", `Unknown audio cue: ${cue}`);
      return Promise.resolve();
    }
    const volume = volumeForChannel(channel, playOptions.gain ?? channelGains.get(channel) ?? 1);
    const wasLive = liveChannels.has(channel);
    const previousVolume = channelVolumes.get(channel);
    const playGeneration = (channelPlayGeneration.get(channel) ?? 0) + 1;
    channelPlayGeneration.set(channel, playGeneration);
    liveChannels.add(channel);
    channelVolumes.set(channel, volume);
    const pendingVolume = pendingChannelVolumes.get(channel);
    if (pendingVolume) pendingVolume.latest = volume;
    const rollbackSkippedPlay = (): void => {
      if (channelPlayGeneration.get(channel) !== playGeneration) return;
      if (!wasLive) {
        liveChannels.delete(channel);
        channelVolumes.delete(channel);
      } else if (channelVolumes.get(channel) === volume) {
        if (previousVolume === undefined) channelVolumes.delete(channel);
        else channelVolumes.set(channel, previousVolume);
      }
    };
    return command(
      channel,
      "media.audio.play",
      { asset, loop, volume, paused: suspended, ...(playOptions.restart ? { restart: true } : {}) },
      undefined,
      playOptions.shouldDispatch,
      playOptions.shouldDispatch ? () => { rollbackSkippedPlay(); playOptions.onSkipped?.(); } : playOptions.onSkipped,
    );
  };

  const reconcileIntents = (
    next: Readonly<Record<string, NovelAudioIntent>>,
    events: EngineUpdate["events"],
    retained: Map<string, RetainedIntent>,
    nativeChannelFor: (channel: string) => string,
    excludedChannels: ReadonlySet<string> = new Set(),
    releaseNativeChannel?: (channel: string) => void,
  ): void => {
    const explicitStops = new Set<string>();
    for (const event of events) {
      if (event.type !== "audioCue" || event.action !== "stop" || event.channel === null ||
          excludedChannels.has(event.channel)) continue;
      explicitStops.add(event.channel);
      const nativeChannel = nativeChannelFor(event.channel);
      command(nativeChannel, "media.audio.stop");
      retained.delete(event.channel);
      clearChannel(nativeChannel);
      releaseNativeChannel?.(event.channel);
    }
    for (const channel of retained.keys()) {
      if (excludedChannels.has(channel) || channel in next) continue;
      const previous = retained.get(channel)!;
      if (previous.action === "play" || releaseNativeChannel === undefined) {
        const nativeChannel = nativeChannelFor(channel);
        if (!explicitStops.has(channel)) command(nativeChannel, "media.audio.stop");
        clearChannel(nativeChannel);
      }
      retained.delete(channel);
      releaseNativeChannel?.(channel);
    }
    for (const [channel, intent] of Object.entries(next)) {
      if (excludedChannels.has(channel)) continue;
      const asset = intent.action === "play" ? assets[intent.cue] : undefined;
      const previous = retained.get(channel);
      const samePlayback = previous?.action === intent.action && previous.cue === intent.cue &&
        previous.loop === intent.loop && previous.asset === asset && !explicitStops.has(channel);
      const nextRetained = { ...intent, ...(asset === undefined ? {} : { asset }) };
      if (samePlayback) {
        const groupChanged = intent.action === "play" &&
          groupForIntent(channel, previous!) !== groupForIntent(channel, intent);
        const gainChanged = intent.action === "play" && gainOfIntent(previous!) !== gainOfIntent(intent);
        retained.set(channel, nextRetained);
        if (intent.action === "play" && (gainChanged || groupChanged)) {
          const nativeChannel = nativeChannelFor(channel);
          setChannelGain(nativeChannel, gainOfIntent(intent));
          applyChannelVolume(nativeChannel);
        }
        continue;
      }
      const nativeChannel = nativeChannelFor(channel);
      retained.set(channel, nextRetained);
      if (intent.action === "stop") {
        if (!explicitStops.has(channel)) command(nativeChannel, "media.audio.stop");
        clearChannel(nativeChannel);
        releaseNativeChannel?.(channel);
      } else {
        setChannelGain(nativeChannel, gainOfIntent(intent));
        play(nativeChannel, intent.cue, intent.loop, { restart: !intent.loop, gain: gainOfIntent(intent) });
      }
    }
  };

  const overlayOwnsMusic = (): boolean => activeSource === "replay" || musicPreviewCue !== null;

  const desiredOverlayMusic = (): { cue: string; loop: boolean; gain: number } | null => {
    if (musicPreviewCue !== null) return { cue: musicPreviewCue, loop: true, gain: 1 };
    if (activeSource === "replay") return replayMusicIntent;
    return null;
  };

  const holdMainMusic = (): Promise<void> => {
    if (!mainMusicHeldForOverlay && liveChannels.has("music")) {
      mainMusicHeldForOverlay = true;
      mainMusicPauseRequest = suspended
        ? Promise.resolve()
        : command("music", "media.audio.pause");
    }
    return mainMusicPauseRequest ?? Promise.resolve();
  };

  const releaseMainMusic = (): void => {
    if (!mainMusicHeldForOverlay) return;
    mainMusicHeldForOverlay = false;
    mainMusicPauseRequest = null;
    if (!suspended && liveChannels.has("music")) void command("music", "media.audio.resume");
  };

  /** Route replay music and explicit previews through one overlay player. */
  const syncOverlayMusic = (forcePlayback = false): void => {
    const ownsMusic = overlayOwnsMusic();
    const desired = desiredOverlayMusic();
    const asset = desired ? assets[desired.cue] ?? null : null;
    const ownershipChanged = overlayMusicOwner !== ownsMusic;
    const playbackChanged = overlayMusicCue !== (desired?.cue ?? null) ||
      overlayMusicAsset !== asset || overlayMusicLoop !== (desired?.loop ?? false);
    const gainChanged = overlayMusicGain !== (desired?.gain ?? 1);
    if (!ownershipChanged && !playbackChanged && !gainChanged && !forcePlayback) return;

    if (!ownershipChanged && !playbackChanged && !forcePlayback) {
      overlayMusicGain = desired?.gain ?? 1;
      if (gainChanged && liveChannels.has("music-preview")) {
        setChannelGain("music-preview", overlayMusicGain);
        applyChannelVolume("music-preview");
      }
      return;
    }

    overlayMusicOwner = ownsMusic;
    const generation = ++overlayMusicGeneration;
    if (ownsMusic) void holdMainMusic();

    if (!desired || !asset) {
      if (desired && !asset) options.onStatus?.("error", `Unknown audio cue: ${desired.cue}`);
      const shouldStop = overlayMusicCue !== null || liveChannels.has("music-preview");
      overlayMusicCue = null;
      overlayMusicAsset = null;
      overlayMusicLoop = false;
      overlayMusicGain = 1;
      if (shouldStop) {
        clearChannel("music-preview");
        overlayTask = overlayTask.catch(() => {}).then(async () => {
          await command("music-preview", "media.audio.stop");
          if (generation === overlayMusicGeneration && !overlayOwnsMusic()) releaseMainMusic();
        });
      } else if (!ownsMusic) releaseMainMusic();
      return;
    }

    overlayMusicCue = desired.cue;
    overlayMusicAsset = asset;
    overlayMusicLoop = desired.loop;
    overlayMusicGain = desired.gain;
    setChannelGain("music-preview", desired.gain);
    const dispatchCurrent = (): boolean => {
      const latest = desiredOverlayMusic();
      return !disposed && generation === overlayMusicGeneration && latest?.cue === desired.cue &&
        latest.loop === desired.loop && latest.gain === desired.gain && assets[desired.cue] === asset;
    };
    overlayTask = overlayTask.catch(() => {}).then(async () => {
      await holdMainMusic();
      if (!dispatchCurrent()) return;
      await play("music-preview", desired.cue, desired.loop, {
        // A preview is an explicit new listen request. Reusing a completed
        // native sample starts at the beginning without replacing players.
        restart: true,
        gain: desired.gain,
        shouldDispatch: dispatchCurrent,
        onSkipped: () => {
          if (generation === overlayMusicGeneration) {
            overlayMusicCue = null;
            overlayMusicAsset = null;
            overlayMusicLoop = false;
            overlayMusicGain = 1;
          }
        },
      });
    });
  };

  const updateTextSoundProgress = (update: EngineUpdate): void => {
    const dispatchGeneration = ++textSoundDispatchGeneration;
    const active = update.snapshot.active;
    if (active?.kind !== "say") {
      previousTextReveal = null;
      textSoundElapsedMs = 0;
      return;
    }

    const previous = previousTextReveal;
    previousTextReveal = {
      id: active.id,
      progress: active.revealProgress,
      revealedCharacters: active.revealedCharacters,
    };
    if (!previous || previous.id !== active.id || active.revealProgress < previous.progress) {
      textSoundElapsedMs = 0;
      return;
    }

    const deltaProgress = active.revealProgress - previous.progress;
    const deltaCharacters = active.revealedCharacters - previous.revealedCharacters;

    const preferences = update.snapshot.preferences;
    const interval = textSounds?.minIntervalMs ?? 100;
    const speed = preferences?.textSpeedCharsPerSecond ?? 0;
    const eligible = textSoundsEnabled && textSounds !== undefined && !update.snapshot.paused && !suspended &&
      preferences?.mode !== "skip" && speed > 0;
    if (!eligible) {
      textSoundElapsedMs = 0;
      return;
    }
    if (deltaProgress <= 0) return;

    // The engine's virtual clock normally reveals less than one code point per
    // frame at the configured speed. A larger jump is a reveal-all, skip or
    // delayed-frame transaction, so discard it rather than making stale audio.
    const maxProgressPerUpdate = 1.5;
    if (deltaProgress > maxProgressPerUpdate) {
      textSoundElapsedMs = 0;
      return;
    }

    textSoundElapsedMs += deltaProgress * 1000 / speed;
    if (deltaCharacters <= 0) return;
    const points = Array.from(active.text);
    const hasNonWhitespace = points
      .slice(previous.revealedCharacters, active.revealedCharacters)
      .some(point => !/^\s+$/u.test(point));
    if (!hasNonWhitespace) return;
    if (textSoundElapsedMs < interval) return;
    // One in-flight request is enough; a slow host drops later progress cues
    // instead of queueing stale sounds that no longer match the displayed text.
    textSoundElapsedMs = 0;
    if (textSoundPending) return;
    const cue = resolveNovelTextSoundCue(textSounds, active.speaker);
    if (!cue) return;
    textSoundPending = true;
    void play(
      `effect-${oneShot++ % 4}`,
      cue,
      false,
      {
        restart: true,
        gain: 1,
        shouldDispatch: () => textSoundsEnabled && !suspended && !enginePaused &&
          textSoundDispatchGeneration === dispatchGeneration,
      },
    ).finally(() => { textSoundPending = false; });
  };

  const voiceNeedsResume = (): boolean => currentVoice !== null &&
    currentVoice.token === currentVoiceToken &&
    terminalVoiceToken !== currentVoice.token &&
    !suspended && !enginePaused &&
    voiceBlocksAutoAdvance(currentVoice);

  const requestVoiceResume = (): void => {
    if (!voiceNeedsResume() || voiceResumeRequestedToken === currentVoice!.token) return;
    const token = currentVoice!.token;
    const playbackId = currentVoicePlaybackId;
    voiceResumeRequestedToken = token;
    command(NOVEL_VOICE_CHANNEL, "media.audio.resume", {}, (status, detail) => {
      deliverVoice({ token, status, error: detail }, true, playbackId);
    });
  };

  const syncVoicePausePolicy = (wasPaused: boolean): void => {
    const isPaused = suspended || enginePaused;
    if (wasPaused === isPaused) return;
    if (isPaused) {
      voiceResumeRequestedToken = null;
      if (liveChannels.has(NOVEL_VOICE_CHANNEL)) command(NOVEL_VOICE_CHANNEL, "media.audio.pause");
    } else {
      requestVoiceResume();
    }
  };

  const resumePersistent = (): void => {
    if (disposed || suspended) return;
    // Completed transient cues never replay after a device returns. Music and
    // an unfinished, token-correlated dialogue line can resume explicitly.
    for (const [channel, intent] of intents) {
      if (intent.action === "play" && intent.loop && !(channel === "music" && mainMusicHeldForOverlay)) {
        command(channel, "media.audio.resume");
      }
    }
    if (activeSource === "replay") {
      for (const [channel, intent] of replayIntents) {
        if (intent.action === "play" && intent.loop) {
          command(replayChannel(channel), "media.audio.resume");
        }
      }
    }
    if (overlayMusicLoop && liveChannels.has("music-preview")) command("music-preview", "media.audio.resume");
    requestVoiceResume();
  };

  const reportPlaybackEvent = (params: Readonly<Record<string, unknown>>): void => {
    if (params.channel !== NOVEL_VOICE_CHANNEL ||
        typeof params.playbackId !== "string" ||
        params.playbackId !== currentVoicePlaybackId ||
        currentVoiceToken === null ||
        terminalVoiceToken === currentVoiceToken ||
        typeof params.status !== "string" ||
        !["playing", "paused", "completed", "error", "unavailable"].includes(params.status)) return;
    const positionMs = params.positionMs;
    const durationMs = params.durationMs;
    if (positionMs !== undefined && (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0)) return;
    if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) return;
    if (params.status === "playing") voiceResumeRequestedToken = currentVoiceToken;
    else if (params.status === "paused" && (suspended || enginePaused)) voiceResumeRequestedToken = null;
    deliverVoice({
      token: currentVoiceToken,
      status: params.status as NovelVoicePlaybackFact["status"],
      ...(positionMs === undefined ? {} : { positionMs }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof params.error === "string" ? { error: params.error } : {}),
    }, true, params.playbackId);
  };

  const removeEventListener = host.onEvent?.(event => {
    if (event.method === "media.audio.activation" && event.params.active === false) {
      voiceResumeRequestedToken = null;
    } else if (event.method === "media.audio.activation" && event.params.active === true) resumePersistent();
    else if (event.method === "media.audio.playback") reportPlaybackEvent(event.params);
  });

  const setMix = (partial: Partial<NovelAudioMix>): NovelAudioMix => {
    if (disposed) return { ...mix };
    mix = validatedMix(mix, partial);
    for (const channel of liveChannels) applyChannelVolume(channel);
    return { ...mix };
  };

  return {
    apply(update: EngineUpdate, source: NovelAudioSource = "main"): void {
      if (disposed) return;
      const voiceWasPolicyPaused = suspended || enginePaused;
      const previousVoiceToken = currentVoiceToken;
      const sourceChanged = activeSource !== source;
      if (sourceChanged) {
        for (let index = 0; index < 4; index++) {
          const channel = `effect-${index}`;
          if (!liveChannels.has(channel)) continue;
          command(channel, "media.audio.stop");
          clearChannel(channel);
        }
        activeSource = source;
        if (source === "main") {
          replayMusicIntent = null;
          for (const [channel, intent] of replayIntents) {
            if (intent.action !== "play") continue;
            const nativeChannel = replayChannel(channel);
            command(nativeChannel, "media.audio.stop");
            clearChannel(nativeChannel);
            releaseReplayChannel(channel);
          }
          replayIntents.clear();
          replayChannels.clear();
        }
        else musicPreviewCue = null;
      }
      enginePaused = update.snapshot.paused;
      if (sourceChanged) syncOverlayMusic();

      if (source === "main") {
        reconcileIntents(update.snapshot.audioIntents, update.events, intents, channel => channel);
      } else {
        reconcileIntents(
          update.snapshot.audioIntents,
          update.events,
          replayIntents,
          replayChannel,
          new Set(["music"]),
          releaseReplayChannel,
        );
        const music = update.snapshot.audioIntents.music;
        replayMusicIntent = music?.action === "play" && assets[music.cue]
          ? { cue: music.cue, loop: music.loop, gain: gainOfIntent(music) }
          : null;
        const restartReplayMusic = update.events.some(event =>
          event.type === "audioCue" && event.action === "stop" && event.channel === "music");
        if (restartReplayMusic && replayMusicIntent) {
          clearChannel("music-preview");
          command("music-preview", "media.audio.stop");
        }
        syncOverlayMusic(restartReplayMusic && replayMusicIntent !== null);
      }

      for (const event of update.events) {
        if (event.type === "audioCue" && event.action === "play" && event.channel === null) {
          // A bounded effects pool: completed one-shots are replaced, never
          // retained as unbounded native player identities.
          play(`effect-${oneShot++ % 4}`, event.cue, event.loop, { restart: true, gain: 1 });
        }
      }

      const voice = update.snapshot.voice ?? null;
      currentVoice = voice;
      if (voice === null) {
        if (currentVoiceToken !== null) {
          currentVoiceToken = null;
          currentVoicePlaybackId = null;
          terminalVoiceToken = null;
          stopVoiceChannel();
        }
      } else if (voice.token !== currentVoiceToken) {
        const replacingVoice = currentVoiceToken !== null;
        currentVoiceToken = voice.token;
        currentVoicePlaybackId = `novel-voice-${voicePlaybackSequence++}`;
        const playbackId = currentVoicePlaybackId;
        voiceResumeRequestedToken = null;
        terminalVoiceToken = terminalVoiceStatus(voice.status) ? voice.token : null;
        const asset = assets[voice.cue];
        if (!asset) {
          reportUnknownVoiceCue(voice, replacingVoice);
        } else {
          liveChannels.add(NOVEL_VOICE_CHANNEL);
          const volume = volumeForChannel(NOVEL_VOICE_CHANNEL);
          channelVolumes.set(NOVEL_VOICE_CHANNEL, volume);
          voiceResumeRequestedToken = suspended || enginePaused ? null : voice.token;
          void command(
            NOVEL_VOICE_CHANNEL,
            "media.audio.play",
            { asset, loop: false, volume, paused: suspended || enginePaused, playbackId, restart: true },
            (status, detail) => deliverVoice({ token: voice.token, status, error: detail }, true, playbackId),
            () => currentVoicePlaybackId === playbackId,
          );
        }
      } else if (terminalVoiceStatus(voice.status)) {
        terminalVoiceToken = voice.token;
        stopVoiceChannel();
      }
      if (previousVoiceToken === currentVoiceToken) syncVoicePausePolicy(voiceWasPolicyPaused);
      updateTextSoundProgress(update);
    },
    setAssets(nextAssets: Readonly<Record<string, string>>): void {
      if (disposed) return;
      assets = { ...nextAssets };
      syncOverlayMusic();
    },
    previewMusic(cue: string): void {
      if (disposed) return;
      if (typeof cue !== "string" || cue.length === 0) throw new RangeError("Music preview cue must be a non-empty string");
      if (!assets[cue]) {
        options.onStatus?.("error", `Unknown audio cue: ${cue}`);
        return;
      }
      musicPreviewCue = cue;
      syncOverlayMusic();
    },
    stopMusicPreview(): void {
      if (disposed || musicPreviewCue === null) return;
      musicPreviewCue = null;
      syncOverlayMusic();
    },
    getMusicPreviewCue(): string | null { return musicPreviewCue; },
    getMix(): NovelAudioMix { return { ...mix }; },
    setMix,
    getTextSoundsEnabled(): boolean { return textSoundsEnabled; },
    setTextSoundsEnabled(value: boolean): void {
      if (typeof value !== "boolean") throw new RangeError("textSoundsEnabled must be a boolean");
      if (textSoundsEnabled === value || disposed) return;
      textSoundsEnabled = value;
      textSoundDispatchGeneration++;
      previousTextReveal = null;
      textSoundElapsedMs = 0;
    },
    /** Backward-compatible master gain control; group gains are unchanged. */
    setVolume(nextVolume: number): void {
      setMix({ master: nextVolume });
    },
    setSuspended(value: boolean): void {
      if (suspended === value || disposed) return;
      textSoundDispatchGeneration++;
      const voiceWasPolicyPaused = suspended || enginePaused;
      suspended = value;
      if (value) {
        for (const channel of liveChannels) {
          if (channel !== NOVEL_VOICE_CHANNEL) command(channel, "media.audio.pause");
        }
      } else {
        resumePersistent();
      }
      syncVoicePausePolicy(voiceWasPolicyPaused);
    },
    async settled(): Promise<void> {
      while (true) {
        const tasks: Promise<unknown>[] = [...queues.values(), overlayTask];
        await Promise.all(tasks);
        if (queues.size === 0 && tasks.at(-1) === overlayTask) return;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeEventListener?.();
      for (const channel of liveChannels) command(channel, "media.audio.stop");
      liveChannels.clear();
      channelVolumes.clear();
      channelGains.clear();
      pendingChannelVolumes.clear();
      intents.clear();
      replayIntents.clear();
      replayChannels.clear();
      replayMusicIntent = null;
      musicPreviewCue = null;
      overlayMusicCue = null;
      overlayMusicAsset = null;
      overlayMusicLoop = false;
      overlayMusicGain = 1;
      overlayMusicOwner = false;
      overlayMusicGeneration++;
      mainMusicHeldForOverlay = false;
      mainMusicPauseRequest = null;
      currentVoice = null;
      currentVoiceToken = null;
      currentVoicePlaybackId = null;
      terminalVoiceToken = null;
      voiceResumeRequestedToken = null;
      previousTextReveal = null;
      textSoundElapsedMs = 0;
      textSoundPending = false;
      textSoundDispatchGeneration++;
      channelPlayGeneration.clear();
    },
  };
}
