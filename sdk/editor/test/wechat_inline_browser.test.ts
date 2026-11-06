// Client iframe lifecycle/layout regression using explicit HTTP test documents.
// Real Guest/WASM interaction is verified separately by the integration probe.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { previewDevice } from "../preview_device.ts";

const clientRoot = resolve(import.meta.dir, "../client");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");

type Project = { id: string; name: string; version: string };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function previewDocument(): Response {
  return new Response(`<!doctype html><body style="margin:0;background:#101827;color:white"><main id="canvas-preview">Canvas preview</main><script>
    parent.postMessage({ source: "pocket-editor-preview", type: "preview.ready" }, location.origin);
    parent.postMessage({ source: "pocket-editor-preview", type: "preview.frame" }, location.origin);
  </script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function wechatDocument(): Response {
  return new Response(`<!doctype html><body style="margin:0;background:#f7f7f7"><main id="wechat-app">WeChat whole app</main></body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("Editor keeps Canvas and WeChat previews visible together and cleans the inline frame", async () => {
  const projects: Project[] = [
    { id: "inline-a", name: "Inline A", version: "0.1.0" },
    { id: "inline-b", name: "Inline B", version: "0.1.0" },
  ];
  const wechatStates = new Map<string, Record<string, unknown>>(
    projects.map((project) => [project.id, { state: "idle", logs: [] }]),
  );
  let nativeBluetoothAvailable = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (path === "/editor.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
        if (path === "/editor.js") {
          // Test-only seam: expose the production renderer so a same-state
          // render can be replayed without changing the shipped client.
          return new Response(`${script}\nwindow.__pocketTestRenderWechat = renderWechatState;`, { headers: { "content-type": "text/javascript; charset=utf-8" } });
        }
        if (path === "/api/preview/device") return json(previewDevice);
        if (path === "/health") return json({ csrfToken: "inline-test", projectId: projects[0]!.id, bluetooth: { local: nativeBluetoothAvailable } });
        if (path === "/api/devices") return json([]);
        if (path === "/api/projects") return json(projects);
        const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
        if (projectMatch) {
          const project = projects.find((item) => item.id === projectMatch[1]);
          if (!project) return json({ error: "project not found" }, 404);
          const tail = projectMatch[2] || "";
          if (tail === "config") return json({ ...project, appId: `pocket.${project.id}`, framework: "solid", entry: "app.tsx", build: 1, tickHz: 60 });
          if (tail === "files") return json({ files: [{ path: "app.tsx" }] });
          if (tail === "files/app.tsx") return json({ path: "app.tsx", content: "export default () => null;", bytes: 27 });
          if (tail === "status") return json({ revision: 1, builtRevision: 1, busy: false, logs: [], artifacts: { generation: "inline" } });
          if (tail === "deploy") return json({ jobs: [] });
          if (tail === "wechat") {
            if (request.method === "POST") {
              const next = { state: "running", targetId: "main", url: new URL(`/wechat-preview/${project.id}/`, url.origin).href, logs: [] };
              wechatStates.set(project.id, next);
              return json(next, 202);
            }
            if (request.method === "DELETE") {
              const next = { state: "stopped", targetId: "main", logs: [] };
              wechatStates.set(project.id, next);
              return json(next);
            }
            return json(wechatStates.get(project.id));
          }
          if (tail === "preview") return previewDocument();
        }
        if (path === "/pocket-embed") return wechatDocument();
        return new Response("not found", { status: 404 });
      },
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    let wechatRequests = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/pocket-embed") wechatRequests += 1; });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator("#preview-frame").waitFor({ state: "visible" });
    await page.locator("#wechat-preview-pane").waitFor({ state: "hidden" });
    expect(await page.locator('#preview-frame').getAttribute('allow')).toBeNull();
    await page.locator('.preview-options > summary').click();
    const bluetoothToggle = page.locator('#web-bluetooth-toggle');
    expect(await bluetoothToggle.isChecked()).toBe(false);
    expect(await bluetoothToggle.isDisabled()).toBe(true);
    await page.locator('.preview-options > summary').click();

    await page.evaluate(() => {
      (window as unknown as { __wechatFrameLoads: number }).__wechatFrameLoads = 0;
      document.getElementById("wechat-preview-frame")?.addEventListener("load", () => {
        const target = window as unknown as { __wechatFrameLoads: number };
        target.__wechatFrameLoads += 1;
      });
    });
    await page.locator("#wechat-start").click();
    await page.locator("#wechat-preview-pane").waitFor({ state: "visible" });
    await page.locator("#wechat-preview-frame").waitFor({ state: "visible" });
    await page.locator("#preview-frame").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("wechat-preview-frame")?.getAttribute("src")?.includes("/pocket-embed") === true);
    await page.waitForFunction(() => {
      const canvas = document.getElementById("preview-stage")!.getBoundingClientRect();
      const wechat = document.getElementById("wechat-preview-pane")!.getBoundingClientRect();
      return Math.abs(canvas.width - wechat.width) <= 1 && Math.abs(canvas.height - wechat.height) <= 1 && Math.abs(canvas.y - wechat.y) <= 1;
    });
    const desktopCanvas = await page.locator("#preview-stage").boundingBox();
    const desktopWechat = await page.locator("#wechat-preview-pane").boundingBox();
    expect(desktopCanvas).not.toBeNull();
    expect(desktopWechat).not.toBeNull();
    expect(desktopWechat!.x).toBeGreaterThan(desktopCanvas!.x + 1);
    expect(Math.abs(desktopWechat!.y - desktopCanvas!.y)).toBeLessThanOrEqual(1);
    await page.locator("#preview-phone-shell").waitFor({ state: "visible" });
    expect(await page.locator("#preview-frame").evaluate((frame) => [frame.style.width, frame.style.height])).toEqual(["375px", "812px"]);
    const shell = await page.locator("#preview-phone-shell").boundingBox();
    expect(Math.abs(shell!.width - desktopCanvas!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(shell!.height - desktopCanvas!.height)).toBeLessThanOrEqual(1);
    expect(await page.locator("#preview-phone-shell").evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    await page.locator("#viewport-picker").selectOption("tablet");
    await page.locator("#preview-phone-shell").waitFor({ state: "hidden" });
    await page.locator("#viewport-picker").selectOption("mobile");
    await page.locator("#preview-phone-shell").waitFor({ state: "visible" });
    const bezelToggle = page.locator("#preview-bezel-toggle");
    expect(await page.locator("#preview-stage").evaluate((element) => element.classList.contains("preview-bezel-enabled"))).toBe(false);
    expect(await page.locator(".preview-surface-label strong").allTextContents()).toEqual(["Flutter", "微信小程序"]);
    await page.waitForTimeout(250);
    const screenBeforeToggle = await page.locator("#preview-stage").boundingBox();
    await bezelToggle.click();
    expect(await page.locator("#preview-stage").evaluate((element) => element.classList.contains("preview-bezel-enabled"))).toBe(true);
    expect(await page.locator("#wechat-preview-shell").evaluate((element) => element.classList.contains("preview-bezel-enabled"))).toBe(true);
    expect(await page.locator("#preview-stage").boundingBox()).toEqual(screenBeforeToggle);
    expect(await page.evaluate(() => localStorage.getItem("pocket.editor.previewShowBezel"))).toBe("1");
    await bezelToggle.click();

    const firstUrl = await page.locator("#wechat-preview-frame").getAttribute("src");
    const firstDatasetUrl = await page.locator("#wechat-preview-frame").evaluate((frame) => frame.dataset.url);
    expect(firstDatasetUrl).toContain("/wechat-preview/inline-a/");
    await page.evaluate((state) => (window as unknown as { __pocketTestRenderWechat: (value: unknown) => void }).__pocketTestRenderWechat(state), {
      state: "running",
      targetId: "main",
      url: firstDatasetUrl,
      logs: [],
    });
    await page.waitForTimeout(100);
    expect(await page.locator("#wechat-preview-frame").getAttribute("src")).toBe(firstUrl);
    expect(await page.evaluate(() => (window as unknown as { __wechatFrameLoads: number }).__wechatFrameLoads)).toBe(1);
    expect(wechatRequests).toBe(1);

    await page.locator("#projects .project-item").nth(1).evaluate((button) => (button as HTMLButtonElement).click());
    await page.waitForFunction(() => document.getElementById("project-title")?.textContent === "Inline B");
    expect(await page.locator("#project-title").textContent()).toBe("Inline B");
    await page.locator("#wechat-preview-pane").waitFor({ state: "hidden" });
    await page.locator("#wechat-preview-frame").waitFor({ state: "hidden" });
    await page.locator("#wechat-start").click();
    await page.locator("#wechat-preview-frame").waitFor({ state: "visible" });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const mobileSurfaces = await page.locator("#preview-surfaces").boundingBox();
    const mobileWrap = await page.locator("#preview-stage-wrap").boundingBox();
    expect(mobileSurfaces).not.toBeNull();
    expect(mobileWrap).not.toBeNull();
    expect(mobileWrap!.x + mobileWrap!.width).toBeLessThanOrEqual(375);
    await page.locator("#wechat-stop").click();
    await page.locator("#wechat-preview-pane").waitFor({ state: "hidden" });
    expect(await page.locator("#wechat-preview-frame").getAttribute("src")).toBe("about:blank");
    nativeBluetoothAvailable = true;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.locator("#preview-frame").waitFor({ state: "visible" });
    await page.locator(".preview-options > summary").click();
    await page.locator("#bluetooth-provider").waitFor({ state: "hidden" });
    expect(await page.locator("#bluetooth-provider").inputValue()).toBe("local");
    expect(await page.locator("#bluetooth-provider-label").textContent()).toBe("Noble 蓝牙");
    expect(await page.locator("#web-bluetooth-toggle").isDisabled()).toBe(false);
    await page.locator("#web-bluetooth-toggle").check();
    await page.locator("#refresh-preview").click();
    await page.waitForFunction(() => document.querySelector("#preview-frame")?.getAttribute("src")?.includes("bluetoothProvider=local"));
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server?.stop(true);
  }
});
