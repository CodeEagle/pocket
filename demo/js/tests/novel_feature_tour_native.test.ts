import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { resolveNovelCameraPose } from "../../../sdk/packages/pocket_vn/src/camera.ts";
import { createNovelChoiceSurfaceLayout } from "../../../sdk/packages/pocket_vn/src/choice-surface.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import { NativeSession, center, readNativeArtifacts, textOf, textOp, type DrawOp, type Frame } from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
const sourceDirectory = resolve(import.meta.dir, "../apps/lantern");
const existingSaveFixture = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/lantern-v1-native-save.json"), "utf8")) as {
  storage: Record<string, unknown>;
};
const sourceStory = JSON.parse(readFileSync(resolve(sourceDirectory, "story.json"), "utf8")) as {
  script: Record<string, TourInstruction[]>;
};
const sourceAssets = JSON.parse(readFileSync(resolve(sourceDirectory, "novel.assets.json"), "utf8")) as {
  choiceSurfaces: Record<string, TourChoiceSurface>;
  imageDimensions?: Record<string, { width: number; height: number }>;
};
// Keep the staged Guest as the local default but permit a test run to pin an
// isolated candidate without touching demo/assets.
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern Guest must be built before feature-tour acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before feature-tour acceptance");

type TourOption = { id: string; text: string; target: string };
type TourInstruction = {
  type?: string;
  id?: string;
  text?: string;
  target?: string;
  options?: TourOption[];
  camera?: { x: number; y: number; scale: number };
};
type TourChoiceSurface = {
  kind: "scene" | "dial";
  image?: string;
  frame?: { x: number; y: number; w: number; h: number };
  targets: Record<string, { x: number; y: number; w: number; h: number }>;
};

function sourceChoice(id: string): { label: string; instructions: TourInstruction[]; index: number; choice: TourInstruction } {
  for (const [label, instructions] of Object.entries(sourceStory.script)) {
    const index = instructions.findIndex(item => item.type === "choice" && item.id === id);
    if (index >= 0) return { label, instructions, index, choice: instructions[index]! };
  }
  assert.fail(`story source is missing choice ${id}`);
}

