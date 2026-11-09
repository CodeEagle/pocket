import { expect, test } from "bun:test";
import {
  isNovelCollectionEntryUnlocked,
  resolveNovelCollectionPortrait,
  validateNovelCollections,
  type NovelCollectionEntry,
  type NovelCollections,
} from "../src/index.ts";
import type { JsonValue } from "../src/types.ts";

const catalog: NovelCollections = {
  people: {
    title: "人物档案",
    entries: {
      mira: {
        title: "Mira",
        body: "Keeper of the harbor light.",
        portrait: { character: "mira", expression: "neutral" },
        unlockVariable: "codex.mira",
      },
      harbor: { title: "Harbor", body: "The town at the water's edge." },
    },
  },
};

const story = {
  variableDefinitions: {
    "codex.mira": { lifetime: "persistent", defaultValue: false },
  },
} as const;

const characters = {
  mira: { neutral: "art/mira-neutral.png" },
};

test("collection schema accepts bounded plain data and validates contextual references", () => {
  expect(validateNovelCollections(catalog)).toEqual([]);
  expect(validateNovelCollections(catalog, { story, characters })).toEqual([]);
});

test("collection schema rejects unknown fields, invalid IDs and overlong text with collection paths", () => {
  const invalid = {
    people: {
      title: "People",
      entries: {
        "bad id": { title: "Mira", body: "Bio", imagePath: "../outside.png" },
      },
      inventory: {},
    },
  };
  const issues = validateNovelCollections(invalid);
  expect(issues.map(issue => issue.code)).toContain("collections.fields");
  expect(issues.map(issue => issue.code)).toContain("collections.id");
  expect(issues.some(issue => issue.path.startsWith("collections."))).toBe(true);
  expect(issues.some(issue => issue.message.includes("imagePath"))).toBe(false);
  expect(validateNovelCollections({ people: { title: "People", entries: { item: { title: "x".repeat(513), body: "" } } } })
    .some(issue => issue.code === "collections.title")).toBe(true);
  expect(validateNovelCollections({ people: { title: "People", entries: { item: { title: "Item", body: "x".repeat(65_537) } } } })
    .some(issue => issue.code === "collections.body")).toBe(true);
});

test("collection and entry counts have explicit upper bounds", () => {
  const tooManyCollections = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
    `collection_${index}`,
    { title: "Collection", entries: {} },
  ]));
  expect(validateNovelCollections(tooManyCollections).some(issue => issue.code === "collections.limit")).toBe(true);

  const tooManyEntries = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [
    `entry_${index}`,
    { title: "Entry", body: "" },
  ]));
  expect(validateNovelCollections({ people: { title: "People", entries: tooManyEntries } })
    .some(issue => issue.code === "collections.limit")).toBe(true);
});

test("context requires declared persistent false unlocks and registered portrait keys", () => {
  const entry = catalog.people!.entries.mira!;
  expect(validateNovelCollections(catalog, {
    story: { variableDefinitions: { "codex.mira": { lifetime: "save", defaultValue: false } } },
    characters,
  }).map(issue => issue.code)).toContain("collections.unlockVariable.persistent");
  expect(validateNovelCollections(catalog, {
    story: { variableDefinitions: { "codex.mira": { lifetime: "persistent", defaultValue: true } } },
    characters,
  }).map(issue => issue.code)).toContain("collections.unlockVariable.persistent");
  expect(validateNovelCollections(catalog, {
    story: { variableDefinitions: {} },
    characters: {},
  }).map(issue => issue.code)).toContain("collections.unlockVariable.missing");
  expect(validateNovelCollections({ people: { title: "People", entries: { mira: entry } } }, {
    characters: { mira: { happy: "art/mira-happy.png" } },
  }).map(issue => issue.code)).toContain("collections.portrait.missing");
});

test("entry unlock projection is public without a gate and otherwise opens only on true", () => {
  const gated = catalog.people!.entries.mira!;
  const publicEntry = catalog.people!.entries.harbor!;
  expect(isNovelCollectionEntryUnlocked(publicEntry, {})).toBe(true);
  expect(isNovelCollectionEntryUnlocked(gated, {})).toBe(false);
  expect(isNovelCollectionEntryUnlocked(gated, { "codex.mira": false })).toBe(false);
  expect(isNovelCollectionEntryUnlocked(gated, { "codex.mira": 1 as JsonValue })).toBe(false);
  expect(isNovelCollectionEntryUnlocked(gated, { "codex.mira": true })).toBe(true);
});

test("portrait resolver reuses the registered image path and safely reports absent data", () => {
  const entry: NovelCollectionEntry = catalog.people!.entries.mira!;
  expect(resolveNovelCollectionPortrait(entry, characters)).toBe("art/mira-neutral.png");
  expect(resolveNovelCollectionPortrait(entry, {})).toBeUndefined();
  expect(resolveNovelCollectionPortrait({ title: "Inherited", body: "", portrait: { character: "constructor", expression: "name" } }, {})).toBeUndefined();
  expect(resolveNovelCollectionPortrait(catalog.people!.entries.harbor!, characters)).toBeUndefined();
  expect(resolveNovelCollectionPortrait(entry, { mira: { neutral: "" } })).toBeUndefined();
});
