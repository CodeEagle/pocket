#!/usr/bin/env node
/**
 * Windows release acceptance for the Node/npm Pocket SDK.
 *
 * This is intentionally a consumer-side smoke test. It validates an already
 * installed platform package and Noble N-API prebuild, then builds both shipped templates
 * with the npm-managed Bun and drives the real native Preview probe. No source
 * compiler, Rust, Python or C/C++ command is admitted here.
 *
 * Usage:
 *   node scripts/tests/windows_package_smoke.mjs --sdk-root=C:\path\sdk
 * The CI job installs the platform tarball before invoking this script.
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const sdkRoot = argument("sdk-root");
if (!sdkRoot) fail("--sdk-root=绝对路径 is required");
const root = resolve(sdkRoot);
if (process.platform !== "win32" || process.arch !== "x64") {
  fail(`Windows smoke must run on win32/x64 (current ${process.platform}/${process.arch})`);
}

const { prebuiltEnvironment, resolvePrebuiltTools, resolveManagedBun, platformPackageName, SDK_VERSION } =
  await import(pathToFileURL(join(root, "scripts/prebuilt_tools.mjs")).href);
const env = prebuiltEnvironment(root);
Object.assign(process.env, env);
const tools = resolvePrebuiltTools(root, env);
if (tools.manifest.platform !== "win32" || tools.manifest.arch !== "x64") {
  fail(`platform manifest is ${tools.manifest.platform}/${tools.manifest.arch}, expected win32/x64`);
}
if (tools.manifest.noble?.included !== true) {
  fail("the Windows platform package has no Noble prebuild; refusing a false Bluetooth acceptance");
}
if (tools.manifest.noble.prebuild !== "noble/prebuilds/win32-x64/node.napi.node") {
  fail(`unexpected Noble prebuild path: ${tools.manifest.noble.prebuild}`);
}

const requireFromSdk = createRequire(join(root, "package.json"));
let nobleRoot;
try {
  nobleRoot = dirname(requireFromSdk.resolve("@abandonware/noble/package.json"));
} catch (error) {
  fail(`@abandonware/noble is not installed: ${error instanceof Error ? error.message : String(error)}`);
}
const nodeGypBuild = requireFromSdk("node-gyp-build");
const binding = nodeGypBuild.resolve(nobleRoot);
const expectedBinding = join(tools.root, "noble", "prebuilds", "win32-x64", "node.napi.node");
if (resolve(binding).toLowerCase() !== resolve(expectedBinding).toLowerCase()) {
  fail(`Noble resolved outside the distributed prebuild: ${binding}`);
}
if (existsSync(join(nobleRoot, "build", "Release", "binding.node"))) {
  fail("Noble resolved a local build/Release binding; Windows acceptance must use the platform package");
}
try {
  const native = requireFromSdk(binding);
  if (typeof native?.NobleWinrt !== "function") {
    fail("Windows Noble binding loaded but did not export NobleWinrt");
  }
} catch (error) {
  fail(`Windows Noble N-API binding cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
}

const bun = resolveManagedBun(root, env);
const work = mkdtempSync(join(tmpdir(), "pocket-windows-smoke-"));
const projects = {};
const builds = {};
try {
  for (const template of ["app", "game"]) {
    const project = join(work, template);
    const output = join(work, `${template}-dist`);
    cpSync(join(root, "templates", template), project, { recursive: true });
    const result = spawnSync(bun, [
      join(root, "scripts/build_guest.ts"),
      `--project-root=${project}`,
      `--outdir=${output}`,
    ], { cwd: root, env, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) {
      fail(`${template} buildGuest failed (${result.status ?? "spawn"}):\n${result.stdout ?? ""}\n${result.stderr ?? result.error?.message ?? ""}`);
    }
    const bytecode = join(output, "app.qjbc");
    const pak = join(output, "app.pak");
    if (!isFile(bytecode) || !isFile(pak)) fail(`${template} did not emit app.qjbc and app.pak`);
    projects[template] = project;
    builds[template] = { bytecode, pak, qjbcBytes: statSync(bytecode).size, pakBytes: statSync(pak).size };
  }

  const previewScript = join(work, "preview-smoke.ts");
  writeFileSync(previewScript, previewSource(root, tools.probe, projects, builds));
  const preview = spawnSync(bun, [previewScript], { cwd: root, env, encoding: "utf8", windowsHide: true });
  if (preview.error || preview.status !== 0) {
    fail(`native Preview interaction failed (${preview.status ?? "spawn"}):\n${preview.stdout ?? ""}\n${preview.stderr ?? preview.error?.message ?? ""}`);
  }
  const report = parseReport(preview.stdout);
  console.log(JSON.stringify({
    ok: true,
    sdkVersion: SDK_VERSION,
    platformPackage: platformPackageName("win32", "x64"),
    toolsRoot: tools.root,
    nobleBinding: binding,
    nobleSourceBuildPresent: false,
    builds,
    preview: report,
  }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function parseReport(stdout) {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith("WINDOWS_PREVIEW_ACCEPTANCE "));
  if (!line) fail(`Preview did not emit WINDOWS_PREVIEW_ACCEPTANCE:\n${stdout}`);
  try { return JSON.parse(line.slice("WINDOWS_PREVIEW_ACCEPTANCE ".length)); }
  catch (error) { fail(`invalid Preview report: ${error instanceof Error ? error.message : String(error)}`); }
}

function previewSource(rootPath, probePath, projectMap, buildMap) {
  return `
import { strict as assert } from "node:assert";
import { createPreviewManager } from ${JSON.stringify(pathToFileURL(join(rootPath, "editor/preview.ts")).href)};
const probe = ${JSON.stringify(probePath)};
const projects = ${JSON.stringify(projectMap)};
const builds = ${JSON.stringify(buildMap)};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = [];
for (const template of ["app", "game"]) {
  const manager = createPreviewManager({ probePath: probe, projectDirectory: projects[template], width: 390, height: 844, idleDisposeMs: 60000,
    artifacts: { bytecode: builds[template].bytecode, pak: builds[template].pak, revision: 1, tickHz: 60 } });
  const url = suffix => "http://127.0.0.1/api/projects/" + template + "/preview/" + suffix;
  const call = (suffix, init) => manager.handle(new Request(url(suffix), init), template, suffix);
  const snapshot = async () => { const response = await call("snapshot"); assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.status.state, "ready", JSON.stringify(value.status)); return value.frame; };
  const has = (frame, text) => frame.ops.some(op => op.type === "text" && op.text === text);
  const waitFor = async predicate => { const deadline = Date.now() + 5000; do { const frame = await snapshot(); if (predicate(frame)) return frame; await wait(30); } while (Date.now() < deadline); throw new Error("Preview frame did not reach expected state for " + template); };
  const click = async text => { const frame = await waitFor(value => has(value, text)); const op = frame.ops.find(value => value.type === "text" && value.text === text); for (const phase of ["down", "up"]) { const response = await call("input", { method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x: op.x + op.w / 2, y: op.y + op.h / 2 }) }); assert.equal(response.status, 200); } };
  try {
    if (template === "app") { await click("深色"); await waitFor(frame => has(frame, "浅色")); await click("浅色"); await waitFor(frame => has(frame, "深色")); }
    else { await click("开始游戏"); await click("命中"); await waitFor(frame => frame.ops.some(op => op.text?.startsWith("得分：1 | 剩余："))); await click("暂停"); await waitFor(frame => has(frame, "已暂停")); await click("继续"); await waitFor(frame => has(frame, "进行中")); }
    result.push({ template, qjbcBytes: builds[template].qjbcBytes, pakBytes: builds[template].pakBytes, inputChangesFrame: true });
  } finally { await manager.dispose(); }
}
console.log("WINDOWS_PREVIEW_ACCEPTANCE " + JSON.stringify({ ok: true, results: result }));
`;
}

function fail(message) {
  console.error(`windows_package_smoke: ${message}`);
  process.exit(1);
}
