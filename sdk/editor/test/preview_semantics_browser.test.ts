import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { chromium } from "playwright";

test("browser projects explicit semantic controls and sends keyboard activation", { timeout: 30_000 }, async () => {
  const clientSource = await readFile(join(import.meta.dir, "../client/preview.js"), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const isScript = new URL(request.url).pathname === "/preview.js";
      return new Response(isScript ? clientSource : "<div data-pocket-preview data-project-id=semantic-browser></div><script src=/preview.js></script>", {
        headers: { "content-type": isScript ? "application/javascript" : "text/html" },
      });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 360 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__previewInputs = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/input")) {
          (window as any).__previewInputs.push(JSON.parse(String(init?.body ?? "{}")));
          return Promise.resolve(new Response("", { status: 200 }));
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
      class FakeEventSource {
        static instances: FakeEventSource[] = [];
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
        close(): void {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void }> }).instances[0];
      if (!source) throw new Error("preview must create one SSE source");
      source.onopen?.();
      const frame = {
        frame: 1,
        width: 390,
        height: 360,
        ops: [],
        resources: [],
        events: [{ name: "accessibility.snapshot", payload: {
          generation: 4,
          runtimeToken: "system-ui:4",
          controls: [
            { guestId: "save", nativeId: 7, label: "Save", role: "button", selected: false, disabled: false, enabled: true, rect: { x: 20, y: 30, width: 120, height: 44 } },
            { guestId: "home", nativeId: 8, label: "Home", role: "tab", selected: true, disabled: false, enabled: true, checked: false, rect: { x: 160, y: 30, width: 120, height: 44 } },
          ],
        } }],
      };
      source.onmessage?.({ data: JSON.stringify({ type: "frame", frame }) });
    });
    const save = page.locator('[data-pocket-semantic-guest-id="save"]');
    const home = page.locator('[data-pocket-semantic-guest-id="home"]');
    await page.waitForFunction(() => document.querySelectorAll("[data-pocket-semantic-guest-id]").length === 2);
    assert.equal(await save.getAttribute("role"), "button");
    assert.equal(await save.getAttribute("aria-label"), "Save");
    assert.equal(await save.getAttribute("aria-pressed"), null);
    assert.equal(await home.getAttribute("role"), "tab");
    assert.equal(await home.getAttribute("aria-selected"), "true");
    assert.equal(await save.evaluate((element) => getComputedStyle(element).pointerEvents), "none");

    await save.focus();
    await save.press("Enter");
    await page.waitForFunction(() => (window as any).__previewInputs.some((input: any) => input.type === "semantic"));
    const action = await page.evaluate(() => (window as any).__previewInputs.filter((input: any) => input.type === "semantic").at(-1));
    assert.deepEqual(action, {
      type: "semantic",
      action: "activate",
      guestId: "save",
      nativeId: 7,
      generation: 4,
      runtimeToken: "system-ui:4",
    });

    const source = await page.evaluateHandle(() => ((window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> }).instances[0]);
    await page.evaluate((sourceValue) => {
      (sourceValue as any).onmessage?.({ data: JSON.stringify({ type: "frame", frame: { frame: 2, width: 390, height: 360, ops: [], resources: [], events: [] } }) });
    }, source);
    await page.waitForFunction(() => document.querySelectorAll("[data-pocket-semantic-guest-id]").length === 0);
    await source.dispose();
  } finally {
    await browser.close();
    server.stop(true);
  }
});
