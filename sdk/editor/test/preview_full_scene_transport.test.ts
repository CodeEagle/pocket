import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";
import { createPreviewMeshWireEncoder, previewMeshWireDecoderSource } from "../preview_mesh_wire.ts";

const capture = new URL("../../.pocket-build/live2d-user-frame.json", import.meta.url);
// A local actual native capture contains licensed atlas/background pixels; it
// is intentionally not a source fixture. Synthetic protocol cases run in CI.
test.skipIf(!existsSync(capture))("full Mist Harbor capture retains background, dialogue, UI and model pixels through mesh transport", { timeout: 60_000 }, async () => {
  const frame = JSON.parse(readFileSync(capture, "utf8"));
  assert.ok(frame.ops.some((op: any) => op.type === "image"), "full scene must include background imagery");
  assert.ok(frame.ops.some((op: any) => op.type === "text"), "full scene must include dialogue/UI");
  assert.ok(frame.ops.filter((op: any) => String(op.asset).includes("Hiyori") && op.type === "textureTriangle").length > 1000);
  const encoded = createPreviewMeshWireEncoder().encode({ type: "frame", frame: { ...frame, resources: [] } });
  const server = Bun.serve({ port: 0, fetch: () => new Response("<!doctype html><body></body>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).EventSource = class { constructor() { (window as any).fixtureSource = this; } close() {} };
    });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.addScriptTag({ content: previewMeshWireDecoderSource() + "\n" + readFileSync(new URL("../client/preview.js", import.meta.url), "utf8") });
    const result = await page.evaluate(({ frame, encoded }) => {
      const root = document.createElement("div"); document.body.append(root);
      const instance = (window as any).PocketEditorPreview.mount(root, { projectId: "full-scene", width: frame.width, height: frame.height });
      const source = (window as any).fixtureSource;
      source.onopen?.();
      source.onmessage({ data: JSON.stringify({ type: "frame", frame }) });
      const ctx = instance.canvas.getContext("2d");
      const before = ctx.getImageData(0, 0, instance.canvas.width, instance.canvas.height).data;
      source.onmessage({ data: JSON.stringify(encoded) });
      const after = ctx.getImageData(0, 0, instance.canvas.width, instance.canvas.height).data;
      let differences = 0, coloredPixels = 0;
      for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) differences++;
      for (let i = 0; i < after.length; i += 4) if (after[i] !== 255 || after[i + 1] !== 255 || after[i + 2] !== 255) coloredPixels++;
      const installed = instance.getFrame();
      const result = { differences, coloredPixels, opCount: installed.ops.length, encodedMarker: installed.meshWire };
      instance.close();
      return result;
    }, { frame, encoded });
    assert.equal(result.differences, 0);
    assert.ok(result.coloredPixels > 100_000, "an empty/blank surface cannot satisfy scene acceptance");
    assert.equal(result.opCount, frame.ops.length);
    assert.equal(result.encodedMarker, undefined);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.stop(true); }
});
