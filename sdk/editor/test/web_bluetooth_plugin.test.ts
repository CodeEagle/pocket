import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const clientRoot = resolve(import.meta.dir, "../client");
const plugin = readFileSync(join(clientRoot, "plugins/web-bluetooth.js"), "utf8");

async function browserPage() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: plugin });
  await page.evaluate(() => {
    class FakeCharacteristic extends EventTarget {
      uuid = "00002a37-0000-1000-8000-00805f9b34fb";
      properties = { read: true, write: true, writeWithoutResponse: true, notify: true, indicate: false };
      value = new DataView(Uint8Array.from([9, 8]).buffer);
      writes = [];
      async readValue() { return this.value; }
      async writeValueWithResponse(value) { this.writes.push({ mode: "response", value: [...value] }); }
      async writeValueWithoutResponse(value) { this.writes.push({ mode: "withoutResponse", value: [...value] }); }
      async startNotifications() { return this; }
      async stopNotifications() { return this; }
    }
    class FakeService {
      uuid = "0000180d-0000-1000-8000-00805f9b34fb";
      characteristic = new FakeCharacteristic();
      async getCharacteristics() { return [this.characteristic]; }
      async getCharacteristic() { return this.characteristic; }
    }
    class FakeGatt {
      connected = false;
      service = new FakeService();
      async connect() { this.connected = true; return this; }
      async getPrimaryServices() { return [this.service]; }
      disconnect() { this.connected = false; }
    }
    class FakeDevice extends EventTarget {
      id = "web-device-1";
      name = "Web Heart Rate";
      gatt = new FakeGatt();
    }
    const device = new FakeDevice();
    const calls = [];
    const sent = [];
    const tokens = [];
    const bluetooth = {
      calls,
      device,
      async requestDevice(options) { calls.push(options); return device; },
      async getDevices() { return [device]; },
    };
    globalThis.__webBluetoothTest = {
      bluetooth,
      device,
      sent,
      tokens,
      adapter: PocketWebBluetooth.create({ bluetooth, send: (token, message) => { tokens.push(token); sent.push(message); }, isSecureContext: true }),
    };
  });
  return { browser, page };
}

test("Web Bluetooth chooser waits for a direct user click and returns the native scan shape", async () => {
  const { browser, page } = await browserPage();
  try {
    await page.evaluate(() => {
      globalThis.__webBluetoothTest.scanPromise = globalThis.__webBluetoothTest.adapter.handle({
        token: "preview-token",
        scope: "root",
        kind: "request",
        requestId: "scan-1",
        capability: "hardware.bluetooth.scan",
        params: { optionalServices: ["0000180d-0000-1000-8000-00805f9b34fb"] },
      });
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls.length)).toBe(0);
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.scanPromise);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls[0])).toEqual({
      acceptAllDevices: true,
      optionalServices: ["0000180d-0000-1000-8000-00805f9b34fb"],
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.result)).toEqual({
      ok: true,
      realBle: true,
      source: "web-bluetooth",
      scanMode: "chooser",
      state: "poweredOn",
      devices: [{ id: "web-device-1", name: "Web Heart Rate" }],
    });
    expect(await page.evaluate(() => new Set(globalThis.__webBluetoothTest.tokens).size)).toBe(1);
  } finally {
    await browser.close();
  }
});

test("Web Bluetooth permission request uses the chooser only for hardware.bluetooth", async () => {
  const { browser, page } = await browserPage();
  try {
    await page.evaluate(() => {
      const { adapter } = globalThis.__webBluetoothTest;
      globalThis.__webBluetoothTest.permissionPromise = adapter.handle({
        token: "permission-token",
        scope: "permission-scope",
        kind: "request",
        requestId: "permission-1",
        capability: "hardware.permissions.request",
        params: { permission: "hardware.bluetooth" },
      });
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls.length)).toBe(0);
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.permissionPromise);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.result)).toEqual({
      ok: true,
      permission: "hardware.bluetooth",
      status: "granted",
      granted: true,
      runtimePermissionRequired: false,
      realHardware: true,
    });
    await page.evaluate(async () => {
      await globalThis.__webBluetoothTest.adapter.handle({
        token: "scan-after-permission-token",
        scope: "permission-scope",
        kind: "request",
        requestId: "scan-after-permission",
        capability: "hardware.bluetooth.scan",
        params: {},
      });
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls.length)).toBe(1);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.result)).toMatchObject({
      scanMode: "authorized-devices",
      devices: [{ id: "web-device-1", name: "Web Heart Rate" }],
    });

    await page.evaluate(async () => {
      await globalThis.__webBluetoothTest.adapter.handle({
        token: "unsupported-permission-token",
        scope: "permission-scope",
        kind: "request",
        requestId: "permission-2",
        capability: "hardware.permissions.request",
        params: { permission: "hardware.camera" },
      });
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.error.code)).toBe("hardware_unsupported");
  } finally {
    await browser.close();
  }
});

