/**
 * The guest's single application state model.
 *
 * Flutter only transports the events and paints the resulting frame. Even
 * capability loading is represented here so an async host response cannot
 * become a second state source in Dart.
 */

import type { TransitionMode } from "@pocket/ui";

export type Route =
  | "home"
  | "gallery"
  | "about"
  | "bytecode"
  | "updates"
  | "plugins"
  | "stress"
  | "performance"
  | "mobile"
  | "transitions"
  | "hardware";

export type { TransitionMode } from "@pocket/ui";

export type HardwareCapability =
  | "hardware.permissions"
  | "hardware.permissions.request"
  | "hardware.camera.preview.start"
  | "hardware.camera.preview.stop"
  | "hardware.camera.lens.switch"
  | "hardware.camera.flash.toggle"
  | "hardware.camera.capture"
  | "hardware.photos.list"
  | "hardware.photos.delete"
  | "hardware.bluetooth.scan"
  | "hardware.bluetooth.connect"
  | "hardware.sensors.read"
  | "hardware.biometrics.authenticate"
  | "hardware.location.current"
  | "hardware.weather.current";

export type HardwarePermission =
  | "hardware.camera"
  | "hardware.photos"
  | "hardware.bluetooth"
  | "hardware.sensors"
  | "hardware.biometrics"
  | "hardware.location"
  | "hardware.microphone"
  | "hardware.network";

export type CapabilityKey =
  | "runtimeInfo"
  | "pluginsList"
  | "packageInfo"
  | "updatesStatus"
  | "updatesCheck"
  | "updatesApply"
  | "updatesRollback"
  | "runtimePerformance"
  | "hardwarePermissions"
  | "hardwarePermissionRequest"
  | "hardwareCameraPreviewStart"
  | "hardwareCameraPreviewStop"
  | "hardwareCameraLensSwitch"
  | "hardwareCameraFlashToggle"
  | "hardwareCameraCapture"
  | "hardwarePhotosList"
  | "hardwarePhotosDelete"
  | "hardwareBluetoothScan"
  | "hardwareBluetoothConnect"
  | "hardwareSensorsRead"
  | "hardwareBiometricsAuthenticate"
  | "hardwareLocationCurrent"
  | "hardwareWeatherCurrent";

export type CapabilityPhase = "idle" | "loading" | "ready" | "error";

export interface CapabilityError {
  code: string;
  message: string;
}

export interface CapabilityState {
  phase: CapabilityPhase;
  requestId: string | null;
  result: unknown;
  error: CapabilityError | null;
}

export interface StressState {
  nodeCount: number;
  checksum: number;
  durationMs: number;
  lastAction: string;
}

export interface CameraPreviewState {
  phase: CapabilityPhase;
  lens?: string;
  surfaceId?: number;
  width?: number;
  height?: number;
  detail?: string;
}

export type PerformanceTimestamp = string | number;

/**
 * A long-frame event emitted by the host's real frame-timing sampler.
 *
 * The event intentionally keeps the four possible sources separate.  A low
 * FPS window is not enough to call a frame a jank event: a guest may only
 * render when dirty, which produces a low average FPS while its active gaps
 * remain zero.  `budgetMs` is the budget for the display refresh rate
 * observed by the host, not a JS-side 60 Hz assumption.
 */
export interface PerformanceJank {
  timestamp: PerformanceTimestamp;
  refreshHz?: number;
  /** Canonical host field for one display frame budget. */
  budgetMs?: number;
  durationMs?: number;
  buildMs?: number;
  rasterMs?: number;
  /** Bridge/decode path duration; this is not pure Rust/native CPU time. */
  nativeMs?: number;
  activeGapMs?: number;
  active?: boolean;
  /** Host measurement scope, for example flutterView or pocketView. */
  scope?: string;
  reason?: string;
  context?: string;
  page?: string;
  action?: string;
}

export interface PerformancePoint {
  timestamp: PerformanceTimestamp;
  fps: number;
  minFps?: number;
  /** Compatibility aggregate retained for existing FPS history providers. */
  maxGapMs?: number;
  /** Compatibility aggregate retained for existing FPS history providers. */
  slowFrames?: number;
  /** Compatibility bridge/native path metric; not pure native work. */
  nativeMsP95?: number;
  refreshHz?: number;
  frameBudgetMs?: number;
  buildMsP95?: number;
  rasterMsP95?: number;
  nativeWorkMsP95?: number;
  activeGapMs?: number;
  activeGapCount?: number;
  /** Canonical host list of active long-frame events. */
  longFrameEvents?: PerformanceJank[];
  longFrameCount?: number;
  /** Compatibility count accepted from older providers. */
  longFrames?: number;
  /** Host diagnostic context. Page/action context is attached in JS. */
  context?: string;
  page?: string;
  action?: string;
}

