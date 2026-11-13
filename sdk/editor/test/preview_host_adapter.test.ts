import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager, parsePreviewHostAdapterConfig } from "../preview.ts";

test("preview host adapter accepts only exact origins and GET/POST route entries", () => {
  const parsed = parsePreviewHostAdapterConfig({
    projectId: "funhub-systemui",
    hostConfig: { apiBaseUrl: "http://127.0.0.1:8787/api/v1" },
    http: {
      allowedOrigins: ["http://127.0.0.1:8787"],
      allowedRoutes: [
        { method: "POST", path: "/api/v1/auth/otp/request" },
        { method: "GET", path: "/api/v1/invites" },
        { method: "POST", path: "/api/v1/invites" },
        { method: "POST", path: "/api/v1/invites/:uuid/accept" },
      ],
    },
  });
  assert.equal(parsed.projectId, "funhub-systemui");
  assert.deepEqual(parsed.http.allowedRoutes, [
    { method: "POST", path: "/api/v1/auth/otp/request" },
    { method: "GET", path: "/api/v1/invites" },
    { method: "POST", path: "/api/v1/invites" },
    { method: "POST", path: "/api/v1/invites/:uuid/accept" },
  ]);
  for (const origin of ["http://localhost:8787", "http://192.168.1.2:8787", "http://127.0.0.1:8787/path"]) {
    assert.throws(() => parsePreviewHostAdapterConfig({
      projectId: "funhub-systemui",
      hostConfig: {},
      http: { allowedOrigins: [origin], allowedRoutes: [] },
    }));
  }
  for (const route of [
    { method: "PUT", path: "/api/v1/auth/otp/request" },
    { method: "POST", path: "/api/v1/auth/otp/request?redirect=1" },
    { method: "POST", path: "/api/v1/../admin" },
    { method: "POST", path: "/api/v1/invites/*/accept" },
    { method: "POST", path: "/api/v1/invites/:inviteId/accept" },
    { method: "POST", path: "/api/v1/:uuid/invites/:uuid/accept" },
  ]) {
    assert.throws(() => parsePreviewHostAdapterConfig({
      projectId: "funhub-systemui",
      hostConfig: {},
      http: { allowedOrigins: ["http://127.0.0.1:8787"], allowedRoutes: [route] },
    }));
  }
});

