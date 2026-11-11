#!/usr/bin/env node
/**
 * Cross-platform Pocket Studio service manager.
 *
 * Studio owns one local endpoint: 127.0.0.1:8791. Process discovery is
 * restricted to this checkout's editor/server.ts; unrelated listeners are
 * never moved or killed.
 */

import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prebuiltEnvironment } from "./prebuilt_tools.mjs";
import {
  acquireUpgradeApplyLock,
  applyStagedSdkFiles,
  isSdkBackupComplete,
  prepareSdkUpgradeBackup,
  readInstalledSdkInfo,
  recoverInterruptedSdkUpgrade,
  restoreBackedUpSdkFiles,
  validateStagedStandaloneSdk,
  writePersistedUpgradeStatus,
} from "./studio_upgrade.mjs";
import { nativeProbeCandidates, nativeProbeSourceInputs, selectNativeProbe } from "./native_probe_path.ts";

const require = createRequire(import.meta.url);
const findProcess = require("find-process").default;
const treeKill = require("tree-kill");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(SCRIPT_DIR, "..");
const CHECKOUT_ROOT = resolve(SDK_ROOT, "..");
const SERVER = join(SDK_ROOT, "editor", "server.ts");
const HOST = "127.0.0.1";
const STANDALONE_FIXTURE_PORT =
  process.env.POCKET_STUDIO_TEST_PORT &&
  existsSync(join(SDK_ROOT, ".pocket-studio-test-fixture")) &&
  !existsSync(join(CHECKOUT_ROOT, ".git")) &&
  !existsSync(join(SDK_ROOT, "editor", "test"))
    ? Number(process.env.POCKET_STUDIO_TEST_PORT)
    : null;
const PORT =
  Number.isInteger(STANDALONE_FIXTURE_PORT) && STANDALONE_FIXTURE_PORT > 0 && STANDALONE_FIXTURE_PORT <= 65535
    ? STANDALONE_FIXTURE_PORT
    : 8791;
const LEGACY_PORTS = STANDALONE_FIXTURE_PORT ? [] : [8790, 8792, 8793];
const WORKSPACE = join(SDK_ROOT, ".pocket-build", "editor-workspace-8791");
const LOG = join(SDK_ROOT, ".pocket-build", "editor-service-8791.log");
const PID_FILE = join(SDK_ROOT, ".pocket-build", "editor-service-8791.pid.json");
const PATH_HASH = sha256Path(SDK_ROOT).slice(0, 16);
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const FS_REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

function sha256Path(value) {
  return createHash("sha256").update(value).digest("hex");
}

function labelForPort(port) { return `com.pocket.editor.${PATH_HASH}.${port}`; }
function sleep(ms) { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }
function normalized(value) {
  const path = String(value || "").replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function checkFixedEnvironment() {
  if (process.env.POCKET_EDITOR_PORT && process.env.POCKET_EDITOR_PORT !== String(PORT)) {
    throw new Error("Pocket Studio 固定使用 8791，POCKET_EDITOR_PORT 不能设置为其他端口");
  }
  if (process.env.POCKET_EDITOR_UPDATE_PORT && process.env.POCKET_EDITOR_UPDATE_PORT !== String(PORT)) {
    throw new Error("Pocket Studio 的 update port 固定使用 8791，不能使用其他端口");
  }
  if (!existsSync(SERVER)) throw new Error(`找不到编辑器入口：${SERVER}`);
}

/**
 * Prefer a fresh source-repository probe for the checked-out Editor. The npm
 * toolchain still supplies Bun, the compiler and other platform helpers; this
 * override is limited to the Editor child and never changes standalone SDK
 * selection. An explicit POCKET_NATIVE_PROBE remains authoritative.
 */
function editorToolEnvironment(options = {}, sdkRoot = SDK_ROOT) {
  const resolvedSdkRoot = resolve(options?.sdkRoot || sdkRoot || SDK_ROOT);
  const explicitCompiler = options.compilerPath || process.env.POCKET_COMPILER_PATH;
  const explicitProbe = options.nativeProbe || process.env.POCKET_NATIVE_PROBE;
  const explicitOverrides = {};
  if (explicitCompiler?.trim()) explicitOverrides.POCKET_COMPILER_PATH = resolve(explicitCompiler);
  if (explicitProbe?.trim()) explicitOverrides.POCKET_NATIVE_PROBE = resolve(explicitProbe);
  if (process.env.POCKET_SOURCE_BUILD === "1") return { ...process.env, ...explicitOverrides };
  const toolEnv = prebuiltEnvironment(resolvedSdkRoot);
  // Preserve the two supported explicit tool overrides. The npm defaults stay
  // in place when neither is supplied.
  if (explicitOverrides.POCKET_NATIVE_PROBE) return { ...toolEnv, ...explicitOverrides };
  if (explicitOverrides.POCKET_COMPILER_PATH) toolEnv.POCKET_COMPILER_PATH = explicitOverrides.POCKET_COMPILER_PATH;

  const candidates = nativeProbeCandidates(resolvedSdkRoot);
  if (!candidates.some(candidate => existsSync(candidate))) return toolEnv;
  const probe = selectNativeProbe({
    candidates,
    sourceInputs: nativeProbeSourceInputs(resolvedSdkRoot),
  });
  return { ...toolEnv, POCKET_NATIVE_PROBE: probe };
}

function processCommand(info) {
  return [info?.cmdline, info?.command, info?.name, info?.cmd].filter(Boolean).flat().join(" ");
}

function processCommandLine(pid) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function processCwd(pid) {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      return execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" })
        .split(/\r?\n/).find(line => line.startsWith("n"))?.slice(1) || "";
    }
  } catch { /* a terminating process may have no readable cwd */ }
  return "";
}

