import { expect, test } from "bun:test";
import "./clock-test-fixture.ts";
import {
  createNovelEngine,
  decodeNovelSaveData,
  encodeNovelSaveData,
  NovelEngineError,
  novelTimelineDefinitionIssue,
  novelTimelineInstructionIssue,
  novelTimelineStoryIssue,
  SaveDataError,
  StoryValidationError,
} from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";
import { clockFixtureTimerCount, pumpClockFixture, resetClockFixture } from "./clock-test-fixture.ts";

const { attachNovelClock } = await import("../src/clock.ts");

const motionTimeline = {
  durationMs: 200,
  camera: [
    { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
    { atMs: 100, value: { x: 100, y: 50, scale: 2 }, easing: "easeInOut" as const },
    { atMs: 200, value: { x: 200, y: 0, scale: 1 } },
  ],
  actors: [{ id: "mira", keyframes: [
    { atMs: 0, value: { position: { x: 0, y: 10 }, scale: 1, rotation: 0 } },
    { atMs: 100, value: { position: { x: 100, y: 60 }, scale: 2, rotation: 90 }, easing: "easeInOut" as const },
    { atMs: 200, value: { position: { x: 200, y: 10 }, scale: 1, rotation: 180 } },
  ] }],
  audio: [
    { atMs: 0, cue: "at-zero" },
    { atMs: 40, cue: "at-forty" },
    { atMs: 100, cue: "at-middle" },
    { atMs: 200, cue: "at-end" },
  ],
};

const timelineStory: StoryDefinition = {
  id: "timeline-story",
  version: 1,
  start: "start",
  timelines: { sweep: motionTimeline },
  script: { start: [
    { type: "scene", background: "harbor", characters: [{ id: "mira", position: "left" }], timeline: "sweep" },
    { type: "say", id: "one", text: "" },
  ] },
};

function cues(update: { readonly events: readonly { readonly type: string; readonly cue?: string }[] }): string[] {
  return update.events.flatMap(event => event.type === "audioCue" && event.cue ? [event.cue] : []);
}

test("timeline schema enforces bounds, first frames, monotonic motion times, and full field paths", () => {
  expect(novelTimelineDefinitionIssue(motionTimeline)).toBeNull();
  expect(novelTimelineDefinitionIssue({ durationMs: 0 }, "story.timelines.bad")).toContain("story.timelines.bad.durationMs");
  expect(novelTimelineDefinitionIssue({ durationMs: 60_001 })).toContain("durationMs must be an integer between 1 and 60000");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    camera: [{ atMs: 1, value: { x: 0, y: 0, scale: 1 } }],
  }, "story.timelines.camera")).toContain("story.timelines.camera.camera[0].atMs must be 0");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    actors: [
      { id: "mira", keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }] },
      { id: "mira", keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }] },
    ],
  })).toContain("duplicates actor track 'mira'");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    actors: [{ id: "mira", keyframes: [
      { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
      { atMs: 0, value: { position: { x: 1, y: 0 }, scale: 1, rotation: 0 } },
    ] }],
  }, "story.timelines.move")).toContain("story.timelines.move.actors[0].keyframes[1].atMs must be strictly greater");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    actors: [{ id: "mira", keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, scale: 99, rotation: 0 } }] }],
  }, "story.timelines.move")).toContain("story.timelines.move.actors[0].keyframes[0].value.scale");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    actors: [{ id: "mira", keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, rotation: 0 } }] }],
  }, "story.timelines.move")).toContain("story.timelines.move.actors[0].keyframes[0].value.scale must be finite");
  expect(novelTimelineInstructionIssue(
    { type: "scene", timeline: "camera", cameraMotion: { durationMs: 100 } },
    { camera: { durationMs: 100, camera: [{ atMs: 0, value: { x: 0, y: 0, scale: 1 } }] } },
    "script.start[0]",
  )).toContain("script.start[0].cameraMotion");
  expect(novelTimelineInstructionIssue(
    { type: "scene", timeline: "actors", cameraMotion: { durationMs: 100 } },
    { actors: { durationMs: 100, actors: [] } },
    "script.start[0]",
  )).toBeNull();
  expect(novelTimelineStoryIssue({ ...timelineStory, script: { start: [{ type: "scene", timeline: "missing" }] } }))
    .toContain("script.start[0].timeline references unknown preset 'missing'");
  const oneActor = (id: string) => ({ id, keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }] });
  expect(novelTimelineDefinitionIssue({ durationMs: 1, actors: Array.from({ length: 33 }, (_, index) => oneActor(`actor-${index}`)) }))
    .toContain("actors cannot contain more than 32 tracks");
  expect(novelTimelineDefinitionIssue({
    durationMs: 100,
    camera: Array.from({ length: 65 }, (_, atMs) => ({ atMs, value: { x: 0, y: 0, scale: 1 } })),
  })).toContain("camera must contain between 1 and 64 keyframes");
  expect(novelTimelineDefinitionIssue({ durationMs: 1, audio: Array.from({ length: 257 }, (_, index) => ({ atMs: 0, cue: `cue-${index}` })) }))
    .toContain("audio cannot contain more than 256 cues");
  const gainTrack = (channel: string) => ({ channel, keyframes: [
    { atMs: 0, value: 1 }, { atMs: 100, value: 0, easing: "easeInOut" },
  ] });
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [] })).toBeNull();
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack("music")] })).toBeNull();
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [] }] }))
    .toContain("audioGains[0].keyframes must contain between 1 and 64 keyframes");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [{ atMs: 0 }] }] }))
    .toContain("audioGains[0].keyframes[0].value must be a finite number between 0 and 1");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [{ atMs: 0, value: Number.NaN }] }] }))
    .toContain("value must be a finite number between 0 and 1");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [{ atMs: 0, value: 1.01 }] }] }))
    .toContain("value must be a finite number between 0 and 1");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [
    { atMs: 0, value: 1 }, { atMs: 0, value: 0 },
  ] }] })).toContain("audioGains[0].keyframes[1].atMs must be strictly greater");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [
    { atMs: 1, value: 1 },
  ] }] })).toContain("audioGains[0].keyframes[0].atMs must be 0");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{ channel: "music", keyframes: [
    { atMs: 101, value: 1 },
  ] }] })).toContain("must be an integer between 0 and durationMs (100)");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack("music"), gainTrack("music")] }))
    .toContain("audioGains[1].channel duplicates gain track 'music'");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack("__pocket_vn_voice")] }))
    .toContain("audioGains[0].channel is reserved for dialogue voice");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack("music:main")] }))
    .toContain("audioGains[0].channel must be 1 to 64 ASCII letters");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack(`a${"b".repeat(64)}`)] }))
    .toContain("audioGains[0].channel must be 1 to 64 ASCII letters");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [gainTrack(`a${"b".repeat(63)}`)] })).toBeNull();
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: Array.from({ length: 33 }, (_, index) => gainTrack(`channel-${index}`)) }))
    .toContain("audioGains cannot contain more than 32 tracks");
  expect(novelTimelineDefinitionIssue({ durationMs: 100, audioGains: [{
    channel: "music", keyframes: Array.from({ length: 65 }, (_, atMs) => ({ atMs, value: 1 })),
  }] })).toContain("audioGains[0].keyframes must contain between 1 and 64 keyframes");
  expect(novelTimelineStoryIssue({
    ...timelineStory,
    timelines: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`t-${index}`, { durationMs: 1 }])),
  })).toContain("story.timelines cannot contain more than 128 presets");
  expect(() => createNovelEngine({
    ...timelineStory,
    script: { start: [{ type: "scene", timeline: "sweep", cameraMotion: { durationMs: 20 } }] },
  })).toThrow(StoryValidationError);
});

