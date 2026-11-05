/**
 * Small mobile composition layer.
 *
 * Provenance:
 * - The vocabulary and slot shape follow the old demo's
 *   `mini_apps/syslib/pocket_syslib_flutter_ui.js` (`Scaffold`, `AppBar`,
 *   `Card`, `ListTile`, and the button variants).
 * - Every implementation below is composed from the pinned official Solid
 *   components. It is deliberately not a second widget/layout engine.
 * - GlassSurface uses the host's generic `registerSurface` bridge when it is
 *   available. Its fallback is an explicitly labelled visual recipe; a CSS
 *   gradient is never reported as native blur or refraction.
 */

import { For, Show, children as resolveChildren, createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import { CompositorSurface, Focusable, Modal, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
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
import type { DisplayGeometry } from "./responsive.ts";

export interface MobileTheme {
  name: string;
  canvas: string;
  surface: string;
  surfaceMuted: string;
  ink: string;
  muted: string;
  accent: string;
  accentPressed: string;
  border: string;
  danger: string;
}

export const MOBILE_THEME_LIGHT: MobileTheme = {
  name: "light",
  canvas: "bg-[#F5F6FA]",
  surface: "bg-white",
  surfaceMuted: "bg-[#EEF1F6]",
  ink: "text-[#17233B]",
  muted: "text-[#7C8799]",
  accent: "bg-[#315DEB]",
  accentPressed: "bg-[#2748C5]",
  border: "border-[#E5E9F2]",
  danger: "bg-[#B4233A]",
};

export const MOBILE_THEME_DARK: MobileTheme = {
  name: "dark",
  canvas: "bg-[#0E1728]",
  surface: "bg-[#17233B]",
  surfaceMuted: "bg-[#22314A]",
  ink: "text-white",
  muted: "text-[#B9C5D8]",
  accent: "bg-[#315DEB]",
  accentPressed: "bg-[#466DFF]",
  border: "border-[#30405A]",
  danger: "bg-[#B4233A]",
};

type ThemeSource = MobileTheme | (() => MobileTheme);

const ThemeContext = createContext<ThemeSource>(MOBILE_THEME_LIGHT);

export function MobileThemeProvider(props: { theme?: ThemeSource; children?: JSX.Element }): JSX.Element {
  return <ThemeContext.Provider value={props.theme ?? MOBILE_THEME_LIGHT}>{props.children}</ThemeContext.Provider>;
}

function useMobileThemeAccessor(): () => MobileTheme {
  const source = useContext(ThemeContext) ?? MOBILE_THEME_LIGHT;
  return typeof source === "function" ? source : () => source;
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
      class={props.class ?? (theme().name === "dark" ? "flex-col w-full bg-[#0E1728]" : "flex-col w-full bg-[#F5F6FA]")}
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
  const { nodeRef, reserve } = useScrollContourReserve({
    baseRight: 16,
    defaultInBand: true,
    enabled: () => !alreadyConsumed(),
    mode: "padding",
  });
  const dark = () => props.dark === true || theme().name === "dark";
  let appliedNonZero = false;
  const appBarStyle = () => {
    const r = reserve();
    if (r > 0) appliedNonZero = true;
    if (scaffold.reservedActions > 0 || r > 0 || appliedNonZero) {
      return { paddingR: Math.max(16 + r, scaffold.reservedActions + r) };
    }
    return undefined;
  };
  return (
    <ContourConsumedContext.Provider value={() => true}>
      <View
        ref={nodeRef}
        class="flex-row items-center gap-2 w-full h-[56] px-4 bg-transparent"
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
      ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
      : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]")}>
      {props.title ? <Text class={theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text> : null}
      {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
      {props.children}
    </ScrollContourItem>
  );
}

export interface MobileButtonProps {
  label: string;
  onPress?: () => void;
  kind?: "filled" | "outlined" | "text" | "danger";
  compact?: boolean;
  class?: string;
  style?: ViewProps["style"];
  debugName?: string;
  disabled?: boolean;
}

export function MobileButton(props: MobileButtonProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const kind = () => props.kind ?? "filled";
  return (
    <Focusable
      class={props.class ?? (kind() === "outlined"
        ? (theme().name === "dark"
          ? (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-transparent border-[#30405A] focus:bg-[#22314A]" : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent border-[#30405A] focus:bg-[#22314A]")
          : (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-transparent border-[#D6DCE7] focus:bg-[#F7F8FC]" : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent border-[#D6DCE7] focus:bg-[#F7F8FC]"))
        : kind() === "text"
          ? (theme().name === "dark"
            ? (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#22314A]" : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#22314A]")
            : (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6]" : "px-4 h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6]"))
          : kind() === "danger"
            ? (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238]" : "px-4 h-[44] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238]")
            : (props.compact ? "px-3 h-[44] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5]" : "px-4 h-[44] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5]") )}
      style={props.disabled
        ? { ...(props.style ?? {}), opacity: props.style?.opacity ?? 0.5 }
        : { ...(props.style ?? {}), opacity: props.style?.opacity ?? 1 }}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text class={kind() === "filled" || kind() === "danger" ? "text-xs text-white font-bold" : theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{props.label}</Text>
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
export const MobileOutlinedButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "outlined");
export const MobileTextButton = (props: MobileButtonAliasProps): JSX.Element => mobileButtonAlias(props, "text");

export function MobileBadge(props: { label: string; tone?: "accent" | "success" | "warning" | "danger" }): JSX.Element {
  return (
    <View class={(props.tone ?? "accent") === "success"
      ? "px-2 py-1 rounded-xl bg-[#E5F7EE]"
      : (props.tone ?? "accent") === "warning"
        ? "px-2 py-1 rounded-xl bg-[#FFF4DD]"
        : (props.tone ?? "accent") === "danger"
          ? "px-2 py-1 rounded-xl bg-[#FDECEF]"
          : "px-2 py-1 rounded-xl bg-[#E8EDFF]"}>
      <Text class={(props.tone ?? "accent") === "success"
        ? "text-xs text-[#147A52] font-bold"
        : (props.tone ?? "accent") === "warning"
          ? "text-xs text-[#936211] font-bold"
          : (props.tone ?? "accent") === "danger"
            ? "text-xs text-[#B4233A] font-bold"
            : "text-xs text-[#315DEB] font-bold"}>{props.label}</Text>
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
        ? "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#253B73]"
        : "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#E8EDFF]")
      : theme().name === "dark"
        ? "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-[#17233B] border-[#30405A]"
        : "flex-row items-center gap-3 px-3 py-3 rounded-xl bg-white border-[#E5E9F2]"}>
      {props.leading}
      <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
        <Text class={props.selected && theme().name !== "dark" ? "text-sm text-[#315DEB] font-bold" : theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text>
        {props.detail ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
      </View>
      {props.trailing}
    </ScrollContourItem>
  );
  return props.onPress ? <Focusable onPress={props.onPress}>{body}</Focusable> : body;
}

export function MobileSegmentedControl(props: {
  items: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  return (
    <ScrollContourItem class={theme().name === "dark" ? "flex-row gap-1 p-1 rounded-xl bg-[#22314A]" : "flex-row gap-1 p-1 rounded-xl bg-[#EEF1F6]"}>
      <For each={props.items}>
        {(item) => <MobileButton label={item.label} compact kind={props.active === item.id ? "filled" : "text"} onPress={() => props.onChange(item.id)} />}
      </For>
    </ScrollContourItem>
  );
}

export function MobileSwitch(props: { value: boolean; onChange: (value: boolean) => void; label?: string }): JSX.Element {
  const theme = useMobileThemeAccessor();
  return (
    <Focusable onPress={() => props.onChange(!props.value)} class={theme().name === "dark" ? "flex-row items-center gap-3 h-[44] px-3 rounded-xl bg-[#22314A]" : "flex-row items-center gap-3 h-[44] px-3 rounded-xl bg-[#EEF1F6]"}>
      <View class={props.value ? "w-10 h-5 rounded-xl bg-[#315DEB]" : "w-10 h-5 rounded-xl bg-[#AAB4C4]"}>
        <View class={props.value ? "w-5 h-5 rounded-full bg-white translate-x-5" : "w-5 h-5 rounded-full bg-white translate-x-0"} />
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
  return (
    <View class="flex-row items-center gap-2">
      <MobileTextButton label="−" compact onPress={() => set(props.value - step)} />
      <View class={theme().name === "dark" ? "flex-1 h-2 rounded-xl bg-[#22314A]" : "flex-1 h-2 rounded-xl bg-[#EEF1F6]"}><View class="h-2 rounded-xl bg-[#315DEB]" style={{ width: -1, scaleX: ratio(), originX: 0 }} /></View>
      <MobileTextButton label="+" compact onPress={() => set(props.value + step)} />
      <Text class={theme().name === "dark" ? "text-white text-xs font-bold" : "text-[#17233B] text-xs font-bold"}>{String(props.value)}</Text>
    </View>
  );
}

export function MobileDialog(props: { open: boolean | (() => boolean); title: string; body?: string; children?: JSX.Element; onClose: () => void }): JSX.Element {
  const theme = useMobileThemeAccessor();
  return (
    <Show when={typeof props.open === "function" ? props.open() : props.open}>
      <Modal
        open
        panelClass={theme().name === "dark"
          ? "flex-col gap-3 w-[328] p-4 rounded-xl shadow-lg bg-[#17233B] border-[#30405A]"
          : "flex-col gap-3 w-[328] p-4 rounded-xl shadow-lg bg-white border-[#E5E9F2]"}
      >
        <Text class={theme().name === "dark" ? "text-lg text-white font-bold" : "text-lg text-[#17233B] font-bold"}>{props.title}</Text>
        {props.body ? <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.body}</Text> : null}
        {props.children}
        <MobileTextButton label="Close" onPress={props.onClose} />
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

// Compatibility vocabulary from the old UIKit. These are aliases, not extra
// implementations, so consumers can migrate names without multiplying logic.
// `Scaffold` is the standalone safe-area contract. Nested pages should use
// `MobileScaffold` (which defaults to `safeArea="none"`) or pass explicit
// edges when they own a different shell.
export const Scaffold = SafeAreaScaffold;
export const AppBar = MobileAppBar;
export const FilledButton = MobileFilledButton;
export const ElevatedButton = MobileFilledButton;
export const OutlinedButton = MobileOutlinedButton;
export const TextButton = MobileTextButton;
export const ListTile = MobileListTile;
