/**
 * @pocket/looseleaf — Buttons, Inputs, Switches, Checkboxes, Sliders, Steppers,
 * Selects, Comboboxes, Forms, Signature Pads & Sketchpads.
 *
 * Strictly aligns with `kevintngo/looseleaf/src/styles/looseleaf.css`:
 * `--primary: var(--ll-marker)` (`#DF6B3C`) and `--primary-foreground: var(--ll-ink)` (`#2A2420`),
 * crisp `radius: 4` corners, `1.5px` `#2A2420` felt-tip borders, and hard offset ink shadows.
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { Focusable, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { InputField, useAnimatedNumber } from "@pocket/ui";
import {
  accentColorOf,
  densityHitHeight,
  seedTilt,
  useLooseleafTheme,
  type LooseleafAccent,
} from "./tokens.ts";
import { Icon, Signature, Stamp, type LooseleafIconName } from "./marks.tsx";
import { Paper } from "./surfaces.tsx";

export type ButtonVariant =
  | "default"
  | "primary"
  | "secondary"
  | "outline"
  | "destructive"
  | "ghost"
  | "link"
  | "blue";

export type ButtonSize = "xs" | "sm" | "default" | "lg" | "icon";

export interface ButtonProps {
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LooseleafIconName;
  trailingIcon?: LooseleafIconName;
  disabled?: boolean;
  selected?: boolean;
  pill?: boolean;
  seed?: string | number;
  style?: ViewProps["style"];
  onPress?: () => void;
  children?: JSX.Element;
}

/**
 * Hand-drawn `<Button>` with crisp offset ink shadow and press sink.
 * Matches `og.png`: `primary`/`default` uses `#DF6B3C` marker fill + dark `#2A2420` ink text!
 */
export function Button(props: ButtonProps): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const variant = () => props.variant ?? "default";
  const size = () => props.size ?? "default";
  const height = () => {
    const base = densityHitHeight(density());
    if (size() === "xs") return Math.max(24, base - 10);
    if (size() === "sm") return Math.max(30, base - 6);
    if (size() === "lg") return base + 6;
    return base;
  };
  const bg = () => {
    const p = palette();
    if (props.selected) return p.hi;
    switch (variant()) {
      case "destructive":
        return p.red;
      case "secondary":
        return p.hi;
      case "outline":
        return p.slip;
      case "blue":
        return p.inkYou;
      case "ghost":
      case "link":
        return "#00000000";
      case "primary":
      case "default":
      default:
        return p.marker;
    }
  };
  const fg = () => {
    const p = palette();
    const darkInkOnFill = p.mode === "amber-night" ? "#1C1000" : "#2A2420";
    if (props.selected) return darkInkOnFill;
    switch (variant()) {
      case "destructive":
      case "blue":
        return p.mode === "amber-night" ? "#1C1000" : "#FFFDF6";
      case "secondary":
      case "primary":
      case "default":
        return darkInkOnFill;
      case "link":
        return p.inkYou;
      case "outline":
      case "ghost":
      default:
        return p.ink;
    }
  };
  const showShadow = () =>
    variant() !== "ghost" && variant() !== "link" && !props.disabled && density() !== "calm";
  const rad = () => (props.pill ? 999 : 4);
  const tilt = () => seedTilt(props.seed ?? props.label ?? "btn", 0.45, density());

  return (
    <Focusable
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
      class={
        size() === "icon"
          ? "relative items-center justify-center shrink-0 active:translate-y-[1px] transition-transform duration-100 ease-out"
          : size() === "xs"
            ? "relative px-2.5 items-center justify-center shrink-0 active:translate-y-[1px] transition-transform duration-100 ease-out"
            : size() === "sm"
              ? "relative px-3 items-center justify-center shrink-0 active:translate-y-[1px] transition-transform duration-100 ease-out"
              : size() === "lg"
                ? "relative px-5 items-center justify-center shrink-0 active:translate-y-[1px] transition-transform duration-100 ease-out"
                : "relative px-4 items-center justify-center shrink-0 active:translate-y-[1px] transition-transform duration-100 ease-out"
      }
      style={{
        height: height(),
        ...(size() === "icon" ? { width: height() } : {}),
        opacity: props.disabled ? 0.48 : 1,
        rotate: tilt(),
        ...(props.style ?? {}),
      }}
    >
      <Show when={showShadow()}>
        <View
          class="absolute inset-0"
          style={{
            insetL: 2,
            insetT: 2,
            insetR: -2,
            insetB: -2,
            bgColor: palette().ink,
            radius: rad(),
            hitPass: 1,
          }}
        />
      </Show>
      <View
        class="absolute inset-0"
        style={{
          bgColor: bg(),
          borderColor:
            variant() === "ghost" || variant() === "link" ? "#00000000" : palette().ink,
          borderWidth: variant() === "ghost" || variant() === "link" ? 0 : 1.5,
          radius: rad(),
          hitPass: 1,
        }}
      />
      <View class="relative flex-row items-center justify-center gap-1.5">
        {props.icon ? (
          <Icon
            name={props.icon}
            size="xs"
            tone={variant() === "link" ? "blue" : "ink"}
          />
        ) : null}
        {props.label !== undefined ? (
          <Text
            class={size() === "xs" ? "text-xs font-bold" : size() === "lg" ? "text-base font-bold" : "text-sm font-bold"}
            style={{ textColor: fg() }}
          >
            {props.label}
          </Text>
        ) : (
          props.children
        )}
        {props.trailingIcon ? <Icon name={props.trailingIcon} size="xs" /> : null}
      </View>
    </Focusable>
  );
}

