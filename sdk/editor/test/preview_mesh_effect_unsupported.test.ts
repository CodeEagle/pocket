import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";

test("Canvas2D preview reports mesh effects and repeat sampling as unsupported", { timeout: 30_000 }, async () => {
  const source = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `<div data-pocket-preview data-project-id=mesh></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
    await page.addInitScript(() => {
      class Source {
        static instances: Source[] = [];
        onmessage?: (event: { data: string }) => void;
        constructor() { Source.instances.push(this); }
        close(): void {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: Source });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));

    for (const op of [
      { type: "meshLayerBegin", x: 0, y: 0, w: 8, h: 8, color: 0, uvs: [1, 1, 1, 0, 0, 0] },
      { type: "textureTriangle", repeatTexture: true, asset: "atlas", color: 0xffffffff,
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 }], uvs: [0, 0, 1.25, 0, 0, 1] },
    ]) {
      await page.evaluate((operation) => {
        const EventSource = (window as any).EventSource as {
          instances: Array<{ onmessage?: (event: { data: string }) => void }>;
        };
        const source = EventSource.instances[0];
        source.onmessage?.({
          data: JSON.stringify({ type: "frame", frame: { frame: 1, width: 8, height: 8, ops: [operation], resources: [], events: [] } }),
        });
      }, op);
      await page.waitForFunction((opType) => {
        const status = document.querySelector("[data-preview-status]")?.textContent ?? "";
        return status.includes("Canvas2D preview does not support") && status.includes(opType);
      }, op.type);
      const status = await page.locator("[data-preview-status]").textContent();
      assert.match(status ?? "", new RegExp(op.type));
    }
  } finally {
    await browser.close();
    await server.stop(true);
  }
});
