#!/usr/bin/env node
/**
 * Cross-platform Pocket Studio service manager.
 *
 * Studio owns port 8791 on the local and LAN interfaces. Process discovery is
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
  applySourceReleaseTools,
  applyStagedSdkFiles,
  inspectSourceUpdate,
  isSdkBackupComplete,
  prepareSourceUpgradeBackup,
  prepareSdkUpgradeBackup,
  readInstalledSdkInfo,
  readPersistedUpgradeStatus,
  recoverInterruptedSdkUpgrade,
  restoreSourceUpgrade,
  restoreBackedUpSdkFiles,
  validateSourceReleaseStage,
  validateStagedStandaloneSdk,
  writePersistedUpgradeStatus,
} from "./studio_upgrade.mjs";
import { nativeProbeCandidates, nativeProbeSourceInputs, selectNativeProbe } from "./native_probe_path.ts";
import { chooseUpdateHost } from "../editor/update_endpoint.ts";

const require = createRequire(import.meta.url);
const findProcess = require("find-process").default;
const treeKill = require("tree-kill");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(SCRIPT_DIR, "..");
const CHECKOUT_ROOT = resolve(SDK_ROOT, "..");
const SERVER = join(SDK_ROOT, "editor", "server.ts");
const HOST = "127.0.0.1";
const BIND_HOST = "0.0.0.0";
const STANDALONE_FIXTURE_PORT =
  process.env.POCKET_STUDIO_TEST_PORT &&
  existsSync(join(SDK_ROOT, ".pocket-studio-test-fixture")) &&
  !existsSync(join(CHECKOUT_ROOT, ".git")) &&
  !existsSync(join(SDK_ROOT, "editor", "test"))
    ? Number(process.env.POCKET_STUDIO_TEST_PORT)
    : null;
const SOURCE_FIXTURE_PORT =
  process.env.POCKET_STUDIO_TEST_SOURCE_GIT === "1" &&
  process.env.POCKET_STUDIO_TEST_PORT &&
  existsSync(join(SDK_ROOT, ".pocket-studio-source-test-fixture")) &&
  existsSync(join(CHECKOUT_ROOT, ".git"))
    ? Number(process.env.POCKET_STUDIO_TEST_PORT)
    : null;
const FIXTURE_PORT = STANDALONE_FIXTURE_PORT ?? SOURCE_FIXTURE_PORT;
const PORT =
  Number.isInteger(FIXTURE_PORT) && FIXTURE_PORT > 0 && FIXTURE_PORT <= 65535
    ? FIXTURE_PORT
    : 8791;
const LEGACY_PORTS = FIXTURE_PORT ? [] : [8790, 8792, 8793];
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
function printLanAddress() {
  try { console.log(`局域网：http://${chooseUpdateHost()}:${PORT}`); }
  catch { /* A LAN interface is optional; loopback remains available. */ }
}
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
function editorToolEnvironment(options = {}, sdkRoot = SDK_ROOT, env = process.env, { preferSourceProbe = true } = {}) {
  const resolvedSdkRoot = resolve(options?.sdkRoot || sdkRoot || SDK_ROOT);
  const explicitCompiler = options.compilerPath || env.POCKET_COMPILER_PATH;
  const explicitProbe = options.nativeProbe || env.POCKET_NATIVE_PROBE;
  const explicitOverrides = {};
  if (explicitCompiler?.trim()) explicitOverrides.POCKET_COMPILER_PATH = resolve(explicitCompiler);
  if (explicitProbe?.trim()) explicitOverrides.POCKET_NATIVE_PROBE = resolve(explicitProbe);
  if (env.POCKET_SOURCE_BUILD === "1") return { ...env, ...explicitOverrides };
  const toolEnv = prebuiltEnvironment(resolvedSdkRoot, env);
  // Preserve the two supported explicit tool overrides. The npm defaults stay
  // in place when neither is supplied.
  if (explicitOverrides.POCKET_NATIVE_PROBE) return { ...toolEnv, ...explicitOverrides };
  if (explicitOverrides.POCKET_COMPILER_PATH) toolEnv.POCKET_COMPILER_PATH = explicitOverrides.POCKET_COMPILER_PATH;

  if (!preferSourceProbe) return toolEnv;
  const candidates = nativeProbeCandidates(resolvedSdkRoot);
  if (!candidates.some(candidate => existsSync(candidate))) return toolEnv;
  const probe = selectNativeProbe({
    candidates,
    sourceInputs: nativeProbeSourceInputs(resolvedSdkRoot),
  });
  return { ...toolEnv, POCKET_NATIVE_PROBE: probe };
}

