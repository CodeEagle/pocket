import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const clientSource = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
const sdkRoot = resolve(import.meta.dir, "../..");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? [
  join(sdkRoot, "native/target/debug/pocket_probe"),
  join(sdkRoot, "native/target/release/pocket_probe"),
].find(existsSync);

test("browser preview projects native glass as real backdrop blur beneath the scrim and panel", { timeout: 30_000 }, async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/preview.js") {
        return new Response(clientSource, { headers: { "content-type": "application/javascript" } });
      }
      return new Response(
        "<div data-pocket-preview data-project-id=glass-test></div><script src=/preview.js></script>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      class FakeEventSource {
        static instances: FakeEventSource[] = [];
        onmessage?: (event: { data: string }) => void;
        readyState = 1;
        constructor(public readonly url: string) {
          FakeEventSource.instances.push(this);
        }
        close(): void {
          this.readyState = 2;
        }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> }).instances[0];
      if (!source) throw new Error("preview must create one SSE source");
      const frame = {
        frame: 1,
        width: 100,
        height: 100,
        ops: [
          { type: "rect", x: 0, y: 0, w: 50, h: 100, color: 0xffff0000 },
          { type: "rect", x: 50, y: 0, w: 50, h: 100, color: 0xff0000ff },
          {
            type: "hostSurface",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            clip: { x: 0, y: 0, w: 100, h: 100 },
            // A plain backdrop blur must remain colorless even if an older
            // recipe accidentally leaves a tint value in its payload.
            asset: JSON.stringify({ kind: "glass", parameters: { effect: "blur", blur: 8, tintOpacity: 0.8, opacity: 0.5 } }),
          },
          // The native Modal scrim follows the glass op and must remain a
          // black translucent layer rather than being replaced by the blur.
          { type: "rect", x: 0, y: 0, w: 100, h: 100, color: 0x66000000 },
          { type: "rect", x: 20, y: 20, w: 60, h: 60, color: 0xffffffff },
        ],
        events: [],
        resources: [],
      };
      source.onmessage?.({ data: JSON.stringify({ type: "frame", frame }) });
    });
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()));
    const sample = await page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const read = (x: number, y: number): number[] => Array.from(context.getImageData(x, y, 1, 1).data);
      return {
        farRed: read(10, 50),
        boundaryLeft: read(49, 50),
        boundaryRight: read(50, 50),
        panel: read(30, 30),
        status: (document.querySelector("[data-preview-status]") as HTMLElement)?.textContent ?? "",
      };
    });
    const postFrame = async (next: Record<string, unknown>): Promise<void> => {
      const frameNumber = Number(next.frame);
      await page.evaluate((frame) => {
        const source = ((window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> }).instances[0];
        if (!source) throw new Error("preview must create one SSE source");
        source.onmessage?.({ data: JSON.stringify({ type: "frame", frame }) });
      }, next);
      await page.waitForFunction((expected) => Number((window as any).PocketEditorPreviewInstance?.getFrame?.()?.frame) === expected, frameNumber);
    };
    const readPixels = async (): Promise<{ farRed: number[]; boundaryLeft: number[]; boundaryRight: number[]; panel: number[] }> => page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const read = (x: number, y: number): number[] => Array.from(context.getImageData(x, y, 1, 1).data);
      return { farRed: read(10, 50), boundaryLeft: read(49, 50), boundaryRight: read(50, 50), panel: read(30, 30) };
    });
    const nextSyntheticFrame = (frame: number, opacity: number, includeLayers: boolean): Record<string, unknown> => ({
      frame,
      width: 100,
      height: 100,
      ops: [
        { type: "rect", x: 0, y: 0, w: 50, h: 100, color: 0xffff0000 },
        { type: "rect", x: 50, y: 0, w: 50, h: 100, color: 0xff0000ff },
        {
          type: "hostSurface",
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          clip: { x: 0, y: 0, w: 100, h: 100 },
          asset: JSON.stringify({ kind: "glass", parameters: { effect: "blur", blur: 8, tintOpacity: 0.8, opacity } }),
        },
        ...(includeLayers
          ? [
              { type: "rect", x: 0, y: 0, w: 100, h: 100, color: 0x66000000 },
              { type: "rect", x: 20, y: 20, w: 60, h: 60, color: 0xffffffff },
            ]
          : []),
      ],
      events: [],
      resources: [],
    });
    await postFrame(nextSyntheticFrame(2, 0, false));
    const sharp = await readPixels();
    assert.ok(sharp.boundaryLeft[0] > 220 && sharp.boundaryLeft[2] < 16, `opacity=0 must leave the sharp red side: ${JSON.stringify(sharp)}`);
    assert.ok(sharp.boundaryRight[2] > 220 && sharp.boundaryRight[0] < 16, `opacity=0 must leave the sharp blue side: ${JSON.stringify(sharp)}`);
    await postFrame(nextSyntheticFrame(3, 1, true));
    const full = await readPixels();
    // Away from the colour boundary, the alpha-0x66 black scrim still dims
    // red instead of being replaced by an opaque/fabricated blur layer.
    assert.ok(sample.farRed[0] >= 140 && sample.farRed[0] <= 170, `scrim alpha changed: ${JSON.stringify(sample)}`);
    assert.ok(sample.farRed[1] < 16 && sample.farRed[2] < 16, `plain blur added an unexpected tint: ${JSON.stringify(sample)}`);
    // A real blur mixes both sides at the sharp boundary. A solid overlay or
    // a no-op hostSurface branch would leave one channel at zero on each side.
    assert.ok(sample.boundaryLeft[0] > 0 && sample.boundaryLeft[2] > 0, `left blur sample is not mixed: ${JSON.stringify(sample)}`);
    assert.ok(sample.boundaryRight[0] > 0 && sample.boundaryRight[2] > 0, `right blur sample is not mixed: ${JSON.stringify(sample)}`);
    assert.ok(sample.panel[0] >= 250 && sample.panel[1] >= 250 && sample.panel[2] >= 250, `panel did not paint above scrim/glass: ${JSON.stringify(sample)}`);
    assert.ok(full.boundaryLeft[0] > 0 && full.boundaryLeft[2] > 0, `full blur must mix both colours: ${JSON.stringify(full)}`);
    assert.ok(full.boundaryRight[0] > 0 && full.boundaryRight[2] > 0, `full blur must mix both colours: ${JSON.stringify(full)}`);
    assert.ok(full.panel[0] >= 250 && full.panel[1] >= 250 && full.panel[2] >= 250, `full-opacity panel did not paint above blur: ${JSON.stringify(full)}`);
    assert.doesNotMatch(sample.status, /native surface op\(s\) unavailable/);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