test("timeline audio groups are valid only on named play cues and preserve legacy routing", () => {
  const definition = (audio: readonly unknown[]) => ({ durationMs: 100, audio });
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "theme", channel: "harbor-bed", group: "music" },
    { atMs: 100, cue: "stop-theme", action: "stop", channel: "harbor-bed" },
    { atMs: 50, cue: "legacy" },
  ]))).toBeNull();
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "theme", group: "music" },
  ]))).toContain("audio[0].group requires a non-empty channel");
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "stop", action: "stop", channel: "harbor-bed", group: "music" },
  ]))).toContain("audio[0].group is only valid when action is 'play'");
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "wrong-bus", channel: "music", group: "effects" },
  ]))).toContain("audio[0].group must be 'music' when channel is 'music'");
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "wrong-channel", channel: "music-preview", group: "effects" },
  ]))).toContain("audio[0].channel 'music-preview' is reserved by the SDK");
  expect(novelTimelineDefinitionIssue(definition([
    { atMs: 0, cue: "legacy-internal", channel: "effect-0" },
  ]))).toBeNull();
});

test("timeline samples actors and camera from one elapsed value, pauses, emits exact crossings, and settles at its end", () => {
  const engine = createNovelEngine(timelineStory);
  const started = engine.start();
  expect(started.snapshot.stage.timeline).toEqual({ id: "sweep", elapsedMs: 0 });
  expect(cues(started)).toEqual(["at-zero"]);
  expect(started.snapshot.audioIntents).toEqual({});
  expect(started.snapshot.stage.characters.mira).toMatchObject({ position: { x: 0, y: 10 }, scale: 1, rotation: 0 });
  expect(started.snapshot.stage.camera).toMatchObject({ x: 0, y: 0, scale: 1 });

  const forty = engine.tick(40);
  expect(cues(forty)).toEqual(["at-forty"]);
  expect(forty.snapshot.stage.timeline).toEqual({ id: "sweep", elapsedMs: 40 });
  expect(forty.snapshot.stage.characters.mira!.position.x).toBeCloseTo(35.2);
  expect(forty.snapshot.stage.characters.mira!.position.y).toBeCloseTo(27.6);
  expect(forty.snapshot.stage.characters.mira!.scale).toBeCloseTo(1.352);
  expect(forty.snapshot.stage.characters.mira!.rotation).toBeCloseTo(31.68);
  expect(forty.snapshot.stage.camera.x).toBeCloseTo(35.2);

  engine.pause();
  const paused = engine.getSnapshot().stage;
  engine.tick(1_000);
  expect(engine.getSnapshot().stage).toEqual(paused);
  engine.resume();
  const hundred = engine.tick(60);
  expect(hundred.snapshot.stage.timeline).toEqual({ id: "sweep", elapsedMs: 100 });
  expect(hundred.snapshot.stage.characters.mira).toMatchObject({ position: { x: 100, y: 60 }, scale: 2, rotation: 90 });
  expect(hundred.snapshot.stage.camera).toMatchObject({ x: 100, y: 50, scale: 2 });
  expect(cues(hundred)).toEqual(["at-middle"]);
  expect(cues(engine.tick(1))).toEqual([]);
  const finished = engine.tick(99);
  expect(cues(finished)).toEqual(["at-end"]);
  expect(finished.snapshot.stage.timeline).toBeUndefined();
  expect(finished.snapshot.stage.characters.mira).toMatchObject({ position: { x: 200, y: 10 }, scale: 1, rotation: 180 });
  expect(finished.snapshot.stage.camera).toMatchObject({ x: 200, y: 0, scale: 1, motion: null });
  engine.dispose();
});

