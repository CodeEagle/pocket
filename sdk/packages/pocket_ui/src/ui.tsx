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
import { createDisplayGeometry } from "./display.ts";
import { availableDisplayPanes, bottomBarInsets, deriveResponsiveLayout, type DisplayGeometry } from "./responsive.ts";

export interface HeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  badge?: string;
}

export function Header(props: HeaderProps): JSX.Element {
  return (
    <View class="flex-row items-center justify-between h-[56] px-4 bg-white border-[#E5E9F2]">
      <View class="flex-col justify-center gap-1">
        {props.eyebrow ? <Text class="text-xs text-[#7C8799] font-bold">{props.eyebrow}</Text> : null}
        <Text class="text-base text-[#17233B] font-bold">{props.title}</Text>
      </View>
      {props.badge ? <Badge tone="cyan">{props.badge}</Badge> : null}
    </View>
  );
}

export function PageIntro(props: { title: string; body: string }): JSX.Element {
  return (
    <View class="flex-col gap-1 px-4 pt-4 pb-2">
      <Text class="text-xl text-[#17233B] font-bold">{props.title}</Text>
      <Text class="text-sm text-[#7C8799]">{props.body}</Text>
    </View>
  );
}

export function SectionHeading(props: { title: string; detail?: string; dark?: boolean }): JSX.Element {
  return (
    <View class="flex-row items-center justify-between px-4 pt-4 pb-2">
      <Text class={props.dark ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>{props.title}</Text>
      {props.detail ? <Text class={props.dark ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{props.detail}</Text> : null}
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

export function ActionButton(props: ActionButtonProps): JSX.Element {
  return (
    <Focusable
      class={props.class ?? (props.kind === "secondary"
        ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF]"
        : props.kind === "quiet"
          ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#EEF1F6] focus:bg-[#E4E9F2]"
          : props.kind === "danger"
            ? "px-4 h-[44] items-center justify-center rounded-xl bg-[#B4233A] focus:bg-[#962238]"
            : "px-4 h-[44] items-center justify-center rounded-xl bg-[#315DEB] focus:bg-[#2748C5]")}
      style={props.disabled
        ? { ...(props.style ?? {}), opacity: props.style?.opacity ?? 0.5 }
        : { ...(props.style ?? {}), opacity: props.style?.opacity ?? 1 }}
      debugName={props.debugName}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      {props.icon ? (
        <View class="flex-col items-center justify-center gap-1">
          <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-sm text-[#315DEB] font-bold" : "text-sm text-white font-bold"}>{props.icon}</Text>
          <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-xs text-[#17233B] font-bold" : "text-xs text-white font-bold"}>{props.label}</Text>
        </View>
      ) : (
        <Text class={props.kind === "quiet" || props.kind === "secondary" ? "text-sm text-[#315DEB] font-bold" : "text-sm text-white font-bold"}>
          {props.label}
        </Text>
      )}
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
    <View class="flex-col items-center gap-2 p-4 rounded-xl bg-[#F1F3F8] border-[#E5E9F2]">
      <Text class="text-sm text-[#17233B] font-bold">{props.title}</Text>
      <Text class="text-xs text-[#7C8799]">{props.body}</Text>
      {props.action}
    </View>
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
    <View class="flex-row items-center justify-between px-3 py-2 rounded-xl bg-[#17233B] border-[#30405A]">
      <View class="flex-row items-center gap-2">
        <View class={props.ok === false ? "w-2 h-2 rounded-full bg-rose-500" : "w-2 h-2 rounded-full bg-emerald-500"} />
        <Text class="text-xs text-white font-bold">{props.label}</Text>
      </View>
      <Text class="text-xs text-[#B9C5D8]">{props.detail}</Text>
    </View>
  );
}

export type NavigationRoute = "home" | "gallery" | "about";

/**
 * Navigation icons are deliberately composed from host primitives instead of
 * Unicode glyphs. The bundled font is a text font and does not guarantee the
 * miscellaneous-symbol code points used by the old tab bar; on a target with
 * no fallback font those code points rendered as empty boxes. These small
 * geometric marks are therefore stable across Flutter, WeChat and native
 * probe hosts and inherit the selected-tab colour through one explicit style.
 */
function NavigationIcon(props: { kind: "home" | "gallery" | "host"; active: boolean }): JSX.Element {
  const color = () => props.active ? "#315DEB" : "#7C8799";
  if (props.kind === "home") {
    return (
      <View class="relative w-[20] h-[20]">
        <View class="absolute left-[4] top-[8] w-[12] h-[9] rounded-sm" style={{ bgColor: color() }} />
        <View class="absolute left-[5] top-[3] w-[10] h-[10] rounded-sm" style={{ bgColor: color(), rotate: 45 }} />
        <View class="absolute left-[8] top-[10] w-[4] h-[7] rounded-sm bg-white" />
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
  return (
    <View class="flex-col gap-[3] w-[20] h-[20] items-center justify-center">
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
      <View class="w-[14] h-[3] rounded-full" style={{ bgColor: color() }} />
    </View>
  );
}

export function NavigationBar(props: {
  route: string;
  onNavigate: (route: "home" | "gallery" | "about") => void;
  wide?: boolean | (() => boolean);
  geometry?: DisplayGeometry | (() => DisplayGeometry);
}): JSX.Element {
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
      paddingL: padding.left,
      paddingR: padding.right,
      paddingB: padding.bottom,
    };
  };
  const hostRoute = () => props.route !== "home" && props.route !== "gallery";
  const items = [
    { id: "home" as const, label: "Home", kind: "home" as const },
    { id: "gallery" as const, label: "Gallery", kind: "gallery" as const },
    { id: "about" as const, label: "Host", kind: "host" as const },
  ];
  return (
    <View
      style={navStyle()}
      class="flex-row items-center w-full shrink-0 px-2 py-1 bg-white border-[#E5E9F2]"
    >
      <For each={items}>
        {(item) => {
          const active = () => props.route === item.id || (hostRoute() && item.id === "about");
          return (
            <Focusable
              class="flex-1 h-[56] flex-col items-center justify-center gap-1 rounded-xl bg-transparent focus:bg-[#F7F8FC]"
              onPress={() => props.onNavigate(item.id)}
            >
              <View class={active() ? "w-[32] h-[28] flex-col items-center justify-center rounded-xl bg-[#E8EDFF]" : "w-[32] h-[28] flex-col items-center justify-center rounded-xl bg-transparent"}>
                <NavigationIcon kind={item.kind} active={active()} />
              </View>
              <Text class={active() ? "text-xs text-[#315DEB] font-bold" : "text-xs text-[#647084] font-bold"}>{item.label}</Text>
            </Focusable>
          );
        }}
      </For>
    </View>
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
    <View class="flex-row flex-wrap gap-1 px-4 py-2 bg-transparent">
      <For each={props.items}>
        {(item) => (
          <Focusable
            class={props.active === item.id
              ? "w-[68] h-[44] items-center justify-center rounded-xl bg-[#E8EDFF] focus:bg-[#DCE5FF]"
              : "w-[68] h-[44] items-center justify-center rounded-xl bg-transparent focus:bg-[#EEF1F6]"}
            onPress={() => props.onChange(item.id)}
          >
            <Text class={props.active === item.id ? "text-sm text-[#315DEB] font-bold" : "text-sm text-[#7C8799] font-bold"}>{item.label}</Text>
          </Focusable>
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
  textColor: "#17233B",
  placeholderColor: "#7C8799",
  fillColor: "#ffffff",
  borderColor: "#D6DCE7",
  focusedBorderColor: "#315DEB",
  borderRadius: 12,
  fontSize: 14,
  paddingHorizontal: 12,
  paddingVertical: 10,
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
  _emitValue?: (packet: Record<string, unknown>) => boolean;
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
  clipRect: () => TextInputRect | undefined;
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
  if (typeof emitValue === "function") {
    try {
      return emitValue({ type: "event", name: method, payload: params }) === true;
    } catch {
      return false;
    }
  }
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

export function getActiveTextInputSession(): TextInputSession | undefined {
  return activeTextInput;
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
  const parsed = parseTextInputParams(params);
  const eventId = parsed.id;
  if (eventId === undefined || eventId !== session.id || !session.isOpen()) return false;
  if (!session.accepts(params)) return false;
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
  const shellTextStyle = () => ({
    textColor: props.value() ? appearance().textColor : appearance().placeholderColor,
  });

  const visualRect = (): TextInputRect | undefined =>
    activePageScroll?.visualRect(node, lastRect) ?? committedLayout(node) ?? lastRect;

  const visualClip = (): TextInputRect | undefined =>
    activePageScroll?.clipRect();

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
    if (node) activePageScroll?.ensureVisible(node, visualRect());
    // Translations are paint-only in the core layout ABI; use the page
    // scroller's visual rect so Flutter's overlay follows the moved shell.
    const rect = visualRect();
    const clip = visualClip();
    if (!rect) return;
    const text = props.value();
    const wasOpened = opened;
    if (!wasOpened) {
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
    },
  };

  createEffect(() => {
    const text = props.value();
    if (text === lastObservedText) return;
    lastObservedText = text;
    if (opened) sendUpdate(text);
  });

  // Layout can change after Flutter adjusts the viewport for the system
  // keyboard. Observe geometry on work-driven frames while this session owns
  // the overlay; emit only changed rects without keeping the ticker alive.
  onFrame(sendRectUpdate, { continuous: false });

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
      <Text class={appearance().fontSize === 12 ? "text-xs" : appearance().fontSize === 16 ? "text-base" : "text-sm"} style={shellTextStyle()}>
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
  let lastViewportRect: TextInputRect | undefined;

  /**
   * Read the page clip with a retained-layout fallback. During a live Duo
   * resize the core may invalidate the viewport node for one layout pass, but
   * the host's canonical ui.__viewport has already received the new height.
   * Keep the last origin/size in that gap and cap it with the live viewport.
   */
  const measureViewport = (): TextInputRect | undefined => {
    const measured = viewportLayout(viewportNode);
    if (measured) {
      lastViewportRect = measured;
      return measured;
    }
    const fallback = lastViewportRect;
    if (!fallback) return undefined;
    const liveWidth = finiteNumber(textInputGlobal.ui?.__viewport?.w);
    const liveHeight = finiteNumber(textInputGlobal.ui?.__viewport?.h);
    // A live host width describes the whole Duo window, while this retained
    // rect may be the left content pane beside a rail/hinge. Never let the
    // fallback clip expand across that sibling pane during the gap.
    const width = liveWidth !== undefined && liveWidth > 0
      ? Math.max(1, Math.min(fallback.width, liveWidth - fallback.x))
      : fallback.width;
    if (liveHeight === undefined || liveHeight <= fallback.y) {
      return { ...fallback, width };
    }
    return {
      ...fallback,
      width,
      height: Math.max(1, Math.min(fallback.height, liveHeight - fallback.y)),
    };
  };

  const refreshMeasurements = (): {
    rect: TextInputRect | undefined;
    viewportChanged: boolean;
  } => {
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
    if (measuredContent) {
      const nextContentHeight = Math.max(rect?.height ?? viewportHeight(), measuredContent.height);
      if (nextContentHeight !== contentHeight()) setContentHeight(nextContentHeight);
    }
    return { rect, viewportChanged };
  };

  const pageScroll = {
    visualRect: (node: NodeMirror, fallback?: TextInputRect): TextInputRect | undefined => {
      // The fallback is already in painted/visual coordinates: InputField
      // stores the last emitted overlay rect and ensureVisible passes its
      // current visual rect back here. Only a fresh committed layout is raw
      // geometry that still needs the page scroll translation.
      const committed = committedLayout(node);
      if (!committed) return fallback;
      // `getLayout` intentionally reports flex geometry without paint
      // transforms. The canvas is the only translated ancestor of page input
      // shells, so apply the current kinetic offset for overlay coordinates.
      return { ...committed, y: committed.y - scroller.offset() };
    },
    clipRect: (): TextInputRect | undefined => measureViewport(),
    ensureVisible: (node: NodeMirror, fallback?: TextInputRect): void => {
      const viewport = measureViewport();
      if (!viewport) return;
      const input = pageScroll.visualRect(node, fallback);
      if (!input) return;
      const margin = 8;
      const top = viewport.y + margin;
      const bottom = viewport.y + viewport.height - margin;
      const inputBottom = input.y + input.height;
      if (inputBottom > bottom) {
        scroller.scrollBy(inputBottom - bottom, { immediate: true });
        // This correction is initiated by viewport/IME geometry, not by a
        // user's drag. Consume the resulting offset so the next frame does
        // not misclassify the automatic scroll and dismiss the focused input.
        previousOffset = scroller.offset();
      } else if (input.y < top) {
        scroller.scrollBy(input.y - top, { immediate: true });
        previousOffset = scroller.offset();
      }
    },
  };
  activePageScroll = pageScroll;
  onCleanup(() => {
    if (activePageScroll === pageScroll) activePageScroll = undefined;
  });

  const syncViewportResize = (): void => {
    const { rect } = refreshMeasurements();
    if (!rect || activePageScroll !== pageScroll) return;
    const input = activeTextInput;
    const inputNode = input?.isOpen() ? input.node() : undefined;
    if (!input || !inputNode) return;
    // Reuse the normal page ensure-visible calculation, then synchronously
    // publish the moved overlay rect. This runs inside the existing
    // display.viewport bridge before PocketView asks for its delta=0 frame.
    pageScroll.ensureVisible(inputNode, input.visualRect());
    input.refreshLayout();
  };
  createDisplayGeometry({ onChange: syncViewportResize });

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
        const rect = measureViewport();
        return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : undefined;
      },
    },
    panSlop: 1,
    onDown: () => scroller.stop(),
    onPanStart: () => scroller.beginDrag(),
    onPanMove: (contact) => scroller.drag(-contact.fdy),
    onPanEnd: (contact) => scroller.endDrag(-contact.vy),
    onUp: () => {
      if (scroller.state() === "idle") {
        const max = Math.max(0, contentHeight() - viewportHeight());
        const current = scroller.offset();
        if (current < 0 || current > max) {
          scroller.beginDrag();
          scroller.endDrag(0);
        }
      }
    },
    onCancel: () => {
      if (scroller.state() === "idle") scroller.beginDrag();
      scroller.endDrag(0);
    },
  });
  bindDpadScroll(scroller);
  onFrame(() => {
    scroller.step();
    const currentOffset = scroller.offset();
    const scrolled = currentOffset !== previousOffset;
    previousOffset = currentOffset;
    const { rect, viewportChanged } = refreshMeasurements();
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
  }, { continuous: () => scroller.state() !== "idle" });

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
          <View class={props.tone === "dark"
            ? "flex-col gap-1 px-3 py-3 bg-[#17233B] border-[#30405A]"
            : "flex-col gap-1 px-3 py-3 bg-white border-[#E5E9F2]"}>
            <Text class={props.tone === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{item.title}</Text>
            {item.detail ? <Text class={props.tone === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{item.detail}</Text> : null}
          </View>
        )}
      </For>
    </View>
  );
}

export function ViewText(props: { title: string; body: string }): JSX.Element {
  return <View class="flex-col gap-1"><Text class="text-sm text-[#17233B] font-bold">{props.title}</Text><Text class="text-xs text-[#7C8799]">{props.body}</Text></View>;
}

export function Card(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <View class={props.class ?? "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"}>{props.children}</View>;
}

export function Row(props: { children?: JSX.Element; class?: string }): JSX.Element {
  return <View class={props.class ?? "flex-row items-center gap-3"}>{props.children}</View>;
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

