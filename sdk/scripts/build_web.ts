import { brotliDecompressSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, cpSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "./build_guest.ts";

const SDK_ROOT = resolve(import.meta.dir, "..");

export type BuildWebOptions = {
  projectRoot: string;
  outDir: string;
  entry?: string;
  tickHz?: number;
  rasterDensity?: number;
  enginePath?: string;
  runtimePath?: string;
};

function ensureEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length > 0) throw new Error(`build_web: output directory is not empty: ${path}`);
  mkdirSync(path, { recursive: true });
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`build_web: invalid JSON object: ${path}`);
  return value as Record<string, unknown>;
}

function requiredFile(path: string, label: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`build_web: ${label} is missing: ${path}`);
  return path;
}

function prebuiltFile(explicit: string | undefined, envName: string): string | undefined {
  const value = explicit || process.env[envName];
  if (value?.trim()) return resolve(value.trim());
  const toolsRoot = process.env.POCKET_TOOLS_PACKAGE?.trim();
  if (!toolsRoot) return undefined;
  const candidates = envName === "POCKET_WEB_ENGINE"
    ? ["engine/pocketjs.wasm", "engine/pocketjs.wasm.br", "web/pocketjs.wasm", "web/pocketjs.wasm.br"]
    : ["web/pocket-web.js", "runtime/pocket-web.js", "pocket-web.js"];
  return candidates.map((candidate) => resolve(toolsRoot, candidate)).find((candidate) => existsSync(candidate));
}

function copyPrebuiltEngine(source: string, output: string): number {
  const input = requiredFile(source, "POCKET_WEB_ENGINE");
  const raw = readFileSync(input);
  const wasm = input.endsWith(".br") ? brotliDecompressSync(raw) : raw;
  if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) {
    throw new Error("build_web: prebuilt PocketJS engine is not a WebAssembly module");
  }
  mkdirSync(join(output, "engine"), { recursive: true });
  writeFileSync(join(output, "engine/pocketjs.wasm"), wasm);
  return wasm.byteLength;
}

function copyRuntimeBundle(source: string, output: string): void {
  copyFileSync(requiredFile(source, "POCKET_WEB_RUNTIME"), join(output, "pocket-web.js"));
}

function readme(config: Record<string, unknown>): string {
  const appId = typeof config.appId === "string" ? config.appId : "pocket.guest";
  return `# PocketJS Web consumer\n\n` +
    `This directory is a standalone browser package for **${appId}**. It contains the real pinned PocketJS WebAssembly runtime with the app's admitted QuickJS bytecode and PAK embedded during the build. It does not require Flutter, Dart, Xcode, Android SDK, or a WeChat runtime.\n\n` +
    `Serve this directory over HTTP(S), then import \`pocket-web.js\` and load \`pocket.config.json\`. \`PocketWebRuntime\` accepts an HTML Canvas2D surface:\n\n` +
    "```html\n<canvas id=\"pocket\" style=\"width:100%;height:100%\"></canvas>\n<script type=\"module\">\nimport { PocketWebRuntime } from './pocket-web.js';\nconst canvas = document.querySelector('#pocket');\nconst config = await fetch('./pocket.config.json').then(r => r.json());\nconst runtime = new PocketWebRuntime({ canvas, engineUrl: './engine/pocketjs.wasm', qjbcUrl: './app.qjbc', pakUrl: './app.pak', config });\nawait runtime.mount();\n</script>\n```\n\n" +
    `The host provides pointer input, a browser IME overlay, resize/visibility lifecycle and app-scoped \`localStorage\` for manifest-declared \`platform.storage.*\`. Hardware APIs are not silently emulated: register a real capability handler with \`PocketWeb.registerCapability(name, handler)\`, or the guest receives an explicit unsupported/unconfigured error.\n`;
}

