/** Playback command encoded in a visual novel story. */
export type NovelVideoInstruction =
  | {
      readonly type: "video";
      readonly action: "play";
      /** Stable story cue. A consumer resolves this to a bundled media asset. */
      readonly cue: string;
      /** Defaults to false; true is suitable for a looping scene background. */
      readonly loop?: boolean;
    }
  | { readonly type: "video"; readonly action: "pause" }
  | { readonly type: "video"; readonly action: "close" }
  | { readonly type: "video"; readonly action: "seek"; readonly positionMs: number };

/**
 * The one VN-owned video overlay. `status` stores author/player intent for
 * playing/paused; `ended` is reserved for an actual native non-loop completion
 * fact. Temporary native pause/visibility states do not replace this intent.
 */
export interface NovelVideoOverlayState {
  readonly cue: string;
  readonly loop: boolean;
  readonly positionMs: number;
  /** Null until an initialized native player reports its duration. */
  readonly durationMs: number | null;
  readonly status: "playing" | "paused" | "ended";
}

/** Facts from the registered native video player, scoped to one engine generation. */
export interface NovelVideoPlaybackFact {
  readonly token: string;
  readonly status: "playing" | "paused" | "ended";
  /** Null until the native player has initialized; never inferred from engine time. */
  readonly positionMs: number | null;
  /** Null until the native player has initialized; never inferred from engine time. */
  readonly durationMs: number | null;
}

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: PlainRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Check the video instruction's own fields. Story-level label validation is
 * unnecessary because these commands do not branch or name a label. Unknown
 * author metadata stays lossless; known fields from another action are errors.
 */
export function novelVideoInstructionIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "video") return "type must be 'video'";
  if (hasOwn(value, "muted")) return "muted is fixed by the video adapter and must be omitted";
  if (hasOwn(value, "asset")) return "asset paths are resolved from cue and must be omitted";
  for (const field of ["status", "durationMs", "fact", "intent"] as const) {
    if (hasOwn(value, field)) return `${field} is video state, not an instruction field`;
  }
  if (value.action === "play") {
    if (!isNonEmptyString(value.cue)) return "play requires a non-empty stable cue";
    if (value.loop !== undefined && typeof value.loop !== "boolean") return "loop must be a boolean";
    if (hasOwn(value, "positionMs")) return "positionMs is supported only by seek";
    return null;
  }
  if (value.action === "pause" || value.action === "close") {
    for (const field of ["cue", "loop", "positionMs"] as const) {
      if (hasOwn(value, field)) return `${field} is not supported for ${value.action}`;
    }
    return null;
  }
  if (value.action === "seek") {
    if (!isNonNegativeSafeInteger(value.positionMs)) {
      return "seek positionMs must be a non-negative safe integer number of milliseconds";
    }
    for (const field of ["cue", "loop"] as const) {
      if (hasOwn(value, field)) return `${field} is not supported for seek`;
    }
    return null;
  }
  return "action must be 'play', 'pause', 'close', or 'seek'";
}

/** Validate the canonical overlay before it enters a stage/save checkpoint. */
export function novelVideoOverlayStateIssue(value: unknown): string | null {
  if (!isRecord(value)) return "video overlay must be an object";
  if (hasOwn(value, "muted")) return "video overlay must not store the fixed muted policy";
  if (hasOwn(value, "asset")) return "video overlay must store a cue, not an asset path";
  for (const field of ["fact", "intent", "playback", "playing"] as const) {
    if (hasOwn(value, field)) return `${field} duplicates the canonical video status`;
  }
  if (!isNonEmptyString(value.cue)) return "video overlay cue must be a non-empty stable key";
  if (typeof value.loop !== "boolean") return "video overlay loop must be a boolean";
  if (!isNonNegativeSafeInteger(value.positionMs)) return "video overlay positionMs must be a non-negative safe integer";
  if (value.durationMs !== null && !isNonNegativeSafeInteger(value.durationMs)) {
    return "video overlay durationMs must be null or a non-negative safe integer";
  }
  if (value.durationMs !== null && value.positionMs > value.durationMs) {
    return "video overlay positionMs must not exceed durationMs";
  }
  if (value.status !== "playing" && value.status !== "paused" && value.status !== "ended") {
    return "video overlay status must be 'playing', 'paused', or 'ended'";
  }
  if (value.status === "ended" && value.loop) return "looping video overlays cannot be ended";
  return null;
}

/** Validate an incoming fact before its generation is compared to live state. */
export function novelVideoPlaybackFactIssue(value: unknown): string | null {
  if (!isRecord(value)) return "video playback fact must be an object";
  if (!isNonEmptyString(value.token)) return "video playback fact token must be non-empty";
  if (value.status !== "playing" && value.status !== "paused" && value.status !== "ended") {
    return "video playback fact status must be 'playing', 'paused', or 'ended'";
  }
  if (value.positionMs !== null && !isNonNegativeSafeInteger(value.positionMs)) {
    return "video playback fact positionMs must be null or a non-negative safe integer";
  }
  if (value.durationMs !== null && !isNonNegativeSafeInteger(value.durationMs)) {
    return "video playback fact durationMs must be null or a non-negative safe integer";
  }
  if (value.status === "ended" && (value.positionMs === null || value.durationMs === null)) {
    return "ended video facts require real positionMs and durationMs";
  }
  if (value.positionMs !== null && value.durationMs !== null && value.positionMs > value.durationMs) {
    return "video playback fact positionMs must not exceed durationMs";
  }
  return null;
}

/**
 * Validate a seek against the most recent real native duration. A missing
 * duration is not guessed, and an out-of-range seek is never silently clamped.
 */
export function novelVideoSeekIssue(positionMs: unknown, durationMs: unknown): string | null {
  if (!isNonNegativeSafeInteger(positionMs)) {
    return "seek positionMs must be a non-negative safe integer number of milliseconds";
  }
  if (durationMs === null) return "video duration must be known before seeking";
  if (!isNonNegativeSafeInteger(durationMs)) return "video duration must be a non-negative safe integer";
  if (positionMs > durationMs) return `seek positionMs must not exceed durationMs (${durationMs})`;
  return null;
}
