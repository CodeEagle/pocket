import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { createLocalBluetoothProvider, type LocalBluetoothPacket } from "../local_bluetooth.ts";

class FakeProcess extends EventEmitter {
  stdin = { write: (line: string) => { this.commands.push(JSON.parse(line)); return true; }, end: () => undefined };
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: any[] = [];
  kill = () => { this.emit("exit", 0, null); return true; };
  reply(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  close() { this.stdout.end(); this.emit("exit", 0, null); }
}

function packet(overrides: Partial<LocalBluetoothPacket> = {}): LocalBluetoothPacket {
  return { scope: "system-ui:1", kind: "request", requestId: "guest-1", capability: "hardware.bluetooth.scan", params: {}, ...overrides };
}

test("local Bluetooth maps a Guest request to the CoreBluetooth helper protocol", async () => {
  const helper = new FakeProcess();
  const messages: any[] = [];
  const provider = createLocalBluetoothProvider({ platform: "darwin", helperPath: "/test/helper", processFactory: () => helper });
  const pending = provider.handle(packet(), (message) => messages.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(helper.commands[0].method, "startBleScan");
  assert.equal(helper.commands[0].params.sessionId, "system-ui:1");
  helper.reply({ id: helper.commands[0].id, result: { ok: true, realBle: true, state: "poweredOn", devices: [{ id: "ble-1", name: "Pocket BLE", rssi: -44 }] } });
  await pending;
  assert.deepEqual(messages[0].payload.result.devices[0], { id: "ble-1", name: "Pocket BLE", rssi: -44 });
  assert.equal(messages[0].payload.result.source, "local-core-bluetooth");
  assert.equal(messages[0].payload.result.scanMode, "nearby");
  await provider.dispose();
});

test("local Bluetooth forwards native notification events and scopes streams", async () => {
  const helper = new FakeProcess();
  const messages: any[] = [];
  const provider = createLocalBluetoothProvider({ platform: "darwin", helperPath: "/test/helper", processFactory: () => helper });
  const scan = packet({ requestId: "scan-1" });
  const scanPending = provider.handle(scan, (message) => messages.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  helper.reply({ id: helper.commands[0].id, result: { ok: true, devices: [{ id: "ble-1", name: "Pocket BLE", rssi: -44 }] } });
  await scanPending;
  const stream = packet({ kind: "stream.open", requestId: undefined, streamId: "stream-1", capability: "hardware.bluetooth.notifications", params: { deviceId: "ble-1", serviceUuid: "180f", characteristicUuid: "2a19" } });
  await provider.handle(stream, (message) => messages.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(helper.commands[1].method, "startHardwareStream");
  assert.notEqual(helper.commands[1].params.streamId, "stream-1");
  helper.reply({ id: helper.commands[1].id, result: { ok: true, streamId: helper.commands[1].params.streamId, state: "watching" } });
  helper.reply({ event: { streamId: helper.commands[1].params.streamId, data: { value: [42] } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const opened = messages.find((message) => message.name === "stream.open");
  assert.equal(Boolean(opened), true);
  assert.equal(opened.payload.result.streamId, "stream-1");
  const data = messages.find((message) => message.name === "stream.data");
  assert.deepEqual(data.payload.data.value, [42]);
  assert.equal(data.payload.data.source, "local-core-bluetooth");
  await provider.handle({ scope: "system-ui:1", kind: "stream.cancel", streamId: "stream-1" }, () => undefined);
  assert.equal(helper.commands.at(-1).method, "stopHardwareStream");
  assert.equal(helper.commands.at(-1).params.streamId, helper.commands[1].params.streamId);
  await provider.dispose();
});

test("local Bluetooth isolates devices and colliding stream ids by scope", async () => {
  const helper = new FakeProcess();
  const a: any[] = [];
  const b: any[] = [];
  const provider = createLocalBluetoothProvider({ platform: "darwin", helperPath: "/test/helper", processFactory: () => helper });

  const scanA = provider.handle(packet({ scope: "scope-a", requestId: "scan-a" }), (message) => a.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  helper.reply({ id: helper.commands[0].id, result: { ok: true, devices: [{ id: "shared-device", name: "A" }] } });
  await scanA;

  const forbidden = packet({ scope: "scope-b", requestId: "connect-b", capability: "hardware.bluetooth.connect", params: { deviceId: "shared-device" } });
  await provider.handle(forbidden, (message) => b.push(message));
  assert.equal(b[0].payload.error.code, "hardware_not_found");
  assert.equal(helper.commands.length, 1);

  const streamA = packet({ scope: "scope-a", kind: "stream.open", requestId: undefined, streamId: "same", capability: "hardware.bluetooth.notifications", params: { deviceId: "shared-device", serviceUuid: "180f", characteristicUuid: "2a19" } });
  const streamB = packet({ scope: "scope-b", kind: "stream.open", requestId: undefined, streamId: "same", capability: "hardware.bluetooth.notifications", params: { deviceId: "other-device", serviceUuid: "180f", characteristicUuid: "2a19" } });
  await provider.handle(streamA, (message) => a.push(message));
  await provider.handle(streamB, (message) => b.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(helper.commands[1].method, "startHardwareStream");
  assert.notEqual(helper.commands[1].params.streamId, "same");
  assert.equal(b.at(-1).payload.error.code, "hardware_not_found");
  helper.reply({ id: helper.commands[1].id, result: { ok: true, state: "watching" } });
  helper.reply({ event: { streamId: helper.commands[1].params.streamId, data: { value: [7] } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(a.some((message) => message.name === "stream.data" && message.payload.streamId === "same"), true);
  await provider.handle({ scope: "scope-a", kind: "scope.dispose" }, () => undefined);
  await provider.dispose();
});

test("local Bluetooth remains explicitly unsupported off macOS", async () => {
  const messages: any[] = [];
  const provider = createLocalBluetoothProvider({ platform: "linux" });
  await provider.handle(packet(), (message) => messages.push(message));
  assert.equal(messages[0].payload.error.code, "hardware_unsupported");
  await provider.dispose();
});

test("local Bluetooth does not spawn late when a scope is disposed during startup", async () => {
  const messages: any[] = [];
  let release!: (process: FakeProcess) => void;
  let factoryCalls = 0;
  const provider = createLocalBluetoothProvider({
    platform: "darwin",
    helperPath: "/test/helper",
    processFactory: () => {
      factoryCalls += 1;
      return new Promise<FakeProcess>((resolve) => { release = resolve; });
    },
  });
  const request = provider.handle(packet({ scope: "late-scope" }), (message) => messages.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await provider.handle({ scope: "late-scope", kind: "scope.dispose" }, () => undefined);
  const helper = new FakeProcess();
  release(helper);
  await request;
  assert.equal(factoryCalls, 1);
  assert.equal(helper.commands.length, 0);
  assert.equal(messages[0].payload.error.code, "hardware_bluetooth_disconnected");
  await provider.dispose();
});
