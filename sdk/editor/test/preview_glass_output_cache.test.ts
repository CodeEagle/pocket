import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { test } from "bun:test";

const client = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
const optics = readFileSync(new URL("../client/liquid-glass.js", import.meta.url), "utf8");
const shader = readFileSync(new URL("../../packages/pocket_flutter/shaders/liquid_glass.frag", import.meta.url), "utf8");

test("multiple glass surfaces reuse static optical work with bounded output retention", { timeout: 60_000 }, async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const uncached = new URL(request.url).pathname === "/uncached";
    const renderer = uncached ? optics
      .replace(/const repeated = signature !== null && retained\?\.signature === signature;/, "const repeated = false;")
      .replace(/if \(signature !== null && \(resting \|\| repeated\) && ow \* oh <= maxOutputPixels\)/, "if (false)") : optics;
    assert.ok(!uncached || renderer !== optics, "cache ablation must match production source");
    const source = renderer.replace('\"\" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
    return new Response(`<div data-pocket-preview data-project-id=cache></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: process.env.POCKET_PROFILE_HEADED !== "1", args: process.platform === "darwin" ? ["--use-angle=metal"] : [] });
  try {
    const results: Record<string, any> = {};
    for (const variant of ["uncached", "cached"]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await page.addInitScript(() => {
        class Source { onmessage?: (event: { data: string }) => void; constructor() { (window as any).__source = this; } close() {} }
        Object.defineProperty(window, "EventSource", { value: Source });
        (window as any).__counts = { uploads: 0, draws: 0, pixels: 0 };
        (window as any).__costs = [];
        let started = 0;
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
          if (this.canvas.id === "pocket-preview-surface") started = performance.now();
          return clear.apply(this, args);
        };
        const post = window.postMessage;
        window.postMessage = function (message: any, ...args: any[]) {
          if (message?.source === "pocket-editor-preview" && message?.type === "preview.frame") (window as any).__costs.push(performance.now() - started);
          return (post as any).call(this, message, ...args);
        } as any;
        (window as any).__outputs = new Set<HTMLCanvasElement>();
        const contexts = new WeakSet<HTMLCanvasElement>();
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: any[]) {
          if (kind === "webgl") contexts.add(this);
          return (get as any).call(this, kind, ...args);
        } as any;
        const copy = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (source: any, ...args: any[]) {
          if (contexts.has(source) && this.canvas.id !== "pocket-preview-surface") (window as any).__outputs.add(this.canvas);
          return (copy as any).call(this, source, ...args);
        } as any;
        for (const method of ["texImage2D", "texSubImage2D"] as const) {
          const original = WebGLRenderingContext.prototype[method];
          (WebGLRenderingContext.prototype as any)[method] = function (...args: any[]) {
            const source = args.at(-1);
            if (source instanceof HTMLCanvasElement) {
              (window as any).__counts.uploads++;
              (window as any).__counts.pixels += source.width * source.height;
            }
            return (original as any).apply(this, args);
          };
        }
        const draw = WebGLRenderingContext.prototype.drawArrays;
        WebGLRenderingContext.prototype.drawArrays = function (...args) { (window as any).__counts.draws++; return draw.apply(this, args); };
      });
      await page.goto(`http://127.0.0.1:${server.port}/${variant}`);
      await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
      results[variant] = await page.evaluate(async () => {
        const instance = (window as any).PocketEditorPreviewInstance;
        let frame = 0;
        const counts = () => ({ ...(window as any).__counts });
        const background = Array.from({ length: 39 }, (_, x) => ({ type: "rect", x: x * 10, y: 0, w: 10, h: 844, color: x % 2 ? 0xff559AC3 : 0xffC96B51 }));
        const send = (offset: number, changed = false) => {
          const surfaces = Array.from({ length: 5 }, (_, index) => ({ type: "hostSurface", id: index + 1,
            x: -1, y: 4 + index * 158, w: 392, h: 128,
            asset: JSON.stringify({ kind: "glass", parameters: { material: "regular", effect: "glass", shape: "pill", blur: 12,
              opticalInset: 36, rippleEffect: 0, warp: false, materialStrength: .24,
              deformation: { anchorX: 130, anchorY: 0, offsetX: index === 2 ? offset : 0, offsetY: 0, radius: 64 } } }) }));
          (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: { frame: ++frame, width: 390, height: 844, events: [], resources: [],
            ops: [...background, ...(changed ? [{ type: "rect", x: 100, y: 55, w: 30, h: 25, color: 0xff00ff00 }] : []), ...surfaces] } }) });
        };
        const next = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
        send(0);
        for (let attempts = 0; attempts < 180 && instance.canvas.dataset.glassRenderer !== "webgl-refractive"; attempts++) await next();
        await next();
        const initial = counts();
        (window as any).__costs = [];
        const gaps: number[] = [];
        let previous = await next();
        for (let index = 0; index < 60; index++) {
          send(8 * Math.sin((index + 1) * .17));
          const now = await next(); gaps.push(now - previous); previous = now;
        }
        const animated = counts();
        const costs = [...(window as any).__costs].sort((a, b) => a - b);
        send(0); await next(); await next();
        const context = instance.canvas.getContext("2d");
        const pixels = Array.from(context.getImageData(0, 0, instance.canvas.width, instance.canvas.height).data);
        const beforeChange = counts();
        send(0, true); await next(); await next();
        const afterChange = counts();
        const changedPixels = Array.from(context.getImageData(200, 110, 20, 20).data);
        // More surfaces than the retention limit must release evicted bitmap
        // storage. Overlap also exercises transitive optical dependencies.
        (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: {
          frame: ++frame, width: 390, height: 844, events: [], resources: [], ops: [...background,
            ...Array.from({ length: 12 }, (_, index) => ({ type: "hostSurface", id: 100 + index,
              x: 0, y: 0, w: 390, h: 700, asset: JSON.stringify({ kind: "glass", parameters: {
                material: "clear", shape: "pill", blur: 0, opticalInset: 36, warp: false, rippleEffect: 0,
              } }) }))],
        } }) });
        await next(); await next();
        const retained = [...(window as any).__outputs] as HTMLCanvasElement[];
        const live = retained.filter(canvas => canvas.width > 0 && canvas.height > 0);
        const livePixels = live.reduce((total, canvas) => total + canvas.width * canvas.height, 0);
        gaps.sort((a, b) => a - b);
        await instance.close();
        return { initial, animated, beforeChange, afterChange, pixels, changedPixels,
          liveOutputs: live.length, livePixels, released: retained.every(canvas => canvas.width === 0 && canvas.height === 0),
          canvasP50Ms: costs[Math.floor(costs.length * .5)], canvasP95Ms: costs[Math.floor(costs.length * .95)],
          frameGapP50: gaps[30], frameGapP95: gaps[57] };
      });
      await page.close();
    }
    const cached = results.cached, uncached = results.uncached;
    const delta = (result: any, name: string) => result.animated[name] - result.initial[name];
    assert.equal(delta(uncached, "draws"), 60 * 5, "ablation must redraw all five surfaces");
    assert.equal(delta(cached, "draws"), 60, "only the changing surface needs another optical pass");
    assert.ok(delta(cached, "uploads") <= 2, "the moving field must keep its existing background texture");
    assert.equal(delta(uncached, "uploads"), 60 * 5, "shared uncached texture must expose inter-surface upload churn");
    assert.deepEqual(cached.pixels, uncached.pixels, "output retention must preserve the final full-resolution image");
    assert.deepEqual(cached.changedPixels, uncached.changedPixels, "an intersecting backdrop change must invalidate cached optics");
    assert.equal(cached.afterChange.draws - cached.beforeChange.draws, 1, "local backdrop changes invalidate only the affected surface");
    assert.ok(cached.liveOutputs > 0 && cached.liveOutputs <= 8);
    assert.ok(cached.livePixels <= 4 * 1024 * 1024, "retained output storage must obey the pixel budget");
    assert.equal(cached.released, true, "closing preview must release all retained output storage");
    console.log("GLASS_CACHE_ABLATION", JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, value]) => [name, {
      uploads: delta(value, "uploads"), draws: delta(value, "draws"), uploadedPixels: delta(value, "pixels"),
      canvasP50Ms: value.canvasP50Ms, canvasP95Ms: value.canvasP95Ms,
      frameGapP50: value.frameGapP50, frameGapP95: value.frameGapP95,
    }]))));
  } finally { await browser.close(); server.stop(true); }
});