function resolvesInside(path, root) {
  if (!path) return false;
  if (inside(path, root)) return true;
  const canonical = process.platform === "win32" ? (realpathSync.native || realpathSync) : realpathSync;
  try { return inside(canonical(path), canonical(root)); }
  catch { return false; }
}

function sourceUpgradeLaunch(options, sdkRoot, env = process.env, buildEnvironment = editorToolEnvironment) {
  const resolvedRoot = resolve(sdkRoot);
  const checkoutRoot = resolve(resolvedRoot, "..");
  const launchOptions = { ...options };
  const launchEnv = { ...env };
  // A source upgrade changes the files behind in-checkout tool paths. Select
  // the verified package matching the new checkout instead, while preserving
  // explicit tools that live outside this repository.
  for (const [optionKey, envKey] of [["compilerPath", "POCKET_COMPILER_PATH"], ["nativeProbe", "POCKET_NATIVE_PROBE"]]) {
    if (resolvesInside(launchOptions[optionKey], checkoutRoot)) delete launchOptions[optionKey];
    if (resolvesInside(launchEnv[envKey], checkoutRoot)) delete launchEnv[envKey];
  }
  delete launchEnv.POCKET_SOURCE_BUILD;
  delete launchEnv.POCKET_SOURCE_UPGRADE_RECOVERY;
  const toolEnv = buildEnvironment(launchOptions, resolvedRoot, launchEnv, { preferSourceProbe: false });
  // Persist the exact tools selected for this source revision. A later normal
  // restart must not rediscover an older in-repository native/target probe.
  for (const [optionKey, envKey] of [["compilerPath", "POCKET_COMPILER_PATH"], ["nativeProbe", "POCKET_NATIVE_PROBE"]]) {
    if (typeof toolEnv[envKey] === "string" && toolEnv[envKey].trim()) {
      launchOptions[optionKey] = resolve(toolEnv[envKey]);
    }
  }
  return {
    options: launchOptions,
    toolEnv,
  };
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

function sameFileSystemPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (normalized(resolve(left)) === normalized(resolve(right))) return true;
  const canonical = process.platform === "win32" ? (realpathSync.native || realpathSync) : realpathSync;
  try { return normalized(canonical(left)) === normalized(canonical(right)); }
  catch { return false; }
}

function commandIncludesPath(command, expectedPath) {
  if (normalized(command).includes(normalized(expectedPath))) return true;
  // Windows may report an 8.3 path in one process and a long path in another.
  // Compare actual files; a matching basename alone is never sufficient ownership.
  for (const match of String(command).matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const candidate = match[1] || match[2] || match[3];
    if (!candidate || !candidate.replaceAll("\\", "/").endsWith("/editor/server.ts")) continue;
    if (sameFileSystemPath(candidate, expectedPath)) return true;
  }
  return false;
}

function sameCheckoutServer(info, expectedPort) {
  const pid = Number(info?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = normalized(processCommand(info));
  let pathMatch = commandIncludesPath(processCommand(info), SERVER);
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
    if (STANDALONE_FIXTURE_PORT) console.error("[upgrade ownership]", JSON.stringify({ server: SERVER, foreign }));
    throw new Error(`端口 ${port} 已被其他程序占用（PID ${foreign.map(info => info.pid).join(", ")}），不会接管或换端口`);
  }
  return { processes, owned: processes.filter(info => sameCheckoutServer(info, port)), foreign };
}

