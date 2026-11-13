import { mock as moduleMock } from "bun:test";
import * as pinnedSolid from "../../../.cache/pocketjs/node_modules/solid-js/dist/solid.js";
moduleMock.module("solid-js", () => pinnedSolid);
import { strict as assert } from "node:assert";
import { mock } from "bun:test";

import type { HostBridge, JsonObject, JsonValue } from "../src/host.ts";

// This mock is intentionally installed in this fixture process only. The
// parent test never mutates Bun's module cache or its global event sink.
mock.module("@pocketjs/framework/clock", () => ({
  after: (_seconds: number, _callback: () => void) => () => {},
  simulationHz: () => 60,
}));

const { createPocketPlatformClient } = await import("../src/platform.ts");

type PendingRequest = {
  capability: string;
  params: JsonObject;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

class FixtureBridge implements HostBridge {
  readonly requests: PendingRequest[] = [];
  readonly handled: Array<Record<string, unknown>> = [];
  disposed = false;

  request<T extends JsonValue = JsonValue>(
    capability: string,
    params: JsonObject = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.requests.push({
        capability,
        params,
        resolve: resolve as (value: JsonValue) => void,
        reject,
      });
    });
  }

  handle(packet: Record<string, unknown>): boolean {
    this.handled.push(packet);
    return true;
  }

  tick(): void {}

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.reject(new Error("fixture disposed"));
  }

  resolveAt(index: number, value: JsonValue): void {
    const request = this.requests[index];
    assert.ok(request, `missing fixture request ${index}`);
    request.resolve(value);
  }
}

function packet(name: string, params: JsonObject): Record<string, unknown> {
  return { type: "event", name, params };
}

function eventSink(): (packet: Record<string, unknown>) => void {
  const sink = (globalThis as { __pocketEvent?: (packet: Record<string, unknown>) => void }).__pocketEvent;
  assert.equal(typeof sink, "function", "client must install a guest event sink");
  return sink!;
}

function withPreviousEventSink(): {
  previous: (packet: Record<string, unknown>) => void;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const previous = (packet: Record<string, unknown>): void => calls.push(packet);
  (globalThis as { __pocketEvent?: (packet: Record<string, unknown>) => void }).__pocketEvent = previous;
  return { previous, calls };
}

async function launchOrderAndEvents(): Promise<void> {
  const { previous, calls } = withPreviousEventSink();
  const bridge = new FixtureBridge();
  const client = createPocketPlatformClient(undefined, { bridge });
  try {
    const messages: unknown[] = [];
    const lifecycle: unknown[] = [];
    const stopMessage = client.onMessage((value) => messages.push(value));
    const stopLifecycle = client.onLifecycle((value) => lifecycle.push(value));
    const opening = client.launchApp("pocket.demo.lobby", { from: "profile" });
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0]!.capability, "platform.apps.open");
    assert.deepEqual(bridge.requests[0]!.params, {
      appId: "pocket.demo.lobby",
      arguments: { from: "profile" },
    });
    bridge.resolveAt(0, {
      requestId: "launch-1",
      targetAppId: "pocket.demo.lobby",
    });
    const launch = await opening;
    assert.equal(launch.requestId, "launch-1");
    assert.equal(launch.targetAppId, "pocket.demo.lobby");

    const sink = eventSink();
    sink(packet("platform.message", {
      id: "message-1",
      sourceAppId: "pocket.demo.profile",
      targetAppId: "pocket.demo.lobby",
      topic: "identity",
      data: { name: "Alex Chen" },
    }));
    sink(packet("platform.lifecycle", {
      appId: "pocket.demo.lobby",
      state: "foreground",
    }));
    sink(packet("platform.result", {
      requestId: "launch-1",
      appId: "pocket.demo.lobby",
      cancelled: false,
      value: { visits: 2, count: 2 },
    }));

    assert.deepEqual(messages, [{
      id: "message-1",
      sourceAppId: "pocket.demo.profile",
      targetAppId: "pocket.demo.lobby",
      topic: "identity",
      data: { name: "Alex Chen" },
    }]);
    assert.deepEqual(lifecycle, [{ appId: "pocket.demo.lobby", state: "foreground" }]);
    assert.deepEqual(await launch.result, {
      requestId: "launch-1",
      appId: "pocket.demo.lobby",
      cancelled: false,
      value: { visits: 2, count: 2 },
    });
    assert.equal(bridge.handled.length, 3);
    assert.equal(calls.length, 3);
    stopMessage();
    stopLifecycle();
  } finally {
    client.dispose();
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
  }
}

