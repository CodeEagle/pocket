import { decodeNovelSaveData } from "./save-codec.ts";
import { createNovelEngine } from "./engine.ts";
import type { NovelSaveData, ScriptPosition, StoryDefinition } from "./types.ts";

/** An address-only upgrade map. It contains no copy of either story script. */
export interface NovelStoryRevisionMap {
  readonly format: "pocket-vn-revision-map";
  readonly formatVersion: 1;
  readonly storyId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** For each old label, entry i is its explicit new instruction index; the last entry is the new end sentinel. Reordered targets must remain unique. */
  readonly labelIndexes: Readonly<Record<string, readonly number[]>>;
  /** Optional provenance for the legacy source used to generate this map. */
  readonly legacySourceSha256?: string;
  /** Optional digest of the extracted legacy story data literal. */
  readonly legacyStorySha256?: string;
}

/** Raised when an explicit revision map cannot safely address a saved position. */
export class NovelSaveRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovelSaveRevisionError";
  }
}

type PlainRecord = Record<string, unknown>;

function record(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, message: string): never {
  throw new NovelSaveRevisionError(`${path} ${message}`);
}

function validateMap(value: unknown, target: StoryDefinition): NovelStoryRevisionMap {
  if (!record(value)) fail("revisionMap", "must be an object.");
  const allowed = ["format", "formatVersion", "storyId", "fromVersion", "toVersion", "labelIndexes", "legacySourceSha256", "legacyStorySha256"];
  if (Object.keys(value).some(key => !allowed.includes(key)) ||
      ["format", "formatVersion", "storyId", "fromVersion", "toVersion", "labelIndexes"].some(key => !Object.hasOwn(value, key))) {
    fail("revisionMap", "has an invalid shape.");
  }
  if (value.format !== "pocket-vn-revision-map" || value.formatVersion !== 1 ||
      typeof value.storyId !== "string" || value.storyId.trim().length === 0 ||
      !Number.isSafeInteger(value.fromVersion) || (value.fromVersion as number) < 1 ||
      !Number.isSafeInteger(value.toVersion) || (value.toVersion as number) <= (value.fromVersion as number)) {
    fail("revisionMap", "has an invalid identity or version range.");
  }
  for (const key of ["legacySourceSha256", "legacyStorySha256"] as const) {
    const digest = value[key];
    if (digest !== undefined && (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest))) {
      fail(`revisionMap.${key}`, "must be a SHA-256 hex digest when supplied.");
    }
  }
  if (value.storyId !== target.id || value.toVersion !== target.version) {
    fail("revisionMap", "does not describe the requested target story revision.");
  }
  if (!record(value.labelIndexes)) fail("revisionMap.labelIndexes", "must be a label-to-index map.");
  const labels = Object.keys(value.labelIndexes);
  if (labels.length === 0 || labels.length > 4096) fail("revisionMap.labelIndexes", "must contain 1 to 4096 labels.");
  for (const label of labels) {
    const indexes = value.labelIndexes[label];
    const instructions = target.script[label];
    if (!instructions) fail(`revisionMap.labelIndexes.${label}`, "does not exist in the target story.");
    if (!Array.isArray(indexes) || indexes.length === 0 || indexes.length > 100_000) {
      fail(`revisionMap.labelIndexes.${label}`, "must be a non-empty bounded instruction-index array.");
    }
    const seen = new Set<number>();
    for (let index = 0; index < indexes.length; index += 1) {
      const mapped = indexes[index];
      const isEndSentinel = index === indexes.length - 1 && mapped === instructions.length;
      if (!Number.isSafeInteger(mapped) || (mapped as number) < 0 || (mapped as number) > instructions.length || seen.has(mapped as number) ||
          (mapped === instructions.length && !isEndSentinel)) {
        fail(`revisionMap.labelIndexes.${label}[${index}]`, "must point to a unique target instruction or final end-position index.");
      }
      seen.add(mapped as number);
    }
    if (indexes[indexes.length - 1] !== instructions.length) {
      fail(`revisionMap.labelIndexes.${label}`, "must end with the target label's end-position sentinel.");
    }
  }
  return value as unknown as NovelStoryRevisionMap;
}

