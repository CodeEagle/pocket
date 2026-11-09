import { expect, test } from "bun:test";
import { diagnoseStoryLocale, localizeStory, novelCollectionTextKey, novelSourceUiMessages } from "../src/localization.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = { id: "records", version: 1, start: "start", script: { start: [{ type: "say", id: "hello", text: "你好" }] } };
const assets = { collections: {
  people: { title: "人物", entries: { mira: { title: "Mira", body: "你好，{{name}}。" } } },
} };
const bodyKey = novelCollectionTextKey("people", "mira", "body");

test("authored collection text follows the existing locale UI catalog and source fallback", () => {
  const translated = localizeStory(story, { en: { format: "pocket-vn-locale", formatVersion: 1, locale: "en", ui: { [bodyKey]: "Hello, {{name}}." } } }, "en", { assetRegistry: assets });
  expect(translated.ui[bodyKey]).toBe("Hello, {{name}}.");
  expect(translated.ui[novelCollectionTextKey("people", null)]).toBe("人物");
  expect(translated.diagnostics.some(issue => issue.code === "extra-ui" && issue.path === `ui.${bodyKey}`)).toBe(false);
  const source = localizeStory(story, {}, "zh", { assetRegistry: assets });
  expect(source.ui[bodyKey]).toBe("你好，{{name}}。");
});

test("collection translations retain placeholder diagnostics", () => {
  const issues = diagnoseStoryLocale(story, { format: "pocket-vn-locale", formatVersion: 1, locale: "en", ui: { [bodyKey]: "Hello." } }, { assetRegistry: assets });
  expect(issues.some(issue => issue.code === "ui-placeholder-mismatch" && issue.path === `ui.${bodyKey}`)).toBe(true);
});

test("dotted stable IDs do not collide in the translation catalog", () => {
  const registry = { collections: {
    "a.b": { title: "First", entries: { c: { title: "One", body: "first body" } } },
    a: { title: "Second", entries: { "b.c": { title: "Two", body: "second body" } } },
  } };
  const first = novelCollectionTextKey("a.b", "c", "body");
  const second = novelCollectionTextKey("a", "b.c", "body");
  expect(first).not.toBe(second);
  const source = novelSourceUiMessages(registry);
  expect(source[first]).toBe("first body");
  expect(source[second]).toBe("second body");
});
