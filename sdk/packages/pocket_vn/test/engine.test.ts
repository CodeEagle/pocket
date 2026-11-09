import { expect, test } from "bun:test";
import {
  conditions,
  createNovelEngine,
  NovelEngineError,
  SaveDataError,
  StepBudgetExceededError,
  StoryValidationError,
  value,
} from "../src/index.ts";
import type { EngineUpdate, StoryDefinition } from "../src/types.ts";

const mainStory: StoryDefinition = {
  id: "engine-main",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "worried", position: "left" }], transition: { kind: "fade", durationMs: 80 } },
      { type: "audio", cue: "harbor-theme", channel: "music", loop: true },
      { type: "set", variable: "clues", value: 1 },
      { type: "inc", variable: "clues", amount: 1 },
      { type: "call", target: "memory-note" },
      { type: "branch", when: conditions.gte(value.variable("clues"), value.literal(2)), then: "story", else: "failed" },
    ],
    "memory-note": [
      { type: "set", variable: "memo", value: "platform-714" },
      { type: "return" },
    ],
    story: [
      { type: "say", id: "intro", speaker: "Mira", portrait: "worried", text: "We have {{clues}} clues, {{memo}}." },
      { type: "wait", durationMs: 100 },
      {
        type: "choice", id: "route", prompt: "Where should we search?",
        options: [
          { id: "archive", text: "The archive", target: "proof", when: conditions.truthy(value.variable("memo")) },
          { id: "roof", text: "The roof", target: "late-route" },
        ],
        timeLimitMs: 1000, timeoutTarget: "late-route",
      },
    ],
    proof: [
      { type: "scene", background: "dawn", characters: [{ id: "mira", expression: "hopeful" }], transition: { kind: "dissolve", durationMs: 150 } },
      { type: "audio", cue: "dawn-theme", channel: "music", loop: true },
      { type: "audio", cue: "letter-chime" },
      { type: "say", id: "evidence", speaker: "Mira", text: "The 7-1-4 pattern is proven." },
      { type: "ending", id: "proof-complete", text: "The letter reaches the harbor.", cg: "truth-letter" },
    ],
    "late-route": [{ type: "ending", id: "storm", text: "The fog closes the roof." }],
    failed: [{ type: "ending", id: "failed", text: "The clues do not align." }],
  },
};

function expectSay(engine: ReturnType<typeof createNovelEngine>, id: string): void {
  const active = engine.getSnapshot().active;
  expect(active?.kind).toBe("say");
  if (active?.kind === "say") expect(active.id).toBe(id);
}

function finishSay(engine: ReturnType<typeof createNovelEngine>): EngineUpdate {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected a dialogue line");
  if (!active.complete) engine.advance();
  return engine.advance();
}

test("executes stage, audio cues, expressions, variables, call-return, branching, wait, choice and ending", () => {
  const engine = createNovelEngine(mainStory);
  const first = engine.start();
  expect(first.snapshot.active?.kind).toBe("say");
  expect(first.snapshot.stage.background).toBe("station");
  expect(first.snapshot.stage.characters.mira).toMatchObject({ expression: "worried", position: "left", visible: true });
  expect(first.snapshot.variables).toMatchObject({ clues: 2, memo: "platform-714" });
  expect(first.snapshot.stage.transition).toMatchObject({ kind: "fade", durationMs: 80, elapsedMs: 0 });
  expect(first.events).toEqual([{ type: "audioCue", sequence: 1, cue: "harbor-theme", action: "play", channel: "music", loop: true, location: { label: "start", index: 1 } }]);
  expect(first.snapshot.audioIntents.music).toEqual({ action: "play", cue: "harbor-theme", loop: true });
  expectSay(engine, "intro");
  if (engine.getSnapshot().active?.kind === "say") expect(engine.getSnapshot().active.text).toBe("We have 2 clues, platform-714.");

  finishSay(engine);
  expect(engine.getSnapshot().active?.kind).toBe("wait");
  engine.tick(40);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "wait", remainingMs: 60 });
  engine.tick(60);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "route" });
  const choice = engine.getSnapshot().active;
  if (choice?.kind === "choice") expect(choice.options.map(option => option.id)).toEqual(["archive", "roof"]);

  const proof = engine.selectChoice("archive");
  expect(proof.snapshot.stage.background).toBe("dawn");
  expect(proof.snapshot.stage.characters.mira).toMatchObject({ expression: "hopeful", position: "left", visible: true });
  expect(proof.events.map(event => event.type === "audioCue" ? event.cue : "")).toEqual(["dawn-theme", "letter-chime"]);
  expect(proof.snapshot.audioIntents.music).toEqual({ action: "play", cue: "dawn-theme", loop: true });
  expectSay(engine, "evidence");
  finishSay(engine);
  expect(engine.getSnapshot().active).toEqual({ kind: "ending", location: { label: "proof", index: 4 }, id: "proof-complete", text: "The letter reaches the harbor.", cg: "truth-letter" });
  expect(engine.getSnapshot().meta.endingIds).toContain("proof-complete");
  expect(engine.getSnapshot().meta.cgIds).toContain("truth-letter");
  expect(engine.getSnapshot().meta.readLineIds).toEqual(["intro", "evidence"]);
});

