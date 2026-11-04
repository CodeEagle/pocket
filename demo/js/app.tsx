import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { after, simulationHz } from "@pocketjs/framework/clock";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import {
  FocusScope,
  Focusable,
  Image,
  Lazy,
  Named,
  Screen,
  Text,
  View,
} from "@pocketjs/framework/solid/components";
import {
  ActionButton,
  Badge,
  Card,
  DetailModal,
  EmptyState,
  Header,
  InputField,
  List,
  MetricCard,
  MiniBarChart,
  NavigationBar,
  PageIntro,
  Row,
  SectionHeading,
  ScrollablePage,
  StatusBar,
  Tabs,
  TileGrid,
  ViewText,
  deliverTextInputEvent,
} from "@pocket/ui";
import { HardwarePage, MobileUiPage, TransitionsPage } from "./mobile-pages.tsx";
import { createHostBridge, hostError, type HostBridge, type JsonValue } from "@pocket/ui/host";
import { RecordingPanel } from "./recording-panel.tsx";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createPlatformExperience, isUnsupportedPlatformError } from "@pocket/ui/platform-experience";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";
import { installShowcaseSystem } from "./system.ts";
import { demoRelease } from "./release.ts";
import { availableDisplayPanes, computeTransitionDescriptor, createDisplayGeometry, deriveResponsiveLayout } from "@pocket/ui";
import {
  PERFORMANCE_HISTORY_LIMIT,
  PERFORMANCE_JANK_LIMIT,
  initialDemoState,
  appendPerformanceSample,
  parsePerformancePoint,
  parsePerformanceSnapshot,
  reduceDemoState,
  type CapabilityKey,
  type CapabilityState,
  type DemoEvent,
  type DemoState,
  type PerformanceJank,
  type PerformancePoint,
  type PerformanceSnapshot,
  type Route,
} from "./state.ts";

type BridgeMessage = {
  type?: string;
  method?: string;
  name?: string;
  params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

const bridge = globalThis as typeof globalThis & {
  __pocketEvent?: (line: string) => void;
};

const componentCards = [
  "View",
  "Text",
  "Image",
  "Focusable",
  "Grid",
  "For",
  "Lazy",
  "Modal",
  "TextField",
];

const componentDetails: Record<string, string> = {
  View: "Flexible layout and spacing.",
  Text: "Typography drawn by Flutter.",
  Image: "Local images from the app bundle.",
  Focusable: "Tap and keyboard interactions.",
  Grid: "Responsive rows and columns.",
  For: "Reactive lists owned by JavaScript.",
  Lazy: "Mount content only when needed.",
  Modal: "A guest-controlled overlay.",
  TextField: "Native keyboard. State stays in JS.",
};

const hostTabs = [
  { id: "about", label: "Runtime" },
  { id: "bytecode", label: "Bytecode" },
  { id: "updates", label: "Updates" },
  { id: "plugins", label: "Plugins" },
  { id: "stress", label: "Stress" },
];

const demoTitle = "Pocket Host Lab";

function decode(line: string): BridgeMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as BridgeMessage : undefined;
  } catch {
    return undefined;
  }
}

function paramsOf(message: BridgeMessage): Record<string, unknown> {
  return message.params ?? message.payload ?? {};
}

function routeOf(value: unknown): Route | undefined {
  const route = String(value ?? "");
  // `gallery` remains the old probe's compatibility spelling for UI.
  if (route === "home" || route === "gallery" || route === "about" || route === "bytecode" || route === "updates" || route === "plugins" || route === "stress" || route === "performance" || route === "mobile" || route === "transitions" || route === "hardware") return route;
  if (route === "ui") return "gallery";
  return undefined;
}

function hostPhase(state: CapabilityState): string {
  if (state.phase === "idle") return "Not requested";
  if (state.phase === "loading") return "Loading";
  if (state.phase === "ready") return "Ready";
  return "Error";
}

function toneForPhase(state: CapabilityState): "cyan" | "green" | "amber" | "rose" {
  if (state.phase === "ready") return "green";
  if (state.phase === "error") return "rose";
  if (state.phase === "loading") return "amber";
  return "cyan";
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "No result payload";
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("entryFormat" in record || "runtimeAbi" in record) {
      const entry = String(record.entryFormat ?? "entry unknown");
      const abi = String(record.runtimeAbi ?? "ABI unknown");
      const version = record.version === undefined ? "" : ` · v${String(record.version)}`;
      const build = record.build === undefined ? "" : ` build ${String(record.build)}`;
      const source = record.source === undefined ? "" : ` · ${String(record.source)}`;
      const glass = record.glassRenderer === undefined ? "" : ` · glassRenderer=${String(record.glassRenderer)}`;
      const surfaces = record.hostSurfaces === undefined ? "" : ` · surfaces=${String(record.hostSurfaces)}`;
      return `${entry} · ${abi}${version}${build}${source}${glass}${surfaces}`;
    }
    if ("activeVersion" in record || "availableVersion" in record || "configured" in record) {
      return [
        `configured=${String(record.configured ?? "unknown")}`,
        `stage=${String(record.stage ?? "unknown")}`,
        `active=${String(record.activeVersion ?? "none")}`,
        `available=${String(record.availableVersion ?? "none")}`,
        `lastError=${String(record.lastError ?? "none")}`,
      ].join(" · ");
    }
    if ("history" in record && "recording" in record) {
      const history = Array.isArray(record.history) ? record.history.length : 0;
      const latest = record.latest && typeof record.latest === "object"
        ? String((record.latest as Record<string, unknown>).fps ?? "unknown")
        : "unknown";
      return `recording=${String(record.recording)} · samples=${history} · guestTicksPerSecond=${latest}`;
    }
    if (Array.isArray(record.plugins)) return `${record.plugins.length} plugin descriptor(s)`;
    if ("packageName" in record || "provider" in record) {
      return [record.provider, record.appName, record.packageName, record.version, record.buildNumber]
        .filter((entry) => entry !== undefined)
        .map(String)
        .join(" · ");
    }
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return String(value);
    return encoded.length > 180 ? `${encoded.slice(0, 177)}...` : encoded;
  } catch {
    return String(value);
  }
}

function capabilitySummary(state: CapabilityState): string {
  if (state.phase === "error") return `${state.error?.code ?? "host_error"}: ${state.error?.message ?? "Host request failed"}`;
  if (state.phase === "loading") return "Waiting for host.response...";
  if (state.phase === "idle") return "No host request has been made.";
  return valueSummary(state.result);
}

function summaryLines(value: string): string[] {
  // PocketJS text runs are deliberately explicit: keep provider diagnostics
  // readable on a 390px device instead of relying on Flutter text wrapping.
  const segments = value.split(" · ");
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment.length <= 34) {
      lines.push(segment);
      continue;
    }
    let remaining = segment;
    while (remaining.length > 34) {
      let cut = remaining.lastIndexOf(" ", 34);
      if (cut < 12) cut = 34;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines.length > 0 ? lines : ["No result payload"];
}

