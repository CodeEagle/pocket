import { afterAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const client = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
const optics = readFileSync(new URL("../client/liquid-glass.js", import.meta.url), "utf8");
const shader = readFileSync(new URL("../../packages/pocket_flutter/shaders/liquid_glass.frag", import.meta.url), "utf8");

type OpticalBrowser = Awaited<ReturnType<typeof chromium.launch>>;
let opticalBrowser: OpticalBrowser | undefined;

async function getOpticalBrowser(): Promise<OpticalBrowser> {
  opticalBrowser ??= await chromium.launch({
    headless: true,
    args: process.platform === "darwin" ? ["--use-angle=metal"] : [],
  });
  return opticalBrowser;
}

afterAll(async () => {
  await opticalBrowser?.close().catch(() => {});
  opticalBrowser = undefined;
});

test("Web Liquid Glass executes the retained optical shader without CPU readback", { timeout: 30_000 }, async () => {
  const variants = {
    optical: shader,
    // Remove only Snell/warp displacement. Frost, tint and rim remain, so a
    // frosted overlay alone cannot satisfy the optical pixel assertion.
    flat: shader.replace(/vec2 uvG = clamp\([^;]+;/, "vec2 uvG = uv;"),
    uncropped: shader,
  };
  assert.notEqual(variants.flat, shader, "refraction ablation must match the retained shader");
  const server = Bun.serve({ port: 0, fetch(request) {
    const variant = new URL(request.url).pathname.slice(1) as keyof typeof variants;
    const renderer = variant === "uncropped" ? optics
      .replace(/const cx =[^\n]+;/, "const cx = 0, cy = 0;")
      .replace(/const cr =[^\n]+;/, "const cr = source.width;")
      .replace(/const cb =[^\n]+;/, "const cb = source.height;") : optics;
    const source = renderer.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(variants[variant] ?? shader));
    return new Response(`<div data-pocket-preview data-project-id=optics></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`,
      { headers: { "content-type": "text/html" } });
  } });
  const browser = await getOpticalBrowser();
  try {
    const images: Record<string, number[]> = {};
    for (const variant of ["optical", "flat", "uncropped"] as const) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 });
      const warnings: string[] = [];
      page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
      await page.addInitScript(() => {
        class Source { onmessage?: (event: { data: string }) => void; constructor() { (window as any).__source = this; } close() {} }
        Object.defineProperty(window, "EventSource", { value: Source });
        (window as any).__uploads = [];
        (window as any).__gpuDraws = 0;
        (window as any).__deleted = 0;
        const proto = WebGLRenderingContext.prototype;
        for (const name of ["texImage2D", "texSubImage2D"] as const) {
          const old = proto[name];
          (proto as any)[name] = function (...args: any[]) {
            const source = args.at(-1);
            if (source instanceof HTMLCanvasElement) (window as any).__uploads.push([source.width, source.height]);
            return (old as any).apply(this, args);
          };
        }
        const draw = proto.drawArrays;
        proto.drawArrays = function (...args) { (window as any).__gpuDraws++; return draw.apply(this, args); };
        const remove = proto.deleteTexture;
        proto.deleteTexture = function (...args) { (window as any).__deleted++; return remove.apply(this, args); };
        proto.readPixels = function () { throw new Error("Glass must not read GPU pixels to JS"); };
        const read = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function (...args) {
          if (!(window as any).__sampling) throw new Error("Glass must not read Canvas pixels to JS");
          return read.apply(this, args);
        };
      });
      await page.goto(`http://127.0.0.1:${server.port}/${variant}`);
      await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
      const result = await page.evaluate(async () => {
        let index = 0;
        const background = Array.from({ length: 39 }, (_, x) => ({ type: "rect", x: x * 10, y: 0, w: 10, h: 844,
          color: (0xff000000 | ((x % 2 ? 220 : 30) << 16) | ((x * 13 % 255) << 8) | (x % 3 ? 240 : 10)) >>> 0 }));
        const glass = (shape: string, darkMaterial = false) => ({ type: "hostSurface", x: 16, y: 730, w: 358, h: 64,
          asset: JSON.stringify({ kind: "glass", parameters: { effect: "glass", shape, radius: 24,
            blur: 0, edgeIntensity: .015, rimIntensity: .05, baseIntensity: .01, tintOpacity: .04,
            cornerBoost: .02, rippleEffect: 0, warp: false, pressed: false,
            materialStrength: darkMaterial ? .72 : 0, materialTint: 0xff1c1c1e } }) });
        async function send(shape = "rounded", color = 0xffffff00, darkMaterial = false) {
          (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: {
            frame: ++index, width: 390, height: 844, events: [], resources: [],
            ops: [...background, glass(shape, darkMaterial), { type: "rect", x: 185, y: 750, w: 20, h: 20, color }],
          } }) });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        await send();
        const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
        for (let attempt = 0; attempt < 120 && canvas.dataset.glassRenderer !== "webgl-refractive"; attempt++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        (window as any).__sampling = true;
        // Sample the lens and surrounding band, without serializing a full
        // multi-megapixel scene through CDP during the render measurement.
        const pixels = Array.from(canvas.getContext("2d")!.getImageData(0, 1440, canvas.width, 180).data);
        (window as any).__sampling = false;
        const cold = { uploads: (window as any).__uploads.length, draws: (window as any).__gpuDraws };
        await send("rounded", 0xff00ffff);
        const foreground = { uploads: (window as any).__uploads.length, draws: (window as any).__gpuDraws };
        await send("pill");
        const shape = { uploads: (window as any).__uploads.length, draws: (window as any).__gpuDraws };
        (window as any).__sampling = true;
        const bright = Array.from(canvas.getContext("2d")!.getImageData(200, 1520, 1, 1).data).slice(0, 3).reduce((a, b) => a + b, 0);
        (window as any).__sampling = false;
        await send("pill", 0xffffff00, true);
        (window as any).__sampling = true;
        const dark = Array.from(canvas.getContext("2d")!.getImageData(200, 1520, 1, 1).data).slice(0, 3).reduce((a, b) => a + b, 0);
        (window as any).__sampling = false;
        const material = { uploads: (window as any).__uploads.length, draws: (window as any).__gpuDraws, bright, dark };
        const mode = canvas.dataset.glassRenderer ?? "missing";
        const uploads = (window as any).__uploads;
        await (window as any).PocketEditorPreviewInstance.close();
        return { pixels, width: canvas.width, mode, cold, foreground, shape, material, uploads, deleted: (window as any).__deleted };
      });
      assert.equal(result.mode, "webgl-refractive", warnings.join("\n"));
      assert.deepEqual(result.cold, { uploads: 1, draws: 1 });
      assert.deepEqual(result.foreground, result.cold, "foreground-only changes must reuse the optical result");
      assert.deepEqual(result.shape, { uploads: 1, draws: 2 }, "shape changes update uniforms without a background upload");
      assert.equal(result.material.uploads, 1, "appearance tint updates only shader uniforms");
      assert.equal(result.material.draws, 3);
      assert.ok(result.material.dark < result.material.bright * .75, "regular dark material must suppress a busy bright backdrop behind its foreground");
      if (variant !== "uncropped") assert.ok(result.uploads.every(([w, h]: number[]) => w * h < 780 * 1688 / 3), `capture must be bounded to the lens and sampling halo: ${JSON.stringify(result.uploads)}`);
      assert.equal(result.deleted, 1, "closing preview must release its GPU texture");
      const at = (x: number, y: number) => result.pixels.slice((y * result.width + x) * 4, (y * result.width + x) * 4 + 4);
      assert.deepEqual(at(390, 80), [255, 255, 0, 255], "foreground content must stay above the optical sample");
      images[variant] = result.pixels;
      await page.close();
    }
    let refracted = 0, outsideDifferences = 0;
    const optical = images.optical!, flat = images.flat!;
    for (let y = 0; y < 180; y++) for (let x = 0; x < 780; x++) {
      const at = (y * 780 + x) * 4;
      const difference = Math.abs(optical[at]! - flat[at]!) + Math.abs(optical[at + 1]! - flat[at + 1]!) + Math.abs(optical[at + 2]! - flat[at + 2]!);
      if (x >= 32 && x < 748 && y >= 20 && y < 148) {
        if (difference > 30) refracted++;
      } else if (difference > 2) outsideDifferences++;
    }
    assert.ok(refracted > 1000, `disabling refraction must change real backdrop pixels: ${refracted}`);
    assert.equal(outsideDifferences, 0, "glass must not alter pixels outside its geometry");
    let maximumCropError = 0;
    for (let index = 0; index < optical.length; index++) maximumCropError = Math.max(maximumCropError, Math.abs(optical[index]! - images.uncropped![index]!));
    assert.ok(maximumCropError <= 2, `bounded capture must match full-scene sampling: maximum channel error ${maximumCropError}`);
  } finally {
    server.stop(true);
  }
});

