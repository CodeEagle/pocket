import type {
  NovelTimelineDefinition,
  NovelTimelineAudioGainTrack,
  NovelTimelineEasing,
  NovelTimelineKeyframe,
} from "./types.ts";
import { NOVEL_VOICE_CHANNEL } from "./voice.ts";
import { novelCharacterTransformIssue } from "./scene.ts";
import { novelCameraTransformIssue } from "./camera.ts";

const TIMELINE_LIMITS = Object.freeze({
  durationMs: 60_000,
  actors: 32,
  keyframes: 64,
  audio: 256,
  audioGains: 32,
  presets: 128,
});

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Shared authoring rule for explicit music/effects routing on named play cues. */
export function novelAuthoredAudioGroupIssue(
  group: unknown,
  action: unknown,
  channel: unknown,
  path = "audio",
): string | null {
  if (group === undefined) return null;
  if (group !== "music" && group !== "effects") return `${path}.group must be 'music' or 'effects'`;
  if (action === "stop") return `${path}.group is only valid when action is 'play'`;
  if (!isNonEmptyString(channel)) return `${path}.group requires a non-empty channel`;
  if (channel === NOVEL_VOICE_CHANNEL) return `${path}.channel is reserved for dialogue voice`;
  if (channel === "music-preview" || /^effect-[0-3]$/.test(channel)) {
    return `${path}.channel '${channel}' is reserved by the SDK for explicit group routing`;
  }
  if (channel === "music" && group !== "music") return `${path}.group must be 'music' when channel is 'music'`;
  return null;
}

function isAudioGainChannel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function exactKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}

function easingIssue(value: unknown, path: string): string | null {
  if (value !== undefined && value !== "linear" && value !== "easeInOut") {
    return `${path} must be 'linear' or 'easeInOut'`;
  }
  return null;
}

function keyframeTimeIssue(value: unknown, path: string, durationMs: number): string | null {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > durationMs) {
    return `${path} must be an integer between 0 and durationMs (${durationMs})`;
  }
  return null;
}

function validateKeyframeTimes(
  keyframes: readonly unknown[],
  path: string,
  durationMs: number,
): string | null {
  if (keyframes.length === 0 || keyframes.length > TIMELINE_LIMITS.keyframes) {
    return `${path} must contain between 1 and ${TIMELINE_LIMITS.keyframes} keyframes`;
  }
  let previous = -1;
  for (let index = 0; index < keyframes.length; index++) {
    const keyframePath = `${path}[${index}]`;
    const keyframe = keyframes[index];
    if (!isRecord(keyframe)) return `${keyframePath} must be an object`;
    const timeIssue = keyframeTimeIssue(keyframe.atMs, `${keyframePath}.atMs`, durationMs);
    if (timeIssue !== null) return timeIssue;
    const atMs = keyframe.atMs as number;
    if (index === 0 && atMs !== 0) return `${keyframePath}.atMs must be 0 for a motion track's first keyframe`;
    if (atMs <= previous) return `${keyframePath}.atMs must be strictly greater than the previous keyframe`;
    const issue = easingIssue(keyframe.easing, `${keyframePath}.easing`);
    if (issue !== null) return issue;
    previous = atMs;
  }
  return null;
}

function validateCameraTrack(value: unknown, path: string, durationMs: number): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  const timingIssue = validateKeyframeTimes(value, path, durationMs);
  if (timingIssue !== null) return timingIssue;
  for (let index = 0; index < value.length; index++) {
    const keyframe = value[index] as PlainRecord;
    const keyframePath = `${path}[${index}]`;
    if (!exactKeys(keyframe, ["atMs", "value", "easing"])) return `${keyframePath} contains unsupported fields`;
    if (!isRecord(keyframe.value) || !exactKeys(keyframe.value, ["x", "y", "scale"])) {
      return `${keyframePath}.value must contain only x, y, and scale`;
    }
    const issue = novelCameraTransformIssue(keyframe.value, `${keyframePath}.value`);
    if (issue !== null) return issue;
  }
  return null;
}

function validateActorTrack(value: unknown, path: string, durationMs: number): string | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "keyframes"])) return `${path} must contain only id and keyframes`;
  if (!isNonEmptyString(value.id)) return `${path}.id must be a non-empty actor id`;
  if (!Array.isArray(value.keyframes)) return `${path}.keyframes must be an array`;
  const timingIssue = validateKeyframeTimes(value.keyframes, `${path}.keyframes`, durationMs);
  if (timingIssue !== null) return timingIssue;
  for (let index = 0; index < value.keyframes.length; index++) {
    const keyframe = value.keyframes[index] as PlainRecord;
    const keyframePath = `${path}.keyframes[${index}]`;
    if (!exactKeys(keyframe, ["atMs", "value", "easing"])) return `${keyframePath} contains unsupported fields`;
    if (!isRecord(keyframe.value) || !exactKeys(keyframe.value, ["position", "scale", "rotation"])) {
      return `${keyframePath}.value must contain only position, scale, and rotation`;
    }
    const position = keyframe.value.position;
    if (!isRecord(position) || !exactKeys(position, ["x", "y"]) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
      return `${keyframePath}.value.position must contain finite x and y coordinates`;
    }
    if (!isFiniteNumber(keyframe.value.scale)) return `${keyframePath}.value.scale must be finite`;
    if (!isFiniteNumber(keyframe.value.rotation)) return `${keyframePath}.value.rotation must be finite`;
    const transformIssue = novelCharacterTransformIssue({ scale: keyframe.value.scale, rotation: keyframe.value.rotation });
    if (transformIssue !== null) return `${keyframePath}.value.${transformIssue}`;
  }
  return null;
}

