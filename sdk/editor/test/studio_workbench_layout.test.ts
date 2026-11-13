import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { previewDevice } from "../preview_device.ts";

const clientRoot = resolve(import.meta.dir, "../client");
const outDir = resolve(import.meta.dir, "../../.pocket-build/studio-redesign-preview");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const previewGuestHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 390px;
    height: 844px;
    overflow: hidden;
    background: #0c1018;
    color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    padding: 54px 16px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .top-bar { display: flex; justify-content: space-between; align-items: center; padding: 0 4px; }
  .top-bar h1 { font-size: 15px; font-weight: 600; color: #f8fafc; }
  .hero {
    height: 168px;
    border-radius: 16px;
    background: radial-gradient(circle at 62% 38%, rgba(251, 191, 36, 0.45), rgba(217, 119, 6, 0.18) 45%, #131b2e 85%);
    border: 1px solid rgba(251, 191, 36, 0.3);
    padding: 18px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    position: relative;
    overflow: hidden;
  }
  .lantern-glow {
    position: absolute;
    top: 22px;
    right: 36px;
    width: 64px;
    height: 82px;
    border-radius: 28px;
    background: linear-gradient(180deg, #fde68a, #f59e0b 65%, #b45309);
    box-shadow: 0 0 42px rgba(251, 191, 36, 0.75);
  }
  .hero strong { font-size: 18px; z-index: 1; }
  .hero span { font-size: 12px; color: #cbd5e1; margin-top: 4px; z-index: 1; }
  .section-head { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; color: #e2e8f0; margin-top: 4px; }
  .section-head a { color: #60a5fa; font-size: 11px; text-decoration: none; }
  .card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    border-radius: 12px;
    background: #151c28;
    border: 1px solid #242f42;
  }
  .card-left { display: flex; align-items: center; gap: 12px; }
  .card-icon {
    width: 46px;
    height: 46px;
    border-radius: 10px;
    background: linear-gradient(135deg, #1e293b, #334155);
    display: grid;
    place-items: center;
    font-size: 20px;
    border: 1px solid rgba(255,255,255,0.08);
  }
  .card-info strong { display: block; font-size: 13px; color: #f8fafc; }
  .card-info small { display: block; font-size: 11px; color: #94a3b8; margin-top: 3px; }
  .badge {
    display: inline-block;
    margin-top: 5px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.16);
    color: #60a5fa;
    font-size: 10px;
    font-family: monospace;
  }
  .card-meta { text-align: right; font-size: 11px; color: #94a3b8; font-family: monospace; }
  .tab-bar {
    margin-top: auto;
    height: 52px;
    border-radius: 14px;
    background: rgba(21, 28, 40, 0.92);
    border: 1px solid #242f42;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    place-items: center;
    font-size: 10px;
    color: #64748b;
  }
  .tab-bar div.active { color: #3b82f6; font-weight: 600; }
</style>
</head>
<body>
  <div class="top-bar"><h1>lantern · 提灯夜行</h1><span>🔔</span></div>
  <div class="hero">
    <div class="lantern-glow"></div>
    <strong>提灯夜行 · 序章</strong>
    <span>QuickJS Bytecode + Flutter 原生图层</span>
  </div>
  <div class="section-head"><span>发现体验</span><a>全部 ›</a></div>
  <div class="card">
    <div class="card-left">
      <div class="card-icon">🏮</div>
      <div class="card-info">
        <strong>提灯夜行</strong>
        <small>国风剧情互动 · 60fps</small>
        <span class="badge">QJBC v1</span>
      </div>
    </div>
    <div class="card-meta">1.8 MB</div>
  </div>
  <div class="card">
    <div class="card-left">
      <div class="card-icon">🏯</div>
      <div class="card-info">
        <strong>长安灯会大厅</strong>
        <small>多人实时房间 · 子包</small>
        <span class="badge">PAK + OTA</span>
      </div>
    </div>
    <div class="card-meta">2.4 MB</div>
  </div>
  <div class="card">
    <div class="card-left">
      <div class="card-icon">🎭</div>
      <div class="card-info">
        <strong>角色立绘衣橱</strong>
        <small>Spine 骨骼与纹理图集</small>
        <span class="badge">按需网络</span>
      </div>
    </div>
    <div class="card-meta">1.2 MB</div>
  </div>
  <div class="tab-bar">
    <div class="active">● 首页</div>
    <div>探索</div>
    <div>背包</div>
    <div>我的</div>
  </div>
  <script>
    setTimeout(() => {
      parent.postMessage({ source: "pocket-editor-preview", type: "preview.ready" }, location.origin);
      parent.postMessage({ source: "pocket-editor-preview", type: "preview.frame" }, location.origin);
    }, 30);
  </script>
</body>
</html>`;

const sampleTsx = `import { createSignal } from "solid-js";
import { View, Text, Image, Button } from "@pocket/ui";

export default function LanternShowcaseApp() {
  const [chapter, setChapter] = createSignal(1);
  const [lanternLit, setLanternLit] = createSignal(true);

  return (
    <View style={{ padding: 16, gap: 12, backgroundColor: "#0c1018" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 16, fontWeight: "700", color: "#f8fafc" }}>
          lantern · 提灯夜行
        </Text>
        <Text style={{ fontSize: 12, color: "#34d399" }}>
          Chapter #{chapter()}
        </Text>
      </View>
      <Image src="assets/hero_lantern.png" style={{ height: 168, borderRadius: 16 }} />
      <Button
        title={lanternLit() ? "掌灯巡游" : "点亮提灯"}
        onPress={() => {
          setLanternLit((v) => !v);
          setChapter((c) => c + 1);
        }}
      />
    </View>
  );
}
`;

const svgHero1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" rx="8" fill="#131c2e"/><circle cx="80" cy="42" r="24" fill="#f59e0b" fill-opacity="0.25"/><circle cx="80" cy="42" r="14" fill="#fbbf24"/><text x="80" y="78" font-family="monospace" font-size="10" fill="#94a3b8" text-anchor="middle">hero_lantern.png</text></svg>`;
const svgHero2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" rx="8" fill="#111f24"/><rect x="44" y="18" width="72" height="40" rx="6" fill="#10b981" fill-opacity="0.3" stroke="#34d399"/><text x="80" y="78" font-family="monospace" font-size="10" fill="#94a3b8" text-anchor="middle">lobby_bg.webp</text></svg>`;

test("Pocket Studio workbench and source-mode SDK auto-upgrade stay available through dirty deferral", async () => {
  mkdirSync(outDir, { recursive: true });
  let wechatRunning = false;
  const studioUpgradeChecks: Array<{ autoApply?: boolean; forceApply?: boolean }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/editor.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/editor.js") return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/api/preview/device") return json({ ...previewDevice, model: "iPhone 16 Pro", screenWidth: 390, screenHeight: 844 });
      if (path === "/previews/hero1.svg") return new Response(svgHero1, { headers: { "content-type": "image/svg+xml" } });
      if (path === "/previews/hero2.svg") return new Response(svgHero2, { headers: { "content-type": "image/svg+xml" } });
      if (path === "/health") return json({ ok: true, service: "pocket-editor", version: "0.1.12", csrfToken: "cap", projectId: "lantern-showcase", bluetooth: { local: true } });
      if (path === "/api/studio/upgrade/check" && req.method === "POST") {
        studioUpgradeChecks.push(await req.json() as { autoApply?: boolean; forceApply?: boolean });
        return json({
          currentVersion: "0.1.12",
          latestVersion: "0.1.13",
          status: "available",
          mode: "source",
          autoUpgradeSupported: true,
          upgradeAvailable: true,
        });
      }
      if (path === "/api/studio/upgrade") {
        return json({
          currentVersion: "0.1.12",
          latestVersion: "0.1.13",
          status: "available",
          mode: "source",
          autoUpgradeSupported: true,
          upgradeAvailable: true,
        });
      }
      if (path === "/api/devices") {
        return json([
          { id: "iphone-16-pro", name: "iPhone 16 Pro", platform: "iOS 18.2", emulator: true, supported: true, available: true },
        ]);
      }
      if (path === "/api/projects") {
        return json([
          { id: "lantern-showcase", name: "lantern-showcase", version: "1.4.2" },
          { id: "campus-club", name: "campus-club", version: "0.3.0" },
        ]);
      }
      if (path.startsWith("/api/projects/lantern-showcase")) {
        const tail = path.replace("/api/projects/lantern-showcase", "").replace(/^\//, "");
        if (tail === "config") {
          return json({
            id: "lantern-showcase",
            name: "lantern-showcase",
            appId: "pocket.lantern.showcase",
            framework: "solid",
            entry: "app.tsx",
            version: "1.4.2",
            build: 18,
            tickHz: 60,
          });
        }
        if (tail === "files") return json({ files: [{ path: "app.tsx" }, { path: "manifest.json" }] });
        if (tail === "files/app.tsx") return json({ path: "app.tsx", content: sampleTsx, bytes: 3480 });
        if (tail === "status") {
          return json({
            revision: 18,
            builtRevision: 18,
            busy: false,
            logs: [
              "[16:01:42] QuickJS bytecode compiled in 84ms · ABI verified (quickjs-bytecode-v1)",
              "[16:01:43] Bundle packaging completed · app.qjbc (142.4 KB) + app.pak (1.82 MB)",
              "[16:01:43] Ready for Flutter native canvas & WeChat WASM preview.",
            ],
            artifacts: {
              generation: "g18",
              bytecode: "/artifacts/app.qjbc",
              metadata: "/artifacts/app.bytecode.json",
              pak: "/artifacts/app.pak",
              manifest: "/artifacts/guest-manifest.json",
            },
            publish: {
              runtimeAbi: "quickjs-v1",
              channel: "test",
              version: "1.4.2-beta.3",
              build: 18,
              revision: 18,
              lanOrigin: "http://192.168.50.20:8791",
            },
          });
        }
        if (tail === "resources") {
          return json({
            revision: 18,
            builtRevision: 18,
            packages: [
              {
                id: "pocket.lantern.showcase",
                title: "main · 主包",
                manifest: "pocket.json",
                resources: [
                  { key: "assets/hero_lantern.png", kind: "asset", bytes: 188416, placement: "pak", previewUrl: "/previews/hero1.svg" },
                  { key: "assets/lobby_bg.webp", kind: "asset", bytes: 425984, placement: "network", previewUrl: "/previews/hero2.svg" },
                  { key: "fonts/lantern_serif.otf", kind: "pak", bytes: 98304, placement: "pak", locked: true, reason: "Required font" },
                  { key: "pak:ui:font.0", kind: "pak", bytes: 24576, placement: "pak", locked: true },
                ],
              },
              {
                id: "pocket.lantern.lobby",
                title: "lobby · 大厅",
                manifest: "apps/lobby/pocket.json",
                resources: [
                  { key: "assets/lobby_banner.png", kind: "asset", bytes: 131072, placement: "network", previewUrl: "/previews/hero2.svg" },
                ],
              },
            ],
          });
        }
        if (tail === "versions") {
          return json({
            origin: "http://192.168.50.20:8791",
            hostVersion: "3.2.0",
            lan: true,
            appConfigUrl: "http://192.168.50.20:8791/test/pocket/3.2.0/pocket.lantern.showcase/latest.json",
            slots: [
              {
                name: "test",
                releaseId: "release-1.4.2-beta.3",
                version: "1.4.2-beta.3",
                build: 18,
                archiveUrl: "/releases/test.tar.gz",
                packages: [
                  { id: "pocket.lantern.showcase", version: "1.4.2-beta.3", build: 18 },
                  { id: "pocket.lantern.lobby", version: "1.4.2-beta.3", build: 18 },
                ],
              },
              {
                name: "stable",
                releaseId: "release-1.4.1-stable",
                version: "1.4.1",
                build: 15,
                archiveUrl: "/releases/stable.tar.gz",
                packages: [
                  { id: "pocket.lantern.showcase", version: "1.4.1", build: 15 },
                ],
              },
            ],
            history: [
              {
                id: "release-1.4.2-beta.3",
                releaseId: "release-1.4.2-beta.3",
                channel: "test",
                slot: "test",
                version: "1.4.2-beta.3",
                build: 18,
                publishedAt: "2026-11-11 16:00",
                archiveUrl: "/releases/test.tar.gz",
                appConfigUrl: "http://192.168.50.20:8791/pocket/3.2.0/pocket.lantern.showcase/release-1.4.2-beta.3/host.json",
                packages: [{ id: "pocket.lantern.showcase", version: "1.4.2-beta.3", build: 18 }],
              },
              {
                id: "release-1.4.1-stable",
                releaseId: "release-1.4.1-stable",
                channel: "release",
                slot: "stable",
                version: "1.4.1",
                build: 15,
                publishedAt: "2026-11-10 20:15",
                archiveUrl: "/releases/stable.tar.gz",
                appConfigUrl: "http://192.168.50.20:8791/pocket/3.2.0/pocket.lantern.showcase/release-1.4.1-stable/host.json",
                packages: [{ id: "pocket.lantern.showcase", version: "1.4.1", build: 15 }],
              },
            ],
          });
        }
        if (tail === "deploy") return json({ jobs: [] });
        if (tail === "wechat") {
          if (req.method === "POST") wechatRunning = true;
          return json(
            wechatRunning
              ? { state: "running", targetId: "main", url: `http://127.0.0.1:${server.port}/wechat-sim`, logs: [] }
              : { state: "idle", logs: [] },
          );
        }
        if (tail === "preview") return new Response(previewGuestHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path === "/pocket-embed") return new Response(previewGuestHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator("#preview-frame").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("preview-state")?.classList.contains("ready"));
    await page.locator("#preview-bezel-toggle").click();
    await page.waitForTimeout(200);

    // 1. Verify 100dvh fixed workbench layout without document scrollbars
    const rootScroll = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      resourcesOpen: (document.getElementById("resources-panel") as HTMLDetailsElement)?.open,
      versionsOpen: (document.getElementById("version-manager") as HTMLDetailsElement)?.open,
      sourceDockHidden: document.getElementById("source-dock")?.hidden,
    }));
    expect(rootScroll.scrollHeight).toBeLessThanOrEqual(rootScroll.clientHeight + 1);
    expect(rootScroll.resourcesOpen).toBe(true);
    expect(rootScroll.versionsOpen).toBe(false);
    expect(rootScroll.sourceDockHidden).toBe(true);

    // Save main workbench screenshot
    await page.screenshot({ path: join(outDir, "03_live_implemented_main.png") });

    // 2. Toggle docked source split, start WeChat inline preview, and open Versions OTA inspector
    await page.locator("#source-split-toggle").click();
    expect(await page.locator("#source-dock").isVisible()).toBe(true);
    await page.waitForFunction(() => (document.getElementById("studio-upgrade-status")?.textContent || "").includes("发现新版本 v0.1.13"));
    expect(await page.locator("#studio-upgrade-action").textContent()).toBe("立即升级");
    expect(studioUpgradeChecks[0]).toEqual({ autoApply: true, forceApply: false });

    const cleanCheck = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/studio/upgrade/check");
    await page.locator("#studio-upgrade-action").click();
    await cleanCheck;
    expect(studioUpgradeChecks.at(-1)).toEqual({ autoApply: true, forceApply: true });

    await page.locator("#source").waitFor({ state: "visible" });
    const savedSource = await page.locator("#source").inputValue();
    await page.locator("#source").fill(`${savedSource}\n// unsaved editor draft`);
    await page.waitForFunction(() => !(document.getElementById("save") as HTMLButtonElement).disabled);
    const checksBeforeDirtyClick = studioUpgradeChecks.length;
    await page.locator("#studio-upgrade-action").click();
    await page.waitForFunction(() => (document.getElementById("studio-upgrade-status")?.textContent || "").includes("未保存修改"));
    expect(studioUpgradeChecks.length).toBe(checksBeforeDirtyClick);

    await page.locator("#wechat-start").click();
    await page.locator("#wechat-preview-frame").waitFor({ state: "visible" });
    await page.locator("#versions-open").click();
    await page.waitForFunction(() => document.getElementById("version-manager-state")?.textContent?.includes("已发布版本"));
    await page.waitForTimeout(250);

    // Save split workbench screenshot
    await page.screenshot({ path: join(outDir, "04_live_implemented_split.png") });

    // 3. Verify console tab switching, #console-collapse-toggle aria-expanded & Cmd+J collapse shortcut
    await page.locator("#console-tab-artifacts").click();
    expect(await page.locator("#console-pane-artifacts").isVisible()).toBe(true);
    await page.locator("#console-tab-build").click();
    expect(await page.locator("#console-collapse-toggle").getAttribute("aria-expanded")).toBe("true");
    await page.locator("#console-collapse-toggle").click();
    expect(await page.locator("#console-dock").evaluate((el) => el.classList.contains("collapsed"))).toBe(true);
    expect(await page.locator("#console-collapse-toggle").getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Control+j");
    expect(await page.locator("#console-dock").evaluate((el) => el.classList.contains("collapsed"))).toBe(false);
    expect(await page.locator("#console-collapse-toggle").getAttribute("aria-expanded")).toBe("true");

    // 4. Verify Cmd/Ctrl + E toggles #source-dock & modal dialog blocks background shortcuts
    await page.keyboard.press("Control+e");
    expect(await page.locator("#source-dock").isVisible()).toBe(false);
    await page.keyboard.press("Meta+e");
    expect(await page.locator("#source-dock").isVisible()).toBe(true);

    await page.locator("#new-project").click();
    expect(await page.locator("#create-dialog").evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);
    await page.keyboard.press("Meta+e");
    expect(await page.locator("#source-dock").isVisible()).toBe(true);
    await page.keyboard.press("Meta+j");
    expect(await page.locator("#console-dock").evaluate((el) => el.classList.contains("collapsed"))).toBe(false);
    await page.locator("#cancel-create").click();
    expect(await page.locator("#create-dialog").evaluate((el) => (el as HTMLDialogElement).open)).toBe(false);

    // 5. Verify native <summary> close clears inspector tab aria-selected and activity rail aria-pressed, and re-opening restores them
    expect(await page.locator("#version-manager").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await page.locator("#version-manager > summary").click();
    expect(await page.locator("#version-manager").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    const clearedState = await page.evaluate(() => ({
      selectedTabs: Array.from(document.querySelectorAll(".inspector-tab")).filter((el) => el.getAttribute("aria-selected") === "true" || el.classList.contains("active")).length,
      pressedRails: ["#rail-resources", "#rail-versions", "#rail-settings"].filter((sel) => {
        const el = document.querySelector(sel);
        return el?.getAttribute("aria-pressed") === "true" || el?.classList.contains("active");
      }).length,
    }));
    expect(clearedState.selectedTabs).toBe(0);
    expect(clearedState.pressedRails).toBe(0);

    await page.locator("#inspector-tab-resources").click();
    expect(await page.locator("#resources-panel").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator("#inspector-tab-resources").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#rail-resources").getAttribute("aria-pressed")).toBe("true");

    // 6. Verify #resize-preview-height keyboard Home (240) and pointer drag (> 600 without clamping #preview-stage-wrap)
    const resizer = page.locator("#resize-preview-height");
    await resizer.focus();
    await page.keyboard.press("Home");
    expect(await resizer.getAttribute("aria-valuenow")).toBe("240");
    const minStageHeight = await page.locator("#preview-stage").evaluate((el) => el.getBoundingClientRect().height);
    expect(minStageHeight).toBeLessThan(240);

    const handleBox = await resizer.boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      const cx = handleBox.x + handleBox.width / 2;
      const cy = handleBox.y + handleBox.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy + 420, { steps: 8 });
      await page.mouse.up();
    }
    const draggedVal = Number(await resizer.getAttribute("aria-valuenow"));
    expect(draggedVal).toBeGreaterThan(600);
    const wrapHeight = await page.locator("#preview-stage-wrap").evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(wrapHeight).toBeGreaterThanOrEqual(draggedVal - 2);

    // 7. Verify narrow viewport (800×900, hitting @media (max-width: 980px)) collapses .activity-rail into horizontal strip cleanly without throwing JS errors
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(100);
    const railDirection = await page.locator(".activity-rail").evaluate((el) => getComputedStyle(el).flexDirection);
    expect(railDirection).toBe("row");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
