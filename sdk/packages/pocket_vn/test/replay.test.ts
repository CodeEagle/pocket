import { expect, test } from "bun:test";
import { formatStoryText, parseStoryText } from "../src/authoring.ts";
import { createNovelEngine, createNovelReplayEngine, NovelEngineError, novelReplayEntriesIssue, StoryValidationError } from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";

function finishSay(engine: ReturnType<typeof createNovelEngine>): void {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected dialogue");
  if (!active.complete) engine.advance();
  engine.advance();
}

const story: StoryDefinition = {
  id: "gallery-replay", version: 1, start: "start",
  variableDefinitions: { score: { lifetime: "save", defaultValue: 0 } },
  replayEntries: [
    { id: "memory", title: "The memory", location: { label: "memory", index: 0 }, unlockEndingId: "proof", badge: "gallery" },
  ],
  script: {
    start: [
      { type: "audio", cue: "ambient", action: "play" },
      { type: "audio", cue: "wind", channel: "ambience", loop: true },
      { type: "audio", cue: "stopped", action: "stop", channel: "music" },
      { type: "audio", cue: "main-track", channel: "music", loop: true },
      { type: "set", variable: "score", value: 7 },
      { type: "say", id: "unlock", text: "The story remembers." },
      { type: "ending", id: "proof", cg: "proof-cg" },
    ],
    memory: [
      { type: "scene", background: "memory-room", characters: [{ id: "mira", expression: "hopeful", position: "center" }] },
      { type: "audio", cue: "memory-track", channel: "music", loop: true },
      { type: "say", id: "memory-line", text: "A replay begins here." },
      { type: "inc", variable: "score", amount: 100 },
      { type: "ending", id: "replayed", cg: "replay-cg" },
    ],
  },
};

test("replay declarations share engine validation and round-trip through story text", () => {
  expect(novelReplayEntriesIssue(undefined)).toBeNull();
  expect(novelReplayEntriesIssue(story.replayEntries, story.script)).toBeNull();
  expect(novelReplayEntriesIssue([
    { id: "same", title: "First", location: { label: "start", index: 0 } },
    { id: "same", title: "Second", location: { label: "start", index: 0 } },
  ], story.script)).toContain("duplicated");
  expect(novelReplayEntriesIssue([{ id: "missing", title: "Missing", location: { label: "nope", index: 0 } }], story.script)).toContain("existing story instruction");
  expect(novelReplayEntriesIssue([{ id: "bad-ending", title: "Bad", location: { label: "start", index: 0 }, unlockEndingId: "elsewhere" }], story.script)).toContain("existing ending");
  expect(() => createNovelEngine({ ...story, replayEntries: [{ id: "bad", title: "Bad", location: { label: "start", index: 99 } }] })).toThrow(StoryValidationError);

  const parsed = parseStoryText(formatStoryText(story));
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story?.replayEntries).toEqual(story.replayEntries);
});

test("only actually executed music-channel play instructions unlock a cue and meta remains monotonic", () => {
  const engine = createNovelEngine(story, { initialMeta: { readLineIds: [], endingIds: [], cgIds: [], musicIds: ["older-track"] } });
  const started = engine.start();
  expect(started.snapshot.meta.musicIds).toEqual(["older-track", "main-track"]);
  const save = engine.save();
  expect(save.state.meta.musicIds).toEqual(["older-track", "main-track"]);
  const loaded = createNovelEngine(story, { initialMeta: { readLineIds: [], endingIds: [], cgIds: [], musicIds: ["newer-track"] } });
  loaded.load(save);
  expect(loaded.getSnapshot().meta.musicIds).toEqual(["newer-track", "older-track", "main-track"]);
  finishSay(loaded);
  expect(loaded.getSnapshot().meta.musicIds).toEqual(["newer-track", "older-track", "main-track"]);
  loaded.newGame();
  expect(loaded.getSnapshot().meta.musicIds).toEqual(["newer-track", "older-track", "main-track"]);
});

test("same-core replay is gated, starts in its own scene, and cannot change source state or metadata", () => {
  const live = createNovelEngine(story, {
    initialVariables: { score: 3 },
    preferences: { mode: "skip", textSpeedCharsPerSecond: 0, skipSeenOnly: true },
  });
  expect(() => createNovelReplayEngine(story, live.getSnapshot(), "memory")).toThrow(NovelEngineError);
  live.start();
  finishSay(live);
  expect(live.getSnapshot().meta.endingIds).toContain("proof");
  expect(live.getSnapshot().meta.musicIds).toContain("main-track");
  const before = live.getSnapshot();
  const beforeSave = live.save();

  const replay = createNovelReplayEngine(story, before, "memory");
  expect(replay.getSnapshot()).toMatchObject({
    paused: false,
    preferences: { mode: "manual", textSpeedCharsPerSecond: 0, skipSeenOnly: true },
    active: { kind: "say", id: "memory-line", complete: true },
    stage: { background: "memory-room" },
    variables: { score: 7 },
    meta: { endingIds: ["proof"], musicIds: ["main-track", "memory-track"] },
  });
  finishSay(replay);
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "ending", id: "replayed" },
    variables: { score: 107 },
    meta: { endingIds: ["proof", "replayed"], cgIds: ["proof-cg", "replay-cg"], musicIds: ["main-track", "memory-track"] },
  });
  expect(live.getSnapshot()).toBe(before);
  expect(live.save()).toEqual(beforeSave);
  replay.dispose();
});
