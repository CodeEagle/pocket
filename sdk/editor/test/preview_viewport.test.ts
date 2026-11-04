import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

/**
 * This fake probe only observes the adapter command boundary. The companion
 * real-native mini-app acceptance remains in preview_mini_app.test.ts; this
 * test makes the resize contract deterministic and catches a regression that
 * would otherwise be hidden by the adapter's final DrawOp scaling.
 */
test("resizes a mounted child to its host slot and preserves pointer mapping", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-viewport-"));
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
let rootPhase = 0;
let rootHeight = 844;
let slotY = 701;
let slotHeight = 844;
let childWidth = 390;
let childHeight = 844;
let hidden = false;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (command) => appendFileSync(logPath, JSON.stringify({ role, command }) + "\\n");
const rootFrame = () => ({
  frame: ++frame,
  width: 390,
  height: rootHeight,
  ops: rootPhase >= 2 && !hidden
    ? [{ type: "hostSurface", surfaceHandle: 2, id: "pocket.test.child", x: 0, y: slotY, w: 390, h: slotHeight, focused: true }]
    : [],
  events: rootPhase === 0
    ? [{ name: "host.request", payload: { requestId: "create-child", capability: "system.runtime.create", params: { appId: "pocket.test.child" } } }]
    : rootPhase === 1
      ? [{ name: "host.request", payload: { requestId: "await-child", capability: "system.runtime.awaitFirstFrame", params: { instanceId: "pocket-app-1", generation: 1 } } }]
      : [],
  resources: [],
});
const childFrame = () => ({
  frame: ++frame,
  width: childWidth,
  height: childHeight,
  ops: [{ type: "text", text: \`child-viewport-\${childWidth}x\${childHeight}\`, x: 8, y: 8, w: 120, h: 15 }],
  events: [],
  resources: [],
});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  log(command);
  if (command.op === "quit") {
    reply({ ok: true });
    setImmediate(() => process.exit(0));
    return;
  }
  if (command.op === "create") {
    if (role === "child") {
      childWidth = Number(command.width);
      childHeight = Number(command.height);
    } else {
      rootHeight = Number(command.height);
    }
    reply({ ok: true });
    return;
  }
  if (command.op === "loadBytecode") {
    role = String(command.bytecodePath).includes("child.qjbc") ? "child" : "root";
    reply({ ok: true });
    return;
  }
  if (command.op === "resize") {
    if (role === "child") {
      childWidth = Number(command.width);
      childHeight = Number(command.height);
    } else {
      rootHeight = Number(command.height);
      // The first admitted frame models the native mini-app entry sheet:
      // 390x844 starts at y=701 and is clipped by the 844px root. A later
      // resize settles it into the 390x788 host slot below the top chrome.
      slotY = 56;
      slotHeight = Math.max(1, rootHeight - 56);
    }
    reply({ ok: true });
    return;
  }
  if (command.op === "schedule") {
    reply({ ok: true, nextWakeDelayMs: 0 });
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (role === "root" && message?.type === "hide-surface") hidden = true;
    if (role === "root" && message?.type === "event" && message.name === "host.response") {
      const capability = message.payload?.capability;
      if (capability === "system.runtime.create") rootPhase = 1;
      if (capability === "system.runtime.awaitFirstFrame") rootPhase = 2;
    }
    reply({ ok: true });
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

  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 5_000,
    width: 390,
    height: 844,
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
  const projectId = "viewport-slot";
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
    assert.ok(predicate(value), `viewport fixture did not settle: ${JSON.stringify(value.status)}`);
    return value;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    let value = await waitFor((next) => next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child-viewport-390x844"));
    assert.equal(value.frame.inputBounds?.x, 0);
    assert.equal(value.frame.inputBounds?.y, 701);
    assert.equal(value.frame.inputBounds?.w, 390);
    assert.equal(value.frame.inputBounds?.h, 143);

    const commands = () => readFile(logPath, "utf8").then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { role: string; command: Record<string, any> }));
    let entries = await commands();
    const childResizes = () => entries.filter((entry) => entry.role === "child" && entry.command.op === "resize");
    assert.deepEqual(childResizes().map((entry) => [entry.command.width, entry.command.height]), [], "matching initial slot must not trigger a redundant resize");

    // Settling the same root viewport changes the host constraints to the
    // 390x788 slot. The child must receive that resize before composition;
    // post-composition 788/844 scaling is intentionally not the fix.
    await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "resize", width: 390, height: 844 }),
    }), projectId, "input");
    value = await waitFor((next) => next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child-viewport-390x788"));
    assert.equal(value.frame.inputBounds?.x, 0);
    assert.equal(value.frame.inputBounds?.y, 56);
    assert.equal(value.frame.inputBounds?.w, 390);
    assert.equal(value.frame.inputBounds?.h, 788);
    entries = await commands();
    assert.deepEqual(childResizes().map((entry) => [entry.command.width, entry.command.height]), [[390, 788]], "child must be resized to settled slot, not post-scaled from root");

    const pointer = async (phase: "down" | "up", id = 0, x = 195, y = 450): Promise<void> => {
      const response = await manager.handle(new Request(`${base}/input`, {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id, x, y }),
      }), projectId, "input");
      assert.equal(response.status, 200);
    };
    await pointer("down");
    await pointer("up");
    entries = await commands();
    const childPointers = entries.filter((entry) => entry.role === "child" && entry.command.op === "send" && entry.command.message?.name === "input.pointer");
    assert.deepEqual(childPointers.map((entry) => [entry.command.message.payload.phase, entry.command.message.payload.x, entry.command.message.payload.y]), [
      ["down", 195, 394], ["up", 195, 394],
    ], "pointer must map through the slot using the resized child viewport");

    await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "resize", width: 390, height: 800 }),
    }), projectId, "input");
    value = await waitFor((next) => next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child-viewport-390x744"));
    assert.equal(value.frame.inputBounds?.h, 744);
    entries = await commands();
    assert.deepEqual(childResizes().map((entry) => [entry.command.width, entry.command.height]), [[390, 788], [390, 744]], "root resize must update the slot viewport once");

    await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "message", message: { type: "hide-surface" } }),
    }), projectId, "input");
    await Bun.sleep(80);
    entries = await commands();
    assert.deepEqual(childResizes().map((entry) => [entry.command.width, entry.command.height]), [[390, 788], [390, 744]], "hidden background child must not be forced to root size");
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
