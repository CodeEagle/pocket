import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type CommandEntry = { role: string; command: Record<string, any> };

test("preview prepareOpen keeps a resident child generation when OTA is unavailable", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-prepare-open-"));
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
let phase = 0;
let frame = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (command) => appendFileSync(logPath, JSON.stringify({ role, command }) + "\\n");
const rootFrame = () => ({
  frame: ++frame,
  width: 390,
  height: 360,
  ops: phase >= 2 ? [{ type: "hostSurface", surfaceHandle: 2, id: "pocket.test.child", x: 0, y: 0, w: 390, h: 360, focused: true }] : [],
  events: phase === 0
    ? [{ name: "host.request", payload: { requestId: "create-child", capability: "system.runtime.create", params: { appId: "pocket.test.child", prepareForOpen: true } } }]
    : phase === 1
      ? [{ name: "host.request", payload: { requestId: "await-child", capability: "system.runtime.awaitFirstFrame", params: { instanceId: "pocket-app-1", generation: 1 } } }]
      : phase === 2
        ? [{ name: "host.request", payload: { requestId: "prepare-child", capability: "system.runtime.prepareOpen", params: { instanceId: "pocket-app-1", generation: 1 } } }]
        : [],
  resources: [],
});
const childFrame = () => ({ frame: ++frame, width: 390, height: 360, ops: [{ type: "text", text: "child", x: 8, y: 8, w: 40, h: 15 }], events: [], resources: [] });
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  log(command);
  if (command.op === "quit") { reply({ ok: true }); setImmediate(() => process.exit(0)); return; }
  if (command.op === "loadBytecode") { role = String(command.bytecodePath).includes("child.qjbc") ? "child" : "root"; reply({ ok: true }); return; }
  if (command.op === "schedule") { reply({ ok: true, nextWakeDelayMs: 0 }); return; }
  if (command.op === "send") {
    const message = command.message;
    if (role === "root" && message?.type === "event" && message.name === "host.response") {
      const capability = message.payload?.capability;
      if (capability === "system.runtime.create") phase = 1;
      if (capability === "system.runtime.awaitFirstFrame") phase = 2;
      if (capability === "system.runtime.prepareOpen") phase = 3;
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
    width: 390,
    height: 360,
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
  const projectId = "prepare-open";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const deadline = Date.now() + 3_000;
    let prepared: CommandEntry | undefined;
    while (Date.now() < deadline && !prepared) {
      const entries = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as CommandEntry);
      prepared = entries.find((entry) => entry.role === "root" && entry.command.op === "send" &&
        entry.command.message?.name === "host.response" &&
        entry.command.message?.payload?.capability === "system.runtime.prepareOpen");
      if (!prepared) await Bun.sleep(15);
    }
    assert.ok(prepared, "preview SystemUI must issue and answer prepareOpen for a resident child");
    assert.deepEqual(prepared.command.message.payload.result, {
      instanceId: "pocket-app-1",
      appId: "pocket.test.child",
      previousGeneration: 1,
      generation: 1,
      updated: false,
      configured: false,
    });
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
