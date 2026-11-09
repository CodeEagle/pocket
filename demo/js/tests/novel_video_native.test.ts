import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { createNovelEngine } from "../../../sdk/packages/pocket_vn/src/engine.ts";
import { decodeNovelSaveData, encodeNovelSaveData } from "../../../sdk/packages/pocket_vn/src/save-codec.ts";
import { localizeStory, rebaseNovelSaveDataForLocale } from "../../../sdk/packages/pocket_vn/src/localization.ts";
import lanternStory from "../apps/lantern/story.json";
import lanternLocales from "../apps/lantern/novel.locales.json";
import projectAssets from "../apps/lantern/novel.assets.json";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE = resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK = resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA = resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before video story acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before video story acceptance");

type ChoiceOption = { id: string; target: string; text: string };
type StoredSave = Record<string, any>;

function storedSave(session: NativeSession): StoredSave {
  const save = session.storage["lantern.slot.auto"] as StoredSave | undefined;
  assert.ok(save && save.format === "pocket-vn-save", "the main journey must use the platform autosave");
  return save!;
}

function active(session: NativeSession): Record<string, any> | null {
  return storedSave(session).state?.active ?? null;
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
    const centerX = op.x + op.w / 2;
    const centerY = op.y + op.h / 2;
    return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
  });
}

