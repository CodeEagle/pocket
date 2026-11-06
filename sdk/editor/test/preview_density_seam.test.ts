import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { chromium } from "playwright";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const demoRoot = join(repositoryRoot, "demo/js");
const profileAppId = "pocket.demo.profile";
const lobbyAppId = "pocket.demo.lobby";
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);
const logicalWidth = 390;
const logicalHeight = 844;
const fractionalDpr = 1.8;

function managerFor(clientPath: string) {
  return createPreviewManager({
    clientPath,
    probePath: probe,
    projectDirectory: demoRoot,
    width: logicalWidth,
    height: logicalHeight,
    idleDisposeMs: 1_000,
    artifacts: {
      bytecodePath: join(repositoryRoot, "demo/assets/app.qjbc"),
      pakPath: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
      compositorSurfaces: { [profileAppId]: 2, [lobbyAppId]: 3 },
      applications: {
        [profileAppId]: {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/profile/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/profile/app.pak"),
          appId: profileAppId,
        },
        [lobbyAppId]: {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/lobby/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/lobby/app.pak"),
          appId: lobbyAppId,
        },
      },
    },
  });
}

function startServer(manager: ReturnType<typeof createPreviewManager>, projectId: string) {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      const route = pathname.endsWith("/stream") ? "stream" : pathname.endsWith("/input") ? "input" : "page";
      return manager.handle(request, projectId, route);
    },
  });
}

async function readOpenProfileButton(preview: any): Promise<Record<string, any>> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await preview.evaluate(() => {
      const instance = (window as any).PocketEditorPreviewInstance;
      const frame = instance?.getFrame?.();
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      const context = canvas?.getContext("2d");
      if (!frame || !canvas || !context) return null;
      const text = frame.ops.find((op: any) => op?.type === "text" && op.text === "Open profile app");
      if (!text) return null;
      const nearLabel = frame.ops.filter((op: any) => op?.type === "rect" &&
        Number(op.w) >= 250 && Math.abs(Number(op.y) - Number(text.y)) < 32);
      const byColor = new Map<number, any[]>();
      for (const op of nearLabel) {
        const color = Number(op.color) >>> 0;
        const group = byColor.get(color) ?? [];
        group.push(op);
        byColor.set(color, group);
      }
      const rects = [...byColor.values()].sort((left, right) => right.length - left.length)[0] ?? [];
      if (rects.length !== 3) return null;
      const left = Math.min(...rects.map((op: any) => Number(op.x)));
      const top = Math.min(...rects.map((op: any) => Number(op.y)));
      const right = Math.max(...rects.map((op: any) => Number(op.x) + Number(op.w)));
      const bottom = Math.max(...rects.map((op: any) => Number(op.y) + Number(op.h)));
      if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
      // Read one column away from the label. The browser canvas stores
      // physical pixels, while native DrawOps and rect geometry are logical.
      const px = Math.max(0, Math.min(canvas.width - 1, Math.floor((left + 20) * canvas.width / frame.width)));
      const expectedColor = Number(rects[0].color) >>> 0;
      const expected = [
        (expectedColor >>> 16) & 0xff,
        (expectedColor >>> 8) & 0xff,
        expectedColor & 0xff,
        (expectedColor >>> 24) & 0xff,
      ];
      const rows: Array<{ logicalY: number; physicalY: number; rgba: number[] }> = [];
      for (let logicalY = Math.ceil(top + 1); logicalY < Math.floor(bottom - 1); logicalY += 1) {
        const physicalY = Math.max(0, Math.min(canvas.height - 1, Math.floor(logicalY * canvas.height / frame.height)));
        rows.push({ logicalY, physicalY, rgba: Array.from(context.getImageData(px, physicalY, 1, 1).data) });
      }
      return {
        backing: { width: canvas.width, height: canvas.height },
        frame: { width: frame.width, height: frame.height },
        rects,
        expected,
        rows,
        badRows: rows.filter((row) => row.rgba.some((value, index) => value !== expected[index])),
      };
    });
    if (result) return result;
    await Bun.sleep(16);
  }
  throw new Error("native Showcase frame did not settle with its Open profile app button");
}

async function renderButton(clientPath: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const projectId = `density-seam-${Math.random().toString(36).slice(2)}`;
  const manager = managerFor(clientPath);
  const server = startServer(manager, projectId);
  const context = await browser.newContext({
    viewport: { width: logicalWidth, height: logicalHeight },
    deviceScaleFactor: fractionalDpr,
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/api/projects/${projectId}/preview`);
    assert.equal(response?.status(), 200, "native preview page response");
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });
    return await readOpenProfileButton(page);
  } finally {
    await page.close();
    await context.close();
    server.stop(true);
    await manager.dispose();
  }
}

test("fractional browser DPR uses one supersampled raster for native rounded seams", { timeout: 180_000 }, async () => {
  assert.ok(probe, `pocket_probe is required for fractional-DPR seam acceptance: ${probeCandidates.join(", ")}`);
  const clientPath = join(sdkRoot, "editor/client/preview.js");
  const source = readFileSync(clientPath, "utf8");
  const fixedDensity = "const density = Math.max(1, Math.ceil(number(global.devicePixelRatio, 1)));";
  const oldDensity = "const density = Math.max(1, number(global.devicePixelRatio, 1));";
  assert.ok(source.includes(fixedDensity), "production client must use integer supersampling");
  const ablatedSource = source.replace(fixedDensity, oldDensity);
  assert.notEqual(ablatedSource, source, "old-density ablation must differ from production client");
  const tempDir = mkdtempSync(join(tmpdir(), "pocket-preview-density-seam-"));
  const oldClientPath = join(tempDir, "preview.js");
  await Bun.write(oldClientPath, ablatedSource);
  const browser = await chromium.launch({ headless: true });
  try {
    const fixed = await renderButton(clientPath, browser);
    assert.deepEqual(fixed.backing, { width: 780, height: 1688 }, "fractional DPR should ceil one shared backing density");
    assert.equal(fixed.badRows.length, 0, `fixed native button has interior seam rows: ${JSON.stringify(fixed.badRows)}`);

    const ablated = await renderButton(oldClientPath, browser);
    assert.deepEqual(ablated.backing, { width: 702, height: 1519 }, "negative control must retain the old independently-rounded backing");
    assert.ok(ablated.badRows.length > 0, `old fractional-DPR projection unexpectedly hid the seam: ${JSON.stringify(ablated.rows)}`);
  } finally {
    await browser.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
