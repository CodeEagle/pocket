import { expect, test } from "bun:test";
import {
  createNovelEngine,
  NovelEngineError,
  StoryValidationError,
} from "../src/engine.ts";
import { encodeNovelSaveData, decodeNovelSaveData } from "../src/save-codec.ts";
import { formatStoryText, parseStoryText } from "../src/authoring.ts";
import { rebaseNovelSaveDataForLocale } from "../src/localization.ts";
import type { NovelSaveData, StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "video-stage-test",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "video", action: "play", cue: "harbor_loop", loop: true },
      { type: "say", id: "first", text: "A quiet harbor." },
      { type: "video", action: "play", cue: "memory_cutscene" },
      { type: "say", id: "second", text: "A remembered letter." },
      { type: "video", action: "pause" },
      { type: "video", action: "close" },
      { type: "ending", id: "done" },
    ],
  },
};

function finishSay(engine: ReturnType<typeof createNovelEngine>) {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected a dialogue line");
  if (!active.complete) engine.advance();
  return engine.advance();
}

test("video play/pause/close are non-blocking and native pause facts do not overwrite intent", () => {
  const engine = createNovelEngine(story);
  const started = engine.start();
  const firstToken = started.snapshot.videoToken;
  expect(started.snapshot.active).toMatchObject({ kind: "say", id: "first" });
  expect(started.snapshot.stage.video).toEqual({
    cue: "harbor_loop", loop: true, positionMs: 0, durationMs: null, status: "playing",
  });
  expect(started.events).toMatchObject([{ type: "videoCue", action: "play", cue: "harbor_loop", loop: true, token: firstToken, positionMs: 0 }]);
  expect(firstToken).toBeString();

  engine.tick(5_000);
  expect(engine.getSnapshot().stage.video?.positionMs).toBe(0);
  expect(engine.reportVideo({ token: firstToken!, status: "paused", positionMs: 25, durationMs: 1_200 }).snapshot.stage.video).toEqual({
    cue: "harbor_loop", loop: true, positionMs: 25, durationMs: 1_200, status: "playing",
  });
  expect(() => engine.reportVideo({ token: firstToken!, status: "ended", positionMs: 1_200, durationMs: 1_200 })).toThrow(/looping/);

  const cutscene = finishSay(engine);
  const cutsceneToken = cutscene.snapshot.videoToken;
  expect(cutscene.snapshot.stage.video).toEqual({
    cue: "memory_cutscene", loop: false, positionMs: 0, durationMs: null, status: "playing",
  });
  expect(cutscene.events[0]).toMatchObject({ type: "videoCue", action: "play", cue: "memory_cutscene", loop: false, token: cutsceneToken });
  const beforeStale = cutscene.snapshot.stage.video;
  expect(engine.reportVideo({ token: firstToken!, status: "ended", positionMs: 1_200, durationMs: 1_200 }).snapshot.stage.video).toEqual(beforeStale);

  const ended = engine.reportVideo({ token: cutsceneToken!, status: "ended", positionMs: 650, durationMs: 650 });
  expect(ended.snapshot.stage.video?.status).toBe("ended");
  expect(engine.reportVideo({ token: cutsceneToken!, status: "paused", positionMs: 500, durationMs: 650 }).snapshot.stage.video).toEqual(ended.snapshot.stage.video);

  const closed = finishSay(engine);
  expect(closed.snapshot.stage.video).toBeNull();
  expect(closed.events.map(event => event.type === "videoCue" ? event.action : null)).toEqual(["pause", "close"]);
  expect(closed.events.every(event => event.type !== "videoCue" || event.sequence > 0)).toBe(true);
  engine.dispose();
});

test("seek requires known duration, rejects overflow atomically, and adopts only native position facts", () => {
  const seekStory: StoryDefinition = {
    id: "video-seek-test", version: 1, start: "start", script: { start: [
      { type: "video", action: "play", cue: "clip" },
      { type: "say", id: "before-seek", text: "Inspect before seeking." },
      { type: "video", action: "seek", positionMs: 250 },
      { type: "ending", id: "done" },
    ] },
  };
  const engine = createNovelEngine(seekStory);
  engine.start();
  const token = engine.getSnapshot().videoToken!;
  engine.reportVideo({ token, status: "playing", positionMs: 40, durationMs: 250 });
  engine.advance();
  const update = engine.advance();
  expect(update.events).toMatchObject([{ type: "videoCue", action: "seek", positionMs: 250 }]);
  expect(update.snapshot.stage.video?.positionMs).toBe(40);
  expect(update.snapshot.stage.video?.status).toBe("playing");
  const seekToken = update.snapshot.videoToken!;
  expect(engine.reportVideo({ token, status: "playing", positionMs: 100, durationMs: 250 }).snapshot.stage.video?.positionMs).toBe(40);
  expect(engine.reportVideo({ token: seekToken, status: "paused", positionMs: 250, durationMs: 250 }).snapshot.stage.video?.positionMs).toBe(250);
  engine.dispose();

  const outOfRange: StoryDefinition = {
    ...seekStory,
    id: "video-seek-range-test",
    script: { start: [
      { type: "video", action: "play", cue: "clip" },
      { type: "say", id: "before-seek", text: "Too far." },
      { type: "video", action: "seek", positionMs: 251 },
      { type: "ending", id: "done" },
    ] },
  };
  const bounded = createNovelEngine(outOfRange);
  bounded.start();
  bounded.reportVideo({ token: bounded.getSnapshot().videoToken!, status: "playing", positionMs: 40, durationMs: 250 });
  bounded.advance();
  const before = bounded.getSnapshot();
  expect(() => bounded.advance()).toThrow(NovelEngineError);
  expect(bounded.getSnapshot()).toEqual(before);
  expect(bounded.getSnapshot().stage.video?.positionMs).toBe(40);
  bounded.dispose();

  const unknownDuration = createNovelEngine(outOfRange);
  unknownDuration.start();
  unknownDuration.advance();
  expect(() => unknownDuration.advance()).toThrow(/known before seeking/);
  unknownDuration.dispose();
});

