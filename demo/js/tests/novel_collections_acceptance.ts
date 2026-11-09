import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  NativeSession,
  center,
  textOf,
  type DrawOp,
  type Frame,
  type NativeArtifacts,
} from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
export const collectionsFixture = resolve(import.meta.dir, "fixtures/novel-collections");
export const collectionsAutoSaveKey = "collections.slot.auto";
export const lockedManualSlotId = "quick";

export type NovelCollectionsExpectation = {
  collectionTitle: string;
  publicTitle: string;
  publicBody: string;
  privateTitle: string;
  privateBody: string;
  portraitAsset: string;
};

/** Copy the static acceptance project and bind its package links to this checkout. */
export function materializeNovelCollectionsFixture(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  cpSync(collectionsFixture, projectRoot, { recursive: true });
  const sdkRoot = join(repositoryRoot, "sdk");
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
    name: "pocket-vn-collections-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
      "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
    },
  }, null, 2));
}

function normalize(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

function hasVisibleText(frame: Frame, expected: string): boolean {
  return normalize(textOf(frame)).includes(normalize(expected));
}

function matchingTextOp(frame: Frame, label: string): DrawOp | undefined {
  const target = normalize(label);
  const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string");
  return candidates.find(op => normalize(op.text!) === target)
    ?? candidates.find(op => normalize(op.text!).includes(target))
    ?? candidates.find(op => target.includes(normalize(op.text!)) && normalize(op.text!).length >= 2);
}

async function waitForText(session: NativeSession, initial: Frame, expected: string, maxFrames = 40): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index++) {
    if (hasVisibleText(frame, expected)) return frame;
    frame = await session.frame();
  }
  throw new Error(`Native collections flow did not paint ${JSON.stringify(expected)}; last frame:\n${textOf(frame)}`);
}

async function scrollUntilText(session: NativeSession, initial: Frame, expected: string, maxDrags = 5): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxDrags && !hasVisibleText(frame, expected); index++) {
    frame = await session.drag({ x: 300, y: 560 }, { x: 300, y: 300 }, 4);
    frame = await session.settle(frame, 1);
  }
  if (!hasVisibleText(frame, expected)) {
    const painted = (frame.ops ?? []).filter(op => op.type === "text").map(op => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h }));
    throw new Error(`Native scroll did not reveal ${JSON.stringify(expected)}; painted=${JSON.stringify(painted)}`);
  }
  return frame;
}

async function tapText(session: NativeSession, frame: Frame, label: string): Promise<Frame> {
  const op = matchingTextOp(frame, label);
  assert.ok(op, `cannot tap visible text ${JSON.stringify(label)}; frame:\n${textOf(frame)}`);
  return session.tapPoint(center(op!, label));
}

function portraitDrawn(frame: Frame, path: string): boolean {
  return (frame.ops ?? []).some(op => op.type === "image" && (op as DrawOp & { asset?: string }).asset === path);
}

function assertLocked(frame: Frame, expected: NovelCollectionsExpectation, reason: string): void {
  const visible = normalize(textOf(frame));
  assert.ok(visible.includes(normalize(expected.privateTitle)), `${reason}: locked title remains listed; frame=${textOf(frame)}`);
  assert.ok(visible.includes(normalize("尚未解锁，继续旅程后再来看看")), `${reason}: lock explanation is absent; frame=${textOf(frame)}`);
  assert.ok(!visible.includes(normalize(expected.privateBody)), `${reason}: locked body leaked into the list; frame=${textOf(frame)}`);
  assert.equal(portraitDrawn(frame, expected.portraitAsset), false, `${reason}: locked portrait was drawn`);
}

function assertPublicList(frame: Frame, expected: NovelCollectionsExpectation, reason: string): void {
  const visible = normalize(textOf(frame));
  assert.ok(visible.includes(normalize(expected.collectionTitle)), `${reason}: collection heading is absent; frame=${textOf(frame)}`);
  assert.ok(visible.includes(normalize(expected.publicTitle)), `${reason}: public entry is absent; frame=${textOf(frame)}`);
  assert.ok(!visible.includes(normalize(expected.publicBody)), `${reason}: public body appeared without selecting its entry`);
  assert.ok(!visible.includes(normalize(expected.privateBody)), `${reason}: private body leaked into the list`);
  assert.equal(portraitDrawn(frame, expected.portraitAsset), false, `${reason}: an unselected entry portrait was drawn`);
}

