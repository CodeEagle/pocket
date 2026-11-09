import { expect, test } from "bun:test";
import {
  createNovelEngine,
  NovelEngineError,
  SaveDataError,
  StoryValidationError,
} from "../src/index.ts";
import type { NovelInputInstruction, StoryDefinition } from "../src/types.ts";

function inputStory(input: NovelInputInstruction, extra: Record<string, readonly unknown[]> = {}): StoryDefinition {
  return {
    id: "input-story",
    version: 1,
    start: "start",
    script: {
      start: [input, { type: "ending", id: "done" }],
      done: [{ type: "ending", id: "done" }],
      cancel: [{ type: "ending", id: "cancel" }],
      ...extra,
    } as StoryDefinition["script"],
  };
}

test("typed inputs use static defaults, preserve raw drafts and commit only typed values", () => {
  const story: StoryDefinition = {
    id: "typed-inputs", version: 1, start: "start", script: { start: [
      { type: "input", id: "name", variable: "name", inputType: "text", defaultValue: "Static", maxLength: 20 },
      { type: "input", id: "score", variable: "score", inputType: "number", min: 100, max: 150 },
      { type: "input", id: "accepted", variable: "accepted", inputType: "boolean", defaultValue: true },
      { type: "ending", id: "done" },
    ] },
  };
  const engine = createNovelEngine(story, { initialVariables: { name: "Existing", score: 1, accepted: "unset" } });
  engine.start();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "name", draft: "Static", error: null, placeholder: null });
  engine.submitInput();
  expect(engine.getSnapshot().variables.name).toBe("Static");

  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "score", draft: "", error: null });
  const required = engine.submitInput();
  expect(required.snapshot.active).toMatchObject({ kind: "input", id: "score", error: { code: "required" } });
  expect(required.snapshot.variables.score).toBe(1);
  engine.updateInput("+1.25e2");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "score", draft: "+1.25e2", error: null });
  engine.submitInput();
  expect(engine.getSnapshot().variables.score).toBe(125);

  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "accepted", draft: true, placeholder: null });
  const booleanSnapshot = engine.getSnapshot();
  expect(() => engine.updateInput("false")).toThrow(RangeError);
  expect(engine.getSnapshot()).toBe(booleanSnapshot);
  engine.updateInput(false);
  engine.submitInput();
  expect(engine.getSnapshot().variables).toEqual({ name: "Static", score: 125, accepted: false });
  expect(engine.getSnapshot().active).toMatchObject({ kind: "ending", id: "done" });
});

test("text lengths count Unicode code points and invalid submit stays in the input", () => {
  const engine = createNovelEngine(inputStory({
    type: "input", id: "text", variable: "answer", inputType: "text", minLength: 2, maxLength: 2,
  }));
  engine.start();
  engine.updateInput("🙂");
  const tooShort = engine.submitInput();
  expect(tooShort.snapshot.active).toMatchObject({ kind: "input", draft: "🙂", error: { code: "tooShort", limit: 2 } });
  expect(tooShort.snapshot.variables).toEqual({});

  engine.updateInput("水🙂");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", draft: "水🙂", error: null });
  engine.submitInput();
  expect(engine.getSnapshot().variables.answer).toBe("水🙂");

  const tooLongEngine = createNovelEngine(inputStory({
    type: "input", id: "text", variable: "answer", inputType: "text", maxLength: 2,
  }));
  tooLongEngine.start();
  tooLongEngine.updateInput("水🙂x");
  expect(tooLongEngine.submitInput().snapshot.active).toMatchObject({ kind: "input", error: { code: "tooLong", limit: 2 } });
});

