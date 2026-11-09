import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import { NativeSession, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const viewport = { width: 360, height: 640 };
const transitionMs = 900;
const backgrounds = {
  old: "art/old.svg",
  left: "art/left.svg",
  right: "art/right.svg",
  up: "art/up.svg",
  down: "art/down.svg",
} as const;

type Direction = "left" | "right" | "up" | "down";
type Rect = { x: number; y: number; w: number; h: number };

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function image(frame: Frame, path: string): DrawOp | undefined {
  return (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === path);
}

function requiredImage(frame: Frame, path: string, label: string): DrawOp {
  const op = image(frame, path);
  assert.ok(op, `${label} must reach the actual native image DrawOp: ${path}; ${textOf(frame)}`);
  return op!;
}

function clipRect(frame: Frame, op: DrawOp, label: string): Rect {
  assert.ok(op.clip, `${label} must expose the real DrawOp clip rectangle`);
  return {
    x: op.clip!.x ?? 0,
    y: op.clip!.y ?? 0,
    w: op.clip!.w ?? frame.width ?? viewport.width,
    h: op.clip!.h ?? frame.height ?? viewport.height,
  };
}

function close(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function visibleFraction(direction: Direction, rect: Rect): number {
  return direction === "left" || direction === "right"
    ? rect.w / viewport.width
    : rect.h / viewport.height;
}

function visibleAreaFraction(rect: Rect): number {
  return rect.w * rect.h / (viewport.width * viewport.height);
}

function assertClipDirection(direction: Direction, rect: Rect, phase: string): void {
  close(rect.w, direction === "left" || direction === "right" ? rect.w : viewport.width, 1, `${phase} reveal full width`);
  close(rect.h, direction === "up" || direction === "down" ? rect.h : viewport.height, 1, `${phase} reveal full height`);
  if (direction === "left") close(rect.x, 0, 1, `${phase} left reveal starts at the left edge`);
  if (direction === "right") close(rect.x + rect.w, viewport.width, 1, `${phase} right reveal remains anchored to the right edge`);
  if (direction === "up") close(rect.y, 0, 1, `${phase} up reveal starts at the top edge`);
  if (direction === "down") close(rect.y + rect.h, viewport.height, 1, `${phase} down reveal remains anchored to the bottom edge`);
  if (phase === "initial") {
    assert.ok(visibleFraction(direction, rect) > 0 && visibleFraction(direction, rect) < 0.25,
      `initial ${direction} clip should reveal only a narrow strip: ${JSON.stringify(rect)}`);
  } else if (phase === "middle") {
    assert.ok(visibleFraction(direction, rect) > 0.35 && visibleFraction(direction, rect) < 0.78,
      `middle ${direction} clip should expose a partial scene: ${JSON.stringify(rect)}`);
  }
}

function uncroppedImageBounds(op: DrawOp, path: string): Rect {
  assert.equal(typeof op.w, "number", "native image op must carry a width");
  assert.equal(typeof op.h, "number", "native image op must carry a height");
  const uv = (op as DrawOp & { uv?: number[] }).uv;
  assert.ok(uv && uv.length === 4 && uv[2]! > uv[0]! && uv[3]! > uv[1]!,
    `${path} exposes a valid source crop for reconstructing its un-clipped image bounds`);
  const width = op.w! / (uv![2]! - uv![0]!);
  const height = op.h! / (uv![3]! - uv![1]!);
  return { x: op.x! - uv![0]! * width, y: op.y! - uv![1]! * height, w: width, h: height };
}

function assertNoImageStretch(first: DrawOp, middle: DrawOp, final: DrawOp, path: string): void {
  // The native painter reports the visible image fragment in x/y/w/h and
  // crops source UVs with it. Reconstruct the complete image rectangle to
  // detect accidental scaling while the outer reveal clip advances.
  const frames = [first, middle, final].map(op => uncroppedImageBounds(op, path));
  for (const [index, size] of frames.entries()) {
    close(size.x, 0, 1, `${path} full image x at sample ${index}`);
    close(size.y, 0, 1, `${path} full image y at sample ${index}`);
    close(size.w, viewport.width, 1, `${path} image width at sample ${index}`);
    close(size.h, viewport.height, 1, `${path} image height at sample ${index}`);
  }
  close(frames[0]!.w, frames[1]!.w, 0.5, `${path} image width stays full-sized during clipping`);
  close(frames[1]!.w, frames[2]!.w, 0.5, `${path} image width stays full-sized at completion`);
  close(frames[0]!.h, frames[1]!.h, 0.5, `${path} image height stays full-sized during clipping`);
  close(frames[1]!.h, frames[2]!.h, 0.5, `${path} image height stays full-sized at completion`);
}

function assertFixedHud(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find(item => item.type === "text" && item.text === label);
  assert.ok(op, `fixed HUD label ${label} remains painted during reveal; ${textOf(frame)}`);
  const hud = op!;
  if (hud.clip) {
    const rect = clipRect(frame, hud, `fixed HUD ${label}`);
    assert.ok(rect.x <= (hud.x ?? 0) + 1 && rect.y <= (hud.y ?? 0) + 1 &&
      rect.x + rect.w >= (hud.x ?? 0) + (hud.w ?? 0) - 1 &&
      rect.y + rect.h >= (hud.y ?? 0) + (hud.h ?? 0) - 1,
    `fixed HUD ${label} must not inherit the scene reveal clip: hud=${JSON.stringify(hud)} clip=${JSON.stringify(rect)}`);
  }
  return hud;
}

function geometry(op: DrawOp): string {
  return JSON.stringify({ x: op.x, y: op.y, w: op.w, h: op.h, clip: op.clip });
}

function dialoguePoint(): { x: number; y: number } {
  const layout = createNovelViewportLayout(viewport, { top: 0, right: 0, bottom: 0, left: 0 });
  return {
    x: layout.insetL + layout.width / 2,
    y: layout.insetT + layout.height - layout.dialogueBottom - layout.dialogueHeight / 2,
  };
}

async function waitForPartialReveal(
  session: NativeSession,
  initial: Frame,
  from: string,
  to: string,
): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (image(frame, from) && image(frame, to)) {
      const incoming = image(frame, to)!;
      if (incoming.clip) {
        const rect = clipRect(frame, incoming, "incoming reveal");
        if (visibleAreaFraction(rect) > 0 && visibleAreaFraction(rect) < 0.98) return frame;
      }
    }
    frame = await session.frame();
  }
  throw new Error(`native reveal never painted both old and incoming stages (${from} -> ${to}): ${textOf(frame)}`);
}

