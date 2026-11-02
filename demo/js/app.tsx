import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import {
  FocusScope,
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
import { HardwarePage, LiquidGlassPage, MobileUiPage, TransitionsPage } from "./mobile-pages.tsx";
import { createHostBridge, hostError, type JsonValue } from "./host.ts";
import { demoRelease } from "./release.ts";
import { availableDisplayPanes, computeTransitionDescriptor, createDisplayGeometry, deriveResponsiveLayout } from "@pocket/ui";
import {
  PERFORMANCE_HISTORY_LIMIT,
  initialDemoState,
  appendPerformanceSample,
  parsePerformancePoint,
  parsePerformanceSnapshot,
  reduceDemoState,
  type CapabilityKey,
  type CapabilityState,
  type DemoEvent,
  type DemoState,
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
  View: "The official retained view primitive carries layout and hit bounds to the native core.",
  Text: "Text is emitted as an official TEXT_RUN and painted by the Flutter surface.",
  Image: "Image resolves the local PAK asset and emits an official TEX_QUAD.",
  Focusable: "Focusable marks a guest View for the official input resolver.",
  Grid: "Grid combines official flex wrapping with focus-grid traversal when columns are supplied.",
  For: "Solid's list helper keeps collection rendering in JavaScript.",
  Lazy: "Lazy gates a subtree in JavaScript; no Dart visibility flag is needed.",
  Modal: "Modal is the official Portal overlay, controlled by this guest signal.",
  TextField: "TextField is a guest input shell bound to Flutter's system text overlay and the app-owned draft signal.",
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
  if (route === "home" || route === "gallery" || route === "about" || route === "bytecode" || route === "updates" || route === "plugins" || route === "stress" || route === "performance" || route === "mobile" || route === "transitions" || route === "glass" || route === "hardware") return route;
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
      return `recording=${String(record.recording)} · samples=${history} · latestFps=${latest}`;
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

function performanceBars(points: readonly PerformancePoint[]): number[] {
  if (points.length === 0) return [];
  const scale = Math.max(60, ...points.map((point) => point.fps));
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
      title: `${metricNumber(point.fps)} FPS · ${timestampLabel(point.timestamp)}`,
      detail: `gap ${metricNumber(point.maxGapMs)} ms · slow ${metricNumber(point.slowFrames, 0)} · native p95 ${metricNumber(point.nativeMsP95)} ms`,
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
  const mobileDark = () => state().route === "mobile" && state().mobileDark;
  const responsiveLayout = () => deriveResponsiveLayout(displayGeometry());
  const wideLayout = () => responsiveLayout().mode === "wide";
  const contentPaneStyle = () => {
    const layout = responsiveLayout();
    if (!layout.division) return { grow: 1 };
    const panes = availableDisplayPanes(displayGeometry());
    const pane = layout.railSide === "right" ? panes[0] : panes[panes.length - 1];
    // The first pane starts after the outer left safe-area inset.  When the
    // rail is on the right the content is the first pane and must carry that
    // offset; when the rail is on the left the rail itself owns the offset.
    return {
      width: pane?.width ?? displayGeometry().width,
      grow: 0,
      marginL: layout.railSide === "right" ? layout.insets.left : 0,
    };
  };
  // Performance samples arrive independently of the application reducer. This
  // keeps a 1 Hz/host-driven metric stream from rebuilding Home/Stress trees.
  const [performance, setPerformance] = createSignal<PerformanceSnapshot>({
    latest: null,
    history: [],
    recording: false,
  });
  // Capability providers such as BLE, biometrics and location can legitimately
  // take several seconds on a real device. Keep the request map bounded, but
  // give those providers a deterministic 30-second guest-clock window.
  const host = createHostBridge(undefined, { maxPendingRequests: 32, timeoutFrames: 1800 });
  let requestSequence = 0;
  const routeTransitionDuration = 220;
  const routeTransitionTickHz = 60;
  let previousRoute: Route = initialDemoState().route;
  let pendingTransitionDirection: "forward" | "reverse" = "forward";
  const [routeTransition, setRouteTransition] = createSignal<{
    from: Route;
    to: Route;
    direction: "forward" | "reverse";
    elapsedMs: number;
    progress: number;
  } | undefined>(undefined);

  const dispatch = (event: DemoEvent): void => {
    if (event.type === "navigate" && event.route !== state().route) pendingTransitionDirection = "forward";
    if (event.type === "popRoute" && state().routeStack.length > 1) pendingTransitionDirection = "reverse";
    setState((current) => reduceDemoState(current, event));
  };

  const navigate = (route: Route): void => dispatch({ type: "navigate", route });

  const isShowcaseRoute = (route: Route): boolean =>
    route === "mobile" || route === "transitions" || route === "glass" || route === "hardware";

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
  });

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
      host.handle(line);
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
          ? { ...(rawSample as Record<string, unknown>), ...(params.minFps === undefined ? {} : { minFps: params.minFps }) }
          : rawSample;
        const sample = parsePerformancePoint(sampleRecord);
        if (sample) {
          setPerformance((current) => {
            const next = appendPerformanceSample(current, sample);
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
    requestCapability("pluginsList", "plugins.list");
    requestCapability("packageInfo", "plugins.packageInfo");
    requestCapability("updatesStatus", "updates.status");

    onCleanup(() => {
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
      host.dispose();
    });
  });

  return (
    <Screen class={mobileDark() ? "w-full h-full flex-col bg-[#0d1726] overflow-hidden" : "w-full h-full flex-col bg-slate-50 overflow-hidden"}>
      <Show when={!isShowcaseRoute(state().route)}>
        <Header
          title={demoTitle}
          subtitle={`${demoRelease} · Solid guest · Flutter canvas`}
        />
      </Show>
      <FocusScope class="flex-1 flex-col overflow-hidden" autoFocus restoreFocus>
        {/* Keep FocusScope's own props static: the official FocusScope
            implementation forwards props through an object spread, so a
            dynamic flex direction there freezes at mount. The ordinary View
            below owns the responsive row/column class and remains reactive
            across a live Duo resize. */}
        <View class={wideLayout() ? "flex-1 flex-row h-full overflow-hidden" : "flex-1 flex-col h-full overflow-hidden"}>
          <Show when={wideLayout() && responsiveLayout().railSide === "left"}>
            <NavigationBar route={state().route} onNavigate={navigate} wide={wideLayout} geometry={() => displayGeometry()} />
          </Show>
          <View class={responsiveLayout().division ? "h-full overflow-hidden" : "flex-1 h-full overflow-hidden"} style={{ ...contentPaneStyle(), translateX: transitionDescriptor().inTx, translateY: transitionDescriptor().inTy, scale: transitionDescriptor().inScale }}>
            <Show when={state().route === "home"}>
              <HomePage
                state={state}
                dispatch={dispatch}
                runtime={state().runtimeInfo}
                onRefresh={() => requestCapability("runtimeInfo", "runtime.info")}
                wide={wideLayout}
                contentWidth={() => {
                  const layout = responsiveLayout();
                  if (!layout.division) return undefined;
                  const panes = availableDisplayPanes(displayGeometry());
                  const pane = layout.railSide === "right" ? panes[0] : panes[panes.length - 1];
                  // Home's hero owns `mx-4`; keep its explicit width inside the
                  // selected pane instead of letting margins cross the hinge.
                  return pane ? Math.max(0, pane.width - 32) : undefined;
                }}
              />
            </Show>
            <Show when={state().route === "gallery"}>
              <GalleryPage state={state} dispatch={dispatch} />
            </Show>
            <Show when={state().route === "mobile"}>
              <ScrollablePage><MobileUiPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "transitions"}>
              <ScrollablePage><TransitionsPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "glass"}>
              <ScrollablePage><LiquidGlassPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "hardware"}>
              <ScrollablePage><HardwarePage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>
            </Show>
            <Show when={state().route === "about" || state().route === "bytecode" || state().route === "updates" || state().route === "plugins" || state().route === "stress" || state().route === "performance"}>
              <HostPages state={state} dispatch={dispatch} requestCapability={requestCapability} runStress={runStress} performance={performance} />
            </Show>
          </View>
          <Show when={!wideLayout() || responsiveLayout().railSide === "right"}>
            <NavigationBar route={state().route} onNavigate={navigate} wide={wideLayout} geometry={() => displayGeometry()} />
          </Show>
        </View>
      </FocusScope>
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
  dispatch: (event: DemoEvent) => void;
  runtime: CapabilityState;
  onRefresh: () => void;
  wide?: () => boolean;
  contentWidth?: () => number | undefined;
}): JSX.Element {
  const wide = () => props.wide?.() === true;
  const contentWidth = () => props.contentWidth?.();
  const panelLayout = () => wide() ? "flex-row gap-3 mx-4" : "flex-col gap-3 mx-4";
  const panelClass = () => wide()
    ? "flex-1 flex-col gap-2 p-4 rounded-xl bg-white border-slate-200"
    : "flex-col gap-2 mx-4 p-4 rounded-xl bg-white border-slate-200";
  return (
    <ScrollablePage>
      <View class="flex-col gap-3">
        <View
          class="flex-col gap-2 mx-4 mt-3 p-4 rounded-xl bg-[#10233f]"
          style={contentWidth() === undefined ? undefined : { width: contentWidth()! }}
        >
          <Row>
            <Text class="text-xs text-blue-200 font-bold">POCKET HOST LAB</Text>
            <Badge tone="green">EMBEDDED</Badge>
          </Row>
          <Text class="text-lg text-white font-bold">One runtime, one source of truth</Text>
          <Text class="text-xs text-blue-100">Native surface · JS-owned state</Text>
        </View>
        <View class="flex-row gap-2 mx-4">
          <MetricCard label="Runtime" value={props.runtime.phase === "ready" ? "Ready" : "Waiting"} detail="Native host" tone="blue" />
          <MetricCard label="Input" value={props.state().draft ? "Ready" : "Draft"} detail="System keyboard" tone="green" />
        </View>
        <Show when={wide()}><HomeExplore wide={wide} dispatch={props.dispatch} /></Show>
        <View class={panelLayout()}>
        <Card class={panelClass()}>
          <ViewText title="Input round-trip" body="The field opens the system keyboard." />
          <InputField
            value={() => props.state().draft}
            onInput={(value) => props.dispatch({ type: "draft", value })}
            onSubmit={(value) => props.dispatch({ type: "draft", value })}
          />
          <Text class="text-sm text-blue-700">Draft: {props.state().draft || "(empty)"}</Text>
        </Card>
        <Named name="CounterCard">
          <Card class={panelClass()}>
            <Row>
              <ViewText title="Counter" body="State stays in JS" />
              <Badge tone="green">LIVE</Badge>
            </Row>
            <Text class="text-xl text-slate-950 font-bold">{String(props.state().count).padStart(2, "0")}</Text>
            <Row>
              <ActionButton label="−" kind="quiet" onPress={() => props.dispatch({ type: "decrement" })} />
              <ActionButton label="+1" onPress={() => props.dispatch({ type: "increment" })} />
              <Text class="text-xs text-slate-500">{props.state().lastAction}</Text>
            </Row>
          </Card>
        </Named>
        </View>
        <Show when={!wide()}><HomeExplore wide={wide} dispatch={props.dispatch} /></Show>
        <Card class="flex-col gap-2 mx-4 p-3 rounded-xl bg-slate-100 border-slate-200">
          <Row>
            <ViewText title="Runtime" body={props.runtime.phase === "ready" ? "Connected to the native host" : "Waiting for the native host"} />
            <Badge tone={props.runtime.phase === "error" ? "rose" : props.runtime.phase === "ready" ? "green" : "amber"}>{props.runtime.phase.toUpperCase()}</Badge>
          </Row>
          <ActionButton label="Open Host details" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "about" })} />
        </Card>
        <StatusBar label="JS state · native pixels" detail="Ready for input" ok={props.runtime.phase !== "error"} />
      </View>
    </ScrollablePage>
  );
}