test("Web Liquid Glass material variants preserve backdrop detail without a second renderer", { timeout: 30_000 }, async () => {
  const server = Bun.serve({ port: 0, fetch() {
    const source = optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
    return new Response(`<div data-pocket-preview data-project-id=material></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await getOpticalBrowser();
  const page = await browser.newPage({ viewport: { width: 160, height: 240 }, deviceScaleFactor: 2 });
  const warnings: string[] = [];
  page.on("pageerror", error => warnings.push(error.message));
  page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
  await page.addInitScript(() => {
    class Source { constructor() { (window as any).__source = this; } close() {} }
    Object.defineProperty(window, "EventSource", { value: Source });
    WebGLRenderingContext.prototype.readPixels = function () { throw new Error("No production GPU readback"); };
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (!(window as any).__sampling) throw new Error("No production Canvas readback");
      return read.apply(this, args);
    };
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    const result = await page.evaluate(async () => {
      const frameWidth = 120, frameHeight = 180;
      let frame = 0;
      const waitFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const post = async (material?: "regular" | "clear", dark = false) => {
        const first = dark ? 0xff182b43 : 0xffd15343;
        const second = dark ? 0xff203a55 : 0xff246796;
        const ops: any[] = Array.from({ length: 30 }, (_, index) => ({ type: "rect", x: index * 4, y: 0, w: 4, h: frameHeight, color: (index % 2 ? first : second) >>> 0 }));
        if (material) ops.push({ type: "hostSurface", x: 4, y: 60, w: 112, h: 60,
          asset: JSON.stringify({ kind: "glass", parameters: {
            effect: "glass", material, shape: "rounded", radius: 24,
            blur: material === "regular" ? 12 : 1.5,
            materialStrength: material === "regular" ? .24 : .02,
            materialTint: 0xfff2f2f7,
            edgeIntensity: .015, rimIntensity: .05, baseIntensity: .01,
            tintOpacity: .04, cornerBoost: .02, rippleEffect: 0, warp: false,
          } }) });
        (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: { frame: ++frame, width: frameWidth, height: frameHeight, events: [], resources: [], ops } }) });
        await waitFrame();
      };
      const sample = () => {
        const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
        (window as any).__sampling = true;
        const raw = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        (window as any).__sampling = false;
        const pixel = (x: number, y: number) => {
          const index = (Math.round(y * canvas.height / frameHeight) * canvas.width + Math.round(x * canvas.width / frameWidth)) * 4;
          return [raw[index]!, raw[index + 1]!, raw[index + 2]!];
        };
        return { row: Array.from({ length: 20 }, (_, index) => pixel(12 + index * 5, 90)), color: pixel(60, 90) };
      };
      const contrast = (row: number[][]) => row.slice(1).reduce((sum, color, index) => sum + color.reduce((channels, value, component) => channels + Math.abs(value - row[index]![component]!), 0), 0) / (row.length - 1);
      await post();
      const baseline = sample();
      await post("clear");
      for (let attempt = 0; attempt < 180 && (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer !== "webgl-refractive"; attempt++) await waitFrame();
      const clear = sample();
      await post("regular");
      const regular = sample();
      await post("clear", true);
      const darkClear = sample();
      await post("regular", true);
      const darkRegular = sample();
      const mode = ((window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement).dataset.glassRenderer ?? "missing";
      await (window as any).PocketEditorPreviewInstance.close();
      return { baseline, clear, regular, darkClear, darkRegular, mode, contrasts: {
        baseline: contrast(baseline.row), clear: contrast(clear.row), regular: contrast(regular.row),
      } };
    });
    assert.equal(result.mode, "webgl-refractive", warnings.join("; "));
    assert.ok(result.contrasts.baseline > 20, "fixture must have actual background detail");
    assert.ok(result.contrasts.clear > result.contrasts.baseline * .18, "clear must retain background detail");
    assert.ok(result.contrasts.regular < result.contrasts.clear * .92, "regular must soften more than clear");
    const saturation = (color: number[]) => (Math.max(...color) - Math.min(...color)) / Math.max(1, Math.max(...color));
    assert.ok(saturation(result.clear.color) > .08 && saturation(result.regular.color) > .03, "both materials must preserve backdrop hue");
    assert.ok(Math.max(...result.darkClear.color) < 180 && Math.max(...result.darkRegular.color) < 180, "dark content must stay dark with the same light-theme tint");
  } finally {
    await page.close().catch(() => {});
    server.stop(true);
  }
});

test("Web Liquid Glass degrades to real frost when the GPU context is unavailable or lost", { timeout: 30_000 }, async () => {
  const source = optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(`<div data-pocket-preview data-project-id=fallback></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await getOpticalBrowser();
  try {
    for (const unavailable of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
      await page.addInitScript((unavailable) => {
        class Source { constructor() { (window as any).__source = this; } close() {} }
        Object.defineProperty(window, "EventSource", { value: Source });
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
          if (type === "webgl" && unavailable) return null;
          const result = (get as any).call(this, type, ...args);
          if (type === "webgl") (window as any).__gl = result;
          return result;
        } as any;
      }, unavailable);
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
      const result = await page.evaluate(async (unavailable) => {
        const instance = (window as any).PocketEditorPreviewInstance;
        const post = (frame: number) => (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: {
          frame, width: 100, height: 100, resources: [], events: [], ops: [
            { type: "rect", x: 0, y: 0, w: 50, h: 100, color: 0xffff0000 },
            { type: "rect", x: 50, y: 0, w: 50, h: 100, color: 0xff0000ff },
            { type: "hostSurface", x: 0, y: 0, w: 100, h: 100, asset: JSON.stringify({ kind: "glass", parameters: {
              effect: "glass", blur: 8, radius: 0, opticalInset: 20,
            } }) },
          ],
        } }) });
        post(1);
        if (!unavailable) {
          (window as any).__gl.getExtension("WEBGL_lose_context").loseContext();
          await new Promise((resolve) => setTimeout(resolve, 50));
          post(2);
        }
        const canvas = instance.canvas as HTMLCanvasElement;
        const pixel = Array.from(canvas.getContext("2d")!.getImageData(49, 50, 1, 1).data);
        const outside = Array.from(canvas.getContext("2d")!.getImageData(5, 50, 1, 1).data);
        const mode = canvas.dataset.glassRenderer;
        await instance.close();
        return { pixel, outside, mode };
      }, unavailable);
      assert.equal(result.mode, "frosted");
      assert.ok(result.pixel[0]! > 30 && result.pixel[2]! > 30, `fallback must sample and blur the real backdrop: ${result.pixel}`);
      assert.ok(result.outside[0]! > 240 && result.outside[1]! < 15 && result.outside[2]! < 15,
        `fallback inset must preserve the original red backdrop outside the shape: ${result.outside}`);
      await page.close();
    }
  } finally { server.stop(true); }
});

