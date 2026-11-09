import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { extname, join, resolve, sep } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildWeb } from "../build_web.ts";

/*
 * This is a maintainer integration gate for the optional render Worker. It
 * deliberately uses one compiled QJBC/PAK pair for both modes so the A/B
 * comparison measures placement of the renderer, not a second app build.
 */
test.skipIf(!process.env.POCKET_WEB_ENGINE || !process.env.POCKET_WEB_RUNTIME)(
  "the same QJBC renders on the main thread and an OffscreenCanvas Worker",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pocket-render-worker-browser-"));
    const project = join(root, "project");
    const output = join(root, "web");
    mkdirSync(project);
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      id: "pocket.test.render-worker",
      app: { entry: "app.tsx" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      capabilities: { requires: ["platform.storage", "test.render.capability"] },
    }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

function App() {
  const [presses, setPresses] = createSignal(0);
  const [frames, setFrames] = createSignal(0);
  const [storageState, setStorageState] = createSignal("storage-pending");
  const [capabilityState, setCapabilityState] = createSignal("capability-pending");
  const [imeState, setImeState] = createSignal("ime-pending");
  const send = (requestId: string, capability: string, params: Record<string, unknown>) =>
    (globalThis as any).pocket?._emitValue?.({
      type: "event", name: "host.request", payload: { requestId, capability, params },
    });
  const previousDeliver = (globalThis as any).__pocketDeliver;
  (globalThis as any).__pocketDeliver = (packet: any) => {
    previousDeliver?.(packet);
    const payload = packet?.payload;
    if (packet?.type !== "event" || packet?.name !== "host.response" || !payload) return;
    if (payload.requestId === "render-storage" && payload.ok) {
      send("render-storage-get", "platform.storage.get", { namespace: "render-worker", key: "probe" });
    }
    if (payload.requestId === "render-storage-get" && payload.ok && payload.result?.value === "ok") setStorageState("storage-ok");
    if (payload.requestId === "render-capability" && payload.ok && payload.result?.ok === false && payload.result?.result === "opaque") setCapabilityState("capability-ok");
  };
  const previousTextEvent = (globalThis as any).__pocketTextInputEvent;
  (globalThis as any).__pocketTextInputEvent = (method: string, payload: any) => {
    previousTextEvent?.(method, payload);
    if (method === "textInput.edit" && payload?.text === "worker-ime") setImeState("ime-ok");
    return true;
  };
  let requested = false;
  onButtonPress(BTN.CROSS, () => setPresses(value => value + 1));
  onFrame(() => {
    setFrames(value => value + 1);
    if (requested) return;
    requested = true;
    send("render-storage", "platform.storage.set", { namespace: "render-worker", key: "probe", value: { value: "ok" } });
    send("render-capability", "test.render.capability", { value: "render-worker" });
    (globalThis as any).pocket?._emitValue?.({
      type: "event", name: "textInput.open", payload: {
        id: "render-worker-ime", editingSession: "render-worker-session", revision: 1,
        jsRevision: 1, text: "", selectionExtent: 0, placeholder: "boundary",
        action: "done", rect: { left: 4, top: 4, width: 120, height: 32 },
      },
    });
  });
  return <View class="w-full h-full flex-col bg-[#101828] p-4 gap-2">
    <Text class="text-xl text-white">{"render-worker-fixture presses=" + presses() + " frames=" + frames() + " " + storageState() + " " + capabilityState() + " " + imeState()}</Text>
  </View>;
}
mount(() => <App />);
`);

    const runtimePath = process.env.POCKET_WEB_RUNTIME;
    if (!runtimePath) throw new Error("POCKET_WEB_RUNTIME is required");
    await buildWeb({
      projectRoot: project,
      outDir: output,
      enginePath: process.env.POCKET_WEB_ENGINE,
      runtimePath,
    });

    expect(JSON.parse(readFileSync(join(output, "pocket.config.json"), "utf8")).renderWorker).toBe(false);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname === "/") {
          const requestedMode = requestUrl.searchParams.get("mode");
          const mode = requestedMode === "worker" || requestedMode === "unsupported" ? requestedMode : "main";
          return new Response(`<!doctype html>
<style>html,body{margin:0;width:100%;height:100%;background:#000}canvas{width:360px;height:240px;display:block}</style>
<canvas id="pocket" tabindex="0"></canvas>
<script type="module">
  import { PocketWebRuntime, registerCapability, setPermissionHandler } from '/pocket-web.js';
  window.errors = [];
  window.wasmInstantiates = 0;
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function(...args) {
    window.wasmInstantiates++;
    return instantiate.apply(this, args);
  };
  const config = await fetch('/pocket.config.json').then(response => response.json());
  ${mode === "main" ? "delete config.renderWorker; // Exercise the runtime default as well as the builder default." : ""}
  registerCapability('test.render.capability', async _params => ({ ok: false, result: 'opaque' }));
  setPermissionHandler(() => true);
  const canvas = document.querySelector('#pocket');
  if (new URL(location.href).searchParams.get('mode') === 'unsupported') {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: undefined });
  }
  try {
    window.runtime = new PocketWebRuntime({
      canvas,
      engineUrl: '/engine/pocketjs.wasm',
      qjbcUrl: '/app.qjbc',
      pakUrl: '/app.pak',
      config,
      gameInput: true,
      ${mode === "main" ? "" : "renderWorker: true,"}
      renderWorkerUrl: '/pocket-render-worker.js',
      onError: error => window.errors.push(String(error?.message || error)),
    });
    window.runtime.mount().then(() => window.ready = true).catch(error => {
      window.errors.push(String(error?.message || error));
      window.failed = true;
    });
  } catch (error) {
    window.errors.push(String(error?.message || error));
    window.failed = true;
  }
