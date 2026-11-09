/**
 * Thin guest composition primitives.
 *
 * Every primitive here is a Solid function assembled from official PocketJS
 * components. This is intentionally a small app UI kit, not a second
 * Flutter widget catalogue or a claim that all upstream components are
 * mounted by this sample.
 */

import { For, Show, children as resolveChildren, createContext, createEffect, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { bindDpadScroll, createScroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import {
  Focusable,
  Grid,
  Modal,
  Text,
  View,
  type NodeMirror,
  type ViewProps,
} from "@pocketjs/framework/solid/components";
import { createDisplayGeometry, subscribeHostEvents } from "./display.ts";
import {
  availableDisplayPanes,
  avoidDisplayOcclusions,
  bottomBarInsets,
  deriveResponsiveLayout,
  DISPLAY_UI_SAFETY_GAP,
  EMPTY_DISPLAY_GEOMETRY,
  hasLocalLeftOcclusionInset,
  hasLocalRightOcclusionInset,
  leftOcclusionFrames,
  pageInsets,
  rightOcclusionFrames,
  sideContourReservesForBand,
  topRightContourReserveForBand,
  topRightOcclusionFrame,
  topRightOcclusionFrames,
  type DisplayGeometry,
  type DisplaySideContourReserves,
} from "./responsive.ts";
import { useRouteActive } from "./route.tsx";
import { HostBridgeAbiError, type HostEvent } from "./host.ts";
import { useAnimatedNumber } from "./mobile.tsx";

/**
 * Safe-area aware guest shell for standalone pages.
 *
 * The host reports the logical safe area through the existing
 * `display.viewport` event.  Keep the canvas/background edge-to-edge, then
 * consume the edge insets exactly once around the app bar and body.  A
 * bottom-bar slot is intentionally excluded from the parent bottom padding:
 * `NavigationBar` owns its own home-indicator inset, matching the retained
 * parent's edge-to-edge bar contract.
 *
 * `MobileScaffold` remains the no-inset composition primitive used by pages
 * already nested below the showcase `Screen`.  This separate entry point is
 * for independent guests (for example the profile and lobby apps), where
 * there is no parent `Screen` to consume the host inset.
 */
export interface SafeAreaScaffoldProps {
  children?: JSX.Element;
  appBar?: SafeAreaSlot;
  bottomBar?: SafeAreaSlot;
  /** Full-viewport canvas class; the background must remain edge-to-edge. */
  class?: string;
  /** Insets to consume; `all` is for an independent guest, `top` for a root shell. */
  edges?: SafeAreaEdges;
  /** Reuse an existing display signal when the parent already owns geometry. */
  geometry?: DisplayGeometry | (() => DisplayGeometry);
  /** Reserve the host's top-right action hit area without shrinking the canvas. */
  reservedActions?: SafeAreaReservedActions;
}

export type SafeAreaEdge = "top" | "right" | "bottom" | "left";
export type SafeAreaEdges = "all" | "none" | readonly SafeAreaEdge[];
export type SafeAreaSlot = JSX.Element | (() => JSX.Element);
export type SafeAreaReservedActions = "none" | "mini-app" | number;
export const MINI_APP_HOST_ACTION_RESERVE = 60;

export interface SafeAreaScaffoldContextValue {
  hasScaffold: boolean;
  reservedActions: number;
  geometry: () => DisplayGeometry;
  /** Local right reserve for a top body band under status icons. */
  topRightContentReserve: () => number;
  /** Progressive right reserve for an arbitrary vertical band `[visualTop, visualBottom]`. */
  topRightReserveForBand: (visualTop: number, visualBottom: number, rampPx?: number, itemRight?: number) => number;
  /** Progressive `{ left, right }` reserves for an arbitrary vertical band `[visualTop, visualBottom]`. */
  sideReservesForBand: (
    visualTop: number,
    visualBottom: number,
    rampPx?: number,
    itemLeft?: number,
    itemRight?: number,
  ) => DisplaySideContourReserves;
}

export const SafeAreaScaffoldContext = createContext<SafeAreaScaffoldContextValue>({
  hasScaffold: false,
  reservedActions: 0,
  geometry: () => EMPTY_DISPLAY_GEOMETRY,
  topRightContentReserve: () => 0,
  topRightReserveForBand: () => 0,
  sideReservesForBand: () => ({ left: 0, right: 0 }),
});

export const ContourConsumedContext = createContext<() => boolean>(() => false);

export interface ScrollablePageContextValue {
  scrollOffset: () => number;
  geometry: () => DisplayGeometry;
  subscribeContour: (sync: () => boolean) => () => void;
  /** Existing painted control geometry, shared with native editor overlays. */
  visualRect?: (node: NodeMirror, fallback?: TextInputRect) => TextInputRect | undefined;
  /** Visible page bounds for overlays such as explicit accessibility nodes. */
  clipRect?: () => TextInputRect | undefined;
  /** Keep an input inside this page's visible clip before opening the IME. */
  ensureVisible?: (node: NodeMirror, fallback?: TextInputRect) => void;
  /** iOS-style nested scroll chaining: forward unconsumed vertical drag delta to parent page. */
  chainDrag?: (deltaY: number) => void;
  /** Complete a chained nested drag with release velocity (or 0 on cancel). */
  chainEndDrag?: (velocityY: number) => void;
}

export const ScrollablePageContext = createContext<ScrollablePageContextValue | undefined>(undefined);

function reservedActionWidth(value: SafeAreaReservedActions | undefined): number {
  if (value === "mini-app") return MINI_APP_HOST_ACTION_RESERVE;
  if (value === "none" || value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function SafeAreaScaffold(props: SafeAreaScaffoldProps): JSX.Element {
  const parentScaffold = useContext(SafeAreaScaffoldContext);
  const edges = props.edges ?? "all";
  // A nested no-inset adapter does not need a display subscription at all;
  // this is the ablation that keeps the Showcase's existing root signal the
  // only geometry owner for those pages while preserving parent contour context.
  const ownedGeometry = props.geometry === undefined && edges !== "none"
    ? createDisplayGeometry()
    : undefined;
  const geometry = (): DisplayGeometry => typeof props.geometry === "function"
    ? props.geometry()
    : props.geometry
      ?? ownedGeometry?.()
      ?? (parentScaffold.hasScaffold ? parentScaffold.geometry() : EMPTY_DISPLAY_GEOMETRY);
  const reservedActions = props.reservedActions !== undefined
    ? reservedActionWidth(props.reservedActions)
    : parentScaffold.reservedActions;
  const consumesLeft = edges === "all" || (edges !== "none" && edges.includes("left"));
  const consumesRight = edges === "all" || (edges !== "none" && edges.includes("right"));
  const bodyLeftInset = (): number => {
    if (!consumesLeft) return 0;
    const current = geometry();
    if (hasLocalLeftOcclusionInset(current)) return 0;
    return pageInsets(current).left;
  };
  const bodyRightInset = (): number => {
    if (!consumesRight) return 0;
    const current = geometry();
    if (hasLocalRightOcclusionInset(current)) return 0;
    return pageInsets(current).right;
  };
  const sideReservesForBand = (
    visualTop: number,
    visualBottom: number,
    rampPx?: number,
    itemLeft?: number,
    itemRight?: number,
  ): DisplaySideContourReserves => {
    if (edges === "none" && props.geometry === undefined) {
      return parentScaffold.sideReservesForBand(visualTop, visualBottom, rampPx, itemLeft, itemRight);
    }
    const current = geometry();
    const raw = sideContourReservesForBand(current, visualTop, visualBottom, {
      itemLeft,
      itemRight,
      rampPx,
    });
    return {
      left: itemLeft !== undefined ? raw.left : Math.max(0, raw.left - bodyLeftInset()),
      right: itemRight !== undefined ? raw.right : Math.max(0, raw.right - bodyRightInset()),
    };
  };
  const topRightReserveForBand = (
    visualTop: number,
    visualBottom: number,
    rampPx?: number,
    itemRight?: number,
  ): number => sideReservesForBand(visualTop, visualBottom, rampPx, undefined, itemRight).right;
  const topRightContentReserve = (): number => {
    if (edges === "none" && props.geometry === undefined) {
      return parentScaffold.topRightContentReserve();
    }
    return topRightReserveForBand(0, 56, 0);
  };

  return (
    <SafeAreaScaffoldContext.Provider value={{
      hasScaffold: true,
      reservedActions,
      geometry,
      topRightContentReserve,
      topRightReserveForBand,
      sideReservesForBand,
    }}>
      <SafeAreaScaffoldBody {...props} edges={edges} geometry={geometry} />
    </SafeAreaScaffoldContext.Provider>
  );
}

function SafeAreaScaffoldBody(props: SafeAreaScaffoldProps & {
  edges: SafeAreaEdges;
  geometry: () => DisplayGeometry;
}): JSX.Element {
  const insets = () => pageInsets(props.geometry());
  // Resolve slots inside the provider-owned body. A getter-backed app-bar
  // (`appBar={() => <MobileAppBar ... />}`) therefore sees the host-action
  // reservation and contour-consumed context instead of materializing against
  // the default context before SafeAreaScaffold mounts.
  const resolveSlot = (slot: SafeAreaSlot | undefined): JSX.Element | undefined =>
    typeof slot === "function" ? slot() : slot;
  const resolvedChildren = resolveChildren(() => resolveSlot(props.children));
  const resolvedBottomBar = resolveChildren(() => resolveSlot(props.bottomBar));
  const bottomBar = resolvedBottomBar();
  const hasAppBar = props.appBar !== undefined && props.appBar !== null;
  const hasBottomBar = bottomBar !== undefined && bottomBar !== null;
  const intrinsic = props.edges === "none";
  const canvasClass = () => props.class ?? (intrinsic
    ? "flex-col w-full bg-[#FAFAFA]"
    : "flex-col w-full h-full bg-[#FAFAFA]");
  const consumes = (edge: SafeAreaEdge): boolean =>
    props.edges === "all" || (props.edges !== "none" && props.edges.includes(edge));
  const bodyLeftInset = () => {
    if (!consumes("left")) return 0;
    const current = props.geometry();
    if (hasLocalLeftOcclusionInset(current)) return 0;
    return insets().left;
  };
  const bodyRightInset = () => {
    if (!consumes("right")) return 0;
    const current = props.geometry();
    // Release a local side/corner occlusion from full-height page padding
    // so content outside the cutout band remains full-width while contour-aware
    // headers and scroll items narrow locally inside the cutout band.
    if (hasLocalRightOcclusionInset(current)) return 0;
    return insets().right;
  };
  const appBarLeadingReserve = () => {
    if (intrinsic || !hasAppBar) return 0;
    const current = props.geometry();
    const padding = pageInsets(current);
    const appBarTop = consumes("top") ? padding.top : 0;
    return Math.max(
      0,
      sideContourReservesForBand(current, appBarTop, appBarTop + 56, { rampPx: 0 }).left - bodyLeftInset(),
    );
  };
  const appBarTrailingReserve = () => {
    if (intrinsic || !hasAppBar) return 0;
    const current = props.geometry();
    const padding = pageInsets(current);
    const existingReserve = reservedActionWidth(props.reservedActions);
    const appBarTop = consumes("top") ? padding.top : 0;
    const contour = topRightOcclusionFrame(current);
    if (existingReserve <= 0) {
      return Math.max(
        0,
        topRightContourReserveForBand(current, appBarTop, appBarTop + 56, { rampPx: 0 }) - bodyRightInset(),
      );
    }
    // Measure only the existing trailing action band in the 56px app-bar.
    // A local Duo corner obstruction adds the missing reserve; body and
    // full-width top layout remain unchanged. Global safeArea.right is already
    // in `bodyRightInset`, so this cannot add the same inset twice.
    const target = {
      left: current.width - bodyRightInset() - existingReserve,
      top: appBarTop,
      width: existingReserve,
      height: 56,
    };
    const local = avoidDisplayOcclusions(current, target, { prefer: "horizontal" });
    // The close target may itself move left. Keep the app-bar content clear
    // of that translated target, not merely clear of the original corner;
    // the existing host-action reserve remains in MobileAppBar.
    return Math.max(0, -local.offsetX) + (contour && bodyRightInset() === 0 ? DISPLAY_UI_SAFETY_GAP : 0);
  };

  // Preserve the retained MobileScaffold contract for nested pages: its
  // children were direct siblings in a grow-only canvas, so a ScrollablePage
  // could measure its intrinsic content. The bounded body wrapper below is
  // only for an independent/root safe-area owner.
  if (intrinsic) {
    return (
      <View class="flex-col w-full" style={{ grow: 1 }}>
        <View class={canvasClass()} style={{ grow: 1 }}>
          {hasAppBar ? resolveSlot(props.appBar) : null}
          {resolvedChildren()}
          {hasBottomBar ? bottomBar : null}
        </View>
      </View>
    );
  }

  return (
    <View class="flex-col w-full h-full" style={{ grow: 1 }}>
      <View
        class={canvasClass()}
        style={{
          grow: 1,
          paddingL: bodyLeftInset(),
          paddingR: bodyRightInset(),
        }}
      >
        {hasAppBar ? (
          <ContourConsumedContext.Provider value={() => true}>
            <View style={{
              paddingT: consumes("top") ? insets().top : 0,
              paddingL: appBarLeadingReserve(),
              paddingR: appBarTrailingReserve(),
            }}>{resolveSlot(props.appBar)}</View>
          </ContourConsumedContext.Provider>
        ) : null}
        <View
          class="flex-1 flex-col w-full overflow-hidden"
          style={{
            paddingT: hasAppBar || !consumes("top") ? 0 : insets().top,
            // A bottom tab bar is already safe-area aware. Without one,
            // keep the scroll viewport above the home indicator.
            paddingB: hasBottomBar || !consumes("bottom") ? 0 : insets().bottom,
          }}
        >
          {resolvedChildren()}
        </View>
        {bottomBar}
      </View>
    </View>
  );
}

function baseMarginLeft(className: string | undefined, explicit?: number | string): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!className) return 0;
  let result = 0;
  for (const token of className.split(/\s+/)) {
    const match = /^(?:m|mx|ml)-(?:\[(\d+(?:\.\d+)?)\]|(\d+(?:\.\d+)?))$/.exec(token);
    if (!match) continue;
    result = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 4;
  }
  return result;
}

function baseMarginRight(className: string | undefined, explicit?: number | string): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!className) return 0;
  let result = 0;
  for (const token of className.split(/\s+/)) {
    const match = /^(?:m|mx|mr)-(?:\[(\d+(?:\.\d+)?)\]|(\d+(?:\.\d+)?))$/.exec(token);
    if (!match) continue;
    result = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 4;
  }
  return result;
}

