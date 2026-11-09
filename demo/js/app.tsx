import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
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
  MobileButton,
  MobileCard,
  InputField,
  MiniBarChart,
  MobileAlert,
  MobileBadge,
  MobileBackButton,
  RouteView,
  MobileThemeProvider,
  AccessibilityPreferencesProvider,
  AppleSemanticsProvider,
  createAccessibilityPreferences,
  createMobileTheme,
  useMobileTheme,
  toMobileColor,
  MobileDialog,
  MobilePopup,
  MobileToast,
  NavigationBar,
  MobileAppBar,
  SafeAreaScaffold,
  ScrollContourItem,
  ScrollablePage,
  MobileListTile,
  deliverTextInputEvent,
  useScrollContourReserve,
  ShadcnAspectRatio,
  ShadcnBreadcrumb,
  ShadcnButtonGroup,
  ShadcnCalendar,
  ShadcnCarousel,
  ShadcnChart,
  ShadcnCollapsible,
  ShadcnCombobox,
  ShadcnCommand,
  ShadcnContextMenu,
  ShadcnDataTable,
  ShadcnDatePicker,
  ShadcnDrawer,
  ShadcnDropdownMenu,
  ShadcnEmpty,
  ShadcnFormField,
  ShadcnHoverCard,
  ShadcnInputGroup,
  ShadcnInputOTP,
  ShadcnItem,
  ShadcnKbd,
  ShadcnMenubar,
  ShadcnNavigationMenu,
  ShadcnPagination,
  ShadcnPopover,
  ShadcnResizable,
  ShadcnScrollArea,
  ShadcnSelect,
  ShadcnSeparator,
  ShadcnSheet,
  ShadcnSidebar,
  ShadcnSpinner,
  ShadcnTable,
  ShadcnTextarea,
  ShadcnToggleGroup,
  ShadcnTooltip,
  ShadcnTypography,
} from "@pocket/ui";
import { HardwarePage, MobileUiPage, TransitionsPage } from "./mobile-pages.tsx";
import { createHostBridge, hostError, type HostBridge, type HostEvent, type JsonValue } from "@pocket/ui/host";
import { VideoPage } from "./video-page.tsx";
import { RecordingPanel } from "./recording-panel.tsx";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createPlatformExperience, isUnsupportedPlatformError } from "@pocket/ui/platform-experience";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";
import { installShowcaseSystem } from "./system.ts";
import { showcaseUpdateState } from "./update-state.ts";
import { SettingsPage, readAppearance, storedAppearance } from "./settings.tsx";
import { ApplePage } from "./apple-page.tsx";
import { computeTransitionDescriptor, createDisplayGeometry } from "@pocket/ui";
import {
  isPrimaryRoute,
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
  Text: "Typography drawn by the active host.",
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

const demoTitle = "Pocket";
const showcaseTabs = [
  { id: "home" as const, label: "Home", kind: "home" as const },
  { id: "gallery" as const, label: "UI", kind: "gallery" as const },
  { id: "about" as const, label: "Host", kind: "host" as const },
  { id: "settings" as const, label: "Settings", kind: "settings" as const },
];

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
  if (route === "settings" || route === "home" || route === "gallery" || route === "about" || route === "bytecode" || route === "updates" || route === "plugins" || route === "stress" || route === "performance" || route === "mobile" || route === "transitions" || route === "hardware" || route === "video" || route === "apple") return route;
  if (route === "ui") return "gallery";
  return undefined;
}

function capabilityUnavailable(state: CapabilityState): boolean {
  return !!state.result && typeof state.result === "object" &&
    (state.result as Record<string, unknown>).supported === false;
}

function hostLabel(state: CapabilityState): string {
  const result = state.result && typeof state.result === "object" ? state.result as Record<string, unknown> : {};
  const provider = result.provider ?? result.host;
  return typeof provider === "string" && provider.length > 0 ? provider : "Pocket host";
}

function supportsRecording(state: CapabilityState): boolean {
  const result = state.result && typeof state.result === "object" ? state.result as Record<string, unknown> : {};
  const features = result.features as Record<string, unknown> | undefined;
  // Keep legacy hosts usable: only an explicit false disables the optional
  // panel. The action still reports the real host error if the provider is
  // absent; missing metadata is not evidence of unsupported recording.
  return features?.recording !== false;
}

function hostPhase(state: CapabilityState): string {
  if (state.phase === "idle") return "Not requested";
  if (state.phase === "loading") return "Loading";
  if (state.phase === "ready") return capabilityUnavailable(state) ? "Unavailable" : "Ready";
  return "Error";
}

function toneForPhase(state: CapabilityState): "accent" | "success" | "warning" | "danger" {
  if (state.phase === "ready") return capabilityUnavailable(state) ? "warning" : "success";
  if (state.phase === "error") return "danger";
  if (state.phase === "loading") return "warning";
  return "accent";
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "No result payload";
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.supported === false) {
      return String(record.reason ?? "This capability is unavailable in the active host.");
    }
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
  const theme = useMobileTheme();
  const [expanded, setExpanded] = createSignal(true);
  const lines = () => summaryLines(capabilitySummary(props.state));
  return (
    <MobileCard title={props.title} detail={props.capability}>
      <MobileBadge tone={toneForPhase(props.state)} label={hostPhase(props.state)} />
      <Show when={expanded()}>
        <View class="flex-col gap-1">
          <For each={lines()}>{(line) => <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{line}</Text>}</For>
        </View>
      </Show>
      <View class="flex-row items-center gap-2">
        <MobileButton label={expanded() ? "Hide details" : "Details"} kind="text" onPress={() => setExpanded(!expanded())} />
        <MobileButton label={props.state.phase === "loading" ? "Waiting" : "Refresh"} kind="text" onPress={props.onRefresh} />
      </View>
    </MobileCard>
  );
}