function validateAudioTrack(value: unknown, path: string, durationMs: number): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  if (value.length > TIMELINE_LIMITS.audio) return `${path} cannot contain more than ${TIMELINE_LIMITS.audio} cues`;
  for (let index = 0; index < value.length; index++) {
    const cue = value[index];
    const cuePath = `${path}[${index}]`;
    if (!isRecord(cue) || !exactKeys(cue, ["atMs", "cue", "action", "channel", "loop", "group"])) {
      return `${cuePath} contains unsupported fields`;
    }
    const timeIssue = keyframeTimeIssue(cue.atMs, `${cuePath}.atMs`, durationMs);
    if (timeIssue !== null) return timeIssue;
    if (!isNonEmptyString(cue.cue)) return `${cuePath}.cue must be a non-empty audio cue`;
    if (cue.action !== undefined && cue.action !== "play" && cue.action !== "stop") {
      return `${cuePath}.action must be 'play' or 'stop'`;
    }
    if (cue.channel !== undefined && !isNonEmptyString(cue.channel)) return `${cuePath}.channel must be non-empty when provided`;
    if (cue.channel === NOVEL_VOICE_CHANNEL) return `${cuePath}.channel is reserved for dialogue voice`;
    if (cue.loop !== undefined && typeof cue.loop !== "boolean") return `${cuePath}.loop must be boolean`;
    const groupIssue = novelAuthoredAudioGroupIssue(cue.group, cue.action, cue.channel, cuePath);
    if (groupIssue !== null) return groupIssue;
  }
  return null;
}

function validateAudioGainTrack(value: unknown, path: string, durationMs: number): string | null {
  if (!isRecord(value) || !exactKeys(value, ["channel", "keyframes"])) {
    return `${path} must contain only channel and keyframes`;
  }
  const channel = value.channel;
  if (channel === NOVEL_VOICE_CHANNEL) return `${path}.channel is reserved for dialogue voice`;
  if (!isAudioGainChannel(channel)) return `${path}.channel must be 1 to 64 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit`;
  if (/^effect-[0-3]$/.test(channel) || channel === "music-preview") {
    return `${path}.channel '${channel}' is reserved by the SDK`;
  }
  if (!Array.isArray(value.keyframes)) return `${path}.keyframes must be an array`;
  const timingIssue = validateKeyframeTimes(value.keyframes, `${path}.keyframes`, durationMs);
  if (timingIssue !== null) return timingIssue;
  for (let index = 0; index < value.keyframes.length; index++) {
    const keyframe = value.keyframes[index] as PlainRecord;
    const keyframePath = `${path}.keyframes[${index}]`;
    if (!exactKeys(keyframe, ["atMs", "value", "easing"])) return `${keyframePath} contains unsupported fields`;
    if (!isFiniteNumber(keyframe.value) || keyframe.value < 0 || keyframe.value > 1) {
      return `${keyframePath}.value must be a finite number between 0 and 1`;
    }
  }
  return null;
}

/** Returns the first schema issue for one authorable timeline preset. */
export function novelTimelineDefinitionIssue(value: unknown, path = "timeline"): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!exactKeys(value, ["durationMs", "camera", "actors", "audio", "audioGains"])) return `${path} contains unsupported fields`;
  if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) <= 0 || (value.durationMs as number) > TIMELINE_LIMITS.durationMs) {
    return `${path}.durationMs must be an integer between 1 and ${TIMELINE_LIMITS.durationMs}`;
  }
  const durationMs = value.durationMs as number;
  if (value.camera !== undefined) {
    const issue = validateCameraTrack(value.camera, `${path}.camera`, durationMs);
    if (issue !== null) return issue;
  }
  if (value.actors !== undefined) {
    if (!Array.isArray(value.actors)) return `${path}.actors must be an array`;
    if (value.actors.length > TIMELINE_LIMITS.actors) return `${path}.actors cannot contain more than ${TIMELINE_LIMITS.actors} tracks`;
    const ids = new Set<string>();
    for (let index = 0; index < value.actors.length; index++) {
      const actor = value.actors[index];
      const issue = validateActorTrack(actor, `${path}.actors[${index}]`, durationMs);
      if (issue !== null) return issue;
      const id = (actor as PlainRecord).id as string;
      if (ids.has(id)) return `${path}.actors[${index}].id duplicates actor track '${id}'`;
      ids.add(id);
    }
  }
  if (value.audio !== undefined) {
    const issue = validateAudioTrack(value.audio, `${path}.audio`, durationMs);
    if (issue !== null) return issue;
  }
  if (value.audioGains !== undefined) {
    if (!Array.isArray(value.audioGains)) return `${path}.audioGains must be an array`;
    if (value.audioGains.length > TIMELINE_LIMITS.audioGains) {
      return `${path}.audioGains cannot contain more than ${TIMELINE_LIMITS.audioGains} tracks`;
    }
    const channels = new Set<string>();
    for (let index = 0; index < value.audioGains.length; index++) {
      const track = value.audioGains[index];
      const issue = validateAudioGainTrack(track, `${path}.audioGains[${index}]`, durationMs);
      if (issue !== null) return issue;
      const channel = (track as PlainRecord).channel as string;
      if (channels.has(channel)) return `${path}.audioGains[${index}].channel duplicates gain track '${channel}'`;
      channels.add(channel);
    }
  }
  return null;
}

