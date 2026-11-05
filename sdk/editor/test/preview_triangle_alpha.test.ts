import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";

test("cold transformed texture fades reuse one RGB upload and preserve alpha pixels", { timeout: 30_000 }, async () => {
  const source = readFileSync(process.env.POCKET_PREVIEW_CLIENT ?? new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(`<div data-pocket-preview data-project-id=triangle></div><script>${source.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 64, height: 96 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      class Source { onmessage?: (event: {data: string}) => void; constructor() { (window as any).__source = this; } close() {} }
      Object.defineProperty(window, "EventSource", { value: Source });
      (window as any).__uploads = 0;
      (window as any).__blurPasses = 0;
      (window as any).__canvases = 0;
      const create = document.createElement.bind(document);
      document.createElement = ((...args: any[]) => {
        if (args[0] === "canvas") (window as any).__canvases += 1;
        return (create as any)(...args);
      }) as typeof document.createElement;
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
        if (this.filter.startsWith("blur(")) (window as any).__blurPasses += 1;
        return draw.apply(this, args as any);
      };
      const put = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function (...args: any[]) {
        (window as any).__uploads += 1;
        return put.apply(this, args as any);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    const result = await page.evaluate(async () => {
      const pixels = Array(128 * 128).fill(7);
      const palette = Array(1027).fill(0);
      palette.splice(7 * 4, 4, 180, 120, 60, 128);
      async function frame(index: number, alpha: number) {
        const color = ((alpha << 24) | 0x8040ff) >>> 0;
        const ops = [
          { type: "textureTriangle", asset: "atlas", color, points: [{x:0,y:0},{x:32,y:0},{x:32,y:32}], uvs: [0,0,1,0,1,1] },
          { type: "textureTriangle", asset: "atlas", color, points: [{x:0,y:0},{x:32,y:32},{x:0,y:32}], uvs: [0,0,1,1,0,1] },
        ];
        const frame = { frame: index, width: 32, height: 32, ops, events: [], resources: index === 1 ? [{asset: "atlas", width:128, height:128, psm:5, pixels, palette}] : [] };
        (window as any).__source.onmessage({ data: JSON.stringify({type:"frame", frame}) });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      await frame(1, 128);
      const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
      const pixel = Array.from(canvas.getContext("2d")!.getImageData(8, 20, 1, 1).data);
      const firstUploads = (window as any).__uploads;
      for (let alpha = 8, index = 2; alpha <= 248; alpha += 8, index++) await frame(index, alpha);
      const fadeUploads = (window as any).__uploads;
      await frame(34, 0);
      const transparent = Array.from(canvas.getContext("2d")!.getImageData(8, 20, 1, 1).data);
      const beforeGlass = (window as any).__canvases;
      async function glass(index: number, opacity: number) {
        const frame = { frame: index, width: 32, height: 32, resources: [], events: [], ops: [
          {type:"rect",x:0,y:0,w:32,h:32,color:0xffff0000},
          {type:"hostSurface",x:0,y:0,w:32,h:32,asset:JSON.stringify({kind:"glass",parameters:{effect:"blur",blur:8,opacity}})},
        ] };
        (window as any).__source.onmessage({data:JSON.stringify({type:"frame",frame})});
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        return { canvases: (window as any).__canvases - beforeGlass, passes: (window as any).__blurPasses };
      }
      const zero = await glass(35, 0);
      const visible = await glass(36, .5);
      const zeroAgain = await glass(37, 0);
      return { pixel, firstUploads, fadeUploads, transparent, zero, visible, zeroAgain };
    });
    // Texture alpha and DrawOp alpha both participate, over an opaque white scene.
    [214, 198, 206, 255].forEach((value, index) => assert.ok(Math.abs(result.pixel[index]! - value) <= 2, JSON.stringify(result)));
    assert.equal(result.firstUploads, 2, "one source upload and one RGB tint upload on the cold path");
    assert.equal(result.fadeUploads, result.firstUploads, "alpha-only frames must not allocate/upload another font texture");
    assert.deepEqual(result.transparent, [255, 255, 255, 255]);
    assert.deepEqual(result.zero, { canvases: 0, passes: 0 }, "a transparent cold frame must allocate no blur target and run no filter");
    assert.deepEqual(result.visible, { canvases: 1, passes: 1 });
    assert.deepEqual(result.zeroAgain, result.visible, "returning to zero opacity must skip the blur again");
  } finally {
    await browser.close();
    await server.stop(true);
  }
});
