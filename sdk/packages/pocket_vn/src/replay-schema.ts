import type { StoryInstruction } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate story replay declarations. Unknown JSON authoring fields are left
 * alone; the engine's JSON boundary validates their serializability.
 */
export function novelReplayEntriesIssue(
  value: unknown,
  script?: unknown,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "replayEntries must be an array.";
  if (script !== undefined && !isRecord(script)) return "story.script must be an object.";
  const ids = new Set<string>();
  const endingIds = script === undefined ? undefined : new Set<string>();
  if (isRecord(script) && endingIds) {
    for (const instructions of Object.values(script)) {
      if (!Array.isArray(instructions)) continue;
      for (const instruction of instructions) {
        if (isRecord(instruction) && instruction.type === "ending" && isNonEmptyString(instruction.id)) endingIds.add(instruction.id);
      }
    }
  }
  for (let index = 0; index < value.length; index++) {
    const path = `replayEntries[${index}]`;
    if (!Object.hasOwn(value, index)) return `${path} must be an object.`;
    const entry = value[index];
    if (!isRecord(entry)) return `${path} must be an object.`;
    if (!isNonEmptyString(entry.id)) return `${path}.id must be a non-empty string.`;
    if (ids.has(entry.id)) return `${path}.id '${entry.id}' is duplicated.`;
    ids.add(entry.id);
    if (!isNonEmptyString(entry.title)) return `${path}.title must be a non-empty string.`;
    const location = entry.location;
    if (!isRecord(location) || !isNonEmptyString(location.label) || !Number.isSafeInteger(location.index) || (location.index as number) < 0) {
      return `${path}.location requires a label and non-negative safe integer index.`;
    }
    if (isRecord(script)) {
      const instructions = script[location.label];
      if (!Object.hasOwn(script, location.label) || !Array.isArray(instructions) || (location.index as number) >= instructions.length) {
        return `${path}.location must point to an existing story instruction.`;
      }
    }
    if (entry.unlockEndingId !== undefined) {
      if (!isNonEmptyString(entry.unlockEndingId)) return `${path}.unlockEndingId must be a non-empty string.`;
      if (endingIds !== undefined && !endingIds.has(entry.unlockEndingId)) {
        return `${path}.unlockEndingId '${entry.unlockEndingId}' does not reference an existing ending.`;
      }
    }
  }
  return null;
}
