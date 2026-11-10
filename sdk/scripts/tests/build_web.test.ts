import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBuildWebArgs, prepareWebLive2dArtifacts } from "../build_web.ts";
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
    "--live2d-core=/opt/live2dcubismcore.min.js",
    "--worker-http-origin=https://example.com",
    "--render-worker",
  ])).toEqual({ projectRoot: "/tmp/guest", outDir: "/tmp/web", enginePath: "/opt/pocket/pocketjs.wasm", runtimePath: "/opt/pocket/pocket-web.js", live2dCorePath: "/opt/live2dcubismcore.min.js", workerHttpOrigins: ["https://example.com"], renderWorker: true });
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
  expect(builder).toContain("novel.native-assets.json");
  expect(builder).toContain("--live2d-core");
});

test("Web Live2D copies only buildGuest's hashed moc allowlist and explicit local Core", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-web-live2d-test-"));
  const guest = join(root, "guest");
  const output = join(root, "web");
  mkdirSync(join(guest, "native-models"), { recursive: true });
  mkdirSync(output);
  const moc = Buffer.from("native Cubism model fixture");
  const assetPath = `native-models/${createHash("sha256").update(moc).digest("hex")}.moc3`;
  const core = join(root, "licensed-live2dcubismcore.min.js");
  writeFileSync(join(guest, assetPath), moc);
  writeFileSync(join(guest, "native-models/unlisted.moc3"), "must not copy");
  writeFileSync(join(guest, "novel.native-assets.json"), JSON.stringify({ version: 1, assets: { "models/actor.moc3": assetPath } }));
  writeFileSync(core, "official Core fixture");
  try {
    const live2d = prepareWebLive2dArtifacts(guest, output, core);
    expect(live2d).toEqual({ assets: { "models/actor.moc3": assetPath }, coreUrl: "./live2dcubismcore.min.js" });
    expect(readFileSync(join(output, assetPath))).toEqual(moc);
    expect(readFileSync(join(output, "live2dcubismcore.min.js"), "utf8")).toBe("official Core fixture");
    expect(existsSync(join(output, "native-models/unlisted.moc3"))).toBe(false);
    expect(live2d?.coreUrl).not.toMatch(/^https?:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Web Live2D requires a local Core when models are present and ignores an empty catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-web-live2d-core-test-"));
  const guest = join(root, "guest");
  const output = join(root, "web");
  mkdirSync(guest);
  mkdirSync(output);
  const previousCore = process.env.POCKET_CUBISM_WEB_CORE;
  delete process.env.POCKET_CUBISM_WEB_CORE;
  try {
    writeFileSync(join(guest, "novel.native-assets.json"), JSON.stringify({ version: 1, assets: {} }));
    expect(prepareWebLive2dArtifacts(guest, output)).toBeUndefined();
    expect(existsSync(join(output, "live2dcubismcore.min.js"))).toBe(false);

    writeFileSync(join(guest, "novel.native-assets.json"), JSON.stringify({ version: 1, assets: { "models/actor.moc3": "native-models/" + "a".repeat(64) + ".moc3" } }));
    expect(() => prepareWebLive2dArtifacts(guest, output)).toThrow(/Cubism Web Core script is required.*--live2d-core=.*POCKET_CUBISM_WEB_CORE/);
    writeFileSync(join(guest, "novel.native-assets.json"), JSON.stringify({ version: 1, assets: { "models/actor.moc3": "../../outside.moc3" } }));
    expect(() => prepareWebLive2dArtifacts(guest, output, "/tmp/core.js")).toThrow(/non-allowlisted/);
  } finally {
    if (previousCore === undefined) delete process.env.POCKET_CUBISM_WEB_CORE;
    else process.env.POCKET_CUBISM_WEB_CORE = previousCore;
    rmSync(root, { recursive: true, force: true });
  }
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
