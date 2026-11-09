import { expect, test } from "bun:test";
import "./clock-test-fixture.ts";
import {
  createNovelEngine,
  decodeNovelSaveData,
  encodeNovelSaveData,
  formatStoryText,
  parseStoryText,
  novelCameraInstructionIssue,
  resolveNovelCameraPose,
  SaveDataError,
  StoryValidationError,
} from "../src/index.ts";
import { clockFixtureTimerCount, pumpClockFixture, resetClockFixture } from "./clock-test-fixture.ts";
import type { StoryDefinition } from "../src/types.ts";

const { attachNovelClock } = await import("../src/clock.ts");

const cameraStory: StoryDefinition = {
  id: "camera-story",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "harbor", camera: { x: 4096, y: 0, scale: 1 } },
      { type: "say", id: "one", text: "" },
      {
        type: "scene",
        camera: { x: 4096, y: 0, scale: 1 },
        cameraMotion: { durationMs: 100, shake: { amplitude: 512, cycles: 1 } },
      },
      { type: "say", id: "two", text: "" },
      { type: "scene", background: "night", transition: { kind: "dissolve", durationMs: 200 } },
      { type: "say", id: "three", text: "" },
      { type: "ending", id: "end" },
    ],
  },
};

test("camera schema is shared, bounded, and rejects unsupported motion fields", () => {
  expect(novelCameraInstructionIssue({
    type: "scene",
    camera: { x: -4096, y: 4096, scale: 8 },
    cameraMotion: { durationMs: 30_000, easing: "easeInOut", shake: { amplitude: 512, cycles: 20 } },
  })).toBeNull();
  expect(novelCameraInstructionIssue({ type: "scene", cameraMotion: { durationMs: 100 } })).toContain("requires camera");
  expect(novelCameraInstructionIssue({ type: "scene", camera: { x: 4097, y: 0, scale: 1 } })).toContain("camera.x");
  expect(novelCameraInstructionIssue({ type: "scene", camera: { x: 0, y: 0, scale: 0.09 } })).toContain("camera.scale");
  expect(novelCameraInstructionIssue({ type: "scene", camera: { x: 0, y: 0, scale: 1, rotation: 12 } })).toContain("rotation");
  expect(novelCameraInstructionIssue({ type: "scene", camera: { x: 0, y: 0, scale: 1 }, cameraMotion: { durationMs: 0 } })).toContain("durationMs");
  expect(novelCameraInstructionIssue({ type: "scene", camera: { x: 0, y: 0, scale: 1 }, cameraMotion: { durationMs: 30, shake: { amplitude: 10, cycles: 0 } } })).toContain("cycles");
  expect(() => createNovelEngine({
    ...cameraStory,
    script: { start: [{ type: "scene", camera: { x: 0, y: 0, scale: 9 } }] },
  })).toThrow(StoryValidationError);
});

test("camera scenes remain lossless in the existing Pocket VN text format", () => {
  const parsed = parseStoryText(formatStoryText(cameraStory));
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story).toEqual(cameraStory);
});

test("camera pose resolution is deterministic, eased, and reduced motion settles at target", () => {
  const camera = {
    x: 100,
    y: 50,
    scale: 2,
    motion: {
      from: { x: 0, y: 10, scale: 1 },
      elapsedMs: 50,
      durationMs: 100,
      easing: "easeInOut" as const,
      shake: { amplitude: 18, cycles: 1 },
    },
  };
  const pose = resolveNovelCameraPose(camera);
  expect(pose.x).toBeCloseTo(50);
  expect(pose.y).toBeCloseTo(12);
  expect(pose.scale).toBeCloseTo(1.5);
  expect(resolveNovelCameraPose(camera)).toEqual(pose);
  expect(resolveNovelCameraPose(camera, { reduceMotion: true })).toEqual({ x: 100, y: 50, scale: 2 });
  expect(resolveNovelCameraPose({ x: 12, y: -8, scale: 1.2 })).toEqual({ x: 12, y: -8, scale: 1.2 });
  expect(resolveNovelCameraPose(undefined)).toEqual({ x: 0, y: 0, scale: 1 });
});

