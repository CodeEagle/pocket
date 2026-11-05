import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");

test("real QJBC semantic control reaches browser AT and activates guest JS", { timeout: 90_000 }, async () => {
  assert.ok(existsSync(nativeProbe), `pocket_probe is required: ${nativeProbe}`);
  const project = await mkdtemp(join(tmpdir(), "pocket-preview-semantic-real-project-"));
  const output = await mkdtemp(join(tmpdir(), "pocket-preview-semantic-real-build-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "semantic-real", private: true, type: "module" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.semantic-real", entry: "app.tsx" }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { AppleSemanticsProvider, createAppleSemanticsStore } from "@pocket/ui";

const host = createHostBridge();
let semanticStore;
function App() {
  const [activated, setActivated] = createSignal(false);
  semanticStore = createAppleSemanticsStore({ bridge: host });
  const semanticRef = semanticStore.register({
    id: "real-activate",
    label: "Activate real guest",
    role: "button",
    onActivate: () => {
      setActivated(true);
      semanticStore.dispose();
    },
  });
  return <AppleSemanticsProvider bridge={host} store={semanticStore}>
    <Screen><View class="flex-col items-center justify-center gap-3 w-full h-full">
      <Focusable nodeRef={semanticRef} onPress={() => setActivated(true)} class="w-[180] h-[48] items-center justify-center bg-[#315DEB]">
        <Text>{activated() ? "Activated" : "Activate real guest"}</Text>
      </Focusable>
    </View></Screen>
  </AppleSemanticsProvider>;
}
mount(() => <App />);
`, "utf8");

  const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
  const projectId = "semantic-real";
  const manager = createPreviewManager({
    probePath: nativeProbe,
    width: 390,
    height: 640,
    idleDisposeMs: 30_000,
    artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
  });
  const actionInputs: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/input")) {
        const copy = request.clone();
        try {
          const body = await copy.json();
          if (body && typeof body === "object" && (body as Record<string, unknown>).type === "semantic") actionInputs.push(body as Record<string, unknown>);
        } catch { /* manager reports malformed requests */ }
      }
      const endpoint = url.pathname.endsWith("/stream") ? "stream" : url.pathname.endsWith("/input") ? "input" : url.pathname.endsWith("/snapshot") ? "snapshot" : "page";
      return manager.handle(request, projectId, endpoint);
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__semanticFrames = [];
      window.addEventListener("message", (event) => {
        if (event.data?.source === "pocket-editor-preview" && event.data.type === "preview.frame") {
          (window as any).__semanticFrames.push(event.data.frame);
        }
      });
    });
    const response = await page.goto(`http://127.0.0.1:${server.port}/api/projects/${projectId}/preview`);
    assert.equal(response?.status(), 200);
    const control = page.locator('[data-pocket-semantic-guest-id="real-activate"]');
    await control.waitFor({ state: "attached", timeout: 30_000 });
    assert.equal(await control.getAttribute("role"), "button");
    assert.equal(await control.getAttribute("aria-label"), "Activate real guest");
    await control.focus();
    await control.press("Enter");
    await page.waitForFunction(() => (window as any).__semanticFrames.some((frame: any) => frame?.ops?.some((op: any) => op?.type === "text" && op?.text === "Activated")), undefined, { timeout: 30_000 });
    assert.equal(actionInputs.length, 1);
    assert.equal(actionInputs[0]?.type, "semantic");
    assert.equal(actionInputs[0]?.action, "activate");
    assert.equal(actionInputs[0]?.guestId, "real-activate");
    assert.equal(typeof actionInputs[0]?.generation, "number");
    await page.waitForFunction(() => !document.querySelector('[data-pocket-semantic-guest-id="real-activate"]'), undefined, { timeout: 10_000 });
  } finally {
    await browser.close();
    server.stop(true);
    await manager.dispose();
    await rm(project, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