function App() {
  const [state, setState] = createSignal<DemoState>(initialDemoState());
  // The stack is the navigation source of truth. The Set is only an instance
  // cache for visited primary tabs; popped secondary routes leave this list
  // and Solid disposes their resources. Every retained route owns its actual
  // local signals and ScrollablePage instead of mirrored scroll snapshots.
  const primaryPages = new Set<Route>(["home"]);
  const stack = createMemo(() => state().routeStack);
  const mountedRoutes = createMemo(() => {
    const entries = stack();
    for (const route of entries) if (isPrimaryRoute(route)) primaryPages.add(route);
    return [...primaryPages, ...entries.filter((route) => !isPrimaryRoute(route))];
  });
  const displayGeometry = createDisplayGeometry();
  // One persisted appearance applies to the canvas and every mounted route.
  const mobileDark = () => state().mobileDark;
  const theme = () => createMobileTheme(mobileDark(), state().accentColor);
  const [preferencesReady, setPreferencesReady] = createSignal(false);
  const [preferencesStatus, setPreferencesStatus] = createSignal("Loading your preferences…");
  let saveQueue: Promise<void> = Promise.resolve();
  let saveRevision = 0;
  const contentPaneWidth = (): number => Math.max(0, displayGeometry().width);
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
  const platform = createPocketPlatformClient(undefined, { bridge: host });
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const system = installShowcaseSystem(host, showcaseUpdateState(platform.storage, state, setState, routeOf));
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
    if (event.type === "setMobileDark" || event.type === "setAccentColor" || event.type === "setInterfaceDensity" || event.type === "resetAppearance") {
      const value = storedAppearance(state());
      const revision = ++saveRevision;
      setPreferencesStatus("Saving preferences…");
      saveQueue = saveQueue.then(async () => {
        try {
          await platform.storage.set("appearance", value);
          if (revision === saveRevision) setPreferencesStatus("Saved on this device");
        } catch {
          if (revision === saveRevision) setPreferencesStatus("Changes apply this session. Device storage is unavailable.");
        }
      });
    }
    if (event.type !== "capabilityStart" && event.type !== "capabilitySuccess" && event.type !== "capabilityFailure") {
      publishPerformanceContext();
    }
  };

  const navigate = (route: Route): void => dispatch({ type: "navigate", route });
  const restorePreferences = async (): Promise<void> => {
    setPreferencesReady(false);
    setPreferencesStatus("Loading your preferences…");
    try {
      await system.ready;
      const saved = readAppearance(await platform.storage.get("appearance"));
      if (saved) dispatch({ type: "restoreAppearance", ...saved });
      setPreferencesStatus(saved ? "Saved on this device" : "Using the default appearance");
    } catch {
      setPreferencesStatus("Changes apply this session. Device storage is unavailable.");
    } finally {
      setPreferencesReady(true);
    }
  };
  onMount(() => { void restorePreferences(); });


  const isShowcaseRoute = (route: Route): boolean =>
    route === "mobile" || route === "transitions" || route === "hardware" || route === "video" || route === "apple";

  // One JS route gate owns playback policy; the Flutter host only executes it.
  // This also pauses a video before its page is removed from the draw tree.
  createEffect(() => platform.media?.setCurrentPage(state().route));

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
    const request = capability === "updates.apply" ? system.updates.apply() : host.request<JsonValue>(capability, params);
    request.then(
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

  // Camera access belongs to the visible device page. Keep this gate above
  // page lifetime so a start result arriving after pop is stopped as well.
  let stoppedPreviewRequest: string | null | undefined;
  createEffect(() => {
    const current = state();
    if (current.route === "hardware") {
      stoppedPreviewRequest = undefined;
      return;
    }
    const preview = current.hardwareCameraPreviewStart;
    if (preview.phase !== "ready" || preview.requestId === stoppedPreviewRequest) return;
    stoppedPreviewRequest = preview.requestId;
    requestCapability("hardwareCameraPreviewStop", "hardware.camera.preview.stop");
  });

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
    const handleEvent = (method: string, params: Record<string, unknown>): void => {
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
    };
    const previous = typeof host.onEvent === "function" ? undefined : bridge.__pocketEvent;
    const receive = (line: string): void => {
      // Request-only injected bridges retain the compatibility sink. Modern
      // HostBridge users receive the already-decoded HostEvent below.
      if (typeof host.onEvent !== "function") host.handle(line);
      const message = decode(line);
      if (!message) return;
      handleEvent(message.method ?? message.name ?? "", paramsOf(message));
      try { previous?.(line); } catch { /* isolate legacy previous sinks */ }
    };
    const removeHostEvent = typeof host.onEvent === "function"
      ? host.onEvent((event: HostEvent) => handleEvent(event.method, event.params))
      : undefined;
    if (typeof host.onEvent !== "function") bridge.__pocketEvent = receive;

    // These are real requests. If the active host has not registered a
    // capability, the resulting host error is rendered rather than replaced
    // with a success placeholder.
    requestCapability("runtimeInfo", "runtime.info");
    publishPerformanceContext();
    requestCapability("pluginsList", "plugins.list");
    requestCapability("packageInfo", "plugins.packageInfo");
    requestCapability("updatesStatus", "updates.status");

    onCleanup(() => {
      removeHostEvent?.();
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
      system.dispose();
      removeExperienceLifecycle();
      experience.dispose();
      platform.dispose();
      host.dispose();
    });
  });

  const renderRoute = (route: Route): JSX.Element => {
    switch (route) {
      case "home":
        return <HomePage state={state} platform={platform} system={system} dispatch={dispatch} runtime={state().runtimeInfo} />;
      case "settings":
        return <SettingsPage state={state} dispatch={dispatch} ready={preferencesReady} status={preferencesStatus} />;
      case "gallery":
        return <GalleryPage state={state} dispatch={dispatch} contentWidth={contentPaneWidth} />;
      case "mobile":
        return <ScrollablePage><MobileUiPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>;
      case "transitions":
        return <ScrollablePage><TransitionsPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>;
      case "hardware":
        return <ScrollablePage><HardwarePage state={state} dispatch={dispatch} requestCapability={requestCapability} host={host} experience={experience} /></ScrollablePage>;
      case "video":
        return <VideoPage host={host} platform={platform} onNavigate={navigate} />;
      case "apple":
        return <ApplePage />;
      default:
        return <HostPages route={route} host={host} state={state} dispatch={dispatch} requestCapability={requestCapability} runStress={runStress} performance={performance} recordingStatus={recordingStatus} />;
    }
  };

  // The retained Flutter host consumed MediaQuery.padding.top before its page
  // body. PocketView reports the equivalent logical inset through
  // display.viewport; consume it once at the SystemUI shell so every route
  // (including the Home header and mobile AppBar) starts below the status bar
  // without teaching each page its own safe-area state.
  return (
    <AppleSemanticsProvider bridge={host}>
    <AccessibilityPreferencesProvider value={accessibility}>
    <MobileThemeProvider theme={theme} density={() => state().interfaceDensity}>
    <Screen
      class={mobileDark() ? "w-full h-full flex-col bg-[#0E1728] overflow-hidden" : "w-full h-full flex-col bg-[#F5F6FA] overflow-hidden"}
    >
      <SafeAreaScaffold
        edges={isPrimaryRoute(state().route) ? ["top"] : ["top", "bottom"]}
        geometry={() => displayGeometry()}
        class={mobileDark() ? "flex-col w-full h-full bg-[#09090B]" : "flex-col w-full h-full bg-[#FAFAFA]"}
      >
      <FocusScope class="flex-1 flex-col overflow-hidden" autoFocus restoreFocus>
        {/* Visibility is derived from the route, without a second nav state. */}
        <View class="flex-1 flex-col h-full overflow-hidden">
          <View class="flex-1 flex-col w-full h-full overflow-hidden" style={{ translateX: transitionDescriptor().inTx, translateY: transitionDescriptor().inTy, scale: transitionDescriptor().inScale }}>
            <MobileAppBar
              title={state().route === "home" ? demoTitle : state().route === "gallery" ? "UI Collection" : state().route === "about" ? "Host" : state().route === "settings" ? "Settings" : state().route === "mobile" ? "Mobile UI" : state().route === "transitions" ? "Transitions" : state().route === "hardware" ? "Hardware" : state().route === "video" ? "Video Lab" : state().route === "apple" ? "Apple Glass" : hostTabs.find((tab) => tab.id === state().route)?.label ?? "Frame diagnostics"}
              centered={!isPrimaryRoute(state().route)}
              leading={isPrimaryRoute(state().route) ? undefined : <MobileBackButton onPress={() => dispatch({ type: "popRoute" })} />}
            />
            <View class="flex-1 w-full h-full overflow-hidden">
              <For each={mountedRoutes()}>{(route) => (
                <RouteView active={state().route === route}>
                  {renderRoute(route)}
                </RouteView>
              )}</For>
            </View>
          </View>
          <NavigationBar route={state().route} onNavigate={navigate} items={showcaseTabs} visible={isPrimaryRoute(state().route)} dark={mobileDark()} accentColor={theme().accentColor} geometry={() => displayGeometry()} />
        </View>
      </FocusScope>
      </SafeAreaScaffold>
      <SystemAppSurfaces
        system={system}
        systemUIFocused={state().detailsOpen}
        presentation="mini-app"
        onClose={async (binding) => {
          const frame = system.snapshot().stack.find((entry) => entry.instanceId === binding.instanceId);
          if (!frame?.requestId) return;
          await host.request("platform.apps.cancel", { requestId: frame.requestId });
        }}
      />
      <MobileDialog
        open={state().detailsOpen}
        title={state().selectedComponent ?? "Component"}
        body={componentDetails[state().selectedComponent ?? ""] ?? "Official guest composition."}
        onClose={() => dispatch({ type: "closeDetails" })}
      />
    </Screen>
    </MobileThemeProvider>
    </AccessibilityPreferencesProvider>
    </AppleSemanticsProvider>
  );
}