function basePaddingLeft(className: string | undefined, explicit?: number | string): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!className) return 0;
  let result = 0;
  for (const token of className.split(/\s+/)) {
    const match = /^(?:p|px|pl)-(?:\[(\d+(?:\.\d+)?)\]|(\d+(?:\.\d+)?))$/.exec(token);
    if (!match) continue;
    result = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 4;
  }
  return result;
}

function basePaddingRight(className: string | undefined, explicit?: number | string): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!className) return 0;
  let result = 0;
  for (const token of className.split(/\s+/)) {
    const match = /^(?:p|px|pr)-(?:\[(\d+(?:\.\d+)?)\]|(\d+(?:\.\d+)?))$/.exec(token);
    if (!match) continue;
    result = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 4;
  }
  return result;
}

function assignViewRef(ref: ViewProps["ref"], current: NodeMirror): void {
  if (!ref) return;
  if (typeof ref === "function") ref(current);
  else if (typeof ref === "object" && "current" in ref) ref.current = current;
}

function baseOverflow(className: string | undefined, explicit?: number | string): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!className) return 0;
  return /(?:^|\s)overflow-hidden(?:\s|$)/.test(className) ? 1 : 0;
}

function hasFullWidth(className: string | undefined, explicit?: number | string): boolean {
  if (typeof explicit === "number" && explicit < 0) return true;
  if (!className) return false;
  return /(?:^|\s)w-full(?:\s|$)/.test(className);
}

export interface ScrollContourOptions {
  baseLeft?: number;
  baseRight?: number;
  defaultInBand?: boolean;
  enabled?: boolean | (() => boolean);
  itemLeft?: number | (() => number | undefined);
  itemRight?: number | (() => number | undefined);
  mode?: "margin" | "padding";
  rampPx?: number;
}

export function useScrollContourReserve(options: ScrollContourOptions = {}): {
  leftReserve: Accessor<number>;
  nodeRef: (current: NodeMirror | undefined) => void;
  reserve: Accessor<number>;
  reserves: Accessor<DisplaySideContourReserves>;
  syncLayout: () => boolean;
} {
  const scaffold = useContext(SafeAreaScaffoldContext);
  const scrollPage = useContext(ScrollablePageContext);
  let node: NodeMirror | undefined;
  let lastCommitted: TextInputRect | undefined;
  let currentLeftReserve = 0;
  let currentRightReserve = 0;
  const [leftReserve, setLeftReserve] = createSignal(0);
  const [reserve, setReserve] = createSignal(0);
  const reserves = (): DisplaySideContourReserves => ({
    left: leftReserve(),
    right: reserve(),
  });
  const isEnabled = (): boolean =>
    options.enabled === undefined
      ? true
      : typeof options.enabled === "function"
        ? options.enabled()
        : options.enabled;
  const activeGeometry = (): DisplayGeometry =>
    scaffold.hasScaffold
      ? scaffold.geometry()
      : scrollPage
        ? scrollPage.geometry()
        : EMPTY_DISPLAY_GEOMETRY;

  const computeForBand = (
    visualTop: number,
    visualBottom: number,
    itemLeft?: number,
    itemRight?: number,
  ): DisplaySideContourReserves => {
    if (scaffold.hasScaffold) {
      return scaffold.sideReservesForBand(visualTop, visualBottom, options.rampPx, itemLeft, itemRight);
    }
    if (scrollPage) {
      return sideContourReservesForBand(scrollPage.geometry(), visualTop, visualBottom, {
        itemLeft,
        itemRight,
        rampPx: options.rampPx,
      });
    }
    return { left: 0, right: 0 };
  };

  const computeNextReserves = (): DisplaySideContourReserves => {
    if (!isEnabled()) return { left: 0, right: 0 };
    const currentGeometry = activeGeometry();
    if (
      leftOcclusionFrames(currentGeometry).length === 0
      && rightOcclusionFrames(currentGeometry).length === 0
    ) {
      return { left: 0, right: 0 };
    }
    const mode = options.mode ?? "margin";
    const baseLeft = options.baseLeft ?? 0;
    const baseRight = options.baseRight ?? 0;
    const explicitItemLeft = typeof options.itemLeft === "function"
      ? options.itemLeft()
      : options.itemLeft;
    const explicitItemRight = typeof options.itemRight === "function"
      ? options.itemRight()
      : options.itemRight;
    const measured = committedLayout(node, true);
    if (measured) lastCommitted = measured;
    const layout = measured ?? lastCommitted;
    if (!layout) {
      if (!options.defaultInBand) return { left: 0, right: 0 };
      const fallbackLeft = explicitItemLeft !== undefined ? explicitItemLeft : baseLeft;
      const fallbackRight = explicitItemRight !== undefined
        ? explicitItemRight
        : currentGeometry.width > 0
          ? Math.max(0, currentGeometry.width - baseRight)
          : undefined;
      return computeForBand(0, 56, fallbackLeft, fallbackRight);
    }
    const offset = scrollPage ? scrollPage.scrollOffset() : 0;
    const visualTop = layout.y - offset;
    const visualBottom = visualTop + layout.height;
    const itemLeft = explicitItemLeft !== undefined
      ? explicitItemLeft
      : Math.max(0, layout.x - (mode === "margin" ? currentLeftReserve : -baseLeft));
    const itemRight = explicitItemRight !== undefined
      ? explicitItemRight
      : layout.width > 0
        ? Math.min(
            currentGeometry.width,
            Math.max(
              0,
              layout.x + layout.width + (mode === "margin" ? currentRightReserve : -baseRight),
            ),
          )
        : undefined;
    return computeForBand(visualTop, visualBottom, itemLeft, itemRight);
  };

  const syncLayout = (): boolean => {
    const next = computeNextReserves();
    let changed = false;
    if (Math.abs(next.left - currentLeftReserve) >= 0.25) {
      currentLeftReserve = next.left;
      setLeftReserve(next.left);
      changed = true;
    }
    if (Math.abs(next.right - currentRightReserve) >= 0.25) {
      currentRightReserve = next.right;
      setReserve(next.right);
      changed = true;
    }
    return changed;
  };

  createEffect(() => {
    activeGeometry();
    isEnabled();
    if (typeof options.itemLeft === "function") options.itemLeft();
    if (typeof options.itemRight === "function") options.itemRight();
    syncLayout();
  });

  if (scrollPage) {
    const unsubscribe = scrollPage.subscribeContour(syncLayout);
    onCleanup(unsubscribe);
  } else {
    onFrame(() => {
      syncLayout();
    }, { continuous: false });
  }

  return {
    leftReserve,
    nodeRef: (current) => {
      node = current;
      if (current) syncLayout();
    },
    reserve,
    reserves,
    syncLayout,
  };
}