function listItems(value: unknown): { id: string; title: string; detail?: string }[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { plugins?: unknown }).plugins)
      ? (value as { plugins: unknown[] }).plugins
      : [];
  return source.map((item, index) => {
    if (item && typeof item === "object") {
      const record = item as { id?: unknown; name?: unknown; version?: unknown; description?: unknown };
      const title = String(record.name ?? record.id ?? `Plugin ${index + 1}`);
      const detail = [record.version, record.description].filter((entry) => entry !== undefined).map(String).join(" · ");
      return { id: `${index}-${title}`, title, detail: detail || undefined };
    }
    return { id: `${index}-${String(item)}`, title: String(item) };
  });
}

type VersionHistoryItem = { id: string; title: string; detail: string };

function versionHistory(value: unknown): VersionHistoryItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const versions = (value as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const version = String(record.version ?? record.versionId ?? `Version ${index + 1}`);
    const build = record.build === undefined ? "unknown" : String(record.build);
    const markers = [
      record.active === true ? "active" : "",
      record.previous === true ? "previous" : "",
      record.lastGood === true ? "last good" : "",
    ].filter(Boolean);
    return [{
      id: `${index}-${version}-${build}`,
      title: `${version} · build ${build}`,
      detail: markers.length > 0 ? markers.join(" · ") : "verified version",
    }];
  });
}

function stressItems(count: number): number[] {
  const items: number[] = [];
  for (let index = 0; index < count; index += 1) items.push(index);
  return items;
}

