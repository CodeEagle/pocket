import { NovelEngineError, StepBudgetExceededError, createNovelEngine } from "./engine.ts";
import { novelBlueprintMetadataIssue } from "./blueprint.ts";
import { novelReplayEntriesIssue } from "./replay-schema.ts";
import { createNovelReplaySeedEngine, resolveNovelReplayEntry } from "./replay-internal.ts";
import type {
  EngineSnapshot,
  NovelEngine,
  NovelEngineOptions,
  NovelExecutionTraceListener,
  NovelStoryBlueprintMetadata,
  ScriptPosition,
  StoryDefinition,
  StoryInstruction,
} from "./types.ts";
import type { NovelReplaySource } from "./replay.ts";

/** Maximum number of prior say/wait passages the editor preview skips by default. */
export const NOVEL_CONTEXT_PREVIEW_MAX_TRANSITIONS = 256;

export type NovelContextPreviewStatus = "reached" | "blocked" | "ended" | "limit";
export type NovelContextPreviewBlocker = "choice" | "input" | "breakpoint";

export type NovelContextPreviewRoot =
  | { readonly kind: "main" }
  | { readonly kind: "replay"; readonly entryId: string; readonly source?: NovelReplaySource }
  | { readonly kind: "blueprint"; readonly label: string };

/** Root identity returned by preview helpers. Source snapshots are never retained. */
export type NovelContextPreviewRootIdentity =
  | { readonly kind: "main" }
  | { readonly kind: "replay"; readonly entryId: string }
  | { readonly kind: "blueprint"; readonly label: string };

export interface NovelContextPreviewRootOption {
  /** Stable selector value derived from root kind and declared identity. */
  readonly value: string;
  readonly root: NovelContextPreviewRootIdentity;
  readonly location: ScriptPosition;
  readonly title: string;
  readonly nodeKind?: "entry" | "chapter";
}

/**
 * Bounded editor-preview controls. Engine options seed a fresh canonical engine;
 * a replay source replaces those seed fields and cannot be mixed with them.
 * Breakpoints are the editor's authored breakpoints to preserve after preview.
 */
export interface NovelContextPreviewOptions extends NovelEngineOptions {
  /** Explicit safe start point. Omitted preserves the story-start behavior. */
  readonly root?: NovelContextPreviewRoot;
  /** Maximum prior say passages and timed waits automatically advanced in one call. */
  readonly maxTransitions?: number;
  readonly breakpoints?: readonly ScriptPosition[];
  /** Receives actual committed OP batches only while this helper call is running. */
  readonly onExecutionTrace?: NovelExecutionTraceListener;
}

export interface NovelContextPreviewContinueOptions {
  /** Maximum prior say passages and timed waits automatically advanced in one call. */
  readonly maxTransitions?: number;
  /** Receives actual committed OP batches only while this helper call is running. */
  readonly onExecutionTrace?: NovelExecutionTraceListener;
}

export interface NovelContextPreviewResult {
  /** The isolated canonical engine. Caller owns it and must dispose it. */
  readonly engine: NovelEngine;
  readonly status: NovelContextPreviewStatus;
  readonly snapshot: EngineSnapshot;
  /** Small selected-root identity. Replay source snapshots are never retained. */
  readonly root: NovelContextPreviewRootIdentity;
  /** Actual engine address used to start this reconstruction. */
  readonly rootLocation: ScriptPosition;
  /** Count of actual committed engine OPs observed during this helper call. */
  readonly steps: number;
  /** Present when preview stopped at an unresolved decision or breakpoint. */
  readonly blocker?: NovelContextPreviewBlocker;
}

interface PreviewSession {
  readonly root: NovelContextPreviewRootIdentity;
  readonly rootLocation: ScriptPosition;
  readonly target: ScriptPosition;
  readonly authoredBreakpoints: readonly ScriptPosition[];
  completed: boolean;
}

// Only small root and breakpoint ownership metadata lives here; story
// variables, cursor, call stack and other runtime facts remain solely in the
// canonical engine.
const sessions = new WeakMap<NovelEngine, PreviewSession>();

/**
 * List roots the editor may start from. Replay options require a valid,
 * unambiguous catalog; blueprint options require valid metadata and the exact
 * canonical instruction shapes emitted for entry/chapter nodes.
 */