function HomePage(props: {
  state: () => DemoState;
  platform: ReturnType<typeof createPocketPlatformClient>;
  system: ReturnType<typeof installShowcaseSystem>;
  dispatch: (event: DemoEvent) => void;
  runtime: CapabilityState;
}): JSX.Element {
  const theme = useMobileTheme();
  return (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4 pb-6">
        <ScrollContourItem
          defaultInBand
          class={
            theme().name === "dark"
              ? "flex-col gap-1.5 p-4 rounded-xl bg-[#18181B] border-[#27272A]"
              : "flex-col gap-1.5 p-4 rounded-xl bg-[#18181B] border-[#18181B]"
          }
          style={{ radius: 12, borderWidth: 1 }}
        >
          <Text class="text-xs text-[#A1A1AA] font-bold">POCKET SHOWCASE</Text>
          <Text class="text-2xl text-[#FAFAFA] font-bold">Made to feel native.</Text>
          <Text class="text-xs text-[#A1A1AA]">Small building blocks. Real possibilities.</Text>
        </ScrollContourItem>
        <HomeExplore dispatch={props.dispatch} />
        <MobileCard title="Playground" detail="A small interaction. An immediate response.">
          <Named name="CounterCard">
            <View class="flex-row items-center justify-between gap-3">
              <View class="flex-col gap-1 flex-1">
                <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>Counter</Text>
                <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{props.state().lastAction}</Text>
              </View>
              <View class="flex-row items-center gap-2">
                <MobileButton label="−" kind="tonal" onPress={() => props.dispatch({ type: "decrement" })} />
                <Text class={theme().name === "dark" ? "text-xl text-[#FAFAFA] font-bold" : "text-xl text-[#09090B] font-bold"}>{String(props.state().count).padStart(2, "0")}</Text>
                <MobileButton label="+1" onPress={() => props.dispatch({ type: "increment" })} />
              </View>
            </View>
          </Named>
          <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>Input round-trip</Text>
          <InputField
            value={() => props.state().draft}
            onInput={(value) => props.dispatch({ type: "draft", value })}
            onSubmit={(value) => props.dispatch({ type: "draft", value })}
            appearance={theme().name === "dark"
              ? { fillColor: "#09090B", textColor: "#FAFAFA", placeholderColor: "#A1A1AA", borderColor: "#27272A", focusedBorderColor: "#FAFAFA", borderRadius: 8 }
              : { fillColor: "#FFFFFF", textColor: "#09090B", placeholderColor: "#71717A", borderColor: "#E4E4E7", focusedBorderColor: "#18181B", borderRadius: 8 }}
          />
          <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>Draft: {props.state().draft || "(empty)"}</Text>
        </MobileCard>
        <PlatformAppsCard platform={props.platform} system={props.system} />
        <MobileListTile
          title={props.runtime.phase === "ready" ? "Runtime ready" : props.runtime.phase === "error" ? "Runtime unavailable" : "Connecting"}
          detail="Explore the host behind your experience."
          trailing={<MobileButton label="Open Host details" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "about" })} />}
        />
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
  const theme = useMobileTheme();
  const [status, setStatus] = createSignal("Preparing apps...");
  const [showAllOfficial, setShowAllOfficial] = createSignal(false);
  const officialDemos = createMemo(() => props.system.snapshot().catalog.flatMap((entry) => {
    const presentation = entry.presentation as Record<string, unknown> | undefined;
    if (presentation?.officialDemo !== true) return [];
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
    return [{
      id: typeof presentation.id === "string" ? presentation.id : entry.appId,
      appId: entry.appId,
      title: typeof presentation.title === "string" ? presentation.title : entry.appId,
      status: typeof presentation.status === "string" ? presentation.status : "unverified",
      statusReason: typeof presentation.statusReason === "string" ? presentation.statusReason : "",
      launchability: typeof presentation.launchability === "string" ? presentation.launchability : "platform-limited",
      missingCapabilities: strings(presentation.missingSessionCapabilities),
      pointerFallbackCapabilities: strings(presentation.pointerFallbackCapabilities),
      installed: entry.installed,
    }];
  }).sort((a, b) => {
    const featured = new Map([["hero", 0], ["motions", 1]]);
    return (featured.get(a.id) ?? 2) - (featured.get(b.id) ?? 2) || a.id.localeCompare(b.id);
  }));
  const visibleOfficialDemos = createMemo(() => officialDemos().slice(0, showAllOfficial() ? officialDemos().length : 6));
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
    <MobileCard>
      <View class="flex-row items-center justify-between">
        <MobileListTile title="Mini Apps" detail="A little more to explore." />
        <MobileBadge label={`${3 + officialDemos().filter((demo) => demo.installed).length} INSTALLED`} tone="neutral" />
      </View>
      <View class="flex-col gap-2">
        <MobileButton label="Open profile app" onPress={() => void open("pocket.demo.profile")} />
        <MobileButton label="Open lobby app" kind="text" onPress={() => void open("pocket.demo.lobby")} />
        <MobileButton label="雾港末班信 · Visual Novel" kind="tonal" onPress={() => void open("pocket.demo.lantern")} />
      </View>
      <View class="flex-col gap-1.5 pt-2">
        <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>Official upstream demos</Text>
        <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>Pointer/touch fallback is available where listed; it does not emulate a physical gamepad.</Text>
        <For each={visibleOfficialDemos()}>{(demo) => {
          const fallback = demo.pointerFallbackCapabilities.length > 0
            ? `Pointer/touch fallback for ${demo.pointerFallbackCapabilities.join(", ")}`
            : "No pointer fallback declared";
          const capabilityDetail = demo.missingCapabilities.length > 0
            ? `Host gap: ${demo.missingCapabilities.join(", ")}`
            : fallback;
          const details = [demo.status, demo.launchability === "portable_pointer_fallback" ? fallback : "", capabilityDetail, demo.statusReason]
            .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
            .join(" · ");
          return (
            <View class="flex-col gap-1 p-2 rounded-lg bg-[#09090B] border-[#27272A]" style={{ radius: 8, borderWidth: 1 }}>
              <MobileListTile title={demo.title} detail={details} />
              <MobileButton
                label={demo.installed ? `Open ${demo.id} demo` : "Platform-limited"}
                disabled={!demo.installed}
                onPress={() => void open(demo.appId)}
              />
            </View>
          );
        }}</For>
        <Show when={officialDemos().length > 6}>
          <MobileButton
            kind="text"
            label={showAllOfficial() ? "Show fewer demos" : `Show all ${officialDemos().length} demos`}
            onPress={() => setShowAllOfficial(!showAllOfficial())}
          />
        </Show>
        <Show when={officialDemos().length === 0}>
          <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>No official demos are staged in this build.</Text>
        </Show>
      </View>
      <For each={summaryLines(status())}>{(line) => <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-500"}>{line}</Text>}</For>
      <Show when={message() !== "No app messages yet"}>
        <For each={summaryLines(message())}>{(line) => <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-500"}>{line}</Text>}</For>
      </Show>
      <MobileButton label="Prewarm lobby" kind="text" onPress={() => {
        void props.system.ready.then(() => props.platform.prewarm("pocket.demo.lobby")).then(
          () => setStatus("Lobby prewarmed; its guest clock is paused"),
          (error) => setStatus(hostError(error).message),
        );
      }} />
    </MobileCard>
  );
}

