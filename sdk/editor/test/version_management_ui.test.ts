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

const project = { id: "version-ui", name: "Version UI", version: "0.1.0" };
const secondProject = { id: "version-ui-b", name: "Version UI B", version: "0.2.0" };
const status = {
  revision: 7,
  builtRevision: 7,
  busy: false,
  logs: [],
  artifacts: { generation: "version-ui" },
};

function versions(_origin: string, target = project, includeStable = true) {
  const isSecond = target.id === secondProject.id;
  const lanOrigin = "http://192.168.50.20:8791";
  const rootId = isSecond ? "pocket.host.demo.b" : "pocket.host.demo";
  const childIds = isSecond ? ["pocket.demo.profile.b", "pocket.demo.lobby.b"] : ["pocket.demo.profile", "pocket.demo.lobby"];
  const packageIds = [rootId, ...childIds];
  const releaseId = isSecond ? "release-2026-11-06-b-8" : "release-2026-11-06-8";
  const stableReleaseId = isSecond ? "release-2026-11-06-b-stable-9" : "release-2026-11-06-stable-9";
  const oldReleaseId = isSecond ? "release-2026-11-06-b-7" : "release-2026-11-06-7";
  const currentPackageVersion = `${target.version}-test.8`;
  const stablePackageVersion = `${target.version}-stable.9`;
  const currentAppConfig = `${lanOrigin}/test/pocket/3.2.0/${rootId}/latest.json`;
  const immutableAppConfig = (release: string) => `${lanOrigin}/pocket/3.2.0/${rootId}/${release}/host.json`;
  const packageManifest = (id: string, release: string) => `${lanOrigin}/pocket/3.2.0/${id}/${release}/latest.json`;
  const packageHost = (id: string, release: string) => `${lanOrigin}/pocket/3.2.0/${id}/${release}/host.json`;
  const historyEntry = (release: string, version: string, build: number, publishedAt: string, slot = "test") => ({
    id: release,
    slot,
    channel: slot === "test" ? "test" : "release",
    releaseId: release,
    version,
    build,
    revision: build,
    hostVersion: "3.2.0",
    packageVersion: release,
    publishedAt,
    archiveUrl: `/releases/${target.id}/${release}.tar.gz`,
    appConfigUrl: immutableAppConfig(release),
    packages: packageIds.map((id) => ({
      id,
      version: version.replace(/\d+$/, String(build)),
      build,
      updateUrl: packageManifest(id, release),
      manifestUrl: packageManifest(id, release),
      hostConfigUrl: packageHost(id, release),
    })),
  });
  return {
    origin: lanOrigin,
    hostVersion: "3.2.0",
    lan: true,
    appConfigUrl: currentAppConfig,
    current: { test: releaseId, ...(includeStable ? { stable: stableReleaseId } : {}) },
    slots: [
      {
        name: "test",
        releaseId,
        version: currentPackageVersion,
        build: 8,
        archiveUrl: `/releases/${target.id}/${releaseId}.tar.gz`,
        packages: packageIds.map((id) => ({
          id,
          version: currentPackageVersion,
          build: 8,
          manifestUrl: `${lanOrigin}/pocket/3.2.0/${id}/test/latest.json`,
          hostConfigUrl: `${lanOrigin}/pocket/3.2.0/${id}/test/host.json`,
        })),
      },
      {
        name: "stable",
        ...(includeStable ? {
          releaseId: stableReleaseId,
          version: stablePackageVersion,
          build: 9,
          archiveUrl: `/releases/${target.id}/${stableReleaseId}.tar.gz`,
        } : {}),
        packages: includeStable ? packageIds.map((id) => ({
          id,
          version: stablePackageVersion,
          build: 9,
          manifestUrl: `${lanOrigin}/release/pocket/3.2.0/${id}/stable/latest.json`,
          hostConfigUrl: `${lanOrigin}/release/pocket/3.2.0/${id}/stable/host.json`,
        })) : [],
      },
    ],
    history: [
      historyEntry(releaseId, `${target.version}-test.8`, 8, "2026-11-06T08:00:00.000Z"),
      ...(includeStable ? [historyEntry(stableReleaseId, `${target.version}-stable.9`, 9, "2026-11-06T08:30:00.000Z", "stable")] : []),
      historyEntry(oldReleaseId, `${target.version}-test.7`, 7, "2026-11-06T07:00:00.000Z"),
    ],
  };
}

