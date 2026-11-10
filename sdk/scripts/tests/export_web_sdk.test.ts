import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SDK_VERSION } from "../prebuilt_tools.mjs";

const repository = resolve(import.meta.dir, "../../..");
const sdkBuild = join(repository, "sdk", ".pocket-build");
const output = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-test-"));
const darwinOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-darwin-test-"));
const windowsOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-windows-test-"));
const missingPlatformOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-missing-test-"));

function withPlatformArchiveFixtures<T>(run: (fixtures: ReadonlyMap<string, Buffer>) => T): T {
  const buildDirectoryExisted = existsSync(sdkBuild);
  mkdirSync(sdkBuild, { recursive: true });
  const originals = new Map<string, Buffer | undefined>();
  const fixtures = new Map<string, Buffer>();
  for (const platform of ["darwin-arm64", "win32-x64"]) {
    const name = `pocket-tools-${platform}-${SDK_VERSION}.tgz`;
    const path = join(sdkBuild, name);
    originals.set(name, existsSync(path) ? readFileSync(path) : undefined);
    // A sentinel file verifies the exporter copies the selected archive. It is
    // deliberately not a valid package and does not stand in for a real build.
    const bytes = Buffer.from(`export-test fixture: ${name}`);
    fixtures.set(name, bytes);
    writeFileSync(path, bytes);
  }
  try {
    return run(fixtures);
  } finally {
    for (const [name, original] of originals) {
      const path = join(sdkBuild, name);
      if (original === undefined) rmSync(path, { force: true });
      else writeFileSync(path, original);
    }
    if (!buildDirectoryExisted && readdirSync(sdkBuild).length === 0) {
      rmSync(sdkBuild, { recursive: true, force: true });
    }
  }
}

afterAll(() => {
  for (const path of [output, darwinOutput, windowsOutput, missingPlatformOutput]) rmSync(path, { recursive: true, force: true });
});

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
    "docs/GAME_INPUT_IMPLEMENTATION.md",
    "docs/WEB_WORKER_IMPLEMENTATION.md",
    "docs/LARGE_IMAGE_IMPLEMENTATION.md",
    "editor/native/noble-bluetooth.mjs",
    "packages/pocket_tftc/src/index.js",
    "packages/pocket_tftc/README.md",
    "editor/client/index.html",
    "native/src/bin/pocket_probe.rs",
    "scripts/build_guest.ts",
    "scripts/project_fonts.ts",
    "scripts/build_web.ts",
    "scripts/build_wechat.ts",
    "scripts/prepare_upstream.py",
    "targets/web/browser_runtime.js",
    "targets/wechat/template/wechat-host.js",
    "packages/pocket_ui/src/index.ts",
    "packages/pocket_vn/src/engine.ts",
    "packages/pocket_vn/src/asset-references.ts",
    "packages/pocket_vn/src/collections.ts",
    "packages/pocket_spine/src/index.ts",
    "packages/pocket_flutter/shaders/liquid_glass.frag",
  ]) expect(existsSync(join(output, path)), path).toBe(true);

  expect(existsSync(join(output, "native/target"))).toBe(false);
  expect(existsSync(join(output, ".cache"))).toBe(false);
  expect(existsSync(join(output, "editor/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_tftc/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_vn/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_spine/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_spine/node_modules"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_live2d"))).toBe(false);

  const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  expect(manifest.version).toBe(SDK_VERSION);
  expect(manifest.workspaces).toContain("packages/pocket_tftc");
  expect(manifest.workspaces).toContain("packages/pocket_ui");
  expect(manifest.workspaces).toContain("packages/pocket_spine");
  expect(manifest.dependencies?.["@pocket/spine"]).toBe("0.1.0");
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
  const spineManifest = JSON.parse(readFileSync(join(output, "packages/pocket_spine/package.json"), "utf8"));
  expect(spineManifest.name).toBe("@pocket/spine");
  expect(spineManifest.dependencies?.["@esotericsoftware/spine-core"]).toBe("4.3.13");
  const readme = readFileSync(join(output, "README.md"), "utf8");
  expect(readme).toContain("QJBC");
  expect(readme).toContain("docs/GAME_INPUT_IMPLEMENTATION.md");
  expect(readme).toContain("docs/WEB_WORKER_IMPLEMENTATION.md");
  expect(readme).toContain("docs/LARGE_IMAGE_IMPLEMENTATION.md");
}, 30_000);

test("export_web_sdk packages only the requested platform archive and fails closed when it is absent", () => {
  withPlatformArchiveFixtures((fixtures) => {
    for (const [platform, target, os, cpu] of [
      ["darwin-arm64", darwinOutput, "darwin", "arm64"],
      ["win32-x64", windowsOutput, "win32", "x64"],
    ] as const) {
      const result = spawnSync("bun", ["sdk/scripts/export_web_sdk.ts", "--out", target, "--platform", platform], {
        cwd: repository,
        encoding: "utf8",
      });
      expect(`${result.stdout}${result.stderr}`).toContain("export_web_sdk: generated");
      expect(result.status).toBe(0);
      const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      expect(manifest.version).toBe(SDK_VERSION);
      expect(manifest.name).toBe(`@pocket/web-sdk-tools-${platform}`);
      expect(manifest.os).toEqual([os]);
      expect(manifest.cpu).toEqual([cpu]);
      expect(
        Object.keys(manifest.optionalDependencies).filter((name) => name.startsWith("@pocket/tools-")),
      ).toEqual([`@pocket/tools-${platform}`]);
      const archiveName = `pocket-tools-${platform}-${SDK_VERSION}.tgz`;
      expect(readFileSync(join(target, "prebuilt", archiveName))).toEqual(fixtures.get(archiveName));
      const readme = readFileSync(join(target, "README.md"), "utf8");
      expect(readme).toContain(`# Pocket Web SDK (${platform})`);
    }

    const archiveName = `pocket-tools-win32-x64-${SDK_VERSION}.tgz`;
    const archive = join(sdkBuild, archiveName);
    rmSync(archive);
    try {
      const result = spawnSync("bun", [
        "sdk/scripts/export_web_sdk.ts",
        "--out",
        missingPlatformOutput,
        "--platform",
        "win32-x64",
      ], { cwd: repository, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("missing win32-x64 prebuilt archive");
    } finally {
      writeFileSync(archive, fixtures.get(archiveName)!);
    }
  });
}, 30_000);