function pngDimensions(path: string): { width: number; height: number } {
  const data = readFileSync(resolve(sourceDirectory, path));
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} must be a PNG asset`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function authoredCamera(choiceId: string): { x: number; y: number; scale: number; motion: null } {
  const found = sourceChoice(choiceId);
  for (let index = found.index - 1; index >= 0; index -= 1) {
    const item = found.instructions[index];
    if (item?.type === "scene" && item.camera) {
      return { ...item.camera, motion: null };
    }
  }
  // The replay starts at feature_tour, whose first scene resets the stage. A
  // branch without another scene inherits that same canonical camera pose.
  for (const item of sourceStory.script.feature_tour ?? []) {
    if (item.type === "scene" && item.camera) return { ...item.camera, motion: null };
  }
  return { x: 0, y: 0, scale: 1, motion: null };
}

function tourTargetCenter(frame: { width?: number; height?: number }, choiceId: string, optionId: string): { x: number; y: number } {
  const found = sourceChoice(choiceId);
  assert.ok(Array.isArray(found.choice.options), `choice ${choiceId} has source options`);
  const surface = sourceAssets.choiceSurfaces[choiceId];
  assert.ok(surface, `asset registry maps the actual ${choiceId} choice surface`);
  const width = frame.width ?? 390;
  const height = frame.height ?? 844;
  const dimensions = surface.kind === "dial" && surface.image
    ? sourceAssets.imageDimensions?.[surface.image] ?? pngDimensions(surface.image)
    : undefined;
  const pose = resolveNovelCameraPose(authoredCamera(choiceId));
  const layout = createNovelChoiceSurfaceLayout(surface, found.choice.options!, width, height, dimensions, 44 / pose.scale);
  assert.ok(layout, `the ${choiceId} surface must keep every option within a native-size hit region`);
  const target = layout!.targets.find(item => item.option.id === optionId);
  assert.ok(target, `${choiceId} maps active option ${optionId} onto a real target`);
  return {
    x: width / 2 + (target!.x + target!.width / 2 - width / 2) * pose.scale + pose.x,
    y: height / 2 + (target!.y + target!.height / 2 - height / 2) * pose.scale + pose.y,
  };
}

function includesAll(frame: { ops?: Array<{ type?: string; text?: string }> }, fragments: readonly string[]): boolean {
  const painted = textOf(frame as Parameters<typeof textOf>[0]).replace(/\s/g, "");
  return fragments.every(fragment => painted.includes(fragment.replace(/\s/g, "")));
}

function paintedTourCaptionCenter(frame: Frame, choiceId: string, caption: string): { x: number; y: number } {
  const normalized = caption.replace(/\s/g, "");
  const op = (frame.ops ?? []).find(item => item.type === "text" && (item.text ?? "").replace(/\s/g, "").includes(normalized));
  assert.ok(op, `the active ${choiceId} option caption is painted as a native text op: ${caption}; frame=${textOf(frame)}`);
  return center(op!, `${choiceId} painted option ${caption}`);
}

async function waitForTourChoice(
  session: NativeSession,
  initial: Frame,
  choiceId: string,
  waitForTransition = true,
): Promise<Frame> {
  const found = sourceChoice(choiceId);
  const captions = (found.choice.options ?? []).map(option => option.text);
  assert.ok(captions.length > 0, `choice ${choiceId} has localized source captions`);
  let frame = initial;
  let previousViewportLayers: string | undefined;
  let stableViewportLayers = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (includesAll(frame, captions)) {
      if (!waitForTransition) return frame;
      // Fade scenes paint destination controls before the full-screen veil is
      // removed. Wait for those rendered layers to stop changing, then tap
      // the actual option center; never click through the transition.
      const viewportLayers = viewportLayerSignature(frame);
      stableViewportLayers = viewportLayers === previousViewportLayers ? stableViewportLayers + 1 : 0;
      previousViewportLayers = viewportLayers;
      if (stableViewportLayers >= 3) return frame;
      frame = await session.frame();
      continue;
    }
    previousViewportLayers = undefined;
    stableViewportLayers = 0;
    // This is a real touch on the dialogue plate. On an unrevealed line the
    // first touch reveals it; subsequent touches advance the authored script.
    // Spatial choices are positioned above this point, so it cannot select an
    // option while waiting for the requested hub/dial labels.
    frame = await session.tapPoint({ x: (frame.width ?? session.width) / 2, y: (frame.height ?? session.height) * 0.86 });
  }
  throw new Error(`timed out reaching ${choiceId}; painted=${textOf(frame)}`);
}

function viewportLayerSignature(frame: Frame): string {
  return JSON.stringify((frame.ops ?? [])
    .filter(op => op.type === "rect" && op.x === 0 && op.y === 0 && op.w === frame.width && op.h === frame.height)
    .map(op => op.color));
}

function hasActiveFadeOverlay(frame: Frame): boolean {
  return (frame.ops ?? []).some(op => op.type === "rect" && op.x === 0 && op.y === 0 &&
    op.w === frame.width && op.h === frame.height && ((op.color ?? 0) >>> 24) < 255);
}

async function waitForViewportLayersStable(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  let previous: string | undefined;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const signature = viewportLayerSignature(frame);
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 3) return frame;
    frame = await session.frame();
  }
  throw new Error(`timed out waiting for the transition veil to leave; painted=${textOf(frame)}`);
}

function assertSurfacePointMatchesPaintedCenter(geometry: { x: number; y: number }, painted: { x: number; y: number }, label: string): void {
  assert.ok(Math.abs(geometry.x - painted.x) <= 16 && Math.abs(geometry.y - painted.y) <= 16,
    `${label} painted center should match its authored target center: geometry=${JSON.stringify(geometry)} painted=${JSON.stringify(painted)}`);
}

test("native title exposes the feature tour beside the legacy model replay and keeps the main autosave isolated", async () => {
  const seededStorage = structuredClone(existingSaveFixture.storage);
  const originalAuto = JSON.stringify(seededStorage["lantern.slot.auto"]);
  assert.ok(originalAuto && originalAuto !== "null", "the title isolation case starts with a real legacy autosave");
  const originalAutoBytes = Buffer.from(originalAuto, "utf8");
  const session = new NativeSession(artifacts, { width: 390, height: 844, storage: seededStorage, deadlineMs: 90_000 });
  const storageMutationCount = () => session.requests.filter(request =>
    request.capability === "platform.storage.set" ||
    request.capability === "platform.storage.remove" ||
    request.capability === "platform.storage.batch").length;
  const assertAutoUnchanged = () => {
    const current = session.storage["lantern.slot.auto"];
    assert.ok(current, "the existing main autosave remains present");
    assert.deepEqual(Buffer.from(JSON.stringify(current), "utf8"), originalAutoBytes,
      "tour navigation must preserve every byte of the existing main autosave");
  };
  try {
    let frame = await session.boot();
    const mutationsAfterBoot = storageMutationCount();
    assert.match(textOf(frame), /5分钟能力巡演/, "the tour should be one direct title-screen action");
    assert.match(textOf(frame), /立绘试映/, "the existing model showcase shortcut must remain available");
    assertAutoUnchanged();

    frame = await session.tap("5分钟能力巡演", frame);
    for (let attempt = 0; attempt < 180 && !textOf(frame).includes("欢迎来到雾港的五分钟巡演"); attempt++) {
      frame = await session.frame();
    }
    assert.match(textOf(frame), /欢迎来到雾港的五分钟巡演/, "the title action must enter the declared feature_tour replay");
    assert.match(textOf(frame), /返回原旅程/, "the existing replay exit remains available during the tour");
    assertAutoUnchanged();

    frame = await session.tap("返回原旅程", frame);
    for (let attempt = 0; attempt < 120 && !textOf(frame).includes("5分钟能力巡演"); attempt++) {
      frame = await session.frame();
    }
    assert.match(textOf(frame), /5分钟能力巡演/, "leaving the tour should restore the title screen");
    assert.match(textOf(frame), /立绘试映/, "the legacy featured replay should remain on the title screen");
    assertAutoUnchanged();
    assert.equal(storageMutationCount(), mutationsAfterBoot, "entering and leaving the replay must not issue any native storage mutation");
  } finally {
    await session.quit();
  }
}, 120_000);

for (const viewport of [
  { name: "phone", width: 390, height: 844 },
  { name: "wide", width: 1280, height: 900 },
]) test(`tour hub hotspots and relay dial route real native pointer input on ${viewport.name}`, async () => {
  const hub = sourceChoice("tour_hub");
  const dial = sourceChoice("tour_dial");
  assert.deepEqual(hub.choice.options?.map(option => option.id), ["tour_reel", "tour_signal", "tour_write"]);
  assert.deepEqual(dial.choice.options?.map(option => option.id), ["tour_dial_7", "tour_dial_1", "tour_dial_4"]);
  assert.equal(sourceAssets.choiceSurfaces.tour_hub?.kind, "scene");
  assert.equal(sourceAssets.choiceSurfaces.tour_dial?.kind, "dial");
  assert.equal(sourceAssets.choiceSurfaces.tour_dial?.image, "art/ui/relay-dial.png");

  const session = new NativeSession(artifacts, { width: viewport.width, height: viewport.height, deadlineMs: 90_000 });
  try {
    let frame = await session.boot();
    const mainAutosaveBefore = JSON.stringify(session.storage["lantern.slot.auto"] ?? null);
    frame = await session.tap("5分钟能力巡演", frame);
    for (let attempt = 0; attempt < 180 && !textOf(frame).includes("欢迎来到雾港的五分钟巡演"); attempt += 1) {
      frame = await session.frame();
    }
    assert.match(textOf(frame), /欢迎来到雾港的五分钟巡演/);

    frame = await waitForTourChoice(session, frame, "tour_hub", false);
    const hubCaptions = hub.choice.options!.map(option => option.text);
    assert.ok(includesAll(frame, hubCaptions), "the real scene hotspot paints all three localized tour choices");
    assert.ok(hasActiveFadeOverlay(frame), "the new scene first paints its controls beneath the active fade veil");
    const signal = hub.choice.options!.find(option => option.id === "tour_signal")!;
    const signalGeometryCenter = tourTargetCenter(frame, "tour_hub", signal.id);
    const signalPaintedCenter = paintedTourCaptionCenter(frame, "tour_hub", signal.text);
    assertSurfacePointMatchesPaintedCenter(signalGeometryCenter, signalPaintedCenter, "tour signal");
    frame = await session.tapPoint(signalPaintedCenter);
    frame = await waitForViewportLayersStable(session, frame);
    assert.ok(includesAll(frame, hubCaptions), "the fade veil consumes an early touch rather than selecting invisible controls");

    // The exact same visible center becomes interactive when the fade veil
    // leaves. This checks the real pointer path without a guessed offset.
    frame = await session.tapPoint(signalPaintedCenter);

    frame = await waitForTourChoice(session, frame, "tour_dial");
    const dialCaptions = dial.choice.options!.map(option => option.text);
    assert.ok(includesAll(frame, dialCaptions), "the real relay dial paints all three dial choices");
    const showsRelayImage = (frame.ops ?? []).some(op => op.type === "image" && (op as typeof op & { asset?: string }).asset === "art/ui/relay-dial.png");
    assert.ok(showsRelayImage, `the ${viewport.name} Guest frame renders the registered relay dial`);

    const selected = dial.choice.options!.find(option => option.id === "tour_dial_7")!;
    const feedbackInstructions = sourceStory.script[selected.target] ?? [];
    const feedback = feedbackInstructions.find(item => item.type === "say")?.text;
    assert.ok(feedback, "the selected dial branch has a visible authored feedback line");
    const dialGeometryCenter = tourTargetCenter(frame, "tour_dial", selected.id);
    const dialPaintedCenter = paintedTourCaptionCenter(frame, "tour_dial", selected.text);
    assertSurfacePointMatchesPaintedCenter(dialGeometryCenter, dialPaintedCenter, "tour dial");
    frame = await session.tapPoint(dialPaintedCenter);
    for (let attempt = 0; attempt < 180 && !includesAll(frame, [feedback!]); attempt += 1) frame = await session.frame();
    assert.ok(includesAll(frame, [feedback!]),
      `the dial pointer reaches its authored branch: ${feedback}; painted=${textOf(frame)}`);

    frame = await waitForTourChoice(session, frame, "tour_hub");
    assert.ok(includesAll(frame, hubCaptions), "dial feedback returns to the interactive tour directory");
    assert.equal(JSON.stringify(session.storage["lantern.slot.auto"] ?? null), mainAutosaveBefore,
      "using tour hotspots and the dial remains isolated from the main autosave");
    frame = await session.tap("返回原旅程", frame);
    for (let attempt = 0; attempt < 120 && !textOf(frame).includes("5分钟能力巡演"); attempt += 1) frame = await session.frame();
    assert.match(textOf(frame), /5分钟能力巡演/);
    assert.equal(JSON.stringify(session.storage["lantern.slot.auto"] ?? null), mainAutosaveBefore);
  } finally {
    await session.quit();
  }
}, 180_000);

type MainActive = { kind?: string; id?: string; options?: TourOption[]; text?: string };

function mainActive(session: NativeSession): MainActive {
  const active = session.storage["lantern.slot.auto"]?.state?.active as MainActive | undefined;
  assert.ok(active && typeof active === "object", "the main game writes its active state through native storage");
  return active!;
}

function normalizeText(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function assetOps(frame: Frame, asset: string): DrawOp[] {
  return (frame.ops ?? []).filter(op => assetOf(op) === asset);
}

function visibleRect(op: DrawOp, frame: Frame): { x: number; y: number; w: number; h: number } | null {
  if (typeof op.x !== "number" || typeof op.y !== "number" || typeof op.w !== "number" || typeof op.h !== "number") return null;
  const clip = op.clip;
  const left = Math.max(op.x, clip?.x ?? 0, 0);
  const top = Math.max(op.y, clip?.y ?? 0, 0);
  const right = Math.min(op.x + op.w, (clip?.x ?? 0) + (clip?.w ?? frame.width ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
  const bottom = Math.min(op.y + op.h, (clip?.y ?? 0) + (clip?.h ?? frame.height ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

function visibleTextOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter(op => op.type === "text" && typeof op.text === "string" && visibleRect(op, frame) !== null)
    .map(op => op.text)
    .join("\n");
}

function geometry(ops: readonly DrawOp[]): string {
  // Keep real rect/vertex/UV/clip/transform geometry. Image UVs can move with
  // the camera while the destination rect stays fixed; color/opacity is not geometry.
  return JSON.stringify(ops.map(op => {
    const extended = op as DrawOp & {
      uv?: unknown;
      clip?: unknown;
      transform?: unknown;
      matrix?: unknown;
    };
    return {
      x: extended.x,
      y: extended.y,
      w: extended.w,
      h: extended.h,
      points: extended.points,
      uvs: extended.uvs,
      uv: extended.uv,
      clip: extended.clip,
      transform: extended.transform,
      matrix: extended.matrix,
    };
  }));
}

function miraMesh(frame: Frame): DrawOp[] {
  return (frame.ops ?? []).filter(op => op.type === "textureTriangle" && (assetOf(op) ?? "").includes("mira-"));
}

function miraPose(frame: Frame): string {
  const points = miraMesh(frame).flatMap(op => op.points ?? []);
  if (points.length === 0) return "";
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  // Normalize global transforms so the signature measures Spine deformation,
  // not camera movement or authored character scaling.
  return JSON.stringify(points.map(point => [
    Math.round((point.x - minX) / width * 1000),
    Math.round((point.y - minY) / height * 1000),
  ]));
}

function rainGeometry(frame: Frame): string {
  return geometry((frame.ops ?? []).filter(op => op.type === "textureTriangle" && assetOf(op) === "art/fx/rain-streak.svg"));
}

function mainDialoguePoint(frame: Frame): { x: number; y: number } {
  const width = frame.width ?? 390;
  const height = frame.height ?? 844;
  const layout = createNovelViewportLayout({ width, height }, { top: 0, right: 0, bottom: 0, left: 0 });
  return {
    x: layout.insetL + layout.width / 2,
    y: layout.insetT + layout.height - layout.dialogueBottom - layout.dialogueHeight / 2,
  };
}

async function waitForMainState(
  session: NativeSession,
  initial: Frame,
  predicate: (active: MainActive) => boolean,
  description: string,
  maxFrames = 900,
): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    const active = mainActive(session);
    if (predicate(active)) return frame;
    frame = await session.frame();
  }
  throw new Error("main game did not reach " + description + "; active=" + JSON.stringify(mainActive(session)) + "; text=" + textOf(frame));
}

async function advanceMainSay(session: NativeSession, initial: Frame): Promise<Frame> {
  const current = mainActive(session);
  assert.equal(current.kind, "say", "expected a dialogue line, got " + JSON.stringify(current));
  const id = current.id;
  let frame = await session.tapPoint(mainDialoguePoint(initial));
  frame = await session.settle(frame, 1);
  const next = mainActive(session);
  if (next.kind === "say" && next.id === id) {
    frame = await session.tapPoint(mainDialoguePoint(frame));
    frame = await session.settle(frame, 1);
  }
  return waitForMainState(session, frame, active => active.kind !== "say" || active.id !== id, "progress beyond " + String(id), 160);
}

function paintedMainOption(frame: Frame, optionText: string): DrawOp | undefined {
  const target = normalizeText(optionText);
  return (frame.ops ?? [])
    .filter(op => op.type === "text" && typeof op.text === "string" &&
      target.startsWith(normalizeText(op.text)) && normalizeText(op.text).length >= 2 &&
      ((op.color ?? 0xff000000) >>> 24) >= 250)
    .sort((left, right) => normalizeText(right.text ?? "").length - normalizeText(left.text ?? "").length)[0];
}

async function waitForMainChoice(session: NativeSession, initial: Frame, choiceId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 500; index += 1) {
    const active = mainActive(session);
    if (active.kind === "choice") {
      assert.equal(active.id, choiceId, "expected choice " + choiceId + ", reached " + String(active.id));
      const firstOption = active.options?.[0];
      assert.ok(firstOption, "choice " + choiceId + " has a real option");
      let option = paintedMainOption(frame, firstOption!.text);
      for (let attempt = 0; !option && attempt < 180; attempt += 1) {
        frame = await session.frame();
        option = paintedMainOption(frame, firstOption!.text);
      }
      assert.ok(option, "choice " + choiceId + " paints its option text; " + textOf(frame));
      return waitForViewportLayersStable(session, frame);
    }
    if (active.kind === "say") frame = await advanceMainSay(session, frame);
    else if (active.kind === "wait") frame = await session.frame();
    else throw new Error("expected choice " + choiceId + ", got " + JSON.stringify(active));
  }
  throw new Error("main story did not reach choice " + choiceId + "; active=" + JSON.stringify(mainActive(session)));
}

async function chooseMainOption(session: NativeSession, initial: Frame, optionId: string): Promise<Frame> {
  const active = mainActive(session);
  assert.equal(active.kind, "choice", "expected a choice before " + optionId);
  const option = active.options?.find(item => item.id === optionId);
  assert.ok(option, "choice " + String(active.id) + " does not offer " + optionId);
  let frame = initial;
  let painted = paintedMainOption(frame, option!.text);
  for (let index = 0; !painted && index < 180; index += 1) {
    frame = await session.frame();
    painted = paintedMainOption(frame, option!.text);
  }
  assert.ok(painted, "option " + optionId + " becomes visibly tappable; " + textOf(frame));
  frame = await waitForViewportLayersStable(session, frame);
  painted = paintedMainOption(frame, option!.text);
  assert.ok(painted, "option " + optionId + " remains painted after transition");
  frame = await session.tapPoint(center(painted!, "main choice " + optionId));
  return waitForMainState(session, frame, next => next.kind !== "choice" || next.id !== active.id,
    "selection of " + optionId, 180);
}

async function driveMainToEnding(session: NativeSession, initial: Frame, endingId: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 500; index += 1) {
    const active = mainActive(session);
    if (active.kind === "ending") {
      assert.equal(active.id, endingId);
      return frame;
    }
    if (active.kind === "say") frame = await advanceMainSay(session, frame);
    else if (active.kind === "wait") frame = await session.frame();
    else throw new Error("expected ending " + endingId + ", got " + JSON.stringify(active));
  }
  throw new Error("main story did not finish at " + endingId + "; active=" + JSON.stringify(mainActive(session)));
}

async function waitForTextFragment(session: NativeSession, initial: Frame, fragment: string, maxFrames = 240): Promise<Frame> {
  let frame = initial;
  const target = normalizeText(fragment);
  for (let index = 0; index < maxFrames; index += 1) {
    if (normalizeText(textOf(frame)).includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error("Guest did not paint " + JSON.stringify(fragment) + "; frame=" + textOf(frame));
}

async function waitForAssetGeometryStable(session: NativeSession, initial: Frame, asset: string): Promise<Frame> {
  let frame = initial;
  let previous = geometry(assetOps(frame, asset));
  let stable = 0;
  for (let index = 0; index < 160; index += 1) {
    frame = await session.frame();
    const current = geometry(assetOps(frame, asset));
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 8 && current !== "[]") return frame;
  }
  throw new Error("scene geometry did not settle for " + asset + "; frame=" + textOf(frame));
}

async function openTourTextInput(session: NativeSession, initial: Frame, placeholder: string): Promise<{ frame: Frame; input: { id: string; editingSession: string; revision: number; jsRevision: number } }> {
  let frame = initial;
  let placeholderOp = (frame.ops ?? []).find(op => op.type === "text" && op.text === placeholder);
  for (let index = 0; !placeholderOp && index < 120; index += 1) {
    frame = await session.frame();
    placeholderOp = (frame.ops ?? []).find(op => op.type === "text" && op.text === placeholder);
  }
  assert.ok(placeholderOp, "input placeholder is painted: " + placeholder);
  const point = center(placeholderOp!, "tour input placeholder");
  const samples: Frame[] = [await session.tapPoint(point)];
  frame = samples[0]!;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const opened = samples.flatMap(item => item.events ?? []).find(item => item.name === "textInput.open" && item.payload?.id);
    if (opened?.payload) {
      const payload = opened.payload;
      assert.equal(String(payload.id), "tour_note", "the native text field belongs to the authored tour input");
      return {
        frame,
        input: {
          id: String(payload.id),
          editingSession: String(payload.editingSession),
          revision: Number(payload.revision ?? 0),
          jsRevision: Number(payload.jsRevision ?? 0),
        },
      };
    }
    frame = await session.frame();
    samples.push(frame);
  }
  throw new Error("the guest did not emit textInput.open; frame=" + textOf(frame));
}

async function waitForMainSlotList(
  session: NativeSession,
  initial: Frame,
  keysBefore: number,
  getsBefore: number,
  minimumReads: number,
): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const keys = session.requests.filter(request => request.capability === "platform.storage.keys").length;
    if (keys > keysBefore && session.storageGets.length - getsBefore >= minimumReads && !textOf(frame).includes("正在读取")) return frame;
    frame = await session.frame();
  }
  throw new Error("the native save list did not finish loading; frame=" + textOf(frame));
}

async function waitForGalleryAssetOnFirstScreen(session: NativeSession, initial: Frame, asset: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 120; index += 1) {
    if (assetOps(frame, asset).some(op => visibleRect(op, frame))) return frame;
    frame = await session.frame();
  }
  throw new Error("gallery did not paint unlocked asset on its first screen " + asset + "; frame=" + textOf(frame));
}

async function revealGalleryAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  const target = normalizeText(label);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (normalizeText(visibleTextOf(frame)).includes(target)) return frame;
    const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip && (op.clip.h ?? 0) > 120);
    assert.ok(anchor?.clip, "gallery exposes its real clipped scroll viewport before scrolling: " + textOf(frame));
    const clip = anchor!.clip!;
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag(
      { x, y: clip.y! + clip.h! * 0.82 },
      { x, y: clip.y! + clip.h! * 0.22 },
      8,
      3,
    );
    frame = await session.settle(frame, 3);
  }
  throw new Error("gallery action did not become visible after real scroll " + label + "; frame=" + textOf(frame));
}

async function revealTitleAction(session: NativeSession, initial: Frame, label: string): Promise<{ frame: Frame; scrolls: number }> {
  let frame = initial;
  const target = normalizeText(label);
  let scrolls = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (normalizeText(visibleTextOf(frame)).includes(target)) return { frame, scrolls };
    const clips = (frame.ops ?? [])
      .filter(op => op.type === "text" && op.clip)
      .map(op => op.clip!)
      .filter(clip => (clip.h ?? 0) > 120 && (clip.w ?? 0) > 160 &&
        (clip.w ?? 0) < (frame.width ?? session.width) && (clip.h ?? 0) < (frame.height ?? session.height))
      .sort((left, right) => (right.w ?? 0) * (right.h ?? 0) - (left.w ?? 0) * (left.h ?? 0));
    const clip = clips[0];
    assert.ok(clip, "title screen exposes its clipped scroll viewport before revealing later actions: " + textOf(frame));
    const x = clip!.x! + clip!.w! / 2;
    frame = await session.drag(
      { x, y: clip!.y! + clip!.h! * 0.82 },
      { x, y: clip!.y! + clip!.h! * 0.22 },
      8,
      3,
    );
    frame = await session.settle(frame, 3);
    scrolls += 1;
  }
  throw new Error("title action did not become visible after real scroll " + label + "; visible=" + visibleTextOf(frame));
}

test("native current Lantern Guest drives the first-five-minute route through all eight real interaction categories", async () => {
  const startedAt = performance.now();
  const session = new NativeSession(artifacts, {
    width: 390,
    height: 844,
    storage: structuredClone(existingSaveFixture.storage),
    deadlineMs: 295_000,
  });
  const covered = new Set<string>();
  try {
    const originalAuto = JSON.stringify(session.storage["lantern.slot.auto"]);
    assert.ok(originalAuto && originalAuto !== "null", "tour isolation begins with an existing main autosave");
    const originalAutoBytes = Buffer.from(originalAuto, "utf8");
    let frame = await session.boot();
    assert.ok(textOf(frame).includes("5分钟能力巡演"), "the existing title exposes the tour entry");
    assert.ok(textOf(frame).includes("雾港末班信"), "the original main journey stays beside the tour");

    // A single real title button action enters the isolated replay engine.
    frame = await session.tap("5分钟能力巡演", frame);
    frame = await waitForViewportLayersStable(session, frame);
    const stationBaselineOps = assetOps(frame, "art/station.png");
    let stationBaselineCount = stationBaselineOps.length;
    let stationBaseline = geometry(stationBaselineOps);
    let mistBaseline = geometry(assetOps(frame, "art/fx/sea-mist.png"));
    let rainBaseline = rainGeometry(frame);
    let cameraMoved = false;
    let weatherMoved = false;
    for (let attempt = 0; attempt < 180 && !normalizeText(textOf(frame)).includes(normalizeText("欢迎来到雾港的五分钟巡演。先看一盏灯怎样穿过雾，再亲手留下一个回音。")); attempt += 1) {
      frame = await session.frame();
      const stationOps = assetOps(frame, "art/station.png");
      const station = geometry(stationOps);
      const rain = rainGeometry(frame);
      const mist = geometry(assetOps(frame, "art/fx/sea-mist.png"));
      if (stationBaselineCount === 0 && stationOps.length > 0) {
        stationBaselineCount = stationOps.length;
        stationBaseline = station;
      } else if (stationOps.length === stationBaselineCount && stationBaselineCount > 0 && station !== stationBaseline) {
        cameraMoved = true;
      }
      if (rainBaseline === "[]" && rain !== "[]") rainBaseline = rain;
      if (mistBaseline === "[]" && mist !== "[]") mistBaseline = mist;
      if ((rain !== "[]" && rain !== rainBaseline) || (mist !== "[]" && mist !== mistBaseline)) weatherMoved = true;
    }
    assert.ok(normalizeText(textOf(frame)).includes(normalizeText("欢迎来到雾港的五分钟巡演。先看一盏灯怎样穿过雾，再亲手留下一个回音。")),
      "the title action reaches the authored opening line in the Guest");
    assert.equal(Buffer.from(JSON.stringify(session.storage["lantern.slot.auto"]), "utf8").compare(originalAutoBytes), 0,
      "entering the feature tour preserves every byte of the existing main autosave");

    assert.ok(miraMesh(frame).length > 10, "the Guest draws Mira's Spine mesh in the tour");
    assert.ok(assetOps(frame, "art/fx/sea-mist.png").length >= 2, "both actual mist layers are painted");
    assert.ok(rainBaseline.length > 2, "the authored rain reaches the native triangle painter");
    assert.ok(stationBaselineCount > 0, "a station background draw exists after the entry fade settles");
    assert.ok(cameraMoved, "the opening camera transition changes station geometry/UVs while its draw-op count stays fixed");
    assert.ok(weatherMoved, "rain or mist changes geometry across real guest frames");
    frame = await waitForAssetGeometryStable(session, frame, "art/station.png");
    const settledStationGeometry = geometry(assetOps(frame, "art/station.png"));
    for (let index = 0; index < 8; index += 1) {
      frame = await session.frame();
      assert.equal(geometry(assetOps(frame, "art/station.png")), settledStationGeometry,
        "camera geometry remains unchanged through a settled frame window; opacity/color are excluded");
    }
    covered.add("camera/weather");

    frame = await waitForTourChoice(session, frame, "tour_hub", false);
    const hub = sourceChoice("tour_hub");
    const hubCaptions = hub.choice.options!.map(option => option.text);
    assert.ok(includesAll(frame, hubCaptions), "the actual hotspot hub paints all three choices");
    assert.ok(hasActiveFadeOverlay(frame), "the first hotspot choice appears under the active scene transition");
    const reel = hub.choice.options!.find(option => option.id === "tour_reel")!;
    const reelGeometryCenter = tourTargetCenter(frame, "tour_hub", reel.id);
    const reelPaintedCenter = paintedTourCaptionCenter(frame, "tour_hub", reel.text);
    assertSurfacePointMatchesPaintedCenter(reelGeometryCenter, reelPaintedCenter, "tour reel hotspot");
    frame = await session.tapPoint(reelPaintedCenter);
    assert.ok(includesAll(frame, hubCaptions), "the transition veil consumes the first tap at the hotspot's actual center");
    frame = await waitForViewportLayersStable(session, frame);
    frame = await session.tapPoint(reelPaintedCenter);
    covered.add("hotspot");

    const reelText = sourceStory.script.feature_tour_reel?.find(item => item.id === "tour_03")?.text ?? "";
    frame = await waitForTextFragment(session, frame, reelText);
    const video = (frame.ops ?? []).find(op => op.type === "video") as (DrawOp & { asset?: string }) | undefined;
    assert.ok(video, "the compiled story produces a visible video surface op alongside the live dialogue");
    assert.equal(video!.asset, "assets/apps/lantern/videos/archive-route-reel.mp4", "the surface points at the authored archive clip");
    assert.ok(miraMesh(frame).length > 10, "Mira's live Spine mesh remains visible above the video scene");
    frame = await waitForAssetGeometryStable(session, frame, "art/archive.png");
    const alertPose = miraPose(frame);
    let animatedPose = false;
    for (let index = 0; index < 45 && !animatedPose; index += 1) {
      frame = await session.frame();
      animatedPose = miraPose(frame) !== alertPose;
    }
    assert.ok(animatedPose, "after the camera settles, the reel scene continues to animate Mira's real Spine vertices");
    covered.add("model action");
    covered.add("video surface");

    frame = await session.tapPoint(mainDialoguePoint(frame));
    frame = await waitForTourChoice(session, frame, "tour_hub", true);
    const signal = sourceChoice("tour_hub").choice.options!.find(option => option.id === "tour_signal")!;
    const signalCenter = paintedTourCaptionCenter(frame, "tour_hub", signal.text);
    assertSurfacePointMatchesPaintedCenter(tourTargetCenter(frame, "tour_hub", signal.id), signalCenter, "tour signal hotspot");
    frame = await session.tapPoint(signalCenter);
    frame = await waitForTourChoice(session, frame, "tour_dial", true);
    const dial = sourceChoice("tour_dial");
    assert.ok(includesAll(frame, dial.choice.options!.map(option => option.text)), "the real dial paints each selectable label");
    assert.ok(assetOps(frame, "art/ui/relay-dial.png").length > 0, "the authored relay wheel image is actually drawn");
    const correct = dial.choice.options!.find(option => option.id === "tour_dial_7")!;
    const correctCenter = paintedTourCaptionCenter(frame, "tour_dial", correct.text);
    assertSurfacePointMatchesPaintedCenter(tourTargetCenter(frame, "tour_dial", correct.id), correctCenter, "tour relay dial");
    frame = await session.tapPoint(correctCenter);
    frame = await waitForTextFragment(session, frame, "七号线落在收信亭窄窗上");
    assert.ok(normalizeText(textOf(frame)).includes(normalizeText("七号线落在收信亭窄窗上")),
      "the pointer on route 7 reaches the real authored success branch");
    covered.add("dial");

    frame = await waitForTourChoice(session, frame, "tour_hub", true);
    const write = sourceChoice("tour_hub").choice.options!.find(option => option.id === "tour_write")!;
    const writeCenter = paintedTourCaptionCenter(frame, "tour_hub", write.text);
    frame = await session.tapPoint(writeCenter);
    const inputIntro = sourceStory.script.feature_tour_input?.find(item => item.id === "tour_05")?.text ?? "";
    frame = await waitForTextFragment(session, frame, inputIntro);
    frame = await session.tapPoint(mainDialoguePoint(frame));
    frame = await waitForTextFragment(session, frame, "一句话即可");
    const point = center(textOp(frame, "一句话即可"), "tour text input placeholder");
    session.sendEvent("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y });
    const down = await session.frame();
    session.sendEvent("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y });
    frame = await session.frame();
    const inputEvent = [...(down.events ?? []), ...(frame.events ?? [])].find(item => item.name === "textInput.open" && item.payload?.id);
    assert.ok(inputEvent?.payload, "touching the guest input shell opens its native input bridge");
    const input = {
      id: String(inputEvent!.payload!.id),
      editingSession: String(inputEvent!.payload!.editingSession),
      revision: Number(inputEvent!.payload!.revision ?? 0),
      jsRevision: Number(inputEvent!.payload!.jsRevision ?? 0),
    };
    const note = "灯还亮着";
    session.sendEvent("textInput.edit", {
      id: input.id,
      editingSession: input.editingSession,
      revision: input.revision + 1,
      jsRevision: input.jsRevision,
      text: note,
      selectionBase: note.length,
      selectionExtent: note.length,
      composingBase: -1,
      composingExtent: -1,
    });
    frame = await session.frame();
    assert.ok(textOf(frame).includes(note), "native textInput.edit changes the live player draft");
    let revision = input.revision + 1;
    let jsRevision = input.jsRevision;
    for (const event of frame.events ?? []) {
      if (event.name === "textInput.update" && event.payload?.id === input.id && event.payload?.editingSession === input.editingSession) {
        if (typeof event.payload.revision === "number") revision = Math.max(revision, event.payload.revision);
        if (typeof event.payload.jsRevision === "number") jsRevision = Math.max(jsRevision, event.payload.jsRevision);
      }
    }
    session.sendEvent("textInput.submit", {
      id: input.id,
      editingSession: input.editingSession,
      revision: revision + 1,
      jsRevision,
      text: note,
      selectionBase: note.length,
      selectionExtent: note.length,
      composingBase: -1,
      composingExtent: -1,
    });
    frame = await session.frame();
    assert.ok(textOf(frame).includes(note) && textOf(frame).includes("提交"),
      "native done leaves the draft visible for the explicit story-submit action");
    frame = await session.tap("提交", frame);
    frame = await waitForTextFragment(session, frame, "雾窗把你的话带回眼前：" + note);
    assert.ok(normalizeText(textOf(frame)).includes(normalizeText(note)), "submitted user text is rendered in the real echo dialogue");
    covered.add("player input");
    assert.equal(Buffer.from(JSON.stringify(session.storage["lantern.slot.auto"]), "utf8").compare(originalAutoBytes), 0,
      "input and progress in the replay have not changed the main autosave");

    frame = await session.tap("返回原旅程", frame);
    for (let attempt = 0; attempt < 120 && !textOf(frame).includes("启程 · 开始新的故事"); attempt += 1) frame = await session.frame();
    assert.ok(textOf(frame).includes("启程 · 开始新的故事"), "replay exit restores the title");
    assert.equal(Buffer.from(JSON.stringify(session.storage["lantern.slot.auto"]), "utf8").compare(originalAutoBytes), 0,
      "exiting the complete replay still leaves the prior main save byte-for-byte unchanged");

    // Save/load/rollback are tested only after explicitly returning to the main
    // engine; replay storage isolation is not bypassed for these operations.
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_01", "main opening dialogue");
    frame = await session.settle(frame, 60);
    assert.notEqual(JSON.stringify(session.storage["lantern.slot.auto"]), originalAuto,
      "a deliberate new main game, after replay exit, may now replace the old autosave");

    frame = await session.tap("手札", frame);
    assert.ok(textOf(frame).includes("旅途手札"), "the main journal opens through the real HUD");
    const autoBeforeQuickSave = structuredClone(session.storage["lantern.slot.auto"]);
    const quickBefore = session.storage["lantern.slot.quick"];
    frame = await session.tap("快速保存此刻", frame);
    for (let attempt = 0; attempt < 180 && session.storage["lantern.slot.quick"] === quickBefore; attempt += 1) frame = await session.frame();
    assert.ok(session.storage["lantern.slot.quick"], "the main quick-save action writes the dedicated quick slot");
    assert.deepEqual(session.storage["lantern.slot.auto"], autoBeforeQuickSave, "quick save does not replace continuous autosave");
    frame = await session.tap("继续阅读", frame);

    frame = await advanceMainSay(session, frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_02", "arrival_02");
    frame = await session.tap("手札", frame);
    const keysBeforeLoad = session.requests.filter(request => request.capability === "platform.storage.keys").length;
    const getsBeforeLoad = session.storageGets.length;
    frame = await session.tap("重读信笺", frame);
    frame = await waitForMainSlotList(session, frame, keysBeforeLoad, getsBeforeLoad, 5);
    const quickReadsBefore = session.storageGets.filter(request => request.key === "lantern.slot.quick").length;
    frame = await session.tap("快速存档", frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_01", "Quick Load restore");
    assert.ok(session.storageGets.filter(request => request.key === "lantern.slot.quick").length > quickReadsBefore,
      "Quick Load reads the actual native quick slot");

    frame = await advanceMainSay(session, frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_02", "arrival_02 after Quick Load");
    frame = await advanceMainSay(session, frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_03", "arrival_03 before rollback");
    frame = await session.tap("回溯", frame);
    frame = await waitForMainState(session, frame, active => active.kind === "say" && active.id === "arrival_02", "rollback result");
    covered.add("save/load/rollback");

    // Follow a real main-story path to the train ending. It is needed to unlock
    // a consumable CG in the gallery; the test never injects ending metadata.
    frame = await waitForMainChoice(session, frame, "arrival_approach");
    frame = await chooseMainOption(session, frame, "check_seal");
    frame = await waitForMainChoice(session, frame, "investigation_hub");
    frame = await chooseMainOption(session, frame, "last_train");
    frame = await waitForMainChoice(session, frame, "signal_window");
    frame = await chooseMainOption(session, frame, "send_train");
    frame = await driveMainToEnding(session, frame, "last_train");
    assert.ok((session.storage["lantern.slot.auto"].state.meta.endingIds as string[]).includes("last_train"),
      "the main ending writes its real unlock to autosave metadata");
    assert.ok((session.storage["lantern.slot.auto"].state.meta.cgIds as string[]).includes("dawn_departure"),
      "the ending itself grants the gallery CG");

    frame = await session.tap("返回扉页", frame);
    for (let attempt = 0; attempt < 180 && !textOf(frame).includes("雾港纪念"); attempt += 1) frame = await session.frame();
    const galleryAction = await revealTitleAction(session, frame, "雾港纪念");
    frame = galleryAction.frame;
    assert.ok(galleryAction.scrolls > 0,
      "the feature-tour title shortcuts push the existing memories action below the phone-sized title viewport; it is reached by a real title-list swipe");
    frame = await session.tap("雾港纪念", frame);
    frame = await waitForGalleryAssetOnFirstScreen(session, frame, "art/dawn-departure.png");
    assert.ok(textOf(frame).includes("天亮以前，信已启程"),
      "the memories gallery displays the title of the CG unlocked by the real ending");
    const firstScreenCg = assetOps(frame, "art/dawn-departure.png").find(op => typeof op.x === "number" && typeof op.y === "number" && typeof op.w === "number" && typeof op.h === "number");
    assert.ok(firstScreenCg, "the first unlocked CG has a real image draw op on the initial gallery page");
    const visibleCg = visibleRect(firstScreenCg!, frame);
    assert.ok(visibleCg && visibleCg.w >= firstScreenCg!.w! * 0.8 && visibleCg.h >= firstScreenCg!.h! * 0.8,
      "the first unlocked CG is substantially visible inside the initial gallery clip");
    const endingSave = JSON.parse(JSON.stringify(session.storage["lantern.slot.auto"]));
    frame = await revealGalleryAction(session, frame, "回看 · 5分钟能力巡演");
    frame = await session.tap("回看 · 5分钟能力巡演", frame);
    frame = await waitForTextFragment(session, frame, "欢迎来到雾港的五分钟巡演");
    assert.deepEqual(session.storage["lantern.slot.auto"], endingSave, "starting the gallery replay keeps the completed main autosave intact");
    frame = await session.tap("返回原旅程", frame);
    for (let attempt = 0; attempt < 120 && !textOf(frame).includes("雾港纪念"); attempt += 1) frame = await session.frame();
    frame = await session.settle(frame, 4);
    frame = await revealGalleryAction(session, frame, "试听 · 天亮以后");
    frame = await session.tap("试听 · 天亮以后", frame);
    frame = await session.settle(frame, 8);
    assert.ok(session.requests.some(request => request.capability === "media.audio.play" &&
      request.params.channel === "music-preview" && request.params.asset === "audio/music_dawn.wav"),
      "the heard music preview remains reachable from the gallery after its unlocked CG");
    frame = await revealGalleryAction(session, frame, "停止试听");
    frame = await session.tap("停止试听", frame);
    assert.ok(session.requests.some(request => request.capability === "media.audio.stop" && request.params.channel === "music-preview"),
      "the gallery can stop its reachable music preview");
    assert.deepEqual(session.storage["lantern.slot.auto"], endingSave, "gallery replay and music preview do not mutate the completed main save");
    covered.add("unlocked gallery content");

    const required = [
      "model action",
      "camera/weather",
      "hotspot",
      "dial",
      "player input",
      "video surface",
      "save/load/rollback",
      "unlocked gallery content",
    ];
    assert.deepEqual([...covered].sort(), required.sort(), "all eight capability groups were reached through actual guest input and persisted state");
    const elapsedMs = Math.round(performance.now() - startedAt);
    assert.ok(elapsedMs <= 300_000, "the driven route exceeded five minutes: " + elapsedMs + "ms");
    const qjbcSha256 = createHash("sha256").update(readFileSync(artifacts.bytecodePath)).digest("hex");
    const pakSha256 = createHash("sha256").update(readFileSync(artifacts.pakPath)).digest("hex");
    console.log("novel_feature_tour_native: eight categories covered; title action to tour=1; driven route=" + elapsedMs +
      "ms; QJBC=" + qjbcSha256 + "; PAK=" + pakSha256);
  } finally {
    await session.quit();
  }
}, 300_000);
