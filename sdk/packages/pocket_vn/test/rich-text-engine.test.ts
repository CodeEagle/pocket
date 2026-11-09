import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { decodeNovelSaveData, encodeNovelSaveData } from "../src/save-codec.ts";
import type { NovelSaveData, StoryDefinition } from "../src/types.ts";

const textStory: StoryDefinition = {
  id: "rich-text-engine",
  version: 1,
  start: "start",
  script: {
    start: [
      {
        type: "say", id: "letter", text: "RETURN",
        rich: {
          spans: [{ id: "return-note", start: 0, end: 6, style: { color: "accent", emphasis: "strong" }, ruby: "戻る", link: { title: "Harbor note", text: "The return signal is {{signal}}." } }],
          pauses: [{ id: "after-return", at: 6, durationMs: null }],
        },
      },
      { type: "ending", id: "finish" },
    ],
  },
};

const instantManual = { mode: "manual" as const, textSpeedCharsPerSecond: 0, autoDelayMs: 0, skipSeenOnly: false };

test("a fully revealed link opens at a local end pause without consuming or advancing the say", () => {
  const engine = createNovelEngine(textStory, { preferences: instantManual, initialVariables: { signal: "灯" } });
  engine.start();
  const before = engine.getSnapshot();
  expect(before.active).toMatchObject({ kind: "say", text: "RETURN", complete: true, pauseCursor: 0, pause: { id: "after-return", remainingMs: null } });

  const beforeInvalidLink = engine.save();
  expect(engine.activateSayLink("unknown").events).toEqual([]);
  expect(engine.save()).toEqual(beforeInvalidLink);
  const opened = engine.activateSayLink("return-note");
  expect(opened.events).toEqual([{
    type: "sayLink", sequence: 1, lineId: "letter", spanId: "return-note",
    title: "Harbor note", text: "The return signal is 灯.", location: { label: "start", index: 0 },
  }]);
  expect(opened.snapshot.active).toEqual(before.active);
  expect(opened.snapshot.backlog).toEqual([]);
  expect(opened.snapshot.meta.readLineIds).toEqual([]);
  expect(opened.snapshot.location).toEqual(before.location);

  engine.pause();
  expect(engine.activateSayLink("return-note").events).toEqual([]);
  engine.resume();
  engine.advance();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", complete: true, pauseCursor: 1, pause: null });
  engine.advance();
  expect(engine.getSnapshot().active?.kind).toBe("ending");
  expect(engine.getSnapshot().backlog[0]?.rich?.spans[0]?.id).toBe("return-note");
  engine.rollback();
  expect(engine.getSnapshot().active).toMatchObject({
    kind: "say", complete: true, pauseCursor: 1, pause: null,
    rich: { spans: [{ id: "return-note", link: { title: "Harbor note", text: "The return signal is 灯." } }], pauses: [{ id: "after-return", at: 6, durationMs: null }] },
  });
});

test("manual and timed pause cursors survive V4 save/load and rollback pools", () => {
  const story: StoryDefinition = {
    ...textStory,
    id: "rich-text-save",
    script: {
      start: [
        { type: "say", id: "timed", text: "A😀BC", rich: { spans: [], pauses: [
          { id: "timed-pause", at: 2, durationMs: 100 }, { id: "manual-pause", at: 3, durationMs: null },
        ] } },
        { type: "ending", id: "finish" },
      ],
    },
  };
  const preferences = { ...instantManual, textSpeedCharsPerSecond: 10 };
  const engine = createNovelEngine(story, { preferences });
  engine.start();
  engine.tick(200);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "say", visibleText: "A😀", pauseCursor: 0, pause: { id: "timed-pause", remainingMs: 100 } });
  engine.tick(50);
  expect(engine.getSnapshot().active).toMatchObject({ pause: { id: "timed-pause", remainingMs: 50 } });

  const compact = encodeNovelSaveData(engine.save());
  expect(compact.state.richPool?.length).toBeGreaterThan(0);
  const malformed = JSON.parse(JSON.stringify(compact)) as typeof compact;
  if (malformed.state.richPool) {
    (malformed.state.richPool[0] as unknown as unknown[])[0] = 9999;
    expect(() => decodeNovelSaveData(malformed)).toThrow();
  }
  const expanded = decodeNovelSaveData(compact);
  expect(expanded.state.active).toMatchObject({ pauseCursor: 0, pause: { id: "timed-pause", remainingMs: 50 } });
  const restored = createNovelEngine(story, { preferences });
  restored.load(compact);
  restored.tick(50);
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", visibleText: "A😀", pauseCursor: 1, pause: null });
  restored.tick(100);
  expect(restored.getSnapshot().active).toMatchObject({ visibleText: "A😀B", pauseCursor: 1, pause: { id: "manual-pause", remainingMs: null } });
  restored.advance();
  expect(restored.getSnapshot().active).toMatchObject({ pauseCursor: 2, pause: null });
  restored.advance();
  expect(restored.getSnapshot().active).toMatchObject({ complete: true, pauseCursor: 2, pause: null });
  restored.advance();
  expect(restored.getSnapshot().active?.kind).toBe("ending");

  const savedAfterCommit = encodeNovelSaveData(restored.save());
  expect(decodeNovelSaveData(savedAfterCommit).state.rollbackHistory[0]?.active).toMatchObject({ pauseCursor: 2, pause: null, rich: { pauses: story.script.start[0]?.type === "say" ? story.script.start[0].rich?.pauses : [] } });
  const afterLoad = createNovelEngine(story, { preferences });
  afterLoad.load(savedAfterCommit);
  afterLoad.rollback();
  expect(afterLoad.getSnapshot().active).toMatchObject({ kind: "say", complete: true, pauseCursor: 2, pause: null });
});

