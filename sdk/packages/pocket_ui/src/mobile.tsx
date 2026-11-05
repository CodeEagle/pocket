/**
 * Built-in Option C Design System & Cross-Platform Composition Layer.
 *
 * Architecture & Provenance:
 * - Combines Material 3 / Shadcn semantic Light & Dark tokens, 3-tier
 *   responsive window size classes (`compact` / `medium` / `expanded`) with
 *   dual interaction density (`touch` 44px vs `desktop` 36px), and TDesign
 *   mobile/mini-program + desktop component specifications.
 * - Preserves the vocabulary and slot shape from the retained parent's
 *   `mini_apps/syslib/pocket_syslib_flutter_ui.js` (`Scaffold`, `AppBar`,
 *   `Card`, `ListTile`, button variants, form controls, overlays).
 * - Every component is composed from the pinned official Solid primitives
 *   (`View`, `Text`, `Focusable`, `Modal`, `CompositorSurface`) with both
 *   compiled native style transitions (`transition-*`) and frame-driven
 *   state-transition animations.
 * - GlassSurface uses the host's generic `registerSurface` bridge when it is
 *   available. Its fallback is an explicitly labelled visual recipe; a CSS
 *   gradient is never reported as native blur or refraction.
 */

import { For, Show, children as resolveChildren, createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { CompositorSurface, Focusable, Modal, Portal, Text, View, type NodeMirror, type ViewProps } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { simulationHz, virtualNow } from "@pocketjs/framework/clock";
import { buildLiquidGlassRecipe, type GlassShape } from "./legacy.ts";
import {
  ContourConsumedContext,
  SafeAreaScaffold,
  SafeAreaScaffoldContext,
  ScrollContourItem,
  ScrollablePageContext,
  useScrollContourReserve,
  type SafeAreaEdges,
  type SafeAreaReservedActions,
  type SafeAreaSlot,
} from "./ui.tsx";
import {
  DISPLAY_UI_SAFETY_GAP,
  avoidDisplayOcclusions,
  deriveDesignDensity,
  deriveWindowSizeClass,
  topRightOcclusionFrame,
  type DesignDensity,
  type DisplayGeometry,
  type WindowSizeClass,
} from "./responsive.ts";
import { useRouteActive } from "./route.tsx";
import type { BridgeObject } from "./host.ts";

export type SemanticTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

/** Supported product accent palettes. Semantic danger/success colors stay separate. */
export type MobileAccent = "blue" | "violet" | "teal" | "rose";

interface MobileAccentPalette {
  color: number;
  softColor: number;
  inkColor: number;
  pressedColor: number;
}

export type MobileColor = `#${string}`;

export interface MobileTheme {
  name: string;
  canvas: string;
  surface: string;
  surfaceMuted: string;
  surfaceElevated?: string;
  ink: string;
  muted: string;
  accent: string;
  accentPressed: string;
  accentSoft?: string;
  accentInk?: string;
  /** ARGB colors for dynamic accent styles; classes remain a static fallback. */
  accentColor?: number;
  accentSoftColor?: number;
  accentInkColor?: number;
  accentPressedColor?: number;
  border: string;
  danger: string;
  success?: string;
  warning?: string;
}

export const MOBILE_THEME_LIGHT: MobileTheme = {
  name: "light",
  canvas: "bg-[#FAFAFA]",
  surface: "bg-white",
  surfaceMuted: "bg-[#F4F4F5]",
  surfaceElevated: "bg-white",
  ink: "text-[#09090B]",
  muted: "text-[#71717A]",
  accent: "bg-[#18181B]",
  accentPressed: "bg-[#27272A]",
  accentSoft: "bg-[#F4F4F5]",
  accentInk: "text-[#09090B]",
  accentColor: 0xff315deb,
  accentSoftColor: 0xfff4f4f5,
  accentInkColor: 0xff315deb,
  accentPressedColor: 0xff27272a,
  border: "border-[#E4E4E7]",
  danger: "bg-[#DC2626]",
  success: "bg-[#16A34A]",
  warning: "bg-[#D97706]",
};

export const MOBILE_THEME_DARK: MobileTheme = {
  name: "dark",
  canvas: "bg-[#09090B]",
  surface: "bg-[#09090B]",
  surfaceMuted: "bg-[#27272A]",
  surfaceElevated: "bg-[#18181B]",
  ink: "text-[#FAFAFA]",
  muted: "text-[#A1A1AA]",
  accent: "bg-[#FAFAFA]",
  accentPressed: "bg-[#E4E4E7]",
  accentSoft: "bg-[#27272A]",
  accentInk: "text-[#FAFAFA]",
  accentColor: 0xff315deb,
  accentSoftColor: 0xff27272a,
  accentInkColor: 0xfffafafa,
  accentPressedColor: 0xffe4e4e7,
  border: "border-[#27272A]",
  danger: "bg-[#DC2626]",
  success: "bg-[#22C55E]",
  warning: "bg-[#F59E0B]",
};

const MOBILE_ACCENT_PALETTES: Record<MobileAccent, { light: MobileAccentPalette; dark: MobileAccentPalette }> = {
  blue: {
    light: { color: 0xff2563eb, softColor: 0xffeff6ff, inkColor: 0xff315deb, pressedColor: 0xff1d4ed8 },
    dark: { color: 0xff3b82f6, softColor: 0xff172554, inkColor: 0xff93c5fd, pressedColor: 0xff2563eb },
  },
  violet: {
    light: { color: 0xff7c3aed, softColor: 0xfff5f3ff, inkColor: 0xff6d28d9, pressedColor: 0xff6d28d9 },
    dark: { color: 0xff8b5cf6, softColor: 0xff2e1065, inkColor: 0xffc4b5fd, pressedColor: 0xff7c3aed },
  },
  teal: {
    light: { color: 0xff0d9488, softColor: 0xfff0fdfa, inkColor: 0xff0f766e, pressedColor: 0xff0f766e },
    dark: { color: 0xff14b8a6, softColor: 0xff042f2e, inkColor: 0xff5eead4, pressedColor: 0xff0d9488 },
  },
  rose: {
    light: { color: 0xffe11d48, softColor: 0xfffff1f2, inkColor: 0xffbe123c, pressedColor: 0xffbe123c },
    dark: { color: 0xffe11d48, softColor: 0xff4c0519, inkColor: 0xfffda4af, pressedColor: 0xfff43f5e },
  },
};

/** Build a theme with one shared accent palette for the whole guest tree. */
export function createMobileTheme(dark: boolean, accent: MobileAccent = "blue"): MobileTheme {
  const base = dark ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT;
  const palette = MOBILE_ACCENT_PALETTES[accent] ?? MOBILE_ACCENT_PALETTES.blue;
  const colors = dark ? palette.dark : palette.light;
  return {
    ...base,
    accentColor: colors.color,
    accentSoftColor: colors.softColor,
    accentInkColor: colors.inkColor,
    accentPressedColor: colors.pressedColor,
  };
}

/**
 * Convert the public ARGB token into the CSS colour spelling consumed by
 * guest styles. Numeric style colours are packed as ABGR by the compiler, so
 * passing the public integer directly would swap red and blue at render time.
 */
export function toMobileColor(value: number | undefined, fallback = 0xff315deb): MobileColor {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const color = normalized >>> 0;
  const rgb = (color & 0x00ffffff).toString(16).padStart(6, "0");
  const alpha = (color >>> 24) & 0xff;
  return (alpha === 0xff
    ? `#${rgb}`
    : `#${rgb}${alpha.toString(16).padStart(2, "0")}`) as MobileColor;
}

interface MobileAccentStylePalette {
  color: MobileColor;
  softColor: MobileColor;
  inkColor: MobileColor;
  pressedColor: MobileColor;
}

function accentPaletteFor(theme: MobileTheme): MobileAccentStylePalette {
  const fallback = theme.name === "dark"
    ? MOBILE_ACCENT_PALETTES.blue.dark
    : MOBILE_ACCENT_PALETTES.blue.light;
  return {
    color: toMobileColor(theme.accentColor, fallback.color),
    softColor: toMobileColor(theme.accentSoftColor, fallback.softColor),
    inkColor: toMobileColor(theme.accentInkColor, fallback.inkColor),
    pressedColor: toMobileColor(theme.accentPressedColor, fallback.pressedColor),
  };
}

function accentColor(theme: MobileTheme): MobileColor {
  return accentPaletteFor(theme).color;
}

function accentSoftColor(theme: MobileTheme): MobileColor {
  return accentPaletteFor(theme).softColor;
}

function accentInkColor(theme: MobileTheme): MobileColor {
  return accentPaletteFor(theme).inkColor;
}

type ThemeSource = MobileTheme | (() => MobileTheme);
type DensitySource = DesignDensity | "auto" | (() => DesignDensity | "auto");

const ThemeContext = createContext<ThemeSource>(MOBILE_THEME_LIGHT);
const DensityContext = createContext<DensitySource>("auto");

export function MobileThemeProvider(props: {
  theme?: ThemeSource;
  density?: DensitySource;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <ThemeContext.Provider value={props.theme ?? MOBILE_THEME_LIGHT}>
      <DensityContext.Provider value={props.density ?? "auto"}>
        {props.children}
      </DensityContext.Provider>
    </ThemeContext.Provider>
  );
}

export function DesignDensityProvider(props: {
  density: DensitySource;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <DensityContext.Provider value={props.density}>
      {props.children}
    </DensityContext.Provider>
  );
}

export function useMobileTheme(): () => MobileTheme {
  const source = useContext(ThemeContext) ?? MOBILE_THEME_LIGHT;
  return typeof source === "function" ? source : () => source;
}

const useMobileThemeAccessor = useMobileTheme;

export function useDesignDensity(): () => DesignDensity {
  const source = useContext(DensityContext) ?? "auto";
  const scaffold = useContext(SafeAreaScaffoldContext);
  return () => {
    const raw = typeof source === "function" ? source() : source;
    return deriveDesignDensity(scaffold.geometry(), raw);
  };
}

export function useWindowSizeClass(): () => WindowSizeClass {
  const scaffold = useContext(SafeAreaScaffoldContext);
  return () => deriveWindowSizeClass(scaffold.geometry());
}

type LayoutBridge = {
  getLayout?: (id: number) => unknown;
};

const layoutGlobal = globalThis as typeof globalThis & {
  pocket?: LayoutBridge;
  ui?: {
    wrapText?: (str: string, fontSlot: number, maxW: number) => number[];
    __viewport?: { w?: unknown };
  };
};

/**
 * PocketJS `<Text>` breaks lines only on explicit `\n`. This helper uses the
 * engine's `ui.wrapText` measurement when available and falls back to clean
 * word-boundary wrapping so long descriptions never overflow cards or alerts.
 */
export function wrapTextLines(
  text: string,
  maxChars = 42,
  maxWidthPx = 276,
  fontSlot = 1,
): string {
  if (!text || text.includes("\n")) return text;
  const nativeWrap = layoutGlobal.ui?.wrapText;
  if (typeof nativeWrap === "function" && maxWidthPx > 0) {
    try {
      const breaks = nativeWrap(text, fontSlot, maxWidthPx);
      if (Array.isArray(breaks) && breaks.length > 0) {
        const lines: string[] = [];
        let start = 0;
        for (const brk of breaks) {
          if (typeof brk === "number" && brk > start && brk <= text.length) {
            lines.push(text.slice(start, brk).trim());
            start = brk;
          }
        }
        const tail = text.slice(start).trim();
        if (tail) lines.push(tail);
        if (lines.length > 0) return lines.join("\n");
      }
    } catch {
      // Fall back to character-based word wrapping below.
    }
  }
  if (text.length <= maxChars) return text;
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars * 0.4)) cut = maxChars;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines.join("\n");
}

function readNodeWidth(node: { id: number } | undefined): number | undefined {
  const getLayout = layoutGlobal.pocket?.getLayout;
  if (!node || typeof getLayout !== "function") return undefined;
  try {
    const raw = getLayout(node.id);
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const w = record.width ?? record.w;
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : undefined;
  } catch {
    return undefined;
  }
}

export interface MobileParagraphProps {
  text: string;
  class?: string;
  /** Match a custom text class to its compiled font; text-xs uses slot 0. */
  fontSlot?: number;
}

/** A width-aware body paragraph backed by the native PocketJS text wrapper. */
export function MobileParagraph(props: MobileParagraphProps): JSX.Element {
  const scaffold = useContext(SafeAreaScaffoldContext);
  const routeActive = useRouteActive();
  let containerNode: { id: number } | undefined;
  const [containerWidth, setContainerWidth] = createSignal(0);
  let lastFallbackWidth = 0;
  let layoutReadArmed = false;
  const fallbackWidth = (): number => {
    const geometryWidth = scaffold.geometry().width;
    const viewportWidth = layoutGlobal.ui?.__viewport?.w;
    // The native viewport updates synchronously on resize, while the
    // scaffold's display event can arrive one frame later (or be absent on
    // the lightweight probe host). Prefer it so a measured paragraph is
    // invalidated for the same resize that invalidates its parent layout.
    const width = typeof viewportWidth === "number" && Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : geometryWidth > 0
        ? geometryWidth
        : 390;
    return Math.max(1, width - 64);
  };
  const syncWidth = (): void => {
    const nextFallbackWidth = fallbackWidth();
    if (nextFallbackWidth !== lastFallbackWidth) {
      lastFallbackWidth = nextFallbackWidth;
      layoutReadArmed = false;
      if (containerWidth() !== 0) setContainerWidth(0);
      return;
    }
    if (!layoutReadArmed) {
      layoutReadArmed = true;
      return;
    }
    const measured = readNodeWidth(containerNode);
    if (measured !== undefined && measured > 0 && Math.abs(measured - containerWidth()) >= 1) {
      setContainerWidth(measured);
    }
  };
  createEffect(() => {
    props.text;
    const nextFallbackWidth = fallbackWidth();
    if (nextFallbackWidth !== lastFallbackWidth) {
      lastFallbackWidth = nextFallbackWidth;
      layoutReadArmed = false;
      setContainerWidth(0);
    }
  });
  try {
    onFrame(syncWidth, {
      active: routeActive,
      continuous: () => routeActive() && (containerWidth() <= 0 || fallbackWidth() !== lastFallbackWidth),
    });
  } catch {
    // Source-only consumers have no native frame scheduler.
  }
  const wrappedText = (): string => wrapTextLines(
    props.text,
    Number.MAX_SAFE_INTEGER,
    containerWidth() > 0 ? containerWidth() : fallbackWidth(),
    props.fontSlot ?? 0,
  );
  return (
    <View
      ref={(current) => {
        containerNode = current;
        syncWidth();
      }}
      class="w-full min-w-0"
    >
      <Text class={props.class ?? "text-xs"}>{wrappedText()}</Text>
    </View>
  );
}

/**
 * Frame-driven state-change animation hook.
 * Whenever `key()` changes, progresses smoothly from `0` to `1.0` over
 * `frames` ticks using a cubic ease-out curve. Overlay callers use the
 * presence helper below so their subtree can reverse before unmounting.
 * Inline controls pass `animateOnMount = false` so they render at rest (`1.0`)
 * on initial mount and animate whenever their state changes; overlays pass
 * `animateOnMount = true` so their entrance animates on mount.
 */
export function useStateTransition(
  key: () => unknown,
  frames = 10,
  animateOnMount = false,
): () => number {
  const routeActive = useRouteActive();
  const [progress, setProgress] = createSignal(animateOnMount ? 0 : 1);
  const [active, setActive] = createSignal(animateOnMount);
  let step = animateOnMount ? 0 : frames;
  let initialized = false;
  let previousKey: unknown;
  createEffect(() => {
    const nextKey = key();
    // A parent store can invalidate its getters every frame without changing
    // the transition key. Restart only for an actual visual state change.
    if (initialized && Object.is(nextKey, previousKey)) return;
    previousKey = nextKey;
    if (!initialized) {
      initialized = true;
      if (animateOnMount) {
        step = 0;
        setProgress(0);
        setActive(true);
      } else {
        step = frames;
        setProgress(1);
        setActive(false);
      }
      return;
    }
    step = 0;
    setProgress(0);
    setActive(true);
  });
  try {
    onFrame(() => {
      if (!routeActive()) return;
      if (step < frames) {
        step += 1;
        const linear = Math.min(1, step / Math.max(1, frames));
        const eased = 1 - Math.pow(1 - linear, 3);
        setProgress(eased);
        if (step >= frames) setActive(false);
      } else if (active()) {
        setActive(false);
      }
    }, { active: () => routeActive() && active(), continuous: () => routeActive() && active() });
  } catch {
    // Ignore when running in unit tests without an active frame scheduler.
  }
  return progress;
}

const MOBILE_OVERLAY_DURATION_SECONDS = 0.3;