async function openCollectionsFromTitle(session: NativeSession, frame: Frame, expected: NovelCollectionsExpectation): Promise<Frame> {
  if (!hasVisibleText(frame, "旅人档案")) frame = await scrollUntilText(session, frame, "旅人档案");
  frame = await tapText(session, frame, "旅人档案");
  return waitForText(session, frame, expected.collectionTitle);
}

async function openCollectionsFromGame(session: NativeSession, frame: Frame, expected: NovelCollectionsExpectation): Promise<Frame> {
  frame = await tapText(session, frame, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  if (!hasVisibleText(frame, "旅人档案")) frame = await scrollUntilText(session, frame, "旅人档案");
  frame = await tapText(session, frame, "旅人档案");
  frame = await waitForText(session, frame, expected.collectionTitle);
  if (!hasVisibleText(frame, expected.privateTitle)) frame = await scrollUntilText(session, frame, expected.privateTitle);
  return frame;
}

type InputFacts = { id: string; editingSession: string; revision: number; jsRevision: number };

function inputFacts(frame: Frame): InputFacts | undefined {
  const opened = (frame.events ?? []).find(event => event.name === "textInput.open" && event.payload?.id);
  if (!opened?.payload) return undefined;
  return {
    id: String(opened.payload.id),
    editingSession: String(opened.payload.editingSession),
    revision: Number(opened.payload.revision),
    jsRevision: Number(opened.payload.jsRevision),
  };
}

function refreshInputFacts(frame: Frame, facts: InputFacts): InputFacts {
  const result = { ...facts };
  for (const event of frame.events ?? []) {
    if ((event.name !== "textInput.open" && event.name !== "textInput.update") || event.payload?.id !== facts.id) continue;
    if (event.payload.editingSession !== facts.editingSession) continue;
    if (typeof event.payload.revision === "number") result.revision = Math.max(result.revision, event.payload.revision);
    if (typeof event.payload.jsRevision === "number") result.jsRevision = Math.max(result.jsRevision, event.payload.jsRevision);
  }
  return result;
}

async function enterNativeText(session: NativeSession, frame: Frame, placeholder: string, value: string): Promise<Frame> {
  const op = matchingTextOp(frame, placeholder);
  assert.ok(op, `story input placeholder ${placeholder} is not visible:\n${textOf(frame)}`);
  const point = center(op!, placeholder);
  const samples: Frame[] = [];
  session.sendEvent("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y });
  let latest = await session.frame();
  samples.push(latest);
  session.sendEvent("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y });
  latest = await session.frame();
  samples.push(latest);
  let facts = samples.map(inputFacts).find(Boolean);
  for (let index = 0; index < 12 && !facts; index++) {
    latest = await session.frame();
    samples.push(latest);
    facts = inputFacts(latest);
  }
  assert.ok(facts, `native input pointer did not open a text session:\n${textOf(latest)}`);
  let current = refreshInputFacts(latest, facts!);
  session.sendEvent("textInput.edit", {
    id: current.id,
    editingSession: current.editingSession,
    revision: current.revision + 1,
    jsRevision: current.jsRevision,
    text: value,
    selectionBase: value.length,
    selectionExtent: value.length,
    composingBase: -1,
    composingExtent: -1,
  });
  latest = await session.frame();
  current = refreshInputFacts(latest, { ...current, revision: current.revision + 1 });
  assert.ok(hasVisibleText(latest, value), `native text edit did not update the guest field:\n${textOf(latest)}`);
  session.sendEvent("textInput.submit", {
    id: current.id,
    editingSession: current.editingSession,
    revision: current.revision + 1,
    jsRevision: current.jsRevision,
    text: value,
    selectionBase: value.length,
    selectionExtent: value.length,
    composingBase: -1,
    composingExtent: -1,
  });
  return session.frame();
}

async function tapPastOpening(session: NativeSession, frame: Frame): Promise<Frame> {
  for (let index = 0; index < 6 && !hasVisibleText(frame, "继续前往雾港"); index++) {
    frame = await tapText(session, frame, "你收到一张");
  }
  return waitForText(session, frame, "继续前往雾港");
}

async function waitForAutoSave(session: NativeSession, predicate: (save: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let index = 0; index < 80; index++) {
    const save = session.storage[collectionsAutoSaveKey] as Record<string, any> | undefined;
    if (save && predicate(save)) return save;
    await session.frame();
  }
  assert.fail(`autosave did not reach the expected state: ${JSON.stringify(session.storage[collectionsAutoSaveKey])}`);
}

async function saveLockedManualSlot(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = await tapText(session, initial, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  frame = await tapText(session, frame, "封存此刻");
  frame = await waitForText(session, frame, "快速保存此刻");
  frame = await tapText(session, frame, "快速保存此刻");
  for (let index = 0; index < 80 && !session.storage[`collections.slot.${lockedManualSlotId}`]; index++) frame = await session.frame();
  const manual = session.storage[`collections.slot.${lockedManualSlotId}`] as Record<string, any> | undefined;
  assert.ok(manual, "the player's manual quick-save action must write a pre-unlock slot separate from autosave");
  assert.notEqual(manual!.state?.meta?.persistentVariables?.miraRecordUnlocked, true, "the pre-unlock manual slot must not contain the unlock");
  assert.equal(Object.hasOwn(manual!.state?.meta?.persistentVariables ?? {}, "miraRecordUnlocked"), false,
    "the locked default remains declared false in the story and has no explicit saved meta override");
  assert.equal(manual!.state?.active?.kind, "choice", "the pre-unlock quick-save must capture the real locked choice point");
  frame = await tapText(session, frame, "返回");
  return waitForText(session, frame, "继续前往雾港");
}

async function loadLockedManualSlot(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = await tapText(session, initial, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  frame = await tapText(session, frame, "重读信笺");
  for (let index = 0; index < 80; index++) {
    if (hasVisibleText(frame, "快速存档") && hasVisibleText(frame, "已保存的旅程") && !hasVisibleText(frame, "正在读取")) break;
    frame = await session.frame();
  }
  assert.ok(hasVisibleText(frame, "快速存档") && hasVisibleText(frame, "已保存的旅程") && !hasVisibleText(frame, "正在读取"),
    `load panel did not finish listing the saved quick slot:\n${textOf(frame)}`);
  const quickReadsBefore = session.storageGets.filter(request => request.key === "collections.slot.quick").length;
  assert.ok(quickReadsBefore > 0, "the load panel must have read the quick slot before loading it");
  frame = await tapText(session, frame, "快速存档");
  frame = await waitForText(session, frame, "继续前往雾港");
  assert.ok(session.storageGets.filter(request => request.key === "collections.slot.quick").length > quickReadsBefore,
    "selecting the visible quick slot must read and load that manual save");
  return frame;
}

function assertUnlocked(frame: Frame, expected: NovelCollectionsExpectation, reason: string): void {
  const visible = normalize(textOf(frame));
  assert.ok(visible.includes(normalize(expected.privateTitle)), `${reason}: unlocked entry is absent`);
  assert.ok(!visible.includes(normalize("尚未解锁，继续旅程后再来看看")), `${reason}: unlocked entry still shows locked detail`);
  assert.ok(!visible.includes(normalize(expected.privateBody)), `${reason}: body must appear only after selecting the entry`);
}

async function openPrivateDetail(session: NativeSession, frame: Frame, expected: NovelCollectionsExpectation, reason: string): Promise<Frame> {
  if (!hasVisibleText(frame, expected.privateTitle)) frame = await scrollUntilText(session, frame, expected.privateTitle);
  assertUnlocked(frame, expected, reason);
  frame = await tapText(session, frame, expected.privateTitle);
  frame = await waitForText(session, frame, expected.privateBody);
  assert.ok(portraitDrawn(frame, expected.portraitAsset), `${reason}: selecting the unlocked entry must paint its registered portrait`);
  return frame;
}

function assertDetailWithinViewport(frame: Frame, expected: NovelCollectionsExpectation, width: number, height: number): void {
  assert.equal(frame.width, width, "native Guest frame width must match the requested layout viewport");
  assert.equal(frame.height, height, "native Guest frame height must match the requested layout viewport");
  const bodyMarker = normalize(expected.privateBody.split(/[：:，,。.!?\s]/, 1)[0]!);
  const bodyOps = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string" && normalize(op.text).includes(bodyMarker));
  assert.ok(bodyOps.length > 0, `private body marker is not represented by a visible text op: ${textOf(frame)}`);
  const portrait = (frame.ops ?? []).find(op => op.type === "image" && (op as DrawOp & { asset?: string }).asset === expected.portraitAsset);
  assert.ok(portrait, "the viewport must paint the selected collection portrait");
  for (const op of [...bodyOps, portrait!]) {
    assert.ok(typeof op.x === "number" && typeof op.y === "number" && typeof op.w === "number" && typeof op.h === "number",
      `painted body and portrait ops must have concrete bounds: ${JSON.stringify(op)}`);
    assert.ok(op.x! >= 0 && op.y! >= 0 && op.x! + op.w! <= width + 1 && op.y! + op.h! <= height + 1,
      `painted collection content must stay within ${width}x${height}: ${JSON.stringify(op)}`);
  }
}

/** A second, layout-only run on the same compiled Guest at a wide, short viewport. */
export async function runNativeCollectionsLayoutAcceptance(
  artifacts: NativeArtifacts,
  savedAuto: Record<string, any>,
  expected: NovelCollectionsExpectation,
): Promise<Frame> {
  const session = new NativeSession(artifacts, {
    width: 800,
    height: 600,
    deadlineMs: 60_000,
    storage: { [collectionsAutoSaveKey]: JSON.parse(JSON.stringify(savedAuto)) },
  });
  try {
    let frame = await session.boot();
    frame = await waitForText(session, frame, "续写 · 继续旅程");
    frame = await tapText(session, frame, "续写 · 继续旅程");
    frame = await waitForText(session, frame, "你收到一张");
    frame = await openCollectionsFromGame(session, frame, expected);
    frame = await openPrivateDetail(session, frame, expected, "800x600 loaded detail");
    assertDetailWithinViewport(frame, expected, 800, 600);
    return frame;
  } finally {
    await session.quit();
  }
}

async function finishDetail(session: NativeSession, frame: Frame, expected: NovelCollectionsExpectation): Promise<Frame> {
  frame = await tapText(session, frame, "返回档案列表");
  frame = await waitForText(session, frame, expected.collectionTitle);
  return tapText(session, frame, "返回");
}

/** Exercise the compiled Guest through actual painted controls and a reconstructed native storage host. */
export async function runNativeCollectionsAcceptance(
  artifacts: NativeArtifacts,
  expected: NovelCollectionsExpectation,
): Promise<{ autoSave: Record<string, any>; finalFrame: Frame }> {
  const sessions: NativeSession[] = [];
  const createSession = (storage: Record<string, any>): NativeSession => {
    const session = new NativeSession(artifacts, {
      width: 360,
      height: 800,
      deadlineMs: 90_000,
      storage,
    });
    sessions.push(session);
    return session;
  };
  try {
    const first = createSession({});
    let frame = await first.boot();
    frame = await waitForText(first, frame, "启程 · 开始新的故事");
    frame = await openCollectionsFromTitle(first, frame, expected);
    assertPublicList(frame, expected, "fresh game");
    frame = await scrollUntilText(first, frame, expected.privateTitle);
    assertLocked(frame, expected, "fresh game");
    frame = await tapText(first, frame, expected.privateTitle);
    if (!hasVisibleText(frame, expected.privateTitle)) frame = await scrollUntilText(first, frame, expected.privateTitle);
    assertLocked(frame, expected, "locked entry tap");
    frame = await tapText(first, frame, "返回");

    frame = await tapText(first, frame, "启程 · 开始新的故事");
    frame = await waitForText(first, frame, "你收到一张");
    frame = await tapPastOpening(first, frame);
    frame = await saveLockedManualSlot(first, frame);
    frame = await tapText(first, frame, "继续前往雾港");
    frame = await waitForText(first, frame, "请留下你的名字");
    frame = await enterNativeText(first, frame, "旅人", "林岚");
    frame = await waitForText(first, frame, "提交");
    frame = await tapText(first, frame, "提交");
    frame = await waitForText(first, frame, "林岚，Mira 把自己的故事交给了你。");
    const autoSave = await waitForAutoSave(first, save => save.state?.meta?.persistentVariables?.miraRecordUnlocked === true);
    assert.equal(autoSave.state.meta.persistentVariables.miraRecordUnlocked, true, "the story's actual set instruction must persist the declared unlock");
    frame = await tapText(first, frame, "林岚，Mira 把自己的故事交给了你。");
    frame = await waitForText(first, frame, "雾散开后，灯塔仍在远处亮着。", 40);
    frame = await openCollectionsFromGame(first, frame, expected);
    frame = await openPrivateDetail(first, frame, expected, "unlocked in first session");
    frame = await finishDetail(first, frame, expected);
    frame = await loadLockedManualSlot(first, frame);
    frame = await openCollectionsFromGame(first, frame, expected);
    assertUnlocked(frame, expected, "loading a pre-unlock manual slot must merge newer persistent progress");
    frame = await openPrivateDetail(first, frame, expected, "after loading a pre-unlock manual slot");
    frame = await finishDetail(first, frame, expected);
    const savedBeforeRebuild = await waitForAutoSave(first, save => save.state?.meta?.persistentVariables?.miraRecordUnlocked === true && save.state?.active?.kind === "choice");
    assert.equal(savedBeforeRebuild.state.meta.persistentVariables.miraRecordUnlocked, true);
    await first.quit();
    sessions.splice(sessions.indexOf(first), 1);

    // This is a fresh guest process; the host receives only the JSON storage
    // snapshot produced by the prior process and the title Resume action loads it.
    const second = createSession(JSON.parse(JSON.stringify(first.storage)) as Record<string, any>);
    frame = await second.boot();
    frame = await waitForText(second, frame, "启程 · 开始新的故事");
    frame = await openCollectionsFromTitle(second, frame, expected);
    assertPublicList(frame, expected, "rebuilt guest before loading its save");
    frame = await scrollUntilText(second, frame, expected.privateTitle);
    assertLocked(frame, expected, "rebuilt guest before loading its save");
    frame = await tapText(second, frame, "返回");
    frame = await tapText(second, frame, "续写 · 继续旅程");
    frame = await waitForText(second, frame, "继续前往雾港");
    frame = await openCollectionsFromGame(second, frame, expected);
    frame = await openPrivateDetail(second, frame, expected, "loaded save after guest rebuild");
    frame = await finishDetail(second, frame, expected);

    frame = await tapText(second, frame, "手札");
    frame = await waitForText(second, frame, "旅途手札");
    frame = await tapText(second, frame, "返回扉页");
    frame = await waitForText(second, frame, "启程 · 开始新的故事");
    frame = await tapText(second, frame, "启程 · 开始新的故事");
    frame = await waitForText(second, frame, "你收到一张");
    frame = await openCollectionsFromGame(second, frame, expected);
    assertUnlocked(frame, expected, "newGame after loaded persistent progress");
    frame = await openPrivateDetail(second, frame, expected, "newGame after loaded persistent progress");
    const finalSave = await waitForAutoSave(second, save => save.state?.meta?.persistentVariables?.miraRecordUnlocked === true && save.state?.active?.id === "opening");
    assert.equal(finalSave.state.meta.persistentVariables.miraRecordUnlocked, true, "newGame must keep the unlock in persistent metadata");
    assertDetailWithinViewport(frame, expected, 360, 800);
    return { autoSave: finalSave, finalFrame: frame };
  } finally {
    for (const session of sessions) await session.quit();
  }
}
