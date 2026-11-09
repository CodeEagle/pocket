import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { decodeNovelSaveData } from "../../../sdk/packages/pocket_vn/src/save-codec.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOp,
  type Frame,
  type DrawOp,
} from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE = resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK = resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA = resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before slot UI acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before slot UI acceptance");

type EditingFacts = { readonly id: string; readonly editingSession: string; readonly revision: number; readonly jsRevision: number };

function active(session: NativeSession): Record<string, any> | null {
  const saved = session.storage["lantern.slot.auto"];
  return saved === undefined ? null : decodeNovelSaveData(saved).state.active;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function visibleCenter(op: DrawOp, label: string): { x: number; y: number } {
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  const left = Math.max(op.x!, op.clip?.x ?? Number.NEGATIVE_INFINITY);
  const top = Math.max(op.y!, op.clip?.y ?? Number.NEGATIVE_INFINITY);
  const right = Math.min(op.x! + op.w!, (op.clip?.x ?? 0) + (op.clip?.w ?? Number.POSITIVE_INFINITY));
  const bottom = Math.min(op.y! + op.h!, (op.clip?.y ?? 0) + (op.clip?.h ?? Number.POSITIVE_INFINITY));
  assert.ok(right > left && bottom > top, `${label} must have a visible painted area inside its clip`);
  return { x: left + (right - left) / 2, y: top + (bottom - top) / 2 };
}

async function tapVisibleText(session: NativeSession, label: string, frame: Frame): Promise<Frame> {
  let latest = frame;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const target = (latest.ops ?? []).find(op => op.type === "text" && op.text === label);
    if (target) return session.tapPoint(visibleCenter(target, label));
    // A clipped text operation can be omitted by the renderer entirely. Drag
    // the observed manager viewport to reveal it, just as a player would.
    const anchor = (latest.ops ?? []).find(op => op.type === "text" &&
      ["保存到此 ID", "复制到 ID", "移动到 ID", "与 ID 交换"].includes(op.text ?? "") && op.clip);
    assert.ok(anchor?.clip, `no painted slot-manager scroll viewport while finding ${label}: ${textOf(latest)}`);
    const clip = anchor.clip;
    const x = clip.x + clip.w / 2;
    latest = await session.drag(
      { x, y: clip.y + clip.h * .8 },
      { x, y: clip.y + clip.h * .2 },
      8,
      3,
    );
    latest = await session.settle(latest, 12);
  }
  throw new Error(`slot manager did not reveal ${label} after real pointer scrolling: ${textOf(latest)}`);
}

async function waitForActive(session: NativeSession, frame: Frame, id: string, maxFrames = 900): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    if (active(session)?.id === id) return latest;
    latest = await session.frame();
  }
  throw new Error(`game did not reach ${id}; active=${JSON.stringify(active(session))}; text=${textOf(latest)}`);
}

async function waitForText(session: NativeSession, frame: Frame, label: string, maxFrames = 300): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    if (textOf(latest).includes(label)) return latest;
    latest = await session.frame();
  }
  throw new Error(`Lantern did not paint ${label} after loading; UI=${textOf(latest)}`);
}

async function waitForSlotList(session: NativeSession, frame: Frame, maxFrames = 180): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    if (!textOf(latest).includes("正在读取")) return latest;
    latest = await session.frame();
  }
  throw new Error(`save-slot list did not finish loading: ${textOf(latest)}`);
}

