import { expect, test } from "bun:test";
import {
  createNovelEngine,
  NovelSaveCodecError,
  SaveDataError,
  StoryValidationError,
} from "../src/index.ts";
import { formatStoryText, parseStoryText } from "../src/authoring.ts";
import { localizeStory, rebaseNovelSaveDataForLocale } from "../src/localization.ts";
import {
  decodeNovelSaveData,
  encodeNovelSaveData,
} from "../src/save-codec.ts";
import {
  novelBackgroundLayersInstructionIssue,
  resolveNovelBackgroundLayerPose,
} from "../src/background-layers.ts";
import type { StoryDefinition } from "../src/types.ts";

const layers = [
  { background: "distant-fog", parallax: 0.25 },
  { background: "foreground-rail", parallax: 0.8 },
] as const;

const story: StoryDefinition = {
  id: "background-layers",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", backgroundLayers: [layers[0]!] },
      { type: "say", id: "one", text: "The first composition." },
      {
        type: "scene",
        background: "archive",
        backgroundLayers: layers,
        camera: { x: 80, y: -40, scale: 1.5 },
        cameraMotion: { durationMs: 400 },
        transition: { kind: "dissolve", durationMs: 300 },
      },
      { type: "say", id: "two", text: "The second composition." },
      { type: "scene", backgroundLayers: [] },
      { type: "say", id: "three", text: "The overlays are cleared." },
      { type: "ending", id: "finish" },
    ],
  },
};

function finishSay(engine: ReturnType<typeof createNovelEngine>): void {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected a say instruction.");
  if (!active.complete) engine.advance();
  engine.advance();
}

test("background layer validator and pose helper share the scene camera without clamping", () => {
  expect(novelBackgroundLayersInstructionIssue({ type: "scene" })).toBeNull();
  expect(novelBackgroundLayersInstructionIssue({ type: "scene", backgroundLayers: layers })).toBeNull();
  expect(novelBackgroundLayersInstructionIssue({
    type: "scene",
    backgroundLayers: Array.from({ length: 9 }, (_, index) => ({ background: `plane-${index}`, parallax: 0.5 })),
  })).toContain("at most 8");
  expect(novelBackgroundLayersInstructionIssue({ type: "scene", backgroundLayers: [{ background: "", parallax: 0.5 }] })).toContain("background");
  expect(novelBackgroundLayersInstructionIssue({ type: "scene", backgroundLayers: [{ background: "mist", parallax: -0.1 }] })).toContain("between 0 and 1");
  expect(novelBackgroundLayersInstructionIssue({ type: "scene", backgroundLayers: [{ background: "mist", parallax: 1.01 }] })).toContain("between 0 and 1");
  expect(novelBackgroundLayersInstructionIssue({ type: "scene", backgroundLayers: [{ background: "mist", parallax: Number.NaN }] })).toContain("between 0 and 1");

  const camera = {
    x: 80, y: -40, scale: 2,
    motion: {
      from: { x: 0, y: 0, scale: 1 },
      elapsedMs: 200,
      durationMs: 400,
      easing: "linear" as const,
    },
  };
  expect(resolveNovelBackgroundLayerPose(camera, 0)).toEqual({ x: 0, y: 0, scale: 1 });
  expect(resolveNovelBackgroundLayerPose(camera, 0.5)).toEqual({ x: 20, y: -10, scale: 1.25 });
  expect(resolveNovelBackgroundLayerPose(camera, 1)).toEqual({ x: 40, y: -20, scale: 1.5 });
  expect(resolveNovelBackgroundLayerPose(camera, 0.5, { reduceMotion: true })).toEqual({ x: 40, y: -20, scale: 1.5 });
  expect(resolveNovelBackgroundLayerPose(undefined, 0.5)).toEqual({ x: 0, y: 0, scale: 1 });
});