export async function buildWeb(options: BuildWebOptions): Promise<{ outDir: string; wasmBytes: number }> {
  const projectRoot = resolve(options.projectRoot);
  const output = resolve(options.outDir);
  ensureEmpty(output);
  const temp = mkdtempSync(join(tmpdir(), "pocketjs-web-build-"));
  const guest = join(temp, "guest");
  mkdirSync(guest);
  try {
    const engine = prebuiltFile(options.enginePath, "POCKET_WEB_ENGINE");
    if (!engine) throw new Error("build_web: a prebuilt generic PocketJS engine is required; set POCKET_WEB_ENGINE (the npm release supplies this file)");
    const runtime = prebuiltFile(options.runtimePath, "POCKET_WEB_RUNTIME");
    if (!runtime) throw new Error("build_web: a prebundled browser host is required; set POCKET_WEB_RUNTIME (the npm release supplies pocket-web.js)");
    const built = await buildGuest({ projectRoot, outDir: guest, entry: options.entry, tickHz: options.tickHz, rasterDensity: options.rasterDensity });
    const metadata = readJson(built.metadata);
    const pocket = readJson(join(projectRoot, "pocket.json"));
    const manifest = readJson(join(projectRoot, "manifest.json"));
    const capabilities = manifest.capabilities && typeof manifest.capabilities === "object" && !Array.isArray(manifest.capabilities)
      ? manifest.capabilities as Record<string, unknown> : {};
    const bindingGeneration = Number(metadata.bindingGeneration || 0);
    if (!Number.isInteger(bindingGeneration) || bindingGeneration < 1) {
      throw new Error("build_web: app.bytecode.json is missing a valid bindingGeneration");
    }
    const wasmBytes = copyPrebuiltEngine(engine, output);
    copyFileSync(built.bytecode, join(output, "app.qjbc"));
    copyFileSync(built.pak, join(output, "app.pak"));
    copyFileSync(built.metadata, join(output, "app.bytecode.json"));
    copyFileSync(join(guest, "guest-manifest.json"), join(output, "guest-manifest.json"));
    const config = {
      appId: typeof pocket.id === "string" && pocket.id ? pocket.id : "pocket.guest",
      tickHz: built.tickHz,
      rasterDensity: options.rasterDensity ?? 1,
      enginePath: "engine/pocketjs.wasm",
      qjbcUrl: "app.qjbc",
      pakUrl: "app.pak",
      bindingGeneration,
      requires: Array.isArray(capabilities.requires) ? capabilities.requires : [],
      optional: Array.isArray(capabilities.optional) ? capabilities.optional : [],
      metadata,
    };
    writeFileSync(join(output, "pocket.config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const webInfo = { target: "web-host-qjbc", appId: config.appId, hostRuntime: "WebAssembly + Canvas2D", enginePath: "engine/pocketjs.wasm", qjbc: "app.qjbc", pak: "app.pak", bindingGeneration: config.bindingGeneration, tickHz: built.tickHz, wasmBytes };
    writeFileSync(join(output, "build-info.json"), `${JSON.stringify(webInfo, null, 2)}\n`);
    copyRuntimeBundle(runtime, output);
    writeFileSync(join(output, "pocket-web.d.ts"), `export interface PocketWebRuntimeOptions { canvas: HTMLCanvasElement; engineUrl: string; qjbcUrl?: string; pakUrl?: string; config?: Record<string, unknown>; cache?: RequestCache; inputElement?: HTMLInputElement; onError?: (error: unknown) => void; }\nexport class PocketWebRuntime { constructor(options: PocketWebRuntimeOptions); mount(): Promise<this>; show(): void; hide(): void; dispose(): void; }\nexport function registerCapability(name: string, handler: (params: unknown, context: { signal: AbortSignal; wx: unknown }) => unknown): () => void;\nexport function setPermissionHandler(handler: ((name: string, params: unknown, context: { signal: AbortSignal }) => boolean | Promise<boolean>) | null): void;\n`);
    writeFileSync(join(output, "README.md"), readme(config));
    cpSync(existsSync(join(SDK_ROOT, "LICENSE")) ? join(SDK_ROOT, "LICENSE") : resolve(SDK_ROOT, "../LICENSE"), join(output, "LICENSE"));
    return { outDir: output, wasmBytes };
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
    else if (arg.startsWith("--engine=")) options.enginePath = arg.slice(9);
    else if (arg.startsWith("--runtime=")) options.runtimePath = arg.slice(10);
    else throw new Error(`build_web: unknown option ${arg}`);
  }
  if (!options.projectRoot || !options.outDir) throw new Error("usage: bun sdk/scripts/build_web.ts --project-root=<consumer> --outdir=<new-web-dir> [--engine=<prebuilt.wasm>] [--runtime=<pocket-web.js>]");
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
