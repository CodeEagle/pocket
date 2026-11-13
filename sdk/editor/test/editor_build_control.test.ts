import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

// Real service. The first server uses a slow injected runner to make timing
// deterministic; the second uses the real buildGuest compiler pipeline.
let slowWorkspace = "";
let realWorkspace = "";
let slow: Awaited<ReturnType<typeof startEditor>>;
let real: Awaited<ReturnType<typeof startEditor>>;
let slowRunnerAborted = false;
let slowMode: "hang" | "fail" | "ok" = "hang";

type Ctx = { base: string; csrf: string; workspace: string };
const ctx = (server: typeof slow, workspace: string, csrf: string): Ctx => ({ base: `http://127.0.0.1:${server.port}`, csrf, workspace });
let slowCtx: Ctx;
let realCtx: Ctx;

async function api(c: Ctx, path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  const method = init.method ?? "GET";
  if (method !== "GET") headers["x-pocket-csrf"] = c.csrf;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${c.base}/api/projects/${path}`, { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  return { status: response.status, body: await response.json() };
}

async function createProject(c: Ctx, id: string): Promise<void> {
  const response = await fetch(`${c.base}/api/projects`, { method: "POST", headers: { "x-pocket-csrf": c.csrf, "content-type": "application/json" }, body: JSON.stringify({ id, name: "Build Control", version: "0.1.0", tickHz: 60 }) });
  expect(response.status).toBe(201);
}

async function waitIdle(c: Ctx, id: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await api(c, `${id}/status`)).body;
    if (!status.busy) return status;
    if (Date.now() > deadline) throw new Error("build did not finish");
    await Bun.sleep(50);
  }
}

function events(c: Ctx, path: string, abort: AbortController) {
  const ready = fetch(`${c.base}/api/projects/${path}`, { signal: abort.signal }).then((response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    return response.body!.getReader();
  });
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: any[] = [];
  return {
    async until(predicate: (event: any) => boolean, timeoutMs = 120_000): Promise<any[]> {
      const reader = await ready;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = seen.findIndex(predicate);
        if (index >= 0) return seen.splice(0, index + 1);
        if (Date.now() > deadline) throw new Error(`timed out; pending ${JSON.stringify(seen).slice(0, 500)}`);
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }))]);
        if (chunk.done) throw new Error("stream ended or timed out");
        buffer += decoder.decode(chunk.value);
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)));
        }
      }
    },
  };
}

async function writeSource(c: Ctx, id: string, content: string): Promise<void> {
  const result = await api(c, `${id}/files/app.tsx`, { method: "PUT", json: { content } });
  expect(result.status).toBe(200);
}

beforeAll(async () => {
  slowWorkspace = mkdtempSync(join(tmpdir(), "pocket-build-slow-"));
  realWorkspace = mkdtempSync(join(tmpdir(), "pocket-build-real-"));
  slow = await startEditor({
    port: 0,
    workspace: slowWorkspace,
    buildRunner: async ({ log, signal }) => {
      log("slow runner: started");
      if (slowMode === "fail") {
        log("error: Could not resolve: \"./gone\"");
        log(`    at ${join(slowWorkspace, "projects/slow-app/app.tsx")}:3:9`);
        log("error: outside the project");
        log("    at /etc/passwd:1:1");
        throw new Error("slow runner failed");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => slowMode === "hang" ? reject(new Error("slow runner was never cancelled")) : resolve(), 30_000);
        signal?.addEventListener("abort", () => { slowRunnerAborted = true; clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      throw new Error("unreachable in this test");
    },
  });
  real = await startEditor({ port: 0, workspace: realWorkspace });
  slowCtx = ctx(slow, slowWorkspace, (await (await fetch(`http://127.0.0.1:${slow.port}/health`)).json()).csrfToken);
  realCtx = ctx(real, realWorkspace, (await (await fetch(`http://127.0.0.1:${real.port}/health`)).json()).csrfToken);
  await createProject(slowCtx, "slow-app");
  await createProject(realCtx, "real-app");
});

afterAll(async () => {
  await slow.stop(true);
  await real.stop(true);
  rmSync(slowWorkspace, { recursive: true, force: true });
  rmSync(realWorkspace, { recursive: true, force: true });
});

