import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { previewDevice } from "../preview_device.ts";

// legacy-resource-api-test

const clientRoot = resolve(import.meta.dir, "../client");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function previewDocument(): Response {
  return new Response(`<!doctype html><body><script>
    parent.postMessage({ source: "pocket-editor-preview", type: "preview.ready" }, location.origin);
    parent.postMessage({ source: "pocket-editor-preview", type: "preview.frame" }, location.origin);
  </script></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

test("Editor edits package resource delivery and retains saved values per mini-app", async () => {
  const project = { id: "resources-app", name: "Resources App", version: "0.1.0" };
  const inventory = {
    revision: 7,
    builtRevision: 7,
    packages: [
      {
        id: "pocket.demo.profile",
        title: "Profile",
        manifest: "apps/profile/pocket.json",
        updateUrl: "/updates/profile/latest.json",
        hostConfigUrl: "/updates/profile/host.json",
        resources: [
          { key: "pak:profile.avatar", kind: "pak", bytes: 128, placement: "pak", previewUrl: "/previews/profile-avatar.svg" },
          { key: "asset:profile.video", kind: "asset", bytes: 2048, placement: "network", previewUrl: "https://evil.example/video.png" },
          { key: "pak:required.font", kind: "pak", bytes: 32, placement: "pak", locked: true, reason: "Required font" },
          { key: "pak:ui:font.10", kind: "pak", bytes: 40, placement: "pak", locked: true },
          { key: "pak:ui:font.2", kind: "pak", bytes: 40, placement: "pak", locked: true },
          { key: "pak:ui:font.0", kind: "pak", bytes: 40, placement: "pak", locked: true },
          { key: "pak:ui:font.1", kind: "pak", bytes: 40, placement: "pak", locked: true },
        ],
      },
      {
        id: "pocket.demo.lobby",
        title: "Lobby",
        manifest: "apps/lobby/pocket.json",
        resources: [{ key: "asset:lobby.background", kind: "asset", bytes: 512, placement: "pak" }],
      },
    ],
  };
  const putRequests: Array<Record<string, unknown>> = [];
  let legacyBackend = false;
  let catalogOnly = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (path === "/editor.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
        if (path === "/editor.js") return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
        if (path === "/api/preview/device") return json(previewDevice);
        if (path === "/previews/profile-avatar.svg") return new Response("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 2 2\"><rect width=\"2\" height=\"2\" fill=\"#73e2c4\"/></svg>", { headers: { "content-type": "image/svg+xml" } });
        if (path === "/health") return json({ csrfToken: "resources-ui", projectId: project.id, bluetooth: { local: false } });
        if (path === "/api/devices") return json([]);
        if (path === "/api/projects") return json([project]);
        const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
        if (projectMatch && projectMatch[1] === project.id) {
          const tail = projectMatch[2] || "";
          if (tail === "config") return json({ ...project, appId: "pocket.resources", framework: "solid", entry: "app.tsx", build: 1, tickHz: 60 });
          if (tail === "files") return json({ files: [{ path: "app.tsx" }] });
          if (tail === "files/app.tsx") return json({ path: "app.tsx", content: "export default () => null;", bytes: 27 });
          if (tail === "status") return json({ revision: 7, builtRevision: 7, busy: false, logs: [], artifacts: { generation: "resources-ui" } });
          if (tail === "versions") return json({
            origin: `http://192.168.50.20:${server!.port}`,
            hostVersion: "3.2.0",
            lan: true,
            appConfigUrl: `http://192.168.50.20:${server!.port}/test/pocket/3.2.0/pocket.resources/latest.json`,
            slots: [
              { name: "test", packages: [{ id: "pocket.resources", version: "0.1.0-test.8", build: 8, manifestUrl: "/pocket/3.2.0/pocket.resources/test/latest.json", hostConfigUrl: "/pocket/3.2.0/pocket.resources/test/host.json" }] },
              { name: "stable", packages: [] },
            ],
          });
          if (tail === "preview") return previewDocument();
          if (tail === "deploy") return json({ jobs: [] });
          if (tail === "wechat") return json({ state: "idle", logs: [] });
          if (tail === "resources") {
            if (legacyBackend) return json({ error: "not found" }, 404);
            if (catalogOnly) return json({ revision: 7, packages: inventory.packages.map(entry => ({ ...entry, resources: [] })) });
            if (request.method === "PUT") {
              const body = await request.json() as Record<string, unknown>;
              putRequests.push(body);
              const packageId = String(body.packageId || "");
              const placements = Array.isArray(body.placements) ? body.placements as Array<Record<string, unknown>> : [];
              const target = inventory.packages.find((entry) => entry.id === packageId);
              if (target) {
                for (const resource of target.resources) {
                  const next = placements.find((entry) => entry.key === resource.key)?.placement;
                  if (!resource.locked && (next === "pak" || next === "network")) resource.placement = next;
                }
              }
              inventory.revision += 1;
            }
            return json(inventory);
          }
        }
        return new Response("not found", { status: 404 });
      },
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator("#resource-package-picker").waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelectorAll("#resource-package-picker option").length === 2);
    await page.locator("#versions-open").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "1 个资源包");
    expect(await page.locator("#version-backend-origin").textContent()).toContain("192.168.50.20");
    expect(await page.locator("#version-manager").textContent()).toContain("0.1.0-test.8");
    expect(await page.locator("#version-app-config-link").getAttribute("href")).toContain("/test/pocket/3.2.0/pocket.resources/latest.json");
    await page.locator("#resources-panel > summary").click();
    expect(await page.locator("#resource-package-picker option").allTextContents()).toEqual([
      "Profile · pocket.demo.profile",
      "Lobby · pocket.demo.lobby",
    ]);
    expect(await page.locator("#resource-package-list .resource-package-button").count()).toBe(2);
    expect(await page.locator("#resource-package-list .resource-package-button[aria-pressed=\"true\"]").textContent()).toContain("Profile");
    expect(await page.locator("#resource-package-meta a").count()).toBe(0);

    const profileAvatar = page.locator('select[data-resource-key="pak:profile.avatar"]');
    const requiredFont = page.locator('.resource-row[data-resource-key="pak:required.font"]');
    expect(await requiredFont.locator("select").count()).toBe(0);
    expect(await requiredFont.locator(".resource-required-badge").textContent()).toContain("基础包 · 必需");
    expect(await page.locator('.resource-preview-image[alt="资源预览：pak:profile.avatar"]').count()).toBe(1);
    expect(await page.locator('.resource-row:has-text("asset:profile.video") .resource-preview-image').count()).toBe(0);
    const fontCards = page.locator('.resource-row[data-resource-key^="pak:ui:font."]');
    const fontKeys = await fontCards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-resource-key")));
    expect(fontKeys).toEqual(["pak:ui:font.0", "pak:ui:font.1", "pak:ui:font.2", "pak:ui:font.10"]);
    expect(await fontCards.locator(".resource-preview").count()).toBe(0);
    const fontHeight = await fontCards.first().evaluate(node => node.getBoundingClientRect().height);
    const imageHeight = await page.locator('.resource-row[data-resource-key="pak:profile.avatar"]').evaluate(node => node.getBoundingClientRect().height);
    expect(fontHeight).toBeLessThan(imageHeight);
    expect(await profileAvatar.evaluate(node => parseFloat(getComputedStyle(node).paddingRight))).toBeGreaterThanOrEqual(24);
    await profileAvatar.selectOption("network");
    expect(await page.locator("#save-resources").isDisabled()).toBe(false);
    expect(await page.locator("#resources-state").textContent()).toBe("策略未保存");
    await page.locator("#save-resources").click();
    await page.waitForFunction(() => document.getElementById("save-resources")?.hasAttribute("disabled") === true);
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0]).toMatchObject({ revision: 7, packageId: "pocket.demo.profile" });
    expect((putRequests[0]!.placements as Array<Record<string, unknown>>).find((entry) => entry.key === "pak:profile.avatar")?.placement).toBe("network");

    await page.locator("#resource-package-list button[data-package-id=\"pocket.demo.lobby\"]").click();
    expect(await page.locator('select[data-resource-key="asset:lobby.background"]').inputValue()).toBe("pak");
    expect(await page.locator("#resource-package-picker").inputValue()).toBe("pocket.demo.lobby");
    await page.locator("#resource-package-picker").selectOption("pocket.demo.profile");
    expect(await profileAvatar.inputValue()).toBe("network");
    legacyBackend = true;
    const errorPage = await browser.newPage();
    await errorPage.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
    await errorPage.waitForFunction(() => document.getElementById("resources-state")?.textContent === "不可用");
    expect(await errorPage.locator("#resources-panel").textContent()).toContain("编辑器后端版本过旧，请重启编辑器服务并刷新页面。");
    await errorPage.close();
    legacyBackend = false;
    catalogOnly = true;
    const catalogPage = await browser.newPage();
    await catalogPage.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
    await catalogPage.waitForFunction(() => document.querySelectorAll("#resource-package-picker option").length === 2);
    expect(await catalogPage.locator("#resources-panel .resource-empty").textContent()).toContain("请先构建项目以生成此资源包的 PAK 和签名网络资源清单。");
    await catalogPage.close();
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server?.stop(true);
  }
});
