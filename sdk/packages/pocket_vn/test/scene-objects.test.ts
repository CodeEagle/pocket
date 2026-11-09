import { expect, test } from "bun:test";
import {
  conditions,
  createNovelEngine,
  encodeNovelSaveData,
  decodeNovelSaveData,
  isNovelSceneObjectInteractive,
  NovelEngineError,
  NovelSaveCodecError,
  novelSceneObjectsIssue,
  orderedNovelStageItems,
  resolveNovelSceneObjectGeometry,
  StoryValidationError,
} from "../src/index.ts";
import type { NovelSceneObject, StageComposition, StoryDefinition } from "../src/types.ts";

const memoryObject: NovelSceneObject = {
  id: "memory-note",
  image: "archive.note",
  frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
  crop: { x: 0.2, y: 0.25, w: 0.5, h: 0.5 },
  layer: 3,
  interaction: {
    label: "Read the note",
    when: conditions.falsy({ type: "variable", name: "noteRead" }),
    effects: [
      { type: "set", variable: "noteRead", value: true },
      { type: "inc", variable: "score", amount: 1 },
    ],
    hit: { x: 0.25, y: 0.4, w: 0.5, h: 0.2 },
  },
};

const laterObject: NovelSceneObject = {
  id: "lamp",
  image: "archive.lamp",
  frame: { x: 0.7, y: 0.15, w: 0.2, h: 0.3 },
  layer: 4,
};

const story: StoryDefinition = {
  id: "scene-object-stage",
  version: 1,
  start: "start",
  variableDefinitions: {
    noteRead: { lifetime: "save", defaultValue: false },
    score: { lifetime: "persistent", defaultValue: 0 },
  },
  script: {
    start: [
      { type: "scene", background: "archive", objects: [memoryObject] },
      { type: "say", id: "first-line", text: "Look closely." },
      { type: "scene", objects: [laterObject], transition: { kind: "dissolve", durationMs: 100 } },
      { type: "say", id: "second-line", text: "A new scene object." },
      { type: "scene", objects: [] },
      { type: "say", id: "third-line", text: "The objects are gone." },
    ],
  },
};

function finishSay(engine: ReturnType<typeof createNovelEngine>): void {
  let active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected an active say.");
  while (!active.complete) {
    engine.advance();
    active = engine.getSnapshot().active;
    if (active?.kind !== "say") throw new Error("Expected the same active say to reveal.");
  }
  engine.advance();
}

