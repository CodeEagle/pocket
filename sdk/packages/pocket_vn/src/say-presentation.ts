import type { NovelSayPresentation } from "./types.ts";

export const NOVEL_SAY_PRESENTATIONS = ["dialogue", "fullscreen", "floating"] as const satisfies readonly NovelSayPresentation[];

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate the optional, backwards-compatible presentation field on one say instruction. */
export function novelSayPresentationInstructionIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "say") return "type must be 'say'";
  if (value.presentation !== undefined && !NOVEL_SAY_PRESENTATIONS.includes(value.presentation as NovelSayPresentation)) {
    return "presentation must be 'dialogue', 'fullscreen', or 'floating'";
  }
  return null;
}