function metricNumber(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function timestampLabel(value: string | number): string {
  return String(value);
}

function recentPerformance(snapshot: PerformanceSnapshot): PerformancePoint[] {
  return snapshot.history.slice(-PERFORMANCE_HISTORY_LIMIT);
}

function performanceBudget(point: PerformancePoint | undefined): number | undefined {
  if (!point) return undefined;
  if (point.frameBudgetMs !== undefined && point.frameBudgetMs > 0) return point.frameBudgetMs;
  if (point.refreshHz !== undefined && point.refreshHz > 0) return 1000 / point.refreshHz;
  return undefined;
}

function performanceGap(point: PerformancePoint | undefined): number | undefined {
  if (!point) return undefined;
  return point.activeGapMs ?? point.maxGapMs;
}

function jankFromPoint(point: PerformancePoint): PerformanceJank[] {
  if (point.longFrameEvents && point.longFrameEvents.length > 0) return point.longFrameEvents;
  const gap = performanceGap(point);
  const budget = performanceBudget(point);
  const slowFrames = point.activeGapCount ?? point.slowFrames ?? 0;
  // Legacy samples already carry a provider-side slow-frame count. For newer
  // samples without that count, only classify a gap with the actual display
  // budget; a sparse guest that reports FPS 4.28 and gap 0 is not a jank.
  const exceedsBudget = gap !== undefined && budget !== undefined && gap > budget * 1.5;
  if (gap === undefined || (!exceedsBudget && slowFrames <= 0)) return [];
  return [{
    timestamp: point.timestamp,
    ...(gap !== undefined ? { durationMs: gap, activeGapMs: gap } : {}),
    ...(budget !== undefined ? { budgetMs: budget } : {}),
    reason: "window aggregate",
    ...(point.context !== undefined ? { context: point.context } : {}),
    ...(point.page !== undefined ? { page: point.page } : {}),
    ...(point.action !== undefined ? { action: point.action } : {}),
  }];
}

function sameJankEvent(first: PerformanceJank, second: PerformanceJank): boolean {
  if (String(first.timestamp) !== String(second.timestamp)) return false;
  if (first.reason === "window aggregate" || second.reason === "window aggregate") return true;
  const firstIdentity = first.context ?? (first.page || first.action ? `${first.page ?? ""}:${first.action ?? ""}` : undefined);
  const secondIdentity = second.context ?? (second.page || second.action ? `${second.page ?? ""}:${second.action ?? ""}` : undefined);
  if (firstIdentity !== undefined && secondIdentity !== undefined && firstIdentity !== secondIdentity) {
    const sharedFrameMetrics =
      (first.activeGapMs !== undefined && first.activeGapMs === second.activeGapMs) ||
      (first.durationMs !== undefined && first.durationMs === second.durationMs) ||
      (first.nativeMs !== undefined && first.nativeMs === second.nativeMs);
    if (!sharedFrameMetrics) return false;
  }
  return true;
}

function performanceScopeLabel(event: PerformanceJank): string {
  if (event.scope === "flutterView") return "Flutter view";
  if (event.scope === "pocketView") return "Pocket view";
  return event.scope ?? "Frame path";
}

function recentPerformanceJanks(snapshot: PerformanceSnapshot): PerformanceJank[] {
  const merged: PerformanceJank[] = [];
  const add = (event: PerformanceJank): void => {
    const index = merged.findIndex((existing) => sameJankEvent(existing, event));
    if (index >= 0) {
      const existing = merged[index]!;
      const refreshHz = event.refreshHz ?? existing.refreshHz;
      const budgetMs = event.budgetMs ?? existing.budgetMs;
      const durationMs = event.durationMs ?? existing.durationMs;
      const buildMs = event.buildMs ?? existing.buildMs;
      const rasterMs = event.rasterMs ?? existing.rasterMs;
      const nativeMs = event.nativeMs ?? existing.nativeMs;
      const activeGapMs = event.activeGapMs ?? existing.activeGapMs;
      const active = event.active ?? existing.active;
      const scope = event.scope === "flutterView" || existing.scope === "flutterView"
        ? "flutterView"
        : (event.scope ?? existing.scope);
      const reason = existing.reason ?? event.reason;
      const context = existing.context ?? event.context;
      const page = existing.page ?? event.page;
      const action = existing.action ?? event.action;
      merged[index] = {
        timestamp: existing.timestamp,
        ...(refreshHz !== undefined ? { refreshHz } : {}),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(buildMs !== undefined ? { buildMs } : {}),
        ...(rasterMs !== undefined ? { rasterMs } : {}),
        ...(nativeMs !== undefined ? { nativeMs } : {}),
        ...(activeGapMs !== undefined ? { activeGapMs } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(action !== undefined ? { action } : {}),
      };
    } else {
      merged.push(event);
    }
  };
  for (const event of snapshot.longFrameEvents ?? []) add(event);
  for (const point of recentPerformance(snapshot)) {
    for (const event of jankFromPoint(point)) add(event);
  }
  merged.sort((first, second) => {
    const firstTime = Date.parse(String(first.timestamp));
    const secondTime = Date.parse(String(second.timestamp));
    return Number.isFinite(firstTime) && Number.isFinite(secondTime) ? firstTime - secondTime : 0;
  });
  return merged.slice(-PERFORMANCE_JANK_LIMIT);
}

function performanceContextLabel(point: PerformanceJank): string {
  const page = point.page;
  const action = point.action;
  if (page && action) return `${page} · ${action}`;
  if (page) return page;
  if (action) return action;
  return point.context ?? "Host frame sampler";
}

function performanceJankRows(snapshot: PerformanceSnapshot): { id: string; title: string; detail: string; context: string }[] {
  return recentPerformanceJanks(snapshot)
    .slice()
    .reverse()
    .map((event, index) => {
      const gap = event.activeGapMs ?? event.durationMs;
      const metric = gap === undefined ? "long frame" : `${metricNumber(gap)} ms active gap`;
      const budgetMs = event.budgetMs;
      const budget = budgetMs === undefined ? "budget unavailable" : `budget ${metricNumber(budgetMs)} ms`;
      const breakdown = [
        event.buildMs === undefined ? "build —" : `build ${metricNumber(event.buildMs)} ms`,
        event.rasterMs === undefined ? "raster —" : `raster ${metricNumber(event.rasterMs)} ms`,
      ].join(" · ");
      const bridge = event.nativeMs === undefined ? "bridge/decode —" : `bridge/decode ${metricNumber(event.nativeMs)} ms`;
      const reason = event.reason ? ` · ${event.reason}` : "";
      return {
        id: `${index}-${String(event.timestamp)}-${String(gap ?? "long")}`,
        title: `${metric} · ${timestampLabel(event.timestamp)}${reason}`,
        detail: `${budget} · ${breakdown}`,
        context: `${bridge} · ${performanceScopeLabel(event)} · ${performanceContextLabel(event)}`,
      };
    });
}

function performanceBars(points: readonly PerformancePoint[]): number[] {
  if (points.length === 0) return [];
  // Use the visible sample window itself as the reference. Display refresh
  // rate and guest cadence can be 90/120/144Hz, so a 60 FPS floor would make
  // a high-refresh chart silently under-report those samples.
  const scale = Math.max(1, ...points.map((point) => point.fps));
  return points.map((point) => Math.max(4, Math.min(32, point.fps / scale * 32)));
}

function minimumPerformanceFps(points: readonly PerformancePoint[]): number | undefined {
  return points.length === 0 ? undefined : Math.min(...points.map((point) => point.fps));
}

function lowPerformanceRows(points: readonly PerformancePoint[]): { id: string; title: string; detail: string }[] {
  return [...points]
    .sort((first, second) => first.fps - second.fps)
    .slice(0, 5)
    .map((point, index) => ({
      id: `${index}-${String(point.timestamp)}`,
      title: `${metricNumber(point.fps)} guest ticks/s · ${timestampLabel(point.timestamp)}`,
      detail: `gap ${metricNumber(point.maxGapMs)} ms · slow ${metricNumber(point.slowFrames, 0)} · bridge/decode p95 ${metricNumber(point.nativeMsP95)} ms`,
    }));
}

function CapabilityCard(props: {
  title: string;
  capability: string;
  state: CapabilityState;
  onRefresh: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(true);
  const lines = () => summaryLines(capabilitySummary(props.state));
  return (
    <Card class="flex-col gap-2 mx-4 p-3 rounded-xl bg-white border-slate-200">
      <Row>
        <ViewText title={props.title} body={props.capability} />
        <Badge tone={toneForPhase(props.state)}>{hostPhase(props.state)}</Badge>
      </Row>
      <Show when={expanded()}>
        <View class="flex-col gap-1">
          <For each={lines()}>{(line) => <Text class="text-xs text-slate-600">{line}</Text>}</For>
        </View>
      </Show>
      <Row>
        <ActionButton label={expanded() ? "Hide details" : "Details"} kind="quiet" onPress={() => setExpanded(!expanded())} />
        <ActionButton label={props.state.phase === "loading" ? "Waiting" : "Refresh"} kind="quiet" onPress={props.onRefresh} />
      </Row>
    </Card>
  );
}

function App() {
  const [state, setState] = createSignal<DemoState>(initialDemoState());
  const displayGeometry = createDisplayGeometry();
  // MobileUiPage owns the theme choice in JS state. Keep the canvas itself in
  // the same palette so a dark mobile page never exposes the light Screen
  // behind a resized/scrolling subtree.
  const mobileDark = () => isShowcaseRoute(state().route) && state().mobileDark;
  const responsiveLayout = () => deriveResponsiveLayout(displayGeometry());
  const wideLayout = () => responsiveLayout().mode === "wide";
  const contentPaneWidth = (): number => Math.max(0, displayGeometry().width);
  const contentPaneStyle = () => ({
    grow: 1,
  });
  // Performance samples arrive independently of the application reducer. This
  // keeps a 1 Hz/host-driven metric stream from rebuilding Home/Stress trees.
  const [performance, setPerformance] = createSignal<PerformanceSnapshot>({
    latest: null,
    history: [],
    recording: false,
  });
  const [recordingStatus, setRecordingStatus] = createSignal<Record<string, unknown> | undefined>(undefined);
  // Capability providers such as BLE, biometrics and location can legitimately
  // take several seconds on a real device. Keep the request map bounded, but
  // give those providers a deterministic 30-second guest-clock window.
  const host = createHostBridge(undefined, {
    maxPendingRequests: 32,
    timeoutFrames: 30 * simulationHz(),
    scheduleTimeout: (frames, callback) => after(frames / simulationHz(), callback),
  });
  const system = installShowcaseSystem(host);
  const platform = createPocketPlatformClient(undefined, { bridge: host });
  const experience = createPlatformExperience(host);
  let systemUiKey = "";
  const syncSystemUi = (force = false): void => {
    const dark = mobileDark();
    const key = `${state().route}:${dark}`;
    if (!force && key === systemUiKey) return;
    systemUiKey = key;
    void experience.systemUi.set({
      statusBarColor: 0x00000000,
      statusBarIconBrightness: dark ? "light" : "dark",
      statusBarBrightness: dark ? "dark" : "light",
      systemNavigationBarColor: dark ? 0xff0e1728 : 0xfff5f6fa,
      systemNavigationBarIconBrightness: dark ? "light" : "dark",
    }).catch((error: unknown) => {
      if (!isUnsupportedPlatformError(error)) console.warn("system UI", hostError(error).code);
    });
  };
  createEffect(() => syncSystemUi());
  const removeExperienceLifecycle = platform.onLifecycle((event) => {
    if (event.state === "onResume" || event.state === "onDidAppear") syncSystemUi(true);
  });
  let requestSequence = 0;
  let lastPublishedPerformanceContext = "";
  const routeTransitionDuration = 220;
  const routeTransitionTickHz = simulationHz();
  let previousRoute: Route = initialDemoState().route;
  let pendingTransitionDirection: "forward" | "reverse" = "forward";
  const [routeTransition, setRouteTransition] = createSignal<{
    from: Route;
    to: Route;
    direction: "forward" | "reverse";
    elapsedMs: number;
    progress: number;
  } | undefined>(undefined);

  const publishPerformanceContext = (): void => {
    const current = state();
    const context = `page=${current.route} · action=${current.lastAction}`;
    if (context === lastPublishedPerformanceContext) return;
    lastPublishedPerformanceContext = context;
    // Context is diagnostic-only host state. Routing and action policy stay in
    // JS; the host merely attaches this bounded string to future long frames.
    void host.request<JsonValue>("runtime.performance", { context }).catch(() => {
      // Older hosts may ignore the optional context parameter. Realtime
      // samples still receive page/action labels below from the JS signal.
    });
  };

  const dispatch = (event: DemoEvent): void => {
    if (event.type === "navigate" && event.route !== state().route) pendingTransitionDirection = "forward";
    if (event.type === "popRoute" && state().routeStack.length > 1) pendingTransitionDirection = "reverse";
    setState((current) => reduceDemoState(current, event));
    if (event.type !== "capabilityStart" && event.type !== "capabilitySuccess" && event.type !== "capabilityFailure") {
      publishPerformanceContext();
    }
  };

  const navigate = (route: Route): void => dispatch({ type: "navigate", route });

  const isShowcaseRoute = (route: Route): boolean =>
    route === "mobile" || route === "transitions" || route === "hardware";

  const nowMs = (): number =>
    typeof globalThis.performance !== "undefined" && typeof globalThis.performance.now === "function"
      ? globalThis.performance.now()
      : Date.now();

  createEffect(() => {
    const nextRoute = state().route;
    if (nextRoute === previousRoute) return;
    const from = previousRoute;
    previousRoute = nextRoute;
    setRouteTransition({
      from,
      to: nextRoute,
      direction: pendingTransitionDirection,
      elapsedMs: 0,
      progress: 0,
    });
    pendingTransitionDirection = "forward";
  });

  const transitionDescriptor = () => {
    const transition = routeTransition();
    if (!transition || (!isShowcaseRoute(transition.from) && !isShowcaseRoute(transition.to))) {
      return computeTransitionDescriptor(state().transitionMode, 1, false, 360);
    }
    return computeTransitionDescriptor(
      state().transitionMode,
      transition.progress,
      transition.direction === "reverse",
      360,
    );
  };

  onFrame(() => {
    host.tick();
    const transition = routeTransition();
    if (!transition) return;
    const elapsedMs = transition.elapsedMs + 1000 / routeTransitionTickHz;
    const progress = Math.max(0, Math.min(1, elapsedMs / routeTransitionDuration));
    if (progress >= 1) {
      setRouteTransition(undefined);
    } else {
      setRouteTransition((current) => current ? { ...current, elapsedMs, progress } : current);
    }
  }, { continuous: () => routeTransition() !== undefined });

  const requestCapability = (key: CapabilityKey, capability: string, params: Record<string, JsonValue> = {}): void => {
    if (state()[key].phase === "loading") return;
    const requestId = `${capability}-${++requestSequence}`;
    dispatch({ type: "capabilityStart", key, requestId });
    host.request<JsonValue>(capability, params).then(
      (result) => {
        if (key === "runtimePerformance") setPerformance(parsePerformanceSnapshot(result));
        dispatch({ type: "capabilitySuccess", key, requestId, result });
      },
      (error) => {
        const failure = hostError(error);
        dispatch({ type: "capabilityFailure", key, requestId, code: failure.code, message: failure.message });
      },
    );
  };

  const runStress = (requestedNodes: number): void => {
    const nodeCount = requestedNodes === 500 ? 500 : 100;
    const startedAt = Date.now();
    let current = initialDemoState();
    let checksum = 0;
    for (let index = 0; index < nodeCount; index += 1) {
      current = reduceDemoState(current, { type: index % 2 === 0 ? "increment" : "decrement" });
      checksum = (checksum + current.count * (index + 1)) % 1000003;
    }
    dispatch({ type: "stressRun", nodeCount, checksum, durationMs: Math.max(0, Date.now() - startedAt) });
  };

  onMount(() => {
    const previous = bridge.__pocketEvent;
    const receive = (line: string): void => {
      // The previous sink installed by createHostBridge owns transport
      // delivery. Forward once below; equal sensor readings are real events.
      const message = decode(line);
      if (!message) return;
      const method = message.method ?? message.name ?? "";
      const params = paramsOf(message);
      if (deliverTextInputEvent(method, params)) {
        // The shell owns the input session; its callbacks dispatch the app
        // draft while preserving native selection/composing metadata.
      } else if (method === "demo.navigate") {
        const route = routeOf(params.route);
        if (route) navigate(route);
      } else if (method === "diagnostics.recording.started") {
        setRecordingStatus(params);
        navigate("about");
      } else if (method === "demo.increment") {
        dispatch({ type: "increment" });
      } else if (method === "demo.decrement") {
        dispatch({ type: "decrement" });
      } else if (method === "demo.setText") {
        dispatch({ type: "draft", value: String(params.value ?? "") });
      } else if (method === "demo.toggleLazy") {
        dispatch({ type: "toggleLazy" });
      } else if (method === "updates.changed") {
        // The host may publish this after an apply/rollback reload. Re-read
        // the canonical status instead of trusting a stale local snapshot.
        requestCapability("updatesStatus", "updates.status");
      } else if (method === "demo.stress") {
        runStress(Number(params.nodes ?? 100));
      } else if (method === "runtime.performance.sample") {
        const rawSample = params.sample ?? params.result ?? params;
        const sampleRecord = rawSample && typeof rawSample === "object" && !Array.isArray(rawSample)
          ? {
            ...(rawSample as Record<string, unknown>),
            ...(params.minFps === undefined ? {} : { minFps: params.minFps }),
            // The host may send the bounded long-frame delta separately as
            // `jank` to avoid repeating the persisted history in each sample.
            ...(
              (rawSample as Record<string, unknown>).longFrameEvents === undefined &&
              params.longFrameEvents === undefined &&
              params.jank !== undefined
                ? { longFrameEvents: params.jank }
                : {}
            ),
          }
          : rawSample;
        const sample = parsePerformancePoint(sampleRecord);
        if (sample) {
          // The native provider owns measured durations; JS owns the user
          // context that explains which page/action was active when the
          // sample arrived. Do not ask Flutter to infer app routing.
          const current = state();
          const context = typeof params.context === "string" ? params.context : sample.context;
          const existingEvents = performance().longFrameEvents ?? [];
          const contextualEvents = sample.longFrameEvents?.map((event) => {
            const prior = existingEvents.find((item) => sameJankEvent(item, event));
            const nextPage = prior?.page ?? event.page ?? current.route;
            const nextAction = prior?.action ?? event.action ?? current.lastAction;
            const nextContext = prior?.context ?? event.context ?? context;
            return {
              ...event,
              ...(nextPage !== undefined ? { page: nextPage } : {}),
              ...(nextAction !== undefined ? { action: nextAction } : {}),
              ...(nextContext !== undefined ? { context: nextContext } : {}),
            };
          });
          const contextualSample: PerformancePoint = {
            ...sample,
            ...(sample.page !== undefined ? {} : { page: current.route }),
            ...(sample.action !== undefined ? {} : { action: current.lastAction }),
            ...(sample.context !== undefined || typeof params.context !== "string"
              ? {}
              : { context: params.context }),
            ...(contextualEvents === undefined ? {} : {
              longFrameEvents: contextualEvents,
            }),
          };
          setPerformance((current) => {
            // A host event-only burst has no cadence window (frames/duration
            // are zero), so its fps=0 marker must not poison latest/history.
            // Its explicit long-frame events still belong in the diagnostics
            // list and are merged by the state model.
            const next = appendPerformanceSample(current, contextualSample, params.eventOnly !== true);
            return {
              ...next,
              recording: typeof params.recording === "boolean" ? params.recording : current.recording,
            };
          });
        }
      }
      previous?.(line);
    };
    bridge.__pocketEvent = receive;

    // These are real requests. If the Flutter host has not registered a
    // capability, the resulting host error is rendered rather than replaced
    // with a success placeholder.
    requestCapability("runtimeInfo", "runtime.info");
    publishPerformanceContext();
    requestCapability("pluginsList", "plugins.list");
    requestCapability("packageInfo", "plugins.packageInfo");
    requestCapability("updatesStatus", "updates.status");

    onCleanup(() => {
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
      system.dispose();
      removeExperienceLifecycle();
      experience.dispose();
      platform.dispose();
      host.dispose();
    });
  });

  // The retained Flutter host consumed MediaQuery.padding.top before its page
  // body. PocketView reports the equivalent logical inset through
  // display.viewport; consume it once at the SystemUI shell so every route
  // (including the Home header and mobile AppBar) starts below the status bar
  // without teaching each page its own safe-area state.
  return (
    <Screen
      class={mobileDark() ? "w-full h-full flex-col bg-[#0E1728] overflow-hidden" : "w-full h-full flex-col bg-[#F5F6FA] overflow-hidden"}
      style={{ paddingT: responsiveLayout().insets.top }}
    >
      <Show when={!isShowcaseRoute(state().route)}>
        <Header
          title={demoTitle}
          subtitle={`${demoRelease} · Solid guest · Flutter canvas`}
        />
      </Show>
      <FocusScope class="flex-1 flex-col overflow-hidden" autoFocus restoreFocus>
        {/* Keep FocusScope's own props static and mount a single bottom
            NavigationBar TabBar below the active route viewport across both
            folded and unfolded Duo postures. */}
        <View class="flex-1 flex-col h-full overflow-hidden">
          <View class="flex-1 w-full h-full overflow-hidden" style={{ ...contentPaneStyle(), translateX: transitionDescriptor().inTx, translateY: transitionDescriptor().inTy, scale: transitionDescriptor().inScale }}>
            <Show when={state().route === "home"}>
              <HomePage
                state={state}
                platform={platform}
                system={system}
                dispatch={dispatch}
                runtime={state().runtimeInfo}
                onRefresh={() => requestCapability("runtimeInfo", "runtime.info")}
                wide={wideLayout}
                contentWidth={() => undefined}
              />
            </Show>
            <Show when={state().route === "gallery"}>
              <GalleryPage state={state} dispatch={dispatch} contentWidth={contentPaneWidth} />
            </Show>
            <Show when={state().route === "mobile"}>
              <ScrollablePage><MobileUiPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "transitions"}>
              <ScrollablePage><TransitionsPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "hardware"}>
              <ScrollablePage><HardwarePage state={state} dispatch={dispatch} requestCapability={requestCapability} host={host} experience={experience} /></ScrollablePage>
            </Show>
            <Show when={state().route === "about" || state().route === "bytecode" || state().route === "updates" || state().route === "plugins" || state().route === "stress" || state().route === "performance"}>
              <HostPages host={host} state={state} dispatch={dispatch} requestCapability={requestCapability} runStress={runStress} performance={performance} recordingStatus={recordingStatus} />
            </Show>
          </View>
          <NavigationBar route={state().route} onNavigate={navigate} wide={wideLayout} geometry={() => displayGeometry()} />
        </View>
      </FocusScope>
      <SystemAppSurfaces
        system={system}
        systemUIFocused={state().detailsOpen}
      />
      <Show when={state().detailsOpen}>
        <DetailModal
          open={state().detailsOpen}
          title={state().selectedComponent ?? "Component"}
          body={componentDetails[state().selectedComponent ?? ""] ?? "Official guest composition."}
          onClose={() => dispatch({ type: "closeDetails" })}
        />
      </Show>
    </Screen>
  );
}

function HomePage(props: {
  state: () => DemoState;
  platform: ReturnType<typeof createPocketPlatformClient>;
  system: ReturnType<typeof installShowcaseSystem>;
  dispatch: (event: DemoEvent) => void;
  runtime: CapabilityState;
  onRefresh: () => void;
  wide?: () => boolean;
  contentWidth?: () => number | undefined;
}): JSX.Element {
  const wide = () => props.wide?.() === true;
  const contentWidth = () => props.contentWidth?.();
  const panelLayout = () => wide() ? "flex-row gap-3 mx-5" : "flex-col gap-3 mx-5";
  const panelClass = () => wide()
    ? "flex-1 flex-col gap-3 p-4 rounded-xl bg-white"
    : "flex-col gap-3 p-4 rounded-xl bg-white";
  return (
    <ScrollablePage>
      <View class="flex-col gap-3 pb-5">
        <View
          class="flex-col gap-2 mx-5 mt-4 p-4 rounded-xl bg-[#315deb]"
          style={contentWidth() === undefined ? undefined : { width: contentWidth()! }}
        >
          <View class="flex-row items-center gap-2">
            <View class="w-[6] h-[6] rounded-full bg-[#a9f2ce]" />
            <Text class="text-xs text-blue-100 font-bold">POCKET SHOWCASE</Text>
          </View>
          <Text class="text-2xl text-white font-bold">Made to feel native.</Text>
          <Text class="text-sm text-blue-100">Small building blocks. Real possibilities.</Text>
        </View>
        <HomeExplore wide={wide} dispatch={props.dispatch} />
        <View class="flex-row items-center justify-between mx-5">
          <Text class="text-sm text-slate-950 font-bold">Playground</Text>
          <Text class="text-xs text-slate-500">Try it live</Text>
        </View>
        <View class={panelLayout()}>
        <Card class={panelClass()}>
          <ViewText title="Input round-trip" body="Your system keyboard, right here." />
          <InputField
            value={() => props.state().draft}
            onInput={(value) => props.dispatch({ type: "draft", value })}
            onSubmit={(value) => props.dispatch({ type: "draft", value })}
            appearance={{ fillColor: "#f5f6fa", borderColor: "#e4e8f0", focusedBorderColor: "#315deb", borderRadius: 10, paddingVertical: 11 }}
          />
          <Text class="text-xs text-slate-500">Draft: {props.state().draft || "(empty)"}</Text>
        </Card>
        <Named name="CounterCard">
          <Card class={panelClass()}>
            <View class="flex-row items-center justify-between gap-3">
              <ViewText title="Counter" body={props.state().lastAction} />
              <View class="flex-row items-center gap-3">
                <ActionButton label="−" kind="quiet" onPress={() => props.dispatch({ type: "decrement" })} />
                <Text class="text-2xl text-slate-950 font-bold">{String(props.state().count).padStart(2, "0")}</Text>
                <ActionButton label="+1" onPress={() => props.dispatch({ type: "increment" })} />
              </View>
            </View>
          </Card>
        </Named>
        </View>
        <PlatformAppsCard platform={props.platform} system={props.system} />
        <View class="flex-row items-center justify-between mx-5 px-1 py-2">
          <View class="flex-row items-center gap-2">
            <View class={props.runtime.phase === "error" ? "w-[6] h-[6] rounded-full bg-rose-500" : "w-[6] h-[6] rounded-full bg-emerald-500"} />
            <Text class="text-xs text-slate-500">{props.runtime.phase === "ready" ? "Runtime ready" : props.runtime.phase === "error" ? "Runtime unavailable" : "Connecting"}</Text>
          </View>
          <ActionButton label="Open Host details" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "about" })} />
        </View>
      </View>
    </ScrollablePage>
  );
}

