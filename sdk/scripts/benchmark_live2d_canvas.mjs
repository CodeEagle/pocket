// Licensed Core/model stay in local caches. Usage is documented in
// docs/LIVE2D_WEB_PREVIEW_OPTIMIZATION.md. Measures Canvas submission, not FPS.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv[2];
if (!baseline) throw new Error("Pass the baseline preview.js path as the first argument");
const sample = process.env.POCKET_HIYORI_ROOT || resolve(sdk,
  "packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5/Samples/Resources/Hiyori");
const core = process.env.POCKET_CUBISM_WEB_CORE || resolve(sdk,
  "packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js");
const browser = await chromium.launch({ headless: process.env.POCKET_BENCH_HEADFUL !== "1" });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ path: core });
  await page.addScriptTag({ path: resolve(sdk, "targets/web/live2d_provider.js") });
  await page.addScriptTag({ path: resolve(baseline) });
  await page.evaluate(() => { window.baselinePreview = window.PocketEditorPreview; });
  await page.addScriptTag({ path: resolve(sdk, "editor/client/preview.js") });
  const report = await page.evaluate(async ({ moc, pngs }) => {
    const bytes = Uint8Array.from(atob(moc), x => x.charCodeAt(0));
    const provider = PocketLive2dProvider.createLive2dProvider({
      core: async () => Live2DCubismCore, readAsset: async () => bytes,
    });
    try {
      const info = await provider.invoke("media.live2d.model.load", {
        id: "benchmark", mocAsset: "Hiyori.moc3", textures: ["page0", "page1"],
      });
      const frame = await provider.invoke("media.live2d.model.update", {
        modelId: info.modelId, parameters: [{ id: "ParamAngleX", value: 20 }], partOpacities: [],
        placement: { dx: 0, dy: 0, scale: Math.min(240 / info.canvas.widthPixels, 340 / info.canvas.heightPixels), opacity: 1 },
      });
      const colors = b => Array.from(new Float32Array(b.buffer, b.byteOffset, 4)).slice(0, 3);
      const meshes = [...frame.drawables].sort((a, b) => a.renderOrder - b.renderOrder)
        .filter(d => d.meshBytes.length).map(d => ({
          id: d.id, texture: info.textures[d.textureIndex], geometry: d.meshBytes,
          visible: Boolean(d.dynamicFlags & 1) && d.opacity > 0,
          effect: {
            blend: ({ 0: "normal", 3: "add", 6: "multiply", 10: "screen" })[d.blendMode],
            repeatTexture: true,
            masks: Array.from(new Uint32Array(d.maskIndices.buffer, d.maskIndices.byteOffset, d.maskIndices.length / 4))
              .filter(i => frame.drawables[i].meshBytes.length).map(i => frame.drawables[i].id),
            inverted: Boolean(d.constantFlags & 8) && d.maskIndices.length > 0,
            multiplyRgb: colors(d.multiplyColorRgba), screenRgb: colors(d.screenColorRgba),
          },
        }));
      const images = {};
      for (let i = 0; i < pngs.length; i++) {
        const img = new Image();
        img.src = "data:image/png;base64," + pngs[i];
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(img, 0, 0);
        images["page" + i] = { canvas, width: img.width, height: img.height,
          rgba: context.getImageData(0, 0, img.width, img.height).data };
      }
      let counts;
      const proto = CanvasRenderingContext2D.prototype;
      const originals = {};
      for (const name of ["clearRect", "drawImage", "createPattern"]) {
        originals[name] = proto[name];
        proto[name] = function (...args) {
          if (counts) counts[name]++;
          return originals[name].apply(this, args);
        };
      }
      const result = { drawables: meshes.length, visible: meshes.filter(m => m.visible).length, measurements: {} };
      const pixels = {};
      try {
        for (const [name, renderer] of [["before", window.baselinePreview], ["after", window.PocketEditorPreview]]) {
          const canvas = document.createElement("canvas");
          canvas.width = 240; canvas.height = 340;
          const context = canvas.getContext("2d");
          const paint = () => { context.clearRect(0, 0, 240, 340); renderer.projectModelMeshes(context, meshes, images); };
          for (let i = 0; i < 3; i++) paint();
          counts = { clearRect: 0, drawImage: 0, createPattern: 0 };
          const times = [];
          for (let i = 0; i < 12; i++) {
            const start = performance.now(); paint(); times.push(performance.now() - start);
          }
          result.measurements[name] = { medianMs: times.sort((a, b) => a - b)[6], ...counts, frames: 12 };
          counts = null;
          pixels[name] = context.getImageData(0, 0, 240, 340).data;
        }
      } finally {
        for (const [name, original] of Object.entries(originals)) proto[name] = original;
      }
      let changedComponents = 0, maxDelta = 0, coveredPixels = 0;
      for (let i = 0; i < pixels.before.length; i++) {
        const delta = Math.abs(pixels.before[i] - pixels.after[i]);
        if (delta) changedComponents++;
        maxDelta = Math.max(maxDelta, delta);
        if (i % 4 === 3 && pixels.after[i]) coveredPixels++;
      }
      result.pixelDiff = { changedComponents, maxDelta, coveredPixels };
      return result;
    } finally { await provider.dispose(); }
  }, {
    moc: readFileSync(resolve(sample, "Hiyori.moc3")).toString("base64"),
    pngs: [0, 1].map(i => readFileSync(resolve(sample, `Hiyori.2048/texture_0${i}.png`)).toString("base64")),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.pixelDiff.coveredPixels === 0 ||
      (process.env.POCKET_BENCH_EXPECT_IDENTICAL === "1" && report.pixelDiff.changedComponents !== 0)) process.exitCode = 1;
} finally { await browser.close(); }
