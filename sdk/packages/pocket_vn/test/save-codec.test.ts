import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import { conditions, createNovelEngine, SaveDataError, value } from "../src/engine.ts";
import {
  decodeNovelSaveData,
  encodeNovelSaveData,
  NovelSaveCodecError,
} from "../src/save-codec.ts";
import type { NovelSaveData, StoryDefinition } from "../src/types.ts";

const rollbackStory: StoryDefinition = {
  id: "save-codec-rollback",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", position: "left" }] },
      { type: "audio", cue: "theme", channel: "music", loop: true },
      { type: "set", variable: "index", value: 0 },
      { type: "jump", target: "loop" },
    ],
    loop: [
      { type: "say", id: "repeat", text: "A repeated line." },
      { type: "inc", variable: "index", amount: 1 },
      { type: "branch", when: conditions.lt(value.variable("index"), value.literal(10)), then: "loop", else: "tail" },
    ],
    tail: [
      ...Array.from({ length: 39 }, (_, index) => ({
        type: "say" as const,
        id: `tail-${index}`,
        text: `The ${index}th note remains in the station archive.`,
      })),
      { type: "ending", id: "complete", text: "The letter is sealed." },
    ],
  },
};

function finishedEngine() {
  const engine = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  engine.start();
  for (let step = 0; step < 1000; step += 1) {
    const active = engine.getSnapshot().active;
    if (active?.kind === "ending") return engine;
    if (active?.kind !== "say") throw new Error(`Unexpected active state ${active?.kind ?? "none"}`);
    if (!active.complete) engine.advance();
    engine.advance();
  }
  throw new Error("The fixture did not reach its ending.");
}

function previousV2Save(expanded: NovelSaveData) {
  const compact = previousV3Save(expanded);
  const active = compact.state.rollbackHistory.pools.active.map((entry: any) => ({
    kind: "say" as const,
    location: { label: entry[0], index: entry[1] },
    id: entry[2],
    speaker: entry[3],
    portrait: entry[4],
    text: entry[5],
    revealProgress: entry[6],
    visibleText: entry[5],
    revealedCharacters: Array.from(entry[5]).length,
    complete: true,
    autoRemainingMs: entry[7],
  }));
  const history = compact.state.rollbackHistory;
  return {
    ...compact,
    formatVersion: 2 as const,
    state: {
      ...compact.state,
      backlog: expanded.state.backlog,
      rollbackHistory: {
        ...history,
        pools: { ...history.pools, active },
      },
    },
  };
}

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
  return {
    ...compact,
    formatVersion: 3 as const,
    state,
  };
}

function firstV3ActiveObjectSave(expanded: NovelSaveData) {
  const compact = previousV3Save(expanded);
  const history = compact.state.rollbackHistory;
  const active = history.pools.active.map((entry: any[]) => ({
    kind: "say" as const,
    location: { label: entry[0], index: entry[1] },
    id: entry[2],
    speaker: entry[3],
    portrait: entry[4],
    text: entry[5],
    revealProgress: entry[6],
    visibleText: entry[5],
    revealedCharacters: Array.from(entry[5]).length,
    complete: true,
    autoRemainingMs: entry[7],
  }));
  return {
    ...compact,
    state: {
      ...compact.state,
      rollbackHistory: { ...history, pools: { ...history.pools, active } },
    },
  };
}