test("scene-object schema, crop geometry, hit geometry and stage order are shared pure helpers", () => {
  expect(novelSceneObjectsIssue([memoryObject])).toBeNull();
  expect(novelSceneObjectsIssue(Array.from({ length: 33 }, (_, index) => ({ ...memoryObject, id: `object-${index}` })))).toContain("at most 32");
  expect(novelSceneObjectsIssue([memoryObject, memoryObject])).toContain("duplicate object id");
  expect(novelSceneObjectsIssue([{ ...memoryObject, frame: { x: 0.8, y: 0, w: 0.3, h: 1 } }])).toContain("frame");
  expect(novelSceneObjectsIssue([{ ...memoryObject, layer: 0.5 }])).toContain("layer");
  expect(novelSceneObjectsIssue([{
    ...memoryObject,
    interaction: { ...memoryObject.interaction!, effects: Array.from({ length: 17 }, () => ({ type: "inc", variable: "score", amount: 1 })) },
  }])).toContain("between 1 and 16 effects");
  expect(novelSceneObjectsIssue([{
    ...memoryObject,
    interaction: { ...memoryObject.interaction!, hit: { x: 0.8, y: 0, w: 0.3, h: 0.5 } },
  }])).toContain("interaction.hit");
  for (const aspectRatio of [0, 0.049, 20.001, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(novelSceneObjectsIssue([{ ...memoryObject, aspectRatio }])).toContain("aspectRatio must be finite");
  }

  expect(resolveNovelSceneObjectGeometry(memoryObject, 360, 640)).toEqual({
    frame: { x: 36, y: 128, width: 180, height: 160 },
    image: { x: -72, y: -80, width: 360, height: 320 },
    hit: { x: 45, y: 64, width: 90, height: 32 },
  });
  expect(resolveNovelSceneObjectGeometry({ ...memoryObject, aspectRatio: 1 }, 360, 640)).toEqual({
    frame: { x: 46, y: 128, width: 160, height: 160 },
    image: { x: -64, y: -80, width: 320, height: 320 },
    hit: { x: 40, y: 64, width: 80, height: 32 },
  });
  expect(resolveNovelSceneObjectGeometry({ ...memoryObject, aspectRatio: 0.5 }, 360, 640)).toEqual({
    frame: { x: 86, y: 128, width: 80, height: 160 },
    image: { x: -32, y: -80, width: 160, height: 320 },
    hit: { x: 20, y: 64, width: 40, height: 32 },
  });
  expect(resolveNovelSceneObjectGeometry({ ...memoryObject, aspectRatio: 2 }, 360, 640)).toEqual({
    frame: { x: 36, y: 163, width: 180, height: 90 },
    image: { x: -72, y: -45, width: 360, height: 180 },
    hit: { x: 45, y: 36, width: 90, height: 18 },
  });
  for (const aspectRatio of [0.05, 20]) {
    const geometry = resolveNovelSceneObjectGeometry({
      ...memoryObject,
      frame: { x: 0, y: 0, w: 1, h: 1 },
      aspectRatio,
    }, 16_384, 16_384);
    expect(geometry).not.toBeNull();
    expect([geometry!.frame, geometry!.image, geometry!.hit].flatMap(rect => Object.values(rect)).every(Number.isFinite)).toBe(true);
    expect(geometry!.frame.width / geometry!.frame.height).toBeCloseTo(aspectRatio);
  }
  const tinyCrop = { ...memoryObject, crop: { x: 0, y: 0, w: Number.MIN_VALUE, h: 1 } };
  expect(novelSceneObjectsIssue([tinyCrop])).toContain("crop must keep image bounds finite");
  expect(resolveNovelSceneObjectGeometry(tinyCrop as unknown as NovelSceneObject, 360, 640)).toBeNull();
  const tinyCropHeight = { ...memoryObject, crop: { x: 0, y: 0, w: 1, h: Number.MIN_VALUE } };
  expect(novelSceneObjectsIssue([tinyCropHeight])).toContain("crop must keep image bounds finite");
  expect(resolveNovelSceneObjectGeometry(tinyCropHeight as unknown as NovelSceneObject, 360, 640)).toBeNull();
  expect(resolveNovelSceneObjectGeometry(memoryObject, Number.POSITIVE_INFINITY, 640)).toBeNull();
  expect(isNovelSceneObjectInteractive(memoryObject, { noteRead: false, score: 0 })).toBe(true);
  expect(isNovelSceneObjectInteractive(memoryObject, { noteRead: true, score: 1 })).toBe(false);

  const stage = {
    characters: {
      front: { id: "front", expression: "neutral", position: "center", visible: true, layer: 2 },
      hidden: { id: "hidden", expression: "neutral", position: "center", visible: false, layer: -4 },
      back: { id: "back", expression: "neutral", position: "left", visible: true, layer: -1 },
      tie: { id: "tie", expression: "neutral", position: "right", visible: true, layer: 3 },
    },
    objects: [memoryObject, laterObject],
  } as StageComposition;
  expect(orderedNovelStageItems(stage)).toEqual([
    { kind: "character", id: "back" },
    { kind: "character", id: "front" },
    { kind: "character", id: "tie" },
    { kind: "object", id: "memory-note" },
    { kind: "object", id: "lamp" },
  ]);
});

test("scene objects replace or preserve as authored, interact without advancing, and persist through transition/save/rollback", () => {
  const engine = createNovelEngine(story, { maxRollbackEntries: 8 });
  const trace: unknown[] = [];
  engine.debug.subscribeExecutionTrace(entries => trace.push(...entries));
  engine.start();
  trace.length = 0;
  const first = engine.getSnapshot();
  expect(first.stage.objects).toEqual([memoryObject]);
  expect(first.active).toMatchObject({ kind: "say", id: "first-line" });

  const beforeInteraction = engine.getSnapshot();
  const interacted = engine.interactSceneObject("memory-note");
  expect(interacted.events).toEqual([]);
  expect(interacted.snapshot.active).toEqual(beforeInteraction.active);
  expect(interacted.snapshot.location).toEqual(beforeInteraction.location);
  expect(interacted.snapshot.stage).toEqual(beforeInteraction.stage);
  expect(interacted.snapshot.variables).toMatchObject({ noteRead: true, score: 1 });
  expect(interacted.snapshot.meta.persistentVariables).toMatchObject({ score: 1 });
  expect(trace).toEqual([]);
  expect(isNovelSceneObjectInteractive(memoryObject, interacted.snapshot.variables)).toBe(false);
  const afterInteraction = engine.getSnapshot();
  expect(() => engine.interactSceneObject("memory-note")).toThrow(NovelEngineError);
  expect(engine.getSnapshot()).toEqual(afterInteraction);

  finishSay(engine);
  const second = engine.getSnapshot();
  expect(second.active).toMatchObject({ kind: "say", id: "second-line" });
  expect(second.stage.objects).toEqual([laterObject]);
  expect(second.stage.transition?.from?.objects).toEqual([memoryObject]);

  const save = engine.save();
  const compact = encodeNovelSaveData(save);
  expect(decodeNovelSaveData(compact)).toEqual(save);
  const loaded = createNovelEngine(story, { maxRollbackEntries: 8 });
  loaded.load(compact);
  expect(loaded.getSnapshot().stage.objects).toEqual([laterObject]);
  expect(loaded.getSnapshot().stage.transition?.from?.objects).toEqual([memoryObject]);
  loaded.rollback();
  expect(loaded.getSnapshot().active).toMatchObject({ kind: "say", id: "first-line" });
  expect(loaded.getSnapshot().stage.objects).toEqual([memoryObject]);
  expect(loaded.getSnapshot().variables).toMatchObject({ noteRead: true, score: 1 });

  finishSay(engine);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", id: "third-line" });
  expect(engine.getSnapshot().stage.objects).toBeUndefined();
  engine.dispose();
  loaded.dispose();
});

test("scene-object transactions roll back every effect on failure and reject pause, choice, input, and ending phases", () => {
  const malformedEffectStory: StoryDefinition = {
    id: "scene-object-atomic",
    version: 1,
    start: "start",
    variableDefinitions: { found: { lifetime: "save", defaultValue: false }, notNumber: { lifetime: "save", defaultValue: "no" } },
    script: { start: [
      { type: "scene", objects: [{ ...memoryObject, interaction: { label: "Pick up", effects: [
        { type: "set", variable: "found", value: true }, { type: "inc", variable: "notNumber", amount: 1 },
      ] } }] },
      { type: "say", id: "line", text: "Inspect." },
    ] },
  };
  const atomic = createNovelEngine(malformedEffectStory);
  atomic.start();
  const beforeFailedEffect = atomic.getSnapshot();
  expect(() => atomic.interactSceneObject("memory-note")).toThrow(NovelEngineError);
  expect(atomic.getSnapshot()).toEqual(beforeFailedEffect);
  atomic.pause();
  const paused = atomic.getSnapshot();
  expect(() => atomic.interactSceneObject("memory-note")).toThrow(/running/);
  expect(atomic.getSnapshot()).toEqual(paused);
  atomic.dispose();

  const gated: StoryDefinition = {
    id: "scene-object-gates",
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "scene", objects: [memoryObject] },
        { type: "say", id: "line", text: "Choose." },
        { type: "choice", id: "choice", options: [{ id: "continue", text: "Continue", target: "input" }] },
      ],
      input: [
        { type: "input", id: "input", variable: "answer", inputType: "text" },
        { type: "ending", id: "end" },
      ],
    },
  };
  const engine = createNovelEngine(gated);
  engine.start();
  finishSay(engine);
  expect(engine.getSnapshot().active?.kind).toBe("choice");
  const beforeChoiceReject = engine.getSnapshot();
  expect(() => engine.interactSceneObject("memory-note")).toThrow(/dialogue/);
  expect(engine.getSnapshot()).toEqual(beforeChoiceReject);
  engine.selectChoice("continue");
  expect(engine.getSnapshot().active?.kind).toBe("input");
  const beforeInputReject = engine.getSnapshot();
  expect(() => engine.interactSceneObject("memory-note")).toThrow(/dialogue/);
  expect(engine.getSnapshot()).toEqual(beforeInputReject);
  engine.updateInput("answer");
  engine.submitInput();
  expect(engine.getSnapshot().active?.kind).toBe("ending");
  expect(() => engine.interactSceneObject("memory-note")).toThrow(/dialogue/);
  engine.dispose();
});