// Keep the detached updater alive while retiring its old Studio process and
// unrelated worker branches.
function protectedRetirementPlan(processes, targetPid, protectedPid, onReject) {
  const reject = (reason, details = {}) => {
    onReject?.({ reason, ...details });
    return null;
  };
  if (!Array.isArray(processes)) {
    return reject("process-snapshot-not-array", {
      snapshotType: processes === null ? "null" : typeof processes,
    });
  }
  const target = Number(targetPid);
  const protectedPidNumber = Number(protectedPid);
  if (
    !Number.isInteger(target) || target <= 0
    || !Number.isInteger(protectedPidNumber) || protectedPidNumber <= 0
  ) {
    return reject("invalid-retirement-pid", {
      targetPid: Number.isInteger(target) ? target : null,
      protectedPid: Number.isInteger(protectedPidNumber) ? protectedPidNumber : null,
    });
  }
  if (target === protectedPidNumber) {
    return reject("target-is-protected-process", { targetPid: target });
  }

  const parents = new Map();
  const rowByPid = new Map();
  const children = new Map();
  const describeInvalidValue = value => ({
    type: value === null ? "null" : typeof value,
    ...(typeof value === "number" && Number.isFinite(value) ? { value } : {}),
  });
  for (let index = 0; index < processes.length; index += 1) {
    const info = processes[index];
    if (info === null || typeof info !== "object") {
      return reject("invalid-process-row", {
        row: index,
        rowType: info === null ? "null" : typeof info,
      });
    }
    const pid = Number(info?.pid);
    const ppid = Number(info?.ppid);
    const invalidFields = [];
    if (info.pid == null || !Number.isInteger(pid) || pid < 0) {
      invalidFields.push({ field: "pid", ...describeInvalidValue(info.pid) });
    }
    if (info.ppid == null || !Number.isInteger(ppid) || ppid < 0) {
      invalidFields.push({ field: "ppid", ...describeInvalidValue(info.ppid) });
    }
    if (invalidFields.length) {
      return reject("invalid-process-row", { row: index, fields: invalidFields });
    }
    if (
      parents.has(pid)
    ) {
      return reject("duplicate-process-pid", {
        pid,
        rows: [rowByPid.get(pid), index],
      });
    }
    parents.set(pid, ppid);
    rowByPid.set(pid, index);
    children.set(pid, []);
  }

  if (!parents.has(target)) {
    return reject("target-missing-from-process-snapshot", { targetPid: target });
  }
  if (!parents.has(protectedPidNumber)) {
    return reject("protected-process-missing-from-snapshot", {
      protectedPid: protectedPidNumber,
    });
  }
  for (const [pid, ppid] of parents) {
    if (pid !== 0 && children.has(ppid)) children.get(ppid).push(pid);
  }

  const collectSubtree = rootPid => {
    const subtree = new Set();
    const pending = [[rootPid, [rootPid]]];
    while (pending.length) {
      const [pid, path] = pending.pop();
      if (subtree.has(pid)) {
        const cycleStart = path.indexOf(pid);
        return {
          cyclePids: path.slice(cycleStart),
        };
      }
      subtree.add(pid);
      for (const childPid of children.get(pid) || []) {
        pending.push([childPid, [...path, childPid]]);
      }
    }
    return { subtree };
  };

  const protectedResult = collectSubtree(protectedPidNumber);
  if (protectedResult.cyclePids) {
    return reject("protected-process-tree-cycle", {
      cyclePids: protectedResult.cyclePids,
    });
  }
  const protectedSubtree = protectedResult.subtree;
  if (protectedSubtree.has(target)) {
    return reject("target-is-inside-protected-process-tree", {
      targetPid: target,
      protectedPid: protectedPidNumber,
    });
  }

  // Retire the target tree from leaves upward, but exclude the protected
  // process and every child visible beneath it in this same process snapshot.
  // Sending one signal per PID avoids platform tree-kill APIs (notably
  // Windows taskkill /T) whose recursion can outlive or reinterpret PPID links.
  const pids = [];
  const visiting = new Set();
  const visitingPath = [];
  const visited = new Set();
  const appendPostorder = pid => {
    if (visiting.has(pid)) {
      const cycleStart = visitingPath.indexOf(pid);
      return [...visitingPath.slice(cycleStart), pid];
    }
    if (visited.has(pid)) return true;
    visiting.add(pid);
    visitingPath.push(pid);
    for (const childPid of children.get(pid) || []) {
      if (protectedSubtree.has(childPid)) continue;
      const result = appendPostorder(childPid);
      if (result !== true) return result;
    }
    visiting.delete(pid);
    visitingPath.pop();
    visited.add(pid);
    pids.push(pid);
    return true;
  };
  const appendResult = appendPostorder(target);
  if (appendResult !== true) {
    return reject("target-process-tree-cycle", { cyclePids: appendResult });
  }
  return { pids };
}

