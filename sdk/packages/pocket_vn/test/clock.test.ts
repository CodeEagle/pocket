import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { clockFixtureTimerCount, pumpClockFixture, resetClockFixture } from "./clock-test-fixture.ts";

const { attachNovelClock } = await import("../src/clock.ts");

test("manual reading and unread skip stop waking the virtual clock", () => {
  resetClockFixture();
  const engine = createNovelEngine({ id: "clock", version: 1, start: "start", script: { start: [
    { type: "say", id: "one", text: "雾港" }, { type: "ending", id: "end" },
  ] } }, { preferences: { textSpeedCharsPerSecond: 30 } });
  const dispose = attachNovelClock(engine);
  expect(clockFixtureTimerCount()).toBe(0);
  engine.start(); expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(20);
  expect(engine.getSnapshot().active?.kind).toBe("say");
  expect(clockFixtureTimerCount()).toBe(0);
  engine.setPreferences({ mode: "skip", skipSeenOnly: true });
  expect(clockFixtureTimerCount()).toBe(0);
  pumpClockFixture(200);
  expect(engine.getSnapshot().phase).toBe("say");
  engine.advance(); expect(engine.getSnapshot().phase).toBe("ending");
  expect(clockFixtureTimerCount()).toBe(0);
  dispose(); engine.dispose();
});

test("voice waiting sleeps after the auto delay and a completion fact wakes it", () => {
  resetClockFixture();
  const engine = createNovelEngine({ id: "voice-clock", version: 1, start: "start", script: { start: [
    { type: "say", id: "spoken", text: "Listen", voice: "voice-line" }, { type: "ending", id: "end" },
  ] } }, { preferences: { mode: "auto", textSpeedCharsPerSecond: 0, autoDelayMs: 100 } });
  const dispose = attachNovelClock(engine); engine.start();
  pumpClockFixture(10);
  const firstActive = engine.getSnapshot().active;
  expect(firstActive?.kind === "say" && firstActive.id).toBe("spoken");
  expect(clockFixtureTimerCount()).toBe(0);
  pumpClockFixture(1000);
  const laterActive = engine.getSnapshot().active;
  expect(laterActive?.kind === "say" && laterActive.id).toBe("spoken");
  engine.reportVoice({ token: engine.getSnapshot().voice!.token, status: "completed" });
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(1);
  expect(engine.getSnapshot().phase).toBe("ending");
  expect(clockFixtureTimerCount()).toBe(0);
  dispose(); engine.dispose();
});

test("pause cancels a timed choice wake and resume uses only subsequent virtual time", () => {
  resetClockFixture();
  const engine = createNovelEngine({ id: "choice-clock", version: 1, start: "start", script: {
    start: [{ type: "choice", id: "storm", timeLimitMs: 1000, timeoutTarget: "end", options: [{ id: "go", text: "启程", target: "end" }] }],
    end: [{ type: "ending", id: "end" }],
  } });
  const dispose = attachNovelClock(engine); engine.start();
  pumpClockFixture(20); engine.pause();
  const remaining = engine.getSnapshot().active;
  expect(clockFixtureTimerCount()).toBe(0); pumpClockFixture(200);
  expect(engine.getSnapshot().active).toEqual(remaining);
  engine.resume(); pumpClockFixture(41);
  expect(engine.getSnapshot().phase).toBe("ending");
  expect(clockFixtureTimerCount()).toBe(0);
  dispose(); engine.dispose();
});

