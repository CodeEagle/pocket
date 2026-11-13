import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  acquireUpgradeApplyLock,
  expectedSdkArchiveAssetNames,
  isSdkBackupComplete,
  recoverInterruptedSdkUpgrade,
} from "../studio_upgrade.mjs";
import {
  configFromHealth,
  editorToolEnvironment,
  isEntrypoint,
  protectedRetirementPlan,
  terminateProcessSet,
  commandIncludesPath,
  upgradeApply,
  makePidRecord,
  mergeLaunchOptions,
  parseArgs,
  parsePidRecord,
} from "../editor_service.mjs";

const fixture = (name: string) => resolve(tmpdir(), name);
const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "editor_service.mjs");
const findProcess = createRequire(import.meta.url)("find-process").default;
const SOURCE_UPSTREAM = "c".repeat(40);
const SOURCE_ABI = "fixture-qjbc-v1";

function tarOctal(value: number, width: number): string {
  return `${Math.max(0, Math.trunc(value)).toString(8).padStart(width - 1, "0")}\0`;
}

function tarGzipFiles(files: Record<string, Buffer | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(`package/${name}`, 0, 100, "utf8");
    header.write(tarOctal(0o644, 8), 100, 8, "utf8");
    header.write(tarOctal(0, 8), 108, 8, "utf8");
    header.write(tarOctal(0, 8), 116, 8, "utf8");
    header.write(tarOctal(bytes.byteLength, 12), 124, 12, "utf8");
    header.write(tarOctal(0, 12), 136, 12, "utf8");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocks.push(header, bytes);
    if (bytes.byteLength % 512) blocks.push(Buffer.alloc(512 - (bytes.byteLength % 512), 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function createStandaloneFixture(root: string, version: string): void {
  const platform = process.platform;
  const arch = process.arch;
  const tuple = `${platform}-${arch}`;
  const upstreamRevision = "a".repeat(40);
  const bytecodeAbi = `quickjs-bytecode-v1:${"b".repeat(64)}`;
  const pkg = { name: `@pocket/web-sdk-tools-${tuple}`, version, type: "module" };
  const provenance = { sourceRepository: "CodeEagle/pocket", pinnedPocketJsRevision: upstreamRevision };
  const toolFiles = {
    [`bin/pocketjs_bytecode${platform === "win32" ? ".exe" : ""}`]: Buffer.from("fixture bytecode tool"),
    [`bin/pocket_probe${platform === "win32" ? ".exe" : ""}`]: Buffer.from("fixture probe tool"),
    "compiler/tools/build.ts": Buffer.from("export {};\n"),
    "compiler/framework/compiler/jsx-plugin.ts": Buffer.from("export {};\n"),
    "compiler/framework/compiler/subpaths.ts": Buffer.from("export {};\n"),
    "compiler/framework/src/inline-fonts.ts": Buffer.from("export {};\n"),
    "compiler/tools/inline-text-slots.ts": Buffer.from("export {};\n"),
  };
  const toolManifest = {
    schemaVersion: 1,
    sdkVersion: version,
    upstreamRevision,
    bytecodeAbi,
    platform,
    arch,
    files: Object.fromEntries(Object.entries(toolFiles).map(([path, bytes]) => [path, {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }])),
  };
  const toolsArchive = tarGzipFiles({
    ...toolFiles,
    "package.json": JSON.stringify({ name: `@pocket/tools-${tuple}`, version }),
    "manifest.json": JSON.stringify(toolManifest),
  });
  const names = expectedSdkArchiveAssetNames(version, platform, arch);
  mkdirSync(join(root, "editor"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "prebuilt"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance));
  writeFileSync(join(root, "editor", "server.ts"), `// fixture ${version}\n`);
  writeFileSync(join(root, "scripts", "editor_service.mjs"), `// fixture ${version}\n`);
  writeFileSync(join(root, "scripts", "prebuilt_tools.mjs"),
    `export const SDK_VERSION = '${version}';\nexport const UPSTREAM_REVISION = '${upstreamRevision}';\nexport const BYTECODE_ABI = '${bytecodeAbi}';\n`);
  writeFileSync(join(root, "prebuilt", names.toolsArchiveName), toolsArchive);
}

function fixtureGit(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]}: ${result.error || result.stderr}`);
  return result.stdout.trim();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createSourceTools(directory: string, version: string, platform = process.platform, arch = process.arch): Buffer {
  const suffix = platform === "win32" ? ".exe" : "";
  const files = {
    [`bin/pocketjs_bytecode${suffix}`]: Buffer.from(`bytecode ${version}`),
    [`bin/pocket_probe${suffix}`]: Buffer.from(`probe ${version}`),
    "compiler/tools/build.ts": Buffer.from("export {};\n"),
    "compiler/framework/compiler/jsx-plugin.ts": Buffer.from("export {};\n"),
    "compiler/framework/compiler/subpaths.ts": Buffer.from("export {};\n"),
    "compiler/framework/src/inline-fonts.ts": Buffer.from("export {};\n"),
    "compiler/tools/inline-text-slots.ts": Buffer.from("export {};\n"),
  };
  for (const [relativePath, bytes] of Object.entries(files)) {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const manifest = {
    schemaVersion: 1,
    sdkVersion: version,
    upstreamRevision: SOURCE_UPSTREAM,
    bytecodeAbi: SOURCE_ABI,
    platform,
    arch,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }])),
  };
  writeJson(join(directory, "package.json"), { name: `@pocket/tools-${platform}-${arch}`, version, type: "module" });
  writeJson(join(directory, "manifest.json"), manifest);
  return tarGzipFiles({
    ...files,
    "package.json": JSON.stringify({ name: `@pocket/tools-${platform}-${arch}`, version, type: "module" }),
    "manifest.json": JSON.stringify(manifest),
  });
}

function createSourceUpgradeFixture() {
  const temp = mkdtempSync(join(tmpdir(), "pocket-editor-source-upgrade-"));
  const repo = join(temp, "repo");
  const sdk = join(repo, "sdk");
  const stageDir = join(temp, "stage");
  const platform = process.platform;
  const arch = process.arch;
  const tuple = `${platform}-${arch}`;
  const scriptsDir = dirname(SCRIPT_PATH);
  const sourcePrebuiltTools = readFileSync(join(scriptsDir, "prebuilt_tools.mjs"), "utf8");
  const fixturePrebuiltTools = (version: string) => sourcePrebuiltTools
    .replace(/export const SDK_VERSION = ['"][^'"]+['"];/, `export const SDK_VERSION = '${version}';`)
    .replace(/export const UPSTREAM_REVISION = ['"][^'"]+['"];/, `export const UPSTREAM_REVISION = '${SOURCE_UPSTREAM}';`)
    .replace(/export const BYTECODE_ABI = ['"][^'"]+['"];/, `export const BYTECODE_ABI = '${SOURCE_ABI}';`);
  mkdirSync(join(sdk, "scripts"), { recursive: true });
  mkdirSync(join(sdk, "editor"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "/sdk/node_modules/\n/sdk/.pocket-build/\n/sdk/.pocket-studio-source-test-fixture\n/sdk/editor/ignored-custom.ts\n/sdk/native/target/\n");
  writeFileSync(join(sdk, ".pocket-studio-source-test-fixture"), "test-only source checkout\n");

  const writeVersion = (version: string) => {
    writeJson(join(sdk, "package.json"), {
      name: "pocketjs-sdk",
      version,
      type: "module",
      dependencies: { fixtureDependency: "1.0.0" },
    });
    writeJson(join(sdk, "package-lock.json"), {
      name: "pocketjs-sdk",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "pocketjs-sdk", version, dependencies: { fixtureDependency: "1.0.0" } },
        "node_modules/fixtureDependency": { version: "1.0.0" },
      },
    });
    writeFileSync(join(sdk, "scripts", "prebuilt_tools.mjs"), fixturePrebuiltTools(version));
    mkdirSync(join(sdk, "native", "src"), { recursive: true });
    writeFileSync(join(sdk, "native", "src", "lib.rs"), `// native input v${version}\n`);
  };

  for (const name of ["editor_service.mjs", "studio_upgrade.mjs", "prebuilt_tools.mjs", "native_probe_path.ts"]) {
    const contents = readFileSync(join(scriptsDir, name), "utf8");
    writeFileSync(join(sdk, "scripts", name), contents);
  }
  const editorDir = resolve(scriptsDir, "../editor");
  writeFileSync(join(sdk, "editor", "update_endpoint.ts"), readFileSync(join(editorDir, "update_endpoint.ts")));
  writeFileSync(join(sdk, "editor", "server.ts"), `
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
const workspace = process.argv.find(value => value.startsWith("--workspace="))?.slice("--workspace=".length);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.POCKET_EDITOR_PORT),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "pocket-editor", workspace, version, pid: process.pid });
    return new Response("source fixture editor");
  },
});
process.on("SIGTERM", () => server.stop(true));
`);

  fixtureGit(repo, "init", "--initial-branch=main");
  fixtureGit(repo, "config", "core.autocrlf", "false");
  fixtureGit(repo, "config", "core.eol", "lf");
  expect(fixtureGit(repo, "config", "--local", "--get", "core.autocrlf")).toBe("false");
  expect(fixtureGit(repo, "config", "--local", "--get", "core.eol")).toBe("lf");
  fixtureGit(repo, "config", "user.name", "Pocket Upgrade Test");
  fixtureGit(repo, "config", "user.email", "upgrade@example.invalid");
  fixtureGit(repo, "config", "commit.gpgsign", "false");
  fixtureGit(repo, "config", "core.hooksPath", join(temp, "no-hooks"));
  fixtureGit(repo, "remote", "add", "origin", "https://github.com/CodeEagle/pocket.git");
  writeVersion("1.0.0");
  utimesSync(join(sdk, "native", "src", "lib.rs"), new Date(0), new Date(0));
  createSourceTools(join(sdk, "node_modules", "@pocket", `tools-${tuple}`), "1.0.0", platform, arch);
  const baseline = (() => { fixtureGit(repo, "add", "."); fixtureGit(repo, "commit", "-m", "baseline"); return fixtureGit(repo, "rev-parse", "HEAD"); })();
  const staleProbe = join(sdk, "native", "target", "release", process.platform === "win32" ? "pocket_probe.exe" : "pocket_probe");
  mkdirSync(dirname(staleProbe), { recursive: true });
  writeFileSync(staleProbe, "stale source checkout probe\n");
  const fixtureSleep = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(fixtureSleep, 0, 0, 20);
  writeVersion("1.0.1");
  writeFileSync(join(sdk, "editor", "ignored-custom.ts"), "// official 1.0.1 release file\n");
  const targetCommit = (() => { fixtureGit(repo, "add", "."); fixtureGit(repo, "add", "-f", "sdk/editor/ignored-custom.ts"); fixtureGit(repo, "commit", "-m", "release 1.0.1"); return fixtureGit(repo, "rev-parse", "HEAD"); })();

  const serviceNodeModules = join(sdk, "node_modules");
  mkdirSync(serviceNodeModules, { recursive: true });
  const currentNodeModules = resolve(scriptsDir, "../node_modules");
  for (const dependency of ["find-process", "tree-kill"]) {
    const source = join(currentNodeModules, dependency);
    if (existsSync(source)) symlinkSync(source, join(serviceNodeModules, dependency), process.platform === "win32" ? "junction" : "dir");
  }

  writeJson(join(stageDir, "package.json"), { name: `@pocket/web-sdk-tools-${tuple}`, version: "1.0.1" });
  mkdirSync(join(stageDir, "scripts"), { recursive: true });
  writeFileSync(join(stageDir, "scripts", "prebuilt_tools.mjs"), fixturePrebuiltTools("1.0.1"));
  writeFileSync(join(stageDir, "scripts", "editor_service.mjs"), readFileSync(join(scriptsDir, "editor_service.mjs")));
  mkdirSync(join(stageDir, "editor"), { recursive: true });
  writeFileSync(join(stageDir, "editor", "server.ts"), "// staged service entry\n");
  writeJson(join(stageDir, "provenance.json"), {
    sourceRepository: "CodeEagle/pocket",
    sourceCommit: targetCommit,
    pinnedPocketJsRevision: SOURCE_UPSTREAM,
  });
  const stagedArchive = createSourceTools(join(stageDir, ".staged-tools", tuple), "1.0.1", platform, arch);
  mkdirSync(join(stageDir, "prebuilt"), { recursive: true });
  writeFileSync(join(stageDir, "prebuilt", expectedSdkArchiveAssetNames("1.0.1", platform, arch).toolsArchiveName), stagedArchive);
  fixtureGit(repo, "reset", "--hard", baseline);
  utimesSync(join(sdk, "native", "src", "lib.rs"), new Date(0), new Date(0));
  return { temp, repo, sdk, stageDir, baseline, targetCommit, close: () => rmSync(temp, { recursive: true, force: true }) };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = server.port;
  server.stop(true);
  return port;
}

