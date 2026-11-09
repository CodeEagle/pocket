import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";

const mountCallbacks: Array<() => void> = [];
const cleanupCallbacks: Array<() => void> = [];
mock.module("solid-js", () => ({
  createSignal(initial: unknown) {
    let value = initial;
    return [() => value, (next: unknown) => {
      value = typeof next === "function" ? (next as (previous: unknown) => unknown)(value) : next;
    }];
  },
  onMount(callback: () => void) { mountCallbacks.push(callback); },
  onCleanup(callback: () => void) { cleanupCallbacks.push(callback); },
}));
mock.module("@pocketjs/framework/clock", () => ({
  after: (_seconds: number, _callback: () => void) => () => {},
  simulationHz: () => 60,
}));

const { createHostBridge } = await import("../src/host.ts");
const { EMPTY_DISPLAY_GEOMETRY } = await import("../src/responsive.ts");
const { createDisplayGeometry } = await import("../src/display.ts");

function event(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { type: "event", name, payload };
}

test("display signal created before mount replays the latest ingress-merged viewport", () => {
  mountCallbacks.length = 0;
  cleanupCallbacks.length = 0;
  const host = createHostBridge(() => true);
  const changes: Array<{ width: number; height: number; top: number; bottom: number; keyboard: number; regions: number }> = [];
  const geometry = createDisplayGeometry({
    bridge: host,
    fallback: { ...EMPTY_DISPLAY_GEOMETRY, width: 360, height: 640 },
    onChange: (value) => changes.push({
      width: value.width,
      height: value.height,
      top: value.safeArea.top,
      bottom: value.safeArea.bottom,
      keyboard: value.keyboardInset,
      regions: value.reservedRegions.length,
    }),
  });
  try {
    assert.deepEqual(geometry().safeArea, { top: 0, right: 0, bottom: 0, left: 0 });
    assert.equal(mountCallbacks.length, 1);

    // The host receives the initial complete fact and a partial update after
    // signal construction but before the Solid mount callback subscribes.
    assert.equal(host.handle(event("display.viewport", {
      width: 411,
      height: 731,
      safeArea: { top: 24, right: 0, bottom: 23.57, left: 0 },
      keyboardInset: 0,
      reservedRegions: [{
        id: "status-cutout",
        kind: "occlusion",
        frame: { left: 370, top: 0, width: 41, height: 28 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    })), false);
    assert.equal(host.handle(event("display.viewport", {
      width: 411,
      height: 700,
      keyboardInset: 12,
    })), false);

    mountCallbacks.shift()!();
    assert.deepEqual(geometry(), {
      width: 411,
      height: 700,
      safeArea: { top: 24, right: 0, bottom: 23.57, left: 0 },
      keyboardInset: 12,
      reservedRegions: [{
        id: "status-cutout",
        kind: "occlusion",
        frame: { left: 370, top: 0, width: 41, height: 28 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.deepEqual(changes, [{ width: 411, height: 700, top: 24, bottom: 23.57, keyboard: 12, regions: 1 }]);

    // Once mounted, live partial updates still use the same display event lane.
    assert.equal(host.handle(event("display.viewport", { width: 411, height: 680, keyboardInset: 8 })), true);
    assert.equal(geometry().height, 680);
    assert.equal(geometry().safeArea.top, 24);
    assert.equal(geometry().safeArea.bottom, 23.57);
    assert.equal(geometry().keyboardInset, 8);
    assert.equal(geometry().reservedRegions.length, 1);
    assert.equal(changes.length, 2);
  } finally {
    for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
    host.dispose();
  }
});