test("Web Bluetooth authorization stays scoped and does not invent a passive scan", async () => {
  const { browser, page } = await browserPage();
  try {
    await page.evaluate(() => {
      const { adapter } = globalThis.__webBluetoothTest;
      globalThis.__webBluetoothTest.scopeAPromise = adapter.handle({ token: "scope-a-permission", scope: "scope-a", kind: "request", requestId: "scope-a-permission", capability: "hardware.permissions.request", params: { permission: "hardware.bluetooth" } });
    });
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.scopeAPromise);
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "scope-a-scan", scope: "scope-a", kind: "request", requestId: "scope-a-scan", capability: "hardware.bluetooth.scan", params: {} }));
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.result.scanMode)).toBe("authorized-devices");
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls.length)).toBe(1);

    await page.evaluate(() => {
      const { adapter } = globalThis.__webBluetoothTest;
      globalThis.__webBluetoothTest.scopeBPromise = adapter.handle({ token: "scope-b-scan", scope: "scope-b", kind: "request", requestId: "scope-b-scan", capability: "hardware.bluetooth.scan", params: {} });
    });
    expect(await page.locator('[data-pocket-web-bluetooth-chooser]').count()).toBe(1);
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.scopeBPromise);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.bluetooth.calls.length)).toBe(2);
  } finally {
    await browser.close();
  }
});

test("Web Bluetooth maps connect, read, write and notification streams to the hardware contract", async () => {
  const { browser, page } = await browserPage();
  try {
    await page.evaluate(() => {
      const { adapter } = globalThis.__webBluetoothTest;
      globalThis.__webBluetoothTest.scanPromise = adapter.handle({ token: "t", scope: "s", kind: "request", requestId: "scan", capability: "hardware.bluetooth.scan", params: {} });
    });
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.scanPromise);
    await page.evaluate(async () => {
      const { adapter } = globalThis.__webBluetoothTest;
      const params = { deviceId: "web-device-1", serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb", characteristicUuid: "00002a37-0000-1000-8000-00805f9b34fb" };
      await adapter.handle({ token: "connect-token", scope: "s", kind: "request", requestId: "connect", capability: "hardware.bluetooth.connect", params });
      await adapter.handle({ token: "read-token", scope: "s", kind: "request", requestId: "read", capability: "hardware.bluetooth.read", params });
      await adapter.handle({ token: "write-token", scope: "s", kind: "request", requestId: "write", capability: "hardware.bluetooth.write", params: { ...params, value: [1, 2, 255], withResponse: true } });
      await adapter.handle({ token: "stream-token", scope: "s", kind: "stream.open", streamId: "stream-1", topic: "hardware.bluetooth.notifications", params });
    });
    const connect = await page.evaluate(() => globalThis.__webBluetoothTest.sent.find((entry) => entry.payload?.requestId === "connect"));
    expect(connect.payload.result.services[0].characteristics[0]).toEqual({
      uuid: "00002a37-0000-1000-8000-00805f9b34fb",
      canRead: true,
      canWrite: true,
      canWriteWithoutResponse: true,
      canNotify: true,
      canIndicate: false,
    });
    const read = await page.evaluate(() => globalThis.__webBluetoothTest.sent.find((entry) => entry.payload?.requestId === "read"));
    expect(read.payload.result.value).toEqual([9, 8]);
    const writes = await page.evaluate(() => globalThis.__webBluetoothTest.device.gatt.service.characteristic.writes);
    expect(writes).toEqual([{ mode: "response", value: [1, 2, 255] }]);
    expect(await page.evaluate(() => new Set(globalThis.__webBluetoothTest.tokens).size)).toBeGreaterThan(1);

    await page.evaluate(() => {
      const characteristic = globalThis.__webBluetoothTest.device.gatt.service.characteristic;
      characteristic.value = new DataView(Uint8Array.from([7, 6, 5]).buffer);
      characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    });
    const data = await page.evaluate(() => globalThis.__webBluetoothTest.sent.find((entry) => entry.name === "stream.data"));
    expect(data.payload).toMatchObject({ streamId: "stream-1", data: { value: [7, 6, 5], realBle: true, source: "web-bluetooth" } });
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "duplicate-stream-token", scope: "s", kind: "stream.open", streamId: "stream-duplicate", topic: "hardware.bluetooth.notifications", params: { deviceId: "web-device-1", serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb", characteristicUuid: "00002a37-0000-1000-8000-00805f9b34fb" } }));
    const duplicate = await page.evaluate(() => globalThis.__webBluetoothTest.sent.find((entry) => entry.name === "stream.error" && entry.payload.streamId === "stream-duplicate"));
    expect(duplicate.payload.error.code).toBe("hardware_busy");
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "stream-token", scope: "s", kind: "stream.cancel", streamId: "stream-1" }));
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.some((entry) => entry.name === "stream.end" && entry.payload.streamId === "stream-1"))).toBe(false);
    await page.evaluate(async () => {
      const { adapter, device } = globalThis.__webBluetoothTest;
      const characteristic = device.gatt.service.characteristic;
      const original = characteristic.startNotifications;
      characteristic.startNotifications = async () => { throw new Error("subscription rejected"); };
      await adapter.handle({ token: "failed-stream-token", scope: "s", kind: "stream.open", streamId: "failed-stream", topic: "hardware.bluetooth.notifications", params: { deviceId: device.id, serviceUuid: device.gatt.service.uuid, characteristicUuid: characteristic.uuid } });
      characteristic.startNotifications = original;
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.filter(entry => entry.name === "stream.error" && entry.payload.streamId === "failed-stream").length)).toBe(1);
    await page.evaluate(async () => {
      const { adapter } = globalThis.__webBluetoothTest;
      const params = { deviceId: "web-device-1", serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb", characteristicUuid: "00002a37-0000-1000-8000-00805f9b34fb" };
      await adapter.handle({ token: "stream-two-token", scope: "s", kind: "stream.open", streamId: "stream-2", topic: "hardware.bluetooth.notifications", params });
      globalThis.__webBluetoothTest.device.dispatchEvent(new Event("gattserverdisconnected"));
    });
    await page.waitForFunction(() => globalThis.__webBluetoothTest.sent.some((entry) => entry.name === "stream.error" && entry.payload.streamId === "stream-2"));
    const dataCount = await page.evaluate(() => globalThis.__webBluetoothTest.sent.filter((entry) => entry.name === "stream.data").length);
    await page.evaluate(() => {
      const characteristic = globalThis.__webBluetoothTest.device.gatt.service.characteristic;
      characteristic.value = new DataView(Uint8Array.from([1]).buffer);
      characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    });
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.filter((entry) => entry.name === "stream.data").length)).toBe(dataCount);
  } finally {
    await browser.close();
  }
});

