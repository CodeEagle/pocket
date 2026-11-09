import type {
  ActiveNovelState,
  BacklogEntry,
  CallStackFrame,
  CharacterPosition,
  ChoiceOptionDefinition,
  ChoiceState,
  Condition,
  EngineEvent,
  EngineListener,
  EngineSnapshot,
  EngineSubscribeOptions,
  EngineUpdate,
  InputState,
  JsonValue,
  NovelAudioIntent,
  NovelAuthoredAudioGroup,
  NovelBackgroundLayer,
  NovelDebugAPI,
  NovelEngine,
  NovelEngineOptions,
  NovelExecutionTraceEntry,
  NovelExecutionTraceListener,
  NovelInputInstruction,
  NovelInputValidationError,
  NovelMetaState,
  NovelPreferences,
  NovelSaveData,
  NovelSceneObject,
  NovelSceneObjectEffect,
  NovelSayRich,
  NovelSayPause,
  NovelSayPauseState,
  NovelTimelineAudioCue,
  NovelTimelineDefinition,
  NovelTimelineState,
  NovelVariableLifetime,
  RevealTransitionDirection,
  NovelVideoInstruction,
  NovelVideoOverlayState,
  NovelVideoPlaybackFact,
  NovelVoicePlaybackFact,
  NovelVoicePlaybackState,
  RollbackCheckpoint,
  SceneCharacterUpdate,
  ScriptPosition,
  StageCharacter,
  StageState,
  StoryDefinition,
  StoryInstruction,
  ValueExpression,
} from "./types.ts";
import { novelCharacterTransformIssue } from "./scene.ts";
import { novelBackgroundLayersInstructionIssue, novelBackgroundLayersIssue } from "./background-layers.ts";
import {
  createNovelCameraMotionState,
  DEFAULT_NOVEL_CAMERA,
  novelCameraInstructionIssue,
  novelCameraStateIssue,
  resolveNovelCameraPose,
} from "./camera.ts";
import {
  NOVEL_INPUT_NUMBER_RAW_LIMIT,
  NOVEL_INPUT_TEXT_RAW_LIMIT,
  novelInputDefaultDraft,
  novelInputInstructionIssue,
  validateNovelInputDraft,
} from "./input.ts";
import { NOVEL_VOICE_CHANNEL, voiceBlocksAutoAdvance } from "./voice.ts";
import { isNovelVariableName, novelVariableDefinitionsIssue } from "./variables.ts";
import { evaluateNovelCondition, novelConditionIssue } from "./conditions.ts";
import { isNovelSceneObjectInteractive, novelSceneObjectsIssue } from "./scene-objects.ts";
import { planNovelInventoryTrade, validateNovelInventory } from "./inventory.ts";
import { interpolateNovelText, novelSayRichIssue, novelSayRichTemplateIssue, resolveNovelSayRich } from "./rich-text.ts";
import { novelReplayEntriesIssue } from "./replay-schema.ts";
import { novelSayPresentationInstructionIssue } from "./say-presentation.ts";
import {
  novelTimelineDefinitionsIssue,
  novelTimelineEasedProgress,
  novelTimelineInstructionIssue,
  novelAuthoredAudioGroupIssue,
  novelTimelineSegment,
  sampleNovelTimelineAudioGain,
} from "./timeline.ts";
import { decodeNovelSaveData } from "./save-codec.ts";
import {
  novelVideoInstructionIssue,
  novelVideoOverlayStateIssue,
  novelVideoPlaybackFactIssue,
  novelVideoSeekIssue,
} from "./video-schema.ts";

const DEFAULT_PREFERENCES: NovelPreferences = {
  mode: "manual",
  textSpeedCharsPerSecond: 32,
  autoDelayMs: 1500,
  skipSeenOnly: true,
};
const DEFAULT_MAX_BACKLOG = 200;
const DEFAULT_MAX_ROLLBACK = 64;
const DEFAULT_STEP_BUDGET = 10_000;
const LOCATION_KEY_SEPARATOR = "\u0000";
let engineInstanceSequence = 0;

export class NovelEngineError extends Error {
  constructor(message: string) { super(message); this.name = "NovelEngineError"; }
}
export class StoryValidationError extends NovelEngineError {
  constructor(message: string) { super(message); this.name = "StoryValidationError"; }
}
export class SaveDataError extends NovelEngineError {
  constructor(message: string) { super(message); this.name = "SaveDataError"; }
}
export class StepBudgetExceededError extends NovelEngineError {
  constructor(budget: number) { super(`Story execution exceeded its ${budget}-step budget`); this.name = "StepBudgetExceededError"; }
}

interface MutableState {
  started: boolean;
  location: ScriptPosition;
  variables: Record<string, JsonValue>;
  stage: StageState;
  active: ActiveNovelState | null;
  callStack: CallStackFrame[];
  backlog: BacklogEntry[];
  nextBacklogSequence: number;
  rollbackHistory: RollbackCheckpoint[];
  meta: NovelMetaState;
  audioIntents: Record<string, NovelAudioIntent>;
  preferences: NovelPreferences;
  paused: boolean;
  eventSequence: number;
  transitionSequence: number;
}

interface EngineInternalOptions {
  maxBacklogEntries: number;
  maxRollbackEntries: number;
  maxStepBudget: number;
}

type PlainRecord = Record<string, unknown>;

function record(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone only JSON data. This also rejects accessor properties and exotic objects at trust boundaries. */
function copyJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NovelEngineError(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new NovelEngineError(`${path} must not contain symbol keys`);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new NovelEngineError(`${path}[${index}] must be a plain JSON array entry`);
      }
      result.push(copyJson(descriptor.value, `${path}[${index}]`));
    }
    for (const key of Object.keys(descriptors)) {
      if (key !== "length" && !/^\d+$/.test(key)) throw new NovelEngineError(`${path} must not have custom array properties`);
    }
    return result;
  }
  if (!record(value)) throw new NovelEngineError(`${path} must contain only plain JSON data`);
  if (Object.getOwnPropertySymbols(value).length) throw new NovelEngineError(`${path} must not contain symbol keys`);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new NovelEngineError(`${path}.${key} must be a plain JSON property`);
    }
    result[key] = copyJson(descriptor.value, `${path}.${key}`);
  }
  return result;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(entry => clone(entry)) as T;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = clone(entry);
  return result as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function failStory(message: string): never { throw new StoryValidationError(message); }
function failSave(message: string): never { throw new SaveDataError(message); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isNonEmptyString(value: unknown): value is string { return isString(value) && value.trim().length > 0; }
function isIntegerAtLeast(value: unknown, minimum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum; }
function addUnique(values: readonly string[], entry: string): string[] { return values.includes(entry) ? [...values] : [...values, entry]; }
function mergeMeta(a: NovelMetaState, b: NovelMetaState): NovelMetaState {
  return {
    readLineIds: [...new Set([...a.readLineIds, ...b.readLineIds])],
    endingIds: [...new Set([...a.endingIds, ...b.endingIds])],
    cgIds: [...new Set([...a.cgIds, ...b.cgIds])],
    musicIds: [...new Set([...(a.musicIds ?? []), ...(b.musicIds ?? [])])],
    // The current engine's explicit persistent progress wins when loading an older slot.
    persistentVariables: { ...(b.persistentVariables ?? {}), ...(a.persistentVariables ?? {}) },
  };
}
function emptyMeta(): NovelMetaState { return { readLineIds: [], endingIds: [], cgIds: [], musicIds: [], persistentVariables: {} }; }
function emptyStage(): StageState {
  return { background: null, characters: {}, transition: null, video: null, camera: { ...DEFAULT_NOVEL_CAMERA, motion: null } };
}
function interpolateTimelineNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}
function sampleNovelTimeline(stage: StageState, definition: NovelTimelineDefinition, elapsedMs: number): StageState {
  let characters = stage.characters as Record<string, StageCharacter>;
  for (const track of definition.actors ?? []) {
    const segment = novelTimelineSegment(track.keyframes, elapsedMs);
    const amount = novelTimelineEasedProgress(segment.progress, segment.to.easing);
    const from = segment.from.value;
    const to = segment.to.value;
    const character = characters[track.id]!;
    if (characters === stage.characters) characters = { ...characters };
    characters[track.id] = {
      ...character,
      position: {
        x: interpolateTimelineNumber(from.position.x, to.position.x, amount),
        y: interpolateTimelineNumber(from.position.y, to.position.y, amount),
      },
      scale: interpolateTimelineNumber(from.scale, to.scale, amount),
      rotation: interpolateTimelineNumber(from.rotation, to.rotation, amount),
    };
  }
  let camera = stage.camera;
  if (definition.camera !== undefined) {
    const segment = novelTimelineSegment(definition.camera, elapsedMs);
    const amount = novelTimelineEasedProgress(segment.progress, segment.to.easing);
    camera = {
      x: interpolateTimelineNumber(segment.from.value.x, segment.to.value.x, amount),
      y: interpolateTimelineNumber(segment.from.value.y, segment.to.value.y, amount),
      scale: interpolateTimelineNumber(segment.from.value.scale, segment.to.value.scale, amount),
      motion: null,
    };
  }
  return characters === stage.characters && camera === stage.camera
    ? stage
    : { ...stage, characters, camera };
}
function orderedTimelineAudio(definition: NovelTimelineDefinition): NovelTimelineAudioCue[] {
  return (definition.audio ?? []).map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.atMs - b.cue.atMs || a.index - b.index)
    .map(entry => entry.cue);
}
function timelineNumbersMatch(actual: unknown, expected: number): boolean {
  return isFiniteNumber(actual) && Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected));
}
function timelineAudioGainIssue(
  intents: Readonly<Record<string, NovelAudioIntent>>,
  definition: NovelTimelineDefinition,
  elapsedMs: number,
  path: string,
): string | null {
  for (const track of definition.audioGains ?? []) {
    const intent = intents[track.channel];
    if (!intent || intent.action !== "play") continue;
    const expected = sampleNovelTimelineAudioGain(track, elapsedMs);
    if (intent.gain === undefined ? expected !== 1 : !timelineNumbersMatch(intent.gain, expected)) {
      return `${path}.audioIntents.${track.channel}.gain does not match timeline elapsedMs`;
    }
  }
  return null;
}
function timelinePoseIssue(stage: StageState, definition: NovelTimelineDefinition, elapsedMs: number, path: string): string | null {
  const expected = sampleNovelTimeline(stage, definition, elapsedMs);
  for (const track of definition.actors ?? []) {
    const current = stage.characters[track.id];
    const pose = expected.characters[track.id];
    const position = current?.position;
    if (!current || !pose || !record(position) ||
        !timelineNumbersMatch(position.x, (pose.position as { readonly x: number; readonly y: number }).x) ||
        !timelineNumbersMatch(position.y, (pose.position as { readonly x: number; readonly y: number }).y) ||
        !timelineNumbersMatch(current.scale, pose.scale!) ||
        !timelineNumbersMatch(current.rotation, pose.rotation!)) {
      return `${path}.characters.${track.id} pose does not match timeline elapsedMs`;
    }
  }
  if (definition.camera !== undefined && (
    !timelineNumbersMatch(stage.camera.x, expected.camera.x) ||
    !timelineNumbersMatch(stage.camera.y, expected.camera.y) ||
    !timelineNumbersMatch(stage.camera.scale, expected.camera.scale) ||
    stage.camera.motion !== null
  )) return `${path}.camera pose does not match timeline elapsedMs`;
  return null;
}
function location(label: string, index = 0): ScriptPosition { return { label, index }; }
function locationKey(value: ScriptPosition): string { return `${value.label}${LOCATION_KEY_SEPARATOR}${value.index}`; }
function sameLocation(a: ScriptPosition, b: ScriptPosition): boolean { return a.label === b.label && a.index === b.index; }
function nextPosition(value: ScriptPosition): ScriptPosition { return { label: value.label, index: value.index + 1 }; }
function codePoints(text: string): string[] { return Array.from(text); }

function validatePosition(value: unknown, story: StoryDefinition, path: string, allowEnd = true): ScriptPosition {
  if (!record(value) || !isString(value.label) || !isIntegerAtLeast(value.index, 0)) failStory(`${path} is not a valid script position`);
  const instructions = story.script[value.label];
  if (!instructions || value.index > instructions.length || (!allowEnd && value.index === instructions.length)) failStory(`${path} points outside the story`);
  return { label: value.label, index: value.index };
}

function validateCharacterPosition(value: unknown, path: string): CharacterPosition {
  if (value === "left" || value === "center" || value === "right") return value;
  if (record(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)) return { x: value.x, y: value.y };
  failStory(`${path} must be left, center, right, or finite x/y coordinates`);
}

function validateCharacterTransform(value: Record<string, unknown>, path: string): void {
  const issue = novelCharacterTransformIssue(value);
  if (issue) failStory(`${path}.${issue}`);
}

function validateCondition(condition: unknown, path: string): asserts condition is Condition {
  const issue = novelConditionIssue(condition, path);
  if (issue !== null) failStory(issue);
}

function validateStoryDefinition(input: StoryDefinition): StoryDefinition {
  let copied: unknown;
  try { copied = copyJson(input, "story"); }
  catch (error) { failStory(error instanceof Error ? error.message : String(error)); }
  if (!record(copied)) failStory("story must be an object");
  const story = copied as unknown as StoryDefinition;
  if (!isNonEmptyString(story.id) || !isIntegerAtLeast(story.version, 1) || !isNonEmptyString(story.start)) failStory("story requires a non-empty id/start and positive integer version");
  const variableDefinitionsIssue = novelVariableDefinitionsIssue(story.variableDefinitions);
  if (variableDefinitionsIssue !== null) failStory(variableDefinitionsIssue);
  if (story.inventory !== undefined) {
    const inventoryIssues = validateNovelInventory(story.inventory, { story });
    if (inventoryIssues.length > 0) {
      const issue = inventoryIssues[0]!;
      failStory(`${issue.path}: ${issue.message}`);
    }
  }
  if (!record(story.script) || Object.keys(story.script).length === 0) failStory("story.script must contain at least one label");
  if (!Object.hasOwn(story.script, story.start)) failStory(`start label '${story.start}' does not exist`);
  const timelineIssue = novelTimelineDefinitionsIssue(story.timelines);
  if (timelineIssue !== null) failStory(timelineIssue);
  const sayIds = new Set<string>();
  const choiceIds = new Set<string>();
  const inputIds = new Set<string>();
  for (const [label, instructions] of Object.entries(story.script)) {
    if (!isNonEmptyString(label) || !Array.isArray(instructions)) failStory("script labels must map to instruction arrays");
    instructions.forEach((instruction, index) => validateInstruction(instruction, `${label}[${index}]`, story, sayIds, choiceIds, inputIds));
  }
  const replayEntriesIssue = novelReplayEntriesIssue(story.replayEntries, story.script);
  if (replayEntriesIssue !== null) failStory(replayEntriesIssue);
  return deepFreeze(story);
}