function HomeExplore(props: { dispatch: (event: DemoEvent) => void }): JSX.Element {
  const theme = useMobileTheme();
  const features = [
    { title: "Mobile UI", detail: "Components", route: "mobile" as const },
    { title: "Transitions", detail: "Motion", route: "transitions" as const },
    { title: "Hardware", detail: "Device APIs", route: "hardware" as const },
    { title: "Video Lab", detail: "Playback", route: "video" as const },
  ];
  return (
    <ScrollContourItem class="flex-row gap-2">
      <For each={features}>{(feature) => (
        <Focusable
          class={
            theme().name === "dark"
              ? "flex-1 flex-col gap-2 h-[104] p-2.5 rounded-xl bg-[#09090B] border-[#27272A] focus:bg-[#18181B] overflow-hidden"
              : "flex-1 flex-col gap-2 h-[104] p-2.5 rounded-xl bg-white border-[#E4E4E7] focus:bg-[#F4F4F5] overflow-hidden"
          }
          style={{ radius: 12, borderWidth: 1 }}
          onPress={() => props.dispatch({ type: "navigate", route: feature.route })}
        >
          <View
            class={
              theme().name === "dark"
                ? "w-[30] h-[30] items-center justify-center rounded-lg bg-[#27272A]"
                : "w-[30] h-[30] items-center justify-center rounded-lg bg-[#F4F4F5]"
            }
          >
            <Show when={feature.route === "mobile"}><Image class="w-[20] h-[20]" src="icons/components.svg" /></Show>
            <Show when={feature.route === "transitions"}><Image class="w-[20] h-[20]" src="icons/motion.svg" /></Show>
            <Show when={feature.route === "hardware"}><Image class="w-[20] h-[20]" src="icons/hardware.svg" /></Show>
            <Show when={feature.route === "video"}><Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA]" : "text-sm text-[#09090B]"}>▶</Text></Show>
          </View>
          <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{feature.title}</Text>
          <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{feature.detail}</Text>
        </Focusable>
      )}</For>
    </ScrollContourItem>
  );
}

