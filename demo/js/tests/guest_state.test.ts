import { test as bunTest } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendPerformanceSample,
  initialDemoState,
  parsePerformancePoint,
  parsePerformanceJank,
  parsePerformanceSnapshot,
  reduceDemoState,
  type DemoState,
} from "../state.ts";
import { createHostBridge } from "@pocket/ui/host";

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
    latest: {
      timestamp: "t2",
      fps: 48,
      minFps: 42,
      maxGapMs: 31,
      activeGapMs: 31,
      slowFrames: 2,
      nativeMsP95: 4.5,
      refreshHz: 120,
      frameBudgetMs: 1000 / 120,
      buildMsP95: 4.2,
      rasterMsP95: 6.1,
      nativeWorkMsP95: 2.4,
      longFrameCount: 1,
    },
    history: [
      { timestamp: "t1", fps: 60, maxGapMs: 17, slowFrames: 0, nativeMsP95: 2.1 },
      {
        timestamp: "t2",
        fps: 48,
        maxGapMs: 31,
        activeGapMs: 31,
        slowFrames: 2,
        nativeMsP95: 4.5,
        refreshHz: 120,
        frameBudgetMs: 1000 / 120,
        buildMsP95: 4.2,
        rasterMsP95: 6.1,
        nativeWorkMsP95: 2.4,
      },
    ],
    longFrameEvents: [{
      timestamp: "t2-frame-1",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 31,
      activeGapMs: 31,
      buildMs: 4.2,
      rasterMs: 6.1,
      nativeMs: 2.4,
      scope: "flutterView",
      context: "host sample",
      page: "stress",
      action: "Run 500 nodes",
    }],
    recording: true,
  };
  const parsedPerformance = parsePerformanceSnapshot(performanceResult);
  assert.equal(parsedPerformance.latest?.fps, 48);
  assert.equal(parsedPerformance.latest?.minFps, 42);
  assert.equal(parsedPerformance.latest?.refreshHz, 120);
  assert.equal(parsedPerformance.latest?.buildMsP95, 4.2);
  assert.equal(parsedPerformance.latest?.rasterMsP95, 6.1);
  assert.equal(parsedPerformance.latest?.nativeWorkMsP95, 2.4);
  assert.equal(parsedPerformance.latest?.longFrameCount, 1);
  assert.equal(parsedPerformance.history.length, 2);
  assert.equal(parsedPerformance.longFrameEvents?.length, 1);
  assert.equal(parsedPerformance.longFrameEvents?.[0]?.activeGapMs, 31);
  assert.equal(parsedPerformance.longFrameEvents?.[0]?.nativeMs, 2.4);
  assert.equal(parsedPerformance.longFrameEvents?.[0]?.scope, "flutterView");
  assert.equal(parsedPerformance.recording, true);
  assert.equal(parsePerformancePoint({ fps: 60 }), undefined);
  assert.equal(
    parsePerformancePoint({
      timestamp: "high-refresh",
      fps: 144,
      maxGapMs: 7,
      slowFrames: 0,
      nativeMsP95: 1,
      refreshHz: 144,
    })?.fps,
    144,
  );
  const sparse = parsePerformancePoint({
    timestamp: "sparse",
    fps: 4.28,
    maxGapMs: 0,
    activeGapMs: 0,
    slowFrames: 0,
    nativeMsP95: 1,
    refreshHz: 60,
  });
  assert.equal(sparse?.activeGapMs, 0);
  assert.equal(sparse?.longFrameEvents, undefined);
  assert.equal(parsePerformanceJank({
    timestamp: "idle-event",
    refreshHz: 120,
    budgetMs: 1000 / 120,
    nativeMs: 40,
    active: false,
  }), undefined);

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

  const appended = appendPerformanceSample(parsedPerformance, {
    timestamp: "t3",
    fps: 58,
    refreshHz: 120,
    budgetMs: 1000 / 120,
    activeGapMs: 24,
    longFrameEvents: [{
      timestamp: "t3-frame-1",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 24,
      activeGapMs: 24,
      buildMs: 3,
      rasterMs: 4,
      nativeMs: 1,
    }],
  });
  assert.equal(appended.latest?.timestamp, "t3");
  assert.equal(appended.longFrameEvents?.length, 2);
  assert.equal(appended.longFrameEvents?.[1]?.nativeMs, 1);

  // Event-only bursts have no cadence window. They must add the real long
  // frame while preserving the last FPS point instead of replacing it with
  // an fps=0 sample.
  const eventOnlySample = parsePerformancePoint({
    timestamp: "event-only-sample",
    fps: 0,
    frames: 0,
    durationMs: 0,
    refreshHz: 120,
    longFrameEvents: [{
      timestamp: "event-only-frame",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 316,
      activeGapMs: 316,
      buildMs: 12,
      rasterMs: 8,
      nativeMs: 4,
      scope: "pocketView",
    }],
  });
  assert.ok(eventOnlySample);
  const eventOnly = appendPerformanceSample(parsedPerformance, eventOnlySample!, false);
  assert.equal(eventOnly.latest?.timestamp, "t2");
  assert.equal(eventOnly.latest?.fps, 48);
  assert.equal(eventOnly.history.length, 2);
  assert.equal(eventOnly.longFrameEvents?.length, 2);
  assert.equal(eventOnly.longFrameEvents?.[1]?.timestamp, "event-only-frame");

  // Two-phase long-frame enrichment: Phase 1 (pocketView, no buildMs/rasterMs)
  // followed by Phase 2 (flutterView, with buildMs/rasterMs) for the same frame
  // timestamp must merge in place without duplicating, upgrading scope to
  // flutterView while preserving initial context, page, action, and nativeMs.
  const phase1Sample = parsePerformancePoint({
    timestamp: "2026-01-01T00:00:02.000Z",
    fps: 0,
    frames: 0,
    durationMs: 0,
    refreshHz: 120,
    longFrameEvents: [{
      timestamp: "2026-01-01T00:00:02.000Z",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 42,
      activeGapMs: 42,
      nativeMs: 5.5,
      scope: "pocketView",
      context: "page=stress;action=Run 500 nodes",
      page: "stress",
      action: "Run 500 nodes",
    }],
  });
  const phase2Sample = parsePerformancePoint({
    timestamp: "2026-01-01T00:00:03.000Z",
    fps: 0,
    frames: 0,
    durationMs: 0,
    refreshHz: 120,
    longFrameEvents: [{
      timestamp: "2026-01-01T00:00:02.000Z",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 42,
      activeGapMs: 42,
      buildMs: 14.2,
      rasterMs: 9.8,
      scope: "flutterView",
      context: "page=performance;action=Opened performance",
      page: "performance",
      action: "Opened performance",
    }],
  });
  const earlierSample = parsePerformancePoint({
    timestamp: "2026-01-01T00:00:01.000Z",
    fps: 0,
    frames: 0,
    durationMs: 0,
    refreshHz: 120,
    longFrameEvents: [{
      timestamp: "2026-01-01T00:00:01.000Z",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 25,
      activeGapMs: 25,
      buildMs: 6.0,
      rasterMs: 4.0,
      nativeMs: 2.0,
      scope: "flutterView",
    }],
  });
  let twoPhaseSnapshot = parsePerformanceSnapshot({ latest: null, history: [], recording: true });
  twoPhaseSnapshot = appendPerformanceSample(twoPhaseSnapshot, phase1Sample!, false);
  twoPhaseSnapshot = appendPerformanceSample(twoPhaseSnapshot, phase2Sample!, false);
  twoPhaseSnapshot = appendPerformanceSample(twoPhaseSnapshot, earlierSample!, false);
  assert.equal(twoPhaseSnapshot.longFrameEvents?.length, 2);
  assert.equal(twoPhaseSnapshot.longFrameEvents?.[0]?.timestamp, "2026-01-01T00:00:01.000Z");
  const mergedEvent = twoPhaseSnapshot.longFrameEvents?.[1];
  assert.equal(mergedEvent?.timestamp, "2026-01-01T00:00:02.000Z");
  assert.equal(mergedEvent?.scope, "flutterView");
  assert.equal(mergedEvent?.buildMs, 14.2);
  assert.equal(mergedEvent?.rasterMs, 9.8);
  assert.equal(mergedEvent?.nativeMs, 5.5);
  assert.equal(mergedEvent?.context, "page=stress;action=Run 500 nodes");
  assert.equal(mergedEvent?.page, "stress");
  assert.equal(mergedEvent?.action, "Run 500 nodes");

  // parsePerformanceSnapshot must keep enriched top-level longFrameEvents over
  // stale unenriched point.longFrameEvents in history.
  const snapshotWithStaleHistory = parsePerformanceSnapshot({
    latest: {
      timestamp: "2026-01-01T00:00:05.000Z",
      fps: 55,
      refreshHz: 120,
      activeGapMs: 36,
      longFrameEvents: [{
        timestamp: "2026-01-01T00:00:04.500Z",
        refreshHz: 120,
        budgetMs: 1000 / 120,
        durationMs: 36,
        activeGapMs: 36,
        nativeMs: 3.2,
        scope: "pocketView",
        context: "page=stress;action=Run 500 nodes",
        page: "stress",
        action: "Run 500 nodes",
      }],
    },
    history: [{
      timestamp: "2026-01-01T00:00:05.000Z",
      fps: 55,
      refreshHz: 120,
      activeGapMs: 36,
      longFrameEvents: [{
        timestamp: "2026-01-01T00:00:04.500Z",
        refreshHz: 120,
        budgetMs: 1000 / 120,
        durationMs: 36,
        activeGapMs: 36,
        nativeMs: 3.2,
        scope: "pocketView",
        context: "page=stress;action=Run 500 nodes",
        page: "stress",
        action: "Run 500 nodes",
      }],
    }],
    longFrameEvents: [{
      timestamp: "2026-01-01T00:00:04.500Z",
      refreshHz: 120,
      budgetMs: 1000 / 120,
      durationMs: 36,
      activeGapMs: 36,
      buildMs: 11.4,
      rasterMs: 7.9,
      nativeMs: 3.2,
      scope: "flutterView",
      context: "page=stress;action=Run 500 nodes",
      page: "stress",
      action: "Run 500 nodes",
    }],
    recording: true,
  });
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.length, 1);
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.scope, "flutterView");
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.buildMs, 11.4);
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.rasterMs, 7.9);
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.nativeMs, 3.2);
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.page, "stress");
  assert.equal(snapshotWithStaleHistory.longFrameEvents?.[0]?.action, "Run 500 nodes");
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
  assert.match(appSource, /host\.request<JsonValue>\("runtime\.performance", \{ context \}\)/);
  assert.match(appSource, /page=\$\{current\.route\}/);
  assert.match(appSource, /ScrollablePage/);
  assert.match(appSource, /createSignal<PerformanceSnapshot>/);
  assert.match(appSource, /setPerformance/);
  assert.match(appSource, /appendPerformanceSample/);
  assert.match(appSource, /params\.eventOnly !== true/);
  assert.match(appSource, /Frame diagnostics/);
  assert.match(appSource, /Recent 60 samples/);
  assert.match(appSource, /Lowest guest tick samples/);
  assert.match(appSource, /Recent long frames/);
  assert.match(appSource, /UI build/);
  assert.match(appSource, /Bridge\/decode/);
  assert.match(appSource, /Flutter view/);
  assert.match(appSource, /scope/);
  assert.match(appSource, /active gap/);
  assert.match(appSource, /Sparse rendering is not a stall/);
  assert.match(appSource, /nativeMsP95/);
  assert.match(appSource, /nativeWorkMsP95/);
  assert.match(appSource, /refreshHz/);
  assert.match(appSource, /PERFORMANCE_JANK_LIMIT/);
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