test("player video controls share instruction validation, preserve state invariants, and persist through save/load", () => {
  const engine = createNovelEngine(story);
  const beforeStart = engine.save();
  expect(() => engine.controlVideo({ type: "video", action: "play", cue: "clip" })).toThrow(/started/i);
  expect(engine.save()).toEqual(beforeStart);

  engine.start();
  const initialToken = engine.getSnapshot().videoToken!;
  engine.reportVideo({ token: initialToken, status: "playing", positionMs: 1_250, durationMs: 3_000 });
  const paused = engine.controlVideo({ type: "video", action: "pause" });
  expect(paused.snapshot.stage.video).toMatchObject({ cue: "harbor_loop", status: "paused", positionMs: 1_250, durationMs: 3_000 });
  expect(paused.snapshot.videoToken).not.toBe(initialToken);
  expect(paused.events).toMatchObject([{ type: "videoCue", action: "pause", token: paused.snapshot.videoToken }]);

  const resumed = engine.controlVideo({ type: "video", action: "play", cue: "harbor_loop", loop: true });
  expect(resumed.snapshot.stage.video).toMatchObject({ status: "playing", positionMs: 1_250, durationMs: 3_000 });
  expect(resumed.snapshot.videoToken).not.toBe(paused.snapshot.videoToken);
  const seek = engine.controlVideo({ type: "video", action: "seek", positionMs: 2_500 });
  expect(seek.events).toMatchObject([{ type: "videoCue", action: "seek", positionMs: 2_500, token: seek.snapshot.videoToken }]);
  expect(seek.snapshot.stage.video?.positionMs).toBe(1_250);
  expect(seek.snapshot.videoToken).not.toBe(resumed.snapshot.videoToken);

  const beforeInvalid = engine.save();
  expect(() => engine.controlVideo({ type: "video", action: "seek", positionMs: 3_001 })).toThrow(/durationMs/);
  expect(() => engine.controlVideo({ type: "video", action: "play", cue: "clip", muted: true } as never)).toThrow(/muted/);
  expect(engine.save()).toEqual(beforeInvalid);

  const loaded = createNovelEngine(story);
  loaded.load(engine.save());
  expect(loaded.getSnapshot().stage.video).toEqual(engine.getSnapshot().stage.video);
  expect(loaded.getSnapshot().videoToken).not.toBe(engine.getSnapshot().videoToken);
  const closed = loaded.controlVideo({ type: "video", action: "close" });
  expect(closed.snapshot.stage.video).toBeNull();
  expect(closed.snapshot.videoToken).toBeNull();
  expect(() => loaded.controlVideo({ type: "video", action: "seek", positionMs: 0 })).toThrow(/without an active video/);
  expect(loaded.getSnapshot().stage.video).toBeNull();
  engine.dispose();
  loaded.dispose();
});

test("player replay from ended restarts the same cue at real zero without inventing position", () => {
  const endedStory: StoryDefinition = {
    id: "video-ended-replay-test", version: 1, start: "start", script: { start: [
      { type: "video", action: "play", cue: "cutscene" },
      { type: "say", id: "wait", text: "The native player reports completion." },
    ] },
  };
  const engine = createNovelEngine(endedStory);
  engine.start();
  const token = engine.getSnapshot().videoToken!;
  engine.reportVideo({ token, status: "playing", positionMs: 700, durationMs: 700 });
  engine.reportVideo({ token, status: "ended", positionMs: 700, durationMs: 700 });
  const replay = engine.controlVideo({ type: "video", action: "play", cue: "cutscene" });
  expect(replay.snapshot.stage.video).toEqual({ cue: "cutscene", loop: false, positionMs: 0, durationMs: 700, status: "playing" });
  expect(replay.snapshot.videoToken).not.toBe(token);
  expect(replay.events).toMatchObject([{ type: "videoCue", action: "play", positionMs: 0 }]);
  engine.dispose();
});