function miniAppResultSummary(value: JsonValue | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return valueSummary(value ?? null);
  const profile = value.profile ?? value.userInfo;
  const person = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : undefined;
  const result = value.lobby && typeof value.lobby === "object" && !Array.isArray(value.lobby) ? value.lobby : value;
  const parts: string[] = [];
  if (typeof person?.name === "string") parts.push(person.name);
  if (typeof result.visits === "number") parts.push(`visits=${result.visits}`);
  if (typeof result.count === "number") parts.push(`count=${result.count}`);
  return parts.length > 0 ? parts.join(" · ") : valueSummary(value);
}

function PlatformAppsCard(props: { platform: ReturnType<typeof createPocketPlatformClient>; system: ReturnType<typeof installShowcaseSystem> }): JSX.Element {
  const [status, setStatus] = createSignal("Preparing apps...");
  onMount(() => {
    void props.system.ready.then(
      () => setStatus("Ready to explore"),
      (error) => setStatus(hostError(error).message),
    );
  });
  const [message, setMessage] = createSignal("No app messages yet");
  const stopMessages = props.platform.onMessage((message) => {
    setMessage(`Message from ${message.sourceAppId}: · ${miniAppResultSummary(message.data)}`);
  });
  onCleanup(stopMessages);
  const open = async (appId: string) => {
    try {
      await props.system.ready;
      const result = await props.platform.openApp(appId, { source: "showcase" });
      setStatus(result.cancelled ? `Cancelled: ${result.reason ?? "closed"}` : `App result: · ${miniAppResultSummary(result.value)}`);
    } catch (error) { setStatus(hostError(error).message); }
  };
  return (
    <Card class="flex-col gap-3 mx-5 p-4 rounded-xl bg-white">
      <View class="flex-row items-center justify-between">
        <ViewText title="Mini Apps" body="A little more to explore." />
        <Badge tone="cyan">2 APPS</Badge>
      </View>
      <View class="flex-col gap-2">
        <ActionButton label="Open profile app" onPress={() => void open("pocket.demo.profile")} />
        <ActionButton label="Open lobby app" kind="quiet" onPress={() => void open("pocket.demo.lobby")} />
      </View>
      <For each={summaryLines(status())}>{(line) => <Text class="text-xs text-slate-500">{line}</Text>}</For>
      <Show when={message() !== "No app messages yet"}>
        <For each={summaryLines(message())}>{(line) => <Text class="text-xs text-slate-500">{line}</Text>}</For>
      </Show>
      <ActionButton label="Prewarm lobby" kind="quiet" onPress={() => {
        void props.system.ready.then(() => props.platform.prewarm("pocket.demo.lobby")).then(
          () => setStatus("Lobby prewarmed; its guest clock is paused"),
          (error) => setStatus(hostError(error).message),
        );
      }} />
    </Card>
  );
}

