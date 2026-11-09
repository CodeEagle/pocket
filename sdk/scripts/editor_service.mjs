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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prebuiltEnvironment } from "./prebuilt_tools.mjs";
import { nativeProbeCandidates, nativeProbeSourceInputs, selectNativeProbe } from "./native_probe_path.ts";

const require = createRequire(import.meta.url);
const findProcess = require("find-process").default;
const treeKill = require("tree-kill");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(SCRIPT_DIR, "..");
const CHECKOUT_ROOT = resolve(SDK_ROOT, "..");
const SERVER = join(SDK_ROOT, "editor", "server.ts");
const HOST = "127.0.0.1";
const PORT = 8791;
const LEGACY_PORTS = [8790, 8792, 8793];
const WORKSPACE = join(SDK_ROOT, ".pocket-build", "editor-workspace-8791");
const LOG = join(SDK_ROOT, ".pocket-build", "editor-service-8791.log");
const PID_FILE = join(SDK_ROOT, ".pocket-build", "editor-service-8791.pid.json");
const PATH_HASH = sha256Path(SDK_ROOT).slice(0, 16);
const HEALTH_URL = `http://${HOST}:${PORT}/health`;

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
function editorToolEnvironment() {
  if (process.env.POCKET_SOURCE_BUILD === "1") return process.env;
  const toolEnv = prebuiltEnvironment(SDK_ROOT);
  if (process.env.POCKET_NATIVE_PROBE?.trim()) return toolEnv;

  const candidates = nativeProbeCandidates(SDK_ROOT);
  if (!candidates.some(candidate => existsSync(candidate))) return toolEnv;
  const probe = selectNativeProbe({
    candidates,
    sourceInputs: nativeProbeSourceInputs(SDK_ROOT),
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
  if (record && !state.owned.some(info => Number(info.pid) === record.pid)) {
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

function readPidRecord() {
  try {
    const record = JSON.parse(readFileSync(PID_FILE, "utf8"));
    if (record.server !== SERVER || record.workspace !== WORKSPACE || !Number.isInteger(record.pid)) return undefined;
    return record;
  } catch { return undefined; }
}

function writePidRecord(pid) {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, `${JSON.stringify({ pid, server: SERVER, workspace: WORKSPACE, port: PORT, startedAt: new Date().toISOString() }, null, 2)}\n`);
}

function clearPidRecord() {
  try { rmSync(PID_FILE, { force: true }); } catch { /* best effort */ }
}

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(750) });
      const health = response.ok ? await response.json() : {};
      if (health.ok === true && health.service === "pocket-editor" && resolve(health.workspace || "") === WORKSPACE) return true;
    } catch { /* startup is still in progress */ }
    await sleep(250);
  }
  return false;
}

async function startChild(options, toolEnv, bun) {
  mkdirSync(dirname(LOG), { recursive: true });
  const logFd = openSync(LOG, "a");
  const env = { ...toolEnv, POCKET_EDITOR_PORT: String(PORT), POCKET_EDITOR_UPDATE_PORT: String(PORT) };
  if (options.projectRoot) env.POCKET_EDITOR_PROJECT_ROOT = options.projectRoot;
  if (options.flutterRoot) env.POCKET_EDITOR_FLUTTER_ROOT = options.flutterRoot;
  if (options.updatePackageVersion) env.POCKET_EDITOR_PACKAGE_VERSION = options.updatePackageVersion;
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
  writePidRecord(child.pid);
  return child;
}

async function restart(options) {
  const toolEnv = editorToolEnvironment();
  const bun = toolEnv.POCKET_BUN || toolEnv.POCKET_EDITOR_BUN || "bun";
  const runtime = spawnSync(bun, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (runtime.status !== 0) throw new Error("npm Bun 不可用，请执行 npm run setup");
  for (const root of [options.projectRoot, options.flutterRoot].filter(Boolean)) {
    if (!existsSync(root)) throw new Error(`项目目录不存在：${root}`);
  }
  await assertPortOwnership(PORT, false);
  cleanupLegacyLaunchd();
  await stopOwnedPort(PORT, true);
  for (const port of LEGACY_PORTS) await stopOwnedPort(port, false);
  clearPidRecord();
  await startChild(options, toolEnv, bun);
  if (!(await waitForHealth())) {
    await stopOwnedPort(PORT, true).catch(() => {});
    clearPidRecord();
    throw new Error(`Studio 在固定端口 ${PORT} 启动失败，请查看 ${LOG}`);
  }
  console.log(`Pocket Studio 已重启：http://${HOST}:${PORT}`);
  console.log(`项目：${options.projectRoot || "未指定（通用 SDK）"}`);
  console.log(`日志：${LOG}`);
}

async function stop() {
  await assertPortOwnership(PORT, false);
  cleanupLegacyLaunchd();
  await stopOwnedPort(PORT, true);
  for (const port of LEGACY_PORTS) await stopOwnedPort(port, false);
  clearPidRecord();
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

function parseArgs(argv) {
  const args = [...argv];
  const command = ["start", "restart", "stop", "status"].includes(args[0]) ? args.shift() : "restart";
  const options = {};
  for (const arg of args) {
    if (arg.startsWith("--project-root=")) options.projectRoot = resolve(arg.slice("--project-root=".length));
    else if (arg.startsWith("--flutter-root=")) options.flutterRoot = resolve(arg.slice("--flutter-root=".length));
    else if (arg.startsWith("--update-package-version=")) options.updatePackageVersion = arg.slice("--update-package-version=".length);
    else if (arg.startsWith("--port=")) {
      if (arg.slice("--port=".length) !== String(PORT)) throw new Error("Studio 固定使用 8791，不能指定其他端口");
    } else throw new Error(`未知参数：${arg}`);
  }
  options.projectRoot ??= process.env.POCKET_EDITOR_PROJECT_ROOT || undefined;
  options.flutterRoot ??= process.env.POCKET_EDITOR_FLUTTER_ROOT || undefined;
  options.updatePackageVersion ??= process.env.POCKET_EDITOR_PACKAGE_VERSION || undefined;
  if (options.projectRoot) options.projectRoot = resolve(options.projectRoot);
  if (options.flutterRoot) options.flutterRoot = resolve(options.flutterRoot);
  return { command, options };
}

async function main() {
  checkFixedEnvironment();
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "status") return status();
  if (command === "stop") return stop();
  // Both start and restart intentionally replace the current same-checkout
  // process so source and native helper changes are picked up immediately.
  return restart(options);
}

main().catch(error => {
  console.error(`Pocket Studio：${error?.message || error}`);
  process.exitCode = 1;
});
