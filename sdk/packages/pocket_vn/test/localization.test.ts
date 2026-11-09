import { expect, test } from "bun:test";
import { conditions, value } from "../src/engine.ts";
import {
  applyStoryAssetOverrides,
  diagnoseStoryLocale,
  localizeStory,
  NOVEL_UI_DEFAULT_MESSAGES,
  parseStoryLocaleCatalog,
  parseStoryLocaleCatalogCollection,
  serializeStoryLocaleCatalog,
  serializeStoryLocaleCatalogCollection,
  StoryLocaleCatalogError,
  type StoryAssetRegistry,
  type StoryLocaleCatalog,
} from "../src/localization.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "locale-fixture",
  version: 3,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", transition: { kind: "fade", durationMs: 12 } },
      { type: "set", variable: "found", value: false },
      { type: "say", id: "intro", speaker: "Mira", portrait: "worried", text: "Hello {{name}}." },
      {
        type: "choice",
        id: "route",
        prompt: "Where now?",
        options: [
          { id: "open", text: "Open the gate", target: "open", when: conditions.truthy(value.variable("found")) },
          { id: "wait", text: "Wait here", target: "safe" },
        ],
        timeLimitMs: 900,
        timeoutTarget: "safe",
      },
    ],
    open: [
      { type: "call", target: "memory" },
      { type: "branch", when: conditions.truthy(value.variable("found")), then: "best", else: "safe" },
    ],
    memory: [
      { type: "say", id: "memory_line", text: "By the harbor." },
      { type: "audio", cue: "bell", channel: "sfx" },
      { type: "inc", variable: "visits", amount: 1 },
      { type: "return" },
    ],
    best: [{ type: "ending", id: "best", text: "The letter arrives.", cg: "arrival" }],
    safe: [{ type: "ending", id: "safe", text: "Everyone is safe." }],
  },
};

const inputStory: StoryDefinition = {
  id: "locale-input-fixture",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "input", id: "captain_name", variable: "captain", inputType: "text", prompt: "Who will guide {{ship}}?", placeholder: "Enter {{ship}} captain" },
      { type: "ending", id: "input-end", text: "The journey begins." },
    ],
  },
};

const en: StoryLocaleCatalog = {
  format: "pocket-vn-locale",
  formatVersion: 1,
  locale: "en",
  lines: { intro: "Hello {{name}}.", memory_line: "By the harbor." },
  speakers: { Mira: "Mira" },
  choices: {
    route: { prompt: "Where now?", options: { open: "Open the gate", wait: "Wait here" } },
  },
  endings: { best: "The letter arrives.", safe: "Everyone is safe." },
};

test("locale catalogs stay JSON-only and round-trip with normalized tags", () => {
  const parsed = parseStoryLocaleCatalog(JSON.stringify({ ...en, locale: "en-US" }));
  expect(parsed.locale).toBe("en-US");
  expect(JSON.parse(serializeStoryLocaleCatalog(parsed))).toEqual(parsed);
  expect(() => parseStoryLocaleCatalog({ ...en, extra: "not part of the format" })).toThrow(StoryLocaleCatalogError);
  expect(() => parseStoryLocaleCatalog({ ...en, lines: { intro: () => "not JSON" } })).toThrow(/JSON data only/);
  expect(() => parseStoryLocaleCatalog({ ...en, assets: { cgs: { arrival: { asset: "alt", path: "/tmp/alt.png" } } } })).toThrow(/unknown fields/);
});

test("background layer cues keep stable IDs while localized image paths use the existing background registry", () => {
  const layered: StoryDefinition = {
    ...story,
    script: {
      ...story.script,
      start: [
        { type: "scene", background: "station", backgroundLayers: [{ background: "fog-plane", parallax: 0.25 }] },
        ...story.script.start.slice(1),
      ],
    },
  };
  const registry: StoryAssetRegistry = {
    backgrounds: {
      station: "art/station.png",
      station_en: "art/station-en.png",
      "fog-plane": "art/fog.png",
      "fog-plane-en": "art/fog-en.png",
    },
  };
  const localized = localizeStory(layered, {
    en: {
      ...en,
      locale: "en",
      assets: { backgrounds: { station: "station_en", "fog-plane": "fog-plane-en" } },
    },
  }, "en", { assetRegistry: registry });
  expect(localized.story.script.start[0]).toMatchObject({
    type: "scene",
    background: "station",
    backgroundLayers: [{ background: "fog-plane", parallax: 0.25 }],
  });
  expect(applyStoryAssetOverrides(registry, localized.assetOverrides).backgrounds).toMatchObject({
    station: "art/station-en.png",
    "fog-plane": "art/fog-en.png",
  });
});

