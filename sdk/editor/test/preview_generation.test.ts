import { strict as assert } from "node:assert";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");

test("a late child idle schedule result cannot clear a newer active timer", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-schedule-generation-"));
  const probePath = join(root, "probe.mjs");
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
  for (const path of [rootBytecode, rootPak, childBytecode, childPak]) await writeFile(path, "fake-artifact");
  await writeFile(join(project, "apps/child/manifest.json"), "{}");
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let role = "unknown";
let frame = 0;
let rootPhase = 0;
let hideSurface = false;
let childSchedules = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rootFrame = () => ({
  frame: ++frame,
  width: 390,
  height: 360,
  ops: hideSurface || rootPhase < 2 ? [] : [{ type: "hostSurface", surfaceHandle: 2, id: "pocket.test.child", x: 0, y: 0, w: 390, h: 360 }],
  events: rootPhase === 0 ? [{ name: "host.request", payload: { requestId: "create-child", capability: "system.runtime.create", params: { appId: "pocket.test.child" } } }]
    : rootPhase === 1 ? [{ name: "host.request", payload: { requestId: "await-child", capability: "system.runtime.awaitFirstFrame", params: { instanceId: "pocket-app-1", generation: 1 } } }]
      : [],
  resources: [],
});
const childFrame = () => ({ frame: ++frame, width: 390, height: 360, ops: [{ type: "text", text: "child", x: 8, y: 8, w: 40, h: 15 }], events: [], resources: [] });
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
    reply({ ok: true });
    return;
  }
  if (command.op === "schedule") {
    if (role === "child" && childSchedules++ === 0) {
      // This is the stale child result. It must arrive after the root has
      // hidden the child and installed a root-only active timer.
      setTimeout(() => reply({ ok: true, nextWakeDelayMs: -1 }), 220);
    } else {
      reply({ ok: true, nextWakeDelayMs: 0 });
    }
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (role === "root" && message?.type === "hide-surface") hideSurface = true;
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
  const projectId = "schedule-generation";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  const snapshot = async (): Promise<Record<string, any>> => {
    const response = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
    assert.equal(response.status, 200);
    return await response.json() as Record<string, any>;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const deadline = Date.now() + 2_000;
    let initial = await snapshot();
    while (Date.now() < deadline && !initial.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child")) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      initial = await snapshot();
    }
    assert.ok(initial.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "child"), "fake child must be focused before interleaving schedules");
    // Let stream.schedule() reach the child probe's deliberately delayed
    // first response, then hide the child. This starts a root-only schedule
    // that must install an active timer before the child response arrives.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    const hide = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "message", message: { type: "hide-surface" } }),
    }), projectId, "input");
    assert.equal(hide.status, 200);
    const beforeLate = await snapshot();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 280));
    const afterLate = await snapshot();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
    const afterSettled = await snapshot();
    assert.ok(Number(afterLate.frame.frame) > Number(beforeLate.frame.frame), `root active timer must tick before stale child result: ${beforeLate.frame.frame} -> ${afterLate.frame.frame}`);
    assert.ok(Number(afterSettled.frame.frame) > Number(afterLate.frame.frame), `late child idle result must not clear root timer: ${afterLate.frame.frame} -> ${afterSettled.frame.frame}`);
    assert.equal(afterSettled.status.nextWakeDelayMs, 0);
    console.log(JSON.stringify({ acceptance: "schedule-generation", beforeLate: beforeLate.frame.frame, afterLate: afterLate.frame.frame, afterSettled: afterSettled.frame.frame }));
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-revision artifact refresh honors completed generation and reloads after it changes", { timeout: 60_000 }, async () => {
  assert.ok(await Bun.file(nativeProbe).exists(), `pocket_probe is required for artifact reload acceptance: ${nativeProbe}`);
  const scratch = await mkdtemp(join(tmpdir(), "pocket-preview-artifact-generation-"));
  const fixture = join(sdkRoot, "editor/test/fixtures/counter");
  const fixtureA = join(scratch, "guest-a");
  const fixtureB = join(scratch, "guest-b");
  const outputA = join(scratch, "out-a");
  const outputB = join(scratch, "out-b");
  const stable = join(scratch, "stable");
  await cp(fixture, fixtureA, { recursive: true });
  await cp(fixture, fixtureB, { recursive: true });
  const source = await readFile(join(fixtureA, "app.tsx"), "utf8");
  await writeFile(join(fixtureA, "app.tsx"), source.replace("Independent counter fixture", "Reload guest A"));
  await writeFile(join(fixtureB, "app.tsx"), source.replace("Independent counter fixture", "Reloaded guest B with a different payload"));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const builtA = await buildGuest({ projectRoot: fixtureA, outDir: outputA, tickHz: 60 });
    const builtB = await buildGuest({ projectRoot: fixtureB, outDir: outputB, tickHz: 60 });
    await mkdir(stable, { recursive: true });
    const stableBytecode = join(stable, "app.qjbc");
    const stablePak = join(stable, "app.pak");
    await copyFile(builtA.bytecode, stableBytecode);
    await copyFile(builtA.pak, stablePak);
    let generation: string | undefined = "build-a";
    const manager = createPreviewManager({
      probePath: nativeProbe,
      width: 390,
      height: 360,
      idleDisposeMs: 1_000,
      artifacts: () => ({ bytecodePath: stableBytecode, pakPath: stablePak, revision: 1, generation, tickHz: 60 }),
    });
    const projectId = "artifact-generation";
    const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
    const snapshot = async (): Promise<Record<string, any>> => {
      const response = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
      assert.equal(response.status, 200);
      return await response.json() as Record<string, any>;
    };
    const texts = (value: Record<string, any>): string[] => value.frame.ops.filter((op: Record<string, unknown>) => op.type === "text").map((op: Record<string, unknown>) => String(op.text));
    const open = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
      const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
      assert.equal(stream.status, 200);
      const next = stream.body!.getReader();
      await next.read();
      return next;
    };
    try {
      reader = await open();
      assert.ok(texts(await snapshot()).includes("Reload guest A"));

      await copyFile(builtB.bytecode, stableBytecode);
      await copyFile(builtB.pak, stablePak);
      // The completed token remains old while files are being replaced. A
      // refresh must keep the already-running Guest A, never load half B.
      await reader.cancel();
      reader = await open();
      assert.ok(texts(await snapshot()).includes("Reload guest A"), "unchanged generation must not reload rewritten files");

      generation = "build-b";
      await reader.cancel();
      reader = await open();
      assert.ok(texts(await snapshot()).includes("Reloaded guest B with a different payload"), "new completed generation must reload the new guest");
      console.log(JSON.stringify({ acceptance: "artifact-generation-reload", sameRevision: 1, unchangedGeneration: "build-a", changedGeneration: "build-b" }));
    } finally {
      await reader?.cancel();
      await manager.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