async function waitForRevealEnd(session: NativeSession, initial: Frame, from: string, to: string): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!image(frame, from) && image(frame, to)) return frame;
    frame = await session.frame();
  }
  throw new Error(`native reveal did not finish (${from} -> ${to}): ${textOf(frame)}`);
}

async function waitForText(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  const target = label.replace(/\s/g, "");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (textOf(frame).replace(/\s/g, "").includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error(`native guest never painted ${label}: ${textOf(frame)}`);
}

async function waitForQuickSlotReady(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const painted = textOf(frame);
    if (painted.includes("快速存档") && !painted.includes("正在读取")) return frame;
    frame = await session.frame();
  }
  throw new Error(`quick slot never finished its real native storage reads: ${textOf(frame)}`);
}

async function assertDirectionThroughNativeFrames(
  session: NativeSession,
  current: Frame,
  direction: Direction,
  from: string,
  to: string,
): Promise<Frame> {
  let frame = await session.tapPoint(dialoguePoint());
  frame = await waitForPartialReveal(session, frame, from, to);
  assert.ok(image(frame, from), `${direction} reveal retains its outgoing scene at the initial frame`);
  const initialOp = requiredImage(frame, to, `${direction} reveal initial frame`);
  const initialClip = clipRect(frame, initialOp, `${direction} reveal initial frame`);
  assertClipDirection(direction, initialClip, "initial");
  assertFixedHud(frame, "手札");

  const middle = await session.settle(frame, 26);
  assert.ok(image(middle, from), `${direction} reveal keeps its outgoing scene through the middle frame`);
  const middleOp = requiredImage(middle, to, `${direction} reveal middle frame`);
  const middleClip = clipRect(middle, middleOp, `${direction} reveal middle frame`);
  assertClipDirection(direction, middleClip, "middle");
  assert.ok(visibleFraction(direction, middleClip) > visibleFraction(direction, initialClip) + 0.25,
    `${direction} reveal advances its real native clip between input and clock frames`);
  const hudBefore = assertFixedHud(frame, "手札");
  const hudMiddle = assertFixedHud(middle, "手札");
  close(hudMiddle.x!, hudBefore.x!, 0.5, `${direction} fixed HUD x`);
  close(hudMiddle.y!, hudBefore.y!, 0.5, `${direction} fixed HUD y`);

  const end = await waitForRevealEnd(session, middle, from, to);
  assert.ok(!image(end, from), `${direction} reveal removes the old scene after the final frame`);
  const finalOp = requiredImage(end, to, `${direction} reveal final frame`);
  assertNoImageStretch(initialOp, middleOp, finalOp, to);
  assertFixedHud(end, "手札");
  return end;
}