function mapPosition(value: unknown, path: string, revision: NovelStoryRevisionMap): ScriptPosition {
  if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "label") || !Object.hasOwn(value, "index") ||
      typeof value.label !== "string" || !Number.isSafeInteger(value.index) || (value.index as number) < 0) {
    return fail(path, "must be a script position with a label and non-negative instruction index.");
  }
  const labelIndexes = revision.labelIndexes[value.label];
  if (!labelIndexes || (value.index as number) >= labelIndexes.length) {
    return fail(path, "is not covered by the explicit revision map.");
  }
  return { label: value.label, index: labelIndexes[value.index as number]! };
}

function nextPosition(position: ScriptPosition): ScriptPosition {
  return { label: position.label, index: position.index + 1 };
}

function mapCallStack(value: unknown, path: string, revision: NovelStoryRevisionMap): NovelSaveData["state"]["callStack"] {
  if (!Array.isArray(value)) fail(path, "must be an array.");
  return value.map((frame, index) => {
    if (!record(frame) || Object.keys(frame).length !== 1 || !Object.hasOwn(frame, "returnTo")) {
      fail(`${path}[${index}]`, "must contain only returnTo.");
    }
    return { returnTo: mapPosition(frame.returnTo, `${path}[${index}].returnTo`, revision) };
  });
}

/**
 * Upgrade a decoded save through one explicit story revision map. Only known
 * script-address fields are rewritten; similarly shaped player variables are
 * copied through untouched. The returned save remains expanded V1 for the
 * engine's ordinary atomic load validation.
 */
export function migrateNovelSaveRevision(
  value: unknown,
  revisionMap: unknown,
  targetStory: StoryDefinition,
): NovelSaveData {
  const decoded = decodeNovelSaveData(value);
  if (decoded.storyId !== targetStory.id) fail("save.storyId", "does not match the requested target story.");
  if (decoded.storyVersion === targetStory.version) return decoded;

  const revision = validateMap(revisionMap, targetStory);
  if (decoded.storyId !== revision.storyId || decoded.storyVersion !== revision.fromVersion) {
    fail("save.storyVersion", "is not covered by the explicit revision map.");
  }
  const state = decoded.state;
  if (!record(state)) fail("save.state", "must be an object.");
  const mappedLocation = mapPosition(state.location, "save.state.location", revision);
  const active = state.active === null
    ? null
    : (() => {
        if (!record(state.active)) fail("save.state.active", "must be an active state or null.");
        return { ...state.active, location: mapPosition(state.active.location, "save.state.active.location", revision) } as NovelSaveData["state"]["active"];
      })();
  const callStack = mapCallStack(state.callStack, "save.state.callStack", revision);
  if (!Array.isArray(state.backlog)) fail("save.state.backlog", "must be an array.");
  const backlog = state.backlog.map((entry, index) => {
    if (!record(entry)) fail(`save.state.backlog[${index}]`, "must be an object.");
    return { ...entry, location: mapPosition(entry.location, `save.state.backlog[${index}].location`, revision) };
  }) as unknown as NovelSaveData["state"]["backlog"];
  if (!Array.isArray(state.rollbackHistory)) fail("save.state.rollbackHistory", "must be an array.");
  const rollbackHistory = state.rollbackHistory.map((checkpoint, index) => {
    const path = `save.state.rollbackHistory[${index}]`;
    if (!record(checkpoint)) fail(path, "must be an object.");
    const location = mapPosition(checkpoint.location, `${path}.location`, revision);
    if (!record(checkpoint.active)) fail(`${path}.active`, "must be an active state.");
    const checkpointActive = {
      ...checkpoint.active,
      location: mapPosition(checkpoint.active.location, `${path}.active.location`, revision),
    } as NovelSaveData["state"]["rollbackHistory"][number]["active"];
    const checkpointCallStack = mapCallStack(checkpoint.callStack, `${path}.callStack`, revision);
    return {
      ...checkpoint,
      location: nextPosition(checkpointActive.location),
      active: checkpointActive,
      callStack: checkpointCallStack,
    };
  }) as unknown as NovelSaveData["state"]["rollbackHistory"];

  const migrated: NovelSaveData = {
    ...decoded,
    storyVersion: revision.toVersion,
    state: {
      ...state,
      location: active ? nextPosition(active.location) : mappedLocation,
      active,
      callStack,
      backlog,
      rollbackHistory,
    },
  };
  const validator = createNovelEngine(targetStory);
  try {
    validator.load(migrated);
  } finally {
    validator.dispose();
  }
  return migrated;
}