export function listNovelContextPreviewRoots(story: StoryDefinition): readonly NovelContextPreviewRootOption[] {
  const roots: NovelContextPreviewRootOption[] = [
    { value: "main", root: { kind: "main" }, location: { label: story.start, index: 0 }, title: "故事起点" },
  ];
  if (!isRecord(story) || !isRecord(story.script)) return roots;

  if (novelReplayEntriesIssue(story.replayEntries, story.script) === null) {
    for (const entry of story.replayEntries ?? []) {
      roots.push({
        value: `replay:${encodeURIComponent(entry.id)}`,
        root: { kind: "replay", entryId: entry.id },
        location: copyPosition(entry.location),
        title: entry.title,
      });
    }
  }

  const blueprint = story.editor?.blueprint;
  if (novelBlueprintMetadataIssue(blueprint, story.script) !== null || !isRecord(blueprint) || !isRecord(blueprint.nodes)) {
    return roots;
  }
  const metadata = blueprint as unknown as NovelStoryBlueprintMetadata;
  for (const [label, node] of Object.entries(metadata.nodes)) {
    if ((node.kind !== "entry" && node.kind !== "chapter") || !hasCanonicalBlueprintRoot(story.script, label, node.kind)) continue;
    roots.push({
      value: `blueprint:${encodeURIComponent(label)}`,
      root: { kind: "blueprint", label },
      location: { label, index: 0 },
      title: node.title ?? label,
      nodeKind: node.kind,
    });
  }
  return roots;
}

/**
 * Start an isolated engine at a safe main, declared replay, or validated
 * blueprint root and run its real OP path to target. Earlier dialogue uses an
 * editor preview skip policy (reveal then commit); timed waits advance by
 * their full remaining time through tick(). Choice and input are never
 * selected or fabricated by this helper.
 */
export function createNovelContextPreview(
  story: StoryDefinition,
  target: ScriptPosition,
  options: NovelContextPreviewOptions = {},
): NovelContextPreviewResult {
  const { root: requestedRoot, maxTransitions, breakpoints, onExecutionTrace, ...engineOptions } = options;
  const limit = checkedTransitionLimit(maxTransitions);
  const resolvedRoot = resolveContextPreviewRoot(story, requestedRoot ?? { kind: "main" }, engineOptions);
  const engine = resolvedRoot.createEngine();
  let retained = false;
  try {
    const authoredBreakpoints = copyPositions(breakpoints ?? []);
    const session: PreviewSession = {
      root: resolvedRoot.identity,
      rootLocation: copyPosition(resolvedRoot.location),
      target: copyPosition(target),
      authoredBreakpoints,
      completed: false,
    };
    // The target breakpoint joins the editor's authored set and stays installed
    // across unresolved choices and inputs until this target is reached.
    engine.debug.setBreakpoints(mergePositions(authoredBreakpoints, session.target));
    sessions.set(engine, session);
    const result = driveToTarget(engine, session, limit, onExecutionTrace, false);
    retained = true;
    return result;
  } finally {
    if (!retained) {
      sessions.delete(engine);
      engine.dispose();
    }
  }
}

/**
 * Continue an engine returned by createNovelContextPreview after the caller
 * applies a real choice/input action. The pending target breakpoint is kept.
 */
export function continueNovelContextPreview(
  engine: NovelEngine,
  target: ScriptPosition,
  options: NovelContextPreviewContinueOptions = {},
): NovelContextPreviewResult {
  const session = sessions.get(engine);
  if (!session) throw new NovelEngineError("Novel context preview requires an engine created by createNovelContextPreview");
  if (session.completed) throw new NovelEngineError("Novel context preview has already reached or completed its target");
  if (!samePosition(session.target, target)) throw new NovelEngineError("Novel context preview target does not match the active preview");
  const limit = checkedTransitionLimit(options.maxTransitions);
  return driveToTarget(engine, session, limit, options.onExecutionTrace, true);
}

