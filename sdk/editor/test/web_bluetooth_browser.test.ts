// End-to-end: pinned bytecode -> native guest -> optional browser plugin ->
// Chromium's real chooser, followed by an explicit test-only GATT provider.
// CDP emulation is test-only; production never injects a simulated Bluetooth API.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager } from "../preview.ts";

async function acceptance() {
  const sdkRoot = resolve(import.meta.dir, "../..");
  const output = mkdtempSync(join(tmpdir(), "pocket-web-bluetooth-"));
  const built = await buildGuest({ projectRoot: join(import.meta.dir, "fixtures/bluetooth"), outDir: output, tickHz: 60 });
  const nativePackets: any[] = [];
  let localDisposed = false;
  // Explicit native-IO test provider; real CoreBluetooth/helper compilation is
  // verified separately. The Guest and browser input/frame transport are real.
  const localBluetooth = {
    async handle(packet: any, send: (message: any) => void) {
      nativePackets.push(packet);
      if (packet.kind !== "request") return;
      const result = packet.capability === "hardware.permissions.request"
        ? { ok: true, permission: "hardware.bluetooth", granted: true, status: "granted", source: "local-core-bluetooth" }
        : { ok: true, realBle: true, source: "local-core-bluetooth", scanMode: "nearby", state: "poweredOn", devices: [{ id: "test-native-peripheral", name: "Test native device", rssi: -47 }] };
      send({ type: "event", name: "host.response", payload: { requestId: packet.requestId, capability: packet.capability, ok: true, result } });
    },
    async dispose() { localDisposed = true; },
  };
  const manager = createPreviewManager({ localBluetooth, probePath: resolveNativeProbePath(sdkRoot), width: 390, height: 480,
    artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 } });
  const projectId = "web-bluetooth-browser";
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: request => {
    if (new URL(request.url).pathname === "/embed") return new Response(`<iframe title="Phone preview" allow="bluetooth" style="width:390px;height:480px" src="/api/projects/${projectId}/preview?webBluetooth=1"></iframe>`, { headers: { "content-type": "text/html" } });
    return manager.handle(request, projectId);
  } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
    let guest: typeof page | import("playwright").Frame = page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const inputs: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/input')) {
        inputs.push(request.postDataJSON());
        if (inputs.length > 15) inputs.shift();
      }
    });
    const cdp = await browser.newBrowserCDPSession();
    const pageCdp = await page.context().newCDPSession(page);
    const address = "09:09:09:09:09:09";
    const serviceUuid = "0000180f-0000-1000-8000-00805f9b34fb";
    await pageCdp.send("DeviceAccess.enable");
    const protocolEvents: unknown[] = [];
    const radioEvents: unknown[] = [];
    await pageCdp.send('Network.enable');
    pageCdp.on('Network.eventSourceMessageReceived', event => { const packet = JSON.parse(event.data); if (String(packet.type).startsWith('plugin')) protocolEvents.push(packet); });
    const cdpErrors: string[] = [];
    const pending = new Set<Promise<unknown>>();
    function operation(promise: Promise<unknown>) {
      pending.add(promise);
      void promise.catch(error => cdpErrors.push(String(error))).finally(() => pending.delete(promise));
    }
    let prompts = 0;
    const promptEvents: unknown[] = [];
    const selectedPrompts = new Set<string>();
    pageCdp.on("DeviceAccess.deviceRequestPrompted", event => {
      promptEvents.push(event);
      const device = event.devices.find(item => item.id === address);
      if (device && !selectedPrompts.has(event.id)) {
        selectedPrompts.add(event.id);
        prompts += 1;
        operation(pageCdp.send("DeviceAccess.selectPrompt", { id: event.id, deviceId: device.id }));
      }
    });
    const url = `http://127.0.0.1:${server.port}/api/projects/${projectId}/preview`;
    async function waitText(text: string) {
      try {
        await guest.waitForFunction(text => (window as any).PocketEditorPreviewInstance?.getFrame?.()?.ops?.some((op: any) => op.type === "text" && op.text === text), text, { timeout: 15000 });
      } catch (error) {
        const actual = await guest.evaluate(() => ({ texts: (window as any).PocketEditorPreviewInstance?.getFrame?.()?.ops?.filter((op: any) => op.type === 'text').map((op: any) => op.text), status: document.querySelector('[data-preview-status]')?.textContent }));
        throw new Error(`Waiting for ${text}: ${JSON.stringify({actual, inputs, errors, promptEvents, protocolEvents, radioEvents, cdpErrors, status: await manager.status(projectId)})}`, { cause: error });
      }
    }
    async function press(text: string) {
      const point = await guest.evaluate(text => {
        const frame = (window as any).PocketEditorPreviewInstance.getFrame();
        const op = frame.ops.find((op: any) => op.type === "text" && op.text === text);
        if (!op) throw new Error(`missing button: ${text}`);
        return { x: op.x + Math.min(op.w || 40, 40) / 2, y: op.y + 7, width: frame.width, height: frame.height };
      }, text);
      const canvas = await guest.locator("canvas").boundingBox();
      await page.mouse.click(canvas!.x + point.x * canvas!.width / point.width, canvas!.y + point.y * canvas!.height / point.height);
    }
    await page.goto(url);
    await waitText("Bluetooth ready");
    await press("Scan BLE");
    await waitText("error=unsupported_capability");
    expect(prompts).toBe(0);
    await page.goto(`http://127.0.0.1:${server.port}/embed`);
    guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
    await cdp.send("BluetoothEmulation.enable", { state: "powered-on", leSupported: true });
    await cdp.send("BluetoothEmulation.simulatePreconnectedPeripheral", { address, name: "Pocket BLE Test", manufacturerData: [], knownServiceUuids: [serviceUuid] });
    await waitText("Request BLE");
    await press("Request BLE");
    // A direct outer-page click provides browser activation for the embedded
    // preview. Request grants selected devices; Scan reuses them in the app.
    await page.getByRole("button", { name: "Choose device", exact: true }).waitFor();
    expect(await guest.locator("[data-pocket-web-bluetooth-chooser]").count()).toBe(0);
    expect(await page.locator("[data-pocket-web-bluetooth-chooser]").count()).toBe(1);
    await page.getByRole("button", { name: "Choose device", exact: true }).click();
    await waitText("permission=granted");
    expect(prompts).toBeGreaterThan(0);
    const authorizationPrompts = prompts;
    await press("Scan BLE");
    await waitText("selected=web-bluetooth:1");
    expect(prompts).toBe(authorizationPrompts);
    expect(await page.locator("[data-pocket-web-bluetooth-chooser]").count()).toBe(0);
    await Promise.all([...pending]);
    expect(cdpErrors).toEqual([]);
    // Chromium 156's CDP radio loses its adapter after device selection in this
    // environment. Exercise GATT routing with an explicitly injected test double;
    // this does not claim real-radio or physical-device GATT verification.
    await page.addInitScript(() => {
      const writes = [];
      class Characteristic extends EventTarget {
        uuid = "00002a19-0000-1000-8000-00805f9b34fb";
        properties = { read: true, write: true, notify: true };
        async readValue() { return new DataView(Uint8Array.from([42]).buffer); }
        async writeValueWithResponse(value) { writes.push([...value]); }
      }
      const characteristic = new Characteristic();
      const service = { uuid: "0000180f-0000-1000-8000-00805f9b34fb", async getCharacteristics() { return [characteristic]; }, async getCharacteristic() { return characteristic; } };
      const gatt = { connected: false, async connect() { this.connected = true; return this; }, disconnect() { this.connected = false; }, async getPrimaryServices() { return [service]; }, async getPrimaryService() { return service; } };
      const device = Object.assign(new EventTarget(), { id: "explicit-test-device", name: "Test GATT", gatt });
      Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { async requestDevice() { return device; } } });
      window.__bluetoothAcceptance = { writes, gatt };
    });
    await page.goto(`${url}?webBluetooth=1`);
    guest = page;
    await waitText("Scan BLE");
    await press("Scan BLE");
    await page.getByRole("button", { name: "Choose device", exact: true }).click();
    await waitText("selected=web-bluetooth:1");
    await press("Read battery");
    await waitText("battery=42");
    await press("Write battery");
    await waitText("written=1");
    expect(await page.evaluate(() => window.__bluetoothAcceptance.writes)).toEqual([[43]]);
    // Disabling tears down the test connection and restores the
    // unsupported contract, without replacing or reloading the guest runtime.
    await page.evaluate(() => window.postMessage({ source: "pocket-editor", type: "preview.plugins", webBluetooth: false }, location.origin));
    await press("Scan BLE");
    await waitText("error=unsupported_capability");
    expect(await page.evaluate(() => window.__bluetoothAcceptance.gatt.connected)).toBe(false);
    // Local scanning remains inside the App and works with Web Bluetooth absent.
    await page.goto(`${url}?webBluetooth=1&bluetoothProvider=local`);
    guest = page;
    await page.evaluate(() => Object.defineProperty(navigator, "bluetooth", { configurable: true, value: undefined }));
    await waitText("Request BLE");
    await press("Request BLE");
    await waitText("permission=granted");
    await press("Scan BLE");
    await waitText("selected=local-core-bluetooth:1");
    await waitText("RSSI -47");
    expect(await page.locator("[data-pocket-web-bluetooth-chooser]").count()).toBe(0);
    expect(nativePackets.some(packet => packet.capability === "hardware.permissions.request")).toBe(true);
    expect(nativePackets.some(packet => packet.capability === "hardware.bluetooth.scan")).toBe(true);
    await page.evaluate(() => window.postMessage({ source: "pocket-editor", type: "preview.plugins", webBluetooth: false, bluetoothProvider: "local" }, location.origin));
    await press("Scan BLE");
    await waitText("error=unsupported_capability");
    expect(nativePackets.some(packet => packet.kind === "scope.dispose")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await manager.dispose();
    server.stop(true);
    rmSync(output, { recursive: true, force: true });
  }
  expect(localDisposed).toBe(true);
}

if (process.env.POCKET_WEB_BLUETOOTH_CHILD === "1") {
  test("native guest Bluetooth requests use Chromium Web Bluetooth only when enabled", { timeout: 600000 }, acceptance);
} else {
  test("Web Bluetooth browser acceptance runs in an isolated Bun process", { timeout: 610000 }, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, POCKET_WEB_BLUETOOTH_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 605000);
    const code = await child.exited;
    clearTimeout(timer);
    expect(code, `${await stdout}\n${await stderr}`).toBe(0);
  });
}
