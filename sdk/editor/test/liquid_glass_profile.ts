/** Run from repository root with bun. Real QJBC/native input + browser canvas
 * profiling; keeps frame delivery, drawing cost and display rAF distinct. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const root = resolve(import.meta.dir, "../../..");
const project = mkdtempSync(join(tmpdir(), "pocket-liquid-profile-"));
let manager: ReturnType<typeof createPreviewManager> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "glass-profile", private: true, type: "module" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.qa.glass-profile", entry: "app.tsx" }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "app.tsx"), `
import { For, Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, View, Text } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import { GlassSurface, MobileButton } from "@pocket/ui";
function App() {
  const [running, run] = createSignal(false);
  const [glass, setGlass] = createSignal(true);
  const [offset, move] = createSignal(0);
  onFrame(() => move(Math.sin(virtualNow() * 2) * 45), { active: running, continuous: running });
  return <Screen class="w-full h-full relative bg-[#101827]">
    <View class="absolute inset-0 overflow-hidden">
      <View class="absolute left-[-50] top-[-50] w-[490] h-[1000]" style={{ translateY: offset() }}>
        <For each={Array.from({length: 24}, (_,i) => i)}>{(i) => <View class="w-full h-[42]" style={{bgColor: i%3===0?0xff375b91:i%3===1?0xffce8855:0xff4a998c}} />}</For>
      </View>
    </View>
    <View class="absolute left-[16] top-[60] w-[358] h-[64]">
      <Show when={glass()}><GlassSurface material="regular" warp={false} radius={28} class="absolute inset-0" contentClass="" /></Show>
      <View class="relative flex-row h-full items-center justify-center gap-2">
        <MobileButton label={running()?"Stop motion":"Start motion"} kind="text" onPress={() => run(!running())} />
        <MobileButton label={glass()?"Glass off":"Glass on"} kind="text" onPress={() => setGlass(!glass())} />
      </View>
    </View>
    <View class="absolute left-[16] top-[730] w-[358] h-[64]">
      <Show when={glass()}><GlassSurface material="regular" warp={false} shape="pill" class="absolute inset-0" contentClass="" /></Show>
      <View class="relative flex-row h-full items-center justify-center"><Text class="text-base font-bold text-white">Now playing</Text></View>
    </View>
  </Screen>;
}
mount(App);
`);
  const built = await buildGuest({ projectRoot: project, outDir: join(project, "out"), tickHz: 60 });
  manager = createPreviewManager({
    probePath: process.env.POCKET_NATIVE_PROBE ?? join(root, "sdk/native/target/release/pocket_probe"),
    width: 390, height: 844, rasterDensity: 2,
    artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
  });
  server = Bun.serve({ port: 0, fetch: (request) => manager!.handle(request, "glass-profile") });
  browser = await chromium.launch({ headless: process.env.POCKET_PROFILE_HEADED !== "1", args: process.platform === "darwin" ? ["--use-angle=metal"] : [] });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const samples = (window as any).__profile = { frames: [] as number[], draws: [] as number[], raf: [] as number[], uploads: [] as number[], gpu: "unknown", opticsCreateMs: 0, firstOpticalDrawMs: 0 };
    let started = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === "pocket-preview-surface") started = performance.now();
      return clear.apply(this, args);
    };
    const post = window.postMessage;
    window.postMessage = function (message: any, ...args: any[]) {
      if (message?.source === "pocket-editor-preview" && message?.type === "preview.frame") {
        const now = performance.now(); samples.frames.push(now); samples.draws.push(now - started);
      }
      return (post as any).call(this, message, ...args);
    } as any;
    let opticalApi: any;
    Object.defineProperty(window, "PocketLiquidGlass", {
      get: () => opticalApi,
      set(api) {
        opticalApi = api;
        const create = api.create;
        api.create = (...args: any[]) => {
          const at = performance.now();
          const surface = create(...args);
          samples.opticsCreateMs = performance.now() - at;
          if (surface) {
            const draw = surface.draw;
            let submitted = false;
            surface.draw = (...args: any[]) => {
              const at = performance.now();
              const result = draw(...args);
              if (result && !submitted) { submitted = true; samples.firstOpticalDrawMs = performance.now() - at; }
              return result;
            };
          }
          return surface;
        };
      },
    });
    const tex = WebGLRenderingContext.prototype.texSubImage2D;
    WebGLRenderingContext.prototype.texSubImage2D = function (...args: any[]) {
      const source = args.at(-1);
      if (source instanceof HTMLCanvasElement) samples.uploads.push(source.width * source.height);
      const extension = this.getExtension("WEBGL_debug_renderer_info");
      if (extension) samples.gpu = String(this.getParameter(extension.UNMASKED_RENDERER_WEBGL));
      return (tex as any).apply(this, args);
    };
    function tick(time: number) { samples.raf.push(time); requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  });
  await page.goto(`http://127.0.0.1:${server.port}/api/projects/glass-profile/preview`);
  await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame()));
  await page.waitForFunction(() => (window as any).__profile.draws.length > 0);
  const coldCanvasSubmissionMs = await page.evaluate(() => (window as any).__profile.draws[0]);
  await page.waitForFunction(() => document.querySelector("canvas")?.dataset.glassRenderer === "webgl-refractive");
  const coldOptics = await page.evaluate(() => ({ createMs: (window as any).__profile.opticsCreateMs, firstDrawMs: (window as any).__profile.firstOpticalDrawMs }));
  async function tap(label: string) {
    await page.waitForFunction((label) => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "text" && op.text === label), label);
    const point = await page.evaluate((label) => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const op = frame.ops.find((op: any) => op.type === "text" && op.text === label);
      const bounds = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: (op.x + op.w / 2) * bounds.width / frame.width, y: (op.y + op.h / 2) * bounds.height / frame.height };
    }, label);
    await page.locator("canvas").click({ position: point });
  }
  await tap("Start motion");
  console.log("active schedule", JSON.stringify((await manager.status("glass-profile")).nextWakeDelayMs));
  const results = [];
  for (const mode of ["two-glass", "no-glass"] as const) {
    if (mode === "no-glass") await tap("Glass off");
    await page.waitForTimeout(500);
    await page.evaluate(() => { const p = (window as any).__profile; p.frames = []; p.draws = []; p.raf = []; p.uploads = []; });
    await page.waitForTimeout(3000);
    results.push(await page.evaluate((mode) => {
      const p = (window as any).__profile;
      const gaps = (values: number[]) => values.slice(1).map((value, index) => value - values[index]!);
      const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
      const rate = (values: number[]) => values.length > 1 ? (values.length - 1) * 1000 / (values.at(-1)! - values[0]!) : 0;
      return { mode, frames: p.frames.length, deliveredHz: rate(p.frames), frameGapP95Ms: percentile(gaps(p.frames), .95),
        canvasP50Ms: percentile(p.draws, .5), canvasP95Ms: percentile(p.draws, .95), browserRafHz: rate(p.raf),
        uploadCount: p.uploads.length, maxUploadPixels: Math.max(0, ...p.uploads), gpu: p.gpu,
        renderer: (document.querySelector("canvas") as HTMLCanvasElement).dataset.glassRenderer };
    }, mode));
  }
  await tap("Stop motion");
  await page.waitForTimeout(500);
  const settled = await page.evaluate(() => (window as any).__profile.frames.length);
  await page.waitForTimeout(250);
  const parked = await page.evaluate((before) => (window as any).__profile.frames.length === before, settled);
  console.log(JSON.stringify({ viewport: "390x844", dpr: 2, coldCanvasSubmissionMs, coldOptics, results, parked, errors }, null, 2));
  if (errors.length || !parked || results[0]!.renderer !== "webgl-refractive") throw new Error("real glass/input/parking acceptance failed");
} finally {
  await browser?.close(); server?.stop(true); await manager?.dispose();
  rmSync(project, { recursive: true, force: true });
}