function driveToTarget(
  engine: NovelEngine,
  session: PreviewSession,
  maxTransitions: number,
  onExecutionTrace: NovelExecutionTraceListener | undefined,
  continuation: boolean,
): NovelContextPreviewResult {
  let steps = 0;
  let transitions = 0;
  const unsubscribe = engine.debug.subscribeExecutionTrace(entries => {
    steps += entries.length;
    onExecutionTrace?.(entries);
  });

  const result = (status: NovelContextPreviewStatus, blocker?: NovelContextPreviewBlocker): NovelContextPreviewResult => ({
    engine,
    root: copyRootIdentity(session.root),
    rootLocation: copyPosition(session.rootLocation),
    status,
    snapshot: engine.getSnapshot(),
    steps,
    ...(blocker === undefined ? {} : { blocker }),
  });
  const stopAtLimit = (): NovelContextPreviewResult => result("limit");

  try {
    let snapshot = engine.getSnapshot();
    if (!snapshot.started) {
      if (session.root.kind === "main") engine.start();
      else {
        engine.debug.jump(session.rootLocation);
        snapshot = engine.getSnapshot();
        if (snapshot.paused && (snapshot.active !== null || !hasPreviewBreakpointAt(session, snapshot.location))) {
          // debug.jump always returns paused. Clear that mechanical pause for
          // blocking passages and terminal addresses that are not real BPs.
          engine.debug.resume();
        }
      }
    } else if (continuation && snapshot.paused
      && (snapshot.active !== null || !samePosition(snapshot.location, session.target))) {
      // Continue through the exact authored breakpoint that previously stopped
      // this preview, or resume an externally paused blocking passage. Active
      // say/wait cursors can equal the target's next address without reaching it.
      engine.debug.resume();
    }

    while (true) {
      snapshot = engine.getSnapshot();

      if (snapshot.paused) {
        if (snapshot.active === null && samePosition(snapshot.location, session.target)) {
          const blocker = executeTargetAndRestoreBreakpoints(engine, session);
          revealCurrentSay(engine);
          session.completed = true;
          return result("reached", blocker);
        }
        return result("blocked", "breakpoint");
      }

      const active = snapshot.active;
      if (active?.kind === "choice") return result("blocked", "choice");
      if (active?.kind === "input") return result("blocked", "input");
      if (active?.kind === "ending") {
        restoreAuthoredBreakpoints(engine, session);
        session.completed = true;
        return result("ended");
      }

      if (active?.kind === "say") {
        if (transitions >= maxTransitions) return stopAtLimit();
        transitions++;
        const beforeLocation = active.location;
        if (!active.complete) engine.advance();
        const afterReveal = engine.getSnapshot();
        const sameActiveLine = afterReveal.active?.kind === "say"
          && samePosition(afterReveal.active.location, beforeLocation)
          && afterReveal.active.complete;
        if (sameActiveLine && !afterReveal.paused) engine.advance();
        continue;
      }

      if (active?.kind === "wait") {
        if (transitions >= maxTransitions) return stopAtLimit();
        transitions++;
        // A wait is real virtual time: tick exactly the remaining duration so
        // stage transitions, timelines and their cue crossings advance too.
        engine.tick(active.remainingMs);
        continue;
      }

      if (snapshot.started) {
        restoreAuthoredBreakpoints(engine, session);
        session.completed = true;
        return result("ended");
      }
      return result("blocked", "breakpoint");
    }
  } catch (error) {
    if (error instanceof StepBudgetExceededError) return stopAtLimit();
    throw error;
  } finally {
    unsubscribe?.();
  }
}

function executeTargetAndRestoreBreakpoints(engine: NovelEngine, session: PreviewSession): NovelContextPreviewBlocker | undefined {
  // Keep the target installed during canonical execution. A nonblocking
  // self-loop then stops at its next real visit instead of running to budget.
  engine.debug.resume();
  const snapshot = engine.getSnapshot();
  const authoredBreakpoint = snapshot.paused && samePositionIn(session.authoredBreakpoints, snapshot.location);
  // Removing only the temporary target also preserves a still-active authored
  // breakpoint stop key when the next boundary was authored by the editor.
  restoreAuthoredBreakpoints(engine, session);
  return authoredBreakpoint ? "breakpoint" : undefined;
}

function restoreAuthoredBreakpoints(engine: NovelEngine, session: PreviewSession): void {
  engine.debug.setBreakpoints(session.authoredBreakpoints);
}

function revealCurrentSay(engine: NovelEngine): void {
  const active = engine.getSnapshot().active;
  if (active?.kind === "say" && !active.complete && !engine.getSnapshot().paused) {
    // The editor preview shows a reached line immediately but leaves it active
    // and uncommitted, so normal play can still advance it later.
    engine.advance();
  }
}

