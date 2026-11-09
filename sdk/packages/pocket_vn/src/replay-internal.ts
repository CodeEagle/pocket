import { createNovelEngine, NovelEngineError, StoryValidationError } from "./engine.ts";
import { novelReplayEntriesIssue } from "./replay-schema.ts";
import type { NovelReplaySource } from "./replay.ts";
import type { NovelEngine, NovelEngineOptions, NovelReplayEntry, StoryDefinition } from "./types.ts";

/** Shared replay declaration validation for the player and editor preview paths. */
export function resolveNovelReplayEntry(story: StoryDefinition, entryId: string): NovelReplayEntry {
  const issue = novelReplayEntriesIssue(story.replayEntries, story.script);
  if (issue !== null) throw new StoryValidationError(issue);
  const entry = story.replayEntries?.find(candidate => candidate.id === entryId);
  if (!entry) throw new NovelEngineError(`Unknown story replay entry '${entryId}'`);
  return entry;
}

/**
 * Build the ordinary isolated engine used by a replay. Only the seed fields
 * already defined by the replay contract are copied; stage and runtime state
 * remain fresh, and manual mode is always used.
 */
export function createNovelReplaySeedEngine(
  story: StoryDefinition,
  source: NovelReplaySource,
  options: Pick<NovelEngineOptions, "maxBacklogEntries" | "maxRollbackEntries" | "maxStepBudget"> = {},
): NovelEngine {
  return createNovelEngine(story, {
    ...options,
    initialVariables: source.variables,
    initialMeta: source.meta,
    preferences: { ...source.preferences, mode: "manual" },
  });
}