function HomeExplore(props: { wide: () => boolean; dispatch: (event: DemoEvent) => void }): JSX.Element {
  const featureClass = (kind: "primary" | "quiet") => {
    if (props.wide()) {
      return kind === "primary"
        ? "flex-1 h-[88] flex-col items-center justify-center rounded-xl bg-blue-600 focus:bg-blue-500 px-4"
        : "flex-1 h-[88] flex-col items-center justify-center rounded-xl bg-slate-200 focus:bg-slate-300 px-4";
    }
    return kind === "primary"
      ? "w-[160] h-[72] flex-col items-center justify-center rounded-xl bg-blue-600 focus:bg-blue-500 px-3"
      : "w-[160] h-[72] flex-col items-center justify-center rounded-xl bg-slate-200 focus:bg-slate-300 px-3";
  };
  return (
    <>
      <SectionHeading title="Explore" detail="Choose a lane" />
      <View class="flex-row flex-wrap gap-2 mx-4">
        <ActionButton class={featureClass("primary")} label="Mobile UI" kind="primary" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
        <ActionButton class={featureClass("quiet")} label="Transitions" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
        <ActionButton class={featureClass("quiet")} label="Liquid Glass" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "glass" })} />
        <ActionButton class={featureClass("quiet")} label="Hardware" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
      </View>
    </>
  );
}