test("save, v2 codec, rollback, locale rebase, and old v1 saves retain one stage-owned overlay", () => {
  const engine = createNovelEngine(story);
  engine.start();
  const firstToken = engine.getSnapshot().videoToken!;
  engine.reportVideo({ token: firstToken, status: "playing", positionMs: 80, durationMs: 900 });
  finishSay(engine);
  const cutsceneToken = engine.getSnapshot().videoToken!;
  engine.reportVideo({ token: cutsceneToken, status: "paused", positionMs: 120, durationMs: 700 });
  const saved = engine.save();
  expect(saved.state.stage.video).toEqual({
    cue: "memory_cutscene", loop: false, positionMs: 120, durationMs: 700, status: "playing",
  });
  expect(saved.state.rollbackHistory[0]?.stage.video).toEqual({
    cue: "harbor_loop", loop: true, positionMs: 80, durationMs: 900, status: "playing",
  });

  const compact = encodeNovelSaveData(saved);
  const expanded = decodeNovelSaveData(compact);
  expect(expanded.state.stage.video).toEqual(saved.state.stage.video);
  expect(expanded.state.rollbackHistory[0]?.stage.video).toEqual(saved.state.rollbackHistory[0]?.stage.video);

  const localizedStory: StoryDefinition = {
    ...story,
    script: { start: story.script.start.map(instruction => instruction.type === "say"
      ? { ...instruction, text: instruction.id === "first" ? "Ein stiller Hafen." : "Ein erinnerter Brief." }
      : instruction) },
  };
  const rebased = rebaseNovelSaveDataForLocale(saved, story, localizedStory);
  expect(rebased.state.stage.video).toEqual(saved.state.stage.video);
  expect(rebased.state.rollbackHistory[0]?.stage.video).toEqual(saved.state.rollbackHistory[0]?.stage.video);

  const loaded = createNovelEngine(story);
  loaded.load(compact);
  expect(loaded.getSnapshot().stage.video).toEqual(saved.state.stage.video);
  expect(loaded.getSnapshot().videoToken).not.toBe(cutsceneToken);
  loaded.rollback();
  expect(loaded.getSnapshot().stage.video).toEqual(saved.state.rollbackHistory[0]?.stage.video);
  expect(loaded.getSnapshot().videoToken).not.toBe(firstToken);
  expect(loaded.reportVideo({ token: cutsceneToken, status: "ended", positionMs: 700, durationMs: 700 }).snapshot.stage.video)
    .toEqual(saved.state.rollbackHistory[0]?.stage.video);

  const legacy = JSON.parse(JSON.stringify(saved)) as NovelSaveData;
  delete (legacy.state.stage as { video?: unknown }).video;
  for (const checkpoint of legacy.state.rollbackHistory) delete (checkpoint.stage as { video?: unknown }).video;
  const legacyEngine = createNovelEngine(story);
  legacyEngine.load(legacy);
  expect(legacyEngine.getSnapshot().stage.video).toBeNull();
  legacyEngine.rollback();
  expect(legacyEngine.getSnapshot().stage.video).toBeNull();

  const malformed = JSON.parse(JSON.stringify(saved)) as NovelSaveData;
  const malformedVideo = malformed.state.stage.video as { status: string; loop: boolean };
  malformedVideo.status = "ended";
  malformedVideo.loop = true;
  const before = loaded.getSnapshot();
  expect(() => loaded.load(malformed)).toThrow(/cannot be ended|positionMs must not exceed/i);
  expect(loaded.getSnapshot()).toEqual(before);

  engine.dispose();
  loaded.dispose();
  legacyEngine.dispose();
});

test("engine rejects malformed video story instructions before execution", () => {
  const invalid = {
    id: "invalid-video", version: 1, start: "start",
    script: { start: [{ type: "video", action: "play", cue: "clip", muted: false }] },
  } as unknown as StoryDefinition;
  expect(() => createNovelEngine(invalid)).toThrow(StoryValidationError);
});

test("newGame releases the old overlay and resets it without adding a video clock", () => {
  const lifecycleStory: StoryDefinition = {
    id: "video-new-game-test", version: 1, start: "start", script: {
      start: [{ type: "say", id: "opening", text: "Ready." }],
      play: [{ type: "video", action: "play", cue: "loop", loop: true }, { type: "ending", id: "end" }],
    },
  };
  const engine = createNovelEngine(lifecycleStory);
  engine.start();
  engine.debug.jump({ label: "play", index: 0 });
  expect(engine.getSnapshot().stage.video?.status).toBe("playing");
  const oldToken = engine.getSnapshot().videoToken;
  const reset = engine.newGame();
  expect(reset.snapshot.active).toMatchObject({ kind: "say", id: "opening" });
  expect(reset.snapshot.stage.video).toBeNull();
  expect(reset.snapshot.videoToken).toBeNull();
  expect(reset.events).toMatchObject([{ type: "videoCue", action: "close", token: oldToken }]);
  expect(engine.reportVideo({ token: oldToken!, status: "ended", positionMs: 80, durationMs: 80 }).snapshot.stage.video).toBeNull();
  engine.dispose();
});

test("story text authoring round-trips video instructions without rewriting cues", () => {
  const text = formatStoryText(story);
  const parsed = parseStoryText(text);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story).toEqual(story);
  expect(formatStoryText(parsed.story!)).toBe(text);
});
