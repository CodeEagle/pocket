import { expect, test } from "bun:test";
import { diagnoseStoryLocale, localizeStory, novelSceneObjectTextKey, novelSourceUiMessages } from "../src/localization.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "object-locale", version: 1, start: "start",
  script: { start: [
    { type: "scene", objects: [{ id: "letter.seal", image: "letter", frame: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 }, interaction: {
      label: "检查封印", effects: [{ type: "set", variable: "found", value: true }],
    } }] },
    { type: "say", id: "inspect", text: "请检查桌面。" },
  ] },
};

test("scene object labels use the existing locale UI catalog without changing effects or saved scene identity", () => {
  const original = JSON.stringify(story);
  const key = novelSceneObjectTextKey("letter.seal");
  expect(novelSourceUiMessages(undefined, story)[key]).toBe("检查封印");
  const localized = localizeStory(story, { en: { format: "pocket-vn-locale", formatVersion: 1, locale: "en", ui: { [key]: "Inspect seal" } } }, "en");
  expect(localized.ui[key]).toBe("Inspect seal");
  expect(localized.story.script.start![0]).toEqual(story.script.start![0]);
  expect(JSON.stringify(story)).toBe(original);
  const fallback = localizeStory(story, { en: { format: "pocket-vn-locale", formatVersion: 1, locale: "en" } }, "en");
  expect(fallback.ui[key]).toBe("检查封印");
});

test("object labels participate in missing/extra UI translation diagnostics", () => {
  const key = novelSceneObjectTextKey("letter.seal");
  const issues = diagnoseStoryLocale(story, { format: "pocket-vn-locale", formatVersion: 1, locale: "en", ui: { "sceneObject.ghost.label": "Ghost" } });
  expect(issues.some(issue => issue.code === "missing-ui" && issue.path === `ui.${key}`)).toBe(true);
  expect(issues.some(issue => issue.code === "extra-ui" && issue.path === "ui.sceneObject.ghost.label")).toBe(true);
});