test("canonical locale collections validate locale keys and the player UI uses the same fallback chain", () => {
  const collection = {
    format: "pocket-vn-locales",
    formatVersion: 1,
    catalogs: { en: { ...en, ui: { "player.menu": "Journal", "player.choiceTimer": "{{time}} seconds left" } } },
  } as const;
  const parsed = parseStoryLocaleCatalogCollection(JSON.stringify(collection));
  expect(parsed.catalogs.en?.locale).toBe("en");
  expect(JSON.parse(serializeStoryLocaleCatalogCollection(parsed))).toEqual(parsed);
  expect(() => parseStoryLocaleCatalogCollection({ ...collection, catalogs: { fr: en } })).toThrow(/must match its collection key/);
  expect(() => parseStoryLocaleCatalogCollection({ ...collection, catalogs: { en: en, EN: { ...en, locale: "EN" } } })).toThrow(/duplicates a catalog/);

  const localized = localizeStory(story, parsed.catalogs, "en");
  expect(localized.ui["player.menu"]).toBe("Journal");
  expect(localized.ui["settings.locale"]).toBe(NOVEL_UI_DEFAULT_MESSAGES["settings.locale"]);
  const diagnostics = diagnoseStoryLocale(story, parsed.catalogs.en!);
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "missing-ui", path: "ui.player.brand" }),
    expect.objectContaining({ code: "ui-placeholder-mismatch", path: "ui.player.choiceTimer" }),
  ]));
});

test("diagnostics identify missing, extra and placeholder-drifted stable keys", () => {
  const incomplete: StoryLocaleCatalog = {
    ...en,
    lines: { intro: "Hello traveler." },
    choices: { route: { prompt: "Where now?", options: { open: "Open the gate", extra: "Take a boat" } } },
    endings: { best: "The letter arrives.", extra_end: "An extra ending." },
  };
  const diagnostics = diagnoseStoryLocale(story, incomplete);
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "placeholder-mismatch", path: "lines.intro", severity: "error" }),
    expect.objectContaining({ code: "missing-line", path: "lines.memory_line" }),
  ]));
  expect(diagnostics.map((entry) => `${entry.code}:${entry.path}`)).toContain("missing-line:lines.memory_line");
  expect(diagnostics.map((entry) => entry.code)).toContain("missing-option");
  expect(diagnostics.map((entry) => entry.code)).toContain("extra-option");
  expect(diagnostics.map((entry) => entry.code)).toContain("missing-ending");
  expect(diagnostics.map((entry) => entry.code)).toContain("extra-ending");
});

test("localization changes display copy only and inherits the parent locale", () => {
  const us: StoryLocaleCatalog = {
    format: "pocket-vn-locale",
    formatVersion: 1,
    locale: "en-US",
    fallbackLocale: "en",
    lines: { intro: "Hello, {{name}}." },
    choices: { route: { options: { open: "Open the gate" } } },
  };
  const localized = localizeStory(story, { en, "en-US": us }, "en-US");
  expect(localized.fallbackChain).toEqual(["en-US", "en"]);
  expect(localized.story.id).toBe(story.id);
  expect(localized.story.version).toBe(story.version);
  expect(localized.story.start).toBe(story.start);
  expect(localized.story.script.open).toEqual(story.script.open);
  expect(localized.story.script.memory).toEqual(story.script.memory);
  expect(localized.story.script.start[2]).toEqual({
    type: "say", id: "intro", speaker: "Mira", portrait: "worried", text: "Hello, {{name}}.",
  });
  const sourceChoice = story.script.start[3];
  if (sourceChoice?.type !== "choice") throw new Error("Expected fixture choice");
  const translatedChoice = localized.story.script.start[3];
  if (translatedChoice?.type !== "choice") throw new Error("Expected localized choice");
  expect(translatedChoice).toMatchObject({
    type: "choice",
    id: "route",
    prompt: "Where now?",
    timeLimitMs: 900,
    timeoutTarget: "safe",
  });
  expect(translatedChoice.options).toEqual(sourceChoice.options.map((option) => ({
    ...option,
    text: en.choices?.route?.options?.[option.id] ?? option.text,
  })));
  expect(localized.story.script.best[0]).toMatchObject({ type: "ending", id: "best", text: "The letter arrives.", cg: "arrival" });
  expect(localized.diagnostics.some((entry) => entry.code === "missing-line" && entry.path === "lines.intro")).toBe(false);
});

