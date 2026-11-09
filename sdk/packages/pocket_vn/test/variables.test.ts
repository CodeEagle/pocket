import { expect, test } from "bun:test";
import { createNovelEngine, novelVariableDefinitionsIssue, SaveDataError, StoryValidationError } from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";

function finishSay(engine: ReturnType<typeof createNovelEngine>): void {
  const active = engine.getSnapshot().active;
  if (active?.kind !== "say") throw new Error("Expected dialogue");
  if (!active.complete) engine.advance();
  engine.advance();
}

const lifetimeStory: StoryDefinition = {
  id: "variable-lifetimes", version: 1, start: "start",
  variableDefinitions: {
    sessionCount: { lifetime: "session", defaultValue: 1 },
    saveCount: { lifetime: "save", defaultValue: 2 },
    persistentCount: { lifetime: "persistent", defaultValue: 3 },
  },
  script: { start: [
    { type: "say", id: "open", text: "Initial values." },
    { type: "set", variable: "sessionCount", value: 4 },
    { type: "set", variable: "saveCount", value: 5 },
    { type: "set", variable: "persistentCount", value: 6 },
    { type: "set", variable: "undeclared", value: "saved by default" },
    { type: "say", id: "next", text: "Session {{sessionCount}}, save {{saveCount}}, persistent {{persistentCount}}." },
  ] },
};

test("variable definitions validate names, lifetimes and JSON defaults while allowing author metadata", () => {
  expect(novelVariableDefinitionsIssue(undefined)).toBeNull();
  expect(novelVariableDefinitionsIssue({ _score: { lifetime: "session", defaultValue: 2, label: "Score" } })).toBeNull();
  expect(novelVariableDefinitionsIssue({ "bad name": { lifetime: "save" } })).toContain("invalid variable name");
  expect(novelVariableDefinitionsIssue({ score: { lifetime: "global" } })).toContain("lifetime");
  expect(novelVariableDefinitionsIssue({ score: { lifetime: "save", defaultValue: Number.POSITIVE_INFINITY } })).toContain("finite JSON numbers");
  expect(novelVariableDefinitionsIssue({ score: { lifetime: "save", defaultValue: undefined } })).toContain("JSON value");
  const malformed = { score: { lifetime: "save" } } as any;
  malformed.score.metadata = malformed;
  expect(novelVariableDefinitionsIssue(malformed)).toBeNull(); // Unknown metadata is the editor's concern to preserve.
  expect(() => createNovelEngine({ ...lifetimeStory, variableDefinitions: { score: { lifetime: "global" as any } } })).toThrow(StoryValidationError);
});

test("save, session and persistent values use one effective projection with distinct reset behavior", () => {
  const engine = createNovelEngine(lifetimeStory);
  expect(engine.getSnapshot().variables).toEqual({ sessionCount: 1, saveCount: 2, persistentCount: 3 });
  engine.start();
  finishSay(engine);
  expect(engine.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "next", text: "Session 4, save 5, persistent 6." },
    variables: { sessionCount: 4, saveCount: 5, persistentCount: 6, undeclared: "saved by default" },
    meta: { persistentVariables: { persistentCount: 6 } },
  });

  const save = engine.save();
  expect(save.state.variables).toEqual({ sessionCount: 4, saveCount: 5, undeclared: "saved by default" });
  expect(save.state.meta.persistentVariables).toEqual({ persistentCount: 6 });
  const coldLoad = createNovelEngine(lifetimeStory);
  coldLoad.load(save);
  expect(coldLoad.getSnapshot().variables).toMatchObject({ sessionCount: 4, saveCount: 5, persistentCount: 6 });

  const currentMeta = createNovelEngine(lifetimeStory, { initialMeta: {
    readLineIds: [], endingIds: [], cgIds: [], persistentVariables: { persistentCount: 9 },
  } });
  currentMeta.load(save);
  expect(currentMeta.getSnapshot().variables.persistentCount).toBe(9); // Current explicit meta wins an older slot.
  expect(currentMeta.getSnapshot().variables.sessionCount).toBe(4); // Session values still come from explicit save/load.

  engine.pause();
  const restarted = engine.newGame();
  expect(restarted.snapshot).toMatchObject({
    paused: false,
    active: { kind: "say", id: "open" },
    meta: { persistentVariables: { persistentCount: 6 } },
    backlog: [],
    rollbackAvailable: 0,
  });
  expect(restarted.snapshot.variables).toMatchObject({ sessionCount: 4, saveCount: 2, persistentCount: 6 });
  expect(Object.hasOwn(restarted.snapshot.variables, "undeclared")).toBe(false);
});

