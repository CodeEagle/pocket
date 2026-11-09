import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { localizeStory, parseStoryLocaleCatalog, rebaseNovelSaveDataForLocale } from "../src/localization.ts";
import type { StoryDefinition } from "../src/types.ts";

const sourceStory: StoryDefinition = {
  id: "rich-locale",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "letter", text: "A{{name}}B", rich: {
        spans: [{ id: "word", start: 1, end: 9, style: { color: "accent" }, ruby: "word", link: { title: "Source note", text: "Source body" } }],
        pauses: [{ id: "end-pause", at: 10, durationMs: null }],
      } },
      { type: "ending", id: "finish" },
    ],
  },
};

const zh = parseStoryLocaleCatalog({
  format: "pocket-vn-locale", formatVersion: 1, locale: "zh-Hans",
  lines: { letter: "港口灯塔" },
  sayRich: { letter: {
    spans: [{ id: "word", start: 1, end: 3, style: { color: "warning", emphasis: "strong" }, ruby: "灯塔", link: { title: "灯塔记录", text: "潮水退去后，灯还亮着。" } }],
    pauses: [{ id: "end-pause", at: 4, durationMs: null }],
  } },
});

test("localized rich ranges are selected only with their matching translated line", () => {
  const translated = localizeStory(sourceStory, { zh }, "zh-Hans");
  const activeInstruction = translated.story.script.start![0]!;
  expect(activeInstruction).toMatchObject({ type: "say", text: "港口灯塔", rich: zh.sayRich?.letter });

  const plainTranslation = localizeStory(sourceStory, {
    en: { format: "pocket-vn-locale", formatVersion: 1, locale: "en", lines: { letter: "The harbor light returns." } },
  }, "en");
  expect(plainTranslation.story.script.start![0]).toMatchObject({ type: "say", text: "The harbor light returns." });
  expect(plainTranslation.story.script.start![0]).not.toHaveProperty("rich");
  expect(plainTranslation.diagnostics).toContainEqual(expect.objectContaining({
    code: "missing-rich-annotations", path: "sayRich.letter", severity: "warning",
  }));

  const sourceFallback = localizeStory(sourceStory, {
    en: { format: "pocket-vn-locale", formatVersion: 1, locale: "en", lines: {} },
  }, "en");
  expect(sourceFallback.story.script.start![0]).toMatchObject({ type: "say", text: "A{{name}}B", rich: sourceStory.script.start![0]?.type === "say" ? sourceStory.script.start![0].rich : undefined });
});

test("locale parser validates ranges against its own line and locale save rebase preserves stable pause identity", () => {
  expect(() => parseStoryLocaleCatalog({
    format: "pocket-vn-locale", formatVersion: 1, locale: "en", lines: { letter: "short" },
    sayRich: { letter: { spans: [{ id: "bad", start: 1, end: 20 }], pauses: [] } },
  })).toThrow("catalog.sayRich.letter");

  const engine = createNovelEngine(sourceStory, { initialVariables: { name: "Q" }, preferences: {
    mode: "manual", textSpeedCharsPerSecond: 0, autoDelayMs: 0, skipSeenOnly: false,
  } });
  engine.start();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", text: "AQB", pause: { id: "end-pause", remainingMs: null } });
  const rebased = rebaseNovelSaveDataForLocale(engine.save(), sourceStory, localizeStory(sourceStory, { zh }, "zh-Hans").story);
  expect(rebased.state.active).toMatchObject({
    kind: "say", text: "港口灯塔", pauseCursor: 0, pause: { id: "end-pause", remainingMs: null },
    rich: zh.sayRich?.letter,
  });
  const localizedEngine = createNovelEngine(localizeStory(sourceStory, { zh }, "zh-Hans").story, { initialVariables: { name: "Q" } });
  localizedEngine.load(rebased);
  expect(localizedEngine.getSnapshot().active).toMatchObject({ kind: "say", visibleText: "港口灯塔", pauseCursor: 0, pause: { id: "end-pause", remainingMs: null } });
});
