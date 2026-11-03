import { test as bunTest } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendPerformanceSample,
  initialDemoState,
  parsePerformancePoint,
  parsePerformanceSnapshot,
  reduceDemoState,
  type DemoState,
} from "../state.ts";
import { createHostBridge } from "../host.ts";

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    bunTest(name, fn);
  } catch {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch((err) => {
        console.error(`Failed test: ${name}`, err);
        process.exit(1);
      });
    }
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function apply(state: DemoState, ...events: Parameters<typeof reduceDemoState>[1][]): DemoState {
  return events.reduce(reduceDemoState, state);
}

test("initial state and state transitions", () => {
  const initial = initialDemoState();
  assert.equal(initial.route, "home");
  assert.equal(initial.count, 0);
  assert.equal(initial.draft, "");
  assert.equal(initial.detailsOpen, false);
  assert.equal(initial.mobileDark, false);
  assert.equal(initial.runtimeInfo.phase, "idle");
  assert.equal(initial.updatesStatus.phase, "idle");
  assert.equal(initial.runtimePerformance.phase, "idle");
  assert.equal(initial.cameraPreview.phase, "idle");

  const counter = apply(initial, { type: "increment" }, { type: "increment" }, { type: "decrement" });
  assert.equal(counter.count, 1);
  assert.equal(counter.lastAction, "Decremented in JS");

  const input = apply(initial, { type: "draft", value: "native guest" });
  assert.equal(input.draft, "native guest");
  assert.equal(input.lastAction, "Input changed in JS");

  const modal = apply(initial, { type: "select", component: "Modal" });
  assert.equal(modal.detailsOpen, true);
  assert.equal(modal.selectedComponent, "Modal");
  assert.equal(apply(modal, { type: "navigate", route: "about" }).detailsOpen, false);

  const lazy = apply(initial, { type: "toggleLazy" });
  assert.equal(lazy.lazyVisible, true);
  assert.equal(apply(lazy, { type: "toggleLazy" }).lazyVisible, false);

  const darkMobile = apply(initial, { type: "setMobileDark", value: true });
  assert.equal(darkMobile.mobileDark, true);
  assert.equal(darkMobile.lastAction, "Mobile theme set to dark");
  assert.equal(apply(darkMobile, { type: "setMobileDark", value: false }).mobileDark, false);
});

test("capability lifecycle and cameraStop transition", () => {
  const initial = initialDemoState();
  const capabilityLoading = apply(initial, { type: "capabilityStart", key: "runtimeInfo", requestId: "runtime-1" });
  assert.equal(capabilityLoading.runtimeInfo.phase, "loading");
  const capabilityReady = apply(capabilityLoading, {
    type: "capabilitySuccess",
    key: "runtimeInfo",
    requestId: "runtime-1",
    result: { engine: "QuickJS" },
  });
  assert.equal(capabilityReady.runtimeInfo.phase, "ready");
  assert.deepEqual(capabilityReady.runtimeInfo.result, { engine: "QuickJS" });
  assert.equal(apply(capabilityReady, {
    type: "capabilityFailure",
    key: "runtimeInfo",
    requestId: "stale-request",
    code: "old",
    message: "stale response",
  }).runtimeInfo.phase, "ready");

  const capabilityError = apply(capabilityLoading, {
    type: "capabilityFailure",
    key: "runtimeInfo",
    requestId: "runtime-1",
    code: "unconfigured",
    message: "runtime.info is not configured",
  });
  assert.equal(capabilityError.runtimeInfo.phase, "error");
  assert.equal(capabilityError.runtimeInfo.error?.code, "unconfigured");

  // cameraStop transitions cameraPreview.phase to idle
  const cameraActiveState: DemoState = {
    ...initial,
    cameraPreview: {
      phase: "ready",
      lens: "front",
      surfaceId: 88,
      width: 1280,
      height: 720,
      detail: "Preview ready",
    },
  };
  const cameraStoppedState = reduceDemoState(cameraActiveState, { operation: "cameraStop" } as any);
  assert.equal(cameraStoppedState.cameraPreview.phase, "idle");
  assert.equal(cameraStoppedState.cameraPreview.surfaceId, undefined);
  assert.equal(cameraStoppedState.cameraPreview.lens, "front");
  assert.equal(cameraStoppedState.cameraPreview.detail, "Preview stopped");

  const cameraStopping = reduceDemoState(cameraActiveState, {
    type: "capabilityStart",
    key: "hardwareCameraPreviewStop",
    requestId: "cam-stop-1",
  });
  const cameraStopKey = reduceDemoState(cameraStopping, {
    type: "capabilitySuccess",
    key: "hardwareCameraPreviewStop",
    requestId: "cam-stop-1",
    result: { stopped: true },
  });
  assert.equal(cameraStopKey.cameraPreview.phase, "idle");
  assert.equal(cameraStopKey.cameraPreview.surfaceId, undefined);
});

