import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

test("preview bounds animated image tint memory and releases replaced resources without GPU readback", { timeout: 30_000 }, async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const script = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/stream")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/input")) return Response.json({ ok: true });
    if (path === "/preview.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    return new Response('<body><div data-pocket-preview data-project-id="tint"></div><script src="/preview.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 32, height: 80 } });
    await page.addInitScript(() => {
      const state = (window as any).__raster = { canvases: [] as HTMLCanvasElement[], reads: 0, paints: 0, read: CanvasRenderingContext2D.prototype.getImageData };
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args: any[]) {
        state.paints += 1;
        return clear.apply(this, args as [number, number, number, number]);
      };
      const create = document.createElement.bind(document);
      document.createElement = ((...args: any[]) => {
        const element = (create as any)(...args);
        if (args[0] === "canvas") state.canvases.push(element);
        return element;
      }) as typeof document.createElement;
      CanvasRenderingContext2D.prototype.getImageData = function (...args: any[]) {
        state.reads += 1;
        return state.read.apply(this, args);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => !!(window as any).PocketEditorPreviewInstance);
    while (!stream) await new Promise(resolve => setTimeout(resolve, 10));
    let index = 0;
    async function frame(color: number, resources: unknown[] = [], releasedResources: string[] = []) {
      index += 1;
      stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "frame", frame: {
        frame: index, width: 32, height: 32, ops: [{ type: "image", asset: "icon", x: 0, y: 0, w: 32, h: 32, color }], resources, releasedResources,
      } })}\n\n`));
      await page.waitForFunction(n => (window as any).PocketEditorPreviewInstance.getFrame()?.frame === n, index);
    }
    const resource = { asset: "icon", width: 1, height: 1, psm: 3, pixels: [180, 120, 60, 255] };
    await frame(0xff8040ff, [resource]);
    const sample = () => page.evaluate(() => {
      const state = (window as any).__raster;
      const canvas = (window as any).PocketEditorPreviewInstance.canvas;
      return { pixel: Array.from(state.read.call(canvas.getContext("2d"), 16, 16, 1, 1).data), reads: state.reads, paints: state.paints,
        retainedPixels: state.canvases.filter((item: HTMLCanvasElement) => item !== canvas).reduce((sum: number, item: HTMLCanvasElement) => sum + item.width * item.height, 0) };
    });
    expect((await sample()).pixel).toEqual([90, 30, 60, 255]);
    // Distinct transition colours used to retain a new Canvas forever.
    for (let value = 0; value < 80; value += 1) await frame((0xff000000 | value * 7919) >>> 0);
    expect((await sample()).retainedPixels).toBeLessThanOrEqual(9);
    expect((await sample()).reads).toBe(0);
    async function regions(enabled: boolean, count: number) {
      await page.evaluate(async ({ enabled, count }) => {
        for (let index = 0; index < count; index += 1) window.postMessage({ source: "pocket-editor", type: "preview.regions", enabled }, location.origin);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, { enabled, count });
    }
    await regions(false, 1);
    const paints = (await sample()).paints;
    // Editor re-announces its inspection state on each native frame. Identical
    // settings must not cause an additional full Canvas repaint every time.
    await regions(false, 80);
    expect((await sample()).paints).toBe(paints);
    await regions(true, 80);
    expect((await sample()).paints).toBe(paints + 1);
    await regions(false, 80);
    expect((await sample()).paints).toBe(paints + 2);
    await frame(0xff8040ff, [{ ...resource, pixels: [100, 200, 80, 255] }]);
    expect((await sample()).pixel).toEqual([50, 50, 80, 255]);
    expect((await sample()).retainedPixels).toBeLessThanOrEqual(2);
    await frame(0xffffffff, [], ["icon"]);
    expect((await sample()).retainedPixels).toBe(0);
    await frame(0xff8040ff, [resource]);
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
    expect((await sample()).retainedPixels).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