function GalleryPage(props: { state: () => DemoState; dispatch: (event: DemoEvent) => void }): JSX.Element {
  return (
    <ScrollablePage>
      <View class="flex-col gap-2">
      <PageIntro title="Official building blocks" body="A focused set of components mounted in this sample." />
      <Image class="w-[24] h-[24] mx-4 rounded-lg" src="pocket-mark.svg" />
      <Text class="text-xs text-slate-600 px-4">Tap a tile for the guest-owned detail modal.</Text>
      <TileGrid>
        <For each={componentCards}>
          {(card) => (
            <ActionButton
              class="flex-col gap-1 p-2 rounded-xl bg-white border-slate-200"
              label={card}
              kind="quiet"
              onPress={() => props.dispatch({ type: "select", component: card })}
            />
          )}
        </For>
      </TileGrid>
      <Card class="flex-col gap-2 mx-4 p-4 rounded-xl bg-white border-slate-200">
        <Row>
          <ViewText title="Lazy panel" body="Toggle a JS-owned subtree" />
          <ActionButton label={props.state().lazyVisible ? "Hide" : "Show"} kind="secondary" onPress={() => props.dispatch({ type: "toggleLazy" })} />
        </Row>
        <Lazy when={() => props.state().lazyVisible}>
          {() => (
            <View class="flex-col gap-1 p-2 rounded-lg bg-purple-600">
              <Text class="text-xs text-white font-bold">Lazy subtree is mounted</Text>
              <Text class="text-xs text-purple-100">No native visibility flag participates.</Text>
              <MiniBarChart values={[8, 14, 10, 22, 18, 28, 24]} />
            </View>
          )}
        </Lazy>
      </Card>
      <Card class="flex-col gap-2 mx-4 p-4 rounded-xl bg-white border-slate-200">
        <ViewText title="Showcase lanes" body="Explore mobile controls, motion, glass, and devices." />
        <View class="flex-row flex-wrap gap-2">
          <ActionButton label="Mobile UI" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
          <ActionButton label="Transitions" kind="secondary" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
          <ActionButton label="Liquid Glass" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "glass" })} />
          <ActionButton label="Hardware" kind="quiet" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
        </View>
      </Card>
      <EmptyState title="Not mounted here" body="Advanced media and auxiliary surfaces are outside this showcase." />
      </View>
    </ScrollablePage>
  );
}