test("numeric input accepts finite signed decimal and exponent syntax, with typed bound errors", () => {
  const numeric = (): ReturnType<typeof createNovelEngine> => createNovelEngine(inputStory({
    type: "input", id: "number", variable: "value", inputType: "number", integer: true, min: -10, max: 1000,
  }));

  const engine = numeric();
  engine.start();
  engine.updateInput("4.5");
  expect(engine.submitInput().snapshot.active).toMatchObject({ kind: "input", error: { code: "integer" } });
  engine.updateInput("-11");
  expect(engine.submitInput().snapshot.active).toMatchObject({ kind: "input", error: { code: "min", limit: -10 } });
  engine.updateInput("1001");
  expect(engine.submitInput().snapshot.active).toMatchObject({ kind: "input", error: { code: "max", limit: 1000 } });
  engine.updateInput("+1e3");
  expect(engine.submitInput().snapshot.active).toMatchObject({ kind: "ending", id: "done" });
  expect(engine.getSnapshot().variables.value).toBe(1000);

  for (const raw of ["NaN", "Infinity", "0x10", "0b11", " 1", "1 ", ".", "+.", "1e999"]) {
    const rejected = numeric();
    rejected.start();
    rejected.updateInput(raw);
    expect(rejected.submitInput().snapshot.active).toMatchObject({ kind: "input", error: { code: "number" } });
  }
  for (const raw of ["+12", "-12.5", ".5", "12.", "1e+3"]) {
    const accepted = createNovelEngine(inputStory({ type: "input", id: "number", variable: "value", inputType: "number" }));
    accepted.start();
    accepted.updateInput(raw);
    accepted.submitInput();
    expect(typeof accepted.getSnapshot().variables.value).toBe("number");
  }

  const largeDefault = createNovelEngine(inputStory({
    type: "input", id: "large", variable: "large", inputType: "number", defaultValue: 1e308,
  }));
  largeDefault.start();
  expect(largeDefault.getSnapshot().active).toMatchObject({ kind: "input", draft: "1e+308" });
  largeDefault.submitInput();
  expect(largeDefault.getSnapshot().variables.large).toBe(1e308);
});

test("raw draft caps reject without truncating or changing the snapshot", () => {
  const text = createNovelEngine(inputStory({ type: "input", id: "text", variable: "text", inputType: "text" }));
  text.start();
  text.updateInput("x".repeat(4096));
  const beforeTextOverflow = text.getSnapshot();
  expect(() => text.updateInput("x".repeat(4097))).toThrow(RangeError);
  expect(text.getSnapshot()).toBe(beforeTextOverflow);
  expect(text.submitInput().snapshot.variables.text).toBe("x".repeat(4096));

  const number = createNovelEngine(inputStory({ type: "input", id: "number", variable: "n", inputType: "number" }));
  number.start();
  const beforeNumberOverflow = number.getSnapshot();
  expect(() => number.updateInput("1".repeat(129))).toThrow(RangeError);
  expect(number.getSnapshot()).toBe(beforeNumberOverflow);
});

test("cancellation follows its target and never writes the input variable", () => {
  const engine = createNovelEngine(inputStory({
    type: "input", id: "name", variable: "name", inputType: "text", cancelTarget: "cancel",
  }), { initialVariables: { name: "Original" } });
  engine.start();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", draft: "", canCancel: true });
  engine.updateInput("Edited");
  engine.cancelInput();
  expect(engine.getSnapshot().variables.name).toBe("Original");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "ending", id: "cancel" });

  const notCancellable = createNovelEngine(inputStory({ type: "input", id: "name", variable: "name", inputType: "text" }));
  notCancellable.start();
  expect(() => notCancellable.cancelInput()).toThrow(NovelEngineError);
  expect(notCancellable.getSnapshot().active).toMatchObject({ kind: "input", canCancel: false });
});

