/**
 * Thin guest composition primitives.
 *
 * Every primitive here is a Solid function assembled from official PocketJS
 * components. This is intentionally a small app UI kit, not a second
 * Flutter widget catalogue or a claim that all upstream components are
 * mounted by this sample.
 */

import { For, createEffect, createSignal, onCleanup, type Accessor, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
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
import { availableDisplayPanes, deriveResponsiveLayout, type DisplayGeometry } from "./responsive.ts";

export interface HeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  badge?: string;
}

export function Header(props: HeaderProps): JSX.Element {
  return (
    <View class="flex-row items-center justify-between h-[56] px-4 bg-white border-slate-200">
      <View class="flex-col justify-center">
        <Text class="text-base text-slate-950 font-bold">{props.title}</Text>
      </View>
      {props.badge ? <Badge tone="cyan">{props.badge}</Badge> : null}
    </View>
  );
}

export function PageIntro(props: { title: string; body: string }): JSX.Element {
  return (
    <View class="flex-col gap-1 px-4 pt-3">
      <Text class="text-xl text-slate-950 font-bold">{props.title}</Text>
      <Text class="text-xs text-slate-600">{props.body}</Text>
    </View>
  );
}

export function SectionHeading(props: { title: string; detail?: string; dark?: boolean }): JSX.Element {
  const titleClass = props.dark ? "text-sm text-white font-bold" : "text-sm text-slate-950 font-bold";
  const detailClass = props.dark ? "text-xs text-cyan-200" : "text-xs text-slate-500";
  return (
    <View class="flex-row items-center justify-between px-4 pt-3">
      <Text class={titleClass}>{props.title}</Text>
      {props.detail ? <Text class={detailClass}>{props.detail}</Text> : null}
    </View>
  );
}

export interface ActionButtonProps extends ViewProps {
  label: string;
  kind?: "primary" | "secondary" | "quiet" | "danger";
  onPress?: () => void;
  icon?: string;
  disabled?: boolean;
}

function actionClass(kind: ActionButtonProps["kind"]): string {
  switch (kind) {
    case "secondary": return "px-3 py-2 rounded-lg bg-blue-500 focus:bg-blue-600";
    case "quiet": return "px-3 py-2 rounded-lg bg-slate-200 focus:bg-slate-300";
    case "danger": return "px-3 py-2 rounded-lg bg-rose-600 focus:bg-rose-500";
    default: return "px-3 py-2 rounded-lg bg-blue-600 focus:bg-blue-500";
  }
}

export function ActionButton(props: ActionButtonProps): JSX.Element {
  const buttonClass = () => props.disabled
    ? `${props.class ?? actionClass(props.kind)} opacity-50`
    : props.class ?? actionClass(props.kind);
  return (
    <Focusable
      class={buttonClass()}
      style={props.style}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      {props.icon ? (
        <View class="flex-col items-center justify-center gap-1">
          <Text class={props.kind === "quiet" ? "text-sm text-slate-700 font-bold" : "text-sm text-white font-bold"}>{props.icon}</Text>
          <Text class={props.kind === "quiet" ? "text-xs text-slate-800 font-bold" : "text-xs text-white font-bold"}>{props.label}</Text>
        </View>
      ) : (
        <Text class={props.kind === "quiet" ? "text-xs text-slate-800 font-bold" : "text-xs text-white font-bold"}>
          {props.label}
        </Text>
      )}
    </Focusable>
  );
}

// Public vocabulary alias; there is still only one button implementation.
export const Button = ActionButton;

export function Badge(props: { children?: JSX.Element; tone?: "cyan" | "green" | "amber" | "rose" }): JSX.Element {
  const cls = props.tone === "green"
    ? "px-2 py-1 rounded-lg bg-emerald-500"
    : props.tone === "amber"
      ? "px-2 py-1 rounded-lg bg-amber-400"
      : props.tone === "rose"
        ? "px-2 py-1 rounded-lg bg-rose-500"
        : "px-2 py-1 rounded-lg bg-cyan-500";
  return <View class={cls}><Text class="text-xs text-slate-950 font-bold">{props.children}</Text></View>;
}

