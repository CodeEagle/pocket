import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { decodeNovelSaveData } from "../../../sdk/packages/pocket_vn/src/save-codec.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  type DrawOp,
  type Frame,
  type NativeArtifacts,
} from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const artifactDirectory = resolve(repositoryRoot, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(artifactDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(artifactDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(artifactDirectory, "app.bytecode.json");

// Use the same default artifact/probe resolution as the existing NativeSession
// tests; callers can select a frozen Guest by setting POCKET_LANTERN_GUEST_*.
const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_LANTERN");
const guestHash = sha256(artifacts.bytecodePath);
const pakHash = sha256(artifacts.pakPath);
const storyId = "demo.lantern.misty-last-letter";
const autoKey = "lantern.slot.auto";
const manualKey = "lantern.slot.1";
const dialoguePoint = { x: 180, y: 470 };

type Save = Record<string, any>;
type ChoiceOption = { id: string; text: string; target: string };

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function saved(session: NativeSession, key = autoKey): Save {
  const value = session.storage[key];
  assert.ok(value && typeof value === "object", `missing ${key} save`);
  return value as Save;
}

function autoSaveWriteCount(session: NativeSession): number {
  const direct = session.storageSets.filter(request => request.key === autoKey).length;
  const batched = session.storageBatches.reduce((count, operations) =>
    count + operations.filter(operation => operation.type === "set" && operation.key === autoKey).length, 0);
  return direct + batched;
}

function active(session: NativeSession): Record<string, any> | null {
  return (session.storage[autoKey]?.state?.active as Record<string, any> | undefined) ?? null;
}

function compact(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

function visibleTextOp(frame: Frame, label: string): DrawOp | undefined {
  const target = compact(label);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || compact(op.text ?? "") !== target) return false;
    if (typeof op.x !== "number" || typeof op.y !== "number" || typeof op.w !== "number" || typeof op.h !== "number") return false;
    const clip = op.clip ?? { x: 0, y: 0, w: frame.width ?? Number.POSITIVE_INFINITY, h: frame.height ?? Number.POSITIVE_INFINITY };
    const left = Math.max(op.x, clip.x ?? 0, 0);
    const top = Math.max(op.y, clip.y ?? 0, 0);
    const right = Math.min(op.x + op.w, (clip.x ?? 0) + (clip.w ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
    const bottom = Math.min(op.y + op.h, (clip.y ?? 0) + (clip.h ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
    if (right <= left || bottom <= top) return false;
    const x = op.x + op.w / 2;
    const y = op.y + op.h / 2;
    return x >= left && x <= right && y >= top && y <= bottom;
  });
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
}

async function waitFor(
  session: NativeSession,
  initial: Frame,
  predicate: () => boolean,
  description: string,
  maxFrames = 300,
): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    if (predicate()) return frame;
    frame = await session.frame();
  }
  throw new Error(`timed out waiting for ${description}; active=${JSON.stringify(active(session))}; painted=${textOf(frame)}`);
}

async function advanceSay(session: NativeSession, initial: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected dialogue, got ${JSON.stringify(before)}`);
  const id = String(before!.id);
  let frame = await session.tapPoint(dialoguePoint);
  frame = await session.settle(frame, 1);
  if (active(session)?.kind === "say" && active(session)?.id === id) {
    frame = await session.tapPoint(dialoguePoint);
    frame = await session.settle(frame, 1);
  }
  return waitFor(session, frame, () => active(session)?.id !== id, `progress beyond ${id}`, 160);
}

async function driveToChoice(session: NativeSession, initial: Frame, id: string, maxInstructions = 220): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxInstructions; index += 1) {
    const current = active(session);
    if (current?.kind === "choice") {
      assert.equal(current.id, id, `expected choice ${id}, reached ${current.id}`);
      return frame;
    }
    if (current?.kind === "say") {
      frame = await advanceSay(session, frame);
      continue;
    }
    if (current?.kind === "wait") {
      frame = await session.frame();
      continue;
    }
    throw new Error(`expected choice ${id}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`story did not reach choice ${id}; active=${JSON.stringify(active(session))}`);
}

async function choose(session: NativeSession, initial: Frame, id: string): Promise<Frame> {
  let frame = initial;
  const current = active(session);
  assert.equal(current?.kind, "choice");
  const option = (current!.options as ChoiceOption[]).find(item => item.id === id);
  assert.ok(option, `choice ${current!.id} has no option ${id}`);
  const target = compact(option!.text);
  for (let index = 0; index < 180; index += 1) {
    const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string")
      .filter(op => {
        const line = compact(op.text!);
        return line.length >= 2 && target.startsWith(line) && ((op.color ?? 0xff000000) >>> 24) >= 250;
      })
      .sort((left, right) => compact(right.text!).length - compact(left.text!).length);
    if (candidates[0]) return session.settle(await session.tapPoint(center(candidates[0], `choice ${id}`)), 1);
    frame = await session.frame();
  }
  throw new Error(`choice ${id} was not visibly painted: ${textOf(frame)}`);
}

async function waitForSay(session: NativeSession, frame: Frame, id: string): Promise<Frame> {
  return waitFor(session, frame, () => active(session)?.kind === "say" && active(session)?.id === id, `dialogue ${id}`);
}

async function finishAtEnding(session: NativeSession, initial: Frame, id: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 240; index += 1) {
    const current = active(session);
    if (current?.kind === "ending") {
      assert.equal(current.id, id);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected ending ${id}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`did not reach ending ${id}; active=${JSON.stringify(active(session))}`);
}

async function openManualSave(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await session.tap("手札", frame);
  frame = await session.settle(frame, 1);
  frame = await session.tap("封存此刻", frame);
  for (let index = 0; index < 160 && textOf(frame).includes("正在读取"); index += 1) frame = await session.frame();
  frame = await session.tap("信笺 1", frame);
  frame = await waitFor(session, frame, () => Boolean(session.storage[manualKey]), "manual slot write", 160);
  return frame;
}

async function loadManualFromTitle(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await tapTitleAction(session, frame, "重读信笺");
  for (let index = 0; index < 180 && textOf(frame).includes("正在读取"); index += 1) frame = await session.frame();
  frame = await session.tap("信笺 1", frame);
  frame = await waitFor(session, frame, () => active(session)?.kind === "choice" && active(session)?.id === "signal_window", "loaded saved choice");
  return frame;
}

async function tapTitleAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const action = visibleTextOp(frame, label);
    if (action) return session.settle(await session.tapPoint(center(action, label)), 2);
    const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip
      && compact(op.text ?? "").includes(compact("启程 · 开始新的故事")));
    assert.ok(anchor?.clip, `title menu must expose its actual scroll viewport: ${textOf(frame)}`);
    const clip = anchor.clip!;
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * .82 }, { x, y: clip.y! + clip.h! * .22 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`title action ${label} did not become visible after real scrolling: ${textOf(frame)}`);
}

