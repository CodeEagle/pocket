import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("delayed child startup leaves root frames and input live, then dispose cancels its load", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-child-startup-"));
  const project = join(root, "project");
  const childProject = join(project, "apps/child");
  const probePath = join(root, "probe.mjs");
  const childLoadStarted = join(root, "child-load-started");
  const childLoadFinished = join(root, "child-load-finished");
  const rootBytecode = join(root, "root.qjbc");
  const rootPak = join(root, "root.pak");
  const childBytecode = join(root, "child.qjbc");
  const childPak = join(root, "child.pak");
  const childLoadDelayMs = 1_800;
  await mkdir(childProject, { recursive: true });
  await writeFile(join(project, "manifest.json"), "{}");
  await writeFile(join(childProject, "manifest.json"), "{}");
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: {
      catalog: [
        { package: "pocket.test.system", manifest: "manifest.json", required: true },
        { package: "pocket.test.child", manifest: "apps/child/manifest.json" },
      ],
      backgroundExecution: "suspend",
    },
    installation: { installedPackages: ["pocket.test.system", "pocket.test.child"] },
  }));
  for (const path of [rootBytecode, rootPak, childBytecode, childPak]) await writeFile(path, "fake-artifact");
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const childLoadStarted = ${JSON.stringify(childLoadStarted)};
const childLoadFinished = ${JSON.stringify(childLoadFinished)};
const childLoadDelayMs = ${childLoadDelayMs};
let role = "unknown";
let frame = 0;
let createRequested = false;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rootFrame = () => {
  const events = [];
  if (!createRequested) {
    createRequested = true;
    events.push({ name: "host.request", payload: {
      requestId: "create-child", capability: "system.runtime.create",
      params: { appId: "pocket.test.child" },
    } });
  }
  return { frame: ++frame, width: 390, height: 360,
    ops: [{ type: "text", text: "root-frame", x: 8, y: frame, w: 80, h: 16 }], events, resources: [] };
};
const childFrame = () => ({ frame: ++frame, width: 390, height: 360, ops: [], events: [], resources: [] });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") {
    reply({ ok: true });
    setImmediate(() => process.exit(0));
    return;
  }
  if (command.op === "loadBytecode") {
    role = String(command.bytecodePath).includes("child.qjbc") ? "child" : "root";
    if (role === "child") {
      writeFileSync(childLoadStarted, String(Date.now()));
      setTimeout(() => {
        writeFileSync(childLoadFinished, String(Date.now()));
        reply({ ok: true });
      }, childLoadDelayMs);
    } else reply({ ok: true });
    return;
  }
  if (command.op === "schedule") {
    reply({ ok: true, nextWakeDelayMs: role === "root" ? 0 : -1 });
    return;
  }
  if (command.op === "frame") {
    reply({ ok: true, frame: role === "child" ? childFrame() : rootFrame() });
    return;
  }
  reply({ ok: true });
});
`, "utf8");
  await chmod(probePath, 0o755);

  const projectId = "child-startup-nonblocking";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 5_000,
    width: 390,
    height: 360,
    idleDisposeMs: 60_000,
    artifacts: {
      bytecodePath: rootBytecode,
      pakPath: rootPak,
      appId: "pocket.test.system",
      applications: {
        "pocket.test.child": { bytecodePath: childBytecode, pakPath: childPak, appId: "pocket.test.child" },
      },
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let disposed = false;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const snapshot = async () => {
      const response = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
      assert.equal(response.status, 200);
      return await response.json() as Record<string, any>;
    };
    const loadDeadline = Date.now() + 2_000;
    while (!existsSync(childLoadStarted) && Date.now() < loadDeadline) await Bun.sleep(10);
    assert.ok(existsSync(childLoadStarted), "the native child probe must reach its deliberately delayed QJBC load");

    const before = await snapshot();
    await Bun.sleep(100);
    const during = await snapshot();
    assert.ok(Number(during.frame.frame) > Number(before.frame.frame),
      `root frames must keep advancing during child load: ${before.frame.frame} -> ${during.frame.frame}`);

    const inputStartedAt = Date.now();
    const input = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "message", message: { type: "preview.test.input" } }),
    }), projectId, "input");
    assert.equal(input.status, 200, await input.text());
    assert.ok(Date.now() - inputStartedAt < 500,
      "root input must not wait for the delayed child bytecode load");
    assert.equal(existsSync(childLoadFinished), false,
      "root frame and input checks must finish while child bytecode is still loading");

    const session = (manager as any).sessions.get(projectId);
    const disposeStartedAt = Date.now();
    await manager.dispose();
    disposed = true;
    assert.ok(Date.now() - disposeStartedAt < 1_500,
      "dispose must stop an in-flight child probe instead of waiting for its load delay");
    await Bun.sleep(childLoadDelayMs + 50);
    assert.equal(session.childRuntimeLoads.size, 0, "cancelled child load must not remain registered");
    assert.equal(session.childRuntimes.size, 0, "cancelled child must not be admitted after disposal");
  } finally {
    await reader?.cancel();
    if (!disposed) await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