test("one large delta crosses every cue once in time order and keeps the final pose", () => {
  const engine = createNovelEngine(timelineStory);
  const started = engine.start();
  expect(cues(started)).toEqual(["at-zero"]);
  const finished = engine.tick(500);
  expect(cues(finished)).toEqual(["at-forty", "at-middle", "at-end"]);
  expect(finished.snapshot.stage.timeline).toBeUndefined();
  expect(finished.snapshot.stage.characters.mira).toMatchObject({ position: { x: 200, y: 10 }, scale: 1, rotation: 180 });
  expect(finished.snapshot.stage.camera.x).toBe(200);
  engine.dispose();
});

test("audio gain tracks sample and hold the play intent through pause, end, and large deltas", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "music", loop: true }, { atMs: 40, cue: "marker" }],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 1 }, { atMs: 100, value: 0.2 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  expect(cues(engine.start())).toEqual(["theme"]);
  expect(engine.getSnapshot().audioIntents.music).toEqual({ action: "play", cue: "theme", loop: true });
  engine.tick(50);
  expect(engine.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.6);
  engine.pause();
  const pausedGain = engine.getSnapshot().audioIntents.music?.gain;
  engine.tick(1_000);
  expect(engine.getSnapshot().audioIntents.music?.gain).toBe(pausedGain);
  engine.resume();
  const ended = engine.tick(50);
  expect(cues(ended)).toEqual([]);
  expect(ended.snapshot.stage.timeline).toBeUndefined();
  expect(ended.snapshot.audioIntents.music?.gain).toBeCloseTo(0.2);
  expect(cues(engine.tick(500))).toEqual([]);
  expect(engine.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.2);
  engine.dispose();

  const large = createNovelEngine(story);
  large.start();
  const jumped = large.tick(500);
  expect(cues(jumped)).toEqual(["marker"]);
  expect(jumped.snapshot.stage.timeline).toBeUndefined();
  expect(jumped.snapshot.audioIntents.music?.gain).toBeCloseTo(0.2);
  large.dispose();
});

