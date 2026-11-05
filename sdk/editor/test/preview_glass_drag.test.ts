import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

test("real glass drag deforms, returns, can be interrupted and parks", { timeout: 90_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-glass-drag-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "glass-drag", type: "module", private: true }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.glass-drag", entry: "app.tsx" }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, View, Text } from "@pocketjs/framework/solid/components";
import { AppleDraggableGlass, AccessibilityPreferencesProvider, createAccessibilityPreferences, MobileButton, RouteView } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
const host = createHostBridge();
function App() {
  const preferences = createAccessibilityPreferences({ bridge: host });
  const [elastic, setElastic] = createSignal(true);
  const [visible, show] = createSignal(true);
  const [routeActive, setRouteActive] = createSignal(true);
  return <AccessibilityPreferencesProvider value={preferences}><Screen class="w-full h-full relative bg-[#16304B]">
    <View class="absolute left-0 top-[240] w-[390] h-[110] bg-[#C07A55]" />
    <View class="absolute left-[160] top-[180] w-[70] h-[320] bg-[#399B82]" />
    <View class="absolute left-[16] top-[40] flex-row gap-3">
      <MobileButton label={elastic() ? "Elastic on" : "Elastic off"} onPress={() => setElastic(!elastic())} />
      <MobileButton label="Hide control" onPress={() => show(false)} />
      <MobileButton label={routeActive() ? "Route off" : "Route on"} onPress={() => setRouteActive(!routeActive())} />
    </View>
    <RouteView active={routeActive} class="absolute left-[110] top-[280] w-[120] h-[68]"><Show when={visible()}><AppleDraggableGlass class="w-full h-full" maxX={120} maxY={90} elastic={elastic()}>
      <View class="w-[12] h-[12] bg-[#00E9A9]" />
      <Text class="text-base font-bold text-[#152238]">Drag glass</Text>
    </AppleDraggableGlass></Show></RouteView>
  </Screen></AccessibilityPreferencesProvider>;
}
mount(App);
`);
    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out"), tickHz: 60 });
    manager = createPreviewManager({
      probePath: process.env.POCKET_NATIVE_PROBE ?? resolve(import.meta.dir, "../../native/target/release/pocket_probe"),
      width: 390, height: 640, rasterDensity: 2,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
    });
    server = Bun.serve({ port: 0, fetch: (request) => manager!.handle(request, "glass-drag") });
    browser = await chromium.launch({ headless: !process.env.POCKET_PROFILE_HEADED, args: process.platform === "darwin" ? ["--use-angle=metal"] : [] });
    const page = await browser.newPage({ viewport: { width: 390, height: 640 }, deviceScaleFactor: 2 });
    const errors: string[] = [];
    let nativeContactId = -1;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (!request.url().endsWith("/input")) return;
      const payload = request.postDataJSON();
      if (payload?.type === "pointer" && payload.phase === "down") nativeContactId = payload.id;
    });
    await page.addInitScript(() => {
      (window as any).__dragSamples = [];
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        if (!(window as any).__dragGpu) {
          const extension = this.getExtension("WEBGL_debug_renderer_info");
          (window as any).__dragGpu = extension ? this.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "unknown";
        }
        return draw.apply(this, args);
      };
      let submittedAt = 0;
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.id === "pocket-preview-surface") submittedAt = performance.now();
        return clear.apply(this, args);
      };
      const post = window.postMessage;
      window.postMessage = function (message: any, ...args: any[]) {
        if (message?.source === "pocket-editor-preview" && message?.type === "preview.frame") {
          const frame = message.frame;
          const surface = frame.ops.find((op: any) => op.type === "hostSurface");
          const foreground = frame.ops.find((op: any) => op.type === "rect" && (op.color >>> 0) === 0xff00e9a9);
          if (surface) (window as any).__dragSamples.push({ x: surface.x, y: surface.y, w: surface.w, h: surface.h, time: performance.now(), canvasMs: performance.now() - submittedAt, foreground });
        }
        return (post as any).call(this, message, ...args);
      } as any;
    });
    await page.goto(`http://127.0.0.1:${server.port}/api/projects/glass-drag/preview`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.glassRenderer === "webgl-refractive");
    const frameRect = async () => page.evaluate(() => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const op = frame.ops.find((op: any) => op.type === "hostSurface");
      if (!op) throw new Error("missing glass surface");
      return { x: op.x, y: op.y, w: op.w, h: op.h };
    });
    const base = await frameRect();
    const point = async (rect: typeof base) => page.evaluate(rect => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const canvas = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: canvas.x + (rect.x + rect.w / 2) * canvas.width / frame.width, y: canvas.y + (rect.y + rect.h / 2) * canvas.height / frame.height };
    }, rect);
    const tap = async (label: string) => {
      const position = await page.evaluate(label => {
        const frame = (window as any).PocketEditorPreviewInstance.getFrame();
        const op = frame.ops.find((op: any) => op.type === "text" && op.text === label);
        if (!op) throw new Error(`missing ${label}`);
        const canvas = document.querySelector("canvas")!.getBoundingClientRect();
        return { x: canvas.x + (op.x + op.w / 2) * canvas.width / frame.width, y: canvas.y + (op.y + op.h / 2) * canvas.height / frame.height };
      }, label);
      await page.mouse.click(position.x, position.y);
      await page.waitForTimeout(200);
    };
    const drag = async (dx: number, dy: number) => {
      const start = await point(await frameRect());
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(start.x + dx * step / 8, start.y + dy * step / 8);
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(60);
    };
    const before = await page.screenshot();
    await drag(96, 40);
    const dragged = await frameRect();
    assert.ok(dragged.x > base.x + 40 && dragged.y > base.y + 10, "real pointer input must move the optical surface");
    const draggingSamples = await page.evaluate(() => (window as any).__dragSamples);
    assert.ok(draggingSamples.some((sample: any) => Math.abs(sample.w - base.w) > 2 || Math.abs(sample.h - base.h) > 2), "a drag must have bounded shape deformation");
    assert.ok(draggingSamples.every((sample: any) => sample.w < base.w * 1.3 && sample.h < base.h * 1.3));
    const widthSteps = draggingSamples.slice(1).map((sample: any, index: number) => Math.abs(sample.w - draggingSamples[index].w));
    assert.ok(Math.max(...widthSteps) < base.w * 0.08, "velocity changes must ease the shape instead of popping to a new scale");
    const firstForeground = draggingSamples[0].foreground;
    const lastForeground = draggingSamples.at(-1).foreground;
    assert.ok(firstForeground && lastForeground, "native foreground marker must survive the paint transform");
    assert.ok(Math.abs((lastForeground.x - firstForeground.x) - (dragged.x - base.x)) < 15, "foreground must follow the same painted transform as the surface");
    assert.notDeepEqual(await page.screenshot(), before, "drag must change actual canvas pixels");
    await page.evaluate(() => { (window as any).__dragSamples = []; });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const release = await page.evaluate(() => (window as any).__dragSamples);
    assert.ok(release.some((sample: any) => sample.x < base.x - 0.3), "release must cross the source before settling");
    let settled = await frameRect();
    for (const key of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(settled[key] - base[key]) < 0.4, `settled ${key}`);
    assert.equal((await manager.status("glass-drag")).nextWakeDelayMs, -1, "settled spring must park");

    await drag(90, 0);
    await page.mouse.up();
    await page.waitForTimeout(5);
    const midReturn = await frameRect();
    assert.ok(midReturn.x + midReturn.w / 2 > base.x + base.w + 10, "re-grab must target outside the original layout bounds");
    const regrab = await point(midReturn);
    await page.mouse.move(regrab.x, regrab.y);
    const downResponse = page.waitForResponse(response => response.url().endsWith("/input") && response.request().postDataJSON()?.phase === "down");
    await page.mouse.down();
    await downResponse;
    await page.waitForTimeout(20);
    const grabbed = await frameRect();
    await page.waitForTimeout(50);
    const held = await frameRect();
    assert.ok(Math.abs((held.x + held.w / 2) - (grabbed.x + grabbed.w / 2)) < 0.4, `re-grabbing must freeze the current anchor while shape can settle: ${JSON.stringify({ midReturn, grabbed, held })}`);
    assert.ok(Math.abs(grabbed.x - midReturn.x) < 35, "input admission must not reset the returning glass to a new source");
    await page.mouse.move(regrab.x - 35, regrab.y + 12, { steps: 3 });
    await page.waitForTimeout(40);
    assert.ok((await frameRect()).x < grabbed.x - 15, "re-grab hit region must follow the painted surface");
    assert.ok(nativeContactId >= 0);
    await page.evaluate(async id => {
      await fetch(location.pathname + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "pointer", phase: "cancel", id, x: 0, y: 0 }) });
    }, nativeContactId);
    await page.waitForTimeout(1200);
    assert.ok(Math.abs((await frameRect()).x - base.x) < 0.4, "cancel must return to source");
    await page.mouse.up();

    await tap("Elastic on");
    await page.evaluate(() => { (window as any).__dragSamples = []; });
    await drag(80, 25);
    const rigid = await page.evaluate(() => (window as any).__dragSamples);
    assert.ok(rigid.every((sample: any) => Math.abs(sample.w - base.w) < 0.4 && Math.abs(sample.h - base.h) < 0.4), "elastic=false removes shape response while keeping drag");
    await page.mouse.up();
    await page.waitForTimeout(1200);
    await tap("Elastic off");
    await drag(70, 20);
    await page.mouse.up();
    await page.waitForTimeout(40);
    await tap("Route off");
    await page.waitForFunction(() => !(window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface"));
    for (let attempt = 0; attempt < 15 && (await manager.status("glass-drag")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-drag")).nextWakeDelayMs, -1, "cached inactive route must park its spring");
    await tap("Route on");
    assert.ok(Math.abs((await frameRect()).x - base.x) < 0.4, "retained route must return without a stale drag");
    await drag(60, 20);
    await page.mouse.up();
    await page.waitForTimeout(40);
    await page.evaluate(async () => {
      await fetch(location.pathname + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "accessibility", preferences: { reduceMotion: true, increaseContrast: false, textScale: 1, accessibleNavigation: false, reduceTransparency: null } }) });
    });
    await page.waitForTimeout(120);
    assert.ok(Math.abs((await frameRect()).x - base.x) < 0.4, "changing Reduce Motion during rebound must settle immediately");
    await page.evaluate(() => { (window as any).__dragSamples = []; });
    await drag(70, 20);
    assert.ok((await frameRect()).x > base.x + 30, "Reduce Motion retains direct manipulation");
    await page.mouse.up();
    await page.waitForTimeout(120);
    settled = await frameRect();
    assert.ok(Math.abs(settled.x - base.x) < 0.4 && Math.abs(settled.w - base.w) < 0.4, "Reduce Motion settles without a rebound");
    assert.equal((await manager.status("glass-drag")).nextWakeDelayMs, -1);
    await tap("Hide control");
    await page.waitForFunction(() => !(window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface"));
    // The ordinary Hide button's native focus-color transition may finish
    // after the component has unmounted. It must still reach an idle bound.
    for (let attempt = 0; attempt < 15 && (await manager.status("glass-drag")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-drag")).nextWakeDelayMs, -1, "unmount must clear frame demand");
    assert.deepEqual(errors, []);
    const times = release.map((sample: any) => sample.canvasMs).sort((a: number, b: number) => a - b);
    const releaseHz = (release.length - 1) * 1000 / (release.at(-1).time - release[0].time);
    console.log(JSON.stringify({ dragged, base, releaseFrames: release.length, releaseHz, canvasP95Ms: times[Math.floor(times.length * .95)], gpu: await page.evaluate(() => (window as any).__dragGpu), canvasRenderer: await page.locator("canvas").getAttribute("data-glass-renderer"), parked: true }));
  } finally {
    await browser?.close(); server?.stop(true); await manager?.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});