function inside(path, root) {
  if (!path) return false;
  const child = normalized(resolve(path));
  const base = normalized(resolve(root));
  return child === base || child.startsWith(`${base}/`);
}

function sameCheckoutServer(info, expectedPort) {
  const pid = Number(info?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = normalized(processCommand(info));
  let pathMatch = command.includes(normalized(SERVER));
  if (!pathMatch && command.includes("sdk/editor/server.ts")) {
    const cwd = processCwd(pid);
    pathMatch = inside(cwd, CHECKOUT_ROOT) || inside(cwd, SDK_ROOT);
  }
  if (!pathMatch && command.includes("editor/server.ts")) {
    pathMatch = command.includes(normalized(join(SDK_ROOT, ".pocket-build")));
  }
  if (!pathMatch) return false;
  const explicitPort = command.match(/--port(?:=|\s+)(\d+)/);
  return !explicitPort || Number(explicitPort[1]) === expectedPort;
}

async function findPortProcesses(port) {
  const found = await findProcess("port", port);
  const candidates = Array.isArray(found) ? found.filter(entry => Number.isInteger(Number(entry?.pid))) : [];
  try {
    const output = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pids = [...new Set(output.split(/\r?\n/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0))];
    return pids.map(pid => candidates.find(entry => Number(entry.pid) === pid) || { pid, cmdline: processCommandLine(pid) });
  } catch (error) {
    // lsof exits 1 when no LISTEN socket exists. The library may still have
    // observed a browser's stale connection; that is not a server to retire.
    if (error.status === 1) return [];
    return candidates;
  }
}

async function assertPortOwnership(port, allowForeign) {
  const processes = await findPortProcesses(port);
  const foreign = processes.filter(info => !sameCheckoutServer(info, port));
  if (foreign.length && !allowForeign) {
    throw new Error(`端口 ${port} 已被其他程序占用（PID ${foreign.map(info => info.pid).join(", ")}），不会接管或换端口`);
  }
  return { processes, owned: processes.filter(info => sameCheckoutServer(info, port)), foreign };
}

function killTree(pid, signal) {
  return new Promise(resolveKill => {
    try { treeKill(Number(pid), signal, () => resolveKill()); }
    catch { resolveKill(); }
  });
}

async function waitProcessesGone(pids, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.some(pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
    if (!alive) return true;
    await sleep(250);
  }
  return !pids.some(pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
}

async function stopOwnedPort(port, required) {
  const state = await assertPortOwnership(port, !required);
  const record = port === PORT ? readPidRecord() : undefined;
  if (record && Number.isInteger(record.pid) && !state.owned.some(info => Number(info.pid) === record.pid)) {
    const found = await findProcess("pid", record.pid);
    state.owned.push(...found.filter(info => sameCheckoutServer(info, port)));
  }
  if (!state.owned.length) return;
  const pids = state.owned.map(info => Number(info.pid));
  for (const pid of pids) await killTree(pid, "SIGTERM");
  if (!(await waitProcessesGone(pids, 1500))) {
    for (const pid of pids) {
      try { process.kill(pid, 0); } catch { continue; }
      const current = (await findProcess("pid", pid))?.[0];
      if (!current) continue;
      if (!sameCheckoutServer(current, port)) throw new Error(`拒绝强制停止未知进程 PID ${pid}`);
      await killTree(pid, "SIGKILL");
    }
  }
  const remaining = (await findPortProcesses(port)).filter(info => required || sameCheckoutServer(info, port));
  if (remaining.length || !(await waitProcessesGone(pids, 2000))) {
    throw new Error(`端口 ${port} 的 Pocket Studio 进程没有退出`);
  }
}

function cleanupLegacyLaunchd() {
  if (process.platform !== "darwin") return;
  for (const port of [PORT, ...LEGACY_PORTS]) {
    spawnSync("launchctl", ["remove", labelForPort(port)], { stdio: "ignore" });
  }
}

const CONFIG_FIELDS = ["projectRoot", "flutterRoot", "updatePackageVersion", "compilerPath", "nativeProbe"];

function serviceConfig(value = {}) {
  const config = {};
  for (const field of CONFIG_FIELDS) {
    const candidate = value?.[field];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    config[field] = field === "updatePackageVersion" ? candidate.trim() : resolve(candidate.trim());
  }
  return config;
}

/** The PID record also carries the launch settings needed by a later start. */
function makePidRecord(pid, config, startedAt = new Date().toISOString()) {
  return { pid, server: SERVER, workspace: WORKSPACE, port: PORT, startedAt, config: serviceConfig(config) };
}

function parsePidRecord(raw) {
  try {
    const record = JSON.parse(raw);
    if (record.server !== SERVER || record.workspace !== WORKSPACE || record.port !== PORT) return undefined;
    if (record.pid !== null && (!Number.isInteger(record.pid) || record.pid <= 0)) return undefined;
    // Older PID records have no config. A live server's health response can
    // supply its existing binding during the first restart after this update.
    return { ...record, config: serviceConfig(record.config ?? record) };
  } catch { return undefined; }
}

function readPidRecord() {
  try { return parsePidRecord(readFileSync(PID_FILE, "utf8")); }
  catch { return undefined; }
}

function writePidRecord(pid, config) {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, `${JSON.stringify(makePidRecord(pid, config), null, 2)}\n`);
}

function writeStoppedRecord(config) {
  // Keep the same record after stop, with no live PID, so `start` can restore
  // the last explicit project and tool overrides without another state file.
  writePidRecord(null, config);
}

function configFromHealth(health) {
  if (!health || health.ok !== true || health.service !== "pocket-editor" || resolve(health.workspace || "") !== WORKSPACE) return {};
  return serviceConfig(health);
}

function mergeLaunchOptions(explicit, previous) {
  const requested = serviceConfig(explicit);
  const current = serviceConfig(previous);
  // A different explicit project starts a new binding. Do not pair it with
  // the prior project's Flutter consumer or package version by accident.
  const switchedProject = Object.hasOwn(requested, "projectRoot") && requested.projectRoot !== current.projectRoot;
  const base = { ...current };
  if (switchedProject) {
    delete base.flutterRoot;
    delete base.updatePackageVersion;
  }
  return { ...base, ...requested };
}

async function readHealth() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(750) });
    return response.ok ? await response.json() : undefined;
  } catch { return undefined; }
}

