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

import { For, Show, children as resolveChildren, createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import { CompositorSurface, Focusable, Modal, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { buildLiquidGlassRecipe, type GlassShape } from "./legacy.ts";
import {
  ContourConsumedContext,
  SafeAreaScaffold,
  SafeAreaScaffoldContext,
  ScrollContourItem,
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

export type SemanticTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

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
  border: string;
  danger: string;
  success?: string;
  warning?: string;
}

export const MOBILE_THEME_LIGHT: MobileTheme = {
  name: "light",
  canvas: "bg-[#F5F6FA]",
  surface: "bg-white",
  surfaceMuted: "bg-[#EEF1F6]",
  surfaceElevated: "bg-[#F8FAFC]",
  ink: "text-[#17233B]",
  muted: "text-[#7C8799]",
  accent: "bg-[#315DEB]",
  accentPressed: "bg-[#2748C5]",
  accentSoft: "bg-[#E8EDFF]",
  accentInk: "text-[#315DEB]",
  border: "border-[#E5E9F2]",
  danger: "bg-[#B4233A]",
  success: "bg-[#147A52]",
  warning: "bg-[#936211]",
};

export const MOBILE_THEME_DARK: MobileTheme = {
  name: "dark",
  canvas: "bg-[#0E1728]",
  surface: "bg-[#17233B]",
  surfaceMuted: "bg-[#22314A]",
  surfaceElevated: "bg-[#1E2D4A]",
  ink: "text-white",
  muted: "text-[#B9C5D8]",
  accent: "bg-[#315DEB]",
  accentPressed: "bg-[#466DFF]",
  accentSoft: "bg-[#253B73]",
  accentInk: "text-[#93B4FF]",
  border: "border-[#30405A]",
  danger: "bg-[#B4233A]",
  success: "bg-[#199A68]",
  warning: "bg-[#D99B26]",
};

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

/**
 * Frame-driven state-change animation hook.
 * Whenever `key()` changes, progresses smoothly from `0.35` to `1.0` over
 * `frames` ticks using a cubic ease-out curve. Starting at `0.35` ensures
 * the element is immediately visible and hit-testable on frame 0 while still
 * producing a crisp entrance/state-change motion across subsequent frames.
 */
export function useStateTransition(key: () => unknown, frames = 10): () => number {
  const [progress, setProgress] = createSignal(0.35);
  let step = 0;
  let initialized = false;
  createEffect(() => {
    key();
    if (!initialized) {
      initialized = true;
      step = 0;
      setProgress(0.35);
      return;
    }
    step = 0;
    setProgress(0.35);
  });
  try {
    onFrame(() => {
      if (step < frames) {
        step += 1;
        const linear = Math.min(1, step / Math.max(1, frames));
        const eased = 1 - Math.pow(1 - linear, 3);
        setProgress(0.35 + 0.65 * eased);
      }
    }, { continuous: false });
  } catch {
    // Ignore when running in unit tests without an active frame scheduler.
  }
  return progress;
}

/**
 * Smoothly interpolates a numeric value (such as progress ratio or thumb
 * position) across frames when the target changes.
 */
export function useAnimatedNumber(target: () => number, rate = 0.38): () => number {
  const initial = target();
  const [current, setCurrent] = createSignal(initial);
  let goal = initial;
  createEffect(() => {
    goal = target();
    const prev = current();
    if (Math.abs(goal - prev) <= 0.002) {
      setCurrent(goal);
    } else {
      setCurrent(prev + (goal - prev) * rate);
    }
  });
  try {
    onFrame(() => {
      const prev = current();
      const diff = goal - prev;
      if (Math.abs(diff) <= 0.002) {
        if (prev !== goal) setCurrent(goal);
        return;
      }
      setCurrent(prev + diff * rate);
    }, { continuous: false });
  } catch {
    // Fallback when no frame loop is active.
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
      class={props.class ?? (theme().name === "dark" ? "flex-col w-full bg-[#0E1728] transition-colors duration-200 ease-out" : "flex-col w-full bg-[#F5F6FA] transition-colors duration-200 ease-out")}
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
  return (
    <ContourConsumedContext.Provider value={() => true}>
      <View
        ref={nodeRef}
        class="flex-row items-center gap-2 w-full h-[56] px-4 bg-transparent transition-colors duration-200 ease-out"
        style={appBarStyle()}
      >
        {props.leading}
        <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
          <Text class={dark() ? "text-base text-white font-bold" : "text-base text-[#17233B] font-bold"}>{props.title}</Text>
          {props.subtitle ? <Text class={dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.subtitle}</Text> : null}
        </View>
        {props.trailing}
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
        {props.title ? <Text class={theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text> : null}
        {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
        {props.children}
      </GlassSurface>
    );
  }
  return (
    <ScrollContourItem class={props.class ?? (theme().name === "dark"
      ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A] transition-colors duration-200 ease-out"
      : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2] transition-colors duration-200 ease-out")}>
      {props.title ? <Text class={theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text> : null}
      {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
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
  style?: ViewProps["style"];
  debugName?: string;
  disabled?: boolean;
}

export function MobileButton(props: MobileButtonProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const density = useDesignDensity();
  const kind = () => props.kind ?? "filled";
  const isCompact = () => props.compact === true || density() === "desktop";
  return (
    <Focusable
      class={props.class ?? (kind() === "outlined"
        ? (theme().name === "dark"
          ? (isCompact()
            ? "px-3 h-[36] items-center justify-center rounded-xl bg-transparent border-[#30405A] focus:bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
            : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent border-[#30405A] focus:bg-[#22314A] active:scale-95 transition-all duration-150 ease-out")
          : (isCompact()
            ? "px-3 h-[36] items-center justify-center rounded-xl bg-transparent border-[#D6DCE7] focus:bg-[#F7F8FC] active:scale-95 transition-all duration-150 ease-out"
            : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent border-[#D6DCE7] focus:bg-[#F7F8FC] active:scale-95 transition-all duration-150 ease-out"))
        : kind() === "tonal"
          ? (theme().name === "dark"
            ? (isCompact()
              ? "px-3 h-[36] items-center justify-center rounded-xl bg-[#253B73] focus:bg-[#314E96] active:scale-95 transition-all duration-150 ease-out"
              : "px-4 h-[44] items-center justify-center rounded-xl bg-[#253B73] focus:bg-[#314E96] active:scale-95 transition-all duration-150 ease-out")
            : (isCompact()
              ? "px-3 h-[36] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF] active:scale-95 transition-all duration-150 ease-out"
              : "px-4 h-[44] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF] active:scale-95 transition-all duration-150 ease-out"))
          : kind() === "text"
            ? (theme().name === "dark"
              ? (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-xl bg-transparent focus:bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#22314A] active:scale-95 transition-all duration-150 ease-out")
              : (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out"))
            : kind() === "danger"
              ? (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238] active:scale-95 transition-all duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238] active:scale-95 transition-all duration-150 ease-out")
              : (isCompact()
                ? "px-3 h-[36] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5] active:scale-95 transition-all duration-150 ease-out"
                : "px-4 h-[44] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5] active:scale-95 transition-all duration-150 ease-out"))}
      style={props.disabled
        ? { ...(props.style ?? {}), opacity: props.style?.opacity ?? 0.5 }
        : { ...(props.style ?? {}), opacity: props.style?.opacity ?? 1 }}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text class={kind() === "filled" || kind() === "danger"
        ? "text-xs text-white font-bold"
        : kind() === "tonal"
          ? (theme().name === "dark" ? "text-xs text-[#93B4FF] font-bold" : "text-xs text-[#315DEB] font-bold")
          : theme().name === "dark"
            ? "text-xs text-white font-bold"
            : "text-xs text-[#17233B] font-bold"}>{props.label}</Text>
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

export function MobileBadge(props: { label: string; tone?: "accent" | "success" | "warning" | "danger" | "neutral" }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const tone = () => props.tone ?? "accent";
  return (
    <View class={tone() === "success"
      ? (theme().name === "dark" ? "px-2 py-1 rounded-xl bg-[#133829] transition-colors duration-150 ease-out" : "px-2 py-1 rounded-xl bg-[#E5F7EE] transition-colors duration-150 ease-out")
      : tone() === "warning"
        ? (theme().name === "dark" ? "px-2 py-1 rounded-xl bg-[#3D2E10] transition-colors duration-150 ease-out" : "px-2 py-1 rounded-xl bg-[#FFF4DD] transition-colors duration-150 ease-out")
        : tone() === "danger"
          ? (theme().name === "dark" ? "px-2 py-1 rounded-xl bg-[#421822] transition-colors duration-150 ease-out" : "px-2 py-1 rounded-xl bg-[#FDECEF] transition-colors duration-150 ease-out")
          : tone() === "neutral"
            ? (theme().name === "dark" ? "px-2 py-1 rounded-xl bg-[#22314A] transition-colors duration-150 ease-out" : "px-2 py-1 rounded-xl bg-[#EEF1F6] transition-colors duration-150 ease-out")
            : (theme().name === "dark" ? "px-2 py-1 rounded-xl bg-[#253B73] transition-colors duration-150 ease-out" : "px-2 py-1 rounded-xl bg-[#E8EDFF] transition-colors duration-150 ease-out")}>
      <Text class={tone() === "success"
        ? (theme().name === "dark" ? "text-xs text-[#6EE7B7] font-bold" : "text-xs text-[#147A52] font-bold")
        : tone() === "warning"
          ? (theme().name === "dark" ? "text-xs text-[#FCD34D] font-bold" : "text-xs text-[#936211] font-bold")
          : tone() === "danger"
            ? (theme().name === "dark" ? "text-xs text-[#FDA4AF] font-bold" : "text-xs text-[#B4233A] font-bold")
            : tone() === "neutral"
              ? (theme().name === "dark" ? "text-xs text-[#B9C5D8] font-bold" : "text-xs text-[#7C8799] font-bold")
              : (theme().name === "dark" ? "text-xs text-[#93B4FF] font-bold" : "text-xs text-[#315DEB] font-bold")}>{props.label}</Text>
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
  const progress = useStateTransition(() => `${props.selected ?? false}:${props.tone ?? "accent"}`, 8);
  const scale = () => 0.96 + 0.04 * progress();
  const content = (
    <View
      class={props.selected
        ? "flex-row items-center gap-1 px-3 py-1 rounded-xl bg-[#315DEB] transition-all duration-150 ease-spring"
        : theme().name === "dark"
          ? "flex-row items-center gap-1 px-3 py-1 rounded-xl bg-[#22314A] border-[#30405A] transition-all duration-150 ease-spring"
          : "flex-row items-center gap-1 px-3 py-1 rounded-xl bg-[#EEF1F6] border-[#E5E9F2] transition-all duration-150 ease-spring"}
      style={{ scale: scale() }}
    >
      <Text class={props.selected
        ? "text-xs text-white font-bold"
        : theme().name === "dark"
          ? "text-xs text-[#B9C5D8] font-bold"
          : "text-xs text-[#17233B] font-bold"}>{props.label}</Text>
      {props.closable ? (
        <Text class={props.selected ? "text-xs text-white font-bold" : "text-xs text-[#7C8799] font-bold"}>×</Text>
      ) : null}
    </View>
  );
  if (props.onPress || props.onClose) {
    return (
      <Focusable
        class="rounded-xl active:scale-95 transition-transform duration-150 ease-out"
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
  const tone = () => props.tone ?? "accent";
  return (
    <View class="relative w-[40] h-[40]">
      <View class={tone() === "success"
        ? "w-[40] h-[40] rounded-full items-center justify-center bg-[#147A52] transition-all duration-200 ease-out"
        : tone() === "warning"
          ? "w-[40] h-[40] rounded-full items-center justify-center bg-[#936211] transition-all duration-200 ease-out"
          : tone() === "danger"
            ? "w-[40] h-[40] rounded-full items-center justify-center bg-[#B4233A] transition-all duration-200 ease-out"
            : "w-[40] h-[40] rounded-full items-center justify-center bg-[#315DEB] transition-all duration-200 ease-out"}>
        <Text class="text-xs text-white font-bold">{props.label}</Text>
      </View>
      {props.status ? (
        <View class={props.status === "online"
          ? "absolute right-0 bottom-0 w-[10] h-[10] rounded-full bg-emerald-500 border-white"
          : props.status === "busy"
            ? "absolute right-0 bottom-0 w-[10] h-[10] rounded-full bg-rose-500 border-white"
            : "absolute right-0 bottom-0 w-[10] h-[10] rounded-full bg-[#7C8799] border-white"} />
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
    <ScrollContourItem class={props.selected
      ? (theme().name === "dark"
        ? "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#253B73] transition-all duration-200 ease-out"
        : "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#E8EDFF] transition-all duration-200 ease-out")
      : theme().name === "dark"
        ? "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#17233B] border-[#30405A] transition-all duration-200 ease-out"
        : "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-white border-[#E5E9F2] transition-all duration-200 ease-out"}>
      {props.leading}
      <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
        <Text class={props.selected && theme().name !== "dark" ? "text-sm text-[#315DEB] font-bold" : theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text>
        {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
      </View>
      {props.trailing}
    </ScrollContourItem>
  );
  return props.onPress
    ? <Focusable class="rounded-xl active:scale-95 transition-transform duration-150 ease-out" onPress={props.onPress}>{body}</Focusable>
    : body;
}

export function MobileSegmentedControl(props: {
  items: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  return (
    <ScrollContourItem class={theme().name === "dark"
      ? "flex-row gap-1 p-1 rounded-xl bg-[#22314A] transition-colors duration-200 ease-out"
      : "flex-row gap-1 p-1 rounded-xl bg-[#EEF1F6] transition-colors duration-200 ease-out"}>
      <For each={props.items}>
        {(item) => <MobileButton label={item.label} compact kind={props.active === item.id ? "filled" : "text"} onPress={() => props.onChange(item.id)} />}
      </For>
    </ScrollContourItem>
  );
}

export function MobileSwitch(props: { value: boolean; onChange: (value: boolean) => void; label?: string }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const density = useDesignDensity();
  const thumbX = useAnimatedNumber(() => (props.value ? 20 : 0), 0.45);
  const progress = useStateTransition(() => props.value, 8);
  const thumbScale = () => 0.92 + 0.08 * progress();
  return (
    <Focusable
      onPress={() => props.onChange(!props.value)}
      class={theme().name === "dark"
        ? (density() === "desktop"
          ? "flex-row items-center gap-3 h-[36] px-3 rounded-xl bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
          : "flex-row items-center gap-3 h-[44] px-3 rounded-xl bg-[#22314A] active:scale-95 transition-all duration-150 ease-out")
        : (density() === "desktop"
          ? "flex-row items-center gap-3 h-[36] px-3 rounded-xl bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out"
          : "flex-row items-center gap-3 h-[44] px-3 rounded-xl bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out")}
    >
      <View class={props.value
        ? "w-10 h-5 rounded-xl bg-[#315DEB] transition-colors duration-200 ease-out"
        : "w-10 h-5 rounded-xl bg-[#AAB4C4] transition-colors duration-200 ease-out"}>
        <View
          class={props.value
            ? "w-5 h-5 rounded-full bg-white translate-x-5 transition-transform duration-200 ease-spring"
            : "w-5 h-5 rounded-full bg-white translate-x-0 transition-transform duration-200 ease-spring"}
          style={{ translateX: thumbX(), scale: thumbScale() }}
        />
      </View>
      {props.label ? <Text class={theme().name === "dark" ? "text-white text-xs font-bold" : "text-[#17233B] text-xs font-bold"}>{props.label}</Text> : null}
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
  const animatedRatio = useAnimatedNumber(ratio, 0.45);
  return (
    <View class="flex-row items-center gap-2">
      <MobileTextButton label="−" compact onPress={() => set(props.value - step)} />
      <View class={theme().name === "dark" ? "flex-1 h-2 rounded-xl bg-[#22314A] overflow-hidden" : "flex-1 h-2 rounded-xl bg-[#EEF1F6] overflow-hidden"}>
        <View class="h-2 rounded-xl bg-[#315DEB] transition-transform duration-200 ease-out" style={{ width: -1, scaleX: animatedRatio(), originX: 0 }} />
      </View>
      <MobileTextButton label="+" compact onPress={() => set(props.value + step)} />
      <Text class={theme().name === "dark" ? "text-white text-xs font-bold" : "text-[#17233B] text-xs font-bold"}>{String(props.value)}</Text>
    </View>
  );
}

export function MobileProgress(props: {
  value: number;
  max?: number;
  label?: string;
  tone?: "accent" | "success" | "warning" | "danger";
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const max = () => Math.max(1, props.max ?? 100);
  const ratio = () => Math.max(0, Math.min(1, props.value / max()));
  const animatedRatio = useAnimatedNumber(ratio, 0.42);
  const pct = () => `${Math.round(ratio() * 100)}%`;
  const tone = () => props.tone ?? "accent";
  return (
    <View class="flex-col gap-1 w-full">
      {props.label ? (
        <View class="flex-row items-center justify-between">
          <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8] font-bold" : "text-xs text-[#7C8799] font-bold"}>{props.label}</Text>
          <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{pct()}</Text>
        </View>
      ) : null}
      <View class={theme().name === "dark" ? "w-full h-2 rounded-xl bg-[#22314A] overflow-hidden" : "w-full h-2 rounded-xl bg-[#EEF1F6] overflow-hidden"}>
        <View
          class={tone() === "success"
            ? "h-2 rounded-xl bg-[#147A52] transition-transform duration-200 ease-out"
            : tone() === "warning"
              ? "h-2 rounded-xl bg-[#936211] transition-transform duration-200 ease-out"
              : tone() === "danger"
                ? "h-2 rounded-xl bg-[#B4233A] transition-transform duration-200 ease-out"
                : "h-2 rounded-xl bg-[#315DEB] transition-transform duration-200 ease-out"}
          style={{ width: -1, scaleX: animatedRatio(), originX: 0 }}
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
  const progress = useStateTransition(() => props.checked, 8);
  const boxScale = () => 0.9 + 0.1 * progress();
  return (
    <Focusable
      class={theme().name === "dark"
        ? "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
        : "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out"}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : () => props.onChange(!props.checked)}
    >
      <View
        class={props.checked
          ? "w-5 h-5 rounded-md items-center justify-center bg-[#315DEB] transition-all duration-150 ease-spring"
          : theme().name === "dark"
            ? "w-5 h-5 rounded-md items-center justify-center bg-[#17233B] border-[#30405A] transition-all duration-150 ease-spring"
            : "w-5 h-5 rounded-md items-center justify-center bg-white border-[#D6DCE7] transition-all duration-150 ease-spring"}
        style={{ scale: boxScale() }}
      >
        {props.checked ? <Text class="text-xs text-white font-bold">✓</Text> : null}
      </View>
      <View class="flex-col flex-1 overflow-hidden" style={{ minW: 0 }}>
        <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{props.label}</Text>
        {props.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#B9C5D8]" : "text-2xs text-[#7C8799]"}>{props.detail}</Text> : null}
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
  const progress = useStateTransition(() => props.value, 8);
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
                  ? "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#253B73] active:scale-95 transition-all duration-150 ease-out"
                  : "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#E8EDFF] active:scale-95 transition-all duration-150 ease-out")
                : (theme().name === "dark"
                  ? "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
                  : "flex-row items-center gap-3 px-3 py-2 rounded-xl bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out")}
              onPress={() => props.onChange(item.id)}
            >
              <View class={active()
                ? "w-5 h-5 rounded-full items-center justify-center bg-[#315DEB] transition-all duration-150 ease-spring"
                : theme().name === "dark"
                  ? "w-5 h-5 rounded-full items-center justify-center bg-[#17233B] border-[#30405A] transition-all duration-150 ease-spring"
                  : "w-5 h-5 rounded-full items-center justify-center bg-white border-[#D6DCE7] transition-all duration-150 ease-spring"}>
                {active() ? <View class="w-2 h-2 rounded-full bg-white" style={{ scale: dotScale() }} /> : null}
              </View>
              <View class="flex-col flex-1 overflow-hidden" style={{ minW: 0 }}>
                <Text class={active() && theme().name !== "dark"
                  ? "text-xs text-[#315DEB] font-bold"
                  : theme().name === "dark"
                    ? "text-xs text-white font-bold"
                    : "text-xs text-[#17233B] font-bold"}>{item.label}</Text>
                {item.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#B9C5D8]" : "text-2xs text-[#7C8799]"}>{item.detail}</Text> : null}
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
  const progress = useStateTransition(() => props.expanded, 10);
  return (
    <ScrollContourItem class={theme().name === "dark"
      ? "flex-col gap-2 p-3 rounded-xl bg-[#17233B] border-[#30405A] transition-all duration-200 ease-out"
      : "flex-col gap-2 p-3 rounded-xl bg-white border-[#E5E9F2] transition-all duration-200 ease-out"}>
      <Focusable
        class="flex-row items-center justify-between gap-2 py-1 rounded-xl active:opacity-80 transition-opacity duration-150 ease-out"
        onPress={props.onToggle}
      >
        <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
          <Text class={theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text>
          {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
        </View>
        <View class="flex-row items-center gap-2">
          {props.badge ? <MobileBadge label={props.badge} /> : null}
          <View
            class={theme().name === "dark"
              ? "w-6 h-6 rounded-full items-center justify-center bg-[#22314A] transition-transform duration-200 ease-spring"
              : "w-6 h-6 rounded-full items-center justify-center bg-[#EEF1F6] transition-transform duration-200 ease-spring"}
            style={{ rotate: props.expanded ? 90 : 0 }}
          >
            <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>›</Text>
          </View>
        </View>
      </Focusable>
      <Show when={props.expanded}>
        <View
          class="flex-col gap-2 pt-2 transition-all duration-200 ease-out"
          style={{
            opacity: progress(),
            translateY: Math.round((1 - progress()) * -6),
          }}
        >
          <View class={theme().name === "dark" ? "w-full h-[1] bg-[#30405A]" : "w-full h-[1] bg-[#E5E9F2]"} />
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
  const [phase, setPhase] = createSignal(0);
  try {
    onFrame(() => {
      if (props.active === false) return;
      setPhase((prev) => (prev + 1) % 60);
    }, { continuous: false });
  } catch {
    // Ignore when no frame loop is active.
  }
  const pulseOpacity = () => {
    if (props.active === false) return 0.85;
    const wave = 0.5 + 0.5 * Math.sin((phase() / 60) * Math.PI * 2);
    return 0.55 + 0.4 * wave;
  };
  const count = () => Math.max(1, Math.min(5, props.rows ?? 3));
  const indices = () => Array.from({ length: count() }, (_, idx) => idx);
  return (
    <View
      class="flex-row items-center gap-3 w-full transition-opacity duration-300 ease-in-out"
      style={{ opacity: pulseOpacity() }}
    >
      {props.avatar !== false ? (
        <View class={theme().name === "dark" ? "w-[40] h-[40] rounded-full bg-[#22314A]" : "w-[40] h-[40] rounded-full bg-[#EEF1F6]"} />
      ) : null}
      <View class="flex-col gap-2 flex-1">
        <For each={indices()}>
          {(idx) => (
            <View
              class={theme().name === "dark" ? "w-full h-3 rounded-xl bg-[#22314A]" : "w-full h-3 rounded-xl bg-[#EEF1F6]"}
              style={{
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
  const isOpen = () => (props.open === undefined ? true : typeof props.open === "function" ? props.open() : props.open);
  const tone = () => props.tone ?? "info";
  const progress = useStateTransition(() => `${isOpen()}:${tone()}:${props.title}`, 10);
  const iconGlyph = () => (tone() === "success" ? "✓" : tone() === "warning" ? "!" : tone() === "danger" ? "×" : "i");
  return (
    <Show when={isOpen()}>
      <ScrollContourItem
        class={tone() === "success"
          ? (theme().name === "dark"
            ? "flex-row items-center gap-3 p-3 rounded-xl bg-[#133829] border-[#199A68] transition-all duration-200 ease-out"
            : "flex-row items-center gap-3 p-3 rounded-xl bg-[#E5F7EE] border-[#A7F3D0] transition-all duration-200 ease-out")
          : tone() === "warning"
            ? (theme().name === "dark"
              ? "flex-row items-center gap-3 p-3 rounded-xl bg-[#3D2E10] border-[#D99B26] transition-all duration-200 ease-out"
              : "flex-row items-center gap-3 p-3 rounded-xl bg-[#FFF4DD] border-[#FDE68A] transition-all duration-200 ease-out")
            : tone() === "danger"
              ? (theme().name === "dark"
                ? "flex-row items-center gap-3 p-3 rounded-xl bg-[#421822] border-[#B4233A] transition-all duration-200 ease-out"
                : "flex-row items-center gap-3 p-3 rounded-xl bg-[#FDECEF] border-[#FECDD3] transition-all duration-200 ease-out")
              : (theme().name === "dark"
                ? "flex-row items-center gap-3 p-3 rounded-xl bg-[#253B73] border-[#315DEB] transition-all duration-200 ease-out"
                : "flex-row items-center gap-3 p-3 rounded-xl bg-[#E8EDFF] border-[#C7D7FE] transition-all duration-200 ease-out")}
        style={{
          opacity: progress(),
          translateY: Math.round((1 - progress()) * -4),
          scale: 0.98 + 0.02 * progress(),
        }}
      >
        <View class={tone() === "success"
          ? "w-6 h-6 rounded-full items-center justify-center bg-[#147A52]"
          : tone() === "warning"
            ? "w-6 h-6 rounded-full items-center justify-center bg-[#936211]"
            : tone() === "danger"
              ? "w-6 h-6 rounded-full items-center justify-center bg-[#B4233A]"
              : "w-6 h-6 rounded-full items-center justify-center bg-[#315DEB]"}>
          <Text class="text-xs text-white font-bold">{iconGlyph()}</Text>
        </View>
        <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
          <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{props.title}</Text>
          {props.body ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.body}</Text> : null}
          {props.children}
        </View>
        {props.actionLabel && props.onAction ? (
          <MobileButton label={props.actionLabel} compact kind="tonal" onPress={props.onAction} />
        ) : null}
        {props.closable && props.onClose ? (
          <MobileTextButton label="Dismiss" compact onPress={props.onClose} />
        ) : null}
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
  const isOpen = () => (typeof props.open === "function" ? props.open() : props.open);
  const tone = () => props.tone ?? "info";
  const progress = useStateTransition(() => `${isOpen()}:${tone()}:${props.message}`, 10);
  const badgeGlyph = () => (tone() === "success" ? "✓" : tone() === "warning" ? "!" : tone() === "danger" ? "×" : "i");
  return (
    <Show when={isOpen()}>
      <ScrollContourItem
        class="flex-row items-center gap-3 px-4 py-3 rounded-xl shadow-lg bg-[#17233B] border-[#30405A] transition-all duration-200 ease-spring"
        style={{
          opacity: progress(),
          translateY: Math.round((1 - progress()) * -6),
          scale: 0.96 + 0.04 * progress(),
        }}
      >
        <View class={tone() === "success"
          ? "w-6 h-6 rounded-full items-center justify-center bg-[#147A52]"
          : tone() === "warning"
            ? "w-6 h-6 rounded-full items-center justify-center bg-[#936211]"
            : tone() === "danger"
              ? "w-6 h-6 rounded-full items-center justify-center bg-[#B4233A]"
              : "w-6 h-6 rounded-full items-center justify-center bg-[#315DEB]"}>
          <Text class="text-xs text-white font-bold">{badgeGlyph()}</Text>
        </View>
        <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
          <Text class="text-xs text-white font-bold">{props.message}</Text>
          {props.detail ? <Text class="text-2xs text-[#B9C5D8]">{props.detail}</Text> : null}
        </View>
        {props.actionLabel && props.onAction ? (
          <MobileButton label={props.actionLabel} compact kind="tonal" onPress={props.onAction} />
        ) : null}
        {props.onClose ? (
          <MobileTextButton label="Hide" compact onPress={props.onClose} />
        ) : null}
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
  const isOpen = () => (typeof props.open === "function" ? props.open() : props.open);
  const progress = useStateTransition(() => `${isOpen()}:${props.title}`, 10);
  const isBottomSheet = () => {
    const placement = props.placement ?? "auto";
    if (placement === "bottom") return true;
    if (placement === "center") return false;
    return sizeClass() === "compact";
  };
  return (
    <Show when={isOpen()}>
      <Modal
        open
        class={isBottomSheet()
          ? "absolute inset-0 z-50 flex-col items-center justify-end p-3"
          : "absolute inset-0 z-50 flex-col items-center justify-center p-4"}
        panelClass={theme().name === "dark"
          ? "flex-col gap-3 w-[344] p-4 rounded-xl shadow-lg bg-[#17233B] border-[#30405A] transition-all duration-200 ease-spring"
          : "flex-col gap-3 w-[344] p-4 rounded-xl shadow-lg bg-white border-[#E5E9F2] transition-all duration-200 ease-spring"}
      >
        <View
          class="flex-col gap-3 w-full"
          style={{
            opacity: progress(),
            translateY: Math.round((1 - progress()) * 6),
            scale: 0.96 + 0.04 * progress(),
          }}
        >
          <View class="flex-row items-center justify-center w-full">
            <View class={theme().name === "dark" ? "w-10 h-1 rounded-xl bg-[#30405A]" : "w-10 h-1 rounded-xl bg-[#D6DCE7]"} />
          </View>
          <View class="flex-row items-center justify-between gap-2">
            <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
              <Text class={theme().name === "dark" ? "text-base text-white font-bold" : "text-base text-[#17233B] font-bold"}>{props.title}</Text>
              {props.subtitle ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.subtitle}</Text> : null}
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
                        ? "flex-row items-center justify-between px-3 py-3 rounded-xl bg-[#421822] active:scale-95 transition-all duration-150 ease-out"
                        : "flex-row items-center justify-between px-3 py-3 rounded-xl bg-[#FDECEF] active:scale-95 transition-all duration-150 ease-out")
                      : (theme().name === "dark"
                        ? "flex-row items-center justify-between px-3 py-3 rounded-xl bg-[#22314A] active:scale-95 transition-all duration-150 ease-out"
                        : "flex-row items-center justify-between px-3 py-3 rounded-xl bg-[#EEF1F6] active:scale-95 transition-all duration-150 ease-out")}
                    onPress={() => {
                      props.onSelectAction?.(action.id);
                      props.onClose();
                    }}
                  >
                    <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
                      <Text class={action.danger
                        ? (theme().name === "dark" ? "text-xs text-[#FDA4AF] font-bold" : "text-xs text-[#B4233A] font-bold")
                        : (theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold")}>{action.label}</Text>
                      {action.detail ? <Text class={theme().name === "dark" ? "text-2xs text-[#B9C5D8]" : "text-2xs text-[#7C8799]"}>{action.detail}</Text> : null}
                    </View>
                    <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8] font-bold" : "text-xs text-[#7C8799] font-bold"}>›</Text>
                  </Focusable>
                )}
              </For>
            </View>
          ) : null}
          {props.children}
          <MobileOutlinedButton label="Dismiss popup" onPress={props.onClose} />
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
  const isOpen = () => (typeof props.open === "function" ? props.open() : props.open);
  const progress = useStateTransition(() => `${isOpen()}:${props.title}:${props.tone ?? "default"}`, 10);
  return (
    <Show when={typeof props.open === "function" ? props.open() : props.open}>
      <Modal
        open
        panelClass={theme().name === "dark"
          ? "flex-col gap-3 w-[328] p-4 rounded-xl shadow-lg bg-[#17233B] border-[#30405A] transition-all duration-200 ease-spring"
          : "flex-col gap-3 w-[328] p-4 rounded-xl shadow-lg bg-white border-[#E5E9F2] transition-all duration-200 ease-spring"}
      >
        <View
          class="flex-col gap-3 w-full"
          style={{
            opacity: progress(),
            translateY: Math.round((1 - progress()) * 4),
            scale: 0.96 + 0.04 * progress(),
          }}
        >
          <Text class={theme().name === "dark" ? "text-lg text-white font-bold" : "text-lg text-[#17233B] font-bold"}>{props.title}</Text>
          {props.body ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.body}</Text> : null}
          {props.children}
          {props.onConfirm || props.confirmLabel ? (
            <View class="flex-row items-center justify-end gap-2">
              <MobileTextButton label={props.cancelLabel ?? "Close"} onPress={props.onClose} />
              <MobileButton
                label={props.confirmLabel ?? "Confirm"}
                kind={props.tone === "danger" ? "danger" : "filled"}
                onPress={() => {
                  props.onConfirm?.();
                  props.onClose();
                }}
              />
            </View>
          ) : (
            <MobileTextButton label={props.cancelLabel ?? "Close"} onPress={props.onClose} />
          )}
        </View>
      </Modal>
    </Show>
  );
}

type SurfaceBridge = {
  registerSurface?: (packageId: string, kind: "glass" | "platformTexture", payload: string) => unknown;
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

export function GlassSurface(props: {
  children?: JSX.Element;
  shape?: GlassShape;
  pressed?: boolean;
  class?: string;
}): JSX.Element {
  const [registered, setRegistered] = createSignal(false);
  const id = `guest.glass.${nextGlassSurface++}`;
  const recipe = createMemo(() => buildLiquidGlassRecipe({ shape: props.shape ?? "rounded", focused: props.pressed === true, warp: true }));
  // Keep the shell transparent when a native surface is registered; the
  // gradient layer below is only the unsupported-host fallback.
  const payload = createMemo((): string => {
    const current = recipe();
    return JSON.stringify({
      radius: current.radius,
      // The native glass provider calls this field `blur`; the local recipe
      // keeps the more descriptive `blurSigma` name for UI/tests.
      blur: current.blurSigma,
      edgeIntensity: current.edgeIntensity,
      rimIntensity: current.rimIntensity,
      baseIntensity: current.baseIntensity,
      tintOpacity: current.tintOpacity,
      cornerBoost: current.cornerBoost,
      rippleEffect: current.rippleEffect,
      warp: current.warp,
      pressed: props.pressed === true,
      shape: current.shape,
    });
  });
  const register = (nextPayload: string): void => {
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
  // The string memo suppresses equal payloads. One effect owns registration;
  // it does not subscribe to the registered signal it updates.
  createEffect(() => register(payload()));
  onCleanup(() => surfaceGlobal.pocket?.releaseSurface?.(id));
  return (
    <ScrollContourItem class={props.class ?? "flex-col gap-3 p-4 rounded-xl border-[#E5E9F2]"}>
      <Show when={registered()}>
        <View class="absolute inset-0 overflow-hidden rounded-xl">
          <CompositorGlass packageId={id} radius={recipe().radius} />
        </View>
      </Show>
      <Show when={!registered()}>
        <View class="absolute inset-0 overflow-hidden rounded-xl" style={{ gradFrom: recipe().bgColors[0], gradTo: recipe().bgColors[2], gradDir: 1, radius: recipe().radius, shadow: recipe().shadowBlur > 20 ? 2 : 1 }} />
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
  const payload = createMemo((): string => JSON.stringify({
    textureId: props.textureId,
    sourceWidth: props.sourceWidth,
    sourceHeight: props.sourceHeight,
    fit: props.fit ?? "cover",
    radius: platformTextureRadius(props.radius),
    rotationDegrees: props.rotationDegrees ?? 0,
    mirrorX: props.mirrorX ?? false,
  }));
  const register = (_nextPayload = payload()): void => {
    const registerSurface = surfaceGlobal.pocket?.registerSurface;
    if (typeof registerSurface !== "function") {
      setRegistered(false);
      return;
    }
    try {
      const ok = registerSurface(id, "platformTexture", payload()) !== false;
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
export const Stepper = MobileStepper;
export const ProgressBar = MobileProgress;
export const Checkbox = MobileCheckbox;
export const RadioGroup = MobileRadioGroup;
export const Tag = MobileTag;
export const Avatar = MobileAvatar;
export const Accordion = MobileAccordion;
export const Skeleton = MobileSkeleton;
export const Alert = MobileAlert;
export const Toast = MobileToast;
export const Popup = MobilePopup;
export const ActionSheet = MobileActionSheet;
export const Dialog = MobileDialog;
