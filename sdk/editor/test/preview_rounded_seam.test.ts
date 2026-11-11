import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { chromium } from "playwright";
import { createPreviewManager, type PreviewFrame } from "../preview.ts";

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

function startServer(manager: ReturnType<typeof createPreviewManager>, projectId: string) {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      const route = pathname.endsWith("/stream") ? "stream" : pathname.endsWith("/input") ? "input" : "page";
      return manager.handle(request, projectId, route);
    },
  });
  return server;
}

function managerFor(clientPath: string) {
  return createPreviewManager({
    clientPath,
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 1_000,
    artifacts: {
      bytecodePath: join(repositoryRoot, "demo/assets/app.qjbc"),
      pakPath: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
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

async function renderProfileButton(clientPath: string, sharedBrowser?: Awaited<ReturnType<typeof chromium.launch>>) {
  const projectId = `rounded-seam-${Math.random().toString(36).slice(2)}`;
  const manager = managerFor(clientPath);
  const server = startServer(manager, projectId);
  const browser = sharedBrowser ?? await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.port}/api/projects/${projectId}/preview`);
    const preview = page.frames().find((frame) => frame.url().includes(`/api/projects/${projectId}/preview`));
    assert.ok(preview, "real preview page did not load");
    await preview!.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()));
    const readFrame = () => preview!.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame());
    let current = await readFrame() as PreviewFrame;
    const open = current.ops.find((op) => op.type === "text" && op.text === "Open profile app");
    assert.ok(open, "native Showcase frame did not expose Open profile app");
    const canvas = preview!.locator("canvas");
    await canvas.click({ position: { x: Number(open!.x) + Number(open!.w) / 2, y: Number(open!.y) + Number(open!.h) / 2 } });
    const deadline = Date.now() + 10_000;
    do {
      current = await readFrame() as PreviewFrame;
      if (current.ops.some((op) => op.type === "text" && op.text === "Pocket Profile")) break;
      await Bun.sleep(16);
    } while (Date.now() < deadline);
    assert.ok(current.ops.some((op) => op.type === "text" && op.text === "Pocket Profile"), "native Profile child did not open");
    let rendered: any;
    let previousGeometry = "";
    let stableSamples = 0;
    const captureDeadline = Date.now() + 10_000;
    while (Date.now() < captureDeadline) {
      const candidate = await preview!.evaluate(() => {
        const frame = (window as any).PocketEditorPreviewInstance.getFrame();
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        const targetText = frame.ops.find((op: any) => op.type === "text" && op.text === "Save identity & open Lobby");
        if (!targetText) return null;
        const targetY = Number(targetText.y);
        const nearLabel = (op: any) => Math.abs(Number(op.y) - targetY) < 32;
        const roundeds = frame.ops.filter((op: any) => op.type === "rounded" && Number(op.w ?? op.width) >= 300 && nearLabel(op));
        if (roundeds.length === 1) {
          const shape = roundeds[0];
          const left = Number(shape.x);
          const top = Number(shape.y);
          const width = Number(shape.w ?? shape.width);
          const height = Number(shape.h ?? shape.height);
          const right = left + width;
          const bottom = top + height;
          const radius = Number(shape.radius);
          if (![left, top, right, bottom, radius].every(Number.isFinite) || left < 0 || top < 0 || bottom > canvas.height || right > canvas.width || width <= 0 || height <= 0) return null;
          const x = Math.max(0, Math.min(canvas.width - 1, Math.round(left + 20)));
          const pixel = (atY: number, atX = x) => Array.from(context.getImageData(atX, atY, 1, 1).data);
          const color = Number(shape.color) >>> 0;
          const core = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, (color >>> 24) & 255];
          const rows = [];
          for (let y = Math.floor(top) + 2; y < Math.ceil(bottom) - 2; y += 1) rows.push({ y, rgba: pixel(y) });
          const edgeY = Math.max(0, Math.min(canvas.height - 1, Math.floor(bottom) - 1));
          const edgePixels = [{ y: edgeY, rgba: pixel(edgeY) }];
          const cornerPixels: number[][] = [];
          const cornerSize = Math.max(1, Math.ceil(radius) + 1);
          for (let y = Math.max(0, Math.floor(top)); y < Math.min(canvas.height, Math.floor(top) + cornerSize); y += 1) {
            for (let x = Math.max(0, Math.floor(left)); x < Math.min(canvas.width, Math.floor(left) + cornerSize); x += 1) cornerPixels.push(pixel(y, x));
          }
          const cornerBackground = pixel(Math.max(0, Math.floor(top) - 1), Math.max(0, Math.floor(left) - 1));
          const clip = shape.clip;
          const outsideClip = clip ? pixel(Math.max(0, Math.floor(Number(clip.y) - 1)), Math.round(canvas.width / 2)) : [];
          return { variant: "native-rounded", roundeds, left, top, bottom, radius, core, rows, edgePixels, cornerPixels, cornerBackground, clip, outsideClip, canvas: { width: canvas.width, height: canvas.height } };
        }

        // Retain coverage for the legacy fallback: three same-color strips and
        // four corner-mask images from older native renderers.
        const masks = frame.ops.filter((op: any) => op.type === "image" && String(op.asset).includes("pocket.demo.profile") && nearLabel(op));
        const fallbackColor = Number(masks[0]?.color ?? 0xff315deb) >>> 0;
        const core = [(fallbackColor >>> 16) & 255, (fallbackColor >>> 8) & 255, fallbackColor & 255, (fallbackColor >>> 24) & 255];
        const rects = frame.ops.filter((op: any) => op.type === "rect" && (Number(op.color) >>> 0) === fallbackColor && Number(op.w) >= 300 && nearLabel(op));
        const left = rects.length > 0 ? Math.min(...rects.map((op: any) => Number(op.x))) : Number.NaN;
        const top = rects.length > 0 ? Math.min(...rects.map((op: any) => Number(op.y))) : Number.NaN;
        const right = rects.length > 0 ? Math.max(...rects.map((op: any) => Number(op.x) + Number(op.w))) : Number.NaN;
        const bottom = rects.length > 0 ? Math.max(...rects.map((op: any) => Number(op.y) + Number(op.h))) : Number.NaN;
        const atEdge = (a: number, b: number) => Math.abs(a - b) <= 0.01;
        // The current rounded-lg profile button has 8px native corner masks.
        // Find masks by their app/color and the four outer corners implied by
        // the three fill rects, rather than assuming a historical 10px radius.
        const images = frame.ops.filter((op: any) => {
          if (op.type !== "image" || !String(op.asset).includes("pocket.demo.profile") || (Number(op.color) >>> 0) !== fallbackColor || !nearLabel(op)) return false;
          const x = Number(op.x);
          const y = Number(op.y);
          const width = Number(op.w);
          const height = Number(op.h);
          return width > 0 && height > 0 &&
            (atEdge(x, left) || atEdge(x + width, right)) &&
            (atEdge(y, top) || atEdge(y + height, bottom));
        });
        if (images.length !== 4 || rects.length !== 3) return null;
        if (![left, top, bottom].every(Number.isFinite) || left < 0 || top < 0 || bottom > canvas.height || bottom <= top) return null;
        const geometry = { variant: "legacy-fallback", left, top, bottom, rects, images, clip: rects[0]?.clip, text: frame.ops.find((op: any) => op.type === "text" && op.text === "Save identity & open Lobby") };
        const x = Math.max(0, Math.min(canvas.width - 1, Math.round(left + 20)));
        const pixel = (atY: number, atX = x) => Array.from(context.getImageData(atX, atY, 1, 1).data);
        const rows = [];
        for (let y = Math.floor(top) + 2; y < Math.ceil(bottom) - 2; y += 1) rows.push({ y, rgba: pixel(y) });
        // Chromium's fractional fill edge lands in the last pixel before the
        // mathematical boundary; sample floor(bottom), not the following row.
        const internalEdges = rects.slice(0, -1).map((op: any) => Math.floor(Number(op.y) + Number(op.h)));
        const edgePixels = internalEdges.map((y: number) => ({ y, rgba: pixel(y) }));
        const cornerPixels: number[][] = [];
        const image = images[0];
        for (let y = Math.max(0, Math.floor(Number(image.y))); y < Math.min(canvas.height, Math.ceil(Number(image.y) + Number(image.h))); y += 1) {
          for (let x = Math.max(0, Math.floor(Number(image.x))); x < Math.min(canvas.width, Math.ceil(Number(image.x) + Number(image.w))); x += 1) cornerPixels.push(pixel(y, x));
        }
        const clip = rects[0]?.clip;
        const outsideClip = clip ? pixel(Math.max(0, Math.floor(Number(clip.y) - 1)), Math.round(canvas.width / 2)) : [];
        return { ...geometry, core, rows, internalEdges, edgePixels, cornerPixels, outsideClip, canvas: { width: canvas.width, height: canvas.height } };
      });
      if (candidate) {
        const key = candidate.variant === "native-rounded"
          ? JSON.stringify(candidate.roundeds.map((op: any) => [op.x, op.y, op.w, op.h, op.radius]))
          : JSON.stringify(candidate.rects.map((op: any) => [op.x, op.y, op.w, op.h]));
        stableSamples = key === previousGeometry ? stableSamples + 1 : 0;
        previousGeometry = key;
        rendered = candidate;
        if (stableSamples >= 2) break;
      } else {
        previousGeometry = "";
        stableSamples = 0;
      }
      await Bun.sleep(16);
    }
    const failureDiagnostics = rendered ? undefined : await preview!.evaluate(() => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      const targetText = frame.ops.find((op: any) => op.type === "text" && op.text === "Save identity & open Lobby");
      if (!targetText) return { frame: { width: frame.width, height: frame.height }, ops: frame.ops.filter((op: any) => op.type === "text").map((op: any) => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h })) };
      const targetY = Number(targetText.y);
      const nearLabel = (op: any) => Math.abs(Number(op.y) - targetY) < 32;
      const roundeds = frame.ops.filter((op: any) => op.type === "rounded" && Number(op.w ?? op.width) >= 300 && nearLabel(op));
      const masks = frame.ops.filter((op: any) => op.type === "image" && String(op.asset).includes("pocket.demo.profile") && nearLabel(op));
      const fallbackColor = Number(masks[0]?.color ?? 0xff315deb) >>> 0;
      const rects = frame.ops.filter((op: any) => op.type === "rect" && (Number(op.color) >>> 0) === fallbackColor && Number(op.w) >= 300 && nearLabel(op));
      const left = rects.length ? Math.min(...rects.map((op: any) => Number(op.x))) : Number(targetText.x);
      const top = rects.length ? Math.min(...rects.map((op: any) => Number(op.y))) : targetY;
      const right = rects.length ? Math.max(...rects.map((op: any) => Number(op.x) + Number(op.w))) : left;
      const bottom = rects.length ? Math.max(...rects.map((op: any) => Number(op.y) + Number(op.h))) : targetY + Number(targetText.h);
      const atEdge = (a: number, b: number) => Math.abs(a - b) <= 0.01;
      const images = frame.ops.filter((op: any) => {
        if (op.type !== "image" || !String(op.asset).includes("pocket.demo.profile") || (Number(op.color) >>> 0) !== fallbackColor || !nearLabel(op)) return false;
        const x = Number(op.x);
        const y = Number(op.y);
        return (atEdge(x, left) || atEdge(x + Number(op.w), right)) &&
          (atEdge(y, top) || atEdge(y + Number(op.h), bottom));
      });
      const px = Math.max(0, Math.min((canvas?.width ?? 1) - 1, Math.round(left + 20)));
      const pixelRows: Array<{ y: number; rgba: number[] }> = [];
      const context = canvas?.getContext("2d");
      if (context) {
        for (let y = Math.max(0, Math.floor(top) + 2); y < Math.min(canvas!.height, Math.ceil(bottom) - 2); y += 1) {
          pixelRows.push({ y, rgba: Array.from(context.getImageData(px, y, 1, 1).data) });
        }
      }
      const clip = rects[0]?.clip;
      const outsideClip = context && clip
        ? Array.from(context.getImageData(Math.round(frame.width / 2), Math.max(0, Math.floor(Number(clip.y) - 1)), 1, 1).data)
        : [];
      return { frame: { width: frame.width, height: frame.height }, canvas: canvas && { width: canvas.width, height: canvas.height }, targetText, roundeds, rects, images, clip, pixelColumnX: px, pixelRows, outsideClip };
    });
    assert.ok(rendered, `native Profile rounded button did not settle inside the preview canvas: ${JSON.stringify(failureDiagnostics)}`);
    if (rendered.variant === "native-rounded") {
      assert.equal(rendered.roundeds.length, 1, `Profile button should use one native rounded DrawOp: ${JSON.stringify(rendered.roundeds)}`);
      assert.equal(rendered.radius, 8, "Profile button keeps its 8px native corner radius");
      assert.ok(rendered.rows.every((row: any) => row.rgba.every((value: number, index: number) => value === rendered.core[index])), `native rounded fill has an interior seam: ${JSON.stringify({ rows: rendered.rows, roundeds: rendered.roundeds })}`);
      assert.ok(rendered.edgePixels.every((row: any) => row.rgba.join(",") === rendered.core.join(",")), `native rounded-fill bottom edge is not opaque: ${JSON.stringify(rendered.edgePixels)}`);
      assert.ok(rendered.cornerPixels.some((rgba: number[]) => rgba.some((value, index) => value !== rendered.core[index] && value !== rendered.cornerBackground[index])), `native rounded corner antialiasing was lost: ${JSON.stringify({ cornerPixels: rendered.cornerPixels, cornerBackground: rendered.cornerBackground })}`);
    } else {
      assert.equal(rendered.rects.length, 3, `Profile button should have 3 rounded fill rects: ${JSON.stringify(rendered.rects)}`);
      assert.equal(rendered.images.length, 4, `Profile button should have 4 corner masks: ${JSON.stringify(rendered.images)}`);
      assert.ok(rendered.rows.every((row: any) => row.rgba.every((value: number, index: number) => value === rendered.core[index])), `legacy rounded fallback has an interior seam: ${JSON.stringify({ edgePixels: rendered.edgePixels, rows: rendered.rows, rects: rendered.rects, images: rendered.images, canvas: rendered.canvas })}`);
      assert.ok(rendered.edgePixels.every((row: any) => row.rgba.join(",") === rendered.core.join(",")), `legacy rounded-fill edge is not opaque: ${JSON.stringify(rendered.edgePixels)}`);
      assert.ok(rendered.cornerPixels.some((rgba: number[]) => rgba.some((value, index) => value !== rendered.core[index] && value !== 255)), `legacy corner-mask antialiasing was lost: ${JSON.stringify(rendered.cornerPixels)}`);
    }
    assert.ok(rendered.outsideClip.length === 0 || rendered.outsideClip.slice(0, 3).join(",") !== rendered.core.slice(0, 3).join(","), `clip leaked the rounded fill outside its child clip: ${JSON.stringify(rendered.outsideClip)}`);
    return rendered;
  } finally {
    if (!sharedBrowser) await browser.close();
    server.stop(true);
    await manager.dispose();
  }
}

test("native rounded DrawOp keeps the Profile button fill and corners seamless", { timeout: 180_000 }, async () => {
  assert.ok(probe, `pocket_probe is required for rounded seam acceptance: ${probeCandidates.join(", ")}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await renderProfileButton(join(sdkRoot, "editor/client/preview.js"), browser);
    assert.equal(result.variant, "native-rounded", `current native output should use the rounded DrawOp: ${JSON.stringify({ roundeds: result.roundeds, rects: result.rects, images: result.images })}`);
  } finally {
    await browser.close();
  }
});
