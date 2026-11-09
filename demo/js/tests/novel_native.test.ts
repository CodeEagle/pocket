import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { resolveNovelCameraPose } from "../../../sdk/packages/pocket_vn/src/camera.ts";
import {
  NativeSession,
  center,
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
const dialoguePoint = { x: 180, y: 470 };
const endingGalleryEntries = [
  { id: "truth_letter", asset: "art/truth-letter.png", title: "跨越二十年的回信" },
  { id: "dawn_departure", asset: "art/dawn-departure.png", title: "天亮以前，信已启程" },
  { id: "harbor_light", asset: "art/harbor-light.png", title: "有人为雾港守灯" },
] as const;
const artifactDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(artifactDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(artifactDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(artifactDirectory, "app.bytecode.json");

const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "lantern QJBC must be built before the native acceptance test");
assert.ok(existsSync(artifacts.pakPath), "lantern asset pack must be built before the native acceptance test");
const storyDocument = JSON.parse(readFileSync(resolve(artifactDirectory, "../../../js/apps/lantern/story.json"), "utf8")) as {
  id?: string;
  version?: number;
  start?: string;
  script?: Record<string, Array<{
    type?: string;
    camera?: { x: number; y: number; scale: number };
    cameraMotion?: { durationMs?: number };
    transition?: { durationMs?: number };
  }>>;
};
assert.equal(storyDocument.id, storyId, "native test story identity must match the compiled game");
const openingScene = (storyDocument.script?.[storyDocument.start ?? "start"] ?? []).find(instruction => instruction.type === "scene");
assert.ok(openingScene?.camera, "Lantern opening scene must declare its camera pose for the native geometry assertion");

type SaveState = Record<string, any>;
type NovelSave = { formatVersion?: number; storyId?: string; storyVersion?: number; state?: SaveState };
type ChoiceOption = { id: string; target: string; text: string };

function latestSave(session: NativeSession): NovelSave {
  const save = session.storage[autosaveKey] as NovelSave | undefined;
  assert.ok(save && save.storyId === storyId, "game must write its current story state through platform.storage.set");
  return save!;
}

function active(session: NativeSession): Record<string, any> | null {
  return (latestSave(session).state?.active as Record<string, any> | null) ?? null;
}

function normalize(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

async function waitForActive(
  session: NativeSession,
  frame: Frame,
  predicate: (value: Record<string, any> | null) => boolean,
  description: string,
  maxFrames = 900,
): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    const state = active(session);
    if (predicate(state)) return latest;
    latest = await session.frame();
  }
  const state = active(session);
  throw new Error(`native game did not reach ${description}; active=${JSON.stringify(state)}; text=${textOf(latest)}`);
}

async function waitForSay(session: NativeSession, frame: Frame, id: string, maxFrames = 900): Promise<Frame> {
  return waitForActive(session, frame, value => value?.kind === "say" && value.id === id, `dialogue ${id}`, maxFrames);
}

async function driveToSay(session: NativeSession, initialFrame: Frame, expectedId: string, maxInstructions = 100): Promise<Frame> {
  let frame = initialFrame;
  for (let index = 0; index < maxInstructions; index += 1) {
    const current = active(session);
    if (current?.kind === "say" && current.id === expectedId) return frame;
    if (current?.kind === "say") {
      frame = await advanceSay(session, frame);
      continue;
    }
    if (current?.kind === "wait") {
      frame = await session.frame();
      continue;
    }
    throw new Error(`expected dialogue ${expectedId}, reached ${JSON.stringify(current)}`);
  }
  throw new Error(`story did not reach dialogue ${expectedId}; active=${JSON.stringify(active(session))}`);
}

async function waitForChoice(session: NativeSession, frame: Frame, id: string, maxFrames = 900): Promise<Frame> {
  return waitForActive(session, frame, value => value?.kind === "choice" && value.id === id, `choice ${id}`, maxFrames);
}

async function waitForEnding(session: NativeSession, frame: Frame, id: string, maxFrames = 1600): Promise<Frame> {
  return waitForActive(session, frame, value => value?.kind === "ending" && value.id === id, `ending ${id}`, maxFrames);
}

async function advanceSay(session: NativeSession, frame: Frame, expectedId?: string): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected a dialogue line, got ${JSON.stringify(before)}`);
  if (expectedId) assert.equal(before?.id, expectedId);
  const id = String(before!.id);

  let latest = await session.tapPoint(dialoguePoint);
  latest = await session.settle(latest, 1);
  let current = active(session);
  // First input reveals the current line. A previously complete line advances
  // immediately, so only send a second input while its identity is unchanged.
  if (current?.kind === "say" && current.id === id) {
    latest = await session.tapPoint(dialoguePoint);
    latest = await session.settle(latest, 1);
  }
  latest = await waitForActive(session, latest, value => value?.kind !== "say" || value.id !== id, `progress beyond ${id}`, 120);
  assert.notEqual(active(session)?.id, id, `dialogue tap did not advance beyond ${id}`);
  return latest;
}

async function driveToChoice(session: NativeSession, initialFrame: Frame, expectedId: string, maxInstructions = 500): Promise<Frame> {
  let frame = initialFrame;
  for (let index = 0; index < maxInstructions; index += 1) {
    const current = active(session);
    if (current?.kind === "choice") {
      assert.equal(current.id, expectedId, `expected choice ${expectedId}, reached ${current.id}`);
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
    if (current?.kind === "ending") throw new Error(`story reached ending ${current.id} before choice ${expectedId}`);
    frame = await session.frame();
  }
  throw new Error(`story did not reach choice ${expectedId}; active=${JSON.stringify(active(session))}`);
}

function choiceOption(session: NativeSession, idOrTarget: string): ChoiceOption {
  const choice = active(session);
  assert.equal(choice?.kind, "choice", `expected choice before selecting ${idOrTarget}`);
  const options = choice!.options as ChoiceOption[];
  const option = options.find(value => value.id === idOrTarget || value.target === idOrTarget);
  assert.ok(option, `choice ${choice!.id} does not offer ${idOrTarget}: ${options.map(value => value.id).join(", ")}`);
  return option!;
}

function findOptionTextOp(frame: Frame, optionText: string): DrawOp | undefined {
  const target = normalize(optionText);
  if (!target || !normalize(textOf(frame)).includes(target)) return undefined;
  const ops = (frame.ops ?? []).filter((op) => op.type === "text" && typeof op.text === "string");
  const candidates = ops.filter(op => {
    if (op.color !== undefined && ((op.color >>> 24) & 0xff) < 250) return false;
    const line = normalize(op.text!);
    return line.length >= 2 && target.startsWith(line);
  });
  return candidates.sort((a, b) => normalize(b.text!).length - normalize(a.text!).length)[0];
}

async function waitForOptionTextOp(session: NativeSession, frame: Frame, optionText: string, maxFrames = 120): Promise<{ frame: Frame; op: DrawOp }> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    const op = findOptionTextOp(latest, optionText);
    if (op) return { frame: latest, op };
    latest = await session.frame();
  }
  throw new Error(`choice option never became visibly painted and tappable: ${optionText}\n${textOf(latest)}`);
}

async function chooseOption(session: NativeSession, frame: Frame, idOrTarget: string): Promise<Frame> {
  const choice = active(session)!;
  const option = choiceOption(session, idOrTarget);
  const painted = await waitForOptionTextOp(session, frame, option.text);
  const latest = await session.tapPoint(center(painted.op, `choice ${option.id}`));
  return session.settle(latest, 1);
}

async function openMenu(session: NativeSession, frame: Frame): Promise<Frame> {
  const latest = await session.tap("手札", frame);
  return session.settle(latest, 1);
}

type Rect = { x?: number; y?: number; w?: number; h?: number };

function intersectRect(a: Rect, b: Rect): { x: number; y: number; w: number; h: number } | null {
  const left = Math.max(a.x ?? 0, b.x ?? 0, 0);
  const top = Math.max(a.y ?? 0, b.y ?? 0, 0);
  const right = Math.min(
    (a.x ?? 0) + (a.w ?? Number.POSITIVE_INFINITY),
    (b.x ?? 0) + (b.w ?? Number.POSITIVE_INFINITY),
  );
  const bottom = Math.min(
    (a.y ?? 0) + (a.h ?? Number.POSITIVE_INFINITY),
    (b.y ?? 0) + (b.h ?? Number.POSITIVE_INFINITY),
  );
  return right > left && bottom > top
    ? { x: left, y: top, w: right - left, h: bottom - top }
    : null;
}

function visibleRect(op: DrawOp, frame: Frame): { x: number; y: number; w: number; h: number } | null {
  if (typeof op.x !== "number" || typeof op.y !== "number" || typeof op.w !== "number" || typeof op.h !== "number") return null;
  return intersectRect(op, {
    x: op.clip?.x ?? 0,
    y: op.clip?.y ?? 0,
    w: op.clip?.w ?? frame.width ?? Number.POSITIVE_INFINITY,
    h: op.clip?.h ?? frame.height ?? Number.POSITIVE_INFINITY,
  });
}

function galleryViewport(frame: Frame): Rect {
  const textOps = (frame.ops ?? []).filter(op => op.type === "text" && op.clip && (op.clip.h ?? 0) > 120);
  const count = textOps.find(op => /已收集|Collected/.test(op.text ?? ""));
  // The count scrolls away on a long gallery page. Keep identifying the page
  // scroller from its content clip instead of falling back to the fixed panel
  // header, whose larger clip also contains the scroll area.
  const viewportOp = count ?? textOps
    .filter(op => op.clip)
    .sort((a, b) => (b.clip!.y ?? 0) - (a.clip!.y ?? 0) || (b.clip!.h ?? 0) - (a.clip!.h ?? 0))[0];
  assert.ok(viewportOp?.clip, `the gallery must expose its real clipped scroll viewport: ${textOf(frame)}`);
  return viewportOp!.clip!;
}

function galleryFrameSummary(frame: Frame): Record<string, unknown> {
  const text = (frame.ops ?? [])
    .filter(op => op.type === "text")
    .map(op => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h, color: op.color, clip: op.clip }));
  const images = endingGalleryEntries.map(entry => {
    const ops = (frame.ops ?? []).filter(op => assetName(op) === entry.asset);
    return {
      id: entry.id,
      count: ops.length,
      samples: ops.slice(0, 3).map(op => ({ x: op.x, y: op.y, w: op.w, h: op.h, clip: op.clip })),
    };
  });
  const clips = new Map<string, { clip: Rect; count: number; kinds: Set<string> }>();
  for (const op of frame.ops ?? []) {
    if (!op.clip) continue;
    const key = JSON.stringify(op.clip);
    const value = clips.get(key) ?? { clip: op.clip, count: 0, kinds: new Set<string>() };
    value.count += 1;
    value.kinds.add(op.type);
    clips.set(key, value);
  }
  return {
    width: frame.width,
    height: frame.height,
    text,
    images,
    clips: [...clips.values()].map(value => ({ clip: value.clip, count: value.count, kinds: [...value.kinds] })),
  };
}

function sameRect(a: Rect, b: Rect, tolerance = 1): boolean {
  return Math.abs((a.x ?? 0) - (b.x ?? 0)) <= tolerance
    && Math.abs((a.y ?? 0) - (b.y ?? 0)) <= tolerance
    && Math.abs((a.w ?? 0) - (b.w ?? 0)) <= tolerance
    && Math.abs((a.h ?? 0) - (b.h ?? 0)) <= tolerance;
}

function containedIn(rect: Rect, viewport: Rect, tolerance = 2): boolean {
  return (rect.x ?? 0) >= (viewport.x ?? 0) - tolerance
    && (rect.y ?? 0) >= (viewport.y ?? 0) - tolerance
    && (rect.x ?? 0) + (rect.w ?? 0) <= (viewport.x ?? 0) + (viewport.w ?? 0) + tolerance
    && (rect.y ?? 0) + (rect.h ?? 0) <= (viewport.y ?? 0) + (viewport.h ?? 0) + tolerance;
}

function galleryScrollSignature(frame: Frame, viewport = galleryViewport(frame)): string {
  return JSON.stringify((frame.ops ?? [])
    .filter(op => op.type === "text" && op.clip && sameRect(op.clip, viewport))
    .map(op => `${normalize(op.text ?? "")}@${Math.round((op.y ?? 0) * 10) / 10}`));
}

async function tryScrollGallery(
  session: NativeSession,
  frame: Frame,
  direction: "down" | "up",
): Promise<{
  frame: Frame;
  moved: boolean;
  diagnostic: Record<string, unknown>;
}> {
  const viewport = galleryViewport(frame);
  const before = galleryScrollSignature(frame, viewport);
  const x = (viewport.x ?? 0) + (viewport.w ?? frame.width ?? width) / 2;
  const fromY = (viewport.y ?? 0) + (viewport.h ?? 0) * (direction === "down" ? 0.82 : 0.2);
  const toY = (viewport.y ?? 0) + (viewport.h ?? 0) * (direction === "down" ? 0.22 : 0.82);
  const beforeFrame = galleryFrameSummary(frame);
  frame = await session.drag({ x, y: fromY }, { x, y: toY }, 8, 2);
  frame = await session.settle(frame, 2);
  const afterViewport = galleryViewport(frame);
  const after = galleryScrollSignature(frame, afterViewport);
  return {
    frame,
    moved: after !== before,
    diagnostic: {
      direction,
      pointer: { from: { x, y: fromY }, to: { x, y: toY }, steps: 8, holdFrames: 2 },
      viewportBefore: viewport,
      viewportAfter: afterViewport,
      beforeSignature: before,
      afterSignature: after,
      beforePaint: beforeFrame,
      afterPaint: galleryFrameSummary(frame),
    },
  };
}

async function scrollGallery(
  session: NativeSession,
  frame: Frame,
  direction: "down" | "up",
): Promise<Frame> {
  const result = await tryScrollGallery(session, frame, direction);
  assert.ok(result.moved,
    `a real pointer drag ${direction} must move content within the gallery clip; diagnostic=${JSON.stringify(result.diagnostic)}`);
  return result.frame;
}

function visibleGalleryTextOp(frame: Frame, fragment: string): DrawOp | undefined {
  const target = normalize(fragment);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || normalize(op.text ?? "") !== target) return false;
    const visible = visibleRect(op, frame);
    if (!visible) return false;
    const x = (op.x ?? 0) + (op.w ?? 0) / 2;
    const y = (op.y ?? 0) + (op.h ?? 0) / 2;
    return x >= visible.x && x <= visible.x + visible.w && y >= visible.y && y <= visible.y + visible.h;
  });
}

async function scrollGalleryUntilText(
  session: NativeSession,
  initialFrame: Frame,
  fragment: string,
  direction: "down" | "up",
  imageAsset?: string,
): Promise<Frame> {
  let frame = initialFrame;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const titleVisible = visibleGalleryTextOp(frame, fragment);
    const imageVisible = imageAsset === undefined || galleryEntryAssetOps(frame, imageAsset)
      .some(op => visibleRect(op, frame) !== null);
    if (titleVisible && imageVisible) return frame;
    // Captions follow their images. A visible caption alone can sit below an
    // image that has already scrolled out above the clip; reveal both before
    // treating that card as visible.
    frame = await scrollGallery(session, frame, titleVisible && !imageVisible ? "up" : direction);
  }
  throw new Error(`gallery text did not become visible after real scrolling: ${fragment}; painted=${textOf(frame)}`);
}

function assetName(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function galleryEntryAssetOps(frame: Frame, asset: string): DrawOp[] {
  const viewport = galleryViewport(frame);
  return (frame.ops ?? []).filter(op => {
    if (assetName(op) !== asset || !op.clip) return false;
    return containedIn(op.clip, viewport);
  });
}

function galleryPageAssetIds(frame: Frame): string[] {
  return endingGalleryEntries
    .filter(entry => galleryEntryAssetOps(frame, entry.asset).length > 0)
    .map(entry => entry.id);
}

function assertGalleryPageAssets(frame: Frame, expectedIds: readonly string[]): void {
  const viewport = galleryViewport(frame);
  const actualIds = galleryPageAssetIds(frame);
  assert.deepEqual(actualIds, expectedIds, `the rendered gallery page must contain exactly its unlocked cards inside the clipped list; viewport=${JSON.stringify(viewport)}; painted=${textOf(frame)}`);
}

async function waitForGalleryPageAssets(
  session: NativeSession,
  initialFrame: Frame,
  expectedIds: readonly string[],
): Promise<Frame> {
  let frame = initialFrame;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (JSON.stringify(galleryPageAssetIds(frame)) === JSON.stringify(expectedIds)) return frame;
    frame = await session.frame();
  }
  throw new Error(`gallery did not render page assets ${expectedIds}; actual=${galleryPageAssetIds(frame)}; painted=${textOf(frame)}`);
}

function assertGalleryEntryVisible(frame: Frame, id: typeof endingGalleryEntries[number]["id"]): void {
  const entry = endingGalleryEntries.find(item => item.id === id)!;
  const viewport = galleryViewport(frame);
  assert.ok(visibleGalleryTextOp(frame, entry.title), `gallery title ${entry.title} must be visibly scrollable`);
  const visibleImage = galleryEntryAssetOps(frame, entry.asset).some(op => {
    const visible = visibleRect(op, frame);
    return visible !== null && intersectRect(visible, viewport) !== null;
  });
  assert.ok(visibleImage, `gallery image ${entry.asset} must be painted inside the actual scroll clip; diagnostic=${JSON.stringify(galleryFrameSummary(frame))}`);
}

function assertGalleryAutosaveUnchanged(
  session: NativeSession,
  beforeBytes: Buffer,
  beforeMeta: unknown,
  beforeWrites: number,
): void {
  const save = latestSave(session);
  assert.deepEqual(Buffer.from(JSON.stringify(save), "utf8"), beforeBytes,
    "gallery scrolling and pagination must preserve the main autosave byte-for-byte");
  assert.deepEqual(save.state?.meta, beforeMeta,
    "gallery paging must not change the three naturally unlocked endings or CG metadata");
  assert.equal(session.storageSets.filter(params => params.key === autosaveKey).length, beforeWrites,
    "gallery view-only interactions must not issue another main autosave write");
}

async function verifyUnlockedGalleryPagination(session: NativeSession, initialFrame: Frame): Promise<Frame> {
  const endingSave = latestSave(session);
  const endingMeta = structuredClone(endingSave.state!.meta);
  const expectedCgIds = endingGalleryEntries.map(entry => entry.id).sort();
  assert.deepEqual([...endingMeta.cgIds].sort(), expectedCgIds,
    "all three gallery entries must be unlocked by the actual three completed story routes");
  const saveBytes = Buffer.from(JSON.stringify(endingSave), "utf8");
  const autoWrites = session.storageSets.filter(params => params.key === autosaveKey).length;

  let frame = await session.tap("返回扉页", initialFrame);
  frame = await session.settle(frame, 2);
  for (let attempt = 0; attempt < 12 && !visibleGalleryTextOp(frame, "雾港纪念"); attempt += 1) {
    const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip
      && ["5分钟", "能力巡演", "开始新的故事"].some(label => (op.text ?? "").includes(label)));
    assert.ok(anchor?.clip, `the title menu must expose its scroll clip: ${textOf(frame)}`);
    const clip = anchor.clip;
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * .82 }, { x, y: clip.y! + clip.h! * .22 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  const galleryAction = visibleGalleryTextOp(frame, "雾港纪念");
  assert.ok(galleryAction, "the title gallery action must become visibly reachable through real menu scrolling");
  frame = await session.tapPoint(center(galleryAction, "title gallery"));
  frame = await session.settle(frame, 2);
  assert.ok(textOf(frame).includes("已收集 3 / 3 张记忆"), "the gallery must reflect the three CGs unlocked by route completion");
  frame = await waitForGalleryPageAssets(session, frame, ["truth_letter", "dawn_departure"]);

  // Scroll to the bottom of page 1, then back through the clipped card list.
  // These are real pointer gestures; no gallery page or CG state is injected.
  frame = await scrollGallery(session, frame, "down");
  frame = await scrollGalleryUntilText(session, frame, "翻阅下一页", "down");
  assert.equal(galleryEntryAssetOps(frame, "art/harbor-light.png").length, 0,
    "the third unlocked CG must remain absent when the first-page pager is visible");
  assertGalleryAutosaveUnchanged(session, saveBytes, endingMeta, autoWrites);
  frame = await scrollGalleryUntilText(session, frame, endingGalleryEntries[0].title, "up", endingGalleryEntries[0].asset);
  assertGalleryEntryVisible(frame, "truth_letter");
  frame = await scrollGalleryUntilText(session, frame, endingGalleryEntries[1].title, "down", endingGalleryEntries[1].asset);
  assertGalleryEntryVisible(frame, "dawn_departure");
  assert.equal(galleryEntryAssetOps(frame, "art/harbor-light.png").length, 0,
    "the third unlocked CG must not be mounted anywhere on page 1, even while scrolling");

  frame = await scrollGalleryUntilText(session, frame, "翻阅下一页", "down");
  frame = await session.tapPoint(center(visibleGalleryTextOp(frame, "翻阅下一页")!, "gallery next page"));
  frame = await session.settle(frame, 2);
  frame = await scrollGalleryUntilText(session, frame, endingGalleryEntries[2].title, "up", endingGalleryEntries[2].asset);
  assertGalleryEntryVisible(frame, "harbor_light");
  assertGalleryPageAssets(frame, ["harbor_light"]);
  assertGalleryAutosaveUnchanged(session, saveBytes, endingMeta, autoWrites);

  frame = await scrollGalleryUntilText(session, frame, "翻阅下一页", "down");
  frame = await session.tapPoint(center(visibleGalleryTextOp(frame, "翻阅下一页")!, "gallery next page cycle"));
  frame = await session.settle(frame, 2);
  frame = await scrollGalleryUntilText(session, frame, endingGalleryEntries[0].title, "up", endingGalleryEntries[0].asset);
  assertGalleryEntryVisible(frame, "truth_letter");
  frame = await scrollGalleryUntilText(session, frame, endingGalleryEntries[1].title, "down", endingGalleryEntries[1].asset);
  assertGalleryEntryVisible(frame, "dawn_departure");
  assertGalleryPageAssets(frame, ["truth_letter", "dawn_departure"]);
  assert.equal(galleryEntryAssetOps(frame, "art/harbor-light.png").length, 0,
    "cycling next page must return to the first two CGs, not append the third");
  assertGalleryAutosaveUnchanged(session, saveBytes, endingMeta, autoWrites);
  frame = await session.tap("返回", frame);
  frame = await session.settle(frame, 1);
  assertGalleryAutosaveUnchanged(session, saveBytes, endingMeta, autoWrites);
  return frame;
}

async function waitForSlotPage(session: NativeSession, frame: Frame): Promise<Frame> {
  for (let index = 0; index < 120; index += 1) {
    if (!textOf(frame).includes("正在读取")) return frame;
    frame = await session.frame();
  }
  throw new Error(`slot summaries did not finish loading: ${textOf(frame)}`);
}

async function saveSlotOne(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await openMenu(session, frame);
  frame = await session.tap("封存此刻", frame);
  frame = await waitForSlotPage(session, frame);
  frame = await session.tap("信笺 1", frame);
  for (let index = 0; index < 120 && !session.storage["lantern.slot.1"]; index += 1) frame = await session.frame();
  const save = session.storage["lantern.slot.1"] as NovelSave | undefined;
  assert.equal(save?.storyId, storyId, "manual save slot must contain the current compiled story");
  return frame;
}

async function loadSlotOne(session: NativeSession, frame: Frame): Promise<Frame> {
  frame = await openMenu(session, frame);
  frame = await session.tap("重读信笺", frame);
  frame = await waitForSlotPage(session, frame);
  frame = await session.tap("信笺 1", frame);
  frame = await session.settle(frame, 2);
  return frame;
}

async function startNewGame(session: NativeSession, frame: Frame, firstLine = "arrival_01"): Promise<Frame> {
  frame = await session.tap("再写一封信", frame);
  frame = await session.settle(frame, 2);
  return waitForSay(session, frame, firstLine);
}

async function finishFromCurrentState(session: NativeSession, frame: Frame, endingId: string): Promise<Frame> {
  for (let index = 0; index < 250; index += 1) {
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

async function run(): Promise<void> {
  const session = new NativeSession(artifacts, { width, height, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    assert.equal(frame.width, width);
    assert.equal(frame.height, height);
    assert.match(textOf(frame), /雾港末班信/);
    assert.ok(textOps(frame, "启程 · 开始新的故事").length > 0, "title screen should expose New Game through the native painter");

    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 2);
    frame = await waitForSay(session, frame, "arrival_01");
    assert.ok(session.requests.some(request => request.capability === "media.audio.play"), "starting the story must dispatch a real host audio request");
    frame = await session.settle(frame, 60);
    const openingMotionMs = Math.max(openingScene.cameraMotion?.durationMs ?? 0, openingScene.transition?.durationMs ?? 0);
    for (let index = 0; index < Math.ceil(openingMotionMs / 16) + 2; index += 1) frame = await session.frame();
    const actorOps = frame.ops as Array<DrawOp & { asset?: string }>;
    const renTriangles = actorOps.filter(op => op.type === "textureTriangle" && op.asset === "art/ren-neutral.png");
    assert.ok(renTriangles.length > 0, "the rotated image must reach the native triangle painter");
    const radians = 2 * Math.PI / 180;
    const authoredCorner = { x: 144 - Math.sin(radians) * 350 * 0.92, y: 116 + Math.cos(radians) * 350 * 0.92 };
    // Camera motion is canonical stage state but the autosave is event-driven,
    // so its elapsed time is not a per-frame renderer clock. Wait for the
    // authored motion above, then compare against its static target pose.
    const camera = resolveNovelCameraPose({ ...openingScene.camera!, motion: null });
    const bottomLeft = {
      x: width / 2 + (authoredCorner.x - width / 2) * camera.scale + camera.x,
      y: height / 2 + (authoredCorner.y - height / 2) * camera.scale + camera.y,
    };
    const renPoints = renTriangles.flatMap(op => op.points ?? []);
    const closestRenPoint = renPoints.slice().sort((a, b) => Math.hypot(a.x - bottomLeft.x, a.y - bottomLeft.y) - Math.hypot(b.x - bottomLeft.x, b.y - bottomLeft.y))[0];
    assert.ok(renPoints.some(point => Math.abs(point.x - bottomLeft.x) <= 1 && Math.abs(point.y - bottomLeft.y) <= 1), `native vertices must contain the authored scaled and rotated corner transformed by the saved/resolved camera pose; camera=${JSON.stringify(camera)} expected=${JSON.stringify(bottomLeft)} nearest=${JSON.stringify(closestRenPoint)}`);
    const firstMira = actorOps.findIndex(op => op.type === "textureTriangle" && op.asset === "art/mira-worried.png");
    const lastRen = actorOps.findLastIndex(op => op.type === "textureTriangle" && op.asset === "art/ren-neutral.png");
    assert.ok(firstMira > lastRen && lastRen >= 0, "authored layer must draw Mira after Ren despite story insertion order");

    frame = await saveSlotOne(session, frame);
    frame = await session.tap("返回", frame);
    frame = await session.settle(frame, 1);
    frame = await advanceSay(session, frame, "arrival_01");
    frame = await waitForSay(session, frame, "arrival_02");

    frame = await loadSlotOne(session, frame);
    assert.equal(active(session)?.id, "arrival_01", "loading a manual slot must restore its actual active line");
    frame = await advanceSay(session, frame, "arrival_01");
    frame = await waitForSay(session, frame, "arrival_02");

    // The active line is unseen. Seen-only skip may reveal it, but must stop
    // instead of passing it automatically.
    frame = await session.tap("已读跳过", frame);
    frame = await session.settle(frame, 1);
    frame = await session.tapPoint(dialoguePoint);
    frame = await session.settle(frame, 8);
    assert.equal(active(session)?.id, "arrival_02", "seen-only skip must stop at unread dialogue");
    assert.ok(normalize(textOf(frame)).includes(normalize(String(active(session)?.text))), "unread dialogue should still become fully visible");
    frame = await session.tap("跳读中", frame);
    frame = await session.settle(frame, 1);
    frame = await advanceSay(session, frame, "arrival_02");
    frame = await waitForSay(session, frame, "arrival_03");

    frame = await session.tap("回溯", frame);
    frame = await session.settle(frame, 1);
    assert.equal(active(session)?.id, "arrival_02", "rollback should restore the preceding completed line in the real guest");
    frame = await advanceSay(session, frame, "arrival_02");
    frame = await waitForSay(session, frame, "arrival_03");

    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await chooseOption(session, frame, "listen_mira");
    frame = await driveToChoice(session, frame, "memory_response");
    frame = await chooseOption(session, frame, "trust_mira");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await chooseOption(session, frame, "archive_entry");
    frame = await driveToChoice(session, frame, "archive_read");
    frame = await chooseOption(session, frame, "archive_route");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await chooseOption(session, frame, "clock_entry");
    frame = await driveToChoice(session, frame, "clock_test");
    frame = await chooseOption(session, frame, "clock_single");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await chooseOption(session, frame, "roof_entry");
    frame = await driveToChoice(session, frame, "roof_inspection");
    frame = await chooseOption(session, frame, "roof_log");
    frame = await driveToChoice(session, frame, "investigation_hub");
    const clues = latestSave(session).state?.variables;
    assert.deepEqual([clues?.found_route, clues?.found_clock, clues?.found_lens], [true, true, true], "all three discovered clues must reach the guest state");

    frame = await chooseOption(session, frame, "relay_entry");
    frame = await driveToChoice(session, frame, "relay_open");
    frame = await chooseOption(session, frame, "open_dial");
    frame = await driveToChoice(session, frame, "dial_one");
    frame = await chooseOption(session, frame, "route_7");
    frame = await driveToChoice(session, frame, "dial_two");
    frame = await chooseOption(session, frame, "pulse_1");
    frame = await driveToChoice(session, frame, "dial_three");
    frame = await chooseOption(session, frame, "minute_4");
    frame = await waitForSay(session, frame, "dial_success_01");
    frame = await advanceSay(session, frame);
    frame = await waitForSay(session, frame, "dial_success_02");
    frame = await advanceSay(session, frame);
    frame = await waitForSay(session, frame, "dial_success_03");
    frame = await advanceSay(session, frame);
    frame = await driveToChoice(session, frame, "memory_repeat_response");
    frame = await chooseOption(session, frame, "affirm_mira");
    frame = await waitForSay(session, frame, "memory_trust_01");
    frame = await advanceSay(session, frame);
    frame = await driveToSay(session, frame, "window_01");
    frame = await advanceSay(session, frame);
    frame = await waitForSay(session, frame, "window_02");
    frame = await advanceSay(session, frame);
    frame = await driveToChoice(session, frame, "signal_window");
    assert.ok((active(session)?.options as ChoiceOption[]).some(option => option.id === "send_truth"), "true ending becomes available only after evidence and trust reach the compiled guest choice");
    frame = await chooseOption(session, frame, "send_truth");
    frame = await session.settle(frame, 20);
    const transitionImages = (frame.ops ?? []).filter(op => op.type === "image") as Array<DrawOp & { asset?: string }>;
    assert.ok(transitionImages.some(op => op.asset === "art/roof.png"), "dissolve must retain the previous scene in the native draw list");
    const dawn = transitionImages.find(op => op.asset === "art/dawn.png");
    assert.ok(dawn && ((dawn.color! >>> 24) > 0) && ((dawn.color! >>> 24) < 255), "dissolve must draw the new scene with intermediate alpha, rather than a black-mask substitute");
    frame = await finishFromCurrentState(session, frame, "truth_letter");
    let state = latestSave(session).state!;
    assert.ok(state.meta.endingIds.includes("truth_letter"), "true ending metadata must persist through host storage");
    assert.ok(state.meta.cgIds.includes("truth_letter"), "true CG metadata must persist through host storage");

    // A fresh game keeps read metadata, then the last-train route is allowed to
    // expire through real guest clock frames and follows its safe timeout.
    frame = await startNewGame(session, frame);
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await chooseOption(session, frame, "check_seal");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await chooseOption(session, frame, "signal_window");
    frame = await waitForSay(session, frame, "window_01");
    frame = await advanceSay(session, frame);
    frame = await waitForSay(session, frame, "window_02");
    frame = await advanceSay(session, frame);
    frame = await driveToChoice(session, frame, "signal_window");
    for (let index = 0; index < 1100 && active(session)?.id !== "timeout_01"; index += 1) frame = await session.frame();
    frame = await waitForSay(session, frame, "timeout_01", 20);
    state = latestSave(session).state!;
    assert.equal(state.variables.timed_out, true, "the 16 second window must take the explicit timeout branch");
    frame = await finishFromCurrentState(session, frame, "last_train");
    state = latestSave(session).state!;
    assert.ok(state.meta.endingIds.includes("last_train"), "timeout should finish the train ending");
    assert.ok(state.meta.cgIds.includes("dawn_departure"), "train CG should be unlocked");

    frame = await startNewGame(session, frame);
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await chooseOption(session, frame, "check_seal");
    frame = await driveToChoice(session, frame, "investigation_hub");
    frame = await chooseOption(session, frame, "signal_window");
    frame = await waitForSay(session, frame, "window_01");
    frame = await advanceSay(session, frame);
    frame = await waitForSay(session, frame, "window_02");
    frame = await advanceSay(session, frame);
    frame = await driveToChoice(session, frame, "signal_window");
    frame = await chooseOption(session, frame, "keep_light");
    frame = await finishFromCurrentState(session, frame, "keep_the_light");
    state = latestSave(session).state!;
    assert.ok(state.meta.endingIds.includes("truth_letter"));
    assert.ok(state.meta.endingIds.includes("last_train"));
    assert.ok(state.meta.endingIds.includes("keep_the_light"));
    assert.ok(state.meta.cgIds.includes("harbor_light"));
    frame = await verifyUnlockedGalleryPagination(session, frame);
    assert.ok(session.requests.some(request => request.capability === "media.audio.play" && request.params.asset), "audio cues must cross the registered host boundary as asset requests");
    assert.ok(session.storageSets.some(params => params.key === "lantern.slot.1"), "manual save must use the existing platform storage capability");
    const saveSizes = session.storageSets
      .filter(params => String(params.key).startsWith("lantern.slot."))
      .map(params => Buffer.byteLength(JSON.stringify(params.value), "utf8"));
    const largestSave = session.storageSets
      .filter(params => String(params.key).startsWith("lantern.slot."))
      .map(params => ({ value: params.value as Record<string, any>, bytes: Buffer.byteLength(JSON.stringify(params.value), "utf8") }))
      .reduce((largest, current) => current.bytes > largest.bytes ? current : largest);
    assert.ok(Math.max(...saveSizes) <= 65_536,
      `Every actual route save must fit the native per-value storage limit; largest=${Math.max(...saveSizes)} bytes`);
    const routeSaves = session.storageSets.filter(params => String(params.key).startsWith("lantern.slot."));
    assert.ok(routeSaves.every(params => (params.value as Record<string, any>).formatVersion === 4),
      "every actual route save must use the compact V4 persistence format");

    const textPool = largestSave.value.state.textPool as unknown[];
    assert.ok(Array.isArray(textPool) && textPool.every(text => typeof text === "string"),
      "the largest actual route save must contain the V4 shared rendered-text pool");
    assert.equal(new Set(textPool).size, textPool.length, "V4 text entries must be interned once by exact rendered text");
    const referencedTexts = new Set<number>();
    const backlog = largestSave.value.state.backlog as Array<unknown[]>;
    assert.ok(backlog.every(entry => entry.length === 7 && Number.isSafeInteger(entry[6])
      && (entry[6] as number) >= 0 && (entry[6] as number) < textPool.length),
    "V4 backlog tuples must reference text in the shared pool");
    for (const entry of backlog) referencedTexts.add(entry[6] as number);
    const activePool = largestSave.value.state.rollbackHistory.pools.active as Array<unknown[]>;
    assert.ok(activePool.every(entry => entry.length === 8
      && typeof entry[0] === "string" && Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0
      && typeof entry[2] === "string" && Number.isSafeInteger(entry[5])
      && (entry[5] as number) >= 0 && (entry[5] as number) < textPool.length
      && entry[6] === Array.from(textPool[entry[5] as number] as string).length
      && (entry[7] === null || (typeof entry[7] === "number" && Number.isFinite(entry[7]) && entry[7] >= 0))),
    "V4 checkpoint active tuples must preserve completed say identity, shared text references, reveal progress and auto delay");
    for (const entry of activePool) referencedTexts.add(entry[5] as number);
    assert.equal(referencedTexts.size, textPool.length, "the actual V4 text pool must have no unreferenced rendered text");
    const activePoolBytes = Buffer.byteLength(JSON.stringify(activePool), "utf8");

    console.log(`novel_native: native QJBC input passed save/load, rollback, seen-only skip, all three endings and timeout; largest V4 slot=${largestSave.bytes} UTF-8 bytes; text pool=${textPool.length}, active tuples=${activePool.length}/${activePoolBytes}B (abi=${artifacts.runtimeAbi})`);
    await session.quit();
  } finally {
    session.forceKill();
  }
}

test("native lantern QJBC accepts story input, completes endings, and pages unlocked gallery", run, 180_000);
