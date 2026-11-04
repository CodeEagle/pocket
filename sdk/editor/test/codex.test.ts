import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createStudioCodex, validateStudioInput } from "../codex.ts";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const flush = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type FixtureOptions = {
  cancelFallbackMs?: number;
  interruptError?: boolean;
  holdChanged?: boolean;
  holdAccount?: boolean;
  models?: any[];
  resolveContext?: (projectId: string, scope: "project" | "sdk") => { scope: "project" | "sdk"; cwd: string; writableRoots: string[]; developerInstructions: string };
};

function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  let receive: (notification: any) => void = () => {};
  let exited: () => void = () => {};
  let notificationActive = true;
  let exitActive = true;
  let stopped = false;
  let stopHook: (() => void) | undefined;
  let releaseChanged: (() => void) | undefined;
  let releaseAccount: (() => void) | undefined;
  const client = {
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "account/read") {
        if (options.holdAccount) await new Promise<void>((resolve) => { releaseAccount = resolve; });
        return { account: { type: "chatgpt", email: "never expose this", accessToken: "never expose this" }, requiresOpenaiAuth: true };
      }
      if (method === "model/list") return { data: options.models ?? [{ id: "pick", model: "actual-model", displayName: "Available model", inputModalities: ["text", "image"], isDefault: true }] };
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: "turn-remote" } };
      if (method === "turn/interrupt" && options.interruptError) throw new Error("interrupt unavailable");
      if (method === "turn/interrupt") return {};
      throw new Error(`unexpected method ${method}`);
    },
    onNotification(callback: typeof receive) { receive = callback; return () => { notificationActive = false; }; },
    onExit(callback: typeof exited) { exited = callback; return () => { exitActive = false; }; },
    handleRequests(_callback: any) {},
    stop() { stopped = true; stopHook?.(); if (exitActive) exited(); },
  };
  const changed: string[] = [];
  const adapter = createStudioCodex({
    client,
    projectDirectory: () => "/tmp/studio-project",
    resolveContext: options.resolveContext,
    cancelFallbackMs: options.cancelFallbackMs,
    onChanged: async (id) => {
      changed.push(id);
      if (options.holdChanged) await new Promise<void>((resolve) => { releaseChanged = resolve; });
    },
  });
  return {
    adapter,
    calls,
    waitForCall: async (method: string, timeoutMs = 1_000) => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const call = calls.find((entry) => entry.method === method);
        if (call) return call;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for RPC ${method}`);
        await Bun.sleep(1);
      }
    },
    waitFor: async (predicate: () => boolean, label: string, timeoutMs = 1_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(1);
      }
    },
    changed,
    emit: (method: string, params: any) => { if (notificationActive) receive({ method, params }); },
    stopped: () => stopped,
    setStopHook: (hook: () => void) => { stopHook = hook; },
    releaseChanged: () => { releaseChanged?.(); releaseChanged = undefined; },
    releaseAccount: () => { releaseAccount?.(); releaseAccount = undefined; },
  };
}

test("Studio auth/model responses contain metadata and never credential fields", async () => {
  const { adapter } = fixture();
  try {
    expect(await adapter.status()).toEqual({ available: true, authenticated: true, authMode: "chatgpt", requiresOpenaiAuth: true });
    expect((await adapter.models()).models[0].id).toBe("actual-model");
    expect(JSON.stringify(await adapter.status())).not.toContain("never expose");
  } finally { await adapter.dispose(); }
});

test("real transport contract streams a turn, scopes cwd, validates image/annotation and cleans completion", async () => {
  const f = fixture();
  try {
    const turn = await f.adapter.start("project-a", { text: "Adjust selected region", model: "actual-model", images: [{ dataUrl: png }], annotation: { rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } } });
    const start = await f.waitForCall("turn/start");
    expect(start.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: ["/tmp/studio-project"], networkAccess: false });
    expect(start.params.input[1].type).toBe("localImage");
    expect(start.params.input[1].path).not.toContain("auth");
    expect(await Bun.file(start.params.input[1].path).exists()).toBe(true);
    expect(start.params.input[0].text).toContain('"width":1');
    f.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-remote", itemId: "m", delta: "Hello" });
    f.emit("item/completed", { threadId: "thread-1", turnId: "turn-remote", item: { id: "m", type: "agentMessage", text: "Hello world" } });
    expect(f.adapter.get("project-a", turn.id).text).toBe("Hello world");
    expect(() => f.adapter.get("project-b", turn.id)).toThrow("not found");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await f.waitFor(() => f.adapter.get("project-a", turn.id).status === "completed", "turn completion");
    await f.waitFor(() => !existsSync(start.params.input[1].path), "attachment cleanup");
    expect(await Bun.file(start.params.input[1].path).exists()).toBe(false);
    expect(f.changed).toEqual(["project-a"]);
  } finally { await f.adapter.dispose(); }
});

test("SDK scope binds the fixed context, serializes all projects, and passes the advertised effort", async () => {
  const f = fixture({
    models: [{
      id: "pick", model: "actual-model", displayName: "Available model", inputModalities: ["text"], isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Quick" },
        { reasoningEffort: "high", description: "Deep" },
      ],
      defaultReasoningEffort: "low",
    }],
    resolveContext: (projectId, scope) => scope === "sdk"
      ? { scope, cwd: "/tmp/pocket-sdk", writableRoots: [`/tmp/${projectId}`, "/tmp/pocket-sdk"], developerInstructions: "SDK roots /tmp/pocket-sdk and selected project" }
      : { scope, cwd: `/tmp/${projectId}`, writableRoots: [`/tmp/${projectId}`], developerInstructions: "project root" },
  });
  try {
    const turn = await f.adapter.start("project-a", { text: "update SDK", scope: "sdk", effort: "high" });
    expect(turn.scope).toBe("sdk");
    const thread = await f.waitForCall("thread/start");
    expect(thread.params.cwd).toBe("/tmp/pocket-sdk");
    expect(thread.params.developerInstructions).toContain("/tmp/pocket-sdk");
    const start = await f.waitForCall("turn/start");
    expect(start.params.cwd).toBe("/tmp/pocket-sdk");
    expect(start.params.sandboxPolicy.writableRoots).toEqual(["/tmp/project-a", "/tmp/pocket-sdk"]);
    expect(start.params.effort).toBe("high");
    expect(f.adapter.isBusy("project-b")).toBe(true);
    await expect(f.adapter.start("project-b", { text: "blocked while SDK writes" })).rejects.toThrow("already running");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await f.waitFor(() => f.adapter.get("project-a", turn.id).status === "completed", "SDK turn completion");
    expect(f.adapter.isBusy("project-b")).toBe(false);
  } finally { await f.adapter.dispose(); }
});

test("SDK scope also waits for a project turn that is still starting", async () => {
  const f = fixture({
    holdAccount: true,
    resolveContext: (projectId, scope) => scope === "sdk"
      ? { scope, cwd: "/tmp/pocket-sdk", writableRoots: [`/tmp/${projectId}`, "/tmp/pocket-sdk"], developerInstructions: "SDK roots" }
      : { scope, cwd: `/tmp/${projectId}`, writableRoots: [`/tmp/${projectId}`], developerInstructions: "project root" },
  });
  try {
    const projectStart = f.adapter.start("project-a", { text: "project starts" });
    await f.waitForCall("account/read");
    await expect(f.adapter.start("project-b", { text: "SDK must wait", scope: "sdk" })).rejects.toThrow("already running");
    f.releaseAccount();
    await f.waitForCall("turn/start");
    const turn = [...f.calls].length ? f.calls.find((call) => call.method === "turn/start") : undefined;
    expect(turn).toBeDefined();
    const result = await projectStart;
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await f.waitFor(() => f.adapter.get("project-a", result.id).status === "completed", "project turn completion");
  } finally { await f.adapter.dispose(); }
});

test("scope-bound threads reject reuse across project and SDK scopes", async () => {
  const f = fixture({
    resolveContext: (projectId, scope) => scope === "sdk"
      ? { scope, cwd: "/tmp/pocket-sdk", writableRoots: [`/tmp/${projectId}`, "/tmp/pocket-sdk"], developerInstructions: "SDK roots" }
      : { scope, cwd: `/tmp/${projectId}`, writableRoots: [`/tmp/${projectId}`], developerInstructions: "project root" },
  });
  try {
    const turn = await f.adapter.start("project-a", { text: "project change" });
    await f.waitForCall("turn/start");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await f.waitFor(() => f.adapter.get("project-a", turn.id).status === "completed", "project turn completion");
    await expect(f.adapter.start("project-a", { text: "wrong scope", scope: "sdk", threadId: "thread-1" })).rejects.toThrow("project and scope");
  } finally { await f.adapter.dispose(); }
});

test("reasoning effort is validated against model/list and omitted for compatible defaults", async () => {
  const models = [{
    id: "pick", model: "actual-model", displayName: "Available model", inputModalities: ["text"], isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }], defaultReasoningEffort: "low",
  }];
  const rejected = fixture({ models });
  try {
    await expect(rejected.adapter.start("project-a", { text: "unsupported", effort: "high" })).rejects.toThrow("not supported");
    expect(rejected.calls.some((call) => call.method === "turn/start")).toBe(false);
  } finally { await rejected.adapter.dispose(); }
  const omitted = fixture({ models });
  try {
    const turn = await omitted.adapter.start("project-a", { text: "use model default" });
    const start = await omitted.waitForCall("turn/start");
    expect(Object.hasOwn(start.params, "effort")).toBe(false);
    omitted.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await omitted.waitFor(() => omitted.adapter.get("project-a", turn.id).status === "completed", "default-effort turn completion");
  } finally { await omitted.adapter.dispose(); }
});

test("conversation ownership, active quota and cancelled completion are enforced", async () => {
  const f = fixture();
  try {
    const turn = await f.adapter.start("project-a", { text: "hello" });
    await f.waitForCall("turn/start");
    await expect(f.adapter.start("project-a", { text: "duplicate" })).rejects.toThrow("already running");
    await expect(f.adapter.start("project-b", { text: "wrong project", threadId: "thread-1" })).rejects.toThrow("does not belong");
    const cancellation = f.adapter.cancel("project-a", turn.id);
    await f.waitForCall("turn/start");
    expect(f.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "turn-remote")).toBe(true);
    expect(f.adapter.get("project-a", turn.id).status).toBe("running");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "interrupted" } });
    await cancellation;
    expect(f.adapter.get("project-a", turn.id).status).toBe("cancelled");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    expect(f.adapter.get("project-a", turn.id).status).toBe("cancelled");
  } finally { await f.adapter.dispose(); }
});

test("cancel stops the owned transport after a bounded missing-completion fallback", async () => {
  for (const interruptError of [false, true]) {
    const f = fixture({ cancelFallbackMs: 20, interruptError });
    try {
      const turn = await f.adapter.start("project-a", { text: "slow" });
      await flush();
      const cancellation = f.adapter.cancel("project-a", turn.id);
      await cancellation;
      expect(f.stopped()).toBe(true);
      expect(f.adapter.get("project-a", turn.id).status).toBe("failed");
      expect(f.adapter.get("project-a", turn.id).error).toContain("stopped before cancellation");
      expect(f.adapter.isBusy("project-a")).toBe(false);
    } finally { await f.adapter.dispose(); }
  }
});

test("terminal status and project unlock wait for onChanged persistence", async () => {
  const f = fixture({ holdChanged: true });
  try {
    const turn = await f.adapter.start("project-a", { text: "hello" });
    await f.waitForCall("turn/start");
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    f.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-remote", status: "completed" } });
    await f.waitForCall("turn/start");
    expect(f.adapter.get("project-a", turn.id).status).toBe("running");
    expect(f.adapter.isBusy("project-a")).toBe(true);
    expect(f.changed).toEqual(["project-a"]);
    f.releaseChanged();
    await flush();
    expect(f.adapter.get("project-a", turn.id).status).toBe("completed");
    expect(f.adapter.isBusy("project-a")).toBe(false);
    expect(f.changed).toEqual(["project-a"]);
  } finally { await f.adapter.dispose(); }
});

test("dispose stops the transport before removing local image attachments", async () => {
  const f = fixture();
  try {
    const turn = await f.adapter.start("project-a", { text: "inspect", images: [{ dataUrl: png }] });
    const start = await f.waitForCall("turn/start");
    const imagePath = start.params.input[1].path as string;
    let imageExistedAtStop = false;
    f.setStopHook(() => { imageExistedAtStop = existsSync(imagePath); });
    await f.adapter.dispose();
    expect(imageExistedAtStop).toBe(true);
    expect(existsSync(imagePath)).toBe(false);
    expect(f.adapter.get("project-a", turn.id).status).toBe("cancelled");
    await f.adapter.dispose();
  } finally { await f.adapter.dispose(); }
});

test("image and region inputs reject wrong MIME, overflow and malformed bounds", () => {
  expect(() => validateStudioInput({ text: "x", images: [{ dataUrl: "data:image/png;base64,YWJjZA==" }] })).toThrow("MIME");
  expect(() => validateStudioInput({ images: Array(5).fill({ dataUrl: png }) })).toThrow("four");
  expect(() => validateStudioInput({ text: "x", annotation: { rect: { x: -1, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } } })).toThrow("rectangle");
  expect(() => validateStudioInput({ text: "x", annotation: { rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } } })).toThrow("screenshot");
  expect(() => validateStudioInput({ text: "x".repeat(32769) })).toThrow("32 KiB");
  expect(() => validateStudioInput({ text: "你".repeat(10923) })).toThrow("32 KiB");
});