test("SystemUI preview receives scoped host config and only its allowed HTTP request", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-trusted-preview-host-"));
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
    installation: { installedPackages: ["pocket.test.system"] },
  }));

  const requests: Array<{ path: string; body: unknown }> = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const rawBody = await request.text();
      const path = new URL(request.url).pathname;
      requests.push({ path, body: rawBody ? JSON.parse(rawBody) : undefined });
      if (path === "/api/v1/large") {
        let chunks = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunks >= 2) return new Promise<void>(() => {});
            chunks += 1;
            controller.enqueue(new Uint8Array(768 * 1024).fill(65));
          },
        }), { headers: { "content-type": "text/plain" } });
      }
      return Response.json({ challengeId: "11111111-1111-4111-8111-111111111111" });
    },
  });
  const origin = `http://127.0.0.1:${api.port}`;
  const allowedUrl = `${origin}/api/v1/auth/otp/request`;
  const inviteId = "11111111-1111-4111-8111-111111111111";
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let firstFrame = true;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = createInterface({ input: process.stdin });
const trace = [];
const record = (event) => {
  trace.push(event);
  require("node:fs").writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(trace));
};
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") { reply({ ok: true }); setTimeout(() => process.exit(0), 0); return; }
  if (command.op === "schedule") { reply({ ok: true, nextWakeDelayMs: -1 }); return; }
  if (command.op === "frame") {
    frame += 1;
    const events = firstFrame ? [
      { name: "host.request", payload: { requestId: "host-config", capability: "funhub.host.config", params: {} } },
      { name: "host.request", payload: { requestId: "otp-request", capability: "dio.request", params: {
        url: ${JSON.stringify(allowedUrl)}, method: "POST", responseType: "json",
        headers: { Accept: "application/json", "Content-Type": "application/json" }, data: { phone: "+8613800000001" }, timeoutMs: 3000,
      } } },
      { name: "host.request", payload: { requestId: "invite-list", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/invites`)}, method: "GET", responseType: "json", headers: { Accept: "application/json" },
      } } },
      { name: "host.request", payload: { requestId: "invite-create", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/invites`)}, method: "POST", responseType: "json",
        headers: { Accept: "application/json", "Content-Type": "application/json" }, data: { recipientUserId: "22222222-2222-4222-8222-222222222222" },
      } } },
      { name: "host.request", payload: { requestId: "invite-accept", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/invites/${inviteId}/accept`)}, method: "POST", responseType: "json",
        headers: { Accept: "application/json", "Content-Type": "application/json" }, data: {},
      } } },
      { name: "host.request", payload: { requestId: "blocked-invite-id", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/invites/not-a-uuid/accept`)}, method: "POST", responseType: "json",
        headers: { Accept: "application/json", "Content-Type": "application/json" }, data: {},
      } } },
      { name: "host.request", payload: { requestId: "blocked-request", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/admin`)}, method: "GET", responseType: "json", headers: {},
      } } },
      { name: "host.request", payload: { requestId: "large-response", capability: "dio.request", params: {
        url: ${JSON.stringify(`${origin}/api/v1/large`)}, method: "GET", responseType: "text", headers: {}, timeoutMs: 3000,
      } } },
    ] : [];
    firstFrame = false;
    reply({ ok: true, frame: { frame, width: 390, height: 844, ops: [], events, resources: [] } });
    return;
  }
  if (command.op === "send") {
    const message = command.message;
    if (message?.type === "event" && message.name === "host.response") record(message.payload);
    reply({ ok: true });
    return;
  }
  reply({ ok: true });
});
`, "utf8");
  await chmod(probePath, 0o755);

  const hostConfig = { apiBaseUrl: `${origin}/api/v1`, allowLoopback: true, testOtp: { code: "081942" } };
  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 3000,
    previewHostAdapter: parsePreviewHostAdapterConfig({
      projectId: "trusted-preview",
      hostConfig,
      http: {
        allowedOrigins: [origin],
        allowedRoutes: [
          { method: "POST", path: "/api/v1/auth/otp/request" },
          { method: "GET", path: "/api/v1/invites" },
          { method: "POST", path: "/api/v1/invites" },
          { method: "POST", path: "/api/v1/invites/:uuid/accept" },
          { method: "GET", path: "/api/v1/large" },
        ],
      },
    }),
    artifacts: { bytecode: bytecodePath, pak: pakPath, revision: 1, tickHz: 60 },
  });
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    const response = await manager.handle(
      new Request("http://127.0.0.1/api/projects/trusted-preview/preview/stream"),
      "trusted-preview",
      "stream",
    );
    if (response.status !== 200) throw new Error(`preview stream failed: ${await response.text()}`);
    body = response.body;
    const deadline = Date.now() + 5_000;
    let trace: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      if (existsSync(tracePath)) trace = JSON.parse(readFileSync(tracePath, "utf8")) as Array<Record<string, unknown>>;
      if (["host-config", "otp-request", "invite-list", "invite-create", "invite-accept", "blocked-invite-id", "blocked-request", "large-response"]
        .every((requestId) => trace.some((entry) => entry.requestId === requestId))) break;
      await Bun.sleep(5);
    }
    const hostConfigResponse = trace.find((entry) => entry.requestId === "host-config");
    assert.equal(hostConfigResponse?.ok, true);
    assert.deepEqual(hostConfigResponse?.result, hostConfig);
    const otpResponse = trace.find((entry) => entry.requestId === "otp-request");
    assert.equal(otpResponse?.ok, true);
    const otpResult = otpResponse?.result as { statusCode?: number; headers?: Record<string, string>; data?: unknown };
    assert.equal(otpResult?.statusCode, 200);
    assert.match(otpResult?.headers?.["content-type"] ?? "", /^application\/json(?:;|$)/);
    assert.deepEqual(otpResult?.data, { challengeId: "11111111-1111-4111-8111-111111111111" });
    const blockedResponse = trace.find((entry) => entry.requestId === "blocked-request");
    assert.equal(blockedResponse?.ok, false);
    const blockedInviteIdResponse = trace.find((entry) => entry.requestId === "blocked-invite-id");
    assert.equal(blockedInviteIdResponse?.ok, false);
    const largeResponse = trace.find((entry) => entry.requestId === "large-response");
    assert.equal(largeResponse?.ok, false);
    assert.equal((largeResponse?.error as { message?: string } | undefined)?.message, "preview HTTP response exceeds 1 MiB",
      "the response limit must stop a chunked body before the server completes it");
    const stableRequests = (items: typeof requests) => [...items].sort((left, right) =>
      `${left.path}\n${JSON.stringify(left.body)}`.localeCompare(`${right.path}\n${JSON.stringify(right.body)}`));
    assert.deepEqual(stableRequests(requests), stableRequests([
      { path: "/api/v1/auth/otp/request", body: { phone: "+8613800000001" } },
      { path: "/api/v1/invites", body: undefined },
      { path: "/api/v1/invites", body: { recipientUserId: "22222222-2222-4222-8222-222222222222" } },
      { path: `/api/v1/invites/${inviteId}/accept`, body: {} },
      { path: "/api/v1/large", body: undefined },
    ]));
  } finally {
    await body?.cancel();
    await manager.dispose();
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