async function waitForHealth(timeoutMs = 30000, expectedVersion = undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readHealth();
    if (health?.ok === true && health.service === "pocket-editor" && resolve(health.workspace || "") === WORKSPACE) {
      if (!expectedVersion || health.version === expectedVersion) return true;
    }
    await sleep(250);
  }
  return false;
}

async function startChild(options, toolEnv, bun) {
  mkdirSync(dirname(LOG), { recursive: true });
  const logFd = openSync(LOG, "a");
  const env = { ...toolEnv, POCKET_EDITOR_PORT: String(PORT), POCKET_EDITOR_UPDATE_PORT: String(PORT) };
  // Remove inherited service bindings before applying the selected config;
  // otherwise a changed explicit project can silently retain an old root.
  delete env.POCKET_EDITOR_PROJECT_ROOT;
  delete env.POCKET_EDITOR_FLUTTER_ROOT;
  delete env.POCKET_EDITOR_PACKAGE_VERSION;
  if (options.projectRoot) env.POCKET_EDITOR_PROJECT_ROOT = options.projectRoot;
  if (options.flutterRoot) env.POCKET_EDITOR_FLUTTER_ROOT = options.flutterRoot;
  if (options.updatePackageVersion) env.POCKET_EDITOR_PACKAGE_VERSION = options.updatePackageVersion;
  if (options.compilerPath) env.POCKET_COMPILER_PATH = options.compilerPath;
  if (options.nativeProbe) env.POCKET_NATIVE_PROBE = options.nativeProbe;
  let child;
  try {
    child = spawn(bun, [SERVER, `--host=${HOST}`, `--port=${PORT}`, `--workspace=${WORKSPACE}`], {
      cwd: CHECKOUT_ROOT, detached: true, windowsHide: true, env,
      stdio: ["ignore", logFd, logFd],
    });
  } finally { closeSync(logFd); }
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", error => reject(new Error(`无法启动 Bun：${error.message}`)));
  });
  child.unref();
  writePidRecord(child.pid, options);
  return child;
}

