import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = resolve(import.meta.dir, "../../..");
const output = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-test-"));

afterAll(() => rmSync(output, { recursive: true, force: true }));

test("export_web_sdk creates a Flutter-free toolchain repo with Editor and the QJBC Web target", () => {
  const result = spawnSync("bun", ["sdk/scripts/export_web_sdk.ts", "--out", output], {
    cwd: repository,
    encoding: "utf8",
  });
  expect(`${result.stdout}${result.stderr}`).toContain("export_web_sdk: generated");
  expect(result.status).toBe(0);

  for (const path of [
    "editor/server.ts",
    "editor/client/index.html",
    "native/src/bin/pocket_probe.rs",
    "scripts/build_guest.ts",
    "scripts/build_web.ts",
    "scripts/build_wechat.ts",
    "scripts/prepare_upstream.py",
    "targets/web/browser_runtime.js",
    "targets/wechat/template/wechat-host.js",
    "packages/pocket_ui/src/index.ts",
    "packages/pocket_flutter/shaders/liquid_glass.frag",
  ]) expect(existsSync(join(output, path)), path).toBe(true);

  expect(existsSync(join(output, "native/target"))).toBe(false);
  expect(existsSync(join(output, ".cache"))).toBe(false);
  expect(existsSync(join(output, "editor/test"))).toBe(false);

  const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  expect(manifest.scripts["build:web"]).toBe("bun scripts/build_web.ts");
  expect(manifest.scripts.editor).toContain("editor/server.ts");
  expect(manifest.scripts.setup).not.toContain("flutter");
  expect(readFileSync(join(output, "README.md"), "utf8")).toContain("QJBC");
});