test("scene objects validate on authored stories and compact stage pools while legacy saves omit them safely", () => {
  const badStory = {
    id: "bad-scene-object", version: 1, start: "start",
    script: { start: [{ type: "scene", objects: [{ ...memoryObject, frame: { x: 0, y: 0, w: 2, h: 1 } }] }] },
  };
  expect(() => createNovelEngine(badStory as StoryDefinition)).toThrow(StoryValidationError);
  const badCropStory = {
    id: "bad-scene-object-crop", version: 1, start: "start",
    script: { start: [{ type: "scene", objects: [{ ...memoryObject, crop: { x: 0, y: 0, w: Number.MIN_VALUE, h: 1 } }] }] },
  };
  expect(() => createNovelEngine(badCropStory as StoryDefinition)).toThrow(StoryValidationError);
  const badAspectRatioStory = {
    id: "bad-scene-object-aspect-ratio", version: 1, start: "start",
    script: { start: [{ type: "scene", objects: [{ ...memoryObject, aspectRatio: 100 }] }] },
  };
  expect(() => createNovelEngine(badAspectRatioStory as StoryDefinition)).toThrow(StoryValidationError);

  const engine = createNovelEngine(story, { maxRollbackEntries: 8 });
  engine.start();
  finishSay(engine);
  const modern = JSON.parse(JSON.stringify(engine.save())) as any;
  const compact = encodeNovelSaveData(modern);
  const corrupt = JSON.parse(JSON.stringify(compact));
  corrupt.state.rollbackHistory.pools.stages[0].objects[0].frame.w = 2;
  expect(() => decodeNovelSaveData(corrupt)).toThrow(NovelSaveCodecError);

  const legacy = JSON.parse(JSON.stringify(modern));
  delete legacy.state.stage.objects;
  if (legacy.state.stage.transition?.from) delete legacy.state.stage.transition.from.objects;
  for (const checkpoint of legacy.state.rollbackHistory) {
    delete checkpoint.stage.objects;
    if (checkpoint.stage.transition?.from) delete checkpoint.stage.transition.from.objects;
  }
  const loaded = createNovelEngine(story, { maxRollbackEntries: 8 });
  loaded.load(legacy);
  expect(loaded.getSnapshot().stage.objects).toBeUndefined();
  expect(loaded.getSnapshot().stage.transition?.from?.objects).toBeUndefined();
  engine.dispose();
  loaded.dispose();
});