function overlayEaseInOut(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

type OverlayPresence = {
  mounted: () => boolean;
  progress: () => number;
  interactive: () => boolean;
};

/**
 * Retain a Modal subtree through its exit so the panel and the colorless
 * backdrop reverse together. `virtualNow()` is the pinned simulation clock;
 * the duration is expressed in seconds rather than fixed input-frame counts.
 * Reversing an interrupted transition walks the same phase backward.
 */
function useOverlayPresence(open: () => boolean): OverlayPresence {
  const routeActive = useRouteActive();
  const [mounted, setMounted] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  let requested = false;
  let phase = 0;
  let lastTime = virtualNow();

  createEffect(() => {
    const activeRoute = routeActive();
    const nextRequested = activeRoute && Boolean(open());
    if (!activeRoute) {
      requested = false;
      phase = 0;
      lastTime = virtualNow();
      setMounted(false);
      setProgress(0);
      return;
    }
    if (nextRequested === requested) return;
    requested = nextRequested;
    lastTime = virtualNow();
    if (nextRequested) {
      setMounted(true);
    } else if (phase === 0) {
      setMounted(false);
    }
  });

  try {
    onFrame(() => {
      if (!routeActive() || !mounted()) return;
      const target = requested ? 1 : 0;
      if (phase === target) {
        if (!requested) setMounted(false);
        lastTime = virtualNow();
        return;
      }
      const now = virtualNow();
      const delta = Math.max(0, now - lastTime);
      lastTime = now;
      phase = Math.max(0, Math.min(1, phase + (requested ? 1 : -1) * delta / MOBILE_OVERLAY_DURATION_SECONDS));
      setProgress(overlayEaseInOut(phase));
      if (phase === target && !requested) setMounted(false);
    }, {
      active: () => routeActive() && mounted() && phase !== (requested ? 1 : 0),
      continuous: () => routeActive() && mounted() && phase !== (requested ? 1 : 0),
    });
  } catch {
    // Source-only consumers have no native frame scheduler.
  }
  return { mounted, progress, interactive: () => routeActive() && requested && Boolean(open()) };
}

/**
 * Smoothly interpolates a numeric value (such as progress ratio, switch thumb,
 * or segmented control indicator position) across frames when the target
 * changes. Keeps the demand scheduler active only while settling.
 */
export function useAnimatedNumber(target: () => number, rate = 0.38, durationMs?: number): () => number {
  const routeActive = useRouteActive();
  const initial = untrack(target);
  const [current, setCurrent] = createSignal(initial);
  const [active, setActive] = createSignal(false);
  let goal = initial;
  let from = initial;
  let elapsedMs = 0;
  const advanceTimed = (): boolean => {
    if (durationMs === undefined || durationMs <= 0) return false;
    elapsedMs += 1000 / simulationHz();
    const progress = Math.min(1, elapsedMs / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    setCurrent(progress === 1 ? goal : from + (goal - from) * eased);
    if (progress === 1) setActive(false);
    return true;
  };
  createEffect(() => {
    const next = target();
    if (Object.is(next, goal)) return;
    // Only the target restarts the animation. Reading current tracked here
    // causes each animation write to rerun this effect and settle instantly.
    const previous = untrack(current);
    goal = next;
    from = previous;
    elapsedMs = 0;
    if (Math.abs(next - previous) <= 0.002) {
      setCurrent(next);
      setActive(false);
    } else {
      setActive(true);
      // Presses run after frame hooks. Publish the first visible sample in
      // that same input turn instead of waiting for another hook and then
      // rounding a slow ease-in sample back to the previous pixel.
      if (untrack(routeActive)) advanceTimed();
    }
  });
  try {
    onFrame(() => {
      if (!routeActive() || !active()) return;
      const previous = untrack(current);
      if (advanceTimed()) return;
      const difference = goal - previous;
      if (Math.abs(difference) <= 0.002) {
        setCurrent(goal);
        setActive(false);
      } else {
        setCurrent(previous + difference * rate);
      }
    }, { active: () => routeActive() && active(), continuous: active });
  } catch {
    // Source-only consumers have no native frame scheduler.
  }
  return current;
}

export function MobileScaffold(props: {
  children?: JSX.Element;
  appBar?: SafeAreaSlot;
  bottomBar?: SafeAreaSlot;
  class?: string;
  /**
   * Nested showcase pages already sit below the root Screen's safe shell, so
   * they default to `none`. Standalone guests should use `SafeAreaScaffold`
   * (or pass `safeArea="all"`) exactly once.
   */
  safeArea?: SafeAreaEdges;
  /** Reuse a parent geometry signal instead of subscribing a second time. */
  geometry?: DisplayGeometry | (() => DisplayGeometry);
  /** Reserve the host's top-right mini-app action area for app-bar content. */
  reservedActions?: SafeAreaReservedActions;
}): JSX.Element {
  // Keep one structural shell: SafeAreaScaffold owns geometry and edge
  // padding, while this compatibility wrapper only supplies the mobile theme.
  // The pinned compiler still sees the classes as literal JSX attributes.
  const theme = useMobileThemeAccessor();
  return (
    <SafeAreaScaffold
      class={props.class ?? (theme().name === "dark" ? "flex-col w-full bg-[#09090B] transition-colors duration-200 ease-out" : "flex-col w-full bg-[#FAFAFA] transition-colors duration-200 ease-out")}
      edges={props.safeArea ?? "none"}
      geometry={props.geometry}
      reservedActions={props.reservedActions}
      appBar={props.appBar}
      bottomBar={props.bottomBar}
    >
      {props.children}
    </SafeAreaScaffold>
  );
}

export function MobileAppBar(props: {
  title: string;
  subtitle?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  dark?: boolean;
  /** Keep the title centered between equal leading/trailing action slots. */
  centered?: boolean;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const scaffold = useContext(SafeAreaScaffoldContext);
  const alreadyConsumed = useContext(ContourConsumedContext);
  const { leftReserve, nodeRef, reserve } = useScrollContourReserve({
    baseLeft: 16,
    baseRight: 16,
    defaultInBand: true,
    enabled: () => !alreadyConsumed(),
    mode: "padding",
  });
  const dark = () => props.dark === true || theme().name === "dark";
  let appliedLeftNonZero = false;
  let appliedRightNonZero = false;
  const appBarStyle = () => {
    const l = leftReserve();
    const r = reserve();
    if (l > 0) appliedLeftNonZero = true;
    if (r > 0) appliedRightNonZero = true;
    const hasLeft = l > 0 || appliedLeftNonZero;
    const hasRight = scaffold.reservedActions > 0 || r > 0 || appliedRightNonZero;
    if (!hasLeft && !hasRight) return undefined;
    let actionRightPadding = scaffold.reservedActions;
    if (scaffold.reservedActions > 0 && !alreadyConsumed()) {
      const current = scaffold.geometry();
      if (current.width > 0) {
        const target = {
          left: Math.max(0, current.width - scaffold.reservedActions),
          top: 0,
          width: scaffold.reservedActions,
          height: 56,
        };
        const local = avoidDisplayOcclusions(current, target, { prefer: "horizontal" });
        const actionShift = Math.max(0, -local.offsetX) + (topRightOcclusionFrame(current) ? DISPLAY_UI_SAFETY_GAP : 0);
        actionRightPadding = scaffold.reservedActions + actionShift;
      }
    }
    return {
      ...(hasLeft ? { paddingL: 16 + l } : {}),
      ...(hasRight ? { paddingR: Math.max(16 + r, actionRightPadding) } : {}),
    };
  };
  const centered = () => props.centered === true;
  return (
    <ContourConsumedContext.Provider value={() => true}>
      <View
        ref={nodeRef}
        class={dark()
          ? "flex-row items-center gap-2 w-full h-[56] px-4 bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out"
          : "flex-row items-center gap-2 w-full h-[56] px-4 bg-white border-[#E4E4E7] transition-colors duration-200 ease-out"}
        style={appBarStyle()}
      >
        {centered() ? <View class="flex-row items-center w-[64] shrink-0">{props.leading}</View> : props.leading}
        <View
          class={centered() ? "flex-col items-center justify-center gap-1 flex-1 overflow-hidden" : "flex-col gap-1 flex-1 overflow-hidden"}
          style={{ minW: 0 }}
        >
          <Text class={dark() ? "text-base text-[#FAFAFA] font-bold" : "text-base text-[#09090B] font-bold"}>{props.title}</Text>
          {props.subtitle ? <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{props.subtitle}</Text> : null}
        </View>
        {centered() ? <View class="flex-row items-center justify-end w-[64] shrink-0">{props.trailing}</View> : props.trailing}
      </View>
    </ContourConsumedContext.Provider>
  );
}

export interface MobileCardProps {
  children?: JSX.Element;
  class?: string;
  title?: string;
  detail?: string;
  glass?: boolean;
  glassShape?: GlassShape;
  glassPressed?: boolean;
}

export function MobileCard(props: MobileCardProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  if (props.glass) {
    return (
      <GlassSurface shape={props.glassShape ?? "rounded"} pressed={props.glassPressed} class={props.class}>
        {props.title ? <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>{props.title}</Text> : null}
        {props.detail ? <MobileParagraph text={props.detail} class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"} /> : null}
        {props.children}
      </GlassSurface>
    );
  }
  return (
    <ScrollContourItem class={props.class ?? (theme().name === "dark"
      ? "flex-col w-full gap-3 p-4 rounded-xl bg-[#18181B] border-[#27272A] transition-colors duration-200 ease-out"
      : "flex-col w-full gap-3 p-4 rounded-xl bg-white border-[#E4E4E7] transition-colors duration-200 ease-out")}>
      {props.title ? <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>{props.title}</Text> : null}
      {props.detail ? <MobileParagraph text={props.detail} class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"} /> : null}
      {props.children}
    </ScrollContourItem>
  );
}

export interface MobileButtonProps {
  label: string;
  onPress?: () => void;
  kind?: "filled" | "tonal" | "outlined" | "text" | "danger";
  compact?: boolean;
  class?: string;
  /** Optional label skin for semantic actions such as an iOS destructive text action. */
  labelClass?: string;
  style?: ViewProps["style"];
  debugName?: string;
  disabled?: boolean;
}

export function MobileButton(props: MobileButtonProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const density = useDesignDensity();
  const kind = () => props.kind ?? "filled";
  const isCompact = () => props.compact === true || density() === "desktop";
  const accentTextStyle = () => props.class === undefined && kind() === "text"
    ? { textColor: accentInkColor(theme()) }
    : {};
  const filledBgStyle = () => props.class === undefined && kind() === "filled"
    ? { bgColor: accentColor(theme()) }
    : {};
  return (
    <Focusable
      class={props.class ?? (kind() === "outlined"
        ? (theme().name === "dark"
          ? (isCompact()
            ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#09090B] border-[#27272A] focus:bg-[#18181B] active:bg-[#27272A] transition-colors duration-150 ease-out"
            : "px-4 h-[44] items-center justify-center rounded-lg bg-[#09090B] border-[#27272A] focus:bg-[#18181B] active:bg-[#27272A] transition-colors duration-150 ease-out")
          : (isCompact()
            ? "px-3 h-[36] items-center justify-center rounded-lg bg-white border-[#E4E4E7] focus:bg-[#F4F4F5] active:bg-[#E4E4E7] transition-colors duration-150 ease-out"
            : "px-4 h-[44] items-center justify-center rounded-lg bg-white border-[#E4E4E7] focus:bg-[#F4F4F5] active:bg-[#E4E4E7] transition-colors duration-150 ease-out"))
        : kind() === "tonal"
          ? (theme().name === "dark"
            ? (isCompact()
               ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#27272A] focus:bg-[#3F3F46] active:bg-[#52525B] transition-colors duration-150 ease-out"
               : "px-4 h-[44] items-center justify-center rounded-lg bg-[#27272A] focus:bg-[#3F3F46] active:bg-[#52525B] transition-colors duration-150 ease-out")
            : (isCompact()
               ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#F4F4F5] focus:bg-[#E4E4E7] active:bg-[#D4D4D8] transition-colors duration-150 ease-out"
               : "px-4 h-[44] items-center justify-center rounded-lg bg-[#F4F4F5] focus:bg-[#E4E4E7] active:bg-[#D4D4D8] transition-colors duration-150 ease-out"))
          : kind() === "text"
            ? (theme().name === "dark"
              ? (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-lg bg-transparent focus:bg-[#27272A] active:bg-[#3F3F46] transition-colors duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-lg bg-transparent focus:bg-[#27272A] active:bg-[#3F3F46] transition-colors duration-150 ease-out")
              : (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-lg bg-transparent focus:bg-[#F4F4F5] active:bg-[#E4E4E7] transition-colors duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-lg bg-transparent focus:bg-[#F4F4F5] active:bg-[#E4E4E7] transition-colors duration-150 ease-out"))
            : kind() === "danger"
              ? (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#DC2626] focus:bg-[#B91C1C] active:bg-[#991B1B] transition-colors duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-lg bg-[#DC2626] focus:bg-[#B91C1C] active:bg-[#991B1B] transition-colors duration-150 ease-out")
              : (theme().name === "dark"
                ? (isCompact()
                  ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#FAFAFA] focus:bg-[#E4E4E7] active:bg-[#D4D4D8] transition-colors duration-150 ease-out"
                  : "px-4 h-[44] items-center justify-center rounded-lg bg-[#FAFAFA] focus:bg-[#E4E4E7] active:bg-[#D4D4D8] transition-colors duration-150 ease-out")
                : (isCompact()
                  ? "px-3 h-[36] items-center justify-center rounded-lg bg-[#18181B] focus:bg-[#27272A] active:bg-[#3F3F46] transition-colors duration-150 ease-out"
                  : "px-4 h-[44] items-center justify-center rounded-lg bg-[#18181B] focus:bg-[#27272A] active:bg-[#3F3F46] transition-colors duration-150 ease-out")))}
      style={props.disabled
        ? { ...filledBgStyle(), ...(props.style ?? {}), opacity: props.style?.opacity ?? 0.5 }
        : { ...filledBgStyle(), ...(props.style ?? {}), opacity: props.style?.opacity ?? 1 }}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text
        class={props.labelClass ?? (kind() === "filled"
          ? "text-xs text-[#FAFAFA] font-bold"
          : kind() === "danger"
            ? "text-xs text-[#FAFAFA] font-bold"
            : kind() === "tonal"
              ? (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#18181B] font-bold")
              : theme().name === "dark"
                ? "text-xs text-[#FAFAFA] font-bold"
                : "text-xs text-[#09090B] font-bold")}
        style={{ ...(props.labelClass === undefined ? accentTextStyle() : {}), translateY: 1 }}
      >{props.label}</Text>
    </Focusable>
  );
}

interface MobileButtonAliasProps {
  label: string;
  onPress?: () => void;
  compact?: boolean;
  class?: string;
  style?: ViewProps["style"];
  debugName?: string;
  disabled?: boolean;
}

function mobileButtonAlias(props: MobileButtonAliasProps, kind: MobileButtonProps["kind"]): JSX.Element {
  return (
    <MobileButton
      label={props.label}
      onPress={props.onPress}
      compact={props.compact}
      class={props.class}
      style={props.style}
      debugName={props.debugName}
      disabled={props.disabled}
      kind={kind}
    />
  );
}

export const MobileFilledButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "filled");
export const MobileTonalButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "tonal");
export const MobileOutlinedButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "outlined");
export const MobileTextButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "text");
export const MobileDangerButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "danger");

export function MobileBadge(props: { label: string; tone?: "accent" | "success" | "warning" | "danger" | "neutral" | "outline" }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const tone = () => props.tone ?? "accent";
  return (
    <View
      class={tone() === "success"
        ? (theme().name === "dark"
          ? "h-[24] px-2.5 flex-row items-center justify-center bg-[#18181B] border-[#27272A] transition-colors duration-150 ease-out"
          : "h-[24] px-2.5 flex-row items-center justify-center bg-[#F4F4F5] border-[#E4E4E7] transition-colors duration-150 ease-out")
        : tone() === "warning"
          ? (theme().name === "dark"
            ? "h-[24] px-2.5 flex-row items-center justify-center bg-[#18181B] border-[#27272A] transition-colors duration-150 ease-out"
            : "h-[24] px-2.5 flex-row items-center justify-center bg-[#F4F4F5] border-[#E4E4E7] transition-colors duration-150 ease-out")
          : tone() === "danger"
            ? "h-[24] px-2.5 flex-row items-center justify-center bg-[#DC2626] transition-colors duration-150 ease-out"
            : tone() === "outline"
              ? (theme().name === "dark"
                ? "h-[24] px-2.5 flex-row items-center justify-center bg-transparent border-[#27272A] transition-colors duration-150 ease-out"
                : "h-[24] px-2.5 flex-row items-center justify-center bg-transparent border-[#E4E4E7] transition-colors duration-150 ease-out")
              : tone() === "neutral"
                ? (theme().name === "dark"
                  ? "h-[24] px-2.5 flex-row items-center justify-center bg-[#27272A] transition-colors duration-150 ease-out"
                  : "h-[24] px-2.5 flex-row items-center justify-center bg-[#F4F4F5] transition-colors duration-150 ease-out")
                : (theme().name === "dark"
                  ? "h-[24] px-2.5 flex-row items-center justify-center bg-[#FAFAFA] transition-colors duration-150 ease-out"
                  : "h-[24] px-2.5 flex-row items-center justify-center bg-[#18181B] transition-colors duration-150 ease-out")}
      style={{
        minW: 24,
        radius: 6,
        ...(tone() === "accent" ? { bgColor: accentColor(theme()) } : {}),
      }}
    >
      <Text
        class={tone() === "success"
          ? (theme().name === "dark" ? "text-xs text-[#4ADE80] font-bold" : "text-xs text-[#15803D] font-bold")
          : tone() === "warning"
            ? (theme().name === "dark" ? "text-xs text-[#FBBF24] font-bold" : "text-xs text-[#B45309] font-bold")
            : tone() === "danger"
              ? "text-xs text-[#FAFAFA] font-bold"
              : tone() === "outline" || tone() === "neutral"
                ? (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#18181B] font-bold")
                : "text-xs text-[#FAFAFA] font-bold"}
        style={{ translateY: 1 }}
      >{props.label}</Text>
    </View>
  );
}

export function MobileTag(props: {
  label: string;
  tone?: "accent" | "success" | "warning" | "danger" | "neutral";
  selected?: boolean;
  closable?: boolean;
  onPress?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const progress = useStateTransition(() => `${props.selected ?? false}:${props.tone ?? "accent"}`, 8, false);
  const content = (
    <View
      class={props.selected
        ? (theme().name === "dark"
          ? "h-[28] px-3 flex-row items-center justify-center gap-1 bg-[#FAFAFA] border-[#FAFAFA] transition-colors duration-150 ease-spring"
          : "h-[28] px-3 flex-row items-center justify-center gap-1 bg-[#18181B] border-[#18181B] transition-colors duration-150 ease-spring")
        : theme().name === "dark"
          ? "h-[28] px-3 flex-row items-center justify-center gap-1 bg-[#09090B] border-[#27272A] transition-colors duration-150 ease-spring"
          : "h-[28] px-3 flex-row items-center justify-center gap-1 bg-white border-[#E4E4E7] transition-colors duration-150 ease-spring"}
      style={{
        minW: 28,
        radius: 6,
        opacity: 0.72 + 0.28 * progress(),
        translateY: Math.round((1 - progress()) * -2),
      }}
    >
      <Text
        class={props.selected
          ? (theme().name === "dark" ? "text-xs text-[#18181B] font-bold" : "text-xs text-[#FAFAFA] font-bold")
          : theme().name === "dark"
            ? "text-xs text-[#A1A1AA] font-bold"
            : "text-xs text-[#09090B] font-bold"}
        style={{ translateY: 1 }}
      >{props.label}</Text>
      {props.closable ? (
        <Text
          class={props.selected
            ? (theme().name === "dark" ? "text-xs text-[#18181B] font-bold" : "text-xs text-[#FAFAFA] font-bold")
            : "text-xs text-[#71717A] font-bold"}
          style={{ translateY: 1 }}
        >×</Text>
      ) : null}
    </View>
  );
  if (props.onPress || props.onClose) {
    return (
      <Focusable
        class="transition-opacity duration-150 ease-out"
        style={{ radius: 6 }}
        onPress={() => {
          if (props.onPress) props.onPress();
          else if (props.onClose) props.onClose();
        }}
      >
        {content}
      </Focusable>
    );
  }
  return content;
}

export function MobileAvatar(props: {
  label: string;
  tone?: "accent" | "success" | "warning" | "danger";
  status?: "online" | "busy" | "offline";
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const tone = () => props.tone ?? "accent";
  return (
    <View class="relative w-[40] h-[40]">
      <View
        class={tone() === "accent"
          ? (theme().name === "dark"
            ? "w-[40] h-[40] items-center justify-center bg-[#FAFAFA] border-[#27272A] transition-colors duration-200 ease-out"
            : "w-[40] h-[40] items-center justify-center bg-[#18181B] border-[#E4E4E7] transition-colors duration-200 ease-out")
          : (theme().name === "dark"
            ? "w-[40] h-[40] items-center justify-center bg-[#27272A] border-[#3F3F46] transition-colors duration-200 ease-out"
            : "w-[40] h-[40] items-center justify-center bg-[#F4F4F5] border-[#E4E4E7] transition-colors duration-200 ease-out")}
        style={{ radius: 19 }}
      >
        <Text
          class={tone() === "accent"
            ? (theme().name === "dark" ? "text-xs text-[#18181B] font-bold" : "text-xs text-[#FAFAFA] font-bold")
            : (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold")}
          style={{ translateY: 1 }}
        >{props.label}</Text>
      </View>
      {props.status ? (
        <View
          class={props.status === "online"
            ? "absolute right-0 bottom-0 w-[10] h-[10] bg-emerald-500 border-white"
            : props.status === "busy"
              ? "absolute right-0 bottom-0 w-[10] h-[10] bg-rose-500 border-white"
              : "absolute right-0 bottom-0 w-[10] h-[10] bg-[#71717A] border-white"}
          style={{ radius: 4 }}
        />
      ) : null}
    </View>
  );
}

export function MobileListTile(props: {
  title: string;
  detail?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  onPress?: () => void;
  selected?: boolean;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const body = (
    <ScrollContourItem
      class={props.selected
      ? (theme().name === "dark"
        ? "flex-row items-center gap-3 w-full px-3 py-3 rounded-lg bg-[#27272A] border-[#FAFAFA] transition-colors duration-200 ease-out"
        : "flex-row items-center gap-3 w-full px-3 py-3 rounded-lg bg-[#F4F4F5] border-[#18181B] transition-colors duration-200 ease-out")
      : theme().name === "dark"
        ? "flex-row items-center gap-3 w-full px-3 py-3 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out"
        : "flex-row items-center gap-3 w-full px-3 py-3 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-out"}
    >
      {props.leading}
      <View class="flex-col gap-1 flex-1">
        <Text
          class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}
        >{props.title}</Text>
        {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{wrapTextLines(props.detail, 36, 220)}</Text> : null}
      </View>
      {props.trailing}
    </ScrollContourItem>
  );
  return props.onPress
    ? <Focusable class="w-full rounded-lg transition-opacity duration-150 ease-out" onPress={props.onPress}>{body}</Focusable>
    : body;
}

export function MobileSegmentedControl(props: {
  items: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  /** Highlight the active pill with the theme's primary accent color. */
  accentActive?: boolean;
}): JSX.Element {
  const routeActive = useRouteActive();
  const theme = useMobileThemeAccessor();
  const scaffold = useContext(SafeAreaScaffoldContext);
  let trackNode: { id: number } | undefined;
  const currentViewportWidth = (): number => {
    const geometryWidth = scaffold.geometry().width;
    const viewportWidth = layoutGlobal.ui?.__viewport?.w;
    return typeof viewportWidth === "number" && Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : geometryWidth > 0
        ? geometryWidth
        : 390;
  };
  let lastViewportWidth = currentViewportWidth();
  let layoutReadArmed = false;
  const [measuredWidth, setMeasuredWidth] = createSignal(0);
  const syncWidth = (): void => {
    const nextViewportW = currentViewportWidth();
    if (nextViewportW !== lastViewportWidth) {
      lastViewportWidth = nextViewportW;
      layoutReadArmed = false;
      if (measuredWidth() !== 0) setMeasuredWidth(0);
      return;
    }
    if (!layoutReadArmed) {
      layoutReadArmed = true;
      return;
    }
    if (measuredWidth() > 0) return;
    const w = readNodeWidth(trackNode);
    if (w !== undefined && w > 0 && Math.abs(w - measuredWidth()) >= 1) {
      setMeasuredWidth(w);
    }
  };
  createEffect(() => {
    props.active;
    props.items.length;
    const nextViewportW = currentViewportWidth();
    if (nextViewportW !== lastViewportWidth) {
      lastViewportWidth = nextViewportW;
      layoutReadArmed = false;
      setMeasuredWidth(0);
    }
  });
  try {
    onFrame(() => {
      if (routeActive()) syncWidth();
    }, {
      active: () => routeActive() && (measuredWidth() <= 0 || currentViewportWidth() !== lastViewportWidth),
      continuous: () => routeActive() && (measuredWidth() <= 0 || currentViewportWidth() !== lastViewportWidth),
    });
  } catch {
    // Ignore when no frame scheduler is active.
  }
  const count = () => Math.max(1, props.items.length);
  const activeIndex = () => {
    const idx = props.items.findIndex((item) => item.id === props.active);
    return idx >= 0 ? idx : 0;
  };
  const totalTrackWidth = () => {
    const measured = measuredWidth();
    if (measured > 0) return measured;
    return Math.max(120, currentViewportWidth() - 36);
  };
  const segmentWidth = () => Math.max(40, Math.round(totalTrackWidth() / count()));
  const targetX = () => Math.round(activeIndex() * (totalTrackWidth() / count()));
  const indicatorX = useAnimatedNumber(targetX, 0.38);

  return (
    <ScrollContourItem
      class={theme().name === "dark"
        ? "w-full p-[3] rounded-lg bg-[#27272A] transition-colors duration-200 ease-out"
        : "w-full p-[3] rounded-lg bg-[#F4F4F5] transition-colors duration-200 ease-out"}
      style={{ minW: 24, radius: 8 }}
    >
      <View
        ref={(current) => {
          trackNode = current;
          syncWidth();
        }}
        class="relative flex-row items-center w-full h-[32]"
      >
        <View
          style={{
            posType: 1,
            insetT: 8,
            insetL: Math.round(indicatorX() + Math.max(0, segmentWidth() / 2 - 14)),
            width: 28,
            height: 16,
            bgColor: accentColor(theme()),
          }}
        />
        <View
          class={theme().name === "dark"
            ? "h-[32] bg-[#09090B] border-[#3F3F46] transition-colors duration-200 ease-out"
            : "h-[32] bg-white border-[#E4E4E7] transition-colors duration-200 ease-out"}
          style={{
            posType: 1,
            insetT: 0,
            insetL: 0,
            width: segmentWidth(),
            radius: 6,
            translateX: Math.round(indicatorX()),
            ...(props.accentActive ? { bgColor: accentColor(theme()) } : {}),
          }}
        />
        <For each={props.items}>
          {(item) => {
            const isSelected = () => props.active === item.id;
            return (
              <Focusable
                class="flex-1 h-[32] items-center justify-center bg-transparent"
                style={{ radius: 6 }}
                onPress={() => {
                  syncWidth();
                  props.onChange(item.id);
                }}
              >
                <Text
                  class={isSelected()
                    ? (props.accentActive
                      ? "text-xs text-[#FAFAFA] font-bold"
                      : (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"))
                    : (theme().name === "dark" ? "text-xs text-[#A1A1AA] font-bold" : "text-xs text-[#71717A] font-bold")}
                  style={{ translateY: 1 }}
                >
                  {item.label}
                </Text>
              </Focusable>
            );
          }}
        </For>
      </View>
    </ScrollContourItem>
  );
}

export interface MobileSwitchProps {
  value: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** External pending work also parks the thumb at the loading midpoint. */
  loading?: boolean;
  /** Commit only when the asynchronous guard succeeds; false/rejection rolls back. */
  onBeforeChange?: (value: boolean) => boolean | Promise<boolean>;
  onError?: (error: unknown) => void;
}

export function MobileSwitch(props: MobileSwitchProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const density = useDesignDensity();
  const routeActive = useRouteActive();
  const [pending, setPending] = createSignal(false);
  const [spinnerPhase, setSpinnerPhase] = createSignal(0);
  const busy = () => props.loading === true || pending();
  const thumbX = useAnimatedNumber(() => busy() ? 10 : props.value ? 20 : 0, 0.24, 280);
  const spinnerOpacity = () => Math.max(0, 1 - Math.abs(thumbX() - 10) / 3);
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const toggle = async (): Promise<void> => {
    if (busy() || props.disabled || !routeActive()) return;
    const previousValue = props.value;
    const next = !previousValue;
    if (!props.onBeforeChange) {
      props.onChange(next);
      return;
    }
    setPending(true);
    try {
      const allowed = await props.onBeforeChange(next);
      if (!disposed && allowed && props.value === previousValue) props.onChange(next);
    } catch (error) {
      if (!disposed) props.onError?.(error);
    } finally {
      if (!disposed) setPending(false);
    }
  };
  onFrame(() => {
    if (busy()) setSpinnerPhase((phase) => (phase + 1) % 24);
  }, { active: routeActive, continuous: busy });
  return (
    <Focusable
      onPress={() => { void toggle(); }}
      focusable={!props.disabled && !busy()}
      style={{ opacity: props.disabled ? 0.5 : 1 }}
      class={theme().name === "dark"
        ? (density() === "desktop"
          ? "flex-row items-center justify-between gap-3 w-full h-[36] px-3 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out"
          : "flex-row items-center justify-between gap-3 w-full h-[44] px-3 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out")
        : (density() === "desktop"
          ? "flex-row items-center justify-between gap-3 w-full h-[36] px-3 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-out"
          : "flex-row items-center justify-between gap-3 w-full h-[44] px-3 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-out")}
    >
      {props.label ? <Text class={theme().name === "dark" ? "text-[#FAFAFA] text-xs font-bold" : "text-[#09090B] text-xs font-bold"}>{props.label}</Text> : null}
      <View
        class={props.value
          ? (theme().name === "dark"
            ? "w-[48] h-[28] p-[2] flex-row items-center bg-[#FAFAFA] transition-colors duration-300 ease-out"
            : "w-[48] h-[28] p-[2] flex-row items-center bg-[#18181B] transition-colors duration-300 ease-out")
          : theme().name === "dark"
            ? "w-[48] h-[28] p-[2] flex-row items-center bg-[#27272A] transition-colors duration-300 ease-out"
            : "w-[48] h-[28] p-[2] flex-row items-center bg-[#E4E4E7] transition-colors duration-300 ease-out"}
        style={{
          minW: 48,
          radius: 13,
          ...(props.value ? { bgColor: accentColor(theme()) } : {}),
        }}
      >
        <View
          class="relative w-[24] h-[24] bg-white"
          style={{ radius: 11, translateX: thumbX() }}
        >
          <Show when={busy()}>
            <View class="absolute left-[6] top-[6] w-[12] h-[12]">
              <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{(index) => (
                <View class="absolute w-[2] h-[2]" style={{
                  insetL: 5 + Math.cos(index * Math.PI / 4) * 4,
                  insetT: 5 + Math.sin(index * Math.PI / 4) * 4,
                  radius: 1,
                  bgColor: "#18181B",
                  opacity: spinnerOpacity() * (0.2 + 0.8 * ((index + Math.floor(spinnerPhase() / 3)) % 8) / 7),
                }} />
              )}</For>
            </View>
          </Show>
        </View>
      </View>
    </Focusable>
  );
}

export function MobileStepper(props: { value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const step = props.step ?? 1;
  const set = (next: number): void => props.onChange(Math.max(min, Math.min(max, next)));
  const ratio = () => Math.max(0, Math.min(1, (props.value - min) / Math.max(1, max - min)));
  const animatedRatio = useAnimatedNumber(ratio, 0.24, 240);
  return (
    <View class="flex-row items-center gap-2">
      <MobileOutlinedButton label="−" compact onPress={() => set(props.value - step)} />
      <View
        class={theme().name === "dark" ? "relative flex-1 h-[8] bg-[#27272A] overflow-hidden" : "relative flex-1 h-[8] bg-[#F4F4F5] overflow-hidden"}
        style={{ radius: 4 }}
      >
        <View
          class="h-[8] bg-[#315DEB]"
          style={{
            width: -1,
            radius: 4,
            scaleX: Math.max(0.02, animatedRatio()),
            originX: -0.5,
            bgColor: accentColor(theme()),
          }}
        />
        <View
          class={theme().name === "dark" ? "h-[8] bg-[#FAFAFA]" : "h-[8] bg-[#18181B]"}
          style={{
            posType: 1,
            insetT: 0,
            insetL: 0,
            width: -1,
            radius: 4,
            scaleX: Math.max(0.02, animatedRatio()),
            originX: -0.5,
          }}
        />
      </View>
      <MobileOutlinedButton label="+" compact onPress={() => set(props.value + step)} />
      <Text class={theme().name === "dark" ? "text-[#FAFAFA] text-xs font-bold" : "text-[#09090B] text-xs font-bold"}>{String(props.value)}</Text>
    </View>
  );
}

export function MobileProgress(props: {
  value: number;
  max?: number;
  label?: string;
  tone?: "accent" | "success" | "warning" | "danger";
  animated?: boolean;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const max = () => Math.max(1, props.max ?? 100);
  const ratio = () => Math.max(0, Math.min(1, props.value / max()));
  const animatedTarget = () => (props.animated === false ? 0 : ratio());
  const animatedRatio = useAnimatedNumber(animatedTarget, 0.24, 240);
  const effectiveRatio = () => (props.animated === false ? ratio() : animatedRatio());
  const pct = () => `${Math.round((props.animated ? effectiveRatio() : ratio()) * 100)}%`;
  const tone = () => props.tone ?? "accent";
  return (
    <View class="flex-col gap-1.5 w-full">
      {props.label ? (
        <View class="flex-row items-center justify-between">
          <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA] font-bold" : "text-xs text-[#71717A] font-bold"}>{props.label}</Text>
          <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{pct()}</Text>
        </View>
      ) : null}
      <View
        class={theme().name === "dark" ? "w-full h-[8] bg-[#27272A] overflow-hidden" : "w-full h-[8] bg-[#F4F4F5] overflow-hidden"}
        style={{ radius: 4 }}
      >
        <View
          class={tone() === "danger"
            ? "h-[8] bg-[#DC2626] transition-colors duration-200 ease-out"
            : theme().name === "dark"
              ? "h-[8] bg-[#FAFAFA] transition-colors duration-200 ease-out"
              : "h-[8] bg-[#18181B] transition-colors duration-200 ease-out"}
          style={{
            width: -1,
            radius: 4,
            scaleX: Math.max(0.02, effectiveRatio()),
            originX: -0.5,
          }}
        />
      </View>
    </View>
  );
}

export function MobileCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail?: string;
  disabled?: boolean;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const progress = useStateTransition(() => props.checked, 8, false);
  const boxScale = () => 0.75 + 0.25 * progress();
  return (
    <Focusable
      class={props.checked
        ? (theme().name === "dark"
          ? "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#18181B] border-[#FAFAFA] transition-colors duration-150 ease-out"
          : "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#FAFAFA] border-[#18181B] transition-colors duration-150 ease-out")
        : (theme().name === "dark"
          ? "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-150 ease-out"
          : "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-150 ease-out")}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : () => props.onChange(!props.checked)}
    >
      <View
        class={props.checked
          ? (theme().name === "dark"
            ? "w-[18] h-[18] items-center justify-center bg-[#FAFAFA] border-[#FAFAFA] transition-colors duration-150 ease-spring"
            : "w-[18] h-[18] items-center justify-center bg-[#18181B] border-[#18181B] transition-colors duration-150 ease-spring")
          : theme().name === "dark"
            ? "w-[18] h-[18] items-center justify-center bg-[#09090B] border-[#3F3F46] transition-colors duration-150 ease-spring"
            : "w-[18] h-[18] items-center justify-center bg-white border-[#D4D4D8] transition-colors duration-150 ease-spring"}
        style={{
          radius: 4,
          opacity: 0.75 + 0.25 * progress(),
        }}
      >
        {props.checked ? (
          <View
            class={theme().name === "dark" ? "w-[8] h-[8] bg-[#09090B]" : "w-[8] h-[8] bg-[#FAFAFA]"}
            style={{ radius: 2, scale: boxScale() }}
          />
        ) : null}
      </View>
      <View class="flex-col gap-0.5 flex-1">
        <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{props.label}</Text>
        {props.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#A1A1AA]" : "text-2xs text-[#71717A]"}>{wrapTextLines(props.detail, 42, 240)}</Text> : null}
      </View>
    </Focusable>
  );
}

export function MobileRadioGroup(props: {
  items: readonly { id: string; label: string; detail?: string }[];
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const progress = useStateTransition(() => props.value, 8, false);
  const dotScale = () => 0.75 + 0.25 * progress();
  return (
    <View class="flex-col gap-2">
      <For each={props.items}>
        {(item) => {
          const active = () => props.value === item.id;
          return (
            <Focusable
              class={active()
                ? (theme().name === "dark"
                  ? "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#18181B] border-[#FAFAFA] transition-colors duration-150 ease-out"
                  : "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#FAFAFA] border-[#18181B] transition-colors duration-150 ease-out")
                : (theme().name === "dark"
                  ? "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-150 ease-out"
                  : "flex-row items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-150 ease-out")}
              onPress={() => props.onChange(item.id)}
            >
              <View
                class={active()
                  ? (theme().name === "dark"
                    ? "w-[18] h-[18] items-center justify-center bg-[#09090B] border-[#FAFAFA] transition-colors duration-150 ease-spring"
                    : "w-[18] h-[18] items-center justify-center bg-white border-[#18181B] transition-colors duration-150 ease-spring")
                  : theme().name === "dark"
                    ? "w-[18] h-[18] items-center justify-center bg-[#09090B] border-[#3F3F46] transition-colors duration-150 ease-spring"
                    : "w-[18] h-[18] items-center justify-center bg-white border-[#D4D4D8] transition-colors duration-150 ease-spring"}
                style={{ radius: 8 }}
              >
                {active() ? (
                  <View
                    class={theme().name === "dark" ? "w-[8] h-[8] bg-[#FAFAFA]" : "w-[8] h-[8] bg-[#18181B]"}
                    style={{ radius: 3, opacity: dotScale() }}
                  />
                ) : null}
              </View>
              <View class="flex-col gap-0.5 flex-1">
                <Text
                  class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}
                >{item.label}</Text>
                {item.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#A1A1AA]" : "text-2xs text-[#71717A]"}>{wrapTextLines(item.detail, 42, 240)}</Text> : null}
              </View>
            </Focusable>
          );
        }}
      </For>
    </View>
  );
}

export function MobileAccordion(props: {
  title: string;
  detail?: string;
  badge?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const progress = useStateTransition(() => props.expanded, 10, false);
  return (
    <ScrollContourItem class={theme().name === "dark"
      ? "flex-col gap-2 p-3 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out"
      : "flex-col gap-2 p-3 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-out"}>
      <Focusable
        class="flex-row items-center justify-between gap-2 w-full py-1 rounded-md transition-opacity duration-150 ease-out"
        onPress={props.onToggle}
      >
        <View class="flex-col gap-1 flex-1">
          <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>{props.title}</Text>
          {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{wrapTextLines(props.detail, 34, 210)}</Text> : null}
        </View>
        <View class="flex-row items-center gap-2">
          {props.badge ? <MobileBadge label={props.badge} tone="neutral" /> : null}
          <View
            class={theme().name === "dark"
              ? "w-[24] h-[24] items-center justify-center bg-[#18181B] border-[#27272A] transition-colors duration-200 ease-spring"
              : "w-[24] h-[24] items-center justify-center bg-[#F4F4F5] border-[#E4E4E7] transition-colors duration-200 ease-spring"}
            style={{ radius: 6, translateY: Math.round((1 - progress()) * -2) }}
          >
            <Text
              class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}
              style={{ translateY: 1 }}
            >
              {props.expanded ? "▾" : "›"}
            </Text>
          </View>
        </View>
      </Focusable>
      <Show when={props.expanded}>
        <View
          class="flex-col gap-2 w-full pt-2 transition-opacity duration-200 ease-out"
          style={{
            opacity: progress(),
            translateY: Math.round((1 - progress()) * -6),
          }}
        >
          <View class={theme().name === "dark" ? "w-full h-[1] bg-[#27272A]" : "w-full h-[1] bg-[#E4E4E7]"} />
          {props.children}
        </View>
      </Show>
    </ScrollContourItem>
  );
}

export function MobileSkeleton(props: {
  rows?: number;
  avatar?: boolean;
  active?: boolean;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const progress = useStateTransition(() => `${props.active !== false}:${props.rows ?? 3}:${props.avatar !== false}`, 14, false);
  const pulseOpacity = () => {
    const base = props.active === false ? 0.55 : 0.92;
    return base * progress();
  };
  const count = () => Math.max(1, Math.min(5, props.rows ?? 3));
  const indices = () => Array.from({ length: count() }, (_, idx) => idx);
  return (
    <View
      class="flex-row items-center gap-3 w-full transition-opacity duration-300 ease-in-out"
      style={{ opacity: pulseOpacity() }}
    >
      {props.avatar !== false ? (
        <View
          class={theme().name === "dark" ? "w-[40] h-[40] bg-[#27272A]" : "w-[40] h-[40] bg-[#F4F4F5]"}
          style={{ radius: 19 }}
        />
      ) : null}
      <View class="flex-col gap-2 flex-1">
        <For each={indices()}>
          {(idx) => (
            <View
              class={theme().name === "dark" ? "w-full h-[12] bg-[#27272A]" : "w-full h-[12] bg-[#F4F4F5]"}
              style={{
                radius: 6,
                scaleX: idx === 0 ? 0.75 : idx % 2 === 1 ? 1 : 0.55,
                originX: -0.5,
              }}
            />
          )}
        </For>
      </View>
    </View>
  );
}

export function MobileAlert(props: {
  open?: boolean | (() => boolean);
  title: string;
  body?: string;
  tone?: "info" | "success" | "warning" | "danger";
  closable?: boolean;
  onClose?: () => void;
  actionLabel?: string;
  onAction?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const routeActive = useRouteActive();
  const isOpen = () => routeActive() && (props.open === undefined ? true : typeof props.open === "function" ? props.open() : props.open);
  const tone = () => props.tone ?? "info";
  let textColumnNode: { id: number } | undefined;
  const [textColumnWidth, setTextColumnWidth] = createSignal(0);
  const [needsMeasurement, setNeedsMeasurement] = createSignal(false);
  const syncTextColumnWidth = (): void => {
    const measured = readNodeWidth(textColumnNode);
    if (measured !== undefined && measured > 0) {
      if (Math.abs(measured - textColumnWidth()) >= 1) setTextColumnWidth(measured);
      setNeedsMeasurement(false);
    }
  };
  createEffect(() => {
    setNeedsMeasurement(isOpen());
  });
  try {
    onFrame(() => {
      if (isOpen() && needsMeasurement()) syncTextColumnWidth();
      else setNeedsMeasurement(false);
    }, {
      active: () => routeActive() && needsMeasurement(),
      continuous: () => routeActive() && needsMeasurement(),
    });
  } catch {
    // Ignore when no frame scheduler is active.
  }
  const textMaxWidth = () => textColumnWidth() > 0 ? textColumnWidth() : 190;
  const progress = useStateTransition(() => `${isOpen()}:${tone()}:${props.title}`, 10, false);
  const iconGlyph = () => (tone() === "success" ? "✓" : tone() === "warning" ? "!" : tone() === "danger" ? "×" : "i");
  const hasActions = () => Boolean(
    (props.actionLabel && props.onAction) || (props.closable && props.onClose),
  );
  return (
    <Show when={isOpen()}>
      <ScrollContourItem
        class={tone() === "danger"
          ? (theme().name === "dark"
            ? "flex-col gap-2 w-full p-3.5 rounded-lg bg-[#09090B] border-[#7F1D1D] transition-colors duration-200 ease-out"
            : "flex-col gap-2 w-full p-3.5 rounded-lg bg-white border-[#EF4444] transition-colors duration-200 ease-out")
          : (theme().name === "dark"
            ? "flex-col gap-2 w-full p-3.5 rounded-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-out"
            : "flex-col gap-2 w-full p-3.5 rounded-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-out")}
        style={{
          opacity: progress(),
          translateY: Math.round((1 - progress()) * -6),
        }}
      >
        <View class="flex-row items-start gap-3 w-full">
          <View
            class={tone() === "danger"
              ? "w-[22] h-[22] items-center justify-center bg-[#DC2626]"
              : theme().name === "dark"
                ? "w-[22] h-[22] items-center justify-center bg-[#27272A] border-[#3F3F46]"
                : "w-[22] h-[22] items-center justify-center bg-[#F4F4F5] border-[#E4E4E7]"}
            style={{
              minW: 22,
              radius: 6,
            }}
          >
            <Text
              class={tone() === "danger"
                ? "text-xs text-[#FAFAFA] font-bold"
                : theme().name === "dark"
                  ? "text-xs text-[#FAFAFA] font-bold"
                  : "text-xs text-[#09090B] font-bold"}
              style={{ translateY: 1 }}
            >{iconGlyph()}</Text>
          </View>
          <View
            ref={(current) => {
              textColumnNode = current;
              syncTextColumnWidth();
            }}
            class="flex-col gap-1 flex-1"
            style={{ minW: 0 }}
          >
            <Text
              class={tone() === "danger"
                ? (theme().name === "dark" ? "text-xs text-[#F87171] font-bold" : "text-xs text-[#DC2626] font-bold")
                : (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold")}
            >{wrapTextLines(props.title, 36, textMaxWidth())}</Text>
            {props.body ? <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{wrapTextLines(props.body, 42, textMaxWidth())}</Text> : null}
            {props.children}
          </View>
        </View>
        <Show when={hasActions()}>
          <View class="flex-row flex-wrap items-center justify-end gap-2 w-full">
            {props.actionLabel && props.onAction ? (
              <MobileButton label={props.actionLabel} compact kind="outlined" onPress={props.onAction} />
            ) : null}
            {props.closable && props.onClose ? (
              <MobileTextButton label="Dismiss" compact onPress={props.onClose} />
            ) : null}
          </View>
        </Show>
      </ScrollContourItem>
    </Show>
  );
}

export function MobileToast(props: {
  open: boolean | (() => boolean);
  message: string;
  detail?: string;
  tone?: "info" | "success" | "warning" | "danger";
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const routeActive = useRouteActive();
  const isOpen = () => routeActive() && (typeof props.open === "function" ? props.open() : props.open);
  const tone = () => props.tone ?? "info";
  let textColumnNode: { id: number } | undefined;
  const [textColumnWidth, setTextColumnWidth] = createSignal(0);
  const [needsMeasurement, setNeedsMeasurement] = createSignal(false);
  const syncTextColumnWidth = (): void => {
    const measured = readNodeWidth(textColumnNode);
    if (measured !== undefined && measured > 0) {
      if (Math.abs(measured - textColumnWidth()) >= 1) setTextColumnWidth(measured);
      setNeedsMeasurement(false);
    }
  };
  createEffect(() => {
    setNeedsMeasurement(isOpen());
  });
  try {
    onFrame(() => {
      if (isOpen() && needsMeasurement()) syncTextColumnWidth();
      else setNeedsMeasurement(false);
    }, {
      active: () => routeActive() && needsMeasurement(),
      continuous: () => routeActive() && needsMeasurement(),
    });
  } catch {
    // Ignore when no frame scheduler is active.
  }
  const textMaxWidth = () => textColumnWidth() > 0 ? textColumnWidth() : 190;
  const progress = useStateTransition(() => `${isOpen()}:${tone()}:${props.message}`, 10, false);
  const badgeGlyph = () => (tone() === "success" ? "✓" : tone() === "warning" ? "!" : tone() === "danger" ? "×" : "i");
  const hasActions = () => Boolean((props.actionLabel && props.onAction) || props.onClose);
  return (
    <Show when={isOpen()}>
      <ScrollContourItem
        class={theme().name === "dark"
          ? "flex-col gap-2 w-full px-4 py-3 rounded-lg shadow-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-spring"
          : "flex-col gap-2 w-full px-4 py-3 rounded-lg shadow-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-spring"}
        style={{
          opacity: progress(),
          translateY: Math.round((1 - progress()) * -8),
        }}
      >
        <View class="flex-row items-start gap-3 w-full">
          <View
            class={tone() === "danger"
              ? "w-[22] h-[22] items-center justify-center bg-[#DC2626]"
              : theme().name === "dark"
                ? "w-[22] h-[22] items-center justify-center bg-[#FAFAFA]"
                : "w-[22] h-[22] items-center justify-center bg-[#18181B]"}
            style={{
              minW: 22,
              radius: 6,
            }}
          >
            <Text
              class={tone() === "danger"
                ? "text-xs text-[#FAFAFA] font-bold"
                : theme().name === "dark"
                  ? "text-xs text-[#18181B] font-bold"
                  : "text-xs text-[#FAFAFA] font-bold"}
              style={{ translateY: 1 }}
            >{badgeGlyph()}</Text>
          </View>
          <View
            ref={(current) => {
              textColumnNode = current;
              syncTextColumnWidth();
            }}
            class="flex-col gap-1 flex-1"
            style={{ minW: 0 }}
          >
            <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{wrapTextLines(props.message, 42, textMaxWidth())}</Text>
            {props.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#A1A1AA]" : "text-2xs text-[#71717A]"}>{wrapTextLines(props.detail, 48, textMaxWidth())}</Text> : null}
          </View>
        </View>
        <Show when={hasActions()}>
          <View class="flex-row flex-wrap items-center justify-end gap-2 w-full">
            {props.actionLabel && props.onAction ? (
              <MobileButton label={props.actionLabel} compact kind="outlined" onPress={props.onAction} />
            ) : null}
            {props.onClose ? (
              <MobileTextButton label="Hide" compact onPress={props.onClose} />
            ) : null}
          </View>
        </Show>
      </ScrollContourItem>
    </Show>
  );
}

export interface MobilePopupAction {
  id: string;
  label: string;
  detail?: string;
  danger?: boolean;
}

/**
 * Put a colorless, alpha-animated backdrop sample in its own portal. The
 * official Modal backdrop is transparent for these Mobile overlays, so the
 * native host can blur the already-painted page without a black scrim. The
 * browser projection consumes the same `glass` host-surface op rather than
 * replacing it with a coloured approximation.
 */
function MobileModalBackdrop(props: { progress: () => number }): JSX.Element {
  return (
    <Portal>
      <GlassSurface
        class="absolute inset-0 w-full h-full"
        effect="blur"
        tintOpacity={0}
        opacity={props.progress}
      />
    </Portal>
  );
}

export function MobilePopup(props: {
  open: boolean | (() => boolean);
  title: string;
  subtitle?: string;
  placement?: "bottom" | "center" | "auto";
  actions?: readonly MobilePopupAction[];
  onSelectAction?: (id: string) => void;
  onClose: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const sizeClass = useWindowSizeClass();
  const presence = useOverlayPresence(() => typeof props.open === "function" ? props.open() : props.open);
  const isBottomSheet = () => {
    const placement = props.placement ?? "auto";
    if (placement === "bottom") return true;
    if (placement === "center") return false;
    return sizeClass() === "compact";
  };
  return (
    <Show when={presence.mounted()}>
      <MobileModalBackdrop progress={presence.progress} />
      <Modal
        open
        backdropClass="bg-transparent"
        class={isBottomSheet()
          ? "absolute inset-0 z-50 flex-col items-center justify-end p-3"
          : "absolute inset-0 z-50 flex-col items-center justify-center p-4"}
        panelClass={isBottomSheet()
          ? "absolute inset-0 flex-col items-center justify-end p-3 bg-transparent"
          : "absolute inset-0 flex-col items-center justify-center p-4 bg-transparent"}
      >
        <View
          class={theme().name === "dark"
            ? "flex-col gap-3 w-[344] p-4 rounded-xl shadow-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-spring"
            : "flex-col gap-3 w-[344] p-4 rounded-xl shadow-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-spring"}
          style={{
            opacity: presence.progress(),
            translateY: Math.round((1 - presence.progress()) * 10),
            scale: 0.92 + 0.08 * presence.progress(),
          }}
        >
          <View class="flex-row items-center justify-center w-full">
            <View
              class={theme().name === "dark" ? "w-[40] h-[4] bg-[#27272A]" : "w-[40] h-[4] bg-[#E4E4E7]"}
              style={{ radius: 2, scaleX: presence.progress() }}
            />
          </View>
          <View class="flex-row items-center justify-between gap-2">
            <View class="flex-col gap-1 flex-1">
              <Text class={theme().name === "dark" ? "text-base text-[#FAFAFA] font-bold" : "text-base text-[#09090B] font-bold"}>{props.title}</Text>
              {props.subtitle ? <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{wrapTextLines(props.subtitle, 38, 230)}</Text> : null}
            </View>
            <MobileBadge label={isBottomSheet() ? "Sheet" : "Popover"} tone="neutral" />
          </View>
          {props.actions && props.actions.length > 0 ? (
            <View class="flex-col gap-2">
              <For each={props.actions}>
                {(action) => (
                  <Focusable
                    class={action.danger
                      ? (theme().name === "dark"
                        ? "flex-row items-center justify-between px-3 py-3 rounded-lg bg-[#09090B] border-[#7F1D1D] transition-colors duration-150 ease-out"
                        : "flex-row items-center justify-between px-3 py-3 rounded-lg bg-white border-[#EF4444] transition-colors duration-150 ease-out")
                      : (theme().name === "dark"
                        ? "flex-row items-center justify-between px-3 py-3 rounded-lg bg-[#18181B] border-[#27272A] transition-colors duration-150 ease-out"
                        : "flex-row items-center justify-between px-3 py-3 rounded-lg bg-[#FAFAFA] border-[#E4E4E7] transition-colors duration-150 ease-out")}
                    onPress={() => {
                      if (!presence.interactive()) return;
                      props.onSelectAction?.(action.id);
                      props.onClose();
                    }}
                  >
                    <View class="flex-col gap-1 flex-1">
                      <Text class={action.danger
                        ? (theme().name === "dark" ? "text-xs text-[#F87171] font-bold" : "text-xs text-[#DC2626] font-bold")
                        : (theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold")}>{action.label}</Text>
                      {action.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#A1A1AA]" : "text-2xs text-[#71717A]"}>{wrapTextLines(action.detail, 42, 260)}</Text> : null}
                    </View>
                    <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA] font-bold" : "text-xs text-[#71717A] font-bold"}>›</Text>
                  </Focusable>
                )}
              </For>
            </View>
          ) : null}
          {props.children}
          <MobileOutlinedButton label="Dismiss popup" onPress={() => {
            if (presence.interactive()) props.onClose();
          }} />
        </View>
      </Modal>
    </Show>
  );
}

export const MobileActionSheet = MobilePopup;

export function MobileDialog(props: {
  open: boolean | (() => boolean);
  title: string;
  body?: string;
  tone?: "default" | "danger" | "success";
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  children?: JSX.Element;
  onClose: () => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const presence = useOverlayPresence(() => typeof props.open === "function" ? props.open() : props.open);
  return (
    <Show when={presence.mounted()}>
      <MobileModalBackdrop progress={presence.progress} />
      <Modal
        open
        backdropClass="bg-transparent"
        class="absolute inset-0 z-50 flex-col items-center justify-center p-4"
        panelClass="absolute inset-0 flex-col items-center justify-center p-4 bg-transparent"
      >
        <View
          class={theme().name === "dark"
            ? "flex-col gap-3 w-full max-w-[280] p-4 rounded-xl shadow-lg bg-[#09090B] border-[#27272A] transition-colors duration-200 ease-spring"
            : "flex-col gap-3 w-full max-w-[280] p-4 rounded-xl shadow-lg bg-white border-[#E4E4E7] transition-colors duration-200 ease-spring"}
          style={{
            opacity: presence.progress(),
            scale: 0.92 + 0.08 * presence.progress(),
          }}
        >
          <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] text-center font-bold" : "text-sm text-[#09090B] text-center font-bold"}>{props.title}</Text>
          {props.body ? <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA] text-center" : "text-xs text-[#71717A] text-center"}>{wrapTextLines(props.body, 36, 240)}</Text> : null}
          {props.children}
          {props.onConfirm || props.confirmLabel ? (
            <View class="flex-row items-center gap-2 w-full">
              <MobileOutlinedButton
                label={props.cancelLabel ?? "Cancel"}
                onPress={() => {
                  if (presence.interactive()) props.onClose();
                }}
                style={{ grow: 1, shrink: 1, basis: 0 }}
              />
              <MobileButton
                label={props.confirmLabel ?? "Confirm"}
                kind={props.tone === "danger" ? "danger" : "filled"}
                style={{ grow: 1, shrink: 1, basis: 0 }}
                onPress={() => {
                  if (!presence.interactive()) return;
                  props.onConfirm?.();
                  props.onClose();
                }}
              />
            </View>
          ) : (
            <View class="flex-col items-stretch w-full">
              <MobileOutlinedButton
                label={props.cancelLabel ?? "Close"}
                onPress={() => {
                  if (presence.interactive()) props.onClose();
                }}
              />
            </View>
          )}
        </View>
      </Modal>
    </Show>
  );
}

type SurfaceBridge = {
  /** The native ABI accepts the typed descriptor object directly. */
  registerSurface?: (packageId: string, kind: "glass" | "platformTexture", payload: BridgeObject) => unknown;
  releaseSurface?: (packageId: string) => void;
};

const surfaceGlobal = globalThis as typeof globalThis & { pocket?: SurfaceBridge };
let nextGlassSurface = 1;
let nextTextureSurface = 1;

const DEFAULT_PLATFORM_TEXTURE_RADIUS = 12;
const MAX_PLATFORM_TEXTURE_RADIUS = 200;

function platformTextureRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PLATFORM_TEXTURE_RADIUS;
  return Math.max(0, Math.min(MAX_PLATFORM_TEXTURE_RADIUS, value));
}

function flatBridgeObjectEquals(
  previous: BridgeObject | undefined,
  next: BridgeObject | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || !Object.is(previous[key], next[key])) {
      return false;
    }
  }
  return true;
}

type GlassSurfaceEffect = "glass" | "blur";
type GlassSurfaceNumber = number | (() => number);

function resolveGlassSurfaceNumber(
  value: GlassSurfaceNumber | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = typeof value === "function" ? value() : value;
  if (typeof resolved !== "number" || !Number.isFinite(resolved)) return fallback;
  return Math.max(minimum, Math.min(maximum, resolved));
}

export function GlassSurface(props: {
  children?: JSX.Element;
  shape?: GlassShape;
  pressed?: boolean;
  /** `blur` is a colorless backdrop sample; `glass` keeps the liquid recipe. */
  effect?: GlassSurfaceEffect;
  /** Plain-backdrop-blur alpha; optical glass keeps its provider default. */
  opacity?: GlassSurfaceNumber;
  /** Optional tint override; a blur backdrop should pass zero. */
  tintOpacity?: GlassSurfaceNumber;
  class?: string;
}): JSX.Element {
  const [registered, setRegistered] = createSignal(false);
  const id = `guest.glass.${nextGlassSurface++}`;
  const recipe = createMemo(() => buildLiquidGlassRecipe({ shape: props.shape ?? "rounded", focused: props.pressed === true, warp: true }));
  const effect = props.effect ?? "glass";
  const surfaceOpacity = createMemo(() => effect === "blur" ? resolveGlassSurfaceNumber(props.opacity, 1, 0, 1) : 1);
  const surfaceRadius = createMemo(() => effect === "blur" ? 0 : recipe().radius);
  // Keep the shell transparent when a native surface is registered; the
  // gradient layer below is only the unsupported-host fallback.
  const payload = createMemo<BridgeObject>(() => {
    const current = recipe();
    const blurOnly = effect === "blur";
    return {
      radius: blurOnly ? 0 : current.radius,
      // The native glass provider calls this field `blur`; the local recipe
      // keeps the more descriptive `blurSigma` name for UI/tests.
      blur: current.blurSigma,
      effect,
      opacity: surfaceOpacity(),
      edgeIntensity: blurOnly ? 0 : current.edgeIntensity,
      rimIntensity: blurOnly ? 0 : current.rimIntensity,
      baseIntensity: blurOnly ? 0 : current.baseIntensity,
      tintOpacity: resolveGlassSurfaceNumber(props.tintOpacity, current.tintOpacity, 0, 1),
      cornerBoost: blurOnly ? 0 : current.cornerBoost,
      rippleEffect: blurOnly ? 0 : current.rippleEffect,
      warp: blurOnly ? false : current.warp,
      pressed: props.pressed === true,
      shape: current.shape,
    };
  }, undefined, { equals: flatBridgeObjectEquals });
  const register = (nextPayload: BridgeObject): void => {
    const registerSurface = surfaceGlobal.pocket?.registerSurface;
    if (typeof registerSurface !== "function") {
      setRegistered(false);
      return;
    }
    try {
      const ok = registerSurface(id, "glass", nextPayload) !== false;
      setRegistered(ok);
    } catch {
      setRegistered(false);
    }
  };
  // The host updates an existing package id in place. This keeps shape and
  // pressed/focus controls interactive without remounting the surface node.
  // The object memo is the one registration source; one effect owns
  // registration and does not subscribe to the registered signal it updates.
  createEffect(() => register(payload()));
  onCleanup(() => surfaceGlobal.pocket?.releaseSurface?.(id));
  return (
    <ScrollContourItem class={props.class ?? "flex-col gap-3 p-4 rounded-xl border-[#E5E9F2]"}>
      <Show when={registered()}>
        <View class={effect === "blur" ? "absolute inset-0 overflow-hidden" : "absolute inset-0 overflow-hidden rounded-xl"}>
          <CompositorGlass packageId={id} radius={surfaceRadius()} />
        </View>
      </Show>
      <Show when={!registered()}>
        <View
          class={effect === "blur" ? "absolute inset-0 overflow-hidden" : "absolute inset-0 overflow-hidden rounded-xl"}
          style={{
            gradFrom: effect === "blur" ? 0x00000000 : recipe().bgColors[0],
            gradTo: effect === "blur" ? 0x00000000 : recipe().bgColors[2],
            gradDir: 1,
            radius: surfaceRadius(),
            opacity: surfaceOpacity(),
            shadow: effect === "blur" ? 0 : recipe().shadowBlur > 20 ? 2 : 1,
          }}
        />
      </Show>
      <View class="relative flex-col gap-3">{props.children}</View>
    </ScrollContourItem>
  );
}

function CompositorGlass(props: { packageId: string; radius: number }): JSX.Element {
  // Kept as a tiny adapter to make the required native surface primitive
  // explicit; callers still compose ordinary children above it.
  return <CompositorSurface package={props.packageId} class="absolute inset-0" style={{ radius: props.radius }} />;
}

/**
 * Bind a host-authorized platform texture to the official compositor node.
 * The package id is guest-owned, while the texture handle is only accepted
 * after the host provider has registered it.
 */
export function PlatformTextureSurface(props: {
  textureId: number;
  sourceWidth: number;
  sourceHeight: number;
  fit?: "cover" | "contain";
  /** Rounded-xl by default; pass zero for a deliberately square surface. */
  radius?: number;
  /** Native camera transform metadata; zero/false keeps legacy textures unchanged. */
  rotationDegrees?: number;
  mirrorX?: boolean;
  class?: string;
}): JSX.Element {
  const [registered, setRegistered] = createSignal(false);
  const id = `guest.texture.${nextTextureSurface++}`;
  const payload = createMemo<BridgeObject>(() => ({
    textureId: props.textureId,
    sourceWidth: props.sourceWidth,
    sourceHeight: props.sourceHeight,
    fit: props.fit ?? "cover",
    radius: platformTextureRadius(props.radius),
    rotationDegrees: props.rotationDegrees ?? 0,
    mirrorX: props.mirrorX ?? false,
  }), undefined, { equals: flatBridgeObjectEquals });
  const register = (nextPayload: BridgeObject): void => {
    const registerSurface = surfaceGlobal.pocket?.registerSurface;
    if (typeof registerSurface !== "function") {
      setRegistered(false);
      return;
    }
    try {
      const ok = registerSurface(id, "platformTexture", nextPayload) !== false;
      setRegistered(ok);
    } catch {
      setRegistered(false);
    }
  };
  createEffect(() => register(payload()));
  onCleanup(() => surfaceGlobal.pocket?.releaseSurface?.(id));
  return (
    <Show
      when={registered()}
      fallback={<View class={props.class ?? "flex-col items-center justify-center rounded-xl bg-[#EEF1F6]"} style={{ radius: platformTextureRadius(props.radius) }}><Text class="text-xs text-[#7C8799]">Texture provider unavailable</Text></View>}
    >
      <View class={props.class ?? "relative overflow-hidden rounded-xl"} style={{ radius: platformTextureRadius(props.radius) }}>
        <CompositorSurface package={id} class="absolute inset-0" style={{ radius: platformTextureRadius(props.radius) }} />
      </View>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Complete shadcn/ui Component Suite (Separator, Kbd, Card primitives, Select,
// InputOTP, ToggleGroup, Command, Table, Calendar, Breadcrumb, Pagination,
// HoverCard, DropdownMenu, Collapsible)
// ---------------------------------------------------------------------------

const Pressable = Focusable;

function resolveDark(props: { dark?: boolean }): () => boolean {
  const theme = useMobileThemeAccessor();
  return () => (props.dark !== undefined ? props.dark : theme().name === "dark");
}

export function ShadcnSeparator(props: {
  orientation?: "horizontal" | "vertical";
  label?: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  if (props.orientation === "vertical") {
    return (
      <View
        class={dark() ? "w-[1] h-[16] bg-[#27272A]" : "w-[1] h-[16] bg-[#E4E4E7]"}
      />
    );
  }
  if (props.label) {
    return (
      <View class="flex-row items-center gap-3 w-full my-1">
        <View
          class={dark() ? "h-[1] bg-[#27272A]" : "h-[1] bg-[#E4E4E7]"}
          style={{ grow: 1, shrink: 1, basis: 0 }}
        />
        <Text
          class={
            dark()
              ? "text-xs text-[#A1A1AA]"
              : "text-xs text-[#71717A]"
          }
        >
          {props.label}
        </Text>
        <View
          class={dark() ? "h-[1] bg-[#27272A]" : "h-[1] bg-[#E4E4E7]"}
          style={{ grow: 1, shrink: 1, basis: 0 }}
        />
      </View>
    );
  }
  return (
    <View
      class={dark() ? "w-full h-[1] bg-[#27272A]" : "w-full h-[1] bg-[#E4E4E7]"}
    />
  );
}

export function ShadcnKbd(props: {
  keys: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View
      class={
        dark()
          ? "h-[20] px-1.5 rounded bg-[#27272A] border-[#3F3F46] items-center justify-center flex-row"
          : "h-[20] px-1.5 rounded bg-[#F4F4F5] border-[#E4E4E7] items-center justify-center flex-row"
      }
      style={{ radius: 4, borderWidth: 1 }}
    >
      <Text
        class={
          dark()
            ? "text-xs text-[#A1A1AA]"
            : "text-xs text-[#71717A]"
        }
        style={{ translateY: 1 }}
      >
        {props.keys}
      </Text>
    </View>
  );
}

export function ShadcnCardHeader(props: {
  title: string;
  description?: string;
  badge?: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-col gap-1 w-full">
      <View class="flex-row items-center justify-between gap-2 w-full">
        <Text
          class={
            dark()
              ? "text-base font-bold text-[#FAFAFA]"
              : "text-base font-bold text-[#09090B]"
          }
        >
          {props.title}
        </Text>
        {props.badge ? (
          <MobileBadge label={props.badge} tone="neutral" />
        ) : null}
      </View>
      {props.description ? (
        <Text
          class={
            dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
          }
        >
          {props.description}
        </Text>
      ) : null}
    </View>
  );
}

export function ShadcnCardTitle(props: {
  children?: JSX.Element;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <Text
      class={
        dark()
          ? "text-base font-bold text-[#FAFAFA]"
          : "text-base font-bold text-[#09090B]"
      }
    >
      {props.children}
    </Text>
  );
}

export function ShadcnCardDescription(props: {
  children?: JSX.Element;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
      {props.children}
    </Text>
  );
}

export function ShadcnCardContent(props: {
  children?: JSX.Element;
}): JSX.Element {
  return <View class="flex-col gap-3 w-full">{props.children}</View>;
}

export function ShadcnCardFooter(props: {
  children?: JSX.Element;
}): JSX.Element {
  return (
    <View class="flex-row items-center justify-between gap-2 w-full pt-1">
      {props.children}
    </View>
  );
}

export function ShadcnSelect(props: {
  label?: string;
  placeholder?: string;
  options: string[];
  value: string;
  onChange?: (next: string) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [open, setOpen] = createSignal(false);
  return (
    <View class="flex-col gap-1.5 w-full">
      {props.label ? (
        <Text
          class={
            dark()
              ? "text-xs text-[#FAFAFA]"
              : "text-xs text-[#09090B]"
          }
        >
          {props.label}
        </Text>
      ) : null}
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        class={
          dark()
            ? "flex-row items-center justify-between w-full h-[38] px-3 rounded-lg bg-[#09090B] border-[#27272A]"
            : "flex-row items-center justify-between w-full h-[38] px-3 rounded-lg bg-white border-[#E4E4E7]"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-xs text-[#FAFAFA]"
              : "text-xs text-[#09090B]"
          }
        >
          {props.value || props.placeholder || "Select an option"}
        </Text>
        <Text
          class={
            dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
          }
        >
          {open() ? "▴" : "▾"}
        </Text>
      </Pressable>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-col gap-0.5 p-1 rounded-lg bg-[#09090B] border-[#27272A] w-full"
              : "flex-col gap-0.5 p-1 rounded-lg bg-white border-[#E4E4E7] w-full"
          }
          style={{ radius: 8, borderWidth: 1, shadow: 1 }}
        >
          <For each={props.options}>
            {(option) => {
              const selected = () => props.value === option;
              return (
                <Pressable
                  onPress={() => {
                    props.onChange?.(option);
                    setOpen(false);
                  }}
                  class={
                    selected()
                      ? dark()
                        ? "flex-row items-center justify-between px-2.5 py-2 rounded-md bg-[#27272A] w-full"
                        : "flex-row items-center justify-between px-2.5 py-2 rounded-md bg-[#F4F4F5] w-full"
                      : "flex-row items-center justify-between px-2.5 py-2 rounded-md w-full"
                  }
                  style={{ radius: 6 }}
                >
                  <Text
                    class={
                      dark()
                        ? "text-xs text-[#FAFAFA]"
                        : "text-xs text-[#09090B]"
                    }
                  >
                    {option}
                  </Text>
                  <Text
                    class={
                      selected()
                        ? dark()
                          ? "text-xs font-bold text-[#FAFAFA]"
                          : "text-xs font-bold text-[#09090B]"
                        : "text-xs text-transparent"
                    }
                  >
                    {selected() ? "✓" : " "}
                  </Text>
                </Pressable>
              );
            }}
          </For>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnInputOTP(props: {
  value: string;
  length?: number;
  activeSlot?: number;
  onSelectSlot?: (index: number) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const count = () => props.length ?? 6;
  const slots = createMemo(() => {
    const chars = props.value.split("");
    const result: Array<{ index: number; char: string }> = [];
    for (let i = 0; i < count(); i += 1) {
      result.push({ index: i, char: chars[i] ?? "•" });
    }
    return result;
  });
  return (
    <View class="flex-row items-center gap-1.5 flex-wrap">
      <For each={slots()}>
        {(slot) => {
          const isFocused = () => (props.activeSlot ?? 0) === slot.index;
          return (
            <View class="flex-row items-center gap-1.5">
              {slot.index === 3 ? (
                <Text
                  class={
                    dark()
                      ? "text-xs font-bold text-[#A1A1AA]"
                      : "text-xs font-bold text-[#71717A]"
                  }
                >
                  -
                </Text>
              ) : null}
              <Pressable
                onPress={() => props.onSelectSlot?.(slot.index)}
                class={
                  isFocused()
                    ? dark()
                      ? "w-[36] h-[40] rounded-lg bg-[#18181B] border-[#FAFAFA] items-center justify-center"
                      : "w-[36] h-[40] rounded-lg bg-white border-[#18181B] items-center justify-center"
                    : dark()
                      ? "w-[36] h-[40] rounded-lg bg-[#09090B] border-[#27272A] items-center justify-center"
                      : "w-[36] h-[40] rounded-lg bg-white border-[#E4E4E7] items-center justify-center"
                }
                style={{ radius: 8, borderWidth: isFocused() ? 2 : 1 }}
              >
                <Text
                  class={
                    dark()
                      ? "text-sm font-bold text-[#FAFAFA]"
                      : "text-sm font-bold text-[#09090B]"
                  }
                >
                  {slot.char}
                </Text>
              </Pressable>
            </View>
          );
        }}
      </For>
    </View>
  );
}

export function ShadcnToggleGroup(props: {
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle?: (id: string) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-row items-center gap-1.5 flex-wrap">
      <For each={props.options}>
        {(item) => {
          const active = () => props.selected.includes(item.id);
          return (
            <Pressable
              onPress={() => props.onToggle?.(item.id)}
              class={
                active()
                  ? dark()
                    ? "h-[34] px-3 rounded-lg bg-[#27272A] border-[#3F3F46] items-center justify-center flex-row"
                    : "h-[34] px-3 rounded-lg bg-[#F4F4F5] border-[#18181B] items-center justify-center flex-row"
                  : dark()
                    ? "h-[34] px-3 rounded-lg bg-[#09090B] border-[#27272A] items-center justify-center flex-row"
                    : "h-[34] px-3 rounded-lg bg-white border-[#E4E4E7] items-center justify-center flex-row"
              }
              style={{ radius: 8, borderWidth: 1 }}
            >
              <Text
                class={
                  active()
                    ? dark()
                      ? "text-xs font-bold text-[#FAFAFA]"
                      : "text-xs font-bold text-[#09090B]"
                    : dark()
                      ? "text-xs text-[#A1A1AA]"
                      : "text-xs text-[#71717A]"
                }
                style={{ translateY: 1 }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        }}
      </For>
    </View>
  );
}

export interface ShadcnCommandItem {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
}

export function ShadcnCommand(props: {
  placeholder?: string;
  items: ShadcnCommandItem[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const groups = createMemo(() => {
    const seen: string[] = [];
    for (const item of props.items) {
      if (!seen.includes(item.group)) seen.push(item.group);
    }
    return seen;
  });
  return (
    <View
      class={
        dark()
          ? "flex-col rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
          : "flex-col rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View
        class={
          dark()
            ? "flex-row items-center justify-between px-3 py-2.5 border-[#27272A]"
            : "flex-row items-center justify-between px-3 py-2.5 border-[#E4E4E7]"
        }
      >
        <View class="flex-row items-center gap-2">
          <Text
            class={
              dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
            }
          >
            ⌕
          </Text>
          <Text
            class={
              dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
            }
          >
            {props.placeholder ?? "Type a command or search..."}
          </Text>
        </View>
        <ShadcnKbd keys="⌘K" dark={dark()} />
      </View>
      <ShadcnSeparator dark={dark()} />
      <View class="flex-col gap-2 p-2 w-full">
        <For each={groups()}>
          {(groupName) => (
            <View class="flex-col gap-1 w-full">
              <Text
                class={
                  dark()
                    ? "text-xs text-[#A1A1AA] px-2 py-0.5"
                    : "text-xs text-[#71717A] px-2 py-0.5"
                }
              >
                {groupName}
              </Text>
              <For
                each={props.items.filter((item) => item.group === groupName)}
              >
                {(item) => {
                  const active = () => props.selectedId === item.id;
                  return (
                    <Pressable
                      onPress={() => props.onSelect?.(item.id)}
                      class={
                        active()
                          ? dark()
                            ? "flex-row items-center justify-between px-2.5 py-2 rounded-md bg-[#27272A] w-full"
                            : "flex-row items-center justify-between px-2.5 py-2 rounded-md bg-[#F4F4F5] w-full"
                          : "flex-row items-center justify-between px-2.5 py-2 rounded-md w-full"
                      }
                      style={{ radius: 6 }}
                    >
                      <Text
                        class={
                          dark()
                            ? "text-xs text-[#FAFAFA]"
                            : "text-xs text-[#09090B]"
                        }
                      >
                        {item.label}
                      </Text>
                      {item.shortcut ? (
                        <ShadcnKbd keys={item.shortcut} dark={dark()} />
                      ) : null}
                    </Pressable>
                  );
                }}
              </For>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}

export interface ShadcnInvoiceRow {
  invoice: string;
  status: "Paid" | "Pending" | "Unpaid";
  method: string;
  amount: string;
}

export function ShadcnTable(props: {
  caption?: string;
  rows: ShadcnInvoiceRow[];
  totalAmount?: string;
  selectedInvoice?: string;
  onSelectRow?: (invoice: string) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View
      class={
        dark()
          ? "flex-col rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
          : "flex-col rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View
        class={
          dark()
            ? "flex-row items-center justify-between px-3 py-2.5 bg-[#18181B]"
            : "flex-row items-center justify-between px-3 py-2.5 bg-[#FAFAFA]"
        }
      >
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#A1A1AA]"
              : "text-xs font-bold text-[#71717A]"
          }
        >
          Invoice
        </Text>
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#A1A1AA]"
              : "text-xs font-bold text-[#71717A]"
          }
        >
          Status
        </Text>
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#A1A1AA]"
              : "text-xs font-bold text-[#71717A]"
          }
        >
          Method
        </Text>
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#A1A1AA]"
              : "text-xs font-bold text-[#71717A]"
          }
        >
          Amount
        </Text>
      </View>
      <ShadcnSeparator dark={dark()} />
      <For each={props.rows}>
        {(row) => {
          const active = () => props.selectedInvoice === row.invoice;
          const badgeKind =
            row.status === "Paid"
              ? "success"
              : row.status === "Pending"
                ? "warning"
                : "neutral";
          return (
            <View class="flex-col w-full">
              <Pressable
                onPress={() => props.onSelectRow?.(row.invoice)}
                class={
                  active()
                    ? dark()
                      ? "flex-row items-center justify-between px-3 py-2.5 bg-[#27272A] w-full"
                      : "flex-row items-center justify-between px-3 py-2.5 bg-[#F4F4F5] w-full"
                    : "flex-row items-center justify-between px-3 py-2.5 w-full"
                }
              >
                <Text
                  class={
                    dark()
                      ? "text-xs font-bold text-[#FAFAFA]"
                      : "text-xs font-bold text-[#09090B]"
                  }
                >
                  {row.invoice}
                </Text>
                <MobileBadge
                  label={row.status}
                  tone={badgeKind}
                />
                <Text
                  class={
                    dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
                  }
                >
                  {row.method}
                </Text>
                <Text
                  class={
                    dark()
                      ? "text-xs font-bold text-[#FAFAFA]"
                      : "text-xs font-bold text-[#09090B]"
                  }
                >
                  {row.amount}
                </Text>
              </Pressable>
              <ShadcnSeparator dark={dark()} />
            </View>
          );
        }}
      </For>
      {props.totalAmount ? (
        <View
          class={
            dark()
              ? "flex-row items-center justify-between px-3 py-2.5 bg-[#18181B]"
              : "flex-row items-center justify-between px-3 py-2.5 bg-[#FAFAFA]"
          }
        >
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA]"
                : "text-xs font-bold text-[#09090B]"
            }
          >
            Total
          </Text>
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA]"
                : "text-xs font-bold text-[#09090B]"
            }
          >
            {props.totalAmount}
          </Text>
        </View>
      ) : null}
      {props.caption ? (
        <View class="px-3 py-2 items-center justify-center">
          <Text
            class={
              dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
            }
          >
            {props.caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const SHADCN_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const SHADCN_CALENDAR_WEEKS = [
  [1, 2, 3, 4, 5, 6, 7],
  [8, 9, 10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19, 20, 21],
  [22, 23, 24, 25, 26, 27, 28],
  [29, 30, 1, 2, 3, 4, 5],
];

export function ShadcnCalendar(props: {
  monthLabel?: string;
  selectedDay: number;
  onSelectDay?: (day: number) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View
      class={
        dark()
          ? "flex-col gap-2.5 p-3 rounded-xl bg-[#09090B] border-[#27272A] w-full"
          : "flex-col gap-2.5 p-3 rounded-xl bg-white border-[#E4E4E7] w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View class="flex-row items-center justify-between w-full px-1">
        <View
          class={
            dark()
              ? "w-[28] h-[28] rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
              : "w-[28] h-[28] rounded-md bg-white border-[#E4E4E7] items-center justify-center"
          }
          style={{ radius: 6, borderWidth: 1 }}
        >
          <Text
            class={
              dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"
            }
          >
            ‹
          </Text>
        </View>
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          {props.monthLabel ?? "November 2026"}
        </Text>
        <View
          class={
            dark()
              ? "w-[28] h-[28] rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
              : "w-[28] h-[28] rounded-md bg-white border-[#E4E4E7] items-center justify-center"
          }
          style={{ radius: 6, borderWidth: 1 }}
        >
          <Text
            class={
              dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"
            }
          >
            ›
          </Text>
        </View>
      </View>
      <View class="flex-row items-center justify-between w-full px-1">
        <For each={SHADCN_WEEKDAYS}>
          {(dayName) => (
            <View class="w-[32] h-[24] items-center justify-center">
              <Text
                class={
                  dark()
                    ? "text-xs text-[#A1A1AA]"
                    : "text-xs text-[#71717A]"
                }
              >
                {dayName}
              </Text>
            </View>
          )}
        </For>
      </View>
      <For each={SHADCN_CALENDAR_WEEKS}>
        {(week, weekIndex) => (
          <View class="flex-row items-center justify-between w-full px-1">
            <For each={week}>
              {(day) => {
                const isOutsideMonth = weekIndex() === SHADCN_CALENDAR_WEEKS.length - 1 && day < 7;
                const isSelected = () => !isOutsideMonth && props.selectedDay === day;
                return (
                  <Pressable
                    onPress={() => {
                      if (!isOutsideMonth) props.onSelectDay?.(day);
                    }}
                    class={
                      isSelected()
                        ? dark()
                          ? "w-[32] h-[32] rounded-md bg-[#FAFAFA] items-center justify-center"
                          : "w-[32] h-[32] rounded-md bg-[#18181B] items-center justify-center"
                        : "w-[32] h-[32] rounded-md items-center justify-center"
                    }
                    style={{ radius: 6 }}
                  >
                    <Text
                      class={
                        isSelected()
                          ? dark()
                            ? "text-xs font-bold text-[#09090B]"
                            : "text-xs font-bold text-[#FAFAFA]"
                          : isOutsideMonth
                            ? dark()
                              ? "text-xs text-[#3F3F46]"
                              : "text-xs text-[#A1A1AA]"
                            : dark()
                              ? "text-xs text-[#FAFAFA]"
                              : "text-xs text-[#09090B]"
                      }
                    >
                      {String(day)}
                    </Text>
                  </Pressable>
                );
              }}
            </For>
          </View>
        )}
      </For>
    </View>
  );
}

export function ShadcnBreadcrumb(props: {
  items: string[];
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-row items-center gap-1.5 flex-wrap">
      <For each={props.items}>
        {(item, idx) => {
          const isLast = () => idx() === props.items.length - 1;
          return (
            <View class="flex-row items-center gap-1.5">
              <Text
                class={
                  isLast()
                    ? dark()
                      ? "text-xs font-bold text-[#FAFAFA]"
                      : "text-xs font-bold text-[#09090B]"
                    : dark()
                      ? "text-xs text-[#A1A1AA]"
                      : "text-xs text-[#71717A]"
                }
              >
                {item}
              </Text>
              {!isLast() ? (
                <Text
                  class={
                    dark() ? "text-xs text-[#71717A]" : "text-xs text-[#A1A1AA]"
                  }
                >
                  /
                </Text>
              ) : null}
            </View>
          );
        }}
      </For>
    </View>
  );
}

export function ShadcnPagination(props: {
  page: number;
  totalPages: number;
  onChange?: (page: number) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const pages = createMemo(() => {
    const out: number[] = [];
    for (let i = 1; i <= props.totalPages; i += 1) out.push(i);
    return out;
  });
  return (
    <View class="flex-row items-center gap-1.5 flex-wrap">
      <Pressable
        onPress={() => props.onChange?.(Math.max(1, props.page - 1))}
        class={
          dark()
            ? "h-[32] px-2.5 rounded-md bg-[#09090B] border-[#27272A] items-center justify-center flex-row"
            : "h-[32] px-2.5 rounded-md bg-white border-[#E4E4E7] items-center justify-center flex-row"
        }
        style={{ radius: 6, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-xs text-[#FAFAFA]"
              : "text-xs text-[#09090B]"
          }
          style={{ translateY: 1 }}
        >
          ‹ Prev
        </Text>
      </Pressable>
      <For each={pages()}>
        {(num) => {
          const active = () => props.page === num;
          return (
            <Pressable
              onPress={() => props.onChange?.(num)}
              class={
                active()
                  ? dark()
                    ? "w-[32] h-[32] rounded-md bg-[#18181B] border-[#FAFAFA] items-center justify-center"
                    : "w-[32] h-[32] rounded-md bg-white border-[#18181B] items-center justify-center"
                  : dark()
                    ? "w-[32] h-[32] rounded-md bg-[#09090B] border-[#27272A] items-center justify-center"
                    : "w-[32] h-[32] rounded-md bg-white border-[#E4E4E7] items-center justify-center"
              }
              style={{ radius: 6, borderWidth: active() ? 2 : 1 }}
            >
              <Text
                class={
                  dark()
                    ? "text-xs font-bold text-[#FAFAFA]"
                    : "text-xs font-bold text-[#09090B]"
                }
                style={{ translateY: 1 }}
              >
                {String(num)}
              </Text>
            </Pressable>
          );
        }}
      </For>
      <Pressable
        onPress={() =>
          props.onChange?.(Math.min(props.totalPages, props.page + 1))
        }
        class={
          dark()
            ? "h-[32] px-2.5 rounded-md bg-[#09090B] border-[#27272A] items-center justify-center flex-row"
            : "h-[32] px-2.5 rounded-md bg-white border-[#E4E4E7] items-center justify-center flex-row"
        }
        style={{ radius: 6, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-xs text-[#FAFAFA]"
              : "text-xs text-[#09090B]"
          }
          style={{ translateY: 1 }}
        >
          Next ›
        </Text>
      </Pressable>
    </View>
  );
}

export function ShadcnHoverCard(props: {
  handle: string;
  description: string;
  joined: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [open, setOpen] = createSignal(true);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between">
        <Pressable
          onPress={() => setOpen((prev) => !prev)}
          class="flex-row items-center gap-1.5"
        >
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA]"
                : "text-xs font-bold text-[#09090B]"
            }
          >
            {props.handle}
          </Text>
          <MobileBadge
            label={open() ? "HoverCard open" : "HoverCard closed"}
            tone="neutral"
          />
        </Pressable>
      </View>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-row items-start gap-3 p-3 rounded-xl bg-[#09090B] border-[#27272A] w-full"
              : "flex-row items-start gap-3 p-3 rounded-xl bg-white border-[#E4E4E7] w-full"
          }
          style={{ radius: 12, borderWidth: 1, shadow: 1 }}
        >
          <MobileAvatar label="VC" tone="accent" />
          <View
            class="flex-col gap-1"
            style={{ grow: 1, shrink: 1, basis: 0 }}
          >
            <Text
              class={
                dark()
                  ? "text-xs font-bold text-[#FAFAFA]"
                  : "text-xs font-bold text-[#09090B]"
              }
            >
              {props.handle}
            </Text>
            <Text
              class={
                dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
              }
            >
              {props.description}
            </Text>
            <Text
              class={
                dark() ? "text-xs text-[#71717A]" : "text-xs text-[#A1A1AA]"
              }
            >
              {props.joined}
            </Text>
          </View>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnDropdownMenu(props: {
  triggerLabel?: string;
  items: Array<{ id: string; label: string; shortcut?: string }>;
  onSelect?: (id: string) => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [open, setOpen] = createSignal(true);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between">
        <Pressable
          onPress={() => setOpen((prev) => !prev)}
          class={
            dark()
              ? "h-[34] px-3 rounded-lg bg-[#09090B] border-[#27272A] items-center justify-center flex-row gap-1.5"
              : "h-[34] px-3 rounded-lg bg-white border-[#E4E4E7] items-center justify-center flex-row gap-1.5"
          }
          style={{ radius: 8, borderWidth: 1 }}
        >
          <Text
            class={
              dark()
                ? "text-xs text-[#FAFAFA]"
                : "text-xs text-[#09090B]"
            }
          >
            {props.triggerLabel ?? "My Account"}
          </Text>
          <Text
            class={
              dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"
            }
          >
            {open() ? "▴" : "▾"}
          </Text>
        </Pressable>
      </View>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-col gap-0.5 p-1.5 rounded-xl bg-[#09090B] border-[#27272A] w-full"
              : "flex-col gap-0.5 p-1.5 rounded-xl bg-white border-[#E4E4E7] w-full"
          }
          style={{ radius: 12, borderWidth: 1, shadow: 1 }}
        >
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA] px-2 py-1"
                : "text-xs font-bold text-[#09090B] px-2 py-1"
            }
          >
            My Account
          </Text>
          <ShadcnSeparator dark={dark()} />
          <For each={props.items}>
            {(item) => (
              <Pressable
                onPress={() => props.onSelect?.(item.id)}
                class="flex-row items-center justify-between px-2 py-1.5 rounded-md w-full"
              >
                <Text
                  class={
                    dark()
                      ? "text-xs text-[#FAFAFA]"
                      : "text-xs text-[#09090B]"
                  }
                >
                  {item.label}
                </Text>
                {item.shortcut ? (
                  <ShadcnKbd keys={item.shortcut} dark={dark()} />
                ) : null}
              </Pressable>
            )}
          </For>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnCollapsible(props: {
  title: string;
  pinnedItem: string;
  hiddenItems: string[];
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [expanded, setExpanded] = createSignal(false);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          {props.title}
        </Text>
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          class={
            dark()
              ? "h-[28] px-2.5 rounded-md bg-[#18181B] border-[#27272A] items-center justify-center flex-row"
              : "h-[28] px-2.5 rounded-md bg-white border-[#E4E4E7] items-center justify-center flex-row"
          }
          style={{ radius: 6, borderWidth: 1 }}
        >
          <Text
            class={
              dark()
                ? "text-xs text-[#FAFAFA]"
                : "text-xs text-[#09090B]"
            }
          >
            {expanded() ? "Hide ▴" : "Toggle ▾"}
          </Text>
        </Pressable>
      </View>
      <View
        class={
          dark()
            ? "px-3 py-2 rounded-lg bg-[#09090B] border-[#27272A] w-full"
            : "px-3 py-2 rounded-lg bg-white border-[#E4E4E7] w-full"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-xs text-[#FAFAFA]"
              : "text-xs text-[#09090B]"
          }
        >
          {props.pinnedItem}
        </Text>
      </View>
      <Show when={expanded()}>
        <For each={props.hiddenItems}>
          {(item) => (
            <View
              class={
                dark()
                  ? "px-3 py-2 rounded-lg bg-[#09090B] border-[#27272A] w-full"
                  : "px-3 py-2 rounded-lg bg-white border-[#E4E4E7] w-full"
              }
              style={{ radius: 8, borderWidth: 1 }}
            >
              <Text
                class={
                  dark()
                    ? "text-xs text-[#FAFAFA]"
                    : "text-xs text-[#09090B]"
                }
              >
                {item}
              </Text>
            </View>
          )}
        </For>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Extended Full shadcn/ui Catalog:
// ScrollArea & ScrollFade, AspectRatio, ButtonGroup, Carousel, Chart,
// Combobox, ContextMenu, DataTable, DatePicker, Drawer, Empty, FormField/Label,
// InputGroup, Item, Menubar, NavigationMenu, Popover, Resizable, Sheet,
// Sidebar, Spinner, Textarea, Tooltip, Typography
// ---------------------------------------------------------------------------

const DEFAULT_SCROLL_TAGS = [
  "v1.2.0-beta.12",
  "v1.2.0-beta.11",
  "v1.2.0-beta.10",
  "v1.2.0-beta.9",
  "v1.2.0-beta.8",
  "v1.2.0-beta.7",
  "v1.2.0-beta.6",
  "v1.2.0-beta.5",
  "v1.2.0-beta.4",
  "v1.2.0-beta.3",
  "v1.2.0-beta.2",
  "v1.2.0-beta.1",
];

export function ShadcnScrollArea(props: {
  title?: string;
  items?: string[];
  fadeHeight?: number;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const routeActive = useRouteActive();
  const parentScrollPage = useContext(ScrollablePageContext);
  const allItems = () => props.items ?? DEFAULT_SCROLL_TAGS;
  const rowStepPx = 29;
  const viewportHeight = 160;
  const trackHeight = 148;
  const thumbHeight = 36;
  const thumbTravel = trackHeight - thumbHeight;
  const maxScrollPx = () =>
    Math.max(0, allItems().length * rowStepPx + 16 - viewportHeight);
  const [scrollPx, setScrollPx] = createSignal(rowStepPx * 2);
  const [draggingThumb, setDraggingThumb] = createSignal(false);
  const currentScrollPx = () =>
    Math.max(0, Math.min(maxScrollPx(), scrollPx()));
  const hasTopFade = () => currentScrollPx() > 2;
  const hasBottomFade = () => currentScrollPx() < maxScrollPx() - 2;
  const thumbY = () => {
    const max = maxScrollPx();
    if (max <= 0) return 0;
    return Math.round((currentScrollPx() / max) * thumbTravel);
  };

  let viewportNode: NodeMirror | undefined;
  let scrollbarNode: NodeMirror | undefined;
  let chainedToParent = false;

  // Inner ScrollArea pan recognizer with iOS-style scroll chaining:
  // consumes vertical movement within [0, maxScrollPx()], and seamlessly
  // hands any unconsumed overflow at the top/bottom boundary to the outer
  // ScrollablePage (including release fling velocity).
  createGesture({
    axis: "y",
    region: {
      node: () => (routeActive() ? viewportNode : undefined),
    },
    panSlop: 1,
    onDown: () => {
      chainedToParent = false;
    },
    onPanMove: (contact) => {
      if (!routeActive()) return;
      const wantDelta = -contact.fdy;
      if (wantDelta === 0) return;
      const prev = currentScrollPx();
      const max = maxScrollPx();
      const next = Math.max(0, Math.min(max, prev + wantDelta));
      const consumed = next - prev;
      const remainder = wantDelta - consumed;
      if (consumed !== 0) {
        setScrollPx(next);
      }
      if (Math.abs(remainder) > 0.01 && parentScrollPage?.chainDrag) {
        chainedToParent = true;
        parentScrollPage.chainDrag(remainder);
      }
    },
    onPanEnd: (contact) => {
      if (!routeActive()) return;
      if (chainedToParent) {
        chainedToParent = false;
        parentScrollPage?.chainEndDrag?.(-contact.vy);
      }
    },
    onCancel: () => {
      if (chainedToParent) {
        chainedToParent = false;
        parentScrollPage?.chainEndDrag?.(0);
      }
    },
  });

  // Side scrollbar rail + thumb recognizer (registered after viewportNode so
  // it has highest priority and claims drags on the scrollbar).
  createGesture({
    axis: "any",
    region: {
      node: () => (routeActive() ? scrollbarNode : undefined),
    },
    panSlop: 1,
    onDown: () => {
      if (routeActive()) setDraggingThumb(true);
    },
    onPanMove: (contact) => {
      if (!routeActive()) return;
      const max = maxScrollPx();
      if (max <= 0 || thumbTravel <= 0) return;
      const deltaScroll = (contact.fdy / thumbTravel) * max;
      setScrollPx((prev) => Math.max(0, Math.min(max, prev + deltaScroll)));
    },
    onTap: () => {
      if (!routeActive()) return;
      const max = maxScrollPx();
      if (max <= 0) return;
      setScrollPx((prev) =>
        prev < max * 0.5
          ? Math.min(max, prev + rowStepPx * 3)
          : Math.max(0, prev - rowStepPx * 3),
      );
    },
    onUp: () => setDraggingThumb(false),
    onCancel: () => setDraggingThumb(false),
  });

  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <View class="flex-row items-center gap-1.5">
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA]"
                : "text-xs font-bold text-[#09090B]"
            }
          >
            {props.title ?? "Tags (ScrollArea + ScrollFade)"}
          </Text>
          <MobileBadge
            label={
              hasTopFade() && hasBottomFade()
                ? "Fade Top+Bottom"
                : hasTopFade()
                  ? "Fade Top"
                  : "Fade Bottom"
            }
            tone="neutral"
          />
        </View>
        <View class="flex-row items-center gap-1">
          <Pressable
            onPress={() =>
              setScrollPx((prev) => Math.max(0, prev - rowStepPx))
            }
            class={
              dark()
                ? "w-[26] h-[24] rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
                : "w-[26] h-[24] rounded-md bg-white border-[#E4E4E7] items-center justify-center"
            }
            style={{ radius: 6, borderWidth: 1 }}
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>↑</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              setScrollPx((prev) => Math.min(maxScrollPx(), prev + rowStepPx))
            }
            class={
              dark()
                ? "w-[26] h-[24] rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
                : "w-[26] h-[24] rounded-md bg-white border-[#E4E4E7] items-center justify-center"
            }
            style={{ radius: 6, borderWidth: 1 }}
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>↓</Text>
          </Pressable>
        </View>
      </View>
      <View
        ref={(current) => {
          viewportNode = current;
        }}
        class={
          dark()
            ? "relative flex-row h-[160] rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
            : "relative flex-row h-[160] rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <View
          class="relative overflow-hidden h-[160]"
          style={{ grow: 1, shrink: 1, basis: 0 }}
        >
          <View
            class="flex-col p-3 gap-1.5 w-full"
            style={{ translateY: -Math.round(currentScrollPx()) }}
          >
            <For each={allItems()}>
              {(tag, idx) => (
                <View class="flex-col gap-1.5 w-full shrink-0">
                  <Text
                    class={
                      dark()
                        ? "text-xs text-[#FAFAFA]"
                        : "text-xs text-[#09090B]"
                    }
                  >
                    {tag}
                  </Text>
                  {idx() < allItems().length - 1 ? (
                    <ShadcnSeparator dark={dark()} />
                  ) : null}
                </View>
              )}
            </For>
          </View>
        </View>
        {/* Interactive draggable ScrollArea scrollbar rail + thumb */}
        <View
          ref={(current) => {
            scrollbarNode = current;
          }}
          class="w-[22] h-[160] items-center justify-center shrink-0"
        >
          <View
            class={
              dark()
                ? "relative w-[8] h-[148] rounded-full bg-[#18181B]"
                : "relative w-[8] h-[148] rounded-full bg-[#F4F4F5]"
            }
            style={{ radius: 4 }}
          >
            <View
              class={
                draggingThumb()
                  ? dark()
                    ? "w-[8] h-[36] rounded-full bg-[#71717A]"
                    : "w-[8] h-[36] rounded-full bg-[#52525B]"
                  : dark()
                    ? "w-[8] h-[36] rounded-full bg-[#3F3F46]"
                    : "w-[8] h-[36] rounded-full bg-[#A1A1AA]"
              }
              style={{ radius: 4, translateY: thumbY() }}
            />
          </View>
        </View>
        {/* Top ScrollFade mask */}
        <Show when={hasTopFade()}>
          <View
            class="absolute left-0 right-0 top-0 h-[24]"
            style={{
              hitPass: 1,
              gradFrom: dark() ? 0xff0b0909 : 0xffffffff,
              gradTo: dark() ? 0x000b0909 : 0x00ffffff,
              gradDir: 0,
            }}
          />
        </Show>
        {/* Bottom ScrollFade mask */}
        <Show when={hasBottomFade()}>
          <View
            class="absolute left-0 right-0 bottom-0 h-[24]"
            style={{
              hitPass: 1,
              gradFrom: dark() ? 0x000b0909 : 0x00ffffff,
              gradTo: dark() ? 0xff0b0909 : 0xffffffff,
              gradDir: 0,
            }}
          />
        </Show>
      </View>
    </View>
  );
}

export const ShadcnScrollFade = ShadcnScrollArea;

export function ShadcnAspectRatio(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [ratio, setRatio] = createSignal<"16:9" | "4:3" | "1:1">("16:9");
  const boxHeight = () => (ratio() === "16:9" ? 110 : ratio() === "4:3" ? 136 : 160);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          AspectRatio ({ratio()})
        </Text>
        <View class="flex-row items-center gap-1">
          <For each={["16:9", "4:3", "1:1"] as const}>
            {(r) => (
              <Pressable
                onPress={() => setRatio(r)}
                class={
                  ratio() === r
                    ? dark()
                      ? "h-[24] px-2 rounded-md bg-[#FAFAFA] items-center justify-center"
                      : "h-[24] px-2 rounded-md bg-[#18181B] items-center justify-center"
                    : dark()
                      ? "h-[24] px-2 rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
                      : "h-[24] px-2 rounded-md bg-white border-[#E4E4E7] items-center justify-center"
                }
                style={{ radius: 6 }}
              >
                <Text
                  class={
                    ratio() === r
                      ? dark()
                        ? "text-xs font-bold text-[#09090B]"
                        : "text-xs font-bold text-[#FAFAFA]"
                      : dark()
                        ? "text-xs text-[#A1A1AA]"
                        : "text-xs text-[#71717A]"
                  }
                >
                  {r}
                </Text>
              </Pressable>
            )}
          </For>
        </View>
      </View>
      <View
        class={
          dark()
            ? "w-full rounded-xl bg-[#18181B] border-[#27272A] items-center justify-center flex-col gap-1 overflow-hidden"
            : "w-full rounded-xl bg-[#F4F4F5] border-[#E4E4E7] items-center justify-center flex-col gap-1 overflow-hidden"
        }
        style={{ height: boxHeight(), radius: 12, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-sm font-bold text-[#FAFAFA]"
              : "text-sm font-bold text-[#09090B]"
          }
        >
          Photo by Drew Beamer · {ratio()}
        </Text>
        <Text
          class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}
        >
          shadcn/ui AspectRatio container ({String(boxHeight())}px height)
        </Text>
      </View>
    </View>
  );
}

export function ShadcnButtonGroup(props: {
  items?: string[];
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const options = () => props.items ?? ["Archive", "Report", "Snooze", "Mark read"];
  const [selected, setSelected] = createSignal(options()[0] ?? "Archive");
  return (
    <View class="flex-col gap-1.5 w-full">
      <Text
        class={
          dark()
            ? "text-xs font-bold text-[#FAFAFA]"
            : "text-xs font-bold text-[#09090B]"
        }
      >
        ButtonGroup
      </Text>
      <View
        class={
          dark()
            ? "flex-row items-center rounded-lg bg-[#09090B] border-[#27272A] overflow-hidden"
            : "flex-row items-center rounded-lg bg-white border-[#E4E4E7] overflow-hidden"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <For each={options()}>
          {(label, idx) => {
            const active = () => selected() === label;
            return (
              <View
                class="flex-row items-center"
                style={{ grow: 1, shrink: 1, basis: 0 }}
              >
                <Pressable
                  onPress={() => setSelected(label)}
                  class={
                    active()
                      ? dark()
                        ? "h-[34] w-full bg-[#27272A] items-center justify-center"
                        : "h-[34] w-full bg-[#F4F4F5] items-center justify-center"
                      : "h-[34] w-full items-center justify-center"
                  }
                >
                  <Text
                    class={
                      active()
                        ? dark()
                          ? "text-xs font-bold text-[#FAFAFA]"
                          : "text-xs font-bold text-[#09090B]"
                        : dark()
                          ? "text-xs text-[#A1A1AA]"
                          : "text-xs text-[#71717A]"
                    }
                  >
                    {label}
                  </Text>
                </Pressable>
                {idx() < options().length - 1 ? (
                  <View
                    class={
                      dark()
                        ? "w-[1] h-[34] bg-[#27272A]"
                        : "w-[1] h-[34] bg-[#E4E4E7]"
                    }
                  />
                ) : null}
              </View>
            );
          }}
        </For>
      </View>
    </View>
  );
}

export function ShadcnCarousel(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const slides = [
    { num: 1, title: "Card Slide 1", subtitle: "Embla Carousel primitive" },
    { num: 2, title: "Card Slide 2", subtitle: "Touch & keyboard navigation" },
    { num: 3, title: "Card Slide 3", subtitle: "Snap alignment & loop" },
    { num: 4, title: "Card Slide 4", subtitle: "Responsive slide sizing" },
    { num: 5, title: "Card Slide 5", subtitle: "Accessible prev/next controls" },
  ];
  const [index, setIndex] = createSignal(0);
  const current = () => slides[index()] ?? slides[0]!;
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          Carousel ({String(index() + 1)} / {String(slides.length)})
        </Text>
        <View class="flex-row items-center gap-1.5">
          <Pressable
            onPress={() =>
              setIndex((prev) => (prev - 1 + slides.length) % slides.length)
            }
            class={
              dark()
                ? "w-[28] h-[28] rounded-full bg-[#18181B] border-[#27272A] items-center justify-center"
                : "w-[28] h-[28] rounded-full bg-white border-[#E4E4E7] items-center justify-center"
            }
            style={{ radius: 13, borderWidth: 1 }}
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>←</Text>
          </Pressable>
          <Pressable
            onPress={() => setIndex((prev) => (prev + 1) % slides.length)}
            class={
              dark()
                ? "w-[28] h-[28] rounded-full bg-[#18181B] border-[#27272A] items-center justify-center"
                : "w-[28] h-[28] rounded-full bg-white border-[#E4E4E7] items-center justify-center"
            }
            style={{ radius: 13, borderWidth: 1 }}
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>→</Text>
          </Pressable>
        </View>
      </View>
      <View
        class={
          dark()
            ? "w-full h-[108] rounded-xl bg-[#09090B] border-[#27272A] items-center justify-center flex-col gap-1"
            : "w-full h-[108] rounded-xl bg-white border-[#E4E4E7] items-center justify-center flex-col gap-1"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <Text
          class={
            dark()
              ? "text-2xl font-bold text-[#FAFAFA]"
              : "text-2xl font-bold text-[#09090B]"
          }
        >
          {String(current().num)}
        </Text>
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          {current().title}
        </Text>
        <Text
          class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}
        >
          {current().subtitle}
        </Text>
      </View>
    </View>
  );
}

const SHADCN_CHART_DATA = [
  { month: "Jan", desktop: 186, mobile: 120 },
  { month: "Feb", desktop: 305, mobile: 210 },
  { month: "Mar", desktop: 237, mobile: 180 },
  { month: "Apr", desktop: 173, mobile: 290 },
  { month: "May", desktop: 209, mobile: 160 },
  { month: "Jun", desktop: 314, mobile: 240 },
];

export function ShadcnChart(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [series, setSeries] = createSignal<"desktop" | "mobile">("desktop");
  const [activeMonth, setActiveMonth] = createSignal("Feb");
  const activePoint = () =>
    SHADCN_CHART_DATA.find((d) => d.month === activeMonth()) ??
    SHADCN_CHART_DATA[1]!;
  return (
    <View
      class={
        dark()
          ? "flex-col rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
          : "flex-col rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View class="flex-row items-center justify-between px-3 py-2.5 w-full">
        <View class="flex-col gap-0.5">
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#FAFAFA]"
                : "text-xs font-bold text-[#09090B]"
            }
          >
            Bar Chart - Interactive
          </Text>
          <Text
            class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}
          >
            {activePoint().month}: {String(activePoint()[series()])} visitors
          </Text>
        </View>
        <View class="flex-row items-center gap-1">
          <Pressable
            onPress={() => setSeries("desktop")}
            class={
              series() === "desktop"
                ? dark()
                  ? "px-2.5 py-1 rounded-md bg-[#27272A]"
                  : "px-2.5 py-1 rounded-md bg-[#F4F4F5]"
                : "px-2.5 py-1 rounded-md"
            }
            style={{ radius: 6 }}
          >
            <Text
              class={
                dark()
                  ? "text-xs font-bold text-[#FAFAFA]"
                  : "text-xs font-bold text-[#09090B]"
              }
            >
              Desktop 24.8k
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSeries("mobile")}
            class={
              series() === "mobile"
                ? dark()
                  ? "px-2.5 py-1 rounded-md bg-[#27272A]"
                  : "px-2.5 py-1 rounded-md bg-[#F4F4F5]"
                : "px-2.5 py-1 rounded-md"
            }
            style={{ radius: 6 }}
          >
            <Text
              class={
                dark()
                  ? "text-xs font-bold text-[#FAFAFA]"
                  : "text-xs font-bold text-[#09090B]"
              }
            >
              Mobile 25.0k
            </Text>
          </Pressable>
        </View>
      </View>
      <ShadcnSeparator dark={dark()} />
      <View class="flex-row items-end justify-between px-4 pt-4 pb-2.5 h-[112] w-full">
        <For each={SHADCN_CHART_DATA}>
          {(item) => {
            const val = () => item[series()];
            const barH = () => Math.max(16, Math.round((val() / 320) * 68));
            const selected = () => activeMonth() === item.month;
            return (
              <Pressable
                onPress={() => setActiveMonth(item.month)}
                class="flex-col items-center gap-1"
              >
                <View
                  class={
                    selected()
                      ? dark()
                        ? "w-[28] rounded-md bg-[#FAFAFA]"
                        : "w-[28] rounded-md bg-[#18181B]"
                      : dark()
                        ? "w-[28] rounded-md bg-[#3F3F46]"
                        : "w-[28] rounded-md bg-[#A1A1AA]"
                  }
                  style={{ height: barH(), radius: 4 }}
                />
                <Text
                  class={
                    selected()
                      ? dark()
                        ? "text-xs font-bold text-[#FAFAFA]"
                        : "text-xs font-bold text-[#09090B]"
                      : dark()
                        ? "text-xs text-[#A1A1AA]"
                        : "text-xs text-[#71717A]"
                  }
                >
                  {item.month}
                </Text>
              </Pressable>
            );
          }}
        </For>
      </View>
    </View>
  );
}

export function ShadcnCombobox(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const frameworks = ["Next.js", "SvelteKit", "Nuxt.js", "Remix", "Astro"];
  const [selected, setSelected] = createSignal("Next.js");
  const [open, setOpen] = createSignal(true);
  const [filter, setFilter] = createSignal<"all" | "n" | "s">("all");
  const filtered = createMemo(() => {
    if (filter() === "n") return frameworks.filter((f) => f.startsWith("N"));
    if (filter() === "s") return frameworks.filter((f) => f.startsWith("S") || f.startsWith("A"));
    return frameworks;
  });
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text
          class={
            dark()
              ? "text-xs font-bold text-[#FAFAFA]"
              : "text-xs font-bold text-[#09090B]"
          }
        >
          Combobox
        </Text>
        <Pressable
          onPress={() => setOpen((prev) => !prev)}
          class={
            dark()
              ? "h-[34] px-3 rounded-lg bg-[#09090B] border-[#27272A] items-center justify-between flex-row gap-2"
              : "h-[34] px-3 rounded-lg bg-white border-[#E4E4E7] items-center justify-between flex-row gap-2"
          }
          style={{ radius: 8, borderWidth: 1 }}
        >
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            {selected()}
          </Text>
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
            ⇕
          </Text>
        </Pressable>
      </View>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-col rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
              : "flex-col rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
          }
          style={{ radius: 12, borderWidth: 1 }}
        >
          <View class="flex-row items-center justify-between px-3 py-2">
            <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
              ⌕ Search framework...
            </Text>
            <View class="flex-row items-center gap-1">
              <For each={["all", "n", "s"] as const}>
                {(f) => (
                  <Pressable
                    onPress={() => setFilter(f)}
                    class={
                      filter() === f
                        ? dark()
                          ? "px-1.5 py-0.5 rounded bg-[#27272A]"
                          : "px-1.5 py-0.5 rounded bg-[#F4F4F5]"
                        : "px-1.5 py-0.5 rounded"
                    }
                    style={{ radius: 4 }}
                  >
                    <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
                      {f === "all" ? "All" : f.toUpperCase()}
                    </Text>
                  </Pressable>
                )}
              </For>
            </View>
          </View>
          <ShadcnSeparator dark={dark()} />
          <View class="flex-col p-1 gap-0.5 w-full">
            <For each={filtered()}>
              {(fw) => (
                <Pressable
                  onPress={() => setSelected(fw)}
                  class={
                    selected() === fw
                      ? dark()
                        ? "flex-row items-center justify-between px-2.5 py-1.5 rounded-md bg-[#27272A] w-full"
                        : "flex-row items-center justify-between px-2.5 py-1.5 rounded-md bg-[#F4F4F5] w-full"
                      : "flex-row items-center justify-between px-2.5 py-1.5 rounded-md w-full"
                  }
                  style={{ radius: 6 }}
                >
                  <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
                    {fw}
                  </Text>
                  <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
                    {selected() === fw ? "✓" : " "}
                  </Text>
                </Pressable>
              )}
            </For>
          </View>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnContextMenu(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [open, setOpen] = createSignal(true);
  const [bookmarks, setBookmarks] = createSignal(true);
  const [person, setPerson] = createSignal("pedro");
  return (
    <View class="flex-col gap-2 w-full">
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        class={
          dark()
            ? "w-full h-[54] rounded-xl bg-[#18181B] border-[#27272A] items-center justify-center"
            : "w-full h-[54] rounded-xl bg-[#FAFAFA] border-[#E4E4E7] items-center justify-center"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          Right click / tap here for ContextMenu ({open() ? "open" : "closed"})
        </Text>
      </Pressable>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-col gap-0.5 p-1.5 rounded-xl bg-[#09090B] border-[#27272A] w-full"
              : "flex-col gap-0.5 p-1.5 rounded-xl bg-white border-[#E4E4E7] w-full"
          }
          style={{ radius: 12, borderWidth: 1, shadow: 1 }}
        >
          <View class="flex-row items-center justify-between px-2 py-1.5">
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>Back</Text>
            <ShadcnKbd keys="⌘[" dark={dark()} />
          </View>
          <View class="flex-row items-center justify-between px-2 py-1.5">
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>Reload</Text>
            <ShadcnKbd keys="⌘R" dark={dark()} />
          </View>
          <ShadcnSeparator dark={dark()} />
          <Pressable
            onPress={() => setBookmarks((prev) => !prev)}
            class="flex-row items-center justify-between px-2 py-1.5"
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
              {bookmarks() ? "✓ Show Bookmarks Bar" : "  Show Bookmarks Bar"}
            </Text>
            <ShadcnKbd keys="⇧⌘B" dark={dark()} />
          </Pressable>
          <ShadcnSeparator dark={dark()} />
          <Text class={dark() ? "text-xs font-bold text-[#A1A1AA] px-2 py-1" : "text-xs font-bold text-[#71717A] px-2 py-1"}>
            People
          </Text>
          <Pressable
            onPress={() => setPerson("pedro")}
            class="flex-row items-center justify-between px-2 py-1"
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
              {person() === "pedro" ? "● Pedro Duarte" : "○ Pedro Duarte"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setPerson("colm")}
            class="flex-row items-center justify-between px-2 py-1"
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
              {person() === "colm" ? "● Colm Tuite" : "○ Colm Tuite"}
            </Text>
          </Pressable>
        </View>
      </Show>
    </View>
  );
}

const SHADCN_PAYMENTS = [
  { id: "m5gr84i9", status: "Success", email: "ken99@yahoo.com", amount: "$316.00" },
  { id: "3u1reuv4", status: "Success", email: "Abe45@gmail.com", amount: "$242.00" },
  { id: "derv1ws0", status: "Processing", email: "Monserrat44@gmail.com", amount: "$837.00" },
  { id: "5kma53ae", status: "Failed", email: "carmella@hotmail.com", amount: "$721.00" },
];

export function ShadcnDataTable(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [selectedIds, setSelectedIds] = createSignal<string[]>(["m5gr84i9"]);
  const [statusFilter, setStatusFilter] = createSignal<"All" | "Success" | "Processing">("All");
  const rows = createMemo(() =>
    statusFilter() === "All"
      ? SHADCN_PAYMENTS
      : SHADCN_PAYMENTS.filter((r) => r.status === statusFilter()),
  );
  const toggleRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between flex-wrap gap-1.5 w-full">
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          DataTable (Payments)
        </Text>
        <View class="flex-row items-center gap-1">
          <For each={["All", "Success", "Processing"] as const}>
            {(st) => (
              <Pressable
                onPress={() => setStatusFilter(st)}
                class={
                  statusFilter() === st
                    ? dark()
                      ? "px-2 py-1 rounded-md bg-[#27272A]"
                      : "px-2 py-1 rounded-md bg-[#F4F4F5]"
                    : "px-2 py-1 rounded-md"
                }
                style={{ radius: 6 }}
              >
                <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
                  {st}
                </Text>
              </Pressable>
            )}
          </For>
        </View>
      </View>
      <View
        class={
          dark()
            ? "flex-col rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
            : "flex-col rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <View
          class={
            dark()
              ? "flex-row items-center justify-between px-3 py-2 bg-[#18181B]"
              : "flex-row items-center justify-between px-3 py-2 bg-[#FAFAFA]"
          }
        >
          <Text class={dark() ? "text-xs font-bold text-[#A1A1AA]" : "text-xs font-bold text-[#71717A]"}>
            Status
          </Text>
          <Text class={dark() ? "text-xs font-bold text-[#A1A1AA]" : "text-xs font-bold text-[#71717A]"}>
            Email ↕
          </Text>
          <Text class={dark() ? "text-xs font-bold text-[#A1A1AA]" : "text-xs font-bold text-[#71717A]"}>
            Amount
          </Text>
        </View>
        <ShadcnSeparator dark={dark()} />
        <For each={rows()}>
          {(row) => {
            const checked = () => selectedIds().includes(row.id);
            return (
              <View class="flex-col w-full">
                <Pressable
                  onPress={() => toggleRow(row.id)}
                  class={
                    checked()
                      ? dark()
                        ? "flex-row items-center justify-between px-3 py-2 bg-[#27272A] w-full"
                        : "flex-row items-center justify-between px-3 py-2 bg-[#F4F4F5] w-full"
                      : "flex-row items-center justify-between px-3 py-2 w-full"
                  }
                >
                  <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
                    {checked() ? "☑ " : "☐ "}
                    {row.status}
                  </Text>
                  <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
                    {row.email}
                  </Text>
                  <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
                    {row.amount}
                  </Text>
                </Pressable>
                <ShadcnSeparator dark={dark()} />
              </View>
            );
          }}
        </For>
        <View class="flex-row items-center justify-between px-3 py-2">
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
            {String(rows().filter((row) => selectedIds().includes(row.id)).length)} of {String(rows().length)} selected
          </Text>
          <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
            Columns ▾
          </Text>
        </View>
      </View>
    </View>
  );
}

export function ShadcnDatePicker(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [day, setDay] = createSignal(14);
  const [open, setOpen] = createSignal(false);
  return (
    <View class="flex-col gap-2 w-full">
      <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
        DatePicker
      </Text>
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        class={
          dark()
            ? "flex-row items-center justify-between h-[38] px-3 rounded-lg bg-[#09090B] border-[#27272A] w-full"
            : "flex-row items-center justify-between h-[38] px-3 rounded-lg bg-white border-[#E4E4E7] w-full"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
          📅 November {String(day())}, 2026
        </Text>
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          {open() ? "Close ▴" : "Pick date ▾"}
        </Text>
      </Pressable>
      <Show when={open()}>
        <ShadcnCalendar
          monthLabel="November 2026"
          selectedDay={day()}
          onSelectDay={(next) => {
            setDay(next);
            setOpen(false);
          }}
          dark={dark()}
        />
      </Show>
    </View>
  );
}

export function ShadcnDrawer(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [goal, setGoal] = createSignal(350);
  return (
    <View
      class={
        dark()
          ? "flex-col items-center gap-3 p-4 rounded-xl bg-[#09090B] border-[#27272A] w-full"
          : "flex-col items-center gap-3 p-4 rounded-xl bg-white border-[#E4E4E7] w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View
        class={
          dark()
            ? "w-[48] h-[6] rounded-full bg-[#27272A]"
            : "w-[48] h-[6] rounded-full bg-[#E4E4E7]"
        }
        style={{ radius: 3 }}
      />
      <View class="flex-col items-center gap-0.5">
        <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>
          Move Goal (Drawer)
        </Text>
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          Set your daily activity goal.
        </Text>
      </View>
      <View class="flex-row items-center justify-between w-full px-4">
        <Pressable
          onPress={() => setGoal((g) => Math.max(200, g - 10))}
          class={
            dark()
              ? "w-[32] h-[32] rounded-full bg-[#18181B] border-[#27272A] items-center justify-center"
              : "w-[32] h-[32] rounded-full bg-white border-[#E4E4E7] items-center justify-center"
          }
          style={{ radius: 15, borderWidth: 1 }}
        >
          <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>−</Text>
        </Pressable>
        <View class="flex-col items-center">
          <Text class={dark() ? "text-2xl font-bold text-[#FAFAFA]" : "text-2xl font-bold text-[#09090B]"}>
            {String(goal())}
          </Text>
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
            CALORIES/DAY
          </Text>
        </View>
        <Pressable
          onPress={() => setGoal((g) => Math.min(600, g + 10))}
          class={
            dark()
              ? "w-[32] h-[32] rounded-full bg-[#18181B] border-[#27272A] items-center justify-center"
              : "w-[32] h-[32] rounded-full bg-white border-[#E4E4E7] items-center justify-center"
          }
          style={{ radius: 15, borderWidth: 1 }}
        >
          <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ShadcnEmpty(props: {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View
      class={
        dark()
          ? "flex-col items-center justify-center gap-2.5 p-5 rounded-xl bg-[#09090B] border-[#27272A] w-full"
          : "flex-col items-center justify-center gap-2.5 p-5 rounded-xl bg-white border-[#E4E4E7] w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View
        class={
          dark()
            ? "w-[36] h-[36] rounded-lg bg-[#18181B] border-[#27272A] items-center justify-center"
            : "w-[36] h-[36] rounded-lg bg-[#F4F4F5] border-[#E4E4E7] items-center justify-center"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>
          ∅
        </Text>
      </View>
      <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>
        {props.title ?? "No projects created (Empty)"}
      </Text>
      <Text class={dark() ? "text-xs text-[#A1A1AA] text-center" : "text-xs text-[#71717A] text-center"}>
        {props.description ?? "You haven't created any projects yet. Get started by creating a new one."}
      </Text>
      <MobileFilledButton
        label={props.actionLabel ?? "Create project"}
        compact
        onPress={props.onAction}
      />
    </View>
  );
}

export function ShadcnLabel(props: {
  text: string;
  required?: boolean;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-row items-center gap-1">
      <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
        {props.text}
      </Text>
      {props.required ? <Text class="text-xs font-bold text-rose-500">*</Text> : null}
    </View>
  );
}

export function ShadcnFormField(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [username, setUsername] = createSignal("@shadcn");
  const isInvalid = () => username().length < 3;
  return (
    <View class="flex-col gap-1.5 w-full">
      <ShadcnLabel text="Username (Form / Field / Label)" required dark={dark()} />
      <View class="flex-row items-center gap-2 w-full">
        <View
          class={
            dark()
              ? "flex-row items-center h-[36] px-3 rounded-lg bg-[#09090B] border-[#27272A]"
              : "flex-row items-center h-[36] px-3 rounded-lg bg-white border-[#E4E4E7]"
          }
          style={{ grow: 1, shrink: 1, basis: 0, radius: 8, borderWidth: 1 }}
        >
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            {username()}
          </Text>
        </View>
        <MobileOutlinedButton
          label={isInvalid() ? "Fix" : "Test error"}
          compact
          onPress={() => setUsername(isInvalid() ? "@shadcn" : "a")}
        />
      </View>
      <Text
        class={
          isInvalid()
            ? "text-xs text-rose-500"
            : dark()
              ? "text-xs text-[#A1A1AA]"
              : "text-xs text-[#71717A]"
        }
      >
        {isInvalid()
          ? "Username must be at least 2 characters."
          : "This is your public display name."}
      </Text>
    </View>
  );
}

export function ShadcnInputGroup(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-col gap-2 w-full">
      <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
        InputGroup
      </Text>
      <View
        class={
          dark()
            ? "flex-row items-center h-[36] rounded-lg bg-[#09090B] border-[#27272A] overflow-hidden w-full"
            : "flex-row items-center h-[36] rounded-lg bg-white border-[#E4E4E7] overflow-hidden w-full"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <View
          class={
            dark()
              ? "h-[36] px-2.5 bg-[#18181B] items-center justify-center"
              : "h-[36] px-2.5 bg-[#F4F4F5] items-center justify-center"
          }
        >
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
            https://
          </Text>
        </View>
        <View
          class="px-2.5 justify-center"
          style={{ grow: 1, shrink: 1, basis: 0 }}
        >
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            ui.shadcn.com
          </Text>
        </View>
        <View
          class={
            dark()
              ? "h-[36] px-2.5 bg-[#18181B] items-center justify-center"
              : "h-[36] px-2.5 bg-[#F4F4F5] items-center justify-center"
          }
        >
          <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
            .com
          </Text>
        </View>
      </View>
    </View>
  );
}

export function ShadcnItem(props: {
  title: string;
  description: string;
  badge?: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View
      class={
        dark()
          ? "flex-row items-center justify-between gap-3 p-3 rounded-xl bg-[#09090B] border-[#27272A] w-full"
          : "flex-row items-center justify-between gap-3 p-3 rounded-xl bg-white border-[#E4E4E7] w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View class="flex-col gap-0.5" style={{ grow: 1, shrink: 1, basis: 0 }}>
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          {props.title}
        </Text>
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          {props.description}
        </Text>
      </View>
      {props.badge ? <MobileBadge label={props.badge} tone="neutral" /> : null}
    </View>
  );
}

export function ShadcnMenubar(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const menus = ["File", "Edit", "View", "Profiles"];
  const [active, setActive] = createSignal("File");
  return (
    <View class="flex-col gap-1.5 w-full">
      <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
        Menubar
      </Text>
      <View
        class={
          dark()
            ? "flex-row items-center gap-1 p-1 rounded-lg bg-[#09090B] border-[#27272A]"
            : "flex-row items-center gap-1 p-1 rounded-lg bg-white border-[#E4E4E7]"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <For each={menus}>
          {(menu) => (
            <Pressable
              onPress={() => setActive(menu)}
              class={
                active() === menu
                  ? dark()
                    ? "px-2.5 py-1 rounded-md bg-[#27272A]"
                    : "px-2.5 py-1 rounded-md bg-[#F4F4F5]"
                  : "px-2.5 py-1 rounded-md"
              }
              style={{ radius: 6 }}
            >
              <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
                {menu}
              </Text>
            </Pressable>
          )}
        </For>
      </View>
      <View
        class={
          dark()
            ? "flex-col gap-0.5 p-1.5 rounded-xl bg-[#09090B] border-[#27272A] w-full"
            : "flex-col gap-0.5 p-1.5 rounded-xl bg-white border-[#E4E4E7] w-full"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <View class="flex-row items-center justify-between px-2 py-1">
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            {active()} → New Tab
          </Text>
          <ShadcnKbd keys="⌘T" dark={dark()} />
        </View>
        <View class="flex-row items-center justify-between px-2 py-1">
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            {active()} → New Window
          </Text>
          <ShadcnKbd keys="⌘N" dark={dark()} />
        </View>
        <ShadcnSeparator dark={dark()} />
        <View class="flex-row items-center justify-between px-2 py-1">
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            Print...
          </Text>
          <ShadcnKbd keys="⌘P" dark={dark()} />
        </View>
      </View>
    </View>
  );
}

export function ShadcnNavigationMenu(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [tab, setTab] = createSignal<"start" | "components" | "docs">("start");
  return (
    <View class="flex-col gap-2 w-full">
      <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
        NavigationMenu
      </Text>
      <View class="flex-row items-center gap-1.5 flex-wrap">
        <For
          each={[
            { id: "start" as const, label: "Getting started ▾" },
            { id: "components" as const, label: "Components ▾" },
            { id: "docs" as const, label: "Documentation" },
          ]}
        >
          {(item) => (
            <Pressable
              onPress={() => setTab(item.id)}
              class={
                tab() === item.id
                  ? dark()
                    ? "h-[32] px-3 rounded-md bg-[#27272A] items-center justify-center"
                    : "h-[32] px-3 rounded-md bg-[#F4F4F5] items-center justify-center"
                  : dark()
                    ? "h-[32] px-3 rounded-md bg-[#09090B] border-[#27272A] items-center justify-center"
                    : "h-[32] px-3 rounded-md bg-white border-[#E4E4E7] items-center justify-center"
              }
              style={{ radius: 6, borderWidth: 1 }}
            >
              <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
                {item.label}
              </Text>
            </Pressable>
          )}
        </For>
      </View>
      <View
        class={
          dark()
            ? "flex-col gap-1.5 p-3 rounded-xl bg-[#09090B] border-[#27272A] w-full"
            : "flex-col gap-1.5 p-3 rounded-xl bg-white border-[#E4E4E7] w-full"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          {tab() === "start"
            ? "shadcn/ui — Re-usable primitives"
            : tab() === "components"
              ? "50+ Built-in Components"
              : "CLI & Theme Reference"}
        </Text>
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          {tab() === "start"
            ? "Beautifully designed components that you can copy and paste into your apps."
            : tab() === "components"
              ? "ScrollArea, DataTable, Command, Calendar, Drawer, Resizable, Sidebar and more."
              : "Configure Zinc light/dark tokens and typography scales."}
        </Text>
      </View>
    </View>
  );
}

export function ShadcnPopover(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [open, setOpen] = createSignal(true);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between">
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          Popover (Dimensions)
        </Text>
        <Pressable
          onPress={() => setOpen((prev) => !prev)}
          class={
            dark()
              ? "h-[30] px-2.5 rounded-md bg-[#18181B] border-[#27272A] items-center justify-center"
              : "h-[30] px-2.5 rounded-md bg-white border-[#E4E4E7] items-center justify-center"
          }
          style={{ radius: 6, borderWidth: 1 }}
        >
          <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
            {open() ? "Close Popover" : "Open Popover"}
          </Text>
        </Pressable>
      </View>
      <Show when={open()}>
        <View
          class={
            dark()
              ? "flex-col gap-2 p-3 rounded-xl bg-[#09090B] border-[#27272A] w-full"
              : "flex-col gap-2 p-3 rounded-xl bg-white border-[#E4E4E7] w-full"
          }
          style={{ radius: 12, borderWidth: 1, shadow: 1 }}
        >
          <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
            Dimensions
          </Text>
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
            Set the dimensions for the layer.
          </Text>
          <For
            each={[
              { k: "Width", v: "100%" },
              { k: "Max. width", v: "300px" },
              { k: "Height", v: "25px" },
            ]}
          >
            {(row) => (
              <View class="flex-row items-center justify-between w-full">
                <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{row.k}</Text>
                <View
                  class={
                    dark()
                      ? "px-2.5 py-1 rounded-md bg-[#18181B] border-[#27272A]"
                      : "px-2.5 py-1 rounded-md bg-[#FAFAFA] border-[#E4E4E7]"
                  }
                  style={{ radius: 6, borderWidth: 1 }}
                >
                  <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>{row.v}</Text>
                </View>
              </View>
            )}
          </For>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnResizable(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const routeActive = useRouteActive();
  const [split, setSplit] = createSignal(35);
  const [draggingHandle, setDraggingHandle] = createSignal(false);
  const cycleSplit = () =>
    setSplit((prev) => (prev < 30 ? 35 : prev < 45 ? 50 : 25));
  let handleNode: NodeMirror | undefined;
  createGesture({
    axis: "any",
    region: {
      node: () => (routeActive() ? handleNode : undefined),
    },
    panSlop: 1,
    onDown: () => {
      if (routeActive()) setDraggingHandle(true);
    },
    onPanMove: (contact) => {
      if (!routeActive()) return;
      setSplit((prev) =>
        Math.max(20, Math.min(80, Math.round(prev + contact.fdx * 0.35))),
      );
    },
    onTap: cycleSplit,
    onUp: () => setDraggingHandle(false),
    onCancel: () => setDraggingHandle(false),
  });
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          Resizable ({String(split())}% / {String(100 - split())}%)
        </Text>
        <MobileTextButton label="Resize ⇔" compact onPress={cycleSplit} />
      </View>
      <View
        class={
          dark()
            ? "flex-row h-[96] rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
            : "flex-row h-[96] rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
        }
        style={{ radius: 12, borderWidth: 1 }}
      >
        <View
          class="items-center justify-center"
          style={{ grow: split(), shrink: 1, basis: 0 }}
        >
          <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
            Sidebar ({String(split())}%)
          </Text>
        </View>
        <View
          ref={(current) => {
            handleNode = current;
          }}
          class={
            draggingHandle()
              ? dark()
                ? "w-[18] h-[96] bg-[#27272A] items-center justify-center"
                : "w-[18] h-[96] bg-[#E4E4E7] items-center justify-center"
              : dark()
                ? "w-[18] h-[96] bg-[#18181B] items-center justify-center"
                : "w-[18] h-[96] bg-[#F4F4F5] items-center justify-center"
          }
        >
          <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>⋮</Text>
        </View>
        <View
          class="flex-col"
          style={{ grow: 100 - split(), shrink: 1, basis: 0 }}
        >
          <View class="flex-1 items-center justify-center">
            <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
              Header
            </Text>
          </View>
          <ShadcnSeparator dark={dark()} />
          <View class="flex-1 items-center justify-center">
            <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
              Content ({String(100 - split())}%)
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

export function ShadcnSheet(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [saved, setSaved] = createSignal(false);
  return (
    <View
      class={
        dark()
          ? "flex-col gap-2.5 p-3.5 rounded-xl bg-[#09090B] border-[#27272A] w-full"
          : "flex-col gap-2.5 p-3.5 rounded-xl bg-white border-[#E4E4E7] w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View class="flex-row items-center justify-between">
        <Text class={dark() ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>
          Edit profile (Sheet)
        </Text>
        <MobileBadge label={saved() ? "Saved" : "Side Sheet"} tone={saved() ? "success" : "neutral"} />
      </View>
      <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
        Make changes to your profile here. Click save when you're done.
      </Text>
      <View class="flex-row items-center justify-between">
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>Name</Text>
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>Pedro Duarte</Text>
      </View>
      <View class="flex-row items-center justify-between">
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>Username</Text>
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>@peduarte</Text>
      </View>
      <MobileFilledButton
        label="Save changes"
        compact
        onPress={() => setSaved(true)}
      />
    </View>
  );
}

export function ShadcnSidebar(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [collapsed, setCollapsed] = createSignal(false);
  const [activeNav, setActiveNav] = createSignal("Playground");
  return (
    <View
      class={
        dark()
          ? "flex-row rounded-xl bg-[#09090B] border-[#27272A] overflow-hidden w-full"
          : "flex-row rounded-xl bg-white border-[#E4E4E7] overflow-hidden w-full"
      }
      style={{ radius: 12, borderWidth: 1 }}
    >
      <View
        class={
          dark()
            ? "flex-col gap-1.5 p-2.5 bg-[#18181B]"
            : "flex-col gap-1.5 p-2.5 bg-[#FAFAFA]"
        }
        style={{ width: collapsed() ? 52 : 132 }}
      >
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          {collapsed() ? "AI" : "Acme Inc"}
        </Text>
        <ShadcnSeparator dark={dark()} />
        <For each={["Playground", "Models", "Docs"]}>
          {(nav) => (
            <Pressable
              onPress={() => setActiveNav(nav)}
              class={
                activeNav() === nav
                  ? dark()
                    ? "px-2 py-1.5 rounded-md bg-[#27272A]"
                    : "px-2 py-1.5 rounded-md bg-[#E4E4E7]"
                  : "px-2 py-1.5 rounded-md"
              }
              style={{ radius: 6 }}
            >
              <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
                {collapsed() ? nav.slice(0, 1) : nav}
              </Text>
            </Pressable>
          )}
        </For>
      </View>
      <View
        class="flex-col p-3 gap-2"
        style={{ grow: 1, shrink: 1, basis: 0 }}
      >
        <View class="flex-row items-center justify-between">
          <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
            Sidebar · {activeNav()}
          </Text>
          <Pressable
            onPress={() => setCollapsed((prev) => !prev)}
            class={
              dark()
                ? "px-2 py-1 rounded bg-[#18181B] border-[#27272A]"
                : "px-2 py-1 rounded bg-[#F4F4F5] border-[#E4E4E7]"
            }
            style={{ radius: 4, borderWidth: 1 }}
          >
            <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
              {collapsed() ? "Expand ▸" : "Collapse ◂"}
            </Text>
          </Pressable>
        </View>
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          Collapsible app sidebar with rail mode and active route state.
        </Text>
      </View>
    </View>
  );
}

export function ShadcnSpinner(props: {
  label?: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-row items-center gap-2 flex-wrap">
      <View
        class={
          dark()
            ? "flex-row items-center gap-1.5 h-[32] px-3 rounded-lg bg-[#18181B] border-[#27272A]"
            : "flex-row items-center gap-1.5 h-[32] px-3 rounded-lg bg-[#F4F4F5] border-[#E4E4E7]"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs font-bold text-[#FAFAFA]" : "text-xs font-bold text-[#09090B]"}>
          ◌
        </Text>
        <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
          {props.label ?? "Processing..."}
        </Text>
      </View>
      <View
        class={
          dark()
            ? "flex-row items-center gap-1.5 h-[32] px-3 rounded-lg bg-[#09090B] border-[#27272A]"
            : "flex-row items-center gap-1.5 h-[32] px-3 rounded-lg bg-white border-[#E4E4E7]"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          ⟳ Syncing workspace
        </Text>
      </View>
    </View>
  );
}

export function ShadcnTextarea(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [text, setText] = createSignal(
    "We are migrating the entire component library to shadcn/ui Zinc tokens.",
  );
  return (
    <View class="flex-col gap-1.5 w-full">
      <ShadcnLabel text="Your message (Textarea)" dark={dark()} />
      <View
        class={
          dark()
            ? "flex-col justify-between p-3 min-h-[68] rounded-lg bg-[#09090B] border-[#27272A] w-full"
            : "flex-col justify-between p-3 min-h-[68] rounded-lg bg-white border-[#E4E4E7] w-full"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
          {text()}
        </Text>
        <Text class={dark() ? "text-xs text-[#71717A]" : "text-xs text-[#A1A1AA]"}>
          {String(text().length)} chars
        </Text>
      </View>
      <View class="flex-row items-center justify-between">
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          Your message will be copied to the support team.
        </Text>
        <MobileOutlinedButton
          label="Sample text"
          compact
          onPress={() =>
            setText((prev) =>
              prev.startsWith("We are")
                ? "All 50+ shadcn/ui components are interactive in the showcase."
                : "We are migrating the entire component library to shadcn/ui Zinc tokens.",
            )
          }
        />
      </View>
    </View>
  );
}

export function ShadcnTooltip(props: {
  content?: string;
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  const [visible, setVisible] = createSignal(true);
  return (
    <View class="flex-row items-center gap-2 flex-wrap">
      <Pressable
        onPress={() => setVisible((prev) => !prev)}
        class={
          dark()
            ? "h-[32] px-3 rounded-lg bg-[#09090B] border-[#27272A] items-center justify-center"
            : "h-[32] px-3 rounded-lg bg-white border-[#E4E4E7] items-center justify-center"
        }
        style={{ radius: 8, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
          Tap Tooltip trigger
        </Text>
      </Pressable>
      <Show when={visible()}>
        <View
          class={
            dark()
              ? "h-[28] px-2.5 rounded-md bg-[#FAFAFA] items-center justify-center"
              : "h-[28] px-2.5 rounded-md bg-[#18181B] items-center justify-center"
          }
          style={{ radius: 6, shadow: 1 }}
        >
          <Text
            class={
              dark()
                ? "text-xs font-bold text-[#09090B]"
                : "text-xs font-bold text-[#FAFAFA]"
            }
          >
            {props.content ?? "Add to library (Tooltip)"}
          </Text>
        </View>
      </Show>
    </View>
  );
}

export function ShadcnTypography(props: {
  dark?: boolean;
}): JSX.Element {
  const dark = resolveDark(props);
  return (
    <View class="flex-col gap-2 w-full">
      <Text class={dark() ? "text-lg font-bold text-[#FAFAFA]" : "text-lg font-bold text-[#09090B]"}>
        Taxing Laughter: The Joke Tax Chronicles
      </Text>
      <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
        Once upon a time, in a far-off land, there was a very lazy king who spent all day lounging on his throne.
      </Text>
      <View
        class={
          dark()
            ? "pl-3 py-1 bg-[#18181B] border-[#27272A] rounded-md"
            : "pl-3 py-1 bg-[#F4F4F5] border-[#E4E4E7] rounded-md"
        }
        style={{ radius: 6, borderWidth: 1 }}
      >
        <Text class={dark() ? "text-xs text-[#FAFAFA]" : "text-xs text-[#09090B]"}>
          "After all," he said, "everyone enjoys a good joke, so it's only fair that they should pay for the privilege."
        </Text>
      </View>
      <View class="flex-row items-center gap-1.5 flex-wrap">
        <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
          Inline code:
        </Text>
        <ShadcnKbd keys="@radix-ui/react-scroll-area" dark={dark()} />
      </View>
    </View>
  );
}

// Public Design System & Compatibility vocabulary aliases.
// `Scaffold` is the standalone safe-area contract. Nested pages should use
// `MobileScaffold` (which defaults to `safeArea="none"`) or pass explicit
// edges when they own a different shell.
export const Scaffold = SafeAreaScaffold;
export const AppBar = MobileAppBar;
export const FilledButton = MobileFilledButton;
export const TonalButton = MobileTonalButton;
export const ElevatedButton = MobileFilledButton;
export const OutlinedButton = MobileOutlinedButton;
export const TextButton = MobileTextButton;
export const ListTile = MobileListTile;
export const Switch = MobileSwitch;
export const SegmentedControl = MobileSegmentedControl;
export const Tabs = MobileSegmentedControl;
export const Stepper = MobileStepper;
export const Slider = MobileStepper;
export const ProgressBar = MobileProgress;
export const Checkbox = MobileCheckbox;
export const RadioGroup = MobileRadioGroup;
export const Badge = MobileBadge;
export const Tag = MobileTag;
export const Avatar = MobileAvatar;
export const Accordion = MobileAccordion;
export const Skeleton = MobileSkeleton;
export const Alert = MobileAlert;
export const Toast = MobileToast;
export const Sonner = MobileToast;
export const Popup = MobilePopup;
export const Sheet = ShadcnSheet;
export const ActionSheet = MobileActionSheet;
export const Dialog = MobileDialog;
export const AlertDialog = MobileDialog;
export const Separator = ShadcnSeparator;
export const Kbd = ShadcnKbd;
export const CardHeader = ShadcnCardHeader;
export const CardTitle = ShadcnCardTitle;
export const CardDescription = ShadcnCardDescription;
export const CardContent = ShadcnCardContent;
export const CardFooter = ShadcnCardFooter;
export const Select = ShadcnSelect;
export const InputOTP = ShadcnInputOTP;
export const ToggleGroup = ShadcnToggleGroup;
export const Command = ShadcnCommand;
export const Table = ShadcnTable;
export const Calendar = ShadcnCalendar;
export const Breadcrumb = ShadcnBreadcrumb;
export const Pagination = ShadcnPagination;
export const HoverCard = ShadcnHoverCard;
export const DropdownMenu = ShadcnDropdownMenu;
export const Collapsible = ShadcnCollapsible;
export const ScrollArea = ShadcnScrollArea;
export const ScrollFade = ShadcnScrollFade;
export const AspectRatio = ShadcnAspectRatio;
export const ButtonGroup = ShadcnButtonGroup;
export const Carousel = ShadcnCarousel;
export const Chart = ShadcnChart;
export const Combobox = ShadcnCombobox;
export const ContextMenu = ShadcnContextMenu;
export const DataTable = ShadcnDataTable;
export const DatePicker = ShadcnDatePicker;
export const Drawer = ShadcnDrawer;
export const Empty = ShadcnEmpty;
export const Label = ShadcnLabel;
export const FormField = ShadcnFormField;
export const InputGroup = ShadcnInputGroup;
export const Item = ShadcnItem;
export const Menubar = ShadcnMenubar;
export const NavigationMenu = ShadcnNavigationMenu;
export const Popover = ShadcnPopover;
export const Resizable = ShadcnResizable;
export const Sidebar = ShadcnSidebar;
export const Spinner = ShadcnSpinner;
export const Textarea = ShadcnTextarea;
export const Tooltip = ShadcnTooltip;
export const Typography = ShadcnTypography;
