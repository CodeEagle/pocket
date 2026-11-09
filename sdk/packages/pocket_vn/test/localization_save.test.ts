import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { encodeNovelSaveData } from "../src/save-codec.ts";
import {
  localizeStory,
  rebaseNovelSaveDataForLocale,
  type StoryLocaleCatalog,
} from "../src/localization.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = {
  id: "locale-save-rebase",
  version: 4,
  start: "start",
  script: {
    start: [
      { type: "say", id: "opening", speaker: "Mira", text: "Count {{count}}." },
      { type: "set", variable: "count", value: 9 },
      { type: "say", id: "arrival", speaker: "Mira", text: "The harbor is quiet." },
      {
        type: "choice",
        id: "route",
        prompt: "Choose for {{count}}.",
        options: [
          { id: "go", text: "Go with {{count}} clues", target: "end" },
          { id: "stay", text: "Stay", target: "end" },
        ],
        timeLimitMs: 1200,
        timeoutTarget: "end",
      },
    ],
    end: [{ type: "ending", id: "finish", text: "The letter has {{count}} marks." }],
  },
};

const fr: StoryLocaleCatalog = {
  format: "pocket-vn-locale",
  formatVersion: 1,
  locale: "fr",
  lines: {
    opening: "Nombre {{count}}.",
    arrival: "Le port garde le silence, sous les lanternes du soir.",
  },
  speakers: { Mira: "Mira en français" },
  choices: {
    route: { prompt: "Choisir pour {{count}}.", options: { go: "Partir avec {{count}} indices", stay: "Rester" } },
  },
  endings: { finish: "La lettre porte {{count}} marques." },
};

test("locale save rebase preserves partial reveal ratio and loads into the same engine with translated speaker", () => {
  const engine = createNovelEngine(story, {
    initialVariables: { count: 3 },
    preferences: { mode: "auto", textSpeedCharsPerSecond: 2, autoDelayMs: 700 },
    initialMeta: { readLineIds: ["older"], endingIds: ["old-ending"], cgIds: ["old-cg"] },
  });
  engine.start();
  engine.tick(750);
  engine.pause();
  const save = engine.save();
  const active = save.state.active;
  if (active?.kind !== "say") throw new Error("expected partial opening dialogue");
  const oldFraction = active.revealProgress / Array.from(active.text).length;

  const localized = localizeStory(story, { fr }, "fr");
  const rebased = rebaseNovelSaveDataForLocale(save, story, localized.story);
  const nextActive = rebased.state.active;
  if (nextActive?.kind !== "say") throw new Error("expected rebased opening dialogue");
  expect(nextActive.text).toBe("Nombre 3.");
  expect(nextActive.speaker).toBe("Mira en français");
  expect(nextActive.revealProgress / Array.from(nextActive.text).length).toBeCloseTo(oldFraction);
  expect(nextActive.complete).toBe(false);
  expect(rebased.state.variables).toEqual(save.state.variables);
  expect(rebased.state.location).toEqual(save.state.location);
  expect(rebased.state.meta).toEqual(save.state.meta);
  expect(rebased.state.paused).toBe(true);
  expect(rebased.state.preferences).toEqual(save.state.preferences);

  const localizedEngine = createNovelEngine(localized.story);
  localizedEngine.load(rebased);
  expect(localizedEngine.getSnapshot().active).toMatchObject({ kind: "say", id: "opening", text: "Nombre 3.", speaker: "Mira en français", complete: false });
  expect(localizedEngine.getSnapshot().paused).toBe(true);
});