function validateInstruction(value: unknown, path: string, story: StoryDefinition, sayIds: Set<string>, choiceIds: Set<string>, inputIds: Set<string>): asserts value is StoryInstruction {
  if (!record(value) || !isString(value.type)) failStory(`${path} is not an instruction`);
  const target = (name: unknown, targetPath: string): void => {
    if (!isNonEmptyString(name) || !Object.hasOwn(story.script, name)) failStory(`${targetPath} references an unknown label`);
  };
  const validateSceneCharacter = (entry: unknown, entryPath: string): asserts entry is SceneCharacterUpdate => {
    if (!record(entry) || !isNonEmptyString(entry.id)) failStory(`${entryPath}.id is required`);
    if (entry.expression !== undefined && !isNonEmptyString(entry.expression)) failStory(`${entryPath}.expression must be non-empty`);
    if (entry.position !== undefined) validateCharacterPosition(entry.position, `${entryPath}.position`);
    validateCharacterTransform(entry, entryPath);
    if (entry.visible !== undefined && typeof entry.visible !== "boolean") failStory(`${entryPath}.visible must be boolean`);
    if (entry.model !== undefined && entry.model !== null && !validModelIntent(entry.model)) failStory(`${entryPath}.model is invalid`);
  };
  switch (value.type) {
    case "say":
      if (!isNonEmptyString(value.id) || !isString(value.text)) failStory(`${path} requires id and text`);
      if (value.rich !== undefined) {
        const richIssue = novelSayRichTemplateIssue(value.text, value.rich);
        if (richIssue !== null) failStory(`${path}.rich: ${richIssue}`);
      }
      {
        const presentationIssue = novelSayPresentationInstructionIssue(value);
        if (presentationIssue !== null) failStory(`${path}.${presentationIssue}`);
      }
      if (sayIds.has(value.id)) failStory(`say id '${value.id}' is duplicated`);
      sayIds.add(value.id);
      if (value.speaker !== undefined && !isString(value.speaker)) failStory(`${path}.speaker must be a string`);
      if (value.portrait !== undefined && !isString(value.portrait)) failStory(`${path}.portrait must be a string`);
      if (value.voice !== undefined && !isNonEmptyString(value.voice)) failStory(`${path}.voice must name a non-empty audio cue`);
      return;
    case "scene":
      if (value.background !== undefined && value.background !== null && !isString(value.background)) failStory(`${path}.background must be a string or null`);
      {
        const layersIssue = novelBackgroundLayersInstructionIssue(value);
        if (layersIssue !== null) failStory(`${path}.${layersIssue}`);
      }
      if (value.characters !== undefined && !Array.isArray(value.characters)) failStory(`${path}.characters must be an array`);
      value.characters?.forEach((entry, index) => validateSceneCharacter(entry, `${path}.characters[${index}]`));
      if (value.remove !== undefined && (!Array.isArray(value.remove) || !value.remove.every(isString))) failStory(`${path}.remove must be an array of character ids`);
      if (value.objects !== undefined) {
        const objectsIssue = novelSceneObjectsIssue(value.objects, `${path}.objects`);
        if (objectsIssue !== null) failStory(objectsIssue);
      }
      if (value.transition !== undefined) {
        if (!record(value.transition) || !["cut", "fade", "dissolve", "reveal"].includes(String(value.transition.kind)) || !isFiniteNumber(value.transition.durationMs) || value.transition.durationMs < 0) failStory(`${path}.transition is invalid`);
        if (value.transition.kind === "reveal") {
          if (value.transition.direction !== undefined && !["left", "right", "up", "down"].includes(String(value.transition.direction))) failStory(`${path}.transition.direction must be left, right, up or down`);
        } else if (Object.hasOwn(value.transition, "direction")) {
          failStory(`${path}.transition.direction is only valid for reveal`);
        }
      }
      {
        const cameraIssue = novelCameraInstructionIssue(value);
        if (cameraIssue !== null) failStory(`${path}.${cameraIssue}`);
      }
      {
        const timelineIssue = novelTimelineInstructionIssue(value, story.timelines, `script.${path}`);
        if (timelineIssue !== null) failStory(timelineIssue);
      }
      return;
    case "audio":
      if (!isNonEmptyString(value.cue)) failStory(`${path}.cue is required`);
      if (value.action !== undefined && value.action !== "play" && value.action !== "stop") failStory(`${path}.action must be play or stop`);
      if (value.channel !== undefined && !isNonEmptyString(value.channel)) failStory(`${path}.channel must be non-empty`);
      if (value.channel === NOVEL_VOICE_CHANNEL) failStory(`${path}.channel is reserved for dialogue voice`);
      if (value.loop !== undefined && typeof value.loop !== "boolean") failStory(`${path}.loop must be boolean`);
      {
        const groupIssue = novelAuthoredAudioGroupIssue(value.group, value.action, value.channel, path);
        if (groupIssue !== null) failStory(groupIssue);
      }
      return;
    case "wait": if (!isFiniteNumber(value.durationMs) || value.durationMs < 0) failStory(`${path}.durationMs must be non-negative`); return;
    case "set":
      if (!isNonEmptyString(value.variable) || !isNovelVariableName(value.variable)) failStory(`${path}.variable is invalid`);
      try { copyJson(value.value, `${path}.value`); } catch (error) { failStory(error instanceof Error ? error.message : String(error)); }
      return;
    case "inc":
      if (!isNonEmptyString(value.variable) || !isNovelVariableName(value.variable) || !isFiniteNumber(value.amount)) failStory(`${path} requires a valid variable and finite amount`);
      return;
    case "trade": {
      const tradeFields = ["type", "item", "action", "quantity", "onFailure"];
      if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !tradeFields.includes(key)) ||
          tradeFields.some(key => !Object.hasOwn(value, key))) {
        failStory(`${path} must contain only type, item, action, quantity, and onFailure`);
      }
      if (!isNonEmptyString(value.item) || !story.inventory || !Object.hasOwn(story.inventory.items, value.item)) {
        failStory(`${path}.item references an unknown inventory item`);
      }
      if (value.action !== "buy" && value.action !== "sell" && value.action !== "consume") {
        failStory(`${path}.action must be buy, sell, or consume`);
      }
      if (!isIntegerAtLeast(value.quantity, 1)) failStory(`${path}.quantity must be a positive safe integer`);
      target(value.onFailure, `${path}.onFailure`);
      return;
    }
    case "branch":
      validateCondition(value.when, `${path}.when`); target(value.then, `${path}.then`); target(value.else, `${path}.else`); return;
    case "jump": case "call": target(value.target, `${path}.target`); return;
    case "return": return;
    case "choice":
      if (!isNonEmptyString(value.id) || choiceIds.has(value.id)) failStory(`${path}.id must be unique and non-empty`);
      choiceIds.add(value.id);
      if (value.prompt !== undefined && !isString(value.prompt)) failStory(`${path}.prompt must be a string`);
      if (!Array.isArray(value.options) || value.options.length === 0) failStory(`${path}.options must contain at least one option`);
      {
        const optionIds = new Set<string>();
        value.options.forEach((option: ChoiceOptionDefinition, optionIndex: number) => {
          const optionPath = `${path}.options[${optionIndex}]`;
          if (!record(option) || !isNonEmptyString(option.id) || optionIds.has(option.id) || !isString(option.text)) failStory(`${optionPath} requires a unique id and text`);
          optionIds.add(option.id); target(option.target, `${optionPath}.target`);
          if (option.when !== undefined) validateCondition(option.when, `${optionPath}.when`);
        });
      }
      if (value.timeLimitMs !== undefined || value.timeoutTarget !== undefined) {
        if (!isFiniteNumber(value.timeLimitMs) || value.timeLimitMs < 0 || value.timeoutTarget === undefined) failStory(`${path} requires both a non-negative timeLimitMs and timeoutTarget`);
        target(value.timeoutTarget, `${path}.timeoutTarget`);
      }
      return;
    case "input": {
      const issue = novelInputInstructionIssue(value);
      if (issue !== null) failStory(`${path}: ${issue}`);
      const instruction = value as unknown as NovelInputInstruction;
      if (inputIds.has(instruction.id)) failStory(`input id '${instruction.id}' is duplicated`);
      inputIds.add(instruction.id);
      if (instruction.cancelTarget !== undefined) target(instruction.cancelTarget, `${path}.cancelTarget`);
      return;
    }
    case "video": {
      const issue = novelVideoInstructionIssue(value);
      if (issue !== null) failStory(`${path}: ${issue}`);
      return;
    }
    case "ending":
      if (!isNonEmptyString(value.id)) failStory(`${path}.id is required`);
      if (value.text !== undefined && !isString(value.text)) failStory(`${path}.text must be a string`);
      if (value.cg !== undefined && !isString(value.cg)) failStory(`${path}.cg must be a string`);
      return;
    default: failStory(`${path}.type is unsupported`);
  }
}

function validateMeta(value: unknown, path: string): NovelMetaState {
  if (!record(value)) failSave(`${path} must be an object`);
  const list = (key: string): string[] => {
    const entries = value[key];
    if (!Array.isArray(entries) || !entries.every(isString)) failSave(`${path}.${key} must be an array of strings`);
    return [...new Set(entries)];
  };
  const persistentVariables = value.persistentVariables === undefined
    ? {}
    : validateVariables(value.persistentVariables, `${path}.persistentVariables`);
  const musicIds = value.musicIds === undefined ? [] : list("musicIds");
  return { readLineIds: list("readLineIds"), endingIds: list("endingIds"), cgIds: list("cgIds"), musicIds, persistentVariables };
}

function validatePreferences(value: unknown, path: string): NovelPreferences {
  if (!record(value) || (value.mode !== "manual" && value.mode !== "auto" && value.mode !== "skip") || !isFiniteNumber(value.textSpeedCharsPerSecond) || value.textSpeedCharsPerSecond < 0 || !isFiniteNumber(value.autoDelayMs) || value.autoDelayMs < 0 || typeof value.skipSeenOnly !== "boolean") failSave(`${path} is invalid`);
  return {
    mode: value.mode,
    textSpeedCharsPerSecond: value.textSpeedCharsPerSecond,
    autoDelayMs: value.autoDelayMs,
    skipSeenOnly: value.skipSeenOnly,
  };
}

function interpolate(text: string, variables: Readonly<Record<string, JsonValue>>): string {
  return interpolateNovelText(text, variables);
}

function mergeVariableValues(
  story: StoryDefinition,
  seeds: Readonly<Record<string, JsonValue>>,
  runtime: Readonly<Record<string, JsonValue>>,
  meta: NovelMetaState,
): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, value] of Object.entries(seeds)) values[name] = clone(value);
  for (const [name, value] of Object.entries(runtime)) values[name] = clone(value);
  for (const [name, value] of Object.entries(meta.persistentVariables ?? {})) values[name] = clone(value);
  return values;
}

function validateOptions(options: NovelEngineOptions): EngineInternalOptions {
  const maxBacklogEntries = options.maxBacklogEntries ?? DEFAULT_MAX_BACKLOG;
  const maxRollbackEntries = options.maxRollbackEntries ?? DEFAULT_MAX_ROLLBACK;
  const maxStepBudget = options.maxStepBudget ?? DEFAULT_STEP_BUDGET;
  if (!isIntegerAtLeast(maxBacklogEntries, 1)) throw new RangeError("maxBacklogEntries must be a positive safe integer");
  if (!isIntegerAtLeast(maxRollbackEntries, 1)) throw new RangeError("maxRollbackEntries must be a positive safe integer");
  if (!isIntegerAtLeast(maxStepBudget, 1)) throw new RangeError("maxStepBudget must be a positive safe integer");
  return { maxBacklogEntries, maxRollbackEntries, maxStepBudget };
}

function preferencesFrom(input: NovelPreferences, partial: Partial<NovelPreferences>): NovelPreferences {
  const candidate = { ...input, ...partial };
  const validated = validatePreferences(candidate, "preferences");
  return validated;
}

function variableLifetime(story: StoryDefinition, name: string): NovelVariableLifetime {
  return story.variableDefinitions?.[name]?.lifetime ?? "save";
}

function assertPersistentVariables(meta: NovelMetaState, story: StoryDefinition, path: string): void {
  for (const name of Object.keys(meta.persistentVariables ?? {})) {
    if (variableLifetime(story, name) !== "persistent") failSave(`${path}.${name} is not declared with the persistent lifetime`);
  }
}

function initialVariableSeeds(story: StoryDefinition, options: NovelEngineOptions): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, definition] of Object.entries(story.variableDefinitions ?? {})) {
    if (Object.hasOwn(definition, "defaultValue")) values[name] = clone(definition.defaultValue as JsonValue);
  }
  if (options.initialVariables !== undefined) {
    try {
      const copied = copyJson(options.initialVariables, "initialVariables");
      if (!record(copied)) throw new NovelEngineError("initialVariables must be an object");
      for (const [name, value] of Object.entries(copied)) {
        if (!isNovelVariableName(name)) throw new NovelEngineError(`initialVariables has an invalid variable name '${name}'`);
        values[name] = value;
      }
    } catch (error) { throw new StoryValidationError(error instanceof Error ? error.message : String(error)); }
  }
  return values;
}

function initialRuntimeVariables(story: StoryDefinition, seeds: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, value] of Object.entries(seeds)) {
    if (variableLifetime(story, name) !== "persistent") result[name] = clone(value);
  }
  return result;
}