test("camera motion uses the story tick and survives save, independent scene fades, and rollback", () => {
  const engine = createNovelEngine(cameraStory);
  engine.start();
  expect(engine.getSnapshot().stage.camera).toEqual({ x: 4096, y: 0, scale: 1, motion: null });

  engine.advance();
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(0);
  engine.tick(13);
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(13);
  const savedAtMotion = engine.save();
  expect(decodeNovelSaveData(encodeNovelSaveData(savedAtMotion))).toEqual(savedAtMotion);
  const loaded = createNovelEngine(cameraStory);
  loaded.load(JSON.parse(JSON.stringify(savedAtMotion)));
  expect(loaded.getSnapshot().stage.camera).toEqual(engine.getSnapshot().stage.camera);
  expect(resolveNovelCameraPose(loaded.getSnapshot().stage.camera).x).toBeGreaterThan(4096);

  engine.advance();
  const beforeSceneFade = engine.getSnapshot().stage;
  expect(beforeSceneFade.transition?.durationMs).toBe(200);
  expect(beforeSceneFade.camera.motion?.elapsedMs).toBe(13);
  expect(beforeSceneFade.transition?.from?.camera?.x).toBeGreaterThan(4096);
  const fadeSave = JSON.parse(JSON.stringify(engine.save()));
  const fadeLoaded = createNovelEngine(cameraStory);
  fadeLoaded.load(fadeSave);
  expect(fadeLoaded.getSnapshot().stage).toEqual(beforeSceneFade);

  engine.tick(20);
  expect(engine.getSnapshot().stage.transition?.elapsedMs).toBe(20);
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(33);
  engine.tick(80);
  expect(engine.getSnapshot().stage.camera.motion).toBeNull();
  expect(engine.getSnapshot().stage.transition?.elapsedMs).toBe(100);
  engine.pause();
  const pausedStage = engine.getSnapshot().stage;
  engine.tick(1_000);
  expect(engine.getSnapshot().stage).toEqual(pausedStage);
  engine.resume();
  engine.rollback();
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(13);
  expect(engine.getSnapshot().stage.transition).toBeNull();
  engine.dispose(); loaded.dispose(); fadeLoaded.dispose();
});

test("newGame resets prior camera motion before replaying the authored start scene", () => {
  const engine = createNovelEngine(cameraStory);
  engine.start(); engine.advance(); engine.tick(40);
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(40);
  engine.newGame();
  expect(engine.getSnapshot().stage.camera).toEqual({ x: 4096, y: 0, scale: 1, motion: null });
  expect(engine.getSnapshot().stage.transition).toBeNull();
  engine.dispose();
});

test("camera animation wakes the existing virtual clock and pauses with narrative time", () => {
  resetClockFixture();
  const engine = createNovelEngine(cameraStory);
  const detach = attachNovelClock(engine);
  engine.start();
  expect(clockFixtureTimerCount()).toBe(0);
  engine.advance();
  expect(clockFixtureTimerCount()).toBe(1);
  engine.pause();
  expect(clockFixtureTimerCount()).toBe(0);
  pumpClockFixture(100);
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(0);
  engine.resume();
  expect(clockFixtureTimerCount()).toBe(1);
  pumpClockFixture(7);
  expect(engine.getSnapshot().stage.camera.motion).toBeNull();
  expect(clockFixtureTimerCount()).toBe(0);
  detach(); engine.dispose();
});

test("legacy saves default to the origin camera; invalid camera saves fail atomically", () => {
  const legacyStory: StoryDefinition = {
    id: "camera-legacy", version: 1, start: "start", script: { start: [
      { type: "scene", background: "one" },
      { type: "say", id: "one", text: "" },
      { type: "scene", background: "two", transition: { kind: "fade", durationMs: 100 } },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const source = createNovelEngine(legacyStory);
  source.start(); source.advance();
  const legacy = JSON.parse(JSON.stringify(source.save()));
  delete legacy.state.stage.camera;
  delete legacy.state.stage.transition.from.camera;
  for (const checkpoint of legacy.state.rollbackHistory) {
    delete checkpoint.stage.camera;
    if (checkpoint.stage.transition?.from) delete checkpoint.stage.transition.from.camera;
  }
  const restored = createNovelEngine(legacyStory);
  restored.load(legacy);
  expect(restored.getSnapshot().stage.camera).toEqual({ x: 0, y: 0, scale: 1, motion: null });
  expect(restored.getSnapshot().stage.transition?.from?.camera).toBeUndefined();

  const before = restored.save();
  const malformed = JSON.parse(JSON.stringify(before));
  malformed.state.stage.camera.scale = 0;
  expect(() => restored.load(malformed)).toThrow(SaveDataError);
  expect(restored.save()).toEqual(before);

  source.dispose(); restored.dispose();
});