export function ScrollContourItem(props: ViewProps & {
  mode?: "margin" | "padding";
  defaultInBand?: boolean;
  enabled?: boolean | (() => boolean);
  rampPx?: number;
  consumeChildren?: boolean;
}): JSX.Element {
  const parentConsumed = useContext(ContourConsumedContext);
  const isEnabled = (): boolean => {
    if (parentConsumed()) return false;
    return props.enabled === undefined
      ? true
      : typeof props.enabled === "function"
        ? props.enabled()
        : props.enabled;
  };
  const mode = props.mode ?? "margin";
  const baseLeft = mode === "padding"
    ? basePaddingLeft(props.class, props.style?.paddingL)
    : baseMarginLeft(props.class, props.style?.marginL);
  const baseRight = mode === "padding"
    ? basePaddingRight(props.class, props.style?.paddingR)
    : baseMarginRight(props.class, props.style?.marginR);
  const { leftReserve, nodeRef, reserve } = useScrollContourReserve({
    baseLeft,
    baseRight,
    defaultInBand: props.defaultInBand,
    enabled: isEnabled,
    mode,
    rampPx: props.rampPx,
  });
  let appliedLeftNonZero = false;
  let appliedRightNonZero = false;
  const contourStyle = (): ViewProps["style"] => {
    const l = leftReserve();
    const r = reserve();
    if (l > 0) appliedLeftNonZero = true;
    if (r > 0) appliedRightNonZero = true;
    if (mode === "padding") {
      const basePadL = basePaddingLeft(props.class, props.style?.paddingL);
      const basePadR = basePaddingRight(props.class, props.style?.paddingR);
      const hasLeft = l > 0 || appliedLeftNonZero || props.style?.paddingL !== undefined;
      const hasRight = r > 0 || appliedRightNonZero || props.style?.paddingR !== undefined;
      if (!hasLeft && !hasRight) return props.style;
      return {
        ...(props.style ?? {}),
        ...(hasLeft ? { paddingL: basePadL + l } : {}),
        ...(hasRight ? { paddingR: basePadR + r } : {}),
      };
    }
    const baseMarL = baseMarginLeft(props.class, props.style?.marginL);
    const baseMarR = baseMarginRight(props.class, props.style?.marginR);
    const defaultOverflow = baseOverflow(props.class, props.style?.overflow);
    const hasLeft = l > 0 || appliedLeftNonZero || props.style?.marginL !== undefined;
    const hasRight = r > 0 || appliedRightNonZero || props.style?.marginR !== undefined;
    if (!hasLeft && !hasRight) {
      return props.style;
    }
    const explicitWidth = props.style?.width;
    const isFullWidth = hasFullWidth(props.class, explicitWidth);
    const adjustedWidth = typeof explicitWidth === "number" && Number.isFinite(explicitWidth) && explicitWidth > 0
      ? Math.max(0, explicitWidth - l - r)
      : isFullWidth
        ? (l > 0 || r > 0 ? Number.NaN : (explicitWidth ?? -1))
        : explicitWidth;
    return {
      ...(props.style ?? {}),
      ...(adjustedWidth !== undefined ? { width: adjustedWidth } : {}),
      ...(hasLeft ? { marginL: baseMarL + l } : {}),
      ...(hasRight ? { marginR: baseMarR + r } : {}),
      overflow: l > 0 || r > 0 ? 1 : defaultOverflow,
    };
  };
  return (
    <ContourConsumedContext.Provider value={() => parentConsumed() || (props.consumeChildren !== false && isEnabled())}>
      <View
        ref={(current) => {
          nodeRef(current);
          assignViewRef(props.ref, current);
        }}
        nodeRef={props.nodeRef}
        class={props.class}
        style={contourStyle()}
        onPress={props.onPress}
        focusable={props.focusable}
        debugName={props.debugName}
      >
        {props.children}
      </View>
    </ContourConsumedContext.Provider>
  );
}

export interface HeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  badge?: string;
}

export function Header(props: HeaderProps): JSX.Element {
  return (
    <ScrollContourItem mode="padding" defaultInBand class="flex-row items-center justify-between h-[56] px-4 bg-white border-[#E5E9F2]">
      <View class="flex-col justify-center gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
        {props.eyebrow ? <Text class="text-xs text-[#7C8799] font-bold">{props.eyebrow}</Text> : null}
        <Text class="text-base text-[#17233B] font-bold">{props.title}</Text>
      </View>
      {props.badge ? <Badge tone="cyan">{props.badge}</Badge> : null}
    </ScrollContourItem>
  );
}

export function PageIntro(props: { title: string; body: string }): JSX.Element {
  return (
    <ScrollContourItem defaultInBand class="flex-col gap-1 px-4 pt-4 pb-2 overflow-hidden">
      <Text class="text-xl text-[#17233B] font-bold">{props.title}</Text>
      <Text class="text-sm text-[#7C8799]">{props.body}</Text>
    </ScrollContourItem>
  );
}

