import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBuildWebArgs } from "../build_web.ts";

test("build_web parses a standalone consumer build without Flutter options", () => {
  expect(parseBuildWebArgs([
    "--project-root=/tmp/guest",
    "--outdir=/tmp/web",
    "--entry=app.tsx",
    "--tick-hz=60",
    "--density=2",
  ])).toEqual({ projectRoot: "/tmp/guest", outDir: "/tmp/web", entry: "app.tsx", tickHz: 60, rasterDensity: 2 });
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
  expect(builder).toContain('"--format=esm"');
  expect(builder).not.toContain("--global-name");
});
