import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  type DrawOp,
  type Frame,
  type NativeArtifacts,
} from "./native_session.ts";

const storyId = "demo.lantern.misty-last-letter";
const autosaveKey = "lantern.slot.auto";
const guestDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
const sourceStoryPath = resolve(import.meta.dir, "../apps/lantern/story.json");
process.env.POCKET_DIALOGUE_BOUNDS_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
process.env.POCKET_DIALOGUE_BOUNDS_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
process.env.POCKET_DIALOGUE_BOUNDS_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");

const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_DIALOGUE_BOUNDS");
const story = JSON.parse(readFileSync(sourceStoryPath, "utf8")) as {
  id?: string;
  start?: string;
  script?: Record<string, Instruction[]>;
};
type Instruction = {
  type?: string;
  id?: string;
  text?: string;
  speaker?: string;
  presentation?: string;
  options?: Array<{ id: string; text: string }>;
};
type ChoiceOption = { id: string; target: string; text: string };
type Rect = { x: number; y: number; w: number; h: number };
type BoundsObservation = {
  lineId: string;
  viewport: { width: number; height: number };
  speakerText: string;
  sourceText: string;
  paintedText: string;
  sourcePaintedMatch: boolean;
  sourceCodepoints: number;
  paintedNonWhitespaceCodepoints: number;
  wrappedLines: number;
  speakerRect: Rect;
  textRect: Rect;
  contentClip: Rect;
  continueRect: Rect;
  toolbarTop: number;
};
const boundsObservations: BoundsObservation[] = [];

assert.equal(story.id, storyId, "dialogue bounds must use the compiled Lantern story");
assert.ok(story.script, "Lantern source story must retain its route instructions");

function compact(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function allInstructions(): Instruction[] {
  return Object.values(story.script ?? {}).flat();
}

function sayInstruction(id: string): Instruction {
  const line = allInstructions().find(item => item.type === "say" && item.id === id);
  assert.ok(line?.text, `source story must provide dialogue ${id}`);
  return line!;
}

const ordinaryDialogue = allInstructions().filter(item => item.type === "say"
  && item.text && /[\u3400-\u9fff]/u.test(item.text)
  && (item.presentation === undefined || item.presentation === "dialogue"));
const longestOrdinaryDialogue = ordinaryDialogue.slice().sort((a, b) =>
  Array.from(b.text ?? "").length - Array.from(a.text ?? "").length)[0];
const openingLines = (story.script?.[story.start ?? "start"] ?? []).filter(item => item.type === "say"
  && item.text && /[\u3400-\u9fff]/u.test(item.text)
  && (item.presentation === undefined || item.presentation === "dialogue"));
const longestOpeningLine = openingLines.slice().sort((a, b) =>
  Array.from(b.text ?? "").length - Array.from(a.text ?? "").length)[0];

assert.equal(longestOrdinaryDialogue?.id, "timeout_01",
  "the actual timeout branch must remain the longest ordinary Chinese dialogue passage");
assert.equal(longestOpeningLine?.id, "arrival_05",
  "the actual opening route's longest ordinary passage must stay under bounds coverage");
assert.equal(sayInstruction("arrival_05").presentation, undefined,
  "opening passage coverage must exercise ordinary dialogue presentation");
assert.equal(sayInstruction("timeout_01").presentation, undefined,
  "longest passage coverage must exercise ordinary dialogue presentation, not fullscreen letter mode");

function currentSave(session: NativeSession): Record<string, any> | undefined {
  return session.storage[autosaveKey] as Record<string, any> | undefined;
}

function active(session: NativeSession): Record<string, any> | null {
  return (currentSave(session)?.state?.active as Record<string, any> | null) ?? null;
}

function sourceText(id: string): string {
  return sayInstruction(id).text!;
}

function rectOf(op: DrawOp): Rect | undefined {
  if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return undefined;
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h! };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

function clipOf(op: DrawOp, frame: Frame): Rect | undefined {
  if (!op.clip || typeof frame.width !== "number" || typeof frame.height !== "number") return undefined;
  return {
    x: op.clip.x ?? 0,
    y: op.clip.y ?? 0,
    w: op.clip.w ?? frame.width,
    h: op.clip.h ?? frame.height,
  };
}

function visibleCenter(op: DrawOp, frame: Frame): { x: number; y: number } | undefined {
  const rect = rectOf(op);
  if (!rect || typeof frame.width !== "number" || typeof frame.height !== "number") return undefined;
  const viewport = { x: 0, y: 0, w: frame.width, h: frame.height };
  const clipped = op.clip ? intersect(rect, clipOf(op, frame)!) : rect;
  const visible = clipped && intersect(clipped, viewport);
  if (!visible) return undefined;
  const point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  return point.x >= visible.x && point.x <= visible.x + visible.w
    && point.y >= visible.y && point.y <= visible.y + visible.h ? point : undefined;
}

function playerAction(frame: Frame, action: "reveal" | "continue"): DrawOp | undefined {
  const label = action === "reveal" ? "轻触显全" : "轻触继续";
  return (frame.ops ?? []).find(op => op.type === "text"
    && compact(op.text ?? "").includes(compact(label))
    && (op.color === undefined || ((op.color >>> 24) & 0xff) > 0)
    && visibleCenter(op, frame) !== undefined);
}

async function waitForSay(session: NativeSession, initial: Frame, id: string, maxFrames = 900): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    if (active(session)?.kind === "say" && active(session)?.id === id) return frame;
    frame = await session.frame();
  }
  throw new Error(`Lantern did not reach dialogue ${id}; active=${JSON.stringify(active(session))}; painted=${textOf(frame)}`);
}

