import { expect, test } from "bun:test";
import "./clock-test-fixture.ts";
import { createNovelEngine, SaveDataError, StoryValidationError } from "../src/index.ts";
import { clockFixtureTimerCount, pumpClockFixture, resetClockFixture } from "./clock-test-fixture.ts";
import type { RevealTransitionDirection, StoryDefinition } from "../src/types.ts";

const { attachNovelClock } = await import("../src/clock.ts");

test("scene transition retains one prior composition across save/load, then releases it", () => {
  const story: StoryDefinition = { id: "stage", version: 1, start: "start", script: { start: [
    { type: "scene", background: "station", characters: [{ id: "mira", expression: "worried", position: { x: 28, y: 96 } }] },
    { type: "say", id: "one", text: "Before." },
    { type: "scene", background: "dawn", remove: ["mira"], characters: [{ id: "ren", expression: "hopeful" }], transition: { kind: "dissolve", durationMs: 1000 } },
    { type: "say", id: "two", text: "After." },
    { type: "ending", id: "end" },
  ] } };
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start(); engine.advance(); engine.tick(400);
  const stage = engine.getSnapshot().stage;
  expect(stage.background).toBe("dawn");
  expect(stage.characters.mira).toBeUndefined();
  expect(stage.transition?.from?.background).toBe("station");
  expect(stage.transition?.from?.characters.mira?.position).toEqual({ x: 28, y: 96 });
  expect(stage.transition?.elapsedMs).toBe(400);
  expect(stage.transition?.from).not.toHaveProperty("transition");
  const save = JSON.parse(JSON.stringify(engine.save()));
  const loaded = createNovelEngine(story);
  loaded.load(save);
  expect(loaded.getSnapshot().stage).toEqual(stage);
  loaded.pause(); loaded.tick(1000);
  expect(loaded.getSnapshot().stage.transition?.elapsedMs).toBe(400);
  loaded.resume(); loaded.tick(600);
  expect(loaded.getSnapshot().stage.transition).toBeNull();
  expect(loaded.getSnapshot().stage.background).toBe("dawn");
  save.state.stage.transition.from.transition = { ...save.state.stage.transition, from: undefined };
  expect(() => loaded.load(save)).toThrow(SaveDataError);
  expect(loaded.getSnapshot().stage.transition).toBeNull();
  engine.dispose(); loaded.dispose();
});

function revealStory(direction?: RevealTransitionDirection): StoryDefinition {
  const transition = direction === undefined
    ? { kind: "reveal" as const, durationMs: 1000 }
    : { kind: "reveal" as const, direction, durationMs: 1000 };
  return { id: "reveal-stage", version: 1, start: "start", script: { start: [
    { type: "scene", background: "station", camera: { x: 24, y: -8, scale: 1.15 } },
    { type: "say", id: "before", text: "Before." },
    { type: "scene", background: "dawn", transition },
    { type: "say", id: "during", text: "During." },
    { type: "say", id: "after", text: "After." },
  ] } };
}

test("reveal accepts all directions, defaults to left and preserves the resolved outgoing camera", () => {
  for (const direction of ["left", "right", "up", "down"] as const) {
    const story = revealStory(direction);
    const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
    engine.start(); engine.advance();
    const transition = engine.getSnapshot().stage.transition;
    expect(transition).toMatchObject({ kind: "reveal", direction, durationMs: 1000, elapsedMs: 0 });
    expect(transition?.from?.background).toBe("station");
    expect(transition?.from?.camera).toEqual({ x: 24, y: -8, scale: 1.15 });
    engine.dispose();
  }

  const engine = createNovelEngine(revealStory(), { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start(); engine.advance();
  expect(engine.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "left" });
  engine.dispose();
});

test("reveal pauses, resumes, saves, restores old saves, rolls back and retires on the existing clock", () => {
  const story = revealStory("right");
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start(); engine.advance(); engine.tick(275);
  expect(engine.getSnapshot().stage.transition?.elapsedMs).toBe(275);

  engine.pause(); engine.tick(500);
  expect(engine.getSnapshot().stage.transition?.elapsedMs).toBe(275);
  const save = JSON.parse(JSON.stringify(engine.save()));
  const loaded = createNovelEngine(story);
  loaded.load(save);
  expect(loaded.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "right", elapsedMs: 275 });
  expect(loaded.getSnapshot().paused).toBe(true);
  loaded.resume(); loaded.tick(125);
  expect(loaded.getSnapshot().stage.transition?.elapsedMs).toBe(400);

  const oldSave = structuredClone(save);
  delete oldSave.state.stage.transition.direction;
  const legacyLoaded = createNovelEngine(story);
  legacyLoaded.load(oldSave);
  expect(legacyLoaded.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "left", elapsedMs: 275 });

  for (const invalid of [
    (candidate: any) => { candidate.kind = "wipe"; },
    (candidate: any) => { candidate.direction = "diagonal"; },
    (candidate: any) => { candidate.kind = "fade"; },
  ]) {
    const malformed = structuredClone(save);
    invalid(malformed.state.stage.transition);
    expect(() => loaded.load(malformed)).toThrow(SaveDataError);
    expect(loaded.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "right", elapsedMs: 400 });
  }

  engine.resume();
  engine.advance();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", id: "after" });
  engine.rollback();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", id: "during" });
  expect(engine.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "right", elapsedMs: 275, from: { background: "station" } });
  engine.tick(725);
  expect(engine.getSnapshot().stage.transition).toBeNull();

  engine.dispose(); loaded.dispose(); legacyLoaded.dispose();
});

