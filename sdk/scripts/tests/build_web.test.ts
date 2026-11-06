import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBuildWebArgs } from "../build_web.ts";
import { parseBuildWebEngineArgs } from "../build_web_engine.ts";

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
  ])).toEqual({ projectRoot: "/tmp/guest", outDir: "/tmp/web", enginePath: "/opt/pocket/pocketjs.wasm", runtimePath: "/opt/pocket/pocket-web.js" });
  expect(() => parseBuildWebArgs(["--outdir=/tmp/web"])).toThrow(/project-root/);
  expect(() => parseBuildWebArgs(["--project-root=/tmp/guest", "--outdir=/tmp/web", "--flutter"])).toThrow(/unknown option/);
});

test("browser target uses the real WebAssembly boundary and explicit Web identity", () => {
  const runtime = readFileSync(resolve(import.meta.dir, "../../targets/web/browser_runtime.js"), "utf8");
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
