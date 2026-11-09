import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { chromium } from "playwright";

const clientRoot = join(import.meta.dir, "../client");

test("preview stream reconnect is recoverable and cancels queued pointer gestures", { timeout: 30_000 }, async () => {
  const clientSource = await readFile(join(clientRoot, "preview.js"), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch: (request) => new URL(request.url).pathname === "/preview.js"
      ? new Response(clientSource, { headers: { "content-type": "application/javascript" } })
      : new Response(`<!doctype html><div data-pocket-preview data-project-id="reconnect-fixture"></div>
        <script>window.__previewMessages=[];window.addEventListener("message",event=>{if(event.data?.source==="pocket-editor-preview")window.__previewMessages.push(event.data)})</script>
        <script src="/preview.js"></script>`, { headers: { "content-type": "text/html" } }),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 360 } });
    await page.addInitScript(() => {
      (window as any).__inputCalls = [];
      (window as any).__downStarted = false;
      (window as any).__releaseDown = null;
      const originalFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/input")) return originalFetch(input, init);
        const payload = JSON.parse(String(init?.body ?? "{}"));
        (window as any).__inputCalls.push(payload);
        if (payload.type === "pointer" && payload.phase === "down" && !(window as any).__downStarted) {
          (window as any).__downStarted = true;
          return new Promise<Response>((resolve) => {
            (window as any).__releaseDown = () => resolve(new Response(null, { status: 200 }));
          });
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof window.fetch;
      class FakeEventSource {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        static instances: FakeEventSource[] = [];
        readyState = FakeEventSource.CONNECTING;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onerror?: () => void;
        closed = false;
        constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
        close(): void { this.closed = true; }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ onerror?: () => void }> }).instances[0];
      const canvas = document.querySelector("canvas")!;
      if (!source) throw new Error("preview must create one SSE source");
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 17, pointerType: "touch", clientX: 20, clientY: 30 }));
    });
    await page.waitForFunction(() => (window as any).__downStarted === true);
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 17, pointerType: "touch", clientX: 32, clientY: 42 }));
      const source = ((window as any).EventSource as { instances: Array<{ onerror?: () => void }> }).instances[0];
      source.onerror?.();
    });
    await page.waitForFunction(() => (window as any).__previewMessages.some((message: any) =>
      message.type === "preview.status" && message.status?.state === "reconnecting"));
    assert.equal(await page.evaluate(() => (window as any).__previewMessages.some((message: any) =>
      message.type === "preview.error" && message.error === "preview stream reconnecting")), false);

    await page.evaluate(() => (window as any).__releaseDown());
    await page.waitForFunction(() => (window as any).__inputCalls.some((payload: any) =>
      payload.type === "pointer" && payload.phase === "cancel"));
    const pointerRequests = await page.evaluate(() => (window as any).__inputCalls.filter((payload: any) => payload.type === "pointer"));
    assert.deepEqual(pointerRequests.map((payload: any) => payload.phase), ["down", "cancel"], "queued MOVE must be discarded after stream loss");

    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ onmessage?: (event: { data: string }) => void }> }).instances[0];
      source.onmessage?.({ data: JSON.stringify({ type: "error", error: "native frame failed" }) });
    });
    await page.waitForFunction(() => (window as any).__previewMessages.some((message: any) =>
      message.type === "preview.error" && message.error === "native frame failed"));
    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ readyState: number; onerror?: () => void }> }).instances[0];
      source.readyState = 2;
      source.onerror?.();
    });
    await page.waitForFunction(() => (window as any).__previewMessages.some((message: any) =>
      message.type === "preview.error" && message.error === "preview stream closed"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    server.stop(true);
  }
});

test("editor shows reconnecting without a toast and restores ready after SSE recovery", { timeout: 30_000 }, async () => {
  const [index, editorSource, editorCss] = await Promise.all([
    readFile(join(clientRoot, "index.html"), "utf8"),
    readFile(join(clientRoot, "editor.js"), "utf8"),
    readFile(join(clientRoot, "editor.css"), "utf8"),
  ]);
  const device = {
    model: "Fixture phone", screenWidth: 375, screenHeight: 812, pixelRatio: 1,
    statusBarHeight: 24, safeAreaBottom: 0,
    safeArea: { top: 24, right: 0, bottom: 0, left: 0 },
    shell: { bezel: 0, borderRadius: 0, notchWidth: 0, notchHeight: 0, homeIndicatorWidth: 0, homeIndicatorHeight: 0, homeIndicatorBottom: 0 },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/editor.js") return new Response(editorSource, { headers: { "content-type": "application/javascript" } });
      if (path === "/editor.css") return new Response(editorCss, { headers: { "content-type": "text/css" } });
      if (path === "/api/preview/device") return Response.json(device);
      if (path === "/health") return Response.json({ ok: true, csrfToken: "fixture", bluetooth: { local: false } });
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/devices") return Response.json({ devices: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => document.querySelector("#preview-state")?.textContent?.includes("等待中"));
    await page.evaluate(() => {
      const previewFrame = document.querySelector<HTMLIFrameElement>("#preview-frame")!;
      const deliver = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin,
        source: previewFrame.contentWindow,
        data: { source: "pocket-editor-preview", version: 1, ...data },
      }));
      (window as any).__deliverPreviewMessage = deliver;
      deliver({ type: "preview.ready" });
      deliver({ type: "preview.frame", frame: { frame: 1, width: 375, height: 812, ops: [], resources: [], events: [] } });
    });
    await page.waitForFunction(() => document.querySelector("#capture-preview")?.hasAttribute("disabled") === false);

    await page.evaluate(() => (window as any).__deliverPreviewMessage({ type: "preview.status", status: { state: "reconnecting" } }));
    assert.match(await page.locator("#preview-state").innerText(), /重连中/);
    assert.equal(await page.locator("#notice").evaluate((element) => (element as HTMLElement).hidden), true);
    assert.equal(await page.locator("#capture-preview").isDisabled(), true);

    await page.evaluate(() => (window as any).__deliverPreviewMessage({ type: "preview.status", status: { state: "ready" } }));
    assert.match(await page.locator("#preview-state").innerText(), /就绪/);
    assert.equal(await page.locator("#capture-preview").isDisabled(), false);

    await page.evaluate(() => (window as any).__deliverPreviewMessage({ type: "preview.error", error: "native frame failed" }));
    assert.equal(await page.locator("#notice").evaluate((element) => (element as HTMLElement).hidden), false);
    assert.equal(await page.locator("#notice-message").innerText(), "native frame failed");
  } finally {
    await browser.close();
    server.stop(true);
  }
});
