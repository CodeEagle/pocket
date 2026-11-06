import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createHostBridge } from "../../pocket_ui/src/host.ts";
import { createPocketBluetooth } from "../src/pocket-bluetooth.ts";
import { TftcClient } from "../src/client.js";
import { buildProtocolFrame, buildYxlOneFrame } from "../src/protocol.js";

type Sent = { type?: string; name?: string; payload?: Record<string, unknown> };

function event(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { type: "event", name, payload };
}

function wire() {
  const packets: Sent[] = [];
  const host = createHostBridge((packet) => {
    packets.push(packet as Sent);
    return true;
  });
  const bluetooth = createPocketBluetooth(host);
  return { host, bluetooth, packets };
}

function response(packets: Sent[], host: ReturnType<typeof createHostBridge>, result: unknown): void {
  const packet = packets.at(-1)!;
  const payload = packet.payload!;
  host.handle(event("host.response", {
    requestId: payload.requestId as string,
    capability: payload.capability as string,
    ok: true,
    result: result as never,
  }));
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Pocket Bluetooth maps scan, GATT inventory, read and write to host capabilities", async () => {
  const { host, bluetooth, packets } = wire();
  try {
    const selectedPromise = bluetooth.requestDevice({ filters: [{ namePrefix: "TF-" }] });
    assert.equal(packets.at(-1)?.payload?.capability, "hardware.bluetooth.scan");
    response(packets, host, { ok: true, devices: [{ id: "ble-1", name: "TF-META2", rssi: -42, manufacturerData: [0xc5, 0x5f, 0x1b, 0x08, 0x01, 0x00, 0x01, 0x14, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66] }] });
    const device = await selectedPromise;
    assert.equal(device.id, "ble-1");
    assert.equal(device.name, "TF-META2");
    assert.deepEqual(device.manufacturerData, [0xc5, 0x5f, 0x1b, 0x08, 0x01, 0x00, 0x01, 0x14, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);

    const connected = device.gatt.connect();
    assert.equal(packets.at(-1)?.payload?.capability, "hardware.bluetooth.connect");
    response(packets, host, {
      ok: true,
      services: [{
        uuid: "0000ffac-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "ffb5", canWrite: true },
          { uuid: "ffb8", canNotify: true },
        ],
      }],
    });
    await connected;
    const service = await device.gatt.getPrimaryService("ffac");
    const write = await service.getCharacteristic("ffb5");
    const writePromise = write.writeValueWithResponse(Uint8Array.from([1, 2, 255]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(packets.at(-1)?.payload?.params, {
      deviceId: "ble-1",
      serviceUuid: "0000ffac-0000-1000-8000-00805f9b34fb",
      characteristicUuid: "ffb5",
      value: [1, 2, 255],
      withResponse: true,
    });
    response(packets, host, { ok: true, bytesWritten: 3 });
    await writePromise;

    const read = await service.getCharacteristic("ffb5");
    const readPromise = read.readValue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    response(packets, host, { ok: true, value: [9, 8] });
    const value = await readPromise;
    assert.deepEqual([...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)], [9, 8]);
  } finally {
    bluetooth.dispose();
    host.dispose();
  }
});

test("notifications use the Pocket stream and surface remote stream errors as disconnect", async () => {
  const { host, bluetooth, packets } = wire();
  try {
    const selectedPromise = bluetooth.requestDevice();
    response(packets, host, { ok: true, devices: [{ id: "ble-1", name: "TF-META2" }] });
    const device = await selectedPromise;
    const connected = device.gatt.connect();
    response(packets, host, { ok: true, services: [{ uuid: "ffac", characteristics: [{ uuid: "ffb8", canNotify: true }] }] });
    await connected;
    const characteristic = await (await device.gatt.getPrimaryService("ffac")).getCharacteristic("ffb8");
    let disconnected = 0;
    device.addEventListener("gattserverdisconnected", () => { disconnected += 1; });
    const notifications = characteristic.startNotifications();
    await notifications;
    const streamPacket = packets.at(-1)!;
    assert.equal(streamPacket.name, "stream.open");
    const streamId = streamPacket.payload!.streamId as string;
    let changed = 0;
    characteristic.addEventListener("characteristicvaluechanged", (event) => {
      changed += event.target.value?.getUint8(0) === 7 ? 1 : 0;
    });
    host.handle(event("stream.data", { streamId, data: { value: [7, 6] } }));
    assert.equal(changed, 1);
    host.handle(event("stream.error", { streamId, error: { code: "hardware_bluetooth_disconnected", message: "lost" } }));
    assert.equal(disconnected, 1);
    assert.equal(device.gatt.connected, false);
  } finally {
    bluetooth.dispose();
    host.dispose();
  }
});

test("disconnect cancels owned notifications and emits the browser disconnect event", async () => {
  const { host, bluetooth, packets } = wire();
  try {
    const selectedPromise = bluetooth.requestDevice();
    response(packets, host, { ok: true, devices: [{ id: "ble-1", name: "TF-META2" }] });
    const device = await selectedPromise;
    const connected = device.gatt.connect();
    response(packets, host, { ok: true, services: [{ uuid: "ffac", characteristics: [{ uuid: "ffb8", canNotify: true }] }] });
    await connected;
    const characteristic = await (await device.gatt.getPrimaryService("ffac")).getCharacteristic("ffb8");
    const disconnectPromise = new Promise<void>((resolve) => device.addEventListener("gattserverdisconnected", () => resolve()));
    await characteristic.startNotifications();
    device.gatt.disconnect();
    await disconnectPromise;
    assert.equal(device.gatt.connected, false);
    assert.equal(packets.at(-1)?.name, "stream.cancel");
  } finally {
    bluetooth.dispose();
    host.dispose();
  }
});