test("legacy saves migrate persistent values and preserve legacy metadata shapes atomically", () => {
  const source = createNovelEngine(lifetimeStory, { initialVariables: { persistentCount: 11 } });
  source.start();
  const legacy = structuredClone(source.save()) as any;
  delete legacy.state.meta.persistentVariables;
  legacy.state.variables.persistentCount = 12;

  const target = createNovelEngine(lifetimeStory);
  target.load(legacy);
  expect(target.getSnapshot().variables.persistentCount).toBe(12);
  expect(target.getSnapshot().meta.persistentVariables).toEqual({ persistentCount: 12 });

  const before = target.getSnapshot();
  const tampered = structuredClone(target.save()) as any;
  tampered.state.meta.persistentVariables.saveCount = 90;
  expect(() => target.load(tampered)).toThrow(SaveDataError);
  expect(target.getSnapshot()).toBe(before);
});

test("rollback rewinds session/save values but keeps persistent progress; newGame keeps monotonic native tokens", () => {
  const rollbackStory: StoryDefinition = {
    id: "variable-rollback", version: 1, start: "start",
    variableDefinitions: {
      sessionValue: { lifetime: "session", defaultValue: 0 },
      saveValue: { lifetime: "save", defaultValue: 0 },
      persistentValue: { lifetime: "persistent", defaultValue: 0 },
    },
    script: { start: [
      { type: "scene", background: "night", transition: { kind: "fade", durationMs: 10 } },
      { type: "audio", cue: "theme", channel: "music", loop: true },
      { type: "say", id: "one", voice: "voice-one", text: "One." },
      { type: "set", variable: "sessionValue", value: 1 },
      { type: "set", variable: "saveValue", value: 2 },
      { type: "set", variable: "persistentValue", value: 3 },
      { type: "say", id: "two", text: "Persistent was {{persistentValue}}." },
      { type: "set", variable: "sessionValue", value: 99 },
      { type: "set", variable: "saveValue", value: 88 },
      { type: "set", variable: "persistentValue", value: 4 },
      { type: "say", id: "three", voice: "voice-three", text: "Three." },
    ] },
  };
  const engine = createNovelEngine(rollbackStory, { preferences: { mode: "auto" } });
  const start = engine.start();
  expect(start.snapshot.voice?.token).toBeTruthy();
  finishSay(engine);
  finishSay(engine);
  expect(engine.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "three" },
    variables: { sessionValue: 99, saveValue: 88, persistentValue: 4 },
  });
  const persisted = createNovelEngine(rollbackStory);
  persisted.load(engine.save());
  persisted.rollback();
  expect(persisted.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "two", text: "Persistent was 3." },
    variables: { sessionValue: 1, saveValue: 2, persistentValue: 4 },
  });

  const before = engine.getSnapshot();
  const restarted = engine.newGame();
  expect(restarted.snapshot.eventSequence).toBeGreaterThan(before.eventSequence);
  expect(restarted.events.map(event => event.type === "audioCue" ? [event.sequence, event.action] : null)).toEqual([
    [before.eventSequence + 1, "stop"],
    [before.eventSequence + 2, "play"],
  ]);
  expect(restarted.snapshot.stage.transition?.id).toBeGreaterThan(before.stage.transition?.id ?? 0);
  expect(restarted.snapshot.voice?.token).not.toBe(before.voice?.token);
  expect(restarted.snapshot.variables).toMatchObject({ sessionValue: 99, saveValue: 0, persistentValue: 4 });
});