test("input actions respect pause state, and auto, skip, tick and debug stepping stop at input", () => {
  const paused = createNovelEngine(inputStory({
    type: "input", id: "text", variable: "text", inputType: "text", cancelTarget: "cancel",
  }));
  paused.start();
  paused.pause();
  const before = paused.getSnapshot();
  expect(() => paused.updateInput("x")).toThrow(NovelEngineError);
  expect(() => paused.submitInput()).toThrow(NovelEngineError);
  expect(() => paused.cancelInput()).toThrow(NovelEngineError);
  expect(paused.tick(5000).snapshot).toMatchObject(before);
  paused.resume();

  for (const mode of ["auto", "skip"] as const) {
    const engine = createNovelEngine({
      id: `input-${mode}`, version: 1, start: "start", script: { start: [
        { type: "say", id: "line", text: "line" },
        { type: "input", id: "stop", variable: "answer", inputType: "text", cancelTarget: "cancel" },
      ], cancel: [{ type: "ending", id: "cancel" }] },
    }, { preferences: { mode, textSpeedCharsPerSecond: 0, autoDelayMs: 0, skipSeenOnly: false } });
    engine.start();
    engine.tick(0);
    expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "stop" });
    const inputSnapshot = engine.getSnapshot();
    engine.tick(100_000);
    expect(engine.getSnapshot().active).toEqual(inputSnapshot.active);
  }

  const debug = createNovelEngine({
    id: "input-debug", version: 1, start: "start", script: { start: [
      { type: "say", id: "line", text: "line" },
      { type: "input", id: "stop", variable: "answer", inputType: "text" },
    ] },
  });
  debug.debug.step();
  debug.debug.step();
  expect(debug.getSnapshot()).toMatchObject({ paused: true, active: { kind: "input", id: "stop" } });
  expect(() => debug.debug.step()).toThrow(NovelEngineError);

  const notInput = createNovelEngine({
    id: "not-input", version: 1, start: "start", script: { start: [{ type: "say", id: "line", text: "line" }] },
  });
  notInput.start();
  expect(() => notInput.updateInput("x")).toThrow(NovelEngineError);
  expect(() => notInput.submitInput()).toThrow(NovelEngineError);
  expect(() => notInput.cancelInput()).toThrow(NovelEngineError);
});

test("input instruction validation rejects malformed branches, duplicate input IDs and missing targets", () => {
  const invalid = (instruction: unknown): StoryDefinition => ({
    id: "bad-input", version: 1, start: "start", script: { start: [instruction as any] },
  });
  const valid = { type: "input", id: "id", variable: "answer", inputType: "text" };
  expect(() => createNovelEngine(invalid({ ...valid, min: 0 }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, inputType: "boolean", placeholder: "unused" }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, variable: "not a variable" }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, maxLength: 4097 }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, minLength: 3, maxLength: 2 }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, defaultValue: "x", minLength: 2 }))).toThrow(StoryValidationError);
  expect(() => createNovelEngine(invalid({ ...valid, cancelTarget: "missing" }))).toThrow(StoryValidationError);

  const duplicates: StoryDefinition = {
    id: "duplicate-input", version: 1, start: "start", script: { start: [
      { ...valid }, { ...valid },
    ] as any },
  };
  expect(() => createNovelEngine(duplicates)).toThrow(StoryValidationError);
});