test("cold optical preparation yields without querying blocking link state and redraws a parked frame", { timeout: 30_000 }, async () => {
  const source = optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shader));
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(`<div data-pocket-preview data-project-id=cold></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await getOpticalBrowser();
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
  try {
    const warnings: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
    await page.addInitScript(() => {
      class Source { constructor() { (window as any).__source = this; } close() {} }
      Object.defineProperty(window, "EventSource", { value: Source });
      (window as any).__completionPolls = 0;
      (window as any).__blockingQueries = 0;
      const proto = WebGLRenderingContext.prototype;
      const query = proto.getProgramParameter;
      proto.getProgramParameter = function (program, parameter) {
        if (parameter === 0x91b1) {
          (window as any).__completionPolls++;
          // Model a slow driver without blocking JS or faking shader success.
          if ((window as any).__completionPolls <= 4) return false;
        }
        if (parameter === this.LINK_STATUS && (window as any).__completionPolls <= 4) {
          (window as any).__blockingQueries++;
          throw new Error("link state queried before asynchronous completion");
        }
        return query.call(this, program, parameter);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    const initial = await page.evaluate(() => {
      (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: { frame: 1, width: 100, height: 100,
        events: [], resources: [], ops: [
          { type: "rect", x: 0, y: 0, w: 50, h: 100, color: 0xffff0000 },
          { type: "rect", x: 50, y: 0, w: 50, h: 100, color: 0xff0000ff },
          { type: "hostSurface", x: 0, y: 0, w: 100, h: 100, asset: JSON.stringify({ kind: "glass", parameters: { effect: "glass", blur: 7.5 } }) },
        ],
      } }) });
      return (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer;
    });
    assert.equal(initial, "frosted", "the first frame must stay paintable while the driver compiles");
    try {
      await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer === "webgl-refractive", undefined, { timeout: 5000 });
    } catch (error) {
      const state = await page.evaluate(() => ({ polls: (window as any).__completionPolls, blocking: (window as any).__blockingQueries, mode: (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer }));
      throw new Error(`${String(error)} ${JSON.stringify({ state, warnings })}`);
    }
    const settled = await page.evaluate(() => ({ frame: (window as any).PocketEditorPreviewInstance.getFrame().frame,
      polls: (window as any).__completionPolls, blocking: (window as any).__blockingQueries }));
    assert.equal(settled.frame, 1, "completion must redraw the existing frame without guest polling");
    assert.ok(settled.polls >= 5);
    assert.equal(settled.blocking, 0);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).__completionPolls), settled.polls, "preparation must park when complete");
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
  } finally {
    await page.close().catch(() => {});
    server.stop(true);
  }
});
