/**
 * Maintainer-only Web engine release build.
 *
 * Consumer builds must use the platform npm package and never invoke this
 * command. The source path below intentionally runs the existing complete
 * WeChat/QJBC build once, then keeps only its generic WebAssembly engine and
 * the bundled browser host. It is the same patched QuickJS runtime used by
 * the external-QJBC browser ABI; it is not the source-evaluation WASM target.
 */
import { brotliDecompressSync } from "node:zlib";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildWechat } from "./build_wechat.ts";

const SDK_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_OUT = join(SDK_ROOT, ".pocket-build", "web-engine");
/** Exports required by every released generic engine. The Worker entries are
 * kept in the same engine so a package cannot silently switch to a second
 * JavaScript runtime when it is moved from native to a browser Worker. */
export const REQUIRED_EXPORTS = [
  "web_boot", "web_set_identity", "web_wechat_boot",
  "web_worker_create", "web_worker_step", "web_worker_deadline",
  "web_worker_receive", "web_worker_take", "web_worker_emit",
  "web_worker_finish", "web_worker_error", "web_worker_destroy",
  "web_worker_channels_configure", "web_worker_channels_push", "web_worker_channels_take",
];
// The old source-eval browser target imported `pocket_web.*`; the pinned
// Worker bridge intentionally imports the distinct `pocket_web_worker.*`
// module and must remain valid here.
const SOURCE_GUEST_IMPORTS = /(?:guest_eval|guest_start|pocket_web\.)/i;

export type BuildWebEngineOptions = { outDir: string; tickHz?: number; rasterDensity?: number };

function run(command: string, args: string[], cwd = SDK_ROOT): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit", env: { ...process.env, POCKET_SOURCE_BUILD: "1" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

export function parseBuildWebEngineArgs(args: string[]): BuildWebEngineOptions {
  const options: Partial<BuildWebEngineOptions> = {};
  for (const arg of args) {
    if (arg.startsWith("--outdir=")) options.outDir = arg.slice("--outdir=".length);
    else if (arg.startsWith("--tick-hz=")) options.tickHz = Number(arg.slice("--tick-hz=".length));
    else if (arg.startsWith("--density=")) options.rasterDensity = Number(arg.slice("--density=".length));
    else throw new Error(`build_web_engine: unknown option ${arg}`);
  }
  return { outDir: resolve(options.outDir || DEFAULT_OUT), tickHz: options.tickHz, rasterDensity: options.rasterDensity };
}

function assertEmptyDirectory(path: string): void {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw new Error(`build_web_engine: output is not a directory: ${path}`);
    if (readdirSync(path).length > 0) throw new Error(`build_web_engine: output is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

/** Validate the ABI of the artifact before it can be copied into an npm package. */
export async function verifyWebEngine(bytes: Uint8Array): Promise<{ exports: string[]; imports: string[] }> {
  if (!bytes.subarray(0, 4).every((value, index) => value === [0, 0x61, 0x73, 0x6d][index])) {
    throw new Error("build_web_engine: output is not a WebAssembly module");
  }
  const module = await WebAssembly.compile(bytes);
  const exports = WebAssembly.Module.exports(module).map((item) => item.name);
  const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`);
  for (const name of REQUIRED_EXPORTS) if (!exports.includes(name)) throw new Error(`build_web_engine: patched engine is missing ${name}`);
  const sourceImports = imports.filter((name) => SOURCE_GUEST_IMPORTS.test(name));
  if (sourceImports.length) throw new Error(`build_web_engine: source-guest imports are forbidden: ${sourceImports.join(", ")}`);
  return { exports, imports };
}

export async function buildWebEngine(options: BuildWebEngineOptions): Promise<{ outDir: string; wasmBytes: number; runtimeBytes: number; exports: string[] }> {
  const output = resolve(options.outDir);
  assertEmptyDirectory(output);
  const temporary = mkdtempSync(join(tmpdir(), "pocketjs-web-engine-source-"));
  const project = join(temporary, "project");
  const miniProgram = join(temporary, "wechat");
  const sourceTemplate = join(SDK_ROOT, "templates", "app");
  try {
    cpSync(sourceTemplate, project, { recursive: true });
    // Keep the source build deliberately tiny while retaining the real
    // framework mount and JSX lowering path. This is a release fixture, not a
    // fake runtime or source-eval fallback.
    writeFileSync(join(project, "app.tsx"), [
      'import { mount } from "@pocketjs/framework/solid";',
      'import { Screen, View } from "@pocketjs/framework/solid/components";',
      'mount(() => <Screen><View /></Screen>);',
      "",
    ].join("\n"));
    const previousSourceBuild = process.env.POCKET_SOURCE_BUILD;
    process.env.POCKET_SOURCE_BUILD = "1";
    try {
      await buildWechat({ projectRoot: project, outDir: miniProgram, entry: "app.tsx", tickHz: options.tickHz, rasterDensity: options.rasterDensity });
    } finally {
      if (previousSourceBuild === undefined) delete process.env.POCKET_SOURCE_BUILD;
      else process.env.POCKET_SOURCE_BUILD = previousSourceBuild;
    }
    const compressed = readFileSync(join(miniProgram, "engine", "pocketjs.wasm.br"));
    const wasm = brotliDecompressSync(compressed);
    const verification = await verifyWebEngine(wasm);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "pocketjs.wasm"), wasm);
    const bun = process.env.POCKET_BUN || "bun";
    run(bun, ["build", join(SDK_ROOT, "targets/web/browser_runtime.js"), "--target=browser", "--format=esm", `--outfile=${join(output, "pocket-web.js")}`]);
    const runtime = readFileSync(join(output, "pocket-web.js"));
    const renderWorkerSource = join(SDK_ROOT, "targets/web/render_worker.js");
    if (!existsSync(renderWorkerSource) || !statSync(renderWorkerSource).isFile()) {
      throw new Error("build_web_engine: render worker entry is missing: targets/web/render_worker.js");
    }
    run(bun, ["build", renderWorkerSource, "--target=browser", "--format=esm", `--outfile=${join(output, "pocket-render-worker.js")}`]);
    const renderWorker = readFileSync(join(output, "pocket-render-worker.js"));
    writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "pocket-web-engine",
      sdkVersion: "0.1.0",
      sourceBuild: true,
      externalGuestAbi: "web_boot + web_set_identity",
      wasm: "pocketjs.wasm",
      runtime: "pocket-web.js",
      renderWorker: "pocket-render-worker.js",
      wasmBytes: wasm.byteLength,
      runtimeBytes: runtime.byteLength,
      renderWorkerBytes: renderWorker.byteLength,
      exports: verification.exports,
      imports: verification.imports,
    }, null, 2)}\n`);
    return { outDir: output, wasmBytes: wasm.byteLength, runtimeBytes: runtime.byteLength, exports: verification.exports };
  } finally {
    if (process.env.POCKET_WEB_ENGINE_KEEP_TEMP !== "1") rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const result = await buildWebEngine(parseBuildWebEngineArgs(process.argv.slice(2)));
    console.log(`build_web_engine: generated ${result.outDir} (wasm=${result.wasmBytes}, runtime=${result.runtimeBytes})`);
    console.log(`build_web_engine: verified exports ${result.exports.join(", ")}`);
  } catch (error) {
    console.error(`build_web_engine: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
