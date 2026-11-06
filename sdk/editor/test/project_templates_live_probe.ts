/** Real template acceptance: init -> pinned buildGuest -> native Preview -> pointer input. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initProject, buildProject } from "../../pocket.ts";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager } from "../preview.ts";

type Frame = { ops: Array<{ type: string; text?: string; x: number; y: number; w: number; h: number }> };
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
  async function click(label: string) {
    const current = await waitFor(f => has(f, label));
    const op = current.ops.find(op => op.type === "text" && op.text === label)!;
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request(route("input"), {
        method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x: op.x + op.w / 2, y: op.y + op.h / 2 }),
      }), template, "input");
      assert.equal(response.status, 200);
    }
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
    await waitFor(f => has(f, "准备开始") && has(f, "得分：0 | 剩余：30"));
    await click("开始游戏");
    await waitFor(f => has(f, "进行中"));
    await click("命中");
    await waitFor(f => f.ops.some(op => op.text?.startsWith("得分：1 | 剩余：")));
    await click("暂停");
    const paused = await waitFor(f => has(f, "已暂停"));
    const pausedScore = paused.ops.find(op => op.text?.startsWith("得分："))!.text;
    await delay(1200);
    assert.ok(has(await frame(), pausedScore!), "paused countdown must remain unchanged");
    await click("继续");
    await waitFor(f => has(f, "进行中"));
    await waitFor(f => !has(f, pausedScore!), 3000);
    await click("重新开始");
    await waitFor(f => has(f, "得分：0 | 剩余：30"));
    await waitFor(f => has(f, "本局结束") && has(f, "得分：0 | 剩余：0"), 35_000);
    await click("重新开始");
    await waitFor(f => has(f, "进行中") && has(f, "得分：0 | 剩余：30"));
    return { template, scoreFromPointer: true, pauseFreezesTime: true, resume: true, restart: true, roundExpiry: true };
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
