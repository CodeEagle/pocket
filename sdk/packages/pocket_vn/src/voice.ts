/** Reserved transport channel for dialogue-bound playback. */
export const NOVEL_VOICE_CHANNEL = "__pocket_vn_voice";

export type NovelVoiceStatus = "playing" | "paused" | "completed" | "error" | "unavailable";

/** Facts reported by the actual playback boundary, correlated to one request. */
export interface NovelVoicePlaybackFact {
  readonly token: string;
  readonly status: NovelVoiceStatus;
  readonly positionMs?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

/** Ephemeral playback state. Never serialized into a save or rollback checkpoint. */
export interface NovelVoicePlaybackState {
  readonly token: string;
  readonly lineId: string;
  readonly cue: string;
  readonly status: "pending" | NovelVoiceStatus;
  readonly positionMs?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

export function voiceBlocksAutoAdvance(voice: NovelVoicePlaybackState | null | undefined): boolean {
  return voice?.status === "pending" || voice?.status === "playing" || voice?.status === "paused";
}