test("crossfade timeline overlaps two music loops and stops each channel at its authored boundary", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-crossfade", version: 1, start: "start",
    timelines: { crossfade: {
      durationMs: 100,
      audio: [
        { atMs: 0, cue: "theme-a", channel: "harbor-a", loop: true, group: "music" },
        { atMs: 25, cue: "theme-b", channel: "harbor-b", loop: true, group: "music" },
        { atMs: 75, cue: "stop-a", action: "stop", channel: "harbor-a" },
        { atMs: 100, cue: "stop-b", action: "stop", channel: "harbor-b" },
      ],
      audioGains: [
        { channel: "harbor-a", keyframes: [{ atMs: 0, value: 1 }, { atMs: 100, value: 0 }] },
        { channel: "harbor-b", keyframes: [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }] },
      ],
    } },
    script: { start: [
      { type: "scene", timeline: "crossfade" },
      { type: "say", id: "end", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  const started = engine.start();
  expect(cues(started)).toEqual(["theme-a"]);
  expect(started.snapshot.audioIntents["harbor-a"]).toEqual({
    action: "play", cue: "theme-a", loop: true, group: "music",
  });

  const overlap = engine.tick(25);
  expect(cues(overlap)).toEqual(["theme-b"]);
  expect(overlap.snapshot.audioIntents["harbor-a"]?.gain).toBeCloseTo(0.75);
  expect(overlap.snapshot.audioIntents["harbor-b"]).toMatchObject({
    action: "play", cue: "theme-b", loop: true, group: "music", gain: 0.25,
  });

  const firstStop = engine.tick(50);
  expect(cues(firstStop)).toEqual(["stop-a"]);
  expect(firstStop.snapshot.audioIntents["harbor-a"]).toEqual({
    action: "stop", cue: "stop-a", loop: false,
  });
  expect(firstStop.snapshot.audioIntents["harbor-b"]?.gain).toBeCloseTo(0.75);

  const finished = engine.tick(25);
  expect(cues(finished)).toEqual(["stop-b"]);
  expect(finished.snapshot.stage.timeline).toBeUndefined();
  expect(finished.snapshot.audioIntents["harbor-b"]).toEqual({
    action: "stop", cue: "stop-b", loop: false,
  });
  engine.dispose();
});

test("gain tracks wait for a future play cue, then update without emitting another audio cue", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain-future", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [
        { atMs: 40, cue: "late-theme", channel: "music", loop: true },
        { atMs: 60, cue: "stop-theme", action: "stop", channel: "music" },
      ],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 0 }, { atMs: 100, value: 1 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  expect(cues(engine.start())).toEqual([]);
  expect(engine.getSnapshot().audioIntents).toEqual({});
  const crossed = engine.tick(50);
  expect(cues(crossed)).toEqual(["late-theme"]);
  expect(crossed.snapshot.audioIntents.music).toMatchObject({ action: "play", cue: "late-theme", loop: true, gain: 0.5 });
  const sampled = engine.tick(5);
  expect(cues(sampled)).toEqual([]);
  expect(sampled.snapshot.audioIntents.music?.gain).toBeCloseTo(0.55);
  const stopped = engine.tick(5);
  expect(cues(stopped)).toEqual(["stop-theme"]);
  expect(stopped.snapshot.audioIntents.music).toEqual({ action: "stop", cue: "stop-theme", loop: false });
  engine.dispose();
});