async function openTitleGallery(session: NativeSession, initialFrame: Frame): Promise<Frame> {
  let frame = initialFrame;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const galleryAction = visibleTextOp(frame, "雾港纪念");
    if (galleryAction) {
      frame = await session.tapPoint(center(galleryAction, "title gallery"));
      return session.settle(frame, 3);
    }

    // The fourth featured replay can push Gallery below the title menu's clip.
    // Drag that real scroll viewport until the complete Gallery action is visible.
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
  for (let index = 0; index < 500; index++) {
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

async function driveToEnding(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 500; index++) {
    const current = active(session);
    if (current?.kind === "ending") {
      assert.equal(current.id, "truth_letter");
      return frame;
    }
    if (current?.kind === "say") frame = await advanceSay(session, frame);
    else if (current?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected the true ending, got ${JSON.stringify(current)}`);
  }
  throw new Error("story did not reach the true ending");
}

async function choose(session: NativeSession, frame: Frame, id: string): Promise<Frame> {
  const current = active(session);
  assert.equal(current?.kind, "choice", `expected choice before selecting ${id}`);
  const option = (current!.options as ChoiceOption[]).find(item => item.id === id || item.target === id);
  assert.ok(option, `choice ${current!.id} does not offer ${id}`);
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
  return session.settle(await session.tapPoint(center(optionOp(frame, option!.text), `choice ${id}`)), 2);
}

async function tapReplayIntro(session: NativeSession, frame: Frame): Promise<Frame> {
  for (let index = 0; index < 120; index++) {
    if (compact(textOf(frame)).includes("镜头慢慢靠近") || compact(textOf(frame)).includes("cameradriftstoward")) return frame;
    frame = await session.tapPoint({ x: 180, y: 470 });
    frame = await session.settle(frame, 2);
  }
  throw new Error(`replay did not reach its video dialogue: ${textOf(frame)}`);
}

async function revealReplayAction(session: NativeSession, frame: Frame, label: string): Promise<Frame> {
  for (let index = 0; index < 12; index++) {
    if (textOf(frame).includes(label)) return frame;
    frame = await session.drag({ x: 180, y: 570 }, { x: 180, y: 160 }, 8, 2);
    frame = await session.settle(frame, 1);
  }
  throw new Error(`gallery replay action did not become visible: ${label}\n${textOf(frame)}`);
}

test("native Lantern QJBC replays the archive film without replacing the ending autosave", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    assert.ok(textOf(frame).includes("启程 · 开始新的故事"), "the title screen must offer a fresh story");
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 8);
    assert.equal(active(session)?.id, "arrival_01");

    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await choose(session, frame, "listen_mira");
    frame = await driveToChoice(session, frame, "memory_response");
    frame = await choose(session, frame, "trust_mira");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "archive_entry");
    frame = await driveToChoice(session, frame, "archive_read");
    frame = await choose(session, frame, "archive_route");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "clock_entry");
    frame = await driveToChoice(session, frame, "clock_test");
    frame = await choose(session, frame, "clock_single");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "roof_entry");
    frame = await driveToChoice(session, frame, "roof_inspection");
    frame = await choose(session, frame, "roof_log");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await choose(session, frame, "relay_entry");
    frame = await driveToChoice(session, frame, "relay_open");
    frame = await choose(session, frame, "open_dial");
    frame = await driveToChoice(session, frame, "dial_one");
    frame = await choose(session, frame, "route_7");
    frame = await driveToChoice(session, frame, "dial_two");
    frame = await choose(session, frame, "pulse_1");
    frame = await driveToChoice(session, frame, "dial_three");
    frame = await choose(session, frame, "minute_4");
    frame = await driveToChoice(session, frame, "memory_repeat_response");
    frame = await choose(session, frame, "affirm_mira");
    frame = await driveToChoice(session, frame, "signal_window");
    frame = await choose(session, frame, "send_truth");
    frame = await driveToEnding(session, frame);
    assert.ok(JSON.stringify(storedSave(session)).includes("truth_letter"), "the main autosave must contain the unlocked true ending");

    const journeyRecords = session.storageSets
      .filter(entry => String(entry.key).startsWith("lantern.slot."))
      .map(entry => ({ value: entry.value as StoredSave, bytes: Buffer.byteLength(JSON.stringify(entry.value), "utf8") }));
    const largestJourneyRecord = journeyRecords.reduce((largest, current) => current.bytes > largest.bytes ? current : largest);
    assert.ok(largestJourneyRecord.bytes <= 65_536,
      `the full archive/video journey save must fit native storage; largest=${largestJourneyRecord.bytes} bytes`);
    const localized = localizeStory(
      lanternStory as any,
      (lanternLocales as any).catalogs,
      "en",
      { assetRegistry: projectAssets as any },
    );
    const englishSave = rebaseNovelSaveDataForLocale(
      decodeNovelSaveData(largestJourneyRecord.value),
      lanternStory as any,
      localized.story,
    );
    const englishEncoded = encodeNovelSaveData(englishSave);
    const englishBytes = Buffer.byteLength(JSON.stringify(englishEncoded), "utf8");
    assert.ok(englishBytes <= 65_536,
      `the actual maximum archive/video save must fit after English locale rebase; largest=${englishBytes} bytes`);
    const englishEngine = createNovelEngine(localized.story);
    try {
      englishEngine.load(englishSave);
      assert.deepEqual(JSON.parse(JSON.stringify(englishEngine.save())), JSON.parse(JSON.stringify(englishSave)),
        "the maximum English-rebased save must restore the same expanded state");
      const rollbackCount = englishEngine.getSnapshot().rollbackAvailable;
      const rollback = englishEngine.rollback();
      assert.equal(rollback.snapshot.rollbackAvailable, rollbackCount - 1,
        "the English-rebased save must retain an executable rollback checkpoint");
    } finally {
      englishEngine.dispose();
    }
    console.log(`novel_video_native: full journey=${largestJourneyRecord.bytes}B; same maximum save rebased to actual English catalog=${englishBytes}B`);

    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 3);
    frame = await openTitleGallery(session, frame);
    const replayAction = "回看 · 七号邮路的旧胶片";
    frame = await revealReplayAction(session, frame, replayAction);
    const mainEndingSave = JSON.parse(JSON.stringify(storedSave(session)));
    assert.ok(JSON.stringify(mainEndingSave).includes("truth_letter"));
    frame = await session.tap(replayAction, frame);
    frame = await session.settle(frame, 8);
    frame = await tapReplayIntro(session, frame);

    const videoSurface = (frame.ops ?? []).find(op => op.type === "video") as (DrawOp & { asset?: string }) | undefined;
    assert.ok(videoSurface, `the compiled replay must create the real video surface operation\n${textOf(frame)}`);
    assert.equal(videoSurface?.asset, "assets/apps/lantern/videos/archive-route-reel.mp4");
    assert.ok(textOf(frame).includes("镜头慢慢靠近"), "video remains behind the actual replay dialogue");
    assert.deepEqual(storedSave(session), mainEndingSave, "active replay updates must not write over the main journey autosave");

    frame = await session.tap("关闭视频", frame);
    frame = await session.settle(frame, 4);
    assert.equal((frame.ops ?? []).some(op => op.type === "video"), false, "the story's close control must release its replay surface");
    frame = await session.tap("返回原旅程", frame);
    frame = await session.settle(frame, 6);
    assert.ok(textOf(frame).includes("雾港纪念"), "exiting replay must restore the gallery that was open before replay");
    assert.ok(textOf(frame).includes(replayAction), "the memories gallery must return to its prior view");
    assert.deepEqual(storedSave(session), mainEndingSave, "returning from replay must keep the main ending save intact");
    frame = await session.tap("返回", frame);
    frame = await session.settle(frame, 6);
    assert.ok(textOf(frame).includes("启程 · 开始新的故事"), "closing the restored gallery must return to its title page");
    assert.deepEqual(storedSave(session), mainEndingSave, "closing the gallery must not change the main ending save");
  } finally {
    const sizes = session.storageSets.filter(entry => String(entry.key).startsWith("lantern.slot."))
      .map(entry => Buffer.byteLength(JSON.stringify(entry.value), "utf8"));
    const largest = Math.max(...sizes);
    assert.ok(largest <= 65_536, `Archive/video route saves must fit native storage; largest=${largest} UTF-8 bytes`);
    console.log(`novel_video_native: largest route slot=${largest} UTF-8 bytes`);
    await session.quit();
  }
}, 210_000);