function assertMonotonicMeta(after: Record<string, any>, before: Record<string, any>): void {
  for (const key of ["readLineIds", "endingIds", "cgIds", "musicIds"] as const) {
    const later = new Set<string>(after[key] ?? []);
    for (const id of before[key] ?? []) assert.ok(later.has(id), `${key} lost previously persisted id ${id}`);
  }
  for (const [name, value] of Object.entries(before.persistentVariables ?? {})) {
    assert.ok(Object.hasOwn(after.persistentVariables ?? {}, name),
      `persistent metadata lost previously stored key ${name}`);
    assert.deepEqual(after.persistentVariables?.[name], value, `persistent value ${name} regressed`);
  }
}

function metaSnapshot(meta: Record<string, any>): Record<string, unknown> {
  return {
    readLineIds: [...(meta.readLineIds ?? [])],
    endingIds: [...(meta.endingIds ?? [])],
    cgIds: [...(meta.cgIds ?? [])],
    musicIds: [...(meta.musicIds ?? [])],
    persistentVariables: { ...(meta.persistentVariables ?? {}) },
  };
}

function runtimeSnapshot(state: Record<string, any>): Record<string, unknown> {
  const stage = state.stage as Record<string, any>;
  return {
    active: state.active ? { kind: state.active.kind, id: state.active.id } : null,
    variables: state.variables,
    stage: {
      background: stage.background,
      characters: stage.characters,
      camera: stage.camera,
      transition: stage.transition,
    },
    audioIntents: state.audioIntents,
  };
}