function GalleryTile(props: {
  card: string;
  index: () => number;
  contentWidth: () => number;
  onSelect: () => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const { leftReserve, nodeRef, reserve } = useScrollContourReserve({
    itemLeft: 16,
    itemRight: () => Math.max(0, props.contentWidth() - 16),
  });
  let appliedLeftNonZero = false;
  const tileStyle = () => {
    const l = leftReserve();
    const r = reserve();
    const isLeftColumn = props.index() % 2 === 0;
    if (isLeftColumn && l > 0) appliedLeftNonZero = true;
    const width = Math.max(0, (props.contentWidth() - l - r - 32 - 12) / 2);
    return {
      width,
      radius: 12,
      borderWidth: 1,
      ...(isLeftColumn && (l > 0 || appliedLeftNonZero) ? { marginL: l } : {}),
    };
  };
  return (
    <Focusable
      nodeRef={nodeRef}
      class={
        theme().name === "dark"
          ? "flex-col gap-3 h-[112] p-4 rounded-xl bg-[#09090B] border-[#27272A] focus:bg-[#18181B] overflow-hidden"
          : "flex-col gap-3 h-[112] p-4 rounded-xl bg-white border-[#E4E4E7] focus:bg-[#F4F4F5] overflow-hidden"
      }
      style={tileStyle()}
      onPress={props.onSelect}
    >
      <View
        class={
          theme().name === "dark"
            ? "w-[28] h-[28] items-center justify-center rounded-md bg-[#27272A]"
            : "w-[28] h-[28] items-center justify-center rounded-md bg-[#F4F4F5]"
        }
      >
        <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{props.card.slice(0, 2)}</Text>
      </View>
      <View class="flex-row items-center justify-between">
        <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>{props.card}</Text>
        <Text class={theme().name === "dark" ? "text-sm text-[#A1A1AA]" : "text-sm text-[#71717A]"}>›</Text>
      </View>
    </Focusable>
  );
}

function GalleryPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  contentWidth: () => number;
}): JSX.Element {
  const theme = useMobileTheme();
  const [galleryToastOpen, setGalleryToastOpen] = createSignal(true);
  const [galleryPopupOpen, setGalleryPopupOpen] = createSignal(false);
  const [galleryDialogOpen, setGalleryDialogOpen] = createSignal(false);
  const [galleryFw, setGalleryFw] = createSignal("Next.js");
  const [galleryOtp, setGalleryOtp] = createSignal(1);
  const [galleryToggle, setGalleryToggle] = createSignal<string[]>(["bold"]);
  const [galleryDay, setGalleryDay] = createSignal(14);
  const [galleryCmd, setGalleryCmd] = createSignal("calendar");
  const [galleryInv, setGalleryInv] = createSignal("INV001");
  const [galleryPage, setGalleryPage] = createSignal(1);
  const [shadcnTab, setShadcnTab] = createSignal<"scroll" | "menus" | "forms" | "data" | "overlays">("scroll");
  const isDark = () => theme().name === "dark";
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
      <MobileListTile title="Official building blocks" detail="The essentials, ready to explore." />
      <MobileCard
        title="Apple Glass"
        detail="Apple-style controls and navigation, with a calm backdrop to explore."
      >
        <MobileButton label="Open Apple Glass" onPress={() => props.dispatch({ type: "navigate", route: "apple" })} />
      </MobileCard>
      <View class="flex-row flex-wrap gap-3">
        <For each={componentCards}>
          {(card, index) => (
            <GalleryTile
              card={card}
              index={index}
              contentWidth={props.contentWidth}
              onSelect={() => props.dispatch({ type: "select", component: card })}
            />
          )}
        </For>
      </View>
      <MobileCard>
        <MobileListTile title="Lazy panel" detail="Content, when you need it." trailing={<MobileButton label={props.state().lazyVisible ? "Hide" : "Show"} kind="tonal" onPress={() => props.dispatch({ type: "toggleLazy" })} />} />
        <Lazy when={() => props.state().lazyVisible}>
          {() => (
            <View class="flex-col gap-1 p-3 rounded-lg bg-[#18181B] border-[#27272A]">
              <Text class="text-xs text-[#FAFAFA] font-bold">Lazy subtree is mounted</Text>
              <Text class="text-xs text-[#A1A1AA]">Only mounted while visible.</Text>
              <MiniBarChart values={[8, 14, 10, 22, 18, 28, 24]} />
            </View>
          )}
        </Lazy>
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Go a little further" detail="Components, motion and device APIs." />
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Mobile UI" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
          <MobileButton label="Transitions" kind="tonal" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
          <MobileButton label="Hardware" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
          <MobileButton label="Video Lab" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "video" })} />
        </View>
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Feedback & overlays" detail="Messages, sheets and dialogs." />
        <MobileAlert
          tone="info"
          title="Make it yours"
          body="Choose your appearance and display preferences in Settings."
        />
        <MobileToast
          open={galleryToastOpen()}
          tone="success"
          message="Toast ready in Gallery"
          detail="Spring entrance & tone transitions"
          onClose={() => setGalleryToastOpen(false)}
        />
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Toast" kind="tonal" onPress={() => setGalleryToastOpen(true)} />
          <MobileButton label="Popup" kind="text" onPress={() => setGalleryPopupOpen(true)} />
          <MobileButton label="Dialog" kind="text" onPress={() => setGalleryDialogOpen(true)} />
          <MobileButton label="Full Suite" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
        </View>
      </MobileCard>
      <MobilePopup
        open={galleryPopupOpen()}
        title="Gallery Action Sheet"
        subtitle="BottomSheet on mobile, centered Popover on desktop."
        actions={[
          { id: "mobile", label: "Open full Mobile + PC UI showcase", detail: "Explore the component collection" },
          { id: "transitions", label: "Inspect route transitions", detail: "iOS spring, shared axis & portal" },
        ]}
        onSelectAction={(id) => {
          if (id === "mobile") props.dispatch({ type: "navigate", route: "mobile" });
          if (id === "transitions") props.dispatch({ type: "navigate", route: "transitions" });
        }}
        onClose={() => setGalleryPopupOpen(false)}
      />
      <MobileDialog
        open={galleryDialogOpen()}
        title="A moment to confirm"
        body="Animated scale & opacity transition owned by JS."
        confirmLabel="Open Mobile UI"
        onConfirm={() => props.dispatch({ type: "navigate", route: "mobile" })}
        onClose={() => setGalleryDialogOpen(false)}
      />
      <MobileAlert tone="info" title="Not mounted here" body="More capabilities live under Host." />

      <Show when={props.state().route === "gallery"}>
        <MobileCard
          title="shadcn/ui Full Component Suite (50+)"
          detail="Browse all shadcn/ui primitives: ScrollArea/ScrollFade, Resizable, Sidebar, Menus, Forms, DataTable, Chart, Overlays & Typography."
        >
          <View class="flex-row flex-wrap gap-1.5">
            <MobileButton
              label="Scroll & Layout"
              kind={shadcnTab() === "scroll" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("scroll")}
            />
            <MobileButton
              label="Menus & Command"
              kind={shadcnTab() === "menus" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("menus")}
            />
            <MobileButton
              label="Forms & Date"
              kind={shadcnTab() === "forms" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("forms")}
            />
            <MobileButton
              label="Charts & Tables"
              kind={shadcnTab() === "data" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("data")}
            />
            <MobileButton
              label="Overlays & Text"
              kind={shadcnTab() === "overlays" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("overlays")}
            />
          </View>

          <Show when={shadcnTab() === "scroll"}>
            <ShadcnScrollArea title="Tags (ScrollArea + ScrollFade)" dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnResizable dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnSidebar dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnCarousel dark={isDark()} />
            <ShadcnAspectRatio dark={isDark()} />
          </Show>

          <Show when={shadcnTab() === "menus"}>
            <ShadcnBreadcrumb items={["shadcn/ui", "Components", "Preview"]} dark={isDark()} />
            <ShadcnNavigationMenu dark={isDark()} />
            <ShadcnMenubar dark={isDark()} />
            <ShadcnCommand
              selectedId={galleryCmd()}
              onSelect={setGalleryCmd}
              items={[
                { id: "calendar", label: "Calendar", group: "Suggestions" },
                { id: "emoji", label: "Search Emoji", group: "Suggestions" },
                { id: "profile", label: "Profile", group: "Preferences", shortcut: "⌘P" },
                { id: "billing", label: "Billing", group: "Preferences", shortcut: "⌘B" },
              ]}
              dark={isDark()}
            />
            <ShadcnDropdownMenu
              triggerLabel="My Account"
              items={[
                { id: "profile", label: "Profile", shortcut: "⇧⌘P" },
                { id: "billing", label: "Billing", shortcut: "⌘B" },
                { id: "shortcuts", label: "Keyboard shortcuts", shortcut: "⌘K" },
              ]}
              dark={isDark()}
            />
            <ShadcnContextMenu dark={isDark()} />
            <ShadcnHoverCard
              handle="@nextjs"
              description="The React Framework – created and maintained by @vercel."
              joined="Joined December 2021"
              dark={isDark()}
            />
          </Show>

          <Show when={shadcnTab() === "forms"}>
            <ShadcnSelect
              label="Framework"
              value={galleryFw()}
              options={["Next.js", "SolidJS", "SvelteKit", "Astro", "Remix"]}
              onChange={setGalleryFw}
              dark={isDark()}
            />
            <ShadcnCombobox dark={isDark()} />
            <ShadcnInputOTP
              value="482910"
              activeSlot={galleryOtp()}
              onSelectSlot={setGalleryOtp}
              dark={isDark()}
            />
            <ShadcnToggleGroup
              options={[
                { id: "bold", label: "B Bold" },
                { id: "italic", label: "I Italic" },
                { id: "underline", label: "U Underline" },
              ]}
              selected={galleryToggle()}
              onToggle={(id) =>
                setGalleryToggle((prev) =>
                  prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
                )
              }
              dark={isDark()}
            />
            <ShadcnDatePicker dark={isDark()} />
            <ShadcnCalendar
              monthLabel="November 2026"
              selectedDay={galleryDay()}
              onSelectDay={setGalleryDay}
              dark={isDark()}
            />
            <ShadcnFormField dark={isDark()} />
            <ShadcnInputGroup dark={isDark()} />
            <ShadcnTextarea dark={isDark()} />
            <ShadcnButtonGroup dark={isDark()} />
          </Show>

          <Show when={shadcnTab() === "data"}>
            <ShadcnChart dark={isDark()} />
            <ShadcnDataTable dark={isDark()} />
            <ShadcnTable
              caption="A list of your recent invoices."
              selectedInvoice={galleryInv()}
              onSelectRow={setGalleryInv}
              rows={[
                { invoice: "INV001", status: "Paid", method: "Credit Card", amount: "$250.00" },
                { invoice: "INV002", status: "Pending", method: "PayPal", amount: "$150.00" },
                { invoice: "INV003", status: "Unpaid", method: "Bank Transfer", amount: "$350.00" },
              ]}
              totalAmount="$750.00"
              dark={isDark()}
            />
            <View class="flex-row items-center justify-between flex-wrap gap-2">
              <View class="flex-row items-center gap-1.5">
                <ShadcnKbd keys="⌘K" dark={isDark()} />
                <ShadcnKbd keys="⇧⌘P" dark={isDark()} />
              </View>
              <ShadcnPagination page={galleryPage()} totalPages={3} onChange={setGalleryPage} dark={isDark()} />
            </View>
            <ShadcnItem
              title="Two-factor authentication (Item)"
              description="Verify via email or authenticator code."
              badge="Enabled"
              dark={isDark()}
            />
          </Show>

          <Show when={shadcnTab() === "overlays"}>
            <ShadcnDrawer dark={isDark()} />
            <ShadcnSheet dark={isDark()} />
            <ShadcnPopover dark={isDark()} />
            <ShadcnCollapsible
              title="@peduarte starred 3 repositories"
              pinnedItem="@radix-ui/primitives"
              hiddenItems={["@radix-ui/colors", "@stitches/react"]}
              dark={isDark()}
            />
            <View class="flex-row items-center justify-between flex-wrap gap-2">
              <ShadcnTooltip dark={isDark()} />
              <ShadcnSpinner dark={isDark()} />
            </View>
            <ShadcnEmpty dark={isDark()} />
            <ShadcnTypography dark={isDark()} />
          </Show>
        </MobileCard>
      </Show>
      </View>
    </ScrollablePage>
  );
}