export function EmptyState(props: { title: string; body: string; action?: JSX.Element }): JSX.Element {
  return (
    <View class="flex-col items-center gap-2 p-4 rounded-xl bg-slate-100 border-slate-200">
      <Text class="text-sm text-slate-950 font-bold">{props.title}</Text>
      <Text class="text-xs text-slate-600">{props.body}</Text>
      {props.action}
    </View>
  );
}

export function MetricCard(props: { label: string; value: string; detail?: string; tone?: "blue" | "purple" | "green" }): JSX.Element {
  const cls = props.tone === "purple"
    ? "flex-1 flex-col gap-1 p-3 rounded-xl bg-purple-100"
    : props.tone === "green"
      ? "flex-1 flex-col gap-1 p-3 rounded-xl bg-emerald-100"
      : "flex-1 flex-col gap-1 p-3 rounded-xl bg-blue-100";
  return (
    <View class={cls}>
      <Text class="text-xs text-slate-600">{props.label}</Text>
      <Text class="text-xl text-slate-950 font-bold">{props.value}</Text>
      {props.detail ? <Text class="text-xs text-slate-600">{props.detail}</Text> : null}
    </View>
  );
}

export function StatusBar(props: { label: string; detail: string; ok?: boolean }): JSX.Element {
  return (
    <View class="flex-row items-center justify-between px-3 py-2 rounded-lg bg-[#172235]">
      <View class="flex-row items-center gap-2">
        <View class={props.ok === false ? "w-2 h-2 rounded-full bg-rose-500" : "w-2 h-2 rounded-full bg-emerald-500"} />
        <Text class="text-xs text-white font-bold">{props.label}</Text>
      </View>
      <Text class="text-xs text-slate-300">{props.detail}</Text>
    </View>
  );
}

export type NavigationRoute = "home" | "gallery" | "about";

