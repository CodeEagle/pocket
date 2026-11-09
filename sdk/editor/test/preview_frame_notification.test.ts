import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";
import { encodePreviewStreamPacket } from "../preview.ts";

const source = readFileSync(
  process.env.POCKET_PREVIEW_CLIENT ?? new URL("../client/preview.js", import.meta.url),
  "utf8",
);

test("parent frame notifications omit texture bytes while Chromium keeps pixels and resource lifecycle", { timeout: 30_000 }, async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `<div data-pocket-preview data-stream-worker=true data-project-id=frame-notification></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      Object.defineProperty(window, "Worker", { configurable: true, value: undefined });
      class Source {
        static instances: Source[] = [];
        onmessage?: (event: { data: string }) => void;
        constructor() { Source.instances.push(this); }
        close(): void {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: Source });
      (window as any).__frameNotifications = [];
      window.addEventListener("message", (event) => {
        if (event.data?.source === "pocket-editor-preview" && event.data?.type === "preview.frame") {
          (window as any).__frameNotifications.push(event.data.frame);
        }
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame));

    const palette = new Array<number>(256 * 4).fill(0);
    palette.splice(7 * 4, 4, 12, 34, 56, 255);
    const firstResource = {
      asset: "solid-pixel",
      revision: 4,
      width: 1,
      height: 1,
      psm: 5,
      linear: true,
      pixels: [7],
      palette,
    };
    const frame = (number: number, resource?: Record<string, unknown>, releasedResources: string[] = []) => ({
      frame: number,
      width: 16,
      height: 16,
      inputBounds: { x: 1, y: 2, w: 12, h: 13 },
      presentationTokens: [],
      ops: [{ type: "image", asset: "solid-pixel", x: 0, y: 0, w: 16, h: 16 }],
      events: [],
      resources: resource ? [resource] : [],
      releasedResources,
    });
    const deliver = async (value: ReturnType<typeof frame>, compact = false) => {
      const packet = new TextDecoder().decode(encodePreviewStreamPacket({ type: "frame", frame: value }, compact));
      await page.evaluate((data) => {
        const EventSource = (window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> };
        EventSource.instances[0]?.onmessage?.({ data });
      }, packet.slice(6).trim());
      await page.waitForFunction((expected) => (window as any).PocketEditorPreviewInstance.getFrame()?.frame === expected, value.frame);
      await page.waitForFunction((expected) => (window as any).__frameNotifications.some((next: any) => next.frame === expected), value.frame);
    };

    await deliver(frame(1, firstResource));
    const first = await page.evaluate(() => {
      const current = (window as any).PocketEditorPreviewInstance.getFrame();
      const notice = (window as any).__frameNotifications.find((value: any) => value.frame === 1);
      const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
      return {
        pixels: current.resources[0].pixels,
        palette: current.resources[0].palette,
        pixel: Array.from(canvas.getContext("2d")!.getImageData(8, 8, 1, 1).data),
        notice,
      };
    });
    assert.deepEqual(first.pixels, [7], "getFrame retains original resource bytes");
    assert.equal(first.palette.length, 1024, "getFrame retains the original palette");
    assert.deepEqual(first.pixel, [12, 34, 56, 255], "Canvas still decodes and draws the native PSM5 pixels");
    assert.deepEqual(first.notice.resources, [{
      asset: "solid-pixel",
      revision: 4,
      width: 1,
      height: 1,
      psm: 5,
      linear: true,
      pixelsBytes: 1,
      paletteBytes: 1024,
    }]);
    assert.equal("pixels" in first.notice.resources[0], false);
    assert.equal("palette" in first.notice.resources[0], false);
    assert.deepEqual(first.notice.inputBounds, { x: 1, y: 2, w: 12, h: 13 });
    assert.deepEqual(first.notice.presentationTokens, []);
    assert.deepEqual(first.notice.ops, [{ type: "image", asset: "solid-pixel", x: 0, y: 0, w: 16, h: 16 }]);
    assert.deepEqual(first.notice.events, []);

    const replacementPalette = new Array<number>(256 * 4).fill(0);
    replacementPalette.splice(9 * 4, 4, 201, 98, 45, 255);
    // Older browsers use atob; the native base64 fast path is optional.
    await page.evaluate(() => {
      (window as any).__fromBase64 = (Uint8Array as any).fromBase64;
      (Uint8Array as any).fromBase64 = undefined;
    });
    await deliver(frame(2, {
      ...firstResource,
      revision: 5,
      pixels: [9],
      palette: replacementPalette,
    }), true);
    const replacement = await page.evaluate(() => ({
      resource: (window as any).PocketEditorPreviewInstance.getFrame().resources[0],
      pixel: Array.from(((window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(8, 8, 1, 1).data),
      notice: (window as any).__frameNotifications.find((value: any) => value.frame === 2),
    }));
    assert.equal(replacement.resource.revision, 5, "same asset identity accepts a new revision");
    assert.equal(replacement.resource.bytesEncoding, "base64");
    assert.deepEqual([...Buffer.from(replacement.resource.pixels, "base64")], [9]);
    assert.deepEqual(replacement.pixel, [201, 98, 45, 255], "replacement pixels reach the actual Canvas");
    assert.equal(replacement.notice.resources[0].revision, 5);
    assert.equal(replacement.notice.resources[0].pixelsBytes, 1);
    assert.equal(replacement.notice.resources[0].paletteBytes, 1024);

    await deliver(frame(3, undefined, ["solid-pixel"]));
    const released = await page.evaluate(() => ({
      current: (window as any).PocketEditorPreviewInstance.getFrame(),
      pixel: Array.from(((window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(8, 8, 1, 1).data),
      notice: (window as any).__frameNotifications.find((value: any) => value.frame === 3),
    }));
    assert.deepEqual(released.current.resources, [], "release removes the decoded source");
    assert.deepEqual(released.current.releasedResources, ["solid-pixel"]);
    assert.deepEqual(released.pixel, [255, 255, 255, 255], "released image no longer paints into Canvas");
    assert.deepEqual(released.notice.resources, []);
    assert.deepEqual(released.notice.releasedResources, ["solid-pixel"], "parent notification retains the release edge");

    await page.evaluate(() => { (Uint8Array as any).fromBase64 = (window as any).__fromBase64; });
    await deliver(frame(4, { asset: "solid-pixel", revision: 6, width: 1, height: 1, psm: 3, pixels: [32, 64, 128, 255] }), true);
    assert.deepEqual(await page.evaluate(() => Array.from(((window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(8, 8, 1, 1).data)), [32, 64, 128, 255]);
    assert.deepEqual(firstResource.pixels, [7], "wire encoding does not mutate the canonical native resource");
  } finally {
    await browser.close();
    await server.stop(true);
  }
});

test("production preview transfers texture buffers from its SSE worker and reconnects with resource replay", { timeout: 30_000 }, async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let connections = 0;
  const makeFrame = (index: number, pixels: number[] = [12, 34, 56, 255]) => ({
    type: "frame", frame: { frame: index, width: 16, height: 16, events: [],
      ops: [{ type: "image", asset: "worker-pixel", x: 0, y: 0, w: 16, h: 16 }],
      resources: [{ asset: "worker-pixel", revision: index, width: 1, height: 1, psm: 3, pixels }],
    },
  });
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/stream")) {
      assert.equal(new URL(request.url).searchParams.get("resources"), "base64");
      connections += 1;
      return new Response(new ReadableStream({ start(value) {
        controller = value;
        value.enqueue(encodePreviewStreamPacket(makeFrame(connections), true));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/input")) return Response.json({ ok: true });
    return new Response(`<div data-pocket-preview data-stream-worker=true data-project-id=worker></div><script>${source.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 } });
    await page.addInitScript(() => {
      const parse = JSON.parse;
      JSON.parse = function (text, ...rest) {
        if (typeof text === "string" && text.includes('"type":"frame"')) throw new Error("Frame JSON reached the rendering thread");
        return Reflect.apply(parse, this, [text, ...rest]);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const wait = (index: number) => page.waitForFunction(expected => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === expected, index);
    const sample = () => page.evaluate(() => {
      const preview = (window as any).PocketEditorPreviewInstance;
      const resource = preview.getFrame().resources[0];
      return { typed: resource?.pixels instanceof Uint8Array, pixel: Array.from((preview.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(8, 8, 1, 1).data) };
    });
    await wait(1);
    assert.deepEqual(await sample(), { typed: true, pixel: [12, 34, 56, 255] });
    controller!.close();
    await wait(2);
    assert.equal(connections, 2, "native EventSource reconnects in the same worker");
    assert.deepEqual(await sample(), { typed: true, pixel: [12, 34, 56, 255] });
    controller!.enqueue(encodePreviewStreamPacket(makeFrame(3, [201, 98, 45, 255]), true));
    await wait(3);
    assert.deepEqual(await sample(), { typed: true, pixel: [201, 98, 45, 255] });
    controller!.enqueue(encodePreviewStreamPacket({ type: "frame", frame: { ...makeFrame(4).frame, resources: [], releasedResources: ["worker-pixel"] } }, true));
    await wait(4);
    assert.deepEqual((await sample()).pixel, [255, 255, 255, 255]);
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
  } finally {
    await browser.close();
    await server.stop(true);
  }
});
