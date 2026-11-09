import { expect, test } from "bun:test";
import { createNovelEngine, StepBudgetExceededError } from "../src/index.ts";
import type { NovelExecutionTraceEntry, StoryDefinition } from "../src/types.ts";

const flowStory: StoryDefinition = {
  id: "execution-trace-flow",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "set", variable: "root", value: "ready" },
      { type: "call", target: "outer" },
      { type: "branch", when: { op: "eq", left: { type: "variable", name: "root" }, right: { type: "literal", value: "ready" } }, then: "first", else: "other" },
    ],
    outer: [
      { type: "call", target: "inner" },
      { type: "set", variable: "outer", value: true },
    ],
    inner: [
      { type: "set", variable: "inner", value: true },
      { type: "return" },
    ],
    first: [{ type: "jump", target: "waiter" }],
    waiter: [
      { type: "wait", durationMs: 5 },
      { type: "choice", id: "route", options: [{ id: "finish", text: "Finish", target: "end" }] },
    ],
    end: [{ type: "ending", id: "finished", text: "Done" }],
    other: [{ type: "ending", id: "other" }],
  },
};

function traceShape(entries: readonly NovelExecutionTraceEntry[]) {
  return entries.map(({ location, op, id, returnTo }) => ({ location, op, ...(id ? { id } : {}), ...(returnTo ? { returnTo } : {}) }));
}

test("reports committed instruction order across nested calls, implicit return, branch, jump, wait, choice and ending", () => {
  const engine = createNovelEngine(flowStory, { preferences: { textSpeedCharsPerSecond: 0 } });
  const received: NovelExecutionTraceEntry[][] = [];
  const unsubscribe = engine.debug.subscribeExecutionTrace(entries => received.push(entries as NovelExecutionTraceEntry[]));

  const start = engine.start();
  expect(Object.keys(start).sort()).toEqual(["events", "snapshot"]);
  expect(start.events).toEqual([]);
  expect(received).toHaveLength(1);
  expect(traceShape(received[0]!)).toEqual([
    { location: { label: "start", index: 0 }, op: "set" },
    { location: { label: "start", index: 1 }, op: "call" },
    { location: { label: "outer", index: 0 }, op: "call" },
    { location: { label: "inner", index: 0 }, op: "set" },
    { location: { label: "inner", index: 1 }, op: "return" },
    { location: { label: "outer", index: 1 }, op: "set" },
    { location: { label: "outer", index: 2 }, op: "implicitReturn", returnTo: { label: "start", index: 2 } },
    { location: { label: "start", index: 2 }, op: "branch" },
    { location: { label: "first", index: 0 }, op: "jump" },
    { location: { label: "waiter", index: 0 }, op: "wait" },
  ]);
  expect(Object.isFrozen(received[0])).toBe(true);
  expect(Object.isFrozen(received[0]![0])).toBe(true);
  const waitSnapshot = JSON.stringify(engine.getSnapshot());
  const waitSave = JSON.stringify(engine.save());
  const noOpUnsubscribe = engine.debug.subscribeExecutionTrace(() => {});
  noOpUnsubscribe();
  expect(JSON.stringify(engine.getSnapshot())).toBe(waitSnapshot);
  expect(JSON.stringify(engine.save())).toBe(waitSave);

  engine.tick(2);
  expect(received).toHaveLength(1);
  engine.tick(3);
  expect(received).toHaveLength(2);
  expect(traceShape(received[1]!)).toEqual([{ location: { label: "waiter", index: 1 }, op: "choice", id: "route" }]);
  engine.selectChoice("finish");
  expect(received).toHaveLength(3);
  expect(traceShape(received[2]!)).toEqual([{ location: { label: "end", index: 0 }, op: "ending", id: "finished" }]);

  unsubscribe();
  engine.dispose();
});

test("does not report breakpoint targets, failed transactions, or empty tick batches; debug step reports only what it executes", () => {
  const story: StoryDefinition = {
    id: "execution-trace-breakpoint",
    version: 1,
    start: "start",
    script: { start: [
      { type: "set", variable: "ready", value: true },
      { type: "say", id: "line", text: "Line" },
      { type: "ending", id: "finish" },
    ] },
  };
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const batches: NovelExecutionTraceEntry[][] = [];
  engine.debug.subscribeExecutionTrace(entries => batches.push(entries as NovelExecutionTraceEntry[]));
  engine.debug.setBreakpoints([{ label: "start", index: 1 }]);
  engine.start();
  expect(batches.map(traceShape)).toEqual([[{ location: { label: "start", index: 0 }, op: "set" }]]);
  expect(engine.getSnapshot()).toMatchObject({ paused: true, location: { label: "start", index: 1 }, active: null });
  engine.debug.step();
  expect(batches.map(traceShape)).toEqual([
    [{ location: { label: "start", index: 0 }, op: "set" }],
    [{ location: { label: "start", index: 1 }, op: "say", id: "line" }],
  ]);

  const looping = createNovelEngine({
    id: "execution-trace-rollback", version: 1, start: "loop",
    script: { loop: [{ type: "set", variable: "value", value: 1 }, { type: "jump", target: "loop" }] },
  }, { maxStepBudget: 2 });
  const failedBatches: NovelExecutionTraceEntry[][] = [];
  looping.debug.subscribeExecutionTrace(entries => failedBatches.push(entries as NovelExecutionTraceEntry[]));
  expect(() => looping.start()).toThrow(StepBudgetExceededError);
  expect(failedBatches).toEqual([]);
  expect(looping.getSnapshot()).toMatchObject({ started: false, location: { label: "loop", index: 0 } });
  looping.dispose();
  engine.dispose();
});