export function SectionHeading(props: { title: string; detail?: string; dark?: boolean }): JSX.Element {
  return (
    <ScrollContourItem class="flex-row items-center justify-between px-4 pt-4 pb-2 overflow-hidden">
      <Text class={props.dark ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text>
      {props.detail ? <Text class={props.dark ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
    </ScrollContourItem>
  );
}

export interface ActionButtonProps extends ViewProps {
  /** Text for the stock button content. Custom children may replace it. */
  label?: string;
  kind?: "primary" | "secondary" | "quiet" | "danger";
  onPress?: () => void;
  icon?: string;
  disabled?: boolean;
}

export function ActionButton(props: ActionButtonProps): JSX.Element {
  const resolvedChildren = resolveChildren(() => props.children);
  const stockContent = () => props.icon ? (
    <View class="flex-col items-center justify-center gap-1">
      <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-sm text-[#315DEB] font-bold" : "text-sm text-white font-bold"}>{props.icon}</Text>
      <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-xs text-[#17233B] font-bold" : "text-xs text-white font-bold"}>{props.label ?? ""}</Text>
    </View>
  ) : (
    <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-sm text-[#315DEB] font-bold" : "text-sm text-white font-bold"}>
      {props.label ?? ""}
    </Text>
  );
  return (
    <Focusable
      class={props.class ?? (props.kind === "secondary"
        ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF] active:bg-[#C9D6FF] transition-colors duration-150 ease-out"
        : props.kind === "quiet"
          ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#EEF1F6] focus:bg-[#E4E9F2] active:bg-[#D7DDE8] transition-colors duration-150 ease-out"
          : props.kind === "danger"
            ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238] active:bg-[#7F1D2D] transition-colors duration-150 ease-out"
            : "px-4 h-[44] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5] active:bg-[#1E3A8A] transition-colors duration-150 ease-out")}
      style={props.disabled
        ? { ...(props.style ?? {}), opacity: props.style?.opacity ?? 0.5 }
        : { ...(props.style ?? {}), opacity: props.style?.opacity ?? 1 }}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      {resolvedChildren() ?? stockContent()}
    </Focusable>
  );
}

// Public vocabulary alias; there is still only one button implementation.
export const Button = ActionButton;

export function Badge(props: { children?: JSX.Element; tone?: "cyan" | "green" | "amber" | "rose" }): JSX.Element {
  return (
    <View class={props.tone === "green"
      ? "px-2 py-1 rounded-xl bg-[#E5F7EE]"
      : props.tone === "amber"
        ? "px-2 py-1 rounded-xl bg-[#FFF4DD]"
        : props.tone === "rose"
          ? "px-2 py-1 rounded-xl bg-[#FDECEF]"
          : "px-2 py-1 rounded-xl bg-[#E8EDFF]"}>
      <Text class={props.tone === "green"
        ? "text-xs text-[#147A52] font-bold"
        : props.tone === "amber"
          ? "text-xs text-[#936211] font-bold"
          : props.tone === "rose"
            ? "text-xs text-[#B4233A] font-bold"
            : "text-xs text-[#315DEB] font-bold"}>{props.children}</Text>
    </View>
  );
}

export function EmptyState(props: { title: string; body: string; action?: JSX.Element }): JSX.Element {
  return (
    <ScrollContourItem class="flex-col items-center gap-2 p-4 rounded-xl bg-[#F1F3F8] border-[#E5E9F2]">
      <Text class="text-sm text-[#17233B] font-bold">{props.title}</Text>
      <Text class="text-xs text-[#7C8799]">{props.body}</Text>
      {props.action}
    </ScrollContourItem>
  );
}

export function MetricCard(props: { label: string; value: string; detail?: string; tone?: "blue" | "purple" | "green" }): JSX.Element {
  return (
    <View class={props.tone === "purple"
      ? "flex-1 flex-col gap-1 p-3 rounded-xl bg-[#F3EEFF] border-[#E5E9F2]"
      : props.tone === "green"
        ? "flex-1 flex-col gap-1 p-3 rounded-xl bg-[#E9F8F0] border-[#E5E9F2]"
        : "flex-1 flex-col gap-1 p-3 rounded-xl bg-[#EEF2FF] border-[#E5E9F2]"}>
      <Text class="text-xs text-[#7C8799]">{props.label}</Text>
      <Text class="text-xl text-[#17233B] font-bold">{props.value}</Text>
      {props.detail ? <Text class="text-xs text-[#7C8799]">{props.detail}</Text> : null}
    </View>
  );
}

export function StatusBar(props: { label: string; detail: string; ok?: boolean }): JSX.Element {
  return (
    <ScrollContourItem
      defaultInBand
      class="flex-row items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#17233B] border-[#30405A] overflow-hidden"
    >
      <View class="flex-row items-center gap-2 flex-1 overflow-hidden" style={{ minW: 0, shrink: 1 }}>
        <View class={props.ok === false ? "w-2 h-2 rounded-full bg-rose-500" : "w-2 h-2 rounded-full bg-emerald-500"} />
        <Text class="text-xs text-white font-bold">{props.label}</Text>
      </View>
      <Text class="flex-1 text-xs text-[#B9C5D8] overflow-hidden" style={{ minW: 0, shrink: 1 }}>{props.detail}</Text>
    </ScrollContourItem>
  );
}

export type NavigationRoute = "home" | "gallery" | "about" | "settings";

export interface NavigationItem {
  /** String keeps NavigationBar reusable for local segmented routes. */
  id: string;
  label: string;
  kind: "home" | "gallery" | "host" | "settings";
}

export interface NavigationBarProps {
  route: string;
  onNavigate: (route: NavigationRoute) => void;
  wide?: boolean | (() => boolean);
  geometry?: DisplayGeometry | (() => DisplayGeometry);
  /** Hide the complete bar, including its home-indicator inset, when false. */
  visible?: boolean;
  /** Optional replacement for the backwards-compatible Home/Gallery/Host set. */
  items?: readonly NavigationItem[];
  /** Use the dark shell colours for a page with a dark surface. */
  dark?: boolean;
  /** Optional ARGB accent rendered as the active icon/text colour. */
  accentColor?: number;
  /** Optional surface rendered behind the controls (for example GlassSurface). */
  background?: JSX.Element | (() => JSX.Element);
  /** Keep the same safe-area and icon logic while using a floating capsule shell. */
  floating?: boolean;
  /** Handle local string tabs without introducing a second navigation component. */
  onItemPress?: (id: string) => void;
  /** Draw and animate the shared active selection capsule. */
  selectionIndicator?: boolean;
  /** Optional content inside the shared active selection capsule. */
  indicator?: JSX.Element | (() => JSX.Element);
  /** Optional semantic node ref for each existing tab Focusable. */
  nodeRefForItem?: (item: NavigationItem) => ViewProps["nodeRef"];
  /** Reuse the actual capsule subtree for shared material interactions. */
  trackNodeRef?: ViewProps["nodeRef"];
  /** An optical selection lens samples the already painted icons. */
  selectionOverlay?: JSX.Element | (() => JSX.Element);
}

/**
 * Navigation icons are deliberately composed from host primitives instead of
 * Unicode glyphs. The bundled font is a text font and does not guarantee the
 * miscellaneous-symbol code points used by the old tab bar; on a target with
 * no fallback font those code points rendered as empty boxes. These small
 * geometric marks are therefore stable across Flutter, WeChat and native
 * probe hosts and inherit the selected-tab colour through one explicit style.
 */
function NavigationIcon(props: { kind: NavigationItem["kind"]; active: boolean; dark?: boolean; accentColor?: string; surfaceColor?: string }): JSX.Element {
  const color = () => props.active
    ? props.accentColor ?? (props.dark ? "#A8BEFF" : "#315DEB")
    : props.dark ? "#A9B7CF" : "#7C8799";
  if (props.kind === "home") {
    return (
      <View class="relative w-[20] h-[20]">
        <View class="absolute left-[4] top-[8] w-[12] h-[9] rounded-sm" style={{ bgColor: color() }} />
        <View class="absolute left-[5] top-[3] w-[10] h-[10] rounded-sm" style={{ bgColor: color(), rotate: 45 }} />
        <View class="absolute left-[8] top-[10] w-[4] h-[7] rounded-sm" style={{ bgColor: props.surfaceColor ?? "#FFFFFF" }} />
      </View>
    );
  }
  if (props.kind === "gallery") {
    return (
      <View class="flex-col gap-[2] w-[20] h-[20] items-center justify-center">
        <View class="flex-row gap-[2]">
          <View class="w-[6] h-[6] rounded-sm" style={{ bgColor: color() }} />
          <View class="w-[6] h-[6] rounded-sm" style={{ bgColor: color() }} />
        </View>
        <View class="flex-row gap-[2]">
          <View class="w-[6] h-[6] rounded-sm" style={{ bgColor: color() }} />
          <View class="w-[6] h-[6] rounded-sm" style={{ bgColor: color() }} />
        </View>
      </View>
    );
  }
  if (props.kind === "settings") {
    return (
      <View class="relative w-[20] h-[20]">
        <View class="absolute left-[8] top-[1] w-[4] h-[18] rounded-sm" style={{ bgColor: color() }} />
        <View class="absolute left-[1] top-[8] w-[18] h-[4] rounded-sm" style={{ bgColor: color() }} />
        <View class="absolute left-[4] top-[4] w-[12] h-[12] rounded-sm" style={{ bgColor: color(), rotate: 45 }} />
      </View>
    );
  }
  return (
    <View class="flex-col gap-[3] w-[20] h-[20] items-center justify-center">
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
    </View>
  );
}

const defaultNavigationItems: readonly NavigationItem[] = [
  { id: "home", label: "Home", kind: "home" },
  // Keep the old Gallery route as the compatibility alias for the UI page.
  { id: "gallery", label: "Gallery", kind: "gallery" },
  { id: "about", label: "Host", kind: "host" },
];

function NavigationSelectionIndicator(props: {
  index: () => number;
  trackWidth: () => number;
  itemCount: () => number;
  trackNode: () => NodeMirror | undefined;
  floating: () => boolean;
  dark?: boolean;
  content?: JSX.Element | (() => JSX.Element);
}): JSX.Element {
  const routeActive = useRouteActive();
  const [measuredWidth, setMeasuredWidth] = createSignal<number>();
  // Use the committed native row, including when a standalone bar is placed
  // in a narrower container. This observes existing layout; it does not lay
  // out a second tree or keep the frame scheduler active.
  onFrame(() => {
    const width = committedLayout(props.trackNode())?.width;
    if (width !== undefined) setMeasuredWidth(width);
  }, { active: routeActive, continuous: false });
  const segmentWidth = () => Math.max(0, (measuredWidth() ?? props.trackWidth()) - 16) / props.itemCount();
  const indicatorX = useAnimatedNumber(
    () => props.index() * segmentWidth(),
    0.38,
  );
  const content = (): JSX.Element | undefined =>
    typeof props.content === "function" ? props.content() : props.content;
  return (
    <View
      class="absolute overflow-hidden"
      style={{
        posType: 1,
        insetT: 4,
        insetL: 12 + indicatorX(),
        width: Math.max(0, segmentWidth() - 8),
        height: props.floating() ? 50 : 46,
        radius: 999,
        bgColor: props.dark ? 0x2effffff : 0x88ffffff,
      }}
    >
      {content()}
    </View>
  );
}

export function NavigationBar(props: NavigationBarProps): JSX.Element {
  let trackNode: NodeMirror | undefined;
  const isFloating = () => props.floating === true;
  const resolveBackground = (): JSX.Element | undefined =>
    typeof props.background === "function" ? props.background() : props.background;
  const itemList = () => props.items ?? defaultNavigationItems;
  const itemIndex = () => {
    const index = itemList().findIndex((item) => item.id === props.route);
    return index >= 0 ? index : 0;
  };
  const itemCount = () => Math.max(1, itemList().length);
  const trackWidth = () => {
    const geometry = props.geometry
      ? (typeof props.geometry === "function" ? props.geometry() : props.geometry)
      : undefined;
    if (!geometry || geometry.width <= 0) return 360;
    const padding = bottomBarInsets(geometry);
    return Math.max(120, geometry.width - padding.left - padding.right - (isFloating() ? 24 : 0));
  };
  const navStyle = () => {
    const geometry = props.geometry
      ? (typeof props.geometry === "function" ? props.geometry() : props.geometry)
      : undefined;
    const padding = geometry
      ? bottomBarInsets(geometry)
      : { top: 0, right: 0, bottom: 0, left: 0 };
    // Let the children and bottom inset determine the outer extent. A fixed
    // 56px shell plus paddingB would put controls under the home indicator.
    return {
      paddingL: padding.left + (isFloating() ? 12 : 0),
      paddingR: padding.right + (isFloating() ? 12 : 0),
      paddingB: padding.bottom + (isFloating() ? 10 : 0),
      ...(isFloating() ? { paddingT: 8 } : {}),
    };
  };
  const hostRoute = () => (
    itemList().some((item) => item.id === "about")
    && props.route !== "home"
    && props.route !== "gallery"
    && props.route !== "settings"
  );
  const surface = () => props.dark ? "#09090B" : "#FFFFFF";
  const border = () => props.dark ? "#27272A" : "#E4E4E7";
  const muted = () => props.dark ? "#A1A1AA" : "#71717A";
  const accent = () => props.accentColor === undefined
    ? props.dark ? "#FAFAFA" : "#18181B"
    : `#${(props.accentColor & 0xFFFFFF).toString(16).padStart(6, "0")}`;
  return (
    <Show when={props.visible !== false}>
      <View
        style={{ ...navStyle(), ...(isFloating() ? {} : { bgColor: surface() }) }}
        class="relative flex-col w-full shrink-0"
      >
        <Show when={!isFloating()}>
          <View class="w-full h-[1]" style={{ bgColor: border() }} />
        </Show>
        <View
          nodeRef={(node) => { trackNode = node; assignViewRef(props.trackNodeRef, node); }}
          class={isFloating()
            ? "relative flex-row items-center w-full h-[58] px-2"
            : "relative flex-row items-center w-full h-[54] px-2"}
          style={isFloating() ? undefined : { bgColor: surface() }}
        >
          <Show when={props.background !== undefined}>
            <View class="absolute inset-0">{resolveBackground()}</View>
          </Show>
          <Show when={props.selectionIndicator === true || props.indicator !== undefined}>
            <NavigationSelectionIndicator
              index={itemIndex}
              trackWidth={trackWidth}
              itemCount={itemCount}
              trackNode={() => trackNode}
              floating={isFloating}
              dark={props.dark}
              content={props.indicator}
            />
          </Show>
          <For each={itemList()}>
            {(item) => {
              const nodeRef = props.nodeRefForItem?.(item);
              const active = () => props.route === item.id || (hostRoute() && item.id === "about");
              return (
                <Focusable
                  nodeRef={nodeRef}
                  class="flex-1 h-[52] flex-col items-center justify-center gap-1 bg-transparent"
                  onPress={() => props.onItemPress ? props.onItemPress(item.id) : props.onNavigate(item.id as NavigationRoute)}
                >
                  <View class="w-[24] h-[22] flex-col items-center justify-center bg-transparent">
                    <NavigationIcon kind={item.kind} active={active()} dark={props.dark} accentColor={active() ? accent() : undefined} surfaceColor={surface()} />
                  </View>
                  <Text
                    class={active()
                      ? "text-xs font-bold"
                      : props.dark ? "text-xs text-[#A1A1AA] font-bold" : "text-xs text-[#71717A] font-bold"}
                    style={{ textColor: active() ? accent() : muted() }}
                  >{item.label}</Text>
                </Focusable>
              );
            }}
          </For>
          {typeof props.selectionOverlay === "function" ? props.selectionOverlay() : props.selectionOverlay}
        </View>
      </View>
    </Show>
  );
}

export const TabBar = NavigationBar;
export const BottomNavigationBar = NavigationBar;

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs(props: { items: readonly TabItem[]; active: string; onChange: (id: string) => void }): JSX.Element {
  return (
    <ScrollContourItem mode="padding" defaultInBand class="flex-row flex-wrap gap-1 px-4 py-2 bg-transparent">
      <For each={props.items}>
        {(item) => (
          <Focusable
            class={props.active === item.id
              ? "w-[68] h-[44] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF] transition-colors duration-150 ease-out"
              : "w-[68] h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6] transition-colors duration-150 ease-out"}
            onPress={() => props.onChange(item.id)}
          >
            <Text class={props.active === item.id ? "text-sm text-[#315DEB] font-bold" : "text-sm text-[#7C8799] font-bold"}>{item.label}</Text>
          </Focusable>
        )}
      </For>
    </ScrollContourItem>
  );
}

/**
 * The guest-side text input contract is deliberately only a small shell:
 * Flutter owns the real TextField and system keyboard overlay.  The shell
 * supplies its committed layout rectangle and keeps the app draft as the
 * only value authority; it never paints a keyboard or keeps a second text
 * buffer.
 */
export interface TextInputParams {
  id?: string | number;
  editingSession?: string;
  revision?: number;
  jsRevision?: number;
  /** The page viewport that clips the guest-owned input shell. */
  clip?: TextInputRect | null;
  text?: string;
  selectionBase?: number;
  selectionExtent?: number;
  composingBase?: number;
  composingExtent?: number;
  force?: boolean;
  source?: string;
  [key: string]: unknown;
}

export function parseTextInputParams(params: TextInputParams): {
  id?: string;
  editingSession?: string;
  revision?: number;
  jsRevision?: number;
  text?: string;
  selectionBase?: number;
  selectionExtent?: number;
  composingBase?: number;
  composingExtent?: number;
} {
  return {
    id: params.id === undefined || params.id === null ? undefined : String(params.id),
    editingSession: typeof params.editingSession === "string" ? params.editingSession : undefined,
    revision: typeof params.revision === "number" && Number.isFinite(params.revision)
      ? Math.trunc(params.revision)
      : undefined,
    jsRevision: typeof params.jsRevision === "number" && Number.isFinite(params.jsRevision)
      ? Math.trunc(params.jsRevision)
      : undefined,
    text: typeof params.text === "string" ? params.text : undefined,
    selectionBase: finiteNumber(params.selectionBase),
    selectionExtent: finiteNumber(params.selectionExtent),
    composingBase: finiteNumber(params.composingBase),
    composingExtent: finiteNumber(params.composingExtent),
  };
}

interface TextInputRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextInputSession {
  id: string;
  isOpen: () => boolean;
  node: () => NodeMirror | undefined;
  visualRect: () => TextInputRect | undefined;
  refreshLayout: () => void;
  close: () => void;
  accepts: (params: TextInputParams) => boolean;
  onOpened: (params: TextInputParams) => boolean;
  onEdit: (params: TextInputParams) => void;
  onSubmit: (params: TextInputParams) => void;
  onClosed: (params: TextInputParams) => void;
}

/**
 * Appearance for the real Flutter editor overlay. The JS component remains
 * the source of truth for visual styling; Flutter only hosts EditableText so
 * the platform IME, selection and composing state stay native.
 *
 * Colors intentionally use six-digit CSS hex strings. PocketJS packs numeric
 * style colors as ABGR while Flutter's Color constructor uses ARGB, so a
 * numeric public color would not be a single-source value across the bridge.
 * The shell also has three baked font slots for this control; keeping the
 * size union finite makes the JS and Flutter editors select the same slot.
 */
export type InputFieldColor = `#${string}` | "transparent";

export interface InputFieldAppearance {
  textColor?: InputFieldColor;
  placeholderColor?: InputFieldColor;
  fillColor?: InputFieldColor;
  borderColor?: InputFieldColor;
  focusedBorderColor?: InputFieldColor;
  borderRadius?: number;
  fontSize?: 12 | 14 | 16;
  paddingHorizontal?: number;
  paddingVertical?: number;
}

const defaultInputFieldAppearance: Required<InputFieldAppearance> = {
  // Keep colours as CSS strings: the guest renderer's packed colour ABI is
  // ABGR, while the Flutter bridge accepts the same CSS spelling and converts
  // it to an ARGB Color. Passing raw integers here would swap red/blue in the
  // JS shell even though the Flutter overlay looked correct.
  textColor: "#09090B",
  placeholderColor: "#71717A",
  fillColor: "#ffffff",
  borderColor: "#E4E4E7",
  focusedBorderColor: "#18181B",
  borderRadius: 8,
  fontSize: 14,
  paddingHorizontal: 12,
  paddingVertical: 10,
};

function normalizeInputColor(
  value: InputFieldColor | undefined,
  fallback: InputFieldColor,
): InputFieldColor {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "transparent" || /^#[0-9a-f]{6}$/.test(normalized)
    ? normalized as InputFieldColor
    : fallback;
}

type TextInputPocket = {
  _emitValue?: (packet: Record<string, unknown>) => boolean;
  getLayout?: (id: number) => unknown;
};

const textInputGlobal = globalThis as typeof globalThis & {
  pocket?: TextInputPocket;
  ui?: { __viewport?: { w?: unknown; h?: unknown } };
};
let nextTextInputId = 1;
let activeTextInput: TextInputSession | undefined;

/** One event tap serves the active ScrollablePages in this guest realm. Pages
 * register only while their route is visible; the existing node tree and
 * viewport geometry select the target, so a wheel event never gets replayed
 * as pointer input or broadcast into each scroller. */
interface DesktopScrollPage {
  node: () => NodeMirror | undefined;
  active: () => boolean;
  rect: () => TextInputRect | undefined;
  applyDelta: (deltaY: number) => number;
  interrupt: () => void;
}

const activeDesktopScrollPages = new Set<DesktopScrollPage>();
let removeDesktopScrollEvents: (() => void) | undefined;
let trackpadScrollPage: DesktopScrollPage | null | undefined;

function nodeContainsId(root: NodeMirror, id: number): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.id === id) return true;
    for (const child of current.children) pending.push(child);
  }
  return false;
}

function nodeIsWithin(root: NodeMirror | undefined, node: NodeMirror | undefined): boolean {
  for (let current = node; current; current = current.parent ?? undefined) {
    if (current === root) return true;
  }
  return false;
}

function nodeDepth(node: NodeMirror): number {
  let depth = 0;
  for (let current: NodeMirror | null = node; current; current = current.parent) depth += 1;
  return depth;
}

function scrollPageAt(x: number, y: number): DesktopScrollPage | undefined {
  let hitId = 0;
  try {
    hitId = getOps().hitTestBounds?.(x, y) ?? 0;
  } catch {
    // Some injected/replay hosts do not expose bounds hit testing. The
    // retained viewport rectangles below are the existing fallback.
  }
  const candidates: Array<{ page: DesktopScrollPage; node: NodeMirror; area: number; depth: number }> = [];
  for (const page of activeDesktopScrollPages) {
    if (!page.active()) continue;
    const node = page.node();
    const rect = page.rect();
    if (!node || !rect || x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue;
    // When the host reports a target, accept only a ScrollablePage whose
    // native mirror owns that target. This lets an overlay or sibling page
    // win hit testing without making every visible page consume the delta.
    if (hitId > 0 && !nodeContainsId(node, hitId)) continue;
    candidates.push({ page, node, area: rect.width * rect.height, depth: nodeDepth(node) });
  }
  candidates.sort((a, b) => b.depth - a.depth || a.area - b.area);
  return candidates[0]?.page;
}

function parentDesktopScrollPage(page: DesktopScrollPage): DesktopScrollPage | undefined {
  const node = page.node();
  for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
    for (const candidate of activeDesktopScrollPages) {
      if (candidate !== page && candidate.active() && candidate.node() === ancestor) return candidate;
    }
  }
  return undefined;
}

function consumeDesktopScroll(page: DesktopScrollPage | undefined, deltaY: number): void {
  if (!page || !page.active() || deltaY === 0) return;
  const consumed = page.applyDelta(deltaY);
  const remainder = deltaY - consumed;
  // Reuse the existing node ancestry for nested scroll chaining. A child
  // consumes to its current bound first; only its unconsumed delta reaches
  // the nearest active ScrollablePage ancestor.
  if (Math.abs(remainder) > 0.01) consumeDesktopScroll(parentDesktopScrollPage(page), remainder);
}

function dispatchDesktopScroll(event: HostEvent): void {
  if (event.method !== "input.scroll") return;
  const params = event.params as Record<string, unknown>;
  const x = finiteNumber(params.x);
  const y = finiteNumber(params.y);
  const deltaY = finiteNumber(params.deltaY) ?? 0;
  const source = params.source;
  const phase = params.phase;
  if (x === undefined || y === undefined) return;

  if (source === "wheel") {
    if (phase !== "update") return;
    consumeDesktopScroll(scrollPageAt(x, y), deltaY);
    return;
  }
  if (source !== "trackpad") return;
  if (phase === "start") {
    trackpadScrollPage = scrollPageAt(x, y) ?? null;
    trackpadScrollPage?.interrupt();
    return;
  }
  if (phase === "end") {
    trackpadScrollPage = undefined;
    return;
  }
  if (phase !== "update") return;
  // Updates without a start are ignored. A start on empty space stores null
  // until end, so a moving trackpad cannot acquire a new page mid-gesture.
  if (trackpadScrollPage === undefined) return;
  if (trackpadScrollPage && !trackpadScrollPage.active()) trackpadScrollPage = null;
  const page = trackpadScrollPage ?? undefined;
  consumeDesktopScroll(page, deltaY);
}

function subscribeDesktopScrollEvents(): () => void {
  return subscribeHostEvents(dispatchDesktopScroll);
}

function registerDesktopScrollPage(page: DesktopScrollPage): () => void {
  activeDesktopScrollPages.add(page);
  if (!removeDesktopScrollEvents) removeDesktopScrollEvents = subscribeDesktopScrollEvents();
  return () => {
    activeDesktopScrollPages.delete(page);
    if (trackpadScrollPage === page) trackpadScrollPage = null;
    if (activeDesktopScrollPages.size === 0) {
      trackpadScrollPage = undefined;
      removeDesktopScrollEvents?.();
      removeDesktopScrollEvents = undefined;
    }
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function committedLayout(node: NodeMirror | undefined, allowZeroWidth = false): TextInputRect | undefined {
  const getLayout = textInputGlobal.pocket?.getLayout;
  if (!node || typeof getLayout !== "function") return undefined;
  try {
    const raw = getLayout(node.id);
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    const width = finiteNumber(record.width ?? record.w);
    const height = finiteNumber(record.height ?? record.h);
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
    if ((allowZeroWidth ? width < 0 : width <= 0) || height <= 0) return undefined;
    return { x, y, width, height };
  } catch {
    return undefined;
  }
}

function viewportLayout(node: NodeMirror | undefined): TextInputRect | undefined {
  // A zero-width viewport is a transient retained-layout state during Duo
  // pane/IME resize. Treat it as unavailable so measureViewport() can retain
  // the last pane geometry and apply its live-width cap. The content canvas
  // intentionally has a separate allowZeroWidth=true read below because its
  // height still determines the scroll extent while a pane is relaid out.
  const rect = committedLayout(node);
  if (!rect) return undefined;
  // During a live keyboard/Duo resize the retained layout tree can report the
  // previous clip height for one or more frames. The framework's canonical
  // `ui.__viewport` is already updated by resizeViewport; use it to cap the
  // visible page extent while retaining the committed canvas origin.
  const liveHeight = finiteNumber(textInputGlobal.ui?.__viewport?.h);
  if (liveHeight === undefined || liveHeight <= rect.y) return rect;
  return { ...rect, height: Math.max(1, Math.min(rect.height, liveHeight - rect.y)) };
}

function emitTextInput(method: string, params: TextInputParams): boolean {
  const emitValue = textInputGlobal.pocket?._emitValue;
  if (typeof emitValue !== "function") throw new HostBridgeAbiError();
  try {
    return emitValue({ type: "event", name: method, payload: params }) === true;
  } catch {
    return false;
  }
}

function offsetFrom(value: unknown, fallback: number, length: number): number {
  const number = finiteNumber(value);
  if (number === undefined) return fallback;
  if (number < 0) return -1;
  return Math.max(0, Math.min(length, Math.trunc(number)));
}

export function getActiveTextInputSession(): TextInputSession | undefined {
  return activeTextInput;
}

/** Deliver Flutter's edit/submit/close notifications to the mounted shell. */
export function deliverTextInputEvent(method: string, params: TextInputParams): boolean {
  if (
    method !== "textInput.edit" &&
    method !== "textInput.submit" &&
    method !== "textInput.opened" &&
    method !== "textInput.closed" &&
    method !== "textInput.dismiss" &&
    method !== "textInput.close"
  ) return false;
  const session = activeTextInput;
  if (!session) return false;
  const parsed = parseTextInputParams(params);
  const eventId = parsed.id;
  if (eventId === undefined || eventId !== session.id || !session.isOpen()) return false;
  // A mount ACK reports that the overlay attached, not a newer text value.
  // Let its handler validate the current session/route without rejecting it
  // for an older jsRevision; all value-bearing events keep the freshness gate.
  if (method !== "textInput.opened" && !session.accepts(params)) return false;
  switch (method) {
    case "textInput.opened":
      return session.onOpened(params);
    case "textInput.edit":
      session.onEdit(params);
      break;
    case "textInput.submit":
      session.onSubmit(params);
      break;
    default:
      session.onClosed(params);
      break;
  }
  return true;
}

export function InputField(props: {
  value: Accessor<string>;
  onInput: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  appearance?: InputFieldAppearance;
}): JSX.Element {
  const routeActive = useRouteActive();
  const scrollPage = useContext(ScrollablePageContext);
  const id = `guest-text-input-${nextTextInputId++}`;
  const [isFocused, setIsFocused] = createSignal(false);
  let node: NodeMirror | undefined;
  let opened = false;
  let openGeneration = 0;
  let editingSession = "";
  let lastNativeRevision = 0;
  let jsRevision = 0;
  let lastObservedText = props.value();
  let selectionBase = lastObservedText.length;
  let selectionExtent = lastObservedText.length;
  let composingBase = -1;
  let composingExtent = -1;
  let lastRect: TextInputRect | undefined;
  let lastClipRect: TextInputRect | undefined;
  let textLayoutDirty = false;
  const [overlayReady, setOverlayReady] = createSignal(false);
  const appearance = (): Required<InputFieldAppearance> => {
    const provided = props.appearance ?? {};
    const fontSize = provided.fontSize === 12 || provided.fontSize === 16
      ? provided.fontSize
      : 14;
    return {
      textColor: normalizeInputColor(provided.textColor, defaultInputFieldAppearance.textColor),
      placeholderColor: normalizeInputColor(provided.placeholderColor, defaultInputFieldAppearance.placeholderColor),
      fillColor: normalizeInputColor(provided.fillColor, defaultInputFieldAppearance.fillColor),
      borderColor: normalizeInputColor(provided.borderColor, defaultInputFieldAppearance.borderColor),
      focusedBorderColor: normalizeInputColor(provided.focusedBorderColor, defaultInputFieldAppearance.focusedBorderColor),
      borderRadius: typeof provided.borderRadius === "number" && Number.isFinite(provided.borderRadius)
        ? provided.borderRadius
        : defaultInputFieldAppearance.borderRadius,
      fontSize,
      paddingHorizontal: typeof provided.paddingHorizontal === "number" && Number.isFinite(provided.paddingHorizontal)
        ? provided.paddingHorizontal
        : defaultInputFieldAppearance.paddingHorizontal,
      paddingVertical: typeof provided.paddingVertical === "number" && Number.isFinite(provided.paddingVertical)
        ? provided.paddingVertical
        : defaultInputFieldAppearance.paddingVertical,
    };
  };
  const appearanceColorParams = (nativeTextVisible: boolean) => {
    const current = appearance();
    return {
      textColor: nativeTextVisible ? current.textColor : "transparent",
      placeholderColor: nativeTextVisible ? current.placeholderColor : "transparent",
      fillColor: nativeTextVisible ? current.fillColor : "transparent",
      borderColor: nativeTextVisible ? current.borderColor : "transparent",
      focusedBorderColor: nativeTextVisible ? current.focusedBorderColor : "transparent",
    };
  };
  const appearanceParams = (nativeTextVisible = overlayReady()): TextInputParams => {
    const current = appearance();
    // Keep Flutter's entire editable surface out of the Guest fallback until
    // the host confirms that its overlay is mounted. Transparent text alone
    // would still let TextField's default fill and border cover the Guest.
    return {
      ...current,
      ...appearanceColorParams(nativeTextVisible),
      placeholder: props.placeholder ?? "Tap to type",
    };
  };
  const shellStyle = () => {
    const current = appearance();
    const border = isFocused() ? current.focusedBorderColor : current.borderColor;
    return {
      width: -1,
      bgColor: current.fillColor === "transparent" ? 0 : current.fillColor,
      borderColor: border === "transparent" ? 0 : border,
      borderWidth: 1,
      radius: current.borderRadius,
      paddingL: current.paddingHorizontal,
      paddingR: current.paddingHorizontal,
      paddingT: current.paddingVertical,
      paddingB: current.paddingVertical,
    };
  };
  const shellTextStyle = () => ({
    textColor: props.value() ? appearance().textColor : appearance().placeholderColor,
  });

  const visualRect = (): TextInputRect | undefined => {
    const currentNode = node;
    return (currentNode ? scrollPage?.visualRect?.(currentNode, lastRect) : undefined)
      ?? committedLayout(currentNode)
      ?? lastRect;
  };

  const visualClip = (): TextInputRect | undefined =>
    scrollPage?.clipRect?.();

  const sameRect = (
    left: TextInputRect | undefined,
    right: TextInputRect | undefined,
  ): boolean => {
    if (left === undefined || right === undefined) return left === right;
    return left.x === right.x && left.y === right.y &&
      left.width === right.width && left.height === right.height;
  };

  const updateOffsets = (params: TextInputParams, text: string): void => {
    selectionBase = offsetFrom(params.selectionBase, selectionBase < 0 ? text.length : selectionBase, text.length);
    selectionExtent = offsetFrom(params.selectionExtent, selectionExtent < 0 ? text.length : selectionExtent, text.length);
    composingBase = offsetFrom(params.composingBase, composingBase, text.length);
    composingExtent = offsetFrom(params.composingExtent, composingExtent, text.length);
  };

  const applyIncomingText = (text: string): void => {
    lastObservedText = text;
    // Native echo can repeat the current draft. Avoid dispatching a second
    // reducer event in that case while still accepting selection metadata.
    if (text !== props.value()) {
      textLayoutDirty = true;
      props.onInput(text);
    }
  };

  const sendUpdate = (text: string): void => {
    const rect = visualRect();
    const clip = visualClip();
    if (!rect) return;
    jsRevision += 1;
    const sent = emitTextInput("textInput.update", {
      id,
      editingSession,
      revision: lastNativeRevision,
      jsRevision,
      // A changed controlled prop is an intentional JS command, not an echo.
      force: true,
      source: "js",
      rect,
      clip: clip ?? null,
      text,
      selectionBase,
      selectionExtent,
      composingBase,
      composingExtent,
      ...appearanceParams(),
    });
    if (sent) {
      lastRect = rect;
      lastClipRect = clip;
    }
  };

  const sendAppearanceUpdate = (nativeTextVisible: boolean): boolean => {
    try {
      return emitTextInput("textInput.update", {
        id,
        editingSession,
        revision: lastNativeRevision,
        jsRevision,
        ...appearanceColorParams(nativeTextVisible),
      });
    } catch {
      // If the host cannot accept the handoff, keep the Guest fallback visible.
      return false;
    }
  };

  const sendRectUpdate = (): void => {
    if (!opened || activeTextInput !== session) return;
    const rect = visualRect();
    const clip = visualClip();
    if (!rect) return;
    if (sameRect(lastRect, rect) && sameRect(lastClipRect, clip)) {
      textLayoutDirty = false;
      return;
    }
    // A text echo can change an intrinsic shell width before the next frame
    // even though the overlay's position and height are unchanged. The shell
    // is a full-width host field; absorb that local remeasure instead of
    // sending a redundant overlay move. Viewport/keyboard changes still move
    // y or height and take the rect-only path below.
    if (
      textLayoutDirty &&
      lastRect &&
      lastRect.x === rect.x &&
      lastRect.y === rect.y &&
      lastRect.height === rect.height &&
      sameRect(lastClipRect, clip)
    ) {
      lastRect = rect;
      textLayoutDirty = false;
      return;
    }
    // A layout-only update deliberately omits text and selection metadata.
    // Flutter keeps the current controller value/caret/composing range while
    // moving/resizing its overlay after viewport or keyboard changes.
    if (emitTextInput("textInput.update", {
      id,
      editingSession,
      revision: lastNativeRevision,
      jsRevision,
      rect,
      clip: clip ?? null,
    })) {
      lastRect = rect;
      lastClipRect = clip;
      textLayoutDirty = false;
    }
  };

  const open = (): void => {
    if (node) scrollPage?.ensureVisible?.(node, visualRect());
    // Translations are paint-only in the core layout ABI; use the page
    // scroller's visual rect so Flutter's overlay follows the moved shell.
    const rect = visualRect();
    const clip = visualClip();
    if (!rect) return;
    const text = props.value();
    const wasOpened = opened;
    if (!wasOpened) {
      // Reset before building the open payload so a new session can never
      // inherit the previous session's visible native styling.
      setOverlayReady(false);
      editingSession = `${id}:${++openGeneration}`;
      lastNativeRevision = 0;
      jsRevision += 1;
      selectionBase = text.length;
      selectionExtent = text.length;
      composingBase = -1;
      composingExtent = -1;
    }
    lastObservedText = text;
    if (activeTextInput && activeTextInput !== session) {
      const previous = activeTextInput;
      previous.close();
      if (activeTextInput === previous) activeTextInput = undefined;
    }
    const method = wasOpened ? "textInput.update" : "textInput.open";
    const sent = emitTextInput(method, {
      id,
      editingSession,
      revision: lastNativeRevision,
      jsRevision,
      rect,
      clip: clip ?? null,
      text,
      selectionBase,
      selectionExtent,
      composingBase,
      composingExtent,
      keyboardType: "text",
      action: "done",
      maxLines: 1,
      ...appearanceParams(),
    });
    if (wasOpened && !sent) {
      // A failed refresh does not mean an already mounted native editor was
      // detached. Keep its session and visibility handoff intact so native
      // edits continue and the Guest fallback does not appear underneath it.
      return;
    }
    opened = sent;
    setIsFocused(sent);
    if (sent) {
      activeTextInput = session;
      lastRect = rect;
      lastClipRect = clip;
    } else {
      lastRect = undefined;
      lastClipRect = undefined;
    }
  };

  const close = (): void => {
    if (!opened) return;
    opened = false;
    setIsFocused(false);
    setOverlayReady(false);
    lastRect = undefined;
    lastClipRect = undefined;
    emitTextInput("textInput.close", { id, editingSession, revision: lastNativeRevision, jsRevision });
  };

  const session: TextInputSession = {
    id,
    isOpen: () => opened,
    node: () => node,
    visualRect,
    refreshLayout: sendRectUpdate,
    close,
    accepts: (params) => {
      // Old hosts without the additive fields remain compatible. Current
      // hosts echo the editing session and monotonically increasing revision.
      if (params.editingSession !== undefined && params.editingSession !== editingSession) return false;
      const parsed = parseTextInputParams(params);
      // A native echo captured before a newer controlled JS command cannot
      // overwrite that explicit replacement, even if its native revision grew.
      if (parsed.jsRevision !== undefined && parsed.jsRevision < jsRevision) return false;
      if (parsed.revision !== undefined && parsed.revision < lastNativeRevision) return false;
      return true;
    },
    onOpened: (params) => {
      const parsed = parseTextInputParams(params);
      if (
        !opened ||
        !routeActive() ||
        parsed.editingSession !== editingSession
      ) return false;
      // Mount acknowledgement is independent of value freshness. A JS value
      // update may have advanced jsRevision while the native mount ACK was in
      // flight; restore only appearance so that ACK cannot overwrite IME text,
      // selection or composing state.
      if (overlayReady()) return true;
      if (!sendAppearanceUpdate(true)) return false;
      setOverlayReady(true);
      return true;
    },
    onEdit: (params) => {
      const parsed = parseTextInputParams(params);
      if (parsed.revision !== undefined) {
        if (parsed.revision <= lastNativeRevision) return;
        lastNativeRevision = parsed.revision;
      }
      const text = parsed.text !== undefined ? parsed.text : props.value();
      updateOffsets(params, text);
      if (parsed.text !== undefined) applyIncomingText(text);
    },
    onSubmit: (params) => {
      const parsed = parseTextInputParams(params);
      let text: string;
      if (parsed.revision !== undefined && parsed.revision < lastNativeRevision) {
        text = props.value();
      } else {
        if (parsed.revision !== undefined) lastNativeRevision = parsed.revision;
        text = parsed.text !== undefined ? parsed.text : props.value();
        updateOffsets(params, text);
        if (parsed.text !== undefined) applyIncomingText(text);
      }
      opened = false;
      setIsFocused(false);
      setOverlayReady(false);
      props.onSubmit?.(text);
    },
    onClosed: (params) => {
      const parsed = parseTextInputParams(params);
      let text: string;
      if (parsed.revision !== undefined && parsed.revision < lastNativeRevision) {
        text = props.value();
      } else {
        if (parsed.revision !== undefined) lastNativeRevision = parsed.revision;
        text = parsed.text !== undefined ? parsed.text : props.value();
        updateOffsets(params, text);
        if (parsed.text !== undefined) applyIncomingText(text);
      }
      opened = false;
      setIsFocused(false);
      setOverlayReady(false);
    },
  };

  // Retained routes stay mounted, so unmount cleanup is no longer sufficient
  // to release the native editor overlay. Close only this field's session
  // when its route becomes inactive; the controlled JS value remains intact
  // and a later activation can reopen it with the same text.
  createEffect(() => {
    if (routeActive() || !opened) return;
    close();
    if (activeTextInput === session) activeTextInput = undefined;
  });

  createEffect(() => {
    const text = props.value();
    if (text === lastObservedText) return;
    lastObservedText = text;
    if (opened) sendUpdate(text);
  });

  // Layout can change after Flutter adjusts the viewport for the system
  // keyboard. Observe geometry on work-driven frames while this session owns
  // the overlay; emit only changed rects without keeping the ticker alive.
  onFrame(sendRectUpdate, { active: routeActive, continuous: false });

  onCleanup(() => {
    close();
    if (activeTextInput === session) activeTextInput = undefined;
  });

  return (
    <Focusable
      nodeRef={(current) => {
        node = current;
      }}
      debugName="SystemTextInput"
      onPress={open}
      style={shellStyle()}
      class="w-full rounded-xl"
    >
      {/* Flutter's positioned TextField paints the same value once its
          attached session is focused. Keep the guest glyph visible until the
          host confirms that overlay, then restore it on submit/dismiss/close. */}
      <Show when={!overlayReady()}>
        <Text class={appearance().fontSize === 12 ? "text-xs" : appearance().fontSize === 16 ? "text-base" : "text-sm"} style={shellTextStyle()}>
          {props.value() || props.placeholder || "Tap to type"}
        </Text>
      </Show>
    </Focusable>
  );
}

/**
 * Page-level scrolling built from the official gesture/kinetics primitives.
 * The viewport itself never moves; only its content canvas translates, so
 * bounds/hit testing remains in the same coordinate space as the buttons and
 * the Flutter text-input overlay. No tap handler is installed here: the
 * framework's normal Focusable activation remains the tap owner while this
 * recognizer claims only vertical pans.
 */
export function ScrollablePage(props: {
  children?: JSX.Element;
  class?: string;
  style?: ViewProps["style"];
}): JSX.Element {
  const routeActive = useRouteActive();
  const parentScrollPage = useContext(ScrollablePageContext);
  const fallbackViewportHeight = 480;
  let viewportNode: NodeMirror | undefined;
  let contentNode: NodeMirror | undefined;
  let previousViewportHeight = fallbackViewportHeight;
  let previousOffset = 0;
  let needsActiveMeasurement = false;
  let activeMeasurementFrames = 0;
  const [viewportHeight, setViewportHeight] = createSignal(fallbackViewportHeight);
  const [contentHeight, setContentHeight] = createSignal(fallbackViewportHeight);
  const scroller = createScroller({
    max: () => Math.max(0, contentHeight() - viewportHeight()),
    extent: () => viewportHeight(),
  });
  // Keep raw committed geometry so a nested page can reapply its parent's
  // current paint translation after a transient layout readback gap.
  let lastViewportLayoutRect: TextInputRect | undefined;

  /**
   * Read this page's own viewport bounds with a retained-layout fallback.
   * Keep this separate from the ancestor-visible clip below: a parent may
   * hide part of a nested viewport, but that does not shrink its scroll range.
   * During a live Duo
   * resize the core may invalidate the viewport node for one layout pass, but
   * the host's canonical ui.__viewport has already received the new height.
   * Keep the last origin/size in that gap and cap it with the live viewport.
   */
  const measureViewport = (): TextInputRect | undefined => {
    if (!routeActive()) return undefined;
    // A nested page is positioned inside its parent's translated content.
    // Read its un-clipped committed size, then compose the parent's paint
    // translation. The parent clip is applied only by measureVisibleViewport.
    const measured = parentScrollPage
      ? committedLayout(viewportNode)
      : viewportLayout(viewportNode);
    if (measured) lastViewportLayoutRect = measured;
    const layout = measured ?? lastViewportLayoutRect;
    if (!layout) return undefined;
    const parentVisual = viewportNode && parentScrollPage?.visualRect?.(viewportNode, layout);
    let rect = parentVisual ?? layout;
    if (measured || parentScrollPage) return rect;
    const liveWidth = finiteNumber(textInputGlobal.ui?.__viewport?.w);
    const liveHeight = finiteNumber(textInputGlobal.ui?.__viewport?.h);
    // A live host width describes the whole Duo window, while this retained
    // rect may be the left content pane beside a rail/hinge. Never let the
    // fallback clip expand across that sibling pane during the gap.
    const width = liveWidth !== undefined && liveWidth > 0
      ? Math.max(1, Math.min(rect.width, liveWidth - rect.x))
      : rect.width;
    if (liveHeight === undefined || liveHeight <= rect.y) {
      return { ...rect, width };
    }
    rect = {
      ...rect,
      width,
      height: Math.max(1, Math.min(rect.height, liveHeight - rect.y)),
    };
    return rect;
  };

  const clipToParentViewport = (rect: TextInputRect): TextInputRect | undefined => {
    const parent = parentScrollPage?.clipRect?.();
    if (!parent) return rect;
    const x = Math.max(rect.x, parent.x);
    const y = Math.max(rect.y, parent.y);
    const right = Math.min(rect.x + rect.width, parent.x + parent.width);
    const bottom = Math.min(rect.y + rect.height, parent.y + parent.height);
    if (right <= x || bottom <= y) return undefined;
    return { x, y, width: right - x, height: bottom - y };
  };

  const measureVisibleViewport = (): TextInputRect | undefined => {
    const rect = measureViewport();
    return rect ? clipToParentViewport(rect) : undefined;
  };

  const refreshMeasurements = (): {
    rect: TextInputRect | undefined;
    viewportChanged: boolean;
  } => {
    if (!routeActive()) return { rect: undefined, viewportChanged: false };
    const rect = measureViewport();
    const viewportChanged = rect !== undefined &&
      rect.height > 0 && rect.height !== previousViewportHeight;
    if (rect && rect.height > 0 && rect.height !== previousViewportHeight) {
      previousViewportHeight = rect.height;
      setViewportHeight(rect.height);
    }
    // A zero-width retained node can occur for one layout pass while a Duo
    // pane is resizing. Its height remains useful for the scroll extent;
    // rejecting the whole record would leave maxScroll frozen at an old value.
    const measuredContent = committedLayout(contentNode, true);
    // A retained display:none subtree reports a zero geometry until the
    // native layout pass after it is shown again. Do not turn that transient
    // zero into `contentHeight = viewportHeight`, which would clamp the
    // retained scroll offset to zero. A valid viewport is also required for
    // the first reactivation measurement; the existing zero-width Duo
    // fallback remains valid when its height is present.
    if (rect && rect.height > 0 && measuredContent && measuredContent.height > 0) {
      const nextContentHeight = Math.max(rect.height, measuredContent.height);
      if (nextContentHeight !== contentHeight()) setContentHeight(nextContentHeight);
    }
    return { rect, viewportChanged };
  };

  const pageScroll = {
    visualRect: (node: NodeMirror, fallback?: TextInputRect): TextInputRect | undefined => {
      if (!routeActive()) return fallback;
      // The fallback is already in painted/visual coordinates: InputField
      // stores the last emitted overlay rect and ensureVisible passes its
      // current visual rect back here. Only a fresh committed layout is raw
      // geometry that still needs the page scroll translation.
      const committed = committedLayout(node);
      if (!committed) return fallback;
      // `getLayout` intentionally reports flex geometry without paint
      // transforms. Apply every enclosing page translation before this
      // page's content translation so nested viewports and input overlays
      // share the same painted coordinate space as hit testing.
      const parentVisual = parentScrollPage?.visualRect?.(node, committed) ?? committed;
      return { ...parentVisual, y: parentVisual.y - scroller.offset() };
    },
    clipRect: measureVisibleViewport,
    ensureVisible: (node: NodeMirror, fallback?: TextInputRect): void => {
      if (!routeActive()) return;
      const viewport = measureVisibleViewport();
      if (!viewport) return;
      // InputField's context supplies its actual painted rect, including the
      // child scroller and every parent translation. Recomputing from this
      // page alone would drop an inner page offset when an ancestor adjusts it.
      const input = fallback ?? pageScroll.visualRect(node);
      if (!input) return;
      const margin = 8;
      const top = viewport.y + margin;
      const bottom = viewport.y + viewport.height - margin;
      const inputBottom = input.y + input.height;
      if (inputBottom > bottom) {
        scroller.scrollBy(inputBottom - bottom, { immediate: true });
        syncContourSubscribers();
        // This correction is initiated by viewport/IME geometry, not by a
        // user's drag. Consume the resulting offset so the next frame does
        // not misclassify the automatic scroll and dismiss the focused input.
        previousOffset = scroller.offset();
      } else if (input.y < top) {
        scroller.scrollBy(input.y - top, { immediate: true });
        syncContourSubscribers();
        previousOffset = scroller.offset();
      }
    },
  };
  createEffect(() => {
    const active = routeActive();
    if (active) {
      needsActiveMeasurement = true;
      activeMeasurementFrames = 0;
    }
  });

  const parentScaffold = useContext(SafeAreaScaffoldContext);
  const contourSubscribers = new Set<() => boolean>();
  let syncedOffsetInTurn = Number.NaN;
  let hadActiveContour = false;
  let microtaskSyncScheduled = false;
  let pageGeometryAccessor: (() => DisplayGeometry) | undefined;
  const activePageGeometry = (): DisplayGeometry =>
    parentScaffold.hasScaffold
      ? parentScaffold.geometry()
      : (pageGeometryAccessor ? pageGeometryAccessor() : EMPTY_DISPLAY_GEOMETRY);
  const hasSideContours = (current: DisplayGeometry): boolean =>
    leftOcclusionFrames(current).length > 0 || rightOcclusionFrames(current).length > 0;
  const syncContourSubscribers = (): boolean => {
    if (!routeActive()) return false;
    if (contourSubscribers.size === 0) return false;
    const hasContour = hasSideContours(activePageGeometry());
    if (!hasContour && !hadActiveContour) return false;
    hadActiveContour = hasContour;
    let anyChanged = false;
    for (let pass = 0; pass < 2; pass += 1) {
      let changedInPass = false;
      for (const subscriber of contourSubscribers) {
        if (subscriber()) {
          changedInPass = true;
          anyChanged = true;
        }
      }
      if (!changedInPass || !hasContour) break;
    }
    return anyChanged;
  };
  const scheduleContourMicrotask = (): void => {
    if (!routeActive()) return;
    if (microtaskSyncScheduled) return;
    if (!hadActiveContour && !hasSideContours(activePageGeometry())) return;
    microtaskSyncScheduled = true;
    queueMicrotask(() => {
      microtaskSyncScheduled = false;
      syncContourSubscribers();
    });
  };

  const syncViewportResize = (): void => {
    if (!routeActive()) return;
    syncContourSubscribers();
    const { rect } = refreshMeasurements();
    if (!rect) return;
    const input = activeTextInput;
    const inputNode = input?.isOpen() ? input.node() : undefined;
    if (!input || !inputNode || !nodeIsWithin(viewportNode, inputNode)) return;
    // Reuse the normal page ensure-visible calculation, then synchronously
    // publish the moved overlay rect. This runs inside the existing
    // display.viewport bridge before PocketView asks for its delta=0 frame.
    pageScroll.ensureVisible(inputNode, input.visualRect());
    input.refreshLayout();
  };
  const pageGeometry = createDisplayGeometry({ onChange: syncViewportResize });
  pageGeometryAccessor = pageGeometry;
  const scrollContext: ScrollablePageContextValue = {
    scrollOffset: () => scroller.offset(),
    geometry: activePageGeometry,
    visualRect: (node, fallback) => pageScroll.visualRect(node, fallback),
    clipRect: pageScroll.clipRect,
    ensureVisible: pageScroll.ensureVisible,
    subscribeContour: (sync) => {
      contourSubscribers.add(sync);
      scheduleContourMicrotask();
      return () => {
        contourSubscribers.delete(sync);
        scheduleContourMicrotask();
      };
    },
    chainDrag: (deltaY: number) => {
      if (!routeActive() || deltaY === 0) return;
      if (scroller.state() !== "tracking") {
        endedOnThisTurn = false;
        scroller.stop();
        scroller.beginDrag();
      }
      scroller.drag(deltaY);
      syncedOffsetInTurn = scroller.offset();
      syncContourSubscribers();
    },
    chainEndDrag: (velocityY: number) => {
      if (!routeActive()) return;
      if (scroller.state() === "tracking") {
        endedOnThisTurn = true;
        scroller.endDrag(velocityY);
      }
    },
  };

  let endedOnThisTurn = false;
  const gesture = createGesture({
    axis: "y",
    // Keep the node hit fact when a host provides it, but retain the official
    // geometry fallback for cold/replay hosts and bare gaps in the viewport.
    // The upstream Clear/VirtualList examples use the same region contract;
    // without the rect a touch whose down hit is unresolved cannot start a
    // page pan even though it is visibly inside the clip.
    region: {
      node: () => routeActive() ? viewportNode : undefined,
      rect: () => {
        if (!routeActive()) return undefined;
        const rect = measureVisibleViewport();
        return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : undefined;
      },
    },
    panSlop: 1,
    onDown: () => {
      if (!routeActive()) return;
      endedOnThisTurn = false;
      scroller.stop();
    },
    onPanStart: () => {
      if (routeActive()) scroller.beginDrag();
    },
    onPanMove: (contact) => {
      if (!routeActive()) return;
      scroller.drag(-contact.fdy);
      syncedOffsetInTurn = scroller.offset();
      syncContourSubscribers();
    },
    onPanEnd: (contact) => {
      if (!routeActive()) return;
      endedOnThisTurn = true;
      scroller.endDrag(-contact.vy);
    },
    onUp: () => {
      if (!routeActive()) return;
      if (scroller.state() === "idle") {
        const max = Math.max(0, contentHeight() - viewportHeight());
        const current = scroller.offset();
        if (current < 0 || current > max) {
          endedOnThisTurn = true;
          scroller.beginDrag();
          scroller.endDrag(0);
        }
      }
    },
    onCancel: () => {
      if (!routeActive()) return;
      endedOnThisTurn = true;
      if (scroller.state() === "idle") scroller.beginDrag();
      scroller.endDrag(0);
    },
  });

  const desktopScrollPage: DesktopScrollPage = {
    node: () => viewportNode,
    active: routeActive,
    rect: measureVisibleViewport,
    interrupt: () => {
      gesture.cancel();
      scroller.stop();
    },
    applyDelta: (deltaY) => {
      desktopScrollPage.interrupt();
      // A touch drag may have left the Scroller in its rubber-band range.
      // Normalize that existing state before measuring how much of this
      // desktop delta the child consumed, or the correction itself could be
      // mistaken for input and send an opposite remainder to the parent.
      scroller.scrollTo(scroller.offset(), { immediate: true });
      const before = scroller.offset();
      scroller.scrollBy(deltaY, { immediate: true });
      const after = scroller.offset();
      if (after !== before) {
        syncedOffsetInTurn = after;
        syncContourSubscribers();
      }
      return after - before;
    },
  };
  let unregisterDesktopScrollPage: (() => void) | undefined;
  createEffect(() => {
    if (routeActive()) {
      if (!unregisterDesktopScrollPage) unregisterDesktopScrollPage = registerDesktopScrollPage(desktopScrollPage);
    } else {
      unregisterDesktopScrollPage?.();
      unregisterDesktopScrollPage = undefined;
    }
  });
  onCleanup(() => {
    unregisterDesktopScrollPage?.();
    unregisterDesktopScrollPage = undefined;
  });

  bindDpadScroll(scroller, { active: routeActive });
  createEffect(() => {
    if (routeActive()) return;
    // Stop an in-flight fling/spring without changing the retained offset.
    // Cancelling the recognizer also releases a contact that crossed a route
    // transition while the old page was active.
    gesture.cancel();
    scroller.stop();
  });
  onFrame(() => {
    if (!routeActive()) return;
    if (endedOnThisTurn) {
      endedOnThisTurn = false;
    } else {
      scroller.step();
    }
    const currentOffset = scroller.offset();
    const scrolled = currentOffset !== previousOffset;
    previousOffset = currentOffset;
    const alreadySyncedInPan = currentOffset === syncedOffsetInTurn;
    syncedOffsetInTurn = Number.NaN;
    const contourChanged = alreadySyncedInPan ? false : syncContourSubscribers();
    if (!alreadySyncedInPan) scheduleContourMicrotask();
    const { rect, viewportChanged } = refreshMeasurements();
    if (needsActiveMeasurement) {
      activeMeasurementFrames += 1;
      // display:none can leave one stale zero-layout frame behind. Give the
      // native layout one follow-up frame when the first read is not real,
      // then stop the work hint while retaining the prior extent as a safe
      // fallback if the host does not expose layout readback.
      const viewportReady = viewportLayout(viewportNode) !== undefined;
      const contentReady = committedLayout(contentNode, true) !== undefined;
      if ((viewportReady && contentReady) || activeMeasurementFrames >= 2) {
        needsActiveMeasurement = false;
      }
    }
    const input = activeTextInput;
    const inputNode = input?.isOpen() ? input.node() : undefined;
    if (viewportChanged && inputNode && nodeIsWithin(viewportNode, inputNode)) {
      pageScroll.ensureVisible(inputNode, input?.visualRect());
    }
    if (contourChanged && input && inputNode && nodeIsWithin(viewportNode, inputNode)) {
      input.refreshLayout();
    }
    if (scrolled && rect && input && inputNode && nodeIsWithin(viewportNode, inputNode)) {
      const visibleRect = measureVisibleViewport();
      // The active InputField owns the nearest ScrollablePage context, so its
      // rect already includes child and ancestor paint translations. A sibling
      // page must never judge the overlay with its own scroll transform.
      const inputRect = input.visualRect();
      const viewportBottom = visibleRect ? visibleRect.y + visibleRect.height : Number.NEGATIVE_INFINITY;
      const inputBottom = inputRect ? inputRect.y + inputRect.height : 0;
      const outside = !visibleRect || !inputRect || inputRect.y < visibleRect.y || inputBottom > viewportBottom;
      if (outside) {
        input.close();
        if (activeTextInput === input) activeTextInput = undefined;
      }
    }
  }, {
    active: routeActive,
    continuous: () => needsActiveMeasurement || scroller.state() !== "idle",
  });

  return (
    <ScrollablePageContext.Provider value={scrollContext}>
      <View
        ref={(current) => {
          viewportNode = current;
        }}
        class={props.class ?? "flex-1 w-full overflow-hidden"}
        style={props.style}
      >
        <View
          class="flex-col"
          style={{
            posType: 1,
            insetT: 0,
            insetL: 0,
            width: -1,
            // Let flex measure the actual children.  A definite height here
            // makes the content column shrink to the viewport and leaves the
            // scroller with max=0. `minH` preserves a full clip-sized canvas
            // while retaining intrinsic content height when the page is longer.
            height: Number.NaN,
            minH: viewportHeight(),
            translateY: -scroller.offset(),
          }}
        >
          <View
            ref={(current) => {
              contentNode = current;
            }}
            // Prevent the flex column from shrinking its children to the
            // containing clip while the auto-sized canvas is being measured.
            class="flex-col w-full shrink-0"
          >
            {props.children}
          </View>
        </View>
      </View>
    </ScrollablePageContext.Provider>
  );
}

export function MiniBarChart(props: { values: readonly number[] }): JSX.Element {
  return (
    <View class="flex-row items-end gap-1 h-[32]">
      <For each={props.values}>
        {(value) => <View class="w-2 rounded-xl bg-[#315DEB]" style={{ height: Math.max(4, value) }} />}
      </For>
    </View>
  );
}

export interface ListItem {
  id: string;
  title: string;
  detail?: string;
}

export function List(props: { items: readonly ListItem[]; tone?: "light" | "dark" }): JSX.Element {
  return (
    <View class="flex-col gap-1 mx-4 rounded-xl">
      <For each={props.items}>
        {(item) => (
          <ScrollContourItem class={props.tone === "dark"
            ? "flex-col gap-1 px-3 py-3 bg-[#17233B] border-[#30405A]"
            : "flex-col gap-1 px-3 py-3 bg-white border-[#E5E9F2]"}>
            <Text class={props.tone === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{item.title}</Text>
            {item.detail ? <Text class={props.tone === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{item.detail}</Text> : null}
          </ScrollContourItem>
        )}
      </For>
    </View>
  );
}

export function ViewText(props: { title: string; body: string }): JSX.Element {
  return <View class="flex-col gap-1"><Text class="text-sm text-[#17233B] font-bold">{props.title}</Text><Text class="text-xs text-[#7C8799]">{props.body}</Text></View>;
}

export function Card(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <ScrollContourItem class={props.class ?? "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"}>{props.children}</ScrollContourItem>;
}

export function Row(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <ScrollContourItem class={props.class ?? "flex-row items-center gap-3"}>{props.children}</ScrollContourItem>;
}

export function TileGrid(props: { children?: JSX.Element }): JSX.Element {
  return <Grid columns={2} gap={12} class="flex-row flex-wrap mx-5">{props.children}</Grid>;
}

/** A reusable modal panel; its overlay is only for component details. */
export function DetailModal(props: {
  open: boolean | (() => boolean);
  title: string;
  body: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal open={props.open}>
      <Text class="text-lg text-[#17233B] font-bold">{props.title}</Text>
      <Text class="text-xs text-[#7C8799]">{props.body}</Text>
      <ActionButton label="Close" kind="quiet" onPress={props.onClose} />
    </Modal>
  );
}

// The mobile vocabulary is a thin composition layer over the same official
// primitives above. Keep one implementation and let callers opt into the
// source-backed aliases without duplicating the existing app kit.
export * from "./mobile.tsx";