test("pinned Guest reveals native scenes in four directions and saves, pauses, skips, loads and rolls back the clipped composition", { timeout: 360_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-reveal-native-"));
  let session: NativeSession | undefined;
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-reveal-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-reveal-native-fixture",
      app: { entry: "app.tsx", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-reveal-native-fixture", capabilities: { requires: [
      "platform.storage.get", "platform.storage.set", "platform.storage.remove", "platform.storage.keys",
    ], optional: [] } }));
    mkdirSync(join(project, "art"), { recursive: true });
    const palette = {
      old: "#163147",
      left: "#984B3D",
      right: "#3E765C",
      up: "#66518A",
      down: "#B17D35",
    } as const;
    for (const [id, path] of Object.entries(backgrounds)) {
      writeFileSync(join(project, path), `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="${palette[id as keyof typeof palette]}"/><path d="M0 40h180M0 280h180" stroke="#FFFFFF" stroke-opacity=".55" stroke-width="4"/><circle cx="${id === "right" ? 150 : 30}" cy="${id === "down" ? 280 : 40}" r="16" fill="#F8E7B0"/></svg>`);
    }
    const story = {
      id: "reveal-native-fixture",
      version: 1,
      start: "start",
      script: {
        start: [
          { type: "scene", background: "old" },
          { type: "say", id: "open", text: "The first stage is ready." },
          { type: "scene", background: "left", transition: { kind: "reveal", durationMs: transitionMs } },
          { type: "say", id: "after-left", text: "The default reveal moves from left to right." },
          { type: "scene", background: "right", transition: { kind: "reveal", direction: "right", durationMs: transitionMs } },
          { type: "say", id: "after-right", text: "The right edge now opens toward the left." },
          { type: "scene", background: "up", transition: { kind: "reveal", direction: "up", durationMs: transitionMs } },
          { type: "say", id: "after-up", text: "The top edge opens downward." },
          { type: "scene", background: "down", transition: { kind: "reveal", direction: "down", durationMs: transitionMs } },
          { type: "say", id: "after-down", text: "The bottom edge opens upward." },
          { type: "scene", background: "old", transition: { kind: "cut", durationMs: 0 } },
          { type: "say", id: "after-cut", text: "The cut returns to the complete original stage." },
          { type: "ending", id: "end", text: "The reveals and the cut control are complete." },
        ],
      },
    };
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
      backgrounds,
      characters: {},
      cgs: {},
      imageDimensions: Object.fromEntries(Object.values(backgrounds).map(path => [path, { width: 180, height: 320 }])),
    }));
    writeFileSync(join(project, "app.tsx"), `
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { AccessibilityPreferencesProvider, createAccessibilityPreferences } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createNovelAnimationDriver, createNovelEngine, createNovelSlotManager } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = ${JSON.stringify({
      backgrounds,
      characters: {},
      cgs: {},
      imageDimensions: Object.fromEntries(Object.values(backgrounds).map(path => [path, { width: 180, height: 320 }])),
    })};
function App() {
  const host = createHostBridge();
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
  const storage = createNovelSlotManager({
    get: key => platform.storage.get(key),
    set: (key, value) => platform.storage.set(key, value),
    remove: key => platform.storage.remove(key),
    keys: () => platform.storage.keys(),
  }, { prefix: "reveal.slot." });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0, skipSeenOnly: true } });
  const animations = createNovelAnimationDriver();
  const stopClock = attachNovelClock(engine, { animations });
  onCleanup(() => { stopClock(); engine.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <NovelView engine={engine} host={host} storage={storage} assets={assets} locale="zh" title="Reveal acceptance" shortTitle="Reveal" subtitle="Native clipped scene fixture" animations={animations} onNewGame={() => engine.start()} />
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the isolated reveal fixture must execute pinned QuickJS bytecode");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    session = new NativeSession(artifacts, { ...viewport, deadlineMs: 180_000 });
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForText(session, frame, "The first stage is ready.");
    requiredImage(frame, backgrounds.old, "initial old scene");

    // One genuine NovelView dialogue pointer starts the default-left reveal.
    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForPartialReveal(session, frame, backgrounds.old, backgrounds.left);
    const firstInitial = requiredImage(frame, backgrounds.left, "default-left initial frame");
    const firstInitialClip = clipRect(frame, firstInitial, "default-left initial frame");
    assertClipDirection("left", firstInitialClip, "initial");
    const firstHud = assertFixedHud(frame, "手札");

    // The skip control is real HUD input. Seen-only skip must keep the current
    // unread line while the independently clocked scene reveal continues.
    frame = await session.tap("已读跳过", frame);
    assert.ok(textOf(frame).includes("跳读中"), "native pointer toggles the existing seen-only skip control");
    assert.ok(textOf(frame).replace(/\s/g, "").includes("The default reveal moves from left to right.".replace(/\s/g, "")),
      `seen-only skip leaves the unread incoming line active: ${textOf(frame)}`);
    assert.ok(image(frame, backgrounds.old) && image(frame, backgrounds.left), "skip preserves both scene compositions while the reveal clock runs");
    frame = await session.tap("跳读中", frame);
    assert.ok(textOf(frame).includes("已读跳过"), "native pointer returns the existing control to manual mode");

    // Opening the actual fixed HUD menu pauses the shared NovelClock. The
    // control is outside the scene clip and remains hittable at a partial reveal.
    frame = await session.tap("手札", frame);
    assert.ok(textOf(frame).includes("旅途手札"), "the fixed HUD menu opens during a reveal through real pointer input");
    assert.ok(image(frame, backgrounds.old) && image(frame, backgrounds.left), "opening the menu retains outgoing and incoming DrawOps");
    const pausedClip = geometry(requiredImage(frame, backgrounds.left, "paused reveal"));
    frame = await session.settle(frame, 8);
    assert.equal(geometry(requiredImage(frame, backgrounds.left, "paused reveal after clock frames")), pausedClip,
      "paused menu frames must keep the incoming reveal clip fixed");
    const menuHud = assertFixedHud(frame, "手札");
    close(menuHud.x!, firstHud.x!, 0.5, "fixed HUD menu x is outside the reveal clip");
    close(menuHud.y!, firstHud.y!, 0.5, "fixed HUD menu y is outside the reveal clip");

    // The menu exposes the existing quick-save action directly, so the engine
    // stays paused at the same transition sample while native storage commits.
    frame = await session.tap("快速保存此刻", frame);
    const saveKey = "reveal.slot.quick";
    for (let attempt = 0; attempt < 30 && !session.storage[saveKey]; attempt += 1) frame = await session.frame();
    const save = session.storage[saveKey] as { state?: { paused?: boolean; stage?: { background?: string; transition?: Record<string, unknown> } } } | undefined;
    assert.ok(save, "the real NovelView quick-save action writes through the host storage capability");
    const savedTransition = save!.state?.stage?.transition;
    assert.ok(savedTransition, "the paused quick save retains an in-progress scene transition");
    assert.equal(savedTransition!.kind, "reveal", "the save keeps the active transition kind");
    assert.equal(savedTransition!.direction, "left", "the omitted direction resolves to left in saved engine state");
    assert.equal(savedTransition!.from && (savedTransition!.from as Record<string, unknown>).background, "old",
      "the save retains the prior stage composition for the reveal");
    assert.ok(Number.isInteger(savedTransition!.id) && Number(savedTransition!.id) > 0, "the saved reveal keeps its stable transition id");
    assert.ok(Number(savedTransition!.elapsedMs) > 0 && Number(savedTransition!.elapsedMs) < transitionMs,
      "the saved reveal keeps the live shared-clock position");
    assert.equal(save!.state?.paused, false, "a menu save stores resumable engine state as the existing NovelView policy requires");

    frame = await session.tap("继续阅读", frame);
    frame = await waitForRevealEnd(session, frame, backgrounds.old, backgrounds.left);
    assert.ok(!image(frame, backgrounds.old), "the first transition reaches its actual terminal stage");

    // Loading that slot after completion must restore the same in-flight
    // clip, source scene, direction and elapsed clock through the real Guest.
    frame = await session.tap("手札", frame);
    frame = await session.tap("重读信笺", frame);
    frame = await waitForQuickSlotReady(session, frame);
    frame = await session.tap("快速存档", frame);
    frame = await waitForPartialReveal(session, frame, backgrounds.old, backgrounds.left);
    const loadedTransitionOp = requiredImage(frame, backgrounds.left, "loaded reveal frame");
    const loadedClip = clipRect(frame, loadedTransitionOp, "loaded reveal frame");
    assertClipDirection("left", loadedClip, "initial");
    const loadedFraction = visibleFraction("left", loadedClip);
    const savedFraction = Number(savedTransition!.elapsedMs) / transitionMs;
    assert.ok(Math.abs(loadedFraction - savedFraction) < 0.16,
      `load restores the saved reveal clock position: saved=${savedFraction} painted=${loadedFraction}`);
    const loadedHud = assertFixedHud(frame, "手札");
    close(loadedHud.x!, firstHud.x!, 0.5, "loaded fixed HUD remains at its original x");
    close(loadedHud.y!, firstHud.y!, 0.5, "loaded fixed HUD remains at its original y");
    frame = await waitForRevealEnd(session, frame, backgrounds.old, backgrounds.left);
    assert.ok(!image(frame, backgrounds.old), "loaded reveal also removes its retained from-scene at completion");

    // Begin the right-directed transition, then use the real Rollback HUD.
    // It restores the completed prior line and its last stable stage.
    let rightAttempt = await session.tapPoint(dialoguePoint());
    rightAttempt = await waitForPartialReveal(session, rightAttempt, backgrounds.left, backgrounds.right);
    assertClipDirection("right", clipRect(rightAttempt, requiredImage(rightAttempt, backgrounds.right, "right rollback attempt"), "right rollback attempt"), "initial");
    frame = await session.tap("回溯", rightAttempt);
    assert.ok(textOf(frame).replace(/\s/g, "").includes("The default reveal moves from left to right.".replace(/\s/g, "")),
      `rollback returns to the real preceding dialogue checkpoint: ${textOf(frame)}`);
    assert.ok(image(frame, backgrounds.left), "rollback restores the prior stable stage");
    assert.ok(!image(frame, backgrounds.right), "rollback removes the discarded incoming stage");

    frame = await assertDirectionThroughNativeFrames(session, frame, "right", backgrounds.left, backgrounds.right);
    frame = await assertDirectionThroughNativeFrames(session, frame, "up", backgrounds.right, backgrounds.up);
    frame = await assertDirectionThroughNativeFrames(session, frame, "down", backgrounds.up, backgrounds.down);
    assert.ok(textOf(frame).includes("The bottom edge opens upward."), "the native story input reaches the final authored scene line");

    // Ablation control: the same engine and stage return to the initial art
    // with an immediate cut. There is no retained outgoing image or partial
    // reveal clip after the input, and the fixed HUD keeps its same geometry.
    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "The cut returns to the complete original stage.");
    const cutImage = requiredImage(frame, backgrounds.old, "cut control frame");
    const cutBounds = uncroppedImageBounds(cutImage, backgrounds.old);
    close(cutBounds.x, 0, 1, "cut image full-frame x");
    close(cutBounds.y, 0, 1, "cut image full-frame y");
    close(cutBounds.w, viewport.width, 1, "cut image is immediately full-width");
    close(cutBounds.h, viewport.height, 1, "cut image is immediately full-height");
    assert.ok(!image(frame, backgrounds.down), "cut immediately removes the prior reveal composition");
    if (cutImage.clip) {
      const cutClip = clipRect(frame, cutImage, "cut control frame");
      close(cutClip.x, 0, 1, "cut clip x");
      close(cutClip.y, 0, 1, "cut clip y");
      close(cutClip.w, viewport.width, 1, "cut has no partial horizontal clip");
      close(cutClip.h, viewport.height, 1, "cut has no partial vertical clip");
    }
    const hudAfterCut = assertFixedHud(frame, "手札");
    for (const key of ["x", "y", "w", "h"] as const) {
      close(hudAfterCut[key]!, firstHud[key]!, 0.5, `fixed HUD ${key} matches during-reveal position after cut`);
    }
    console.log(`novel_reveal_native: pinned buildGuest ${artifacts.runtimeAbi}; native DrawList validated default-left/right/up/down, fixed HUD, pause/skip, transition save-load/rollback, and immediate cut ablation`);
  } finally {
    await session?.quit();
    rmSync(project, { recursive: true, force: true });
  }
});