function HomeExplore(props: { wide: () => boolean; dispatch: (event: DemoEvent) => void }): JSX.Element {
  const features = [
    { title: "Mobile UI", detail: "Components", route: "mobile" as const },
    { title: "Transitions", detail: "Motion", route: "transitions" as const },
    { title: "Hardware", detail: "Device APIs", route: "hardware" as const },
  ];
  return (
    <View class="flex-row gap-3 mx-5">
      <For each={features}>{(feature) => (
        <Focusable class="flex-1 flex-col gap-2 h-[104] p-3 rounded-xl bg-white focus:bg-blue-50" onPress={() => props.dispatch({ type: "navigate", route: feature.route })}>
          <View class="w-[30] h-[30] items-center justify-center rounded-lg bg-blue-50">
            <Show when={feature.route === "mobile"}><Image class="w-[20] h-[20]" src="icons/components.svg" /></Show>
            <Show when={feature.route === "transitions"}><Image class="w-[20] h-[20]" src="icons/motion.svg" /></Show>
            <Show when={feature.route === "hardware"}><Image class="w-[20] h-[20]" src="icons/hardware.svg" /></Show>
          </View>
          <Text class="text-xs text-slate-950 font-bold">{feature.title}</Text>
          <Text class="text-xs text-slate-500">{feature.detail}</Text>
        </Focusable>
      )}</For>
    </View>
  );
}

function GalleryPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  contentWidth: () => number;
}): JSX.Element {
  const tileWidth = () => Math.max(0, (props.contentWidth() - 40 - 12) / 2);
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 pb-5">
      <PageIntro title="Official building blocks" body="The essentials, ready to explore." />
      <TileGrid>
        <For each={componentCards}>
          {(card) => (
            <Focusable
              class="flex-col gap-3 h-[112] p-4 rounded-xl bg-white focus:bg-blue-50"
              style={{ width: tileWidth() }}
              onPress={() => props.dispatch({ type: "select", component: card })}
            >
              <View class="w-[28] h-[28] items-center justify-center rounded-lg bg-blue-50">
                <Text class="text-xs text-blue-600 font-bold">{card.slice(0, 2)}</Text>
              </View>
              <View class="flex-row items-center justify-between">
                <Text class="text-sm text-slate-950 font-bold">{card}</Text>
                <Text class="text-sm text-slate-400">›</Text>
              </View>
            </Focusable>
          )}
        </For>
      </TileGrid>
      <Card class="flex-col gap-3 mx-5 p-4 rounded-xl bg-white">
        <Row>
          <ViewText title="Lazy panel" body="Content, when you need it." />
          <ActionButton label={props.state().lazyVisible ? "Hide" : "Show"} kind="secondary" onPress={() => props.dispatch({ type: "toggleLazy" })} />
        </Row>
        <Lazy when={() => props.state().lazyVisible}>
          {() => (
            <View class="flex-col gap-1 p-2 rounded-lg bg-purple-600">
              <Text class="text-xs text-white font-bold">Lazy subtree is mounted</Text>
              <Text class="text-xs text-purple-100">Only mounted while visible.</Text>
              <MiniBarChart values={[8, 14, 10, 22, 18, 28, 24]} />
            </View>
          )}
        </Lazy>
      </Card>
      <Card class="flex-col gap-3 mx-5 p-4 rounded-xl bg-white">
        <ViewText title="Go a little further" body="Components, motion and device APIs." />
        <View class="flex-row flex-wrap gap-2">
          <ActionButton label="Mobile UI" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
          <ActionButton label="Transitions" kind="secondary" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
          <ActionButton label="Hardware" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
        </View>
      </Card>
      <EmptyState title="Not mounted here" body="More capabilities live under Host." />
      </View>
    </ScrollablePage>
  );
}

