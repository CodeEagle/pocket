import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  NativeSession,
  center,
  textOp,
  readNativeArtifacts,
  textOf,
  textOps,
  type DrawOp,
  type Frame,
  type NativeArtifacts,
} from "./native_session.ts";

const width = 360;
const height = 640;
const storyId = "demo.lantern.misty-last-letter";
const autosaveKey = "lantern.slot.auto";
const artifactDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(artifactDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(artifactDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(artifactDirectory, "app.bytecode.json");

const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before input acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before input acceptance");
const storyDocument = JSON.parse(readFileSync(resolve(artifactDirectory, "../../../js/apps/lantern/story.json"), "utf8")) as { id?: string };
assert.equal(storyDocument.id, storyId, "input acceptance must load the compiled Lantern story");

type SaveState = Record<string, any>;
type NovelSave = { storyId?: string; state?: SaveState };
type ChoiceOption = { id: string; target: string; text: string };
type EditingFacts = { id: string; editingSession: string; revision: number; jsRevision: number };

function latestSave(session: NativeSession): NovelSave {
  const save = session.storage[autosaveKey] as NovelSave | undefined;
  assert.ok(save && save.storyId === storyId, "game must persist its current state through platform.storage.set");
  return save!;
}

function active(session: NativeSession): Record<string, any> | null {
  return (latestSave(session).state?.active as Record<string, any> | null) ?? null;
}

function normalize(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

async function advanceSay(session: NativeSession, frame: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected dialogue before advance, got ${JSON.stringify(before)}`);
  const id = String(before!.id);
  let latest = await session.tapPoint({ x: 180, y: 470 });
  latest = await session.settle(latest, 1);
  if (active(session)?.kind === "say" && active(session)?.id === id) {
    latest = await session.tapPoint({ x: 180, y: 470 });
    latest = await session.settle(latest, 1);
  }
  for (let index = 0; index < 120; index++) {
    const current = active(session);
    if (current?.kind !== "say" || current.id !== id) return latest;
    latest = await session.frame();
  }
  throw new Error(`native game did not advance beyond ${id}; active=${JSON.stringify(active(session))}; text=${textOf(frame)}`);
}

async function driveToChoice(session: NativeSession, initial: Frame, expectedId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 300; index++) {
    const current = active(session);
    if (current?.kind === "choice") {
      assert.equal(current.id, expectedId);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected choice ${expectedId}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`native game did not reach choice ${expectedId}; active=${JSON.stringify(active(session))}`);
}

async function driveToInput(session: NativeSession, initial: Frame, expectedId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 300; index++) {
    const current = active(session);
    if (current?.kind === "input") {
      assert.equal(current.id, expectedId);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected input ${expectedId}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`native game did not reach input ${expectedId}; active=${JSON.stringify(active(session))}`);
}

async function driveToSay(session: NativeSession, initial: Frame, expectedId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 300; index++) {
    const current = active(session);
    if (current?.kind === "say" && current.id === expectedId) return frame;
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected dialogue ${expectedId}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`native game did not reach dialogue ${expectedId}; active=${JSON.stringify(active(session))}`);
}

function optionOp(frame: Frame, optionText: string): DrawOp {
  const target = normalize(optionText);
  assert.ok(normalize(textOf(frame)).includes(target), `option is not painted: ${optionText}\n${textOf(frame)}`);
  const candidates = (frame.ops ?? []).filter((op) => op.type === "text" && typeof op.text === "string" && target.startsWith(normalize(op.text)));
  assert.ok(candidates.length > 0, `no painted line matches option ${optionText}`);
  return candidates.sort((left, right) => normalize(right.text!).length - normalize(left.text!).length)[0]!;
}

async function waitForOptionOp(session: NativeSession, initial: Frame, optionText: string, maxFrames = 120): Promise<{ frame: Frame; op: DrawOp }> {
  const target = normalize(optionText);
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    if (normalize(textOf(frame)).includes(target)) {
      const candidates = (frame.ops ?? []).filter((op) => op.type === "text" && typeof op.text === "string" && target.startsWith(normalize(op.text)));
      if (candidates.length > 0) {
        return {
          frame,
          op: candidates.sort((left, right) => normalize(right.text!).length - normalize(left.text!).length)[0]!,
        };
      }
    }
    frame = await session.frame();
  }
  throw new Error(`choice option never became visibly painted and tappable: ${optionText}\n${textOf(frame)}`);
}

async function choose(session: NativeSession, frame: Frame, optionId: string): Promise<Frame> {
  const choice = active(session);
  assert.equal(choice?.kind, "choice");
  const option = (choice!.options as ChoiceOption[]).find((item) => item.id === optionId);
  assert.ok(option, `choice ${choice!.id} has no ${optionId}: ${(choice!.options as ChoiceOption[]).map((item) => item.id).join(", ")}`);
  const painted = await waitForOptionOp(session, frame, option!.text);
  const latest = await session.tapPoint(center(painted.op, optionId));
  return session.settle(latest, 1);
}

async function openNativeEditor(session: NativeSession, frame: Frame, placeholder: string): Promise<{ frame: Frame; facts: EditingFacts }> {
  const point = center(textOp(frame, placeholder), placeholder);
  const samples: Frame[] = [];
  session.sendEvent("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y });
  let latest = await session.frame();
  samples.push(latest);
  session.sendEvent("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y });
  latest = await session.frame();
  samples.push(latest);
  for (let index = 0; index < 12; index++) {
    const opened = samples.flatMap((sample) => sample.events ?? []).find((item) => item.name === "textInput.open" && item.payload?.id);
    if (opened?.payload) {
      const payload = opened.payload;
      assert.equal(typeof payload.editingSession, "string", "textInput.open must carry its editing session");
      assert.equal(typeof payload.revision, "number", "textInput.open must carry its native revision");
      assert.equal(typeof payload.jsRevision, "number", "textInput.open must carry its JS revision");
      return {
        frame: latest,
        facts: {
          id: String(payload.id),
          editingSession: String(payload.editingSession),
          revision: Number(payload.revision),
          jsRevision: Number(payload.jsRevision),
        },
      };
    }
    latest = await session.frame();
    samples.push(latest);
  }
  throw new Error(`InputField pointer did not emit textInput.open: ${textOf(latest)}`);
}

function refreshEditingFacts(frame: Frame, facts: EditingFacts): EditingFacts {
  const result = { ...facts };
  for (const item of frame.events ?? []) {
    if ((item.name !== "textInput.open" && item.name !== "textInput.update") || item.payload?.id !== facts.id) continue;
    if (item.payload.editingSession !== facts.editingSession) continue;
    if (typeof item.payload.revision === "number") result.revision = Math.max(result.revision, item.payload.revision);
    if (typeof item.payload.jsRevision === "number") result.jsRevision = Math.max(result.jsRevision, item.payload.jsRevision);
  }
  return result;
}

async function sendNativeText(session: NativeSession, facts: EditingFacts, text: string): Promise<{ frame: Frame; facts: EditingFacts }> {
  session.sendEvent("textInput.edit", {
    id: facts.id,
    editingSession: facts.editingSession,
    revision: facts.revision + 1,
    jsRevision: facts.jsRevision,
    text,
    selectionBase: text.length,
    selectionExtent: text.length,
    composingBase: -1,
    composingExtent: -1,
  });
  const frame = await session.frame();
  return { frame, facts: refreshEditingFacts(frame, { ...facts, revision: facts.revision + 1 }) };
}

async function submitNativeText(session: NativeSession, facts: EditingFacts, text: string): Promise<Frame> {
  session.sendEvent("textInput.submit", {
    id: facts.id,
    editingSession: facts.editingSession,
    revision: facts.revision + 1,
    jsRevision: facts.jsRevision,
    text,
    selectionBase: text.length,
    selectionExtent: text.length,
    composingBase: -1,
    composingExtent: -1,
  });
  return session.frame();
}

type SlotIoCounts = { keys: number; gets: number };

function slotIoCounts(session: NativeSession): SlotIoCounts {
  return {
    keys: session.requests.filter(request => request.capability === "platform.storage.keys").length,
    gets: session.storageGets.length,
  };
}

function slotWriteCount(session: NativeSession, slot: string): number {
  const key = `lantern.slot.${slot}`;
  return session.storageSets.filter(request => request.key === key).length;
}

async function waitForSlotList(session: NativeSession, frame: Frame, before: SlotIoCounts, minimumReads: number): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < 180; index += 1) {
    const io = slotIoCounts(session);
    const readsFinished = io.keys > before.keys && io.gets - before.gets >= minimumReads;
    if (readsFinished) {
      latest = await session.settle(latest, 2);
      if (!textOf(latest).includes("正在读取")) return latest;
    }
    latest = await session.frame();
  }
  throw new Error(`save-slot list did not finish: requests=${JSON.stringify(slotIoCounts(session))}; text=${textOf(latest)}`);
}

async function waitForSlotWrite(session: NativeSession, frame: Frame, slot: string, previousWrites: number): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < 180; index += 1) {
    if (slotWriteCount(session, slot) > previousWrites) return session.settle(latest, 3);
    latest = await session.frame();
  }
  throw new Error(`slot ${slot} was not written: writes=${slotWriteCount(session, slot)}; text=${textOf(latest)}`);
}

async function saveSlot(session: NativeSession, frame: Frame, slot: string): Promise<Frame> {
  frame = await session.tap("手札", frame);
  frame = await session.settle(frame, 1);
  const listBefore = slotIoCounts(session);
  frame = await session.tap("封存此刻", frame);
  frame = await waitForSlotList(session, frame, listBefore, 4);
  const key = `lantern.slot.${slot}`;
  const alreadyExists = Object.hasOwn(session.storage, key);
  const previousSave = alreadyExists ? JSON.parse(JSON.stringify(session.storage[key])) as unknown : undefined;
  const previousWrites = slotWriteCount(session, slot);
  frame = await session.tap(`信笺 ${slot}`, frame);
  frame = await session.settle(frame, 1);
  if (alreadyExists) {
    assert.equal(slotWriteCount(session, slot), previousWrites, `saving occupied slot ${slot} once must not write before confirmation`);
    assert.deepEqual(session.storage[key], previousSave, `saving occupied slot ${slot} once must leave the old record intact`);
    assert.ok(textOf(frame).includes(`覆盖存档 ${slot}`), `occupied slot ${slot} must show overwrite confirmation: ${textOf(frame)}`);
    frame = await session.tap("确认", frame);
  }
  frame = await waitForSlotWrite(session, frame, slot, previousWrites);
  const save = session.storage[`lantern.slot.${slot}`] as NovelSave | undefined;
  assert.equal(save?.storyId, storyId, `manual save slot ${slot} must store the current Lantern story`);
  return frame;
}

async function loadSlot(session: NativeSession, frame: Frame, slot: string): Promise<Frame> {
  frame = await session.tap("手札", frame);
  frame = await session.settle(frame, 1);
  const listBefore = slotIoCounts(session);
  frame = await session.tap("重读信笺", frame);
  frame = await waitForSlotList(session, frame, listBefore, 5);
  const expected = (session.storage[`lantern.slot.${slot}`] as NovelSave | undefined)?.state?.active;
  assert.ok(expected, `slot ${slot} must have an active player state before it is loaded`);
  frame = await session.tap(`信笺 ${slot}`, frame);
  for (let index = 0; index < 180; index += 1) {
    const current = active(session);
    if (current?.kind === expected!.kind && current?.id === expected!.id &&
        (expected!.kind !== "input" || current.draft === expected!.draft)) return frame;
    frame = await session.frame();
  }
  throw new Error(`slot ${slot} did not restore its saved active draft: active=${JSON.stringify(active(session))}; text=${textOf(frame)}`);
}

async function leaveJournal(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await session.tap("返回", frame);
  frame = await session.settle(frame, 1);
  if (textOps(frame, "继续阅读").length > 0) {
    frame = await session.tap("继续阅读", frame);
    frame = await session.settle(frame, 1);
  }
  return frame;
}

test("native Lantern input edits, validates, cancels, saves, restores and rolls back", async () => {
  const session = new NativeSession(artifacts, { width, height, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    assert.ok(textOps(frame, "启程 · 开始新的故事").length > 0, "title is drawn by the compiled guest");
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 2);
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await choose(session, frame, "ask_ren");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "archive");
    frame = await driveToChoice(session, frame, "archive_read");
    frame = await choose(session, frame, "copy_route");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "leave_reply_address");
    frame = await driveToChoice(session, frame, "platform_stall_menu");
    frame = await choose(session, frame, "leave_stall");
    frame = await driveToInput(session, frame, "registry_recipient");

    // Cancel is a real player action after opening/editing the guest InputField.
    let editor = await openNativeEditor(session, frame, "例如：小岚🙂");
    frame = editor.frame;
    let edited = await sendNativeText(session, editor.facts, "未提交🙂");
    frame = edited.frame;
    assert.match(textOf(frame), /未提交🙂/, "native textInput.edit must change the drawn guest draft");
    frame = await session.tap("取消", frame);
    frame = await session.settle(frame, 2);
    frame = await driveToChoice(session, frame, "investigation_hub");
    assert.equal(active(session)?.kind, "choice", "cancel must return to the investigation hub");
    assert.equal(active(session)?.id, "investigation_hub");
    assert.equal(latestSave(session).state?.variables?.reply_name, undefined, "cancelling must not commit the text draft");

    frame = await choose(session, frame, "leave_reply_address");
    frame = await driveToChoice(session, frame, "platform_stall_menu");
    frame = await choose(session, frame, "leave_stall");
    frame = await driveToInput(session, frame, "registry_recipient");
    editor = await openNativeEditor(session, frame, "例如：小岚🙂");
    edited = await sendNativeText(session, editor.facts, "林岚🙂");
    frame = await submitNativeText(session, edited.facts, "林岚🙂");
    assert.equal(active(session)?.kind, "input", "native done submits the text session but does not activate the story's Submit action");
    assert.match(textOf(frame), /林岚🙂/, "native submit must leave the JS input draft visible");
    frame = await saveSlot(session, frame, "1");
    const uncommittedName = session.storage["lantern.slot.1"] as NovelSave;
    assert.equal(uncommittedName.state?.active?.draft, "林岚🙂", "native input draft must be saveable before story confirmation");
    assert.equal(uncommittedName.state?.variables?.reply_name, undefined, "the native done action must not commit the story variable");
    frame = await leaveJournal(session, frame);
    frame = await session.tap("提交", frame);
    frame = await session.settle(frame, 4);
    assert.equal(active(session)?.id, "registry_02", "valid text submission must advance to its interpolated response");
    assert.match(String(active(session)?.text), /林岚🙂/);
    assert.equal(latestSave(session).state?.variables?.reply_name, "林岚🙂");
    frame = await driveToInput(session, frame, "registry_mailbox");

    editor = await openNativeEditor(session, frame, "0–999");
    edited = await sendNativeText(session, editor.facts, "1000");
    frame = await submitNativeText(session, edited.facts, "1000");
    assert.equal(active(session)?.kind, "input", "native done leaves numeric validation to the explicit story action");
    frame = await session.tap("提交", frame);
    frame = await session.settle(frame, 2);
    assert.equal(active(session)?.id, "registry_mailbox", "invalid numeric submit must not advance the story");
    assert.equal(active(session)?.kind, "input");
    assert.match(textOf(frame), /999/, "numeric bound error must appear in the guest frame");
    frame = await saveSlot(session, frame, "2");
    const invalidSave = session.storage["lantern.slot.2"] as NovelSave;
    assert.equal(invalidSave.state?.active?.kind, "input");
    assert.equal(invalidSave.state?.active?.id, "registry_mailbox");
    assert.equal(invalidSave.state?.active?.draft, "1000", "save data must preserve the invalid raw number");
    assert.deepEqual(invalidSave.state?.active?.error, { code: "max", limit: 999 }, "save data must preserve the structured validation error");
    assert.equal(invalidSave.state?.variables?.reply_box, undefined, "invalid number must not enter the typed variable map");
    frame = await leaveJournal(session, frame);

    editor = await openNativeEditor(session, frame, "1000");
    edited = await sendNativeText(session, editor.facts, "1e2");
    frame = await submitNativeText(session, edited.facts, "1e2");
    assert.equal(active(session)?.kind, "input", "native done closes the IME but leaves the game field active");
    frame = await session.tap("提交", frame);
    frame = await session.settle(frame, 4);
    assert.equal(active(session)?.id, "registry_03");
    assert.match(String(active(session)?.text), /100/);
    assert.equal(latestSave(session).state?.variables?.reply_box, 100, "valid numeric raw text must commit as a number");
    frame = await driveToInput(session, frame, "registry_public_consent");

    // Boolean controls use JS-owned Yes/No actions. Save/load restores the JS
    // draft, and the player's existing rollback action returns to the prior line.
    frame = await session.tap("是", frame);
    frame = await session.settle(frame, 1);
    frame = await saveSlot(session, frame, "1");
    const savedBoolean = session.storage["lantern.slot.1"] as NovelSave;
    assert.equal(savedBoolean.state?.active?.kind, "input");
    assert.equal(savedBoolean.state?.active?.id, "registry_public_consent");
    assert.equal(savedBoolean.state?.active?.draft, true, "manual save must retain a submitted-to-UI but uncommitted boolean draft");
    frame = await leaveJournal(session, frame);
    frame = await session.tap("否", frame);
    frame = await session.settle(frame, 1);
    frame = await loadSlot(session, frame, "1");
    frame = await saveSlot(session, frame, "3");
    const restoredBoolean = session.storage["lantern.slot.3"] as NovelSave;
    assert.equal(restoredBoolean.state?.active?.draft, true, "loading a saved input draft must restore its typed selection");
    assert.equal(restoredBoolean.state?.variables?.reply_public, undefined, "saving a boolean draft must not prematurely write its variable");
    frame = await leaveJournal(session, frame);
    frame = await session.tap("回溯", frame);
    frame = await session.settle(frame, 2);
    assert.equal(active(session)?.kind, "say", "rollback from an input must return to the preceding dialogue checkpoint");
    assert.equal(active(session)?.id, "registry_03");
    assert.equal(latestSave(session).state?.variables?.reply_public, undefined, "rollback must not commit the unsubmitted consent");
    frame = await driveToInput(session, frame, "registry_public_consent");
    frame = await session.tap("是", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("提交", frame);
    frame = await session.settle(frame, 3);
    frame = await driveToSay(session, frame, "registry_04_yes");
    assert.equal(active(session)?.id, "registry_04_yes", "explicit boolean confirmation must follow the yes branch");
    assert.equal(latestSave(session).state?.variables?.reply_public, true, "confirmed consent must commit a boolean value");
    frame = await session.settle(frame, 140);
    assert.match(textOf(frame), /林岚🙂/, "the return-label name remains visible in its confirmation");

    console.log(`novel_input_native: compiled Lantern QJBC accepted host text edit/submit, validation, cancel, save/load and rollback (abi=${artifacts.runtimeAbi})`);
    await session.quit();
  } finally {
    session.forceKill();
  }
}, 180_000);
