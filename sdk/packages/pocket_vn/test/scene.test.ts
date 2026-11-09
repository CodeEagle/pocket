import { expect, test } from "bun:test";
import { createNovelEngine, SaveDataError, StoryValidationError } from "../src/engine.ts";
import { orderedNovelCharacterIds, resolveNovelCharacterPlacement } from "../src/scene.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "scene-transform", version: 1, start: "start", script: { start: [
    { type: "scene", characters: [
      { id: "front", position: { x: 42, y: 91 }, scale: 1.25, rotation: 15, layer: 2 },
      { id: "back", position: "right", layer: -1 },
      { id: "tie", position: "left", layer: 2 },
    ] },
    { type: "say", id: "one", text: "One" },
    { type: "scene", characters: [{ id: "front", expression: "happy" }], transition: { kind: "dissolve", durationMs: 100 } },
    { type: "say", id: "two", text: "Two" },
    { type: "scene", characters: [{ id: "front", scale: 1, rotation: 0, layer: 0 }] },
    { type: "say", id: "three", text: "Three" },
  ] },
};

test("scene transforms persist through updates, transition, save/load and rollback without changing old defaults", () => {
  const engine = createNovelEngine(story);
  engine.start();
  const first = engine.getSnapshot().stage;
  expect(orderedNovelCharacterIds(first)).toEqual(["back", "front", "tie"]);
  expect(resolveNovelCharacterPlacement(first.characters.front!)).toEqual({ x: 42, y: 91, width: 240, height: 350, scale: 1.25, rotation: 15, layer: 2 });
  expect(resolveNovelCharacterPlacement(first.characters.back!)).toEqual({ x: 144, y: 116, width: 240, height: 350, scale: 1, rotation: 0, layer: -1 });
  expect("scale" in first.characters.back!).toBe(false);
  engine.advance(); engine.advance();
  expect(engine.getSnapshot().stage.characters.front).toMatchObject({ expression: "happy", scale: 1.25, rotation: 15, layer: 2 });
  expect(engine.getSnapshot().stage.transition?.from).toEqual({
    background: first.background,
    characters: first.characters,
    camera: { x: 0, y: 0, scale: 1 },
  });
  const saved = engine.save();
  const loaded = createNovelEngine(story);
  loaded.load(saved);
  expect(loaded.getSnapshot().stage).toEqual(engine.getSnapshot().stage);
  loaded.advance(); loaded.advance();
  expect(loaded.getSnapshot().stage.characters.front).toMatchObject({ scale: 1, rotation: 0, layer: 0 });
  loaded.rollback();
  expect(loaded.getSnapshot().stage.characters.front).toMatchObject({ scale: 1.25, rotation: 15, layer: 2 });
  const malformed = structuredClone(saved);
  (malformed.state.stage.characters.front as any).scale = -1;
  expect(() => loaded.load(malformed)).toThrow(SaveDataError);
  engine.dispose(); loaded.dispose();
});

test("invalid authored scale, rotation and layer fail before running", () => {
  for (const update of [{ scale: 0 }, { scale: 8.1 }, { rotation: 361 }, { layer: 0.5 }, { layer: -1025 }]) {
    const invalid = { ...story, script: { start: [{ type: "scene", characters: [{ id: "mira", ...update }] }] } };
    expect(() => createNovelEngine(invalid as StoryDefinition)).toThrow(StoryValidationError);
  }
});
