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
  const manager = createPreviewManager({
    probePath: resolveNativeProbePath(sdk), projectDirectory: project,
    width: 390, height: 844, idleDisposeMs: 60_000,
    artifacts: { bytecode: built.qjbc, pak: built.pak, revision: 1, tickHz: 60 },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
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
    if (template === "app") {
      await click("深色");
      await waitFor(f => has(f, "浅色"));
      await click("浅色");
      await waitFor(f => has(f, "深色"));
      return { template, themeToggle: true };
    }
    await waitFor(f => has(f, "星尘捕手") && has(f, "得分：0") && has(f, "剩余：30 秒"));
    await click("开始游戏");
    const playing = await waitFor(f => has(f, "点击发光星核"));
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
    const pausedTime = paused.ops.find(op => op.text?.startsWith("剩余："))!.text;
    await delay(1200);
    assert.ok(has(await frame(), pausedTime!), "paused countdown must remain unchanged");
    await click("继续");
    await waitFor(f => has(f, "点击发光星核"));
    await waitFor(f => !has(f, pausedTime!), 3000);
    await click("暂停");
    await click("重新开始");
    await waitFor(f => has(f, "得分：0") && has(f, "剩余：30 秒"));
    await waitFor(f => has(f, "本局结束") && has(f, "得分：0") && has(f, "剩余：0 秒"), 35_000);
    await click("再来一局");
    await waitFor(f => has(f, "点击发光星核") && has(f, "得分：0") && has(f, "剩余：30 秒"));
    return { template, graphicMotion: true, emptySpaceDoesNotScore: true, hitParticles: true, scoreFromPointer: true, heldPressAcrossFrames: true, pauseFreezesTime: true, resume: true, restart: true, roundExpiry: true };
  } finally {
    await reader?.cancel();
    await manager.dispose();
  }
}

try {
  const results = [];
  for (const template of ["app", "game"] as const) results.push(await verify(template));
  console.log("TEMPLATE_LIVE_ACCEPTANCE", JSON.stringify({ ok: true, results }));
} finally { rmSync(workspace, { recursive: true, force: true }); }