test("manual say pauses sleep while timed say pauses use the shared narrative clock", () => {
  resetClockFixture();
  const story = (durationMs: number | null) => ({
    id: `say-pause-clock-${durationMs ?? "manual"}`, version: 1, start: "start", script: { start: [
      { type: "say" as const, id: "line", text: "AB", rich: { spans: [], pauses: [{ id: "pause", at: 1, durationMs }] } },
    ] },
  });
  const manual = createNovelEngine(story(null), { preferences: { textSpeedCharsPerSecond: 10 } });
  const disposeManual = attachNovelClock(manual);
  manual.start();
  pumpClockFixture(6);
  expect(manual.getSnapshot().active).toMatchObject({ kind: "say", pause: { id: "pause", remainingMs: null } });
  expect(clockFixtureTimerCount()).toBe(0);
  disposeManual(); manual.dispose();

  resetClockFixture();
  const moving = createNovelEngine({ id: "say-pause-camera-clock", version: 1, start: "start", script: { start: [
    { type: "scene", camera: { x: 100, y: 0, scale: 1 }, cameraMotion: { durationMs: 100 } },
    { type: "say", id: "line", text: "AB", rich: { spans: [], pauses: [{ id: "manual", at: 0, durationMs: null }] } },
  ] } }, { preferences: { textSpeedCharsPerSecond: 0 } });
  const disposeMoving = attachNovelClock(moving);
  moving.start();
  expect(moving.getSnapshot().active).toMatchObject({ kind: "say", pause: { id: "manual", remainingMs: null } });
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(1);
  expect(moving.getSnapshot().stage.camera.motion?.elapsedMs).toBeGreaterThan(0);
  disposeMoving(); moving.dispose();

  resetClockFixture();
  const timed = createNovelEngine(story(100), { preferences: { textSpeedCharsPerSecond: 10 } });
  const disposeTimed = attachNovelClock(timed);
  timed.start();
  pumpClockFixture(6);
  const firstTimedPause = timed.getSnapshot().active;
  expect(firstTimedPause).toMatchObject({ kind: "say", pause: { id: "pause" } });
  if (firstTimedPause?.kind === "say" && firstTimedPause.pause) expect(firstTimedPause.pause.remainingMs).toBeGreaterThan(90);
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(2);
  const laterTimedPause = timed.getSnapshot().active;
  expect(laterTimedPause).toMatchObject({ pause: { id: "pause" } });
  if (laterTimedPause?.kind === "say" && laterTimedPause.pause) expect(laterTimedPause.pause.remainingMs).toBeLessThan(100);
  timed.pause();
  expect(clockFixtureTimerCount()).toBe(0);
  disposeTimed(); timed.dispose();
});

test("stage models share one clock, pause with the story and release the last wake", async () => {
  const { createNovelAnimationDriver } = await import("../src/models.ts");
  resetClockFixture();
  const engine = createNovelEngine({ id: "models-clock", version: 1, start: "start", script: { start: [{ type: "say", id: "still", text: "Still" }] } }, { preferences: { textSpeedCharsPerSecond: 0 } });
  const animations = createNovelAnimationDriver();
  const dispose = attachNovelClock(engine, { animations });
  engine.start();
  expect(clockFixtureTimerCount()).toBe(0);
  let steps = 0;
  const removeA = animations.register(() => { steps++; });
  const removeB = animations.register(() => { steps++; });
  let narrativeUpdates = 0;
  const removeObserver = engine.subscribe(() => { narrativeUpdates++; });
  const readingSnapshot = engine.getSnapshot();
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(3); expect(steps).toBe(6); expect(clockFixtureTimerCount()).toBe(1);
  expect(narrativeUpdates).toBe(0);
  expect(engine.getSnapshot()).toBe(readingSnapshot);
  engine.pause(); pumpClockFixture(100); expect(steps).toBe(6); expect(clockFixtureTimerCount()).toBe(0);
  engine.resume(); pumpClockFixture(2); expect(steps).toBe(10);
  removeA(); expect(clockFixtureTimerCount()).toBe(1);
  removeB(); expect(clockFixtureTimerCount()).toBe(0);
  removeObserver(); dispose(); engine.dispose();
});

test("model animation keeps running while narrative time advances only when needed", async () => {
  const { createNovelAnimationDriver } = await import("../src/models.ts");
  resetClockFixture();
  const engine = createNovelEngine({ id: "model-reveal-clock", version: 1, start: "start", script: {
    start: [{ type: "say", id: "line", text: "AB" }, { type: "ending", id: "end" }],
  } }, { preferences: { textSpeedCharsPerSecond: 60, autoDelayMs: 100 } });
  const animations = createNovelAnimationDriver();
  let steps = 0;
  const removeModel = animations.register(() => { steps++; });
  const dispose = attachNovelClock(engine, { animations });
  engine.start();
  pumpClockFixture(6);
  const active = engine.getSnapshot().active;
  expect(active?.kind === "say" && active.complete).toBe(true);
  let updates = 0;
  const removeObserver = engine.subscribe(() => { updates++; });
  pumpClockFixture(60);
  expect(steps).toBe(66);
  expect(updates).toBe(0);
  engine.setPreferences({ mode: "auto" });
  pumpClockFixture(10);
  expect(engine.getSnapshot().phase).toBe("ending");
  expect(steps).toBeGreaterThan(66);
  removeObserver(); removeModel(); dispose(); engine.dispose();
});