function initialState(story: StoryDefinition, options: NovelEngineOptions, prefs: NovelPreferences, seeds: Readonly<Record<string, JsonValue>>): MutableState {
  const meta = options.initialMeta === undefined ? emptyMeta() : validateMeta(options.initialMeta, "initialMeta");
  return {
    started: false,
    location: location(story.start),
    variables: initialRuntimeVariables(story, seeds),
    stage: emptyStage(),
    active: null,
    callStack: [],
    backlog: [],
    nextBacklogSequence: 1,
    rollbackHistory: [],
    meta,
    audioIntents: {},
    preferences: prefs,
    paused: false,
    eventSequence: 0,
    transitionSequence: 0,
  };
}

function validModelIntent(value: unknown): boolean {
  return record(value) && isNonEmptyString(value.key)
    && (value.animation === undefined || isNonEmptyString(value.animation))
    && (value.skin === undefined || isNonEmptyString(value.skin))
    && (value.loop === undefined || typeof value.loop === "boolean")
    && (value.expression === undefined || isNonEmptyString(value.expression))
    && Object.keys(value).every(key => ["key", "animation", "skin", "expression", "loop"].includes(key));
}

function restoreStage(
  value: unknown,
  path: string,
  allowTransition = true,
  allowCameraMotion = true,
  timelines?: StoryDefinition["timelines"],
): StageState {
  if (!record(value) || (value.background !== null && !isString(value.background)) || !record(value.characters)) failSave(`${path} is invalid`);
  let backgroundLayers: NovelBackgroundLayer[] | undefined;
  if (value.backgroundLayers !== undefined) {
    const issue = novelBackgroundLayersIssue(value.backgroundLayers, `${path}.backgroundLayers`);
    if (issue !== null) failSave(issue);
    const layers = value.backgroundLayers as readonly NovelBackgroundLayer[];
    if (layers.length > 0) backgroundLayers = layers.map(layer => ({ background: layer.background, parallax: layer.parallax }));
  }
  let objects: NovelSceneObject[] | undefined;
  if (value.objects !== undefined) {
    const issue = novelSceneObjectsIssue(value.objects, `${path}.objects`);
    if (issue !== null) failSave(issue);
    objects = (value.objects as readonly NovelSceneObject[]).map(object => clone(object));
  }
  const characters: Record<string, StageCharacter> = Object.create(null) as Record<string, StageCharacter>;
  for (const [id, entry] of Object.entries(value.characters)) {
    if (!record(entry) || entry.id !== id || !isString(entry.expression) || typeof entry.visible !== "boolean") failSave(`${path}.characters.${id} is invalid`);
    let position: CharacterPosition;
    try {
      position = validateCharacterPosition(entry.position, `${path}.characters.${id}.position`);
      validateCharacterTransform(entry, `${path}.characters.${id}`);
    }
    catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
    if (entry.model !== undefined && !validModelIntent(entry.model)) failSave(`${path}.characters.${id}.model is invalid`);
    characters[id] = { id, expression: entry.expression, position, visible: entry.visible,
      ...(entry.scale === undefined ? {} : { scale: entry.scale as number }),
      ...(entry.rotation === undefined ? {} : { rotation: entry.rotation as number }),
      ...(entry.layer === undefined ? {} : { layer: entry.layer as number }),
      ...(entry.model === undefined ? {} : { model: clone(entry.model) as unknown as StageCharacter["model"] }) };
  }
  let transition: StageState["transition"] = null;
  if (value.transition !== null) {
    if (!allowTransition) failSave(`${path} cannot contain a nested transition`);
    const candidate = value.transition;
    if (!record(candidate) || !isIntegerAtLeast(candidate.id, 1) || (candidate.kind !== "cut" && candidate.kind !== "fade" && candidate.kind !== "dissolve" && candidate.kind !== "reveal") || !isFiniteNumber(candidate.durationMs) || candidate.durationMs < 0 || !isFiniteNumber(candidate.elapsedMs) || candidate.elapsedMs < 0 || candidate.elapsedMs > candidate.durationMs) failSave(`${path}.transition is invalid`);
    if (candidate.kind === "reveal") {
      if (candidate.direction !== undefined && candidate.direction !== "left" && candidate.direction !== "right" && candidate.direction !== "up" && candidate.direction !== "down") failSave(`${path}.transition.direction is invalid`);
      transition = { id: candidate.id, kind: "reveal", direction: (candidate.direction ?? "left") as RevealTransitionDirection, durationMs: candidate.durationMs, elapsedMs: candidate.elapsedMs };
    } else {
      if (Object.hasOwn(candidate, "direction")) failSave(`${path}.transition.direction is only valid for reveal`);
      transition = { id: candidate.id, kind: candidate.kind, durationMs: candidate.durationMs, elapsedMs: candidate.elapsedMs };
    }
    if (candidate.from !== undefined) {
      if (!record(candidate.from) || "transition" in candidate.from || "timeline" in candidate.from) failSave(`${path}.transition.from must contain only a composition`);
      const previous = restoreStage({ ...candidate.from, transition: null }, `${path}.transition.from`, false, false);
      transition = {
        ...transition,
        from: {
          background: previous.background,
          ...(previous.backgroundLayers === undefined ? {} : { backgroundLayers: previous.backgroundLayers }),
          characters: previous.characters,
          ...(previous.objects === undefined ? {} : { objects: previous.objects }),
          ...(candidate.from.camera === undefined ? {} : { camera: { x: previous.camera.x, y: previous.camera.y, scale: previous.camera.scale } }),
        },
      };
    }
  }
  let camera: StageState["camera"] = { ...DEFAULT_NOVEL_CAMERA, motion: null };
  if (value.camera !== undefined) {
    const issue = novelCameraStateIssue(value.camera, `${path}.camera`, { allowShakeOffset: !allowCameraMotion, allowMotion: allowCameraMotion });
    if (issue !== null) failSave(issue);
    const candidate = value.camera as Record<string, unknown>;
    const rawMotion = candidate.motion;
    let motion: StageState["camera"]["motion"] = null;
    if (rawMotion !== null && rawMotion !== undefined) {
      const current = rawMotion as Record<string, unknown>;
      const from = current.from as Record<string, number>;
      motion = {
        from: { x: from.x, y: from.y, scale: from.scale },
        elapsedMs: current.elapsedMs as number,
        durationMs: current.durationMs as number,
        easing: current.easing as "linear" | "easeInOut",
        ...(current.shake === undefined ? {} : { shake: clone(current.shake) as { amplitude: number; cycles: number } }),
      };
    }
    camera = { x: candidate.x as number, y: candidate.y as number, scale: candidate.scale as number, motion };
  }
  let timeline: NovelTimelineState | null = null;
  let timelineDefinition: NovelTimelineDefinition | undefined;
  if (value.timeline !== undefined && value.timeline !== null) {
    const candidate = value.timeline;
    if (!record(candidate) || Reflect.ownKeys(candidate).some(key => key !== "id" && key !== "elapsedMs") ||
        !isNonEmptyString(candidate.id) || !isFiniteNumber(candidate.elapsedMs)) {
      failSave(`${path}.timeline must contain only a preset id and finite elapsedMs`);
    }
    timelineDefinition = timelines?.[candidate.id as string];
    if (!timelineDefinition || !Object.hasOwn(timelines ?? {}, candidate.id as string)) failSave(`${path}.timeline.id references an unknown preset`);
    if ((candidate.elapsedMs as number) < 0 || (candidate.elapsedMs as number) >= timelineDefinition.durationMs) {
      failSave(`${path}.timeline.elapsedMs must be between zero and durationMs, exclusive at the end`);
    }
    for (const actor of timelineDefinition.actors ?? []) {
      if (!Object.hasOwn(characters, actor.id)) failSave(`${path}.timeline preset '${candidate.id as string}' targets missing actor '${actor.id}'`);
    }
    if (timelineDefinition.camera !== undefined && camera.motion !== null) failSave(`${path}.timeline camera track cannot overlap camera motion`);
    timeline = { id: candidate.id as string, elapsedMs: candidate.elapsedMs as number };
  }
  let video: NovelVideoOverlayState | null = null;
  if (value.video !== undefined && value.video !== null) {
    const issue = novelVideoOverlayStateIssue(value.video);
    if (issue !== null) failSave(`${path}.video ${issue}`);
    const candidate = value.video as NovelVideoOverlayState;
    video = {
      cue: candidate.cue,
      loop: candidate.loop,
      positionMs: candidate.positionMs,
      durationMs: candidate.durationMs,
      status: candidate.status,
    };
  }
  const restoredStage: StageState = {
    background: value.background as string | null,
    ...(backgroundLayers === undefined ? {} : { backgroundLayers }),
    characters,
    ...(objects === undefined ? {} : { objects }),
    transition,
    ...(timeline === null ? {} : { timeline }),
    video,
    camera,
  };
  if (timeline !== null && timelineDefinition !== undefined) {
    const issue = timelinePoseIssue(restoredStage, timelineDefinition, timeline.elapsedMs, path);
    if (issue !== null) failSave(issue);
  }
  return restoredStage;
}

function restoreAudioIntents(value: unknown, path: string): Record<string, NovelAudioIntent> {
  if (!record(value)) failSave(`${path} must be an object`);
  const result: Record<string, NovelAudioIntent> = Object.create(null) as Record<string, NovelAudioIntent>;
  for (const [channel, intent] of Object.entries(value)) {
    if (!isNonEmptyString(channel) || !record(intent) || (intent.action !== "play" && intent.action !== "stop") || !isNonEmptyString(intent.cue) || typeof intent.loop !== "boolean") failSave(`${path}.${channel} is invalid`);
    const groupIssue = novelAuthoredAudioGroupIssue(intent.group, intent.action, channel, `${path}.${channel}`);
    if (groupIssue !== null) failSave(groupIssue);
    if (intent.gain !== undefined && (intent.action !== "play" || !isFiniteNumber(intent.gain) || intent.gain < 0 || intent.gain > 1)) {
      failSave(`${path}.${channel}.gain must be a finite play-intent gain between 0 and 1`);
    }
    result[channel] = {
      action: intent.action,
      cue: intent.cue,
      loop: intent.loop,
      ...(intent.group === undefined ? {} : { group: intent.group as NovelAuthoredAudioGroup }),
      ...(intent.gain === undefined ? {} : { gain: intent.gain as number }),
    };
  }
  return result;
}