const rollbackStory: StoryDefinition = {
  id: "rollback-story", version: 3, start: "start", script: {
    start: [
      { type: "say", id: "one", text: "First {{count}}." },
      { type: "set", variable: "count", value: 1 },
      { type: "say", id: "two", text: "Second." },
      { type: "set", variable: "count", value: 2 },
      { type: "say", id: "three", text: "Third." },
      { type: "ending", id: "finish" },
    ],
  },
};

test("save/load restores compact rollback history and rollback keeps meta while rewinding state", () => {
  const engine = createNovelEngine(rollbackStory, { initialVariables: { count: 0 }, maxBacklogEntries: 8, maxRollbackEntries: 8 });
  engine.start();
  finishSay(engine);
  finishSay(engine);
  expectSay(engine, "three");
  expect(engine.getSnapshot().variables.count).toBe(2);
  const save = engine.save();
  expect(save.state.backlog.map(entry => entry.lineId)).toEqual(["one", "two"]);
  expect(save.state.rollbackHistory.map(checkpoint => checkpoint.backlogSequence)).toEqual([0, 1]);
  expect(save.state.rollbackHistory.every(checkpoint => !("backlog" in checkpoint))).toBe(true);

  const loaded = createNovelEngine(rollbackStory, { maxBacklogEntries: 1, maxRollbackEntries: 1, initialMeta: { readLineIds: ["outside"], endingIds: [], cgIds: ["legacy-cg"] } });
  loaded.load(save);
  expect(loaded.getSnapshot().backlog.map(entry => entry.lineId)).toEqual(["two"]);
  expect(loaded.getSnapshot().meta.readLineIds).toContain("outside");
  expect(loaded.getSnapshot().meta.cgIds).toContain("legacy-cg");
  expect(loaded.getSnapshot().rollbackAvailable).toBe(1);

  loaded.rollback();
  expect(loaded.getSnapshot().active).toMatchObject({ kind: "say", id: "two", complete: true });
  expect(loaded.getSnapshot().variables.count).toBe(1);
  expect(loaded.getSnapshot().backlog).toEqual([]); // The clipped log cannot reconstruct the rewound line's prior history.
  expect(loaded.getSnapshot().meta.readLineIds).toEqual(["outside", "one", "two"]);
  loaded.advance();
  expect(loaded.getSnapshot().active).toMatchObject({ kind: "say", id: "three" });
  expect(loaded.getSnapshot().backlog.map(entry => entry.lineId)).toEqual(["two"]);
  expect(loaded.getSnapshot().backlog[0]?.sequence).toBe(3);
});