test("skip mode advances narrative time without creating a second reveal clock", () => {
  const engine = createNovelEngine({
    id: "reveal-skip", version: 1, start: "start", script: { start: [
      { type: "scene", background: "station" },
      { type: "say", id: "before", text: "Before." },
      { type: "scene", background: "dawn", transition: { kind: "reveal", direction: "up", durationMs: 500 } },
      { type: "say", id: "during", text: "During." },
      { type: "ending", id: "end" },
    ] },
  }, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start(); engine.advance();
  engine.setPreferences({ mode: "skip", skipSeenOnly: false });
  engine.tick(80);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "ending", id: "end" });
  expect(engine.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction: "up", elapsedMs: 80 });
  engine.dispose();
});

test("reveal progress uses the existing NovelClock and releases its wake on completion", () => {
  resetClockFixture();
  const engine = createNovelEngine(revealStory("down"), { preferences: { textSpeedCharsPerSecond: 0 } });
  const detach = attachNovelClock(engine);
  engine.start(); engine.advance();
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(3);
  const elapsed = engine.getSnapshot().stage.transition?.elapsedMs ?? 0;
  expect(elapsed).toBeGreaterThan(0);

  engine.pause();
  expect(clockFixtureTimerCount()).toBe(0);
  pumpClockFixture(10);
  expect(engine.getSnapshot().stage.transition?.elapsedMs).toBe(elapsed);
  engine.resume();
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(60);
  expect(engine.getSnapshot().stage.transition).toBeNull();
  expect(clockFixtureTimerCount()).toBe(0);
  detach(); engine.dispose();
});

test("story validation rejects unsupported reveal directions and direction on other kinds", () => {
  for (const transition of [
    { kind: "reveal", durationMs: 100, direction: "diagonal" },
    { kind: "fade", durationMs: 100, direction: "left" },
    { kind: "wipe", durationMs: 100 },
  ]) {
    const story = { id: "invalid-reveal", version: 1, start: "start", script: { start: [{ type: "scene", transition }] } } as unknown as StoryDefinition;
    expect(() => createNovelEngine(story)).toThrow(StoryValidationError);
  }
});

test("interrupting reveal freezes one resolved composition and cut drops its transition", () => {
  const story: StoryDefinition = { id: "reveal-interruption", version: 1, start: "start", script: { start: [
    { type: "scene", background: "old", camera: { x: 0, y: 0, scale: 1 } },
    { type: "say", id: "one", text: "One." },
    { type: "scene", background: "station", camera: { x: 100, y: 0, scale: 1 }, cameraMotion: { durationMs: 1000, easing: "linear" }, transition: { kind: "reveal", direction: "left", durationMs: 1000 } },
    { type: "say", id: "two", text: "Two." },
    { type: "scene", background: "roof", transition: { kind: "reveal", direction: "up", durationMs: 1000 } },
    { type: "say", id: "three", text: "Three." },
    { type: "scene", background: "dawn", transition: { kind: "cut", durationMs: 0 } },
    { type: "say", id: "four", text: "Four." },
  ] } };
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const restored = createNovelEngine(story);
  try {
    engine.start(); engine.advance(); engine.tick(250);
    const firstId = engine.getSnapshot().stage.transition!.id;
    engine.advance();
    const interrupted = engine.getSnapshot().stage.transition!;
    expect(interrupted.id).toBeGreaterThan(firstId);
    expect(interrupted).toMatchObject({ kind: "reveal", direction: "up", elapsedMs: 0, from: { background: "station", camera: { x: 25, y: 0, scale: 1 } } });
    expect(interrupted.from).not.toHaveProperty("transition");
    restored.load(JSON.parse(JSON.stringify(engine.save())));
    restored.tick(1000);
    expect(restored.getSnapshot().stage.transition).toBeNull();
    expect(restored.getSnapshot().stage.background).toBe("roof");
    engine.advance();
    expect(engine.getSnapshot().stage.transition).toBeNull();
    expect(engine.getSnapshot().stage.background).toBe("dawn");
  } finally { engine.dispose(); restored.dispose(); }
});
