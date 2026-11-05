import { strict as assert } from "node:assert";
import { test as bunTest } from "bun:test";
import {
  createHostBridge,
  type JsonObject,
} from "../../../sdk/packages/pocket_ui/src/host.ts";
import { createPlatformExperience } from "../../../sdk/packages/pocket_ui/src/platform-experience.ts";
import { createPocketStreamAdapter } from "../../../sdk/packages/pocket_ui/src/streams.ts";

type Packet = {
  type?: string;
  name?: string;
  payload?: JsonObject;
};

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    bunTest(name, fn);
  } catch {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch((error) => {
        console.error(`Failed test: ${name}`, error);
        process.exit(1);
      });
    }
  }
}

function event(name: string, payload: JsonObject): Record<string, unknown> {
  return { type: "event", name, payload };
}

function payload(packet: Packet): JsonObject {
  assert.ok(packet.payload && typeof packet.payload === "object");
  return packet.payload!;
}

test("hardware capability panels use real host packets for streams and GATT", async () => {
  const packets: Packet[] = [];
  const host = createHostBridge((packet) => {
    packets.push(packet as Packet);
    return true;
  });
  const streams = createPocketStreamAdapter(host, {
    maxActiveStreams: 4,
    maxBufferedMessages: 8,
  });

  try {
    const sensors = streams.open("hardware.sensors.watch", { samplingHz: 10 });
    assert.equal(packets.at(-1)?.name, "stream.open");
    assert.deepEqual(payload(packets.at(-1)!).params, { samplingHz: 10 });
    assert.equal(payload(packets.at(-1)!).topic, "hardware.sensors.watch");

    const sensorRead = sensors.read();
    host.handle(
      event("stream.data", {
        streamId: sensors.id,
        data: { sensor: "accelerometer", x: 1, y: 2, z: 3 },
      }),
    );
    assert.deepEqual(await sensorRead, {
      sensor: "accelerometer",
      x: 1,
      y: 2,
      z: 3,
    });
    assert.equal(sensors.cancel("panel_unmounted"), true);
    assert.equal(packets.at(-1)?.name, "stream.cancel");
    assert.equal(payload(packets.at(-1)!).reason, "panel_unmounted");

    const selector = {
      deviceId: "demo-device",
      serviceUuid: "service-1",
      characteristicUuid: "characteristic-1",
    };
    const notifications = streams.open(
      "hardware.bluetooth.notifications",
      selector,
    );
    assert.equal(packets.at(-1)?.name, "stream.open");
    assert.deepEqual(payload(packets.at(-1)!).params, selector);
    const notificationRead = notifications.read();
    host.handle(
      event("stream.data", {
        streamId: notifications.id,
        data: { value: [1, 2, 255], timestamp: 12 },
      }),
    );
    assert.deepEqual(await notificationRead, {
      value: [1, 2, 255],
      timestamp: 12,
    });

    const readRequest = host.request("hardware.bluetooth.read", selector);
    const readPacket = packets.at(-1)!;
    assert.equal(readPacket.name, "host.request");
    const readRequestId = payload(readPacket).requestId;
    assert.equal(payload(readPacket).capability, "hardware.bluetooth.read");
    assert.deepEqual(payload(readPacket).params, selector);
    host.handle({
      type: "response",
      requestId: readRequestId,
      capability: "hardware.bluetooth.read",
      ok: true,
      result: { value: [10, 11] },
    });
    assert.deepEqual(await readRequest, { value: [10, 11] });

    const writeParams = {
      ...selector,
      value: [10, 11, 12],
      withResponse: false,
    };
    const writeRequest = host.request("hardware.bluetooth.write", writeParams);
    const writePacket = packets.at(-1)!;
    assert.equal(writePacket.name, "host.request");
    const writeRequestId = payload(writePacket).requestId;
    assert.equal(payload(writePacket).capability, "hardware.bluetooth.write");
    assert.deepEqual(payload(writePacket).params, writeParams);
    host.handle({
      type: "response",
      requestId: writeRequestId,
      capability: "hardware.bluetooth.write",
      ok: true,
      result: { written: 3 },
    });
    assert.deepEqual(await writeRequest, { written: 3 });

    const failedRead = host.request("hardware.bluetooth.read", selector);
    const failedPacket = packets.at(-1)!;
    host.handle({
      type: "response",
      requestId: payload(failedPacket).requestId,
      capability: "hardware.bluetooth.read",
      ok: false,
      error: { code: "gatt_error", message: "Characteristic unavailable" },
    });
    await assert.rejects(failedRead, (error: unknown) => {
      return (
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "gatt_error"
      );
    });

    const notificationReadAfterError = notifications.read();
    host.handle(
      event("stream.error", {
        streamId: notifications.id,
        error: { code: "provider_failed", message: "Notifications stopped" },
      }),
    );
    await assert.rejects(notificationReadAfterError, (error: unknown) => {
      return (
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "provider_failed"
      );
    });
    host.handle(event("stream.end", { streamId: notifications.id }));
    assert.equal(notifications.state, "errored");
  } finally {
    streams.dispose("panel_test_finished");
    host.dispose();
  }
});

test("platform panel actions stay explicit and use the host capability names", async () => {
  const packets: Packet[] = [];
  const host = createHostBridge((packet) => {
    packets.push(packet as Packet);
    return true;
  });
  const experience = createPlatformExperience(host);

  try {
    const initial = experience.links.initial<{ uri: string | null }>();
    const initialPacket = packets.at(-1)!;
    assert.equal(initialPacket.name, "host.request");
    assert.equal(payload(initialPacket).capability, "platform.links.initial");
    assert.deepEqual(payload(initialPacket).params, {});
    host.handle({
      type: "response",
      requestId: payload(initialPacket).requestId,
      capability: "platform.links.initial",
      ok: true,
      result: { uri: null },
    });
    assert.deepEqual(await initial, { uri: null });

    const haptic = experience.haptics.perform<{ performed: boolean }>({
      type: "selection",
    });
    const hapticPacket = packets.at(-1)!;
    assert.equal(payload(hapticPacket).capability, "platform.haptics.perform");
    assert.deepEqual(payload(hapticPacket).params, { type: "selection" });
    host.handle({
      type: "response",
      requestId: payload(hapticPacket).requestId,
      capability: "platform.haptics.perform",
      ok: true,
      result: { performed: true },
    });
    assert.deepEqual(await haptic, { performed: true });

    const systemUi = experience.systemUi.set({
      statusBarIconBrightness: "dark",
      systemNavigationBarIconBrightness: "dark",
    });
    const systemUiPacket = packets.at(-1)!;
    assert.equal(payload(systemUiPacket).capability, "platform.systemUi.set");
    assert.deepEqual(payload(systemUiPacket).params, {
      statusBarIconBrightness: "dark",
      systemNavigationBarIconBrightness: "dark",
    });
    host.handle({
      type: "response",
      requestId: payload(systemUiPacket).requestId,
      capability: "platform.systemUi.set",
      ok: true,
      result: { applied: true },
    });
    assert.deepEqual(await systemUi, { applied: true });
  } finally {
    experience.dispose();
    host.dispose();
  }
});