test("an explicit play during an active gain track samples the timeline before save and load", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain-replace", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "old-theme", channel: "music" }],
      audioGains: [{ channel: "music", keyframes: [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "audio", action: "play", cue: "replacement", channel: "music" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  engine.start(); engine.tick(25);
  const update = engine.advance();
  expect(cues(update)).toEqual(["replacement"]);
  expect(update.snapshot.audioIntents.music).toMatchObject({ action: "play", cue: "replacement", gain: 0.25 });
  const saved = engine.save();
  const loaded = createNovelEngine(story);
  loaded.load(JSON.parse(JSON.stringify(saved)));
  expect(loaded.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.25);
  engine.dispose(); loaded.dispose();
});

test("gain state round-trips and rollback resumes its checkpoint while malformed gains fail atomically", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain-save", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "music", loop: true }],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 0 }, { atMs: 100, value: 1 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const source = createNovelEngine(story);
  source.start(); source.tick(40); source.advance();
  expect(source.getSnapshot().stage.timeline?.elapsedMs).toBe(40);
  expect(source.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.4);
  const checkpointSave = source.save();
  expect(checkpointSave.state.rollbackHistory[0]?.audioIntents.music?.gain).toBeCloseTo(0.4);

  source.tick(30);
  const saved = source.save();
  expect(saved.state.audioIntents.music?.gain).toBeCloseTo(0.7);
  expect(decodeNovelSaveData(encodeNovelSaveData(saved))).toEqual(saved);
  const loaded = createNovelEngine(story);
  loaded.load(JSON.parse(JSON.stringify(saved)));
  expect(loaded.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.7);

  const beforeBadLoad = loaded.save();
  const badCurrent = JSON.parse(JSON.stringify(saved));
  badCurrent.state.audioIntents.music.gain = 0.2;
  expect(() => loaded.load(badCurrent)).toThrow(SaveDataError);
  expect(loaded.save()).toEqual(beforeBadLoad);
  const badCheckpoint = JSON.parse(JSON.stringify(saved));
  badCheckpoint.state.rollbackHistory[0].audioIntents.music.gain = 0.2;
  expect(() => loaded.load(badCheckpoint)).toThrow(SaveDataError);
  expect(loaded.save()).toEqual(beforeBadLoad);
  const invalidGain = JSON.parse(JSON.stringify(saved));
  invalidGain.state.audioIntents.music.gain = 2;
  expect(() => loaded.load(invalidGain)).toThrow(SaveDataError);
  expect(() => encodeNovelSaveData(invalidGain)).toThrow();

  source.rollback();
  expect(source.getSnapshot().stage.timeline?.elapsedMs).toBe(40);
  expect(source.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.4);
  expect(cues(source.tick(30))).toEqual([]);
  expect(source.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.7);
  loaded.dispose(); source.dispose();
});

test("group survives gain normalization, pause, save/load, rollback, and legacy omission", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-group-state", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "harbor-bed", loop: true, group: "music" }],
      audioGains: [{ channel: "harbor-bed", keyframes: [
        { atMs: 0, value: 0.5 }, { atMs: 50, value: 1 }, { atMs: 100, value: 0.2 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  const started = engine.start();
  expect(started.snapshot.audioIntents["harbor-bed"]).toMatchObject({ group: "music", gain: 0.5 });
  expect(started.snapshot.meta.musicIds).toContain("theme");
  engine.tick(50);
  expect(engine.getSnapshot().audioIntents["harbor-bed"]).toEqual({
    action: "play", cue: "theme", loop: true, group: "music",
  });
  engine.pause();
  engine.tick(1_000);
  expect(engine.getSnapshot().stage.timeline?.elapsedMs).toBe(50);
  expect(engine.getSnapshot().audioIntents["harbor-bed"]).toEqual({
    action: "play", cue: "theme", loop: true, group: "music",
  });
  engine.resume();
  engine.advance();
  engine.tick(25);
  expect(engine.getSnapshot().audioIntents["harbor-bed"]?.gain).toBeCloseTo(0.6);

  const saved = engine.save();
  const loaded = createNovelEngine(story);
  loaded.load(JSON.parse(JSON.stringify(saved)));
  expect(loaded.getSnapshot().audioIntents["harbor-bed"]).toMatchObject({ group: "music", gain: 0.6 });

  const beforeInvalidLoad = loaded.save();
  const invalidSaves = [
    (bad: any) => { bad.state.audioIntents["harbor-bed"].group = "voice"; },
    (bad: any) => { bad.state.audioIntents["harbor-bed"].action = "stop"; bad.state.audioIntents["harbor-bed"].group = "music"; },
    (bad: any) => {
      delete bad.state.audioIntents["harbor-bed"];
      bad.state.audioIntents.music = { action: "play", cue: "theme", loop: true, group: "effects" };
    },
    (bad: any) => { bad.state.rollbackHistory[0].audioIntents["harbor-bed"].group = "voice"; },
  ];
  for (const mutate of invalidSaves) {
    const bad = JSON.parse(JSON.stringify(beforeInvalidLoad));
    mutate(bad);
    expect(() => loaded.load(bad)).toThrow(SaveDataError);
    expect(loaded.save()).toEqual(beforeInvalidLoad);
  }

  engine.rollback();
  expect(engine.getSnapshot().stage.timeline?.elapsedMs).toBe(50);
  expect(engine.getSnapshot().audioIntents["harbor-bed"]).toEqual({
    action: "play", cue: "theme", loop: true, group: "music",
  });
  const legacy = JSON.parse(JSON.stringify(saved));
  delete legacy.state.audioIntents["harbor-bed"].group;
  if (legacy.state.rollbackHistory[0]?.audioIntents["harbor-bed"]) {
    delete legacy.state.rollbackHistory[0].audioIntents["harbor-bed"].group;
  }
  const legacyLoaded = createNovelEngine(story);
  legacyLoaded.load(legacy);
  expect(legacyLoaded.getSnapshot().audioIntents["harbor-bed"]).toEqual({
    action: "play", cue: "theme", loop: true, gain: 0.6,
  });
  legacyLoaded.dispose(); loaded.dispose(); engine.dispose();
});

test("active timeline accepts an omitted legacy gain only when its sampled value is one", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain-legacy", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "music" }],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 1 }, { atMs: 100, value: 0 },
      ] }],
    } },
    script: { start: [{ type: "scene", timeline: "fade" }, { type: "say", id: "one", text: "" }] },
  };
  const engine = createNovelEngine(story); engine.start();
  const legacy = JSON.parse(JSON.stringify(engine.save()));
  delete legacy.state.audioIntents.music.gain;
  const loaded = createNovelEngine(story);
  loaded.load(legacy);
  expect(loaded.getSnapshot().audioIntents.music).toEqual({ action: "play", cue: "theme", loop: false });
  loaded.tick(20);
  const beforeBadLoad = loaded.save();
  const bad = JSON.parse(JSON.stringify(beforeBadLoad));
  delete bad.state.audioIntents.music.gain;
  expect(() => loaded.load(bad)).toThrow(SaveDataError);
  expect(loaded.save()).toEqual(beforeBadLoad);
  engine.dispose(); loaded.dispose();
});

