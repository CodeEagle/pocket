import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBuildWebArgs } from "../build_web.ts";
import { parseBuildWebEngineArgs, verifyWebEngine } from "../build_web_engine.ts";

test("build_web parses a standalone consumer build without Flutter options", () => {
  expect(parseBuildWebArgs([
    "--project-root=/tmp/guest",
    "--outdir=/tmp/web",
    "--entry=app.tsx",
    "--tick-hz=60",
    "--density=2",
  ])).toEqual({ projectRoot: "/tmp/guest", outDir: "/tmp/web", entry: "app.tsx", tickHz: 60, rasterDensity: 2 });
  expect(parseBuildWebArgs([
    "--project-root=/tmp/guest",
    "--outdir=/tmp/web",
    "--engine=/opt/pocket/pocketjs.wasm",
    "--runtime=/opt/pocket/pocket-web.js",
    "--worker-http-origin=https://example.com",
    "--render-worker",
  ])).toEqual({ projectRoot: "/tmp/guest", outDir: "/tmp/web", enginePath: "/opt/pocket/pocketjs.wasm", runtimePath: "/opt/pocket/pocket-web.js", workerHttpOrigins: ["https://example.com"], renderWorker: true });
  expect(parseBuildWebArgs(["--project-root=/tmp/guest", "--outdir=/tmp/web", "--no-render-worker"]).renderWorker).toBe(false);
  expect(() => parseBuildWebArgs(["--outdir=/tmp/web"])).toThrow(/project-root/);
  expect(() => parseBuildWebArgs(["--project-root=/tmp/guest", "--outdir=/tmp/web", "--flutter"])).toThrow(/unknown option/);
});

test("browser target uses the real WebAssembly boundary and explicit Web identity", () => {
  const runtime = readFileSync(resolve(import.meta.dir, "../../targets/web/browser_runtime.js"), "utf8");
  const transport = readFileSync(resolve(import.meta.dir, "../../targets/web/worker_transport.js"), "utf8");
  const builder = readFileSync(resolve(import.meta.dir, "../build_web.ts"), "utf8");
  expect(runtime).toContain("WebAssembly.instantiate");
  expect(runtime).toContain("provider: \"web\"");
  expect(runtime).toContain("hostRuntime: \"WebAssembly + Canvas2D\"");
  expect(runtime).toContain("export { PocketWebRuntime");
  expect(runtime).not.toContain("source-eval");
  expect(runtime).not.toContain("flutter");
  expect(builder).toContain("POCKET_WEB_ENGINE");
  expect(builder).toContain("POCKET_WEB_RUNTIME");
  expect(builder).toContain("app.qjbc");
  expect(builder).toContain("app.pak");
  expect(builder).not.toContain("buildWechat");
  expect(builder).toContain("pocket-render-worker.js");
  expect(builder).toContain("renderWorkerUrl");
});

test("standalone Web packaging keeps the compiled Worker artifact and exact HTTP grant", () => {
  const builder = readFileSync(resolve(import.meta.dir, "../build_web.ts"), "utf8");
  const runtime = readFileSync(resolve(import.meta.dir, "../../targets/web/browser_runtime.js"), "utf8");
  const transport = readFileSync(resolve(import.meta.dir, "../../targets/web/worker_transport.js"), "utf8");
  expect(builder).toContain("built.worker.bytecode");
  expect(builder).toContain("app.worker.qjbc");
  expect(builder).toContain("workerHttpOrigins");
  expect(builder).toContain("manifest capabilities do not grant network origins");
  expect(runtime).not.toContain("createBrowserWorker");
  expect(runtime).not.toContain("importScripts");
  expect(transport).toContain("web_worker_create");
  expect(transport).toContain("web_worker_emit");
  expect(transport).toContain("web_worker_finish");
  expect(transport).toContain("WebAssembly.instantiate");
  expect(transport).not.toContain("app.worker.js");
});

test("render Worker defaults off and supports explicit Worker rendering", () => {
  const builder = readFileSync(resolve(import.meta.dir, "../build_web.ts"), "utf8");
  const engineBuilder = readFileSync(resolve(import.meta.dir, "../build_web_engine.ts"), "utf8");
  expect(builder).toContain("options.renderWorker ?? false");
  expect(builder).toContain("POCKET_RENDER_WORKER");
  expect(builder).toContain("--render-worker");
  expect(engineBuilder).toContain("pocket-render-worker.js");
  expect(engineBuilder).toContain("targets/web/render_worker.js");
});

test("Web engine release command is an explicit source-build maintainer path", () => {
  expect(parseBuildWebEngineArgs([]).outDir).toContain(".pocket-build/web-engine");
  expect(parseBuildWebEngineArgs(["--outdir=/tmp/engine", "--tick-hz=60", "--density=2"]))
    .toEqual({ outDir: "/tmp/engine", tickHz: 60, rasterDensity: 2 });
  const builder = readFileSync(resolve(import.meta.dir, "../build_web_engine.ts"), "utf8");
  expect(builder).toContain("POCKET_SOURCE_BUILD");
  expect(builder).toContain("buildWechat");
  expect(builder).toContain("web_boot");
  expect(builder).toContain("web_set_identity");
  expect(builder).toContain("source-guest imports are forbidden");
});

test("Worker engine verification rejects an old or incomplete npm engine", async () => {
  const emptyWasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  await expect(verifyWebEngine(emptyWasm)).rejects.toThrow(/missing/);
});