test("instant, auto, and skip modes stop at manual and timed pause markers", () => {
  for (const mode of ["auto", "skip"] as const) {
    const manualStory: StoryDefinition = {
      ...textStory,
      id: `rich-${mode}-manual`,
      script: {
        start: [
          { type: "say", id: "line", text: "AB", rich: { spans: [], pauses: [{ id: "end", at: 2, durationMs: null }] } },
          { type: "ending", id: "done" },
        ],
      },
    };
    const engine = createNovelEngine(manualStory, { preferences: { ...instantManual, mode } });
    engine.start();
    engine.tick(5000);
    expect(engine.getSnapshot().active).toMatchObject({ kind: "say", text: "AB", complete: true, pauseCursor: 0, pause: { id: "end", remainingMs: null } });
    expect(engine.getSnapshot().backlog).toEqual([]);
    expect(engine.getSnapshot().meta.readLineIds).toEqual([]);
    engine.advance();
    expect(engine.getSnapshot().active).toMatchObject({ kind: "say", pauseCursor: 1, pause: null });

    const timedStory: StoryDefinition = {
      ...manualStory,
      id: `rich-${mode}-timed`,
      script: {
        start: [
          { type: "say", id: "line", text: "AB", rich: { spans: [], pauses: [{ id: "timed", at: 0, durationMs: 100 }] } },
          { type: "ending", id: "done" },
        ],
      },
    };
    const timed = createNovelEngine(timedStory, { preferences: { ...instantManual, mode, autoDelayMs: mode === "auto" ? 100 : 0 } });
    timed.start();
    timed.tick(99);
    expect(timed.getSnapshot().active).toMatchObject({ kind: "say", pauseCursor: 0, pause: { id: "timed", remainingMs: 1 } });
    expect(timed.getSnapshot().backlog).toEqual([]);
    timed.tick(1);
    if (mode === "auto") {
      expect(timed.getSnapshot().active?.kind).toBe("say");
      expect(timed.getSnapshot().backlog).toEqual([]);
      timed.tick(99);
      expect(timed.getSnapshot().active?.kind).toBe("say");
      timed.tick(1);
      expect(timed.getSnapshot().active?.kind).toBe("ending");
    } else {
      expect(timed.getSnapshot().active?.kind).toBe("ending");
    }
  }
});

test("plain say saves keep their legacy active and compact tuple shapes", () => {
  const story: StoryDefinition = { id: "plain-save", version: 1, start: "start", script: { start: [{ type: "say", id: "plain", text: "Plain." }] } };
  const engine = createNovelEngine(story, { preferences: instantManual });
  engine.start();
  expect(engine.getSnapshot().active).not.toHaveProperty("rich");
  engine.advance();
  engine.advance();
  const compact = encodeNovelSaveData(engine.save());
  expect(compact.state).not.toHaveProperty("richPool");
  expect(compact.state.backlog[0]).toHaveLength(7);
  expect(compact.state.rollbackHistory.pools.active[0]).toHaveLength(8);
});

test("invalid placeholder boundaries and pause save state fail atomically", () => {
  const badStory: StoryDefinition = {
    id: "rich-bad-placeholder", version: 1, start: "start",
    script: { start: [{ type: "say", id: "bad", text: "{{name}}", rich: { spans: [{ id: "split", start: 1, end: 3 }], pauses: [] } }] },
  };
  expect(() => createNovelEngine(badStory, { initialVariables: { name: "灯" } })).toThrow("cannot split a {{variable}} placeholder");

  const engine = createNovelEngine(textStory, { preferences: instantManual });
  engine.start();
  const beforeLoad = engine.getSnapshot();
  const damaged = JSON.parse(JSON.stringify(engine.save())) as NovelSaveData;
  const damagedState = damaged.state as unknown as { active: NovelSaveData["state"]["active"] };
  if (damagedState.active?.kind === "say") {
    damagedState.active = { ...damagedState.active, pause: { id: "wrong-marker", remainingMs: null } };
  }
  expect(() => engine.load(damaged)).toThrow();
  expect(engine.getSnapshot()).toEqual(beforeLoad);
});
