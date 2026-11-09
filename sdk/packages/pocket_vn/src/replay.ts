import { NovelEngineError } from "./engine.ts";
import { createNovelReplaySeedEngine, resolveNovelReplayEntry } from "./replay-internal.ts";
import type { EngineSnapshot, NovelEngine, StoryDefinition } from "./types.ts";

export { novelReplayEntriesIssue } from "./replay-schema.ts";

/** Read-only seed data copied into an isolated replay engine. */
export type NovelReplaySource = Pick<EngineSnapshot, "variables" | "meta" | "preferences">;

/**
 * Create an ordinary Pocket VN engine at a declared replay entry. Variables,
 * meta, and preferences are copied through the regular engine constructor;
 * replay writes remain local to the returned engine. Entries must establish
 * their own stage because the source engine's historical stage is not guessed.
 */
export function createNovelReplayEngine(
  story: StoryDefinition,
  source: NovelReplaySource,
  entryId: string,
): NovelEngine {
  const entry = resolveNovelReplayEntry(story, entryId);
  if (entry.unlockEndingId !== undefined && !source.meta.endingIds.includes(entry.unlockEndingId)) {
    throw new NovelEngineError(`Story replay entry '${entryId}' is locked`);
  }

  const replay = createNovelReplaySeedEngine(story, source);
  try {
    replay.debug.jump(entry.location);
    replay.debug.resume();
    return replay;
  } catch (error) {
    replay.dispose();
    throw error;
  }
}