/** Validates the preset map and its 128-preset authoring bound. */
export function novelTimelineDefinitionsIssue(value: unknown, path = "story.timelines"): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return `${path} must be an object keyed by preset id`;
  const entries = Object.entries(value);
  if (entries.length > TIMELINE_LIMITS.presets) return `${path} cannot contain more than ${TIMELINE_LIMITS.presets} presets`;
  for (const [id, definition] of entries) {
    if (!isNonEmptyString(id)) return `${path} keys must be non-empty preset ids`;
    const issue = novelTimelineDefinitionIssue(definition, `${path}.${id}`);
    if (issue !== null) return issue;
  }
  return null;
}

/** Validates a scene's preset reference and same-scene camera-motion conflict. */
export function novelTimelineInstructionIssue(
  value: unknown,
  timelines: unknown,
  path = "scene",
): string | null {
  if (!isRecord(value) || value.type !== "scene") return `${path}.type must be 'scene'`;
  if (value.timeline === undefined || value.timeline === null) return null;
  if (!isNonEmptyString(value.timeline)) return `${path}.timeline must be a non-empty preset id, null, or omitted`;
  if (!isRecord(timelines) || !Object.hasOwn(timelines, value.timeline)) return `${path}.timeline references unknown preset '${value.timeline}'`;
  const definition = timelines[value.timeline];
  if (value.cameraMotion !== undefined && isRecord(definition) && definition.camera !== undefined) {
    return `${path}.cameraMotion cannot be used with camera track '${value.timeline}'`;
  }
  return null;
}

/** Shared full-story helper for authoring surfaces and engine construction. */
export function novelTimelineStoryIssue(value: unknown): string | null {
  if (!isRecord(value)) return "story must be an object";
  const definitionsIssue = novelTimelineDefinitionsIssue(value.timelines);
  if (definitionsIssue !== null) return definitionsIssue;
  if (value.script === undefined) return null;
  if (!isRecord(value.script)) return "story.script must be an object";
  const timelines = value.timelines;
  for (const [label, instructions] of Object.entries(value.script)) {
    if (!Array.isArray(instructions)) continue;
    for (let index = 0; index < instructions.length; index++) {
      const instruction = instructions[index];
      if (!isRecord(instruction) || instruction.type !== "scene") continue;
      const issue = novelTimelineInstructionIssue(instruction, timelines, `script.${label}[${index}]`);
      if (issue !== null) return issue;
    }
  }
  return null;
}

/** Uses the easing attached to the destination keyframe for this segment. */
export function novelTimelineEasedProgress(progress: number, easing: NovelTimelineEasing | undefined): number {
  const amount = Math.max(0, Math.min(1, progress));
  return easing === "easeInOut" ? amount * amount * (3 - 2 * amount) : amount;
}

/** Selects the adjacent keyframes used to resolve one track at a timeline time. */
export function novelTimelineSegment<T extends NovelTimelineKeyframe>(
  keyframes: readonly T[],
  elapsedMs: number,
): { readonly from: T; readonly to: T; readonly progress: number } {
  if (elapsedMs <= keyframes[0]!.atMs || keyframes.length === 1) {
    return { from: keyframes[0]!, to: keyframes[0]!, progress: 0 };
  }
  for (let index = 1; index < keyframes.length; index++) {
    const to = keyframes[index]!;
    if (elapsedMs <= to.atMs) {
      const from = keyframes[index - 1]!;
      return { from, to, progress: (elapsedMs - from.atMs) / (to.atMs - from.atMs) };
    }
  }
  const last = keyframes[keyframes.length - 1]!;
  return { from: last, to: last, progress: 1 };
}

/** Samples one channel's normalized gain using the timeline's shared keyframe rules. */
export function sampleNovelTimelineAudioGain(track: NovelTimelineAudioGainTrack, elapsedMs: number): number {
  const segment = novelTimelineSegment(track.keyframes, elapsedMs);
  const amount = novelTimelineEasedProgress(segment.progress, segment.to.easing);
  return segment.from.value + (segment.to.value - segment.from.value) * amount;
}

export type { NovelTimelineDefinition };