test("cancel with no active build is a 409", async () => {
  const result = await api(slowCtx, "slow-app/build/cancel", { method: "POST", json: {} });
  expect(result.status).toBe(409);
});

test("cancelling a running build aborts the runner and leaves a clear final state", async () => {
  const abort = new AbortController();
  const stream = events(slowCtx, "slow-app/build/events", abort);
  const initial = (await stream.until((event) => event.type === "status"))[0];
  expect(initial.status.busy).toBe(false);
  const before = (await api(slowCtx, "slow-app/status")).body;
  expect((await api(slowCtx, "slow-app/build", { method: "POST", json: {} })).status).toBe(202);
  await stream.until((event) => event.type === "log" && event.line === "slow runner: started");
  expect((await api(slowCtx, "slow-app/status")).body.busy).toBe(true);
  const cancelled = await api(slowCtx, "slow-app/build/cancel", { method: "POST", json: {} });
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.cancelled).toBe(true);
  expect(cancelled.body.status).toMatchObject({ busy: false, error: "build cancelled", builtRevision: before.builtRevision });
  expect(slowRunnerAborted).toBe(true);
  const final = (await api(slowCtx, "slow-app/status")).body;
  expect(final).toMatchObject({ busy: false, error: "build cancelled", builtRevision: null, diagnostics: [] });
  expect(final.logs).toContain("build cancelled");
  // Events: a log line, a final non-busy status, then done with ok:false.
  const tail = await stream.until((event) => event.type === "done");
  expect(tail.some((event) => event.type === "log" && event.line === "build cancelled")).toBe(true);
  expect(tail.some((event) => event.type === "status" && event.status.busy === false && event.status.error === "build cancelled")).toBe(true);
  expect(tail.at(-1)).toMatchObject({ type: "done", ok: false, builtRevision: null, diagnostics: [] });
  // A second cancel has nothing to cancel; a later source edit clears the cancelled state.
  expect((await api(slowCtx, "slow-app/build/cancel", { method: "POST", json: {} })).status).toBe(409);
  await api(slowCtx, "slow-app/files/app.tsx", { method: "PUT", json: { content: "export default 1;\n" } });
  expect((await api(slowCtx, "slow-app/status")).body.error).toBeUndefined();
  abort.abort();
});

test("build events report failure diagnostics and drop paths outside the project", async () => {
  slowMode = "fail";
  const abort = new AbortController();
  const stream = events(slowCtx, "slow-app/build/events", abort);
  await stream.until((event) => event.type === "status");
  await api(slowCtx, "slow-app/build", { method: "POST", json: {} });
  const seen = await stream.until((event) => event.type === "done");
  const done = seen.at(-1);
  expect(done).toMatchObject({ type: "done", ok: false, builtRevision: null });
  expect(done.diagnostics).toEqual([{ file: "app.tsx", line: 3, column: 9, severity: "error", message: 'Could not resolve: "./gone"' }]);
  expect(seen.filter((event) => event.type === "log").map((event) => event.line)).toContain("slow runner: started");
  const status = (await api(slowCtx, "slow-app/status")).body;
  expect(status.error).toBe("slow runner failed");
  expect(status.diagnostics).toEqual(done.diagnostics);
  expect(JSON.stringify(status.diagnostics)).not.toContain(slowWorkspace);
  // The diagnostics field is only present while the failure is current.
  await api(slowCtx, "slow-app/files/app.tsx", { method: "PUT", json: { content: "export default 2;\n" } });
  expect((await api(slowCtx, "slow-app/status")).body.diagnostics).toBeUndefined();
  abort.abort();
  slowMode = "hang";
});

test("build events stream is bounded by disconnect cleanup and needs no credential for reads only", async () => {
  const abort = new AbortController();
  const stream = events(slowCtx, "slow-app/build/events", abort);
  await stream.until((event) => event.type === "status");
  abort.abort();
  // The project stays fully usable after a client disconnects mid-stream.
  expect((await api(slowCtx, "slow-app/status")).status).toBe(200);
});

