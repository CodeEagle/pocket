import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  configFromHealth,
  editorToolEnvironment,
  makePidRecord,
  mergeLaunchOptions,
  parseArgs,
  parsePidRecord,
} from "../editor_service.mjs";

const fixture = (name: string) => resolve(tmpdir(), name);

describe("editor service launch config", () => {
  test("first launch without explicit values stays on the generic SDK", () => {
    const { options } = parseArgs(["start"], {});
    expect(options).toEqual({});
    expect(mergeLaunchOptions(options, {})).toEqual({});
  });

  test("no-argument start or restart restores the saved project and explicit tool overrides", () => {
    const { options } = parseArgs(["restart"], {});
    const saved = {
      projectRoot: fixture("lantern"),
      flutterRoot: fixture("consumer"),
      updatePackageVersion: "0.1.0",
      compilerPath: fixture("compiler/build.ts"),
      nativeProbe: fixture("pocket_probe"),
    };
    expect(mergeLaunchOptions(options, saved)).toEqual(saved);
  });

  test("health recovers project settings from an older PID record without config", () => {
    const legacy = makePidRecord(4321, {}, "2026-11-09T00:00:00.000Z");
    delete (legacy as { config?: unknown }).config;
    const parsed = parsePidRecord(JSON.stringify(legacy));
    expect(parsed?.config).toEqual({});
    expect(configFromHealth({
      ok: true,
      service: "pocket-editor",
      workspace: legacy.workspace,
      projectRoot: fixture("lantern"),
      flutterRoot: fixture("consumer"),
      updatePackageVersion: "0.1.0",
    })).toEqual({
      projectRoot: fixture("lantern"),
      flutterRoot: fixture("consumer"),
      updatePackageVersion: "0.1.0",
    });
    expect(configFromHealth({ ok: true, service: "pocket-editor", workspace: fixture("other-workspace"), projectRoot: fixture("foreign") })).toEqual({});
  });

  test("switching project clears only the prior Flutter binding and package version", () => {
    const previous = {
      projectRoot: fixture("lantern"),
      flutterRoot: fixture("lantern-flutter"),
      updatePackageVersion: "0.1.0",
      compilerPath: fixture("compiler/build.ts"),
      nativeProbe: fixture("pocket_probe"),
    };
    expect(mergeLaunchOptions({ projectRoot: fixture("other") }, previous)).toEqual({
      projectRoot: fixture("other"),
      compilerPath: fixture("compiler/build.ts"),
      nativeProbe: fixture("pocket_probe"),
    });
  });

  test("explicit values override saved settings", () => {
    const explicit = parseArgs(["restart", `--project-root=${fixture("new")}`, "--update-package-version=2.3.4"], {
      POCKET_EDITOR_FLUTTER_ROOT: fixture("new-flutter"),
      POCKET_COMPILER_PATH: fixture("new-compiler/build.ts"),
      POCKET_NATIVE_PROBE: fixture("new-probe"),
    }).options;
    expect(mergeLaunchOptions(explicit, {
      projectRoot: fixture("old"),
      flutterRoot: fixture("old-flutter"),
      updatePackageVersion: "1.2.3",
      compilerPath: fixture("old-compiler/build.ts"),
      nativeProbe: fixture("old-probe"),
    })).toEqual({
      projectRoot: fixture("new"),
      flutterRoot: fixture("new-flutter"),
      updatePackageVersion: "2.3.4",
      compilerPath: fixture("new-compiler/build.ts"),
      nativeProbe: fixture("new-probe"),
    });
  });

  test("the PID record keeps launch config when it is marked stopped", () => {
    const record = makePidRecord(null, { projectRoot: fixture("lantern"), compilerPath: fixture("compiler/build.ts") });
    expect(parsePidRecord(JSON.stringify(record))).toMatchObject({
      pid: null,
      config: { projectRoot: fixture("lantern"), compilerPath: fixture("compiler/build.ts") },
    });
  });

  test("parses upgrade-apply stage directory, target version, and handoff token arguments", () => {
    const parsed = parseArgs([
      "upgrade-apply",
      `--stage-dir=${fixture("sdk-upgrade-stage-0.1.11")}`,
      "--target-version=0.1.11",
      "--handoff-token=token-123",
    ], {});
    expect(parsed.command).toBe("upgrade-apply");
    expect(parsed.upgrade).toEqual({
      stageDir: fixture("sdk-upgrade-stage-0.1.11"),
      targetVersion: "0.1.11",
      handoffToken: "token-123",
    });

    const parsedFromEnv = parseArgs([
      "upgrade-apply",
      `--stage-dir=${fixture("sdk-upgrade-stage-0.1.11")}`,
      "--target-version=0.1.11",
    ], {
      POCKET_UPGRADE_HANDOFF_TOKEN: "env-token-456",
    });
    expect(parsedFromEnv.upgrade.handoffToken).toBe("env-token-456");
  });

  test("editorToolEnvironment accepts an explicit sdkRoot argument", () => {
    const env = editorToolEnvironment({ compilerPath: fixture("custom-compiler.ts") }, fixture("custom-sdk"));
    expect(env.POCKET_COMPILER_PATH).toBe(fixture("custom-compiler.ts"));
  });
});