function summarizeCliResult(result: ReturnType<typeof spawnSync>) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout?.toString(),
    stderr: result.stderr?.toString(),
  };
}

async function preserveSourceCliDiagnostics(
  source: ReturnType<typeof createSourceUpgradeFixture>,
  serviceCli: string,
  serviceScript: string,
  childEnv: NodeJS.ProcessEnv,
  port: number,
  commandResults: Record<string, ReturnType<typeof summarizeCliResult>>,
  failure: unknown,
): Promise<string> {
  const root = join(process.env.RUNNER_TEMP || tmpdir(), "pocket-studio-upgrade-diagnostics");
  const directory = join(root, `source-cli-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const status = spawnSync(serviceCli, [serviceScript, "status"], {
    cwd: source.repo,
    env: childEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  let health: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
    health = { status: response.status, body: await response.text() };
  } catch (error) {
    health = { error: error instanceof Error ? error.message : String(error) };
  }
  writeJson(join(directory, "source-cli-failure.json"), {
    error: failure instanceof Error ? failure.message : String(failure),
    port,
    repo: source.repo,
    sdk: source.sdk,
    commands: commandResults,
    status: summarizeCliResult(status),
    health,
  });
  const buildDir = join(source.sdk, ".pocket-build");
  for (const [sourceName, targetName] of [
    ["editor-service-8791.log", "editor-service.log"],
    ["editor-service-8791.pid.json", "editor-service.pid.json"],
  ]) {
    const path = join(buildDir, sourceName);
    if (existsSync(path)) copyFileSync(path, join(directory, targetName));
  }
  return directory;
}

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
      `--source-commit=${"a".repeat(40)}`,
      "--handoff-token=token-123",
    ], {});
    expect(parsed.command).toBe("upgrade-apply");
    expect(parsed.upgrade).toEqual({
      stageDir: fixture("sdk-upgrade-stage-0.1.11"),
      targetVersion: "0.1.11",
      sourceCommit: "a".repeat(40),
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
    const env = editorToolEnvironment(
      { compilerPath: fixture("custom-compiler.ts") },
      fixture("custom-sdk"),
      { ...process.env, POCKET_SOURCE_BUILD: "1" },
    );
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
    pids: [111, 110, 123, 120, 100],
  });
  expect(protectedRetirementPlan(processes, 100, 120)).toEqual({
    pids: [111, 110, 100],
  });
  expect(protectedRetirementPlan(processes, 100, 999)).toEqual({
    pids: [111, 110, 122, 121, 123, 120, 100],
  });
  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 800 }, // exited launcher; only snapshot PIDs can be signaled
  ], 100, 200)).toEqual({ pids: [100] });
  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 200, ppid: 1 },
    { pid: 100, ppid: 200 }, // target nested below updater; retirement is unsafe
  ], 100, 200)).toBeNull();
  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: Number.NaN },
  ], 100, 200)).toBeNull();
  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 1 },
    { pid: 200, ppid: 1 },
  ], 100, 200)).toBeNull();
  expect(protectedRetirementPlan([{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }], 100, 1)).toBeNull();
});

test("protected retirement identifies malformed rows and unsafe ancestry without exposing commands", () => {
  let rejection: unknown;
  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0, cmd: "private command" },
    { pid: 100, ppid: 1, cmd: "server command" },
    { pid: 200, ppid: Number.NaN, cmd: "private updater command" },
  ], 100, 200, value => { rejection = value; })).toBeNull();
  expect(rejection).toEqual({
    reason: "invalid-process-row",
    row: 2,
    fields: [{ field: "ppid", type: "number" }],
  });
  expect(JSON.stringify(rejection)).not.toContain("private command");

  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 1 },
    { pid: 200, ppid: 1 },
  ], 100, 200, value => { rejection = value; })).toBeNull();
  expect(rejection).toEqual({
    reason: "duplicate-process-pid",
    pid: 200,
    rows: [2, 3],
  });

  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 300 },
    { pid: 300, ppid: 200 },
  ], 100, 200, value => { rejection = value; })).toBeNull();
  expect(rejection).toEqual({
    reason: "protected-process-tree-cycle",
    cyclePids: [200, 300, 200],
  });

  expect(protectedRetirementPlan([
    { pid: 1, ppid: 0 },
    { pid: 200, ppid: 1 },
    { pid: 100, ppid: 200 },
  ], 100, 200, value => { rejection = value; })).toBeNull();
  expect(rejection).toEqual({
    reason: "target-is-inside-protected-process-tree",
    targetPid: 100,
    protectedPid: 200,
  });
});


test("upgrade retirement kills the real server tree but preserves its detached updater", { timeout: 10_000 }, async () => {
  const source = `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    const updater = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const waitForSpawn = (child) => new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const waitForWorkerReady = new Promise((resolve, reject) => {
      worker.stdout.once("data", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error("worker exited before installing its signal handler: " + code)));
    });
    Promise.all([waitForSpawn(updater), waitForWorkerReady]).then(() => {
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
    const processes = await findProcess("name", "");
    const retirementPlan = protectedRetirementPlan(processes, server.pid!, childPids.updaterPid);
    expect(retirementPlan).not.toBeNull();
    expect(retirementPlan!.pids).toContain(childPids.workerPid);
    expect(retirementPlan!.pids).not.toContain(childPids.updaterPid);
    if (process.platform !== "win32") {
      const workerState = spawnSync("ps", ["-o", "stat=", "-p", String(childPids.workerPid)], { encoding: "utf8" });
      expect(workerState.status).toBe(0);
      expect(workerState.stdout.trim()).not.toMatch(/^[ZX]/);
    }
    const processesByPid = new Map(processes.map((info: { pid: number }) => [Number(info.pid), info]));
    const retirementProcesses = retirementPlan!.pids.map(pid => processesByPid.get(pid)).filter(Boolean);
    expect(retirementProcesses).toHaveLength(retirementPlan!.pids.length);
    expect(await terminateProcessSet(retirementProcesses, { timeoutMs: 100, killTimeoutMs: 3000 })).toBe(true);

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


test("upgrade retirement refuses TERM when the live PID no longer matches its snapshot", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => process.exit(17)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const pid = child.pid!;

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("child did not become ready")), 3_000);
      child.once("error", error => {
        clearTimeout(timer);
        rejectReady(error);
      });
      child.once("exit", code => {
        clearTimeout(timer);
        rejectReady(new Error(`child exited before ready (${code})`));
      });
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    const found = await findProcess("pid", pid);
    const snapshot = Array.isArray(found) ? found.find(info => Number(info?.pid) === pid) : undefined;
    expect(snapshot?.cmd).toBeTruthy();
    await expect(terminateProcessSet([{
      ...snapshot!,
      cmd: `${snapshot!.cmd} changed-after-snapshot`,
    }], { timeoutMs: 50, killTimeoutMs: 50 })).rejects.toThrow(/拒绝发送 SIGTERM/);

    await new Promise(resolveDelay => setTimeout(resolveDelay, 75));
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") alive = false; }
    expect(alive).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
    }
  }
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