test("layers execute, survive save/load and transition capture, then rollback with the prior stage", () => {
  const engine = createNovelEngine(story, { maxRollbackEntries: 8 });
  const first = engine.start();
  expect(first.snapshot.stage.background).toBe("station");
  expect(first.snapshot.stage.backgroundLayers).toEqual([layers[0]]);

  finishSay(engine);
  const snapshot = engine.getSnapshot();
  expect(snapshot.active).toMatchObject({ kind: "say", id: "two" });
  expect(snapshot.stage.background).toBe("archive");
  expect(snapshot.stage.backgroundLayers).toEqual(layers);
  expect(snapshot.stage.transition?.from).toMatchObject({
    background: "station",
    backgroundLayers: [layers[0]],
  });

  const ordinary = engine.save();
  const compact = encodeNovelSaveData(ordinary);
  expect(decodeNovelSaveData(compact)).toEqual(ordinary);
  const localized = localizeStory(story, {
    fr: {
      format: "pocket-vn-locale",
      formatVersion: 1,
      locale: "fr",
      lines: { one: "Première composition.", two: "Deuxième composition." },
    },
  }, "fr");
  const rebased = rebaseNovelSaveDataForLocale(ordinary, story, localized.story);
  expect(rebased.state.stage.backgroundLayers).toEqual(layers);
  expect(rebased.state.stage.transition?.from?.backgroundLayers).toEqual([layers[0]]);

  const corruptCompact = JSON.parse(JSON.stringify(compact));
  corruptCompact.state.rollbackHistory.pools.stages[0].backgroundLayers[0].parallax = 2;
  expect(() => decodeNovelSaveData(corruptCompact)).toThrow(NovelSaveCodecError);

  const loaded = createNovelEngine(story, { maxRollbackEntries: 8 });
  loaded.load(compact);
  expect(loaded.getSnapshot().stage.backgroundLayers).toEqual(layers);
  expect(loaded.getSnapshot().stage.transition?.from?.backgroundLayers).toEqual([layers[0]]);
  loaded.rollback();
  expect(loaded.getSnapshot().active).toMatchObject({ kind: "say", id: "one", complete: true });
  expect(loaded.getSnapshot().stage.background).toBe("station");
  expect(loaded.getSnapshot().stage.backgroundLayers).toEqual([layers[0]]);

  const cleared = createNovelEngine(story);
  cleared.load(ordinary);
  finishSay(cleared);
  expect(cleared.getSnapshot().active).toMatchObject({ kind: "say", id: "three" });
  expect(cleared.getSnapshot().stage.background).toBe("archive");
  expect(cleared.getSnapshot().stage.backgroundLayers).toBeUndefined();
  engine.dispose();
  loaded.dispose();
  cleared.dispose();
});

test("legacy saves without backgroundLayers load as the old single-background stage; invalid load is atomic", () => {
  const engine = createNovelEngine(story, { maxRollbackEntries: 8 });
  engine.start();
  finishSay(engine);

  const modern = JSON.parse(JSON.stringify(engine.save()));
  const legacy = JSON.parse(JSON.stringify(modern));
  delete legacy.state.stage.backgroundLayers;
  for (const checkpoint of legacy.state.rollbackHistory) {
    delete checkpoint.stage.backgroundLayers;
    if (checkpoint.stage.transition?.from) delete checkpoint.stage.transition.from.backgroundLayers;
  }
  engine.load(legacy);
  expect(engine.getSnapshot().stage.backgroundLayers).toBeUndefined();

  const beforeInvalidLoad = engine.getSnapshot();
  const invalid = JSON.parse(JSON.stringify(modern));
  invalid.state.stage.backgroundLayers[0].parallax = 2;
  expect(() => engine.load(invalid)).toThrow(SaveDataError);
  expect(engine.getSnapshot()).toEqual(beforeInvalidLoad);
  engine.dispose();
});

test("engine rejects malformed authored background layer lists", () => {
  expect(() => createNovelEngine({
    ...story,
    script: { start: [{ type: "scene", backgroundLayers: [{ background: "mist", parallax: 2 }] }] },
  } as StoryDefinition)).toThrow(StoryValidationError);
});

test("layered scene instructions stay lossless through the existing authoring format", () => {
  const parsed = parseStoryText(formatStoryText(story));
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story?.script.start).toEqual(story.script.start);
});
