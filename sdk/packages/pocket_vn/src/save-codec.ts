import type {
  BacklogEntry,
  JsonValue,
  NovelAudioIntent,
  NovelCompressedBacklogEntryV4,
  NovelCompressedRollbackActive,
  NovelCompressedRollbackActiveV4,
  NovelCompressedRollbackCheckpoint,
  NovelCompressedRollbackHistoryV4,
  NovelCompressedSayRichV4,
  NovelSayColorToken,
  NovelSayRich,
  NovelSaveData,
  NovelSaveDataV4,
  RollbackCheckpoint,
  StageState,
} from "./types.ts";
import { novelVideoOverlayStateIssue } from "./video-schema.ts";
import { novelBackgroundLayersIssue } from "./background-layers.ts";
import { novelSceneObjectsIssue } from "./scene-objects.ts";
import { novelAuthoredAudioGroupIssue } from "./timeline.ts";
import { novelSayRichIssue } from "./rich-text.ts";

type UnknownRecord = Record<string, unknown>;

/** Raised when a compact persisted save cannot be safely expanded. */
export class NovelSaveCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovelSaveCodecError";
  }
}

function fail(path: string, message: string): never {
  throw new NovelSaveCodecError(`${path} ${message}`);
}

function record(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Copy finite JSON data into prototype-safe records without invoking getters. */
function copyJson(value: unknown, path: string, active = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fail(path, "must contain only finite JSON numbers.");
  }
  if (Array.isArray(value)) {
    if (active.has(value)) return fail(path, "must not contain circular JSON data.");
    if (Object.getOwnPropertySymbols(value).length > 0) return fail(path, "must not contain symbol keys.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copied: JsonValue[] = [];
    active.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return fail(`${path}[${index}]`, "must be a plain JSON array entry.");
        }
        copied.push(copyJson(descriptor.value, `${path}[${index}]`, active));
      }
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return fail(path, "must not have custom array properties.");
        }
      }
    } finally {
      active.delete(value);
    }
    return copied;
  }
  if (!record(value)) return fail(path, "must contain only plain JSON data.");
  if (active.has(value)) return fail(path, "must not contain circular JSON data.");
  if (Object.getOwnPropertySymbols(value).length > 0) return fail(path, "must not contain symbol keys.");
  const copied: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  active.add(value);
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return fail(`${path}.${key}`, "must be a plain JSON property.");
      }
      // Null-prototype outputs preserve keys such as __proto__ as ordinary JSON data.
      copied[key] = copyJson(descriptor.value, `${path}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
  return copied;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(object[key]!)).join(",") + "}";
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function position(value: unknown, path: string): value is { label: string; index: number } {
  if (!record(value) || !exactKeys(value, ["label", "index"]) ||
      typeof value.label !== "string" || !Number.isSafeInteger(value.index) || (value.index as number) < 0) {
    fail(path, "must be a script position with a label and non-negative safe index.");
  }
  return true;
}

function variablePool(value: unknown, path: string): value is Readonly<Record<string, JsonValue>> {
  if (!record(value)) fail(path, "must be an object.");
  return true;
}

function stagePool(value: unknown, path: string): value is StageState {
  if (!record(value)) fail(path, "must be a stage object.");
  if (value.backgroundLayers !== undefined) {
    const issue = novelBackgroundLayersIssue(value.backgroundLayers, `${path}.backgroundLayers`);
    if (issue !== null) fail(path, `${issue}.`);
  }
  if (value.objects !== undefined) {
    const issue = novelSceneObjectsIssue(value.objects, `${path}.objects`);
    if (issue !== null) throw new NovelSaveCodecError(issue);
  }
  if (Object.prototype.hasOwnProperty.call(value, "video") && value.video !== null) {
    const issue = novelVideoOverlayStateIssue(value.video);
    if (issue !== null) fail(`${path}.video`, `${issue}.`);
  }
  return true;
}

function activePool(value: unknown, path: string): value is Extract<RollbackCheckpoint["active"], { kind: "say" }> {
  if (!record(value) || value.kind !== "say") fail(path, "must be a completed dialogue state.");
  return true;
}

function legacyV3ActivePool(value: unknown, path: string): value is Extract<RollbackCheckpoint["active"], { kind: "say" }> {
  compactActivePool(value, path);
  return true;
}

function compactActivePool(value: unknown, path: string): NovelCompressedRollbackActive {
  const fields = ["kind", "location", "id", "speaker", "portrait", "text", "revealProgress", "visibleText", "revealedCharacters", "complete", "autoRemainingMs"];
  if (!record(value) || value.kind !== "say" || fields.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !fields.includes(key) && !["rich", "pauseCursor", "pause"].includes(key))) fail(path, "must be a canonical completed dialogue state.");
  if (!position(value.location, `${path}.location`)) fail(path, "has an invalid location.");
  if (typeof value.id !== "string" || value.id.trim().length === 0) fail(`${path}.id`, "must be a non-empty string.");
  if (value.speaker !== null && typeof value.speaker !== "string") fail(`${path}.speaker`, "must be a string or null.");
  if (value.portrait !== null && typeof value.portrait !== "string") fail(`${path}.portrait`, "must be a string or null.");
  if (typeof value.text !== "string") fail(`${path}.text`, "must be a string.");
  const characterCount = Array.from(value.text).length;
  if (!Number.isFinite(value.revealProgress) || value.revealProgress !== characterCount
    || value.visibleText !== value.text || value.revealedCharacters !== characterCount || value.complete !== true) {
    fail(path, "must be a completed say state consistent with its text.");
  }
  if (value.autoRemainingMs !== null && (typeof value.autoRemainingMs !== "number" || !Number.isFinite(value.autoRemainingMs) || value.autoRemainingMs < 0)) {
    fail(`${path}.autoRemainingMs`, "must be null or a non-negative finite number.");
  }
  if (value.rich !== undefined) {
    const issue = novelSayRichIssue(value.text, value.rich);
    if (issue !== null || value.pauseCursor !== (value.rich as NovelSayRich).pauses.length || value.pause !== null) {
      fail(`${path}.rich`, issue ?? "completed rollback dialogue must have consumed every pause.");
    }
  } else if (Object.hasOwn(value, "pauseCursor") || Object.hasOwn(value, "pause")) {
    fail(path, "pause state requires rich annotations.");
  }
  return [
    value.location.label,
    value.location.index,
    value.id,
    value.speaker,
    value.portrait,
    value.text,
    value.revealProgress,
    value.autoRemainingMs,
  ] as NovelCompressedRollbackActive;
}

function validateCompactActivePool(value: unknown, path: string): value is NovelCompressedRollbackActive {
  if (!Array.isArray(value) || value.length !== 8) fail(path, "must be an eight-field completed say tuple.");
  if (typeof value[0] !== "string" || !Number.isSafeInteger(value[1]) || (value[1] as number) < 0) {
    fail(path, "must contain a script label and non-negative safe instruction index.");
  }
  if (typeof value[2] !== "string" || value[2].trim().length === 0) fail(`${path}[2]`, "dialogue ID must be a non-empty string.");
  if (value[3] !== null && typeof value[3] !== "string") fail(`${path}[3]`, "speaker must be a string or null.");
  if (value[4] !== null && typeof value[4] !== "string") fail(`${path}[4]`, "portrait must be a string or null.");
  if (typeof value[5] !== "string") fail(`${path}[5]`, "text must be a string.");
  const characterCount = Array.from(value[5]).length;
  if (typeof value[6] !== "number" || !Number.isFinite(value[6]) || value[6] !== characterCount) {
    fail(`${path}[6]`, "reveal progress must equal the completed text's Unicode code-point count.");
  }
  if (value[7] !== null && (typeof value[7] !== "number" || !Number.isFinite(value[7]) || value[7] < 0)) {
    fail(`${path}[7]`, "auto delay must be null or a non-negative finite number.");
  }
  return true;
}

function expandCompactActivePool(value: NovelCompressedRollbackActive, path: string): Extract<RollbackCheckpoint["active"], { kind: "say" }> {
  validateCompactActivePool(value, path);
  const text = value[5];
  const revealedCharacters = Array.from(text).length;
  return {
    kind: "say",
    location: { label: value[0], index: value[1] },
    id: value[2],
    speaker: value[3],
    portrait: value[4],
    text,
    revealProgress: value[6],
    visibleText: text,
    revealedCharacters,
    complete: true,
    autoRemainingMs: value[7],
  };
}

function audioPool(value: unknown, path: string): value is Readonly<Record<string, NovelAudioIntent>> {
  if (!record(value)) fail(path, "must be an audio intent object.");
  for (const [channel, intent] of Object.entries(value)) {
    if (!record(intent)) fail(`${path}.${channel}`, "must be an audio intent object.");
    const groupIssue = novelAuthoredAudioGroupIssue(intent.group, intent.action, channel, `${path}.${channel}`);
    if (groupIssue !== null) fail(path, `${groupIssue}.`);
    if (intent.gain !== undefined && (intent.action === "stop" || typeof intent.gain !== "number" ||
        !Number.isFinite(intent.gain) || intent.gain < 0 || intent.gain > 1)) {
      fail(`${path}.${channel}.gain`, "must be a finite play-intent gain between 0 and 1.");
    }
  }
  return true;
}

function intern<T>(pool: T[], indexes: Map<string, number>, value: T): number {
  const key = canonicalJson(value as unknown as JsonValue);
  const existing = indexes.get(key);
  if (existing !== undefined) return existing;
  const index = pool.length;
  indexes.set(key, index);
  pool.push(value);
  return index;
}

function assertV1(value: unknown): asserts value is NovelSaveData {
  if (!record(value) || value.format !== "pocket-vn-save" || value.formatVersion !== 1 ||
      typeof value.storyId !== "string" || !Number.isSafeInteger(value.storyVersion) ||
      !record(value.state) || !Array.isArray(value.state.rollbackHistory)) {
    fail("save", "must be an expanded pocket-vn-save version 1 record.");
  }
}

function expandBacklog(value: unknown, path: string): BacklogEntry[] {
  if (!Array.isArray(value)) fail(path, "must be an array of compact entries.");
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!Array.isArray(entry) || entry.length !== 7) fail(itemPath, "must be a seven-field backlog tuple.");
    if (!Number.isSafeInteger(entry[0]) || (entry[0] as number) < 1) fail(`${itemPath}[0]`, "sequence must be a positive safe integer.");
    if (typeof entry[1] !== "string" || entry[1].trim().length === 0) fail(`${itemPath}[1]`, "line ID must be a non-empty string.");
    if (typeof entry[2] !== "string" || !Number.isSafeInteger(entry[3]) || (entry[3] as number) < 0) {
      fail(itemPath, "must contain a script label and non-negative safe instruction index.");
    }
    if (entry[4] !== null && typeof entry[4] !== "string") fail(`${itemPath}[4]`, "speaker must be a string or null.");
    if (entry[5] !== null && typeof entry[5] !== "string") fail(`${itemPath}[5]`, "portrait must be a string or null.");
    if (typeof entry[6] !== "string") fail(`${itemPath}[6]`, "text must be a string.");
    return {
      sequence: entry[0] as number,
      lineId: entry[1],
      location: { label: entry[2], index: entry[3] as number },
      speaker: entry[4],
      portrait: entry[5],
      text: entry[6],
    };
  });
}

function compactBacklogV4(
  value: unknown,
  internText: (text: string) => number,
  internRich: (rich: unknown, text: string, path: string) => number,
): NovelCompressedBacklogEntryV4[] {
  if (!Array.isArray(value)) fail("save.state.backlog", "must be an array.");
  return value.map((entry, index) => {
    const path = `save.state.backlog[${index}]`;
    if (!record(entry) || !exactKeys(entry, entry.rich === undefined
      ? ["sequence", "lineId", "location", "speaker", "portrait", "text"]
      : ["sequence", "lineId", "location", "speaker", "portrait", "text", "rich"])) {
      fail(path, "must be a canonical backlog entry.");
    }
    if (!Number.isSafeInteger(entry.sequence) || (entry.sequence as number) < 1) {
      fail(`${path}.sequence`, "must be a positive safe integer.");
    }
    if (typeof entry.lineId !== "string" || entry.lineId.trim().length === 0) fail(`${path}.lineId`, "must be a non-empty string.");
    if (!position(entry.location, `${path}.location`)) fail(path, "has an invalid location.");
    if (entry.speaker !== null && typeof entry.speaker !== "string") fail(`${path}.speaker`, "must be a string or null.");
    if (entry.portrait !== null && typeof entry.portrait !== "string") fail(`${path}.portrait`, "must be a string or null.");
    if (typeof entry.text !== "string") fail(`${path}.text`, "must be a string.");
    const compacted = [
      entry.sequence as number,
      entry.lineId,
      entry.location.label,
      entry.location.index,
      entry.speaker,
      entry.portrait,
      internText(entry.text),
    ];
    if (entry.rich !== undefined) compacted.push(internRich(entry.rich, entry.text, `${path}.rich`));
    return compacted as unknown as NovelCompressedBacklogEntryV4;
  });
}

function textPool(value: unknown, path: string): value is string {
  if (typeof value !== "string") fail(path, "must be a string.");
  return true;
}

function referencedText(value: unknown, texts: readonly string[], path: string, used: Set<number>): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= texts.length) {
    return fail(path, "must reference an existing rendered-text pool entry.");
  }
  const index = value as number;
  used.add(index);
  return texts[index]!;
}

function compactSayRichV4(value: unknown, text: string, path: string, internText: (text: string) => number): NovelCompressedSayRichV4 {
  const issue = novelSayRichIssue(text, value);
  if (issue !== null) fail(path, `${issue}.`);
  const rich = value as NovelSayRich;
  return [
    internText(text),
    rich.spans.map(span => [
      internText(span.id), span.start, span.end,
      span.style?.color ?? null, span.style?.emphasis ?? null,
      span.ruby === undefined ? null : internText(span.ruby),
      span.link === undefined ? null : internText(span.link.title),
      span.link === undefined ? null : internText(span.link.text),
    ] as const),
    rich.pauses.map(pause => [internText(pause.id), pause.at, pause.durationMs] as const),
  ];
}

function expandSayRichV4(
  value: unknown,
  texts: readonly string[],
  usedTexts: Set<number>,
  path: string,
): NovelSayRich {
  if (!Array.isArray(value) || value.length !== 3 || !Array.isArray(value[1]) || !Array.isArray(value[2])) {
    return fail(path, "must be a three-field rich annotation tuple.");
  }
  const text = referencedText(value[0], texts, `${path}[0]`, usedTexts);
  const spans = value[1].map((raw, index) => {
    const spanPath = `${path}[1][${index}]`;
    if (!Array.isArray(raw) || raw.length !== 8) fail(spanPath, "must be an eight-field span tuple.");
    const [idRef, start, end, color, emphasis, rubyRef, titleRef, noteTextRef] = raw;
    const id = referencedText(idRef, texts, `${spanPath}[0]`, usedTexts);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) fail(spanPath, "must contain integer code-point boundaries.");
    if (color !== null && color !== "accent" && color !== "muted" && color !== "warning") fail(`${spanPath}[3]`, "has an unknown semantic color token.");
    if (emphasis !== null && emphasis !== "strong") fail(`${spanPath}[4]`, "has an unknown emphasis token.");
    if ((titleRef === null) !== (noteTextRef === null)) fail(spanPath, "link title and body references must be paired.");
    const ruby = rubyRef === null ? undefined : referencedText(rubyRef, texts, `${spanPath}[5]`, usedTexts);
    const link = titleRef === null ? undefined : {
      title: referencedText(titleRef, texts, `${spanPath}[6]`, usedTexts),
      text: referencedText(noteTextRef, texts, `${spanPath}[7]`, usedTexts),
    };
    const style = color === null && emphasis === null ? undefined : {
      ...(color === null ? {} : { color: color as NovelSayColorToken }),
      ...(emphasis === null ? {} : { emphasis: emphasis as "strong" }),
    };
    return {
      id, start: start as number, end: end as number,
      ...(style === undefined ? {} : { style }),
      ...(ruby === undefined ? {} : { ruby }),
      ...(link === undefined ? {} : { link }),
    };
  });
  const pauses = value[2].map((raw, index) => {
    const pausePath = `${path}[2][${index}]`;
    if (!Array.isArray(raw) || raw.length !== 3) fail(pausePath, "must be a three-field pause tuple.");
    const id = referencedText(raw[0], texts, `${pausePath}[0]`, usedTexts);
    if (!Number.isSafeInteger(raw[1])) fail(`${pausePath}[1]`, "must be an integer code-point boundary.");
    if (raw[2] !== null && (!Number.isSafeInteger(raw[2]) || (raw[2] as number) <= 0)) fail(`${pausePath}[2]`, "must be a positive integer or null.");
    return { id, at: raw[1] as number, durationMs: raw[2] as number | null };
  });
  const rich: NovelSayRich = { spans, pauses };
  const issue = novelSayRichIssue(text, rich);
  if (issue !== null) fail(path, `${issue}.`);
  return rich;
}

function validateSayRichPoolEntryV4(value: unknown, path: string, texts: readonly string[], usedTexts: Set<number>): value is NovelCompressedSayRichV4 {
  expandSayRichV4(value, texts, usedTexts, path);
  return true;
}

function referencedRich(
  value: unknown,
  pool: readonly NovelCompressedSayRichV4[],
  texts: readonly string[],
  usedTexts: Set<number>,
  usedRich: Set<number>,
  path: string,
): NovelSayRich {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= pool.length) fail(path, "must reference an existing rich annotation pool entry.");
  const index = value as number;
  usedRich.add(index);
  return expandSayRichV4(pool[index]!, texts, usedTexts, `${path} (richPool[${index}])`);
}

function expandBacklogV4(
  value: unknown,
  texts: readonly string[],
  richPool: readonly NovelCompressedSayRichV4[],
  usedTexts: Set<number>,
  usedRich: Set<number>,
  path: string,
): BacklogEntry[] {
  if (!Array.isArray(value)) fail(path, "must be an array of compact entries.");
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!Array.isArray(entry) || (entry.length !== 7 && entry.length !== 8)) fail(itemPath, "must be a seven- or eight-field backlog tuple.");
    if (!Number.isSafeInteger(entry[0]) || (entry[0] as number) < 1) fail(`${itemPath}[0]`, "sequence must be a positive safe integer.");
    if (typeof entry[1] !== "string" || entry[1].trim().length === 0) fail(`${itemPath}[1]`, "line ID must be a non-empty string.");
    if (typeof entry[2] !== "string" || !Number.isSafeInteger(entry[3]) || (entry[3] as number) < 0) {
      fail(itemPath, "must contain a script label and non-negative safe instruction index.");
    }
    if (entry[4] !== null && typeof entry[4] !== "string") fail(`${itemPath}[4]`, "speaker must be a string or null.");
    if (entry[5] !== null && typeof entry[5] !== "string") fail(`${itemPath}[5]`, "portrait must be a string or null.");
    const text = referencedText(entry[6], texts, `${itemPath}[6]`, usedTexts);
    const rich = entry.length === 8
      ? referencedRich(entry[7], richPool, texts, usedTexts, usedRich, `${itemPath}[7]`)
      : undefined;
    if (entry.length === 8) {
      const poolIndex = entry[7] as number;
      const richText = referencedText(richPool[poolIndex]![0], texts, `${itemPath}[7].text`, usedTexts);
      if (richText !== text) fail(`${itemPath}[7]`, "references annotations for different rendered text.");
    }
    return {
      sequence: entry[0] as number,
      lineId: entry[1],
      location: { label: entry[2], index: entry[3] as number },
      speaker: entry[4],
      portrait: entry[5],
      text,
      ...(rich === undefined ? {} : { rich }),
    };
  });
}

function compactActivePoolV4(
  value: unknown,
  path: string,
  internText: (text: string) => number,
  internRich: (rich: unknown, text: string, path: string) => number,
): NovelCompressedRollbackActiveV4 {
  const compacted = compactActivePool(value, path);
  const result: Array<string | number | null> = [
    compacted[0],
    compacted[1],
    compacted[2],
    compacted[3],
    compacted[4],
    internText(compacted[5]),
    compacted[6],
    compacted[7],
  ];
  if (record(value) && value.rich !== undefined) result.push(internRich(value.rich, compacted[5], `${path}.rich`));
  return result as unknown as NovelCompressedRollbackActiveV4;
}

function validateCompactActivePoolV4(
  value: unknown,
  path: string,
  texts: readonly string[],
  richPool: readonly NovelCompressedSayRichV4[],
  usedTexts: Set<number>,
  usedRich: Set<number>,
): value is NovelCompressedRollbackActiveV4 {
  if (!Array.isArray(value) || (value.length !== 8 && value.length !== 9)) fail(path, "must be an eight- or nine-field completed say tuple.");
  const text = referencedText(value[5], texts, `${path}[5]`, usedTexts);
  validateCompactActivePool([
    value[0], value[1], value[2], value[3], value[4], text, value[6], value[7],
  ], path);
  if (value.length === 9) {
    referencedRich(value[8], richPool, texts, usedTexts, usedRich, `${path}[8]`);
    const richText = referencedText(richPool[value[8] as number]![0], texts, `${path}[8].text`, usedTexts);
    if (richText !== text) fail(`${path}[8]`, "references annotations for different rendered text.");
  }
  return true;
}

function expandCompactActivePoolV4(
  value: NovelCompressedRollbackActiveV4,
  path: string,
  texts: readonly string[],
  richPool: readonly NovelCompressedSayRichV4[],
  usedTexts: Set<number>,
  usedRich: Set<number>,
): Extract<RollbackCheckpoint["active"], { kind: "say" }> {
  const text = referencedText(value[5], texts, `${path}[5]`, usedTexts);
  const active = expandCompactActivePool([
    value[0], value[1], value[2], value[3], value[4], text, value[6], value[7],
  ], path);
  if (value.length === 9) {
    const rich = referencedRich(value[8], richPool, texts, usedTexts, usedRich, `${path}[8]`);
    return { ...active, rich, pauseCursor: rich.pauses.length, pause: null };
  }
  return active;
}

/**
 * Encode a validated engine save as format v4. Rollback state and rendered
 * historical text are interned; backlog records and completed say fields use tuples.
 */
export function encodeNovelSaveData(save: NovelSaveData): NovelSaveDataV4 {
  const snapshot = copyJson(save, "save");
  assertV1(snapshot);
  const state = snapshot.state as UnknownRecord;
  const rawCheckpoints = state.rollbackHistory;
  if (!Array.isArray(rawCheckpoints)) fail("save.state.rollbackHistory", "must be an array.");
  if (!audioPool(state.audioIntents, "save.state.audioIntents")) fail("save.state.audioIntents", "has invalid audio intents.");
  if (Object.hasOwn(state, "textPool")) fail("save.state.textPool", "is reserved by compact format v4.");
  if (Object.hasOwn(state, "richPool")) fail("save.state.richPool", "is reserved by compact format v4.");

  const texts: string[] = [];
  const textIndexes = new Map<string, number>();
  const internText = (text: string) => intern(texts, textIndexes, text);
  const richValues: NovelCompressedSayRichV4[] = [];
  const richIndexes = new Map<string, number>();
  const internRich = (rich: unknown, text: string, path: string) =>
    intern(richValues, richIndexes, compactSayRichV4(rich, text, path, internText));
  const backlog = compactBacklogV4(state.backlog, internText, internRich);

  const variableValues: Readonly<Record<string, JsonValue>>[] = [];
  const stageValues: StageState[] = [];
  const activeValues: NovelCompressedRollbackActiveV4[] = [];
  const audioValues: Readonly<Record<string, NovelAudioIntent>>[] = [];
  const variableIndexes = new Map<string, number>();
  const stageIndexes = new Map<string, number>();
  const activeIndexes = new Map<string, number>();
  const audioIndexes = new Map<string, number>();
  const entries: NovelCompressedRollbackCheckpoint[] = [];

  for (const [index, raw] of rawCheckpoints.entries()) {
    const path = `save.state.rollbackHistory[${index}]`;
    if (!record(raw)) fail(path, "must be an object.");
    if (!position(raw.location, `${path}.location`)) fail(path, "has an invalid location.");
    if (!Array.isArray(raw.callStack)) fail(`${path}.callStack`, "must be an array.");
    if (!Number.isSafeInteger(raw.backlogSequence) || (raw.backlogSequence as number) < 0) {
      fail(`${path}.backlogSequence`, "must be a non-negative safe integer.");
    }
    if (!variablePool(raw.variables, `${path}.variables`)) fail(path, "has invalid variables.");
    if (!stagePool(raw.stage, `${path}.stage`)) fail(path, "has an invalid stage.");
    if (!audioPool(raw.audioIntents, `${path}.audioIntents`)) fail(path, "has invalid audio intents.");

    const variablesRef = intern(variableValues, variableIndexes, raw.variables);
    const stageRef = intern(stageValues, stageIndexes, raw.stage);
    const activeValue = compactActivePoolV4(raw.active, `${path}.active`, internText, internRich);
    const activeRef = intern(activeValues, activeIndexes, activeValue);
    const audioIntentsRef = intern(audioValues, audioIndexes, raw.audioIntents);
    entries.push([
      raw.location.label,
      raw.location.index,
      raw.callStack as RollbackCheckpoint["callStack"],
      raw.backlogSequence as number,
      variablesRef,
      stageRef,
      activeRef,
      audioIntentsRef,
    ]);
  }

  const pools: NovelCompressedRollbackHistoryV4["pools"] = {
    variables: variableValues,
    stages: stageValues,
    active: activeValues,
    audioIntents: audioValues,
  };
  const compressedHistory: NovelCompressedRollbackHistoryV4 = { pools, entries };
  const compactState: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(state)) {
    if (key === "rollbackHistory" || key === "backlog" || key === "textPool") continue;
    if (key === "active" && record(value) && value.kind === "say" && value.rich !== undefined) {
      if (typeof value.text !== "string") fail("save.state.active.text", "must be a string.");
      const { rich, ...active } = value;
      compactState.active = { ...active, richRef: internRich(rich, value.text, "save.state.active.rich") };
    } else compactState[key] = value;
  }
  compactState.textPool = texts;
  if (richValues.length > 0) compactState.richPool = richValues;
  compactState.backlog = backlog;
  compactState.rollbackHistory = compressedHistory;

  const compact: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "formatVersion" && key !== "state") compact[key] = value;
  }
  compact.format = "pocket-vn-save";
  compact.formatVersion = 4;
  compact.state = compactState;
  return compact as unknown as NovelSaveDataV4;
}

function requiredPool<T>(
  pools: readonly T[],
  reference: unknown,
  path: string,
  validate: (value: unknown, path: string) => value is T,
  used: Set<number>,
): T {
  if (!Number.isSafeInteger(reference) || (reference as number) < 0 || (reference as number) >= pools.length) {
    return fail(path, "must reference an existing pool entry.");
  }
  const index = reference as number;
  used.add(index);
  const value = pools[index];
  validate(value, path);
  return value as T;
}

function validatedPool<T>(
  value: unknown,
  path: string,
  validate: (item: unknown, itemPath: string) => item is T,
): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array.");
  const pool: T[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    validate(item, itemPath);
    const key = canonicalJson(item as unknown as JsonValue);
    if (seen.has(key)) fail(itemPath, "duplicates an earlier pool value.");
    seen.add(key);
    pool.push(item as T);
  }
  return pool;
}

/**
 * Expand legacy v1 or compact v2/v3/v4 save data into the engine's v1 shape.
 * V1 inputs pass through unchanged so existing saves retain their format.
 */
export function decodeNovelSaveData(value: unknown): NovelSaveData {
  if (!record(value) || value.format !== "pocket-vn-save") fail("save", "has an unknown format.");
  if (value.formatVersion === 1) return value as unknown as NovelSaveData;
  if (value.formatVersion !== 2 && value.formatVersion !== 3 && value.formatVersion !== 4) fail("save.formatVersion", "must be 1, 2, 3, or 4.");

  const snapshot = copyJson(value, "save");
  if (!record(snapshot) || !record(snapshot.state)) fail("save.state", "must be an object.");
  if (!audioPool(snapshot.state.audioIntents, "save.state.audioIntents")) fail("save.state.audioIntents", "has invalid audio intents.");
  const compactVersion = snapshot.formatVersion;
  const usedTexts = new Set<number>();
  const usedRich = new Set<number>();
  const texts = compactVersion === 4
    ? validatedPool(snapshot.state.textPool, "save.state.textPool", textPool)
    : [];
  const richPool = compactVersion === 4 && snapshot.state.richPool !== undefined
    ? validatedPool(
      snapshot.state.richPool,
      "save.state.richPool",
      (item, path): item is NovelCompressedSayRichV4 => validateSayRichPoolEntryV4(item, path, texts, usedTexts),
    )
    : [];
  const expandedBacklog = compactVersion === 3
    ? expandBacklog(snapshot.state.backlog, "save.state.backlog")
    : compactVersion === 4
      ? expandBacklogV4(snapshot.state.backlog, texts, richPool, usedTexts, usedRich, "save.state.backlog")
      : undefined;
  const encoded = snapshot.state.rollbackHistory;
  if (!record(encoded) || !exactKeys(encoded, ["pools", "entries"])) {
    fail("save.state.rollbackHistory", "has an invalid compact shape.");
  }
  if (!record(encoded.pools) || !exactKeys(encoded.pools, ["variables", "stages", "active", "audioIntents"])) {
    fail("save.state.rollbackHistory.pools", "has an invalid shape.");
  }
  const variables = validatedPool(encoded.pools.variables, "save.state.rollbackHistory.pools.variables", variablePool);
  const stages = validatedPool(encoded.pools.stages, "save.state.rollbackHistory.pools.stages", stagePool);
  let activeFormat: "tuple" | "object" = "object";
  let active: Array<NovelCompressedRollbackActive | NovelCompressedRollbackActiveV4 | Extract<RollbackCheckpoint["active"], { kind: "say" }>>;
  if (compactVersion === 4) {
    if (!Array.isArray(encoded.pools.active)) fail("save.state.rollbackHistory.pools.active", "must be an array.");
    activeFormat = "tuple";
    active = validatedPool(
      encoded.pools.active,
      "save.state.rollbackHistory.pools.active",
      (item, path): item is NovelCompressedRollbackActiveV4 => validateCompactActivePoolV4(item, path, texts, richPool, usedTexts, usedRich),
    );
  } else if (compactVersion === 3) {
    if (!Array.isArray(encoded.pools.active)) fail("save.state.rollbackHistory.pools.active", "must be an array.");
    const values = encoded.pools.active;
    const firstIsTuple = values.length === 0 || Array.isArray(values[0]);
    const mixedFormat = values.some(item => Array.isArray(item) !== firstIsTuple);
    if (mixedFormat) fail("save.state.rollbackHistory.pools.active", "must not mix compact tuples and legacy completed dialogue objects.");
    activeFormat = firstIsTuple ? "tuple" : "object";
    active = firstIsTuple
      ? validatedPool(values, "save.state.rollbackHistory.pools.active", validateCompactActivePool)
      : validatedPool(values, "save.state.rollbackHistory.pools.active", legacyV3ActivePool);
  } else {
    active = validatedPool(encoded.pools.active, "save.state.rollbackHistory.pools.active", activePool);
  }
  const audioIntents = validatedPool(encoded.pools.audioIntents, "save.state.rollbackHistory.pools.audioIntents", audioPool);
  if (!Array.isArray(encoded.entries)) fail("save.state.rollbackHistory.entries", "must be an array.");

  const usedVariables = new Set<number>();
  const usedStages = new Set<number>();
  const usedActive = new Set<number>();
  const usedAudioIntents = new Set<number>();
  const rollbackHistory: RollbackCheckpoint[] = encoded.entries.map((entry, index) => {
    const path = `save.state.rollbackHistory.entries[${index}]`;
    if (!Array.isArray(entry) || entry.length !== 8) fail(path, "must be an eight-field checkpoint tuple.");
    if (typeof entry[0] !== "string" || !Number.isSafeInteger(entry[1]) || (entry[1] as number) < 0) {
      fail(path, "must contain a script label and non-negative safe instruction index.");
    }
    if (!Array.isArray(entry[2])) fail(`${path}[2]`, "call stack must be an array.");
    if (!Number.isSafeInteger(entry[3]) || (entry[3] as number) < 0) {
      fail(`${path}[3]`, "backlog cursor must be a non-negative safe integer.");
    }
    const entryLocation = { label: entry[0] as string, index: entry[1] as number };
    let activeState: Extract<RollbackCheckpoint["active"], { kind: "say" }>;
    if (compactVersion === 4) {
      activeState = expandCompactActivePoolV4(requiredPool(
        active as readonly NovelCompressedRollbackActiveV4[],
        entry[6], `${path}[6]`,
        (item, itemPath): item is NovelCompressedRollbackActiveV4 => validateCompactActivePoolV4(item, itemPath, texts, richPool, usedTexts, usedRich),
        usedActive,
      ), `${path}[6]`, texts, richPool, usedTexts, usedRich);
    } else if (compactVersion === 3 && activeFormat === "tuple") {
      activeState = expandCompactActivePool(requiredPool(
        active as readonly NovelCompressedRollbackActive[], entry[6], `${path}[6]`, validateCompactActivePool, usedActive,
      ), `${path}[6]`);
    } else if (compactVersion === 3) {
      const legacyState = requiredPool(
        active as readonly Extract<RollbackCheckpoint["active"], { kind: "say" }>[],
        entry[6], `${path}[6]`, legacyV3ActivePool, usedActive,
      );
      activeState = expandCompactActivePool(compactActivePool(legacyState, `${path}[6]`), `${path}[6]`);
    } else {
      activeState = requiredPool(
        active as readonly Extract<RollbackCheckpoint["active"], { kind: "say" }>[],
        entry[6], `${path}[6]`, activePool, usedActive,
      );
    }
    const checkpoint: RollbackCheckpoint = {
      location: entryLocation,
      callStack: entry[2] as unknown as RollbackCheckpoint["callStack"],
      backlogSequence: entry[3] as number,
      variables: requiredPool(variables, entry[4], `${path}[4]`, variablePool, usedVariables),
      stage: requiredPool(stages, entry[5], `${path}[5]`, stagePool, usedStages),
      active: activeState,
      audioIntents: requiredPool(audioIntents, entry[7], `${path}[7]`, audioPool, usedAudioIntents),
    };
    return {
      ...checkpoint,
      location: { label: checkpoint.location.label, index: checkpoint.location.index },
      callStack: copyJson(checkpoint.callStack, `${path}.callStack`) as unknown as RollbackCheckpoint["callStack"],
      variables: copyJson(checkpoint.variables, `${path}.variables`) as RollbackCheckpoint["variables"],
      stage: copyJson(checkpoint.stage, `${path}.stage`) as unknown as RollbackCheckpoint["stage"],
      active: copyJson(checkpoint.active, `${path}.active`) as unknown as RollbackCheckpoint["active"],
      audioIntents: copyJson(checkpoint.audioIntents, `${path}.audioIntents`) as unknown as RollbackCheckpoint["audioIntents"],
    };
  });

  for (const [path, used, pool] of [
    ["variables", usedVariables, variables],
    ["stages", usedStages, stages],
    ["active", usedActive, active],
    ["audioIntents", usedAudioIntents, audioIntents],
  ] as const) {
    if (used.size !== pool.length) fail(`save.state.rollbackHistory.pools.${path}`, "contains an unreferenced value.");
  }
  const expandedState: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, stateValue] of Object.entries(snapshot.state)) {
    if (key !== "rollbackHistory" && key !== "backlog" && (compactVersion !== 4 || (key !== "textPool" && key !== "richPool"))) expandedState[key] = stateValue;
  }
  if (compactVersion === 4 && record(expandedState.active) && Object.hasOwn(expandedState.active, "richRef")) {
    const activeValue = expandedState.active;
    if (Object.hasOwn(activeValue, "rich")) fail("save.state.active", "must not contain both rich metadata and a richRef.");
    const rich = referencedRich(activeValue.richRef, richPool, texts, usedTexts, usedRich, "save.state.active.richRef");
    const richPoolIndex = activeValue.richRef as number;
    const richText = referencedText(richPool[richPoolIndex]![0], texts, "save.state.active.richRef.text", usedTexts);
    if (activeValue.text !== richText) fail("save.state.active.richRef", "does not match the active rendered text.");
    const { richRef: _richRef, ...active } = activeValue;
    expandedState.active = { ...active, rich };
  }
  expandedState.backlog = compactVersion === 3 || compactVersion === 4 ? expandedBacklog : snapshot.state.backlog;
  expandedState.rollbackHistory = rollbackHistory;
  if (compactVersion === 4 && usedTexts.size !== texts.length) {
    fail("save.state.textPool", "contains an unreferenced rendered-text value.");
  }
  if (compactVersion === 4 && usedRich.size !== richPool.length) {
    fail("save.state.richPool", "contains an unreferenced rich annotation value.");
  }
  const expanded: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, saveValue] of Object.entries(snapshot)) {
    if (key !== "formatVersion" && key !== "state") expanded[key] = saveValue;
  }
  expanded.format = "pocket-vn-save";
  expanded.formatVersion = 1;
  expanded.state = expandedState;
  return expanded as unknown as NovelSaveData;
}
