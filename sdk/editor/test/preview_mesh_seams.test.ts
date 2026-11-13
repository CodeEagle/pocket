import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";

for (const forceCanvas of [false, true]) test(`small dense meshes and bounded fallback batching (${forceCanvas ? "Canvas" : "GPU"})`, { timeout: 30_000 }, async () => {
  const source = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch: () => new Response("<!doctype html><body></body>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript((forceCanvas: boolean) => {
      if (forceCanvas) {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(kind: any, ...args: any[]) {
          return kind === "webgl2" ? null : original.call(this, kind, ...args);
        } as any;
      }
      (window as any).EventSource = class {
        constructor() { (window as any).fixtureSource = this; }
        close() {}
      };
    }, forceCanvas);
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(async (forceCanvas: boolean) => {
      const probe = document.createElement("canvas");
      if (!forceCanvas && !probe.getContext("webgl2")) throw new Error("WebGL2 is required for this renderer acceptance test");
      const texture = document.createElement("canvas"); texture.width = texture.height = 8;
      const tc = texture.getContext("2d")!; tc.fillStyle = "white"; tc.fillRect(0, 0, 8, 8);
      const image = { canvas: texture, width: 8, height: 8, rgba: tc.getImageData(0, 0, 8, 8).data };
      const vertices: number[] = [], indices: number[] = [], cells = 20;
      for (let y = 0; y <= cells; y++) for (let x = 0; x <= cells; x++) {
        vertices.push(3.17 + x * 2.31, 3.29 + y * 2.19, x / cells, y / cells);
      }
      for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
        const a = y * (cells + 1) + x, b = a + 1, c = a + cells + 2, d = c - 1;
        indices.push(a, b, c, a, c, d);
      }
      const mesh = new Uint8Array(16 + vertices.length * 4 + indices.length * 4), data = new DataView(mesh.buffer);
      [0x31534d50, vertices.length / 4, indices.length, 0xffffffff].forEach((v, i) => data.setUint32(i * 4, v, true));
      vertices.forEach((v, i) => data.setFloat32(16 + i * 4, v, true));
      indices.forEach((v, i) => data.setUint32(16 + vertices.length * 4 + i * 4, v, true));
      const target = document.createElement("canvas"); target.width = target.height = 64;
      const context = target.getContext("2d")!;
      let clips = 0;
      const original = CanvasRenderingContext2D.prototype.clip;
      CanvasRenderingContext2D.prototype.clip = function(...args: any[]) { clips++; return original.apply(this, args as any); };
      try {
        (window as any).PocketEditorPreview.projectModelMeshes(context, [{ id: "dense", texture: "white", geometry: mesh,
          effect: { blend: "normal", repeatTexture: true } }], { white: image });
      } finally { CanvasRenderingContext2D.prototype.clip = original; }
      const pixels = context.getImageData(6, 6, 40, 36).data;
      let minimumAlpha = 255;
      for (let i = 3; i < pixels.length; i += 4) minimumAlpha = Math.min(minimumAlpha, pixels[i]!);
      // The native preview emits ordinary triangle DrawOps for plain meshes,
      // outside meshLayerBegin. Exercise that path as well as the stage API.
      const root = document.createElement("div"); document.body.append(root);
      const instance = (window as any).PocketEditorPreview.mount(root, { projectId: "dense", width: 64, height: 64 });
      for (let i = 0; i < 100 && !(window as any).fixtureSource; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const ops: any[] = [{ type: "rect", x: 0, y: 0, w: 64, h: 64, color: 0xff000000 }];
      for (let i = 0; i < indices.length; i += 3) {
        const tri = indices.slice(i, i + 3);
        ops.push({ type: "textureTriangle", asset: "white", repeatTexture: true, color: 0xffffffff,
          points: tri.map(v => ({ x: vertices[v * 4], y: vertices[v * 4 + 1] })),
          uvs: tri.flatMap(v => vertices.slice(v * 4 + 2, v * 4 + 4)) });
      }
      let batchSlices = 0;
      const originalSlice = Array.prototype.slice;
      Array.prototype.slice = function(...args: any[]) {
        if (this.length === 801 && this[0]?.type === "rect") batchSlices++;
        return originalSlice.apply(this, args as any);
      };
      try { (window as any).fixtureSource.onmessage({ data: JSON.stringify({ type: "frame", frame: {
        frame: 1, width: 64, height: 64, ops, events: [],
        resources: [{ asset: "white", width: 8, height: 8, psm: 3, pixels: Array(8 * 8 * 4).fill(255) }],
      } }) }); } finally { Array.prototype.slice = originalSlice; }
      const nativePixels = instance.canvas.getContext("2d").getImageData(6, 6, 40, 36).data;
      let minimumWhite = 255;
      for (let i = 0; i < nativePixels.length; i += 4) minimumWhite = Math.min(minimumWhite, nativePixels[i]);
      await instance.close();
      return { minimumAlpha, clips, minimumWhite, batchSlices };
    }, forceCanvas);
    assert.equal(result.batchSlices, 1, "an unsupported run must not rescan/slice every remaining triangle");
    if (!forceCanvas) {
    assert.equal(result.minimumAlpha, 255, "internal mesh edges must never reveal the backdrop");
    assert.ok(result.clips < 10, `800 triangles should be submitted as a mesh, got ${result.clips} Canvas clips`);
    assert.equal(result.minimumWhite, 255, "native plain mesh batches must not expose their black backdrop either");
    } else assert.ok(result.minimumWhite > 0, "Canvas compatibility path still draws the native mesh");
  } finally { await browser.close(); await server.stop(true); }
});