function HostPages(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
  runStress: (nodes: number) => void;
  performance: () => PerformanceSnapshot;
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
        <RuntimePage state={props.state} requestCapability={props.requestCapability} onNavigate={(route) => props.dispatch({ type: "navigate", route })} />
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
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
  onNavigate: (route: Route) => void;
}): JSX.Element {
  return (
    <View class="flex-col gap-3">
      <PageIntro title="Runtime" body="Live host status and package identity." />
      <CapabilityCard title="Runtime info" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <CapabilityCard title="Package metadata" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
      <ActionButton label="FPS history" kind="secondary" onPress={() => props.onNavigate("performance")} />
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
  const provider = () => props.state().runtimePerformance;
  return (
    <View class="flex-col gap-2">
      <PageIntro title="FPS history" body="Host frame samples and low-frame events." />
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
        <Show when={points().length > 0} fallback={<EmptyState title="No FPS samples" body="Open a configured host performance provider or refresh this page." />}>
          <MiniBarChart values={performanceBars(points())} />
          <Text class="text-xs text-slate-600">Bars are the latest provider samples, scaled to a 60 FPS baseline.</Text>
        </Show>
      </Card>
      <View class="flex-row gap-2 mx-4">
        <MetricCard
          label="Latest FPS"
          value={metricNumber(latest()?.fps)}
          detail={latest() ? `min ${metricNumber(latest()?.minFps)} · gap ${metricNumber(latest()?.maxGapMs)} ms` : "No latest sample"}
          tone="purple"
        />
        <Card class="flex-col gap-1 p-3 rounded-xl bg-rose-100">
          <Text class="text-xs text-rose-700">Current minimum</Text>
          <Text class="text-xl text-rose-700 font-bold">{metricNumber(minimumPerformanceFps(points()))}</Text>
          <Text class="text-xs text-rose-700">lowest recorded FPS</Text>
        </Card>
      </View>
      <Show when={lowRows().length > 0} fallback={<EmptyState title="No low-frame samples" body="The provider has not returned a measurable history yet." />}>
        <Card class="flex-col gap-1 mx-4 p-2 rounded-xl bg-white border-slate-200">
          <SectionHeading title="Lowest FPS samples" detail="Provider history" />
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
                  <Text class="text-xs text-rose-700 font-bold">{item?.title ?? "Low FPS sample"}</Text>
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
      <Card class="flex-col gap-2 mx-4 p-3 rounded-xl bg-[#172235]">
        <ViewText title="What this proves" body="A real host response is visible here when configured. An error or missing capability remains visible as an error." />
        <Text class="text-xs text-cyan-200">Current response: {capabilitySummary(props.state().runtimeInfo)}</Text>
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

