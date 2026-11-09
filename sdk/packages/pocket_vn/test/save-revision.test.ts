import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { decodeNovelSaveData, encodeNovelSaveData } from "../src/save-codec.ts";
import { migrateNovelSaveRevision, NovelSaveRevisionError, type NovelStoryRevisionMap } from "../src/save-revision.ts";
import type { NovelSaveData, StoryDefinition } from "../src/types.ts";

const oldStory: StoryDefinition = {
  id: "revision-map-fixture",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", characters: [] },
      { type: "audio", cue: "theme", channel: "music", loop: true },
      { type: "set", variable: "user_marker", value: { label: "intro", index: 0, nested: { label: "start", index: 4 } } },
      { type: "call", target: "intro" },
      { type: "say", id: "after-call", text: "The caller returns." },
      { type: "ending", id: "done", text: "The record is closed." },
    ],
    intro: [
      { type: "say", id: "intro-first", text: "First note." },
      { type: "input", id: "reader-note", variable: "reader_note", inputType: "text", prompt: "Leave a note", minLength: 1, maxLength: 32 },
      { type: "say", id: "intro-second", text: "The second note." },
      { type: "return" },
    ],
  },
};

const targetStory: StoryDefinition = {
  id: oldStory.id,
  version: 2,
  start: "start",
  script: {
    start: [
      { type: "say", id: "new-opening", text: "A newly added opening." },
      ...oldStory.script.start,
    ],
    intro: [
      { type: "say", id: "new-intro", text: "A newly added note." },
      oldStory.script.intro[0]!,
      oldStory.script.intro[1]!,
      { type: "say", id: "new-after-input", text: "This line was added after the active input." },
      oldStory.script.intro[2]!,
      oldStory.script.intro[3]!,
    ],
  },
};

const revisionMap: NovelStoryRevisionMap = {
  format: "pocket-vn-revision-map",
  formatVersion: 1,
  storyId: oldStory.id,
  fromVersion: 1,
  toVersion: 2,
  labelIndexes: {
    start: [1, 2, 3, 4, 5, 6, 7],
    intro: [1, 2, 4, 5, 6],
  },
};

function activeInputSave() {
  const engine = createNovelEngine(oldStory, { preferences: { textSpeedCharsPerSecond: 0 } });
  engine.start();
  expect(engine.getSnapshot().active?.kind).toBe("say");
  engine.advance();
  expect(engine.getSnapshot().active?.kind).toBe("input");
  engine.updateInput("draft in progress");
  return { engine, save: engine.save() };
}

/** Rebuild the previous compact V3 wire shape from the canonical save. */
function previousV3Save(expanded: NovelSaveData) {
  const compact = encodeNovelSaveData(expanded);
  const state = JSON.parse(JSON.stringify(compact.state)) as any;
  state.backlog = state.backlog.map((entry: any[]) => [
    ...entry.slice(0, 6),
    compact.state.textPool[entry[6]],
  ]);
  state.rollbackHistory.pools.active = state.rollbackHistory.pools.active.map((entry: any[]) => [
    ...entry.slice(0, 5),
    compact.state.textPool[entry[5]],
    entry[6],
    entry[7],
  ]);
  delete state.textPool;
  return { ...compact, formatVersion: 3 as const, state };
}

test("revision migration remaps only known addresses and validates mapped active, caller, backlog and rollback locations", () => {
  const { engine, save } = activeInputSave();
  try {
    expect(save.state.callStack).toEqual([{ returnTo: { label: "start", index: 4 } }]);
    expect(save.state.backlog[0]?.location).toEqual({ label: "intro", index: 0 });
    expect(save.state.rollbackHistory[0]?.active.location).toEqual({ label: "intro", index: 0 });
    const before = JSON.stringify(save);

    const migrated = migrateNovelSaveRevision(save, revisionMap, targetStory);
    expect(JSON.stringify(save)).toBe(before, "migration must not mutate the stored source save");
    expect(migrated.storyVersion).toBe(2);
    expect(migrated.state.active?.kind).toBe("input");
    expect(migrated.state.active?.location).toEqual({ label: "intro", index: 2 });
      expect(migrated.state.location).toEqual({ label: "intro", index: 3 },
        "the next position follows the mapped active input, preserving a newly inserted say before the old next instruction");
    expect(migrated.state.callStack).toEqual([{ returnTo: { label: "start", index: 5 } }]);
    expect(migrated.state.backlog[0]?.location).toEqual({ label: "intro", index: 1 });
    expect(migrated.state.rollbackHistory[0]?.location).toEqual({ label: "intro", index: 2 });
    expect(migrated.state.rollbackHistory[0]?.active.location).toEqual({ label: "intro", index: 1 });
    expect(migrated.state.active).toMatchObject({ draft: "draft in progress", prompt: "Leave a note", error: null });

    for (const key of ["variables", "stage", "meta", "audioIntents", "preferences", "eventSequence", "transitionSequence"] as const) {
      expect(migrated.state[key]).toEqual(save.state[key], `${key} must remain unchanged by address migration`);
    }
    expect(migrated.state.variables.user_marker).toEqual({
      label: "intro", index: 0, nested: { label: "start", index: 4 },
    }, "position-shaped values inside author variables are not rewritten");

    const restored = createNovelEngine(targetStory);
    try {
      restored.load(migrated);
      expect(restored.getSnapshot().active).toMatchObject({ kind: "input", location: { label: "intro", index: 2 }, draft: "draft in progress" });
      restored.submitInput();
      expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "new-after-input", location: { label: "intro", index: 3 } },
        "after input, the mapped runtime resumes at the newly inserted line instead of skipping to the former next instruction");
      restored.rollback();
      expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "intro-first", location: { label: "intro", index: 1 } });
    } finally { restored.dispose(); }
  } finally { engine.dispose(); }
});