async function restart(explicitOptions) {
  const record = readPidRecord();
  const previous = { ...(record?.config ?? {}), ...configFromHealth(await readHealth()) };
  const options = mergeLaunchOptions(explicitOptions, previous);
  for (const root of [options.projectRoot, options.flutterRoot].filter(Boolean)) {
    if (!existsSync(root)) throw new Error(`项目目录不存在：${root}`);
  }
  await assertPortOwnership(PORT, false);
  cleanupLegacyLaunchd();
  await stopOwnedPort(PORT, true);
  for (const port of LEGACY_PORTS) await stopOwnedPort(port, false);
  const recovered = recoverInterruptedSdkUpgrade(SDK_ROOT);
  if (recovered && process.env.POCKET_UPGRADE_RECOVERY_REEXEC !== "1") {
    writeStoppedRecord(options);
    const reexec = spawnSync(
      process.execPath,
      [join(SDK_ROOT, "scripts", "editor_service.mjs"), ...process.argv.slice(2)],
      {
        cwd: CHECKOUT_ROOT,
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, POCKET_UPGRADE_RECOVERY_REEXEC: "1" },
      },
    );
    if (reexec.error) throw reexec.error;
    if (reexec.status !== 0) process.exit(reexec.status ?? 1);
    return;
  }
  const toolEnv = editorToolEnvironment(options, SDK_ROOT);
  const bun = toolEnv.POCKET_BUN || toolEnv.POCKET_EDITOR_BUN || "bun";
  const runtime = spawnSync(bun, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (runtime.status !== 0) throw new Error("npm Bun 不可用，请执行 npm run setup");
  await startChild(options, toolEnv, bun);
  if (!(await waitForHealth())) {
    await stopOwnedPort(PORT, true).catch(() => {});
    writeStoppedRecord(options);
    throw new Error(`Studio 在固定端口 ${PORT} 启动失败，请查看 ${LOG}`);
  }
  console.log(`Pocket Studio 已重启：http://${HOST}:${PORT}`);
  console.log(`项目：${options.projectRoot || "未指定（通用 SDK）"}`);
  console.log(`日志：${LOG}`);
}

async function stop() {
  const record = readPidRecord();
  const previous = { ...(record?.config ?? {}), ...configFromHealth(await readHealth()) };
  await assertPortOwnership(PORT, false);
  cleanupLegacyLaunchd();
  await stopOwnedPort(PORT, true);
  for (const port of LEGACY_PORTS) await stopOwnedPort(port, false);
  writeStoppedRecord(previous);
  console.log("Pocket Studio 已停止（8791 及同仓库旧端口已清理）");
}

async function status() {
  const state = await assertPortOwnership(PORT, false);
  const record = readPidRecord();
  if (state.owned.length) {
    if (!(await waitForHealth(1500))) throw new Error(`Studio 进程存在但健康检查失败，请执行 npm restart。日志：${LOG}`);
    console.log(`Pocket Studio 运行中：http://${HOST}:${PORT} PID=${state.owned.map(info => info.pid).join(",")}`);
    if (record && state.owned.some(info => Number(info.pid) === record.pid)) console.log(`PID 文件已验证：${PID_FILE}`);
    return;
  }
  console.log(`Pocket Studio 未运行：固定端口 ${PORT} 空闲`);
  for (const port of LEGACY_PORTS) {
    const legacy = await findPortProcesses(port);
    if (legacy.length) console.log(`旧端口 ${port} 仍有监听；执行 restart 清理同仓库进程`);
  }
  process.exitCode = 1;
}

