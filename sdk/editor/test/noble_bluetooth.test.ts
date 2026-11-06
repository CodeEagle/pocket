import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "bun:test";
import { createNobleBluetoothTransport } from "../native/noble-bluetooth.mjs";

function fixture() {
  const characteristic = Object.assign(new EventEmitter(), {
    uuid: "ffb8", properties: ["read", "write", "writeWithoutResponse", "notify"],
    writes: [] as { value: number[]; withoutResponse: boolean }[],
    unsubscribed: 0,
    async readAsync() { return Buffer.from([1, 2]); },
    async writeAsync(value: Buffer, withoutResponse: boolean) { this.writes.push({ value: [...value], withoutResponse }); },
    async subscribeAsync() { this.emit("data", Buffer.from([7]), true); },
    async unsubscribeAsync() { this.unsubscribed++; },
  });
  const services = [{ uuid: "ffac", characteristics: [characteristic] }];
  const peripheral = Object.assign(new EventEmitter(), {
    id: "ble-1", rssi: -42, advertisement: { localName: "DK-META2", manufacturerData: Buffer.from([197,95,179,5,0,1,20,1,32,33,34,35,36,37]) },
    services, disconnects: 0,
    async connectAsync() {},
    async discoverAllServicesAndCharacteristicsAsync() { return { services, characteristics: [characteristic] }; },
    async disconnectAsync() { this.disconnects++; this.emit("disconnect"); },
    disconnect() { void this.disconnectAsync(); },
  });
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn", stops: 0,
    async startScanningAsync() { queueMicrotask(() => this.emit("discover", peripheral)); },
    async stopScanningAsync() { this.stops++; },
  });
  const events: any[] = [];
  const transport = createNobleBluetoothTransport(noble, packet => events.push(packet), { timeoutMs: 1000 });
  const request = (method: string, params = {}) => transport.handle({ method, params: { sessionId: "a", ...params } });
  const scan = () => request("startBleScan", { timeoutMs: 250 });
  const select = { deviceId: "ble-1", serviceUuid: "ffac", characteristicUuid: "ffb8" };
  return { characteristic, peripheral, noble, events, transport, request, scan, select };
}

test("Noble transport preserves advertisement facts, GATT inventory and response mode", async () => {
  const f = fixture();
  try {
    const scan = await f.scan();
    assert.deepEqual(scan.devices[0].manufacturerData, [...f.peripheral.advertisement.manufacturerData]);
    const connected = await f.request("connectBleDevice", { deviceId: "ble-1" });
    assert.equal(connected.services[0].characteristics[0].canWriteWithoutResponse, true);
    assert.deepEqual((await f.request("readBleCharacteristic", f.select)).value, [1,2]);
    await f.request("writeBleCharacteristic", { ...f.select, value: [8,10], withResponse: true });
    await f.request("writeBleCharacteristic", { ...f.select, value: [8,0], withResponse: false });
    assert.deepEqual(f.characteristic.writes, [{ value:[8,10], withoutResponse:false }, { value:[8,0], withoutResponse:true }]);
  } finally { await f.transport.dispose(); }
});

test("Noble subscribe captures the immediate notification, ignores reads, and releases listeners", async () => {
  const f = fixture();
  try {
    await f.scan(); await f.request("connectBleDevice", { deviceId:"ble-1" });
    await f.request("startHardwareStream", { ...f.select, streamId:"notify" });
    assert.deepEqual(f.events[0].event.data.value, [7]);
    f.characteristic.emit("data", Buffer.from([99]), false);
    assert.equal(f.events.length, 1);
    f.characteristic.emit("data", Buffer.from([8,10]), true);
    assert.deepEqual(f.events.at(-1).event.data.value, [8,10]);
    await f.request("stopHardwareStream", { streamId:"notify" });
    assert.equal(f.characteristic.listenerCount("data"), 0);
    assert.equal(f.characteristic.unsubscribed, 1);
  } finally { await f.transport.dispose(); }
});

test("Noble scope cleanup never disconnects a different owner and reconnect has current disconnect routing", async () => {
  const f = fixture();
  try {
    await f.scan(); await f.request("connectBleDevice", { deviceId:"ble-1" });
    await f.request("startBleScan", { sessionId:"b", timeoutMs:250 });
    await f.request("disposeSession", { sessionId:"b" });
    assert.equal(f.peripheral.disconnects, 0);
    await f.request("disposeSession");
    await f.request("startBleScan", { sessionId:"c", timeoutMs:250 });
    await f.request("connectBleDevice", { sessionId:"c", deviceId:"ble-1" });
    await f.request("startHardwareStream", { sessionId:"c", ...f.select, streamId:"current" });
    f.peripheral.emit("disconnect");
    assert.equal(f.events.at(-1).event.streamId, "current");
    assert.equal(f.events.at(-1).event.error.code, "hardware_bluetooth_disconnected");
  } finally { await f.transport.dispose(); }
});

test("disposing an active Noble scan rejects it and cannot resurrect its scope", async () => {
  const f = fixture();
  const pending = f.request("startBleScan", { timeoutMs:30000 });
  const rejected = assert.rejects(pending, /disposed|cancelled|connection/i);
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.request("disposeSession");
  await rejected;
  assert.equal(f.noble.listenerCount("discover"), 0);
  await assert.rejects(f.scan(), /disposed|retired/i);
  await f.transport.dispose();
});

test("Noble releases a physical connection that completes after its timeout", async () => {
  const f = fixture();
  let finish!: () => void;
  f.peripheral.connectAsync = () => new Promise<void>(resolve => { finish = resolve; });
  try {
    await f.scan();
    await assert.rejects(f.request("connectBleDevice", { deviceId: "ble-1" }), /timed out/);
    const beforeLateConnection = f.peripheral.disconnects;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(f.peripheral.disconnects > beforeLateConnection);
    assert.equal(f.peripheral.listenerCount("disconnect"), 0);
  } finally { await f.transport.dispose(); }
});

test("Noble does not fabricate an explicit OS permission grant", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.request("requestBlePermission"), { code: "hardware_unsupported" });
  } finally { await f.transport.dispose(); }
});
