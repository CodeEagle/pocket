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
    "scripts/project_templates.ts",
    "scripts/editor_service.mjs",
    "scripts/toolchain.mjs",
    "scripts/prebuilt_tools.mjs",
    "templates/app/app.tsx",
    "templates/game/app.tsx",
    "docs/PROJECT_TEMPLATES.md",
    "docs/NPM_TOOLCHAIN.md",
    "editor/native/noble-bluetooth.mjs",
    "packages/pocket_tftc/src/index.js",
    "packages/pocket_tftc/README.md",
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
  expect(existsSync(join(output, "packages/pocket_tftc/test"))).toBe(false);

  const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  expect(manifest.version).toBe("0.1.1");
  expect(manifest.workspaces).toContain("packages/pocket_tftc");
  expect(manifest.workspaces).toContain("packages/pocket_ui");
  expect(manifest.dependencies?.["@pocket/ui"]).toBeUndefined();
  expect(manifest.dependencies?.["find-process"]).toBe("2.1.1");
  expect(manifest.dependencies?.["tree-kill"]).toBe("1.2.2");
  expect(manifest.devDependencies?.["@open-wxa/wxa-runner-core"]).toBe("0.12.3");
  expect(manifest.scripts["build:web"]).toBe("node scripts/toolchain.mjs run scripts/build_web.ts");
  expect(manifest.dependencies.bun).toBe("1.3.9");
  expect(manifest.scripts.setup).toBe("node scripts/toolchain.mjs setup");
  expect(manifest.scripts.bootstrap).toBe("node scripts/toolchain.mjs bootstrap");
  expect(manifest.scripts["build:guest"]).toBe("node scripts/toolchain.mjs build:guest");
  expect(manifest.scripts["build:probe"]).toBe("node scripts/toolchain.mjs build:probe");
  expect(manifest.scripts.editor).toContain("scripts/editor_service.mjs");
  expect(manifest.scripts.setup).not.toContain("flutter");
  expect(manifest.dependencies?.["@abandonware/noble"]).toBeUndefined();
  expect(manifest.optionalDependencies?.["@abandonware/noble"]).toBe("1.9.2-26");
  const readme = readFileSync(join(output, "README.md"), "utf8");
  expect(readme).toContain("QJBC");
}, 30_000);
