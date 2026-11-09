import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
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

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before replay acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before replay acceptance");

type ChoiceOption = { id: string; text: string };

function savedState(session: NativeSession): Record<string, any> | null {
  const saved = session.storage["lantern.slot.auto"];
  return saved && typeof saved === "object" ? saved as Record<string, any> : null;
}

function active(session: NativeSession): Record<string, any> | null {
  return savedState(session)?.state?.active ?? null;
}

function compact(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

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

function optionOp(frame: Frame, label: string): DrawOp {
  const target = compact(label);
  const candidates = (frame.ops ?? []).filter(op =>
    op.type === "text" && typeof op.text === "string" && target.startsWith(compact(op.text)));
  assert.ok(candidates.length > 0, `choice option is not painted: ${label}\n${textOf(frame)}`);
  return candidates.sort((left, right) => compact(right.text!).length - compact(left.text!).length)[0]!;
}

async function advanceSay(session: NativeSession, frame: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected dialogue, got ${JSON.stringify(before)}`);
  const id = String(before!.id);
  let latest = await session.tapPoint({ x: 180, y: 470 });
  latest = await session.settle(latest, 1);
  if (active(session)?.kind === "say" && active(session)?.id === id) {
    latest = await session.tapPoint({ x: 180, y: 470 });
    latest = await session.settle(latest, 1);
  }
  for (let index = 0; index < 120; index++) {
    if (active(session)?.id !== id) return latest;
    latest = await session.frame();
  }
  throw new Error(`dialogue did not advance beyond ${id}: ${textOf(frame)}`);
}

async function driveToChoice(session: NativeSession, initial: Frame, expected: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 300; index++) {
    const current = active(session);
    if (current?.kind === "choice") {
      assert.equal(current.id, expected);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected choice ${expected}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`story did not reach choice ${expected}`);
}

async function driveToEnding(session: NativeSession, initial: Frame, expected: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 500; index++) {
    const current = active(session);
    if (current?.kind === "ending") {
      assert.equal(current.id, expected);
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected ending ${expected}, got ${JSON.stringify(current)}`);
  }
  throw new Error(`story did not reach ending ${expected}`);
}

async function revealText(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 12; index++) {
    if (textOf(frame).includes(label)) return frame;
    frame = await session.drag({ x: 180, y: 570 }, { x: 180, y: 160 }, 8, 2);
    frame = await session.settle(frame, 1);
  }
  throw new Error(`gallery control never became painted: ${label}\n${textOf(frame)}`);
}

async function openTitleGallery(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const galleryAction = visibleTextOp(frame, "雾港纪念");
    if (galleryAction) {
      frame = await session.tapPoint(center(galleryAction, "title gallery"));
      return session.settle(frame, 3);
    }

    // Added collection entries push the Gallery action below the title menu's
    // clip. Drag inside the actual painted viewport until that action is visible.
    const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip
      && compact(op.text ?? "").includes(compact("开始新的故事")));
    assert.ok(anchor?.clip, `the title menu must expose its clipped scroll viewport: ${textOf(frame)}`);
    const clip = anchor.clip;
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * .82 }, { x, y: clip.y! + clip.h! * .22 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`title Gallery action did not become visibly reachable through real menu scrolling: ${textOf(frame)}`);
}

async function choose(session: NativeSession, frame: Frame, id: string): Promise<Frame> {
  const current = active(session);
  assert.equal(current?.kind, "choice");
  const option = (current!.options as ChoiceOption[]).find(item => item.id === id);
  assert.ok(option, `choice ${current!.id} has no ${id}`);
  // Durable state can precede the first painted camera/dissolve frame.
  // Resolve the hit point only when the actual option is fully visible.
  let visible = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    visible = (frame.ops ?? []).some(op => op.type === "text" && typeof op.text === "string"
      && compact(op.text).length >= 2 && compact(option!.text).startsWith(compact(op.text))
      && ((op.color ?? 0xff000000) >>> 24) >= 250);
    if (visible) break;
    frame = await session.frame();
  }
  assert.ok(visible, `choice ${id} did not become visibly actionable`);
  return session.settle(await session.tapPoint(center(optionOp(frame, option!.text), option!.text)), 2);
}

test("native Lantern gallery replays an unlocked ending without saving over the main journey and previews music on one overlay", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 8);
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await choose(session, frame, "ask_ren");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "last_train");
    frame = await driveToChoice(session, frame, "signal_window");
    frame = await choose(session, frame, "send_train");
    frame = await driveToEnding(session, frame, "last_train");
    assert.equal(active(session)?.kind, "ending");
    assert.equal(active(session)?.id, "last_train");
    assert.deepEqual(savedState(session)?.state?.meta?.endingIds, ["last_train"]);
    const mainSave = JSON.parse(JSON.stringify(session.storage["lantern.slot.auto"]));

    assert.ok(textOf(frame).includes("返回扉页"), `ending actions must remain visible: ${textOf(frame)}`);
    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 2);
    frame = await openTitleGallery(session, frame);
    assert.match(textOf(frame), /回看 · 信随末班车离港/, "the ending entry must be visible after its real ending unlocks");
    frame = await session.tap("回看 · 信随末班车离港", frame);
    for (let index = 0; index < 180 && !compact(textOf(frame)).includes("你把封好的信交还Mira"); index++) frame = await session.frame();
    assert.ok(compact(textOf(frame)).includes("你把封好的信交还Mira"), "the isolated replay engine must execute the ending's real dialogue");
    assert.equal(active(session)?.id, "last_train", "replay execution must not replace the durable autosave cursor");
    assert.deepEqual(session.storage["lantern.slot.auto"], mainSave, "dialogue playback in replay must not autosave into the main journey");
    assert.equal(textOf(frame).includes("返回原旅程"), true);
    frame = await session.tap("返回原旅程", frame);
    frame = await session.settle(frame, 4);
    frame = await revealText(session, frame, "试听 · 天亮以后");
    assert.match(textOf(frame), /试听 · 天亮以后/, "gallery music list must contain an actually-heard, registered cue");
    assert.deepEqual(session.storage["lantern.slot.auto"], mainSave, "exiting replay must leave the main save unchanged");

    const mainPlaysBeforePreview = session.requests.filter(request =>
      request.capability === "media.audio.play" && request.params.channel === "music").length;
    frame = await session.tap("试听 · 天亮以后", frame);
    frame = await session.settle(frame, 12);
    assert.ok(session.requests.some(request => request.capability === "media.audio.pause" && request.params.channel === "music"));
    assert.ok(session.requests.some(request => request.capability === "media.audio.play" &&
      request.params.channel === "music-preview" && request.params.asset === "audio/music_dawn.wav"));
    assert.equal(session.requests.filter(request =>
      request.capability === "media.audio.play" && request.params.channel === "music").length, mainPlaysBeforePreview,
    "preview must leave the original music player's request and playhead intact");

    frame = await session.tap("停止试听", frame);
    frame = await session.settle(frame, 8);
    assert.ok(session.requests.some(request => request.capability === "media.audio.stop" && request.params.channel === "music-preview"));
    assert.ok(session.requests.some(request => request.capability === "media.audio.resume" && request.params.channel === "music"));
    assert.equal(session.requests.filter(request =>
      request.capability === "media.audio.play" && request.params.channel === "music").length, mainPlaysBeforePreview);
    assert.deepEqual(session.storage["lantern.slot.auto"], mainSave);
  } finally {
    await session.quit();
  }
}, 210_000);