function HostPages(props: {
  host: HostBridge;
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
  runStress: (nodes: number) => void;
  performance: () => PerformanceSnapshot;
  recordingStatus?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  const route = () => props.state().route;
  const switchTab = (id: string): void => {
    const target = routeOf(id);
    if (target && target !== "home" && target !== "gallery") props.dispatch({ type: "navigate", route: target });
  };
  return (
    <ScrollablePage>
      <View class="flex-col gap-2">
      <Tabs items={hostTabs} active={route() === "performance" ? "about" : route()} onChange={switchTab} />
      <Show when={route() === "about"}>
        <RuntimePage host={props.host} state={props.state} requestCapability={props.requestCapability} onNavigate={(route) => props.dispatch({ type: "navigate", route })} recordingStatus={props.recordingStatus} />
      </Show>
      <Show when={route() === "bytecode"}>
        <BytecodePage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "updates"}>
        <UpdatesPage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "plugins"}>
        <PluginsPage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "stress"}>
        <StressPage state={props.state} runStress={props.runStress} />
      </Show>
      <Show when={route() === "performance"}>
        <PerformancePage state={props.state} performance={props.performance} requestCapability={props.requestCapability} />
      </Show>
      </View>
    </ScrollablePage>
  );
}

function RuntimePage(props: {
  host: HostBridge;
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
  onNavigate: (route: Route) => void;
  recordingStatus?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  return (
    <View class="flex-col gap-3">
      <PageIntro title="Runtime" body="Live host status and package identity." />
      <CapabilityCard title="Runtime info" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <CapabilityCard title="Package metadata" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
      <ActionButton label="Frame diagnostics" kind="secondary" onPress={() => props.onNavigate("performance")} />
      <RecordingPanel host={props.host} status={props.recordingStatus} />
      <StatusBar label="JS ↔ Flutter" detail="No Dart UI state" ok={props.state().runtimeInfo.phase !== "error"} />
    </View>
  );
}

function PerformancePage(props: {
  state: () => DemoState;
  performance: () => PerformanceSnapshot;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  onMount(() => props.requestCapability("runtimePerformance", "runtime.performance"));
  const points = () => recentPerformance(props.performance());
  const latest = () => props.performance().latest;
  const lowRows = () => lowPerformanceRows(points());
  const jankRows = () => performanceJankRows(props.performance());
  const provider = () => props.state().runtimePerformance;
  const latestLongFrame = () => {
    const events = recentPerformanceJanks(props.performance());
    return events[events.length - 1];
  };
  const latestBudget = () => performanceBudget(latest()) ?? latestLongFrame()?.budgetMs;
  const latestGap = () => performanceGap(latest()) ?? latestLongFrame()?.activeGapMs ?? latestLongFrame()?.durationMs;
  const latestBuild = () => latest()?.buildMsP95 ?? latestLongFrame()?.buildMs;
  const latestRaster = () => latest()?.rasterMsP95 ?? latestLongFrame()?.rasterMs;
  const latestBridgeDecode = () => latest()?.nativeWorkMsP95 ?? latestLongFrame()?.nativeMs;
  return (
    <View class="flex-col gap-2">
      <PageIntro title="Frame diagnostics" body="Guest ticks are separate from Flutter FPS. Sparse rendering is not a stall." />
      <Card class="flex-row items-center justify-between gap-2 mx-4 p-2 rounded-xl bg-white border-slate-200">
        <View class="flex-col gap-1 flex-1">
          <Text class="text-xs text-slate-950 font-bold">Performance provider · {hostPhase(provider())}</Text>
          <Text class={provider().phase === "error" ? "text-xs text-rose-700" : "text-xs text-slate-600"}>
            {capabilitySummary(provider())}
          </Text>
        </View>
        <ActionButton
          label={provider().phase === "loading" ? "Wait" : "Refresh"}
          kind="quiet"
          onPress={() => props.requestCapability("runtimePerformance", "runtime.performance")}
        />
      </Card>
      <Card class="flex-col gap-2 mx-4 p-2 rounded-xl bg-slate-100 border-slate-200">
        <Row>
          <ViewText title="Recent 60 samples" body={props.performance().recording ? "Recording" : "Provider not recording"} />
          <Badge tone={props.performance().recording ? "green" : "amber"}>{String(points().length)}</Badge>
        </Row>
        <Show when={points().length > 0} fallback={<EmptyState title="No guest tick samples" body="Open a configured host performance provider or refresh this page." />}>
          <MiniBarChart values={performanceBars(points())} />
          <Text class="text-xs text-slate-600">Bars show guest scheduler turns per active second, not Flutter FPS.</Text>
        </Show>
      </Card>
      <View class="flex-row gap-2 mx-4">
        <MetricCard
          label="Guest ticks/s"
          value={metricNumber(latest()?.fps)}
          detail={latest() ? `min ${metricNumber(latest()?.minFps)} · active gap ${metricNumber(latestGap())} ms` : "No latest sample"}
          tone="purple"
        />
        <Card class="flex-col gap-1 p-3 rounded-xl bg-rose-100">
          <Text class="text-xs text-rose-700">Current minimum</Text>
          <Text class="text-xl text-rose-700 font-bold">{metricNumber(minimumPerformanceFps(points()))}</Text>
          <Text class="text-xs text-rose-700">lowest guest tick window</Text>
        </Card>
      </View>
      <Show when={latest() ?? latestLongFrame()} fallback={<EmptyState title="No frame breakdown" body="The provider has not returned a current frame window." />}>
        <Card class="flex-col gap-2 mx-4 p-3 rounded-xl bg-white border-slate-200">
          <SectionHeading
            title="Latest frame breakdown"
            detail={latestBudget() === undefined ? "refresh budget unavailable" : `budget ${metricNumber(latestBudget())} ms`}
          />
          <Row>
            <ViewText title="UI build" body={latestBuild() === undefined ? "—" : `${metricNumber(latestBuild())} ms${latest()?.buildMsP95 === undefined ? " long frame" : " p95"}`} />
            <ViewText title="Raster" body={latestRaster() === undefined ? "—" : `${metricNumber(latestRaster())} ms${latest()?.rasterMsP95 === undefined ? " long frame" : " p95"}`} />
          </Row>
          <Row>
            <ViewText title="Bridge/decode" body={latestBridgeDecode() === undefined ? "—" : `${metricNumber(latestBridgeDecode())} ms${latest()?.nativeWorkMsP95 === undefined ? " long frame" : " p95"}`} />
            <ViewText title="Active gap" body={latestGap() === undefined ? "—" : `${metricNumber(latestGap())} ms`} />
          </Row>
          <Text class="text-xs text-slate-600">
            Compatibility bridge p95: {metricNumber(latest()?.nativeMsP95)} ms · refresh {latest()?.refreshHz === undefined ? "—" : `${metricNumber(latest()?.refreshHz)} Hz`}
          </Text>
        </Card>
      </Show>
      <Show when={jankRows().length > 0} fallback={<EmptyState title="No recent long frames" body="No active gap exceeded the provider's refresh-rate budget. A low guest tick rate with gap 0 can be intentional sparse rendering." />}>
        <Card class="flex-col gap-1 mx-4 p-2 rounded-xl bg-amber-50 border-amber-200">
          <SectionHeading title="Recent long frames" detail="Measured jank history" />
          <VirtualList
            count={jankRows().length}
            rowHeight={64}
            height={192}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = jankRows()[index];
              return (
                <View class="flex-col gap-1 px-2 py-1 bg-amber-50 border-amber-200">
                  <Text class="text-xs text-amber-800 font-bold">{item?.title ?? "Long frame"}</Text>
                  <Text class="text-xs text-slate-600">{item?.detail ?? "Frame timing breakdown unavailable"}</Text>
                  <Text class="text-xs text-slate-600">{item?.context ?? "Host frame sampler"}</Text>
                </View>
              );
            }}
          />
        </Card>
      </Show>
      <Show when={lowRows().length > 0} fallback={<EmptyState title="No low-frame samples" body="The provider has not returned a measurable history yet." />}>
        <Card class="flex-col gap-1 mx-4 p-2 rounded-xl bg-white border-slate-200">
          <SectionHeading title="Lowest guest tick samples" detail="Compatibility history · not jank by itself" />
          <VirtualList
            count={lowRows().length}
            rowHeight={36}
            height={108}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = lowRows()[index];
              return (
                <View class="flex-col gap-1 px-2 py-1 bg-slate-50 border-slate-200">
                  <Text class="text-xs text-rose-700 font-bold">{item?.title ?? "Low guest tick sample"}</Text>
                  <Text class="text-xs text-slate-600">{item?.detail ?? "Provider metrics unavailable"}</Text>
                </View>
              );
            }}
          />
        </Card>
      </Show>
    </View>
  );
}

