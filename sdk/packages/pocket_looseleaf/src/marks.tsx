/**
 * @pocket/looseleaf — Hand-Drawn Pens, Marks, Annotations, Tally, Stamps,
 * Seals, Stickers, Doodle Icons & Stubby Mascot.
 *
 * Every mark is rendered with native PocketJS geometric primitives (`View`
 * ribbons, rotations, stroke arcs, and offset fills) so zero external PNG/SVG
 * pak textures are required while remaining razor-sharp at every density.
 */

import { For, Show, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import {
  accentColorOf,
  penColor,
  seedOffset,
  seedTilt,
  useLooseleafTheme,
  type LooseleafAccent,
  type LooseleafPenTone,
} from "./tokens.ts";

export type LooseleafIconName =
  | "arrow-right"
  | "arrow-left"
  | "arrow-up"
  | "arrow-down"
  | "check"
  | "x"
  | "plus"
  | "minus"
  | "star"
  | "heart"
  | "sparkle"
  | "sparkles"
  | "search"
  | "calendar"
  | "clock"
  | "bell"
  | "baby"
  | "bottle"
  | "moon"
  | "sun"
  | "shield"
  | "settings"
  | "pencil"
  | "paperclip"
  | "pin"
  | "trash"
  | "edit"
  | "user"
  | "users"
  | "chart"
  | "folder"
  | "info"
  | "alert";

const ICON_GLYPHS: Record<LooseleafIconName, string> = {
  "arrow-right": "→",
  "arrow-left": "←",
  "arrow-up": "↑",
  "arrow-down": "↓",
  check: "✓",
  x: "✕",
  plus: "+",
  minus: "−",
  star: "★",
  heart: "♥",
  sparkle: "✦",
  sparkles: "✧",
  search: "⌕",
  calendar: "▦",
  clock: "⊙",
  bell: "♪",
  baby: "☺",
  bottle: "◈",
  moon: "☾",
  sun: "☀",
  shield: "❖",
  settings: "≡",
  pencil: "✎",
  paperclip: "§",
  pin: "◆",
  trash: "⌫",
  edit: "✎",
  user: "◯",
  users: "◎",
  chart: "▤",
  folder: "▣",
  info: "i",
  alert: "!",
};

export function Icon(props: {
  name: LooseleafIconName;
  tone?: LooseleafPenTone;
  size?: "xs" | "sm" | "md" | "lg";
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "ink");
  const tilt = () => seedTilt(props.seed ?? props.name, 2.2, density());
  const sizeClass = () =>
    props.size === "xs"
      ? "text-xs font-bold"
      : props.size === "lg"
        ? "text-xl font-bold"
        : props.size === "md"
          ? "text-base font-bold"
          : "text-sm font-bold";
  return (
    <View class="items-center justify-center shrink-0" style={{ rotate: tilt() }}>
      <Text class={sizeClass()} style={{ textColor: color() }}>
        {ICON_GLYPHS[props.name] ?? "•"}
      </Text>
    </View>
  );
}

/** Yellow highlighter or pastel marker swipe behind inline/block text. */
export function Highlight(props: {
  text?: string;
  tone?: "hi" | "marker" | "sky" | "grass" | "bubblegum";
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const fill = () => {
    const p = palette();
    if (props.tone === "marker") return `${p.marker}52`;
    if (props.tone === "sky") return `${p.sky}4D`;
    if (props.tone === "grass") return `${p.grass}4D`;
    if (props.tone === "bubblegum") return `${p.bubblegum}52`;
    return p.hiSelect;
  };
  const tilt = () => seedTilt(props.seed ?? props.text ?? "hi", 0.9, density());
  return (
    <View class="relative flex-row items-center px-1.5 py-0.5">
      <View
        class="absolute inset-0"
        style={{
          bgColor: fill(),
          radius: 5,
          rotate: tilt(),
          translateY: 1,
          hitPass: 1,
        }}
      />
      {props.text !== undefined ? (
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {props.text}
        </Text>
      ) : (
        props.children
      )}
    </View>
  );
}

/** Hand-drawn double-pressure felt/marker underline beneath display words. */
export function Underline(props: {
  text?: string;
  tone?: LooseleafPenTone;
  size?: "sm" | "md" | "lg" | "xl";
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const stroke = () => penColor(palette(), props.tone ?? "marker");
  const tilt = () => seedTilt(props.seed ?? props.text ?? "ul", 1.2, density());
  const textClass = () =>
    props.size === "xl"
      ? "text-2xl font-bold"
      : props.size === "lg"
        ? "text-xl font-bold"
        : props.size === "sm"
          ? "text-xs font-bold"
          : "text-base font-bold";
  return (
    <View class="flex-col items-start gap-0.5">
      {props.text !== undefined ? (
        <Text class={textClass()} style={{ textColor: palette().ink }}>
          {props.text}
        </Text>
      ) : (
        props.children
      )}
      <View class="relative w-full h-[5]">
        <View
          class="w-full h-[3]"
          style={{ bgColor: stroke(), radius: 2, rotate: tilt() }}
        />
        <View
          class="absolute left-[4] right-[2] top-[2] h-[2]"
          style={{ bgColor: stroke(), opacity: 0.55, radius: 1, rotate: -tilt() * 0.6 }}
        />
      </View>
    </View>
  );
}

/** Hand-drawn oval ink loop circling a word, number, or badge. */
export function Circled(props: {
  text?: string;
  tone?: LooseleafPenTone;
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const stroke = () => penColor(palette(), props.tone ?? "red");
  const tilt = () => seedTilt(props.seed ?? props.text ?? "circle", 2.4, density());
  return (
    <View class="relative flex-row items-center justify-center px-2.5 py-1">
      <View
        class="absolute inset-0"
        style={{
          borderColor: stroke(),
          borderWidth: 2,
          radius: 999,
          rotate: tilt(),
          hitPass: 1,
        }}
      />
      <View
        class="absolute left-[1] right-[-1] top-[-1] bottom-[1]"
        style={{
          borderColor: stroke(),
          borderWidth: 1,
          opacity: 0.55,
          radius: 999,
          rotate: -tilt() * 0.7,
          hitPass: 1,
        }}
      />
      {props.text !== undefined ? (
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {props.text}
        </Text>
      ) : (
        props.children
      )}
    </View>
  );
}

/** Red-pencil or felt-tip strikethrough across completed tasks or old values. */
export function Strike(props: {
  text: string;
  tone?: LooseleafPenTone;
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const line = () => penColor(palette(), props.tone ?? "red");
  const tilt = () => seedTilt(props.seed ?? props.text, 1.5, density());
  return (
    <View class="relative flex-row items-center">
      <Text class="text-sm" style={{ textColor: palette().pencilText }}>
        {props.text}
      </Text>
      <View
        class="absolute left-0 right-0 top-[9] h-[2]"
        style={{ bgColor: line(), radius: 1, rotate: tilt(), hitPass: 1 }}
      />
    </View>
  );
}

/** Wavy hand-drawn squiggle divider made of alternating tilted ink segments. */
export function Squiggle(props: {
  tone?: LooseleafPenTone;
  segments?: number;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "pencil");
  const items = () => Array.from({ length: Math.max(6, Math.min(24, props.segments ?? 14)) }, (_, i) => i);
  return (
    <View class="flex-row items-center gap-0.5 py-1">
      <For each={items()}>
        {(idx) => (
          <View
            class="w-[10] h-[2.5]"
            style={{
              bgColor: color(),
              radius: 2,
              rotate: idx % 2 === 0 ? -16 : 16,
              translateY: idx % 2 === 0 ? -1 : 1,
            }}
          />
        )}
      </For>
    </View>
  );
}

/** Energetic multi-stroke margin scribble swatch. */
export function Scribble(props: {
  tone?: LooseleafPenTone;
  width?: number;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "marker");
  const w = () => props.width ?? 48;
  return (
    <View class="flex-col gap-0.5 py-0.5" style={{ width: w() }}>
      <View class="h-[2.5] w-full" style={{ bgColor: color(), radius: 2, rotate: -3 }} />
      <View class="h-[2.5] w-full" style={{ bgColor: color(), opacity: 0.85, radius: 2, rotate: 2.5, scaleX: 0.92 }} />
      <View class="h-[2] w-full" style={{ bgColor: color(), opacity: 0.65, radius: 2, rotate: -1.8, scaleX: 0.78 }} />
    </View>
  );
}

/** Hand-drawn margin bracket (`left`, `right`, or `both`) framing a callout block. */
export function Bracket(props: {
  side?: "left" | "right" | "both";
  tone?: LooseleafPenTone;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const stroke = () => penColor(palette(), props.tone ?? "pencil");
  const side = () => props.side ?? "left";
  return (
    <View class="flex-row items-stretch gap-2">
      <Show when={side() === "left" || side() === "both"}>
        <View class="relative w-[8] shrink-0">
          <View class="absolute left-0 top-0 bottom-0 w-[2]" style={{ bgColor: stroke(), radius: 1 }} />
          <View class="absolute left-0 top-0 w-[7] h-[2]" style={{ bgColor: stroke(), radius: 1 }} />
          <View class="absolute left-0 bottom-0 w-[7] h-[2]" style={{ bgColor: stroke(), radius: 1 }} />
        </View>
      </Show>
      <View class="flex-col gap-1 flex-1">{props.children}</View>
      <Show when={side() === "right" || side() === "both"}>
        <View class="relative w-[8] shrink-0">
          <View class="absolute right-0 top-0 bottom-0 w-[2]" style={{ bgColor: stroke(), radius: 1 }} />
          <View class="absolute right-0 top-0 w-[7] h-[2]" style={{ bgColor: stroke(), radius: 1 }} />
          <View class="absolute right-0 bottom-0 w-[7] h-[2]" style={{ bgColor: stroke(), radius: 1 }} />
        </View>
      </Show>
    </View>
  );
}

export type ArrowDirection = "right" | "left" | "up" | "down" | "up-left" | "up-right";

/** Hand-inked directional pointer arrow. */
export function Arrow(props: {
  direction?: ArrowDirection;
  tone?: LooseleafPenTone;
  label?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "blue");
  const glyph = () => {
    switch (props.direction) {
      case "left":
        return "←";
      case "up":
        return "↑";
      case "down":
        return "↓";
      case "up-left":
        return "↖";
      case "up-right":
        return "↗";
      case "right":
      default:
        return "→";
    }
  };
  return (
    <View class="flex-row items-center gap-1">
      <Text class="text-base font-bold" style={{ textColor: color(), rotate: -3 }}>
        {glyph()}
      </Text>
      <Show when={Boolean(props.label)}>
        <Text class="text-xs font-bold" style={{ textColor: color() }}>
          {props.label}
        </Text>
      </Show>
    </View>
  );
}

/** 3-axis 6-point hand-drawn margin asterisk star (`*`). */
export function Asterisk(props: {
  tone?: LooseleafPenTone;
  size?: number;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "red");
  const s = () => props.size ?? 14;
  return (
    <View class="relative items-center justify-center shrink-0" style={{ width: s(), height: s() }}>
      <View class="absolute h-[2]" style={{ width: s(), bgColor: color(), radius: 1, rotate: 0 }} />
      <View class="absolute h-[2]" style={{ width: s(), bgColor: color(), radius: 1, rotate: 60 }} />
      <View class="absolute h-[2]" style={{ width: s(), bgColor: color(), radius: 1, rotate: -60 }} />
    </View>
  );
}

/** Margin callout note with angled hand-drawn arrow (`"on purpose!"`, `"launch day!"`). */
export function Callout(props: {
  text?: string;
  direction?: ArrowDirection;
  tone?: LooseleafPenTone;
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "blue");
  const tilt = () => seedTilt(props.seed ?? props.text ?? "callout", 2.5, density());
  return (
    <View class="flex-row items-center gap-1.5" style={{ rotate: tilt() }}>
      <Arrow direction={props.direction ?? "up-left"} tone={props.tone ?? "blue"} />
      {props.text !== undefined ? (
        <Text class="text-xs font-bold" style={{ textColor: color() }}>
          {props.text}
        </Text>
      ) : (
        props.children
      )}
    </View>
  );
}

/** Wrapper that attaches a handwritten margin annotation beside any element. */
export function Annotate(props: {
  note: string;
  tone?: LooseleafPenTone;
  direction?: ArrowDirection;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <View class="flex-col gap-1">
      {props.children}
      <View class="flex-row justify-end pr-2">
        <Callout text={props.note} tone={props.tone ?? "blue"} direction={props.direction ?? "up-left"} />
      </View>
    </View>
  );
}

/** Riso-offset display marker lettering (Looseleaf `.ll-riso`). */
export function Lettering(props: {
  text: string;
  size?: "lg" | "xl" | "2xl" | "4xl" | "5xl";
  accent?: LooseleafAccent;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const shadowColor = () => accentColorOf(palette(), props.accent ?? "marker");
  const cls = () =>
    props.size === "5xl" || props.size === "4xl" || props.size === "2xl"
      ? "text-2xl font-bold"
      : props.size === "lg"
        ? "text-lg font-bold"
        : "text-xl font-bold";
  const offset = () => (density() === "calm" ? 0 : 2);
  return (
    <View class="relative flex-row items-center">
      <Show when={offset() > 0}>
        <Text
          class={cls()}
          style={{
            posType: 1,
            insetL: offset(),
            insetT: offset(),
            textColor: shadowColor(),
            opacity: 0.42,
            hitPass: 1,
          }}
        >
          {props.text}
        </Text>
      </Show>
      <Text class={cls()} style={{ textColor: palette().ink }}>
        {props.text}
      </Text>
    </View>
  );
}

/** Bold felt-tip / marker inline pill tag. */
export function Marker(props: {
  text: string;
  accent?: LooseleafAccent;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const bg = () => accentColorOf(palette(), props.accent ?? "hi");
  return (
    <View
      class="px-2 py-0.5 flex-row items-center justify-center"
      style={{ bgColor: bg(), radius: 5, rotate: -0.8 }}
    >
      <Text class="text-xs font-bold" style={{ textColor: "#2A2420" }}>
        {props.text}
      </Text>
    </View>
  );
}

/** Blue-felt handwritten note text (`--ll-ink-you`). */
export function Handwritten(props: {
  text: string;
  tone?: LooseleafPenTone;
  size?: "xs" | "sm" | "base" | "lg";
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "blue");
  const jitterY = () => seedOffset(props.seed ?? props.text, 1, "hand", density());
  const cls = () =>
    props.size === "lg"
      ? "text-lg font-bold"
      : props.size === "base"
        ? "text-base font-bold"
        : props.size === "xs"
          ? "text-xs font-bold"
          : "text-sm font-bold";
  return (
    <Text class={cls()} style={{ textColor: color(), translateY: jitterY() }}>
      {props.text}
    </Text>
  );
}

/** Ruled margin pull-quote with attribution. */
export function Quote(props: {
  text: string;
  author?: string;
  tone?: LooseleafPenTone;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const bar = () => penColor(palette(), props.tone ?? "marker");
  return (
    <View class="flex-row items-stretch gap-3 py-1">
      <View class="w-[3] shrink-0" style={{ bgColor: bar(), radius: 2 }} />
      <View class="flex-col gap-1 flex-1">
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {`“${props.text}”`}
        </Text>
        <Show when={Boolean(props.author)}>
          <Text class="text-xs" style={{ textColor: palette().pencilText }}>
            {`— ${props.author}`}
          </Text>
        </Show>
      </View>
    </View>
  );
}

/** Signed bottom-line cursive signature flourish with pencil baseline. */
export function Signature(props: {
  name: string;
  date?: string;
  tone?: LooseleafPenTone;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const ink = () => penColor(palette(), props.tone ?? "blue");
  return (
    <View class="flex-col gap-1 w-full">
      <View class="flex-row items-end justify-between px-1">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-xs font-bold" style={{ textColor: palette().pencil }}>
            ×
          </Text>
          <Text class="text-lg font-bold" style={{ textColor: ink(), rotate: -2 }}>
            {props.name}
          </Text>
        </View>
        <Show when={Boolean(props.date)}>
          <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
            {props.date}
          </Text>
        </Show>
      </View>
      <View class="w-full h-[1.5]" style={{ bgColor: palette().pencilMark }} />
    </View>
  );
}

/**
 * Authentic 5-stroke gate tally marks (`||||` + diagonal 5th slash),
 * grouped into fives for any non-negative `count` (e.g. `<Tally count={7} />`).
 */
export function Tally(props: {
  count: number;
  size?: "sm" | "md" | "lg";
  tone?: LooseleafPenTone;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const stroke = () => penColor(palette(), props.tone ?? "ink");
  const slashColor = () => penColor(palette(), props.tone === "ink" ? "red" : (props.tone ?? "red"));
  const h = () => (props.size === "lg" ? 22 : props.size === "sm" ? 12 : 16);
  const groups = () => {
    const safe = Math.max(0, Math.min(60, Math.floor(props.count)));
    const full = Math.floor(safe / 5);
    const rem = safe % 5;
    const list: number[] = [];
    for (let i = 0; i < full; i += 1) list.push(5);
    if (rem > 0 || list.length === 0) list.push(rem);
    return list;
  };
  return (
    <View class="flex-row items-center gap-2.5">
      <For each={groups()}>
        {(groupCount, groupIdx) => {
          const verticals = Array.from({ length: Math.min(4, groupCount) }, (_, i) => i);
          return (
            <Show
              when={groupCount > 0}
              fallback={
                <Text class="text-xs font-mono" style={{ textColor: palette().pencil }}>
                  0
                </Text>
              }
            >
              <View class="relative flex-row items-center gap-1 px-0.5" style={{ height: h() }}>
                <For each={verticals}>
                  {(barIdx) => (
                    <View
                      class="w-[2.5]"
                      style={{
                        height: h(),
                        bgColor: stroke(),
                        radius: 1.5,
                        rotate: (barIdx % 2 === 0 ? -2.5 : 2) + (groupIdx() % 2),
                      }}
                    />
                  )}
                </For>
                <Show when={groupCount === 5}>
                  <View
                    class="absolute left-[-2] top-[7] h-[2.5]"
                    style={{
                      width: 24,
                      bgColor: slashColor(),
                      radius: 1.5,
                      rotate: -28,
                      hitPass: 1,
                    }}
                  />
                </Show>
              </View>
            </Show>
          );
        }}
      </For>
    </View>
  );
}

/** Tilted rubber ink stamp (`APPROVED`, `NEW`, `NIGHT SAFE`, baby tag, etc.). */
export function Stamp(props: {
  label: string;
  tone?: "marker" | "red" | "green" | "blue" | "ink";
  seed?: string | number;
  rotate?: number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const color = () => {
    const p = palette();
    if (props.tone === "red") return p.red;
    if (props.tone === "green") return p.green;
    if (props.tone === "blue") return p.inkYou;
    if (props.tone === "ink") return p.ink;
    return p.marker;
  };
  const angle = () =>
    props.rotate !== undefined
      ? props.rotate
      : seedTilt(props.seed ?? props.label, 4.5, density());
  return (
    <View
      class="px-2.5 py-1 flex-row items-center justify-center"
      style={{
        bgColor: `${color()}22`,
        borderColor: color(),
        borderWidth: 2,
        radius: 4,
        rotate: angle(),
      }}
    >
      <Text class="text-2xs font-bold tracking-wide" style={{ textColor: color() }}>
        {props.label.toUpperCase()}
      </Text>
    </View>
  );
}

/** Circular embossed wax / foil seal badge. */
export function Seal(props: {
  label: string;
  accent?: LooseleafAccent;
  size?: number;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const fill = () => accentColorOf(palette(), props.accent ?? "tomato");
  const sz = () => props.size ?? 44;
  return (
    <View
      class="relative items-center justify-center shrink-0"
      style={{
        width: sz(),
        height: sz(),
        bgColor: fill(),
        borderColor: palette().ink,
        borderWidth: 2,
        radius: sz() / 2,
        rotate: -5,
      }}
    >
      <View
        class="items-center justify-center"
        style={{
          width: sz() - 8,
          height: sz() - 8,
          borderColor: "#FFFDF6AA",
          borderWidth: 1,
          radius: (sz() - 8) / 2,
        }}
      >
        <Text class="text-2xs font-bold" style={{ textColor: "#FFFDF6" }}>
          {props.label}
        </Text>
      </View>
    </View>
  );
}

/** Die-cut white-bordered stationery sticker with short drop shadow and optional tap handler. */
export function Sticker(props: {
  label: string;
  icon?: LooseleafIconName;
  accent?: LooseleafAccent;
  peel?: boolean;
  seed?: string | number;
  onPress?: () => void;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const fill = () => accentColorOf(palette(), props.accent ?? "lemon");
  const tilt = () => seedTilt(props.seed ?? props.label, 3.2, density());
  const body = (
    <View class="relative" style={{ rotate: tilt() }}>
      <View
        class="absolute left-[2] top-[3] right-[-2] bottom-[-3]"
        style={{ bgColor: palette().shadowHard, radius: 999, hitPass: 1 }}
      />
      <View
        class="px-3 py-1.5 flex-row items-center gap-1.5"
        style={{
          bgColor: "#FFFDF6",
          borderColor: palette().pencilMark,
          borderWidth: 1,
          radius: 999,
        }}
      >
        <View
          class="px-2 py-0.5 flex-row items-center gap-1"
          style={{ bgColor: fill(), borderColor: "#2A2420", borderWidth: 1.5, radius: 999 }}
        >
          {props.icon ? <Icon name={props.icon} tone="ink" size="xs" /> : null}
          <Text class="text-xs font-bold" style={{ textColor: "#2A2420" }}>
            {props.label}
          </Text>
        </View>
      </View>
    </View>
  );
  if (props.onPress) {
    return (
      <Focusable class="items-center justify-center" onPress={props.onPress}>
        {body}
      </Focusable>
    );
  }
  return body;
}

/** Unframed margin doodle ornament (`star`, `heart`, `sparkle`, `spiral`, `flower`). */
export function Doodle(props: {
  kind?: "star" | "heart" | "sparkle" | "spiral" | "flower" | "arrow";
  tone?: LooseleafPenTone;
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const color = () => penColor(palette(), props.tone ?? "pencil");
  const glyph = () => {
    switch (props.kind) {
      case "heart":
        return "♡";
      case "sparkle":
        return "✦";
      case "spiral":
        return "◎";
      case "flower":
        return "✿";
      case "arrow":
        return "↝";
      case "star":
      default:
        return "☆";
    }
  };
  return (
    <Text
      class="text-base font-bold"
      style={{
        textColor: color(),
        rotate: seedTilt(props.seed ?? props.kind ?? "doodle", 6, density()),
      }}
    >
      {glyph()}
    </Text>
  );
}

export type MascotPose =
  | "idle"
  | "wave"
  | "think"
  | "sleep"
  | "write"
  | "celebrate"
  | "oops"
  | "peek";

/**
 * **Stubby** the Pencil Stub — Looseleaf's signature mascot used by `Empty`,
 * `Spinner`, onboarding headers, and friendly empty timeline states.
 */
export function Mascot(props: {
  pose?: MascotPose;
  caption?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const pose = () => props.pose ?? "idle";
  const face = () => {
    switch (pose()) {
      case "wave":
        return "(•‿•)/";
      case "think":
        return "(◔_◔)?";
      case "sleep":
        return "(－_－) zzZ";
      case "write":
        return "✎(•‿•)";
      case "celebrate":
        return "✧(≧◡≦)✧";
      case "oops":
        return "(⊙_⊙;)";
      case "peek":
        return "|•ω•)";
      case "idle":
      default:
        return "(•‿•)";
    }
  };
  return (
    <View class="flex-col items-center gap-1.5">
      <View class="relative flex-col items-center">
        {/* Pink eraser cap */}
        <View
          class="w-[34] h-[12]"
          style={{
            bgColor: palette().bubblegum,
            borderColor: palette().ink,
            borderWidth: 2,
            radius: 5,
          }}
        />
        {/* Metal ferrule band */}
        <View
          class="w-[36] h-[6]"
          style={{
            bgColor: palette().paperShade,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 2,
          }}
        />
        {/* Yellow hexagonal No. 2 pencil body */}
        <View
          class="w-[34] h-[30] items-center justify-center"
          style={{
            bgColor: palette().hi,
            borderColor: palette().ink,
            borderWidth: 2,
            radius: 4,
          }}
        >
          <Text class="text-2xs font-bold" style={{ textColor: "#2A2420" }}>
            {face()}
          </Text>
        </View>
        {/* Sharpened wood collar + graphite tip */}
        <View
          class="w-[22] h-[10] items-center justify-end"
          style={{
            bgColor: palette().kraft,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 3,
          }}
        >
          <View class="w-[8] h-[4]" style={{ bgColor: palette().ink, radius: 2 }} />
        </View>
      </View>
      <Show when={Boolean(props.caption)}>
        <Text class="text-xs font-bold" style={{ textColor: palette().pencilText }}>
          {props.caption}
        </Text>
      </Show>
    </View>
  );
}

/** Paper-scrap stationery confetti burst. */
export function Confetti(props: { count?: number }): JSX.Element {
  const { palette } = useLooseleafTheme();
  const colors = () => {
    const p = palette();
    return [p.tomato, p.lemon, p.sky, p.grass, p.grape, p.bubblegum];
  };
  const pieces = () => Array.from({ length: Math.max(4, Math.min(16, props.count ?? 10)) }, (_, i) => i);
  return (
    <View class="flex-row items-center justify-center gap-2 py-1">
      <For each={pieces()}>
        {(idx) => (
          <View
            class="w-[8] h-[5]"
            style={{
              bgColor: colors()[idx % colors().length]!,
              borderColor: palette().ink,
              borderWidth: 1,
              radius: 1,
              rotate: (idx * 37) % 90 - 45,
              translateY: idx % 2 === 0 ? -2 : 2,
            }}
          />
        )}
      </For>
    </View>
  );
}

/** Subtle hand-drawn frame wrapper (respects calm density automatically). */
export function Boil(props: {
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { density } = useLooseleafTheme();
  const tilt = () => seedTilt(props.seed ?? "boil", 0.5, density());
  return (
    <View class="flex-col" style={{ rotate: tilt() }}>
      {props.children}
    </View>
  );
}
