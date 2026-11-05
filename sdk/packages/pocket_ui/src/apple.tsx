/**
 * Independent Apple-style composition helpers.
 *
 * These helpers are deliberately parallel to the existing mobile vocabulary:
 * consumers can opt into one glass button, toolbar or navigation capsule
 * without changing the default Showcase shell.  The host-facing glass bridge
 * remains `GlassSurface`; this module only composes it with JS-owned controls.
 */

import { createContext, useContext, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import {
  GlassSurface,
  toMobileColor,
  useMobileTheme,
} from "./mobile.tsx";
import { useAccessibilityPreferences } from "./accessibility.ts";
import { useRouteActive } from "./route.tsx";
import { useAppleSemantics, type AppleSemanticNodeRef } from "./semantics.ts";
import {
  NavigationBar,
  ScrollablePageContext,
  SafeAreaScaffoldContext,
  type NavigationBarProps,
  type NavigationItem,
} from "./ui.tsx";

const AppleGlassGroupContext = createContext(false);
let nextAppleSemanticInstance = 0;

function nextAppleSemanticId(kind: "button" | "tab"): string {
  nextAppleSemanticInstance += 1;
  return `apple.${kind}.${nextAppleSemanticInstance}`;
}

function relativeLuminance(value: number | undefined): number {
  const color = (value ?? 0xff315deb) >>> 0;
  const channel = (shift: number): number => {
    const srgb = ((color >>> shift) & 0xff) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function selectedInkColor(value: number | undefined): string {
  const background = relativeLuminance(value);
  const white = 1;
  const dark = relativeLuminance(0x0b1324);
  const whiteContrast = (Math.max(background, white) + 0.05) / (Math.min(background, white) + 0.05);
  const darkContrast = (Math.max(background, dark) + 0.05) / (Math.min(background, dark) + 0.05);
  return darkContrast >= whiteContrast ? "#0B1324" : "#FFFFFF";
}

function appleActionTextClass(scale: number): string {
  if (scale >= 1.9) return "text-4xl font-bold";
  if (scale >= 1.5) return "text-2xl font-bold";
  if (scale >= 1.2) return "text-xl font-bold";
  return "text-base font-bold";
}

function appleToolbarTitleClass(scale: number): string {
  if (scale >= 1.9) return "text-4xl font-bold";
  if (scale >= 1.5) return "text-2xl font-bold";
  if (scale >= 1.2) return "text-xl font-bold";
  return "text-base font-bold";
}

function appleToolbarSubtitleClass(scale: number): string {
  if (scale >= 1.9) return "text-2xl";
  if (scale >= 1.5) return "text-xl";
  if (scale >= 1.2) return "text-base";
  return "text-sm";
}

function AppleGlassActionContent(props: {
  label: string;
  icon?: JSX.Element;
  selected: boolean;
  dark: boolean;
  textScale: number;
  selectedInk: string;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap items-center justify-center gap-2" style={{ minW: 0 }}>
      {props.icon}
      <Text
        class={appleActionTextClass(props.textScale)}
        style={{ minW: 0, textColor: props.selected ? props.selectedInk : props.dark ? "#F8FAFC" : "#23314A" }}
      >{props.label}</Text>
    </View>
  );
}
export interface AppleGlassButtonProps {
  label: string;
  icon?: JSX.Element;
  material?: "regular" | "clear";
  onPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
}

/**
 * A 44pt Apple-style action. Standalone use gets one regular glass surface;
 * when created by `AppleGlassToolbar.actions`, the provider context keeps it
 * as a tinted child so a toolbar action does not register a second surface.
 */
export function AppleGlassButton(props: AppleGlassButtonProps): JSX.Element {
  const theme = useMobileTheme();
  const accessibility = useAccessibilityPreferences();
  const semantics = useAppleSemantics();
  const routeActive = useRouteActive();
  const scrollPage = useContext(ScrollablePageContext);
  const inGlassGroup = useContext(AppleGlassGroupContext);
  const selected = () => props.selected === true;
  const dark = () => theme().name === "dark";
  const textScale = () => accessibility().textScale;
  const accentColor = () => toMobileColor(theme().accentColor);
  const selectedInk = () => selectedInkColor(theme().accentColor);
  const semanticNodeRef = semantics?.register({
    id: nextAppleSemanticId("button"),
    label: () => props.label,
    role: "button",
    selected,
    ...(props.selected !== undefined ? { checked: () => props.selected === true } : {}),
    disabled: () => props.disabled === true,
    routeActive,
    onActivate: () => props.onPress?.(),
    visualRect: scrollPage?.visualRect
      ? (node, committed) => scrollPage.visualRect?.(node) ?? committed
      : undefined,
    clipRect: scrollPage?.clipRect,
  });
  const content = (
    <Focusable
      class={selected()
        ? "min-h-[44] px-3 py-2 flex-row flex-wrap items-center justify-center bg-[#315DEB] focus:bg-[#2748C5] active:bg-[#1E3A8A] transition-colors duration-150 ease-out"
        : dark()
          ? "min-h-[44] px-3 py-2 flex-row flex-wrap items-center justify-center bg-[#15233A] focus:bg-[#20375C] active:bg-[#294778] transition-colors duration-150 ease-out"
          : "min-h-[44] px-3 py-2 flex-row flex-wrap items-center justify-center bg-[#FFFFFF66] focus:bg-[#FFFFFF99] active:bg-[#FFFFFFBB] transition-colors duration-150 ease-out"}
      style={{
        radius: 999,
        minW: 44,
        opacity: props.disabled ? 0.5 : 1,
        ...(selected() ? { bgColor: accentColor() } : {}),
      }}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
      nodeRef={semanticNodeRef}
    >
      <AppleGlassActionContent label={props.label} icon={props.icon} selected={selected()} dark={dark()} textScale={textScale()} selectedInk={selectedInk()} />
    </Focusable>
  );
  if (inGlassGroup) return content;
  return (
    <GlassSurface
      shape="pill"
      material={props.material ?? "regular"}
      radius={999}
      blur={props.material === "clear" ? 3 : 7.5}
      warp={false}
      class="flex-col"
      contentClass="flex-row items-center justify-center"
    >
      {content}
    </GlassSurface>
  );
}

export interface AppleGlassToolbarProps {
  title: string;
  subtitle?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Lazy action slot; it is resolved inside the toolbar's glass-group provider. */
  actions?: () => JSX.Element;
}

/** One regular material surface for a toolbar and its ordinary tint actions. */
export function AppleGlassToolbar(props: AppleGlassToolbarProps): JSX.Element {
  const theme = useMobileTheme();
  const accessibility = useAccessibilityPreferences();
  const textScale = () => accessibility().textScale;
  return (
    <AppleGlassGroupContext.Provider value={true}>
      <GlassSurface
        shape="rounded"
        material="regular"
        radius={28}
        blur={7.5}
        warp={false}
        class="w-full flex-col"
        contentClass="w-full flex-row items-center gap-3 px-4 py-3"
      >
        {props.leading}
        <View
          class="flex-col gap-1 overflow-hidden"
          style={{ minW: 0, width: 0, grow: 1, shrink: 1, basis: 0 }}
        >
          <Text class={appleToolbarTitleClass(textScale())} style={{ minW: 0, textColor: theme().name === "dark" ? "#F8FAFC" : "#152238" }}>{props.title}</Text>
          {props.subtitle ? <Text class={appleToolbarSubtitleClass(textScale())} style={{ minW: 0, textColor: theme().name === "dark" ? "#B9C5D8" : "#66758A" }}>{props.subtitle}</Text> : null}
        </View>
        {props.actions ? props.actions() : props.trailing}
      </GlassSurface>
    </AppleGlassGroupContext.Provider>
  );
}

export interface AppleGlassNavigationBarProps extends Omit<NavigationBarProps, "onNavigate" | "onItemPress" | "route" | "background" | "floating" | "selectionIndicator" | "nodeRefForItem"> {
  active: string;
  items: readonly NavigationItem[];
  onChange: (id: string) => void;
}

/**
 * Opt-in capsule navigation. It delegates icon layout, safe-area handling,
 * focus targets and the spring selection indicator to `NavigationBar`; this
 * wrapper only supplies the regular glass background and Apple defaults.
 */
export function AppleGlassNavigationBar(props: AppleGlassNavigationBarProps): JSX.Element {
  const theme = useMobileTheme();
  const semantics = useAppleSemantics();
  const routeActive = useRouteActive();
  const scrollPage = useContext(ScrollablePageContext);
  const scaffold = useContext(SafeAreaScaffoldContext);
  const dark = () => props.dark ?? theme().name === "dark";
  const tabSemanticRefs = new Map<string, AppleSemanticNodeRef>();
  const tabSemanticPrefix = nextAppleSemanticId("tab");
  const nodeRefForItem = (item: NavigationItem): AppleSemanticNodeRef | undefined => {
    if (!semantics) return undefined;
    const existing = tabSemanticRefs.get(item.id);
    if (existing) return existing;
    const nodeRef = semantics.register({
      id: `${tabSemanticPrefix}.${item.id}`,
      label: () => item.label,
      role: "tab",
      selected: () => props.active === item.id,
      disabled: () => false,
      routeActive,
      onActivate: () => props.onChange(item.id),
      visualRect: scrollPage?.visualRect
        ? (node, committed) => scrollPage.visualRect?.(node) ?? committed
        : undefined,
      clipRect: scrollPage?.clipRect,
    });
    tabSemanticRefs.set(item.id, nodeRef);
    return nodeRef;
  };
  const barGeometry = () => props.geometry
    ? (typeof props.geometry === "function" ? props.geometry() : props.geometry)
    : scaffold.geometry();
  return (
    <NavigationBar
      route={props.active}
      onNavigate={() => undefined}
      items={props.items}
      visible={props.visible}
      dark={dark()}
      wide={props.wide}
      onItemPress={props.onChange}
      nodeRefForItem={nodeRefForItem}
      geometry={barGeometry}
      floating
      selectionIndicator
      background={
        <GlassSurface
          shape="pill"
          material="regular"
          radius={999}
          blur={7.5}
          warp={false}
          class="absolute inset-0"
          style={{ radius: 999 }}
          contentClass=""
        />
      }
      accentColor={props.accentColor ?? theme().accentInkColor ?? theme().accentColor}
    />
  );
}
