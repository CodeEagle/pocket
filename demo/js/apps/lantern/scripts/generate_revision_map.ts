import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type PlainRecord = Record<string, unknown>;
type StoryData = {
  id: string;
  version: number;
  script: Record<string, unknown[]>;
};

const hiyoriFramingLabels = [
  "model_showcase_hiyori_idle_0",
  "model_showcase_hiyori_idle_0_closeup",
  "model_showcase_hiyori_idle_1",
  "model_showcase_hiyori_idle_1_closeup",
  "model_showcase_hiyori_tap_body",
  "model_showcase_hiyori_tap_body_closeup",
] as const;

function fail(message: string): never {
  throw new Error(`revision map: ${message}`);
}

function record(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract and evaluate only the static story data expression; never evaluate app.js. */
function parseStoryLiteral(source: string): unknown {
  const marker = "var story_default =";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0 || source.indexOf(marker, markerIndex + marker.length) >= 0) {
    fail("expected exactly one bundled story_default assignment in the legacy app source");
  }
  let cursor = markerIndex + marker.length;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] !== "{") fail("story_default is not an object literal");
  const start = cursor;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) break;
  }
  if (depth !== 0 || quote) fail("unterminated story_default object literal");
  const literal = source.slice(start, cursor + 1);
  let terminator = cursor + 1;
  while (/\s/.test(source[terminator] ?? "")) terminator += 1;
  if (source[terminator] !== ";") fail("legacy story literal is not terminated by a semicolon");
  // The source is a pinned generated artifact and the evaluated expression is
  // only its static story data object, never its app/runtime code.
  let extracted: unknown;
  try { extracted = new Function(`"use strict"; return (${literal});`)(); }
  catch (error) { fail(`cannot parse the isolated story data literal: ${String(error)}`); }
  const serialized = JSON.stringify(extracted);
  if (!serialized) fail("story data literal is not JSON serializable");
  return JSON.parse(serialized) as unknown;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as PlainRecord;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function hiyoriFramingComparable(instruction: unknown): string | null {
  if (!record(instruction) || instruction.type !== "scene" || !Array.isArray(instruction.characters)) return null;
  const characters = instruction.characters;
  const sampleIndexes = characters.flatMap((character, index) =>
    record(character) && character.id === "sample_hiyori" ? [index] : []);
  if (sampleIndexes.length !== 1) return null;
  const sample = characters[sampleIndexes[0]!];
  if (!record(sample) || !Object.hasOwn(sample, "position") || !Object.hasOwn(sample, "scale")) return null;
  const copy = JSON.parse(JSON.stringify(instruction)) as PlainRecord;
  const copiedCharacters = copy.characters as unknown[];
  const copiedSample = copiedCharacters[sampleIndexes[0]] as PlainRecord;
  delete copiedSample.position;
  delete copiedSample.scale;
  return canonical(copy);
}

function sameHiyoriFramingInstruction(oldInstruction: unknown, nextInstruction: unknown): boolean {
  const oldComparable = hiyoriFramingComparable(oldInstruction);
  return oldComparable !== null && oldComparable === hiyoriFramingComparable(nextInstruction);
}

function sameInstruction(oldInstruction: unknown, nextInstruction: unknown, allowHiyoriFraming: boolean): boolean {
  if (!record(oldInstruction) || !record(nextInstruction)) return false;
  return canonical(oldInstruction) === canonical(nextInstruction) ||
    allowHiyoriFraming && sameHiyoriFramingInstruction(oldInstruction, nextInstruction);
}

function mapLegacyInstructions(
  oldStory: StoryData,
  nextStory: StoryData,
  reorderedLabels: ReadonlySet<string>,
  allowHiyoriFramingLabels: ReadonlySet<string>,
): Record<string, number[]> {
  const result: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (const label of reorderedLabels) if (!Object.hasOwn(oldStory.script, label)) fail(`unknown reordered label '${label}'`);
  for (const label of Object.keys(oldStory.script).sort()) {
    const oldInstructions = oldStory.script[label];
    const nextInstructions = nextStory.script[label];
    if (!Array.isArray(oldInstructions) || !Array.isArray(nextInstructions)) fail(`target story is missing legacy label '${label}'`);
    const indexes: number[] = [];
    const used = new Set<number>();
    let cursor = 0;
    for (const [oldIndex, oldInstruction] of oldInstructions.entries()) {
      const found = nextInstructions.findIndex((candidate, index) =>
        (reorderedLabels.has(label) ? !used.has(index) : index >= cursor) &&
        sameInstruction(oldInstruction, candidate, allowHiyoriFramingLabels.has(label)));
      if (found < 0) fail(`old instruction ${label}[${oldIndex}] has no unused exact match${reorderedLabels.has(label) ? "" : " in sequence"} in the target script`);
      indexes.push(found);
      used.add(found);
      cursor = found + 1;
    }
    // A saved next-instruction cursor can legally equal the old label length.
    // Store the new label length as the final explicit end-position sentinel.
    indexes.push(nextInstructions.length);
    result[label] = indexes;
  }
  return result;
}

