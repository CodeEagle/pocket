import { expect, test } from "bun:test";
import "./clock-test-fixture.ts";
import { createNovelEngine } from "../src/index.ts";
import { resolveNovelCameraPose } from "../src/camera.ts";
import type { StoryDefinition } from "../src/types.ts";
import { clockFixtureTimerCount, resetClockFixture } from "./clock-test-fixture.ts";

const { attachNovelClock } = await import("../src/clock.ts");

const presentationStory: StoryDefinition = {
  id: "stage-presentation",
  version: 1,
  start: "start",
  timelines: {
    sweep: {
      durationMs: 100,
      camera: [
        { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
        { atMs: 100, value: { x: 100, y: 40, scale: 2 } },
      ],
      actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 0, y: 10 }, scale: 1, rotation: 0 } },
        { atMs: 100, value: { position: { x: 100, y: 60 }, scale: 2, rotation: 90 } },
      ] }],
      audio: [
        { atMs: 0, cue: "theme", channel: "music", loop: true },
        { atMs: 40, cue: "marker" },
      ],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 1 },
        { atMs: 100, value: 0.2 },
      ] }],
    },
  },
  script: {
    start: [
      { type: "scene", background: "harbor", characters: [
        { id: "mira", position: "left" },
        { id: "bystander", position: "right" },
      ] },
      { type: "scene", characters: [{ id: "mira", position: "center" }], transition: { kind: "fade", durationMs: 80 }, timeline: "sweep" },
      { type: "say", id: "first", text: "" },
      { type: "say", id: "second", text: "" },
    ],
  },
};

function audioCues(events: readonly { readonly type: string; readonly cue?: string }[]): string[] {
  return events.flatMap(event => event.type === "audioCue" && event.cue ? [event.cue] : []);
}

