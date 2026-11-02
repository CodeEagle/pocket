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
  | "glass"
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

export type PerformanceTimestamp = string | number;

export interface PerformancePoint {
  timestamp: PerformanceTimestamp;
  fps: number;
  minFps?: number;
  maxGapMs: number;
  slowFrames: number;
  nativeMsP95: number;
}

export interface PerformanceSnapshot {
  latest: PerformancePoint | null;
  history: PerformancePoint[];
  recording: boolean;
}

export const PERFORMANCE_HISTORY_LIMIT = 60;

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

/** Parse only provider-produced samples with all required measurements. */
export function parsePerformancePoint(value: unknown): PerformancePoint | undefined {
  if (!isRecord(value)) return undefined;
  const timestamp = timestampOf(value.timestamp);
  const fps = finiteNumber(value.fps);
  const maxGapMs = finiteNumber(value.maxGapMs);
  const slowFrames = finiteNumber(value.slowFrames);
  const nativeMsP95 = finiteNumber(value.nativeMsP95);
  if (
    timestamp === undefined ||
    fps === undefined ||
    maxGapMs === undefined ||
    slowFrames === undefined ||
    nativeMsP95 === undefined ||
    fps < 0 ||
    maxGapMs < 0 ||
    slowFrames < 0 ||
    nativeMsP95 < 0
  ) {
    return undefined;
  }
  const minFps = finiteNumber(value.minFps);
  return {
    timestamp,
    fps,
    ...(minFps !== undefined && minFps >= 0 ? { minFps } : {}),
    maxGapMs,
    slowFrames,
    nativeMsP95,
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

function mergePerformancePoint(history: PerformancePoint[], sample: PerformancePoint): PerformancePoint[] {
  const previous = history[history.length - 1];
  if (previous && sameTimestamp(previous.timestamp, sample.timestamp)) {
    return [...history.slice(0, -1), sample];
  }
  return [...history, sample];
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
  return {
    latest: latest ?? null,
    history,
    recording: value.recording === true,
  };
}

export function appendPerformanceSample(
  snapshot: PerformanceSnapshot,
  sample: PerformancePoint,
): PerformanceSnapshot {
  return {
    latest: sample,
    history: boundedHistory(mergePerformancePoint(snapshot.history, sample)),
    recording: snapshot.recording,
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
      return withCapability(state, event.key, {
        phase: "ready",
        requestId: event.requestId,
        result: event.result,
        error: null,
      });
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