test("v4 save codec shares rendered text across backlog and rollback without changing engine.save", () => {
  const source = finishedEngine();
  try {
    const expanded = source.save();
    const compact = encodeNovelSaveData(expanded);
    const history = compact.state.rollbackHistory;

    expect(expanded.state.backlog).toHaveLength(49);
    expect(expanded.state.rollbackHistory).toHaveLength(48);
    expect(compact.formatVersion).toBe(4);
    expect(compact.state.backlog).toHaveLength(49);
    expect(compact.state.backlog.every(entry => entry.length === 7)).toBe(true);
    expect(compact.state.backlog[0]).toEqual([1, "repeat", "loop", 0, null, null, expect.any(Number)]);
    expect(compact.state.textPool[compact.state.backlog[0]![6]]).toBe("A repeated line.");
    expect(new Set(compact.state.textPool).size).toBe(compact.state.textPool.length, "the shared text pool interns exact rendered strings once");
    expect(Array.isArray(history.entries)).toBe(true);
    expect(history.entries).toHaveLength(48);
    expect(history.pools.variables).toHaveLength(10);
    expect(history.pools.stages).toHaveLength(1);
    expect(history.pools.audioIntents).toHaveLength(1);
    expect(history.pools.active.length).toBeLessThan(history.entries.length);
    expect(history.pools.active.every(entry => entry.length === 8)).toBe(true);
    expect(history.pools.active.every(entry => Number.isSafeInteger(entry[5]))).toBe(true);

    // Engine state remains ordinary V1; V4 compacts only backlog and rollback-history text.
    expect(compact.state.active).toEqual(expanded.state.active);
    expect(compact.state.meta).toEqual(expanded.state.meta);
    expect(compact.state.variables).toEqual(expanded.state.variables);
    expect(compact.state.stage).toEqual(expanded.state.stage);
    expect(decodeNovelSaveData(compact)).toEqual(expanded);
    expect(encodeNovelSaveData(expanded)).toEqual(compact);
    const priorV2 = previousV2Save(expanded);
    const priorV3 = previousV3Save(expanded);
    expect(decodeNovelSaveData(priorV2)).toEqual(expanded);
    expect(decodeNovelSaveData(priorV3)).toEqual(expanded);
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(Buffer.byteLength(JSON.stringify(priorV3), "utf8"));
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(Buffer.byteLength(JSON.stringify(priorV2), "utf8"));
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(65_536);
  } finally {
    source.dispose();
  }
});