export interface PerformanceSnapshot {
  latest: PerformancePoint | null;
  history: PerformancePoint[];
  recording: boolean;
  /** Canonical persisted host list of active long-frame events. */
  longFrameEvents?: PerformanceJank[];
  /** Host diagnostic context, if the provider exposes one. */
  context?: string;
}

export const PERFORMANCE_HISTORY_LIMIT = 60;
export const PERFORMANCE_JANK_LIMIT = 60;

export interface DemoState {
  route: Route;
  routeStack: Route[];
  transitionMode: TransitionMode;
  count: number;
  draft: string;
  selectedComponent: string | null;
  detailsOpen: boolean;
  lazyVisible: boolean;
  /** Shared mobile showcase theme; the root canvas mirrors this signal. */
  mobileDark: boolean;
  lastAction: string;
  runtimeInfo: CapabilityState;
  pluginsList: CapabilityState;
  packageInfo: CapabilityState;
  updatesStatus: CapabilityState;
  updatesCheck: CapabilityState;
  updatesApply: CapabilityState;
  updatesRollback: CapabilityState;
  runtimePerformance: CapabilityState;
  hardwarePermissions: CapabilityState;
  hardwarePermissionRequest: CapabilityState;
  hardwareCameraPreviewStart: CapabilityState;
  hardwareCameraPreviewStop: CapabilityState;
  hardwareCameraLensSwitch: CapabilityState;
  hardwareCameraFlashToggle: CapabilityState;
  hardwareCameraCapture: CapabilityState;
  hardwarePhotosList: CapabilityState;
  hardwarePhotosDelete: CapabilityState;
  hardwareBluetoothScan: CapabilityState;
  hardwareBluetoothConnect: CapabilityState;
  hardwareSensorsRead: CapabilityState;
  hardwareBiometricsAuthenticate: CapabilityState;
  hardwareLocationCurrent: CapabilityState;
  hardwareWeatherCurrent: CapabilityState;
  cameraPreview: CameraPreviewState;
  stress: StressState;
}

export type DemoEvent =
  | { type: "navigate"; route: Route }
  | { type: "popRoute" }
  | { type: "setTransitionMode"; mode: TransitionMode }
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "draft"; value: string }
  | { type: "select"; component: string }
  | { type: "closeDetails" }
  | { type: "toggleLazy" }
  | { type: "setMobileDark"; value: boolean }
  | { type: "capabilityStart"; key: CapabilityKey; requestId: string }
  | { type: "capabilitySuccess"; key: CapabilityKey; requestId: string; result: unknown }
  | { type: "capabilityFailure"; key: CapabilityKey; requestId: string; code: string; message: string }
  | { type: "stressRun"; nodeCount: number; checksum: number; durationMs: number };

function idleCapability(): CapabilityState {
  return { phase: "idle", requestId: null, result: null, error: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampOf(value: unknown): PerformanceTimestamp | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

function positiveNumber(value: unknown, maximum = 3600000): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 && number <= maximum ? number : undefined;
}

function firstNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) return number;
  }
  return undefined;
}

function firstPositiveNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const number = positiveNumber(value[key]);
    if (number !== undefined) return number;
  }
  return undefined;
}

function hasNegativeNumber(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const number = finiteNumber(value[key]);
    return number !== undefined && number < 0;
  });
}

