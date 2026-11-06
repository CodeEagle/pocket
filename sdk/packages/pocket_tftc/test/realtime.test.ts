import { expect, test } from "bun:test";
import {
  CMD_MCU_REPLY,
  DATA_KEY,
  TftcClient,
  buildProtocolFrame,
} from "../src/index.js";

function connectedClient() {
  const client = new TftcClient({ now: () => 1234 });
  client.profile = { name: "DK-META2", protocol: "dokidoki", commands: {} };
  client.device = { gatt: { connected: true } };
  client.businessReady = true;
  client.securityState = "plain";
  return client;
}

function notify(client, attributes, { msgId = 0, command = CMD_MCU_REPLY } = {}) {
  client.handleStandardNotify(buildProtocolFrame(command, attributes, {
    msgId,
    includeChecksum: true,
  }));
}

test("valid notify updates fields and emits raw message plus semantic changes", () => {
  const client = connectedClient();
  const messages: any[] = [];
  const changes: any[] = [];
  client.on("message", (event) => messages.push(event.detail));
  client.on("change", (event) => changes.push(event.detail));

  notify(client, [
    DATA_KEY.BATTERY_COMPACT_STATUS, 132,
    DATA_KEY.DEVICE_COMPACT_STATUS, 0,
    DATA_KEY.LINER_COMPACT_STATUS, 0x23,
  ]);

  expect(messages).toHaveLength(1);
  expect(messages[0].command).toBe(CMD_MCU_REPLY);
  expect(messages[0].changes.map((change: any) => change.field)).toEqual([
    "batteryCompactStatus", "battery", "batteryStatus",
    "deviceCompactStatus", "isWorking", "workModeState", "commandFlag",
    "linerCompactStatus", "linerStatus", "linerId",
  ]);
  expect(changes).toHaveLength(1);
  expect(changes[0].changes.find((change: any) => change.field === "battery")?.current).toBe(33);
  expect(client.status().battery).toBe(33);
  expect(client.status().batteryStatus).toBe(0);
  expect(client.status().isWorking).toBe(false);
});

test("repeated valid notify still emits a message but suppresses changes", () => {
  const client = connectedClient();
  const messages: any[] = [];
  const changes: any[] = [];
  client.on("message", (event) => messages.push(event.detail));
  client.on("change", (event) => changes.push(event.detail));
  const attributes = [DATA_KEY.BATTERY_COMPACT_STATUS, 132];

  notify(client, attributes);
  notify(client, attributes);

  expect(messages).toHaveLength(2);
  expect(messages[1].changes).toEqual([]);
  expect(changes).toHaveLength(1);
});

test("checksum failure emits neither message nor change and does not mutate attributes", () => {
  const client = connectedClient();
  const messages: any[] = [];
  const changes: any[] = [];
  client.on("message", (event) => messages.push(event.detail));
  client.on("change", (event) => changes.push(event.detail));
  const frame = Array.from(buildProtocolFrame(CMD_MCU_REPLY, [DATA_KEY.BATTERY_COMPACT_STATUS, 132], {
    includeChecksum: true,
  }));
  frame[frame.length - 1] ^= 0xff;

  client.handleStandardNotify(frame);

  expect(messages).toEqual([]);
  expect(changes).toEqual([]);
  expect(client.attributes.size).toBe(0);
  expect(client.status().battery).toBeNull();
});

test("matching queryKeys response also emits message and change before resolving", async () => {
  const client = connectedClient();
  const messages: any[] = [];
  const changes: any[] = [];
  client.on("message", (event) => messages.push(event.detail));
  client.on("change", (event) => changes.push(event.detail));
  client.writeChar = {
    async writeValueWithResponse(frame) {
      const request = Array.from(frame);
      const msgId = request[0] & 0x0f;
      notify(client, [DATA_KEY.DEVICE_COMPACT_STATUS, 1], { msgId, command: 0x07 });
    },
  };

  await client.queryKeys([DATA_KEY.DEVICE_COMPACT_STATUS], { timeout: 1000 });

  expect(messages).toHaveLength(1);
  expect(messages[0].msgId).toBe(1);
  expect(messages[0].changes.map((change: any) => change.field)).toEqual([
    "deviceCompactStatus", "isWorking", "workModeState", "commandFlag",
  ]);
  expect(changes).toHaveLength(1);
  expect(client.pendingRequests.size).toBe(0);
});

test("fragmented notify emits only after all frames assemble and then changes state once", () => {
  const client = connectedClient();
  const messages: any[] = [];
  const changes: any[] = [];
  client.on("message", (event) => messages.push(event.detail));
  client.on("change", (event) => changes.push(event.detail));
  const complete = Array.from(buildProtocolFrame(CMD_MCU_REPLY, [
    DATA_KEY.BATTERY_COMPACT_STATUS, 132,
    DATA_KEY.DEVICE_COMPACT_STATUS, 1,
  ], { msgId: 7, includeChecksum: true })).slice(4);
  const first = complete.slice(0, 2);
  const second = complete.slice(2);

  client.handleStandardNotify(buildProtocolFrame(CMD_MCU_REPLY, first, {
    msgId: 7, totalFrames: 2, currentFrame: 0,
  }));
  expect(messages).toEqual([]);
  expect(changes).toEqual([]);

  client.handleStandardNotify(buildProtocolFrame(CMD_MCU_REPLY, second, {
    msgId: 7, totalFrames: 2, currentFrame: 1,
  }));

  expect(messages).toHaveLength(1);
  expect(messages[0].totalFrames).toBe(2);
  expect(changes).toHaveLength(1);
  expect(client.status().battery).toBe(33);
  expect(client.status().isWorking).toBe(true);
});
