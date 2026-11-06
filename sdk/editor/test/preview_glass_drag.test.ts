import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

type Rect = { x: number; y: number; w: number; h: number };
type Surface = Rect & { parameters: Record<string, any> };

test("real glass local deformation and shared Apple controls stay in place", { timeout: 120_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-glass-local-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "glass-local", type: "module", private: true }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.glass-local", entry: "app.tsx" }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import {
  AccessibilityPreferencesProvider,
  AppleDraggableGlass,
  AppleGlassButton,
  AppleGlassNavigationBar,
  AppleGlassToolbar,
  MobileButton,
  RouteView,
  createAccessibilityPreferences,
  type NavigationItem,
} from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";

const host = createHostBridge();
const tabs: readonly NavigationItem[] = [
  { id: "home", label: "Home", kind: "home" },
  { id: "gallery", label: "Gallery", kind: "gallery" },
  { id: "host", label: "Host", kind: "host" },
];

function App() {
  const preferences = createAccessibilityPreferences({ bridge: host });
  const [elastic, setElastic] = createSignal(true);
  const [visible, setVisible] = createSignal(true);
  const [routeActive, setRouteActive] = createSignal(true);
  const [active, setActive] = createSignal("home");
  const [status, setStatus] = createSignal("Ready");
  return <AccessibilityPreferencesProvider value={preferences}>
    <Screen class="relative w-full h-full bg-[#142A45]">
      <View class="absolute left-0 top-[0] w-[390] h-[640] bg-[#142A45]" />
      <View class="absolute left-[-28] top-[230] w-[230] h-[170] rounded-full bg-[#D95B4A]" style={{ opacity: 0.88, rotate: -12 }} />
      <View class="absolute right-[-24] top-[170] w-[220] h-[260] rounded-full bg-[#2CB67D]" style={{ opacity: 0.82, rotate: 14 }} />
      <View class="absolute left-[34] top-[430] w-[320] h-[130] rounded-full bg-[#2E6FE7]" style={{ opacity: 0.78, rotate: -6 }} />
      <View class="absolute left-[16] top-[18] w-[358] flex-col gap-2">
        <AppleGlassButton label="Glass button" onPress={() => setStatus("Button tapped")} />
        <AppleGlassToolbar
          title="Shared toolbar"
          subtitle="One material, real child action"
          actions={() => <AppleGlassButton label="Toolbar action" onPress={() => setStatus("Toolbar tapped")} />}
        />
        <Text class="text-xs font-bold text-[#D8E7FF]">Status: {status()}</Text>
        <Text class="text-xs font-bold text-[#D8E7FF]">Active: {active()}</Text>
      </View>
      <RouteView active={routeActive} class="absolute left-[112] top-[232] w-[166] h-[72]">
        <Show when={visible()}>
          <AppleDraggableGlass class="w-[166] h-[72] flex-col items-center justify-center" material="clear" maxX={96} maxY={72} elastic={elastic()}>
            <Text class="text-sm font-bold text-[#F8FAFC]">Pull anchor</Text>
          </AppleDraggableGlass>
        </Show>
      </RouteView>
      <View class="absolute left-[16] top-[332] flex-row gap-2">
        <MobileButton label={elastic() ? "Disable elastic" : "Enable elastic"} compact onPress={() => setElastic(!elastic())} />
        <MobileButton label={visible() ? "Hide glass" : "Show glass"} compact onPress={() => setVisible(!visible())} />
        <MobileButton label={routeActive() ? "Route off" : "Route on"} compact onPress={() => setRouteActive(!routeActive())} />
      </View>
      <View class="absolute left-0 right-0 bottom-0">
        <AppleGlassNavigationBar items={tabs} active={active()} onChange={(id) => { setActive(id); setStatus(id + " selected"); }} />
      </View>
    </Screen>
  </AccessibilityPreferencesProvider>;
}
mount(App);
`);
    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out"), tickHz: 60 });
    manager = createPreviewManager({
      probePath: process.env.POCKET_NATIVE_PROBE ?? resolve(import.meta.dir, "../../native/target/release/pocket_probe"),
      width: 390, height: 640, rasterDensity: 2,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
    });
    server = Bun.serve({ port: 0, fetch: (request) => manager!.handle(request, "glass-local") });
    browser = await chromium.launch({
      headless: !process.env.POCKET_PROFILE_HEADED,
      args: process.platform === "darwin" ? ["--use-angle=metal"] : [],
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 640 }, deviceScaleFactor: 2 });
    const errors: string[] = [];
    const warnings: string[] = [];
    const inputEvents: any[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
    page.on("request", request => {
      if (request.url().endsWith("/input")) inputEvents.push(request.postDataJSON());
    });
    await page.addInitScript(() => {
      (window as any).__glassFrames = [];
      (window as any).__glassGpu = "unknown";
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        if ((window as any).__glassGpu === "unknown") {
          const extension = this.getExtension("WEBGL_debug_renderer_info");
          (window as any).__glassGpu = extension ? this.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "unknown";
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
          const surfaces = frame.ops.filter((op: any) => op.type === "hostSurface").map((op: any) => {
            let parameters: Record<string, any> = {};
            try { parameters = JSON.parse(op.asset).parameters ?? {}; } catch { /* diagnostic only */ }
            return { x: op.x, y: op.y, w: op.w, h: op.h, parameters };
          });
          (window as any).__glassFrames.push({ frame: frame.frame, surfaces, canvasMs: performance.now() - submittedAt, time: performance.now() });
          if ((window as any).__glassFrames.length > 500) (window as any).__glassFrames.shift();
        }
        return (post as any).call(this, message, ...args);
      } as any;
    });
    await page.goto(`http://127.0.0.1:${server.port}/api/projects/glass-local/preview`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.glassRenderer === "webgl-refractive");

    const currentFrame = async (): Promise<any> => page.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame());
    const parseSurfaces = (frame: any): Surface[] => frame.ops.filter((op: any) => op.type === "hostSurface").map((op: any) => {
      let parameters: Record<string, any> = {};
      try { parameters = JSON.parse(op.asset).parameters ?? {}; } catch { /* assertion below handles absent material */ }
      // `opticalInset` belongs to the expanded paint quad, not the shell or
      // hit target. Normalize frame geometry back to the shell so local
      // deformation assertions compare the stable layout rect. The renderer
      // keeps the inset in its SDF while allowing the paint halo to extend
      // outside this logical rect.
      const inset = Math.max(0, Number(parameters.opticalInset ?? 0));
      return { x: op.x + inset, y: op.y + inset, w: Math.max(0, op.w - inset * 2), h: Math.max(0, op.h - inset * 2), parameters };
    });
    const surfaces = async (): Promise<Surface[]> => parseSurfaces(await currentFrame());
    const textRect = async (label: string): Promise<Rect> => page.evaluate((label) => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const op = frame.ops.find((item: any) => item.type === "text" && item.text === label);
      if (!op) throw new Error(`missing text ${label}`);
      return { x: op.x, y: op.y, w: op.w, h: op.h };
    }, label);
    const canvasPoint = async (rect: Rect): Promise<{ x: number; y: number }> => page.evaluate((rect) => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const canvas = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: canvas.x + (rect.x + rect.w / 2) * canvas.width / frame.width, y: canvas.y + (rect.y + rect.h / 2) * canvas.height / frame.height };
    }, rect);
    const tap = async (label: string): Promise<void> => {
      const point = await canvasPoint(await textRect(label));
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(260);
    };
    const frameTargetSurface = async (): Promise<Surface> => {
      const target = (await surfaces()).filter(surface => surface.y > 190 && surface.y < 310 && surface.w > 130 && surface.w < 200);
      if (!target[0]) throw new Error(`missing target surface: ${JSON.stringify(await surfaces())}`);
      return target[0];
    };
    const frameNavLens = async (): Promise<Surface> => {
      const nav = (await surfaces()).filter(surface => surface.y > 500 && surface.w < 200 && surface.parameters.material === "clear");
      if (!nav[0]) throw new Error(`missing navigation lens: ${JSON.stringify(await surfaces())}`);
      return nav[0];
    };
    const capturePixels = async (): Promise<{ width: number; height: number; samples: number[] }> => page.evaluate(() => {
      const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const stride = 4;
      (window as any).__sampling = true;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      (window as any).__sampling = false;
      const samples: number[] = [];
      for (let y = 0; y < canvas.height; y += stride) for (let x = 0; x < canvas.width; x += stride) {
        const index = (y * canvas.width + x) * 4;
        samples.push(x, y, data[index]!, data[index + 1]!, data[index + 2]!);
      }
      return { width: canvas.width, height: canvas.height, samples };
    });
    const comparePixels = (
      base: { width: number; height: number; samples: number[] },
      next: { width: number; height: number; samples: number[] },
      target: Surface,
      anchorX: number,
      anchorY: number,
    ) => {
      let local = 0, shoulder = 0, remote = 0;
      const remotePoints: number[][] = [];
      const scale = base.width / 390;
      const halo = 20 * scale;
      const radius = 64 * scale;
      for (let i = 0; i < base.samples.length; i += 5) {
        const x = base.samples[i]!, y = base.samples[i + 1]!;
        const delta = Math.abs(base.samples[i + 2]! - next.samples[i + 2]!) + Math.abs(base.samples[i + 3]! - next.samples[i + 3]!) + Math.abs(base.samples[i + 4]! - next.samples[i + 4]!);
        // A browser frame can differ by a few quantization units when its
        // backdrop texture is refreshed; count only visible deformation.
        if (delta <= 16) continue;
        const logicalX = x / scale, logicalY = y / scale;
        const distance = Math.hypot(logicalX - anchorX, logicalY - anchorY);
        if (distance < radius) local++;
        if (logicalX > target.x + target.w && logicalX < target.x + target.w + halo && Math.abs(logicalY - anchorY) < target.h / 2) shoulder++;
        const inSurfaceHalo = logicalX >= target.x - halo && logicalX <= target.x + target.w + halo && logicalY >= target.y - halo && logicalY <= target.y + target.h + halo;
        if (distance >= radius && !inSurfaceHalo) {
          remote++;
          if (remotePoints.length < 8) remotePoints.push([logicalX, logicalY, delta]);
        }
      }
      return { local, shoulder, remote, remotePoints };
    };

    const initialSurfaces = await surfaces();
    assert.ok(initialSurfaces.length >= 5, `button, toolbar, target, nav background and nav lens must all paint: ${initialSurfaces.length}`);
    assert.equal(initialSurfaces.filter(surface => surface.y > 500 && surface.w < 200 && surface.parameters.material === "clear").length, 1, "navigation selection adds one front glass lens");
    assert.ok(initialSurfaces.some(surface => surface.y > 500 && surface.w > 300 && surface.parameters.material === "clear"), "navigation keeps a shared transparent background");

    // Let the initial accessibility snapshot and first frame delivery settle
    // before the first admitted pointer contact.
    await page.waitForTimeout(260);
    await tap("Glass button");
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "text" && String(op.text).includes("Status: Button tapped")), undefined, { timeout: 1000 });
    const buttonFrame = await currentFrame();
    assert.ok(buttonFrame.ops.some((op: any) => op.type === "text" && String(op.text).includes("Status: Button tapped")), "standalone AppleGlassButton must receive real input");
    const beforeToolbarSurfaces = (await surfaces()).length;
    await tap("Toolbar action");
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "text" && String(op.text).includes("Status: Toolbar tapped")), undefined, { timeout: 1000 });
    const toolbarFrame = await currentFrame();
    assert.ok(toolbarFrame.ops.some((op: any) => op.type === "text" && String(op.text).includes("Status: Toolbar tapped")), `toolbar AppleGlassButton must receive real input: ${toolbarFrame.ops.filter((op: any) => op.type === "text").map((op: any) => op.text).join("|")}`);
    assert.equal((await surfaces()).length, beforeToolbarSurfaces, "toolbar action must reuse its parent's one material");

    const base = await frameTargetSurface();
    const baseLabel = await textRect("Pull anchor");
    const basePixels = await capturePixels();
    const startLogical = { x: base.x + base.w - 10, y: base.y + base.h / 2 };
    const start = await canvasPoint({ x: startLogical.x, y: startLogical.y, w: 0, h: 0 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Keep the contact inside the preview viewport while holding it. A short
    // edge pull is enough to exercise the local field without depending on a
    // browser pointer-capture edge transition.
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(start.x + 28 * step / 4, start.y + 4 * step / 4);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(60);
    const pulled = await frameTargetSurface();
    const pulledLabel = await textRect("Pull anchor");
    const pulledPixels = await capturePixels();
    const pulledDeformation = pulled.parameters.deformation ?? {};
    assert.deepEqual({ x: pulled.x, y: pulled.y, w: pulled.w, h: pulled.h }, { x: base.x, y: base.y, w: base.w, h: base.h }, "local deformation must keep the layout quad fixed");
    assert.deepEqual(pulledLabel, baseLabel, "local deformation must keep the label rect fixed");
    assert.ok(Math.abs(Number(pulledDeformation.offsetX ?? 0)) > 0.1 || Math.abs(Number(pulledDeformation.offsetY ?? 0)) > 0.1, `real input must update local deformation: ${JSON.stringify({ deformation: pulledDeformation, base, startLogical, input: inputEvents.slice(-16) })}`);
    const pullPixels = comparePixels(basePixels, pulledPixels, base, startLogical.x, startLogical.y);
    assert.ok(pullPixels.local > 20, `local deformation must alter pixels near the touched anchor: ${JSON.stringify(pullPixels)}`);
    assert.equal(pullPixels.remote, 0, `remote backdrop pixels must remain unchanged: ${JSON.stringify(pullPixels)}`);
    const held1 = await frameTargetSurface();
    await page.waitForTimeout(320);
    const held2 = await frameTargetSurface();
    assert.ok(Math.abs(Number(held2.parameters.deformation?.offsetX ?? 0) - Number(held1.parameters.deformation?.offsetX ?? 0)) < 0.4, "held local deformation must settle without drifting");
    await page.mouse.up();
    await page.waitForTimeout(55);
    const returning = await frameTargetSurface();
    assert.ok(Math.abs(Number(returning.parameters.deformation?.offsetX ?? 0)) > 0.1 || Math.abs(Number(returning.parameters.deformation?.offsetY ?? 0)) > 0.1, "release must start a local spring from the pulled field");
    await page.waitForTimeout(1000);
    const restored = await frameTargetSurface();
    const restoredPixels = await capturePixels();
    assert.ok(Math.abs(Number(restored.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(restored.parameters.deformation?.offsetY ?? 0)) < 0.05, `local deformation must restore to zero: ${JSON.stringify(restored.parameters.deformation)}`);
    const restoredDiff = comparePixels(basePixels, restoredPixels, base, startLogical.x, startLogical.y);
    assert.equal(restoredDiff.local, 0, `restored pixels must match the base frame: ${JSON.stringify(restoredDiff)}`);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "settled local spring must park");

    await tap("Disable elastic");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y, { steps: 5 });
    await page.waitForTimeout(100);
    const rigid = await frameTargetSurface();
    assert.ok(Math.abs(Number(rigid.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(rigid.parameters.deformation?.offsetY ?? 0)) < 0.05, "elastic=false must disable local deformation");
    await page.mouse.up();
    await page.waitForTimeout(250);
    await tap("Enable elastic");

    await page.evaluate(async () => {
      await fetch(location.pathname + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "accessibility", preferences: { reduceMotion: true, increaseContrast: false, textScale: 1, accessibleNavigation: false, reduceTransparency: null } }) });
    });
    await page.waitForTimeout(140);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y, { steps: 5 });
    await page.waitForTimeout(100);
    const reduced = await frameTargetSurface();
    assert.ok(Math.abs(Number(reduced.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(reduced.parameters.deformation?.offsetY ?? 0)) < 0.05, "Reduce Motion must disable local deformation");
    await page.mouse.up();
    await page.waitForTimeout(150);

    await tap("Route off");
    await page.waitForFunction(() => !(window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface" && op.y > 190 && op.y < 310));
    for (let attempt = 0; attempt < 20 && (await manager.status("glass-local")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "inactive route must clear local frame demand");
    await tap("Route on");
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface" && op.y > 190 && op.y < 310));
    const routeRestored = await frameTargetSurface();
    assert.ok(Math.abs(Number(routeRestored.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(routeRestored.parameters.deformation?.offsetY ?? 0)) < 0.05, "route re-entry must not restore stale deformation");
    await page.evaluate(async () => {
      await fetch(location.pathname + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "accessibility", preferences: { reduceMotion: false, increaseContrast: false, textScale: 1, accessibleNavigation: false, reduceTransparency: null } }) });
    });
    await page.waitForTimeout(120);

    const home = await textRect("Home");
    const navigationBackdrop = (await surfaces()).find(surface => surface.y > 500 && surface.w > 300);
    assert.ok(navigationBackdrop, "the shared navigation backdrop must be present");
    assert.equal(navigationBackdrop.parameters.material, "clear", "navigation defaults to the transparent shared optical material");
    assert.equal(navigationBackdrop.parameters.blur, 0, "clear navigation must not introduce a frosted sampling lattice");
    assert.equal(navigationBackdrop.parameters.materialStrength, 0, "clear navigation must preserve the center backdrop without a neutral wash");
    const gallery = await textRect("Gallery");
    const homePoint = await canvasPoint(home);
    const galleryPoint = await canvasPoint(gallery);
    await page.mouse.move(homePoint.x, homePoint.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(homePoint.x + (galleryPoint.x - homePoint.x) * step / 8, homePoint.y + 4 * step / 8);
      await page.waitForTimeout(18);
    }
    await page.waitForTimeout(55);
    const navHeld = await frameNavLens();
    assert.ok(Number(navHeld.parameters.magnification ?? 1) > 1.01, `navigation lens must magnify while held: ${JSON.stringify({ parameters: navHeld.parameters, input: inputEvents.slice(-12) })}`);
    assert.ok(Math.abs(Number(navHeld.parameters.deformation?.offsetX ?? 0)) > 0.1 || Math.abs(Number(navHeld.parameters.deformation?.offsetY ?? 0)) > 0.1, `navigation lens must carry local deformation while dragged: ${JSON.stringify(navHeld.parameters)}`);
    await page.mouse.up();
    await page.waitForTimeout(450);
    assert.ok((await currentFrame()).ops.some((op: any) => op.type === "text" && op.text === "Active: gallery"), "navigation drag must select the nearest tab on release");
    const navRestored = await frameNavLens();
    assert.ok(Math.abs(Number(navRestored.parameters.magnification ?? 1) - 1) < 0.02, `navigation lens magnification must reset after release: ${JSON.stringify(navRestored.parameters)}`);
    assert.ok(Math.abs(Number(navRestored.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(navRestored.parameters.deformation?.offsetY ?? 0)) < 0.05, `navigation lens deformation must reset after release: ${JSON.stringify(navRestored.parameters)}`);
    for (let attempt = 0; attempt < 40 && (await manager.status("glass-local")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "navigation release must park the preview after its spring settles");

    const frames = await page.evaluate(() => (window as any).__glassFrames as Array<{ canvasMs: number; time: number; surfaces?: Surface[] }>);
    const percentile = (values: number[], fraction: number): number => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * fraction))]! : 0;
    const canvasTimes = frames.map(frame => frame.canvasMs).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    const frameGaps = frames.slice(1).map((frame, index) => frame.time - frames[index]!.time).filter(value => value > 0 && value < 100).sort((a, b) => a - b);
    const previewFrameHz = frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1)!.time - frames[0]!.time) : 0;
    const surfaceCounts = frames.map(frame => frame.surfaces?.length ?? 0);
    console.log(JSON.stringify({
      base, pulled, returning, restored, localFrames: frames.length,
      previewFrameHz,
      activeFrameGapP50Ms: percentile(frameGaps, .5),
      activeFrameGapP95Ms: percentile(frameGaps, .95),
      canvasP50Ms: percentile(canvasTimes, .5),
      canvasP95Ms: percentile(canvasTimes, .95),
      surfaceCountMin: surfaceCounts.length ? Math.min(...surfaceCounts) : 0,
      surfaceCountMax: surfaceCounts.length ? Math.max(...surfaceCounts) : 0,
      gpu: await page.evaluate(() => (window as any).__glassGpu),
      canvasRenderer: await page.locator("canvas").getAttribute("data-glass-renderer"),
      parked: (await manager.status("glass-local")).nextWakeDelayMs === -1,
    }));
    assert.deepEqual(errors, [], warnings.join("; "));
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});
