/**
 * End-to-end browser acceptance for the complete PocketSystem WeChat target.
 *
 * This deliberately drives the rendered Canvas with mouse input. It does not
 * call system.runtime.* or mutate a Guest from the page context as a shortcut.
 * The service-frame inspection is read-only evidence that the same input made
 * the real SystemUI Guest create and compose child runtimes.
 *
 * Usage:
 *   bun sdk/scripts/tests/wechat_system_preview_probe.ts <system-build-dir>
 *
 * The argument is a build_wechat output directory whose build-info composition
 * is system-multi-guest. Playwright resolves its bundled Chromium; no system
 * Chrome process is started.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Frame, type Page } from "playwright";
import { startWechatPreview } from "../preview_wechat.ts";

type JsonRecord = Record<string, any>;
type RuntimeEvidence = {
  appId: string;
  instanceId: string;
  generation: number;
  logicalWidth: number;
  logicalHeight: number;
  hasExports: boolean;
  scale: number;
  surfaceHandle: number;
};
type SystemEvidence = {
  root: { appId: string; logicalWidth: number; logicalHeight: number; hasExports: boolean };
  catalog: Array<{ appId: string; index: number; surfaceHandle?: number }>;
  runtimes: RuntimeEvidence[];
  frames: Array<{ handle: number; focused: boolean; full: number[] }>;
};

function fail(message: string, evidence?: unknown): never {
  const detail = evidence === undefined ? "" : ` ${JSON.stringify(evidence)}`;
  throw new Error(`${message}${detail}`);
}

function assert(condition: unknown, message: string, evidence?: unknown): asserts condition {
  if (!condition) fail(message, evidence);
}

function serviceFrame(page: Page): Frame {
  const frame = page.frames().find(value => value.url().includes("/appservice.html"));
  if (!frame) fail("official WeChat appservice frame did not start", page.frames().map(value => value.url()));
  return frame;
}

async function waitForService(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const frame = page.frames().find(value => value.url().includes("/appservice.html"));
    if (frame) {
      const booted = await frame.evaluate(() => {
        const guest = (globalThis as any).getCurrentPages?.()[0];
        const host = guest?._host;
        return !!host?.exports && !!host?.system;
      }).catch(() => false);
      if (booted) return frame;
    }
    await page.waitForTimeout(100);
  }
  return serviceFrame(page);
}

async function readEvidence(service: Frame): Promise<SystemEvidence> {
  return service.evaluate(() => {
    const guest = (globalThis as any).getCurrentPages?.()[0];
    const host = guest?._host;
    const system = host?.system;
    if (!host || !system) throw new Error("PocketSystem host is unavailable");
    const runtimes = [...system.runtimes.values()].map((runtime: any) => ({
      appId: String(runtime.config?.appId ?? ""),
      instanceId: String(runtime.instanceId ?? ""),
      generation: Number(runtime.runtimeGeneration ?? 0),
      logicalWidth: Number(runtime.logicalWidth ?? 0),
      logicalHeight: Number(runtime.logicalHeight ?? 0),
      hasExports: !!runtime.exports,
      scale: Number(runtime.scale),
      surfaceHandle: Number(runtime.config?.surfaceHandle ?? 0),
    }));
    const frames = system.frames().map((frame: any) => ({
      handle: Number(frame.handle ?? 0),
      focused: frame.focused === true,
      full: Array.isArray(frame.full) ? frame.full.map(Number) : [],
    }));
    return {
      root: {
        appId: String(host.config?.appId ?? ""),
        logicalWidth: Number(host.logicalWidth ?? 0),
        logicalHeight: Number(host.logicalHeight ?? 0),
        hasExports: !!host.exports,
      },
      catalog: Array.isArray(host.config?.system?.apps) ? host.config.system.apps.map((app: any) => ({
        appId: String(app.appId ?? ""),
        index: Number(app.index ?? -1),
        ...(app.surfaceHandle === undefined ? {} : { surfaceHandle: Number(app.surfaceHandle) }),
      })) : [],
      runtimes,
      frames,
    };
  });
}

async function framebufferHash(service: Frame, runtimeAppId?: string): Promise<number> {
  return service.evaluate((appId) => {
    const page = (globalThis as any).getCurrentPages?.()[0];
    const host = appId
      ? [...(page?._host?.system?.runtimes?.values?.() ?? [])].find((value: any) => value.config?.appId === appId)
      : page?._host;
    if (!host?.exports || !host.host) throw new Error(`WASM host is unavailable for ${appId || "SystemUI"}`);
    const pointer = host.exports.web_pixels(host.host);
    const length = host.exports.web_pixels_len(host.host);
    const bytes = new Uint8Array(host.exports.memory.buffer, pointer, length);
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  }, runtimeAppId);
}

async function canvasBox(view: Frame): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await view.locator("canvas").first().boundingBox();
  if (!box) fail("WeChat Canvas2D surface was not found");
  return box;
}

async function clickLogical(page: Page, view: Frame, x: number, y: number, width: number, height: number): Promise<void> {
  const box = await canvasBox(view);
  await page.mouse.click(box.x + box.width * x / width, box.y + box.height * y / height);
}

async function dragLogical(page: Page, view: Frame, from: [number, number], to: [number, number], width: number, height: number): Promise<void> {
  const box = await canvasBox(view);
  const point = (x: number, y: number) => [box.x + box.width * x / width, box.y + box.height * y / height] as const;
  const start = point(...from);
  const end = point(...to);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 8 });
  await page.mouse.up();
}

async function waitForRuntime(service: Frame, appId: string, expectedCount?: number): Promise<SystemEvidence> {
  let latest!: SystemEvidence;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await readEvidence(service);
    if (latest.runtimes.some(runtime => runtime.appId === appId) &&
        (expectedCount === undefined || latest.runtimes.length === expectedCount)) return latest;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  fail(`runtime ${appId} was not created by rendered input`, latest);
}

async function waitForRuntimeGone(service: Frame, appId: string): Promise<{ samples: SystemEvidence[]; final: SystemEvidence }> {
  const samples: SystemEvidence[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = await readEvidence(service);
    samples.push(evidence);
    if (!evidence.runtimes.some(runtime => runtime.appId === appId)) return { samples, final: evidence };
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  fail(`runtime ${appId} did not disappear after the close animation`, samples.at(-1));
}

async function closeFocusedRuntime(page: Page, view: Frame, service: Frame, width: number, height: number, appId: string): Promise<SystemEvidence> {
  const before = await readEvidence(service);
  const samples: SystemEvidence[] = [];
  // One real click at the WeChat-capsule-safe close control (global 564,111;
  // logical 251,74 on the current 375x812 target). Repeated candidate taps
  // could conceal a broken hit-test or restart a transition.
  await clickLogical(page, view, 251, 74, width, height);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = await readEvidence(service);
    samples.push(evidence);
    if (!evidence.runtimes.some(runtime => runtime.appId === appId)) {
      const intermediate = samples.filter(value => value.runtimes.some(runtime => runtime.appId === appId));
      const focusedYs = new Set(intermediate.flatMap(value => value.frames
        .filter(frame => frame.handle === before.runtimes.find(runtime => runtime.appId === appId)?.surfaceHandle && frame.full.length === 4)
        .map(frame => frame.full[1])));
      assert(intermediate.length >= 2 && focusedYs.size >= 2,
        "close did not expose at least two distinct reverse-animation surface positions", { before, samples });
      return evidence;
    }
    await page.waitForTimeout(50);
  }
  fail(`focused runtime ${appId} did not close from the rendered top-right control`, { before, samples });
}

const artifacts = process.argv[2];
if (!artifacts) throw new Error("Usage: bun sdk/scripts/tests/wechat_system_preview_probe.ts <system-build-dir>");

const temp = mkdtempSync(join(tmpdir(), "pocket-wechat-system-browser-"));
const { server, url } = await startWechatPreview({ miniprogramRoot: resolve(artifacts), outDir: temp });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: Number(process.env.POCKET_WECHAT_SYSTEM_DPR || 2) });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(url);
  const service = await waitForService(page);
  const view = page.frames().find(frame => frame.url().includes("/webview/pages/"));
  if (!view) fail("official WeChat webview frame did not start", page.frames().map(frame => frame.url()));
  await page.waitForTimeout(5000);
  const initial = await readEvidence(service);
  assert(initial.root.hasExports, "SystemUI WASM exports are unavailable", initial);
  assert(initial.catalog.length >= 3, "the WeChat artifact is not the complete project catalog", initial);
  assert(initial.catalog.some(app => app.index === 0 && app.appId === initial.root.appId), "catalog index 0 is not SystemUI", initial);
  assert(initial.runtimes.length === 0, "child runtime unexpectedly exists before input", initial);
  const width = initial.root.logicalWidth;
  const height = initial.root.logicalHeight;
  assert(width > 0 && height > 0, "invalid SystemUI logical viewport", initial);

  const capabilities = await service.evaluate(async () => {
    const host = (globalThis as any).getCurrentPages()[0]._host;
    const responses: Record<string, any> = {};
    const respond = host.respond;
    host.respond = function(request: any, ok: boolean, result: any, error: any) {
      if (request.requestId.startsWith("review-readonly-")) responses[request.capability] = { ok, result, error };
      else return respond.call(this, request, ok, result, error);
    };
    try {
      for (const capability of ["runtime.info", "plugins.packageInfo", "plugins.list", "updates.status"]) {
        await host.handleRequest({ requestId: `review-readonly-${capability}`, capability });
      }
    } finally { host.respond = respond; }
    return { responses, scale: host.scale, canvas: [host.canvas.width, host.canvas.height],
      devicePixelRatio: host.currentDevicePixelRatio(), hasDensityUpload: typeof host.exports.web_wechat_upload_surface === "function" };
  });
  assert(Object.values(capabilities.responses).every((value: any) => value.ok), "read-only host metadata requests failed", capabilities);
  assert(capabilities.responses["runtime.info"].result.runtimeAbi && capabilities.responses["runtime.info"].result.entryBytes > 0,
    "runtime metadata was not packaged", capabilities);
  assert(capabilities.responses["plugins.packageInfo"].result.version, "Guest package version was not packaged", capabilities);
  assert(capabilities.devicePixelRatio === await page.evaluate(() => window.devicePixelRatio), "preview used emulated phone scale instead of browser screen", capabilities);
  assert(capabilities.scale === Math.min(4, Math.ceil(capabilities.devicePixelRatio), Math.floor(4096 / width), Math.floor(4096 / height)),
    "browser preview did not retain the admitted screen density", capabilities);
  assert(capabilities.canvas[0] === width * capabilities.scale && capabilities.canvas[1] === height * capabilities.scale && capabilities.hasDensityUpload,
    "real Canvas backing store or compositor density upload is missing", capabilities);
  const homeHash = await framebufferHash(service);
  // The WeChat window reserves a 34px home-indicator inset. NavigationBar's
  // 56px control center is therefore height - 34 - 28 = height - 62.
  const tabY = height - 64;
  await clickLogical(page, view, width * 0.5, tabY, width, height); // Gallery tab
  await page.waitForTimeout(700);
  const galleryHash = await framebufferHash(service);
  assert(galleryHash !== homeHash, "Home -> Gallery did not change the real SystemUI framebuffer");
  await clickLogical(page, view, width * 5 / 6, tabY, width, height); // Host tab
  await page.waitForTimeout(700);
  const hostHash = await framebufferHash(service);
  assert(hostHash !== galleryHash, "Gallery -> Host did not change the real SystemUI framebuffer");
  await clickLogical(page, view, width / 6, tabY, width, height); // back Home
  await page.waitForTimeout(700);
  const homeAgainHash = await framebufferHash(service);
  assert(homeAgainHash !== hostHash, "Host -> Home did not change the real SystemUI framebuffer");

  await dragLogical(page, view, [187, 553], [187, 263], width, height);
  await page.waitForTimeout(1500);
  await clickLogical(page, view, 187, 453, width, height);
  await waitForRuntime(service, "pocket.demo.profile", 1);
  await page.waitForTimeout(1400);
  const profile = await readEvidence(service);
  assert(profile.runtimes.every(runtime => runtime.hasExports), "Profile runtime lacks WASM exports", profile);
  await clickLogical(page, view, 187, 483, width, height); // select Lin
  await page.waitForTimeout(200);
  await clickLogical(page, view, 187, 628, width, height); // Save/open Lobby
  await waitForRuntime(service, "pocket.demo.lobby", 2);
  await page.waitForTimeout(1600);
  const both = await readEvidence(service);
  assert(both.runtimes.some(runtime => runtime.appId === "pocket.demo.profile"), "Profile runtime was not retained while opening Lobby", both);
  assert(both.runtimes.some(runtime => runtime.appId === "pocket.demo.lobby"), "Profile -> Lobby did not create Lobby from rendered input", both);
  assert(both.runtimes.every(runtime => runtime.hasExports), "Nested runtime is not backed by real WASM exports", both);
  assert(both.runtimes.every(runtime => runtime.scale === capabilities.scale), "child runtime lost root density", both);
  assert(both.frames.filter(frame => frame.handle > 1).length >= 2, "compositor did not retain both child surfaces", both);

  const lobbyBefore = await framebufferHash(service, "pocket.demo.lobby");
  await clickLogical(page, view, 187, 458, width, height);
  await page.waitForTimeout(200);
  const lobbyAfter = await framebufferHash(service, "pocket.demo.lobby");
  assert(lobbyAfter !== lobbyBefore, "Lobby child framebuffer did not change after rendered input", both);

  const afterLobbyClose = await closeFocusedRuntime(page, view, service, width, height, "pocket.demo.lobby");
  assert(afterLobbyClose.runtimes.some(runtime => runtime.appId === "pocket.demo.profile"), "closing Lobby also destroyed retained Profile", afterLobbyClose);
  assert(!afterLobbyClose.runtimes.some(runtime => runtime.appId === "pocket.demo.lobby"), "Lobby runtime remains after reverse close", afterLobbyClose);
  const afterProfileClose = await closeFocusedRuntime(page, view, service, width, height, "pocket.demo.profile");
  assert(afterProfileClose.runtimes.length === 0, "Profile runtime remains after reverse close", afterProfileClose);
  assert(pageErrors.length === 0, "browser page errors occurred during complete App flow", pageErrors);
  const screenshot = process.env.POCKET_WECHAT_SYSTEM_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ pass: true, completeApp: true, realWasm: true, browserErrors: pageErrors.length,
    catalog: initial.catalog.map(app => app.appId), initial: initial.runtimes.length, nested: both.runtimes.map(runtime => runtime.appId),
    final: afterProfileClose.runtimes.length, capabilities, homeHash, galleryHash, hostHash, homeAgainHash, lobbyBefore, lobbyAfter }));
} finally {
  await browser?.close();
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