test("a new explicit play resets a held timeline gain to the default gain", () => {
  const story: StoryDefinition = {
    id: "timeline-audio-gain-play-reset", version: 1, start: "start",
    timelines: { fade: { durationMs: 100, audio: [{ atMs: 0, cue: "old", channel: "music" }],
      audioGains: [{ channel: "music", keyframes: [{ atMs: 0, value: 1 }, { atMs: 100, value: 0 }] }] } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "scene", timeline: null },
      { type: "say", id: "two", text: "" },
      { type: "audio", action: "play", cue: "new", channel: "music" },
      { type: "say", id: "three", text: "" },
    ] },
  };
  const engine = createNovelEngine(story); engine.start(); engine.tick(25);
  expect(engine.getSnapshot().audioIntents.music?.gain).toBeCloseTo(0.75);
  const cancelled = engine.advance();
  expect(cues(cancelled)).toEqual([]);
  expect(cancelled.snapshot.stage.timeline).toBeUndefined();
  expect(cancelled.snapshot.audioIntents.music?.gain).toBeCloseTo(0.75);
  const update = engine.advance();
  expect(cues(update)).toEqual(["new"]);
  expect(update.snapshot.stage.timeline).toBeUndefined();
  expect(update.snapshot.audioIntents.music).toEqual({ action: "play", cue: "new", loop: false });
  engine.dispose();
});

test("skip mode advances timeline tracks and cues through the same narrative clock", () => {
  const engine = createNovelEngine(timelineStory);
  engine.start();
  engine.setPreferences({ mode: "skip", skipSeenOnly: false });
  const skipped = engine.tick(500);
  expect(cues(skipped)).toEqual(["at-forty", "at-middle", "at-end"]);
  expect(skipped.snapshot.stage.timeline).toBeUndefined();
  expect(skipped.snapshot.stage.characters.mira).toMatchObject({ position: { x: 200, y: 10 }, rotation: 180 });
  engine.dispose();
});

