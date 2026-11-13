/**
 * @pocket/looseleaf — Data Display, Graph-Paper Charts, Notebook Calendar,
 * Ledger Tables, Code Blocks, Chat Bubbles, Sticker Boards & Journal Timeline.
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { useAnimatedNumber } from "@pocket/ui";
import {
  accentColorOf,
  seedTilt,
  useLooseleafTheme,
  type LooseleafAccent,
} from "./tokens.ts";
import { Callout, Circled, Mascot, Stamp, Sticker, type LooseleafIconName } from "./marks.tsx";
import { Button } from "./controls.tsx";
import { Paper } from "./surfaces.tsx";
import { Separator } from "./navigation.tsx";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "sky"
  | "grass"
  | "lemon"
  | "grape"
  | "bubblegum";

/** Hand-bordered stationery `<Badge>` (`og.png`: crisp ink border + dark ink on marker/pastel). */
export function Badge(props: {
  label: string;
  variant?: BadgeVariant;
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const bg = () => {
    const p = palette();
    switch (props.variant) {
      case "secondary":
        return p.hi;
      case "outline":
        return p.slip;
      case "destructive":
        return p.red;
      case "sky":
        return p.sky;
      case "grass":
        return p.grass;
      case "lemon":
        return p.lemon;
      case "grape":
        return p.grape;
      case "bubblegum":
        return p.bubblegum;
      case "default":
      default:
        return p.marker;
    }
  };
  const fg = () => {
    const p = palette();
    const v = props.variant ?? "default";
    if (v === "destructive" || v === "grape") {
      return p.mode === "amber-night" ? "#1C1000" : "#FFFDF6";
    }
    if (v === "outline") return p.ink;
    return p.mode === "amber-night" ? "#1C1000" : "#2A2420";
  };
  return (
    <View
      class="px-2 py-0.5 flex-row items-center justify-center shrink-0"
      style={{
        bgColor: bg(),
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
        rotate: seedTilt(props.seed ?? props.label, 1.1, density()),
      }}
    >
      <Text class="text-2xs font-bold" style={{ textColor: fg() }}>
        {props.label}
      </Text>
    </View>
  );
}

/** Stationery-tinted hand-ringed `<Avatar>`. */
export function Avatar(props: {
  name: string;
  size?: "sm" | "md" | "lg";
  accent?: LooseleafAccent;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const initials = () => {
    const parts = props.name.trim().split(/\s+/);
    if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
    return props.name.slice(0, 2).toUpperCase();
  };
  const accents: LooseleafAccent[] = ["sky", "grass", "lemon", "tangerine", "grape", "bubblegum"];
  const autoAccent = () => {
    if (props.accent) return props.accent;
    let sum = 0;
    for (let i = 0; i < props.name.length; i += 1) sum += props.name.charCodeAt(i);
    return accents[sum % accents.length]!;
  };
  const dim = () => (props.size === "lg" ? 42 : props.size === "sm" ? 28 : 34);
  return (
    <View
      class="items-center justify-center shrink-0"
      style={{
        width: dim(),
        height: dim(),
        bgColor: accentColorOf(palette(), autoAccent()),
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: dim() / 2,
      }}
    >
      <Text
        class={props.size === "sm" ? "text-2xs font-bold" : "text-xs font-bold"}
        style={{ textColor: "#2A2420" }}
      >
        {initials()}
      </Text>
    </View>
  );
}

export const AvatarFallback = Avatar;

/** Hand-drawn `<Progress>` bar with marker fill and red-pencil percentage readout. */
export function Progress(props: {
  value: number;
  max?: number;
  label?: string;
  accent?: "marker" | "green" | "blue";
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const max = () => Math.max(1, props.max ?? 100);
  const ratio = () => Math.max(0, Math.min(1, props.value / max()));
  const anim = useAnimatedNumber(ratio, 0.28, 180);
  const pct = () => `${String(Math.round(ratio() * 100))}%`;
  const fill = () => {
    if (props.accent === "green") return palette().green;
    if (props.accent === "blue") return palette().inkYou;
    return palette().marker;
  };
  return (
    <View class="flex-col gap-1 w-full">
      <Show when={Boolean(props.label)}>
        <View class="flex-row items-center justify-between w-full">
          <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
            {props.label}
          </Text>
          <Text class="text-xs font-mono font-bold" style={{ textColor: palette().red }}>
            {pct()}
          </Text>
        </View>
      </Show>
      <View
        class="w-full h-[10] overflow-hidden"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 3,
        }}
      >
        <View
          class="h-[10]"
          style={{
            width: -1,
            bgColor: fill(),
            scaleX: Math.max(0.03, anim()),
            originX: -0.5,
          }}
        />
      </View>
    </View>
  );
}

export interface BarChartDatum {
  label: string;
  value: number;
}

/**
 * Graph-paper `<BarChart>` with ink-outlined bars, automatic circled peak bar,
 * and blue-pen callout annotation (`"launch day!"` — Looseleaf Demo `ChartCard`).
 */
export function BarChart(props: {
  title?: string;
  description?: string;
  data: readonly BarChartDatum[];
  peakNote?: string;
  accent?: "green" | "marker" | "blue";
  fastener?: "clip" | "pin" | "none";
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [selectedLabel, setSelectedLabel] = createSignal<string | undefined>(undefined);
  const maxVal = createMemo(() => Math.max(1, ...props.data.map((d) => d.value)));
  const peakItem = createMemo(() =>
    props.data.reduce((best, cur) => (cur.value > best.value ? cur : best), props.data[0] ?? { label: "", value: 0 }),
  );
  const activeDatum = () =>
    props.data.find((d) => d.label === selectedLabel()) ?? peakItem();
  const barFill = () => {
    if (props.accent === "marker") return palette().marker;
    if (props.accent === "blue") return palette().inkYou;
    return palette().green;
  };

  return (
    <Paper
      stock="graph"
      rules="graph"
      tape={props.fastener === "none" ? "top" : false}
      fastener={props.fastener === "none" ? false : (props.fastener ?? "clip")}
      shadow="hard"
      seed={props.title ?? "barchart"}
    >
      <View class="flex-row items-start justify-between gap-2 w-full">
        <View class="flex-col gap-0.5 flex-1">
          <Show when={Boolean(props.title)}>
            <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
              {props.title}
            </Text>
          </Show>
          <Show when={Boolean(props.description)}>
            <Text class="text-xs" style={{ textColor: palette().pencilText }}>
              {props.description}
            </Text>
          </Show>
        </View>
        <Callout
          text={
            selectedLabel()
              ? `${activeDatum().label}: ${String(activeDatum().value)}`
              : (props.peakNote ?? `peak: ${String(peakItem().value)}!`)
          }
          tone="blue"
          direction="down"
        />
      </View>

      <View class="flex-row items-end justify-between gap-2 pt-3 pb-1 h-[120] w-full">
        <For each={props.data}>
          {(item) => {
            const isPeak = () => item.label === peakItem().label;
            const isSelected = () => item.label === (selectedLabel() ?? peakItem().label);
            const h = () => Math.max(14, Math.round((item.value / maxVal()) * 74));
            return (
              <Focusable
                onPress={() => setSelectedLabel(item.label)}
                class="flex-1 flex-col items-center gap-1"
              >
                <Show
                  when={isPeak()}
                  fallback={
                    <Text class="text-2xs font-bold" style={{ textColor: palette().pencilText }}>
                      {String(item.value)}
                    </Text>
                  }
                >
                  <Circled text={String(item.value)} tone="red" />
                </Show>
                <View
                  class="w-[24]"
                  style={{
                    height: h(),
                    bgColor: isSelected() ? palette().marker : barFill(),
                    borderColor: palette().ink,
                    borderWidth: 1.5,
                    radius: 2,
                  }}
                />
                <Text
                  class={isSelected() ? "text-xs font-bold" : "text-xs"}
                  style={{ textColor: isSelected() ? palette().inkYou : palette().inkSoft }}
                >
                  {item.label}
                </Text>
              </Focusable>
            );
          }}
        </For>
      </View>
    </Paper>
  );
}

export const ChartContainer = Paper;
export const LineChart = BarChart;

const LL_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const LL_WEEKS = [
  [1, 2, 3, 4, 5, 6, 7],
  [8, 9, 10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19, 20, 21],
  [22, 23, 24, 25, 26, 27, 28],
  [29, 30, 1, 2, 3, 4, 5],
];

/**
 * Cream-card `<Calendar>` with corner masking tape, blue-felt circled selected
 * date, and red-pencil today dot (matches Looseleaf Demo `Planner`).
 */
export function Calendar(props: {
  monthLabel?: string;
  selectedDay: number;
  today?: number;
  onSelectDay?: (day: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const todayDay = () => props.today ?? 11;
  return (
    <Paper stock="card" tape="corner" shadow="hard" seed="ll-calendar">
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
          {props.monthLabel ?? "November 2026"}
        </Text>
        <Badge label={`Today · ${String(todayDay())}`} variant="outline" />
      </View>
      <View class="flex-row items-center justify-between w-full pt-1">
        <For each={LL_WEEKDAYS}>
          {(wd) => (
            <View class="w-[32] items-center justify-center">
              <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
                {wd}
              </Text>
            </View>
          )}
        </For>
      </View>
      <For each={LL_WEEKS}>
        {(week, wIdx) => (
          <View class="flex-row items-center justify-between w-full">
            <For each={week}>
              {(day) => {
                const outside = wIdx() === LL_WEEKS.length - 1 && day < 7;
                const selected = () => !outside && props.selectedDay === day;
                const isToday = () => !outside && todayDay() === day;
                return (
                  <Focusable
                    onPress={() => {
                      if (!outside) props.onSelectDay?.(day);
                    }}
                    class="relative w-[32] h-[30] items-center justify-center"
                    style={{
                      bgColor: selected() ? `${palette().hi}88` : "#00000000",
                      borderColor: selected() ? palette().inkYou : "#00000000",
                      borderWidth: selected() ? 2 : 0,
                      radius: 15,
                    }}
                  >
                    <Text
                      class={selected() || isToday() ? "text-xs font-bold" : "text-xs"}
                      style={{
                        textColor: outside
                          ? palette().pencilMark
                          : selected()
                            ? palette().inkYou
                            : isToday()
                              ? palette().red
                              : palette().ink,
                      }}
                    >
                      {String(day)}
                    </Text>
                  </Focusable>
                );
              }}
            </For>
          </View>
        )}
      </For>
    </Paper>
  );
}

/** Popover-style `<DatePicker>` built on `<Calendar>`. */
export function DatePicker(props: {
  label?: string;
  monthLabel?: string;
  day?: number;
  onChange?: (day: number) => void;
}): JSX.Element {
  const [localDay, setLocalDay] = createSignal(props.day ?? 14);
  const [open, setOpen] = createSignal(false);
  const activeDay = () => (props.day !== undefined ? props.day : localDay());
  return (
    <View class="flex-col gap-2 w-full">
      <Button
        label={`▦ ${props.monthLabel ?? "Nov"} ${String(activeDay())}, 2026`}
        variant="outline"
        onPress={() => setOpen((o) => !o)}
      />
      <Show when={open()}>
        <Calendar
          monthLabel={props.monthLabel}
          selectedDay={activeDay()}
          onSelectDay={(d) => {
            setLocalDay(d);
            props.onChange?.(d);
            setOpen(false);
          }}
        />
      </Show>
    </View>
  );
}

export interface TableColumn {
  key: string;
  header: string;
}

/** Ledger-ruled `<Table>` (and `<DataTable>` alias). */
export function Table(props: {
  caption?: string;
  columns: readonly TableColumn[];
  rows: readonly Record<string, string>[];
  selectedIndex?: number;
  onSelectRow?: (index: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="check" rules="ledger" shadow="hard" tilt={false} paddingClass="relative flex-col w-full overflow-hidden">
      <View
        class="flex-row items-center justify-between px-3 py-2.5 w-full"
        style={{ bgColor: palette().paperShade }}
      >
        <For each={props.columns}>
          {(col) => (
            <View class="flex-1">
              <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
                {col.header}
              </Text>
            </View>
          )}
        </For>
      </View>
      <View class="w-full h-[1.5]" style={{ bgColor: palette().ink }} />
      <For each={props.rows}>
        {(row, idx) => {
          const active = () => props.selectedIndex === idx();
          return (
            <View class="flex-col w-full">
              <Focusable
                onPress={() => props.onSelectRow?.(idx())}
                class="flex-row items-center justify-between px-3 py-2 w-full"
                style={{ bgColor: active() ? palette().hiSelect : "#00000000" }}
              >
                <For each={props.columns}>
                  {(col) => (
                    <View class="flex-1">
                      <Text class="text-xs" style={{ textColor: palette().ink }}>
                        {row[col.key] ?? "—"}
                      </Text>
                    </View>
                  )}
                </For>
              </Focusable>
              <Separator />
            </View>
          );
        }}
      </For>
      <Show when={Boolean(props.caption)}>
        <View class="px-3 py-2 items-center justify-center w-full">
          <Text class="text-xs" style={{ textColor: palette().pencilText }}>
            {props.caption}
          </Text>
        </View>
      </Show>
    </Paper>
  );
}

export const DataTable = Table;

/** Keycap `<Kbd>` shortcut badge (`font-mono text-xs`). */
export function Kbd(props: { keys: string }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="px-1.5 h-[22] items-center justify-center flex-row"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 3,
      }}
    >
      <Text class="text-xs font-mono" style={{ textColor: palette().ink }}>
        {props.keys}
      </Text>
    </View>
  );
}

/** Code snippet `<CodeBlock>` slip (`dark` `#24272E` or `light` cream paper). */
export function CodeBlock(props: {
  code: string;
  title?: string;
  tone?: "dark" | "light";
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const isDark = () => (props.tone ?? "dark") === "dark";
  return (
    <View
      class="flex-col gap-1.5 p-3 w-full"
      style={{
        bgColor: isDark() ? palette().codeBg : palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <Show when={Boolean(props.title)}>
        <Text
          class="text-xs font-mono"
          style={{ textColor: isDark() ? "#A3A6AD" : palette().pencilText }}
        >
          {props.title}
        </Text>
      </Show>
      <Text
        class="text-xs font-mono"
        style={{ textColor: isDark() ? palette().codeInk : palette().inkYou }}
      >
        {props.code}
      </Text>
    </View>
  );
}

/** Structured list `<Item>` row with optional badge or trailing control. */
export function Item(props: {
  title: string;
  description?: string;
  leading?: JSX.Element;
  badge?: string;
  trailing?: JSX.Element;
  onPress?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="slip" shadow="sheet" tilt={false} onPress={props.onPress} paddingClass="relative flex-row items-center justify-between gap-3 w-full p-3">
      <View class="flex-row items-center gap-2.5 flex-1">
        {props.leading}
        <View class="flex-col gap-0.5 flex-1">
          <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
            {props.title}
          </Text>
          <Show when={Boolean(props.description)}>
            <Text class="text-xs" style={{ textColor: palette().pencilText }}>
              {props.description}
            </Text>
          </Show>
        </View>
      </View>
      {props.badge ? <Badge label={props.badge} variant="secondary" /> : null}
      {props.trailing}
    </Paper>
  );
}

/** Friendly `<Empty>` state featuring Stubby the pencil stub! */
export function Empty(props: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="paper" tape="top" shadow="hard">
      <View class="flex-col items-center justify-center gap-2 py-3 w-full">
        <Mascot pose="wave" />
        <Text class="text-base font-bold text-center" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Show when={Boolean(props.description)}>
          <Text class="text-xs text-center" style={{ textColor: palette().pencilText }}>
            {props.description}
          </Text>
        </Show>
        <Show when={Boolean(props.actionLabel)}>
          <Button label={props.actionLabel!} size="sm" onPress={props.onAction} />
        </Show>
      </View>
    </Paper>
  );
}

/** Pencil-shaded placeholder `<Skeleton>` lines. */
export function Skeleton(props: { rows?: number }): JSX.Element {
  const { palette } = useLooseleafTheme();
  const lines = () => Array.from({ length: props.rows ?? 3 }, (_, i) => i);
  return (
    <View class="flex-col gap-2 w-full py-1">
      <For each={lines()}>
        {(idx) => (
          <View
            class="h-[12] w-full"
            style={{
              bgColor: palette().paperShade,
              borderColor: palette().pencilMark,
              borderWidth: 1,
              radius: 3,
              scaleX: idx === 0 ? 0.72 : idx % 2 === 1 ? 0.94 : 0.56,
              originX: -0.5,
            }}
          />
        )}
      </For>
    </View>
  );
}

/** Hand-drawn ink `<Spinner>` badge. */
export function Spinner(props: { label?: string }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="px-3 py-1.5 flex-row items-center gap-2"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 999,
      }}
    >
      <Text class="text-sm font-bold" style={{ textColor: palette().marker }}>
        ✎
      </Text>
      <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
        {props.label ?? "Drawing ink..."}
      </Text>
    </View>
  );
}

/** Typewriter monospaced strip `<Typewriter>`. */
export function Typewriter(props: { text: string }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="px-3 py-2 flex-row items-center gap-1"
      style={{
        bgColor: palette().slip,
        borderColor: palette().pencilMark,
        borderWidth: 1,
        radius: 3,
      }}
    >
      <Text class="text-sm font-mono" style={{ textColor: palette().ink }}>
        {props.text}
      </Text>
      <View class="w-[2] h-[16]" style={{ bgColor: palette().inkYou }} />
    </View>
  );
}

