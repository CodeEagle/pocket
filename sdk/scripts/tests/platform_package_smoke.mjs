#!/usr/bin/env node
/**
 * Platform release acceptance for the Node/npm Pocket SDK.
 *
 * This is intentionally a consumer-side smoke test. It validates an already
 * installed platform package and Noble N-API prebuild, then builds both shipped templates
 * with the npm-managed Bun and drives the real native Preview probe. No source
 * compiler, Rust, Python or C/C++ command is admitted here.
 *
 * Usage:
 *   node scripts/tests/platform_package_smoke.mjs --sdk-root=/path/to/sdk
 * The CI job installs the platform tarball before invoking this script.
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const sdkRoot = argument("sdk-root");
if (!sdkRoot) fail("--sdk-root=绝对路径 is required");
const root = resolve(sdkRoot);
const target = resolveTarget();

const { prebuiltEnvironment, resolvePrebuiltTools, resolveManagedBun, platformPackageName, SDK_VERSION } =
  await import(pathToFileURL(join(root, "scripts/prebuilt_tools.mjs")).href);
const env = prebuiltEnvironment(root);
Object.assign(process.env, env);
const tools = resolvePrebuiltTools(root, env);
if (tools.manifest.platform !== target.platform || tools.manifest.arch !== target.arch) {
  fail(`platform manifest is ${tools.manifest.platform}/${tools.manifest.arch}, expected ${target.platform}/${target.arch}`);
}
if (tools.manifest.noble?.included !== true) {
  fail(`the ${target.label} platform package has no Noble prebuild; refusing a false Bluetooth acceptance`);
}
if (tools.manifest.noble.prebuild !== `noble/prebuilds/${target.platform}-${target.arch}/node.napi.node`) {
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
const expectedBinding = join(tools.root, "noble", "prebuilds", `${target.platform}-${target.arch}`, "node.napi.node");
if (resolve(binding).toLowerCase() !== resolve(expectedBinding).toLowerCase()) {
  fail(`Noble resolved outside the distributed prebuild: ${binding}`);
}
if (existsSync(join(nobleRoot, "build", "Release", "binding.node"))) {
  fail(`Noble resolved a local build/Release binding; ${target.label} acceptance must use the platform package`);
}
try {
  const native = requireFromSdk(binding);
  if (typeof native?.[target.nobleExport] !== "function") {
    fail(`${target.label} Noble binding loaded but did not export ${target.nobleExport}`);
  }
} catch (error) {
  fail(`${target.label} Noble N-API binding cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
}

const bun = resolveManagedBun(root, env);
const work = mkdtempSync(join(tmpdir(), "pocket-platform-smoke-"));
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
  await verifyStudioLifecycle(root, env, projects.app);
  console.log(JSON.stringify({
    ok: true,
    sdkVersion: SDK_VERSION,
    platformPackage: platformPackageName(target.platform, target.arch),
    toolsRoot: tools.root,
    nobleBinding: binding,
    nobleSourceBuildPresent: false,
    builds,
    preview: report,
    studio: { port: 8791, start: true, health: true, status: true, stop: true },
  }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function resolveTarget() {
  if (process.platform === "win32" && process.arch === "x64") {
    return { label: "Windows x64", platform: "win32", arch: "x64", nobleExport: "NobleWinrt" };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { label: "macOS arm64", platform: "darwin", arch: "arm64", nobleExport: "NobleMac" };
  }
  fail(`platform smoke only supports Windows x64 or macOS arm64 (current ${process.platform}/${process.arch})`);
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function parseReport(stdout) {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith("POCKET_PREVIEW_ACCEPTANCE "));
  if (!line) fail(`Preview did not emit POCKET_PREVIEW_ACCEPTANCE:\n${stdout}`);
  try { return JSON.parse(line.slice("POCKET_PREVIEW_ACCEPTANCE ".length)); }
  catch (error) { fail(`invalid Preview report: ${error instanceof Error ? error.message : String(error)}`); }
}

async function verifyStudioLifecycle(rootPath, toolEnv, projectRoot) {
  const service = join(rootPath, "scripts/editor_service.mjs");
  const start = spawnSync(process.execPath, [service, "start", `--project-root=${projectRoot}`], {
    cwd: rootPath,
    env: toolEnv,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  if (start.error || start.status !== 0) {
    const logPath = join(rootPath, ".pocket-build", "editor-service-8791.log");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no service log)";
    fail(`Studio start failed (${start.status ?? "spawn"}):\n${start.stdout ?? ""}\n${start.stderr ?? start.error?.message ?? ""}\n${log}`);
  }
  const workspace = resolve(rootPath, ".pocket-build", "editor-workspace-8791");
  try {
    const health = await waitForStudioHealth(workspace, 30000);
    if (!health) fail("Studio /health did not become ready on fixed port 8791");
    const status = spawnSync(process.execPath, [service, "status"], {
      cwd: rootPath,
      env: toolEnv,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (status.error || status.status !== 0 || !/8791/.test(`${status.stdout ?? ""}${status.stderr ?? ""}`)) {
      fail(`Studio status failed on fixed port 8791 (${status.status ?? "spawn"}):\n${status.stdout ?? ""}\n${status.stderr ?? status.error?.message ?? ""}`);
    }
  } finally {
    const stop = spawnSync(process.execPath, [service, "stop"], {
      cwd: rootPath,
      env: toolEnv,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (stop.error || stop.status !== 0) {
      fail(`Studio stop failed (${stop.status ?? "spawn"}):\n${stop.stdout ?? ""}\n${stop.stderr ?? stop.error?.message ?? ""}`);
    }
    if (await waitForStudioHealth(workspace, 3000)) {
      fail("Studio remained reachable after stop on fixed port 8791");
    }
  }
}

async function waitForStudioHealth(workspace, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8791/health", { signal: AbortSignal.timeout(750) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.service === "pocket-editor" && resolve(health.workspace || "") === workspace) return true;
      }
    } catch { /* startup or shutdown is still in progress */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
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
  let reader;
  const snapshot = async () => { const response = await call("snapshot"); assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.status.state, "ready", JSON.stringify(value.status)); return value.frame; };
  const has = (frame, text) => frame.ops.some(op => op.type === "text" && op.text === text);
  const waitFor = async (predicate, expected) => {
    const deadline = Date.now() + 5000;
    let frame;
    do {
      frame = await snapshot();
      if (predicate(frame)) return frame;
      await wait(30);
    } while (Date.now() < deadline);
    const text = frame.ops.filter(op => op.type === "text").map(op => op.text);
    throw new Error("Preview " + template + " did not reach " + expected + " within 5s; frame=" + frame.frame + "; text=" + JSON.stringify(text));
  };
  const click = async text => { const frame = await waitFor(value => has(value, text), "text " + JSON.stringify(text)); const op = frame.ops.find(value => value.type === "text" && value.text === text); for (const phase of ["down", "up"]) { const response = await call("input", { method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x: op.x + op.w / 2, y: op.y + op.h / 2 }) }); assert.equal(response.status, 200); } };
  const textStartingWith = (frame, prefix) => frame.ops.find(op => op.type === "text" && op.text?.startsWith(prefix))?.text;
  const tap = async (x, y, holdMs = 120) => {
    for (const phase of ["down", "up"]) {
      const response = await call("input", { method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x, y }) });
      assert.equal(response.status, 200);
      if (phase === "down") await wait(holdMs);
    }
  };
  try {
    const stream = await call("stream");
    assert.equal(stream.status, 200);
    reader = stream.body?.getReader();
    await reader?.read();
    if (template === "app") {
      const initial = await waitFor(frame => has(frame, "深色"), 'App initial theme control');
      await click("深色");
      const light = await waitFor(frame => has(frame, "浅色"), 'App light theme after input');
      await click("浅色");
      const dark = await waitFor(frame => has(frame, "深色"), 'App dark theme after input');
      result.push({ template, inputChangesFrame: true, frames: { initial: initial.frame, light: light.frame, dark: dark.frame } });
    } else {
      const ready = await waitFor(frame => has(frame, "星尘捕手") && has(frame, "得分：0") && has(frame, "剩余：30 秒"), 'Game ready HUD');
      await click("开始游戏");
      const playing = await waitFor(frame => has(frame, "点击发光星核") && has(frame, "得分：0") && Boolean(textStartingWith(frame, "剩余：")), 'Game playing HUD');
      const starCore = frame => frame.ops.find(op => op.color === 0xfffff8df);
      const firstCore = starCore(playing);
      assert.ok(firstCore, "playing Game frame must expose the rendered star-core op");
      await tap(8, 100);
      const emptySpace = await snapshot();
      assert.ok(has(emptySpace, "得分：0"), "empty space must not score");
      const targetFrame = await waitFor(frame => Boolean(starCore(frame)), 'rendered star-core target');
      const target = starCore(targetFrame);
      assert.ok(target, "target frame must contain the rendered star-core op");
      await tap(target.x + target.w / 2, target.y + target.h / 2);
      const scored = await waitFor(frame => has(frame, "得分：1"), 'Game score to become 1 after star-core input');
      await click("暂停");
      const paused = await waitFor(frame => has(frame, "已暂停") && Boolean(textStartingWith(frame, "剩余：")), 'Game paused HUD');
      const pausedTime = textStartingWith(paused, "剩余：");
      assert.ok(pausedTime, "paused game frame must expose its countdown text");
      await wait(1200);
      const frozen = await snapshot();
      assert.ok(has(frozen, "已暂停"), "game left the paused state during the 1.2s freeze check");
      assert.ok(has(frozen, "得分：1"), "game score changed while paused");
      assert.equal(textStartingWith(frozen, "剩余："), pausedTime, "game countdown changed while paused");
      await click("继续");
      const continued = await waitFor(frame => has(frame, "点击发光星核") && has(frame, "得分：1") && Boolean(textStartingWith(frame, "剩余：")) && textStartingWith(frame, "剩余：") !== pausedTime, 'Game countdown to advance after resume');
      result.push({ template, inputChangesFrame: true, score: { before: "得分：0", after: "得分：1", frame: scored.frame }, countdown: { paused: pausedTime, frozenForMs: 1200, resumed: textStartingWith(continued, "剩余：") }, frames: { ready: ready.frame, playing: playing.frame, target: targetFrame.frame, scored: scored.frame, paused: paused.frame, frozen: frozen.frame, resumed: continued.frame }, targetSource: "rendered FrameResult op color 0xfffff8df" });
    }
    result.at(-1).qjbcBytes = builds[template].qjbcBytes;
    result.at(-1).pakBytes = builds[template].pakBytes;
  } finally { await reader?.cancel(); await manager.dispose(); }
}
console.log("POCKET_PREVIEW_ACCEPTANCE " + JSON.stringify({ ok: true, results: result }));
`;
}

function fail(message) {
  throw new Error(`platform_package_smoke: ${message}`);
}