async function upgradeApply(upgradeParams = {}, runtimeOptions = {}) {
  const sdkRoot = resolve(runtimeOptions.sdkRoot || SDK_ROOT);
  const { stageDir, targetVersion, handoffToken } = upgradeParams;
  if (!stageDir || !targetVersion) throw new Error("upgrade-apply 需要 --stage-dir 与 --target-version");
  const resolvedStageDir = resolve(stageDir);
  const releaseLock = acquireUpgradeApplyLock(sdkRoot, {
    phase: "applying",
    targetVersion,
    stageDir: resolvedStageDir,
    ...(handoffToken ? { handoffToken } : {}),
  });
  try {
    const installed = readInstalledSdkInfo(sdkRoot);
    if (installed.mode !== "standalone") {
      throw new Error("源码检出或 Git 工作区模式不支持自动覆盖升级");
    }
    const previousVersion = installed.currentVersion;
    validateStagedStandaloneSdk(resolvedStageDir, targetVersion);
    const healthTimeoutMs = runtimeOptions.healthTimeoutMs ?? Number(process.env.POCKET_STUDIO_UPGRADE_HEALTH_TIMEOUT_MS || 30000);

    const record = readPidRecord();
    const previousConfig = { ...(record?.config ?? {}), ...configFromHealth(await readHealth()) };
    const options = mergeLaunchOptions({}, previousConfig);
    const backupDir = join(sdkRoot, ".pocket-build", `sdk-upgrade-backup-${previousVersion}`);

    await assertPortOwnership(PORT, false);
    // Validate and complete backup BEFORE stopping the running service so an
    // incomplete backup never leaves the user with a stopped service or wiped files.
    prepareSdkUpgradeBackup(sdkRoot, resolvedStageDir, backupDir);
    if (!isSdkBackupComplete(backupDir)) {
      throw new Error("升级前完整备份未能完成，已中止服务停止与文件变更");
    }

    if (handoffToken) {
      // Allow the parent Studio HTTP response to flush before stopping the old service.
      await sleep(150);
    }

    cleanupLegacyLaunchd();
    await stopOwnedPort(PORT, true);
    for (const port of LEGACY_PORTS) await stopOwnedPort(port, false);

    let filesMutated = false;
    try {
      filesMutated = true;
      applyStagedSdkFiles(sdkRoot, resolvedStageDir, backupDir);
      const toolEnv = editorToolEnvironment(options, sdkRoot);
      const bun = toolEnv.POCKET_BUN || toolEnv.POCKET_EDITOR_BUN || "bun";
      await startChild(options, toolEnv, bun);
      if (!(await waitForHealth(healthTimeoutMs, targetVersion))) {
        throw new Error(`升级到 v${targetVersion} 后 Studio 健康检查或版本确认失败`);
      }
      writePersistedUpgradeStatus(sdkRoot, {
        status: "up-to-date",
        previousVersion,
        currentVersion: targetVersion,
        latestVersion: targetVersion,
        appliedAt: new Date().toISOString(),
        rolledBack: false,
        error: null,
      });
      rmSync(resolvedStageDir, FS_REMOVE_OPTIONS);
      rmSync(backupDir, FS_REMOVE_OPTIONS);
      console.log(`Pocket Studio 已升级并重启至 v${targetVersion}：http://${HOST}:${PORT}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await stopOwnedPort(PORT, true).catch(() => {});
      if (!filesMutated || !isSdkBackupComplete(backupDir)) {
        writePersistedUpgradeStatus(sdkRoot, {
          status: "error",
          previousVersion,
          currentVersion: previousVersion,
          latestVersion: targetVersion,
          rolledBack: false,
          error: `升级中止（未应用破坏性更改）：${reason}`,
          updatedAt: new Date().toISOString(),
        });
        rmSync(resolvedStageDir, FS_REMOVE_OPTIONS);
        rmSync(backupDir, FS_REMOVE_OPTIONS);
        throw error;
      }
      try {
        restoreBackedUpSdkFiles(sdkRoot, backupDir);
      } catch (restoreError) {
        writePersistedUpgradeStatus(sdkRoot, {
          status: "error",
          previousVersion,
          currentVersion: previousVersion,
          latestVersion: targetVersion,
          rolledBack: false,
          error: `升级失败且文件回滚异常：${reason} / ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      let rollbackHealthy = false;
      let rollbackStartError = "";
      try {
        const rollbackEnv = editorToolEnvironment(options, sdkRoot);
        const rollbackBun = rollbackEnv.POCKET_BUN || rollbackEnv.POCKET_EDITOR_BUN || "bun";
        await startChild(options, rollbackEnv, rollbackBun);
        rollbackHealthy = Boolean(await waitForHealth(healthTimeoutMs, previousVersion));
      } catch (startErr) {
        rollbackStartError = startErr instanceof Error ? startErr.message : String(startErr);
      }
      if (!rollbackHealthy) {
        writePersistedUpgradeStatus(sdkRoot, {
          status: "error",
          previousVersion,
          currentVersion: previousVersion,
          latestVersion: targetVersion,
          rolledBack: false,
          error: `升级至 v${targetVersion} 失败，文件已恢复到 v${previousVersion}，但旧版服务重启健康检查未通过${rollbackStartError ? `（${rollbackStartError}）` : ""}：${reason}`,
          updatedAt: new Date().toISOString(),
        });
        rmSync(resolvedStageDir, FS_REMOVE_OPTIONS);
        rmSync(backupDir, FS_REMOVE_OPTIONS);
        throw new Error(`升级失败且回滚后服务未就绪：${reason}`);
      }
      writePersistedUpgradeStatus(sdkRoot, {
        status: "error",
        previousVersion,
        currentVersion: previousVersion,
        latestVersion: targetVersion,
        rolledBack: true,
        error: `升级至 v${targetVersion} 失败，已自动回滚到 v${previousVersion}：${reason}`,
        updatedAt: new Date().toISOString(),
      });
      rmSync(resolvedStageDir, FS_REMOVE_OPTIONS);
      rmSync(backupDir, FS_REMOVE_OPTIONS);
      throw new Error(`升级失败并已回滚到 v${previousVersion}：${reason}`);
    }
  } finally {
    releaseLock();
  }
}

function parseArgs(argv, env = process.env) {
  const args = [...argv];
  const command = ["start", "restart", "stop", "status", "upgrade-apply"].includes(args[0]) ? args.shift() : "restart";
  const options = {};
  const upgrade = {};
  for (const arg of args) {
    if (arg.startsWith("--project-root=")) options.projectRoot = resolve(arg.slice("--project-root=".length));
    else if (arg.startsWith("--flutter-root=")) options.flutterRoot = resolve(arg.slice("--flutter-root=".length));
    else if (arg.startsWith("--update-package-version=")) options.updatePackageVersion = arg.slice("--update-package-version=".length);
    else if (command === "upgrade-apply" && arg.startsWith("--stage-dir=")) upgrade.stageDir = resolve(arg.slice("--stage-dir=".length));
    else if (command === "upgrade-apply" && arg.startsWith("--target-version=")) upgrade.targetVersion = arg.slice("--target-version=".length).trim();
    else if (command === "upgrade-apply" && arg.startsWith("--handoff-token=")) upgrade.handoffToken = arg.slice("--handoff-token=".length).trim();
    else if (arg.startsWith("--port=")) {
      if (arg.slice("--port=".length) !== String(PORT)) throw new Error("Studio 固定使用 8791，不能指定其他端口");
    } else throw new Error(`未知参数：${arg}`);
  }
  if (command === "upgrade-apply") {
    upgrade.handoffToken ??= env.POCKET_UPGRADE_HANDOFF_TOKEN?.trim() || undefined;
  }
  options.projectRoot ??= env.POCKET_EDITOR_PROJECT_ROOT || undefined;
  options.flutterRoot ??= env.POCKET_EDITOR_FLUTTER_ROOT || undefined;
  options.updatePackageVersion ??= env.POCKET_EDITOR_PACKAGE_VERSION || undefined;
  options.compilerPath = env.POCKET_COMPILER_PATH || undefined;
  options.nativeProbe = env.POCKET_NATIVE_PROBE || undefined;
  return { command, options: serviceConfig(options), upgrade };
}

async function main() {
  checkFixedEnvironment();
  const { command, options, upgrade } = parseArgs(process.argv.slice(2));
  if (command === "status") return status();
  if (command === "stop") return stop();
  if (command === "upgrade-apply") return upgradeApply(upgrade);
  // Both start and restart intentionally replace the current same-checkout
  // process so source and native helper changes are picked up immediately.
  return restart(options);
}

function isEntrypoint(entry = process.argv[1], moduleUrl = import.meta.url) {
  if (!entry) return false;
  const entryPath = resolve(entry);
  const modulePath = resolve(fileURLToPath(moduleUrl));
  if (entryPath === modulePath) return true;
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

export { configFromHealth, editorToolEnvironment, isEntrypoint, makePidRecord, mergeLaunchOptions, parseArgs, parsePidRecord, serviceConfig, upgradeApply };

if (isEntrypoint()) {
  main().catch(error => {
    console.error(`Pocket Studio：${error?.message || error}`);
    process.exitCode = 1;
  });
}
