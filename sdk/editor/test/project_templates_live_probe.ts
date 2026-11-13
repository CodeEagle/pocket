/** Real template acceptance: init -> pinned buildGuest -> native Preview -> pointer input. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initProject, buildProject } from "../../pocket.ts";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager } from "../preview.ts";

type Frame = { ops: Array<{ type: string; text?: string; x: number; y: number; w: number; h: number; color?: number }> };
const sdk = resolve(import.meta.dir, "../..");
const workspace = mkdtempSync(join(tmpdir(), "pocket-templates-live-"));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function verify(template: "app" | "game") {
  const project = join(workspace, template);
  const previousFlutter = process.env.FLUTTER_BIN;
  // This probe validates JS/Preview. It does not generate or claim to run a native Flutter app.
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try { await initProject(project, { template }); }
  finally {
    if (previousFlutter === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previousFlutter;
  }
  const built = await buildProject(project);
  let viewport = template === "game"
    ? { width: 390, height: 844, safeArea: { top: 44, right: 0, bottom: 80, left: 0 } }
    : { width: 390, height: 844, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } };
  const manager = createPreviewManager({
    probePath: resolveNativeProbePath(sdk), projectDirectory: project,
    ...viewport, idleDisposeMs: 60_000,
    artifacts: { bytecode: built.qjbc, pak: built.pak, revision: 1, tickHz: 60 },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamPump: Promise<void> | undefined;
  let streamFailure: unknown;
  const route = (suffix: string) => `http://127.0.0.1/api/projects/${template}/preview/${suffix}`;
  async function frame(): Promise<Frame> {
    const response = await manager.handle(new Request(route("snapshot")), template, "snapshot");
    assert.equal(response.status, 200);
    const snapshot = await response.json() as any;
    assert.equal(snapshot.status.state, "ready", JSON.stringify(snapshot.status));
    return snapshot.frame;
  }
  async function waitFor(predicate: (frame: Frame) => boolean, timeout = 4000): Promise<Frame> {
    const deadline = Date.now() + timeout;
    let current: Frame;
    do {
      current = await frame();
      if (predicate(current)) return current;
      await delay(30);
    } while (Date.now() < deadline);
    throw new Error(`Template ${template} did not reach expected frame: ${JSON.stringify(current!.ops.filter(op => op.type === "text"))}`);
  }
  const has = (f: Frame, text: string) => f.ops.some(op => op.type === "text" && op.text === text);
  const textOp = (f: Frame, text: string) => f.ops.find(op => op.type === "text" && op.text === text);
  const buttonBounds = (f: Frame, color: number, expectedHeight: number) => f.ops.find(op =>
    (op.type === "rect" || op.type === "rounded")
    && op.color === color && Math.abs(op.h - expectedHeight) < 1 && op.w > 100);
  const assertWithin = (op: { x: number; y: number; w: number; h: number } | undefined, rect: { left: number; top: number; right: number; bottom: number }, label: string) => {
    assert.ok(op, `${label} must be painted with bounds`);
    assert.ok(op.x >= rect.left - 1 && op.y >= rect.top - 1 && op.x + op.w <= rect.right + 1 && op.y + op.h <= rect.bottom + 1,
      `${label} must fit its safe rectangle: op=${JSON.stringify(op)} rect=${JSON.stringify(rect)}`);
  };
  const safeContent = () => ({
    left: viewport.safeArea.left,
    top: viewport.safeArea.top + 56,
    right: viewport.width - viewport.safeArea.right,
    bottom: viewport.height - viewport.safeArea.bottom - 14,
  });
  const assertGameBackdrop = (frame: Frame) => {
    const fullCanvas = frame.ops.find(op => op.type === "rect" && op.color === 0xff080f21 && op.x === 0 && op.y === 0 && op.w === viewport.width && op.h === viewport.height);
    assert.ok(fullCanvas, `Game canvas fill must cover the full viewport ${viewport.width}x${viewport.height}`);
    const topStarX = viewport.width * .63;
    const bottomStarX = viewport.width * .16;
    const topStar = frame.ops.find(op => op.color === 0xff6687ac && Math.abs(op.x - topStarX) < 1 && op.y < viewport.safeArea.top);
    const bottomStar = frame.ops.find(op => op.color === 0xff6687ac && Math.abs(op.x - bottomStarX) < 1 && op.y + op.h > viewport.height - viewport.safeArea.bottom);
    assert.ok(topStar, `decorative star must paint into the unsafe top area: ${JSON.stringify(frame.ops.filter(op => op.color === 0xff6687ac).slice(0, 4))}`);
    assert.ok(bottomStar, "decorative star must paint into the unsafe bottom area");
    const leftStar = frame.ops.find(op => op.color === 0xff6687ac && Math.abs(op.x - viewport.width * .02) < 1 && op.x + op.w < viewport.safeArea.left);
    const rightStar = frame.ops.find(op => op.color === 0xff6687ac && Math.abs(op.x - viewport.width * .95) < 1 && op.x > viewport.width - viewport.safeArea.right);
    if (viewport.safeArea.left > 0) assert.ok(leftStar, "decorative star must extend through the unsafe left area");
    if (viewport.safeArea.right > 0) assert.ok(rightStar, "decorative star must extend through the unsafe right area");
    const coveredAfter = (sample: { x: number; y: number }, after: number) => frame.ops.slice(after + 1).some(op =>
      (op.type === "rect" || op.type === "rounded" || op.type === "image")
      && (op.color === undefined || (op.color >>> 24) === 0xff)
      && op.x <= sample.x && op.y <= sample.y && op.x + op.w >= sample.x && op.y + op.h >= sample.y);
    const topIndex = frame.ops.indexOf(topStar);
    const bottomIndex = frame.ops.indexOf(bottomStar);
    assert.ok(topIndex > frame.ops.indexOf(fullCanvas), "background detail must paint after the opaque canvas fill");
    assert.ok(bottomIndex > frame.ops.indexOf(fullCanvas), "bottom-edge detail must paint after the opaque canvas fill");
    assert.equal(coveredAfter({ x: topStar.x + topStar.w / 2, y: topStar.y + topStar.h / 2 }, topIndex), false, "later opaque content must not hide the top-edge detail");
    assert.equal(coveredAfter({ x: bottomStar.x + bottomStar.w / 2, y: bottomStar.y + bottomStar.h / 2 }, bottomIndex), false, "later opaque content must not hide the bottom-edge detail");
    if (leftStar) assert.equal(coveredAfter({ x: leftStar.x + leftStar.w / 2, y: leftStar.y + leftStar.h / 2 }, frame.ops.indexOf(leftStar)), false, "later opaque content must not hide the left-edge detail");
    if (rightStar) assert.equal(coveredAfter({ x: rightStar.x + rightStar.w / 2, y: rightStar.y + rightStar.h / 2 }, frame.ops.indexOf(rightStar)), false, "later opaque content must not hide the right-edge detail");
    const planet = frame.ops.find(op => op.color === 0xff11273d);
    assert.ok(planet, "full-viewport planet layer must paint");
  };
  const assertGameTargetSafe = (frame: Frame) => {
    const target = frame.ops.find(op => op.color === 0xff312f36);
    assert.ok(target, "playing Game must expose the visible target bounds");
    assertWithin(target, safeContent(), "Game target bounds");
    return target;
  };
  async function tap(x: number, y: number, holdMs = 120) {
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request(route("input"), {
        method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x, y }),
      }), template, "input");
      assert.equal(response.status, 200);
      if (phase === "down") await delay(holdMs);
    }
  }
  async function click(label: string) {
    const current = await waitFor(f => has(f, label));
    const op = current.ops.find(op => op.type === "text" && op.text === label)!;
    await tap(op.x + op.w / 2, op.y + op.h / 2);
  }

  try {
    const stream = await manager.handle(new Request(route("stream")), template, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    streamPump = (async () => {
      try {
        while (reader) {
          const packet = await reader.read();
          if (packet.done) break;
        }
      } catch (error) {
        streamFailure = error;
      }
    })();
    if (template === "app") {
      await click("深色");
      await waitFor(f => has(f, "浅色"));
      await click("浅色");
      await waitFor(f => has(f, "深色"));
      return { template, themeToggle: true };
    }
    const ready = await waitFor(f => has(f, "星尘捕手") && has(f, "得分：0") && has(f, "剩余：30 秒"));
    assertGameBackdrop(ready);
    const readyRect = safeContent();
    assertWithin(textOp(ready, "星尘捕手"), readyRect, "ready title");
    assertWithin(textOp(ready, "追上星光，点击收集 · 30 秒挑战"), readyRect, "ready detail");
    assertWithin(textOp(ready, "开始游戏"), readyRect, "ready action");
    assertWithin(textOp(ready, "得分：0"), {
      left: viewport.safeArea.left, top: viewport.safeArea.top,
      right: viewport.width - viewport.safeArea.right, bottom: viewport.safeArea.top + 56,
    }, "measured MobileAppBar title/subtitle band");
    assertWithin(textOp(ready, "POCKET ARCADE"), {
      left: viewport.safeArea.left, top: viewport.safeArea.top,
      right: viewport.width - viewport.safeArea.right, bottom: viewport.safeArea.top + 56,
    }, "measured MobileAppBar subtitle band");
    const readyButton = buttonBounds(ready, 0xfff9cf72, 44);
    assertWithin(readyButton, readyRect, "ready primary button hit box");
    await click("开始游戏");
    const playing = await waitFor(f => has(f, "点击发光星核"));
    assertGameTargetSafe(playing);
    const pause = textOp(playing, "暂停");
    assertWithin(pause, { left: viewport.safeArea.left, top: viewport.safeArea.top, right: viewport.width - viewport.safeArea.right - 60, bottom: viewport.height - viewport.safeArea.bottom }, "pause action and reserved host-close region");
    // Locate the graphic core by its rendered color, not a hidden hit label.
    const core = (f: Frame) => f.ops.find(op => op.color === 0xfffff8df);
    const firstCore = core(playing)!;
    assert.ok(firstCore, "playing frame must contain the graphic star core");
    const moved = await waitFor(f => !!core(f) && (core(f)!.x !== firstCore.x || core(f)!.y !== firstCore.y));
    await tap(8, 100);
    assert.ok(has(await frame(), "得分：0"), "empty space must not score");
    const target = core(moved)!;
    await tap(target.x + target.w / 2, target.y + target.h / 2);
    await waitFor(f => has(f, "+1"));
    const scored = await waitFor(f => has(f, "得分：1"));
    // Keep the next target trackable while the player aims. The former
    // 1.2-second teleport could remove it before a normal click arrived.
    const nextTarget = core(scored)!;
    await delay(1400);
    const heldTarget = core(await frame())!;
    assert.ok(Math.abs(heldTarget.x - nextTarget.x) <= 20 && Math.abs(heldTarget.y - nextTarget.y) <= 20,
      "target must stay near its visible position until hit");
    await tap(heldTarget.x + heldTarget.w / 2, heldTarget.y + heldTarget.h / 2, 300);
    await waitFor(f => has(f, "得分：2"));
    await click("暂停");
    const paused = await waitFor(f => has(f, "已暂停"));
    for (const label of ["已暂停", "星光在等你", "继续", "重新开始"]) assertWithin(textOp(paused, label), safeContent(), `paused ${label}`);
    const pausedTime = paused.ops.find(op => op.text?.startsWith("剩余："))!.text;
    await delay(1200);
    assert.ok(has(await frame(), pausedTime!), "paused countdown must remain unchanged");
    await click("继续");
    await waitFor(f => has(f, "点击发光星核"));
    await waitFor(f => !has(f, pausedTime!), 3000);

    // Rotate the same live Guest to a short landscape canvas. The scaffold
    // receives the new single safe-area fact; the field/target stay in it,
    // while the scene art remains full-viewport and the app-bar keeps the
    // existing 60px mini-app host-action reserve.
    viewport = { width: 844, height: 320, safeArea: { top: 12, right: 44, bottom: 26, left: 44 } };
    const resize = await manager.handle(new Request(route("input"), {
      method: "POST",
      body: JSON.stringify({ type: "resize", ...viewport }),
    }), template, "input");
    assert.equal(resize.status, 200);
    const rotated = await waitFor(f => has(f, "点击发光星核") && has(f, "得分：2"));
    assertGameBackdrop(rotated);
    assertGameTargetSafe(rotated);
    assertWithin(textOp(rotated, "暂停"), { left: viewport.safeArea.left, top: viewport.safeArea.top, right: viewport.width - viewport.safeArea.right - 60, bottom: viewport.height - viewport.safeArea.bottom }, "rotated pause action and reserved host-close region");
    await click("暂停");
    let rotatedPaused = await waitFor(f => has(f, "已暂停"));
    for (const label of ["已暂停", "星光在等你", "继续", "重新开始"]) assertWithin(textOp(rotatedPaused, label), safeContent(), `rotated paused ${label}`);
    const restartButton = buttonBounds(rotatedPaused, 0xff16263a, 36);
    assertWithin(restartButton, safeContent(), "rotated restart button hit box");
    await click("继续");
    const rotatedPlaying = await waitFor(f => has(f, "点击发光星核") && has(f, "得分：2"));
    const rotatedTarget = core(rotatedPlaying)!;
    assertGameTargetSafe(rotatedPlaying);
    await tap(rotatedTarget.x + rotatedTarget.w / 2, rotatedTarget.y + rotatedTarget.h / 2, 180);
    await waitFor(f => has(f, "得分：3"));
    await click("暂停");
    rotatedPaused = await waitFor(f => has(f, "已暂停") && has(f, "得分：3"));
    const rotatedRestart = buttonBounds(rotatedPaused, 0xff16263a, 36);
    assertWithin(rotatedRestart, safeContent(), "rotated restart button hit box before edge input");
    await tap(rotatedRestart!.x + rotatedRestart!.w / 2, rotatedRestart!.y + rotatedRestart!.h + 1, 120);
    assert.ok(has(await frame(), "已暂停"), "a tap just below the restart hit box must not activate it");
    await tap(rotatedRestart!.x + rotatedRestart!.w / 2, rotatedRestart!.y + rotatedRestart!.h - 1, 180);
    const restarted = await waitFor(f => has(f, "点击发光星核") && has(f, "得分：0") && has(f, "剩余：30 秒"));
    assertGameTargetSafe(restarted);
    await waitFor(f => has(f, "本局结束") && has(f, "得分：0") && has(f, "剩余：0 秒"), 35_000);
    await click("再来一局");
    await waitFor(f => has(f, "点击发光星核") && has(f, "得分：0") && has(f, "剩余：30 秒"));
    return { template, fullViewportBackground: true, safeReadyAndPausedBounds: true, miniAppHostActionReserve: true, rotationAndScoreInput: true, graphicMotion: true, emptySpaceDoesNotScore: true, hitParticles: true, scoreFromPointer: true, heldPressAcrossFrames: true, pauseFreezesTime: true, resume: true, restart: true, roundExpiry: true };
  } finally {
    await reader?.cancel();
    await streamPump;
    await manager.dispose();
    if (streamFailure) throw streamFailure;
  }
}

try {
  const results = [];
  for (const template of ["app", "game"] as const) results.push(await verify(template));
  console.log("TEMPLATE_LIVE_ACCEPTANCE", JSON.stringify({ ok: true, results }));
} finally { rmSync(workspace, { recursive: true, force: true }); }
