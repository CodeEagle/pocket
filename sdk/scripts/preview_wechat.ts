import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { DevServer } from "@open-wxa/wxa-runner-core";
import { buildWechat } from "./build_wechat.ts";

/** Browser staging only: the canonical mini-program package remains unchanged. */
export function prepareWechatRunner(miniprogramRoot: string, runnerRoot: string): void {
  const metadata = JSON.parse(readFileSync(join(miniprogramRoot, "build-info.json"), "utf8"));
  if (metadata.target !== "wechat-host-qjbc" || !["single-guest-primary-surface", "system-multi-guest-primary-surface"].includes(metadata.composition)) {
    throw new Error("Expected an official Pocket WeChat build");
  }
  const compressed = readFileSync(join(miniprogramRoot, "engine/pocketjs.wasm.br"));
  const wasm = brotliDecompressSync(compressed);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  if (hash(compressed) !== metadata.compressedEngineSha256 || hash(wasm) !== metadata.engineSha256 ||
      !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error("WeChat engine integrity check failed");
  }
  if (resolve(miniprogramRoot) === resolve(runnerRoot)) throw new Error("Browser staging must be separate from the mini-program package");
  if (existsSync(runnerRoot) && readdirSync(runnerRoot).length) throw new Error("Browser staging directory must be empty");
  cpSync(miniprogramRoot, runnerRoot, { recursive: true });
  writeFileSync(join(runnerRoot, "engine/pocketjs.browser.wasm"), wasm);
  const app = readFileSync(join(runnerRoot, "app.js"), "utf8");
  // wxa-runner's official service realm hides WebAssembly. Its same-origin
  // parent supplies the browser implementation; the Pocket engine is identical.
  const adapter = `// Browser-only marker: the generated device package keeps the native
// 1365px Canvas2D limit, while this parent Canvas can preserve Retina pixels.
wx.__pocketBrowserPreview = true;
// The WXA webview reports its emulated phone ratio (usually 3).  The actual
// preview surface belongs to the browser, so read the parent window's current
// devicePixelRatio instead of baking a phone profile into the adapter.  Keep
// this as a function: moving the preview between displays can change the
// browser ratio without rebuilding the mini-program package.
wx.__pocketBrowserDevicePixelRatio = function() {
  var owner = globalThis.parent && typeof globalThis.parent.devicePixelRatio === 'number'
    ? globalThis.parent : globalThis;
  var ratio = Number(owner.devicePixelRatio);
  return isFinite(ratio) && ratio > 0 ? ratio : 1;
};
wx.WXWebAssembly = { instantiate: async function(path, imports) {
    if (path !== 'engine/pocketjs.wasm.br') throw new Error('Unsupported Pocket WASM path: ' + path);
    var response = await globalThis.fetch('/engine/pocketjs.browser.wasm');
    if (!response.ok) throw new Error('Pocket WASM HTTP ' + response.status);
    return globalThis.parent.WebAssembly.instantiate(await response.arrayBuffer(), imports);
  }};\n`;
  writeFileSync(join(runnerRoot, "app.js"), adapter + app);
}

export async function startWechatPreview(options: { projectRoot?: string; miniprogramRoot?: string; outDir: string; port?: number }) {
  const output = resolve(options.outDir);
  if (existsSync(output) && readdirSync(output).length) throw new Error("Preview output directory must be empty");
  mkdirSync(output, { recursive: true });
  let artifacts = options.miniprogramRoot && resolve(options.miniprogramRoot);
  if (!artifacts) {
    if (!options.projectRoot) throw new Error("A project root or existing mini-program build is required");
    artifacts = join(output, "miniprogram");
    await buildWechat({ projectRoot: resolve(options.projectRoot), outDir: artifacts });
  }
  const runnerRoot = join(output, "runner");
  prepareWechatRunner(artifacts, runnerRoot);
  const server = new DevServer({ projectPath: runnerRoot, host: "127.0.0.1", port: options.port ?? 0,
    watch: false, forwardConsole: true, baseLibVersion: "3.7.0" });
  try { return { server, url: await server.start() }; }
  catch (error) { await server.close().catch(() => {}); throw error; }
}

if (import.meta.main) {
  try {
    const options: { projectRoot?: string; miniprogramRoot?: string; outDir: string; port?: number } = {
      outDir: resolve(".pocket-build/wechat-preview", randomUUID()),
    };
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith("--project-root=")) options.projectRoot = arg.slice(15);
      else if (arg.startsWith("--miniprogram-root=")) options.miniprogramRoot = arg.slice(19);
      else if (arg.startsWith("--outdir=")) options.outDir = arg.slice(9);
      else if (arg.startsWith("--port=")) {
        options.port = Number(arg.slice(7));
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid port");
      } else throw new Error(`Unknown option: ${arg}`);
    }
    if (!!options.projectRoot === !!options.miniprogramRoot) throw new Error("Pass exactly one of --project-root or --miniprogram-root");
    const { server, url } = await startWechatPreview(options);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await server.close(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`POCKET_WECHAT_PREVIEW_URL=${url}`);
  } catch (error) {
    console.error(`preview_wechat: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
