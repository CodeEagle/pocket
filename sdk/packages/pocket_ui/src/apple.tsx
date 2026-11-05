/**
 * Independent Apple-style composition helpers.
 *
 * These helpers are deliberately parallel to the existing mobile vocabulary:
 * consumers can opt into one glass button, toolbar or navigation capsule
 * without changing the default Showcase shell.  The host-facing glass bridge
 * remains `GlassSurface`; this module only composes it with JS-owned controls.
 */

import { createContext, createEffect, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { simulationHz, virtualNow } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import type { NodeMirror, ViewProps } from "@pocketjs/framework/solid/components";
import {
  GlassSurface,
  toMobileColor,
  useMobileTheme,
  useAnimatedNumber,
} from "./mobile.tsx";
import { useAccessibilityPreferences } from "./accessibility.ts";
import { useRouteActive } from "./route.tsx";
import { stepMotionSpring } from "./motion.ts";
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

function appleGlassStyleNumber(
  style: ViewProps["style"] | undefined,
  name: "translateX" | "translateY" | "scaleX" | "scaleY",
  fallback: number,
): number {
  const value = style?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampAppleGlass(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * An opt-in direct-manipulation glass control.
 * The shell remains one `GlassSurface`; movement and jelly are
 * paint-only transforms, so flex geometry and the native surface provider
 * stay shared with every other glass consumer.
 */
export interface AppleDraggableGlassProps {
  children?: JSX.Element;
  class?: string;
  style?: ViewProps["style"];
  /** Keep the drag while removing only the velocity-driven shape response. */
  elastic?: boolean;
  /** Symmetric logical-pixel travel bounds from the source position. */
  maxX?: number;
  /** Symmetric logical-pixel travel bounds from the source position. */
  maxY?: number;
}

export function AppleDraggableGlass(props: AppleDraggableGlassProps): JSX.Element {
  const accessibility = useAccessibilityPreferences();
  const routeActive = useRouteActive();
  const [offsetX, setOffsetX] = createSignal(0);
  const [offsetY, setOffsetY] = createSignal(0);
  const [shapeTargetX, setShapeTargetX] = createSignal(1);
  const [shapeTargetY, setShapeTargetY] = createSignal(1);
  const shapeScaleX = useAnimatedNumber(shapeTargetX, 0.38, 200);
  const shapeScaleY = useAnimatedNumber(shapeTargetY, 0.38, 200);

  let node: NodeMirror | undefined;
  let gestureHandle: { cancel: () => void } | undefined;
  let disposed = false;
  let phase: "idle" | "pressed" | "dragging" | "returning" = "idle";
  let positionX = 0;
  let positionY = 0;
  let velocityX = 0;
  let velocityY = 0;
  let lastFrame = virtualNow();

  const reducedMotion = (): boolean => accessibility().reduceMotion === true;
  const elasticEnabled = (): boolean => props.elastic !== false && !reducedMotion();
  const boundedOffset = (value: number, limit: number | undefined, fallback: number): number => {
    const extent = typeof limit === "number" && Number.isFinite(limit) ? Math.abs(limit) : fallback;
    return clampAppleGlass(value, -extent, extent);
  };

  const setShapeFromVelocity = (vx: number, vy: number): void => {
    if (!elasticEnabled()) {
      setShapeTargetX(1);
      setShapeTargetY(1);
      return;
    }
    // The retained parent shader bounded its normalized velocity at .32;
    // mapping that same input to the host's paint scale gives a useful
    // <=12% squash/stretch envelope without adding another shader state.
    const vxNorm = clampAppleGlass((Number.isFinite(vx) ? vx : 0) / 1000, -0.32, 0.32);
    const vyNorm = clampAppleGlass((Number.isFinite(vy) ? vy : 0) / 1000, -0.32, 0.32);
    setShapeTargetX(clampAppleGlass(1 + vxNorm * 0.38 - vyNorm * 0.16, 0.88, 1.12));
    setShapeTargetY(clampAppleGlass(1 + vyNorm * 0.38 - vxNorm * 0.16, 0.88, 1.12));
  };

  const syncOrigin = (): void => {
    setOffsetX(positionX);
    setOffsetY(positionY);
  };

  const settleImmediately = (): void => {
    positionX = 0;
    positionY = 0;
    velocityX = 0;
    velocityY = 0;
    phase = "idle";
    syncOrigin();
    setShapeTargetX(1);
    setShapeTargetY(1);
  };

  const releaseToOrigin = (releaseVelocityX = 0, releaseVelocityY = 0): void => {
    if (disposed || !routeActive() || reducedMotion()) {
      settleImmediately();
      return;
    }
    velocityX = Number.isFinite(releaseVelocityX) ? clampAppleGlass(releaseVelocityX, -1200, 1200) : 0;
    velocityY = Number.isFinite(releaseVelocityY) ? clampAppleGlass(releaseVelocityY, -1200, 1200) : 0;
    if (
      Math.abs(positionX) < 0.001 &&
      Math.abs(positionY) < 0.001 &&
      Math.abs(velocityX) < 0.001 &&
      Math.abs(velocityY) < 0.001
    ) {
      settleImmediately();
      return;
    }
    phase = "returning";
    lastFrame = virtualNow();
    setShapeFromVelocity(velocityX, velocityY);
  };

  gestureHandle = createGesture({
    axis: "any",
    region: {
      node: () => (routeActive() && !disposed ? node : undefined),
    },
    panSlop: 1,
    onDown: () => {
      if (disposed || !routeActive()) return;
      // A new contact owns the currently painted position. Stopping the
      // spring here is what makes a re-grab interrupt without a jump.
      phase = "pressed";
      velocityX = 0;
      velocityY = 0;
      lastFrame = virtualNow();
      if (!elasticEnabled()) {
        setShapeTargetX(1);
        setShapeTargetY(1);
      }
    },
    onPanStart: () => {
      if (disposed || !routeActive()) return;
      phase = "dragging";
      velocityX = 0;
      velocityY = 0;
    },
    onPanMove: (contact) => {
      if (disposed || !routeActive() || phase !== "dragging") return;
      positionX = boundedOffset(positionX + contact.fdx, props.maxX, 96);
      positionY = boundedOffset(positionY + contact.fdy, props.maxY, 72);
      syncOrigin();
      const fallbackVelocityX = contact.fdx * simulationHz();
      const fallbackVelocityY = contact.fdy * simulationHz();
      setShapeFromVelocity(
        Math.abs(contact.vx) > 0.001 ? contact.vx : fallbackVelocityX,
        Math.abs(contact.vy) > 0.001 ? contact.vy : fallbackVelocityY,
      );
    },
    onPanEnd: (contact) => {
      if (phase !== "dragging") return;
      releaseToOrigin(contact.vx, contact.vy);
    },
    onUp: () => {
      // `onUp` runs before `onPanEnd`; only the tap/no-pan path releases here.
      if (phase === "pressed") {
        releaseToOrigin(0, 0);
      }
    },
    onCancel: () => {
      if (phase === "idle") return;
      releaseToOrigin(0, 0);
    },
  });

  onFrame(() => {
    if (disposed || !routeActive()) return;
    const now = virtualNow();
    const delta = Math.max(0, now - lastFrame);
    lastFrame = now;
    if (phase !== "returning") return;
    if (reducedMotion()) {
      settleImmediately();
      return;
    }
    const nextX = stepMotionSpring(positionX, velocityX, 0, delta, 560, 0.62);
    const nextY = stepMotionSpring(positionY, velocityY, 0, delta, 560, 0.62);
    positionX = nextX.position;
    positionY = nextY.position;
    velocityX = nextX.velocity;
    velocityY = nextY.velocity;
    syncOrigin();
    setShapeFromVelocity(velocityX, velocityY);
    if (
      Math.abs(positionX) < 0.03 &&
      Math.abs(positionY) < 0.03 &&
      Math.abs(velocityX) < 0.6 &&
      Math.abs(velocityY) < 0.6
    ) {
      settleImmediately();
    }
  }, {
    active: () => routeActive() && !disposed && phase === "returning",
    continuous: () => routeActive() && !disposed && phase === "returning",
  });

  createEffect(() => {
    const reduce = accessibility().reduceMotion;
    const elastic = props.elastic !== false && !reduce;
    if (!elastic) {
      setShapeTargetX(1);
      setShapeTargetY(1);
    }
    if (reduce && phase === "returning") settleImmediately();
  });

  createEffect(() => {
    if (!routeActive()) {
      gestureHandle?.cancel();
      settleImmediately();
    }
  });

  onCleanup(() => {
    disposed = true;
    gestureHandle?.cancel();
    phase = "idle";
  });

  const externalTranslateX = () => appleGlassStyleNumber(props.style, "translateX", 0);
  const externalTranslateY = () => appleGlassStyleNumber(props.style, "translateY", 0);
  const externalScaleX = () => appleGlassStyleNumber(props.style, "scaleX", 1);
  const externalScaleY = () => appleGlassStyleNumber(props.style, "scaleY", 1);
  return (
    <GlassSurface
      class={props.class ?? "min-h-[44] flex-col"}
      material="regular"
      shape="pill"
      radius={999}
      warp={false}
      contentClass="relative w-full h-full flex-col items-center justify-center px-4 py-2"
      style={{
        minW: 44, minH: 44,
        ...(props.style ?? {}),
        translateX: externalTranslateX() + offsetX(),
        translateY: externalTranslateY() + offsetY(),
        scaleX: externalScaleX() * shapeScaleX(),
        scaleY: externalScaleY() * shapeScaleY(),
      }}
      nodeRef={(current) => {
        node = current;
      }}
    >
      {props.children}
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