test("real preview wakes a Show-mounted MobileDialog after a true idle without a permanent onFrame", { timeout: 90_000 }, async () => {
  assert.ok(nativeProbe && existsSync(nativeProbe), "a pinned pocket_probe is required for idle modal browser acceptance");
  const projectRoot = mkdtempSync(join(tmpdir(), "pocket-editor-idle-modal-browser-project-"));
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-idle-modal-browser-build-"));
  const projectId = "modal-glass-idle-wake";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // This fixture intentionally has no permanent onFrame hook. The dialog is
    // mounted only after the real pointer-up, so its transition demand must
    // wake the preview after the native scheduler has reached idle.
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: projectId, private: true, type: "module" }));
    writeFileSync(join(projectRoot, "pocket.json"), JSON.stringify({ appId: `pocket.test.${projectId}`, entry: "app.tsx" }));
    writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(projectRoot, "app.tsx"), `
import { createSignal, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, View } from "@pocketjs/framework/solid/components";
import { MobileButton, MobileDialog, MobileThemeProvider } from "@pocket/ui";

function App() {
  const [open, setOpen] = createSignal(false);
  return (
    <Screen class="w-full h-full flex-col">
      <View class="flex-1 w-full items-center justify-center">
        <MobileThemeProvider>
          <MobileButton label="Open modal" onPress={() => setOpen(true)} />
          <Show when={open()}>
            <MobileDialog open={true} title="Idle modal" body="This dialog is mounted only after pointer-up." onClose={() => setOpen(false)} />
          </Show>
        </MobileThemeProvider>
      </View>
    </Screen>
  );
}

mount(App);
`);
    const built = await buildGuest({ projectRoot, outDir: output, tickHz: 60 });
    manager = createPreviewManager({
      probePath: nativeProbe,
      width: 390,
      height: 640,
      idleDisposeMs: 30_000,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
    });
    const prefix = `/api/projects/${projectId}/preview`;
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        const endpoint = pathname.endsWith("/stream") ? "stream" : pathname.endsWith("/input") ? "input" : "page";
        return manager!.handle(request, projectId, endpoint);
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__idleModalTrace = { frames: [], pointerUps: [] };
      window.addEventListener("message", (event) => {
        const packet = event.data;
        if (packet?.source !== "pocket-editor-preview" || packet?.type !== "preview.frame" || !packet.frame) return;
        const glass = (packet.frame.ops ?? []).find((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
        let opacity: number | null = null;
        if (glass) {
          try { opacity = Number(JSON.parse(String(glass.asset)).parameters?.opacity); } catch { opacity = null; }
        }
        (window as any).__idleModalTrace.frames.push({ frame: Number(packet.frame.frame), at: performance.now(), opacity, hasGlass: glass !== undefined });
      });
      document.addEventListener("pointerup", (event) => {
        if ((event.target as HTMLElement | null)?.tagName !== "CANVAS") return;
        const trace = (window as any).__idleModalTrace;
        trace.pointerUps.push({ at: performance.now(), frame: trace.frames.at(-1)?.frame ?? null });
      }, true);
    });
    const pageErrors: string[] = [];
    const inputErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) inputErrors.push(`${response.status()} ${response.url()}`);
    });
    const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}`);
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });

    const readTrace = async (): Promise<any> => page.evaluate(() => {
      const trace = (window as any).__idleModalTrace;
      return {
        frames: trace.frames.map((entry: any) => ({ frame: entry.frame, at: entry.at, opacity: entry.opacity, hasGlass: entry.hasGlass })),
        pointerUps: trace.pointerUps.slice(),
      };
    });
    const readFrame = async (): Promise<any> => page.evaluate(() => (window as any).PocketEditorPreviewInstance?.getFrame?.());
    const textPoint = async (text: string): Promise<{ x: number; y: number }> => {
      const point = await page.evaluate((label) => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        const op = frame?.ops?.find((candidate: any) => candidate?.type === "text" && candidate?.text === label);
        return op ? { x: Number(op.x) + Number(op.w ?? 0) / 2, y: Number(op.y) + Number(op.h ?? 0) / 2 } : null;
      }, text);
      assert.ok(point, `idle fixture frame is missing ${text}`);
      return point!;
    };
    const clickLogical = async (point: { x: number; y: number }): Promise<void> => {
      const frame = await readFrame();
      const box = await page.locator("canvas").boundingBox();
      assert.ok(frame && box, "idle fixture canvas must remain available");
      await page.mouse.click(box!.x + point.x * box!.width / Number(frame.width), box!.y + point.y * box!.height / Number(frame.height));
    };
    const waitForStableIdle = async (label: string): Promise<{ frame: number; frameCount: number }> => {
      // The fixture has no onFrame hook before/after the dialog. Two samples
      // separated by 220ms prove the native demand scheduler really idled.
      await page.waitForTimeout(700);
      const before = await readTrace();
      await page.waitForTimeout(220);
      const after = await readTrace();
      const beforeLast = before.frames.at(-1);
      const afterLast = after.frames.at(-1);
      assert.ok(beforeLast && afterLast, `${label} must have emitted an initial frame before idle`);
      assert.equal(afterLast.frame, beforeLast.frame, `${label} negative control: idle guest emitted a frame after 700ms: ${JSON.stringify({ beforeLast, afterLast })}`);
      assert.equal(after.frames.length, before.frames.length, `${label} negative control: idle guest kept publishing frames: ${JSON.stringify({ before: before.frames.length, after: after.frames.length })}`);
      return { frame: Number(afterLast.frame), frameCount: after.frames.length };
    };
    const waitForFirstNonzero = async (pointerIndex: number, baselineFrame: number): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const trace = await readTrace();
        const pointer = trace.pointerUps[pointerIndex];
        if (pointer) {
          for (const entry of trace.frames) {
            if (entry.at < pointer.at) continue;
            const opacity = typeof entry.opacity === "number" ? entry.opacity : undefined;
            if (opacity !== undefined && opacity > 0) {
              const samples = trace.frames
                .filter((candidate: any) => candidate.at >= pointer.at)
                .slice(0, 12)
                .map((candidate: any) => ({
                  frame: Number(candidate.frame),
                  deltaMs: Number(candidate.at) - Number(pointer.at),
                  opacity: candidate.opacity,
                  hasGlass: candidate.hasGlass,
                }));
              return {
                pointerUpMs: Number(pointer.at),
                firstOpacityAtMs: Number(entry.at),
                firstOpacityDelayMs: Number(entry.at) - Number(pointer.at),
                firstNonzeroOpacity: opacity,
                pointerFrame: Number(pointer.frame ?? baselineFrame),
                firstFrame: Number(entry.frame),
                frameDelta: Number(entry.frame) - Number(pointer.frame ?? baselineFrame),
                frameSamples: samples,
              };
            }
          }
        }
        await Bun.sleep(10);
      }
      throw new Error(`timed out waiting for ${pointerIndex === 0 ? "cold" : "repeat"} first nonzero dialog opacity`);
    };
    const waitForSettledAndClose = async (): Promise<void> => {
      await page.waitForFunction(() => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        const op = frame?.ops?.find((candidate: any) => candidate?.type === "hostSurface" && String(candidate.asset ?? "").includes('"kind":"glass"'));
        if (!op) return false;
        try { return Number(JSON.parse(String(op.asset)).parameters?.opacity) >= 0.99; } catch { return false; }
      }, undefined, { timeout: 5_000 });
      await page.waitForFunction(() => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        return (frame?.ops ?? []).some((candidate: any) => candidate?.type === "text" && candidate?.text === "Close");
      }, undefined, { timeout: 5_000 });
      await clickLogical(await textPoint("Close"));
      await page.waitForFunction(() => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        return !(frame?.ops ?? []).some((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
      }, undefined, { timeout: 5_000 });
    };

    const idleBefore = await waitForStableIdle("cold idle");
    const measurements: Array<Record<string, unknown>> = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const before = await readTrace();
      const pointerIndex = before.pointerUps.length;
      const baselineFrame = Number(before.frames.at(-1)?.frame ?? idleBefore.frame);
      await clickLogical(await textPoint("Open modal"));
      const first = await waitForFirstNonzero(pointerIndex, baselineFrame);
      assert.ok(Number(first.frameDelta) > 0, `cycle ${cycle + 1} must advance native frames after pointer-up: ${JSON.stringify(first)}`);
      assert.ok(Number(first.firstOpacityAtMs) >= Number(first.pointerUpMs), `cycle ${cycle + 1} opacity preceded pointer-up: ${JSON.stringify(first)}`);
      assert.ok(Number(first.firstOpacityDelayMs) < 180, `cycle ${cycle + 1} woke too slowly after idle: ${JSON.stringify(first)}`);
      if (cycle === 1) {
        const samples = Array.isArray(first.frameSamples) ? first.frameSamples as Array<{ opacity?: number | null }> : [];
        assert.ok(samples.some((sample) => typeof sample.opacity === "number" && sample.opacity > 0 && sample.opacity < 0.99), `repeat open must expose an intermediate opacity frame: ${JSON.stringify(first)}`);
      }
      measurements.push({ cycle: cycle === 0 ? "cold" : "repeat", ...first, frameCountAtIdle: idleBefore.frameCount });
      await waitForSettledAndClose();
      // Repeat the negative-control idle interval after unmounting the dialog;
      // a leaked transition hook would keep publishing frames here.
      await waitForStableIdle("repeat idle");
    }
    console.log(`[preview-glass-idle-wake] ${JSON.stringify(measurements)}`);
    assert.deepEqual(inputErrors, [], "idle modal pointer round trips must not fail input transport");
    assert.deepEqual(pageErrors, [], "idle modal pointer round trips must not raise browser errors");
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
test("real preview guest can repeatedly open and close a colorless blur modal without hanging", { timeout: 90_000 }, async () => {
  assert.ok(nativeProbe && existsSync(nativeProbe), "a pinned pocket_probe is required for modal browser acceptance");
  const projectRoot = mkdtempSync(join(tmpdir(), "pocket-editor-modal-browser-project-"));
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-modal-browser-build-"));
  const projectId = "modal-glass-repeat";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: projectId, private: true, type: "module" }));
    writeFileSync(join(projectRoot, "pocket.json"), JSON.stringify({ appId: `pocket.test.${projectId}`, entry: "app.tsx" }));
    writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(projectRoot, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, View } from "@pocketjs/framework/solid/components";
import {
  MOBILE_THEME_LIGHT,
  MobileButton,
  MobileDialog,
  MobileThemeProvider,
} from "@pocket/ui";

function App() {
  const [open, setOpen] = createSignal(false);
  return (
    <Screen class="w-full h-full flex-col">
      <View class="flex-row flex-1 w-full">
        <View class="flex-1 h-full bg-[#FF0000]" />
        <View class="flex-1 h-full bg-[#0000FF]" />
      </View>
      <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
        <MobileButton label="Open modal" onPress={() => setOpen(true)} />
        <MobileDialog
          open={open()}
          title="Repeated modal"
          body="This is a real guest round trip."
          onClose={() => setOpen(false)}
        />
      </MobileThemeProvider>
    </Screen>
  );
}

mount(App);
`);
    const built = await buildGuest({ projectRoot, outDir: output, tickHz: 60 });
    manager = createPreviewManager({
      probePath: nativeProbe,
      width: 390,
      height: 640,
      idleDisposeMs: 1000,
      artifacts: {
        bytecode: built.bytecode,
        pak: built.pak,
        revision: 1,
        tickHz: 60,
      },
    });
    const prefix = `/api/projects/${projectId}/preview`;
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        const endpoint = pathname.endsWith("/stream")
          ? "stream"
          : pathname.endsWith("/input")
            ? "input"
            : "page";
        return manager!.handle(request, projectId, endpoint);
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__modalFrameTrace = [];
      (window as any).__modalFrameTimings = [];
      (window as any).__modalPointerTrace = [];
      const canvasTimings = new WeakMap<object, any>();
      const contextPrototype: any = (window as any).CanvasRenderingContext2D?.prototype;
      for (const method of ["clearRect", "fillRect", "drawImage", "fillText", "strokeRect", "save", "restore", "clip", "beginPath", "fill"]) {
        const original = contextPrototype?.[method];
        if (typeof original !== "function") continue;
        try {
          contextPrototype[method] = function(...methodArgs: any[]) {
            const canvas = (this as any).canvas as HTMLCanvasElement | undefined;
            const tracked = canvas?.id === "pocket-preview-surface";
            let timing = tracked ? canvasTimings.get(this) : undefined;
            if (tracked && !timing) {
              timing = { startedAt: null, endedAt: null, calls: 0 };
              canvasTimings.set(this, timing);
              (canvas as any).__pocketDrawTiming = timing;
            }
            if (tracked && method === "clearRect") {
              timing.startedAt = performance.now();
              timing.endedAt = null;
              timing.calls = 0;
            }
            const result = original.apply(this, methodArgs);
            if (tracked) {
              timing.endedAt = performance.now();
              timing.calls += 1;
            }
            return result;
          };
        } catch {
          // Some browser implementations expose non-writable prototype methods.
        }
      }
      document.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement | null)?.tagName === "CANVAS") {
          (window as any).__modalPointerTrace.push({ at: performance.now() });
        }
      }, true);
      window.addEventListener("message", (event) => {
        const packet = event.data;
        if (packet?.source === "pocket-editor-preview" && packet?.type === "preview.frame" && packet.frame) {
          (window as any).__modalFrameTrace.push(packet.frame);
          const canvas = document.querySelector("canvas") as any;
          const draw = canvas?.__pocketDrawTiming;
          (window as any).__modalFrameTimings.push({
            frame: Number(packet.frame.frame),
            receivedAt: performance.now(),
            resources: Array.isArray(packet.frame.resources) ? packet.frame.resources.length : 0,
            drawStart: typeof draw?.startedAt === "number" ? draw.startedAt : null,
            drawEnd: typeof draw?.endedAt === "number" ? draw.endedAt : null,
            drawCalls: Number(draw?.calls ?? 0),
          });
        }
      });
    });
    const inputErrors: string[] = [];
    const pageErrors: string[] = [];
    const inputRecords: Array<{ startedAt: number; responseAt?: number; status?: number }> = [];
    const inputRequests = new Map<object, { startedAt: number; responseAt?: number; status?: number }>();
    const timingMeasurements: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
      const record = { startedAt: performance.now() };
      inputRecords.push(record);
      inputRequests.set(request, record);
    });
    page.on("response", (response) => {
      if (response.request().method() !== "POST" || !response.url().endsWith("/input")) return;
      const record = inputRequests.get(response.request());
      if (!record) return;
      record.responseAt = performance.now();
      record.status = response.status();
    });
    page.on("response", (response) => {
      if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) {
        inputErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}`);
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });

    const textPoint = async (text: string, waitForSemantic = false): Promise<{ x: number; y: number }> => {
      if (waitForSemantic) {
        await page.waitForFunction((label) => {
          const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
          return frame?.ops?.some((candidate: any) => candidate?.type === "text" && candidate?.text === label);
        }, text, { timeout: 5_000 });
      }
      const point = await page.evaluate((label) => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        const op = frame?.ops?.find((candidate: any) => candidate?.type === "text" && candidate?.text === label);
        if (!op) return null;
        return { x: Number(op.x) + Number(op.w) / 2, y: Number(op.y) + Number(op.h) / 2 };
      }, text);
      assert.ok(point, `real guest frame is missing ${text}`);
      return point;
    };
    const frameWithModal = async (): Promise<any> => {
      await page.waitForFunction(() => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        return frame?.ops?.some((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
      }, undefined, { timeout: 5_000 });
      return page.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame());
    };
    const modalMetricsSince = async (start: number): Promise<Array<{
      frame: number;
      titleAlpha: number;
      panelWidth: number;
      panelHeight: number;
      blurOpacity: number;
      tintOpacity: number;
      effect: string;
      blackBackdrops: number;
    }>> => page.evaluate((offset) => {
      const frames = ((window as any).__modalFrameTrace ?? []).slice(offset);
      return frames.map((frame: any) => {
        const ops = Array.isArray(frame?.ops) ? frame.ops : [];
        const title = ops.find((op: any) => op?.type === "text" && op?.text === "Repeated modal");
        const glass = ops.find((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
        if (!glass) return null;
        let parameters: any = {};
        try { parameters = JSON.parse(String(glass.asset)).parameters ?? {}; } catch { parameters = {}; }
        const panel = ops
          .filter((op: any) => op?.type === "rect" && Number(op.w) >= 220 && Number(op.w) <= 300 && Number(op.h) >= 70 && Number(op.h) <= 220 && Math.abs(Number(op.x) + Number(op.w) / 2 - Number(frame.width) / 2) <= 8)
          .sort((left: any, right: any) => Number(right.w) * Number(right.h) - Number(left.w) * Number(left.h))[0];
        if (!panel) return null;
        const blackBackdrops = ops.filter((op: any) => op?.type === "rect" && Math.abs(Number(op.x)) <= 0.1 && Math.abs(Number(op.y)) <= 0.1 && Math.abs(Number(op.w) - Number(frame.width)) <= 0.1 && Math.abs(Number(op.h) - Number(frame.height)) <= 0.1 && typeof op.color === "number" && ((Number(op.color) >>> 24) & 0xff) > 0 && ((Number(op.color) >>> 16) & 0xff) < 16).length;
        return {
          frame: Number(frame.frame),
          // During the earliest scale samples glyphs can be represented by
          // image ops rather than a semantic text op. Keep titleAlpha only
          // as optional diagnostics; glass + panel are the transition ABI.
          titleAlpha: title ? (Number(title.color) >>> 24) & 0xff : -1,
          panelWidth: Number(panel.w),
          panelHeight: Number(panel.h),
          blurOpacity: Number(parameters.opacity),
          tintOpacity: Number(parameters.tintOpacity),
          effect: String(parameters.effect ?? ""),
          blackBackdrops,
        };
      }).filter(Boolean);
    }, start) as Promise<Array<{
      frame: number;
      titleAlpha: number;
      panelWidth: number;
      panelHeight: number;
      blurOpacity: number;
      tintOpacity: number;
      effect: string;
      blackBackdrops: number;
    }>>;
    const modalTimingSince = async (start: number): Promise<Array<{
      frame: number;
      receivedAt: number;
      blurOpacity: number;
      resources: number;
      drawMs: number | null;
      drawCalls: number;
    }>> => page.evaluate((offset) => {
      const frames = ((window as any).__modalFrameTrace ?? []).slice(offset);
      const timings = ((window as any).__modalFrameTimings ?? []) as Array<any>;
      return frames.map((frame: any) => {
        const glass = (Array.isArray(frame?.ops) ? frame.ops : []).find((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
        if (!glass) return null;
        let parameters: any = {};
        try { parameters = JSON.parse(String(glass.asset)).parameters ?? {}; } catch { return null; }
        const timing = timings.find((candidate) => Number(candidate.frame) === Number(frame.frame));
        if (!timing || typeof timing.receivedAt !== "number") return null;
        return {
          frame: Number(frame.frame),
          receivedAt: timing.receivedAt,
          blurOpacity: Number(parameters.opacity),
          resources: Number(timing.resources ?? 0),
          drawMs: typeof timing.drawStart === "number" && typeof timing.drawEnd === "number" ? timing.drawEnd - timing.drawStart : null,
          drawCalls: Number(timing.drawCalls ?? 0),
        };
      }).filter(Boolean);
    }, start) as Promise<Array<{
      frame: number;
      receivedAt: number;
      blurOpacity: number;
      resources: number;
      drawMs: number | null;
      drawCalls: number;
    }>>;
    const waitForModalSettle = async (start: number): Promise<void> => {
      await page.waitForFunction((offset) => {
        const frames = ((window as any).__modalFrameTrace ?? []).slice(offset);
        return frames.some((frame: any) => {
          const ops = Array.isArray(frame?.ops) ? frame.ops : [];
          const glass = ops.find((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
          if (!glass) return false;
          let parameters: any = {};
          try { parameters = JSON.parse(String(glass.asset)).parameters ?? {}; } catch { return false; }
          // Text op colours are emitted before parent opacity compositing, and
          // early glyphs may not be semantic text ops. The glass payload is
          // the observable backdrop fade; panel geometry is the scale signal.
          return Number(parameters.opacity) >= 0.99;
        });
      }, start, { timeout: 5_000 });
    };
    const frameWithoutModal = async (): Promise<any> => {
      await page.waitForFunction(() => {
        const frame = (window as any).PocketEditorPreviewInstance?.getFrame?.();
        // Fading native text becomes image glyphs before the Modal finishes
        // exiting. The underlying Open button is available only after the
        // retained glass/Modal subtree has actually been released.
        return !frame?.ops?.some((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
      }, undefined, { timeout: 5_000 });
      return page.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame());
    };
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    assert.ok(box, "preview canvas must have a browser layout box");

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const traceStart = await page.evaluate(() => ((window as any).__modalFrameTrace ?? []).length);
      const pointerStart = await page.evaluate(() => ((window as any).__modalPointerTrace ?? []).length);
      const inputStart = inputRecords.length;
      const open = await textPoint("Open modal");
      await page.mouse.click(box!.x + open.x, box!.y + open.y);
      const openFrame = await frameWithModal();
      const glassIndex = openFrame.ops.findIndex((op: any) => op?.type === "hostSurface" && String(op.asset ?? "").includes('"kind":"glass"'));
      assert.ok(glassIndex >= 0, `cycle ${cycle + 1} must emit a glass host surface: ${JSON.stringify(openFrame.ops.filter((op: any) => op?.type === "hostSurface"))}`);
      const glassAsset = JSON.parse(String(openFrame.ops[glassIndex]!.asset));
      assert.equal(glassAsset.parameters.effect, "blur", `cycle ${cycle + 1} must use plain backdrop blur`);
      assert.equal(glassAsset.parameters.tintOpacity, 0, `cycle ${cycle + 1} must not tint the backdrop`);
      assert.ok(Number.isFinite(Number(glassAsset.parameters.opacity)), `cycle ${cycle + 1} must expose animated backdrop alpha`);
      const opaqueScrim = openFrame.ops.find((op: any) => op?.type === "rect" && Number(op.x) === 0 && Number(op.y) === 0 && Number(op.w) === 390 && Number(op.h) === 640 && ((Number(op.color) >>> 24) & 0xff) > 0 && ((Number(op.color) >>> 16) & 0xff) < 16);
      assert.equal(opaqueScrim, undefined, `cycle ${cycle + 1} must not paint the default black Modal scrim`);
      await waitForModalSettle(traceStart);
      const timings = await modalTimingSince(traceStart);
      if (cycle < 2) {
        const pointerAt = await page.evaluate((offset) => Number(((window as any).__modalPointerTrace ?? [])[offset]?.at), pointerStart);
        assert.ok(Number.isFinite(pointerAt), `cycle ${cycle + 1} must observe the real canvas pointerdown`);
        assert.ok(timings.length >= 2, `cycle ${cycle + 1} must expose native modal timing frames: ${JSON.stringify(timings)}`);
        const firstProgress = timings[0]!;
        const settledTiming = timings.findLast((timing) => timing.blurOpacity >= 0.99) ?? timings.at(-1)!;
        const nativeInput = inputRecords.slice(inputStart).filter((record) => record.responseAt !== undefined);
        const firstNativeResponseMs = nativeInput.length > 0 ? Math.min(...nativeInput.map((record) => record.responseAt! - record.startedAt)) : null;
        const resourceTiming = timings.find((timing) => timing.resources > 0);
        timingMeasurements.push({
          phase: cycle === 0 ? "cold" : "warm",
          firstProgressMs: firstProgress.receivedAt - pointerAt,
          settledMs: settledTiming.receivedAt - pointerAt,
          firstProgressFrame: firstProgress.frame,
          settledFrame: settledTiming.frame,
          firstNativeResponseMs,
          firstResourceMs: resourceTiming ? resourceTiming.receivedAt - pointerAt : null,
          firstCanvasDrawMs: firstProgress.drawMs,
          firstCanvasDrawCalls: firstProgress.drawCalls,
          modalFrameCount: timings.length,
        });
        assert.ok(firstProgress.receivedAt >= pointerAt, `cycle ${cycle + 1} first progress preceded input: ${JSON.stringify(timings)}`);
        assert.ok(firstNativeResponseMs !== null && firstNativeResponseMs >= 0, `cycle ${cycle + 1} must observe the native input response: ${JSON.stringify(inputRecords.slice(inputStart))}`);
        assert.ok(resourceTiming, `cycle ${cycle + 1} must observe resource arrival in the real frame stream: ${JSON.stringify(timings)}`);
        assert.ok(settledTiming.receivedAt - pointerAt < 2_000, `cycle ${cycle + 1} modal settled too slowly: ${JSON.stringify(timingMeasurements.at(-1))}`);
        assert.ok(firstProgress.drawMs !== null && firstProgress.drawMs >= 0, `cycle ${cycle + 1} must measure synchronous Canvas draw: ${JSON.stringify(timings)}`);
      }
      if (cycle === 0) {
        const metrics = await modalMetricsSince(traceStart);
        assert.ok(metrics.length >= 3, `modal entrance must expose an intermediate frame: ${JSON.stringify(metrics)}`);
        const first = metrics[0]!;
        const settled = metrics.at(-1)!;
        for (let index = 1; index < metrics.length; index += 1) {
          const previous = metrics[index - 1]!;
          const current = metrics[index]!;
          // This selects integer native shadow/fill fragments, not the
          // panel's float bounds. Allow one pixel per edge, as in the native
          // Dialog regression, while still requiring overall scale growth.
          assert.ok(current.panelWidth + 2 >= previous.panelWidth, `modal panel scale regressed: ${JSON.stringify(metrics)}`);
          assert.ok(current.blurOpacity + 0.02 >= previous.blurOpacity, `modal blur opacity regressed: ${JSON.stringify(metrics)}`);
        }
        assert.ok(first.panelWidth < settled.panelWidth, `modal panel must scale up from its pop origin: ${JSON.stringify(metrics)}`);
        assert.ok(first.blurOpacity < 1 && settled.blurOpacity >= 0.99, `modal blur must fade in: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.every((metric) => metric.effect === "blur" && metric.tintOpacity === 0 && metric.blackBackdrops === 0), `modal backdrop must remain colorless and use a transparent official Modal backdrop: ${JSON.stringify(metrics)}`);
      }
      const close = await textPoint("Close", true);
      await page.mouse.click(box!.x + close.x, box!.y + close.y);
      await frameWithoutModal();
    }
    console.log(`[preview-glass-timing] ${JSON.stringify(timingMeasurements)}`);
    assert.deepEqual(inputErrors, [], "modal pointer round trips must not fail input transport");
    assert.deepEqual(pageErrors, [], "modal pointer round trips must not raise browser errors");
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
