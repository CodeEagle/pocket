import { expect, test } from "bun:test";
import { createNovelEngine, SaveDataError } from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";

const originalCopy: StoryDefinition = {
  id: "say-copy-restore",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "set", variable: "captain", value: "Mira" },
      { type: "say", id: "arrival", speaker: "Mira", portrait: "calm", text: "Before {{captain}}: 🌊" },
      { type: "set", variable: "captain", value: "Orin" },
      { type: "say", id: "harbor", speaker: "Mira", portrait: "calm", text: "Now {{captain}} sees 🌊 old harbor." },
      { type: "ending", id: "end" },
    ],
  },
};

const revisedCopy: StoryDefinition = {
  ...originalCopy,
  script: {
    start: [
      { type: "set", variable: "captain", value: "Mira" },
      { type: "say", id: "arrival", speaker: "Mira", portrait: "calm", text: "Revised scene: {{captain}} reaches 🌊." },
      { type: "set", variable: "captain", value: "Orin" },
      { type: "say", id: "harbor", speaker: "Mira", portrait: "calm", text: "Tonight {{captain}} watches the 🌊 harbor lights from the pier." },
      { type: "ending", id: "end" },
    ],
  },
};

function completeLine(engine: ReturnType<typeof createNovelEngine>): void {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected a say instruction");
  if (!active.complete) engine.advance();
  engine.advance();
}

test("same-ID text-only edits restore partial say by Unicode code-point fraction and preserve history", () => {
  const source = createNovelEngine(originalCopy, { preferences: { textSpeedCharsPerSecond: 8 } });
  source.start();
  completeLine(source);
  expect(source.getSnapshot()).toMatchObject({ active: { kind: "say", id: "harbor" }, variables: { captain: "Orin" } });
  source.tick(250);
  const oldActive = source.getSnapshot().active;
  if (oldActive?.kind !== "say") throw new Error("Expected partial source dialogue");
  expect(oldActive.revealedCharacters).toBe(2);
  const oldSave = source.save();

  const sameStory = createNovelEngine(originalCopy);
  sameStory.load(oldSave);
  expect(sameStory.getSnapshot().active).toEqual(oldActive);

  const resumed = createNovelEngine(revisedCopy);
  resumed.load(oldSave);
  const active = resumed.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected resumed dialogue");
  const expectedText = "Tonight Orin watches the 🌊 harbor lights from the pier.";
  const oldLength = Array.from(oldActive.text).length;
  const newPoints = Array.from(expectedText);
  const expectedProgress = oldActive.revealProgress / oldLength * newPoints.length;
  expect(active.text).toBe(expectedText);
  expect(active.revealProgress).toBeCloseTo(expectedProgress);
  expect(active.revealProgress).not.toBeCloseTo(oldActive.revealProgress / oldActive.text.length * newPoints.length);
  expect(active.visibleText).toBe(newPoints.slice(0, Math.floor(expectedProgress)).join(""));
  expect(active.complete).toBe(false);
  // Backlog remains the historical line exactly as it was when the save was made.
  expect(resumed.getSnapshot().backlog[0]?.text).toBe("Before Mira: 🌊");

  resumed.rollback();
  expect(resumed.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "arrival", text: "Revised scene: Mira reaches 🌊.", complete: true },
    variables: { captain: "Mira" },
  });
});

test("save loading still rejects inconsistent old display data and changed instruction structure atomically", () => {
  const source = createNovelEngine(originalCopy, { preferences: { textSpeedCharsPerSecond: 8 } });
  source.start();
  completeLine(source);
  source.tick(250);
  const save = source.save();

  const target = createNovelEngine(revisedCopy);
  const before = target.getSnapshot();
  const inconsistent = structuredClone(save) as any;
  inconsistent.state.active.visibleText = "forged prefix";
  expect(() => target.load(inconsistent)).toThrow(SaveDataError);
  expect(target.getSnapshot()).toBe(before);

  const changedId = structuredClone(revisedCopy) as any;
  changedId.script.start[3].id = "different-line";
  expect(() => createNovelEngine(changedId).load(save)).toThrow(SaveDataError);

  const changedKind = structuredClone(revisedCopy) as any;
  changedKind.script.start[3] = { type: "wait", durationMs: 1 };
  expect(() => createNovelEngine(changedKind).load(save)).toThrow(SaveDataError);
});

test("persistent-variable rollback keeps the checkpoint's historically rendered text after a copy edit", () => {
  const oldStory: StoryDefinition = {
    id: "say-copy-persistent",
    version: 1,
    start: "start",
    variableDefinitions: { trust: { lifetime: "persistent", defaultValue: 0 } },
    script: { start: [
      { type: "say", id: "first", text: "Trust was {{trust}} at the old pier." },
      { type: "set", variable: "trust", value: 3 },
      { type: "say", id: "second", text: "A second line." },
      { type: "set", variable: "trust", value: 4 },
      { type: "say", id: "third", text: "The current line." },
    ] },
  };
  const editedStory: StoryDefinition = {
    ...oldStory,
    script: { start: [
      { type: "say", id: "first", text: "The old pier recorded trust {{trust}}." },
      ...oldStory.script.start.slice(1),
    ] },
  };
  const source = createNovelEngine(oldStory);
  source.start();
  completeLine(source);
  completeLine(source);
  const save = source.save();

  const resumed = createNovelEngine(editedStory);
  resumed.load(save);
  resumed.rollback(2);
  expect(resumed.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "first", text: "Trust was 0 at the old pier.", complete: true },
    variables: { trust: 4 },
  });
});
