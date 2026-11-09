import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { NativeSession, center, readNativeArtifacts, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before audio mix acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before audio mix acceptance");

const audioPlay = (session: NativeSession, channel: string) => session.requests.filter(request =>
  request.capability === "media.audio.play" && request.params.channel === channel);
const audioVolumes = (session: NativeSession, channel: string) => session.requests.filter(request =>
  request.capability === "media.audio.volume" && request.params.channel === channel);

function active(session: NativeSession): Record<string, any> | null {
  return (session.storage["lantern.slot.auto"] as { state?: { active?: Record<string, any> | null } } | undefined)?.state?.active ?? null;
}

async function revealTitleAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((frame.ops ?? []).some(op => op.type === "text" && op.text === label)) return frame;
    const clip = (frame.ops ?? []).find(op => op.type === "text" && op.clip && (op.clip.h ?? 0) > 120)?.clip;
    assert.ok(clip, `the title menu must expose its clipped scroll viewport: ${textOf(frame)}`);
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * 0.82 }, { x, y: clip.y! + clip.h! * 0.22 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`title action never became painted through real menu scrolling: ${label}\n${textOf(frame)}`);
}

function optionOp(frame: Frame, label: string): DrawOp {
  const compact = (value: string): string => value.replace(/[\s\u200b\ufeff]/g, "");
  const target = compact(label);
  const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string" && target.startsWith(compact(op.text)));
  assert.ok(candidates.length > 0, `choice text is not painted: ${label}\n${textOf(frame)}`);
  return candidates.sort((left, right) => compact(right.text!).length - compact(left.text!).length)[0]!;
}

async function advanceSay(session: NativeSession, frame: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected a dialogue line, got ${JSON.stringify(before)}`);
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
  throw new Error(`story did not advance beyond ${id}; active=${JSON.stringify(active(session))}; text=${textOf(frame)}`);
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

test("native Lantern audio settings adjust a live channel without restarting it and persist the mix", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 90_000 });
  try {
    let frame: Frame = await session.boot();
    assert.match(textOf(frame), /雾港末班信/);
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 12);
    assert.equal(audioPlay(session, "music").length, 1, "starting the story must create one live BGM channel");
    assert.equal(audioPlay(session, "music")[0]?.params.volume, 0.7);

    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("阅读偏好", frame);
    frame = await session.settle(frame, 2);
    assert.match(textOf(frame), /总音量 · 70%/);
    assert.match(textOf(frame), /音乐 · 100%/);
    assert.match(textOf(frame), /音效 · 100%/);
    assert.match(textOf(frame), /语音 · 100%/);

    frame = await session.tap("总音量 · 70%", frame);
    frame = await session.settle(frame, 8);
    assert.match(textOf(frame), /总音量 · 75%/);
    assert.equal(audioPlay(session, "music").length, 1, "changing a gain must not send another play request");
    assert.equal(audioVolumes(session, "music").at(-1)?.params.volume, 0.75);
    assert.deepEqual(session.storage["lantern.audio.mix"], { master: 0.75, music: 1, effects: 1, voice: 1 });

    const restoredStorage = JSON.parse(JSON.stringify(session.storage)) as Record<string, unknown>;
    await session.quit();
    const restored = new NativeSession(artifacts, { width: 360, height: 640, storage: restoredStorage, deadlineMs: 30_000 });
    try {
      frame = await restored.boot();
      frame = await revealTitleAction(restored, frame, "阅读偏好");
      frame = await restored.tap("阅读偏好", frame);
      frame = await restored.settle(frame, 3);
      assert.match(textOf(frame), /总音量 · 75%/, "the actual player UI must restore JS-stored audio mix settings");
      assert.equal(audioPlay(restored, "music").length, 0, "opening settings on the title screen must not eagerly play music");
    } finally { await restored.quit(); }
  } finally { await session.quit(); }
}, 120_000);

test("native New Game resets save progress and retains persistent reading meta", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 120_000 });
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 4);
    frame = await driveToChoice(session, frame, "arrival_approach");
    const approach = active(session)!;
    const askRen = (approach.options as Array<{ id: string; target: string; text: string }>).find(option => option.id === "ask_ren");
    assert.ok(askRen, "opening choice must preserve the original Ren route");
    frame = await session.tapPoint(center(optionOp(frame, askRen!.text), "ask_ren"));
    frame = await session.settle(frame, 1);
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await session.settle(frame, 12);

    const before = session.storage["lantern.slot.auto"] as { state: { variables: Record<string, unknown>; meta: { readLineIds: string[] } } };
    assert.equal(before.state.variables.ren_trust, 1, "the chosen story route must update the real save variable");
    assert.ok(before.state.meta.readLineIds.includes("arrival_ren_01"), "completed dialogue becomes persistent read meta");
    assert.equal(audioPlay(session, "music").length, 1);

    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 10);

    const after = session.storage["lantern.slot.auto"] as { state: { active: Record<string, any>; variables: Record<string, unknown>; meta: { readLineIds: string[] } } };
    assert.equal(after.state.active.id, "arrival_01");
    assert.equal(after.state.variables.ren_trust, 0, "save-lifetime progress resets with a new game");
    assert.ok(after.state.meta.readLineIds.includes("arrival_ren_01"), "completed dialogue meta survives a new game");
    assert.equal(audioPlay(session, "music").length, 2, "the current music cue starts on the new story after its stop boundary");
    assert.equal(session.requests.filter(request => request.capability === "media.audio.stop" && request.params.channel === "music").length, 1);
  } finally { await session.quit(); }
}, 150_000);
