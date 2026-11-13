import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  configFromHealth,
  editorToolEnvironment,
  isEntrypoint,
  protectedRetirementPlan,
  protectedProcessIsOutsideTargetTree,
  killTree,
  commandIncludesPath,
  upgradeApply,
  makePidRecord,
  mergeLaunchOptions,
  parseArgs,
  parsePidRecord,
} from "../editor_service.mjs";

const fixture = (name: string) => resolve(tmpdir(), name);
const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "editor_service.mjs");

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

  test("CLI entrypoint guard resolves symlinked parent directories and executes main()", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pocket-editor-service-symlink-"));
    try {
      const symlinkedScriptsDir = join(tempDir, "scripts-link");
      symlinkSync(dirname(SCRIPT_PATH), symlinkedScriptsDir, process.platform === "win32" ? "junction" : "dir");
      const symlinkedEntry = join(symlinkedScriptsDir, "editor_service.mjs");
      const canonicalModuleUrl = pathToFileURL(SCRIPT_PATH).href;

      expect(isEntrypoint(symlinkedEntry, canonicalModuleUrl)).toBe(true);
      expect(isEntrypoint(join(tempDir, "missing.mjs"), canonicalModuleUrl)).toBe(false);

      const cliRun = spawnSync("node", [symlinkedEntry, "start", "--port=9999"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(cliRun.status).toBe(1);
      expect(cliRun.stderr).toContain("Pocket Studio：Studio 固定使用 8791，不能指定其他端口");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


test("upgrade retirement excludes the updater ancestry while retaining worker tree cleanup", () => {
  const processes = [
    { pid: 100, ppid: 1 }, // old Studio
    { pid: 110, ppid: 100 }, // compiler worker
    { pid: 111, ppid: 110 }, // compiler child, retired by its subtree root
    { pid: 120, ppid: 100 }, // optional intermediary
    { pid: 121, ppid: 120 }, // upgrader
    { pid: 122, ppid: 121 }, // updater probe, must survive
    { pid: 123, ppid: 120 }, // intermediary's other worker
    { pid: 999, ppid: 1 }, // unrelated process
  ];
  expect(protectedRetirementPlan(processes, 100, 121)).toEqual({
    subtreeRoots: [110, 123], directPids: [120, 100],
  });
  expect(protectedRetirementPlan(processes, 100, 120)).toEqual({
    subtreeRoots: [110], directPids: [100],
  });
  expect(protectedRetirementPlan(processes, 100, 999)).toBeNull();
  expect(protectedRetirementPlan([{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }], 100, 1)).toBeNull();
});


test("upgrade retirement kills the real server tree but preserves its detached updater", { timeout: 10_000 }, async () => {
  const source = `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const updater = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const waitForSpawn = (child) => new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    Promise.all([waitForSpawn(worker), waitForSpawn(updater)]).then(() => {
      updater.unref();
      process.stdout.write(JSON.stringify({ workerPid: worker.pid, updaterPid: updater.pid }) + "\\n");
    }, (error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
    setInterval(() => {}, 1000);
  `;
  const server = spawn("node", ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });

  let childPids: { workerPid: number; updaterPid: number } | undefined;
  try {
    childPids = await new Promise<{ workerPid: number; updaterPid: number }>((resolveReady, rejectReady) => {
      let output = "";
      const timer = setTimeout(() => rejectReady(new Error(`process tree did not become ready: ${stderr}`)), 3_000);
      server.once("error", (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        rejectReady(new Error(`server process exited before ready (${code}): ${stderr}`));
      });
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try { resolveReady(JSON.parse(output.slice(0, newline))); }
        catch (error) { rejectReady(error); }
      });
    });

    if (process.platform !== "win32") {
      const updaterPpid = spawnSync("ps", ["-o", "ppid=", "-p", String(childPids.updaterPid)], { encoding: "utf8" });
      expect(updaterPpid.status).toBe(0);
      expect(Number(updaterPpid.stdout.trim())).toBe(server.pid);
    }
    await killTree(server.pid!, "SIGTERM", childPids.updaterPid);

    const processState = (pid: number) => {
      const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      if (result.status === 0) {
        const state = result.stdout.trim();
        return state && !/^[ZX]/.test(state) ? "alive" : "exited";
      }
      try { process.kill(pid, 0); return "alive"; }
      catch (error) { return error.code === "ESRCH" ? "exited" : "alive"; }
    };
    const waitForExit = async (pid: number) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (processState(pid) === "exited") return true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      return false;
    };

    expect(await waitForExit(server.pid!)).toBe(true);
    expect(await waitForExit(childPids.workerPid)).toBe(true);
    expect(processState(childPids.updaterPid)).toBe("alive");
  } finally {
    for (const pid of [server.pid, childPids?.workerPid, childPids?.updaterPid]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (server.pid) server.kill("SIGKILL");
  }
});


test("an updater already reparented to init is safe for recursive retirement", () => {
  const processes = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 1 },
  ];
  expect(protectedProcessIsOutsideTargetTree(processes, 100, 200)).toBe(true);
  expect(protectedProcessIsOutsideTargetTree([
    { pid: 0, ppid: 0 },
    { pid: 100, ppid: 0 },
    { pid: 200, ppid: 0 },
  ], 100, 200)).toBe(true);
  expect(protectedProcessIsOutsideTargetTree(processes, 100, 300)).toBe(false);
  expect(protectedProcessIsOutsideTargetTree([{ pid: 200, ppid: 100 }], 100, 200)).toBe(false);
  expect(protectedProcessIsOutsideTargetTree([{ pid: 200, ppid: 999 }], 100, 200)).toBe(false);
});


test("service ownership resolves aliased command paths and rejects unrelated files", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-command-path-"));
  try {
    const actual = join(root, "actual sdk");
    mkdirSync(join(actual, "editor"), { recursive: true });
    writeFileSync(join(actual, "editor", "server.ts"), "// fixture");
    const alias = join(root, "alias");
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    expect(commandIncludesPath(`bun "${join(alias, "editor", "server.ts")}" --port=8791`, join(actual, "editor", "server.ts"))).toBe(true);
    expect(commandIncludesPath(`bun "${join(actual, "editor", "server.ts")}"`, join(alias, "editor", "server.ts"))).toBe(true);
    expect(commandIncludesPath(`bun "${join(root, "unrelated", "editor", "server.ts")}"`, join(actual, "editor", "server.ts"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("pre-stop upgrade failures persist an error rather than leaving the UI restarting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-upgrade-early-error-"));
  try {
    mkdirSync(join(root, ".pocket-build"), { recursive: true });
    const statusPath = join(root, ".pocket-build", "sdk-upgrade-status.json");
    writeFileSync(statusPath, JSON.stringify({ status: "restarting", currentVersion: "0.1.10" }));
    await expect(upgradeApply({ stageDir: join(root, "missing-stage"), targetVersion: "0.1.11" }, { sdkRoot: root })).rejects.toThrow();
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    expect(status.status).toBe("error");
    expect(status.error).toBeTruthy();
    expect(status.currentVersion).toBe("0.1.10");
    expect(status.rolledBack).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