test("auto reveal, pause, resume, timed choice, zero-speed text and seen-only skip use explicit ticks", () => {
  const autoStory: StoryDefinition = { id: "auto", version: 1, start: "start", script: { start: [
    { type: "say", id: "line", text: "abcd" },
    { type: "say", id: "next", text: "next" },
    { type: "ending", id: "end" },
  ] } };
  const auto = createNovelEngine(autoStory, { preferences: { mode: "auto", textSpeedCharsPerSecond: 2, autoDelayMs: 500 } });
  auto.start();
  auto.tick(2000);
  expect(auto.getSnapshot().active).toMatchObject({ kind: "say", id: "line", complete: true, autoRemainingMs: 500 });
  auto.tick(200);
  auto.pause();
  auto.tick(1000);
  expect(auto.getSnapshot().active).toMatchObject({ kind: "say", id: "line", autoRemainingMs: 300 });
  auto.resume();
  auto.tick(300);
  expect(auto.getSnapshot().active).toMatchObject({ kind: "say", id: "next" });
  expect(auto.getSnapshot().backlog.map(entry => entry.lineId)).toEqual(["line"]);

  const timerStory: StoryDefinition = { id: "timer", version: 1, start: "start", script: { start: [
    { type: "choice", id: "timed", options: [{ id: "go", text: "Go", target: "go" }], timeLimitMs: 1000, timeoutTarget: "timeout" },
  ], go: [{ type: "ending", id: "selected" }], timeout: [{ type: "ending", id: "timeout" }] } };
  const timer = createNovelEngine(timerStory);
  timer.start(); timer.tick(400); timer.pause(); timer.tick(500);
  expect(timer.getSnapshot().active).toMatchObject({ kind: "choice", timeRemainingMs: 600 });
  timer.resume(); timer.tick(600);
  expect(timer.getSnapshot().active).toMatchObject({ kind: "ending", id: "timeout" });

  const seen = createNovelEngine(autoStory, { initialMeta: { readLineIds: ["line"], endingIds: [], cgIds: [] }, preferences: { mode: "skip", textSpeedCharsPerSecond: 0 } });
  seen.start();
  seen.tick(0);
  expect(seen.getSnapshot().active).toMatchObject({ kind: "say", id: "next", complete: true });
  expect(seen.getSnapshot().backlog.map(entry => entry.lineId)).toEqual(["line"]);
  seen.tick(1000);
  expect(seen.getSnapshot().active).toMatchObject({ kind: "say", id: "next" }); // Unread text stops skip.
});

test("malformed and cross-story saves fail without changing live state", () => {
  const engine = createNovelEngine(rollbackStory);
  engine.start();
  const before = engine.getSnapshot();
  const save = engine.save();
  expect(() => engine.load({ ...save, storyVersion: 99 })).toThrow(SaveDataError);
  const malformed = structuredClone(save) as any;
  malformed.state.location = { label: "missing", index: 0 };
  expect(() => engine.load(malformed)).toThrow(SaveDataError);
  expect(engine.getSnapshot()).toBe(before);

  const otherStory = { ...rollbackStory, id: "another-story" };
  expect(() => createNovelEngine(otherStory).load(save)).toThrow(SaveDataError);
});

