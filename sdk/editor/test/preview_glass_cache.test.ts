import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { test } from "bun:test";

test("preview reuses a stable backdrop blur across glass opacity frames", { timeout: 30_000 }, async () => {
  const source = readFileSync(process.env.POCKET_PREVIEW_CLIENT ?? new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `<div data-pocket-preview data-project-id=glass-cache></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
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
        constructor() { FakeEventSource.instances.push(this); }
        close(): void {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as any).__blurPasses = 0;
      (window as any).__blurTargets = new Set<HTMLCanvasElement>();
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
        if (this.filter.startsWith("blur(")) {
          (window as any).__blurPasses += 1;
          (window as any).__blurTargets.add(this.canvas);
        }
        return drawImage.apply(this, args as any);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    const result = await page.evaluate(async () => {
      const send = async (frame: Record<string, unknown>) => {
        const source = ((window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> }).instances[0];
        source?.onmessage?.({ data: JSON.stringify({ type: "frame", frame }) });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      };
      const frame = (index: number, rightColor: number, opacity: number, blur = 8): Record<string, unknown> => ({
        frame: index,
        width: 100,
        height: 100,
        ops: [
          { type: "rect", x: 0, y: 0, w: 50, h: 100, color: 0xffff0000 },
          { type: "rect", x: 50, y: 0, w: 50, h: 100, color: rightColor },
          {
            type: "hostSurface",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            asset: JSON.stringify({ kind: "glass", parameters: { effect: "blur", blur, opacity, tintOpacity: 0 } }),
          },
        ],
        events: [],
        resources: [],
      });
      const pixel = () => {
        const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
        return Array.from(canvas.getContext("2d")!.getImageData(49 * canvas.width / 100, canvas.height / 2, 1, 1).data);
      };
      await send(frame(1, 0xff0000ff, 0.25));
      const quarter = pixel();
      await send(frame(2, 0xff0000ff, 0.5));
      const stablePasses = (window as any).__blurPasses;
      const half = pixel();
      await send(frame(3, 0xff0000ff, 1));
      const stableOpacityPasses = (window as any).__blurPasses;
      const full = pixel();
      await send(frame(4, 0xff00ff00, 0.5));
      const changedBackdropPasses = (window as any).__blurPasses;
      const changed = pixel();
      await send(frame(5, 0xff00ff00, 0.5, 10));
      const finalPasses = (window as any).__blurPasses;
      // Replacing an image under the same asset id changes the sampled pixels.
      const imageFrame = (index: number, pixels?: number[]) => ({ ...frame(index, 0xff00ff00, 1),
        ops: [{ type: "image", asset: "background", x: 0, y: 0, w: 100, h: 100 }, (frame(index, 0, 1).ops as unknown[])[2]],
        resources: pixels ? [{ asset: "background", width: 1, height: 1, psm: 3, pixels }] : [],
      });
      await send(imageFrame(6, [255, 0, 0, 255]));
      const red = pixel();
      await send(imageFrame(7));
      const imageStablePasses = (window as any).__blurPasses;
      await send(imageFrame(8, [0, 0, 255, 255]));
      const blue = pixel();
      const replacedPasses = (window as any).__blurPasses;
      await send({ ...imageFrame(9), releasedResources: ["background"] });
      const released = pixel();
      const releasedPasses = (window as any).__blurPasses;
      await send({ ...frame(10, 0xff0000ff, 1), width: 80 });
      const resizedPasses = (window as any).__blurPasses;
      const videoFrame = (index: number) => ({ ...frame(index, 0xff0000ff, 1),
        ops: [{ type: "video", id: "not-ready", x: 0, y: 0, w: 0, h: 0 }, ...(frame(index, 0xff0000ff, 1).ops as unknown[])],
      });
      // Even a not-yet-ready video disables reuse: its first decoded frame may
      // arrive without a changed draw list. Real video playback has its own suite.
      await send(videoFrame(11));
      await send(videoFrame(12));
      const videoPasses = (window as any).__blurPasses;
      const targets = [...(window as any).__blurTargets] as HTMLCanvasElement[];
      await (window as any).PocketEditorPreviewInstance.close();
      return { stablePasses, stableOpacityPasses, changedBackdropPasses, finalPasses,
        quarter, half, full, changed, red, blue, released,
        imageStablePasses, replacedPasses, releasedPasses, resizedPasses, videoPasses,
        targets: targets.length, freed: targets.every((canvas) => canvas.width === 0 && canvas.height === 0) };
    });
    assert.equal(result.stablePasses, 1, JSON.stringify(result));
    assert.equal(result.stableOpacityPasses, 1, JSON.stringify(result));
    assert.equal(result.changedBackdropPasses, 2, JSON.stringify(result));
    assert.equal(result.finalPasses, 3, JSON.stringify(result));
    assert.ok(result.quarter[2]! < result.half[2]! && result.half[2]! < result.full[2]!, "cached blur must still composite this frame's opacity");
    assert.ok(result.changed[1]! > 20 && result.changed[2]! < 5, "changed backdrop must use new green pixels");
    assert.equal(result.imageStablePasses, 4);
    assert.equal(result.replacedPasses, 5);
    assert.equal(result.releasedPasses, 6);
    assert.equal(result.resizedPasses, 7);
    assert.equal(result.videoPasses, 9, "video prefixes must recalculate on every frame");
    assert.ok(result.red[0]! > 250 && result.red[2]! < 5);
    assert.ok(result.blue[2]! > 250 && result.blue[0]! < 5);
    assert.ok(result.released.slice(0, 3).every((channel) => channel > 250), "released resource must not leave stale blur pixels");
    assert.equal(result.targets, 1, "reuse the original scratch buffer rather than keeping backdrop history");
    assert.ok(result.freed, "preview close must release the scratch pixels");
  } finally {
    await browser.close();
    server.stop(true);
  }
});