function checkedTransitionLimit(value: number | undefined): number {
  const limit = value ?? NOVEL_CONTEXT_PREVIEW_MAX_TRANSITIONS;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("maxTransitions must be a positive safe integer");
  return limit;
}

function copyPosition(position: ScriptPosition): ScriptPosition {
  return { label: position.label, index: position.index };
}

function copyPositions(positions: readonly ScriptPosition[]): readonly ScriptPosition[] {
  return positions.map(copyPosition);
}

function mergePositions(positions: readonly ScriptPosition[], target: ScriptPosition): readonly ScriptPosition[] {
  return samePositionIn(positions, target) ? positions : [...positions, target];
}

function samePositionIn(positions: readonly ScriptPosition[], target: ScriptPosition): boolean {
  return positions.some(position => samePosition(position, target));
}

function samePosition(left: ScriptPosition, right: ScriptPosition): boolean {
  return left.label === right.label && left.index === right.index;
}

function resolveContextPreviewRoot(
  story: StoryDefinition,
  root: NovelContextPreviewRoot,
  engineOptions: NovelEngineOptions,
): {
  readonly identity: NovelContextPreviewRootIdentity;
  readonly location: ScriptPosition;
  readonly createEngine: () => NovelEngine;
} {
  switch (root.kind) {
    case "main":
      return {
        identity: { kind: "main" },
        location: { label: story.start, index: 0 },
        createEngine: () => createNovelEngine(story, engineOptions),
      };
    case "replay": {
      const entry = resolveNovelReplayEntry(story, root.entryId);
      const identity: NovelContextPreviewRootIdentity = { kind: "replay", entryId: entry.id };
      if (root.source === undefined) {
        return {
          identity,
          location: copyPosition(entry.location),
          createEngine: () => createNovelEngine(story, engineOptions),
        };
      }
      if (engineOptions.initialVariables !== undefined || engineOptions.initialMeta !== undefined || engineOptions.preferences !== undefined) {
        throw new NovelEngineError("A replay source cannot be combined with initialVariables, initialMeta, or preferences");
      }
      return {
        identity,
        location: copyPosition(entry.location),
        createEngine: () => createNovelReplaySeedEngine(story, root.source!, engineOptions),
      };
    }
    case "blueprint": {
      const option = listNovelContextPreviewRoots(story).find(candidate => candidate.root.kind === "blueprint" && candidate.root.label === root.label);
      if (!option || option.root.kind !== "blueprint") {
        throw new NovelEngineError(`Blueprint root '${root.label}' is not an eligible blueprint entry`);
      }
      const location = copyPosition(option.location);
      return {
        identity: { kind: "blueprint", label: root.label },
        location,
        createEngine: () => createNovelEngine(story, engineOptions),
      };
    }
    default:
      throw new NovelEngineError("Novel context preview root must be main, replay, or blueprint");
  }
}

function hasPreviewBreakpointAt(session: PreviewSession, position: ScriptPosition): boolean {
  return samePosition(position, session.target) || samePositionIn(session.authoredBreakpoints, position);
}

function copyRootIdentity(root: NovelContextPreviewRootIdentity): NovelContextPreviewRootIdentity {
  switch (root.kind) {
    case "main": return { kind: "main" };
    case "replay": return { kind: "replay", entryId: root.entryId };
    case "blueprint": return { kind: "blueprint", label: root.label };
  }
}

function hasCanonicalBlueprintRoot(
  script: StoryDefinition["script"],
  label: string,
  kind: "entry" | "chapter",
): boolean {
  if (label.trim().length === 0 || !Object.hasOwn(script, label)) return false;
  const instructions = script[label] as readonly StoryInstruction[] | undefined;
  if (!Array.isArray(instructions)) return false;
  if (kind === "entry") {
    return instructions.length === 1
      && instructions[0]?.type === "jump"
      && isValidScriptTarget(script, instructions[0].target);
  }
  return instructions.length === 2
    && instructions[0]?.type === "call"
    && isValidScriptTarget(script, instructions[0].target)
    && instructions[1]?.type === "jump"
    && isValidScriptTarget(script, instructions[1].target);
}

function isValidScriptTarget(script: StoryDefinition["script"], target: string): boolean {
  return target.trim().length > 0 && Object.hasOwn(script, target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
