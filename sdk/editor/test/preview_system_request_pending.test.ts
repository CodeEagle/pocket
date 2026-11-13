import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("a delayed SystemUI response resolves the matching platform request after the inline pump budget", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-system-request-pending-"));
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
const pendingResponses = new Map();
const trace = [];
const record = (event) => {
  trace.push(event);
  require("node:fs").writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(trace));
};
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") {
    reply({ ok: true });
    setTimeout(() => process.exit(0), 0);
    return;
  }
  if (command.op === "schedule") {
    reply({ ok: true, nextWakeDelayMs: [...pendingResponses.values()].some((pending) => !pending.sent) ? 1 : -1 });
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (message?.type === "event" && message.name === "system.request") {
      const requestId = String(message.payload?.requestId ?? "");
      const capability = String(message.payload?.capability ?? "");
      const respondAt = Date.now() + (capability === "platform.messages.send" ? 90 : 145);
      pendingResponses.set(requestId, { capability, respondAt, sent: false, startedAt: Date.now(), framesWhilePending: 0 });
      record({ type: "system-request", requestId, capability });
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
        result: payload.result ?? null,
        errorCode: payload.error?.code ?? null,
      });
    }
    reply({ ok: true });
    return;
  }
  if (command.op === "frame") {
    frame += 1;
    const events = [];
    if (firstRequest) {
      firstRequest = false;
      events.push({ name: "host.request", payload: {
        requestId: "guest-message-1",
        capability: "platform.messages.send",
        params: { appId: "pocket.test.system", data: { ping: true }, topic: "test" },
      } }, {
        name: "host.request", payload: {
          requestId: "guest-message-2",
          capability: "platform.messages.receive",
          params: {},
        },
      });
    }
    for (const [requestId, pending] of [...pendingResponses]) {
      if (pending.sent) continue;
      pending.framesWhilePending += 1;
      if (Date.now() >= pending.respondAt) {
        pendingResponses.delete(requestId);
        record({ type: "system-response", requestId, capability: pending.capability, delayMs: Date.now() - pending.startedAt, framesWhilePending: pending.framesWhilePending });
        events.push({ name: "host.request", payload: {
          requestId: "system-response-" + (pending.capability === "platform.messages.send" ? "1" : "2"),
          capability: "system.runtime.respond",
          params: { requestId, ok: true, value: { delivered: pending.capability } },
        } });
      }
    }
    reply({ ok: true, frame: { frame, width: 390, height: 360, ops: [], events, resources: [] } });
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
    session(projectId: string): { pendingSystemRequests: Map<string, unknown> };
  };
  const session = internalManager.session("system-request-pending");
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    const response = await manager.handle(
      new Request("http://127.0.0.1/api/projects/system-request-pending/preview/stream"),
      "system-request-pending",
      "stream",
    );
    assert.equal(response.status, 200);
    body = response.body;
    const deadline = Date.now() + 2_000;
    let trace: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      if (existsSync(tracePath)) trace = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>[];
      const originResponses = trace.filter((entry) => entry.type === "host-response" && entry.capability.startsWith("platform.messages."));
      const controlResponses = trace.filter((entry) => entry.type === "host-response" && entry.capability === "system.runtime.respond");
      if (originResponses.length === 2 && controlResponses.length === 2 && session.pendingSystemRequests.size === 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    const systemRequests = trace.filter((entry) => entry.type === "system-request");
    const systemResponses = trace.filter((entry) => entry.type === "system-response");
    const originResponses = trace.filter((entry) => entry.type === "host-response" && entry.capability.startsWith("platform.messages."));
    const controlResponses = trace.filter((entry) => entry.type === "host-response" && entry.capability === "system.runtime.respond");
    assert.equal(systemRequests.length, 2, "both independent platform requests must reach SystemUI");
    assert.equal(systemResponses.length, 2, "both delayed SystemUI responses must be emitted");
    for (const response of systemResponses) {
      assert.ok(Number(response.delayMs) >= 80, "fixture responses must arrive after their real delay");
      assert.ok(systemRequests.some((request) => request.requestId === response.requestId), "SystemUI response must retain its internal correlation ID");
    }
    assert.equal(originResponses.length, 2, "both original guest requests must receive host.response");
    const sendResponse = originResponses.find((entry) => entry.requestId === "guest-message-1");
    const receiveResponse = originResponses.find((entry) => entry.requestId === "guest-message-2");
    assert.ok(sendResponse);
    assert.equal(sendResponse.capability, "platform.messages.send");
    assert.equal(sendResponse.ok, true);
    assert.deepEqual(sendResponse.result, { delivered: "platform.messages.send" });
    assert.ok(receiveResponse);
    assert.equal(receiveResponse.capability, "platform.messages.receive");
    assert.equal(receiveResponse.ok, true);
    assert.deepEqual(receiveResponse.result, { delivered: "platform.messages.receive" });
    assert.equal(controlResponses.length, 2, "each control response must be acknowledged");
    for (const controlResponse of controlResponses) {
      assert.equal(controlResponse.ok, true);
      assert.equal(controlResponse.accepted, true);
      assert.equal(controlResponse.stale, false);
    }
    assert.equal(session.pendingSystemRequests.size, 0, "completed requests must leave no pending entry");
  } finally {
    await body?.cancel();
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child request yields its operation turn and accepts the delayed response before timeout", { timeout: 60_000 }, async () => {
  const manager = createPreviewManager({ commandTimeoutMs: 2_000 });
  const internalManager = manager as unknown as {
    session(projectId: string): Record<string, any>;
  };
  const session = internalManager.session("system-request-child");
  const childResponses: Record<string, unknown>[] = [];
  const rootResponses: Record<string, unknown>[] = [];
  let systemRequestId = "";
  let responseAt = 0;
  let responseEmitted = false;
  let rootFrame = 0;
  let childFrame = 0;
  const rootProbe = {
    async checked(command: Record<string, any>) {
      if (command.op === "send") {
        const message = command.message;
        if (message?.name === "system.request") {
          systemRequestId = String(message.payload?.requestId ?? "");
          responseAt = Date.now() + 120;
        } else if (message?.name === "host.response") {
          rootResponses.push(message.payload);
        }
        return { ok: true };
      }
      if (command.op === "schedule") return { ok: true, nextWakeDelayMs: 1 };
      if (command.op === "frame") {
        rootFrame += 1;
        const events = !responseEmitted && systemRequestId && Date.now() >= responseAt
          ? [{ name: "host.request", payload: {
            requestId: "system-response-1",
            capability: "system.runtime.respond",
            params: { requestId: systemRequestId, ok: true, value: { delivered: true } },
          } }]
          : [];
        if (events.length > 0) responseEmitted = true;
        return { ok: true, frame: { frame: rootFrame, width: 390, height: 360, ops: [], events, resources: [] } };
      }
      return { ok: true };
    },
    async stop() {},
  };
  const childProbe = {
    async checked(command: Record<string, any>) {
      if (command.op === "send" && command.message?.name === "host.response") {
        childResponses.push(command.message.payload);
      }
      if (command.op === "frame") {
        childFrame += 1;
        return { ok: true, frame: { frame: childFrame, width: 390, height: 360, ops: [], events: [], resources: [] } };
      }
      return { ok: true };
    },
    async stop() {},
  };
  const baseRuntime = (appId: string, instanceId: string, probe: typeof rootProbe) => ({
    appId,
    instanceId,
    generation: 1,
    probe,
    artifacts: {},
    viewportWidth: 390,
    viewportHeight: 360,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    resources: new Map(),
    initialEvents: [],
    pendingBrowserEvents: [],
    needsPump: false,
    pumping: 0,
  });
  const rootRuntime = baseRuntime("pocket.test.system", "system-ui", rootProbe);
  const childRuntime = baseRuntime("love.funhub.pocket.auth", "auth-instance", childProbe);
  session.rootRuntime = rootRuntime;
  session.probe = rootProbe;
  session.tickHz = 60;
  session.childRuntimes.set(childRuntime.appId, childRuntime);
  try {
    await session.dispatchSystemRequest(childRuntime, "guest-auth-1", "platform.messages.send", {}, 0);
    assert.equal(session.pendingSystemRequests.size, 1, "the request must remain pending after inline pumps yield");
    const pending = [...session.pendingSystemRequests.values()][0];
    assert.ok(pending.timer, "the outstanding request must have a wall-clock bound");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 130));
    await session.pumpRuntime(rootRuntime, 0);

    const originalResponse = childResponses.find((response) => response.capability === "platform.messages.send");
    const controlResponse = rootResponses.find((response) => response.capability === "system.runtime.respond");
    assert.ok(originalResponse, "the child request must receive its own host.response");
    assert.equal(originalResponse.requestId, "guest-auth-1");
    assert.equal(originalResponse.ok, true);
    assert.deepEqual(originalResponse.result, { delivered: true });
    assert.ok(controlResponse, "SystemUI's control request must be acknowledged");
    assert.deepEqual(controlResponse.result, { accepted: true });
    assert.equal(session.pendingSystemRequests.size, 0);
    assert.equal(pending.timer, undefined, "normal completion must clear the timeout");
  } finally {
    await manager.dispose();
  }
});
