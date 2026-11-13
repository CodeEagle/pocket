import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("a missing SystemUI response sends a bounded host error without an unhandled rejection", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-system-request-failure-"));
  const project = join(root, "project");
  const probePath = join(root, "probe.mjs");
  const bytecodePath = join(root, "app.qjbc");
  const pakPath = join(root, "app.pak");
  const tracePath = join(root, "trace.json");
  mkdirSync(project);
  await writeFile(bytecodePath, new Uint8Array([0]));
  await writeFile(pakPath, new Uint8Array([0]));
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: { catalog: [] },
    installation: { installedPackages: [] },
  }));
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let firstRequest = true;
let systemRequestId = "";
let lateResponseAt = 0;
let lateResponseSent = false;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = createInterface({ input: process.stdin });
const trace = [];
const record = (event) => {
  trace.push({ atMs: Date.now(), ...event });
  require("node:fs").writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(trace));
};
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") {
    reply({ ok: true });
    setTimeout(() => process.exit(0), 0);
    return;
  }
  if (command.op === "schedule") {
    // Model a native guest with continuous work while its request is pending.
    // Preview maps native zero-demand to the configured 60Hz frame cadence;
    // a permanently repeated 1ms delay would not model the native timer API.
    reply({ ok: true, nextWakeDelayMs: systemRequestId && !lateResponseSent ? 0 : -1 });
    return;
  }
  if (command.op === "frame") {
    frame += 1;
    const events = firstRequest ? [{ name: "host.request", payload: {
      requestId: "guest-request-1",
      capability: "platform.apps.list",
      params: {},
    } }] : [];
    firstRequest = false;
    if (systemRequestId && !lateResponseSent && Date.now() >= lateResponseAt) {
      lateResponseSent = true;
      record({ type: "late-system-response", requestId: systemRequestId });
      events.push({ name: "host.request", payload: {
        requestId: "system-response-late",
        capability: "system.runtime.respond",
        params: { requestId: systemRequestId, ok: true, value: { delivered: true } },
      } });
    }
    reply({ ok: true, frame: { frame, width: 390, height: 360, ops: [], events, resources: [] } });
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (message?.type === "event" && message.name === "system.request") {
      systemRequestId = String(message.payload?.requestId ?? "");
      lateResponseAt = Date.now() + 5_500;
      record({ type: "system-request", requestId: message.payload?.requestId, capability: message.payload?.capability });
    }
    if (message?.type === "event" && message.name === "host.response") {
      const payload = message.payload ?? {};
      record({
        type: "host-response",
        requestId: payload.requestId,
        capability: payload.capability,
        ok: payload.ok === true,
        stale: payload.result?.stale === true,
        accepted: payload.result?.accepted === true,
        errorCode: payload.error?.code ?? null,
      });
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
    artifacts: { bytecode: bytecodePath, pak: pakPath, revision: 1, tickHz: 60 },
  });
  const internalManager = manager as unknown as {
    session(projectId: string): {
      pendingSystemRequests: Map<string, unknown>;
      disposed: boolean;
      state: string;
      error?: string;
      subscribers: Set<unknown>;
      rootRuntime?: { generation: number; pumping: number };
      probe?: unknown;
    };
  };
  const session = internalManager.session("system-timeout");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const response = await manager.handle(
      new Request("http://127.0.0.1/api/projects/system-timeout/preview/stream"),
      "system-timeout",
      "stream",
    );
    assert.equal(response.status, 200);
    const deadline = Date.now() + 12_000;
    let trace: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      if (existsSync(tracePath)) trace = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>[];
      if (trace.some((entry) => entry.type === "host-response" && entry.capability === "platform.apps.list") &&
          trace.some((entry) => entry.type === "host-response" && entry.capability === "system.runtime.respond")) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const request = trace.find((entry) => entry.type === "system-request" && entry.capability === "platform.apps.list");
    const hostResponse = trace.find((entry) => entry.type === "host-response" && entry.capability === "platform.apps.list");
    const lateResponse = trace.find((entry) => entry.type === "late-system-response");
    const staleAcknowledgement = trace.find((entry) => entry.type === "host-response" && entry.capability === "system.runtime.respond");
    assert.ok(request, "the platform request must reach SystemUI");
    assert.ok(hostResponse, `a bounded timeout must produce a host.response; pending=${session.pendingSystemRequests.size}; state=${session.state}; error=${session.error ?? ""}; disposed=${session.disposed}; subscribers=${session.subscribers.size}; root=${JSON.stringify(session.rootRuntime && { generation: session.rootRuntime.generation, pumping: session.rootRuntime.pumping })}; probe=${Boolean(session.probe)}; trace=${JSON.stringify(trace)}`);
    assert.equal(hostResponse.requestId, "guest-request-1");
    assert.equal(hostResponse.ok, false);
    assert.equal(hostResponse.errorCode, "system_request_timeout");
    assert.ok(lateResponse, "SystemUI may reply after the request timeout");
    assert.equal(lateResponse.requestId, request.requestId);
    assert.ok(staleAcknowledgement, "a late response must still be acknowledged to keep SystemUI's queue live");
    assert.equal(staleAcknowledgement.ok, true);
    assert.equal(staleAcknowledgement.accepted, true);
    assert.equal(staleAcknowledgement.stale, true);
    assert.equal(trace.filter((entry) => entry.type === "host-response" && entry.capability === "platform.apps.list").length, 1,
      "the late response must not fabricate a second guest result");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.deepEqual(unhandled, [], `unexpected unhandled rejection: ${String(unhandled[0])}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
