import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { test } from "bun:test";

const client = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
const optics = readFileSync(new URL("../client/liquid-glass.js", import.meta.url), "utf8");
const shader = readFileSync(new URL("../../packages/pocket_flutter/shaders/liquid_glass.frag", import.meta.url), "utf8");

const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 160;
const DENSE_GRID_X = 104;
const DENSE_GRID_Y = 108;
const DENSE_GRID_SIZE = 33;
const DENSE_GRID_STEP = 1;

type RGB = [number, number, number];
type Sample = { x: number; y: number; color: RGB };

// A real decoded psm=3 image resource, rather than a synthetic rect. The
// glyph edge is deliberately high contrast so repeated backdrop taps remain
// measurable after the panel is composited.
function makeGlyphResource() {
  const width = 32;
  const height = 32;
  const pixels = new Array<number>(width * height * 4).fill(0);
  const glyph = [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ];
  const scale = 3;
  const left = 8;
  const top = 5;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] !== "1") continue;
      for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) {
        const px = left + column * scale + x;
        const py = top + row * scale + y;
        const at = (py * width + px) * 4;
        pixels[at] = 100;
        pixels[at + 1] = 224;
        pixels[at + 2] = 255;
        pixels[at + 3] = 255;
      }
    }
  }
  return { asset: "glyph-page", width, height, psm: 3, pixels };
}

const glyphResource = makeGlyphResource();

// Freeze the regular material that was present at repository HEAD. This is
// deliberately constructed from constants, so the test never shells out to
// git at runtime and cannot accidentally use the current shader as its own
// ablation/reference answer.
function legacyRegularBranch(): string {
  const weights = [1, 3, 6, 8, 6, 3, 1];
  const lines = [
    "  } else if (materialVariant < 1.5) {",
    "    vec2 blurStep = vec2(",
    "      uBlur * 0.28 / uSurfaceSize.x,",
    "      uBlur * 0.24 / uSurfaceSize.y",
    "    );",
    "    vec3 accumulated = vec3(0.0);",
  ];
  for (let row = -3; row <= 3; row += 1) for (let column = -3; column <= 3; column += 1) {
    const weight = weights[row + 3]! * weights[column + 3]!;
    const signedX = column.toFixed(1);
    const signedY = row.toFixed(1);
    lines.push(`    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(${signedX}, ${signedY}), 0.002, 0.998)).rgb * ${weight.toFixed(1)};`);
  }
  lines.push("    glassColor = accumulated / 784.0;\n");
  return lines.join("\n");
}

function legacyRegularShader(source: string): string {
  const regularStart = source.indexOf("  } else if (materialVariant < 1.5) {");
  const clearStart = source.indexOf("  } else {\n    // Clear keeps", regularStart);
  assert.ok(regularStart >= 0 && clearStart > regularStart, "regular material branch must remain identifiable");
  return source.slice(0, regularStart) + legacyRegularBranch() + source.slice(clearStart);
}

const beforeShader = legacyRegularShader(shader);

function baseOps() {
  return [
    { type: "rect", x: 0, y: 0, w: FRAME_WIDTH, h: FRAME_HEIGHT, color: 0xff13213a },
    { type: "image", asset: glyphResource.asset, x: 104, y: 108, w: 32, h: 32 },
    { type: "text", x: 65, y: 112, w: 30, h: 22, text: "G", fontSlot: 7, color: 0xffffd166 },
  ];
}

function glassOp(material: "regular" | "clear") {
  const regular = material === "regular";
  return {
    type: "hostSurface",
    x: regular ? 8 : 96,
    y: regular ? 96 : 100,
    w: regular ? 224 : 48,
    h: regular ? 56 : 48,
    asset: JSON.stringify({ kind: "glass", parameters: {
      effect: "glass", material, shape: regular ? "rounded" : "pill",
      radius: regular ? 12 : 999, blur: regular ? 12 : 0,
      edgeIntensity: 0, rimIntensity: 0, baseIntensity: 0, tintOpacity: 0,
      cornerBoost: 0, rippleEffect: 0, warp: false, pressed: false,
      materialStrength: 0, materialTint: 0xfff2f2f7, magnification: 1,
    } }),
  };
}