test("authored audio groups reach intents and music unlock metadata; invalid groups reject the story", () => {
  const story: StoryDefinition = {
    id: "authored-audio-group", version: 1, start: "start", script: { start: [
      { type: "audio", cue: "harbor-wind", channel: "harbor-bed", group: "music", loop: true },
      { type: "say", id: "line", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  const started = engine.start();
  expect(started.events).toEqual([{
    type: "audioCue", sequence: 1, cue: "harbor-wind", action: "play", channel: "harbor-bed",
    loop: true, group: "music", location: { label: "start", index: 0 },
  }]);
  expect(started.snapshot.audioIntents["harbor-bed"]).toEqual({
    action: "play", cue: "harbor-wind", loop: true, group: "music",
  });
  expect(started.snapshot.meta.musicIds).toContain("harbor-wind");
  engine.dispose();

  const invalidInstructions = [
    { type: "audio", cue: "theme", group: "music" },
    { type: "audio", cue: "theme", action: "stop", channel: "harbor-bed", group: "music" },
    { type: "audio", cue: "theme", channel: "music", group: "effects" },
    { type: "audio", cue: "theme", channel: "music-preview", group: "music" },
    { type: "audio", cue: "theme", channel: "effect-0", group: "effects" },
    { type: "audio", cue: "voice", channel: "__pocket_vn_voice", group: "music" },
    { type: "audio", cue: "theme", channel: "harbor-bed", group: "voice" },
  ];
  for (const instruction of invalidInstructions) {
    expect(() => createNovelEngine({ ...story, script: { start: [instruction as never] } }))
      .toThrow(StoryValidationError);
  }
  const invalidTimeline = {
    ...story,
    timelines: { crossfade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "music", group: "effects" }],
    } },
    script: { start: [{ type: "scene", timeline: "crossfade" }] },
  } as unknown as StoryDefinition;
  expect(() => createNovelEngine(invalidTimeline)).toThrow(StoryValidationError);
});

test("automatic instruction loops stop at the budget and roll back the failed transaction", () => {
  const loopStory: StoryDefinition = { id: "loop", version: 1, start: "loop", script: { loop: [
    { type: "inc", variable: "count", amount: 1 }, { type: "jump", target: "loop" },
  ] } };
  const engine = createNovelEngine(loopStory, { maxStepBudget: 5 });
  expect(() => engine.start()).toThrow(StepBudgetExceededError);
  expect(engine.getSnapshot()).toMatchObject({ started: false, location: { label: "loop", index: 0 }, variables: {} });
});

test("debug controls use the same engine and immutable snapshots", () => {
  const debugStory: StoryDefinition = { id: "debug", version: 1, start: "start", script: {
    start: [{ type: "set", variable: "x", value: 2 }, { type: "say", id: "first", text: "first" }, { type: "say", id: "second", text: "second" }],
  } };
  const engine = createNovelEngine(debugStory);
  const updates: EngineUpdate[] = [];
  engine.subscribe(update => updates.push(update), { emitCurrent: true });
  engine.debug.setBreakpoints([{ label: "start", index: 0 }]);
  engine.start();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, active: null, location: { label: "start", index: 0 } });
  engine.debug.resume();
  expect(engine.getSnapshot()).toMatchObject({ paused: false, variables: { x: 2 }, active: { kind: "say", id: "first" } });
  expect(Object.isFrozen(engine.getSnapshot())).toBe(true);
  expect(Object.isFrozen(engine.getSnapshot().variables)).toBe(true);
  expect(() => (engine.getSnapshot().variables as any).x = 5).toThrow();
  engine.debug.pause();
  engine.debug.step();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, active: { kind: "say", id: "second" } });
  const beforeJump = engine.getSnapshot();
  engine.debug.jump({ label: "start", index: 1 });
  expect(engine.getSnapshot()).toMatchObject({ paused: true, variables: { x: 2 }, active: { kind: "say", id: "first" } });
  expect(engine.getSnapshot().meta).toEqual(beforeJump.meta);
  expect(updates.every(update => update.snapshot.storyId === "debug" && Array.isArray(update.events))).toBe(true);
  engine.dispose();
  expect(engine.getSnapshot().phase).toBe("disposed");
  expect(() => engine.advance()).toThrow(NovelEngineError);
});

test("resume skips a self-loop breakpoint exactly once per resume", () => {
  const engine = createNovelEngine({
    id: "debug-resume-one-breakpoint", version: 1, start: "loop",
    script: { loop: [
      { type: "inc", variable: "counter", amount: 1 },
      { type: "jump", target: "loop" },
    ] },
  }, { maxStepBudget: 16 });
  engine.debug.setBreakpoints([{ label: "loop", index: 0 }]);
  engine.start();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "loop", index: 0 }, variables: {} });

  engine.debug.resume();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "loop", index: 0 }, variables: { counter: 1 } });
  engine.debug.resume();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "loop", index: 0 }, variables: { counter: 2 } });
  engine.dispose();
});

test("debug step skips the current self-loop breakpoint once and stops on re-entry", () => {
  const engine = createNovelEngine({
    id: "debug-step-one-breakpoint", version: 1, start: "loop",
    script: { loop: [
      { type: "inc", variable: "counter", amount: 1 },
      { type: "jump", target: "loop" },
    ] },
  }, { maxStepBudget: 16 });
  engine.debug.setBreakpoints([{ label: "loop", index: 0 }]);
  engine.start();

  engine.debug.step();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "loop", index: 0 }, variables: { counter: 1 } });
  engine.debug.step();
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "loop", index: 0 }, variables: { counter: 2 } });
  engine.dispose();
});

test("story validation rejects duplicate dialogue IDs and unsafe executable shapes", () => {
  const duplicate: StoryDefinition = { id: "invalid", version: 1, start: "start", script: { start: [
    { type: "say", id: "same", text: "a" }, { type: "say", id: "same", text: "b" },
  ] } };
  expect(() => createNovelEngine(duplicate)).toThrow(StoryValidationError);
  const badCondition: StoryDefinition = { id: "invalid-condition", version: 1, start: "start", script: { start: [
    { type: "branch", when: { op: "eval", code: "globalThis.pwned = true" } as any, then: "start", else: "start" },
  ] } };
  expect(() => createNovelEngine(badCondition)).toThrow(StoryValidationError);
});
