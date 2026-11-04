import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type RecordValue = Record<string, any>;
const buffers = new WeakMap<object, string>();

async function readPacket(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1_000): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  let text = buffers.get(reader) ?? "";
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: true }), 100)),
    ]);
    if (result.done) continue;
    text += new TextDecoder().decode(result.value);
    const match = text.match(/data: (\{.*?\})\n\n/s);
    if (match) {
      buffers.set(reader, text.slice(match.index! + match[0].length));
      return JSON.parse(match[1]);
    }
  }
  throw new Error(`timed out waiting for SSE packet: ${text}`);
}

test("web Bluetooth transport is opt-in, owner scoped, and forwards host responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-web-bluetooth-"));
  const probePath = join(root, "probe.mjs");
  const bytecodePath = join(root, "app.qjbc");
  const pakPath = join(root, "app.pak");
  await Bun.write(bytecodePath, new Uint8Array([0]));
  await Bun.write(pakPath, new Uint8Array([0]));
  await Bun.write(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let requestPending = true;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") { reply({ ok: true }); setTimeout(() => process.exit(0), 0); return; }
  if (command.op === "schedule") { reply({ ok: true, nextWakeDelayMs: -1 }); return; }
  if (command.op === "resize") { requestPending = true; reply({ ok: true }); return; }
  if (command.op === "send") { if (command.message?.name === "host.response") requestPending = false; reply({ ok: true }); return; }
  if (command.op === "frame") {
    const events = requestPending ? [{ name: "host.request", payload: { requestId: "ble-request", capability: "hardware.bluetooth.scan", params: { services: ["battery_service"] } } }] : [];
    reply({ ok: true, frame: { frame: ++frame, width: 390, height: 360, ops: [], events, resources: [] } });
    return;
  }
  reply({ ok: true });
});
`);
  await chmod(probePath, 0o755);
  const manager = createPreviewManager({ probePath, artifacts: { bytecodePath, pakPath, revision: 1, tickHz: 60 } });
  const projectId = "web-bluetooth-transport";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const page = await manager.handle(new Request(base), projectId, "page");
    assert.equal(page.headers.get("permissions-policy"), "bluetooth=(self)");
    assert.match(await page.text(), /PocketWebBluetooth/);

    const stream = await manager.handle(new Request(`${base}/stream?presentation=browser&webBluetooth=1&clientId=tab-a`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    const first = await readPacket(reader);
    assert.equal(first.type, "status");
    let second = await readPacket(reader);
    while (second.type !== "plugin.request") second = await readPacket(reader);
    assert.equal(second.type, "plugin.request");
    assert.equal(second.plugin, "web-bluetooth");
    assert.equal(second.kind, "request");
    assert.equal(second.clientId, "tab-a");
    assert.equal(typeof second.token, "string");
    assert.match(String(second.scope), /:/);

    const malformed = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "plugin-message", clientId: "tab-a", token: second.token, message: null }),
    }), projectId, "input");
    assert.equal(malformed.status, 400);
    assert.equal((await manager.status(projectId)).state, "ready");

    const response = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({
        type: "plugin-message",
        clientId: "tab-a",
        token: second.token,
        message: { type: "event", name: "host.response", payload: {
          requestId: second.requestId,
          capability: second.capability,
          ok: true,
          result: { ok: true, realBle: true, source: "web-bluetooth", devices: [] },
        } },
      }),
    }), projectId, "input");
    assert.equal(response.status, 200);

    const resize = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "resize", width: 390, height: 360 }),
    }), projectId, "input");
    assert.equal(resize.status, 200);
    let pendingAfterResize = await readPacket(reader);
    while (pendingAfterResize.type !== "plugin.request") pendingAfterResize = await readPacket(reader);
    assert.equal(pendingAfterResize.requestId, "ble-request");

    const disable = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "plugin-disable", clientId: "tab-a" }),
    }), projectId, "input");
    assert.equal(disable.status, 200);
    const late = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({
        type: "plugin-message",
        clientId: "tab-a",
        token: pendingAfterResize.token,
        message: { type: "event", name: "host.response", payload: {
          requestId: pendingAfterResize.requestId,
          capability: pendingAfterResize.capability,
          ok: true,
          result: { late: true },
        } },
      }),
    }), projectId, "input");
    assert.equal(late.status, 200);
    assert.equal((await manager.status(projectId)).state, "ready");

    const secondOwner = await manager.handle(new Request(`${base}/stream?presentation=browser&webBluetooth=1&clientId=tab-b`), projectId, "stream");
    assert.equal(secondOwner.status, 200);
    await secondOwner.body?.cancel();
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