test("actor timelines can share the existing scene cameraMotion when they do not own a camera track", () => {
  const story: StoryDefinition = {
    id: "timeline-camera-motion", version: 1, start: "start", timelines: { actor: {
      durationMs: 100,
      actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
        { atMs: 100, value: { position: { x: 100, y: 0 }, scale: 1, rotation: 0 } },
      ] }],
    } }, script: { start: [
      { type: "scene", characters: [{ id: "mira" }], camera: { x: 100, y: 0, scale: 1 }, cameraMotion: { durationMs: 100 }, timeline: "actor" },
      { type: "say", id: "one", text: "" },
    ] },
  };
  const engine = createNovelEngine(story); engine.start();
  engine.tick(50);
  expect(engine.getSnapshot().stage.timeline?.elapsedMs).toBe(50);
  expect(engine.getSnapshot().stage.characters.mira!.position.x).toBeCloseTo(50);
  expect(engine.getSnapshot().stage.camera.motion?.elapsedMs).toBe(50);
  expect(engine.getSnapshot().stage.camera.motion?.durationMs).toBe(100);
  engine.dispose();
});

test("save/load does not replay zero or crossed cues and rejects forged preset, time, target, and pose atomically", () => {
  const source = createNovelEngine(timelineStory);
  expect(cues(source.start())).toEqual(["at-zero"]);
  const zeroLoaded = createNovelEngine(timelineStory);
  expect(cues(zeroLoaded.load(JSON.parse(JSON.stringify(source.save()))))).toEqual([]);
  expect(cues(zeroLoaded.tick(40))).toEqual(["at-forty"]);
  expect(cues(source.tick(40))).toEqual(["at-forty"]);
  const saved = source.save();
  expect(decodeNovelSaveData(encodeNovelSaveData(saved))).toEqual(saved);
  const loaded = createNovelEngine(timelineStory);
  const loadUpdate = loaded.load(JSON.parse(JSON.stringify(saved)));
  expect(cues(loadUpdate)).toEqual([]);
  expect(loaded.getSnapshot().stage.timeline).toEqual({ id: "sweep", elapsedMs: 40 });
  expect(cues(loaded.tick(60))).toEqual(["at-middle"]);
  expect(cues(loaded.tick(100))).toEqual(["at-end"]);
  expect(loaded.getSnapshot().stage.timeline).toBeUndefined();

  const before = loaded.save();
  const badId = JSON.parse(JSON.stringify(saved));
  badId.state.stage.timeline.id = "missing";
  expect(() => loaded.load(badId)).toThrow(SaveDataError);
  const badTime = JSON.parse(JSON.stringify(saved));
  badTime.state.stage.timeline.elapsedMs = 200;
  expect(() => loaded.load(badTime)).toThrow(SaveDataError);
  const badTarget = JSON.parse(JSON.stringify(saved));
  delete badTarget.state.stage.characters.mira;
  expect(() => loaded.load(badTarget)).toThrow(SaveDataError);
  const badPose = JSON.parse(JSON.stringify(saved));
  badPose.state.stage.characters.mira.position.x += 1;
  expect(() => loaded.load(badPose)).toThrow(SaveDataError);
  expect(loaded.save()).toEqual(before);
  source.dispose(); zeroLoaded.dispose(); loaded.dispose();
});

