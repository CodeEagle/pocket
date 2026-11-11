import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
    "editor/diagnostics.ts",
    "packages/pocket_diagnostics/src/node.ts",
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
    "packages/pocket_live2d/src/index.ts",
    "docs/WEB_LIVE2D.md",
    "docs/EDITOR_LIVE2D.md",
    "packages/pocket_live2d/scripts/bootstrap_cubism_web_core.sh",
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
  for (const path of [
    "packages/pocket_live2d/native",
    "packages/pocket_live2d/ios",
    "packages/pocket_live2d/macos",
    "packages/pocket_live2d/android",
    "packages/pocket_live2d/windows",
    "packages/pocket_live2d/test",
    "packages/pocket_live2d/node_modules",
  ]) expect(existsSync(join(output, path)), path).toBe(false);

  const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  expect(manifest.version).toBe(SDK_VERSION);
  expect(manifest.workspaces).toContain("packages/pocket_tftc");
  expect(manifest.workspaces).toContain("packages/pocket_ui");
  expect(manifest.workspaces).toContain("packages/pocket_spine");
  expect(manifest.workspaces).toContain("packages/pocket_live2d");
  expect(manifest.dependencies?.["@pocket/spine"]).toBe("0.1.0");
  expect(manifest.dependencies?.["@pocket/live2d"]).toBe("0.1.0");
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
  const live2dManifest = JSON.parse(readFileSync(join(output, "packages/pocket_live2d/package.json"), "utf8"));
  expect(live2dManifest.name).toBe("@pocket/live2d");
  expect(live2dManifest.files).toEqual(["src"]);
  expect(live2dManifest.dependencies).toBeUndefined();
  for (const target of Object.values(live2dManifest.exports as Record<string, string>)) {
    expect(existsSync(join(output, "packages/pocket_live2d", target.replace(/^\.\//, "")))).toBe(true);
  }
  const installRoot = mkdtempSync(join(tmpdir(), "pocket-web-live2d-install-test-"));
  try {
    mkdirSync(join(installRoot, "packages"), { recursive: true });
    cpSync(join(output, "packages/pocket_live2d"), join(installRoot, "packages/pocket_live2d"), { recursive: true });
    writeFileSync(join(installRoot, "package.json"), JSON.stringify({
      name: "pocket-web-live2d-install-test",
      private: true,
      workspaces: ["packages/pocket_live2d"],
      dependencies: { "@pocket/live2d": "0.1.0" },
    }));
    const install = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: installRoot,
      encoding: "utf8",
    });
    expect(install.status).toBe(0);
    expect(realpathSync(join(installRoot, "node_modules/@pocket/live2d"))).toBe(realpathSync(join(installRoot, "packages/pocket_live2d")));
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
  const readme = readFileSync(join(output, "README.md"), "utf8");
  expect(readme).toContain("QJBC");
  expect(readme).toContain("docs/GAME_INPUT_IMPLEMENTATION.md");
  expect(readme).toContain("docs/WEB_WORKER_IMPLEMENTATION.md");
  expect(readme).toContain("docs/LARGE_IMAGE_IMPLEMENTATION.md");
  expect(readme).toContain("docs/WEB_LIVE2D.md");
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