test("stress and performance snapshots", () => {
  const initial = initialDemoState();
  const stress = apply(initial, { type: "stressRun", nodeCount: 500, checksum: 1234, durationMs: 2 });
  assert.equal(stress.stress.nodeCount, 500);
  assert.equal(stress.stress.checksum, 1234);
  assert.equal(stress.stress.durationMs, 2);

  const performanceResult = {
    latest: { timestamp: "t2", fps: 48, minFps: 42, maxGapMs: 31, slowFrames: 2, nativeMsP95: 4.5 },
    history: [
      { timestamp: "t1", fps: 60, maxGapMs: 17, slowFrames: 0, nativeMsP95: 2.1 },
      { timestamp: "t2", fps: 48, maxGapMs: 31, slowFrames: 2, nativeMsP95: 4.5 },
    ],
    recording: true,
  };
  const parsedPerformance = parsePerformanceSnapshot(performanceResult);
  assert.equal(parsedPerformance.latest?.fps, 48);
  assert.equal(parsedPerformance.latest?.minFps, 42);
  assert.equal(parsedPerformance.history.length, 2);
  assert.equal(parsedPerformance.recording, true);
  assert.equal(parsePerformancePoint({ fps: 60 }), undefined);
  assert.equal(
    parsePerformancePoint({
      timestamp: "high-refresh",
      fps: 144,
      maxGapMs: 7,
      slowFrames: 0,
      nativeMsP95: 1,
    })?.fps,
    144,
  );

  const performanceLoading = apply(initial, {
    type: "capabilityStart",
    key: "runtimePerformance",
    requestId: "performance-1",
  });
  const performanceReady = apply(performanceLoading, {
    type: "capabilitySuccess",
    key: "runtimePerformance",
    requestId: "performance-1",
    result: performanceResult,
  });
  assert.equal(performanceReady.runtimePerformance.phase, "ready");
  assert.deepEqual(performanceReady.runtimePerformance.result, performanceResult);

  let rolling = { latest: null, history: [], recording: true } as ReturnType<typeof parsePerformanceSnapshot>;
  for (let index = 0; index < 65; index += 1) {
    rolling = appendPerformanceSample(rolling, {
      timestamp: String(index),
      fps: 60 - index,
      maxGapMs: 16,
      slowFrames: index % 3,
      nativeMsP95: 2,
    });
  }
  assert.equal(rolling.history.length, 60);
  assert.equal(rolling.history[0]?.timestamp, "5");
  assert.equal(rolling.latest?.timestamp, "64");
});