function imageSource(shaderSource: string) {
  return optics.replace('"" /* pocket-liquid-glass-shader */', JSON.stringify(shaderSource));
}

function sampleError(left: RGB, right: RGB): number {
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);
}

function aliasMetrics(grid: RGB[], size: number) {
  const luminance = grid.map(([r, g, b]) => r * 0.299 + g * 0.587 + b * 0.114);
  let total = 0;
  let axis = 0;
  let diagonal = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y += 1) for (let x = 1; x < size - 1; x += 1) {
    const at = y * size + x;
    const left = luminance[at - 1]!;
    const right = luminance[at + 1]!;
    const up = luminance[at - size]!;
    const down = luminance[at + size]!;
    const diagonalMean = (luminance[at - size - 1]! + luminance[at - size + 1]!
      + luminance[at + size - 1]! + luminance[at + size + 1]!) / 4;
    total += Math.abs(4 * luminance[at]! - luminance[at - 1]! - luminance[at + 1]!
      - luminance[at - size]! - luminance[at + size]!);
    axis += Math.abs(2 * luminance[at]! - left - right) + Math.abs(2 * luminance[at]! - up - down);
    diagonal += Math.abs(luminance[at]! - diagonalMean);
    count += 1;
  }
  return {
    denseAliasEnergy: total / Math.max(1, count),
    axisEnergy: axis / Math.max(1, count),
    diagonalEnergy: diagonal / Math.max(1, count),
  };
}

