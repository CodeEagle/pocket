import { expect, test } from "bun:test";
import {
  NovelEngineError,
  StoryValidationError,
  continueNovelContextPreview,
  createNovelContextPreview,
  createNovelEngine,
  createNovelReplayEngine,
  listNovelContextPreviewRoots,
} from "../src/index.ts";
import type { NovelExecutionTraceEntry, ScriptPosition, StoryDefinition } from "../src/types.ts";

const contextStory: StoryDefinition = {
  id: "context-preview-flow",
  version: 1,
  start: "start",
  timelines: {
    sweep: {
      durationMs: 100,
      camera: [
        { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
        { atMs: 100, value: { x: 100, y: 40, scale: 2 } },
      ],
      audio: [{ atMs: 0, cue: "harbor", channel: "music", loop: true }, { atMs: 25, cue: "wave" }],
      audioGains: [{ channel: "music", keyframes: [{ atMs: 0, value: 1 }, { atMs: 100, value: 0.5 }] }],
    },
  },
  script: {
    start: [
      { type: "set", variable: "beforeCall", value: true },
      { type: "call", target: "setup" },
      { type: "wait", durationMs: 40 },
      { type: "choice", id: "route", options: [
        { id: "go", text: "Go", target: "chosen" },
        { id: "leave", text: "Leave", target: "other" },
      ] },
    ],
    setup: [
      { type: "scene", background: "harbor", timeline: "sweep" },
      { type: "audio", cue: "wind", channel: "wind", loop: true },
      { type: "set", variable: "callRan", value: 7 },
      { type: "return" },
    ],
    chosen: [
      { type: "set", variable: "route", value: "go" },
      { type: "scene", background: "cabin" },
      { type: "say", id: "target-line", text: "The real route is visible." },
      { type: "ending", id: "done" },
    ],
    other: [{ type: "ending", id: "left" }],
  },
};

const target: ScriptPosition = { label: "chosen", index: 1 };
const engineOptions = { preferences: { textSpeedCharsPerSecond: 32 } } as const;

function traceOps(batches: readonly (readonly NovelExecutionTraceEntry[])[]): string[] {
  return batches.flatMap(batch => batch.map(entry => `${entry.location.label}[${entry.location.index}]:${entry.op}`));
}

test("reconstructs canonical call/return, wait, choice and nonblocking target state", () => {
  const contextStoryBefore = structuredClone(contextStory);
  const main = createNovelEngine(contextStory, engineOptions);
  main.start();
  const mainBefore = main.save();
  const traced: NovelExecutionTraceEntry[][] = [];

  const preview = createNovelContextPreview(contextStory, target, {
    ...engineOptions,
    onExecutionTrace: entries => traced.push([...entries]),
  });
  expect(preview.root).toEqual({ kind: "main" });
  expect(preview.rootLocation).toEqual({ label: contextStory.start, index: 0 });
  expect(preview.status).toBe("blocked");
  expect(preview.blocker).toBe("choice");
  expect(preview.snapshot.active).toMatchObject({ kind: "choice", id: "route" });
  expect(preview.snapshot.variables).toMatchObject({ beforeCall: true, callRan: 7 });
  expect(preview.snapshot.callStack).toEqual([]);
  expect(preview.snapshot.stage).toMatchObject({
    background: "harbor",
    timeline: { id: "sweep", elapsedMs: 40 },
    camera: { x: 40, y: 16, scale: 1.4 },
  });
  expect(preview.snapshot.audioIntents.wind).toMatchObject({ cue: "wind", action: "play", loop: true });
  expect(traceOps(traced)).toEqual([
    "start[0]:set", "start[1]:call", "setup[0]:scene", "setup[1]:audio", "setup[2]:set", "setup[3]:return",
    "start[2]:wait", "start[3]:choice",
  ]);
  expect(preview.steps).toBe(traceOps(traced).length);

  preview.engine.selectChoice("go");
  const resumed = continueNovelContextPreview(preview.engine, target);
  expect(resumed.status).toBe("reached");
  expect(resumed.snapshot).toMatchObject({
    phase: "say",
    active: { kind: "say", id: "target-line", complete: true, visibleText: "The real route is visible." },
    variables: { beforeCall: true, callRan: 7, route: "go" },
    callStack: [],
    stage: { background: "cabin" },
  });

  const oracle = createNovelEngine(contextStory, engineOptions);
  oracle.debug.setBreakpoints([target]);
  oracle.start();
  oracle.tick(40);
  oracle.selectChoice("go");
  expect(oracle.getSnapshot()).toMatchObject({ paused: true, location: target, active: null });
  oracle.debug.setBreakpoints([]);
  oracle.debug.resume();
  oracle.advance();
  expect(preview.engine.save()).toEqual(oracle.save());

  const loaded = createNovelEngine(contextStory, engineOptions);
  loaded.load(preview.engine.save());
  expect(loaded.getSnapshot()).toEqual(preview.engine.getSnapshot());
  expect(loaded.save()).toEqual(preview.engine.save());

  expect(main.save()).toEqual(mainBefore);
  expect(contextStory).toEqual(contextStoryBefore);
  preview.engine.dispose();
  oracle.dispose();
  loaded.dispose();
  main.dispose();
});

test("lists only declared safe roots and validates blueprint metadata against canonical instructions", () => {
  const story: StoryDefinition = {
    id: "context-root-list",
    version: 1,
    start: "main",
    replayEntries: [
      { id: "locked", title: "Locked replay", location: { label: "replay", index: 0 }, unlockEndingId: "unlock" },
    ],
    editor: { blueprint: { version: 1, nodes: {
      entry: { kind: "entry", title: "Entry root" },
      chapter: { kind: "chapter", title: "Chapter root" },
      stale: { kind: "chapter", title: "Stale metadata" },
      wrongShape: { kind: "entry", title: "Not an entry" },
      condition: { kind: "condition", title: "Condition" },
    } } },
    script: {
      main: [{ type: "ending", id: "main-ending" }],
      replay: [{ type: "ending", id: "replay-ending" }],
      unlock: [{ type: "ending", id: "unlock" }],
      entry: [{ type: "jump", target: "main" }],
      chapter: [{ type: "call", target: "chapter-body" }, { type: "jump", target: "main" }],
      "chapter-body": [{ type: "return" }],
      stale: [{ type: "call", target: "chapter-body" }],
      wrongShape: [{ type: "say", id: "not-an-entry", text: "No." }],
      condition: [{ type: "jump", target: "main" }],
    },
  };

  expect(listNovelContextPreviewRoots(story)).toEqual([
    { value: "main", root: { kind: "main" }, location: { label: "main", index: 0 }, title: "故事起点" },
    { value: "replay:locked", root: { kind: "replay", entryId: "locked" }, location: { label: "replay", index: 0 }, title: "Locked replay" },
    { value: "blueprint:entry", root: { kind: "blueprint", label: "entry" }, location: { label: "entry", index: 0 }, title: "Entry root", nodeKind: "entry" },
    { value: "blueprint:chapter", root: { kind: "blueprint", label: "chapter" }, location: { label: "chapter", index: 0 }, title: "Chapter root", nodeKind: "chapter" },
  ]);

  const duplicateReplay: StoryDefinition = {
    ...story,
    replayEntries: [
      { id: "same", title: "First", location: { label: "replay", index: 0 } },
      { id: "same", title: "Second", location: { label: "replay", index: 0 } },
    ],
  };
  expect(listNovelContextPreviewRoots(duplicateReplay).map(option => option.root.kind)).toEqual(["main", "blueprint", "blueprint"]);
  const staleMetadata: StoryDefinition = {
    ...story,
    editor: { blueprint: { version: 1, nodes: { missing: { kind: "entry" } } } },
  };
  expect(listNovelContextPreviewRoots(staleMetadata).map(option => option.root.kind)).toEqual(["main", "replay"]);
});

test("replay context captures entry OPs with breakpoints installed and copies only declared seed fields", () => {
  const story: StoryDefinition = {
    id: "context-replay-root",
    version: 1,
    start: "main",
    variableDefinitions: { score: { lifetime: "save", defaultValue: 0 } },
    replayEntries: [
      { id: "locked-route", title: "Locked route", location: { label: "replay", index: 0 }, unlockEndingId: "proof" },
    ],
    script: {
      main: [
        { type: "scene", background: "main-room" },
        { type: "audio", cue: "main-track", channel: "music", loop: true },
        { type: "call", target: "source-body" },
        { type: "ending", id: "source-finished" },
      ],
      "source-body": [{ type: "say", id: "source-line", text: "Main context." }, { type: "return" }],
      replay: [
        { type: "scene", background: "replay-room" },
        { type: "set", variable: "replayRan", value: true },
        { type: "say", id: "replay-target", text: "Replay context." },
        { type: "ending", id: "replayed" },
      ],
      proof: [{ type: "ending", id: "proof" }],
    },
  };
  const source = createNovelEngine(story, {
    initialVariables: { score: 9 },
    initialMeta: { readLineIds: ["prior"], endingIds: [], cgIds: [], musicIds: [] },
    preferences: { mode: "skip", textSpeedCharsPerSecond: 44, autoDelayMs: 55, skipSeenOnly: true },
  });
  source.start();
  source.advance();
  expect(source.getSnapshot().callStack).toEqual([{ returnTo: { label: "main", index: 3 } }]);
  expect(source.getSnapshot().audioIntents.music).toMatchObject({ cue: "main-track", action: "play", loop: true });
  const sourceBefore = source.getSnapshot();
  const sourceSaveBefore = source.save();
  const traced: NovelExecutionTraceEntry[] = [];
  const targetAddress = { label: "replay", index: 2 };
  const entryBreakpoint = { label: "replay", index: 0 };
  const preview = createNovelContextPreview(story, targetAddress, {
    root: { kind: "replay", entryId: "locked-route", source: sourceBefore },
    breakpoints: [entryBreakpoint],
    onExecutionTrace: entries => traced.push(...entries),
  });

  expect(preview.root).toEqual({ kind: "replay", entryId: "locked-route" });
  expect(preview.rootLocation).toEqual({ label: "replay", index: 0 });
  expect(preview.status).toBe("blocked");
  expect(preview.blocker).toBe("breakpoint");
  expect(preview.snapshot).toMatchObject({ paused: true, location: entryBreakpoint, active: null });
  expect(traced).toEqual([]);

  const reached = continueNovelContextPreview(preview.engine, targetAddress, {
    onExecutionTrace: entries => traced.push(...entries),
  });
  expect(reached.root).toEqual({ kind: "replay", entryId: "locked-route" });
  expect(reached.root).not.toHaveProperty("source");
  expect(reached.rootLocation).toEqual({ label: "replay", index: 0 });
  expect(reached.status).toBe("reached");
  expect(reached.snapshot).toMatchObject({
    paused: false,
    active: { kind: "say", id: "replay-target", complete: true, visibleText: "Replay context." },
    variables: { score: 9, replayRan: true },
    meta: { readLineIds: ["prior"], endingIds: [] },
    preferences: { mode: "manual", textSpeedCharsPerSecond: 44, autoDelayMs: 55, skipSeenOnly: true },
    stage: { background: "replay-room" },
    callStack: [],
  });
  expect(reached.snapshot.audioIntents).toEqual({});
  expect(traced.map(entry => `${entry.location.label}[${entry.location.index}]:${entry.op}`)).toEqual([
    "replay[0]:scene", "replay[1]:set", "replay[2]:say",
  ]);
  expect(reached.snapshot.meta.endingIds).not.toContain("proof");
  expect(source.getSnapshot()).toEqual(sourceBefore);
  expect(source.save()).toEqual(sourceSaveBefore);
  expect(() => createNovelReplayEngine(story, sourceBefore, "locked-route")).toThrow(/locked/);
  preview.engine.dispose();
  source.dispose();
});

test("replay context supports fresh and explicit initial seeds but rejects mixed source seeds", () => {
  const story: StoryDefinition = {
    id: "context-replay-seeds", version: 1, start: "main",
    replayEntries: [{ id: "replay", title: "Replay", location: { label: "replay", index: 0 }, unlockEndingId: "proof" }],
    script: {
      main: [{ type: "ending", id: "main" }],
      replay: [{ type: "say", id: "line", text: "{{seed}}" }, { type: "ending", id: "replayed" }],
      proof: [{ type: "ending", id: "proof" }],
    },
  };
  const targetAddress = { label: "replay", index: 0 };
  const seeded = createNovelContextPreview(story, targetAddress, {
    root: { kind: "replay", entryId: "replay" },
    initialVariables: { seed: "from options" },
  });
  expect(seeded.snapshot.active).toMatchObject({ kind: "say", text: "from options", complete: true });
  expect(seeded.snapshot.meta.endingIds).toEqual([]);
  expect(seeded.root).toEqual({ kind: "replay", entryId: "replay" });
  expect(() => createNovelContextPreview(story, targetAddress, {
    root: { kind: "replay", entryId: "replay", source: seeded.snapshot },
    initialVariables: { seed: "conflict" },
  })).toThrow(/cannot be combined/i);
  seeded.engine.dispose();
});

test("retries a rolled-back non-main bootstrap from its immutable root identity", () => {
  const story: StoryDefinition = {
    id: "context-root-budget-retry", version: 1, start: "main",
    replayEntries: [{ id: "loop-replay", title: "Loop", location: { label: "loop", index: 0 } }],
    editor: { blueprint: { version: 1, nodes: { loopEntry: { kind: "entry" } } } },
    script: {
      main: [{ type: "set", variable: "main_only", value: 99 }, { type: "say", id: "main-target", text: "Main must not run." }],
      loop: [{ type: "inc", variable: "counter", amount: 1 }, { type: "jump", target: "loop" }],
      loopEntry: [{ type: "jump", target: "loop" }],
    },
  };
  const targetAddress = { label: "main", index: 1 };
  for (const root of [
    { kind: "replay", entryId: "loop-replay" } as const,
    { kind: "blueprint", label: "loopEntry" } as const,
  ]) {
    const first = createNovelContextPreview(story, targetAddress, { root, maxStepBudget: 4 });
    expect(first.status).toBe("limit");
    expect(first.snapshot.started).toBe(false);
    expect(first.root.kind).toBe(root.kind);
    (first.root as { kind: string }).kind = "main";
    const resumed = continueNovelContextPreview(first.engine, targetAddress);
    expect(resumed.status).toBe("limit");
    expect(resumed.root).toEqual(root);
    expect(resumed.rootLocation).toEqual(root.kind === "replay"
      ? { label: "loop", index: 0 }
      : { label: "loopEntry", index: 0 });
    expect(resumed.snapshot.started).toBe(false);
    expect(resumed.snapshot.variables.main_only).toBeUndefined();
    expect(resumed.snapshot.active?.kind).not.toBe("say");
    first.engine.dispose();
  }
});

test("blueprint entry and chapter roots use only canonical blueprint entry shapes and fresh state", () => {
  const story: StoryDefinition = {
    id: "context-blueprint-root", version: 1, start: "main",
    editor: { blueprint: { version: 1, nodes: {
      chapterRoot: { kind: "chapter", title: "Chapter root" },
      entryRoot: { kind: "entry", title: "Entry root" },
      staleRoot: { kind: "chapter" },
    } } },
    script: {
      main: [{ type: "scene", background: "main-only" }, { type: "ending", id: "main" }],
      chapterRoot: [{ type: "call", target: "chapterBody" }, { type: "jump", target: "chapterEnd" }],
      chapterBody: [
        { type: "scene", background: "chapter-room" },
        { type: "set", variable: "chapterRan", value: true },
        { type: "say", id: "chapter-line", text: "A fresh chapter." },
        { type: "return" },
      ],
      chapterEnd: [{ type: "ending", id: "chapter-end" }],
      entryRoot: [{ type: "jump", target: "entryChoice" }],
      entryChoice: [{ type: "choice", id: "entry-choice", options: [{ id: "go", text: "Go", target: "entryLine" }] }],
      entryLine: [{ type: "say", id: "entry-line", text: "Entry route." }],
      staleRoot: [{ type: "call", target: "chapterBody" }],
    },
  };
  const chapterTarget = { label: "chapterBody", index: 2 };
  const chapter = createNovelContextPreview(story, chapterTarget, {
    root: { kind: "blueprint", label: "chapterRoot" },
    initialVariables: { explicitSeed: 3 },
  });
  expect(chapter.root).toEqual({ kind: "blueprint", label: "chapterRoot" });
  expect(chapter.status).toBe("reached");
  expect(chapter.snapshot).toMatchObject({
    active: { kind: "say", id: "chapter-line", complete: true },
    variables: { chapterRan: true, explicitSeed: 3 },
    stage: { background: "chapter-room" },
    callStack: [{ returnTo: { label: "chapterRoot", index: 1 } }],
  });
  expect(chapter.snapshot.stage.background).not.toBe("main-only");
  chapter.engine.dispose();

  const entryTarget = { label: "entryChoice", index: 0 };
  const entry = createNovelContextPreview(story, entryTarget, { root: { kind: "blueprint", label: "entryRoot" } });
  expect(entry.status).toBe("reached");
  expect(entry.root).toEqual({ kind: "blueprint", label: "entryRoot" });
  expect(entry.snapshot.active).toMatchObject({ kind: "choice", id: "entry-choice" });
  entry.engine.dispose();

  expect(() => createNovelContextPreview(story, chapterTarget, { root: { kind: "blueprint", label: "staleRoot" } })).toThrow(/eligible blueprint/i);
  expect(() => createNovelContextPreview(story, chapterTarget, { root: { kind: "blueprint", label: "chapterBody" } })).toThrow(/eligible blueprint/i);
});

test("stops for real choices and inputs, then continues only after actual decisions", () => {
  const story: StoryDefinition = {
    id: "context-preview-input",
    version: 1,
    start: "start",
    script: {
      start: [{ type: "choice", id: "gate", options: [
        { id: "write", text: "Write", target: "collect" },
        { id: "finish", text: "Finish", target: "ending" },
      ] }],
      collect: [
        { type: "input", id: "name", variable: "name", inputType: "text", prompt: "Your name?", cancelTarget: "cancelled" },
        { type: "say", id: "named", text: "Hello {{name}}." },
      ],
      ending: [{ type: "ending", id: "finished" }],
      cancelled: [{ type: "ending", id: "cancelled" }],
    },
  };
  const inputTarget = { label: "collect", index: 1 };
  const preview = createNovelContextPreview(story, inputTarget);
  expect(preview.status).toBe("blocked");
  expect(preview.blocker).toBe("choice");
  expect(preview.snapshot.variables.name).toBeUndefined();
  expect(preview.snapshot.active).toMatchObject({ kind: "choice", id: "gate" });

  preview.engine.selectChoice("write");
  const input = continueNovelContextPreview(preview.engine, inputTarget);
  expect(input.status).toBe("blocked");
  expect(input.blocker).toBe("input");
  expect(input.snapshot.active).toMatchObject({ kind: "input", id: "name", draft: "" });
  expect(input.snapshot.variables.name).toBeUndefined();

  preview.engine.updateInput("Ada");
  preview.engine.submitInput();
  const reached = continueNovelContextPreview(preview.engine, inputTarget);
  expect(reached.status).toBe("reached");
  expect(reached.snapshot.variables.name).toBe("Ada");
  expect(reached.snapshot.active).toMatchObject({ kind: "say", id: "named", complete: true, visibleText: "Hello Ada." });
  preview.engine.dispose();

  const earlyEnding = createNovelContextPreview(story, inputTarget);
  earlyEnding.engine.selectChoice("finish");
  const ended = continueNovelContextPreview(earlyEnding.engine, inputTarget);
  expect(ended.status).toBe("ended");
  expect(ended.snapshot.active).toMatchObject({ kind: "ending", id: "finished" });
  earlyEnding.engine.dispose();
});

test("executes a targeted call through the canonical call stack into its real passage", () => {
  const story: StoryDefinition = {
    id: "context-preview-target-call", version: 1, start: "start",
    script: {
      start: [
        { type: "call", target: "chapter" },
        { type: "ending", id: "done" },
      ],
      chapter: [
        { type: "set", variable: "inside", value: true },
        { type: "say", id: "chapter-line", text: "Inside the called chapter." },
        { type: "return" },
      ],
    },
  };
  const preview = createNovelContextPreview(story, { label: "start", index: 0 });
  expect(preview.status).toBe("reached");
  expect(preview.snapshot).toMatchObject({
    phase: "say",
    active: { kind: "say", id: "chapter-line", complete: true },
    variables: { inside: true },
    callStack: [{ returnTo: { label: "start", index: 1 } }],
  });
  preview.engine.dispose();
});

test("keeps an authored target breakpoint after executing that target exactly once", () => {
  const story: StoryDefinition = {
    id: "context-preview-authored-bp", version: 1, start: "start",
    script: {
      start: [{ type: "choice", id: "route", options: [{ id: "go", text: "Go", target: "route" }] }],
      route: [
        { type: "scene", background: "first" },
        { type: "say", id: "first", text: "First" },
        { type: "jump", target: "route" },
      ],
    },
  };
  const authoredTarget = { label: "route", index: 0 };
  const preview = createNovelContextPreview(story, authoredTarget, { breakpoints: [authoredTarget] });
  expect(preview.status).toBe("blocked");
  preview.engine.selectChoice("go");
  const reached = continueNovelContextPreview(preview.engine, authoredTarget);
  expect(reached.status).toBe("reached");
  expect(reached.snapshot.active).toMatchObject({ kind: "say", id: "first", complete: true });

  preview.engine.advance();
  expect(preview.engine.getSnapshot()).toMatchObject({
    paused: true,
    location: authoredTarget,
    active: null,
  });
  preview.engine.dispose();
});

test("executes a nonblocking target once in a self-loop with temporary and authored breakpoints", () => {
  const story: StoryDefinition = {
    id: "context-preview-target-loop", version: 1, start: "loop",
    script: { loop: [
      { type: "inc", variable: "counter", amount: 1 },
      { type: "jump", target: "loop" },
    ] },
  };
  const target = { label: "loop", index: 0 };

  const temporary = createNovelContextPreview(story, target, { maxStepBudget: 16 });
  expect(temporary.status).toBe("reached");
  expect(temporary.steps).toBe(2);
  expect(temporary.snapshot).toMatchObject({
    paused: true,
    location: target,
    variables: { counter: 1 },
  });
  expect(temporary.blocker).toBeUndefined();
  temporary.engine.dispose();

  const authored = createNovelContextPreview(story, target, { maxStepBudget: 16, breakpoints: [target] });
  expect(authored.status).toBe("reached");
  expect(authored.steps).toBe(2);
  expect(authored.snapshot).toMatchObject({
    paused: true,
    location: target,
    variables: { counter: 1 },
  });
  expect(authored.blocker).toBe("breakpoint");
  authored.engine.debug.resume();
  expect(authored.engine.getSnapshot()).toMatchObject({
    paused: true,
    location: target,
    variables: { counter: 2 },
  });
  authored.engine.dispose();
});

test("bounds auto-skip loops and canonical immediate loops without changing the source story", () => {
  const sayLoop: StoryDefinition = {
    id: "context-preview-say-loop", version: 1, start: "loop",
    script: {
      loop: [
        { type: "say", id: "again", text: "Again." },
        { type: "jump", target: "loop" },
      ],
      target: [{ type: "ending", id: "unreachable" }],
    },
  };
  const sayLoopBefore = structuredClone(sayLoop);
  const bounded = createNovelContextPreview(sayLoop, { label: "target", index: 0 }, { maxTransitions: 2 });
  expect(bounded.status).toBe("limit");
  expect(bounded.steps).toBeGreaterThan(0);
  expect(bounded.snapshot.phase).toBe("say");
  expect(sayLoop).toEqual(sayLoopBefore);
  bounded.engine.dispose();

  const immediateLoop: StoryDefinition = {
    id: "context-preview-op-loop", version: 1, start: "loop",
    script: {
      loop: [{ type: "set", variable: "n", value: 1 }, { type: "jump", target: "loop" }],
      unreachable: [{ type: "ending", id: "unreachable" }],
    },
  };
  const immediate = createNovelContextPreview(immediateLoop, { label: "unreachable", index: 0 }, { maxStepBudget: 5 });
  expect(immediate.status).toBe("limit");
  expect(immediate.steps).toBe(0);
  expect(immediate.snapshot).toMatchObject({ started: false, paused: false, location: { label: "loop", index: 0 }, variables: {} });
  immediate.engine.dispose();
});

test("continues a bounded preview after the caller increases its passage budget", () => {
  const story: StoryDefinition = {
    id: "context-preview-continue-limit", version: 1, start: "start",
    script: {
      start: [
        { type: "say", id: "first", text: "First" },
        { type: "say", id: "second", text: "Second" },
        { type: "choice", id: "gate", options: [{ id: "go", text: "Go", target: "target" }] },
      ],
      target: [{ type: "say", id: "target", text: "Reached." }],
    },
  };
  const target = { label: "target", index: 0 };
  const limited = createNovelContextPreview(story, target, { maxTransitions: 1 });
  expect(limited.status).toBe("limit");
  expect(limited.snapshot.active).toMatchObject({ kind: "say", id: "second" });

  const next = continueNovelContextPreview(limited.engine, target, { maxTransitions: 4 });
  expect(next.status).toBe("blocked");
  expect(next.blocker).toBe("choice");
  expect(next.snapshot.active).toMatchObject({ kind: "choice", id: "gate" });
  next.engine.selectChoice("go");
  const reached = continueNovelContextPreview(next.engine, target);
  expect(reached.status).toBe("reached");
  expect(reached.snapshot.active).toMatchObject({ kind: "say", id: "target", complete: true, visibleText: "Reached." });
  reached.engine.dispose();
});

test("continues after an external pause on a prior say whose cursor equals the target", () => {
  const sayStory: StoryDefinition = {
    id: "context-preview-paused-prior-say", version: 1, start: "start",
    script: { start: [
      { type: "say", id: "first", text: "First" },
      { type: "say", id: "prior", text: "Prior to target" },
      { type: "say", id: "target", text: "Target line" },
    ] },
  };
  const sayTarget = { label: "start", index: 2 };
  const pausedSay = createNovelContextPreview(sayStory, sayTarget, { maxTransitions: 1 });
  expect(pausedSay.status).toBe("limit");
  expect(pausedSay.snapshot).toMatchObject({ active: { kind: "say", id: "prior" }, location: sayTarget });
  pausedSay.engine.pause();
  const reachedSay = continueNovelContextPreview(pausedSay.engine, sayTarget);
  expect(reachedSay.status).toBe("reached");
  expect(reachedSay.snapshot).toMatchObject({
    phase: "say",
    active: { kind: "say", id: "target", complete: true, visibleText: "Target line" },
  });
  reachedSay.engine.dispose();
});

test("continues after an external pause on a prior wait whose cursor equals the target", () => {
  const waitStory: StoryDefinition = {
    id: "context-preview-paused-prior-wait", version: 1, start: "start",
    script: { start: [
      { type: "say", id: "first", text: "First" },
      { type: "wait", durationMs: 10 },
      { type: "say", id: "target", text: "After wait" },
    ] },
  };
  const waitTarget = { label: "start", index: 2 };
  const pausedWait = createNovelContextPreview(waitStory, waitTarget, { maxTransitions: 1 });
  expect(pausedWait.status).toBe("limit");
  expect(pausedWait.snapshot).toMatchObject({ active: { kind: "wait", remainingMs: 10 }, location: waitTarget });
  pausedWait.engine.pause();
  const reachedWait = continueNovelContextPreview(pausedWait.engine, waitTarget);
  expect(reachedWait.status).toBe("reached");
  expect(reachedWait.snapshot).toMatchObject({
    phase: "say",
    active: { kind: "say", id: "target", complete: true, visibleText: "After wait" },
  });
  reachedWait.engine.dispose();
});

test("rejects invalid or mismatched targets without mutating stories or live engine state", () => {
  const source = structuredClone(contextStory);
  expect(() => createNovelContextPreview(contextStory, { label: "missing", index: 0 })).toThrow(StoryValidationError);
  expect(contextStory).toEqual(source);

  const preview = createNovelContextPreview(contextStory, target);
  const before = preview.engine.save();
  expect(() => continueNovelContextPreview(preview.engine, { label: "chosen", index: 999 })).toThrow(NovelEngineError);
  expect(preview.engine.save()).toEqual(before);
  preview.engine.dispose();
});