test("rollback resumes from its saved elapsed time and does not replay already crossed timeline cues", () => {
  const story: StoryDefinition = {
    id: "timeline-rollback", version: 1, start: "start", timelines: { sweep: {
      durationMs: 200,
      actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
        { atMs: 200, value: { position: { x: 200, y: 0 }, scale: 1, rotation: 0 } },
      ] }],
      audio: [{ atMs: 0, cue: "zero" }, { atMs: 50, cue: "fifty" }, { atMs: 150, cue: "one-fifty" }],
    } }, script: { start: [
      { type: "scene", characters: [{ id: "mira" }], timeline: "sweep" },
      { type: "say", id: "one", text: "" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  expect(cues(engine.start())).toEqual(["zero"]);
  expect(cues(engine.tick(50))).toEqual(["fifty"]);
  engine.advance();
  expect(engine.getSnapshot().stage.timeline).toEqual({ id: "sweep", elapsedMs: 50 });
  expect(cues(engine.tick(100))).toEqual(["one-fifty"]);
  engine.rollback();
  expect(engine.getSnapshot().stage.timeline).toEqual({ id: "sweep", elapsedMs: 50 });
  expect(cues(engine.tick(100))).toEqual(["one-fifty"]);
  engine.dispose();
});

test("new timeline presets reset their own clock and scene omission or null interrupts without a second stage state", () => {
  const story: StoryDefinition = {
    id: "timeline-switch", version: 1, start: "start", timelines: {
      first: { durationMs: 100, actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
        { atMs: 100, value: { position: { x: 100, y: 0 }, scale: 1, rotation: 0 } },
      ] }] },
      second: { durationMs: 100, actors: [{ id: "mira", keyframes: [
        { atMs: 0, value: { position: { x: 300, y: 0 }, scale: 2, rotation: 30 } },
        { atMs: 100, value: { position: { x: 400, y: 0 }, scale: 2, rotation: 60 } },
      ] }] },
    }, script: { start: [
      { type: "scene", characters: [{ id: "mira" }], timeline: "first" },
      { type: "say", id: "one", text: "" },
      { type: "scene", timeline: "second", transition: { kind: "fade", durationMs: 100 } },
      { type: "say", id: "two", text: "" },
      { type: "scene", timeline: null },
      { type: "say", id: "three", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  engine.start(); engine.tick(50);
  expect(engine.getSnapshot().stage.characters.mira!.position).toMatchObject({ x: 50, y: 0 });
  engine.advance();
  expect(engine.getSnapshot().stage.timeline).toEqual({ id: "second", elapsedMs: 0 });
  expect(engine.getSnapshot().stage.characters.mira).toMatchObject({ position: { x: 300, y: 0 }, scale: 2, rotation: 30 });
  expect(engine.getSnapshot().stage.transition?.from && "timeline" in engine.getSnapshot().stage.transition.from).toBe(false);
  engine.advance();
  expect(engine.getSnapshot().stage.timeline).toBeUndefined();
  expect(engine.getSnapshot().stage.characters.mira).toMatchObject({ position: { x: 300, y: 0 }, scale: 2, rotation: 30 });
  expect("timeline" in (engine.getSnapshot().stage.transition?.from ?? {})).toBe(false);
  engine.dispose();
});

test("activation rejects unknown actor targets atomically, old saves omit timeline, and the shared clock sleeps when settled", async () => {
  const invalid: StoryDefinition = {
    id: "timeline-missing-target", version: 1, start: "start",
    timelines: { sweep: { durationMs: 100, actors: [{ id: "unknown", keyframes: [
      { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
    ] }] } },
    script: { start: [{ type: "scene", characters: [{ id: "mira" }], timeline: "sweep", transition: { kind: "fade", durationMs: 100 } }] },
  };
  const engine = createNovelEngine(invalid);
  const beforeActivation = engine.save();
  expect(() => engine.start()).toThrow(NovelEngineError);
  expect(engine.getSnapshot().started).toBe(false);
  expect(engine.getSnapshot().stage.characters).toEqual({});
  expect(engine.save()).toEqual(beforeActivation);
  engine.dispose();

  const legacyStory: StoryDefinition = { id: "timeline-old-save", version: 1, start: "start", script: { start: [
    { type: "scene", characters: [{ id: "mira" }] }, { type: "say", id: "one", text: "" },
  ] } };
  const legacySource = createNovelEngine(legacyStory); legacySource.start();
  const legacy = JSON.parse(JSON.stringify(legacySource.save()));
  delete legacy.state.stage.timeline;
  const legacyLoaded = createNovelEngine(legacyStory); legacyLoaded.load(legacy);
  expect(legacyLoaded.getSnapshot().stage.timeline).toBeUndefined();

  resetClockFixture();
  const clocked = createNovelEngine(timelineStory);
  const detach = attachNovelClock(clocked);
  clocked.start();
  expect(clockFixtureTimerCount()).toBe(1);
  clocked.pause(); expect(clockFixtureTimerCount()).toBe(0);
  pumpClockFixture(8);
  expect(clocked.getSnapshot().stage.timeline?.elapsedMs).toBe(0);
  clocked.resume(); pumpClockFixture(14);
  expect(clocked.getSnapshot().stage.timeline).toBeUndefined();
  expect(clockFixtureTimerCount()).toBe(0);
  detach(); clocked.dispose(); legacySource.dispose(); legacyLoaded.dispose();
});