test("Web Liquid Glass regular material reduces glyph lattice artifacts and keeps the nav center transparent", { timeout: 30_000 }, async () => {
  const variants = { current: shader, before: beforeShader };
  const server = Bun.serve({ port: 0, fetch(request) {
    const variant = new URL(request.url).pathname.slice(1) as keyof typeof variants;
    const source = imageSource(variants[variant] ?? shader);
    return new Response(`<div data-pocket-preview data-project-id=material-artifact></div><script>${`${source}\n${client}`.replaceAll("</script", "<\\/script")}</script>`, {
      headers: { "content-type": "text/html" },
    });
  } });
  const browser = await chromium.launch({ headless: true, args: process.platform === "darwin" ? ["--use-angle=metal"] : [] });

  try {
    async function renderVariant(variant: keyof typeof variants, includeNav: boolean) {
      const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT }, deviceScaleFactor: 2 });
      try {
        await page.addInitScript(() => {
          class Source { constructor() { (window as any).__source = this; } close() {} }
          Object.defineProperty(window, "EventSource", { value: Source });
          (window as any).__sampling = false;
          WebGLRenderingContext.prototype.readPixels = function () { throw new Error("Glass must not read GPU pixels to JS"); };
          const read = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function (...args) {
            if (!(window as any).__sampling) throw new Error("Glass must not read Canvas pixels to JS");
            return read.apply(this, args);
          };
        });
        await page.goto(`http://127.0.0.1:${server.port}/${variant}`);
        await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));

        let frame = 0;
        const navPoints = [
          { x: 118, y: 122 }, { x: 120, y: 122 }, { x: 122, y: 122 },
          { x: 118, y: 124 }, { x: 120, y: 124 }, { x: 122, y: 124 },
          { x: 118, y: 126 }, { x: 120, y: 126 }, { x: 122, y: 126 },
          { x: 80, y: 124 },
        ];
        const post = async (glass: "none" | "regular" | "clear") => {
          const ops = baseOps();
          if (glass !== "none") ops.push(glassOp(glass));
          await page.evaluate(({ nextFrame, ops, resources, width, height }) => {
            (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame: {
              frame: nextFrame, width, height, events: [], resources, ops,
            } }) });
          }, { nextFrame: ++frame, ops, resources: frame === 1 ? [glyphResource] : [], width: FRAME_WIDTH, height: FRAME_HEIGHT });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        };

        const sample = async (points: Array<{ x: number; y: number }>): Promise<Sample[]> => page.evaluate(({ points, width, height }) => {
          const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
          const context = canvas.getContext("2d")!;
          (window as any).__sampling = true;
          const raw = context.getImageData(0, 0, canvas.width, canvas.height).data;
          (window as any).__sampling = false;
          const color = (x: number, y: number): RGB => {
            const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x * canvas.width / width)));
            const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y * canvas.height / height)));
            const at = (py * canvas.width + px) * 4;
            return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
          };
          return points.map(({ x, y }) => ({ x, y, color: color(x, y) }));
        }, { points, width: FRAME_WIDTH, height: FRAME_HEIGHT });

        const gridPoints = Array.from({ length: DENSE_GRID_SIZE * DENSE_GRID_SIZE }, (_, index) => ({
          x: DENSE_GRID_X + (index % DENSE_GRID_SIZE) * DENSE_GRID_STEP,
          y: DENSE_GRID_Y + Math.floor(index / DENSE_GRID_SIZE) * DENSE_GRID_STEP,
        }));
        await post("none");
        const navBaseline = includeNav ? await sample(navPoints) : [];
        await post("regular");
        await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer === "webgl-refractive", undefined, { timeout: 8_000 });
        const regular = await sample(gridPoints);
        let nav: Sample[] = [];
        if (includeNav) {
          await post("clear");
          await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.canvas.dataset.glassRenderer === "webgl-refractive", undefined, { timeout: 8_000 });
          nav = await sample(navPoints);
        }
        await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
        return { regular, navBaseline, nav };
      } finally {
        await page.close().catch(() => {});
      }
    }

    const current = await renderVariant("current", true);
    const before = await renderVariant("before", false);
    const currentMetrics = aliasMetrics(current.regular.map(({ color }) => color), DENSE_GRID_SIZE);
    const beforeMetrics = aliasMetrics(before.regular.map(({ color }) => color), DENSE_GRID_SIZE);
    assert.ok(currentMetrics.denseAliasEnergy < beforeMetrics.denseAliasEnergy * 0.95,
      `current regular material must reduce dense glyph alias energy versus the frozen HEAD branch: ${JSON.stringify({ currentMetrics, beforeMetrics })}`);
    assert.ok(currentMetrics.axisEnergy < beforeMetrics.axisEnergy * 0.95,
      `current regular material must reduce dense glyph axis alias energy versus the frozen HEAD branch: ${JSON.stringify({ currentMetrics, beforeMetrics })}`);
    assert.ok(currentMetrics.diagonalEnergy < beforeMetrics.diagonalEnergy * 0.9,
      `current regular material must reduce dense glyph diagonal alias energy versus the frozen HEAD branch: ${JSON.stringify({ currentMetrics, beforeMetrics })}`);

    const centerSamples = current.nav.slice(0, 9);
    const centerBaseline = current.navBaseline.slice(0, 9);
    const centerDelta = centerSamples.reduce((total, sample, index) => total + sampleError(sample.color, centerBaseline[index]!.color), 0) / centerSamples.length;
    const outsideDelta = sampleError(current.nav[9]!.color, current.navBaseline[9]!.color);
    assert.ok(centerDelta <= 12,
      `clear navigation center must remain transparent over the glyph/image backdrop: ${JSON.stringify({ centerDelta, centerSamples, centerBaseline })}`);
    assert.ok(outsideDelta <= 2,
      `navigation lens must not wash pixels outside its shape: ${JSON.stringify({ outsideDelta, outside: current.nav[9], baseline: current.navBaseline[9] })}`);
  } finally {
    await browser.close().catch(() => {});
    server.stop(true);
  }
});
