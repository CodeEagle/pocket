import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = { id: "models", version: 1, start: "start", script: { start: [
  { type: "scene", characters: [{ id: "mira", model: { key: "mira-rig", animation: "idle", loop: true } }] },
  { type: "say", id: "first", text: "First" },
  { type: "scene", characters: [{ id: "mira", model: { key: "mira-rig", animation: "wave", skin: "raincoat", loop: false } }] },
  { type: "say", id: "second", text: "Second" },
  { type: "scene", characters: [{ id: "mira", model: null, expression: "hopeful" }] },
  { type: "say", id: "third", text: "Third" },
] } };

test("model intents survive save/load/rollback without persisting runtime mesh state", () => {
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start();
  expect(engine.getSnapshot().stage.characters.mira?.model?.animation).toBe("idle");
  const save = engine.save();
  engine.advance();
  expect(engine.getSnapshot().stage.characters.mira?.model?.animation).toBe("wave");
  engine.rollback();
  expect(engine.getSnapshot().stage.characters.mira?.model?.animation).toBe("idle");
  engine.load(save);
  expect(engine.getSnapshot().stage.characters.mira?.model).toEqual({ key: "mira-rig", animation: "idle", loop: true });
  engine.advance(); engine.advance();
  expect(engine.getSnapshot().stage.characters.mira?.model).toBeUndefined();
  expect(engine.getSnapshot().stage.characters.mira?.expression).toBe("hopeful");
  const invalid = structuredClone(save) as any;
  invalid.state.stage.characters.mira.model.vertices = [1, 2, 3];
  expect(() => engine.load(invalid)).toThrow("model is invalid");
  expect(() => createNovelEngine({ ...story, script: { start: [{ type: "scene", characters: [{ id: "mira", model: { key: "" } }] }] } })).toThrow("model is invalid");
});