export function NavigationBar(props: {
  route: string;
  onNavigate: (route: NavigationRoute) => void;
  wide?: boolean | (() => boolean);
  geometry?: DisplayGeometry | (() => DisplayGeometry);
}): JSX.Element {
  const wide = () => typeof props.wide === "function" ? props.wide() : props.wide === true;
  const layout = () => {
    if (props.geometry) {
      const geometry = typeof props.geometry === "function" ? props.geometry() : props.geometry;
      return deriveResponsiveLayout(geometry);
    }
    return {
      mode: wide() ? "wide" as const : "narrow" as const,
      navigation: wide() ? "rail" as const : "bottom" as const,
      railSide: "right" as const,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  };
  const rail = () => layout().navigation === "rail";
  const navStyle = () => {
    const resolved = layout();
    const padding = resolved.insets;
    if (!rail()) {
      // Let the children and bottom inset determine the outer extent. A fixed
      // 56px shell plus paddingB would put controls under the home indicator.
      return { paddingL: padding.left, paddingR: padding.right, paddingB: padding.bottom };
    }
    const panes = props.geometry
      ? availableDisplayPanes(typeof props.geometry === "function" ? props.geometry() : props.geometry)
      : [];
    const pane = panes.length > 1
      ? (resolved.railSide === "right" ? panes[panes.length - 1]! : panes[0]!)
      : undefined;
    const divisionGap = resolved.division?.frame.width ?? 0;
    const splitDisplay = pane !== undefined;
    return {
      width: pane?.width ?? 104,
      paddingT: padding.top,
      paddingB: padding.bottom,
      // A split pane already excludes the outer safe-area inset. Applying
      // padding.right/left again would move the rail outside the display
      // rect; only the hinge gap (and, for a left rail, the leading inset)
      // belongs in the sibling extent. The no-division fallback keeps the
      // outer trailing inset when the rail is laid out beside a flex pane.
      marginL: splitDisplay
        ? (resolved.railSide === "right" ? divisionGap : padding.left)
        : 0,
      marginR: splitDisplay
        ? (resolved.railSide === "left" ? divisionGap : 0)
        : padding.right,
    };
  };
  const hostRoute = props.route !== "home" && props.route !== "gallery";
  const items = [
    { id: "home" as const, label: "Home", icon: "⌂" },
    // Keep the old Gallery route as the compatibility alias for the UI page.
    { id: "gallery" as const, label: "Gallery", icon: "▦" },
    { id: "about" as const, label: "Host", icon: "☷" },
  ];
  return (
    <View style={navStyle()} class={rail() ? "flex-col items-center gap-2 h-full px-2 py-3 bg-white border-slate-200" : "flex-row items-center gap-1 px-2 bg-white border-slate-200"}>
      <For each={items}>
        {(item) => (
          <ActionButton
            label={item.label}
            icon={item.icon}
            class={rail()
              ? (props.route === item.id || (hostRoute && item.id === "about")
                ? "w-[88] h-[64] items-center justify-center rounded-lg bg-blue-600 focus:bg-blue-500"
                : "w-[88] h-[64] items-center justify-center rounded-lg bg-slate-100 focus:bg-slate-200")
              : (props.route === item.id || (hostRoute && item.id === "about")
                ? "flex-1 h-[48] items-center justify-center rounded-lg bg-blue-600 focus:bg-blue-500"
                : "flex-1 h-[48] items-center justify-center rounded-lg bg-slate-100 focus:bg-slate-200")}
            kind={props.route === item.id || (hostRoute && item.id === "about") ? "primary" : "quiet"}
            onPress={() => props.onNavigate(item.id)}
          />
        )}
      </For>
    </View>
  );
}

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs(props: { items: readonly TabItem[]; active: string; onChange: (id: string) => void }): JSX.Element {
  return (
    <View class="flex-row gap-1 px-4 py-2 bg-slate-100">
      <For each={props.items}>
        {(item) => (
          <ActionButton
            label={item.label}
            kind={props.active === item.id ? "primary" : "quiet"}
            onPress={() => props.onChange(item.id)}
          />
        )}
      </For>
    </View>
  );
}

/**
 * The guest-side text input contract is deliberately only a small shell:
 * Flutter owns the real TextField and system keyboard overlay.  The shell
 * supplies its committed layout rectangle and keeps the app draft as the
 * only value authority; it never paints a keyboard or keeps a second text
 * buffer.
 */
type TextInputParams = Record<string, unknown>;

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
  close: () => void;
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
export type InputFieldColor = `#${string}`;

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
  textColor: "#283444",
  placeholderColor: "#667485",
  fillColor: "#ffffff",
  borderColor: "#9aa5b2",
  focusedBorderColor: "#2676cb",
  borderRadius: 8,
  fontSize: 14,
  paddingHorizontal: 12,
  paddingVertical: 8,
};

function normalizeInputColor(
  value: InputFieldColor | undefined,
  fallback: InputFieldColor,
): InputFieldColor {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^#[0-9a-f]{6}$/.test(normalized)
    ? normalized as InputFieldColor
    : fallback;
}

type TextInputPocket = {
  _emit?: (line: string) => boolean;
  getLayout?: (id: number) => unknown;
};

const textInputGlobal = globalThis as typeof globalThis & {
  pocket?: TextInputPocket;
  ui?: { __viewport?: { w?: unknown; h?: unknown } };
};
let nextTextInputId = 1;
let activeTextInput: TextInputSession | undefined;
let activePageScroll: {
  ensureVisible: (node: NodeMirror, fallback?: TextInputRect) => void;
  visualRect: (node: NodeMirror, fallback?: TextInputRect) => TextInputRect | undefined;
} | undefined;

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
  const rect = committedLayout(node, true);
  if (!rect) return undefined;
  // During a live keyboard/Duo resize the retained layout tree can report the
  // previous clip height for one or more frames. The framework's canonical
  // `ui.__viewport` is already updated by resizeViewport; use it to cap the
  // visible page extent while retaining the committed canvas origin.
  const liveHeight = finiteNumber(textInputGlobal.ui?.__viewport?.h);
  const liveWidth = finiteNumber(textInputGlobal.ui?.__viewport?.w);
  const width = rect.width > 0 ? rect.width : liveWidth && liveWidth > 0 ? liveWidth : rect.width;
  if (liveHeight === undefined || liveHeight <= rect.y) return { ...rect, width };
  return { ...rect, width, height: Math.max(1, Math.min(rect.height, liveHeight - rect.y)) };
}