test("Web Bluetooth cancellation and dispose clean up chooser and reject insecure contexts", async () => {
  const { browser, page } = await browserPage();
  try {
    await page.evaluate(() => {
      const { bluetooth } = globalThis.__webBluetoothTest;
      globalThis.__insecure = PocketWebBluetooth.create({ bluetooth, send: (_token, message) => { globalThis.__insecureSent = message; }, isSecureContext: false });
    });
    await page.evaluate(() => globalThis.__insecure.handle({ token: "t", scope: "s", kind: "request", requestId: "x", capability: "hardware.bluetooth.scan", params: {} }));
    expect(await page.evaluate(() => globalThis.__insecureSent.payload.error.code)).toBe("hardware_unsupported");

    await page.evaluate(() => {
      globalThis.__webBluetoothTest.cancelPromise = globalThis.__webBluetoothTest.adapter.handle({ token: "t2", scope: "s", kind: "request", requestId: "cancel", capability: "hardware.bluetooth.scan", params: {} });
    });
    await page.locator('[data-pocket-web-bluetooth-chooser] button').last().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.cancelPromise);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.error.code)).toBe("hardware_not_found");
    await page.evaluate(async () => {
      const { adapter } = globalThis.__webBluetoothTest;
      globalThis.__webBluetoothTest.scopeScan = adapter.handle({ token: "scope-token", scope: "owner-a", kind: "request", requestId: "scope-scan", capability: "hardware.bluetooth.scan", params: {} });
    });
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.scopeScan);
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "dispose-token", scope: "owner-a", kind: "scope.dispose" }));
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "new-token", scope: "owner-a", kind: "request", requestId: "stale", capability: "hardware.bluetooth.connect", params: { deviceId: "web-device-1" } }));
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.at(-1).payload.error.code)).toBe("hardware_not_found");
    await page.evaluate(() => {
      globalThis.__webBluetoothTest.bluetooth.requestDevice = () => new Promise((resolve) => { globalThis.__webBluetoothTest.resolveLateDevice = resolve; });
      globalThis.__webBluetoothTest.latePromise = globalThis.__webBluetoothTest.adapter.handle({ token: "late-token", scope: "late-owner", kind: "request", requestId: "late-scan", capability: "hardware.bluetooth.scan", params: {} });
    });
    await page.locator('[data-pocket-web-bluetooth-chooser] button').first().click();
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.handle({ token: "dispose-late", scope: "late-owner", kind: "scope.dispose" }));
    await page.evaluate(() => { globalThis.__webBluetoothTest.device.gatt.connected = true; });
    await page.evaluate(() => globalThis.__webBluetoothTest.resolveLateDevice(globalThis.__webBluetoothTest.device));
    await page.evaluate(() => globalThis.__webBluetoothTest.latePromise);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.sent.some((entry) => entry.payload?.requestId === "late-scan"))).toBe(false);
    expect(await page.evaluate(() => globalThis.__webBluetoothTest.device.gatt.connected)).toBe(false);
    await page.evaluate(() => globalThis.__webBluetoothTest.adapter.dispose());
    expect(await page.locator('[data-pocket-web-bluetooth-chooser]').count()).toBe(0);
  } finally {
    await browser.close();
  }
});
