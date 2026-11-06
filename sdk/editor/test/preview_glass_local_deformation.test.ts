import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { test } from "bun:test";

const client = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
const optics = readFileSync(new URL("../client/liquid-glass.js", import.meta.url), "utf8");
const shader = readFileSync(new URL("../../packages/pocket_flutter/shaders/liquid_glass.frag", import.meta.url), "utf8");

/**
 * Verifies the draw-layer contract independently of the JS gesture producer:
 * a local pull paints a shoulder into the visual halo, distant pixels stay
 * untouched, and zeroing the field reproduces the original frame.
 */
test("Web Liquid Glass local deformation paints a padded shoulder", { timeout: 30_000 }, async () => {
  const server = Bun.serve({ port: 0, fetch() {
    const source = optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
    return new Response(`<div data-pocket-preview data-project-id=local-deformation></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, {
      headers: { "content-type": "text/html" },
    });
  } });
  const browser = await chromium.launch({ headless: true, args: process.platform === "darwin" ? ["--use-angle=metal"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 160, height: 180 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => {
      class Source { onmessage?: (event: { data: string }) => void; constructor() { (window as any).__source = this; } close() {} }
      Object.defineProperty(window, "EventSource", { value: Source });
      const read = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        if (!(window as any).__sampling) throw new Error("production canvas readback");
        return read.apply(this, args);
      };
      WebGLRenderingContext.prototype.readPixels = function () { throw new Error("production GPU readback"); };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    let nextFrame = 0;
    const frame = (deformation: Record<string, number>, geometry = {
      x: -16, y: 24, w: 172, h: 132, opticalInset: 36,
    }) => ({
      type: "frame",
      frame: {
        frame: ++nextFrame, width: 160, height: 180, events: [], resources: [],
        ops: [
          ...Array.from({ length: 40 }, (_, index) => ({
            type: "rect", x: index * 4, y: 0, w: 4, h: 180,
            color: (index % 2 ? 0xff256796 : 0xffd15343) >>> 0,
          })),
          {
            // The compositor quad already includes the optical halo;
            // opticalInset keeps the original 100x60 SDF inside it.
            type: "hostSurface", x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h,
            clip: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
            asset: JSON.stringify({ kind: "glass", parameters: {
              effect: "glass", material: "clear", blur: 1.5, materialStrength: .02,
              materialTint: 0xfff2f2f7, edgeIntensity: .015, rimIntensity: .05,
              baseIntensity: .01, tintOpacity: .04, cornerBoost: .02,
              rippleEffect: 0, warp: false, shape: "pill", radius: 999,
              opticalInset: geometry.opticalInset, deformation,
            } }),
          },
        ],
      },
    });
    const capture = async (deformation: Record<string, number>, geometry?: {
      x: number, y: number, w: number, h: number, opticalInset: number,
    }) => {
      const message = frame(deformation, geometry);
      const expectedFrame = message.frame.frame;
      await page.evaluate((next) => (window as any).__source.onmessage({ data: JSON.stringify(next) }), message);
      await page.waitForFunction((expected) => (window as any).PocketEditorPreviewInstance.getFrame()?.frame === expected, expectedFrame);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.waitForFunction(() => document.querySelector("canvas")?.dataset.glassRenderer === "webgl-refractive");
      return page.evaluate(() => {
        const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
        (window as any).__sampling = true;
        const data = Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data);
        (window as any).__sampling = false;
        return { width: canvas.width, height: canvas.height, data };
      });
    };
    const base = await capture({ anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0, radius: 0 });
    // The expanded compositor quad and a conventional unpadded quad must
    // produce identical pixels over the original shape. This guards the ROI
    // crop/texture-coordinate optimization against changing the material.
    const fullSource = await capture(
      { anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0, radius: 0 },
      { x: 20, y: 60, w: 100, h: 60, opticalInset: 0 },
    );
    const croppedSource = await capture(
      { anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0, radius: 0 },
      { x: -16, y: 24, w: 172, h: 132, opticalInset: 36 },
    );
    const pulled = await capture({ anchorX: 38, anchorY: 0, offsetX: 12, offsetY: 0, radius: 52 });
    const reset = await capture({ anchorX: 38, anchorY: 0, offsetX: 0, offsetY: 0, radius: 52 });
    assert.equal(base.width, 320);
    assert.equal(base.height, 360);
    const rgbDifference = (a: typeof base, b: typeof base, x: number, y: number): number => {
      const index = (y * a.width + x) * 4;
      return Math.abs(a.data[index]! - b.data[index]!) + Math.abs(a.data[index + 1]! - b.data[index + 1]!) + Math.abs(a.data[index + 2]! - b.data[index + 2]!);
    };
    let shoulder = 0, local = 0, untouched = 0, distant = 0, outside = 0, resetError = 0;
    let cropParityError = 0;
    for (let y = 0; y < base.height; y += 2) {
      for (let x = 0; x < base.width; x += 2) {
        const diff = rgbDifference(base, pulled, x, y);
        const logicalX = x / 2, logicalY = y / 2;
        const inOriginal = logicalX >= 20 && logicalX < 120 && logicalY >= 60 && logicalY < 120;
        const inHalo = logicalX >= 2 && logicalX < 138 && logicalY >= 42 && logicalY < 138;
        if (logicalX >= 120 && logicalX < 156 && logicalY >= 60 && logicalY < 120 && diff > 12) shoulder++;
        if (inOriginal && diff > 12) local++;
        if (logicalX >= 20 && logicalX < 45 && logicalY >= 70 && logicalY < 110 && diff > 2) untouched++;
        if (!inHalo && diff > 2) outside++;
        if ((logicalX >= 0 && logicalX < 10 && logicalY >= 60 && logicalY < 120) && diff > 2) distant++;
        resetError = Math.max(resetError, rgbDifference(base, reset, x, y));
        if (logicalX >= 30 && logicalX < 110 && logicalY >= 70 && logicalY < 110) {
          const parity = rgbDifference(fullSource, croppedSource, x, y);
          cropParityError = Math.max(cropParityError, parity);
        }
      }
    }
    assert.ok(shoulder > 20, `local pull must paint beyond the original right edge: ${shoulder}`);
    assert.ok(local > 20, `local pull must alter pixels near the contact: ${local}`);
    assert.equal(untouched, 0, `remote part of the same control must remain unchanged: ${untouched}`);
    assert.equal(outside, 0, `visual halo must stay bounded: ${outside}`);
    assert.equal(distant, 0, `distant backdrop must remain unchanged: ${distant}`);
    assert.ok(resetError <= 1, `zero deformation must restore the source frame: ${resetError}`);
    assert.ok(cropParityError <= 8, `cropped capture must match the full source over the original shape: ${cropParityError}`);
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
    await page.close();
  } finally {
    await browser.close();
    server.stop(true);
  }
});