test("a port-retirement refusal removes the unused backup and stage without rolling back", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-upgrade-stop-refused-"));
  const stageDir = join(root, ".pocket-build", "sdk-upgrade-stage-0.1.15");
  const backupDir = join(root, ".pocket-build", "sdk-upgrade-backup-0.1.14");
  const lockPath = join(root, ".pocket-build", "sdk-upgrade-apply.lock.json");
  const statusPath = join(root, ".pocket-build", "sdk-upgrade-status.json");
  const consumerFile = join(root, ".pocket-build", "editor-workspace-8791", "projects", "sample", "app.tsx");
  try {
    createStandaloneFixture(root, "0.1.14");
    createStandaloneFixture(stageDir, "0.1.15");
    mkdirSync(dirname(consumerFile), { recursive: true });
    writeFileSync(consumerFile, "// preserve consumer project\n");
    writeFileSync(statusPath, JSON.stringify({
      status: "restarting",
      currentVersion: "0.1.14",
      latestVersion: "0.1.15",
    }));

    const originalServer = readFileSync(join(root, "editor", "server.ts"), "utf8");
    await expect(upgradeApply({ stageDir, targetVersion: "0.1.15" }, {
      sdkRoot: root,
      assertPortOwnership: async () => ({ processes: [], owned: [], foreign: [] }),
      cleanupLegacyLaunchd: () => {},
      stopOwnedPort: async (port: number, required: boolean, protectedPid: number) => {
        expect(port).toBeGreaterThan(0);
        expect(required).toBe(true);
        expect(protectedPid).toBe(process.pid);
        expect(isSdkBackupComplete(backupDir)).toBe(true);
        throw new Error("stop rejected by protected process guard");
      },
    })).rejects.toThrow("stop rejected by protected process guard");

    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version":"0.1.14"');
    expect(readFileSync(join(root, "editor", "server.ts"), "utf8")).toBe(originalServer);
    expect(readFileSync(consumerFile, "utf8")).toBe("// preserve consumer project\n");
    expect(existsSync(backupDir)).toBe(false);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(await recoverInterruptedSdkUpgrade(root)).toBeNull();
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    expect(status.status).toBe("error");
    expect(status.currentVersion).toBe("0.1.14");
    expect(status.rolledBack).toBe(false);
    expect(status.error).toContain("stop rejected by protected process guard");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source upgrade applies the staged Git commit through the real service CLI and restarts the new version", { timeout: 45_000 }, async () => {
  const source = createSourceUpgradeFixture();
  const port = await allocateLoopbackPort();
  const serviceScript = join(source.sdk, "scripts", "editor_service.mjs");
  // The service's supported CLI is Node (package scripts and the entrypoint
  // shebang use it). `process.execPath` here is the Bun test runner; nesting a
  // detached Bun service CLI under Bun can hang on Windows before `start`
  // returns. Keep POCKET_BUN pointed at the managed Bun for the actual server.
  const serviceCli = "node";
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    POCKET_STUDIO_TEST_SOURCE_GIT: "1",
    POCKET_STUDIO_TEST_PORT: String(port),
    POCKET_BUN: process.execPath,
  };
  for (const name of [
    "POCKET_SOURCE_BUILD", "POCKET_EDITOR_PORT", "POCKET_EDITOR_UPDATE_PORT", "POCKET_EDITOR_BUN",
    "POCKET_COMPILER_PATH", "POCKET_NATIVE_PROBE", "POCKET_TOOLS_PACKAGE", "POCKET_UPSTREAM_ROOT", "POCKET_BYTECODE_BIN",
  ]) delete childEnv[name];
  let serviceStartAttempted = false;
  let parentLock: (() => void) | undefined;
  const commandResults: Record<string, ReturnType<typeof summarizeCliResult>> = {};
  try {
    serviceStartAttempted = true;
    const start = spawnSync(serviceCli, [serviceScript, "start"], {
      cwd: source.repo,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
    commandResults.start = summarizeCliResult(start);
    if (start.status !== 0) throw new Error(`source service start failed: ${start.error || ""}\n${start.stdout}\n${start.stderr}`);
    const firstHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean; version: string; pid: number };
    expect(firstHealth).toMatchObject({ ok: true, version: "1.0.0" });

    const handoffToken = "source-cli-handoff-token";
    parentLock = acquireUpgradeApplyLock(source.sdk, {
      phase: "spawning",
      mode: "source",
      sourceCommit: source.targetCommit,
      targetVersion: "1.0.1",
      stageDir: source.stageDir,
      handoffToken,
    });
    const apply = spawnSync(serviceCli, [
      serviceScript,
      "upgrade-apply",
      `--stage-dir=${source.stageDir}`,
      "--target-version=1.0.1",
      `--source-commit=${source.targetCommit}`,
      `--handoff-token=${handoffToken}`,
    ], {
      cwd: source.repo,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    commandResults.upgradeApply = summarizeCliResult(apply);
    parentLock();
    parentLock = undefined;
    if (apply.status !== 0) throw new Error(`source upgrade CLI failed: ${apply.error || ""}\n${apply.stdout}\n${apply.stderr}`);

    const secondHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean; version: string; pid: number };
    expect(secondHealth).toMatchObject({ ok: true, version: "1.0.1" });
    expect(secondHealth.pid).not.toBe(firstHealth.pid);
    expect(fixtureGit(source.repo, "rev-parse", "HEAD")).toBe(source.targetCommit);
    expect(JSON.parse(readFileSync(join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`, "manifest.json"), "utf8")).sdkVersion).toBe("1.0.1");
    expect(readFileSync(join(source.sdk, "editor", "ignored-custom.ts"), "utf8")).toBe("// official 1.0.1 release file\n");
    const installedTools = join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`);
    const pidFile = join(source.sdk, ".pocket-build", "editor-service-8791.pid.json");
    const expectedCompiler = join(installedTools, "compiler", "tools", "build.ts");
    const expectedProbe = join(installedTools, "bin", process.platform === "win32" ? "pocket_probe.exe" : "pocket_probe");
    const upgradedRecord = JSON.parse(readFileSync(pidFile, "utf8"));
    expect(realpathSync(upgradedRecord.config.compilerPath)).toBe(realpathSync(expectedCompiler));
    expect(realpathSync(upgradedRecord.config.nativeProbe)).toBe(realpathSync(expectedProbe));
    expect(existsSync(join(source.sdk, "native", "target", "release", process.platform === "win32" ? "pocket_probe.exe" : "pocket_probe"))).toBe(true);

    const restart = spawnSync(serviceCli, [serviceScript, "restart"], {
      cwd: source.repo,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
    commandResults.restart = summarizeCliResult(restart);
    if (restart.status !== 0) throw new Error(`source service restart after upgrade failed: ${restart.error || ""}\n${restart.stdout}\n${restart.stderr}`);
    const thirdHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean; version: string; pid: number };
    expect(thirdHealth).toMatchObject({ ok: true, version: "1.0.1" });
    expect(thirdHealth.pid).not.toBe(secondHealth.pid);
    const restartedRecord = JSON.parse(readFileSync(pidFile, "utf8"));
    expect(realpathSync(restartedRecord.config.compilerPath)).toBe(realpathSync(expectedCompiler));
    expect(realpathSync(restartedRecord.config.nativeProbe)).toBe(realpathSync(expectedProbe));
    expect(existsSync(source.stageDir)).toBe(false);
    expect(existsSync(join(source.sdk, ".pocket-build", "sdk-upgrade-backup-1.0.0"))).toBe(false);
  } catch (error) {
    const directory = await preserveSourceCliDiagnostics(
      source,
      serviceCli,
      serviceScript,
      childEnv as NodeJS.ProcessEnv,
      port,
      commandResults,
      error,
    );
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nSource CLI diagnostics: ${directory}`);
  } finally {
    parentLock?.();
    if (serviceStartAttempted) {
      spawnSync(serviceCli, [serviceScript, "stop"], {
        cwd: source.repo,
        env: childEnv as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 10_000,
      });
    }
    source.close();
  }
});

test("source upgrade rolls back Git and verified tools after startup failure and drops stale checkout overrides", async () => {
  const source = createSourceUpgradeFixture();
  const ignoredPath = join(source.sdk, "editor", "ignored-custom.ts");
  const oldToolsDir = join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`);
  const observedLaunches: Array<{ options: Record<string, string>; env: Record<string, string | undefined> }> = [];
  const startedLaunches: Array<{ options: Record<string, string>; env: Record<string, string | undefined> }> = [];
  let startCount = 0;
  const incomingEnvironment = {
    POCKET_SOURCE_BUILD: "1",
    POCKET_COMPILER_PATH: join(source.repo, ".pocket-build", "old-tools", "build.ts"),
    POCKET_NATIVE_PROBE: join(source.temp, "external-probe"),
  };
  try {
    await expect(upgradeApply({ stageDir: source.stageDir, targetVersion: "1.0.1", sourceCommit: source.targetCommit }, {
      sdkRoot: source.sdk,
      assertPortOwnership: async () => ({ processes: [], owned: [], foreign: [] }),
      readPidRecord: () => ({ config: {
        projectRoot: source.temp,
        compilerPath: join(source.temp, "external-compiler.ts"),
        nativeProbe: join(source.repo, ".cache", "pocketjs", "old-probe"),
      } }),
      readHealth: async () => undefined,
      cleanupLegacyLaunchd: () => {},
      stopOwnedPort: async () => {},
      editorToolEnvironment: (options, _sdkRoot, env) => {
        observedLaunches.push({ options: { ...options }, env: { ...env } });
        return {
          ...env,
          POCKET_BUN: process.execPath,
          POCKET_COMPILER_PATH: options.compilerPath || "package/compiler/tools/build.ts",
          POCKET_NATIVE_PROBE: options.nativeProbe || env.POCKET_NATIVE_PROBE || "package/bin/pocket_probe",
        };
      },
      startChild: async (options, env) => {
        startedLaunches.push({ options: { ...options }, env: { ...env } });
        startCount += 1;
      },
      waitForHealth: async (_timeout, expectedVersion) => expectedVersion === "1.0.0",
      environment: incomingEnvironment,
    })).rejects.toThrow(/已回滚到 v1\.0\.0/);

    expect(fixtureGit(source.repo, "rev-parse", "HEAD")).toBe(source.baseline);
    expect(fixtureGit(source.repo, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(oldToolsDir, "manifest.json"), "utf8")).sdkVersion).toBe("1.0.0");
    expect(existsSync(ignoredPath)).toBe(false);
    expect(startCount).toBe(2);
    expect(observedLaunches).toHaveLength(2);
    for (const launch of observedLaunches) {
      expect(launch.options.compilerPath).toBe(join(source.temp, "external-compiler.ts"));
      expect(launch.options.nativeProbe).toBeUndefined();
      expect(launch.env.POCKET_SOURCE_BUILD).toBeUndefined();
      expect(launch.env.POCKET_COMPILER_PATH).toBeUndefined();
      expect(launch.env.POCKET_NATIVE_PROBE).toBe(incomingEnvironment.POCKET_NATIVE_PROBE);
    }
    expect(startedLaunches).toHaveLength(2);
    for (const launch of startedLaunches) {
      expect(launch.options.compilerPath).toBe(join(source.temp, "external-compiler.ts"));
      expect(launch.options.nativeProbe).toBe(incomingEnvironment.POCKET_NATIVE_PROBE);
    }
    const status = JSON.parse(readFileSync(join(source.sdk, ".pocket-build", "sdk-upgrade-status.json"), "utf8"));
    expect(status).toMatchObject({ status: "error", currentVersion: "1.0.0", rolledBack: true });
    expect(existsSync(source.stageDir)).toBe(false);
  } finally { source.close(); }
});

test("source preflight defers an ignored user path that the target release would add", async () => {
  const source = createSourceUpgradeFixture();
  const ignoredPath = join(source.sdk, "editor", "ignored-custom.ts");
  const userBytes = "// local ignored consumer file\n";
  writeFileSync(ignoredPath, userBytes);
  const oldToolsDir = join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`);
  let stopCalls = 0;
  try {
    await expect(upgradeApply({ stageDir: source.stageDir, targetVersion: "1.0.1", sourceCommit: source.targetCommit }, {
      sdkRoot: source.sdk,
      assertPortOwnership: async () => ({ processes: [], owned: [], foreign: [] }),
      readPidRecord: () => ({ config: {} }),
      readHealth: async () => undefined,
      stopOwnedPort: async () => { stopCalls += 1; },
    })).rejects.toThrow(/源码更新会覆盖现有的未跟踪或被忽略文件/);

    expect(stopCalls).toBe(0);
    expect(fixtureGit(source.repo, "rev-parse", "HEAD")).toBe(source.baseline);
    expect(fixtureGit(source.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(ignoredPath, "utf8")).toBe(userBytes);
    expect(JSON.parse(readFileSync(join(oldToolsDir, "manifest.json"), "utf8")).sdkVersion).toBe("1.0.0");
    const status = JSON.parse(readFileSync(join(source.sdk, ".pocket-build", "sdk-upgrade-status.json"), "utf8"));
    expect(status).toMatchObject({ status: "error", latestVersion: "1.0.1", rolledBack: false });
  } finally { source.close(); }
});

test("source rollback refusal reports the Git version that remains installed", async () => {
  const source = createSourceUpgradeFixture();
  const ignoredPath = join(source.sdk, "editor", "ignored-custom.ts");
  const userBytes = "// user edit made while the new service was starting\n";
  const targetToolsDir = join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`);
  try {
    await expect(upgradeApply({ stageDir: source.stageDir, targetVersion: "1.0.1", sourceCommit: source.targetCommit }, {
      sdkRoot: source.sdk,
      assertPortOwnership: async () => ({ processes: [], owned: [], foreign: [] }),
      readPidRecord: () => ({ config: {} }),
      readHealth: async () => undefined,
      cleanupLegacyLaunchd: () => {},
      stopOwnedPort: async () => {},
      editorToolEnvironment: (_options, _sdkRoot, env) => ({ ...env, POCKET_BUN: process.execPath }),
      startChild: async () => {},
      waitForHealth: async (_timeout, expectedVersion) => {
        if (expectedVersion === "1.0.1") {
          writeFileSync(ignoredPath, userBytes);
          return false;
        }
        return true;
      },
    })).rejects.toThrow(/健康检查或版本确认失败/);

    expect(fixtureGit(source.repo, "rev-parse", "HEAD")).toBe(source.targetCommit);
    expect(readFileSync(ignoredPath, "utf8")).toBe(userBytes);
    expect(JSON.parse(readFileSync(join(targetToolsDir, "manifest.json"), "utf8")).sdkVersion).toBe("1.0.1");
    const status = JSON.parse(readFileSync(join(source.sdk, ".pocket-build", "sdk-upgrade-status.json"), "utf8"));
    expect(status).toMatchObject({ status: "error", currentVersion: "1.0.1", rolledBack: false });
    expect(status.error).toContain("源码更新后工作区不再是官方 origin 上干净的 main");
  } finally { source.close(); }
});

test("source CLI validates the complete staged tool archive before retiring the service", async () => {
  const source = createSourceUpgradeFixture();
  const archivePath = join(source.stageDir, "prebuilt", expectedSdkArchiveAssetNames("1.0.1").toolsArchiveName);
  const oldToolsDir = join(source.sdk, "node_modules", "@pocket", `tools-${process.platform}-${process.arch}`);
  writeFileSync(archivePath, "corrupted archive");
  let stopCalls = 0;
  try {
    await expect(upgradeApply({ stageDir: source.stageDir, targetVersion: "1.0.1", sourceCommit: source.targetCommit }, {
      sdkRoot: source.sdk,
      assertPortOwnership: async () => ({ processes: [], owned: [], foreign: [] }),
      stopOwnedPort: async () => { stopCalls += 1; },
    })).rejects.toThrow();

    expect(stopCalls).toBe(0);
    expect(fixtureGit(source.repo, "rev-parse", "HEAD")).toBe(source.baseline);
    expect(JSON.parse(readFileSync(join(oldToolsDir, "manifest.json"), "utf8")).sdkVersion).toBe("1.0.0");
  } finally { source.close(); }
});
