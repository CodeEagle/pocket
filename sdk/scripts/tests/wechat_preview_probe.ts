// Actual Lobby bytecode / WASM acceptance. Pass a build_wechat output directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startWechatPreview } from "../preview_wechat.ts";

const artifacts = process.argv[2];
if (!artifacts) throw new Error("Usage: bun sdk/scripts/tests/wechat_preview_probe.ts <Lobby WeChat build>");
const temp = mkdtempSync(join(tmpdir(), "pocket-wechat-browser-"));
const { server, url } = await startWechatPreview({ miniprogramRoot: resolve(artifacts), outDir: temp });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll("iframe").length >= 2);
  const service = page.frames().find(frame => frame.url().includes("/appservice.html"));
  if (!service) throw new Error("Official WeChat service frame did not start");
  let booted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    booted = await service.evaluate(() => !!(globalThis as any).getCurrentPages?.()[0]?._host?.exports);
    if (booted) break;
    await page.waitForTimeout(100);
  }
  if (!booted) throw new Error("Pocket WASM did not boot within 10 seconds");
  await service.evaluate(() => {
    const global = globalThis as any;
    const host = global.getCurrentPages()[0]._host;
    global.__pocketInputs = [];
    const original = host.inputFrame.bind(host);
    host.inputFrame = (contacts: unknown[]) => { global.__pocketInputs.push(contacts); return original(contacts); };
  });
  const pixels = () => service.evaluate(() => {
    const host = (globalThis as any).getCurrentPages()[0]._host;
    const bytes = new Uint8Array(host.exports.memory.buffer, host.exports.web_pixels(host.host), host.exports.web_pixels_len(host.host));
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  });
  // Allow async initial storage responses to settle before measuring input.
  await page.waitForTimeout(500);
  const before = await pixels();
  const view = page.frames().find(frame => frame.url().includes("/webview/pages/"));
  const canvas = await view?.locator("canvas").first().boundingBox();
  if (!canvas) throw new Error("Actual Canvas2D surface not found");
  // Current Lobby's increment button in its 375 x 812 logical surface.
  await page.mouse.click(canvas.x + canvas.width * 0.5, canvas.y + 413);
  await page.waitForTimeout(500);
  const after = await pixels();
  const state = await service.evaluate(() => ({ error: (globalThis as any).getCurrentPages()[0].data.error,
    inputs: (globalThis as any).__pocketInputs }));
  if (errors.length || state.error || before === after || state.inputs.length !== 2 || state.inputs[0].length !== 1 || state.inputs[1].length !== 0) {
    throw new Error(JSON.stringify({ errors, state, before, after }));
  }
  const screenshot = process.env.POCKET_WECHAT_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ pass: true, realWasm: true, browserErrors: errors.length, inputFrames: state.inputs.length, before, after }));
} finally {
  await browser?.close();
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