test("pinned Lantern guest preserves persistent progress across old-slot load, rollback, ending unlock and isolated replay", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 240_000 });
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForSay(session, frame, "arrival_01");
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await choose(session, frame, "check_seal");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "last_train");
    frame = await driveToChoice(session, frame, "signal_window");

    // Let the authored roof transition/camera finish so the retained slot has
    // stable stage intent. The choice deadline remains well above this wait.
    frame = await session.settle(frame, 90);
    frame = await openManualSave(session, frame);
    const manualEncoded = structuredClone(saved(session, manualKey));
    const manual = decodeNovelSaveData(manualEncoded) as Save;
    assert.equal(manual.storyId, storyId);
    assert.equal(manual.state.active.kind, "choice");
    assert.equal(manual.state.active.id, "signal_window");
    assert.equal(manual.state.variables.letter_seen, true, "the real route must persist its typed clue value");
    assert.equal(manual.state.variables.mira_trust, 1, "the real route must persist its typed trust value");
    assert.equal(manual.state.stage.background, "roof");
    assert.equal(manual.state.audioIntents.ambience.cue, "roof_gust");
    assert.ok(manual.state.meta.readLineIds.includes("arrival_01"));
    assert.ok(manual.state.meta.musicIds.includes("music_storm"));
    const rollbackCheckpoint = manual.state.rollbackHistory.at(-1);
    assert.ok(rollbackCheckpoint, "the saved route must contain a completed-dialogue rollback checkpoint");

    frame = await session.tap("返回", frame);
    frame = await session.settle(frame, 1);
    frame = await choose(session, frame, "send_train");
    frame = await finishAtEnding(session, frame, "last_train");
    const endingSave = structuredClone(saved(session));
    const endingState = endingSave.state as Save;
    assert.deepEqual(endingState.meta.endingIds, ["last_train"]);
    assert.deepEqual(endingState.meta.cgIds, ["dawn_departure"]);
    assert.ok(endingState.meta.musicIds.includes("music_dawn"));
    assert.ok(endingState.meta.readLineIds.includes("train_01"));
    assert.equal(endingState.stage.background, "dawn");
    assert.equal(endingState.audioIntents.music.cue, "music_dawn");
    assert.notDeepEqual(endingState.stage, manual.state.stage, "ending route must change stage from the older manual slot");
    assert.notDeepEqual(endingState.audioIntents, manual.state.audioIntents, "ending route must change at least one audio intent");
    assert.ok((manual.state.meta.endingIds ?? []).length < endingState.meta.endingIds.length,
      "the manual slot must predate the ending unlock whose progress is later merged");

    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 1);
    frame = await loadManualFromTitle(session, frame);
    let loadedState = saved(session).state as Save;
    assertJsonEqual(loadedState.variables, manual.state.variables, "load must restore the slot's session/save variables");
    assertJsonEqual(loadedState.stage, manual.state.stage, "load must restore the slot's stage");
    assertJsonEqual(loadedState.audioIntents, manual.state.audioIntents, "load must restore the slot's audio intents");
    assertMonotonicMeta(loadedState.meta, endingState.meta);
    assert.ok(loadedState.meta.endingIds.includes("last_train"), "loading an older slot must retain the unlocked ending");
    assert.ok(loadedState.meta.cgIds.includes("dawn_departure"), "loading an older slot must retain the unlocked CG");
    assert.ok(loadedState.meta.readLineIds.includes("train_01"), "loading an older slot must retain read history");
    assert.ok(loadedState.meta.musicIds.includes("music_dawn"), "loading an older slot must retain heard-music progress");

    frame = await session.tap("回溯", frame);
    frame = await waitFor(session, frame, () => active(session)?.kind === "say" && active(session)?.id === rollbackCheckpoint.active.id,
      "rollback to saved dialogue checkpoint");
    const rolledBackState = saved(session).state as Save;
    assertJsonEqual(rolledBackState.variables, rollbackCheckpoint.variables,
      "rollback must restore checkpoint session/save values without erasing persistent metadata");
    assertJsonEqual(rolledBackState.stage, rollbackCheckpoint.stage, "rollback must restore the checkpoint stage");
    assertJsonEqual(rolledBackState.audioIntents, rollbackCheckpoint.audioIntents,
      "rollback must restore the checkpoint's requested audio intents");
    assertMonotonicMeta(rolledBackState.meta, endingState.meta);

    frame = await driveToChoice(session, frame, "signal_window");
    frame = await choose(session, frame, "send_train");
    frame = await finishAtEnding(session, frame, "last_train");
    assertMonotonicMeta(saved(session).state.meta, endingState.meta);

    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 1);
    frame = await tapTitleAction(session, frame, "雾港纪念");
    const mainSaveBeforeReplay = structuredClone(saved(session));
    const autoWritesBeforeReplay = autoSaveWriteCount(session);
    assert.ok(autoWritesBeforeReplay > 0, "the storage log must have observed real main-autosave writes before replay");
    frame = await session.tap("回看 · 信随末班车离港", frame);
    for (let index = 0; index < 180 && !compact(textOf(frame)).includes(compact("你把封好的信交还Mira")); index += 1) {
      frame = await session.frame();
    }
    assert.ok(compact(textOf(frame)).includes(compact("你把封好的信交还Mira")),
      `the isolated replay must show the real ending dialogue: ${textOf(frame)}`);
    assert.deepEqual(saved(session), mainSaveBeforeReplay,
      "the ending replay must not advance or rewrite the main journey autosave");
    assert.equal(autoSaveWriteCount(session), autoWritesBeforeReplay,
      "replay must not issue a platform.storage.set/batch write for the main autosave");
    assert.equal(active(session)?.id, "last_train", "the durable main autosave cursor remains at the ending during replay");

    console.log(`novel_rollback_meta_native: QJBC=${guestHash} PAK=${pakHash} ABI=${artifacts.runtimeAbi}; load restored variables/stage/audio, rollback restored checkpoint intent, read/CG/ending/music meta remained monotonic, replay left main autosave deep-JSON unchanged with no autosave write request`);
    console.log(`novel_rollback_meta_native_meta: ${JSON.stringify({
      beforeEnding: metaSnapshot(manual.state.meta),
      afterEnding: metaSnapshot(endingState.meta),
      afterLoad: metaSnapshot(loadedState.meta),
      afterRollback: metaSnapshot(rolledBackState.meta),
      afterReunlock: metaSnapshot(saved(session).state.meta),
    })}`);
    console.log(`novel_rollback_meta_native_state: ${JSON.stringify({
      beforeEnding: runtimeSnapshot(manual.state),
      afterEnding: runtimeSnapshot(endingState),
      loaded: runtimeSnapshot(loadedState),
      rollbackCheckpoint: runtimeSnapshot(rollbackCheckpoint),
      rolledBack: runtimeSnapshot(rolledBackState),
    })}`);
  } finally {
    await session.quit();
  }
}, 260_000);
