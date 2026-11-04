import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type CommandEntry = { role: string; command: Record<string, any> };

test("publishes root and compositor-child safe areas without duplicate slot padding", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-safe-area-"));
  const probePath = join(root, "probe.mjs");
  const logPath = join(root, "commands.jsonl");
  const project = join(root, "project");
  const rootBytecode = join(root, "root.qjbc");
  const rootPak = join(root, "root.pak");
  const childBytecode = join(root, "child.qjbc");
  const childPak = join(root, "child.pak");
  await mkdir(join(project, "apps/child"), { recursive: true });
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: { catalog: [{ package: "pocket.test.child", manifest: "apps/child/manifest.json" }] },
    installation: { installedPackages: ["pocket.test.child"] },
  }));
  await writeFile(join(project, "apps/child/manifest.json"), "{}");
  for (const path of [rootBytecode, rootPak, childBytecode, childPak]) await writeFile(path, "fake-artifact");
  await writeFile(probePath, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = ${JSON.stringify(logPath)};
let role = "unknown";
let frame = 0;
let phase = 0;
let rootWidth = 375;
let rootHeight = 812;
let childWidth = 375;
let childHeight = 812;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (command) => appendFileSync(logPath, JSON.stringify({ role, command }) + "\\n");
const rootFrame = () => ({
  frame: ++frame,
  width: rootWidth,
  height: rootHeight,
  ops: phase >= 2 ? [{ type: "hostSurface", surfaceHandle: 2, id: "pocket.test.child", x: 0, y: 44, w: rootWidth, h: Math.max(1, rootHeight - 78), focused: true }] : [],
  events: phase === 0
    ? [{ name: "host.request", payload: { requestId: "create-child", capability: "system.runtime.create", params: { appId: "pocket.test.child" } } }]
    : phase === 1
      ? [{ name: "host.request", payload: { requestId: "await-child", capability: "system.runtime.awaitFirstFrame", params: { instanceId: "pocket-app-1", generation: 1 } } }]
      : [],
  resources: [],
});
const childFrame = () => ({
  frame: ++frame,
  width: childWidth,
  height: childHeight,
  ops: [{ type: "text", text: \`child-viewport-\${childWidth}x\${childHeight}\`, x: 8, y: 8, w: 160, h: 15 }],
  events: [],
  resources: [],
});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  log(command);
  if (command.op === "quit") { reply({ ok: true }); setImmediate(() => process.exit(0)); return; }
  if (command.op === "create") {
    if (role === "child") { childWidth = Number(command.width); childHeight = Number(command.height); }
    else { rootWidth = Number(command.width); rootHeight = Number(command.height); }
    reply({ ok: true });
    return;
  }
  if (command.op === "loadBytecode") { role = String(command.bytecodePath).includes("child.qjbc") ? "child" : "root"; reply({ ok: true }); return; }
  if (command.op === "resize") {
    if (role === "child") { childWidth = Number(command.width); childHeight = Number(command.height); }
    else { rootWidth = Number(command.width); rootHeight = Number(command.height); }
    reply({ ok: true });
    return;
  }
  if (command.op === "schedule") { reply({ ok: true, nextWakeDelayMs: -1 }); return; }
  if (command.op === "send") {
    const message = command.message;
    if (role === "root" && message?.type === "event" && message.name === "host.response") {
      if (message.payload?.capability === "system.runtime.create") phase = 1;
      if (message.payload?.capability === "system.runtime.awaitFirstFrame") phase = 2;
    }
    reply({ ok: true });
    return;
  }
  if (command.op === "frame") { reply({ ok: true, frame: role === "child" ? childFrame() : rootFrame() }); return; }
  reply({ ok: true });
});
`, "utf8");
  await chmod(probePath, 0o755);

  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 5_000,
    width: 375,
    height: 812,
    safeArea: { top: 44, right: 0, bottom: 34, left: 0 },
    idleDisposeMs: 1_000,
    artifacts: {
      bytecodePath: rootBytecode,
      pakPath: rootPak,
      revision: 1,
      applications: {
        "pocket.test.child": { bytecodePath: childBytecode, pakPath: childPak, appId: "pocket.test.child" },
      },
      tickHz: 60,
    },
  });
  const projectId = "safe-area";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  const snapshot = async (): Promise<Record<string, any>> => {
    const response = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
    assert.equal(response.status, 200);
    return await response.json() as Record<string, any>;
  };
  const waitFor = async (predicate: (value: Record<string, any>) => boolean): Promise<Record<string, any>> => {
    const deadline = Date.now() + 3_000;
    let value = await snapshot();
    while (Date.now() < deadline && !predicate(value)) {
      await Bun.sleep(15);
      value = await snapshot();
    }
    assert.ok(predicate(value), `safe-area fixture did not settle: ${JSON.stringify(value.status)}`);
    return value;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const value = await waitFor((next) => next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child-viewport-375x734"));
    assert.equal(value.frame.width, 375);
    assert.equal(value.frame.height, 812);

    const entries = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as CommandEntry);
    const displayFacts = entries
      .filter((entry) => entry.command.op === "send" && entry.command.message?.method === "display.viewport")
      .map((entry) => ({ role: entry.role, params: entry.command.message.params }));
    assert.deepEqual(displayFacts[0], { role: "root", params: { width: 375, height: 812, safeArea: { top: 44, right: 0, bottom: 34, left: 0 } } });
    assert.ok(displayFacts.some((fact) => fact.role === "child" && fact.params.width === 375 && fact.params.height === 812 && fact.params.safeArea.top === 44 && fact.params.safeArea.bottom === 34), "fullscreen child must inherit root insets before its host slot is known");
    assert.ok(displayFacts.some((fact) => fact.role === "child" && fact.params.width === 375 && fact.params.height === 734 && JSON.stringify(fact.params.safeArea) === JSON.stringify({ top: 0, right: 0, bottom: 0, left: 0 })), "safe-clipped child must not receive duplicate insets");

    await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "resize", width: 768, height: 1023 }),
    }), projectId, "input");
    const afterTablet = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as CommandEntry);
    const rootFacts = afterTablet
      .filter((entry) => entry.role === "root" && entry.command.op === "send" && entry.command.message?.method === "display.viewport")
      .map((entry) => entry.command.message.params);
    assert.deepEqual(rootFacts.at(-1), { width: 768, height: 1023, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }, "resize without safeArea must clear the previous phone profile");
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
