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

test("clear Apple controls stay rigid while bottom navigation retains drag feedback", { timeout: 120_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-glass-local-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "glass-local", type: "module", private: true }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.glass-local", entry: "app.tsx" }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
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
        <AppleGlassButton label="Glass button" selected onPress={() => setStatus("Button tapped")} />
        <AppleGlassToolbar
          title="Shared toolbar"
          subtitle="One material, real child action"
          actions={() => <AppleGlassButton label="Toolbar action" onPress={() => setStatus("Toolbar tapped")} />}
        />
        <Text class="text-xs font-bold text-[#D8E7FF]">Status: {status()}</Text>
        <Text class="text-xs font-bold text-[#D8E7FF]">Active: {active()}</Text>
      </View>
      <RouteView active={routeActive} class="absolute left-[112] top-[232] w-[166] h-[72]">
        <AppleDraggableGlass class="w-[166] h-[72] flex-col items-center justify-center">
          <Text class="text-sm font-bold text-[#F8FAFC]">Pull anchor</Text>
        </AppleDraggableGlass>
      </RouteView>
      <View class="absolute left-[16] top-[332] flex-row gap-2">
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
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
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
    const pixelDifference = (
      base: { width: number; height: number; samples: number[] },
      next: { width: number; height: number; samples: number[] },
    ) => {
      let visible = 0;
      let maximum = 0;
      for (let i = 0; i < base.samples.length; i += 5) {
        const delta = Math.abs(base.samples[i + 2]! - next.samples[i + 2]!) + Math.abs(base.samples[i + 3]! - next.samples[i + 3]!) + Math.abs(base.samples[i + 4]! - next.samples[i + 4]!);
        maximum = Math.max(maximum, delta);
        if (delta > 16) visible++;
      }
      return { visible, maximum };
    };

    const initialSurfaces = await surfaces();
    assert.ok(initialSurfaces.length >= 5, `button, toolbar, target, nav background and nav lens must all paint: ${initialSurfaces.length}`);
    for (const surface of initialSurfaces) {
      assert.equal(surface.parameters.material, "clear", "all Apple controls default to the shared clear material");
      assert.equal(surface.parameters.blur, 0, "Apple controls must preserve backdrop detail without frost");
      assert.equal(surface.parameters.materialStrength, 0, "including selected standalone buttons must not add a material fill");
    }
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
    const basePixels = await capturePixels();
    const start = await canvasPoint({ x: base.x + base.w / 2, y: base.y + base.h / 2, w: 0, h: 0 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y, { steps: 5 });
    await page.waitForTimeout(100);
    const stable = await frameTargetSurface();
    const stablePixels = await capturePixels();
    assert.deepEqual({ x: stable.x, y: stable.y, w: stable.w, h: stable.h }, { x: base.x, y: base.y, w: base.w, h: base.h }, "ordinary Apple glass must keep its layout quad fixed");
    assert.equal(Number(stable.parameters.magnification ?? 1), 1, "ordinary Apple glass must not magnify on drag");
    assert.ok(Math.abs(Number(stable.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(stable.parameters.deformation?.offsetY ?? 0)) < 0.05, "ordinary Apple glass must not deform on drag");
    assert.deepEqual(pixelDifference(basePixels, stablePixels), { visible: 0, maximum: 0 }, "ordinary Apple glass pixels must remain unchanged during drag");
    await page.mouse.up();
    await page.waitForTimeout(120);

    await tap("Route off");
    await page.waitForFunction(() => !(window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface" && op.y > 190 && op.y < 310));
    for (let attempt = 0; attempt < 20 && (await manager.status("glass-local")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "inactive route must clear local frame demand");
    await tap("Route on");
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "hostSurface" && op.y > 190 && op.y < 310));
    const routeRestored = await frameTargetSurface();
    assert.equal(Number(routeRestored.parameters.magnification ?? 1), 1, "route re-entry must not restore stale magnification");
    assert.ok(Math.abs(Number(routeRestored.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(routeRestored.parameters.deformation?.offsetY ?? 0)) < 0.05, "route re-entry must not restore stale deformation");

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
    assert.ok(Number(navHeld.parameters.magnification ?? 1) > 1.01, `navigation lens must magnify while held: ${JSON.stringify(navHeld.parameters)}`);
    assert.ok(Math.abs(Number(navHeld.parameters.deformation?.offsetX ?? 0)) > 0.1 || Math.abs(Number(navHeld.parameters.deformation?.offsetY ?? 0)) > 0.1, `navigation lens must carry local deformation while dragged: ${JSON.stringify(navHeld.parameters)}`);
    await page.mouse.up();
    await page.waitForTimeout(450);
    assert.ok((await currentFrame()).ops.some((op: any) => op.type === "text" && op.text === "Active: gallery"), "navigation drag must select the nearest tab on release");
    const navRestored = await frameNavLens();
    assert.ok(Math.abs(Number(navRestored.parameters.magnification ?? 1) - 1) < 0.02, `navigation lens magnification must reset after release: ${JSON.stringify(navRestored.parameters)}`);
    assert.ok(Math.abs(Number(navRestored.parameters.deformation?.offsetX ?? 0)) < 0.05 && Math.abs(Number(navRestored.parameters.deformation?.offsetY ?? 0)) < 0.05, `navigation lens deformation must reset after release: ${JSON.stringify(navRestored.parameters)}`);
    for (let attempt = 0; attempt < 40 && (await manager.status("glass-local")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "navigation release must park the preview after its spring settles");
    await tap("Home");
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "text" && op.text === "Active: home"));
    for (let attempt = 0; attempt < 20 && (await manager.status("glass-local")).nextWakeDelayMs !== -1; attempt++) await page.waitForTimeout(50);
    assert.equal((await manager.status("glass-local")).nextWakeDelayMs, -1, "navigation click must park the preview when idle");
    assert.deepEqual(errors, [], warnings.join("; "));
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});