test("observer subscriptions are inert, callback errors are isolated, and nested commits reach all observers in order", () => {
  const story: StoryDefinition = {
    id: "execution-trace-reentrant", version: 1, start: "start",
    script: { start: [
      { type: "say", id: "first", text: "First" },
      { type: "set", variable: "nested", value: true },
      { type: "ending", id: "last" },
    ] },
  };
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const before = JSON.stringify(engine.save());
  const batches: NovelExecutionTraceEntry[][] = [];
  const secondObserverBatches: NovelExecutionTraceEntry[][] = [];
  let observerFailures = 0;
  const unsubscribeThrowing = engine.debug.subscribeExecutionTrace(() => { observerFailures++; throw new Error("observer failure"); });
  const unsubscribe = engine.debug.subscribeExecutionTrace(entries => batches.push(entries as NovelExecutionTraceEntry[]));
  const unsubscribeSecondObserver = engine.debug.subscribeExecutionTrace(entries => secondObserverBatches.push(entries as NovelExecutionTraceEntry[]));
  expect(JSON.stringify(engine.save())).toBe(before);
  expect(JSON.stringify(engine.save())).toBe(before);

  let nested = false;
  engine.subscribe(update => {
    if (!nested && update.snapshot.active?.kind === "say") {
      nested = true;
      engine.advance();
    }
  });
  expect(() => engine.start()).not.toThrow();
  expect(batches.map(batch => batch.map(entry => entry.op))).toEqual([["say"], ["set", "ending"]]);
  expect(secondObserverBatches.map(batch => batch.map(entry => entry.op))).toEqual([["say"], ["set", "ending"]]);
  expect(observerFailures).toBe(2);
  expect(engine.getSnapshot().phase).toBe("ending");

  unsubscribeThrowing();
  unsubscribe();
  unsubscribeSecondObserver();
  engine.dispose();
});

test("dispose completes the in-flight batch for its commit-time observers and drops queued later batches", () => {
  const engine = createNovelEngine({
    id: "execution-trace-dispose", version: 1, start: "start",
    script: { start: [
      { type: "say", id: "first", text: "First" },
      { type: "set", variable: "nested", value: true },
      { type: "ending", id: "last" },
    ] },
  }, { preferences: { textSpeedCharsPerSecond: 0 } });
  let nested = false;
  engine.subscribe(update => {
    if (!nested && update.snapshot.active?.kind === "say") {
      nested = true;
      engine.advance();
    }
  });
  engine.debug.subscribeExecutionTrace(() => engine.dispose());
  const remainingObserver: NovelExecutionTraceEntry[][] = [];
  engine.debug.subscribeExecutionTrace(entries => remainingObserver.push(entries as NovelExecutionTraceEntry[]));

  engine.start();
  expect(remainingObserver.map(batch => batch.map(entry => entry.op))).toEqual([["say"]]);
  expect(engine.getSnapshot().phase).toBe("disposed");
});

test("trace observers can commit recursively without reordering batches for either observer", () => {
  const engine = createNovelEngine({
    id: "execution-trace-observer-reentrant", version: 1, start: "start",
    script: { start: [
      { type: "say", id: "first", text: "First" },
      { type: "set", variable: "nested", value: true },
      { type: "ending", id: "last" },
    ] },
  }, { preferences: { textSpeedCharsPerSecond: 0 } });
  const firstObserver: NovelExecutionTraceEntry[][] = [];
  const secondObserver: NovelExecutionTraceEntry[][] = [];
  let nested = false;
  engine.debug.subscribeExecutionTrace(entries => {
    firstObserver.push(entries as NovelExecutionTraceEntry[]);
    if (!nested) {
      nested = true;
      engine.advance();
    }
  });
  engine.debug.subscribeExecutionTrace(entries => secondObserver.push(entries as NovelExecutionTraceEntry[]));

  engine.start();
  expect(firstObserver.map(batch => batch.map(entry => entry.op))).toEqual([["say"], ["set", "ending"]]);
  expect(secondObserver.map(batch => batch.map(entry => entry.op))).toEqual([["say"], ["set", "ending"]]);
  expect(engine.getSnapshot().phase).toBe("ending");
  engine.dispose();
});