function BytecodePage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  return (
    <View class="flex-col gap-3">
      <PageIntro title="Bytecode" body="QuickJS runtime and bundle identity." />
      <CapabilityCard title="QuickJS runtime" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <Card class="flex-col gap-2 mx-4 p-4 rounded-xl bg-white">
        <ViewText title="Package response" body="Reported by the active runtime." />
        <For each={summaryLines(capabilitySummary(props.state().runtimeInfo))}>{(line) => <Text class="text-xs text-slate-500">{line}</Text>}</For>
      </Card>
    </View>
  );
}

function UpdatesPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  const versions = () => versionHistory(props.state().updatesStatus.result);
  return (
    <View class="flex-col gap-2">
      <PageIntro title="Updates" body="Manage versions supplied by the host." />
      <CapabilityCard title="Current status" capability="updates.status" state={props.state().updatesStatus} onRefresh={() => props.requestCapability("updatesStatus", "updates.status")} />
      <Show when={versions().length > 0} fallback={<EmptyState title="Version history" body="The host returned no verified versions." />}>
        <Card class="flex-col gap-1 mx-4 p-2 rounded-xl bg-slate-100 border-slate-200">
          <Row>
            <ViewText title="Version history" body="From updates.status" />
            <Badge tone="cyan">{String(versions().length)}</Badge>
          </Row>
          <VirtualList
            count={versions().length}
            rowHeight={32}
            height={80}
            focusRows={false}
            overscan={32}
            renderRow={(index) => {
              const item = versions()[index];
              return (
                <View class="flex-col gap-1 px-2 py-1 bg-white border-slate-200">
                  <Text class="text-xs text-slate-950 font-bold">{item?.title ?? "Version"}</Text>
                  <Text class="text-xs text-slate-600">{item?.detail ?? "verified version"}</Text>
                </View>
              );
            }}
          />
        </Card>
      </Show>
      <Row class="mx-4">
        <ActionButton label="Check" onPress={() => props.requestCapability("updatesCheck", "updates.check")} />
        <ActionButton label="Apply" kind="secondary" onPress={() => props.requestCapability("updatesApply", "updates.apply")} />
        <ActionButton label="Rollback" kind="danger" onPress={() => props.requestCapability("updatesRollback", "updates.rollback")} />
      </Row>
      <List tone="light" items={[
        { id: "check", title: "updates.check", detail: capabilitySummary(props.state().updatesCheck) },
        { id: "apply", title: "updates.apply", detail: capabilitySummary(props.state().updatesApply) },
        { id: "rollback", title: "updates.rollback", detail: capabilitySummary(props.state().updatesRollback) },
      ]} />
    </View>
  );
}

function PluginsPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  const plugins = () => listItems(props.state().pluginsList.result);
  return (
    <View class="flex-col gap-3">
      <PageIntro title="Plugins" body="Installed capabilities from the host." />
      <CapabilityCard title="Installed plugins" capability="plugins.list" state={props.state().pluginsList} onRefresh={() => props.requestCapability("pluginsList", "plugins.list")} />
      <Show when={plugins().length > 0} fallback={<EmptyState title="No plugin list" body={capabilitySummary(props.state().pluginsList)} />}>
        <List items={plugins()} tone="light" />
      </Show>
      <CapabilityCard title="External package info" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
    </View>
  );
}

function StressPage(props: { state: () => DemoState; runStress: (nodes: number) => void }): JSX.Element {
  const nodes = () => stressItems(props.state().stress.nodeCount);
  return (
    <View class="flex-col gap-3">
      <PageIntro title="Stress" body="Measure JS node pressure at two sizes." />
      <Card class="flex-col gap-2 mx-4 p-3 rounded-xl bg-white border-slate-200">
        <Row>
          <ViewText title="Retained node pressure" body="No Dart handler or duplicate state" />
          <Badge tone="amber">JS</Badge>
        </Row>
        <Row>
          <ActionButton label="Run 100 nodes" onPress={() => props.runStress(100)} />
          <ActionButton label="Run 500 nodes" kind="secondary" onPress={() => props.runStress(500)} />
        </Row>
      </Card>
      <View class="flex-row gap-2 mx-4">
        <MetricCard label="Nodes" value={String(props.state().stress.nodeCount)} detail={`${props.state().stress.durationMs} ms JS setup`} tone="purple" />
        <MetricCard label="Checksum" value={String(props.state().stress.checksum)} detail={props.state().stress.lastAction} tone="green" />
      </View>
      <Text class="text-xs text-slate-600 px-4">{props.state().stress.nodeCount} retained nodes in the current guest frame.</Text>
      <View class="flex-row flex-wrap gap-1 px-4 overflow-hidden">
        <For each={nodes()}>
          {() => <View class="w-2 h-2 rounded bg-cyan-500" />}
        </For>
      </View>
    </View>
  );
}

mount(() => <App />);