async function openTextField(session: NativeSession, frame: Frame, label: string): Promise<{ frame: Frame; facts: EditingFacts }> {
  const point = center(textOp(frame, label), label);
  const samples: Frame[] = [];
  session.sendEvent("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y });
  samples.push(await session.frame());
  session.sendEvent("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y });
  samples.push(await session.frame());
  for (let index = 0; index < 12; index += 1) {
    const opened = samples.flatMap(sample => sample.events ?? []).find(event => event.name === "textInput.open" && event.payload?.id);
    if (opened?.payload) {
      return {
        frame: samples.at(-1)!,
        facts: {
          id: String(opened.payload.id),
          editingSession: String(opened.payload.editingSession),
          revision: Number(opened.payload.revision ?? 0),
          jsRevision: Number(opened.payload.jsRevision ?? 0),
        },
      };
    }
    samples.push(await session.frame());
  }
  throw new Error(`text input did not open for ${label}: ${textOf(samples.at(-1)!)}`);
}

async function editAndDismiss(session: NativeSession, frame: Frame, label: string, value: string): Promise<Frame> {
  const opened = await openTextField(session, frame, label);
  const revision = opened.facts.revision + 1;
  session.sendEvent("textInput.edit", {
    id: opened.facts.id,
    editingSession: opened.facts.editingSession,
    revision,
    jsRevision: opened.facts.jsRevision,
    text: value,
    selectionBase: value.length,
    selectionExtent: value.length,
    composingBase: -1,
    composingExtent: -1,
  });
  let latest = await session.frame();
  assert.ok(textOf(latest).includes(value), `native text edit did not update the slot ID field to ${value}`);
  // NativeSession models the input event protocol but has no Flutter overlay;
  // send its explicit close event before tapping the JS action below.
  session.sendEvent("textInput.dismiss", {
    id: opened.facts.id,
    editingSession: opened.facts.editingSession,
    revision,
    jsRevision: opened.facts.jsRevision,
    text: value,
    selectionBase: value.length,
    selectionExtent: value.length,
    composingBase: -1,
    composingExtent: -1,
  });
  latest = await session.frame();
  return latest;
}

test("pinned Lantern player quick save and raw slot controls use the official native input bridge", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    frame = await waitForText(session, frame, "启程 · 开始新的故事");
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 8);
    frame = await waitForActive(session, frame, "arrival_01");
    frame = await session.settle(frame, 50);

    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 2);
    const autoBeforeQuickSave = clone(session.storage["lantern.slot.auto"]);
    frame = await session.tap("快速保存此刻", frame);
    frame = await session.settle(frame, 4);
    assert.ok(session.storage["lantern.slot.quick"], "Quick Save must use its dedicated quick key");
    assert.deepEqual(session.storage["lantern.slot.auto"], autoBeforeQuickSave, "Quick Save must leave the continuous autosave key untouched");

    frame = await session.tap("继续阅读", frame);
    frame = await session.settle(frame, 2);
    const lineId = String(active(session)?.id);
    frame = await session.tapPoint({ x: 180, y: 470 });
    frame = await session.settle(frame, 1);
    if (active(session)?.id === lineId) {
      frame = await session.tapPoint({ x: 180, y: 470 });
      frame = await session.settle(frame, 1);
    }
    for (let index = 0; index < 120 && active(session)?.id === lineId; index += 1) frame = await session.frame();
    assert.notEqual(active(session)?.id, lineId, "the journey must advance before Quick Load is checked");
    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("重读信笺", frame);
    frame = await session.settle(frame, 4);
    frame = await waitForSlotList(session, frame);
    const quickReadsBeforeLoad = session.storageGets.filter(request => request.key === "lantern.slot.quick").length;
    frame = await session.tap("快速存档", frame);
    frame = await session.settle(frame, 5);
    assert.ok(!textOf(frame).includes("从记录中的那个瞬间继续。"), `Quick Load action did not close the load page; quickReads=${session.storageGets.filter(request => request.key === "lantern.slot.quick").length - quickReadsBeforeLoad}; UI=${textOf(frame)}`);
    assert.equal(active(session)?.id, lineId, `Quick Load must restore the dedicated checkpoint; auto=${JSON.stringify(active(session))}; quick=${JSON.stringify(decodeNovelSaveData(session.storage["lantern.slot.quick"]).state.active)}; UI=${textOf(frame)}`);

    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("封存此刻", frame);
    frame = await session.settle(frame, 4);
    frame = await waitForSlotList(session, frame);
    frame = await session.tap("信笺 1", frame);
    frame = await session.settle(frame, 5);
    assert.ok(session.storage["lantern.slot.1"], "legacy named slot 1 must remain writable");

    frame = await session.tap("管理存档", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.match(textOf(frame), /输入存档 ID/, "slot management must reuse the existing @pocket/ui text input shell");
    frame = await session.tap("信笺 1", frame);
    frame = await session.settle(frame, 1);
    frame = await editAndDismiss(session, frame, "输入存档 ID", "archive");
    frame = await session.tap("保存到此 ID", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.ok(session.storage["lantern.slot.archive"], "a custom ID must be saved through the slot manager");

    frame = await session.tap("信笺 1", frame);
    frame = await session.settle(frame, 1);
    frame = await editAndDismiss(session, frame, "archive", "archive");
    frame = await session.tap("复制到 ID", frame);
    frame = await session.settle(frame, 1);
    assert.match(textOf(frame), /覆盖到 archive/, "copying over an occupied ID must require visible confirmation");
    frame = await session.tap("确认", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.deepEqual(session.storage["lantern.slot.archive"], session.storage["lantern.slot.1"], "copy must delegate the opaque record to the slot manager");

    frame = await session.tap("信笺 archive", frame);
    frame = await session.settle(frame, 1);
    frame = await editAndDismiss(session, frame, "archive", "moved");
    frame = await session.tap("移动到 ID", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.equal(session.storage["lantern.slot.archive"], undefined, "move must remove its source after the manager operation");
    assert.ok(session.storage["lantern.slot.moved"], "move must create the destination");
    assert.ok(!textOf(frame).includes("来源 · 1"), "a successful move must clear the deleted source selection");

    frame = await session.tap("信笺 1", frame);
    frame = await session.settle(frame, 1);
    frame = await editAndDismiss(session, frame, "moved", "moved");
    frame = await session.tap("与 ID 交换", frame);
    frame = await session.settle(frame, 1);
    assert.match(textOf(frame), /交换 1 与 moved/, "swap must require explicit confirmation");
    frame = await session.tap("确认", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.ok(session.storageBatches.some(batch => batch.length === 2 &&
      batch.every(operation => operation.type === "set") &&
      batch.map(operation => operation.key).sort().join(",") === "lantern.slot.1,lantern.slot.moved"),
    "swap UI must use the manager's single atomic storage batch");

    frame = await tapVisibleText(session, "删除来源", frame);
    frame = await session.settle(frame, 1);
    assert.match(textOf(frame), /删除存档 1/, "delete must require explicit confirmation");
    frame = await session.tap("确认", frame);
    frame = await session.settle(frame, 5);
    frame = await waitForSlotList(session, frame);
    assert.equal(session.storage["lantern.slot.1"], undefined, "confirmed delete must remove the selected slot");
    assert.ok(session.storage["lantern.slot.auto"], "slot management must preserve the reserved autosave");
  } finally {
    await session.quit();
  }
}, 210_000);

test("slot save remains blocked until a delayed host slot listing confirms whether the legacy ID is occupied", async () => {
  const existing = { sentinel: "do-not-overwrite-before-list" };
  const session = new NativeSession(artifacts, {
    width: 360,
    height: 640,
    deadlineMs: 120_000,
    storage: { "lantern.slot.1": clone(existing) },
    deferCapabilities: ["platform.storage.keys"],
  });
  try {
    let frame = await session.boot();
    frame = await waitForText(session, frame, "启程 · 开始新的故事");
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 8);
    frame = await waitForActive(session, frame, "arrival_01");
    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("封存此刻", frame);
    frame = await session.settle(frame, 2);
    assert.equal(session.storage["lantern.slot.1"].sentinel, existing.sentinel, "existing data must remain while list() is pending");
    assert.equal(session.storageSets.some(request => request.key === "lantern.slot.1"), false, "no save request may be sent before list() resolves");

    session.respondPending("platform.storage.keys", Object.keys(session.storage));
    frame = await session.frame();
    frame = await session.settle(frame, 4);
    frame = await waitForSlotList(session, frame);
    frame = await session.tap("信笺 1", frame);
    frame = await session.settle(frame, 1);
    assert.equal(session.storage["lantern.slot.1"].sentinel, existing.sentinel, "one press on an occupied row must only request confirmation");
    assert.match(textOf(frame), /覆盖存档 1/);
  } finally {
    await session.quit();
  }
}, 150_000);