test("real build: a syntax error yields structured diagnostics with a project-relative file and line", async () => {
  await writeSource(realCtx, "real-app", "export default function App() {\n  return <view>\n}\nconst = ;\n");
  expect((await api(realCtx, "real-app/build", { method: "POST", json: {} })).status).toBe(202);
  const status = await waitIdle(realCtx, "real-app");
  expect(status.error).toBeDefined();
  expect(status.builtRevision).toBeNull();
  expect(status.diagnostics.length).toBeGreaterThanOrEqual(1);
  const first = status.diagnostics[0];
  expect(first).toMatchObject({ file: "app.tsx", line: 2, severity: "error" });
  expect(first.message).toContain("Unterminated JSX contents");
  expect(first.column).toBeGreaterThanOrEqual(1);
  for (const diagnostic of status.diagnostics) {
    expect(diagnostic.file.startsWith("/")).toBe(false);
    expect(diagnostic.file).not.toContain(realWorkspace);
    expect(diagnostic.message).not.toContain(realWorkspace);
  }
  // Logs stay as plain strings.
  expect(status.logs.every((line: string) => typeof line === "string")).toBe(true);
}, 120_000);

test("real build: an unresolved import reports bun's file/line/column", async () => {
  await writeSource(realCtx, "real-app", 'import { missing } from "./nope";\nexport default function App() {\n  return <view>{missing}</view>;\n}\n');
  await api(realCtx, "real-app/build", { method: "POST", json: {} });
  const status = await waitIdle(realCtx, "real-app");
  expect(status.error).toBeDefined();
  const hit = status.diagnostics.find((diagnostic: any) => diagnostic.message.includes("./nope"));
  // bun reports the position inside the JSX-lowered intermediate module, so the
  // line can be offset from the original source; the file and message are exact.
  expect(hit).toMatchObject({ file: "app.tsx", severity: "error" });
  expect(hit.line).toBeGreaterThanOrEqual(1);
  expect(hit.column).toBeGreaterThan(1);
}, 120_000);

test("real build: success clears diagnostics, emits status/log/done, and publishes a built revision", async () => {
  await writeSource(realCtx, "real-app", "export default function App() {\n  return null;\n}\n");
  const abort = new AbortController();
  const stream = events(realCtx, "real-app/build/events", abort);
  await stream.until((event) => event.type === "status");
  await api(realCtx, "real-app/build", { method: "POST", json: {} });
  const seen = await stream.until((event) => event.type === "done");
  expect(seen.some((event) => event.type === "status" && event.status.busy === true)).toBe(true);
  expect(seen.some((event) => event.type === "log" && event.line.startsWith("build ready"))).toBe(true);
  const done = seen.at(-1);
  expect(done.ok).toBe(true);
  expect(done.diagnostics).toEqual([]);
  const status = (await api(realCtx, "real-app/status")).body;
  expect(status.error).toBeUndefined();
  expect(status.diagnostics).toBeUndefined();
  expect(status.builtRevision).toBe(status.revision);
  abort.abort();
}, 120_000);

test("real build: cancel kills the compiler process tree and does not publish a build", async () => {
  const before = (await api(realCtx, "real-app/status")).body;
  await writeSource(realCtx, "real-app", "export default function App() {\n  return null; // changed\n}\n");
  const abort = new AbortController();
  const stream = events(realCtx, "real-app/build/events", abort);
  await stream.until((event) => event.type === "status");
  await api(realCtx, "real-app/build", { method: "POST", json: {} });
  // Wait until the compiler pipeline is really running, then cancel.
  await stream.until((event) => event.type === "log" && event.line.startsWith("build_guest: "));
  const cancelled = await api(realCtx, "real-app/build/cancel", { method: "POST", json: {} });
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.status).toMatchObject({ busy: false, error: "build cancelled", builtRevision: before.builtRevision });
  const done = (await stream.until((event) => event.type === "done")).at(-1);
  expect(done).toMatchObject({ ok: false, builtRevision: before.builtRevision });
  await Bun.sleep(300);
  const projectDirectory = join(realWorkspace, "projects/real-app");
  const survivors = Bun.spawnSync(["pgrep", "-f", `--project-root=${projectDirectory}`]);
  expect(survivors.stdout.toString().trim()).toBe("");
  // The server keeps working and can build again after a cancellation.
  await api(realCtx, "real-app/build", { method: "POST", json: {} });
  const rebuilt = await waitIdle(realCtx, "real-app");
  expect(rebuilt.error).toBeUndefined();
  expect(rebuilt.builtRevision).toBe(rebuilt.revision);
  abort.abort();
}, 180_000);
