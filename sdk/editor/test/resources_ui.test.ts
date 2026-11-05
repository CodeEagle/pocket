import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { previewDevice } from "../preview_device.ts";

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
    packages: [
      {
        id: "pocket.demo.profile",
        title: "Profile",
        manifest: "apps/profile/pocket.json",
        updateUrl: "/updates/profile/latest.json",
        hostConfigUrl: "/updates/profile/host.json",
        resources: [
          { key: "pak:profile.avatar", kind: "pak", bytes: 128, placement: "pak" },
          { key: "asset:profile.video", kind: "asset", bytes: 2048, placement: "network" },
          { key: "pak:required.font", kind: "pak", bytes: 32, placement: "pak", locked: true, reason: "Required font" },
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
          if (tail === "preview") return previewDocument();
          if (tail === "deploy") return json({ jobs: [] });
          if (tail === "wechat") return json({ state: "idle", logs: [] });
          if (tail === "resources") {
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
    await page.locator("#resources-panel > summary").click();
    expect(await page.locator("#resource-package-picker option").allTextContents()).toEqual([
      "Profile · pocket.demo.profile",
      "Lobby · pocket.demo.lobby",
    ]);
    expect(await page.locator('a:has-text("Update manifest")').getAttribute("href")).toBe("/updates/profile/latest.json");

    const profileAvatar = page.locator('select[data-resource-key="pak:profile.avatar"]');
    const requiredFont = page.locator('select[data-resource-key="pak:required.font"]');
    expect(await requiredFont.isDisabled()).toBe(true);
    expect(await page.locator(".resource-row-reason").allTextContents()).toContain("Required font");
    await profileAvatar.selectOption("network");
    expect(await page.locator("#save-resources").isDisabled()).toBe(false);
    expect(await page.locator("#resources-state").textContent()).toBe("Unsaved policy");
    await page.locator("#save-resources").click();
    await page.waitForFunction(() => document.getElementById("save-resources")?.hasAttribute("disabled") === true);
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0]).toMatchObject({ revision: 7, packageId: "pocket.demo.profile" });
    expect((putRequests[0]!.placements as Array<Record<string, unknown>>).find((entry) => entry.key === "pak:profile.avatar")?.placement).toBe("network");

    await page.locator("#resource-package-picker").selectOption("pocket.demo.lobby");
    expect(await page.locator('select[data-resource-key="asset:lobby.background"]').inputValue()).toBe("pak");
    await page.locator("#resource-package-picker").selectOption("pocket.demo.profile");
    expect(await profileAvatar.inputValue()).toBe("network");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server?.stop(true);
  }
});