test("version manager renders one app access URL, history archives, and clears stale data after refresh failure", { timeout: 15_000 }, async () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let failVersions = false;
  let delayFirstProjectVersions = false;
  let includeStable = true;
  let versionReads = 0;
  let archiveReads = 0;
  let packageOfflineCalls = 0;
  const publishBodies: Array<Record<string, unknown>> = [];
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
        if (path.startsWith("/releases/")) {
          archiveReads += 1;
          const filename = path.includes("offline")
            ? "version-ui-offline.tar.gz"
            : decodeURIComponent(path.split("/").at(-1) || "archive.tar.gz");
          return new Response("immutable archive", { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename=${filename}` } });
        }
        if (path === "/health") return json({ csrfToken: "version-ui", projectId: project.id, bluetooth: { local: false } });
        if (path === "/api/devices") return json([]);
        if (path === "/api/projects") return json([project, secondProject]);
        const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
        if (!projectMatch || ![project.id, secondProject.id].includes(projectMatch[1])) return new Response("not found", { status: 404 });
        const targetProject = projectMatch[1] === secondProject.id ? secondProject : project;
        const tail = projectMatch[2] || "";
        if (tail === "config") return json({ ...targetProject, appId: targetProject === secondProject ? "pocket.host.demo.b" : "pocket.host.demo", framework: "solid", entry: "app.tsx", build: 8, tickHz: 60 });
        if (tail === "files") return json({ files: [{ path: "app.tsx" }] });
        if (tail === "files/app.tsx") return json({ path: "app.tsx", content: "export default () => null;", bytes: 27 });
        if (tail === "status") return json(status);
        if (tail === "resources") return json({ revision: 7, builtRevision: 7, packages: [] });
        if (tail === "package-offline" && request.method === "POST") {
          packageOfflineCalls += 1;
          return json({ archiveUrl: `/releases/${project.id}/offline.tar.gz`, filename: "version-ui-offline.tar.gz" });
        }
        if (tail === "versions") {
          versionReads += 1;
          if (delayFirstProjectVersions && targetProject === project) await new Promise((resolve) => setTimeout(resolve, 500));
          if (failVersions) return json({ error: "version backend unavailable" }, 503);
          return json(versions("", targetProject, includeStable));
        }
        if (tail === "publish" && request.method === "POST") {
          publishBodies.push(await request.json() as Record<string, unknown>);
          const body = publishBodies.at(-1);
          return json({ status: { ...status, publish: { channel: body?.channel === "test" ? "test" : "release", version: "0.1.0", build: 8, revision: 7 } } });
        }
        if (tail === "preview") {
          return new Response("<!doctype html><script>parent.postMessage({source:'pocket-editor-preview',type:'preview.ready'}, location.origin); parent.postMessage({source:'pocket-editor-preview',type:'preview.frame'}, location.origin);</script>", { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (tail === "wechat") return json({ state: "idle", logs: [] });
        if (tail === "deploy") return json({ jobs: [] });
        return new Response("not found", { status: 404 });
      },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as unknown as { __copiedUrl?: string }).__copiedUrl = value;
          },
        },
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator("#versions-open").waitFor({ state: "attached" });
    await page.locator("#versions-open").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "3 个已发布版本");
    expect(await page.locator("#version-history").isHidden()).toBe(false);
    expect(await page.locator("#version-history-count").textContent()).toBe("3 个发布版本");
    expect(await page.locator("#version-history").textContent()).toContain("release-2026-11-06-8");
    expect(await page.locator("#version-history").textContent()).toContain("release-2026-11-06-stable-9");
    expect(await page.locator("#version-history").textContent()).toContain("release-2026-11-06-7");
    expect(await page.locator("#version-history").textContent()).toContain("测试 · v0.1.0-test.8 · build 8");
    expect(await page.locator("#version-history").textContent()).toContain("稳定版 · v0.1.0-stable.9 · build 9");
    expect(await page.locator("#version-history").textContent()).toContain("v0.1.0-test.7 · build 7");
    const appConfigUrl = "http://192.168.50.20:8791/test/pocket/3.2.0/pocket.host.demo/latest.json";
    expect(await page.locator("#version-app-config").isHidden()).toBe(false);
    expect(await page.locator("#version-app-config-link").getAttribute("href")).toBe(appConfigUrl);
    expect(await page.locator("#version-app-config-link").textContent()).toBe(appConfigUrl);
    expect(await page.locator("#version-slots a.version-download-icon").count()).toBe(2);
    expect(await page.locator("#version-slots a.version-download-icon").nth(0).getAttribute("href")).toBe("/releases/version-ui/release-2026-11-06-8.tar.gz");
    expect(await page.locator("#version-slots a.version-download-icon").nth(1).getAttribute("href")).toBe("/releases/version-ui/release-2026-11-06-stable-9.tar.gz");
    expect(await page.locator("#version-slots .version-download-icon").count()).toBe(2);
    expect(await page.locator("#version-slots .version-copy-url").count()).toBe(0);
    expect(await page.locator("#version-slots").textContent()).toContain("关联 mini app · v0.1.0-test.8 · 构建 8");
    expect(await page.locator("#version-history a[href*='pocket.demo.profile']").count()).toBe(0);
    expect(await page.locator("#version-history a").filter({ hasText: "版本配置" }).count()).toBe(3);
    expect(await page.locator("#version-history a").filter({ hasText: "版本配置" }).nth(0).getAttribute("href")).toBe("http://192.168.50.20:8791/pocket/3.2.0/pocket.host.demo/release-2026-11-06-8/host.json");
    const appConfigCopy = page.locator("#version-app-config-copy");
    await appConfigCopy.click();
    await page.waitForFunction(() => (window as unknown as { __copiedUrl?: string }).__copiedUrl === "http://192.168.50.20:8791/test/pocket/3.2.0/pocket.host.demo/latest.json");
    expect(await appConfigCopy.textContent()).toBe("已复制");
    expect(await page.locator("#version-host-guide").textContent()).toContain("latest.json");
    expect(await page.locator("#version-host-guide").textContent()).not.toContain("host.json");
    expect(await page.locator("#version-host-guide").textContent()).toContain("POCKET_HOST_CONFIG_URL");
    expect(await page.locator('#version-history-list a[download]').count()).toBe(3);
    const testArchiveDownload = page.waitForEvent("download");
    await page.locator("#version-slots a.version-download-icon").nth(0).click();
    expect((await testArchiveDownload).suggestedFilename()).toBe("release-2026-11-06-8.tar.gz");
    const stableArchiveDownload = page.waitForEvent("download");
    await page.locator("#version-slots a.version-download-icon").nth(1).click();
    expect((await stableArchiveDownload).suggestedFilename()).toBe("release-2026-11-06-stable-9.tar.gz");
    const latestArchiveDownload = page.waitForEvent("download");
    await page.locator("#version-history-list .version-history-item").nth(0).locator('a[download]').click();
    expect((await latestArchiveDownload).suggestedFilename()).toBe("release-2026-11-06-8.tar.gz");
    const oldArchiveDownload = page.waitForEvent("download");
    await page.locator("#version-history-list .version-history-item").nth(2).locator('a[download]').click();
    expect((await oldArchiveDownload).suggestedFilename()).toBe("release-2026-11-06-7.tar.gz");
    expect(archiveReads).toBe(4);
    includeStable = false;
    await page.locator("#versions-refresh").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "2 个已发布版本");
    expect(await page.locator("#version-slots .version-download-icon").count()).toBe(2);
    expect(await page.locator("#version-slots a.version-download-icon").count()).toBe(1);
    expect(await page.locator("#version-slots button.version-download-icon").isDisabled()).toBe(true);
    includeStable = true;
    await page.locator("#versions-refresh").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "3 个已发布版本");
    expect(await page.locator("#version-publish-test").isDisabled()).toBe(false);
    expect(await page.locator("#version-publish-release").isDisabled()).toBe(false);
    expect(await page.locator("#version-pack-download").count()).toBe(0);
    expect(packageOfflineCalls).toBe(0);
    expect(publishBodies).toHaveLength(0);

    await page.locator("#version-publish-test").click();
    await page.waitForFunction(() => document.getElementById("notice")?.hidden === false);
    await page.waitForFunction(() => (document.getElementById("version-publish-release") as HTMLButtonElement | null)?.disabled === false);
    expect(publishBodies).toHaveLength(1);
    expect(publishBodies[0]).toEqual({ channel: "test" });
    await page.waitForFunction(() => document.getElementById("version-history-count")?.textContent === "3 个发布版本");

    await page.locator("#version-publish-release").click();
    await page.waitForFunction(() => document.getElementById("notice-message")?.textContent?.includes("稳定版资源包已发布。"));
    await page.waitForFunction(() => (document.getElementById("versions-refresh") as HTMLButtonElement | null)?.disabled === false);
    expect(publishBodies).toHaveLength(2);
    expect(publishBodies[1]).toEqual({});

    failVersions = true;
    await page.locator("#versions-refresh").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "打开后加载");
    expect(await page.locator("#version-history").isHidden()).toBe(true);
    expect(await page.locator("#version-slots").textContent()).toContain("发布测试版或稳定版包");
    expect(versionReads).toBeGreaterThanOrEqual(4);

    // A slow response for the old project must not populate the newly selected project.
    failVersions = false;
    delayFirstProjectVersions = true;
    const readsBeforeSlowRefresh = versionReads;
    await page.locator("#versions-open").click();
    const requestDeadline = Date.now() + 1_000;
    while (versionReads <= readsBeforeSlowRefresh && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(versionReads).toBeGreaterThan(readsBeforeSlowRefresh);
    await page.locator("#project-switcher > summary").click();
    await page.locator("#projects .project-item").nth(1).click();
    await page.waitForFunction(() => document.getElementById("project-title")?.textContent === "Version UI B");
    await page.waitForTimeout(700);
    expect(await page.locator("#version-manager-state").textContent()).toBe("打开后加载");
    expect(await page.locator("#version-history").textContent()).not.toContain("release-2026-11-06-8");
    expect(await page.locator("#version-app-config").isHidden()).toBe(true);
    expect(await page.locator("#version-app-config-copy").isDisabled()).toBe(true);
    delayFirstProjectVersions = false;
    await page.locator("#versions-open").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent === "3 个已发布版本");
    expect(await page.locator("#version-history").textContent()).toContain("release-2026-11-06-b-8");
    expect(await page.locator("#version-history").textContent()).not.toContain("release-2026-11-06-8");
    expect(await page.locator("#version-app-config-link").getAttribute("href")).toBe("http://192.168.50.20:8791/test/pocket/3.2.0/pocket.host.demo.b/latest.json");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server?.stop(true);
  }
});