test("locale save rebase retains the input draft and restores translated prompt and placeholder by active ID", () => {
  const inputStory: StoryDefinition = {
    id: "locale-input-save",
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "input", id: "captain_name", variable: "captain", inputType: "text", prompt: "Who will guide {{ship}}?", placeholder: "Enter {{ship}} captain" },
        { type: "say", id: "after-input", text: "The ship leaves." },
      ],
    },
  };
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
  const engine = createNovelEngine(inputStory, { initialVariables: { ship: "Aube" } });
  engine.start();
  engine.updateInput("Mira");
  const saved = engine.save();
  const localized = localizeStory(inputStory, { fr }, "fr");
  const rebased = rebaseNovelSaveDataForLocale(saved, inputStory, localized.story);
  expect(rebased.state.active).toMatchObject({
    kind: "input",
    id: "captain_name",
    variable: "captain",
    draft: "Mira",
    prompt: "Qui guidera Aube ?",
    placeholder: "Nom du capitaine de Aube",
  });

  const restored = createNovelEngine(localized.story);
  restored.load(rebased);
  expect(restored.getSnapshot().active).toMatchObject({
    kind: "input",
    id: "captain_name",
    draft: "Mira",
    prompt: "Qui guidera Aube ?",
    placeholder: "Nom du capitaine de Aube",
  });
  restored.submitInput();
  expect(restored.getSnapshot().variables.captain).toBe("Mira");
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "after-input" });
  engine.dispose();
  restored.dispose();
});

test("locale rebase decodes compact saves and translates backlog, rollback, timed choices and endings", () => {
  const engine = createNovelEngine(story, {
    initialVariables: { count: 3 },
    preferences: { textSpeedCharsPerSecond: 0 },
  });
  engine.start();
  engine.advance(); // Complete opening and execute the set before the next dialogue.
  engine.advance(); // Complete arrival and stop at the timed route choice.
  engine.tick(300);
  expect(engine.getSnapshot().variables.count).toBe(9);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", timeRemainingMs: 900 });

  const save = engine.save();
  expect(save.state.backlog[0]?.text).toBe("Count 3.");
  expect(save.state.rollbackHistory[0]?.variables.count).toBe(3);
  const localized = localizeStory(story, { fr }, "fr");
  const compact = encodeNovelSaveData(save);
  const rebased = rebaseNovelSaveDataForLocale(compact, story, localized.story);
  expect(rebased.state.backlog[0]).toMatchObject({ lineId: "opening", speaker: "Mira en français", text: "Nombre 3." });
  expect(rebased.state.active).toMatchObject({
    kind: "choice",
    id: "route",
    prompt: "Choisir pour 9.",
    options: [
      { id: "go", text: "Partir avec 9 indices", target: "end" },
      { id: "stay", text: "Rester", target: "end" },
    ],
    timeRemainingMs: 900,
  });

  const localizedEngine = createNovelEngine(localized.story);
  localizedEngine.load(rebased);
  localizedEngine.rollback(2);
  expect(localizedEngine.getSnapshot().active).toMatchObject({ kind: "say", id: "opening", text: "Nombre 3.", speaker: "Mira en français", complete: true });
  expect(localizedEngine.getSnapshot().variables.count).toBe(3);
  expect(localizedEngine.getSnapshot().meta.readLineIds).toContain("opening");

  const endEngine = createNovelEngine(localized.story);
  endEngine.load(rebased);
  endEngine.selectChoice("go");
  const endingSave = endEngine.save();
  if (endingSave.state.active?.kind !== "ending") throw new Error("expected ending after choice");
  expect(endingSave.state.active.text).toBe("La lettre porte 9 marques.");
  const nextCatalog: StoryLocaleCatalog = {
    ...fr,
    locale: "de",
    lines: { opening: "Zahl {{count}}.", arrival: "Der Hafen ist still." },
    speakers: { Mira: "Mira auf Deutsch" },
    choices: { route: { prompt: "Wähle für {{count}}.", options: { go: "Mit {{count}} Hinweisen gehen", stay: "Bleiben" } } },
    endings: { finish: "Der Brief trägt {{count}} Spuren." },
  };
  const german = localizeStory(story, { de: nextCatalog }, "de");
  const endingRebased = rebaseNovelSaveDataForLocale(endingSave, localized.story, german.story);
  const germanEngine = createNovelEngine(german.story);
  germanEngine.load(endingRebased);
  expect(germanEngine.getSnapshot().active).toMatchObject({ kind: "ending", id: "finish", text: "Der Brief trägt 9 Spuren." });
});