test("TftcClient executes a TRYFUN-ONE connect and command through the Pocket adapter", async () => {
  const { host, bluetooth, packets } = wire();
  const client = new TftcClient({ bluetooth });
  try {
    const connected = client.connect();
    await turn();
    response(packets, host, { ok: true, devices: [{ id: "one-1", name: "TRYFUN-ONE" }] });
    await turn();
    response(packets, host, {
      ok: true,
      services: [
        { uuid: "ff10", characteristics: [{ uuid: "fff1", canWrite: true }] },
        { uuid: "ff12", characteristics: [{ uuid: "ff14", canNotify: true }] },
      ],
    });
    await connected;
    const streamPacket = packets.find((packet) => packet.name === "stream.open");
    assert.ok(streamPacket);
    const streamId = streamPacket!.payload!.streamId as string;

    const command = client.setLinear(4);
    await turn();
    assert.equal(packets.at(-1)?.payload?.capability, "hardware.bluetooth.write");
    response(packets, host, { ok: true, bytesWritten: 5 });
    host.handle(event("stream.data", {
      streamId,
      data: { value: Array.from(buildYxlOneFrame(0x0b, 0x03, 0x01)) },
    }));
    await turn();
    assert.equal(packets.at(-1)?.payload?.capability, "hardware.bluetooth.write");
    response(packets, host, { ok: true, bytesWritten: 5 });
    await command;
    assert.equal(client.status().ready, true);
  } finally {
    await client.disconnect({ skipPause: true, silent: true }).catch(() => {});
    bluetooth.dispose();
    host.dispose();
  }
});

test("dispose makes pending scans and previously returned characteristics terminal", async () => {
  const { host, bluetooth, packets } = wire();
  const pendingScan = bluetooth.requestDevice();
  const scanPacket = packets.at(-1)!;
  bluetooth.dispose();
  host.handle(event("host.response", {
    requestId: scanPacket.payload!.requestId as string,
    capability: "hardware.bluetooth.scan",
    ok: true,
    result: { ok: true, devices: [{ id: "late", name: "TF-LATE" }] },
  }));
  await assert.rejects(pendingScan, (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: string }).code === "hardware_bluetooth_disconnected");

  const second = wire();
  try {
    const selected = second.bluetooth.requestDevice();
    response(second.packets, second.host, { ok: true, devices: [{ id: "ble-1", name: "TF-META2" }] });
    const device = await selected;
    const connected = device.gatt.connect();
    response(second.packets, second.host, { ok: true, services: [{ uuid: "ffac", characteristics: [{ uuid: "ffb5", canWrite: true }] }] });
    await connected;
    const characteristic = await (await device.gatt.getPrimaryService("ffac")).getCharacteristic("ffb5");
    second.bluetooth.dispose();
    const before = second.packets.length;
    await assert.rejects(characteristic.writeValue(Uint8Array.of(1)), (error: unknown) =>
      typeof error === "object" && error !== null && (error as { code?: string }).code === "hardware_bluetooth_disconnected");
    assert.equal(second.packets.length, before);
  } finally {
    second.bluetooth.dispose();
    second.host.dispose();
  }
  host.dispose();
});


test("flutter_blue_plus manufacturer map and notification facts use the same TFTC client", async () => {
  const { host, bluetooth, packets } = wire();
  const client = new TftcClient({ bluetooth });
  const changes: any[] = [];
  client.on("change", event => changes.push(...event.detail.changes));
  try {
    const pending = client.connect();
    await turn();
    response(packets, host, { ok: true, devices: [{ id: "fbp-1", name: "DK-META2", manufacturerData: { [String(0x5fc5)]: [0xb3,5,0,1,20,1,32,33,34,35,36,37] } }] });
    await turn();
    response(packets, host, { ok: true, services: [{ uuid: "ffac", characteristics: [{ uuid:"ffb5", canWrite:true }, { uuid:"ffb7", canWriteWithoutResponse:true }, { uuid:"ffb8", canNotify:true }] }] });
    await pending;
    assert.equal(client.status().ready, true);
    const streamId = packets.find(packet => packet.name === "stream.open")!.payload!.streamId as string;
    host.handle(event("stream.data", { streamId, data: { value: [...buildProtocolFrame(1, [8,10,32,132,33,3], { includeChecksum:true })] } }));
    assert.equal(client.status().vibrationLevel, 10);
    assert.equal(client.status().battery, 33);
    assert.equal(client.status().isWorking, true);
    assert.ok(changes.some(change => change.field === "vibrationLevel" && change.current === 10));
    const command = client.setVibration(0);
    await turn();
    assert.equal(packets.at(-1)!.payload!.params!.withResponse, false);
    response(packets, host, { ok:true, bytesWritten:7 });
    await command;
    assert.equal(client.status().vibrationLevel, 10); // No optimistic state.
  } finally {
    await client.disconnect({ skipPause:true, silent:true }).catch(() => {});
    bluetooth.dispose(); host.dispose();
  }
});
