import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("a continuous native root demand yields a pending SystemUI request to the ticker", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-system-request-animation-"));
  const project = join(root, "project");
  const probePath = join(root, "probe.mjs");
  const bytecodePath = join(root, "app.qjbc");
  const pakPath = join(root, "app.pak");
  await mkdir(project);
  await writeFile(bytecodePath, new Uint8Array([0]));
  await writeFile(pakPath, new Uint8Array([0]));
  await writeFile(join(project, "manifest.json"), "{}");
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: {
      catalog: [{ package: "pocket.test.system", manifest: "manifest.json", required: true }],
      backgroundExecution: "suspend",
    },
    installation: { installedPackages: ["pocket.test.system"] },
  }));
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let firstRequest = true;
let systemRequestId = "";
let pending = false;
let responded = false;
let pendingFrames = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const currentFrame = () => {
  const active = pending && !responded;
  const y = active ? Math.min(220, pendingFrames * 20) : responded ? 220 : 0;
  const events = [];
  if (firstRequest) {
    firstRequest = false;
    events.push({ name: "host.request", payload: {
      requestId: "return-1",
      capability: "platform.apps.return",
      params: { value: { returned: true } },
    } });
  }
  if (active && pendingFrames >= 8 && systemRequestId) {
    events.push({ name: "host.request", payload: {
      requestId: "respond-1",
      capability: "system.runtime.respond",
      params: { requestId: systemRequestId, ok: true, value: { returned: true } },
    } });
  }
  return { frame, width: 390, height: 360,
    ops: [{ type: "text", text: "reverse-sheet", x: 0, y, w: 120, h: 20 }],
    events, resources: [] };
};
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") {
    reply({ ok: true });
    setImmediate(() => process.exit(0));
    return;
  }
  if (command.op === "frame") {
    frame += 1;
    if (pending && !responded) pendingFrames += 1;
    reply({ ok: true, frame: currentFrame() });
    return;
  }
  if (command.op === "schedule") {
    // The hook becomes continuous on the second native queue turn. The
    // adapter must sample demand again rather than consuming the whole exit
    // animation in the first serialized system.request call.
    reply({ ok: true, nextWakeDelayMs: pending && !responded && pendingFrames >= 2 ? 0 : -1 });
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (message?.type === "event" && message.name === "system.request") {
      systemRequestId = String(message.payload?.requestId ?? "");
      pending = true;
      pendingFrames = 0;
    }
    if (message?.type === "event" && message.name === "host.response" &&
        message.payload?.capability === "platform.apps.return") {
      responded = true;
      pending = false;
    }
    reply({ ok: true });
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
    artifacts: { bytecodePath, pakPath, revision: 1, tickHz: 60 },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const base = "http://127.0.0.1/api/projects/system-request-animation/preview";
    const stream = await manager.handle(
      new Request(`${base}/stream`),
      "system-request-animation",
      "stream",
    );
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const frames = new Map<number, number>();
    const deadline = Date.now() + 3_000;
    let stable = 0;
    let lastFrame = -1;
    while (Date.now() < deadline) {
      const response = await manager.handle(
        new Request(`${base}/snapshot`),
        "system-request-animation",
        "snapshot",
      );
      assert.equal(response.status, 200);
      const snapshot = await response.json() as Record<string, any>;
      const current = snapshot.frame as Record<string, any>;
      const op = (current.ops as Record<string, any>[]).find((value) => value.type === "text" && value.text === "reverse-sheet");
      assert.ok(op, "the fake native root must publish its animation marker");
      frames.set(Number(current.frame), Number(op.y));
      if (Number(current.frame) === lastFrame) stable += 1;
      else {
        stable = 0;
        lastFrame = Number(current.frame);
      }
      if (snapshot.status.nextWakeDelayMs === -1 && Number(op.y) === 220 && stable >= 2) break;
      await Bun.sleep(12);
    }
    const intermediate = [...frames.values()].filter((y) => y > 0 && y < 220);
    assert.ok(intermediate.length >= 3,
      `continuous root demand must publish intermediate frames, got y=${[...frames.values()].join(",")}`);
    assert.ok(new Set(intermediate).size >= 3,
      `intermediate animation positions must be distinct, got y=${intermediate.join(",")}`);
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