async function waitForPlayerAction(
  session: NativeSession,
  initial: Frame,
  action: "reveal" | "continue",
  maxFrames = 120,
): Promise<{ frame: Frame; op: DrawOp }> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    const op = playerAction(frame, action);
    if (op) return { frame, op };
    frame = await session.frame();
  }
  throw new Error(`visible ${action} action never painted: ${textOf(frame)}`);
}

async function waitForAnyPlayerAction(
  session: NativeSession,
  initial: Frame,
  maxFrames = 120,
): Promise<{ frame: Frame; action: "reveal" | "continue"; op: DrawOp }> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    const reveal = playerAction(frame, "reveal");
    if (reveal) return { frame, action: "reveal", op: reveal };
    const next = playerAction(frame, "continue");
    if (next) return { frame, action: "continue", op: next };
    frame = await session.frame();
  }
  throw new Error(`no visible reveal or Continue action painted: ${textOf(frame)}`);
}

async function advanceSay(session: NativeSession, initial: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected dialogue before input, got ${JSON.stringify(before)}`);
  const id = String(before!.id);
  let { frame, action, op } = await waitForAnyPlayerAction(session, initial);
  frame = await session.tapPoint(center(op, `visible action for ${id}`));
  frame = await session.settle(frame, 1);
  if (action === "reveal" && active(session)?.kind === "say" && active(session)?.id === id) {
    const action = await waitForPlayerAction(session, frame, "continue");
    frame = await session.tapPoint(center(action.op, `visible Continue for ${id}`));
    frame = await session.settle(frame, 1);
  }
  for (let index = 0; index < 120; index += 1) {
    if (active(session)?.id !== id) return frame;
    frame = await session.frame();
  }
  throw new Error(`real pointer input did not advance dialogue ${id}; active=${JSON.stringify(active(session))}; painted=${textOf(frame)}`);
}

function fullDialogueOp(frame: Frame, text: string): DrawOp | undefined {
  const expected = compact(text);
  return (frame.ops ?? []).find(op => op.type === "text" && typeof op.text === "string"
    && compact(op.text) === expected
    && (op.color === undefined || ((op.color >>> 24) & 0xff) > 0));
}

function assertDialogueBounds(frame: Frame, session: NativeSession, id: string, minimumCodepoints = 70): DrawOp {
  const expected = sourceText(id);
  const body = fullDialogueOp(frame, expected);
  assert.ok(body, `${id} must paint its complete source text after a real reveal; painted=${textOf(frame)}`);
  const rect = rectOf(body!);
  const clip = clipOf(body!, frame);
  assert.ok(rect && clip, `${id} must expose native text bounds and its dialogue content clip`);
  assert.ok(Array.from(expected).length >= minimumCodepoints, `${id} must retain its Chinese dialogue length`);
  const lines = String(body!.text).split(/\r?\n/);
  assert.ok(lines.length > 1, `${id} must wrap into multiple painted lines at ${session.width}×${session.height}`);
  assert.ok(lines.every(line => line.trim().length > 0), `${id} must not hide source text in empty or clipped lines`);

  const viewport = { x: 0, y: 0, w: frame.width!, h: frame.height! };
  const layout = createNovelViewportLayout({ width: session.width, height: session.height }, {
    top: 0, right: 0, bottom: 0, left: 0,
  });
  const toolbarTop = frame.height! - layout.toolbarHeight;
  assert.ok(clip!.w > 0 && clip!.h > 0 && clip!.w < viewport.w && clip!.h < viewport.h,
    `${id} must use the bounded dialogue content clip, not a fullscreen page clip: ${JSON.stringify(clip)}`);
  assert.ok(clip!.x >= layout.insetL + layout.dialogueLeft - 2
    && clip!.x + clip!.w <= layout.insetL + layout.dialogueLeft + layout.dialogueWidth + 2,
  `${id} clip must stay inside the authored dialogue panel: ${JSON.stringify({ clip, layout })}`);
  assert.ok(clip!.x >= 0 && clip!.y >= 0 && clip!.x + clip!.w <= viewport.w + 1
    && clip!.y + clip!.h <= toolbarTop + 1,
  `${id} dialogue content clip must remain on screen and above the toolbar: ${JSON.stringify({ clip, toolbarTop })}`);
  assert.ok(rect!.x >= clip!.x - 1 && rect!.y >= clip!.y - 1
    && rect!.x + rect!.w <= clip!.x + clip!.w + 1
    && rect!.y + rect!.h <= clip!.y + clip!.h + 1,
  `${id} full painted text must fit within its real content clip without hidden tail lines: ${JSON.stringify({ rect, clip, lines: lines.length })}`);

  const continueOp = playerAction(frame, "continue");
  assert.ok(continueOp, `${id} must expose a visible Continue action after full reveal`);
  const continueRect = rectOf(continueOp!);
  assert.ok(continueRect && continueRect.y + continueRect.h <= toolbarTop + 1,
    `${id} Continue action must be visibly above the player toolbar: ${JSON.stringify({ continueRect, toolbarTop })}`);
  const speakerText = sayInstruction(id).speaker ?? "雾港纪事";
  const speakerOp = (frame.ops ?? []).find(op => op.type === "text"
    && compact(op.text ?? "") === compact(speakerText)
    && (op.color === undefined || ((op.color >>> 24) & 0xff) > 0)
    && visibleCenter(op, frame) !== undefined);
  assert.ok(speakerOp, `${id} must paint its actual ${speakerText} speaker label`);
  const speakerRect = rectOf(speakerOp!);
  assert.ok(speakerRect && speakerRect.y + speakerRect.h < rect!.y
    && speakerRect.x >= 0 && speakerRect.x + speakerRect.w <= viewport.w + 1,
  `${id} speaker label must remain separately visible above its body text: ${JSON.stringify({ speakerText, speakerRect, textRect: rect })}`);
  boundsObservations.push({
    lineId: id,
    viewport: { width: frame.width!, height: frame.height! },
    speakerText,
    sourceText: expected,
    paintedText: String(body!.text),
    sourcePaintedMatch: compact(String(body!.text)) === compact(expected),
    sourceCodepoints: Array.from(expected).length,
    paintedNonWhitespaceCodepoints: Array.from(compact(String(body!.text))).length,
    wrappedLines: lines.length,
    speakerRect: speakerRect!,
    textRect: rect!,
    contentClip: clip!,
    continueRect: continueRect!,
    toolbarTop,
  });
  return continueOp!;
}

async function revealAndAssert(session: NativeSession, initial: Frame, id: string, minimumCodepoints = 70): Promise<{ frame: Frame; continueOp: DrawOp }> {
  let frame = initial;
  assert.equal(active(session)?.id, id, `source route must reach ${id} as the actual active dialogue`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body = fullDialogueOp(frame, sourceText(id));
    if (body) return { frame, continueOp: assertDialogueBounds(frame, session, id, minimumCodepoints) };
    const reveal = playerAction(frame, "reveal");
    if (reveal) {
      frame = await session.tapPoint(center(reveal, `real reveal input for ${id}`));
      frame = await session.settle(frame, 1);
      assert.equal(active(session)?.id, id, `revealing ${id} must not advance to a different story line`);
    } else {
      frame = await session.frame();
    }
  }
  const waited = await waitForSay(session, frame, id, 30);
  const body = fullDialogueOp(waited, sourceText(id));
  assert.ok(body, `${id} did not expose its full rendered text after a real reveal: ${textOf(waited)}`);
  return { frame: waited, continueOp: assertDialogueBounds(waited, session, id, minimumCodepoints) };
}

async function tapContinueAndAssertProgress(session: NativeSession, frame: Frame, id: string, op?: DrawOp): Promise<Frame> {
  const action = op ?? (await waitForPlayerAction(session, frame, "continue")).op;
  frame = await session.tapPoint(center(action, `actual Continue pointer for ${id}`));
  frame = await session.settle(frame, 1);
  for (let index = 0; index < 120; index += 1) {
    if (active(session)?.id !== id) return frame;
    frame = await session.frame();
  }
  throw new Error(`tapping the painted Continue action did not advance ${id}; painted=${textOf(frame)}`);
}

async function driveToSay(session: NativeSession, initial: Frame, id: string, maxInstructions = 100): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxInstructions; index += 1) {
    const current = active(session);
    if (current?.kind === "say" && current.id === id) return frame;
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else if (current?.kind === "choice") throw new Error(`route reached choice ${current.id} before dialogue ${id}`);
    else if (current?.kind === "ending") throw new Error(`route ended at ${current.id} before dialogue ${id}`);
    else frame = await session.frame();
  }
  throw new Error(`real pointer route did not reach ${id}; active=${JSON.stringify(active(session))}`);
}

async function driveToChoice(session: NativeSession, initial: Frame, id: string, maxInstructions = 200): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxInstructions; index += 1) {
    const current = active(session);
    if (current?.kind === "choice") {
      assert.equal(current.id, id, `expected route choice ${id}, reached ${current.id}`);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else if (current?.kind === "ending") throw new Error(`route reached ending ${current.id} before choice ${id}`);
    else frame = await session.frame();
  }
  throw new Error(`real pointer route did not reach choice ${id}; active=${JSON.stringify(active(session))}`);
}

function choiceOption(session: NativeSession, idOrTarget: string): ChoiceOption {
  const choice = active(session);
  assert.equal(choice?.kind, "choice", `expected a live route choice before selecting ${idOrTarget}`);
  const option = (choice!.options as ChoiceOption[]).find(value => value.id === idOrTarget || value.target === idOrTarget);
  assert.ok(option, `actual route choice ${choice!.id} must offer ${idOrTarget}`);
  return option!;
}

async function chooseOption(session: NativeSession, initial: Frame, idOrTarget: string): Promise<Frame> {
  const option = choiceOption(session, idOrTarget);
  const wanted = compact(option.text);
  let frame = initial;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string"
      && (op.color === undefined || ((op.color >>> 24) & 0xff) >= 250)
      && visibleCenter(op, frame) !== undefined
      && wanted.startsWith(compact(op.text)) && compact(op.text).length >= 2);
    const painted = candidates.sort((a, b) => compact(b.text ?? "").length - compact(a.text ?? "").length)[0];
    if (painted) {
      frame = await session.tapPoint(center(painted, `visible route option ${option.id}`));
      return session.settle(frame, 2);
    }
    frame = await session.frame();
  }
  throw new Error(`actual choice option ${option.id} never became visibly tappable: ${textOf(frame)}`);
}

async function checkLineAndContinue(session: NativeSession, frame: Frame, id: string, minimumCodepoints = 70): Promise<Frame> {
  const measured = await revealAndAssert(session, frame, id, minimumCodepoints);
  return tapContinueAndAssertProgress(session, measured.frame, id, measured.continueOp);
}

async function selectChoice(session: NativeSession, frame: Frame, choiceId: string, optionIdOrTarget: string): Promise<Frame> {
  frame = await driveToChoice(session, frame, choiceId);
  return chooseOption(session, frame, optionIdOrTarget);
}

async function selectChoices(
  session: NativeSession,
  frame: Frame,
  route: readonly (readonly [choiceId: string, optionIdOrTarget: string])[],
): Promise<Frame> {
  for (const [choiceId, optionIdOrTarget] of route) {
    frame = await selectChoice(session, frame, choiceId, optionIdOrTarget);
  }
  return frame;
}

async function startNewGame(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await session.tap("再写一封信", frame);
  frame = await session.settle(frame, 2);
  return waitForSay(session, frame, "arrival_01");
}

async function reachSignalWindowChoice(session: NativeSession, initial: Frame): Promise<Frame> {
  const frame = await selectChoices(session, initial, [
    ["arrival_approach", "check_seal"], ["investigation_hub", "signal_window"],
  ]);
  return driveToChoice(session, frame, "signal_window");
}

async function finishFromCurrentState(session: NativeSession, initial: Frame, endingId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 400; index += 1) {
    const current = active(session);
    if (current?.kind === "ending") {
      assert.equal(current.id, endingId);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else if (current?.kind === "choice") throw new Error(`unexpected choice ${current.id} while finishing ${endingId}`);
    else frame = await session.frame();
  }
  throw new Error(`did not finish at ${endingId}; active=${JSON.stringify(active(session))}`);
}

async function reachTrueEnding(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = await selectChoices(session, initial, [
    ["arrival_approach", "listen_mira"], ["memory_response", "trust_mira"],
    ["investigation_hub", "archive_entry"], ["archive_read", "archive_route"],
    ["investigation_hub", "clock_entry"], ["clock_test", "clock_single"],
    ["investigation_hub", "roof_entry"], ["roof_inspection", "roof_log"],
    ["investigation_hub", "relay_entry"], ["relay_open", "open_dial"],
    ["dial_one", "route_7"], ["dial_two", "pulse_1"], ["dial_three", "minute_4"],
  ]);
  for (const id of ["dial_success_01", "dial_success_02", "dial_success_03"]) {
    frame = await driveToSay(session, frame, id);
    frame = await advanceSay(session, frame);
  }
  frame = await selectChoices(session, frame, [["memory_repeat_response", "affirm_mira"]]);
  for (const id of ["window_01", "window_02"]) {
    frame = await driveToSay(session, frame, id);
    frame = await advanceSay(session, frame);
  }
  frame = await selectChoices(session, frame, [["signal_window", "send_truth"]]);
  frame = await driveToSay(session, frame, "truth_04");
  frame = await checkLineAndContinue(session, frame, "truth_04");
  return finishFromCurrentState(session, frame, "truth_letter");
}

async function runViewport(width: number, height: number): Promise<void> {
  const session = new NativeSession(artifacts, { width, height, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    assert.equal(frame.width, width);
    assert.equal(frame.height, height);
    assert.match(textOf(frame), /雾港末班信/);

    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 2);
    frame = await waitForSay(session, frame, "arrival_01");
    frame = await driveToSay(session, frame, "arrival_02");
    frame = await checkLineAndContinue(session, frame, "arrival_02", 45);
    frame = await driveToSay(session, frame, "arrival_03");
    frame = await checkLineAndContinue(session, frame, "arrival_03", 60);
    frame = await driveToSay(session, frame, "arrival_05");
    frame = await checkLineAndContinue(session, frame, "arrival_05");

    // Short real path exercises the globally longest ordinary Chinese say and its timed timeout.
    frame = await reachSignalWindowChoice(session, frame);
    frame = await waitForSay(session, frame, "timeout_01", 1_120);
    frame = await checkLineAndContinue(session, frame, "timeout_01");
    frame = await finishFromCurrentState(session, frame, "last_train");

    // Reuse the existing true-ending evidence and relay-code route; no save or engine state is injected.
    frame = await startNewGame(session, frame);
    frame = await reachTrueEnding(session, frame);

    // The same live Guest then takes the direct train ending branch.
    frame = await startNewGame(session, frame);
    frame = await reachSignalWindowChoice(session, frame);
    frame = await chooseOption(session, frame, "send_train");
    frame = await driveToSay(session, frame, "train_01");
    frame = await checkLineAndContinue(session, frame, "train_01");
    frame = await finishFromCurrentState(session, frame, "last_train");

    // Finally use the real shelter choice and finish its branch as well.
    frame = await startNewGame(session, frame);
    frame = await reachSignalWindowChoice(session, frame);
    frame = await chooseOption(session, frame, "keep_light");
    frame = await driveToSay(session, frame, "shelter_01");
    frame = await checkLineAndContinue(session, frame, "shelter_01");
    frame = await finishFromCurrentState(session, frame, "keep_the_light");

    console.log(`novel_dialogue_bounds_native: ${width}×${height} completed timeout, truth, train and shelter routes with visible pointer input`);
    await session.quit();
  } finally {
    session.forceKill();
  }
}

test("native Lantern dialogue bounds keep long Chinese passages visible and Continue tappable", async () => {
  await runViewport(329, 600);
  await runViewport(1280, 900);
  assert.equal(boundsObservations.length, 14, "seven source passages must be recorded at both native viewports");
  assert.ok(boundsObservations.every(item => item.sourcePaintedMatch), "each complete Guest-painted line must match its source line");
  console.log(`novel_dialogue_bounds_native: geometry=${JSON.stringify(boundsObservations)}`);
  const testPath = resolve(import.meta.dir, "novel_dialogue_bounds_native.test.ts");
  console.log(`novel_dialogue_bounds_native: runtimeAbi=${artifacts.runtimeAbi}; guest=${artifacts.bytecodePath} sha256=${sha256(artifacts.bytecodePath)}; pak=${artifacts.pakPath} sha256=${sha256(artifacts.pakPath)}; metadata=${artifacts.metadataPath} sha256=${sha256(artifacts.metadataPath)}; test=${testPath} sha256=${sha256(testPath)}`);
}, 360_000);
