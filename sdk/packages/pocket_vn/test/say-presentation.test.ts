import { expect, test } from "bun:test";
import { createNovelEngine, StoryValidationError } from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "say-presentation",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "legacy", speaker: "Mira", text: "普通对白：海雾里的灯。" },
      { type: "say", id: "reader", presentation: "fullscreen", text: "全屏段落：aLongEnglishWordWithoutSpacesAnd中文内容仍由同一个对白时钟推进。" },
      { type: "say", id: "float", presentation: "floating", text: "浮动文字保留在场景上方。" },
      { type: "ending", id: "end", text: "Done" },
    ],
  },
};

function expectNoPersistedPresentation(active: unknown): void {
  expect(active && typeof active === "object" && Object.hasOwn(active, "presentation")).toBe(false);
}

test("say presentation is derived from location across save, load and rollback without changing the save shape", () => {
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", id: "legacy" });
  expect(engine.getSnapshot().active).not.toHaveProperty("presentation");

  engine.advance();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", id: "reader", presentation: "fullscreen" });
  const fullScreenSave = engine.save();
  expectNoPersistedPresentation(fullScreenSave.state.active);
  for (const checkpoint of fullScreenSave.state.rollbackHistory) expectNoPersistedPresentation(checkpoint.active);

  const restored = createNovelEngine(story);
  restored.load(fullScreenSave);
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "reader", presentation: "fullscreen" });
  expectNoPersistedPresentation(restored.save().state.active);

  restored.advance();
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "float", presentation: "floating" });
  restored.advance();
  expect(restored.getSnapshot().active).toMatchObject({ kind: "ending", id: "end" });
  restored.rollback();
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "float", presentation: "floating" });
  expectNoPersistedPresentation(restored.save().state.active);
});

test("say presentation validates the shared enum and explicit dialogue remains the legacy shape", () => {
  const explicitDefault: StoryDefinition = {
    id: story.id,
    version: story.version,
    start: "start",
    script: { start: [{ type: "say", id: "line", presentation: "dialogue", text: "Dialogue" }] },
  };
  const engine = createNovelEngine(explicitDefault, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start();
  expect(engine.getSnapshot().active).not.toHaveProperty("presentation");
  expect(engine.save().state.active).not.toHaveProperty("presentation");

  const invalid = structuredClone(explicitDefault) as any;
  invalid.script.start[0].presentation = "card";
  expect(() => createNovelEngine(invalid)).toThrow(StoryValidationError);
});