test("revision migration keeps compact V3 saves readable without changing draft or clock fields", () => {
  const { engine, save } = activeInputSave();
  try {
    const compactV3 = previousV3Save(save);
    expect(compactV3.formatVersion).toBe(3);
    const migrated = migrateNovelSaveRevision(compactV3, revisionMap, targetStory);
    expect(migrated.formatVersion).toBe(1);
    expect(migrated.state.active).toMatchObject({ kind: "input", draft: "draft in progress" });
    expect(migrated.state.location).toEqual({ label: "intro", index: 3 });
    expect(decodeNovelSaveData(compactV3).state.active).toEqual(save.state.active);
    expect(migrated.state.active).toEqual(save.state.active && {
      ...save.state.active,
      location: { label: "intro", index: 2 },
    });
  } finally { engine.dispose(); }
});

test("revision migration accepts the current compact V4 shared-text pool", () => {
  const { engine, save } = activeInputSave();
  try {
    const compactV4 = encodeNovelSaveData(save);
    expect(compactV4.formatVersion).toBe(4);
    expect(compactV4.state.textPool.length).toBeGreaterThan(0);
    const migrated = migrateNovelSaveRevision(compactV4, revisionMap, targetStory);
    expect(migrated.formatVersion).toBe(1);
    expect(migrated.state.active).toMatchObject({ kind: "input", draft: "draft in progress", location: { label: "intro", index: 2 } });
    expect(migrated.state.location).toEqual({ label: "intro", index: 3 });
    expect(migrated.state.rollbackHistory).toHaveLength(save.state.rollbackHistory.length);
    expect(migrated.state.rollbackHistory[0]).toMatchObject({
      location: { label: "intro", index: 2 },
      active: { location: { label: "intro", index: 1 }, text: "First note." },
      callStack: [{ returnTo: { label: "start", index: 5 } }],
    });
    expect(decodeNovelSaveData(compactV4)).toEqual(save);
  } finally { engine.dispose(); }
});

test("explicit reordered addresses repair dialogue after a return without skipping it on resume", () => {
  const legacy: StoryDefinition = {
    ...oldStory,
    script: { ...oldStory.script, intro: [
      oldStory.script.intro[0]!, oldStory.script.intro[1]!,
      oldStory.script.intro[3]!, oldStory.script.intro[2]!,
    ] },
  };
  const repaired: StoryDefinition = { ...oldStory, version: 2 };
  const map: NovelStoryRevisionMap = {
    ...revisionMap,
    labelIndexes: { start: [0, 1, 2, 3, 4, 5, 6], intro: [0, 1, 3, 2, 4] },
  };
  const original = createNovelEngine(legacy, { preferences: { textSpeedCharsPerSecond: 0 } });
  const restored = createNovelEngine(repaired, { preferences: { textSpeedCharsPerSecond: 0 } });
  try {
    original.start(); original.advance(); original.updateInput("old draft");
    const save = original.save();
    const before = JSON.stringify(save);
    const migrated = migrateNovelSaveRevision(encodeNovelSaveData(save), map, repaired);
    expect(JSON.stringify(save)).toBe(before);
    expect(migrated.state.active).toMatchObject({ kind: "input", draft: "old draft", location: { label: "intro", index: 1 } });
    expect(migrated.state.location).toEqual({ label: "intro", index: 2 });
    restored.load(migrated);
    restored.submitInput();
    expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "intro-second" });
    restored.advance();
    expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "after-call" });
    restored.rollback();
    expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "intro-second" });
    expect(() => migrateNovelSaveRevision(save, {
      ...map, labelIndexes: { ...map.labelIndexes, intro: [0, 1, 3, 3, 4] },
    }, repaired)).toThrow(NovelSaveRevisionError);
  } finally { original.dispose(); restored.dispose(); }
});

test("end-of-label addresses use explicit sentinels and unsupported maps fail without touching user data", () => {
  const valid = migrateNovelSaveRevision({
    format: "pocket-vn-save",
    formatVersion: 1,
    storyId: oldStory.id,
    storyVersion: 1,
    state: {
      started: true,
      location: { label: "start", index: oldStory.script.start.length },
      variables: {}, stage: { background: null, characters: {}, transition: null, video: null, camera: { x: 0, y: 0, scale: 1, motion: null } },
      active: null, callStack: [], backlog: [], nextBacklogSequence: 1, rollbackHistory: [], meta: { readLineIds: [], endingIds: [], cgIds: [] },
      audioIntents: {}, preferences: { mode: "manual", skipSeenOnly: true, textSpeedCharsPerSecond: 32, autoDelayMs: 2500 },
      paused: false, eventSequence: 0, transitionSequence: 0,
    },
  }, revisionMap, targetStory);
  expect(valid.state.location).toEqual({ label: "start", index: targetStory.script.start.length });

  const { engine, save } = activeInputSave();
  try {
    const before = JSON.stringify(save);
    expect(() => migrateNovelSaveRevision(save, { ...revisionMap, fromVersion: 3 }, targetStory)).toThrow(NovelSaveRevisionError);
    expect(() => migrateNovelSaveRevision(save, { ...revisionMap, labelIndexes: { ...revisionMap.labelIndexes, intro: [1, 5, 3, 4, 5] } }, targetStory)).toThrow(NovelSaveRevisionError);
    expect(() => migrateNovelSaveRevision(save, revisionMap, { ...targetStory, version: 3 })).toThrow(NovelSaveRevisionError);
    expect(JSON.stringify(save)).toBe(before, "unsupported or corrupt maps leave the input untouched");
  } finally { engine.dispose(); }
});