/** Joined hand-inked `<ButtonGroup>` (`og.png` `[ Day | Week | Month ]` bar). */
export function ButtonGroup(props: {
  items: readonly { id: string; label: string }[];
  value: string;
  onChange?: (id: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="flex-row items-center overflow-hidden"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <For each={props.items}>
        {(item, idx) => {
          const active = () => props.value === item.id;
          return (
            <View class="flex-row items-center">
              <Focusable
                class="px-3 h-[30] items-center justify-center"
                style={{ bgColor: active() ? palette().hi : "#00000000" }}
                onPress={() => props.onChange?.(item.id)}
              >
                <Text
                  class="text-xs font-bold"
                  style={{
                    textColor: active()
                      ? (palette().mode === "amber-night" ? "#1C1000" : "#2A2420")
                      : palette().ink,
                  }}
                >
                  {item.label}
                </Text>
              </Focusable>
              <Show when={idx() < props.items.length - 1}>
                <View class="w-[1] h-[30]" style={{ bgColor: palette().ink }} />
              </Show>
            </View>
          );
        }}
      </For>
    </View>
  );
}

/** Tactile rubber `<StampButton>` that leaves a visible stamped mark when pressed. */
export function StampButton(props: {
  label: string;
  stampedLabel?: string;
  stamped?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const [localStamped, setLocalStamped] = createSignal(false);
  const active = () => (props.stamped !== undefined ? props.stamped : localStamped());
  return (
    <View class="flex-row items-center gap-2.5">
      <Button
        label={props.label}
        variant={active() ? "outline" : "primary"}
        icon="sparkle"
        onPress={() => {
          setLocalStamped((v) => !v);
          props.onPress?.();
        }}
      />
      <Show when={active()}>
        <Stamp label={props.stampedLabel ?? "STAMPED"} tone="red" rotate={-5} />
      </Show>
    </View>
  );
}

/** Form `<Label>` with optional red-pencil required asterisk. */
export function Label(props: {
  text: string;
  required?: boolean;
  hint?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-row items-center justify-between w-full">
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {props.text}
        </Text>
        <Show when={props.required === true}>
          <Text class="text-xs font-bold" style={{ textColor: palette().red }}>
            *
          </Text>
        </Show>
      </View>
      <Show when={Boolean(props.hint)}>
        <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
          {props.hint}
        </Text>
      </Show>
    </View>
  );
}

/** Manila `<LabelTag>` lug tag with punched reinforcement ring. */
export function LabelTag(props: {
  label: string;
  accent?: LooseleafAccent;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const ring = () => accentColorOf(palette(), props.accent ?? "marker");
  return (
    <View
      class="px-2.5 py-1 flex-row items-center gap-1.5"
      style={{
        bgColor: palette().kraft,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 3,
        rotate: -1,
      }}
    >
      <View
        class="w-[7] h-[7]"
        style={{ bgColor: palette().desk, borderColor: ring(), borderWidth: 2, radius: 4 }}
      />
      <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
        {props.label}
      </Text>
    </View>
  );
}

/**
 * Paper-slip `<Input>` backed by `@pocket/ui`'s native `InputField` so mobile
 * and desktop keyboards edit blue-felt ink (`--ll-ink-you`) directly.
 */
export function Input(props: {
  value: string | (() => string);
  placeholder?: string;
  onInput?: (value: string) => void;
  onSubmit?: (value: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const accessor = () => (typeof props.value === "function" ? props.value() : props.value);
  return (
    <InputField
      value={accessor}
      placeholder={props.placeholder}
      onInput={(val) => props.onInput?.(val)}
      onSubmit={(val) => props.onSubmit?.(val)}
      appearance={{
        fillColor: palette().slip,
        textColor: palette().inkYou,
        placeholderColor: palette().pencilText,
        borderColor: palette().ink,
        focusedBorderColor: palette().focus,
        borderRadius: 4,
      }}
    />
  );
}

/** Prefix/suffix `<InputGroup>` slip. */
export function InputGroup(props: {
  prefix?: string;
  value: string;
  suffix?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="flex-row items-center h-[36] w-full overflow-hidden"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <Show when={Boolean(props.prefix)}>
        <View
          class="h-[36] px-2.5 items-center justify-center"
          style={{ bgColor: palette().paperShade }}
        >
          <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
            {props.prefix}
          </Text>
        </View>
      </Show>
      <View class="px-3 flex-1 justify-center">
        <Text class="text-sm font-bold" style={{ textColor: palette().inkYou }}>
          {props.value}
        </Text>
      </View>
      <Show when={Boolean(props.suffix)}>
        <View
          class="h-[36] px-2.5 items-center justify-center"
          style={{ bgColor: palette().paperShade }}
        >
          <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
            {props.suffix}
          </Text>
        </View>
      </Show>
    </View>
  );
}

/** 6-slot hand-boxed `<InputOTP>` verification row. */
export function InputOTP(props: {
  value: string;
  length?: number;
  activeSlot?: number;
  onSelectSlot?: (slot: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const total = () => props.length ?? 6;
  const slots = createMemo(() =>
    Array.from({ length: total() }, (_, index) => ({
      index,
      char: props.value[index] ?? "·",
    })),
  );
  return (
    <View class="flex-row items-center gap-1.5 flex-wrap">
      <For each={slots()}>
        {(slot) => {
          const focused = () => (props.activeSlot ?? 0) === slot.index;
          return (
            <Focusable
              onPress={() => props.onSelectSlot?.(slot.index)}
              class="w-[36] h-[40] items-center justify-center"
              style={{
                bgColor: focused() ? palette().hi : palette().slip,
                borderColor: focused() ? palette().inkYou : palette().ink,
                borderWidth: focused() ? 2 : 1.5,
                radius: 4,
              }}
            >
              <Text
                class="text-base font-mono font-bold"
                style={{ textColor: focused() ? "#2A2420" : palette().inkYou }}
              >
                {slot.char}
              </Text>
            </Focusable>
          );
        }}
      </For>
    </View>
  );
}

/** Ruled notepad `<Textarea>` surface. */
export function Textarea(props: {
  value: string;
  placeholder?: string;
  rows?: number;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const minH = () => Math.max(64, (props.rows ?? 3) * 22);
  return (
    <Paper stock="slip" rules="ruled" tilt={false} shadow="sheet">
      <View class="w-full justify-between" style={{ minH: minH() }}>
        <Text
          class="text-sm"
          style={{ textColor: props.value ? palette().inkYou : palette().pencilText }}
        >
          {props.value || props.placeholder || "Write a note..."}
        </Text>
      </View>
    </Paper>
  );
}

/** Multi-action notebook `<PromptInput>` composer with quick tag chips and send button. */
export function PromptInput(props: {
  value: string;
  placeholder?: string;
  tags?: readonly string[];
  onSubmit?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="card" shadow="hard" tilt={false}>
      <Text
        class="text-sm"
        style={{ textColor: props.value ? palette().inkYou : palette().pencilText }}
      >
        {props.value || props.placeholder || "Ask Stubby or jot down a prompt..."}
      </Text>
      <View class="flex-row items-center justify-between flex-wrap gap-2 pt-1">
        <View class="flex-row items-center gap-1.5 flex-wrap">
          <For each={props.tags ?? ["§ Paper", "✎ Sketch"]}>
            {(tag) => (
              <View
                class="px-2 py-0.5"
                style={{
                  bgColor: palette().paperShade,
                  borderColor: palette().pencilMark,
                  borderWidth: 1,
                  radius: 3,
                }}
              >
                <Text class="text-xs font-mono" style={{ textColor: palette().inkSoft }}>
                  {tag}
                </Text>
              </View>
            )}
          </For>
        </View>
        <Button label="Send" size="sm" trailingIcon="arrow-right" onPress={props.onSubmit} />
      </View>
    </Paper>
  );
}

/** Hand-inked `<Checkbox>` with crisp square border (`radius: 3`) and optional strike-through label. */
export function Checkbox(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  strikeWhenChecked?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const scale = useAnimatedNumber(() => (props.checked ? 1 : 0.9), 0.35, 140);
  return (
    <Focusable
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : () => props.onChange?.(!props.checked)}
      class="flex-row items-center gap-2.5 py-1"
      style={{ opacity: props.disabled ? 0.5 : 1 }}
    >
      <View
        class="w-[18] h-[18] items-center justify-center shrink-0"
        style={{
          bgColor: props.checked ? palette().hi : palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 3,
          scale: scale(),
        }}
      >
        <Show when={props.checked}>
          <Text
            class="text-xs font-bold"
            style={{
              textColor: palette().mode === "amber-night" ? "#1C1000" : "#2A2420",
              rotate: -3,
            }}
          >
            ✓
          </Text>
        </Show>
      </View>
      <Show when={Boolean(props.label)}>
        <View class="relative flex-row items-center">
          <Text
            class="text-sm"
            style={{
              textColor:
                props.checked && props.strikeWhenChecked
                  ? palette().pencilText
                  : palette().ink,
            }}
          >
            {props.label}
          </Text>
          <Show when={props.checked && props.strikeWhenChecked === true}>
            <View
              class="absolute left-0 right-0 top-[9] h-[2]"
              style={{ bgColor: palette().red, radius: 1, hitPass: 1 }}
            />
          </Show>
        </View>
      </Show>
    </Focusable>
  );
}

/**
 * Hand-drawn `<Switch>` pill toggle (`og.png`: terracotta marker active track +
 * `#2A2420` ink-bordered `#FFFDF6` circle thumb).
 */
export function Switch(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  detail?: string;
  accent?: "marker" | "blue" | "green";
  disabled?: boolean;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const thumbX = useAnimatedNumber(() => (props.checked ? 18 : 0), 0.3, 160);
  const trackFill = () => {
    if (!props.checked) return palette().paperShade;
    if (props.accent === "blue") return palette().inkYou;
    if (props.accent === "green") return palette().green;
    return palette().marker;
  };
  return (
    <Focusable
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : () => props.onChange?.(!props.checked)}
      class="flex-row items-center justify-between gap-2.5 py-0.5"
      style={{ opacity: props.disabled ? 0.5 : 1 }}
    >
      <Show when={Boolean(props.label || props.detail)}>
        <View class="flex-col gap-0.5">
          <Show when={Boolean(props.label)}>
            <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
              {props.label}
            </Text>
          </Show>
          <Show when={Boolean(props.detail)}>
            <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
              {props.detail}
            </Text>
          </Show>
        </View>
      </Show>
      <View
        class="w-[42] h-[24] p-[2] flex-row items-center shrink-0"
        style={{
          bgColor: trackFill(),
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 999,
        }}
      >
        <View
          class="w-[18] h-[18]"
          style={{
            bgColor: palette().mode === "amber-night" ? "#FFB800" : "#FFFDF6",
            borderColor: palette().mode === "amber-night" ? "#1C1000" : "#2A2420",
            borderWidth: 1.5,
            radius: 9,
            translateX: thumbX(),
          }}
        />
      </View>
    </Focusable>
  );
}

/** Hand-drawn circle `<RadioGroup>`. */
export function RadioGroup(props: {
  options: readonly { id: string; label: string; detail?: string }[];
  value: string;
  onChange?: (id: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-2 w-full">
      <For each={props.options}>
        {(opt) => {
          const active = () => props.value === opt.id;
          return (
            <Focusable
              onPress={() => props.onChange?.(opt.id)}
              class="flex-row items-center gap-2.5 py-1"
            >
              <View
                class="w-[20] h-[20] items-center justify-center shrink-0"
                style={{
                  bgColor: palette().slip,
                  borderColor: active() ? palette().inkYou : palette().ink,
                  borderWidth: 1.5,
                  radius: 10,
                }}
              >
                <Show when={active()}>
                  <View
                    class="w-[10] h-[10]"
                    style={{ bgColor: palette().marker, radius: 5 }}
                  />
                </Show>
              </View>
              <View class="flex-col gap-0.5 flex-1">
                <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
                  {opt.label}
                </Text>
                <Show when={Boolean(opt.detail)}>
                  <Text class="text-xs" style={{ textColor: palette().pencilText }}>
                    {opt.detail}
                  </Text>
                </Show>
              </View>
            </Focusable>
          );
        }}
      </For>
    </View>
  );
}

/**
 * Interactive pencil-rule `<Slider>` with terracotta marker fill and blue-felt
 * value readout (mirrors Looseleaf `og.png` slider track + circle thumb).
 */
export function Slider(props: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  onChange?: (next: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const min = () => props.min ?? 0;
  const max = () => Math.max(min() + 1, props.max ?? 100);
  const step = () => props.step ?? 10;
  const ratio = () => Math.max(0, Math.min(1, (props.value - min()) / (max() - min())));
  const animRatio = useAnimatedNumber(ratio, 0.3, 140);
  const bump = (delta: number) => {
    const next = Math.max(min(), Math.min(max(), props.value + delta));
    props.onChange?.(next);
  };
  return (
    <View class="flex-row items-center gap-2 w-full">
      <Show when={Boolean(props.label)}>
        <Text class="text-xs font-bold shrink-0" style={{ textColor: palette().ink }}>
          {props.label}
        </Text>
      </Show>
      <Focusable
        class="w-[24] h-[24] items-center justify-center shrink-0"
        style={{
          bgColor: palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 4,
        }}
        onPress={() => bump(-step())}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          −
        </Text>
      </Focusable>
      <Focusable
        class="relative flex-1 h-[8] overflow-hidden"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 4,
        }}
        onPress={() => {
          const next = props.value + step() > max() ? min() : props.value + step();
          props.onChange?.(next);
        }}
      >
        <View
          class="h-[8]"
          style={{
            width: -1,
            bgColor: palette().marker,
            scaleX: Math.max(0.03, animRatio()),
            originX: -0.5,
          }}
        />
      </Focusable>
      <Focusable
        class="w-[24] h-[24] items-center justify-center shrink-0"
        style={{
          bgColor: palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 4,
        }}
        onPress={() => bump(step())}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          +
        </Text>
      </Focusable>
      <Text class="text-sm font-mono font-bold shrink-0" style={{ textColor: palette().inkYou }}>
        {String(props.value)}
      </Text>
    </View>
  );
}

/** Numeric `<Stepper>` control with paper `-` / `+` buttons. */
export function Stepper(props: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange?: (next: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 999;
  const step = () => props.step ?? 1;
  return (
    <View class="flex-row items-center gap-1.5">
      <Button
        label="−"
        variant="outline"
        size="xs"
        onPress={() => props.onChange?.(Math.max(min(), props.value - step()))}
      />
      <View
        class="px-2.5 h-[30] items-center justify-center"
        style={{
          bgColor: palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 4,
        }}
      >
        <Text class="text-xs font-mono font-bold" style={{ textColor: palette().inkYou }}>
          {props.unit ? `${String(props.value)} ${props.unit}` : String(props.value)}
        </Text>
      </View>
      <Button
        label="+"
        variant="outline"
        size="xs"
        onPress={() => props.onChange?.(Math.min(max(), props.value + step()))}
      />
    </View>
  );
}

/** 5-star hand-drawn `<Rating>` picker. */
export function Rating(props: {
  value: number;
  max?: number;
  onChange?: (value: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const stars = () => Array.from({ length: props.max ?? 5 }, (_, i) => i + 1);
  return (
    <View class="flex-row items-center gap-1">
      <For each={stars()}>
        {(n) => {
          const filled = () => n <= props.value;
          return (
            <Focusable
              onPress={() => props.onChange?.(n)}
              class="w-[28] h-[28] items-center justify-center"
            >
              <Text
                class="text-lg font-bold"
                style={{ textColor: filled() ? palette().tangerine : palette().pencilMark }}
              >
                {filled() ? "★" : "☆"}
              </Text>
            </Focusable>
          );
        }}
      </For>
    </View>
  );
}

/** Highlighter-swiped `<Toggle>` chip. */
export function Toggle(props: {
  pressed: boolean;
  label: string;
  onChange?: (pressed: boolean) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Focusable
      onPress={() => props.onChange?.(!props.pressed)}
      class="px-2.5 h-[30] items-center justify-center flex-row"
      style={{
        bgColor: props.pressed ? palette().hi : palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <Text
        class="text-xs font-bold"
        style={{ textColor: props.pressed ? "#2A2420" : palette().ink }}
      >
        {props.label}
      </Text>
    </Focusable>
  );
}

/** Multi-select or single-select `<ToggleGroup>`. */
export function ToggleGroup(props: {
  options: readonly { id: string; label: string }[];
  selected: readonly string[];
  onToggle?: (id: string) => void;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap items-center gap-1.5">
      <For each={props.options}>
        {(item) => (
          <Toggle
            label={item.label}
            pressed={props.selected.includes(item.id)}
            onChange={() => props.onToggle?.(item.id)}
          />
        )}
      </For>
    </View>
  );
}

/** Paper slip dropdown `<Select>` (and `<NativeSelect>` alias). */
export function Select(props: {
  label?: string;
  value: string;
  options: readonly string[];
  onChange?: (value: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [open, setOpen] = createSignal(false);
  return (
    <View class="flex-col gap-1.5 w-full">
      <Show when={Boolean(props.label)}>
        <Label text={props.label!} />
      </Show>
      <Focusable
        onPress={() => setOpen((o) => !o)}
        class="flex-row items-center justify-between px-3 h-[36] w-full"
        style={{
          bgColor: palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 4,
        }}
      >
        <Text class="text-sm font-bold" style={{ textColor: palette().inkYou }}>
          {props.value}
        </Text>
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {open() ? "▴" : "▾"}
        </Text>
      </Focusable>
      <Show when={open()}>
        <View
          class="flex-col gap-0.5 p-1.5 w-full"
          style={{
            bgColor: palette().slip,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 4,
          }}
        >
          <For each={props.options}>
            {(opt) => {
              const selected = () => props.value === opt;
              return (
                <Focusable
                  onPress={() => {
                    props.onChange?.(opt);
                    setOpen(false);
                  }}
                  class="flex-row items-center justify-between px-2.5 py-1.5 w-full"
                  style={{
                    bgColor: selected() ? palette().hi : "#00000000",
                    radius: 3,
                  }}
                >
                  <Text
                    class="text-xs font-bold"
                    style={{ textColor: selected() ? "#2A2420" : palette().ink }}
                  >
                    {opt}
                  </Text>
                  <Text
                    class="text-xs font-bold"
                    style={{ textColor: selected() ? palette().inkYou : "#00000000" }}
                  >
                    ✓
                  </Text>
                </Focusable>
              );
            }}
          </For>
        </View>
      </Show>
    </View>
  );
}

export const NativeSelect = Select;

/** Searchable `<Combobox>` slip with quick filter pills. */
export function Combobox(props: {
  label?: string;
  options: readonly string[];
  value: string;
  onChange?: (value: string) => void;
}): JSX.Element {
  return <Select label={props.label} options={props.options} value={props.value} onChange={props.onChange} />;
}

/** Form `<Field>` wrapper with label, description, and red-pencil validation message. */
export function Field(props: {
  label: string;
  required?: boolean;
  description?: string;
  error?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-1.5 w-full">
      <Label text={props.label} required={props.required} />
      {props.children}
      <Show when={Boolean(props.error)} fallback={
        <Show when={Boolean(props.description)}>
          <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
            {props.description}
          </Text>
        </Show>
      }>
        <Text class="text-xs font-bold" style={{ textColor: palette().red }}>
          {`✎ ${props.error}`}
        </Text>
      </Show>
    </View>
  );
}

/** Semantic `<Form>` stack wrapper. */
export function Form(props: { children?: JSX.Element }): JSX.Element {
  return <View class="flex-col gap-3 w-full">{props.children}</View>;
}

/** Dashed-border paper `<Dropzone>` for file/photo attachments. */
export function Dropzone(props: {
  title?: string;
  hint?: string;
  onPick?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="slip" fastener="clip" shadow="sheet" onPress={props.onPick}>
      <View class="flex-col items-center justify-center gap-1 py-3 w-full">
        <Icon name="paperclip" size="lg" tone="blue" />
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {props.title ?? "Drop photos or tap to attach"}
        </Text>
        <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
          {props.hint ?? "PNG · JPG · PDF up to 10 MB"}
        </Text>
      </View>
    </Paper>
  );
}

/** Interactive `<SignaturePad>` with sign/clear toggle. */
export function SignaturePad(props: {
  signerName?: string;
  signed?: boolean;
  onChange?: (signed: boolean) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [localSigned, setLocalSigned] = createSignal(props.signed ?? true);
  const isSigned = () => (props.signed !== undefined ? props.signed : localSigned());
  return (
    <Paper stock="slip" shadow="sheet" tilt={false}>
      <Show
        when={isSigned()}
        fallback={
          <View class="h-[44] items-center justify-center w-full">
            <Text class="text-xs" style={{ textColor: palette().pencilText }}>
              Tap “Sign” to add handwritten signature
            </Text>
          </View>
        }
      >
        <Signature name={props.signerName ?? "Ada Lovelace"} date="2026-11-11" />
      </Show>
      <View class="flex-row items-center justify-end gap-2">
        <Button
          label={isSigned() ? "Clear" : "Sign"}
          variant="outline"
          size="xs"
          onPress={() => {
            const next = !isSigned();
            setLocalSigned(next);
            props.onChange?.(next);
          }}
        />
      </View>
    </Paper>
  );
}

/** Interactive graph-paper `<Sketchpad>` with pen color swatches and tap-to-draw strokes. */
export function Sketchpad(props: {
  title?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [pen, setPen] = createSignal<"ink" | "marker" | "blue" | "green">("marker");
  const [strokes, setStrokes] = createSignal<number>(3);
  const penHex = () => {
    const p = palette();
    if (pen() === "ink") return p.ink;
    if (pen() === "blue") return p.inkYou;
    if (pen() === "green") return p.green;
    return p.marker;
  };
  return (
    <Paper stock="graph" rules="graph" shadow="hard" tilt={false}>
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
          {props.title ?? "SKETCHPAD · GRAPH STOCK"}
        </Text>
        <View class="flex-row items-center gap-1.5">
          <For each={["ink", "marker", "blue", "green"] as const}>
            {(tone) => (
              <Focusable
                onPress={() => setPen(tone)}
                class="w-[18] h-[18]"
                style={{
                  bgColor:
                    tone === "ink"
                      ? palette().ink
                      : tone === "blue"
                        ? palette().inkYou
                        : tone === "green"
                          ? palette().green
                          : palette().marker,
                  borderColor: pen() === tone ? palette().hi : palette().ink,
                  borderWidth: pen() === tone ? 2.5 : 1,
                  radius: 9,
                }}
              />
            )}
          </For>
        </View>
      </View>
      <Focusable
        onPress={() => setStrokes((n) => (n >= 6 ? 1 : n + 1))}
        class="w-full h-[72] items-center justify-center flex-col gap-2"
      >
        <For each={Array.from({ length: strokes() }, (_, i) => i)}>
          {(idx) => (
            <View
              class="h-[3]"
              style={{
                width: 90 + idx * 28,
                bgColor: penHex(),
                radius: 2,
                rotate: idx % 2 === 0 ? -3.5 : 2.8,
              }}
            />
          )}
        </For>
      </Focusable>
    </Paper>
  );
}