function HostPages(props: {
  route: Route;
  host: HostBridge;
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
  runStress: (nodes: number) => void;
  performance: () => PerformanceSnapshot;
  recordingStatus?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  const route = () => props.route;
  const switchTab = (id: string): void => {
    const target = routeOf(id);
    if (target && target !== "home" && target !== "gallery") props.dispatch({ type: "navigate", route: target });
  };
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
      <Show when={route() === "about"}>
        <RuntimePage host={props.host} state={props.state} requestCapability={props.requestCapability} onNavigate={(route) => props.dispatch({ type: "navigate", route })} recordingStatus={props.recordingStatus} />
      </Show>
      <Show when={route() === "about"}>
        <MobileCard title="Explore your host" detail="Packages, updates and diagnostics.">
          <For each={hostTabs.filter((tab) => tab.id !== "about")}>{(tab) => <MobileListTile title={tab.label} detail="Open details" trailing={<MobileButton label={`Open ${tab.label}`} kind="text" onPress={() => switchTab(tab.id)} />} onPress={() => switchTab(tab.id)} />}</For>
        </MobileCard>
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
  const theme = useMobileTheme();
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Runtime" detail="Live host status and package identity." />
      <CapabilityCard title="Runtime info" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <CapabilityCard title="Package metadata" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
      <ScrollContourItem>
        <MobileButton label="Frame diagnostics" kind="tonal" onPress={() => props.onNavigate("performance")} />
      </ScrollContourItem>
      <Show
        when={supportsRecording(props.state().runtimeInfo)}
        fallback={<MobileAlert
          tone="info"
          title={props.state().runtimeInfo.phase === "ready"
            ? "Deterministic replay unavailable"
            : props.state().runtimeInfo.phase === "error"
            ? "Recording support unavailable"
            : "Checking recording support"}
          body={props.state().runtimeInfo.phase === "ready"
            ? "The active host does not provide recording and replay."
            : props.state().runtimeInfo.phase === "error"
            ? `${props.state().runtimeInfo.error?.code ?? "host_error"}: ${props.state().runtimeInfo.error?.message ?? "Runtime facts are unavailable."}`
            : "Waiting for the host to finish capability negotiation."}
        />}
      >
        <RecordingPanel host={props.host} status={props.recordingStatus} />
      </Show>
      <MobileAlert title={`Connected to ${hostLabel(props.state().runtimeInfo)}`} body="UI state stays in JS" tone={props.state().runtimeInfo.phase === "error" ? "danger" : "info"} />
    </View>
  );
}

