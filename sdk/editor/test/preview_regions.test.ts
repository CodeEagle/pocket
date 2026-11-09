import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

type PreviewFrame = { frame?: number; ops?: Array<Record<string, unknown>> };

const sdkRoot = resolve(import.meta.dir, "../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const fixture = join(import.meta.dir, "fixtures/counter");
const playwrightOverride = process.env.POCKET_PLAYWRIGHT;
const screenshotPath = process.env.POCKET_REGIONS_SCREENSHOT ?? "/tmp/pocket-preview-regions-20261104.png";

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("preview region overlay toggles and captures without changing FrameResult or input", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for region overlay acceptance: ${probe}`);
  if (playwrightOverride) assert.ok(existsSync(playwrightOverride), `POCKET_PLAYWRIGHT does not exist: ${playwrightOverride}`);
  const { chromium } = playwrightOverride
    ? await import(pathToFileURL(playwrightOverride).href)
    : await import("playwright");
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-regions-build-"));
  let built;
  try {
    built = await buildGuest({ projectRoot: fixture, outDir: output, tickHz: 60 });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  const manager = createPreviewManager({
    probePath: probe,
    width: 390,
    height: 360,
    idleDisposeMs: 1000,
    artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
  });
  const projectId = "counter-regions";
  const prefix = `/api/projects/${projectId}/preview`;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      const endpoint = pathname.endsWith("/stream")
        ? "stream"
        : pathname.endsWith("/input")
          ? "input"
          : "page";
      return manager.handle(request, projectId, endpoint);
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 520 } });
  const inputPackets: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
    const body = request.postData();
    if (body) inputPackets.push(JSON.parse(body) as Record<string, unknown>);
  });

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}?regions=1`);
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });
    await page.evaluate(() => {
      (window as any).__pocketPreviewCaptures = [];
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message?.source === "pocket-editor-preview" && message.type === "preview.capture.result") {
          (window as any).__pocketPreviewCaptures.push(message);
        }
      });
    });

    // The browser publishes its accessibility fact on startup through the
    // same /input endpoint. Compare overlay operations against that settled
    // transport baseline, rather than treating startup facts as user input.
    await waitFor(async () => inputPackets.some(packet => packet.type === "accessibility"), Boolean, "startup accessibility fact");
    const startupPackets = structuredClone(inputPackets);
    console.log(`preview regions startup packets: ${JSON.stringify(startupPackets)}`);

    const originalFrame = await page.evaluate(() => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      return { number: frame.frame, ops: JSON.parse(JSON.stringify(frame.ops)) };
    });
    const redPixels = () => page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 170 && pixels[index + 1] < 100 && pixels[index + 2] < 100 && pixels[index + 3] > 180) count += 1;
      }
      return count;
    });
    await waitFor(redPixels, (count) => count > 0, "URL-enabled red region overlay");
    await page.evaluate(() => {
      window.postMessage({ source: "pocket-editor", type: "preview.regions", enabled: false }, window.location.origin);
    });
    await waitFor(redPixels, (count) => count === 0, "URL overlay disable");
    const capture = async (requestId: string): Promise<{ dataUrl: string; width: number; height: number }> => {
      await page.evaluate((id) => {
        window.postMessage({ source: "pocket-editor", type: "preview.capture", requestId: id }, window.location.origin);
      }, requestId);
      return await waitFor(
        () => page.evaluate((id) => (window as any).__pocketPreviewCaptures.find((value: any) => value.requestId === id) ?? null, requestId),
        (value): value is { dataUrl: string; width: number; height: number } => !!value && typeof value.dataUrl === "string",
        `capture ${requestId}`,
      );
    };
    const capturePixels = async (dataUrl: string): Promise<number> => await page.evaluate(async (url) => {
      const image = new Image();
      await new Promise<void>((resolveImage, rejectImage) => {
        image.onload = () => resolveImage();
        image.onerror = () => rejectImage(new Error("capture data URL did not decode"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 170 && pixels[index + 1] < 100 && pixels[index + 2] < 100 && pixels[index + 3] > 180) count += 1;
      }
      return count;
    }, dataUrl);

    const offCapture = await capture("regions-off");
    const offPixels = await capturePixels(offCapture.dataUrl);
    assert.equal(offCapture.width, 390);
    assert.equal(offCapture.height, 360);

    await page.evaluate(() => {
      window.postMessage({ source: "pocket-editor", type: "preview.regions", enabled: true }, window.location.origin);
    });
    const visiblePixels = await waitFor(redPixels, (count) => count > 0, "visible red region overlay");
    assert.ok(visiblePixels > offPixels, "region overlay must add red pixels to the current projection");
    await page.screenshot({ path: screenshotPath });
    const enabledOps = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).PocketEditorPreviewInstance.getFrame().ops)));
    assert.deepEqual(enabledOps, originalFrame.ops, "region overlay must not mutate FrameResult ops");
    assert.equal(await page.evaluate(() => Number((window as any).PocketEditorPreviewInstance.getFrame().frame)), originalFrame.number, "enabling regions must not request a guest frame");
    assert.deepEqual(inputPackets, startupPackets, "region toggle must not send native input after startup facts");
    const onCapture = await capture("regions-on");
    const onCapturePixels = await capturePixels(onCapture.dataUrl);
    assert.ok(onCapturePixels > offPixels, "capture must include the currently visible region labels/borders");

    await page.evaluate(() => {
      window.postMessage({ source: "pocket-editor", type: "preview.regions", enabled: false }, window.location.origin);
    });
    await waitFor(redPixels, (count) => count <= offPixels, "region overlay removal");
    const disabledOps = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).PocketEditorPreviewInstance.getFrame().ops)));
    assert.deepEqual(disabledOps, originalFrame.ops, "disabling regions must restore the original FrameResult projection");
    assert.equal(await page.evaluate(() => Number((window as any).PocketEditorPreviewInstance.getFrame().frame)), originalFrame.number, "disabling regions must not request a guest frame");
    assert.deepEqual(inputPackets, startupPackets, "region toggle must not send native input after startup facts");

    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const rect = canvas.getBoundingClientRect();
      for (const [type, buttons] of [["pointerdown", 1], ["pointerup", 0]] as const) {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          pointerId: 77,
          pointerType: "mouse",
          clientX: rect.left + 195,
          clientY: rect.top + 120,
          buttons,
        }));
      }
    });
    await waitFor(
      () => page.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.type === "text" && op.text === "count=1")),
      (value) => value === true,
      "native counter input after overlay toggle",
    );
    assert.deepEqual(inputPackets.slice(startupPackets.length).map((packet) => packet.phase), ["down", "up"], "region overlay must not intercept pointer input");
  } finally {
    await browser.close();
    server.stop(true);
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