test("replay titles round-trip by stable ID and remain attached to the localized story", () => {
  const replayStory: StoryDefinition = {
    ...story,
    replayEntries: [{
      id: "best_replay",
      title: "The source ending",
      location: { label: "best", index: 0 },
      unlockEndingId: "best",
    }],
  };
  const catalog: StoryLocaleCatalog = { ...en, replays: { best_replay: "The translated ending" } };
  const parsed = parseStoryLocaleCatalog(JSON.stringify(catalog));
  expect(parsed.replays).toEqual(catalog.replays);
  expect(JSON.parse(serializeStoryLocaleCatalog(parsed)).replays).toEqual(catalog.replays);

  const localized = localizeStory(replayStory, { en: parsed }, "en");
  expect(localized.story.replayEntries).toEqual([{
    ...replayStory.replayEntries![0],
    title: "The translated ending",
  }]);
  expect(localized.diagnostics.some(entry => entry.code === "missing-replay")).toBe(false);
  expect(diagnoseStoryLocale(replayStory, { ...catalog, replays: { orphan: "Unused" } })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "missing-replay", path: "replays.best_replay" }),
    expect.objectContaining({ code: "extra-replay", path: "replays.orphan" }),
  ]));
});

test("input prompt and placeholder translations round-trip and use stable instruction IDs", () => {
  const fr: StoryLocaleCatalog = {
    format: "pocket-vn-locale",
    formatVersion: 1,
    locale: "fr",
    inputs: {
      captain_name: {
        prompt: "Qui guidera {{ship}} ?",
        placeholder: "Nom du capitaine de {{ship}}",
      },
    },
  };
  const parsed = parseStoryLocaleCatalog(JSON.stringify(fr));
  expect(parsed.inputs?.captain_name).toEqual(fr.inputs?.captain_name);
  expect(JSON.parse(serializeStoryLocaleCatalog(parsed)).inputs.captain_name).toEqual(fr.inputs?.captain_name);

  const localized = localizeStory(inputStory, { fr: parsed }, "fr");
  expect(localized.story.script.start[0]).toEqual({
    type: "input",
    id: "captain_name",
    variable: "captain",
    inputType: "text",
    prompt: "Qui guidera {{ship}} ?",
    placeholder: "Nom du capitaine de {{ship}}",
  });
  expect(localized.diagnostics.some(entry => entry.code === "missing-input" && entry.path === "inputs.captain_name")).toBe(false);

  const english = localizeStory(inputStory, { en: { ...en, locale: "en", inputs: { captain_name: { prompt: "Who guides {{ship}}?" } } } }, "en");
  expect(english.ui["input.submit"]).toBe("Submit");
  expect(english.ui["input.error.min"]).toBe("The value must be at least {{limit}}.");
});

test("input locale diagnostics report absent fields, extras, and placeholder drift", () => {
  const incomplete: StoryLocaleCatalog = {
    format: "pocket-vn-locale",
    formatVersion: 1,
    locale: "fr",
    inputs: {
      captain_name: { prompt: "Qui guidera le navire ?" },
      unused: { prompt: "Unused" },
    },
  };
  const diagnostics = diagnoseStoryLocale(inputStory, incomplete);
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "input-placeholder-mismatch", path: "inputs.captain_name.prompt", severity: "error" }),
    expect.objectContaining({ code: "missing-input-placeholder", path: "inputs.captain_name.placeholder" }),
    expect.objectContaining({ code: "extra-input", path: "inputs.unused" }),
  ]));
});

test("locale asset keys resolve only through the existing registry", () => {
  const registry: StoryAssetRegistry = {
    backgrounds: { station: "img/station.png", station_en: "img/station-en.png" },
    characters: { mira: { worried: "img/mira-worried.png", worried_en: "img/mira-worried-en.png" } },
    cgs: { arrival: { image: "img/arrival.png", title: "Arrival" }, arrival_en: { image: "img/arrival-en.png", title: "Arrival EN" } },
    audio: { bell: "audio/bell.wav", bell_en: "audio/bell-en.wav" },
    videos: { harbor: "video/harbor.mp4", harbor_en: "video/harbor-en.mp4" },
  };
  const overrides = {
    backgrounds: { station: "station_en" },
    characters: { mira: { worried: "worried_en" } },
    cgs: { arrival: { asset: "arrival_en", title: "At the harbor" } },
    audio: { bell: "bell_en" },
    videos: { harbor: "harbor_en" },
  } as const;
  const translated = applyStoryAssetOverrides(registry, overrides);
  expect(translated.backgrounds?.station).toBe("img/station-en.png");
  expect(translated.characters?.mira?.worried).toBe("img/mira-worried-en.png");
  expect(translated.cgs?.arrival).toEqual({ image: "img/arrival-en.png", title: "At the harbor" });
  expect(translated.audio?.bell).toBe("audio/bell-en.wav");
  expect(translated.videos?.harbor).toBe("video/harbor-en.mp4");
  expect(() => applyStoryAssetOverrides(registry, { backgrounds: { station: "../private.png" } })).toThrow(/not registered/);

  const catalog: StoryLocaleCatalog = {
    format: "pocket-vn-locale", formatVersion: 1, locale: "fr",
    assets: { videos: { harbor: "harbor_en" } },
  };
  expect(parseStoryLocaleCatalog(serializeStoryLocaleCatalog(catalog))).toMatchObject({
    assets: { videos: { harbor: "harbor_en" } },
  });
});