function emitTextInput(method: string, params: TextInputParams): boolean {
  const emit = textInputGlobal.pocket?._emit;
  if (typeof emit !== "function") return false;
  try {
    return emit(JSON.stringify({ type: "event", name: method, payload: params })) === true;
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

/** Deliver Flutter's edit/submit/close notifications to the mounted shell. */
export function deliverTextInputEvent(method: string, params: TextInputParams): boolean {
  if (
    method !== "textInput.edit" &&
    method !== "textInput.submit" &&
    method !== "textInput.closed" &&
    method !== "textInput.dismiss" &&
    method !== "textInput.close"
  ) return false;
  const session = activeTextInput;
  if (!session) return false;
  const eventId = params.id === undefined || params.id === null ? undefined : String(params.id);
  if (eventId === undefined || eventId !== session.id || !session.isOpen()) return false;
  switch (method) {
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
  const id = `guest-text-input-${nextTextInputId++}`;
  const [isFocused, setIsFocused] = createSignal(false);
  let node: NodeMirror | undefined;
  let opened = false;
  let lastObservedText = props.value();
  let selectionBase = lastObservedText.length;
  let selectionExtent = lastObservedText.length;
  let composingBase = -1;
  let composingExtent = -1;
  let lastRect: TextInputRect | undefined;
  let textLayoutDirty = false;
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
  const appearanceParams = (): TextInputParams => ({
    ...appearance(),
    placeholder: props.placeholder ?? "Tap to type",
  });
  const shellStyle = () => {
    const current = appearance();
    return {
      width: -1,
      bgColor: current.fillColor,
      borderColor: isFocused() ? current.focusedBorderColor : current.borderColor,
      borderWidth: 1,
      radius: current.borderRadius,
      paddingL: current.paddingHorizontal,
      paddingR: current.paddingHorizontal,
      paddingT: current.paddingVertical,
      paddingB: current.paddingVertical,
    };
  };
  const shellTextClass = () => {
    switch (appearance().fontSize) {
      case 12: return "text-xs";
      case 16: return "text-base";
      default: return "text-sm";
    }
  };
  const shellTextStyle = () => ({
    textColor: props.value() ? appearance().textColor : appearance().placeholderColor,
  });

  const visualRect = (): TextInputRect | undefined =>
    activePageScroll?.visualRect(node, lastRect) ?? committedLayout(node) ?? lastRect;

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
    if (!rect) return;
    const sent = emitTextInput("textInput.update", {
      id,
      rect,
      text,
      selectionBase,
      selectionExtent,
      composingBase,
      composingExtent,
      ...appearanceParams(),
    });
    if (sent) lastRect = rect;
  };

  const sendRectUpdate = (): void => {
    if (!opened || activeTextInput !== session) return;
    const rect = visualRect();
    if (!rect) return;
    if (
      lastRect &&
      lastRect.x === rect.x &&
      lastRect.y === rect.y &&
      lastRect.width === rect.width &&
      lastRect.height === rect.height
    ) {
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
      lastRect.height === rect.height
    ) {
      lastRect = rect;
      textLayoutDirty = false;
      return;
    }
    // A layout-only update deliberately omits text and selection metadata.
    // Flutter keeps the current controller value/caret/composing range while
    // moving/resizing its overlay after viewport or keyboard changes.
    if (emitTextInput("textInput.update", { id, rect })) {
      lastRect = rect;
      textLayoutDirty = false;
    }
  };

  const open = (): void => {
    if (node) activePageScroll?.ensureVisible(node, visualRect());
    // Translations are paint-only in the core layout ABI; use the page
    // scroller's visual rect so Flutter's overlay follows the moved shell.
    const rect = visualRect();
    if (!rect) return;
    const text = props.value();
    const wasOpened = opened;
    if (!wasOpened) {
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
      rect,
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
    opened = sent;
    setIsFocused(sent);
    if (sent) {
      activeTextInput = session;
      lastRect = rect;
    } else {
      lastRect = undefined;
    }
  };

  const close = (): void => {
    if (!opened) return;
    opened = false;
    setIsFocused(false);
    lastRect = undefined;
    emitTextInput("textInput.close", { id });
  };

  const session: TextInputSession = {
    id,
    isOpen: () => opened,
    node: () => node,
    visualRect,
    close,
    onEdit: (params) => {
      const text = typeof params.text === "string" ? params.text : props.value();
      updateOffsets(params, text);
      if (typeof params.text === "string") applyIncomingText(text);
    },
    onSubmit: (params) => {
      const text = typeof params.text === "string" ? params.text : props.value();
      updateOffsets(params, text);
      if (typeof params.text === "string") applyIncomingText(text);
      opened = false;
      setIsFocused(false);
      props.onSubmit?.(text);
    },
    onClosed: (params) => {
      const text = typeof params.text === "string" ? params.text : props.value();
      updateOffsets(params, text);
      if (typeof params.text === "string") applyIncomingText(text);
      opened = false;
      setIsFocused(false);
    },
  };

  createEffect(() => {
    const text = props.value();
    if (text === lastObservedText) return;
    lastObservedText = text;
    if (opened) sendUpdate(text);
  });

  // Layout can change after Flutter adjusts the viewport for the system
  // keyboard. Poll only while this session owns the active overlay and only
  // emit when the measured rect differs, so an unchanged frame stays quiet.
  onFrame(sendRectUpdate);

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
      class="w-full"
    >
      <Text class={shellTextClass()} style={shellTextStyle()}>
        {props.value() || props.placeholder || "Tap to type"}
      </Text>
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
}): JSX.Element {
  const fallbackViewportHeight = 480;
  let viewportNode: NodeMirror | undefined;
  let contentNode: NodeMirror | undefined;
  let previousViewportHeight = fallbackViewportHeight;
  let previousOffset = 0;
  const [viewportHeight, setViewportHeight] = createSignal(fallbackViewportHeight);
  const [contentHeight, setContentHeight] = createSignal(fallbackViewportHeight);
  const scroller = createScroller({
    max: () => Math.max(0, contentHeight() - viewportHeight()),
    extent: () => viewportHeight(),
  });

  const pageScroll = {
    visualRect: (node: NodeMirror, fallback?: TextInputRect): TextInputRect | undefined => {
      const rect = committedLayout(node) ?? fallback;
      if (!rect) return undefined;
      // `getLayout` intentionally reports flex geometry without paint
      // transforms. The canvas is the only translated ancestor of page input
      // shells, so apply the current kinetic offset for overlay coordinates.
      return { ...rect, y: rect.y - scroller.offset() };
    },
    ensureVisible: (node: NodeMirror, fallback?: TextInputRect): void => {
      const viewport = viewportLayout(viewportNode);
      if (!viewport) return;
      const input = pageScroll.visualRect(node, fallback);
      if (!input) return;
      const margin = 8;
      const top = viewport.y + margin;
      const bottom = viewport.y + viewport.height - margin;
      const inputBottom = input.y + input.height;
      if (inputBottom > bottom) {
        scroller.scrollBy(inputBottom - bottom, { immediate: true });
      } else if (input.y < top) {
        scroller.scrollBy(input.y - top, { immediate: true });
      }
    },
  };
  activePageScroll = pageScroll;
  onCleanup(() => {
    if (activePageScroll === pageScroll) activePageScroll = undefined;
  });

  createGesture({
    axis: "y",
    // Keep the node hit fact when a host provides it, but retain the official
    // geometry fallback for cold/replay hosts and bare gaps in the viewport.
    // The upstream Clear/VirtualList examples use the same region contract;
    // without the rect a touch whose down hit is unresolved cannot start a
    // page pan even though it is visibly inside the clip.
    region: {
      node: () => viewportNode,
      rect: () => {
        const rect = viewportLayout(viewportNode);
        return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : undefined;
      },
    },
    panSlop: 1,
    onDown: () => scroller.stop(),
    onPanStart: () => scroller.beginDrag(),
    onPanMove: (contact) => scroller.drag(-contact.fdy),
    onPanEnd: (contact) => scroller.endDrag(-contact.vy),
    onCancel: () => scroller.endDrag(0),
  });
  bindDpadScroll(scroller);
  onFrame(() => {
    scroller.step();
    const currentOffset = scroller.offset();
    const scrolled = currentOffset !== previousOffset;
    previousOffset = currentOffset;
    const rect = viewportLayout(viewportNode);
    const viewportChanged = rect !== undefined && rect.height > 0 && rect.height !== previousViewportHeight;
    if (rect && rect.height > 0 && rect.height !== previousViewportHeight) {
      previousViewportHeight = rect.height;
      setViewportHeight(rect.height);
    }
    const measuredContent = committedLayout(contentNode);
    if (measuredContent) {
      const nextContentHeight = Math.max(rect?.height ?? viewportHeight(), measuredContent.height);
      if (nextContentHeight !== contentHeight()) setContentHeight(nextContentHeight);
    }
    const input = activeTextInput;
    const inputNode = input?.isOpen() ? input.node() : undefined;
    if (viewportChanged && inputNode && activePageScroll === pageScroll) {
      pageScroll.ensureVisible(inputNode, input?.visualRect());
    }
    if (scrolled && rect && input && inputNode) {
      const inputRect = pageScroll.visualRect(inputNode, input.visualRect());
      const viewportBottom = rect.y + rect.height;
      const inputBottom = inputRect ? inputRect.y + inputRect.height : 0;
      const outside = !inputRect || inputRect.y < rect.y || inputBottom > viewportBottom;
      if (outside) {
        input.close();
        if (activeTextInput === input) activeTextInput = undefined;
      }
    }
  });

  return (
    <View
      ref={(current) => {
        viewportNode = current;
      }}
      class={props.class ?? "flex-1 w-full overflow-hidden"}
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
  );
}

export function MiniBarChart(props: { values: readonly number[] }): JSX.Element {
  return (
    <View class="flex-row items-end gap-1 h-[32]">
      <For each={props.values}>
        {(value) => <View class="w-2 rounded bg-cyan-500" style={{ height: Math.max(4, value) }} />}
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
  const rowClass = props.tone === "dark" ? "flex-col gap-1 px-3 py-2 bg-[#172235]" : "flex-col gap-1 px-3 py-2 bg-white border-slate-200";
  const titleClass = props.tone === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold";
  const detailClass = props.tone === "dark" ? "text-xs text-slate-300" : "text-xs text-slate-600";
  return (
    <View class="flex-col gap-1 mx-4">
      <For each={props.items}>
        {(item) => (
          <View class={rowClass}>
            <Text class={titleClass}>{item.title}</Text>
            {item.detail ? <Text class={detailClass}>{item.detail}</Text> : null}
          </View>
        )}
      </For>
    </View>
  );
}

export function ViewText(props: { title: string; body: string }): JSX.Element {
  return <View class="flex-col gap-1"><Text class="text-sm text-slate-950 font-bold">{props.title}</Text><Text class="text-xs text-slate-600">{props.body}</Text></View>;
}

export function Card(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <View class={props.class ?? "flex-col gap-2 p-3 rounded-xl bg-white border-slate-200"}>{props.children}</View>;
}

export function Row(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <View class={props.class ?? "flex-row items-center gap-2"}>{props.children}</View>;
}

export function TileGrid(props: { children?: JSX.Element }): JSX.Element {
  return <Grid columns={2} gap={6} class="flex-row flex-wrap">{props.children}</Grid>;
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
      <Text class="text-lg text-slate-950 font-bold">{props.title}</Text>
      <Text class="text-xs text-slate-600">{props.body}</Text>
      <ActionButton label="Close" kind="quiet" onPress={props.onClose} />
    </Modal>
  );
}

// The mobile vocabulary is a thin composition layer over the same official
// primitives above. Keep one implementation and let callers opt into the
// source-backed aliases without duplicating the existing app kit.
export * from "./mobile.tsx";