test("v4 save codec preserves authored groups in current and rollback intents and rejects damaged groups", () => {
  const story: StoryDefinition = {
    id: "save-codec-audio-group", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "theme", channel: "harbor-bed", loop: true, group: "music" }],
      audioGains: [{ channel: "harbor-bed", keyframes: [
        { atMs: 0, value: 1 }, { atMs: 100, value: 0.2 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const source = createNovelEngine(story);
  try {
    source.start();
    source.advance();
    const expanded = source.save();
    expect(expanded.state.audioIntents["harbor-bed"]).toMatchObject({ group: "music" });
    expect(expanded.state.rollbackHistory[0]?.audioIntents["harbor-bed"]).toMatchObject({ group: "music" });

    const compact = encodeNovelSaveData(expanded);
    expect(compact.formatVersion).toBe(4);
    expect(compact.state.audioIntents["harbor-bed"]).toMatchObject({ group: "music" });
    expect(compact.state.rollbackHistory.pools.audioIntents).toContainEqual({
      "harbor-bed": { action: "play", cue: "theme", loop: true, group: "music" },
    });
    expect(decodeNovelSaveData(compact)).toEqual(expanded);

    const damagedCurrent = JSON.parse(JSON.stringify(compact));
    damagedCurrent.state.audioIntents["harbor-bed"].group = "voice";
    expect(() => decodeNovelSaveData(damagedCurrent)).toThrow(NovelSaveCodecError);
    const damagedPool = JSON.parse(JSON.stringify(compact));
    damagedPool.state.rollbackHistory.pools.audioIntents[0]["harbor-bed"].group = "voice";
    expect(() => decodeNovelSaveData(damagedPool)).toThrow(NovelSaveCodecError);

    const damagedExpanded = JSON.parse(JSON.stringify(expanded));
    damagedExpanded.state.rollbackHistory[0].audioIntents["harbor-bed"].group = "voice";
    expect(() => encodeNovelSaveData(damagedExpanded)).toThrow(NovelSaveCodecError);
  } finally {
    source.dispose();
  }
});

test("engine loads legacy v1/v2/v3 and compact v4 history; every rollback matches", () => {
  const source = finishedEngine();
  const legacy = JSON.parse(JSON.stringify(source.save()));
  const compact = encodeNovelSaveData(source.save());
  const previousV2 = previousV2Save(source.save());
  const previousV3Tuples = previousV3Save(source.save());
  const previousV3 = firstV3ActiveObjectSave(source.save());
  const fromLegacy = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  const fromV2 = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  const fromV3Tuples = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  const fromPreviousV3 = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  const fromCompact = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  try {
    fromLegacy.load(legacy);
    fromV2.load(previousV2);
    fromV3Tuples.load(previousV3Tuples);
    fromPreviousV3.load(previousV3);
    fromCompact.load(compact);
    expect(fromV3Tuples.save()).toEqual(legacy, "the deployed V3 tuple pools must remain readable");
    expect(fromPreviousV3.save()).toEqual(legacy, "the early V3 object active pool must remain readable");
    for (let index = 0; index < 48; index += 1) {
      const legacyUpdate = fromLegacy.rollback();
      const v2Update = fromV2.rollback();
      const v3TupleUpdate = fromV3Tuples.rollback();
      const previousV3Update = fromPreviousV3.rollback();
      const compactUpdate = fromCompact.rollback();
      expect(v2Update.snapshot.active).toEqual(legacyUpdate.snapshot.active);
      expect(v3TupleUpdate.snapshot.active).toEqual(legacyUpdate.snapshot.active);
      expect(previousV3Update.snapshot.active).toEqual(legacyUpdate.snapshot.active);
      expect(compactUpdate.snapshot).toMatchObject({
        phase: legacyUpdate.snapshot.phase,
        active: legacyUpdate.snapshot.active,
        location: legacyUpdate.snapshot.location,
        variables: legacyUpdate.snapshot.variables,
        stage: legacyUpdate.snapshot.stage,
        backlog: legacyUpdate.snapshot.backlog,
        rollbackAvailable: legacyUpdate.snapshot.rollbackAvailable,
      });
    }
    expect(fromCompact.getSnapshot().rollbackAvailable).toBe(0);
    expect(fromCompact.getSnapshot().variables.index).toBe(1);
  } finally {
    source.dispose();
    fromLegacy.dispose();
    fromV2.dispose();
    fromV3Tuples.dispose();
    fromPreviousV3.dispose();
    fromCompact.dispose();
  }
});

test("v1 decode keeps its original format and v4 rejects malformed tuples and text references atomically", () => {
  const source = finishedEngine();
  const loaded = createNovelEngine(rollbackStory, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  try {
    const legacy = JSON.parse(JSON.stringify(source.save()));
    expect(decodeNovelSaveData(legacy)).toEqual(legacy);
    expect(decodeNovelSaveData(legacy).formatVersion).toBe(1);
    loaded.load(legacy);
    const before = loaded.save();
    const compact = encodeNovelSaveData(source.save());

    const invalidBacklogTuple = JSON.parse(JSON.stringify(compact)) as any;
    invalidBacklogTuple.state.backlog[0].push("extra");
    expect(() => decodeNovelSaveData(invalidBacklogTuple)).toThrow(NovelSaveCodecError);
    assert.throws(() => loaded.load(invalidBacklogTuple), SaveDataError);
    expect(loaded.save()).toEqual(before);

    const invalidBacklogTextReference = JSON.parse(JSON.stringify(compact)) as any;
    invalidBacklogTextReference.state.backlog[0][6] = 99_999;
    expect(() => decodeNovelSaveData(invalidBacklogTextReference)).toThrow(NovelSaveCodecError);

    const invalidActiveTextReference = JSON.parse(JSON.stringify(compact)) as any;
    invalidActiveTextReference.state.rollbackHistory.pools.active[0][5] = 99_999;
    expect(() => decodeNovelSaveData(invalidActiveTextReference)).toThrow(NovelSaveCodecError);

    const duplicateTextValue = JSON.parse(JSON.stringify(compact)) as any;
    duplicateTextValue.state.textPool.push(duplicateTextValue.state.textPool[0]);
    expect(() => decodeNovelSaveData(duplicateTextValue)).toThrow(NovelSaveCodecError);

    const unreferencedTextValue = JSON.parse(JSON.stringify(compact)) as any;
    unreferencedTextValue.state.textPool.push("unreferenced historical text");
    expect(() => decodeNovelSaveData(unreferencedTextValue)).toThrow(NovelSaveCodecError);

    const invalidReference = JSON.parse(JSON.stringify(compact)) as any;
    invalidReference.state.rollbackHistory.entries[0][5] = 900;
    expect(() => decodeNovelSaveData(invalidReference)).toThrow(NovelSaveCodecError);
    assert.throws(() => loaded.load(invalidReference), SaveDataError);
    expect(loaded.save()).toEqual(before);

    const invalidShape = JSON.parse(JSON.stringify(compact)) as any;
    invalidShape.state.rollbackHistory.entries[0].push(true);
    expect(() => decodeNovelSaveData(invalidShape)).toThrow(NovelSaveCodecError);
    expect(loaded.save()).toEqual(before);

    const invalidActiveTuple = JSON.parse(JSON.stringify(compact)) as any;
    invalidActiveTuple.state.rollbackHistory.pools.active[0].splice(6, 1);
    expect(() => decodeNovelSaveData(invalidActiveTuple)).toThrow(NovelSaveCodecError);
    assert.throws(() => loaded.load(invalidActiveTuple), SaveDataError);
    expect(loaded.save()).toEqual(before);

    const inconsistentActiveTuple = JSON.parse(JSON.stringify(compact)) as any;
    inconsistentActiveTuple.state.rollbackHistory.pools.active[0][6] += 1;
    expect(() => decodeNovelSaveData(inconsistentActiveTuple)).toThrow(NovelSaveCodecError);
    assert.throws(() => loaded.load(inconsistentActiveTuple), SaveDataError);
    expect(loaded.save()).toEqual(before);

    const mixedActivePool = JSON.parse(JSON.stringify(compact)) as any;
    const oldObjectEntry = firstV3ActiveObjectSave(source.save()).state.rollbackHistory.pools.active[0];
    mixedActivePool.state.rollbackHistory.pools.active[0] = oldObjectEntry;
    expect(() => decodeNovelSaveData(mixedActivePool)).toThrow(NovelSaveCodecError);
    assert.throws(() => loaded.load(mixedActivePool), SaveDataError);
    expect(loaded.save()).toEqual(before);

    const invalidFiniteValue = JSON.parse(JSON.stringify(compact)) as any;
    invalidFiniteValue.state.rollbackHistory.pools.stages[0].injected = Infinity;
    expect(() => decodeNovelSaveData(invalidFiniteValue)).toThrow(NovelSaveCodecError);
    expect(loaded.save()).toEqual(before);

    const extraBacklogMetadata = structuredClone(source.save()) as any;
    extraBacklogMetadata.state.backlog[0].futureMetadata = "must not be silently discarded";
    expect(() => encodeNovelSaveData(extraBacklogMetadata)).toThrow(NovelSaveCodecError);
  } finally {
    source.dispose();
    loaded.dispose();
  }
});

test("codec preserves prototype-named JSON keys as data", () => {
  const prototypeNamedValue = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"kept":true}}');
  const story: StoryDefinition = {
    id: "save-codec-prototype-keys",
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "set", variable: "payload", value: prototypeNamedValue },
        { type: "say", id: "line", text: "Keep these JSON keys." },
        { type: "ending", id: "end" },
      ],
    },
  };
  const source = createNovelEngine(story);
  const restored = createNovelEngine(story);
  try {
    source.start();
    source.advance();
    source.advance();
    const compact = encodeNovelSaveData(source.save());
    restored.load(compact);
    const payload = restored.getSnapshot().variables.payload as Record<string, unknown>;
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(payload.__proto__).toEqual({ polluted: true });
    expect(payload.constructor).toEqual({ kept: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  } finally {
    source.dispose();
    restored.dispose();
  }
});

test("codec round-trips deep valid JSON and rejects noncanonical array properties", () => {
  const deepValue: Record<string, any> = {};
  let cursor = deepValue;
  for (let index = 0; index < 140; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  cursor.done = true;
  const story: StoryDefinition = {
    id: "save-codec-deep-json",
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "say", id: "first", text: "The first line." },
        { type: "say", id: "second", text: "The second line." },
        { type: "ending", id: "finish" },
      ],
    },
  };
  const source = createNovelEngine(story, { initialVariables: { deepValue } });
  const restored = createNovelEngine(story);
  try {
    source.start();
    source.advance();
    source.advance(); // Store the deep variable in a rollback checkpoint pool.
    const expanded = source.save();
    const compact = encodeNovelSaveData(expanded);
    expect(decodeNovelSaveData(compact)).toEqual(expanded);
    restored.load(compact);
    let layers = 0;
    let current = restored.getSnapshot().variables.deepValue as Record<string, unknown>;
    while (current && typeof current === "object" && Object.hasOwn(current, "next")) {
      layers += 1;
      current = current.next as Record<string, unknown>;
    }
    expect(layers).toBe(140);
    expect(current.done).toBe(true);

    const customArrayProperty = JSON.parse(JSON.stringify(compact)) as any;
    Object.defineProperty(customArrayProperty.state.rollbackHistory.entries[0], "01", {
      value: "not a JSON array element",
      enumerable: true,
    });
    expect(() => decodeNovelSaveData(customArrayProperty)).toThrow(NovelSaveCodecError);
  } finally {
    source.dispose();
    restored.dispose();
  }
});