/** Scratch-to-reveal `<Reveal>` slip. */
export function Reveal(props: {
  coverLabel?: string;
  secret: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [shown, setShown] = createSignal(false);
  return (
    <Focusable
      onPress={() => setShown((s) => !s)}
      class="px-3.5 py-2.5 flex-row items-center justify-between w-full"
      style={{
        bgColor: shown() ? palette().hi : palette().paperShade,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <Text class="text-xs font-bold" style={{ textColor: "#2A2420" }}>
        {shown() ? props.secret : (props.coverLabel ?? "Tap to reveal ink note")}
      </Text>
      <Text class="text-xs font-mono" style={{ textColor: palette().inkYou }}>
        {shown() ? "HIDE" : "PEEK"}
      </Text>
    </Focusable>
  );
}

/** Specimen `<Typography>` showcase block. */
export function Typography(props: {
  heading?: string;
  body?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-2 w-full">
      <Text class="text-2xl font-bold" style={{ textColor: palette().ink }}>
        {props.heading ?? "Sphinx of black quartz, judge my vow"}
      </Text>
      <Text class="text-sm" style={{ textColor: palette().inkSoft }}>
        {props.body ??
          "Real UI is calm: cream paper, dark brown-black felt-tip, blue felt for you and anything interactive, graphite pencil for meta text."}
      </Text>
    </View>
  );
}

/** Hand-drawn speech `<Bubble>` & `<Message>` (Looseleaf Demo `ChatCard`). */
export function Bubble(props: {
  text: string;
  variant?: "default" | "muted";
  seed?: string | number;
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const isYou = () => (props.variant ?? "default") === "default";
  return (
    <View
      class="px-3.5 py-2 max-w-[260]"
      style={{
        bgColor: isYou() ? palette().hi : palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 10,
        rotate: seedTilt(props.seed ?? props.text, 0.7, density()),
      }}
    >
      <Text
        class="text-sm"
        style={{ textColor: isYou() ? "#2A2420" : palette().ink }}
      >
        {props.text}
      </Text>
    </View>
  );
}

export function Message(props: {
  sender: string;
  align?: "start" | "end";
  messages: readonly string[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const isEnd = () => props.align === "end";
  return (
    <View
      class={
        isEnd()
          ? "flex-row items-end justify-end gap-2 w-full"
          : "flex-row items-end justify-start gap-2 w-full"
      }
    >
      <Show when={!isEnd()}>
        <Avatar name={props.sender} size="sm" />
      </Show>
      <View class={isEnd() ? "flex-col items-end gap-1" : "flex-col items-start gap-1"}>
        <Text class="text-2xs font-bold" style={{ textColor: palette().pencilText }}>
          {props.sender}
        </Text>
        <For each={props.messages}>
          {(msg, idx) => (
            <Bubble
              text={msg}
              variant={isEnd() ? "default" : "muted"}
              seed={`${props.sender}-${String(idx())}`}
            />
          )}
        </For>
      </View>
    </View>
  );
}

export function MessageGroup(props: { children?: JSX.Element }): JSX.Element {
  return (
    <Paper stock="graph" rules="graph" tape="both" shadow="hard" seed="msg-group">
      <View class="flex-col gap-3 w-full">{props.children}</View>
    </Paper>
  );
}

export const MessageScroller = MessageGroup;

export function TypingIndicator(props: { sender?: string }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-row items-center gap-1.5 px-2.5 py-1">
      <Text class="text-xs font-bold" style={{ textColor: palette().inkYou }}>
        •••
      </Text>
      <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
        {`${props.sender ?? "Sam"} is writing in pencil...`}
      </Text>
    </View>
  );
}

/** Paperclipped file `<Attachment>` chip. */
export function Attachment(props: {
  filename: string;
  meta?: string;
  onPress?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Focusable
      onPress={props.onPress}
      class="px-3 py-2 flex-row items-center justify-between gap-2"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 4,
      }}
    >
      <Text class="text-xs font-bold" style={{ textColor: palette().inkYou }}>
        {`§ ${props.filename}`}
      </Text>
      <Show when={Boolean(props.meta)}>
        <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
          {props.meta}
        </Text>
      </Show>
    </Focusable>
  );
}

/** Sheet of die-cut `<StickerSheet>` / `<StickerPicker>` / `<StickerBoard>`. */
export function StickerSheet(props: {
  stickers?: readonly { label: string; icon?: LooseleafIconName; accent?: LooseleafAccent }[];
  onPick?: (label: string) => void;
}): JSX.Element {
  const items = () =>
    props.stickers ?? [
      { label: "SHIP IT", icon: "sparkle" as const, accent: "lemon" as const },
      { label: "HAND DRAWN", icon: "pencil" as const, accent: "sky" as const },
      { label: "A+ WORK", icon: "star" as const, accent: "grass" as const },
      { label: "LOVE THIS", icon: "heart" as const, accent: "bubblegum" as const },
    ];
  return (
    <Paper stock="slip" shadow="sheet" tilt={false}>
      <View class="flex-row flex-wrap items-center gap-2.5">
        <For each={items()}>
          {(s) => (
            <Sticker
              label={s.label}
              icon={s.icon}
              accent={s.accent}
              onPress={() => props.onPick?.(s.label)}
            />
          )}
        </For>
      </View>
    </Paper>
  );
}

export const StickerPicker = StickerSheet;
export const StickerBoard = StickerSheet;

/**
 * Journal `<LooseleafTimelineItem>` with vertical felt-tip ink rail, colored
 * tag pill (ideal for Multi-Baby / Multi-Author unified timelines), timestamp,
 * and optional rubber stamp.
 */
export function LooseleafTimelineItem(props: {
  time: string;
  title: string;
  detail?: string;
  tagLabel?: string;
  tagAccent?: LooseleafAccent;
  stampLabel?: string;
  isLast?: boolean;
  onPress?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const dotColor = () => accentColorOf(palette(), props.tagAccent ?? "marker");
  return (
    <View class="flex-row items-stretch gap-3 w-full">
      {/* Left vertical ink rail + node dot */}
      <View class="flex-col items-center w-[18] shrink-0">
        <View
          class="w-[14] h-[14] mt-2 shrink-0"
          style={{
            bgColor: dotColor(),
            borderColor: palette().ink,
            borderWidth: 2,
            radius: 7,
          }}
        />
        <Show when={!props.isLast}>
          <View class="w-[2] flex-1 my-1" style={{ bgColor: palette().pencilMark, opacity: 0.65 }} />
        </Show>
      </View>

      {/* Right paper entry card */}
      <View class="flex-1 pb-2.5">
        <Paper stock="card" shadow="sheet" seed={`${props.time}-${props.title}`} onPress={props.onPress}>
          <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
            <View class="flex-row items-center gap-2">
              <Text class="text-xs font-mono font-bold" style={{ textColor: palette().inkYou }}>
                {props.time}
              </Text>
              <Show when={Boolean(props.tagLabel)}>
                <Badge
                  label={props.tagLabel!}
                  variant={
                    props.tagAccent === "sky"
                      ? "sky"
                      : props.tagAccent === "grass"
                        ? "grass"
                        : props.tagAccent === "grape"
                          ? "grape"
                          : props.tagAccent === "bubblegum"
                            ? "bubblegum"
                            : "secondary"
                  }
                />
              </Show>
            </View>
            <Show when={Boolean(props.stampLabel)}>
              <Stamp label={props.stampLabel!} tone="green" rotate={-3} />
            </Show>
          </View>
          <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
            {props.title}
          </Text>
          <Show when={Boolean(props.detail)}>
            <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
              {props.detail}
            </Text>
          </Show>
          {props.children}
        </Paper>
      </View>
    </View>
  );
}