test("save/load preserves invalid drafts and errors, rejects forged input state atomically, and reads legacy saves", () => {
  const story = inputStory({
    type: "input", id: "answer", variable: "answer", inputType: "number", prompt: "Enter {{existing}}",
    placeholder: "1..5", min: 1, max: 5, cancelTarget: "cancel",
  });
  const engine = createNovelEngine(story, { initialVariables: { existing: "a value" } });
  engine.start();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", prompt: "Enter a value", placeholder: "1..5" });
  engine.updateInput("NaN");
  engine.submitInput();
  const invalidSave = engine.save();
  const loaded = createNovelEngine(story);
  loaded.load(invalidSave);
  expect(loaded.getSnapshot().active).toMatchObject({ kind: "input", draft: "NaN", error: { code: "number" } });

  loaded.updateInput("4"); // A changed raw value clears the old error.
  const draftOnlySave = loaded.save();
  const draftOnly = createNovelEngine(story);
  draftOnly.load(draftOnlySave);
  expect(draftOnly.getSnapshot().active).toMatchObject({ kind: "input", draft: "4", error: null });

  const beforeBadLoad = draftOnly.getSnapshot();
  const staleError = structuredClone(draftOnlySave) as any;
  staleError.state.active.error = { code: "number" };
  expect(() => draftOnly.load(staleError)).toThrow(SaveDataError);
  expect(draftOnly.getSnapshot()).toBe(beforeBadLoad);

  const forgedShape = structuredClone(draftOnlySave) as any;
  forgedShape.state.active.error = { code: "max", limit: 5, forged: true };
  expect(() => draftOnly.load(forgedShape)).toThrow(SaveDataError);
  expect(draftOnly.getSnapshot()).toBe(beforeBadLoad);

  const changedInstructions: readonly StoryDefinition[] = [
    inputStory({ type: "input", id: "different-id", variable: "answer", inputType: "number", prompt: "Enter {{existing}}", placeholder: "1..5", min: 1, max: 5, cancelTarget: "cancel" }),
    inputStory({ type: "input", id: "answer", variable: "different-variable", inputType: "number", prompt: "Enter {{existing}}", placeholder: "1..5", min: 1, max: 5, cancelTarget: "cancel" }),
    inputStory({ type: "input", id: "answer", variable: "answer", inputType: "text", prompt: "Enter {{existing}}", placeholder: "1..5", cancelTarget: "cancel" }),
    inputStory({ type: "input", id: "answer", variable: "answer", inputType: "number", prompt: "Changed", placeholder: "1..5", min: 1, max: 5, cancelTarget: "cancel" }),
    inputStory({ type: "input", id: "answer", variable: "answer", inputType: "number", prompt: "Enter {{existing}}", placeholder: "Changed", min: 1, max: 5, cancelTarget: "cancel" }),
    inputStory({ type: "input", id: "answer", variable: "answer", inputType: "number", prompt: "Enter {{existing}}", placeholder: "1..5", min: 1, max: 5 }),
  ];
  for (const changedInstruction of changedInstructions) {
    expect(() => createNovelEngine(changedInstruction).load(draftOnlySave)).toThrow(SaveDataError);
  }

  const legacyStory: StoryDefinition = {
    id: "legacy-save", version: 1, start: "start", script: { start: [{ type: "say", id: "line", text: "legacy" }] },
  };
  const legacy = createNovelEngine(legacyStory);
  legacy.start();
  const legacySave = legacy.save();
  expect(legacySave.formatVersion).toBe(1);
  expect(createNovelEngine(legacyStory).load(legacySave).snapshot.active).toMatchObject({ kind: "say", id: "line" });
});

test("rollback restores the typed value and stage at the existing completed-dialogue checkpoint", () => {
  const story: StoryDefinition = {
    id: "input-rollback", version: 1, start: "start", script: { start: [
      { type: "scene", background: "before" },
      { type: "say", id: "before-input", text: "Before." },
      { type: "input", id: "score", variable: "score", inputType: "number" },
      { type: "scene", background: "after-input" },
      { type: "say", id: "after-input", text: "Entered." },
      { type: "scene", background: "later" },
      { type: "set", variable: "score", value: 99 },
      { type: "say", id: "later", text: "Later." },
      { type: "ending", id: "done" },
    ] },
  };
  const engine = createNovelEngine(story);
  engine.start();
  engine.advance();
  engine.advance();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "score" });
  engine.updateInput("7");
  engine.submitInput();
  expect(engine.getSnapshot()).toMatchObject({ variables: { score: 7 }, stage: { background: "after-input" }, active: { kind: "say", id: "after-input" } });
  engine.advance();
  engine.advance();
  expect(engine.getSnapshot()).toMatchObject({ variables: { score: 99 }, stage: { background: "later" }, active: { kind: "say", id: "later" } });
  engine.advance();
  engine.advance();
  engine.rollback(2);
  expect(engine.getSnapshot()).toMatchObject({
    variables: { score: 7 }, stage: { background: "after-input" }, active: { kind: "say", id: "after-input", complete: true },
  });
});
