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

import { For, Show, children as resolveChildren, createContext, createEffect, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js";
import { CompositorSurface, Focusable, Modal, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { buildLiquidGlassRecipe, type GlassShape } from "./legacy.ts";

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
  canvas: "bg-slate-50",
  surface: "bg-white",
  surfaceMuted: "bg-slate-200",
  ink: "text-slate-950",
  muted: "text-slate-600",
  accent: "bg-blue-600",
  accentPressed: "bg-blue-500",
  border: "border-slate-200",
  danger: "bg-rose-600",
};

export const MOBILE_THEME_DARK: MobileTheme = {
  name: "dark",
  canvas: "bg-[#0d1726]",
  surface: "bg-[#172235]",
  surfaceMuted: "bg-[#22314a]",
  ink: "text-white",
  muted: "text-slate-300",
  accent: "bg-cyan-600",
  accentPressed: "bg-cyan-500",
  border: "border-slate-600",
  danger: "bg-rose-600",
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
  appBar?: JSX.Element;
  bottomBar?: JSX.Element;
  class?: string;
}): JSX.Element {
  // Keep the structural classes literal in JSX. The pinned compiler collects
  // classes from JSX attributes into the PAK style table; classes assembled
  // by a function (the pre-package version did this) are not a portable style
  // contract and silently become an unsized native row. The outer canvas keeps
  // a bounded fill so a themed page also paints its empty tail.
  const theme = useMobileThemeAccessor();
  const resolvedChildren = resolveChildren(() => props.children);
  const fillsViewport = () => props.class === undefined;
  return (
    <View class="flex-col w-full" style={{ grow: 1 }}>
      <View class={props.class ?? (theme().name === "dark" ? "flex-col w-full bg-[#0d1726]" : "flex-col w-full bg-slate-50")} style={{ grow: 1 }}>
        {props.appBar}
        <View class="flex-col w-full" style={{ grow: fillsViewport() ? 1 : 0 }}>{resolvedChildren()}</View>
        {props.bottomBar}
      </View>
    </View>
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
  const dark = () => props.dark === true || theme().name === "dark";
  const titleClass = () => dark() ? "text-lg text-white font-bold" : "text-lg text-slate-950 font-bold";
  const subtitleClass = () => dark() ? "text-xs text-slate-300" : "text-xs text-slate-600";
  return (
    <View class={dark() ? "flex-row items-center gap-2 w-full px-4 py-3 bg-[#0d1726]" : "flex-row items-center gap-2 w-full px-4 py-3 bg-white border-slate-200"}>
      {props.leading}
      <View class="flex-col gap-1 flex-1">
        <Text class={titleClass()}>{props.title}</Text>
        {props.subtitle ? <Text class={subtitleClass()}>{props.subtitle}</Text> : null}
      </View>
      {props.trailing}
    </View>
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

function surfaceClass(theme: MobileTheme): string {
  return theme.name === "dark"
    ? "flex-col gap-2 p-3 rounded-xl bg-[#172235] border-slate-600"
    : "flex-col gap-2 p-3 rounded-xl bg-white border-slate-200";
}

export function MobileCard(props: MobileCardProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const titleClass = () => theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-slate-950 font-bold";
  const detailClass = () => theme().name === "dark" ? "text-xs text-slate-300" : "text-xs text-slate-600";
  const cardClass = () => props.class ?? surfaceClass(theme());
  const content = (
    <View class={cardClass()}>
      {props.title ? <Text class={titleClass()}>{props.title}</Text> : null}
      {props.detail ? <Text class={detailClass()}>{props.detail}</Text> : null}
      {props.children}
    </View>
  );
  if (!props.glass) return content;
  return (
    <GlassSurface shape={props.glassShape ?? "rounded"} pressed={props.glassPressed} class={props.class}>
      {props.title ? <Text class={titleClass()}>{props.title}</Text> : null}
      {props.detail ? <Text class={detailClass()}>{props.detail}</Text> : null}
      {props.children}
    </GlassSurface>
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

function buttonClass(theme: MobileTheme, kind: MobileButtonProps["kind"], compact: boolean): string {
  const filledLight = compact ? "px-2 py-1 rounded-lg bg-blue-600 focus:bg-blue-500" : "px-4 py-3 h-[48] rounded-lg bg-blue-600 focus:bg-blue-500";
  const filledDark = compact ? "px-2 py-1 rounded-lg bg-cyan-600 focus:bg-cyan-500" : "px-4 py-3 h-[48] rounded-lg bg-cyan-600 focus:bg-cyan-500";
  const outlinedLight = compact ? "px-2 py-1 rounded-lg bg-transparent border-slate-200" : "px-4 py-3 h-[48] rounded-lg bg-transparent border-slate-200";
  const outlinedDark = compact ? "px-2 py-1 rounded-lg bg-transparent border-slate-600" : "px-4 py-3 h-[48] rounded-lg bg-transparent border-slate-600";
  const text = compact ? "px-2 py-1 rounded-lg bg-transparent" : "px-4 py-3 h-[48] rounded-lg bg-transparent";
  const danger = compact ? "px-2 py-1 rounded-lg bg-rose-600 focus:bg-rose-500" : "px-4 py-3 h-[48] rounded-lg bg-rose-600 focus:bg-rose-500";
  const dark = theme.name === "dark";
  if (kind === "outlined") return dark ? outlinedDark : outlinedLight;
  if (kind === "text") return text;
  if (kind === "danger") return danger;
  return dark ? filledDark : filledLight;
}

export function MobileButton(props: MobileButtonProps): JSX.Element {
  const theme = useMobileThemeAccessor();
  const kind = () => props.kind ?? "filled";
  const buttonClassName = () => props.disabled
    ? `${props.class ?? buttonClass(theme(), kind(), props.compact === true)} opacity-50`
    : props.class ?? buttonClass(theme(), kind(), props.compact === true);
  const textClass = () => kind() === "filled" || kind() === "danger"
    ? "text-xs text-white font-bold"
    : theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold";
  return (
    <Focusable
      class={buttonClassName()}
      style={props.style}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text class={textClass()}>{props.label}</Text>
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
  const cls = () => (props.tone ?? "accent") === "success"
    ? "px-2 py-1 rounded-lg bg-emerald-400"
    : (props.tone ?? "accent") === "warning"
      ? "px-2 py-1 rounded-lg bg-amber-300"
      : (props.tone ?? "accent") === "danger"
        ? "px-2 py-1 rounded-lg bg-rose-400"
        : "px-2 py-1 rounded-lg bg-cyan-300";
  return <View class={cls()}><Text class="text-xs text-slate-950 font-bold">{props.label}</Text></View>;
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
  const tileClass = () => props.selected
    ? "flex-row items-center gap-2 px-3 py-2 rounded-lg bg-blue-100"
    : theme().name === "dark"
      ? "flex-row items-center gap-2 px-3 py-2 rounded-lg bg-[#172235]"
      : "flex-row items-center gap-2 px-3 py-2 rounded-lg bg-white";
  const titleClass = () => theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-slate-950 font-bold";
  const detailClass = () => theme().name === "dark" ? "text-xs text-slate-300" : "text-xs text-slate-600";
  const body = (
    <View class={tileClass()}>
      {props.leading}
      <View class="flex-col gap-1 flex-1">
        <Text class={titleClass()}>{props.title}</Text>
        {props.detail ? <Text class={detailClass()}>{props.detail}</Text> : null}
      </View>
      {props.trailing}
    </View>
  );
  return props.onPress ? <Focusable onPress={props.onPress}>{body}</Focusable> : body;
}

export function MobileSegmentedControl(props: {
  items: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const theme = useMobileThemeAccessor();
  const containerClass = () => theme().name === "dark"
    ? "flex-row gap-1 p-1 rounded-lg bg-[#22314a]"
    : "flex-row gap-1 p-1 rounded-lg bg-slate-200";
  return (
    <View class={containerClass()}>
      <For each={props.items}>
        {(item) => <MobileButton label={item.label} compact kind={props.active === item.id ? "filled" : "text"} onPress={() => props.onChange(item.id)} />}
      </For>
    </View>
  );
}

export function MobileSwitch(props: { value: boolean; onChange: (value: boolean) => void; label?: string }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const shellClass = () => theme().name === "dark"
    ? "flex-row items-center gap-2 px-2 py-1 rounded-lg bg-[#22314a]"
    : "flex-row items-center gap-2 px-2 py-1 rounded-lg bg-slate-200";
  const labelClass = () => theme().name === "dark" ? "text-white text-xs font-bold" : "text-slate-950 text-xs font-bold";
  const trackClass = () => props.value ? "w-8 h-4 rounded-lg bg-emerald-500" : "w-8 h-4 rounded-lg bg-slate-400";
  const thumbClass = () => props.value ? "w-4 h-4 rounded-full bg-white translate-x-4" : "w-4 h-4 rounded-full bg-white translate-x-0";
  return (
    <Focusable onPress={() => props.onChange(!props.value)} class={shellClass()}>
      <View class={trackClass()}>
        <View class={thumbClass()} />
      </View>
      {props.label ? <Text class={labelClass()}>{props.label}</Text> : null}
    </Focusable>
  );
}

export function MobileStepper(props: { value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const trackClass = () => theme().name === "dark" ? "flex-1 h-2 rounded-lg bg-[#22314a]" : "flex-1 h-2 rounded-lg bg-slate-200";
  const fillClass = () => theme().name === "dark" ? "h-2 rounded-lg bg-cyan-600" : "h-2 rounded-lg bg-blue-600";
  const valueClass = () => theme().name === "dark" ? "text-white text-xs font-bold" : "text-slate-950 text-xs font-bold";
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const step = props.step ?? 1;
  const set = (next: number): void => props.onChange(Math.max(min, Math.min(max, next)));
  const ratio = () => Math.max(0, Math.min(1, (props.value - min) / Math.max(1, max - min)));
  return (
    <View class="flex-row items-center gap-2">
      <MobileTextButton label="−" compact onPress={() => set(props.value - step)} />
      <View class={trackClass()}><View class={fillClass()} style={{ width: -1, scaleX: ratio(), originX: 0 }} /></View>
      <MobileTextButton label="+" compact onPress={() => set(props.value + step)} />
      <Text class={valueClass()}>{String(props.value)}</Text>
    </View>
  );
}

export function MobileDialog(props: { open: boolean | (() => boolean); title: string; body?: string; children?: JSX.Element; onClose: () => void }): JSX.Element {
  const theme = useMobileThemeAccessor();
  const titleClass = () => theme().name === "dark" ? "text-lg text-white font-bold" : "text-lg text-slate-950 font-bold";
  const bodyClass = () => theme().name === "dark" ? "text-xs text-slate-300" : "text-xs text-slate-600";
  return (
    <Show when={typeof props.open === "function" ? props.open() : props.open}>
      <Modal open>
        <Text class={titleClass()}>{props.title}</Text>
        {props.body ? <Text class={bodyClass()}>{props.body}</Text> : null}
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
  const recipe = () => buildLiquidGlassRecipe({ shape: props.shape ?? "rounded", focused: props.pressed === true, warp: true });
  // Keep the shell transparent when a native surface is registered; the
  // gradient layer below is only the unsupported-host fallback.
  const fallbackClass = props.class ?? "flex-col gap-2 p-3 rounded-xl border-slate-200";
  const payload = (): string => {
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
  };
  let mounted = false;
  const register = (): void => {
    const registerSurface = surfaceGlobal.pocket?.registerSurface;
    if (typeof registerSurface !== "function") {
      setRegistered(false);
      return;
    }
    try {
      const ok = registerSurface(id, "glass", payload()) !== false;
      setRegistered(ok);
    } catch {
      setRegistered(false);
    }
  };
  onMount(() => {
    mounted = true;
    register();
  });
  // The host updates an existing package id in place. This keeps shape and
  // pressed/focus controls interactive without remounting the surface node.
  createEffect(() => {
    void props.shape;
    void props.pressed;
    if (mounted && registered()) register();
  });
  onCleanup(() => surfaceGlobal.pocket?.releaseSurface?.(id));
  return (
    <View class={fallbackClass}>
      <Show when={registered()}>
        <View class="absolute inset-0 overflow-hidden rounded-xl">
          <CompositorGlass packageId={id} radius={recipe().radius} />
        </View>
      </Show>
      <Show when={!registered()}>
        <View class="absolute inset-0 overflow-hidden rounded-xl" style={{ gradFrom: recipe().bgColors[0], gradTo: recipe().bgColors[2], gradDir: 1, radius: recipe().radius, shadow: recipe().shadowBlur > 20 ? 2 : 1 }} />
      </Show>
      <View class="relative flex-col gap-2">{props.children}</View>
    </View>
  );
}

function CompositorGlass(props: { packageId: string; radius: number }): JSX.Element {
  // Kept as a tiny adapter to make the required native surface primitive
  // explicit; callers still compose ordinary children above it.
  return CompositorSurface({ package: props.packageId, class: "absolute inset-0", style: { radius: props.radius } });
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
  let mounted = false;
  const payload = (): string => JSON.stringify({
    textureId: props.textureId,
    sourceWidth: props.sourceWidth,
    sourceHeight: props.sourceHeight,
    fit: props.fit ?? "cover",
    radius: platformTextureRadius(props.radius),
    rotationDegrees: props.rotationDegrees ?? 0,
    mirrorX: props.mirrorX ?? false,
  });
  const register = (): void => {
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
  onMount(() => {
    mounted = true;
    register();
  });
  createEffect(() => {
    void props.textureId;
    void props.sourceWidth;
    void props.sourceHeight;
    void props.fit;
    void props.radius;
    void props.rotationDegrees;
    void props.mirrorX;
    if (mounted && registered()) register();
  });
  onCleanup(() => surfaceGlobal.pocket?.releaseSurface?.(id));
  return (
    <Show
      when={registered()}
      fallback={<View class={props.class ?? "flex-col items-center justify-center rounded-xl bg-slate-200"} style={{ radius: platformTextureRadius(props.radius) }}><Text class="text-xs text-slate-600">Texture provider unavailable</Text></View>}
    >
      <View class={props.class ?? "relative overflow-hidden rounded-xl"} style={{ radius: platformTextureRadius(props.radius) }}>
        <CompositorSurface package={id} class="absolute inset-0" style={{ radius: platformTextureRadius(props.radius) }} />
      </View>
    </Show>
  );
}

// Compatibility vocabulary from the old UIKit. These are aliases, not extra
// implementations, so consumers can migrate names without multiplying logic.
export const Scaffold = MobileScaffold;
export const AppBar = MobileAppBar;
export const FilledButton = MobileFilledButton;
export const ElevatedButton = MobileFilledButton;
export const OutlinedButton = MobileOutlinedButton;
export const TextButton = MobileTextButton;
export const ListTile = MobileListTile;
