/*
 * Browser acceptance setup:
 *   bun install
 *   bunx playwright install chromium
 *   bun test editor/test/preview_density.test.ts --timeout 120000
 *
 * This test deliberately uses the real native preview route and the pinned
 * Playwright Chromium module. It does not replace the SSE/native execution
 * path with a fabricated frame or a successful mock input response.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

type InputPacket = Record<string, any>;
type Capture = {
  requestId: string;
  dataUrl: string;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
};

const sdkRoot = resolve(import.meta.dir, "../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const fixture = join(import.meta.dir, "fixtures/counter");
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";
const logicalWidth = 390;
const logicalHeight = 844;

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string, attempts = 300): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function installDensityHook(context: any): Promise<void> {
  await context.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    const records = new Set<{ media: string; listeners: Set<(event: MediaQueryListEvent) => void> }>();
    (window as any).__pocketSetPreviewDpr = (value: number) => {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
      for (const record of [...records]) {
        for (const listener of [...record.listeners]) listener({ matches: true, media: record.media } as MediaQueryListEvent);
      }
    };
    window.matchMedia = ((query: string) => {
      const native = nativeMatchMedia(query);
      const record = { media: query, listeners: new Set<(event: MediaQueryListEvent) => void>() };
      records.add(record);
      return {
        matches: native.matches,
        media: query,
        onchange: null,
        addEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
          if (type === "change") record.listeners.add(listener);
        },
        removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
          if (type === "change") record.listeners.delete(listener);
        },
        addListener(listener: (event: MediaQueryListEvent) => void) { record.listeners.add(listener); },
        removeListener(listener: (event: MediaQueryListEvent) => void) { record.listeners.delete(listener); },
        dispatchEvent(event: Event) {
          for (const listener of [...record.listeners]) listener(event as MediaQueryListEvent);
          return true;
        },
      } as MediaQueryList;
    }) as typeof window.matchMedia;
  });
}

async function capture(page: any, requestId: string): Promise<Capture> {
  await page.evaluate((id: string) => {
    window.postMessage({ source: "pocket-editor", type: "preview.capture", requestId: id }, window.location.origin);
  }, requestId);
  return waitFor(
    () => page.evaluate((id: string) => (window as any).__pocketDensityCaptures?.find((value: Capture) => value.requestId === id) ?? null, requestId),
    (value): value is Capture => !!value && typeof value.dataUrl === "string",
    `capture ${requestId}`,
  );
}

async function captureImageSize(page: any, dataUrl: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (url: string) => {
    const image = new Image();
    await new Promise<void>((resolveImage, rejectImage) => {
      image.onload = () => resolveImage();
      image.onerror = () => rejectImage(new Error("preview capture data URL did not decode"));
      image.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, dataUrl);
}

async function nonWhitePixels(page: any): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) count += 1;
    }
    return count;
  });
}

async function runPreviewDensityAcceptance(): Promise<void> {
  assert.ok(existsSync(probe), `pocket_probe is required for preview density acceptance: ${probe}`);
  assert.ok(existsSync(playwrightPath), `Playwright Chromium module is required: ${playwrightPath}`);
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-density-build-"));
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  try {
    const built = await buildGuest({ projectRoot: fixture, outDir: output, tickHz: 60 });
    manager = createPreviewManager({
      probePath: probe,
      width: logicalWidth,
      height: logicalHeight,
      idleDisposeMs: 1000,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
    });
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        const endpoint = pathname.endsWith("/stream")
          ? "stream"
          : pathname.endsWith("/input")
            ? "input"
            : "page";
        return manager!.handle(request, "density", endpoint);
      },
    });
    browser = await chromium.launch({ headless: true });

    for (const dpr of [1, 2, 3]) {
      const context = await browser.newContext({
        viewport: { width: logicalWidth, height: logicalHeight },
        deviceScaleFactor: dpr,
      });
      await installDensityHook(context);
      const page = await context.newPage();
      const requests: InputPacket[] = [];
      const responseErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("request", (request: any) => {
        if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
        const body = request.postData();
        if (body) requests.push(JSON.parse(body) as InputPacket);
      });
      page.on("response", (response: any) => {
        if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) {
          responseErrors.push(`${response.status()} ${response.url()}`);
        }
      });
      page.on("pageerror", (error: Error) => pageErrors.push(error.message));
      try {
        const response = await page.goto(`http://127.0.0.1:${server.port}/api/projects/density/preview`);
        assert.equal(response?.status(), 200, `DPR${dpr} preview page response`);
        await page.evaluate(() => {
          (window as any).__pocketDensityCaptures = [];
          window.addEventListener("message", (event) => {
            if (event.data?.source === "pocket-editor-preview" && event.data.type === "preview.capture.result") {
              (window as any).__pocketDensityCaptures.push(event.data);
            }
          });
        });
        await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });

        const dimensions = await page.evaluate(() => {
          const canvas = document.querySelector("canvas") as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect();
          const frame = (window as any).PocketEditorPreviewInstance.getFrame();
          return { canvasWidth: canvas.width, canvasHeight: canvas.height, cssWidth: rect.width, cssHeight: rect.height, frameWidth: frame.width, frameHeight: frame.height };
        });
        assert.equal(dimensions.canvasWidth, logicalWidth * dpr, `DPR${dpr} backing width`);
        assert.equal(dimensions.canvasHeight, logicalHeight * dpr, `DPR${dpr} backing height`);
        assert.ok(Math.abs(dimensions.cssWidth - logicalWidth) < 1, `DPR${dpr} canvas CSS width stays logical`);
        assert.ok(Math.abs(dimensions.cssHeight - logicalHeight) < 1, `DPR${dpr} canvas CSS height stays logical`);
        assert.equal(dimensions.frameWidth, logicalWidth, `DPR${dpr} FrameResult logical width`);
        assert.equal(dimensions.frameHeight, logicalHeight, `DPR${dpr} FrameResult logical height`);

        const initialCapture = await capture(page, `initial-${dpr}`);
        assert.equal(initialCapture.width, logicalWidth * dpr, `DPR${dpr} capture pixel width`);
        assert.equal(initialCapture.height, logicalHeight * dpr, `DPR${dpr} capture pixel height`);
        assert.equal(initialCapture.logicalWidth, logicalWidth, `DPR${dpr} capture logical width`);
        assert.equal(initialCapture.logicalHeight, logicalHeight, `DPR${dpr} capture logical height`);
        assert.deepEqual(await captureImageSize(page, initialCapture.dataUrl), { width: logicalWidth * dpr, height: logicalHeight * dpr });

        const canvas = await page.locator("canvas").boundingBox();
        assert.ok(canvas, `DPR${dpr} canvas layout box`);
        const clickX = canvas!.x + 195;
        const clickY = canvas!.y + 220;
        const requestStart = requests.length;
        await page.mouse.click(clickX, clickY);
        await waitFor(
          () => requests.slice(requestStart),
          (packets) => packets.filter((packet) => packet.type === "pointer").some((packet) => packet.phase === "up"),
          `DPR${dpr} logical click`,
        );
        const clickPackets = requests.slice(requestStart).filter((packet) => packet.type === "pointer") as InputPacket[];
        assert.deepEqual(clickPackets.map((packet) => packet.phase), ["down", "up"], `DPR${dpr} click phase order`);
        for (const packet of clickPackets) {
          assert.ok(Math.abs(Number(packet.x) - 195) < 1, `DPR${dpr} x remains logical (${packet.x})`);
          assert.ok(Math.abs(Number(packet.y) - 220) < 1, `DPR${dpr} y remains logical (${packet.y})`);
        }

        if (dpr === 1) {
          const beforePixels = await nonWhitePixels(page);
          assert.ok(beforePixels > 0, "initial logical frame must have rendered pixels");
          await page.evaluate(() => (window as any).__pocketSetPreviewDpr(2));
          await waitFor(
            () => page.evaluate(() => {
              const canvas = document.querySelector("canvas") as HTMLCanvasElement;
              return { width: canvas.width, height: canvas.height };
            }),
            (value) => value.width === logicalWidth * 2 && value.height === logicalHeight * 2,
            "DPR change redraw",
          );
          const afterPixels = await nonWhitePixels(page);
          assert.ok(afterPixels > 0, "DPR change must redraw the existing FrameResult");
          const changedCapture = await capture(page, "changed-dpr");
          assert.equal(changedCapture.width, logicalWidth * 2, "changed DPR capture pixel width");
          assert.equal(changedCapture.height, logicalHeight * 2, "changed DPR capture pixel height");
          assert.equal(changedCapture.logicalWidth, logicalWidth, "changed DPR capture logical width");
          assert.equal(changedCapture.logicalHeight, logicalHeight, "changed DPR capture logical height");
        }
        assert.deepEqual(responseErrors, [], `DPR${dpr} input response errors: ${responseErrors.join("; ")}`);
        assert.deepEqual(pageErrors, [], `DPR${dpr} page errors: ${pageErrors.join("; ")}`);
      } finally {
        await page.close();
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(output, { recursive: true, force: true });
  }
}

if (process.env.POCKET_PREVIEW_DENSITY_CHILD === "1") {
  test("preview canvas tracks DPR while frames, input, and captures stay logical", { timeout: 120_000 }, runPreviewDensityAcceptance);
} else {
  test("preview density acceptance runs in an isolated Bun process", { timeout: 150_000 }, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, POCKET_PREVIEW_DENSITY_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill(), 140_000);
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const output = `${await stdout}\n${await stderr}`;
    assert.equal(exitCode, 0, output);
  });
}