function resolveActive(story: StoryDefinition, active: unknown, variables: Readonly<Record<string, JsonValue>>, prefs: NovelPreferences, path: string): ActiveNovelState | null {
  if (active === null) return null;
  if (!record(active) || !isString(active.kind)) failSave(`${path} is invalid`);
  let activeLocation: ScriptPosition;
  try { activeLocation = validatePosition(active.location, story, `${path}.location`, false); }
  catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
  const instruction = story.script[activeLocation.label]![activeLocation.index]!;
  if (instruction.type !== active.kind) failSave(`${path} does not match its story instruction`);
  if (active.kind === "say" && instruction.type === "say") {
    let resolved: ReturnType<typeof resolveNovelSayRich>;
    try { resolved = resolveNovelSayRich(instruction.text, variables, instruction.rich); }
    catch (error) { failSave(`${path} rich state cannot be resolved: ${error instanceof Error ? error.message : String(error)}`); }
    const text = resolved.text;
    const points = codePoints(text);
    if (active.id !== instruction.id || active.speaker !== (instruction.speaker ?? null) || active.portrait !== (instruction.portrait ?? null)
      || !isString(active.text) || !isFiniteNumber(active.revealProgress) || active.revealProgress < 0
      || !isIntegerAtLeast(active.revealedCharacters, 0) || active.revealedCharacters !== Math.floor(active.revealProgress)
      || typeof active.complete !== "boolean"
      || (active.autoRemainingMs !== null && (!isFiniteNumber(active.autoRemainingMs) || active.autoRemainingMs < 0))) {
      failSave(`${path} say state is inconsistent`);
    }
    // First validate the saved display against its own text. An Editor may
    // update copy without changing story identity, location, or dialogue ID;
    // in that case keep its revealed fraction while showing the current
    // instruction text. This mirrors locale rebasing without accepting a
    // tampered visible prefix or weakening any address/identity checks.
    const savedPoints = codePoints(active.text);
    if (active.revealProgress > savedPoints.length
      || active.visibleText !== savedPoints.slice(0, active.revealedCharacters).join("")
      || active.complete !== (active.revealedCharacters >= savedPoints.length)) {
      failSave(`${path} say state is inconsistent`);
    }
    const savedRevealedCharacters = active.revealedCharacters as number;
    const textChanged = active.text !== text;
    let revealProgress = !textChanged
      ? active.revealProgress
      : active.complete
        ? points.length
        : savedPoints.length === 0
          ? 0
          : Math.min(points.length, Math.max(0, active.revealProgress / savedPoints.length * points.length));
    const savedRichValue = active.rich;
    let savedRich: NovelSayRich | undefined;
    if (savedRichValue !== undefined) {
      const issue = novelSayRichIssue(active.text, savedRichValue);
      if (issue !== null) failSave(`${path}.rich is invalid: ${issue}`);
      savedRich = savedRichValue as NovelSayRich;
    }
    const rich: NovelSayRich | undefined = !textChanged && savedRich !== undefined ? savedRich : resolved.rich;
    const savedPauseCursor = active.pauseCursor;
    if (savedPauseCursor !== undefined) {
      const maximumCursor = savedRich?.pauses.length ?? rich?.pauses.length ?? 0;
      if (!Number.isSafeInteger(savedPauseCursor) || (savedPauseCursor as number) < 0 || (savedPauseCursor as number) > maximumCursor) {
        failSave(`${path}.pauseCursor is invalid`);
      }
    }
    let pauseCursor = 0;
    let pause: NovelSayPauseState | null = null;
    if (rich !== undefined) {
      if (!textChanged && Number.isSafeInteger(savedPauseCursor) && (savedPauseCursor as number) >= 0 && (savedPauseCursor as number) <= rich.pauses.length) {
        pauseCursor = savedPauseCursor as number;
      } else if (!textChanged && savedRich !== undefined) {
        // Save data written before pause cursors existed is interpreted by
        // stable pause identity, then by the historical reveal boundary.
        const oldCursor = Number.isSafeInteger(savedPauseCursor) && (savedPauseCursor as number) >= 0
          ? Math.min(savedRich.pauses.length, savedPauseCursor as number)
          : savedRich.pauses.filter(marker => marker.at <= savedRevealedCharacters).length;
        const consumed = new Set(savedRich.pauses.slice(0, oldCursor).map(marker => marker.id));
        while (pauseCursor < rich.pauses.length && consumed.has(rich.pauses[pauseCursor]!.id)) pauseCursor++;
      } else {
        // Old saves have no annotation cursor. Treat markers at or before the
        // saved visible prefix as already passed so adding rich metadata does
        // not unexpectedly replay a pause in the middle of a line.
        pauseCursor = rich.pauses.filter(marker => marker.at <= savedRevealedCharacters).length;
      }
      const currentMarker = rich.pauses[pauseCursor];
      const savedPause = active.pause;
      if (savedPause !== undefined && savedPause !== null && !record(savedPause)) failSave(`${path}.pause is inconsistent`);
      if (savedPause != null && (currentMarker === undefined || savedPause.id !== currentMarker.id)) failSave(`${path}.pause is inconsistent`);
      if (currentMarker !== undefined && record(savedPause) && savedPause.id === currentMarker.id) {
        if (currentMarker.durationMs === null) {
          if (savedPause.remainingMs !== null) failSave(`${path}.pause is inconsistent`);
          pause = { id: currentMarker.id, remainingMs: null };
        } else {
          if (!isFiniteNumber(savedPause.remainingMs) || savedPause.remainingMs < 0
            || (!textChanged && savedPause.remainingMs > currentMarker.durationMs)) failSave(`${path}.pause is inconsistent`);
          pause = { id: currentMarker.id, remainingMs: Math.min(currentMarker.durationMs, savedPause.remainingMs) };
        }
      } else if (currentMarker !== undefined && currentMarker.at <= Math.floor(revealProgress)) {
        // Text edits can move a marker behind the saved prefix. Stop at that
        // boundary and let the player consume it before revealing further.
        revealProgress = currentMarker.at;
        pause = { id: currentMarker.id, remainingMs: currentMarker.durationMs };
      }
    } else if (active.pauseCursor !== undefined || active.pause !== undefined) {
      failSave(`${path} has pause state without rich annotations`);
    }
    const revealedCharacters = Math.floor(revealProgress);
    if (pause !== null && rich !== undefined) {
      const marker = rich.pauses[pauseCursor]!;
      if (revealedCharacters !== marker.at) failSave(`${path}.pause does not match the reveal boundary`);
    }
    const complete = revealedCharacters >= points.length;
    const readyForAdvance = complete && pause === null && (rich === undefined || pauseCursor >= rich.pauses.length);
    return {
      kind: "say", location: activeLocation, id: instruction.id,
      speaker: instruction.speaker ?? null, portrait: instruction.portrait ?? null, text,
      ...(rich === undefined ? {} : { rich, pauseCursor, pause }),
      revealProgress, visibleText: points.slice(0, revealedCharacters).join(""), revealedCharacters, complete,
      autoRemainingMs: readyForAdvance ? active.autoRemainingMs : null,
    };
  }
  if (active.kind === "choice" && instruction.type === "choice") {
    const expected = instruction.options.filter(option => !option.when || evaluateNovelCondition(option.when, variables)).map(option => ({ id: option.id, text: interpolate(option.text, variables), target: option.target }));
    if (active.id !== instruction.id || active.prompt !== (instruction.prompt === undefined ? null : interpolate(instruction.prompt, variables)) || !Array.isArray(active.options) || active.options.length !== expected.length || active.options.some((option, index) => !record(option) || option.id !== expected[index]!.id || option.text !== expected[index]!.text || option.target !== expected[index]!.target)) failSave(`${path} choice state is inconsistent`);
    let timeRemainingMs: number | null;
    if (instruction.timeLimitMs === undefined) {
      if (active.timeRemainingMs !== null) failSave(`${path} choice timer is invalid`);
      timeRemainingMs = null;
    } else {
      if (!isFiniteNumber(active.timeRemainingMs) || active.timeRemainingMs < 0 || active.timeRemainingMs > instruction.timeLimitMs) failSave(`${path} choice timer is invalid`);
      timeRemainingMs = active.timeRemainingMs;
    }
    return { kind: "choice", location: activeLocation, id: instruction.id, prompt: instruction.prompt === undefined ? null : interpolate(instruction.prompt, variables), options: expected, timeRemainingMs };
  }
  if (active.kind === "input" && instruction.type === "input") {
    const input = instruction as NovelInputInstruction;
    const inputKeys = ["kind", "location", "id", "variable", "inputType", "prompt", "placeholder", "draft", "canCancel", "error"];
    if (Object.keys(active).some(key => !inputKeys.includes(key)) || inputKeys.some(key => !Object.hasOwn(active, key))) {
      failSave(`${path} input state has an invalid shape`);
    }
    const expectedPrompt = input.prompt === undefined ? null : interpolate(input.prompt, variables);
    const expectedPlaceholder = input.inputType === "boolean" || input.placeholder === undefined
      ? null
      : interpolate(input.placeholder, variables);
    if (active.id !== input.id || active.variable !== input.variable || active.inputType !== input.inputType
      || active.prompt !== expectedPrompt || active.placeholder !== expectedPlaceholder
      || active.canCancel !== (input.cancelTarget !== undefined)) {
      failSave(`${path} input identity or display state is inconsistent`);
    }
    if (input.inputType === "boolean") {
      if (typeof active.draft !== "boolean") failSave(`${path} boolean input draft is invalid`);
    } else {
      if (!isString(active.draft)) failSave(`${path} ${input.inputType} input draft is invalid`);
      const draftLength = codePoints(active.draft).length;
      const draftLimit = input.inputType === "number" ? NOVEL_INPUT_NUMBER_RAW_LIMIT : NOVEL_INPUT_TEXT_RAW_LIMIT;
      if (draftLength > draftLimit) failSave(`${path} input draft exceeds its raw limit`);
    }
    const expectedValidation = validateNovelInputDraft(input, active.draft as string | boolean);
    let error: NovelInputValidationError | null = null;
    if (active.error !== null) {
      if (expectedValidation.valid || !record(active.error)) failSave(`${path} input error does not match its draft`);
      const expectedError = expectedValidation.error;
      const expectedErrorKeys = expectedError.limit === undefined ? ["code"] : ["code", "limit"];
      if (Object.keys(active.error).some(key => !expectedErrorKeys.includes(key))
        || expectedErrorKeys.some(key => !Object.hasOwn(active.error as PlainRecord, key))
        || active.error.code !== expectedError.code
        || (expectedError.limit === undefined ? active.error.limit !== undefined : active.error.limit !== expectedError.limit)) {
        failSave(`${path} input error does not match its draft`);
      }
      error = expectedError;
    }
    return {
      kind: "input", location: activeLocation, id: input.id, variable: input.variable,
      inputType: input.inputType, prompt: expectedPrompt, placeholder: expectedPlaceholder,
      draft: active.draft as string | boolean, canCancel: input.cancelTarget !== undefined, error,
    };
  }
  if (active.kind === "wait" && instruction.type === "wait") {
    if (active.durationMs !== instruction.durationMs || !isFiniteNumber(active.remainingMs) || active.remainingMs < 0 || active.remainingMs > instruction.durationMs) failSave(`${path} wait state is inconsistent`);
    return { kind: "wait", location: activeLocation, durationMs: instruction.durationMs, remainingMs: active.remainingMs };
  }
  if (active.kind === "ending" && instruction.type === "ending") {
    const text = instruction.text === undefined ? "" : interpolate(instruction.text, variables);
    const cg = instruction.cg ?? null;
    if (active.id !== instruction.id || active.text !== text || active.cg !== cg) failSave(`${path} ending state is inconsistent`);
    return { kind: "ending", location: activeLocation, id: instruction.id, text, cg };
  }
  failSave(`${path} has an unsupported active state`);
}

function validateCallStack(value: unknown, story: StoryDefinition, path: string): CallStackFrame[] {
  if (!Array.isArray(value)) failSave(`${path} must be an array`);
  return value.map((entry, index) => {
    if (!record(entry)) failSave(`${path}[${index}] is invalid`);
    let returnTo: ScriptPosition;
    try { returnTo = validatePosition(entry.returnTo, story, `${path}[${index}].returnTo`); }
    catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
    return { returnTo };
  });
}

function validateVariables(value: unknown, path: string): Record<string, JsonValue> {
  try {
    const copied = copyJson(value, path);
    if (!record(copied)) failSave(`${path} must be an object`);
    for (const name of Object.keys(copied)) if (!isNovelVariableName(name)) failSave(`${path} has an invalid variable name '${name}'`);
    return copied;
  } catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
}

function resolveCheckpointActive(
  story: StoryDefinition,
  activeValue: unknown,
  variables: Readonly<Record<string, JsonValue>>,
  index: number,
): ActiveNovelState {
  const path = `save.state.rollbackHistory[${index}].active`;
  if (!record(activeValue) || activeValue.kind !== "say") {
    const active = resolveActive(story, activeValue, variables, DEFAULT_PREFERENCES, path);
    if (active?.kind !== "say") failSave(`save.state.rollbackHistory[${index}] must point at a completed dialogue line`);
    return active;
  }
  let activeLocation: ScriptPosition;
  try { activeLocation = validatePosition(activeValue.location, story, `${path}.location`, false); }
  catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
  const instruction = story.script[activeLocation.label]![activeLocation.index]!;
  if (instruction.type !== "say" || activeValue.id !== instruction.id) failSave(`${path} does not match its dialogue instruction`);
  const dependsOnPersistentValue = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
  let match: RegExpExecArray | null;
  let historicalText = false;
  while ((match = dependsOnPersistentValue.exec(instruction.text)) !== null) {
    if (variableLifetime(story, match[1]!) === "persistent") { historicalText = true; break; }
  }
  if (!historicalText) {
    const active = resolveActive(story, activeValue, variables, DEFAULT_PREFERENCES, path);
    if (active?.kind !== "say") failSave(`save.state.rollbackHistory[${index}] must point at a completed dialogue line`);
    return active;
  }
  const text = activeValue.text;
  if (!isString(text)) failSave(`${path}.text must be a string`);
  const points = codePoints(text);
  if (activeValue.speaker !== (instruction.speaker ?? null) || activeValue.portrait !== (instruction.portrait ?? null)
    || !isFiniteNumber(activeValue.revealProgress) || activeValue.revealProgress !== points.length
    || activeValue.revealedCharacters !== points.length || activeValue.visibleText !== text
    || activeValue.complete !== true
    || (activeValue.autoRemainingMs !== null && (!isFiniteNumber(activeValue.autoRemainingMs) || activeValue.autoRemainingMs < 0))) {
    failSave(`${path} say state is inconsistent`);
  }
  return {
    kind: "say", location: activeLocation, id: instruction.id,
    speaker: instruction.speaker ?? null, portrait: instruction.portrait ?? null, text,
    revealProgress: points.length, visibleText: text, revealedCharacters: points.length,
    complete: true, autoRemainingMs: activeValue.autoRemainingMs,
    ...(activeValue.rich === undefined ? {} : (() => {
      const issue = novelSayRichIssue(text, activeValue.rich);
      if (issue !== null) failSave(`${path}.rich is invalid: ${issue}`);
      return { rich: activeValue.rich as NovelSayRich, pauseCursor: (activeValue.rich as NovelSayRich).pauses.length, pause: null };
    })()),
  };
}

function validateCheckpoint(
  story: StoryDefinition,
  value: unknown,
  index: number,
  seeds: Readonly<Record<string, JsonValue>>,
  meta: NovelMetaState,
): RollbackCheckpoint {
  const path = `save.state.rollbackHistory[${index}]`;
  if (!record(value) || !isIntegerAtLeast(value.backlogSequence, 0)) failSave(`${path} is invalid`);
  let checkpointLocation: ScriptPosition;
  try { checkpointLocation = validatePosition(value.location, story, `${path}.location`); }
  catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
  const serializedVariables = validateVariables(value.variables, `${path}.variables`);
  const variables: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, variableValue] of Object.entries(serializedVariables)) {
    if (variableLifetime(story, name) !== "persistent") variables[name] = variableValue;
  }
  const stage = restoreStage(value.stage, `${path}.stage`, true, true, story.timelines);
  const active = resolveCheckpointActive(story, value.active, mergeVariableValues(story, seeds, variables, meta), index);
  if (active.kind !== "say" || !active.complete) failSave(`${path} must point at a completed dialogue line`);
  if (!sameLocation(checkpointLocation, nextPosition(active.location))) failSave(`${path}.location does not follow its active line`);
  const callStack = validateCallStack(value.callStack, story, `${path}.callStack`);
  const audioIntents = restoreAudioIntents(value.audioIntents, `${path}.audioIntents`);
  if (stage.timeline) {
    const definition = story.timelines?.[stage.timeline.id];
    if (definition) {
      const issue = timelineAudioGainIssue(audioIntents, definition, stage.timeline.elapsedMs, path);
      if (issue !== null) failSave(issue);
    }
  }
  return { location: checkpointLocation, variables, stage, active, callStack, backlogSequence: value.backlogSequence, audioIntents };
}

function normalizeStoryMeta(initial: NovelMetaState | undefined, story: StoryDefinition): NovelMetaState {
  if (initial === undefined) return emptyMeta();
  try {
    const meta = validateMeta(initial, "initialMeta");
    assertPersistentVariables(meta, story, "initialMeta.persistentVariables");
    return meta;
  }
  catch (error) { throw new StoryValidationError(error instanceof Error ? error.message : String(error)); }
}

