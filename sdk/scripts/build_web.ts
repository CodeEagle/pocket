import { brotliDecompressSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildWechat } from "./build_wechat.ts";

const SDK_ROOT = resolve(import.meta.dir, "..");
const WEB_TARGET = resolve(SDK_ROOT, "targets/web");

export type BuildWebOptions = {
  projectRoot: string;
  outDir: string;
  entry?: string;
  tickHz?: number;
  rasterDensity?: number;
};

function run(command: string[], cwd: string): void {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed (${result.status ?? 1})\n${result.stdout || ""}${result.stderr || ""}`);
}

function ensureEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length > 0) throw new Error(`build_web: output directory is not empty: ${path}`);
  mkdirSync(path, { recursive: true });
}

function readConfig(path: string): Record<string, unknown> {
  const value = createRequire(import.meta.url)(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("build_web: generated pocket.config.js is invalid");
  return value as Record<string, unknown>;
}

function readme(config: Record<string, unknown>): string {
  const appId = typeof config.appId === "string" ? config.appId : "pocket.guest";
  return `# PocketJS Web consumer\n\n` +
    `This directory is a standalone browser package for **${appId}**. It contains the real pinned PocketJS WebAssembly runtime with the app's admitted QuickJS bytecode and PAK embedded during the build. It does not require Flutter, Dart, Xcode, Android SDK, or a WeChat runtime.\n\n` +
    `Serve this directory over HTTP(S), then import \`pocket-web.js\` and load \`pocket.config.json\`. \`PocketWebRuntime\` accepts an HTML Canvas2D surface:\n\n` +
    "```html\n<canvas id=\"pocket\" style=\"width:100%;height:100%\"></canvas>\n<script type=\"module\">\nimport { PocketWebRuntime } from './pocket-web.js';\nconst canvas = document.querySelector('#pocket');\nconst config = await fetch('./pocket.config.json').then(r => r.json());\nconst runtime = new PocketWebRuntime({ canvas, engineUrl: './engine/pocketjs.wasm', config });\nawait runtime.mount();\n</script>\n```\n\n" +
    `The host provides pointer input, a browser IME overlay, resize/visibility lifecycle and app-scoped \`localStorage\` for manifest-declared \`platform.storage.*\`. Hardware APIs are not silently emulated: register a real capability handler with \`PocketWeb.registerCapability(name, handler)\`, or the guest receives an explicit unsupported/unconfigured error.\n`;
}

export async function buildWeb(options: BuildWebOptions): Promise<{ outDir: string; wasmBytes: number }> {
  const projectRoot = resolve(options.projectRoot);
  const output = resolve(options.outDir);
  ensureEmpty(output);
  const temp = mkdtempSync(join(tmpdir(), "pocketjs-web-build-"));
  const mini = join(temp, "wechat");
  mkdirSync(mini);
  try {
    await buildWechat({ projectRoot, outDir: mini, entry: options.entry, tickHz: options.tickHz, rasterDensity: options.rasterDensity });
    const info = JSON.parse(readFileSync(join(mini, "build-info.json"), "utf8")) as Record<string, unknown>;
    if (info.target !== "wechat-host-qjbc") throw new Error("build_web: expected the real QJBC build stage");
    const wasm = brotliDecompressSync(readFileSync(join(mini, "engine/pocketjs.wasm.br")));
    if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) throw new Error("build_web: generated engine is not a WebAssembly module");
    mkdirSync(join(output, "engine"), { recursive: true });
    writeFileSync(join(output, "engine/pocketjs.wasm"), wasm);
    const config = readConfig(join(mini, "pocket.config.js"));
    writeFileSync(join(output, "pocket.config.json"), `${JSON.stringify({ ...config, enginePath: "engine/pocketjs.wasm" }, null, 2)}\n`);
    const webInfo = { ...info, target: "web-host-qjbc", hostRuntime: "WebAssembly + Canvas2D", enginePath: "engine/pocketjs.wasm" };
    delete webInfo.compressedEngineBytes;
    delete webInfo.compressedEngineSha256;
    writeFileSync(join(output, "build-info.json"), `${JSON.stringify(webInfo, null, 2)}\n`);
    run(["bun", "build", join(WEB_TARGET, "browser_runtime.js"), "--target=browser", "--format=esm", `--outfile=${join(output, "pocket-web.js")}`], SDK_ROOT);
    writeFileSync(join(output, "pocket-web.d.ts"), `export interface PocketWebRuntimeOptions { canvas: HTMLCanvasElement; engineUrl: string; config?: Record<string, unknown>; cache?: RequestCache; inputElement?: HTMLInputElement; onError?: (error: unknown) => void; }\nexport class PocketWebRuntime { constructor(options: PocketWebRuntimeOptions); mount(): Promise<this>; show(): void; hide(): void; dispose(): void; }\nexport function registerCapability(name: string, handler: (params: unknown, context: { signal: AbortSignal; wx: unknown }) => unknown): () => void;\nexport function setPermissionHandler(handler: ((name: string, params: unknown, context: { signal: AbortSignal }) => boolean | Promise<boolean>) | null): void;\n`);
    writeFileSync(join(output, "README.md"), readme(config));
    cpSync(resolve(SDK_ROOT, "../LICENSE"), join(output, "LICENSE"));
    return { outDir: output, wasmBytes: wasm.byteLength };
  } finally {
    if (process.env.POCKET_WEB_KEEP_TEMP !== "1") rmSync(temp, { recursive: true, force: true });
  }
}

export function parseBuildWebArgs(args: string[]): BuildWebOptions {
  const options: Partial<BuildWebOptions> = {};
  for (const arg of args) {
    if (arg.startsWith("--project-root=")) options.projectRoot = arg.slice(15);
    else if (arg.startsWith("--outdir=")) options.outDir = arg.slice(9);
    else if (arg.startsWith("--entry=")) options.entry = arg.slice(8);
    else if (arg.startsWith("--tick-hz=")) options.tickHz = Number(arg.slice(10));
    else if (arg.startsWith("--density=")) options.rasterDensity = Number(arg.slice(10));
    else throw new Error(`build_web: unknown option ${arg}`);
  }
  if (!options.projectRoot || !options.outDir) throw new Error("usage: bun sdk/scripts/build_web.ts --project-root=<consumer> --outdir=<new-web-dir>");
  return options as BuildWebOptions;
}

if (import.meta.main) {
  try {
    const result = await buildWeb(parseBuildWebArgs(process.argv.slice(2)));
    console.log(`build_web: generated ${result.outDir} (wasm=${result.wasmBytes})`);
  } catch (error) {
    console.error(`build_web: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