test("reduced-motion stage is a frozen final-pose projection with no canonical or clock effects", () => {
  resetClockFixture();
  const engine = createNovelEngine(presentationStory);
  const detachClock = attachNovelClock(engine);
  const started = engine.start();
  expect(audioCues(started.events)).toEqual(["theme"]);
  expect(clockFixtureTimerCount()).toBe(1);

  const canonical = engine.getSnapshot().stage;
  const canonicalBytes = JSON.stringify(engine.save());
  expect(engine.getStagePresentation()).toBe(canonical);
  expect(engine.getStagePresentation({ reduceMotion: false })).toBe(canonical);

  const projected = engine.getStagePresentation({ reduceMotion: true });
  expect(projected).not.toBe(canonical);
  expect(projected.characters.mira).toMatchObject({ position: { x: 100, y: 60 }, scale: 2, rotation: 90 });
  expect(projected.camera).toMatchObject({ x: 100, y: 40, scale: 2, motion: null });
  expect(projected.characters.bystander).toBe(canonical.characters.bystander);
  expect(projected.transition).toBe(canonical.transition);
  expect(projected.timeline).toEqual({ id: "sweep", elapsedMs: 0 });
  expect(Object.isFrozen(projected)).toBe(true);
  expect(Object.isFrozen(projected.characters)).toBe(true);
  expect(Object.isFrozen(projected.characters.mira)).toBe(true);
  expect(Object.isFrozen(projected.characters.mira!.position)).toBe(true);
  expect(Object.isFrozen(projected.camera)).toBe(true);
  expect(engine.getSnapshot().stage).toBe(canonical);
  expect(engine.getSnapshot().eventSequence).toBe(started.snapshot.eventSequence);
  expect(JSON.stringify(engine.save())).toBe(canonicalBytes);
  expect(clockFixtureTimerCount()).toBe(1);

  engine.tick(20);
  expect(engine.getSnapshot().stage.timeline).toEqual({ id: "sweep", elapsedMs: 20 });
  expect(engine.getSnapshot().stage.characters.mira!.position.x).toBeCloseTo(20);
  expect(engine.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.84);
  expect(engine.getStagePresentation({ reduceMotion: true }).characters.mira).toMatchObject({ position: { x: 100, y: 60 }, scale: 2, rotation: 90 });
  expect(engine.getStagePresentation({ reduceMotion: false })).toBe(engine.getSnapshot().stage);

  const crossedMarker = engine.tick(20);
  expect(engine.getSnapshot().stage.timeline).toEqual({ id: "sweep", elapsedMs: 40 });
  expect(audioCues(crossedMarker.events)).toEqual(["marker"]);
  const midMotionStage = engine.getSnapshot().stage;
  const paused = engine.pause().snapshot.stage;
  expect(engine.getStagePresentation({ reduceMotion: true }).characters.mira!.position.x).toBe(100);
  engine.tick(500);
  expect(engine.getSnapshot().stage).toBe(paused);
  expect(engine.getStagePresentation({ reduceMotion: false })).toBe(paused);
  engine.resume();
  engine.tick(10);
  expect(engine.getSnapshot().stage.timeline?.elapsedMs).toBe(50);
  expect(engine.getStagePresentation({ reduceMotion: true }).camera.x).toBe(100);
  expect(engine.getStagePresentation({ reduceMotion: false })).not.toBe(midMotionStage);

  const saved = engine.save();
  const loaded = createNovelEngine(presentationStory);
  loaded.load(JSON.parse(JSON.stringify(saved)));
  const loadedCanonical = loaded.getSnapshot().stage;
  const loadedBytes = JSON.stringify(loaded.save());
  expect(loaded.getStagePresentation({ reduceMotion: true }).characters.mira!.position.x).toBe(100);
  expect(loaded.getSnapshot().stage).toBe(loadedCanonical);
  expect(JSON.stringify(loaded.save())).toBe(loadedBytes);
  loaded.advance();
  loaded.tick(10);
  expect(loaded.getSnapshot().stage.timeline?.elapsedMs).toBe(60);
  loaded.rollback();
  expect(loaded.getSnapshot().stage.timeline?.elapsedMs).toBe(50);
  expect(loaded.getStagePresentation({ reduceMotion: true }).characters.mira).toMatchObject({ position: { x: 100, y: 60 }, scale: 2, rotation: 90 });

  detachClock();
  expect(clockFixtureTimerCount()).toBe(0);
  engine.dispose();
  loaded.dispose();
});

test("actor-only presentation preserves cameraMotion for existing reduced-motion resolution", () => {
  const story: StoryDefinition = {
    id: "stage-presentation-camera-motion",
    version: 1,
    start: "start",
    timelines: { actor: {
      durationMs: 100,
      actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
        { atMs: 100, value: { position: { x: 100, y: 20 }, scale: 1.5, rotation: 45 } },
      ] }],
    } },
    script: { start: [
      { type: "scene", characters: [
        { id: "mira", position: "left" },
        { id: "bystander", position: "right" },
      ], camera: { x: 100, y: 40, scale: 2 }, cameraMotion: { durationMs: 100 }, timeline: "actor" },
      { type: "say", id: "line", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  engine.start();
  engine.tick(25);

  const canonical = engine.getSnapshot().stage;
  const projected = engine.getStagePresentation({ reduceMotion: true });
  expect(projected).not.toBe(canonical);
  expect(projected.characters.mira).toMatchObject({ position: { x: 100, y: 20 }, scale: 1.5, rotation: 45 });
  expect(projected.characters.bystander).toBe(canonical.characters.bystander);
  expect(projected.camera).toBe(canonical.camera);
  expect(projected.camera.motion).toMatchObject({ elapsedMs: 25, durationMs: 100 });
  expect(resolveNovelCameraPose(canonical.camera)).toMatchObject({ x: 25, y: 10, scale: 1.25 });
  expect(resolveNovelCameraPose(projected.camera, { reduceMotion: true })).toEqual({ x: 100, y: 40, scale: 2 });
  expect(engine.getStagePresentation({ reduceMotion: false })).toBe(canonical);
  engine.dispose();
});