function signalProcess(pid, signal) {
  try { process.kill(Number(pid), signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function processSnapshotDetails(processes, targetPid, protectedPid) {
  const byPid = new Map((Array.isArray(processes) ? processes : []).map(info => [Number(info?.pid), Number(info?.ppid)]));
  const protectedAncestry = [];
  let ancestor = Number(protectedPid);
  const seen = new Set();
  while (Number.isInteger(ancestor) && ancestor > 0 && !seen.has(ancestor) && protectedAncestry.length < 16) {
    seen.add(ancestor);
    const parent = byPid.get(ancestor);
    protectedAncestry.push({ pid: ancestor, ppid: Number.isInteger(parent) ? parent : null });
    if (!Number.isInteger(parent) || parent <= 0) break;
    ancestor = parent;
  }
  const target = Number(targetPid);
  const targetParent = byPid.get(target);
  return {
    target: { pid: target, ppid: Number.isInteger(targetParent) ? targetParent : null },
    protectedAncestry,
  };
}

function protectedProcessSnapshotError(processes, targetPid, protectedPid, rejection) {
  return new Error(
    `拒绝停止进程 ${targetPid}：updater ${protectedPid} 的进程快照无效或存在祖先冲突 `
    + `${JSON.stringify(rejection || { reason: "unknown-snapshot-rejection" })} `
    + JSON.stringify(processSnapshotDetails(processes, targetPid, protectedPid)),
  );
}

async function killTree(pid, signal) {
  return new Promise(resolveKill => {
    try { treeKill(Number(pid), signal, () => resolveKill()); }
    catch { resolveKill(); }
  });
}

function processIsRunning(pid) {
  if (process.platform !== "win32") {
    try {
      const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
      return Boolean(state) && !/^[ZX]/.test(state);
    } catch (error) {
      if (error.status === 1) return false;
    }
  }
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function waitProcessesGone(pids, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.some(processIsRunning);
    if (!alive) return true;
    await sleep(250);
  }
  return !pids.some(processIsRunning);
}

function sameProcessSnapshotIdentity(expected, current) {
  if (Number(expected?.pid) <= 0 || Number(current?.pid) !== Number(expected.pid)) return false;
  const expectedCommand = String(expected?.cmd || expected?.cmdline || expected?.command || "").trim();
  const currentCommand = String(current?.cmd || current?.cmdline || current?.command || "").trim();
  const expectedBin = String(expected?.bin || "").trim();
  const currentBin = String(current?.bin || "").trim();
  const expectedName = String(expected?.name || "").trim();
  const currentName = String(current?.name || "").trim();
  if (expectedCommand && (!currentCommand || expectedCommand !== currentCommand)) return false;
  if (expectedBin && (!currentBin || normalized(expectedBin) !== normalized(currentBin))) return false;
  if (expectedName && currentName && normalized(expectedName) !== normalized(currentName)) return false;
  return Boolean((expectedCommand && currentCommand) || (expectedBin && currentBin));
}

async function signalVerifiedProcess(expected, signal, validateCurrent) {
  const pid = Number(expected?.pid);
  if (!processIsRunning(pid)) return false;

  const found = await findProcess("pid", pid);
  const current = Array.isArray(found) ? found.find(entry => Number(entry?.pid) === pid) : undefined;
  if (!current) {
    if (!processIsRunning(pid)) return false;
  } else if (sameProcessSnapshotIdentity(expected, current) && validateCurrent(expected, current)) {
    signalProcess(pid, signal);
    return true;
  }

  const currentPpid = Number(current?.ppid);
  throw new Error(
    `拒绝发送 ${signal} 给进程 ${pid}：无法确认其仍是初始快照中的目标 `
    + JSON.stringify({ expected: { pid, ppid: Number(expected.ppid) }, current: { pid: current ? Number(current.pid) : null, ppid: Number.isInteger(currentPpid) ? currentPpid : null } }),
  );
}

async function terminateProcessSet(processes, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500;
  const killTimeoutMs = options.killTimeoutMs ?? 2000;
  const validateCurrent = options.validateCurrent ?? (() => true);
  const unique = new Map();
  for (const info of processes) {
    const pid = Number(info?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || unique.has(pid)) continue;
    unique.set(pid, info);
  }
  const entries = [...unique.values()];
  const pids = entries.map(info => Number(info.pid));
  for (const info of entries) await signalVerifiedProcess(info, "SIGTERM", validateCurrent);
  if (await waitProcessesGone(pids, timeoutMs)) return true;

  for (const info of entries) await signalVerifiedProcess(info, "SIGKILL", validateCurrent);
  return waitProcessesGone(pids, killTimeoutMs);
}

async function stopOwnedPort(port, required, protectedPid) {
  const state = await assertPortOwnership(port, !required);
  const record = port === PORT ? readPidRecord() : undefined;
  if (record && Number.isInteger(record.pid) && !state.owned.some(info => Number(info.pid) === record.pid)) {
    const found = await findProcess("pid", record.pid);
    state.owned.push(...found.filter(info => sameCheckoutServer(info, port)));
  }
  if (!state.owned.length) return;
  const pids = state.owned.map(info => Number(info.pid));
  if (protectedPid) {
    const processes = await findProcess("name", "");
    const byPid = new Map((Array.isArray(processes) ? processes : []).map(info => [Number(info?.pid), info]));
    const planned = new Map();
    for (const pid of pids) {
      if (planned.has(pid)) continue;
      const target = byPid.get(pid);
      let rejection;
      const plan = protectedRetirementPlan(processes, pid, protectedPid, value => {
        rejection = value;
      });
      if (!target) {
        if (!processIsRunning(pid)) continue;
        throw protectedProcessSnapshotError(processes, pid, protectedPid, rejection);
      }
      if (!plan) throw protectedProcessSnapshotError(processes, pid, protectedPid, rejection);
      for (const plannedPid of plan.pids) {
        const info = byPid.get(plannedPid);
        if (!info) throw protectedProcessSnapshotError(processes, pid, protectedPid);
        if (!planned.has(plannedPid)) planned.set(plannedPid, info);
      }
    }
    const rootPids = new Set(pids);
    const terminated = await terminateProcessSet([...planned.values()], {
      validateCurrent: (expected, current) => !rootPids.has(Number(expected.pid)) || sameCheckoutServer(current, port),
    });
    const remaining = (await findPortProcesses(port)).filter(info => required || sameCheckoutServer(info, port));
    if (remaining.length || !terminated) {
      throw new Error(`端口 ${port} 的 Pocket Studio 进程没有退出`);
    }
    return;
  }
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
    if (!sameFileSystemPath(record.server, SERVER) || !sameFileSystemPath(record.workspace, WORKSPACE) || record.port !== PORT) return undefined;
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
  if (!health || health.ok !== true || health.service !== "pocket-editor" || !sameFileSystemPath(health.workspace, WORKSPACE)) return {};
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
    if (health?.ok === true && health.service === "pocket-editor" && sameFileSystemPath(health.workspace, WORKSPACE)) {
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
    child = spawn(bun, [SERVER, `--host=${BIND_HOST}`, `--port=${PORT}`, `--workspace=${WORKSPACE}`], {
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
  const sourceUpgradeRecovery = recovered?.mode === "source" || process.env.POCKET_SOURCE_UPGRADE_RECOVERY === "1";
  if (recovered && process.env.POCKET_UPGRADE_RECOVERY_REEXEC !== "1") {
    const recoveryOptions = sourceUpgradeRecovery ? sourceUpgradeLaunch(options, SDK_ROOT).options : options;
    writeStoppedRecord(recoveryOptions);
    const reexec = spawnSync(
      process.execPath,
      [join(SDK_ROOT, "scripts", "editor_service.mjs"), ...process.argv.slice(2)],
      {
        cwd: CHECKOUT_ROOT,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          POCKET_UPGRADE_RECOVERY_REEXEC: "1",
          ...(sourceUpgradeRecovery ? { POCKET_SOURCE_UPGRADE_RECOVERY: "1" } : {}),
        },
      },
    );
    if (reexec.error) throw reexec.error;
    if (reexec.status !== 0) process.exit(reexec.status ?? 1);
    return;
  }
  const launch = sourceUpgradeRecovery
    ? sourceUpgradeLaunch(options, SDK_ROOT)
    : { options, toolEnv: editorToolEnvironment(options, SDK_ROOT) };
  const toolEnv = launch.toolEnv;
  const bun = toolEnv.POCKET_BUN || toolEnv.POCKET_EDITOR_BUN || "bun";
  const runtime = spawnSync(bun, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (runtime.status !== 0) throw new Error("npm Bun 不可用，请执行 npm run setup");
  await startChild(launch.options, toolEnv, bun);
  if (!(await waitForHealth())) {
    await stopOwnedPort(PORT, true).catch(() => {});
    writeStoppedRecord(options);
    throw new Error(`Studio 在固定端口 ${PORT} 启动失败，请查看 ${LOG}`);
  }
  console.log(`Pocket Studio 已重启：http://${HOST}:${PORT}`);
  printLanAddress();
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
    printLanAddress();
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
  const sourceCommit = typeof upgradeParams.sourceCommit === "string" ? upgradeParams.sourceCommit.trim().toLowerCase() : "";
  if (!stageDir || !targetVersion) throw new Error("upgrade-apply 需要 --stage-dir 与 --target-version");
  const resolvedStageDir = resolve(stageDir);
  const releaseLock = acquireUpgradeApplyLock(sdkRoot, {
    phase: "applying",
    targetVersion,
    stageDir: resolvedStageDir,
    ...(sourceCommit ? { mode: "source", sourceCommit } : {}),
    ...(handoffToken ? { handoffToken } : {}),
  });
  try {
    const platform = runtimeOptions.platform ?? process.platform;
    const arch = runtimeOptions.arch ?? process.arch;
    const installed = readInstalledSdkInfo(sdkRoot, platform, arch);
    const sourceMode = installed.mode === "source";
    if (!sourceMode && installed.mode !== "standalone") throw new Error(`不支持的 SDK 安装模式：${installed.mode}`);
    if (sourceMode && !sourceCommit) throw new Error("源码自动升级缺少 --source-commit");
    if (!sourceMode && sourceCommit) throw new Error("独立 SDK 升级不能指定 --source-commit");
    const previousVersion = installed.currentVersion;
    validateStagedStandaloneSdk(resolvedStageDir, targetVersion, platform, arch);
    const sourceStage = sourceMode
      ? validateSourceReleaseStage(sdkRoot, sourceCommit, targetVersion, resolvedStageDir, platform, arch)
      : null;
    const healthTimeoutMs = runtimeOptions.healthTimeoutMs ?? Number(process.env.POCKET_STUDIO_UPGRADE_HEALTH_TIMEOUT_MS || 30000);
    const assertOwnership = runtimeOptions.assertPortOwnership ?? assertPortOwnership;
    const currentPidRecord = runtimeOptions.readPidRecord ?? readPidRecord;
    const currentHealth = runtimeOptions.readHealth ?? readHealth;

    const record = currentPidRecord();
    const previousConfig = { ...(record?.config ?? {}), ...configFromHealth(await currentHealth()) };
    const options = mergeLaunchOptions({}, previousConfig);
    const backupDir = join(sdkRoot, ".pocket-build", `sdk-upgrade-backup-${previousVersion}`);

    await assertOwnership(PORT, false);
    // Validate and complete backup BEFORE stopping the running service so an
    // incomplete backup never leaves the user with a stopped service or wiped files.
    if (sourceMode) {
      prepareSourceUpgradeBackup(sdkRoot, backupDir, {
        previousHead: sourceStage.head,
        targetCommit: sourceCommit,
        targetVersion,
      }, platform, arch);
    } else {
      prepareSdkUpgradeBackup(sdkRoot, resolvedStageDir, backupDir, platform, arch);
    }
    if (!isSdkBackupComplete(backupDir)) {
      throw new Error("升级前完整备份未能完成，已中止服务停止与文件变更");
    }

    if (handoffToken) {
      // Allow the parent Studio HTTP response to flush before stopping the old service.
      await sleep(150);
    }

    const retireOwnedPort = runtimeOptions.stopOwnedPort ?? stopOwnedPort;
    const removeLegacyLaunchAgents = runtimeOptions.cleanupLegacyLaunchd ?? cleanupLegacyLaunchd;
    try {
      removeLegacyLaunchAgents();
      await retireOwnedPort(PORT, true, process.pid);
      for (const port of LEGACY_PORTS) await retireOwnedPort(port, false);
    } catch (error) {
      // The SDK files are still untouched. Do not leave a complete backup for
      // startup recovery to mistake for an interrupted, applied upgrade.
      rmSync(backupDir, FS_REMOVE_OPTIONS);
      rmSync(resolvedStageDir, FS_REMOVE_OPTIONS);
      throw error;
    }

    let filesMutated = false;
    try {
      filesMutated = true;
      if (sourceMode) {
        const eligibility = inspectSourceUpdate(sdkRoot, sourceCommit);
        if (!eligibility.canApply || eligibility.head !== sourceStage.head || eligibility.repoRoot !== sourceStage.repoRoot) {
          throw new Error(eligibility.deferredReason || "源码工作区在停止服务后发生变化；未应用更新");
        }
        execFileSync("git", ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", sourceCommit], {
          cwd: sourceStage.repoRoot,
          encoding: "utf8",
          timeout: runtimeOptions.gitTimeoutMs ?? 120000,
          windowsHide: true,
        });
        applySourceReleaseTools(sdkRoot, sourceStage.stagedToolsDir, platform, arch);
      } else {
        applyStagedSdkFiles(sdkRoot, resolvedStageDir, backupDir, platform, arch);
      }
      const launch = sourceMode
        ? sourceUpgradeLaunch(options, sdkRoot, runtimeOptions.environment ?? process.env, runtimeOptions.editorToolEnvironment ?? editorToolEnvironment)
        : {
            options,
            toolEnv: (runtimeOptions.editorToolEnvironment ?? editorToolEnvironment)(options, sdkRoot),
          };
      const toolEnv = launch.toolEnv;
      const bun = toolEnv.POCKET_BUN || toolEnv.POCKET_EDITOR_BUN || "bun";
      await (runtimeOptions.startChild ?? startChild)(launch.options, toolEnv, bun);
      if (!(await (runtimeOptions.waitForHealth ?? waitForHealth)(healthTimeoutMs, targetVersion))) {
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
      printLanAddress();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await (runtimeOptions.stopOwnedPort ?? stopOwnedPort)(PORT, true).catch(() => {});
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
        if (sourceMode) restoreSourceUpgrade(sdkRoot, backupDir, sourceCommit, platform, arch);
        else restoreBackedUpSdkFiles(sdkRoot, backupDir, platform, arch);
      } catch (restoreError) {
        const currentVersionAfterRestoreFailure = readInstalledSdkInfo(sdkRoot, platform, arch).currentVersion;
        writePersistedUpgradeStatus(sdkRoot, {
          status: "error",
          previousVersion,
          currentVersion: currentVersionAfterRestoreFailure,
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
        const rollbackLaunch = sourceMode
          ? sourceUpgradeLaunch(options, sdkRoot, runtimeOptions.environment ?? process.env, runtimeOptions.editorToolEnvironment ?? editorToolEnvironment)
          : {
              options,
              toolEnv: (runtimeOptions.editorToolEnvironment ?? editorToolEnvironment)(options, sdkRoot),
            };
        const rollbackEnv = rollbackLaunch.toolEnv;
        const rollbackBun = rollbackEnv.POCKET_BUN || rollbackEnv.POCKET_EDITOR_BUN || "bun";
        await (runtimeOptions.startChild ?? startChild)(rollbackLaunch.options, rollbackEnv, rollbackBun);
        rollbackHealthy = Boolean(await (runtimeOptions.waitForHealth ?? waitForHealth)(healthTimeoutMs, previousVersion));
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
  } catch (error) {
    const status = readPersistedUpgradeStatus(sdkRoot);
    if (status?.status !== "error") {
      writePersistedUpgradeStatus(sdkRoot, {
        ...status,
        status: "error",
        latestVersion: targetVersion,
        rolledBack: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
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
    else if (command === "upgrade-apply" && arg.startsWith("--source-commit=")) upgrade.sourceCommit = arg.slice("--source-commit=".length).trim();
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
  return Boolean(entry && sameFileSystemPath(entry, fileURLToPath(moduleUrl)));
}

export { configFromHealth, editorToolEnvironment, isEntrypoint, commandIncludesPath, protectedRetirementPlan, terminateProcessSet, makePidRecord, mergeLaunchOptions, parseArgs, parsePidRecord, serviceConfig, upgradeApply };

if (isEntrypoint()) {
  main().catch(error => {
    console.error(`Pocket Studio：${error?.message || error}`);
    process.exitCode = 1;
  });
}