/** Creates a deterministic, data-only story engine. All time arrives through tick(ms). */
export function createNovelEngine(storyInput: StoryDefinition, options: NovelEngineOptions = {}): NovelEngine {
  const story = validateStoryDefinition(storyInput);
  const limits = validateOptions(options);
  let preferences: NovelPreferences;
  try { preferences = preferencesFrom(DEFAULT_PREFERENCES, options.preferences ?? {}); }
  catch (error) { throw new StoryValidationError(error instanceof Error ? error.message : String(error)); }
  // Validate meta at construction, then pass the normalized value through one path.
  const normalizedMeta = normalizeStoryMeta(options.initialMeta, story);
  const seeds = deepFreeze(initialVariableSeeds(story, options));
  const state = initialState(story, { ...options, initialMeta: normalizedMeta }, preferences, seeds);
  const listeners = new Set<EngineListener>();
  const executionTraceListeners = new Set<NovelExecutionTraceListener>();
  const breakpoints = new Set<string>();
  let disposed = false;
  let breakpointStopKey: string | null = null;
  let activeExecutionTrace: NovelExecutionTraceEntry[] | null = null;
  const executionTraceQueue: Array<{
    readonly entries: readonly NovelExecutionTraceEntry[];
    readonly listeners: readonly NovelExecutionTraceListener[];
  }> = [];
  let transactionNotificationDepth = 0;
  let dispatchingExecutionTrace = false;
  const engineInstance = ++engineInstanceSequence;
  let voiceSequence = 0;
  let voice: NovelVoicePlaybackState | null = null;
  let videoSequence = 0;
  let videoToken: string | null = null;

  const readIds = (): Set<string> => new Set(state.meta.readLineIds);
  const currentInstruction = (where = state.location): StoryInstruction | undefined => story.script[where.label]?.[where.index];
  const renewVoice = (): void => {
    const active = state.active;
    const instruction = active?.kind === "say" ? currentInstruction(active.location) : undefined;
    voice = active?.kind === "say" && instruction?.type === "say" && instruction.voice
      ? { token: `voice-${engineInstance}-${++voiceSequence}`, lineId: active.id, cue: instruction.voice, status: "pending" }
      : null;
  };
  const renewVideoToken = (): string | null => {
    if (state.stage.video === null) {
      videoToken = null;
      return null;
    }
    videoToken = `video-${engineInstance}-${++videoSequence}`;
    return videoToken;
  };

  const effectiveVariables = (
    runtime: Readonly<Record<string, JsonValue>> = state.variables,
    meta: NovelMetaState = state.meta,
  ): Record<string, JsonValue> => mergeVariableValues(story, seeds, runtime, meta);

  const writeVariable = (name: string, value: JsonValue): void => {
    if (variableLifetime(story, name) === "persistent") {
      state.meta = {
        ...state.meta,
        persistentVariables: { ...(state.meta.persistentVariables ?? {}), [name]: clone(value) },
      };
    } else {
      state.variables = { ...state.variables, [name]: clone(value) };
    }
  };
  const incrementVariable = (name: string, amount: number): void => {
    const current = effectiveVariables()[name] ?? 0;
    if (typeof current !== "number") throw new NovelEngineError(`Cannot increment non-numeric variable '${name}'`);
    const next = current + amount;
    if (!Number.isFinite(next)) throw new NovelEngineError(`Increment of '${name}' produced a non-finite value`);
    writeVariable(name, next);
  };
  const applySceneObjectEffect = (effect: NovelSceneObjectEffect): void => {
    if (effect.type === "set") writeVariable(effect.variable, effect.value);
    else incrementVariable(effect.variable, effect.amount);
  };

  const snapshotActive = (): ActiveNovelState | null => {
    const active = state.active;
    if (active?.kind !== "say") return active;
    const instruction = story.script[active.location.label]?.[active.location.index];
    const presentation = instruction?.type === "say" ? instruction.presentation : undefined;
    // Legacy and explicit dialogue keep the historical snapshot shape; only
    // non-default layouts need an ephemeral render hint.
    return presentation && presentation !== "dialogue"
      ? { ...active, presentation }
      : active;
  };
  const snapshotFromState = (): EngineSnapshot => deepFreeze({
    storyId: story.id,
    storyVersion: story.version,
    phase: disposed ? "disposed" : state.active?.kind ?? "ready",
    started: state.started,
    paused: state.paused,
    location: state.location,
    variables: effectiveVariables(),
    stage: state.stage,
    audioIntents: state.audioIntents,
    voice,
    videoToken,
    active: snapshotActive(),
    callStack: state.callStack,
    backlog: state.backlog,
    meta: state.meta,
    preferences: state.preferences,
    rollbackAvailable: state.rollbackHistory.length,
    eventSequence: state.eventSequence,
  });
  let snapshot = snapshotFromState();

  const ensureLive = (): void => { if (disposed) throw new NovelEngineError("Novel engine is disposed"); };
  const makeUpdate = (events: readonly EngineEvent[] = []): EngineUpdate => {
    if (state.active?.kind !== "say") voice = null;
    snapshot = snapshotFromState();
    const update = deepFreeze({ snapshot, events: clone(events) });
    for (const listener of [...listeners]) {
      try { listener(update); } catch { /* Listener failures must not roll back story state. */ }
    }
    return update;
  };
  const dispatchExecutionTrace = (): void => {
    if (transactionNotificationDepth > 0 || dispatchingExecutionTrace) return;
    dispatchingExecutionTrace = true;
    try {
      while (executionTraceQueue.length > 0) {
        const batch = executionTraceQueue.shift()!;
        for (const listener of batch.listeners) {
          try { listener(batch.entries); } catch { /* Trace observers cannot affect committed engine state. */ }
        }
      }
    } finally {
      dispatchingExecutionTrace = false;
    }
  };
  const transact = (operation: (events: EngineEvent[]) => void): EngineUpdate => {
    ensureLive();
    // State containers are copy-on-write; a shallow checkpoint makes high-frequency
    // clock ticks independent of the bounded backlog and rollback-history sizes.
    const before = { ...state };
    const beforeBreakpointStopKey = breakpointStopKey;
    const beforeVoice = voice;
    const beforeVideoToken = videoToken;
    const events: EngineEvent[] = [];
    const traceEntries = executionTraceListeners.size > 0 ? [] : null;
    activeExecutionTrace = traceEntries;
    try { operation(events); }
    catch (error) {
      activeExecutionTrace = null;
      Object.assign(state, before);
      breakpointStopKey = beforeBreakpointStopKey;
      voice = beforeVoice;
      videoToken = beforeVideoToken;
      throw error;
    }
    activeExecutionTrace = null;
    if (traceEntries?.length) {
      const entries = deepFreeze(traceEntries.map(entry => clone(entry)));
      executionTraceQueue.push({ entries, listeners: [...executionTraceListeners] });
    }
    transactionNotificationDepth++;
    try { return makeUpdate(events); }
    finally {
      transactionNotificationDepth--;
      dispatchExecutionTrace();
    }
  };

  const setLocation = (value: ScriptPosition): void => { state.location = { label: value.label, index: value.index }; };
  const lineProgress = (text: string, progress: number): Pick<Extract<ActiveNovelState, { kind: "say" }>, "revealProgress" | "visibleText" | "revealedCharacters" | "complete"> => {
    const points = codePoints(text);
    const bounded = Math.max(0, Math.min(points.length, progress));
    const revealedCharacters = Math.floor(bounded);
    return { revealProgress: bounded, visibleText: points.slice(0, revealedCharacters).join(""), revealedCharacters, complete: revealedCharacters >= points.length };
  };
  const initializeAutoTimer = (id: string, complete: boolean): number | null => {
    if (!complete || state.preferences.mode === "manual") return null;
    if (state.preferences.mode === "skip") return readIds().has(id) ? 0 : null;
    return state.preferences.autoDelayMs;
  };
  type SayActive = Extract<ActiveNovelState, { kind: "say" }>;
  const nextSayPause = (active: SayActive): NovelSayPause | undefined =>
    active.rich?.pauses[active.pauseCursor ?? 0];
  const sayReadyForAdvance = (active: SayActive): boolean =>
    active.complete && active.pause == null && (active.rich === undefined || (active.pauseCursor ?? 0) >= active.rich.pauses.length);
  const revealSayTo = (active: SayActive, requestedProgress: number): SayActive => {
    const marker = nextSayPause(active);
    const progress = Math.min(requestedProgress, marker?.at ?? codePoints(active.text).length);
    const reveal = lineProgress(active.text, progress);
    if (active.rich === undefined) return { ...active, ...reveal };
    const reachedPause = marker !== undefined && progress >= marker.at;
    const pause: NovelSayPauseState | null = reachedPause
      ? active.pause?.id === marker.id
        ? active.pause
        : { id: marker.id, remainingMs: marker.durationMs }
      : null;
    return { ...active, ...reveal, pauseCursor: active.pauseCursor ?? 0, pause };
  };
  const releaseSayPause = (active: SayActive): SayActive => {
    if (active.rich === undefined || active.pause == null) return active;
    const cursor = active.pauseCursor ?? 0;
    const nextCursor = Math.min(active.rich.pauses.length, cursor + 1);
    const released = { ...active, pauseCursor: nextCursor, pause: null };
    return {
      ...released,
      autoRemainingMs: sayReadyForAdvance(released)
        ? initializeAutoTimer(released.id, true)
        : null,
    };
  };
  const conditionChoiceOptions = (instruction: Extract<StoryInstruction, { type: "choice" }>): ChoiceState["options"] => {
    const variables = effectiveVariables();
    return instruction.options
      .filter(option => !option.when || evaluateNovelCondition(option.when, variables))
      .map(option => ({ id: option.id, text: interpolate(option.text, variables), target: option.target }));
  };

  const emitAudioCue = (
    cue: string,
    action: "play" | "stop",
    channel: string | null,
    loop: boolean,
    at: ScriptPosition,
    events: EngineEvent[],
    sampleActiveTimelineGain = true,
    group?: NovelAuthoredAudioGroup,
  ): void => {
    const effectiveGroup = group ?? (channel === "music" ? "music" : channel === null ? undefined : "effects");
    if (action === "play" && effectiveGroup === "music") {
      const musicIds = state.meta.musicIds ?? [];
      if (!musicIds.includes(cue)) state.meta = { ...state.meta, musicIds: [...musicIds, cue] };
    }
    if (channel !== null) {
      state.audioIntents = {
        ...state.audioIntents,
        [channel]: action === "stop" ? { action, cue, loop: false } : {
          action, cue, loop,
          ...(group === undefined ? {} : { group }),
        },
      };
    }
    state.eventSequence++;
    events.push({
      type: "audioCue",
      sequence: state.eventSequence,
      cue,
      action,
      channel,
      loop: action === "play" && loop,
      ...(action === "play" && group !== undefined ? { group } : {}),
      location: at,
    });
    if (sampleActiveTimelineGain && action === "play" && channel !== null && state.stage.timeline) {
      const definition = story.timelines?.[state.stage.timeline.id];
      if (definition?.audioGains?.some(track => track.channel === channel)) {
        sampleTimelineAudioGains(definition, state.stage.timeline.elapsedMs);
      }
    }
  };

  const sampleTimelineAudioGains = (definition: NovelTimelineDefinition, elapsedMs: number): void => {
    let sampled: Record<string, NovelAudioIntent> | undefined;
    for (const track of definition.audioGains ?? []) {
      const intent = (sampled ?? state.audioIntents)[track.channel];
      if (!intent || intent.action !== "play") continue;
      const gain = sampleNovelTimelineAudioGain(track, elapsedMs);
      if (intent.gain === undefined ? gain === 1 : timelineNumbersMatch(intent.gain, gain)) continue;
      sampled ??= { ...state.audioIntents };
      sampled[track.channel] = gain === 1
        ? {
          action: intent.action,
          cue: intent.cue,
          loop: intent.loop,
          ...(intent.group === undefined ? {} : { group: intent.group }),
        }
        : { ...intent, gain };
    }
    if (sampled !== undefined) state.audioIntents = sampled;
  };

  const applyScene = (
    instruction: Extract<StoryInstruction, { type: "scene" }>,
    events: EngineEvent[],
    executingAt: ScriptPosition,
  ): void => {
    const previousCameraPose = resolveNovelCameraPose(state.stage.camera);
    const characters: Record<string, StageCharacter> = clone(state.stage.characters as Record<string, StageCharacter>);
    for (const id of instruction.remove ?? []) delete characters[id];
    for (const update of instruction.characters ?? []) {
      const previous = characters[update.id];
      characters[update.id] = {
        id: update.id,
        expression: update.expression ?? previous?.expression ?? "neutral",
        position: update.position === undefined ? (previous?.position ?? "center") : clone(update.position),
        visible: update.visible ?? previous?.visible ?? true,
        ...((update.scale ?? previous?.scale) === undefined ? {} : { scale: update.scale ?? previous?.scale }),
        ...((update.rotation ?? previous?.rotation) === undefined ? {} : { rotation: update.rotation ?? previous?.rotation }),
        ...((update.layer ?? previous?.layer) === undefined ? {} : { layer: update.layer ?? previous?.layer }),
        ...((update.model === undefined ? previous?.model : update.model) ? { model: clone(update.model === undefined ? previous!.model! : update.model!) } : {}),
      };
    }
    const timelineId = instruction.timeline ?? null;
    const timelineDefinition = timelineId === null ? undefined : story.timelines?.[timelineId];
    if (timelineId !== null && timelineDefinition === undefined) throw new NovelEngineError(`Scene references unknown timeline preset '${timelineId}'`);
    if (timelineDefinition !== undefined) {
      for (const track of timelineDefinition.actors ?? []) {
        if (!Object.hasOwn(characters, track.id)) {
          throw new NovelEngineError(`Scene timeline '${timelineId}' targets missing actor '${track.id}'`);
        }
      }
    }
    const previousTransition = instruction.transition;
    let transition: StageState["transition"] = null;
    if (previousTransition && previousTransition.kind !== "cut" && previousTransition.durationMs > 0) {
      state.transitionSequence++;
      const from = {
        background: state.stage.background,
        ...(state.stage.backgroundLayers === undefined ? {} : { backgroundLayers: state.stage.backgroundLayers }),
        characters: state.stage.characters,
        ...(state.stage.objects === undefined ? {} : { objects: state.stage.objects }),
        camera: previousCameraPose,
      };
      transition = previousTransition.kind === "reveal"
        ? { id: state.transitionSequence, kind: "reveal", direction: previousTransition.direction ?? "left", durationMs: previousTransition.durationMs, elapsedMs: 0, from }
        : { id: state.transitionSequence, kind: previousTransition.kind, durationMs: previousTransition.durationMs, elapsedMs: 0, from };
    }
    const camera = instruction.camera === undefined
      ? state.stage.camera
      : {
        x: instruction.camera.x,
        y: instruction.camera.y,
        scale: instruction.camera.scale,
        motion: instruction.cameraMotion === undefined
          ? null
          : createNovelCameraMotionState(previousCameraPose, instruction.cameraMotion),
      };
    const backgroundLayers = instruction.backgroundLayers === undefined
      ? state.stage.backgroundLayers
      : instruction.backgroundLayers.length === 0
        ? undefined
        : instruction.backgroundLayers.map(layer => ({ background: layer.background, parallax: layer.parallax }));
    const objects = instruction.objects === undefined
      ? state.stage.objects
      : instruction.objects.length === 0
        ? undefined
        : instruction.objects.map(object => clone(object));
    let nextStage: StageState = {
      background: instruction.background === undefined ? state.stage.background : instruction.background,
      ...(backgroundLayers === undefined ? {} : { backgroundLayers }),
      characters,
      ...(objects === undefined ? {} : { objects }),
      transition,
      ...(timelineDefinition === undefined ? {} : { timeline: { id: timelineId!, elapsedMs: 0 } }),
      video: state.stage.video,
      camera,
    };
    if (timelineDefinition !== undefined) {
      nextStage = sampleNovelTimeline(nextStage, timelineDefinition, 0);
      for (const cue of orderedTimelineAudio(timelineDefinition)) {
        if (cue.atMs !== 0) break;
        emitAudioCue(cue.cue, cue.action ?? "play", cue.channel ?? null, cue.loop ?? false, executingAt, events, false, cue.group);
      }
      sampleTimelineAudioGains(timelineDefinition, 0);
    }
    state.stage = nextStage;
  };

  const emitVideoCue = (
    events: EngineEvent[],
    action: NovelVideoInstruction["action"],
    overlay: NovelVideoOverlayState,
    token: string,
    at: ScriptPosition,
    positionMs?: number,
  ): void => {
    state.eventSequence++;
    events.push({
      type: "videoCue",
      sequence: state.eventSequence,
      action,
      token,
      cue: overlay.cue,
      loop: overlay.loop,
      ...(positionMs === undefined ? {} : { positionMs }),
      location: at,
    });
  };

  const applyVideo = (instruction: NovelVideoInstruction, events: EngineEvent[], at: ScriptPosition): void => {
    const current = state.stage.video;
    if (instruction.action === "play") {
      const sameCue = current?.cue === instruction.cue;
      const overlay: NovelVideoOverlayState = {
        cue: instruction.cue,
        loop: instruction.loop ?? false,
        positionMs: sameCue && current.status !== "ended" ? current.positionMs : 0,
        durationMs: sameCue ? current.durationMs : null,
        status: "playing",
      };
      state.stage = { ...state.stage, video: overlay };
      const token = renewVideoToken()!;
      emitVideoCue(events, "play", overlay, token, at, overlay.positionMs);
      return;
    }
    if (instruction.action === "pause") {
      if (current === null) return;
      const overlay = { ...current, status: "paused" as const };
      state.stage = { ...state.stage, video: overlay };
      const token = renewVideoToken()!;
      emitVideoCue(events, "pause", overlay, token, at);
      return;
    }
    if (instruction.action === "close") {
      if (current === null) return;
      const token = videoToken ?? renewVideoToken()!;
      state.stage = { ...state.stage, video: null };
      renewVideoToken();
      emitVideoCue(events, "close", current, token, at);
      return;
    }
    if (current === null) throw new NovelEngineError("Cannot seek without an active video overlay");
    const issue = novelVideoSeekIssue(instruction.positionMs, current.durationMs);
    if (issue !== null) throw new NovelEngineError(issue);
    // Seek is a command, not a position fact. Keep the old position until the
    // native player reports its real post-seek snapshot.
    const overlay: NovelVideoOverlayState = current.status === "ended"
      ? { ...current, status: "paused" }
      : current;
    state.stage = { ...state.stage, video: overlay };
    const token = renewVideoToken()!;
    emitVideoCue(events, "seek", overlay, token, at, instruction.positionMs);
  };

  const jumpToLabel = (label: string): void => { setLocation(location(label)); };
  const traceInstruction = (instruction: StoryInstruction, at: ScriptPosition): void => {
    if (activeExecutionTrace === null) return;
    const id = "id" in instruction && typeof instruction.id === "string" ? instruction.id : undefined;
    activeExecutionTrace.push(id === undefined
      ? { location: clone(at), op: instruction.type }
      : { location: clone(at), op: instruction.type, id });
  };
  const runUntilBlocking = (events: EngineEvent[], ignoreBreakpoint: string | null = null): void => {
    let steps = 0;
    let ignoreBreakpointOnce = ignoreBreakpoint;
    while (state.started && state.active === null) {
      if (steps >= limits.maxStepBudget) throw new StepBudgetExceededError(limits.maxStepBudget);
      const instruction = currentInstruction();
      if (instruction === undefined) {
        if (state.callStack.length > 0) {
          steps++;
          const frame = state.callStack[state.callStack.length - 1]!;
          if (activeExecutionTrace !== null) {
            activeExecutionTrace.push({
              location: clone(state.location),
              op: "implicitReturn",
              returnTo: clone(frame.returnTo),
            });
          }
          state.callStack = state.callStack.slice(0, -1);
          setLocation(frame.returnTo);
          continue;
        }
        return;
      }
      const at = locationKey(state.location);
      const skipCurrentBreakpoint = at === ignoreBreakpointOnce;
      ignoreBreakpointOnce = null;
      if (breakpoints.has(at) && !skipCurrentBreakpoint) {
        state.paused = true;
        breakpointStopKey = at;
        return;
      }
      if (activeExecutionTrace !== null) traceInstruction(instruction, state.location);
      steps++;
      const executingAt = clone(state.location);
      setLocation(nextPosition(executingAt));
      const variables = effectiveVariables();
      switch (instruction.type) {
        case "say": {
          const resolved = resolveNovelSayRich(instruction.text, variables, instruction.rich);
          const initial: SayActive = {
            kind: "say", location: executingAt, id: instruction.id,
            speaker: instruction.speaker ?? null, portrait: instruction.portrait ?? null, text: resolved.text,
            ...(resolved.rich === undefined ? {} : { rich: resolved.rich, pauseCursor: 0, pause: null }),
            ...lineProgress(resolved.text, 0), autoRemainingMs: null,
          };
          const reveal = revealSayTo(initial,
            state.preferences.textSpeedCharsPerSecond === 0 ? codePoints(resolved.text).length : 0);
          state.active = { ...reveal, autoRemainingMs: sayReadyForAdvance(reveal) ? initializeAutoTimer(instruction.id, true) : null };
          renewVoice();
          return;
        }
        case "scene": applyScene(instruction, events, executingAt); break;
        case "video": applyVideo(instruction, events, executingAt); break;
        case "audio": {
          const action = instruction.action ?? "play";
          const channel = instruction.channel ?? null;
          const loop = instruction.loop ?? false;
          emitAudioCue(instruction.cue, action, channel, loop, executingAt, events, true, instruction.group);
          break;
        }
        case "wait":
          if (instruction.durationMs > 0) {
            state.active = { kind: "wait", location: executingAt, durationMs: instruction.durationMs, remainingMs: instruction.durationMs };
            return;
          }
          break;
        case "set": writeVariable(instruction.variable, instruction.value); break;
        case "inc": incrementVariable(instruction.variable, instruction.amount); break;
        case "trade": {
          const inventory = story.inventory;
          if (!inventory) throw new NovelEngineError("A validated trade instruction has no inventory catalog");
          const plan = planNovelInventoryTrade(inventory, variables, instruction);
          if (!plan.ok) {
            jumpToLabel(instruction.onFailure);
            break;
          }
          for (const [name, value] of Object.entries(plan.updates)) writeVariable(name, value);
          break;
        }
        case "branch": jumpToLabel(evaluateNovelCondition(instruction.when, variables) ? instruction.then : instruction.else); break;
        case "jump": jumpToLabel(instruction.target); break;
        case "call": state.callStack = [...state.callStack, { returnTo: clone(state.location) }]; jumpToLabel(instruction.target); break;
        case "return":
          if (state.callStack.length === 0) throw new NovelEngineError(`return at ${executingAt.label}[${executingAt.index}] has no matching call`);
          {
            const frame = state.callStack[state.callStack.length - 1]!;
            state.callStack = state.callStack.slice(0, -1);
            setLocation(frame.returnTo);
          }
          break;
        case "choice": {
          const options = conditionChoiceOptions(instruction);
          if (options.length === 0) throw new NovelEngineError(`Choice '${instruction.id}' has no available options`);
          if (instruction.timeLimitMs === 0) { jumpToLabel(instruction.timeoutTarget!); break; }
          state.active = {
            kind: "choice", location: executingAt, id: instruction.id,
            prompt: instruction.prompt === undefined ? null : interpolate(instruction.prompt, variables),
            options, timeRemainingMs: instruction.timeLimitMs ?? null,
          };
          return;
        }
        case "input": {
          const prompt = instruction.prompt === undefined ? null : interpolate(instruction.prompt, variables);
          const placeholder = instruction.inputType === "boolean" || instruction.placeholder === undefined
            ? null
            : interpolate(instruction.placeholder, variables);
          state.active = {
            kind: "input", location: executingAt, id: instruction.id, variable: instruction.variable,
            inputType: instruction.inputType, prompt, placeholder,
            draft: novelInputDefaultDraft(instruction), canCancel: instruction.cancelTarget !== undefined, error: null,
          };
          return;
        }
        case "ending": {
          state.meta = {
            ...state.meta,
            endingIds: addUnique(state.meta.endingIds, instruction.id),
            cgIds: instruction.cg === undefined ? [...state.meta.cgIds] : addUnique(state.meta.cgIds, instruction.cg),
          };
          state.active = {
            kind: "ending", location: executingAt, id: instruction.id,
            text: instruction.text === undefined ? "" : interpolate(instruction.text, variables), cg: instruction.cg ?? null,
          };
          return;
        }
      }
    }
  };

  const recordRead = (id: string): void => {
    if (!state.meta.readLineIds.includes(id)) state.meta = { ...state.meta, readLineIds: [...state.meta.readLineIds, id] };
  };
  const commitActiveSay = (): void => {
    const active = state.active;
    if (!active || active.kind !== "say" || !sayReadyForAdvance(active)) throw new NovelEngineError("The current line is not complete");
    const entry: BacklogEntry = {
      sequence: state.nextBacklogSequence++, lineId: active.id, location: clone(active.location),
      speaker: active.speaker, portrait: active.portrait, text: active.text,
      ...(active.rich === undefined ? {} : { rich: clone(active.rich) }),
    };
    state.backlog = [...state.backlog, entry];
    if (state.backlog.length > limits.maxBacklogEntries) state.backlog = state.backlog.slice(state.backlog.length - limits.maxBacklogEntries);
    recordRead(active.id);
    const checkpoint: RollbackCheckpoint = {
      location: clone(state.location), variables: clone(state.variables), stage: clone(state.stage), active: clone(active),
      callStack: clone(state.callStack), backlogSequence: entry.sequence - 1, audioIntents: clone(state.audioIntents),
    };
    state.rollbackHistory = [...state.rollbackHistory, checkpoint];
    if (state.rollbackHistory.length > limits.maxRollbackEntries) state.rollbackHistory = state.rollbackHistory.slice(state.rollbackHistory.length - limits.maxRollbackEntries);
    state.active = null;
    voice = null;
  };

  const advanceWithinTick = (deltaMs: number, events: EngineEvent[]): void => {
    let remaining = deltaMs;
    let immediateTransitions = 0;
    const advanceTimelineMotion = (elapsedMs: number, cues: EngineEvent[]): void => {
      const timeline = state.stage.timeline;
      if (!timeline || elapsedMs <= 0) return;
      const definition = story.timelines?.[timeline.id];
      if (!definition) throw new NovelEngineError(`Active timeline preset '${timeline.id}' is missing`);
      const nextElapsedMs = Math.min(definition.durationMs, timeline.elapsedMs + elapsedMs);
      let nextStage = sampleNovelTimeline(state.stage, definition, nextElapsedMs);
      for (const cue of orderedTimelineAudio(definition)) {
        if (cue.atMs > timeline.elapsedMs && cue.atMs <= nextElapsedMs) {
          emitAudioCue(cue.cue, cue.action ?? "play", cue.channel ?? null, cue.loop ?? false,
            clone(state.active?.location ?? state.location), cues, false, cue.group);
        }
      }
      sampleTimelineAudioGains(definition, nextElapsedMs);
      if (nextElapsedMs >= definition.durationMs) {
        const settledStage: Record<string, unknown> = { ...nextStage };
        delete settledStage.timeline;
        nextStage = settledStage as unknown as StageState;
      } else {
        nextStage = { ...nextStage, timeline: { id: timeline.id, elapsedMs: nextElapsedMs } };
      }
      state.stage = nextStage;
    };
    const advanceStageMotion = (elapsedMs: number): void => {
      if (elapsedMs <= 0) return;
      const stage = state.stage;
      const transition = stage.transition;
      const cameraMotion = stage.camera.motion;
      if (!transition && !cameraMotion && !stage.timeline) return;
      const nextTransition = transition
        ? transition.elapsedMs + elapsedMs >= transition.durationMs
          ? null
          : { ...transition, elapsedMs: transition.elapsedMs + elapsedMs }
        : null;
      const nextCamera = cameraMotion
        ? cameraMotion.elapsedMs + elapsedMs >= cameraMotion.durationMs
          ? { ...stage.camera, motion: null }
          : { ...stage.camera, motion: { ...cameraMotion, elapsedMs: cameraMotion.elapsedMs + elapsedMs } }
        : stage.camera;
      state.stage = { ...stage, transition: nextTransition, camera: nextCamera };
      advanceTimelineMotion(elapsedMs, events);
    };
    // Bound zero-time auto chains as well as instruction chains.
    while (state.started && !state.paused) {
      const active = state.active;
      if (!active) {
        runUntilBlocking(events);
        if (!state.active || state.paused) {
          if (!state.paused) advanceStageMotion(remaining);
          return;
        }
        if (remaining === 0 && ++immediateTransitions > limits.maxStepBudget) throw new StepBudgetExceededError(limits.maxStepBudget);
        continue;
      }
      if (active.kind === "say") {
        if (active.pause != null) {
          if (active.pause.remainingMs === null) { advanceStageMotion(remaining); return; }
          const used = Math.min(remaining, active.pause.remainingMs);
          advanceStageMotion(used);
          remaining -= used;
          const after = active.pause.remainingMs - used;
          if (after > 0) {
            state.active = { ...active, pause: { ...active.pause, remainingMs: after } };
            return;
          }
          state.active = releaseSayPause({ ...active, pause: { ...active.pause, remainingMs: 0 } });
          continue;
        }
        if (!active.complete) {
          const speed = state.preferences.textSpeedCharsPerSecond;
          const total = codePoints(active.text).length;
          const marker = nextSayPause(active);
          const target = marker?.at ?? total;
          const distance = Math.max(0, target - active.revealProgress);
          if (speed <= 0) {
            advanceStageMotion(0);
            const revealed = revealSayTo(active, target);
            state.active = {
              ...revealed,
              autoRemainingMs: sayReadyForAdvance(revealed) ? initializeAutoTimer(active.id, true) : null,
            };
            continue;
          }
          if (remaining <= 0) { advanceStageMotion(remaining); return; }
          const needed = distance * 1000 / speed;
          const used = Math.min(remaining, needed);
          advanceStageMotion(used);
          const revealed = revealSayTo(active, active.revealProgress + used * speed / 1000);
          state.active = {
            ...revealed,
            autoRemainingMs: sayReadyForAdvance(revealed) ? initializeAutoTimer(active.id, true) : null,
          };
          remaining -= used;
          if (!revealed.complete || revealed.pause != null) {
            if (revealed.pause != null) continue;
            return;
          }
          if (remaining === 0 && state.preferences.mode === "manual") return;
          continue;
        }
        const mode = state.preferences.mode;
        const seen = readIds().has(active.id);
        if (!sayReadyForAdvance(active) || mode === "manual" || (mode === "skip" && state.preferences.skipSeenOnly && !seen)) { advanceStageMotion(remaining); return; }
        const timer = active.autoRemainingMs ?? (mode === "skip" ? 0 : state.preferences.autoDelayMs);
        const used = Math.min(remaining, timer);
        advanceStageMotion(used);
        const after = timer - used;
        state.active = { ...active, autoRemainingMs: after };
        remaining -= used;
        if (after > 0) return;
        if (mode === "auto" && voiceBlocksAutoAdvance(voice)) { advanceStageMotion(remaining); return; }
        commitActiveSay();
        runUntilBlocking(events);
        if (state.paused) return;
        if (remaining === 0 && state.active) return;
        if (++immediateTransitions > limits.maxStepBudget) throw new StepBudgetExceededError(limits.maxStepBudget);
        continue;
      }
      if (active.kind === "wait") {
        const used = Math.min(remaining, active.remainingMs);
        advanceStageMotion(used);
        const after = active.remainingMs - used;
        remaining -= used;
        if (after > 0) { state.active = { ...active, remainingMs: after }; return; }
        state.active = null;
        runUntilBlocking(events);
        if (state.paused) return;
        if (remaining === 0 && state.active) return;
        if (++immediateTransitions > limits.maxStepBudget) throw new StepBudgetExceededError(limits.maxStepBudget);
        continue;
      }
      if (active.kind === "choice") {
        if (active.timeRemainingMs === null) { advanceStageMotion(remaining); return; }
        const used = Math.min(remaining, active.timeRemainingMs);
        advanceStageMotion(used);
        const after = active.timeRemainingMs - used;
        remaining -= used;
        if (after > 0) { state.active = { ...active, timeRemainingMs: after }; return; }
        const instruction = story.script[active.location.label]![active.location.index]!;
        if (instruction.type !== "choice" || instruction.timeoutTarget === undefined) throw new NovelEngineError("Timed choice has no timeout target");
        state.active = null;
        jumpToLabel(instruction.timeoutTarget);
        runUntilBlocking(events);
        if (state.paused) return;
        if (remaining === 0 && state.active) return;
        if (++immediateTransitions > limits.maxStepBudget) throw new StepBudgetExceededError(limits.maxStepBudget);
        continue;
      }
      if (active.kind === "input") {
        advanceStageMotion(remaining);
        return;
      }
      advanceStageMotion(remaining);
      return;
    }
  };

  const restoreLoadedState = (value: unknown): MutableState => {
    let data: unknown;
    try { data = copyJson(value, "save"); }
    catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
    if (!record(data) || data.format !== "pocket-vn-save" || data.formatVersion !== 1 || data.storyId !== story.id || data.storyVersion !== story.version || !record(data.state)) failSave("save format or story identity/version does not match");
    const raw = data.state;
    if (typeof raw.started !== "boolean" || typeof raw.paused !== "boolean" || !isIntegerAtLeast(raw.eventSequence, 0) || !isIntegerAtLeast(raw.transitionSequence, 0) || !isIntegerAtLeast(raw.nextBacklogSequence, 1)) failSave("save state counters are invalid");
    let savedLocation: ScriptPosition;
    try { savedLocation = validatePosition(raw.location, story, "save.state.location"); }
    catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
    const serializedVariables = validateVariables(raw.variables, "save.state.variables");
    const savedMeta = validateMeta(raw.meta, "save.state.meta");
    assertPersistentVariables(savedMeta, story, "save.state.meta.persistentVariables");
    const regularVariables: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const legacyPersistentVariables: Record<string, JsonValue> = { ...(savedMeta.persistentVariables ?? {}) };
    for (const [name, variableValue] of Object.entries(serializedVariables)) {
      if (variableLifetime(story, name) === "persistent") {
        // Older v1 saves stored every variable in state.variables. Lift only
        // values without a canonical metadata value; explicit meta remains authoritative.
        if (!Object.hasOwn(legacyPersistentVariables, name)) legacyPersistentVariables[name] = variableValue;
      } else regularVariables[name] = variableValue;
    }
    const restoredMeta: NovelMetaState = { ...savedMeta, persistentVariables: legacyPersistentVariables };
    const variables = regularVariables;
    const variablesForDisplay = effectiveVariables(variables, restoredMeta);
    const stage = restoreStage(raw.stage, "save.state.stage", true, true, story.timelines);
    const preferences = validatePreferences(raw.preferences, "save.state.preferences");
    const active = resolveActive(story, raw.active, variablesForDisplay, preferences, "save.state.active");
    if (!raw.started && (active !== null || !sameLocation(savedLocation, location(story.start)))) failSave("unstarted save must be at the story start");
    if (active && !sameLocation(savedLocation, nextPosition(active.location))) failSave("save location does not follow its active instruction");
    const callStack = validateCallStack(raw.callStack, story, "save.state.callStack");
    const audioIntents = restoreAudioIntents(raw.audioIntents, "save.state.audioIntents");
    if (stage.timeline) {
      const definition = story.timelines?.[stage.timeline.id];
      if (definition) {
        const issue = timelineAudioGainIssue(audioIntents, definition, stage.timeline.elapsedMs, "save.state");
        if (issue !== null) failSave(issue);
      }
    }
    if (!Array.isArray(raw.backlog)) failSave("save.state.backlog must be an array");
    const backlog: BacklogEntry[] = raw.backlog.map((entry, index) => {
      if (!record(entry) || !isIntegerAtLeast(entry.sequence, 1) || !isNonEmptyString(entry.lineId) || !isString(entry.text) || (entry.speaker !== null && !isString(entry.speaker)) || (entry.portrait !== null && !isString(entry.portrait))) failSave(`save.state.backlog[${index}] is invalid`);
      let entryLocation: ScriptPosition;
      try { entryLocation = validatePosition(entry.location, story, `save.state.backlog[${index}].location`, false); }
      catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
      const instruction = story.script[entryLocation.label]![entryLocation.index]!;
      if (instruction.type !== "say" || instruction.id !== entry.lineId) failSave(`save.state.backlog[${index}] does not match a dialogue line`);
      if (entry.rich !== undefined) {
        const richIssue = novelSayRichIssue(entry.text, entry.rich);
        if (richIssue !== null) failSave(`save.state.backlog[${index}].rich is invalid: ${richIssue}`);
      }
      return {
        sequence: entry.sequence, lineId: entry.lineId, location: entryLocation,
        speaker: entry.speaker, portrait: entry.portrait, text: entry.text,
        ...(entry.rich === undefined ? {} : { rich: clone(entry.rich as NovelSayRich) }),
      };
    });
    if (backlog.length > limits.maxBacklogEntries) backlog.splice(0, backlog.length - limits.maxBacklogEntries);
    for (let index = 1; index < backlog.length; index++) if (backlog[index]!.sequence <= backlog[index - 1]!.sequence) failSave("save backlog sequence must increase");
    const nextBacklogSequence = raw.nextBacklogSequence as number;
    if (backlog.length > 0 && backlog[backlog.length - 1]!.sequence >= nextBacklogSequence) failSave("nextBacklogSequence must follow the saved backlog");
    if (!Array.isArray(raw.rollbackHistory)) failSave("save.state.rollbackHistory must be an array");
    const rollbackHistory = raw.rollbackHistory.map((entry, index) => validateCheckpoint(story, entry, index, seeds, restoredMeta));
    if (rollbackHistory.length > limits.maxRollbackEntries) rollbackHistory.splice(0, rollbackHistory.length - limits.maxRollbackEntries);
    for (let index = 1; index < rollbackHistory.length; index++) if (rollbackHistory[index]!.backlogSequence <= rollbackHistory[index - 1]!.backlogSequence) failSave("rollback checkpoint cursors must increase");
    if (rollbackHistory.some(entry => entry.backlogSequence >= nextBacklogSequence)) failSave("rollback checkpoint cursor exceeds the saved log sequence");
    return {
      started: raw.started, location: savedLocation, variables, stage, active, callStack, backlog,
      nextBacklogSequence, rollbackHistory,
      meta: mergeMeta(state.meta, restoredMeta), audioIntents, preferences, paused: raw.paused,
      eventSequence: raw.eventSequence, transitionSequence: Math.max(raw.transitionSequence, stage.transition?.id ?? 0),
    };
  };

  const requireActiveInput = (): { readonly active: InputState; readonly instruction: NovelInputInstruction } => {
    if (!state.started) throw new NovelEngineError("Start the story before editing input");
    if (state.paused) throw new NovelEngineError("Resume the story before editing input");
    const active = state.active;
    if (active?.kind !== "input") throw new NovelEngineError("There is no active input");
    const instruction = currentInstruction(active.location);
    if (!instruction || instruction.type !== "input") throw new NovelEngineError("The active input no longer matches its story instruction");
    return { active, instruction };
  };

  const debug: NovelDebugAPI = {
    subscribeExecutionTrace: listener => {
      ensureLive();
      executionTraceListeners.add(listener);
      return () => { executionTraceListeners.delete(listener); };
    },
    pause: () => api.pause(),
    resume: () => api.resume(),
    step: () => transact(events => {
      if (!state.started) state.started = true;
      const active = state.active;
      if (active?.kind === "choice" || active?.kind === "input" || active?.kind === "ending") throw new NovelEngineError(`Cannot step through a ${active.kind}; resolve it or jump first`);
      if (active?.kind === "say") {
        const progress = lineProgress(active.text, codePoints(active.text).length);
        state.active = {
          ...active, ...progress, ...(active.rich === undefined ? {} : { pauseCursor: active.rich.pauses.length, pause: null }),
          autoRemainingMs: null,
        };
        commitActiveSay();
      } else if (active?.kind === "wait") state.active = null;
      const skip = breakpointStopKey ?? (state.active === null ? locationKey(state.location) : null);
      breakpointStopKey = null;
      state.paused = false;
      runUntilBlocking(events, skip);
      state.paused = true;
    }),
    setBreakpoints: locations => {
      ensureLive();
      const next = new Set<string>();
      for (const address of locations) {
        try { next.add(locationKey(validatePosition(address, story, "breakpoint", false))); }
        catch (error) { throw new StoryValidationError(error instanceof Error ? error.message : String(error)); }
      }
      const stoppedAt = breakpointStopKey;
      breakpoints.clear();
      for (const key of next) breakpoints.add(key);
      // Reapplying a still-hit breakpoint must keep resume's one-time skip token.
      breakpointStopKey = state.paused
        && stoppedAt !== null
        && stoppedAt === locationKey(state.location)
        && next.has(stoppedAt)
        ? stoppedAt
        : null;
      return makeUpdate();
    },
    jump: address => transact(events => {
      let target: ScriptPosition;
      try { target = validatePosition(address, story, "debug jump", true); }
      catch (error) { throw new StoryValidationError(error instanceof Error ? error.message : String(error)); }
      state.started = true;
      state.active = null;
      state.callStack = [];
      state.rollbackHistory = [];
      state.paused = false;
      setLocation(target);
      breakpointStopKey = null;
      runUntilBlocking(events, null);
      state.paused = true;
    }),
  };

  const api: NovelEngine = {
    debug,
    getSnapshot: () => snapshot,
    getStagePresentation: (options = {}) => {
      if (options.reduceMotion !== true) return snapshot.stage;
      const timeline = state.stage.timeline;
      if (!timeline) return snapshot.stage;
      const definition = story.timelines?.[timeline.id];
      if (!definition) return snapshot.stage;
      return deepFreeze(sampleNovelTimeline(state.stage, definition, definition.durationMs));
    },
    subscribe(listener: EngineListener, subscribeOptions: EngineSubscribeOptions = {}): () => void {
      ensureLive();
      listeners.add(listener);
      if (subscribeOptions.emitCurrent) {
        try { listener(deepFreeze({ snapshot, events: [] })); } catch { /* Listener failures do not affect engine state. */ }
      }
      return () => { listeners.delete(listener); };
    },
    start: () => transact(events => {
      if (state.started) throw new NovelEngineError("Novel engine can only be started once; create a new engine to restart");
      state.started = true;
      runUntilBlocking(events);
    }),
    advance: () => transact(events => {
      if (!state.started) throw new NovelEngineError("Start the story before advancing");
      if (state.paused) throw new NovelEngineError("Resume the story before advancing");
      const active = state.active;
      if (!active) { runUntilBlocking(events); return; }
      if (active.kind === "say") {
        if (active.pause != null) {
          state.active = releaseSayPause(active);
          return;
        }
        if (!active.complete) {
          const progress = revealSayTo(active, codePoints(active.text).length);
          state.active = {
            ...progress,
            autoRemainingMs: sayReadyForAdvance(progress) ? initializeAutoTimer(active.id, true) : null,
          };
          return;
        }
        if (!sayReadyForAdvance(active)) {
          const progress = revealSayTo(active, codePoints(active.text).length);
          state.active = {
            ...progress,
            autoRemainingMs: sayReadyForAdvance(progress) ? initializeAutoTimer(active.id, true) : null,
          };
          return;
        }
        commitActiveSay();
        runUntilBlocking(events);
        return;
      }
      if (active.kind === "ending") throw new NovelEngineError("The story has ended");
      if (active.kind === "choice") throw new NovelEngineError("Select one of the available choices");
      if (active.kind === "input") throw new NovelEngineError("Submit or cancel the active input");
      throw new NovelEngineError("Wait for the current timed passage to finish");
    }),
    activateSayLink: spanId => transact(events => {
      if (!isNonEmptyString(spanId) || !state.started || state.paused) return;
      const active = state.active;
      if (active?.kind !== "say" || active.rich === undefined) return;
      const span = active.rich.spans.find(item => item.id === spanId && item.link !== undefined);
      if (!span || span.end > active.revealedCharacters) return;
      const instruction = currentInstruction(active.location);
      if (instruction?.type !== "say" || instruction.id !== active.id || instruction.rich === undefined) return;
      let canonicalSpan: NovelSayRich["spans"][number] | undefined;
      try {
        canonicalSpan = resolveNovelSayRich(instruction.text, effectiveVariables(), instruction.rich)
          .rich?.spans.find(item => item.id === spanId && item.link !== undefined);
      } catch { return; }
      if (!canonicalSpan?.link) return;
      state.eventSequence++;
      events.push({
        type: "sayLink", sequence: state.eventSequence, lineId: active.id, spanId: span.id,
        title: canonicalSpan.link.title, text: canonicalSpan.link.text, location: clone(active.location),
      });
    }),
    reportVoice: (fact: NovelVoicePlaybackFact) => {
      ensureLive();
      if (!record(fact) || !isNonEmptyString(fact.token)
        || !["playing", "paused", "completed", "error", "unavailable"].includes(fact.status)) {
        throw new RangeError("Voice fact requires a playback token and supported status");
      }
      for (const key of ["positionMs", "durationMs"] as const) {
        if (fact[key] !== undefined && (!isFiniteNumber(fact[key]) || fact[key] < 0)) throw new RangeError(`Voice ${key} must be finite and non-negative`);
      }
      if (fact.error !== undefined && typeof fact.error !== "string") throw new RangeError("Voice error must be a string");
      // A completed/replaced playback cannot become current again through a
      // delayed pause or completion event from a native state subscription.
      if (!voice || fact.token !== voice.token || !voiceBlocksAutoAdvance(voice)) return deepFreeze({ snapshot, events: [] });
      if (voice.status === fact.status && voice.positionMs === fact.positionMs && voice.durationMs === fact.durationMs && voice.error === fact.error) return deepFreeze({ snapshot, events: [] });
      return transact(() => {
        voice = { ...voice!, status: fact.status,
          ...(fact.positionMs === undefined ? {} : { positionMs: fact.positionMs }),
          ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
          ...(fact.error === undefined ? {} : { error: fact.error }),
        };
      });
    },
    reportVideo: (fact: NovelVideoPlaybackFact) => {
      ensureLive();
      const issue = novelVideoPlaybackFactIssue(fact);
      if (issue !== null) throw new RangeError(issue);
      const current = state.stage.video;
      if (!current || !videoToken || fact.token !== videoToken || current.status === "ended") {
        return deepFreeze({ snapshot, events: [] });
      }
      if (fact.status === "ended" && current.loop) {
        throw new RangeError("A looping video overlay cannot report completion");
      }
      const next: NovelVideoOverlayState = {
        ...current,
        positionMs: fact.positionMs ?? current.positionMs,
        durationMs: fact.durationMs ?? current.durationMs,
        // Actual playing/paused facts reflect native lifecycle, not desired
        // state. Only a real non-loop completion changes the canonical status.
        status: fact.status === "ended" ? "ended" : current.status,
      };
      const stateIssue = novelVideoOverlayStateIssue(next);
      if (stateIssue !== null) throw new RangeError(stateIssue);
      if (next.positionMs === current.positionMs && next.durationMs === current.durationMs && next.status === current.status) {
        return deepFreeze({ snapshot, events: [] });
      }
      return transact(() => {
        state.stage = { ...state.stage, video: next };
      });
    },
    controlVideo: (instruction: NovelVideoInstruction) => {
      ensureLive();
      if (!state.started) throw new NovelEngineError("Story must be started to control video");
      const issue = novelVideoInstructionIssue(instruction);
      if (issue !== null) throw new RangeError(`Invalid video control: ${issue}`);
      return transact(events => applyVideo(instruction, events, clone(state.location)));
    },
    replayVoice: () => transact(() => {
      const active = state.active;
      const instruction = active?.kind === "say" ? currentInstruction(active.location) : undefined;
      if (instruction?.type !== "say" || !instruction.voice) throw new NovelEngineError("There is no voiced dialogue to replay");
      renewVoice();
    }),
    selectChoice: optionId => transact(events => {
      if (!state.started || state.paused) throw new NovelEngineError("Story must be running to select a choice");
      const active = state.active;
      if (!active || active.kind !== "choice") throw new NovelEngineError("There is no active choice");
      const option = active.options.find(entry => entry.id === optionId);
      if (!option) throw new NovelEngineError(`Choice option '${optionId}' is unavailable`);
      state.active = null;
      jumpToLabel(option.target);
      runUntilBlocking(events);
    }),
    interactSceneObject: objectId => transact(() => {
      if (!state.started || state.paused) throw new NovelEngineError("Story must be running to interact with a scene object");
      if (state.active?.kind !== "say") throw new NovelEngineError("Scene objects can only be used while dialogue is active");
      const object = state.stage.objects?.find(entry => entry.id === objectId);
      if (!object) throw new NovelEngineError(`Scene object '${objectId}' is not on the current stage`);
      const interaction = object.interaction;
      if (!interaction || !isNovelSceneObjectInteractive(object, effectiveVariables())) {
        throw new NovelEngineError(`Scene object '${objectId}' is not interactive right now`);
      }
      for (const effect of interaction.effects) applySceneObjectEffect(effect);
    }),
    updateInput: value => transact(() => {
      const { active } = requireActiveInput();
      if (active.inputType === "boolean") {
        if (typeof value !== "boolean") throw new RangeError("Boolean input requires a boolean value");
      } else {
        if (typeof value !== "string") throw new RangeError(`${active.inputType} input requires a string value`);
        const rawLimit = active.inputType === "number" ? NOVEL_INPUT_NUMBER_RAW_LIMIT : NOVEL_INPUT_TEXT_RAW_LIMIT;
        if (codePoints(value).length > rawLimit) throw new RangeError(`Input draft exceeds the ${rawLimit}-code-point raw limit`);
      }
      state.active = { ...active, draft: value, error: null };
    }),
    submitInput: () => transact(events => {
      const { active, instruction } = requireActiveInput();
      const validation = validateNovelInputDraft(instruction, active.draft);
      if (!validation.valid) {
        state.active = { ...active, error: validation.error };
        return;
      }
      writeVariable(instruction.variable, validation.value);
      state.active = null;
      runUntilBlocking(events);
    }),
    cancelInput: () => transact(events => {
      const { active, instruction } = requireActiveInput();
      if (instruction.cancelTarget === undefined) throw new NovelEngineError("The active input cannot be cancelled");
      state.active = null;
      jumpToLabel(instruction.cancelTarget);
      runUntilBlocking(events);
    }),
    tick: deltaMs => transact(events => {
      if (!isFiniteNumber(deltaMs) || deltaMs < 0) throw new RangeError("tick delta must be a finite non-negative number");
      if (!state.paused) advanceWithinTick(deltaMs, events);
    }),
    pause: () => transact(() => { state.paused = true; }),
    resume: () => transact(events => {
      const wasPaused = state.paused;
      state.paused = false;
      if (wasPaused && state.active === null && state.started) {
        const skip = breakpointStopKey;
        breakpointStopKey = null;
        runUntilBlocking(events, skip);
      }
    }),
    setPreferences: partial => transact(() => {
      state.preferences = preferencesFrom(state.preferences, partial);
      if (state.active?.kind === "say") {
        const active = state.active;
        const progress = !active.complete && active.pause == null && state.preferences.textSpeedCharsPerSecond === 0
          ? revealSayTo(active, codePoints(active.text).length)
          : active;
        state.active = {
          ...progress,
          autoRemainingMs: sayReadyForAdvance(progress) ? initializeAutoTimer(active.id, true) : null,
        };
      }
    }),
    rollback: (steps = 1) => transact(() => {
      if (!isIntegerAtLeast(steps, 1) || steps > state.rollbackHistory.length) throw new RangeError("rollback steps exceed available dialogue history");
      const targetIndex = state.rollbackHistory.length - steps;
      const checkpoint = state.rollbackHistory[targetIndex]!;
      state.rollbackHistory = state.rollbackHistory.slice(0, targetIndex);
      state.location = clone(checkpoint.location);
      state.variables = clone(checkpoint.variables as Record<string, JsonValue>);
      state.stage = clone(checkpoint.stage);
      state.active = clone(checkpoint.active);
      state.callStack = clone(checkpoint.callStack as CallStackFrame[]);
      state.audioIntents = clone(checkpoint.audioIntents as Record<string, NovelAudioIntent>);
      state.backlog = state.backlog.filter(entry => entry.sequence <= checkpoint.backlogSequence);
      renewVoice();
      renewVideoToken();
      // Meta, preferences, pause state and nextBacklogSequence deliberately survive rollback.
      breakpointStopKey = null;
    }),
    newGame: () => transact(events => {
      const currentVariables = effectiveVariables();
      const variables = initialRuntimeVariables(story, seeds);
      for (const [name, value] of Object.entries(currentVariables)) {
        if (variableLifetime(story, name) === "session") variables[name] = clone(value);
      }
      const stopLocation = clone(state.location);
      for (const [channel, intent] of Object.entries(state.audioIntents)) {
        if (intent.action !== "play") continue;
        state.eventSequence++;
        events.push({ type: "audioCue", sequence: state.eventSequence, cue: intent.cue, action: "stop", channel, loop: false, location: stopLocation });
      }
      if (state.stage.video !== null) {
        const overlay = state.stage.video;
        const token = videoToken ?? renewVideoToken()!;
        emitVideoCue(events, "close", overlay, token, stopLocation);
      }
      state.started = true;
      state.location = location(story.start);
      state.variables = variables;
      state.stage = emptyStage();
      renewVideoToken();
      state.active = null;
      state.callStack = [];
      state.backlog = [];
      state.nextBacklogSequence = 1;
      state.rollbackHistory = [];
      state.audioIntents = {};
      state.paused = false;
      breakpointStopKey = null;
      runUntilBlocking(events);
    }),
    save: () => {
      ensureLive();
      const data: NovelSaveData = {
        format: "pocket-vn-save", formatVersion: 1, storyId: story.id, storyVersion: story.version,
        state: {
          started: state.started, location: clone(state.location), variables: clone(state.variables), stage: clone(state.stage),
          active: state.active === null ? null : clone(state.active), callStack: clone(state.callStack), backlog: clone(state.backlog),
          nextBacklogSequence: state.nextBacklogSequence, rollbackHistory: clone(state.rollbackHistory), meta: clone(state.meta),
          audioIntents: clone(state.audioIntents), preferences: clone(state.preferences), paused: state.paused,
          eventSequence: state.eventSequence, transitionSequence: state.transitionSequence,
        },
      };
      return deepFreeze(data);
    },
    load: value => transact(() => {
      let expandedSave: NovelSaveData;
      try { expandedSave = decodeNovelSaveData(value); }
      catch (error) { failSave(error instanceof Error ? error.message : String(error)); }
      const loaded = restoreLoadedState(expandedSave);
      Object.assign(state, loaded);
      renewVoice();
      renewVideoToken();
      breakpointStopKey = null;
    }),
    dispose: () => {
      if (disposed) return;
      state.paused = true;
      state.active = null;
      videoToken = null;
      disposed = true;
      makeUpdate();
      listeners.clear();
      executionTraceQueue.length = 0;
      executionTraceListeners.clear();
      breakpoints.clear();
      breakpointStopKey = null;
    },
  };
  return api;
}

export const value = {
  literal(value: JsonValue): ValueExpression { return { type: "literal", value: clone(value) }; },
  variable(name: string): ValueExpression { return { type: "variable", name }; },
};

export const conditions = {
  truthy(value: ValueExpression): Condition { return { op: "truthy", value }; },
  falsy(value: ValueExpression): Condition { return { op: "falsy", value }; },
  eq(left: ValueExpression, right: ValueExpression): Condition { return { op: "eq", left, right }; },
  neq(left: ValueExpression, right: ValueExpression): Condition { return { op: "neq", left, right }; },
  gt(left: ValueExpression, right: ValueExpression): Condition { return { op: "gt", left, right }; },
  gte(left: ValueExpression, right: ValueExpression): Condition { return { op: "gte", left, right }; },
  lt(left: ValueExpression, right: ValueExpression): Condition { return { op: "lt", left, right }; },
  lte(left: ValueExpression, right: ValueExpression): Condition { return { op: "lte", left, right }; },
  and(...conditions: Condition[]): Condition { return { op: "and", conditions }; },
  or(...conditions: Condition[]): Condition { return { op: "or", conditions }; },
  not(condition: Condition): Condition { return { op: "not", condition }; },
};