const projectRoot = resolve(import.meta.dir, "../../../../..");
const defaults = {
  legacyApp: resolve(projectRoot, "sdk/.pocket-build/novel-highres-20261107/final-y70-guest/app.js"),
  targetStory: resolve(import.meta.dir, "../story.json"),
  output: resolve(import.meta.dir, "../revision-map.json"),
};
const options = { ...defaults };
const reorderedLabels = new Set<string>();
const allowHiyoriFramingLabels = new Set<string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value || !flag?.startsWith("--")) fail("usage: bun scripts/generate_revision_map.ts [--legacy-app path] [--target-story path] [--out path] [--reordered-labels label,label] [--hiyori-framing-labels label,label]");
  if (flag === "--reordered-labels") {
    for (const label of value.split(",")) {
      if (!label || reorderedLabels.has(label)) fail("reordered labels must be unique, nonempty names");
      reorderedLabels.add(label);
    }
    index += 1;
    continue;
  }
  if (flag === "--hiyori-framing-labels") {
    for (const label of value.split(",")) {
      if (!label || allowHiyoriFramingLabels.has(label)) fail("Hiyori framing labels must be unique, nonempty names");
      if (!(hiyoriFramingLabels as readonly string[]).includes(label)) fail(`Hiyori framing exception is not allowed for '${label}'`);
      allowHiyoriFramingLabels.add(label);
    }
    index += 1;
    continue;
  }
  const resolved = resolve(process.cwd(), value);
  if (flag === "--legacy-app") options.legacyApp = resolved;
  else if (flag === "--target-story") options.targetStory = resolved;
  else if (flag === "--out") options.output = resolved;
  else fail(`unknown option ${flag}`);
  index += 1;
}

const legacySource = readFileSync(options.legacyApp, "utf8");
const oldStory = parseStoryLiteral(legacySource);
const nextStory = JSON.parse(readFileSync(options.targetStory, "utf8")) as StoryData;
if (!record(oldStory) || typeof oldStory.id !== "string" || !Number.isSafeInteger(oldStory.version) || !record(oldStory.script)) {
  fail("extracted story_default is not a valid story data object");
}
if (oldStory.id !== nextStory.id || !Number.isSafeInteger(nextStory.version) || nextStory.version <= oldStory.version) {
  fail("legacy and target story identity/version are not an upgrade pair");
}
const legacyJson = JSON.stringify(oldStory);
if (!legacyJson) fail("legacy story data cannot be represented as JSON");
for (const label of allowHiyoriFramingLabels) {
  if (!Object.hasOwn(oldStory.script, label) || !Object.hasOwn(nextStory.script, label)) fail(`Hiyori framing label '${label}' must exist in both stories`);
  const oldScenes = oldStory.script[label]!.filter(instruction => record(instruction) && instruction.type === "scene");
  const nextScenes = nextStory.script[label]!.filter(instruction => record(instruction) && instruction.type === "scene");
  if (oldScenes.length !== 1 || nextScenes.length !== 1 ||
      hiyoriFramingComparable(oldScenes[0]) === null || hiyoriFramingComparable(nextScenes[0]) === null) {
    fail(`Hiyori framing label '${label}' must have one scene with sample_hiyori position and scale`);
  }
}
const revisionMap = {
  format: "pocket-vn-revision-map",
  formatVersion: 1,
  storyId: oldStory.id,
  fromVersion: oldStory.version,
  toVersion: nextStory.version,
  legacySourceSha256: createHash("sha256").update(legacySource).digest("hex"),
  legacyStorySha256: createHash("sha256").update(canonical(oldStory)).digest("hex"),
  labelIndexes: mapLegacyInstructions(oldStory as StoryData, nextStory, reorderedLabels, allowHiyoriFramingLabels),
};
writeFileSync(options.output, `${JSON.stringify(revisionMap, null, 2)}\n`, "utf8");
console.log(`Wrote ${Object.keys(revisionMap.labelIndexes).length} labels from story v${revisionMap.fromVersion} to v${revisionMap.toVersion}.`);
if (reorderedLabels.size) console.log(`Explicitly reordered labels: ${[...reorderedLabels].sort().join(", ")}`);
if (allowHiyoriFramingLabels.size) console.log(`Explicitly adjusted sample_hiyori framing labels: ${[...allowHiyoriFramingLabels].sort().join(", ")}`);
console.log(`Legacy source SHA-256: ${revisionMap.legacySourceSha256}`);
console.log(`Legacy story SHA-256: ${revisionMap.legacyStorySha256}`);