async function earlyResult(): Promise<void> {
  const { previous } = withPreviousEventSink();
  const bridge = new FixtureBridge();
  const client = createPocketPlatformClient(undefined, { bridge });
  try {
    const opening = client.launchApp("pocket.demo.lobby");
    bridge.resolveAt(0, { requestId: "early-1" });
    eventSink()(packet("platform.result", {
      requestId: "early-1",
      appId: "pocket.demo.lobby",
      cancelled: false,
      value: { ready: true },
    }));
    const launch = await opening;
    assert.deepEqual(await launch.result, {
      requestId: "early-1",
      appId: "pocket.demo.lobby",
      cancelled: false,
      value: { ready: true },
    });
  } finally {
    client.dispose();
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
  }
}

async function cancellation(): Promise<void> {
  const { previous } = withPreviousEventSink();
  const bridge = new FixtureBridge();
  const client = createPocketPlatformClient(undefined, { bridge });
  try {
    const opening = client.launchApp("pocket.demo.lobby");
    bridge.resolveAt(0, { requestId: "cancel-1" });
    const launch = await opening;
    const cancellation = launch.cancel();
    assert.equal(bridge.requests.length, 2);
    assert.equal(bridge.requests[1]!.capability, "platform.apps.cancel");
    assert.deepEqual(bridge.requests[1]!.params, { requestId: "cancel-1" });
    bridge.resolveAt(1, { cancelled: true });
    assert.deepEqual(await cancellation, { cancelled: true });
    eventSink()(packet("platform.result", {
      requestId: "cancel-1",
      appId: "pocket.demo.lobby",
      cancelled: true,
      value: null,
      reason: "cancelled",
    }));
    assert.deepEqual(await launch.result, {
      requestId: "cancel-1",
      appId: "pocket.demo.lobby",
      cancelled: true,
      value: null,
      reason: "cancelled",
    });
  } finally {
    client.dispose();
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
  }
}

async function storageBatch(): Promise<void> {
  const { previous } = withPreviousEventSink();
  const bridge = new FixtureBridge();
  const client = createPocketPlatformClient(undefined, { bridge });
  try {
    const operations = [
      { type: "set", key: "slot.1", value: { active: "chapter-2", unicode: "海" } },
      { type: "remove", key: "slot.2" },
    ] as const;
    const pending = client.storage.batch(operations, "saves");
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0]!.capability, "platform.storage.batch");
    assert.deepEqual(bridge.requests[0]!.params, {
      namespace: "saves",
      operations: [
        { type: "set", key: "slot.1", value: { active: "chapter-2", unicode: "海" } },
        { type: "remove", key: "slot.2" },
      ],
    });
    bridge.resolveAt(0, null);
    await pending;

    const callsBeforeInvalid = bridge.requests.length;
    const malformed = [{ type: "move", key: "slot.1" }] as unknown as Parameters<typeof client.storage.batch>[0];
    await assert.rejects(client.storage.batch(malformed, "saves"), /unsupported type/);
    assert.equal(bridge.requests.length, callsBeforeInvalid,
      "an unknown runtime operation must not be rewritten as a destructive remove request");
  } finally {
    client.dispose();
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
  }
}

async function dispose(): Promise<void> {
  const { previous } = withPreviousEventSink();
  const bridge = new FixtureBridge();
  const client = createPocketPlatformClient(undefined, { bridge });
  try {
    const opening = client.launchApp("pocket.demo.lobby");
    bridge.resolveAt(0, { requestId: "dispose-1" });
    const launch = await opening;
    const result = launch.result;
    const sink = eventSink();
    client.dispose();
    client.dispose();
    await assert.rejects(result, /Platform client disposed/);
    assert.equal(bridge.disposed, false, "an injected bridge belongs to the caller");
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
    sink(packet("platform.result", {
      requestId: "dispose-1",
      appId: "pocket.demo.lobby",
      cancelled: false,
      value: { stale: true },
    }));
  } finally {
    client.dispose();
    assert.equal((globalThis as { __pocketEvent?: unknown }).__pocketEvent, previous);
  }
}

await launchOrderAndEvents();
await earlyResult();
await cancellation();
await storageBatch();
await dispose();
console.log("PLATFORM_CLIENT_FIXTURE_OK");
