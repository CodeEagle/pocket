import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";

for (const fallback of [false, true]) test(`mesh projection handles masks, repeat UV, tint, blend and updates (${fallback ? "Canvas fallback" : "GPU"})`, { timeout: 30_000 }, async () => {
  const source = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch: () => new Response(`<script>${source.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    if (fallback) await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind: string, ...args: any[]) {
        return kind === "webgl2" ? null : (original as any).call(this, kind, ...args);
      } as typeof original;
    });
    await page.goto(`http://127.0.0.1:${server.port}`);
    const results = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 340;
      const ctx = canvas.getContext("2d")!;
      const image = (rgba: number[]) => {
        const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 1;
        const pixels = new Uint8ClampedArray(rgba); canvas.getContext("2d")!.putImageData(new ImageData(pixels, 2, 1), 0, 0);
        return { canvas, width: 2, height: 1, rgba: pixels };
      };
      const images = { white: image([255, 255, 255, 255, 255, 255, 255, 255]), red: image([255, 0, 0, 255, 255, 0, 0, 255]), mask: image([255, 255, 255, 255, 255, 255, 255, 0]), pattern: image([255, 0, 0, 255, 0, 255, 0, 255]) };
      const geometry = (repeat = 1, color = 0xffffffff) => {
        const data = new Uint8Array(16 + 4 * 16 + 6 * 4), view = new DataView(data.buffer);
        [0x31534d50, 4, 6, color].forEach((n, i) => view.setUint32(i * 4, n, true));
        [0, 0, 0, 0, 80, 0, repeat, 0, 80, 80, repeat, 1, 0, 80, 0, 1].forEach((n, i) => view.setFloat32(16 + i * 4, n, true));
        [0, 1, 2, 0, 2, 3].forEach((n, i) => view.setUint32(80 + i * 4, n, true));
        return data;
      };
      const paint = (meshes: unknown[]) => { ctx.clearRect(0, 0, 240, 340); (window as any).PocketEditorPreview.projectModelMeshes(ctx, meshes, images); };
      const pixel = (x: number) => [...ctx.getImageData(x, 30, 1, 1).data];
      const mask = { id: "mask", texture: "mask", geometry: geometry(), visible: false };
      const target = { id: "target", texture: "red", geometry: geometry(), visible: true, effect: { blend: "normal", repeatTexture: true, masks: ["mask"], multiplyRgb: [1, 1, 1], screenRgb: [0, 0, 0] } };
      paint([target, mask]); const normal = [pixel(10), pixel(70)];
      paint([{ ...target, effect: { ...target.effect, inverted: true } }, mask]); const inverted = [pixel(10), pixel(70)];
      paint([{ ...target, texture: "pattern", geometry: geometry(2), effect: { ...target.effect, masks: [] } }]); const repeat = [pixel(10), pixel(30), pixel(50), pixel(70)];
      paint([{ ...target, effect: { ...target.effect, masks: [], multiplyRgb: [0.5, 1, 1], screenRgb: [0, 1, 0] } }]); const tint = pixel(10);
      ctx.clearRect(0, 0, 240, 340); ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 80, 80);
      (window as any).PocketEditorPreview.projectModelMeshes(ctx, [{ ...target, effect: { ...target.effect, masks: [], blend: "multiply" } }], images);
      const blend = pixel(10);
      let patterns = 0, clears = 0;
      const proto = CanvasRenderingContext2D.prototype;
      const originalPattern = proto.createPattern, originalClear = proto.clearRect;
      proto.createPattern = function(...args: Parameters<typeof originalPattern>) { patterns++; return originalPattern.apply(this, args); };
      proto.clearRect = function(...args: Parameters<typeof originalClear>) { clears++; return originalClear.apply(this, args); };
      paint([target, { ...target, id: "second", effect: { ...target.effect, inverted: true } }, mask]);
      const combined = [pixel(10), pixel(70)];
      patterns = clears = 0;
      paint([target, { ...target, id: "second", effect: { ...target.effect, inverted: true } }, mask]);
      const warmPatterns = patterns, warmClears = clears;
      // A new frame must rerasterize a mask changed in place.
      const maskView = new DataView(mask.geometry.buffer);
      for (let vertex = 0; vertex < 4; vertex++) maskView.setFloat32(16 + vertex * 16, maskView.getFloat32(16 + vertex * 16, true) + 100, true);
      paint([target, mask]);
      const movedMask = pixel(10);
      // Canvas-only sources are mutable (video/authoring); never retain their pattern.
      const dynamic = images.red as { canvas: HTMLCanvasElement; width: number; height: number; rgba?: Uint8ClampedArray };
      delete dynamic.rgba;
      dynamic.canvas.getContext("2d")!.fillStyle = "blue";
      dynamic.canvas.getContext("2d")!.fillRect(0, 0, 2, 1);
      patterns = 0;
      paint([{ ...target, effect: { ...target.effect, masks: [] } }]);
      const dynamicPixel = pixel(10), dynamicPatterns = patterns;
      proto.createPattern = originalPattern; proto.clearRect = originalClear;
      paint([{ id: "colored-spine", texture: "white", geometry: geometry(1, 0xff0000ff) }]);
      return { normal, inverted, repeat, tint, blend, combined, warmPatterns, warmClears, movedMask, dynamicPixel, dynamicPatterns, packedRed: pixel(10) };
    });
    assert.deepEqual(results.normal, [[255, 0, 0, 255], [0, 0, 0, 0]]);
    assert.deepEqual(results.inverted, [[0, 0, 0, 0], [255, 0, 0, 255]]);
    assert.ok(results.repeat[0][0] > 200 && results.repeat[1][1] > 200 && results.repeat[2][0] > 200 && results.repeat[3][1] > 200, JSON.stringify(results.repeat));
    assert.deepEqual(results.tint, [128, 255, 0, 255]);
    assert.deepEqual(results.blend, [0, 0, 0, 255]);
    assert.deepEqual(results.packedRed, [255, 0, 0, 255]);
    assert.deepEqual(results.combined, [[255, 0, 0, 255], [255, 0, 0, 255]]);
    assert.equal(results.warmPatterns, 0);
    assert.equal(results.warmClears, 4, "two contents share one rasterized mask despite different inversion");
    assert.deepEqual(results.movedMask, [0, 0, 0, 0]);
    assert.deepEqual(results.dynamicPixel, [0, 0, 255, 255]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.stop(true); }
});