</script>`, { headers: { "content-type": "text/html" } });
        }
        const file = resolve(output, `.${decodeURIComponent(requestUrl.pathname)}`);
        if (!file.startsWith(output + sep)) return new Response("forbidden", { status: 403 });
        const suffix = extname(file);
        const contentType = suffix === ".js" ? "text/javascript" : suffix === ".wasm" ? "application/wasm" :
          suffix === ".json" ? "application/json" : "application/octet-stream";
        return new Response(Bun.file(file), { headers: { "content-type": contentType } });
      },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    const inspectTexts = async (page: any) =>
      page.evaluate(async () => {
        const snapshot = await (window as any).runtime.inspect();
        const values: string[] = [];
        const visit = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (typeof node.text === "string") values.push(node.text);
          if (Array.isArray(node.children)) node.children.forEach(visit);
        };
        if (Array.isArray(snapshot?.nodes)) snapshot.nodes.forEach(visit);
        else visit(snapshot);
        return { snapshot, values };
      });

    const runMode = async (mode: "main" | "worker") => {
      const page = await browser!.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?mode=${mode}`);
      await page.waitForFunction(() => (window as any).ready || (window as any).failed, { timeout: 30_000 });
      expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
      expect(await page.evaluate(() => (window as any).failed)).not.toBe(true);
      const initial = createHash("sha256").update(await page.locator("canvas").screenshot()).digest("hex");
      const before = await inspectTexts(page);
      expect(before.values.some(value => value.includes("render-worker-fixture presses=0"))).toBe(true);
      await page.waitForFunction(async () => {
        const result = JSON.stringify(await (window as any).runtime.inspect());
        return result.includes("storage-ok") && result.includes("capability-ok");
      }, { timeout: 10_000 });
      const boundaryTexts = await inspectTexts(page);
      expect(boundaryTexts.values.some(value => value.includes("storage-ok"))).toBe(true);
      expect(boundaryTexts.values.some(value => value.includes("capability-ok"))).toBe(true);
      const input = page.locator("input");
      await input.waitFor({ state: "visible" });
      await input.fill("worker-ime");
      await input.press("Enter");
      await page.waitForFunction(async () => JSON.stringify(await (window as any).runtime.inspect()).includes("ime-ok"), { timeout: 10_000 });
      await page.locator("canvas").focus();
      await page.keyboard.press("z");
      await page.waitForFunction(async () => {
        const result = await (window as any).runtime.inspect();
        return JSON.stringify(result).includes("presses=1");
      }, { timeout: 10_000 });
      const final = await inspectTexts(page);
      expect(final.values.some(value => value.includes("presses=1"))).toBe(true);
      expect(createHash("sha256").update(await page.locator("canvas").screenshot()).digest("hex")).not.toBe(initial);
      const stats = await page.evaluate(() => (window as any).runtime.stats());
      expect(stats.mode).toBe(mode);
      expect(stats.thread).toBe(mode === "worker" ? "worker" : "main");
      expect(stats.frameCount).toBeGreaterThan(0);
      expect(stats.frameDurationMs).toBeGreaterThanOrEqual(0);
      expect(stats.width).toBeGreaterThan(0);
      expect(stats.height).toBeGreaterThan(0);
      await page.evaluate(() => (window as any).runtime.hide());
      const hiddenStats = await page.evaluate(() => (window as any).runtime.stats());
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(await page.evaluate(() => (window as any).runtime.stats())).toMatchObject({ frameCount: hiddenStats.frameCount });
      await page.evaluate(() => (window as any).runtime.show());
      await page.waitForTimeout(120);
      const resumedStats = await page.evaluate(() => (window as any).runtime.stats());
      expect(resumedStats.frameCount).toBeGreaterThanOrEqual(hiddenStats.frameCount);
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        canvas.style.width = "420px";
        canvas.style.height = "280px";
        window.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(async () => {
        const stats = await (window as any).runtime.stats();
        return stats.width >= 420 && stats.height >= 280;
      }, { timeout: 10_000 });
      const resized = await page.evaluate(() => (window as any).runtime.stats());
      expect(resized.width).toBeGreaterThan(resumedStats.width);
      expect(resized.height).toBeGreaterThan(resumedStats.height);
      const sampleStarted = Date.now();
      const sampleBefore = resized.frameCount;
      await page.waitForTimeout(1_050);
      const sampleAfter = await page.evaluate(() => (window as any).runtime.stats());
      const sampleElapsedMs = Math.max(1, Date.now() - sampleStarted);
      const sampleFrameDelta = Math.max(0, sampleAfter.frameCount - sampleBefore);
      await page.evaluate(() => (window as any).runtime.dispose());
      expect(await page.evaluate(() => (window as any).runtime.disposed)).toBe(true);
      expect(pageErrors).toEqual([]);
      const result = {
        mode,
        instantiatesOnMain: await page.evaluate(() => (window as any).wasmInstantiates),
        stats,
        sample: {
          elapsedMs: sampleElapsedMs,
          frameDelta: sampleFrameDelta,
          observedFps: sampleFrameDelta * 1000 / sampleElapsedMs,
          frameDurationMs: Math.max(0, sampleAfter.frameDurationMs - resized.frameDurationMs),
          averageAdvanceMs: sampleFrameDelta > 0
            ? Math.max(0, sampleAfter.frameDurationMs - resized.frameDurationMs) / sampleFrameDelta
            : null,
        },
      };
      await page.close();
      return result;
    };

    try {
      browser = await chromium.launch({ headless: true });
      const main = await runMode("main");
      const worker = await runMode("worker");
      expect(main.instantiatesOnMain).toBeGreaterThan(0);
      expect(worker.instantiatesOnMain).toBe(0);
      expect(worker.stats.mode).toBe("worker");
      const unsupported = await browser.newPage();
      await unsupported.goto(`http://127.0.0.1:${server.port}/?mode=unsupported`);
      await unsupported.waitForFunction(() => (window as any).ready || (window as any).failed, { timeout: 30_000 });
      expect(await unsupported.evaluate(() => (window as any).failed)).toBe(true);
      expect(await unsupported.evaluate(() => (window as any).wasmInstantiates)).toBe(0);
      expect((await unsupported.evaluate(() => (window as any).errors)).join(" ")).toMatch(/OffscreenCanvas|transferControlToOffscreen|render Worker/i);
      await unsupported.close();
      const report = {
        generatedAt: new Date().toISOString(),
        main,
        worker,
        comparison: {
          sameGuest: true,
          workerMainThreadWasmInstantiates: worker.instantiatesOnMain,
          mainObservedFps: main.sample.observedFps,
          workerObservedFps: worker.sample.observedFps,
        },
      };
      const reportPath = process.env.POCKET_RENDER_WORKER_ABLATION_REPORT;
      if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await browser?.close();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
