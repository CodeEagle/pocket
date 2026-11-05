import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import {
  createHostBridge,
  HOST_BRIDGE_MAX_DIAGNOSTICS,
} from "../src/host.ts";
import { createPocketStreamAdapter } from "../src/streams.ts";

mock.module("@pocketjs/framework/clock", () => ({
  after: (_seconds: number, _callback: () => void) => () => {},
  simulationHz: () => 60,
}));
const { createPocketPlatformClient } = await import("../src/platform.ts");

function event(name: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "event", name, payload });
}

test("HostBridge isolates event/tick/previous-sink failures and keeps a bounded diagnostic lane", () => {
  const globalObject = globalThis as typeof globalThis & {
    __pocketEvent?: (line: string) => void;
    __pocketDeliver?: (line: string) => void;
  };
  const oldEvent = globalObject.__pocketEvent;
  const oldDeliver = globalObject.__pocketDeliver;
  let previousEvents = 0;
  let previousDeliveries = 0;
  globalObject.__pocketEvent = () => {
    previousEvents += 1;
    throw new Error("previous event failed");
  };
  globalObject.__pocketDeliver = () => {
    previousDeliveries += 1;
    throw new Error("previous deliver failed");
  };

  const diagnostics: Array<{ kind: string; method?: string }> = [];
  const host = createHostBridge(() => true, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  let laterEvents = 0;
  let laterTicks = 0;
  host.onEvent!(() => { throw new Error("listener failed"); });
  host.onEvent!(() => { laterEvents += 1; });
  host.onTick!(() => { throw new Error("tick listener failed"); });
  host.onTick!(() => { laterTicks += 1; });
  try {
    globalObject.__pocketEvent!(event("diagnostic.event"));
    globalObject.__pocketDeliver!("not-json");
    host.tick();
    for (let index = 0; index < HOST_BRIDGE_MAX_DIAGNOSTICS + 8; index += 1) {
      host.handle(event("bounded.event"));
    }
    assert.equal(laterEvents, HOST_BRIDGE_MAX_DIAGNOSTICS + 9);
    assert.equal(laterTicks, 1);
    assert.equal(previousEvents, 1);
    assert.equal(previousDeliveries, 1);
    assert.equal(diagnostics.length, HOST_BRIDGE_MAX_DIAGNOSTICS);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "event_listener"));
    assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "tick_listener"));
    assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "previous_event_sink"));
    assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "previous_deliver_sink"));
  } finally {
    host.dispose();
    globalObject.__pocketEvent = oldEvent;
    globalObject.__pocketDeliver = oldDeliver;
  }
});

test("modern HostBridge listeners share one decoded event object across platform and streams", () => {
  const host = createHostBridge(() => true);
  const platform = createPocketPlatformClient(undefined, { bridge: host });
  const streams = createPocketStreamAdapter(host);
  let parseCount = 0;
  const originalParse = JSON.parse;
  const values: unknown[] = [];
  platform.onMessage((message) => values.push(message.data));
  try {
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
      parseCount += 1;
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    host.handle(event("platform.message", {
      id: "message-1",
      sourceAppId: "sender",
      targetAppId: "receiver",
      topic: "test",
      data: { value: 7 },
    }));
    assert.deepEqual(values, [{ value: 7 }]);
    assert.equal(parseCount, 1, "the host decodes the wire packet once for all modern listeners");
  } finally {
    JSON.parse = originalParse;
    streams.dispose();
    platform.dispose();
    host.dispose();
  }
});
