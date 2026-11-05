/**
 * Small Flutter vocabulary adapters for the public Pocket UI package.
 *
 * Provenance:
 * - `mini_apps/syslib/pocket_syslib_flutter_ui.js` supplied the original
 *   `Divider`, `FloatingActionButton`, `NavigationBar` and Material naming.
 * - These adapters are composed from the pinned official Pocket `View`, `Text`
 *   and `Focusable` primitives. They do not create a second VDOM or layout
 *   engine; applications still own composition and state in JS.
 */

import { Focusable, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { Show, type JSX } from "solid-js";

export function FlutterDivider(props: {
  height?: number;
  color?: number | string;
} = {}): JSX.Element {
  const height = () => props.height ?? 1;
  const color = () => props.color;
  return <View class="w-full bg-[#E4E4E7]" style={{ height: height(), bgColor: color() ?? "#E4E4E7" }} />;
}

export function FlutterLinearProgressIndicator(props: {
  /** A determinate value in [0, 1]. Indeterminate animation is not faked. */
  value: number;
  color?: number | string;
  backgroundColor?: number | string;
}): JSX.Element {
  const value = () => Math.max(0, Math.min(1, Number.isFinite(props.value) ? props.value : 0));
  const color = () => props.color;
  const backgroundColor = () => props.backgroundColor;
  return (
    <View
      class="w-full h-2 rounded-lg bg-[#F4F4F5]"
      style={{ bgColor: backgroundColor() ?? "#F4F4F5" }}
    >
      <View
        class="h-2 rounded-lg bg-[#18181B]"
        style={{
          width: -1,
          scaleX: value(),
          // The renderer scales around the node center by default. A left
          // origin keeps a determinate progress bar growing from its start
          // edge instead of shrinking toward the middle.
          originX: -0.5,
          bgColor: color() ?? "#18181B",
        }}
      />
    </View>
  );
}

export function FlutterChip(props: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  leading?: JSX.Element;
}): JSX.Element {
  const selected = () => props.selected === true;
  const hasPress = () => typeof props.onPress === "function";
  // Keep one native callback identity while reading the latest prop. This is
  // important when a parent swaps handlers without replacing the node.
  const onPress = () => props.onPress?.();
  const body = (
    <View class={selected() ? "flex-row items-center gap-1 px-3 h-[36] rounded-md bg-[#18181B]" : "flex-row items-center gap-1 px-3 h-[36] rounded-md bg-[#F4F4F5] border-[#E4E4E7]"}>
      {props.leading}
      <Text class={selected() ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B]"}>{props.label}</Text>
    </View>
  );
  return <Show when={hasPress()} fallback={body}><Focusable onPress={onPress}>{body}</Focusable></Show>;
}

export function FlutterIconButton(props: {
  icon: string;
  tooltip?: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: ViewProps["style"];
}): JSX.Element {
  const disabled = () => props.disabled === true;
  const onPress = () => disabled() ? undefined : props.onPress?.();
  return (
    <Focusable
      class={disabled() ? "flex-col items-center justify-center w-[40] h-[40] rounded-md bg-[#F4F4F5] opacity-50" : "flex-col items-center justify-center w-[40] h-[40] rounded-md bg-[#F4F4F5] border-[#E4E4E7] focus:bg-[#E4E4E7]"}
      focusable={!disabled()}
      debugName={props.tooltip}
      onPress={onPress}
      style={props.style}
    >
      <Text class="text-sm text-[#09090B] font-bold">{props.icon}</Text>
    </Focusable>
  );
}

export function FlutterFloatingActionButton(props: {
  icon?: string;
  label?: string;
  tooltip?: string;
  onPress?: () => void;
  disabled?: boolean;
}): JSX.Element {
  const disabled = () => props.disabled === true;
  const extended = () => props.label !== undefined;
  const className = () => disabled()
    ? extended()
      ? "flex-row items-center justify-center gap-2 px-4 h-[40] rounded-lg bg-[#F4F4F5] opacity-50"
      : "flex-col items-center justify-center w-[40] h-[40] rounded-lg bg-[#F4F4F5] opacity-50"
    : extended()
      ? "flex-row items-center justify-center gap-2 px-4 h-[40] rounded-lg bg-[#18181B] focus:bg-[#27272A]"
      : "flex-col items-center justify-center w-[40] h-[40] rounded-lg bg-[#18181B] focus:bg-[#27272A]";
  const onPress = () => disabled() ? undefined : props.onPress?.();
  return (
    <Focusable
      class={className()}
      focusable={!disabled()}
      debugName={props.tooltip}
      onPress={onPress}
    >
      <Show when={props.icon}><Text class={disabled() ? "text-sm text-[#71717A] font-bold" : "text-sm text-[#FAFAFA] font-bold"}>{props.icon}</Text></Show>
      <Show when={props.label}><Text class={disabled() ? "text-xs text-[#71717A] font-bold" : "text-xs text-[#FAFAFA] font-bold"}>{props.label}</Text></Show>
    </Focusable>
  );
}

export function FlutterNavigationDestination(props: {
  icon: string;
  label: string;
  selected?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const selected = () => props.selected === true;
  const hasPress = () => typeof props.onPress === "function";
  const onPress = () => props.onPress?.();
  const body = (
    <View class={selected() ? "flex-col items-center justify-center gap-1 px-3 h-[44] rounded-md bg-[#F4F4F5]" : "flex-col items-center justify-center gap-1 px-3 h-[44] rounded-md bg-transparent"}>
      <Text class={selected() ? "text-sm text-[#09090B] font-bold" : "text-sm text-[#71717A]"}>{props.icon}</Text>
      <Text class={selected() ? "text-xs text-[#09090B] font-bold" : "text-xs text-[#71717A]"}>{props.label}</Text>
    </View>
  );
  return <Show when={hasPress()} fallback={body}><Focusable onPress={onPress}>{body}</Focusable></Show>;
}

// Flutter-shaped aliases keep migration mechanical without adding parallel
// implementations.
export const Divider = FlutterDivider;
export const LinearProgressIndicator = FlutterLinearProgressIndicator;
export const Chip = FlutterChip;
export const IconButton = FlutterIconButton;
export const FloatingActionButton = FlutterFloatingActionButton;
export const NavigationDestination = FlutterNavigationDestination;