test("source checks and boundary integrity", () => {
  const appSource = readFileSync(join(root, "app.tsx"), "utf8");
  const uiSource = readFileSync(join(root, "../../sdk/packages/pocket_ui/src/ui.tsx"), "utf8");
  const releaseSource = readFileSync(join(root, "release.ts"), "utf8");
  const guestManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    capabilities?: { requires?: string[]; optional?: string[] };
  };
  assert.match(appSource, /mount\(\(\) => <App \/>\)/);
  assert.match(appSource, /reduceDemoState/);
  assert.match(appSource, /demo\.setText/);
  assert.match(appSource, /runtime\.info/);
  assert.match(appSource, /runtime\.performance/);
  assert.match(appSource, /runtime\.performance\.sample/);
  assert.match(appSource, /ScrollablePage/);
  assert.match(appSource, /createSignal<PerformanceSnapshot>/);
  assert.match(appSource, /setPerformance/);
  assert.match(appSource, /appendPerformanceSample/);
  assert.match(appSource, /FPS history/);
  assert.match(appSource, /Recent 60 samples/);
  assert.match(appSource, /Lowest FPS samples/);
  assert.match(appSource, /nativeMsP95/);
  assert.match(appSource, /const scale = Math\.max\(1, \.\.\.points\.map/);
  assert.doesNotMatch(appSource, /scaled to a 60 FPS baseline/);
  assert.match(appSource, /plugins\.list/);
  assert.match(appSource, /updates\.rollback/);
  assert.match(appSource, /updates\.changed/);
  assert.match(appSource, /stage=/);
  assert.match(appSource, /lastError=/);
  assert.match(appSource, /function versionHistory/);
  assert.match(appSource, /VirtualList/);
  assert.match(appSource, /Version history/);
  assert.match(appSource, /previous/);
  assert.match(appSource, /Run 500 nodes/);
  assert.match(appSource, /demo\.stress/);
  assert.match(appSource, /Pocket Host Lab/);
  assert.match(appSource, /state\(\)\.mobileDark/);
  assert.doesNotMatch(appSource, /package:flutter|dart:|lib\//);
  assert.match(uiSource, /function Tabs/);
  assert.match(uiSource, /Button = ActionButton/);
  assert.match(uiSource, /function List/);
  assert.match(uiSource, /function DetailModal/);
  assert.match(uiSource, /function ScrollablePage/);
  assert.match(uiSource, /createGesture/);
  assert.match(uiSource, /createScroller/);
  assert.match(uiSource, /bindDpadScroll/);
  assert.match(uiSource, /translateY:\s*-scroller\.offset\(\)/);
  assert.match(uiSource, /ensureVisible/);
  assert.match(uiSource, /scroller\.scrollBy/);
  assert.match(uiSource, /inputNode/);
  assert.match(uiSource, /contentNode/);
  assert.match(uiSource, /measuredContent/);
  assert.match(uiSource, /previousOffset/);
  assert.match(uiSource, /const outside/);
  assert.doesNotMatch(uiSource, /contentHeight \?\? 960/);
  assert.doesNotMatch(appSource, /contentHeight=\{960\}/);
  assert.doesNotMatch(uiSource, /@pocketjs\/framework\/osk/);
  assert.match(uiSource, /textInput\.open/);
  assert.match(uiSource, /textInput\.update/);
  assert.match(uiSource, /textInput\.close/);
  assert.match(uiSource, /textInput\.edit/);
  assert.match(uiSource, /textInput\.submit/);
  assert.match(uiSource, /textInput\.closed/);
  assert.match(uiSource, /getLayout/);
  assert.match(uiSource, /deliverTextInputEvent/);
  // Rect delivery and scrolling are exercised by the compiled native probe;
  // a specific onFrame call spelling is not an interaction assertion.
  assert.match(uiSource, /lastRect/);
  assert.match(uiSource, /activeTextInput = session/);
  assert.doesNotMatch(uiSource, /function Keyboard/);
  assert.match(appSource, /deliverTextInputEvent/);
  assert.doesNotMatch(appSource, /OSK/);
  // Request/response and limits are exercised below through the shared SDK
  // bridge; moving it out of the consumer is not a protocol change.
  assert.match(releaseSource, /demoRelease/);
  assert.ok(guestManifest.capabilities?.optional?.includes("updates.apply"));
  assert.ok(guestManifest.capabilities?.optional?.includes("plugins.packageInfo"));
  assert.ok(guestManifest.capabilities?.optional?.includes("runtime.performance"));
});

test("host bridge communication and limits", async () => {
  const sentPackets: string[] = [];
  const hostBridge = createHostBridge((line) => {
    sentPackets.push(line);
    return true;
  });
  const runtimePromise = hostBridge.request("runtime.info", {});
  const runtimePacket = JSON.parse(sentPackets[0]!) as {
    type: string;
    name: string;
    payload: { requestId: string; capability: string; params: Record<string, unknown> };
  };
  assert.equal(runtimePacket.type, "event");
  assert.equal(runtimePacket.name, "host.request");
  assert.equal(runtimePacket.payload.capability, "runtime.info");
  assert.deepEqual(runtimePacket.payload.params, {});
  assert.equal(hostBridge.handle({
    type: "response",
    requestId: runtimePacket.payload.requestId,
    capability: "runtime.info",
    ok: true,
    result: { engine: "QuickJS" },
  }), true);
  assert.deepEqual(await runtimePromise, { engine: "QuickJS" });
  hostBridge.dispose();

  const boundedBridge = createHostBridge(() => true, { maxPendingRequests: 1, timeoutFrames: 2 });
  const timedOut = boundedBridge.request("updates.status", {});
  await assert.rejects(boundedBridge.request("updates.check", {}), (error: unknown) => {
    return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "request_quota");
  });
  boundedBridge.tick();
  boundedBridge.tick();
  await assert.rejects(timedOut, (error: unknown) => {
    return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "timeout");
  });
  boundedBridge.dispose();
});

test("host request deadlines can sleep and cancel without frame polling", async () => {
  const callbacks = new Set<() => void>();
  const packets: string[] = [];
  const bridge = createHostBridge(line => { packets.push(line); return true; }, {
    timeoutFrames: 1800,
    scheduleTimeout: (frames, callback) => {
      assert.equal(frames, 1800);
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    },
  });
  const response = bridge.request("runtime.info");
  // Legacy tick() callers must not count down a separately scheduled timer.
  for (let n = 0; n < 2000; n++) bridge.tick();
  assert.equal(callbacks.size, 1);
  const requestId = JSON.parse(packets[0]!).payload.requestId;
  bridge.handle({ type: "response", requestId, result: { ready: true } });
  assert.deepEqual(await response, { ready: true });
  assert.equal(callbacks.size, 0);

  const timedOut = assert.rejects(bridge.request("runtime.info"), (error: unknown) => {
    return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "timeout");
  });
  const fire = [...callbacks][0]!;
  callbacks.delete(fire); // a one-shot timer consumes its own registration
  fire();
  await timedOut;
  const disposed = assert.rejects(bridge.request("runtime.info"), /disposed/i);
  bridge.dispose();
  await disposed;
  assert.equal(callbacks.size, 0);
});
