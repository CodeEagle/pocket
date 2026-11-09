import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const guestDirectory = resolve(repositoryRoot, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");

const artifacts = readNativeArtifacts("POCKET_LANTERN");
const autosaveKey = "lantern.slot.auto";
const titleStart = "启程 · 开始新的故事";
const inventoryReplay = "雾港补给铺 · 买卖与行囊";
const compact = (value: string): string => value.replace(/[\s\u200b\ufeff]/g, "");
const dialoguePoint = { x: 180, y: 470 };

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

assert.ok(existsSync(artifacts.bytecodePath), "the selected Lantern Guest bytecode must exist");
assert.ok(existsSync(artifacts.pakPath), "the selected Lantern Guest PAK must exist");

function visibleBounds(op: DrawOp, frame: Frame): { x: number; y: number; w: number; h: number } | undefined {
  if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return undefined;
  const clip = op.clip ?? { x: 0, y: 0, w: frame.width ?? Number.POSITIVE_INFINITY, h: frame.height ?? Number.POSITIVE_INFINITY };
  const x = Math.max(op.x!, clip.x ?? 0, 0);
  const y = Math.max(op.y!, clip.y ?? 0, 0);
  const right = Math.min(op.x! + op.w!, (clip.x ?? 0) + (clip.w ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
  const bottom = Math.min(op.y! + op.h!, (clip.y ?? 0) + (clip.h ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

function visibleTextOp(frame: Frame, label: string): DrawOp | undefined {
  const target = compact(label);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(target)) return false;
    const visible = visibleBounds(op, frame);
    if (!visible) return false;
    const x = op.x! + op.w! / 2;
    const y = op.y! + op.h! / 2;
    return x >= visible.x && x <= visible.x + visible.w && y >= visible.y && y <= visible.y + visible.h;
  });
}

function scrollClip(frame: Frame, anchorText: string): NonNullable<DrawOp["clip"]> {
  const target = compact(anchorText);
  const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip && compact(op.text ?? "").includes(target));
  if (anchor?.clip) return anchor.clip;
  const fallback = (frame.ops ?? []).find(op => op.type === "text" && op.clip
    && (op.clip.w ?? 0) >= 180 && (op.clip.h ?? 0) >= 120);
  assert.ok(fallback?.clip, `a real scroll viewport must be painted: ${textOf(frame)}`);
  return fallback!.clip!;
}

async function waitForText(session: NativeSession, initial: Frame, text: string, maxFrames = 240): Promise<Frame> {
  const target = compact(text);
  let frame = initial;
  for (let attempt = 0; attempt < maxFrames; attempt++) {
    if (compact(textOf(frame)).includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error(`expected visible text did not appear: ${text}; painted=${textOf(frame)}`);
}

async function revealText(
  session: NativeSession,
  initial: Frame,
  label: string,
  options: { anchorText: string; direction: "down" | "up" },
): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 16; attempt++) {
    if (visibleTextOp(frame, label)) return frame;
    const clip = scrollClip(frame, options.anchorText);
    const x = clip.x! + clip.w! / 2;
    const fromY = clip.y! + clip.h! * (options.direction === "down" ? 0.82 : 0.22);
    const toY = clip.y! + clip.h! * (options.direction === "down" ? 0.22 : 0.82);
    frame = await session.drag({ x, y: fromY }, { x, y: toY }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`text did not become visibly reachable through real scrolling: ${label}; painted=${textOf(frame)}`);
}

async function tapVisibleText(session: NativeSession, frame: Frame, label: string): Promise<Frame> {
  const op = visibleTextOp(frame, label);
  assert.ok(op, `visible text action is painted before pointer input: ${label}; painted=${textOf(frame)}`);
  return session.tapPoint(center(op!, label));
}

function autosave(session: NativeSession): Record<string, any> | undefined {
  const value = session.storage[autosaveKey];
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

function autosaveWriteCount(session: NativeSession): number {
  const singleWrites = session.storageSets.filter(operation => operation.key === autosaveKey).length;
  const batchWrites = session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === autosaveKey).length;
  return singleWrites + batchWrites;
}

async function closeInventory(session: NativeSession, frame: Frame): Promise<Frame> {
  const back = (frame.ops ?? []).find(op => op.type === "text" && op.text === "返回");
  assert.ok(back, `inventory panel exposes its real Back action: ${textOf(frame)}`);
  return session.tapPoint(center(back!, "inventory panel Back"));
}

function assertInventory(frame: Frame, expected: { tokens: number; sleeves: number; wicks: number }): void {
  const painted = compact(textOf(frame));
  assert.ok(painted.includes(`旅资券·${expected.tokens}`), `currency is visibly ${expected.tokens}: ${textOf(frame)}`);
  assert.ok(painted.includes(`防潮封套持有${expected.sleeves}·买入4·退回2`),
    `sleeve quantity and canonical prices are visible: ${textOf(frame)}`);
  assert.ok(painted.includes(`备用灯芯持有${expected.wicks}·买入7·退回3`),
    `wick quantity and canonical prices are visible: ${textOf(frame)}`);
}

async function advanceReplayToVisibleChoice(session: NativeSession, initial: Frame, firstOption: string): Promise<Frame> {
  let frame = initial;
  // Replay state is intentionally not exposed through main autosave. The
  // rendered say/reveal controls and visible choice are the acceptance oracle.
  for (let tap = 0; tap < 900; tap++) {
    if (visibleTextOp(frame, firstOption)) return frame;
    const painted = compact(textOf(frame));
    if (painted.includes(compact("轻触显全")) || painted.includes(compact("轻触继续"))) {
      frame = await session.tapPoint(dialoguePoint);
      frame = await session.settle(frame, 1);
    } else {
      frame = await session.frame();
    }
  }
  throw new Error(`real replay pointer input did not reach visible choice ${firstOption}: ${textOf(frame)}`);
}

async function inspectReplayChoiceInventory(
  session: NativeSession,
  initial: Frame,
  expected: { tokens: number; sleeves: number; wicks: number },
): Promise<Frame> {
  let frame = await tapVisibleText(session, initial, "随身行囊");
  frame = await waitForText(session, frame, "旅资券");
  assertInventory(frame, expected);
  frame = await closeInventory(session, frame);
  return waitForText(session, frame, "购买一只防潮封套");
}

async function takeChoice(session: NativeSession, initial: Frame, optionText: string): Promise<Frame> {
  const frame = await waitForText(session, initial, optionText, 90);
  return tapVisibleText(session, frame, optionText);
}

async function readInventoryAfterTrade(
  session: NativeSession,
  frame: Frame,
  successText: string,
  expected: { tokens: number; sleeves: number; wicks: number },
): Promise<Frame> {
  frame = await waitForText(session, frame, successText, 180);
  frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");
  return inspectReplayChoiceInventory(session, frame, expected);
}

test("Lantern v6 inventory replay buys, returns, consumes, and preserves the main autosave through real NativeSession input", async () => {
  const session = new NativeSession(artifacts, { width: 800, height: 600, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    frame = await revealText(session, frame, titleStart, { anchorText: "雾港末班信", direction: "down" });
    frame = await tapVisibleText(session, frame, titleStart);
    frame = await waitForText(session, frame, "雾港", 180);
    for (let attempt = 0; attempt < 180 && !autosave(session); attempt++) frame = await session.frame();

    const startedSave = autosave(session);
    assert.ok(startedSave, "starting the real main story creates a non-empty autosave");
    assert.equal(startedSave.storyId, "demo.lantern.misty-last-letter");
    assert.equal(startedSave.storyVersion, 6, "the selected native Guest executes Lantern v6");
    assert.equal(startedSave.state?.active?.kind, "say", "the title action starts the actual main story");
    assert.deepEqual({
      travel_tokens: startedSave.state?.variables?.travel_tokens,
      weather_sleeves: startedSave.state?.variables?.weather_sleeves,
      spare_wicks: startedSave.state?.variables?.spare_wicks,
    }, { travel_tokens: 12, weather_sleeves: 0, spare_wicks: 0 });
    assert.ok(JSON.stringify(startedSave).length > 0);
    assert.ok(autosaveWriteCount(session) > 0, "main progression has already written its autosave through the native storage host");

    frame = await session.tap("手札", frame);
    frame = await waitForText(session, frame, "旅途手札");
    frame = await revealText(session, frame, "返回扉页", { anchorText: "继续阅读", direction: "down" });
    frame = await tapVisibleText(session, frame, "返回扉页");
    frame = await waitForText(session, frame, titleStart);

    frame = await revealText(session, frame, "随身行囊", { anchorText: titleStart, direction: "down" });
    frame = await tapVisibleText(session, frame, "随身行囊");
    frame = await waitForText(session, frame, "旅资券");
    assertInventory(frame, { tokens: 12, sleeves: 0, wicks: 0 });
    frame = await closeInventory(session, frame);
    frame = await revealText(session, frame, titleStart, { anchorText: "随身行囊", direction: "up" });

    const mainSaveBeforeReplay = structuredClone(autosave(session));
    const autoWritesBeforeReplay = autosaveWriteCount(session);
    assert.ok(mainSaveBeforeReplay, "the main autosave remains present after returning to the title");
    assert.deepEqual(mainSaveBeforeReplay.state?.meta?.endingIds ?? [], [], "the new-game fixture has no earned endings");

    frame = await revealText(session, frame, inventoryReplay, { anchorText: titleStart, direction: "down" });
    frame = await tapVisibleText(session, frame, inventoryReplay);
    frame = await waitForText(session, frame, "这是一段独立的补给体验", 360);
    assert.deepEqual(session.storage[autosaveKey], mainSaveBeforeReplay,
      "the free title replay does not replace the real main autosave");
    assert.equal(autosaveWriteCount(session), autoWritesBeforeReplay,
      "starting the isolated replay performs no main-autosave write");

    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");
    frame = await inspectReplayChoiceInventory(session, frame, { tokens: 12, sleeves: 0, wicks: 0 });

    frame = await takeChoice(session, frame, "购买一只防潮封套");
    frame = await readInventoryAfterTrade(session, frame, "把一只干燥的封套放进你的行囊", { tokens: 8, sleeves: 1, wicks: 0 });
    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");

    frame = await takeChoice(session, frame, "退回一只防潮封套");
    frame = await readInventoryAfterTrade(session, frame, "行囊里少了一只封套", { tokens: 10, sleeves: 0, wicks: 0 });
    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");

    frame = await takeChoice(session, frame, "购买一截备用灯芯");
    frame = await readInventoryAfterTrade(session, frame, "一截新灯芯被纸绳系好", { tokens: 3, sleeves: 0, wicks: 1 });
    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");

    frame = await takeChoice(session, frame, "点亮一截灯芯，等候雨势稍缓");
    frame = await readInventoryAfterTrade(session, frame, "行囊里的灯芯少了一截", { tokens: 3, sleeves: 0, wicks: 0 });
    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");

    frame = await takeChoice(session, frame, "购买一只防潮封套");
    frame = await waitForText(session, frame, "这次没有扣款，也没有增加物品", 180);
    assert.ok(compact(textOf(frame)).includes(compact("旅资不足")),
      "the refused branch visibly names insufficient funds");
    frame = await advanceReplayToVisibleChoice(session, frame, "购买一只防潮封套");
    frame = await inspectReplayChoiceInventory(session, frame, { tokens: 3, sleeves: 0, wicks: 0 });
    assert.deepEqual(session.storage[autosaveKey], mainSaveBeforeReplay,
      "buy, sell, consume, and the rejected purchase remain local to the replay engine");
    assert.equal(autosaveWriteCount(session), autoWritesBeforeReplay,
      "no replay trade writes the main autosave");

    frame = await advanceReplayToVisibleChoice(session, frame, "收好行囊，继续寄信");
    frame = await takeChoice(session, frame, "收好行囊，继续寄信");
    frame = await waitForText(session, frame, "小铺已打烊", 240);
    frame = await waitForText(session, frame, "返回原旅程", 120);
    frame = await tapVisibleText(session, frame, "返回原旅程");
    frame = await waitForText(session, frame, titleStart, 240);

    assert.deepEqual(session.storage[autosaveKey], mainSaveBeforeReplay,
      "exiting the replay restores the title without changing the parked main journey");
    assert.equal(autosaveWriteCount(session), autoWritesBeforeReplay,
      "the main autosave write count remains unchanged through replay exit");
    console.log("LANTERN_INVENTORY_NATIVE", JSON.stringify({
      guestQjbcPath: artifacts.bytecodePath,
      guestQjbcSha256: sha256(artifacts.bytecodePath),
      guestPakPath: artifacts.pakPath,
      guestPakSha256: sha256(artifacts.pakPath),
      guestMetadataPath: artifacts.metadataPath,
      guestMetadataSha256: sha256(artifacts.metadataPath),
      storyVersion: startedSave.storyVersion,
      mainAutosaveNonEmpty: true,
      mainAutosaveWriteCountBeforeReplay: autoWritesBeforeReplay,
      mainAutosaveWriteCountAfterReplay: autosaveWriteCount(session),
      replay: "inventory_showcase",
      transitions: [
        { currency: 12, weather_sleeves: 0, spare_wicks: 0 },
        { action: "buy weather_sleeve", currency: 8, weather_sleeves: 1, spare_wicks: 0 },
        { action: "sell weather_sleeve", currency: 10, weather_sleeves: 0, spare_wicks: 0 },
        { action: "buy spare_wick", currency: 3, weather_sleeves: 0, spare_wicks: 1 },
        { action: "consume spare_wick", currency: 3, weather_sleeves: 0, spare_wicks: 0 },
        { action: "rejected buy weather_sleeve", currency: 3, weather_sleeves: 0, spare_wicks: 0 },
      ],
      canonicalInventoryText: ["旅资券", "防潮封套", "备用灯芯", "buy/sell prices", "owned quantities"],
      replayExitedToTitle: true,
    }));
  } finally {
    await session.quit();
  }
}, 210_000);