function contextString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parse one explicit long-frame record, accepting the native aliases. */
export function parsePerformanceJank(
  value: unknown,
  fallbackTimestamp?: PerformanceTimestamp,
  fallbackRefreshHz?: number,
): PerformanceJank | undefined {
  if (!isRecord(value)) return undefined;
  const timestamp = timestampOf(value.timestamp) ?? timestampOf(value.at) ?? fallbackTimestamp;
  if (timestamp === undefined) return undefined;
  const refreshHz = firstPositiveNumber(value, ["refreshHz", "displayHz"]) ?? fallbackRefreshHz;
  const budgetMs = firstPositiveNumber(value, ["budgetMs", "frameBudgetMs"])
    ?? (refreshHz !== undefined ? 1000 / refreshHz : undefined);
  const durationMs = firstPositiveNumber(value, ["durationMs", "frameDurationMs", "elapsedMs"]);
  const buildMs = firstNumber(value, ["buildMs", "uiBuildMs", "buildDurationMs"]);
  const rasterMs = firstNumber(value, ["rasterMs", "uiRasterMs", "rasterDurationMs"]);
  const nativeMs = firstNumber(value, ["nativeMs", "nativeWorkMs", "nativeDurationMs", "nativeWork"]);
  const activeGapMs = firstNumber(value, ["activeGapMs", "gapMs", "frameGapMs"]);
  const active = typeof value.active === "boolean" ? value.active : undefined;
  const scope = contextString(value.scope);
  // The host persists only active-frame facts. An explicit idle marker must
  // never become a user-visible jank event after transport or replay.
  if (active === false) return undefined;
  if (hasNegativeNumber(value, [
    "durationMs", "frameDurationMs", "elapsedMs", "buildMs", "uiBuildMs",
    "buildDurationMs", "rasterMs", "uiRasterMs", "rasterDurationMs", "nativeMs",
    "nativeWorkMs", "nativeDurationMs", "nativeWork", "activeGapMs", "gapMs",
    "frameGapMs",
  ])) return undefined;
  const reason = contextString(value.reason ?? value.kind ?? value.phase);
  const context = contextString(value.context);
  const page = contextString(value.page ?? value.route);
  const action = contextString(value.action ?? value.lastAction);
  // Do not turn an arbitrary `jank` marker into a fake event. Require at
  // least one measured duration/gap or an explicit reason from the provider.
  if (
    durationMs === undefined &&
    buildMs === undefined &&
    rasterMs === undefined &&
    nativeMs === undefined &&
    activeGapMs === undefined &&
    reason === undefined
  ) return undefined;
  return {
    timestamp,
    ...(refreshHz !== undefined ? { refreshHz } : {}),
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(buildMs !== undefined && buildMs >= 0 ? { buildMs } : {}),
    ...(rasterMs !== undefined && rasterMs >= 0 ? { rasterMs } : {}),
    ...(nativeMs !== undefined && nativeMs >= 0 ? { nativeMs } : {}),
    ...(activeGapMs !== undefined && activeGapMs >= 0 ? { activeGapMs } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

function jankItems(value: unknown): unknown[] {
  if (isRecord(value)) {
    const nested = value.longFrameEvents ?? value.events ?? value.items;
    if (nested !== undefined) return jankItems(nested);
  }
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function parsedJank(value: Record<string, unknown>, timestamp: PerformanceTimestamp, refreshHz?: number): PerformanceJank[] {
  const source = value.longFrameEvents ?? value.jank ?? value.longFrames ?? value.longFrame;
  return jankItems(source).flatMap((item) => {
    const parsed = parsePerformanceJank(item, timestamp, refreshHz);
    return parsed ? [parsed] : [];
  });
}

/** Parse only provider-produced samples with all required measurements. */
export function parsePerformancePoint(value: unknown): PerformancePoint | undefined {
  if (!isRecord(value)) return undefined;
  const timestamp = timestampOf(value.timestamp);
  const fps = finiteNumber(value.fps);
  if (timestamp === undefined || fps === undefined || fps < 0) return undefined;
  if (hasNegativeNumber(value, [
    "minFps", "maxGapMs", "activeGapMs", "maxActiveGapMs", "slowFrames",
    "activeGapCount", "nativeMsP95", "refreshHz", "displayHz", "frameBudgetMs",
    "budgetMs", "buildMsP95", "uiBuildMsP95", "rasterMsP95", "uiRasterMsP95",
    "nativeWorkMsP95", "nativeWorkP95Ms", "longFrames", "longFrameCount",
  ])) return undefined;
  const refreshHz = firstPositiveNumber(value, ["refreshHz", "displayHz"]);
  const frameBudgetMs = firstPositiveNumber(value, ["frameBudgetMs", "budgetMs"])
    ?? (refreshHz !== undefined ? 1000 / refreshHz : undefined);
  const activeGapMs = firstNumber(value, ["activeGapMs", "maxActiveGapMs"]);
  const maxGapMs = finiteNumber(value.maxGapMs) ?? activeGapMs;
  const jank = parsedJank(value, timestamp, refreshHz);
  const slowFrames = finiteNumber(value.slowFrames)
    ?? finiteNumber(value.activeGapCount)
    ?? finiteNumber(value.longFrames)
    ?? (jank.length > 0 ? jank.length : undefined);
  const nativeMsP95 = finiteNumber(value.nativeMsP95);
  const buildMsP95 = firstNumber(value, ["buildMsP95", "uiBuildMsP95"]);
  const rasterMsP95 = firstNumber(value, ["rasterMsP95", "uiRasterMsP95"]);
  const nativeWorkMsP95 = firstNumber(value, ["nativeWorkMsP95", "nativeWorkP95Ms"]);
  const activeGapCount = finiteNumber(value.activeGapCount);
  const longFrames = finiteNumber(value.longFrames) ?? (jank.length > 0 ? jank.length : undefined);
  const longFrameCount = finiteNumber(value.longFrameCount) ?? (jank.length > 0 ? jank.length : undefined);
  // Legacy hosts must continue to parse, while newer hosts may omit the
  // compatibility aggregates once the explicit breakdown is available.
  const hasExplicitMetrics =
    refreshHz !== undefined ||
    frameBudgetMs !== undefined ||
    activeGapMs !== undefined ||
    buildMsP95 !== undefined ||
    rasterMsP95 !== undefined ||
    nativeWorkMsP95 !== undefined ||
    jank.length > 0;
  if (
    !hasExplicitMetrics &&
    (maxGapMs === undefined || slowFrames === undefined || nativeMsP95 === undefined)
  ) return undefined;
  const minFps = finiteNumber(value.minFps);
  return {
    timestamp,
    fps,
    ...(minFps !== undefined && minFps >= 0 ? { minFps } : {}),
    ...(maxGapMs !== undefined && maxGapMs >= 0 ? { maxGapMs } : {}),
    ...(slowFrames !== undefined && slowFrames >= 0 ? { slowFrames } : {}),
    ...(nativeMsP95 !== undefined && nativeMsP95 >= 0 ? { nativeMsP95 } : {}),
    ...(refreshHz !== undefined ? { refreshHz } : {}),
    ...(frameBudgetMs !== undefined ? { frameBudgetMs } : {}),
    ...(buildMsP95 !== undefined && buildMsP95 >= 0 ? { buildMsP95 } : {}),
    ...(rasterMsP95 !== undefined && rasterMsP95 >= 0 ? { rasterMsP95 } : {}),
    ...(nativeWorkMsP95 !== undefined && nativeWorkMsP95 >= 0 ? { nativeWorkMsP95 } : {}),
    ...(activeGapMs !== undefined && activeGapMs >= 0 ? { activeGapMs } : {}),
    ...(activeGapCount !== undefined && activeGapCount >= 0 ? { activeGapCount } : {}),
    ...(longFrames !== undefined && longFrames >= 0 ? { longFrames } : {}),
    ...(longFrameCount !== undefined && longFrameCount >= 0 ? { longFrameCount } : {}),
    ...(jank.length > 0 ? { longFrameEvents: jank } : {}),
    ...(contextString(value.context) !== undefined ? { context: contextString(value.context) } : {}),
    ...(contextString(value.page ?? value.route) !== undefined ? { page: contextString(value.page ?? value.route) } : {}),
    ...(contextString(value.action ?? value.lastAction) !== undefined ? { action: contextString(value.action ?? value.lastAction) } : {}),
  };
}

function sameTimestamp(first: PerformanceTimestamp, second: PerformanceTimestamp): boolean {
  return String(first) === String(second);
}

function boundedHistory(history: PerformancePoint[]): PerformancePoint[] {
  return history.length <= PERFORMANCE_HISTORY_LIMIT
    ? history
    : history.slice(history.length - PERFORMANCE_HISTORY_LIMIT);
}

function boundedJank(history: PerformanceJank[]): PerformanceJank[] {
  return history.length <= PERFORMANCE_JANK_LIMIT
    ? history
    : history.slice(history.length - PERFORMANCE_JANK_LIMIT);
}

function mergePerformancePoint(history: PerformancePoint[], sample: PerformancePoint): PerformancePoint[] {
  const previous = history[history.length - 1];
  if (previous && sameTimestamp(previous.timestamp, sample.timestamp)) {
    return [...history.slice(0, -1), sample];
  }
  return [...history, sample];
}

function sameJank(first: PerformanceJank, second: PerformanceJank): boolean {
  return String(first.timestamp) === String(second.timestamp) &&
    first.scope === second.scope &&
    first.activeGapMs === second.activeGapMs &&
    first.durationMs === second.durationMs &&
    first.buildMs === second.buildMs &&
    first.rasterMs === second.rasterMs &&
    first.nativeMs === second.nativeMs;
}

function mergeJank(history: PerformanceJank[], sample: PerformanceJank[]): PerformanceJank[] {
  const merged = [...history];
  for (const item of sample) {
    const index = merged.findIndex((existing) => sameJank(existing, item));
    if (index >= 0) merged[index] = item;
    else merged.push(item);
  }
  return boundedJank(merged);
}

/** Convert the host's runtime.performance result without inventing values. */
export function parsePerformanceSnapshot(value: unknown): PerformanceSnapshot {
  if (!isRecord(value)) return { latest: null, history: [], recording: false };
  const latest = parsePerformancePoint(value.latest);
  const history = Array.isArray(value.history)
    ? boundedHistory(value.history.flatMap((item) => {
        const point = parsePerformancePoint(item);
        return point ? [point] : [];
      }))
    : [];
  const explicitJank = jankItems(value.longFrameEvents ?? value.jank ?? value.longFrames).flatMap((item) => {
    const parsed = parsePerformanceJank(item);
    return parsed ? [parsed] : [];
  });
  const historyJank = [
    ...history.flatMap((point) => point.longFrameEvents ?? []),
    ...(latest?.longFrameEvents ?? []),
  ];
  return {
    latest: latest ?? null,
    history,
    recording: value.recording === true,
    ...(explicitJank.length > 0 || historyJank.length > 0
      ? { longFrameEvents: boundedJank(mergeJank(explicitJank, historyJank)) }
      : {}),
    ...(contextString(value.context) !== undefined ? { context: contextString(value.context) } : {}),
  };
}

export function appendPerformanceSample(
  snapshot: PerformanceSnapshot,
  sample: PerformancePoint,
  recordFps = true,
): PerformanceSnapshot {
  const longFrameEvents = mergeJank(snapshot.longFrameEvents ?? [], sample.longFrameEvents ?? []);
  return {
    // Event-only host bursts intentionally carry fps=0/frames=0 because no
    // cadence window was observed. Keep those diagnostics without replacing
    // the last real FPS point or adding a poisoned history entry.
    latest: recordFps ? sample : snapshot.latest,
    history: recordFps ? boundedHistory(mergePerformancePoint(snapshot.history, sample)) : snapshot.history,
    recording: snapshot.recording,
    ...(longFrameEvents.length > 0
      ? { longFrameEvents }
      : {}),
    ...(snapshot.context !== undefined ? { context: snapshot.context } : {}),
  };
}

export function initialDemoState(): DemoState {
  return {
    route: "home",
    count: 0,
    draft: "",
    selectedComponent: null,
    detailsOpen: false,
    lazyVisible: false,
    mobileDark: false,
    lastAction: "Ready",
    runtimeInfo: idleCapability(),
    pluginsList: idleCapability(),
    packageInfo: idleCapability(),
    updatesStatus: idleCapability(),
    updatesCheck: idleCapability(),
    updatesApply: idleCapability(),
    updatesRollback: idleCapability(),
    runtimePerformance: idleCapability(),
    hardwarePermissions: idleCapability(),
    hardwarePermissionRequest: idleCapability(),
    hardwareCameraPreviewStart: idleCapability(),
    hardwareCameraPreviewStop: idleCapability(),
    hardwareCameraLensSwitch: idleCapability(),
    hardwareCameraFlashToggle: idleCapability(),
    hardwareCameraCapture: idleCapability(),
    hardwarePhotosList: idleCapability(),
    hardwarePhotosDelete: idleCapability(),
    hardwareBluetoothScan: idleCapability(),
    hardwareBluetoothConnect: idleCapability(),
    hardwareSensorsRead: idleCapability(),
    hardwareBiometricsAuthenticate: idleCapability(),
    hardwareLocationCurrent: idleCapability(),
    hardwareWeatherCurrent: idleCapability(),
    cameraPreview: {
      phase: "idle",
      lens: "back",
      surfaceId: undefined,
      width: undefined,
      height: undefined,
      detail: "Preview idle",
    },
    routeStack: ["home"],
    transitionMode: "IOS_SPRING_PARALLAX",
    stress: { nodeCount: 0, checksum: 0, durationMs: 0, lastAction: "Not run" },
  };
}

function capabilityState(state: DemoState, key: CapabilityKey): CapabilityState {
  return state[key];
}

function withCapability(state: DemoState, key: CapabilityKey, value: CapabilityState): DemoState {
  return { ...state, [key]: value } as DemoState;
}

export function reduceDemoState(state: DemoState, event: DemoEvent): DemoState {
  const action = event as unknown as Record<string, unknown>;
  if (action.operation === "cameraStop" || action.type === "cameraStop") {
    return {
      ...state,
      cameraPreview: {
        phase: "idle",
        lens: state.cameraPreview.lens,
        surfaceId: undefined,
        width: undefined,
        height: undefined,
        detail: "Preview stopped",
      },
      hardwareCameraPreviewStart: idleCapability(),
      hardwareCameraPreviewStop: {
        phase: "ready",
        requestId: null,
        result: { stopped: true },
        error: null,
      },
      lastAction: "Preview stopped",
    };
  }
  switch (event.type) {
    case "navigate":
      {
        const existing = state.routeStack.lastIndexOf(event.route);
        const routeStack = existing >= 0
          ? state.routeStack.slice(0, existing + 1)
          : [...state.routeStack, event.route].slice(-8);
        return {
          ...state,
          route: event.route,
          routeStack,
          detailsOpen: false,
          lastAction: `Navigated to ${event.route}`,
        };
      }
    case "popRoute": {
      if (state.routeStack.length <= 1) return state;
      const routeStack = state.routeStack.slice(0, -1);
      return {
        ...state,
        route: routeStack[routeStack.length - 1] ?? "home",
        routeStack,
        detailsOpen: false,
        lastAction: "Popped route",
      };
    }
    case "setTransitionMode":
      return { ...state, transitionMode: event.mode, lastAction: `Transition ${event.mode}` };
    case "increment":
      return { ...state, count: state.count + 1, lastAction: "Incremented in JS" };
    case "decrement":
      return { ...state, count: state.count - 1, lastAction: "Decremented in JS" };
    case "draft":
      return { ...state, draft: event.value, lastAction: "Input changed in JS" };
    case "select":
      return {
        ...state,
        selectedComponent: event.component,
        detailsOpen: true,
        lastAction: `Opened ${event.component}`,
      };
    case "closeDetails":
      return { ...state, detailsOpen: false, lastAction: "Closed details" };
    case "toggleLazy":
      return {
        ...state,
        lazyVisible: !state.lazyVisible,
        lastAction: state.lazyVisible ? "Lazy panel hidden" : "Lazy panel shown",
      };
    case "setMobileDark":
      return {
        ...state,
        mobileDark: event.value,
        lastAction: event.value ? "Mobile theme set to dark" : "Mobile theme set to light",
      };
    case "capabilityStart":
      return withCapability(state, event.key, {
        phase: "loading",
        requestId: event.requestId,
        result: null,
        error: null,
      });
    case "capabilitySuccess": {
      const current = capabilityState(state, event.key);
      if (current.requestId !== event.requestId) return state;
      let nextState = withCapability(state, event.key, {
        phase: "ready",
        requestId: event.requestId,
        result: event.result,
        error: null,
      });
      if (event.key === "hardwareCameraPreviewStop") {
        nextState = {
          ...nextState,
          cameraPreview: {
            phase: "idle",
            lens: state.cameraPreview.lens,
            surfaceId: undefined,
            width: undefined,
            height: undefined,
            detail: "Preview stopped",
          },
          hardwareCameraPreviewStart: idleCapability(),
        };
      } else if (event.key === "hardwareCameraPreviewStart") {
        const res = isRecord(event.result) ? event.result : {};
        nextState = {
          ...nextState,
          cameraPreview: {
            phase: "ready",
            lens: typeof res.lens === "string" ? res.lens : state.cameraPreview.lens,
            surfaceId:
              typeof res.textureId === "number"
                ? res.textureId
                : typeof res.surfaceId === "number"
                ? res.surfaceId
                : undefined,
            width: typeof res.width === "number" ? res.width : undefined,
            height: typeof res.height === "number" ? res.height : undefined,
            detail: "Preview active",
          },
        };
      }
      return nextState;
    }
    case "capabilityFailure": {
      const current = capabilityState(state, event.key);
      if (current.requestId !== event.requestId) return state;
      return withCapability(state, event.key, {
        phase: "error",
        requestId: event.requestId,
        result: null,
        error: { code: event.code, message: event.message },
      });
    }
    case "stressRun":
      return {
        ...state,
        stress: {
          nodeCount: event.nodeCount,
          checksum: event.checksum,
          durationMs: event.durationMs,
          lastAction: `Prepared ${event.nodeCount} stress nodes in JS`,
        },
        lastAction: "Stress test completed in JS",
      };
  }
}