function PerformancePage(props: {
  state: () => DemoState;
  performance: () => PerformanceSnapshot;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  const theme = useMobileTheme();
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
      <MobileListTile title="Frame diagnostics" detail="Guest ticks are separate from display FPS. Sparse rendering is not a stall." />
      <MobileCard>
        <View class="flex-col gap-1 flex-1">
          <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold"}>Performance provider · {hostPhase(provider())}</Text>
          <Text class={provider().phase === "error" ? "text-xs text-rose-700" : "text-xs text-slate-600"}>
            {capabilitySummary(provider())}
          </Text>
        </View>
        <MobileButton
          label={provider().phase === "loading" ? "Wait" : "Refresh"}
          kind="text"
          onPress={() => props.requestCapability("runtimePerformance", "runtime.performance")}
        />
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Recent 60 samples" detail={props.performance().recording ? "Recording" : "Provider not recording"} trailing={<MobileBadge tone={props.performance().recording ? "success" : "warning"} label={String(points().length)} />} />
        <Show when={points().length > 0} fallback={<MobileAlert tone="info" title="No guest tick samples" body="Open a configured host performance provider or refresh this page." />}>
          <MiniBarChart values={performanceBars(points())} />
          <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>Bars show guest scheduler turns per active second, not display FPS.</Text>
        </Show>
      </MobileCard>
      <ScrollContourItem class="flex-row gap-2">
        <MobileCard title="Guest ticks/s" detail={latest() ? `min ${metricNumber(latest()?.minFps)} · active gap ${metricNumber(latestGap())} ms` : "No latest sample"}>
          <Text class="text-2xl font-bold" style={{ textColor: toMobileColor(theme().accentInkColor) }}>{metricNumber(latest()?.fps)}</Text>
        </MobileCard>
        <MobileCard>
          <Text class={theme().name === "dark" ? "text-xs text-rose-300" : "text-xs text-rose-700"}>Current minimum</Text>
          <Text class={theme().name === "dark" ? "text-xl text-rose-300 font-bold" : "text-xl text-rose-700 font-bold"}>{metricNumber(minimumPerformanceFps(points()))}</Text>
          <Text class={theme().name === "dark" ? "text-xs text-rose-300" : "text-xs text-rose-700"}>lowest guest tick window</Text>
        </MobileCard>
      </ScrollContourItem>
      <Show when={latest() ?? latestLongFrame()} fallback={<MobileAlert tone="info" title="No frame breakdown" body="The provider has not returned a current frame window." />}>
        <MobileCard>
          <MobileListTile
            title="Latest frame breakdown"
            detail={latestBudget() === undefined ? "refresh budget unavailable" : `budget ${metricNumber(latestBudget())} ms`}
          />
          <View class="flex-row items-center justify-between gap-2">
            <MobileListTile title="UI build" detail={latestBuild() === undefined ? "—" : `${metricNumber(latestBuild())} ms${latest()?.buildMsP95 === undefined ? " long frame" : " p95"}`} />
            <MobileListTile title="Raster" detail={latestRaster() === undefined ? "—" : `${metricNumber(latestRaster())} ms${latest()?.rasterMsP95 === undefined ? " long frame" : " p95"}`} />
          </View>
          <View class="flex-row items-center justify-between gap-2">
            <MobileListTile title="Bridge/decode" detail={latestBridgeDecode() === undefined ? "—" : `${metricNumber(latestBridgeDecode())} ms${latest()?.nativeWorkMsP95 === undefined ? " long frame" : " p95"}`} />
            <MobileListTile title="Active gap" detail={latestGap() === undefined ? "—" : `${metricNumber(latestGap())} ms`} />
          </View>
          <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>
            Compatibility bridge p95: {metricNumber(latest()?.nativeMsP95)} ms · refresh {latest()?.refreshHz === undefined ? "—" : `${metricNumber(latest()?.refreshHz)} Hz`}
          </Text>
        </MobileCard>
      </Show>
      <Show when={jankRows().length > 0} fallback={<MobileAlert tone="info" title="No recent long frames" body="No active gap exceeded the provider's refresh-rate budget. A low guest tick rate with gap 0 can be intentional sparse rendering." />}>
        <MobileCard>
          <MobileListTile title="Recent long frames" detail="Measured jank history" />
          <VirtualList
            count={jankRows().length}
            rowHeight={64}
            height={192}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = jankRows()[index];
              return (
                <View class="flex-col gap-1 px-2 py-1 bg-[#3D2E10] border-[#936211]">
                  <Text class={theme().name === "dark" ? "text-xs text-[#FCD34D] font-bold" : "text-xs text-amber-800 font-bold"}>{item?.title ?? "Long frame"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "Frame timing breakdown unavailable"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.context ?? "Host frame sampler"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
      <Show when={lowRows().length > 0} fallback={<MobileAlert tone="info" title="No low-frame samples" body="The provider has not returned a measurable history yet." />}>
        <MobileCard>
          <MobileListTile title="Lowest guest tick samples" detail="Compatibility history · not jank by itself" />
          <VirtualList
            count={lowRows().length}
            rowHeight={36}
            height={108}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = lowRows()[index];
              return (
                <View class={theme().name === "dark" ? "flex-col gap-1 px-2 py-1 bg-[#17233B] border-[#30405A]" : "flex-col gap-1 px-2 py-1 bg-slate-50 border-slate-200"}>
                  <Text class={theme().name === "dark" ? "text-xs text-rose-300 font-bold" : "text-xs text-rose-700 font-bold"}>{item?.title ?? "Low guest tick sample"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "Provider metrics unavailable"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
    </View>
  );
}

function BytecodePage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Bytecode" detail="QuickJS runtime and bundle identity." />
      <CapabilityCard title="QuickJS runtime" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <MobileCard>
        <MobileListTile title="Package response" detail="Reported by the active runtime." />
        <For each={summaryLines(capabilitySummary(props.state().runtimeInfo))}>{(line) => <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-500"}>{line}</Text>}</For>
      </MobileCard>
    </View>
  );
}

function UpdatesPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const versions = () => versionHistory(props.state().updatesStatus.result);
  return (
    <View class="flex-col gap-2">
      <MobileListTile title="Updates" detail="Manage versions supplied by the host." />
      <CapabilityCard title="Current status" capability="updates.status" state={props.state().updatesStatus} onRefresh={() => props.requestCapability("updatesStatus", "updates.status")} />
      <Show when={versions().length > 0} fallback={<MobileAlert tone="info" title="Version history" body="The host returned no verified versions." />}>
        <MobileCard>
          <MobileListTile title="Version history" detail="From updates.status" trailing={<MobileBadge label={String(versions().length)} />} />
          <VirtualList
            count={versions().length}
            rowHeight={32}
            height={80}
            focusRows={false}
            overscan={32}
            renderRow={(index) => {
              const item = versions()[index];
              return (
                <View class={theme().name === "dark" ? "flex-col gap-1 px-2 py-1 bg-[#17233B] border-[#30405A]" : "flex-col gap-1 px-2 py-1 bg-white border-slate-200"}>
                  <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold"}>{item?.title ?? "Version"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "verified version"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
      <Show when={!capabilityUnavailable(props.state().updatesStatus)}
        fallback={<MobileAlert tone="info" title="Updates not configured" body="This host runs the embedded package. Pocket package updates are not enabled." />}>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton label="Check" onPress={() => props.requestCapability("updatesCheck", "updates.check")} />
        <MobileButton label="Apply" kind="tonal" onPress={() => props.requestCapability("updatesApply", "updates.apply")} />
        <MobileButton label="Rollback" kind="danger" onPress={() => props.requestCapability("updatesRollback", "updates.rollback")} />
      </View>
      <MobileCard>
        <MobileListTile title="updates.check" detail={capabilitySummary(props.state().updatesCheck)} />
        <MobileListTile title="updates.apply" detail={capabilitySummary(props.state().updatesApply)} />
        <MobileListTile title="updates.rollback" detail={capabilitySummary(props.state().updatesRollback)} />
      </MobileCard>
      </Show>
    </View>
  );
}

function PluginsPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const plugins = () => listItems(props.state().pluginsList.result);
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Plugins" detail="Installed capabilities from the host." />
      <CapabilityCard title="Installed plugins" capability="plugins.list" state={props.state().pluginsList} onRefresh={() => props.requestCapability("pluginsList", "plugins.list")} />
      <Show when={plugins().length > 0} fallback={<MobileAlert tone="info" title="No plugin list" body={capabilitySummary(props.state().pluginsList)} />}>
        <MobileCard><For each={plugins()}>{(plugin) => <MobileListTile title={plugin.title} detail={plugin.detail} />}</For></MobileCard>
      </Show>
      <CapabilityCard title="External package info" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
    </View>
  );
}

function StressPage(props: { state: () => DemoState; runStress: (nodes: number) => void }): JSX.Element {
  const theme = useMobileTheme();
  const nodes = () => stressItems(props.state().stress.nodeCount);
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Stress" detail="Measure JS node pressure at two sizes." />
      <MobileCard>
        <MobileListTile title="Retained node pressure" detail="Guest-owned UI state" />
        <View class="flex-row items-center justify-between gap-2">
          <MobileButton label="Run 100 nodes" onPress={() => props.runStress(100)} />
          <MobileButton label="Run 500 nodes" kind="tonal" onPress={() => props.runStress(500)} />
        </View>
      </MobileCard>
      <ScrollContourItem class="flex-row gap-2">
        <MobileCard title="Nodes" detail={`${props.state().stress.durationMs} ms JS setup`}><Text class="text-2xl font-bold" style={{ textColor: toMobileColor(theme().accentInkColor) }}>{String(props.state().stress.nodeCount)}</Text></MobileCard>
        <MobileCard title="Checksum" detail={props.state().stress.lastAction}><Text class="text-xl font-bold" style={{ textColor: toMobileColor(theme().accentInkColor) }}>{String(props.state().stress.checksum)}</Text></MobileCard>
      </ScrollContourItem>
      <ScrollContourItem mode="padding" class="px-4">
        <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{props.state().stress.nodeCount} retained nodes in the current guest frame.</Text>
      </ScrollContourItem>
      <ScrollContourItem mode="padding" class="flex-row flex-wrap gap-1 px-4 overflow-hidden">
        <For each={nodes()}>
          {() => <View class="w-2 h-2 rounded bg-cyan-500" />}
        </For>
      </ScrollContourItem>
    </View>
  );
}

mount(() => <App />);

