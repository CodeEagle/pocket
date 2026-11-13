/**
 * @pocket/looseleaf — Tabs, Menus, Command Palette, Breadcrumb, Pagination,
 * Sidebar, ScrollArea, Resizable, Carousel, AppBar & Floating Dock Navigation.
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { NavigationBar, type DisplayGeometry, type NavigationItem } from "@pocket/ui";
import { useLooseleafTheme } from "./tokens.ts";
import { Button } from "./controls.tsx";
import { Paper, Tape } from "./surfaces.tsx";

/** Hand-drawn `<Separator>` rule (`solid`, `double`, or `dashed`). */
export function Separator(props: {
  orientation?: "horizontal" | "vertical";
  kind?: "pencil" | "ink" | "double" | "dashed";
  label?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const color = () =>
    props.kind === "ink" || props.kind === "double" ? palette().ink : palette().pencilMark;
  if (props.orientation === "vertical") {
    return <View class="w-[1.5] h-[20]" style={{ bgColor: color(), opacity: 0.7 }} />;
  }
  if (props.label) {
    return (
      <View class="flex-row items-center gap-2.5 w-full py-1">
        <View class="flex-1 h-[1]" style={{ bgColor: color(), opacity: 0.6 }} />
        <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
          {props.label}
        </Text>
        <View class="flex-1 h-[1]" style={{ bgColor: color(), opacity: 0.6 }} />
      </View>
    );
  }
  if (props.kind === "double") {
    return (
      <View class="flex-col gap-0.5 w-full py-0.5">
        <View class="w-full h-[1.5]" style={{ bgColor: color() }} />
        <View class="w-full h-[1]" style={{ bgColor: color(), opacity: 0.55 }} />
      </View>
    );
  }
  if (props.kind === "dashed") {
    const dashes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    return (
      <View class="flex-row items-center justify-between w-full py-1">
        <For each={dashes}>
          {() => <View class="w-[14] h-[1.5]" style={{ bgColor: color(), opacity: 0.65, radius: 1 }} />}
        </For>
      </View>
    );
  }
  return <View class="w-full h-[1]" style={{ bgColor: color(), opacity: 0.65 }} />;
}

/**
 * Notebook `<Tabs>` with yellow-highlighter active pill and terracotta ink bar
 * (matches Looseleaf Demo `TabsCard`: `To do | Sprint | Team`).
 */
export function Tabs(props: {
  items: readonly { id: string; label: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-3 w-full">
      <View
        class="flex-row items-center gap-1 p-1 w-full"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 7,
        }}
      >
        <For each={props.items}>
          {(tab) => {
            const active = () => props.value === tab.id;
            return (
              <Focusable
                onPress={() => props.onChange(tab.id)}
                class="flex-1 h-[32] px-2.5 flex-row items-center justify-center gap-1.5"
                style={{
                  bgColor: active() ? palette().hi : "#00000000",
                  borderColor: active() ? palette().ink : "#00000000",
                  borderWidth: active() ? 1.5 : 0,
                  radius: 5,
                }}
              >
                <Text
                  class="text-xs font-bold"
                  style={{ textColor: active() ? "#2A2420" : palette().inkSoft }}
                >
                  {tab.label}
                </Text>
                <Show when={tab.count !== undefined}>
                  <Text
                    class="text-2xs font-bold"
                    style={{ textColor: active() ? palette().red : palette().pencilText }}
                  >
                    {String(tab.count)}
                  </Text>
                </Show>
              </Focusable>
            );
          }}
        </For>
      </View>
      {props.children}
    </View>
  );
}

/** Pencil-slash `<Breadcrumb>` trail. */
export function Breadcrumb(props: {
  items: readonly string[];
  onSelect?: (index: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-row flex-wrap items-center gap-1.5">
      <For each={props.items}>
        {(item, idx) => {
          const isLast = () => idx() === props.items.length - 1;
          return (
            <View class="flex-row items-center gap-1.5">
              <Focusable onPress={() => props.onSelect?.(idx())}>
                <Text
                  class={isLast() ? "text-xs font-bold" : "text-xs"}
                  style={{ textColor: isLast() ? palette().ink : palette().inkYou }}
                >
                  {item}
                </Text>
              </Focusable>
              <Show when={!isLast()}>
                <Text class="text-xs" style={{ textColor: palette().pencilMark }}>
                  /
                </Text>
              </Show>
            </View>
          );
        }}
      </For>
    </View>
  );
}

/** Page-numbered notebook `<Pagination>` bar. */
export function Pagination(props: {
  page: number;
  totalPages: number;
  onChange?: (page: number) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const pages = createMemo(() =>
    Array.from({ length: Math.max(1, props.totalPages) }, (_, i) => i + 1),
  );
  return (
    <View class="flex-row flex-wrap items-center gap-1.5">
      <Button
        label="‹ Prev"
        variant="outline"
        size="xs"
        disabled={props.page <= 1}
        onPress={() => props.onChange?.(Math.max(1, props.page - 1))}
      />
      <For each={pages()}>
        {(num) => {
          const active = () => props.page === num;
          return (
            <Focusable
              onPress={() => props.onChange?.(num)}
              class="w-[30] h-[30] items-center justify-center"
              style={{
                bgColor: active() ? palette().hi : palette().slip,
                borderColor: palette().ink,
                borderWidth: active() ? 2 : 1,
                radius: 5,
              }}
            >
              <Text
                class="text-xs font-bold"
                style={{ textColor: active() ? "#2A2420" : palette().ink }}
              >
                {String(num)}
              </Text>
            </Focusable>
          );
        }}
      </For>
      <Button
        label="Next ›"
        variant="outline"
        size="xs"
        disabled={props.page >= props.totalPages}
        onPress={() => props.onChange?.(Math.min(props.totalPages, props.page + 1))}
      />
    </View>
  );
}

/** Top-level `<NavigationMenu>` with paper preview panel. */
export function NavigationMenu(props: {
  sections?: readonly { id: string; label: string; summary: string }[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const list = () =>
    props.sections ?? [
      { id: "foundations", label: "Foundations ▾", summary: "Ten laws of the hand: cream paper, felt-tip ink, short umber shadows." },
      { id: "components", label: "Components ▾", summary: "120+ drop-in shadcn-compatible paper & marker components." },
      { id: "blocks", label: "Blocks", summary: "Ready-made desks, journals, timelines, and planners." },
    ];
  const [active, setActive] = createSignal(list()[0]?.id ?? "foundations");
  const current = () => list().find((s) => s.id === active()) ?? list()[0]!;
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row flex-wrap items-center gap-1.5">
        <For each={list()}>
          {(sec) => (
            <Button
              label={sec.label}
              size="xs"
              variant={active() === sec.id ? "secondary" : "outline"}
              onPress={() => setActive(sec.id)}
            />
          )}
        </For>
      </View>
      <Paper stock="slip" shadow="sheet" tilt={false}>
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {current().label.replace(" ▾", "")}
        </Text>
        <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
          {current().summary}
        </Text>
      </Paper>
    </View>
  );
}

/** Classic desktop `<Menubar>` strip on slip stock. */
export function Menubar(props: {
  menus?: readonly string[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const items = () => props.menus ?? ["File", "Edit", "Paper", "Ink"];
  const [active, setActive] = createSignal(items()[0] ?? "File");
  return (
    <View class="flex-col gap-1.5 w-full">
      <View
        class="flex-row items-center gap-1 p-1"
        style={{
          bgColor: palette().slip,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 6,
        }}
      >
        <For each={items()}>
          {(m) => (
            <Focusable
              onPress={() => setActive(m)}
              class="px-2.5 py-1"
              style={{
                bgColor: active() === m ? palette().hi : "#00000000",
                radius: 4,
              }}
            >
              <Text
                class="text-xs font-bold"
                style={{ textColor: active() === m ? "#2A2420" : palette().ink }}
              >
                {m}
              </Text>
            </Focusable>
          )}
        </For>
      </View>
    </View>
  );
}

/** Paper slip `<DropdownMenu>`. */
export function DropdownMenu(props: {
  triggerLabel: string;
  items: readonly { id: string; label: string; shortcut?: string }[];
  onSelect?: (id: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [open, setOpen] = createSignal(false);
  return (
    <View class="flex-col gap-1.5 w-full">
      <View class="flex-row items-center">
        <Button
          label={`${props.triggerLabel} ${open() ? "▴" : "▾"}`}
          variant="outline"
          size="sm"
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      <Show when={open()}>
        <Paper stock="slip" shadow="hard" tilt={false} paddingClass="relative flex-col gap-1 w-full p-2">
          <For each={props.items}>
            {(item) => (
              <Focusable
                onPress={() => {
                  props.onSelect?.(item.id);
                  setOpen(false);
                }}
                class="flex-row items-center justify-between px-2.5 py-1.5 w-full active:bg-[#F8DC4C] focus:bg-[#ECE6DA]"
                style={{ radius: 5 }}
              >
                <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
                  {item.label}
                </Text>
                <Show when={Boolean(item.shortcut)}>
                  <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
                    {item.shortcut}
                  </Text>
                </Show>
              </Focusable>
            )}
          </For>
        </Paper>
      </Show>
    </View>
  );
}

/** Tap-to-open `<ContextMenu>` region on ruled paper. */
export function ContextMenu(props: {
  label?: string;
  items?: readonly { id: string; label: string; shortcut?: string }[];
  onSelect?: (id: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [open, setOpen] = createSignal(false);
  const actions = () =>
    props.items ?? [
      { id: "highlight", label: "Highlight selection", shortcut: "⌘H" },
      { id: "stamp", label: "Add rubber stamp", shortcut: "⌘S" },
      { id: "pin", label: "Pin to corkboard", shortcut: "⌘P" },
    ];
  return (
    <View class="flex-col gap-1.5 w-full">
      <Focusable
        onPress={() => setOpen((o) => !o)}
        class="h-[48] px-3 items-center justify-center w-full"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().pencilMark,
          borderWidth: 1.5,
          radius: 6,
        }}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().inkSoft }}>
          {props.label ?? `Tap to ${open() ? "close" : "open"} context menu`}
        </Text>
      </Focusable>
      <Show when={open()}>
        <Paper stock="slip" shadow="hard" tilt={false} paddingClass="relative flex-col gap-1 w-full p-2">
          <For each={actions()}>
            {(act) => (
              <Focusable
                onPress={() => {
                  props.onSelect?.(act.id);
                  setOpen(false);
                }}
                class="flex-row items-center justify-between px-2.5 py-1.5 w-full"
              >
                <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
                  {act.label}
                </Text>
                <Show when={Boolean(act.shortcut)}>
                  <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
                    {act.shortcut}
                  </Text>
                </Show>
              </Focusable>
            )}
          </For>
        </Paper>
      </Show>
    </View>
  );
}

/** Index-card `<Command>` palette with grouped items and `⌘K` header. */
export function Command(props: {
  placeholder?: string;
  items: readonly { id: string; label: string; group: string; shortcut?: string }[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const groups = createMemo(() => {
    const out: string[] = [];
    for (const item of props.items) {
      if (!out.includes(item.group)) out.push(item.group);
    }
    return out;
  });
  return (
    <Paper stock="slip" shadow="hard" tilt={false} paddingClass="relative flex-col gap-2 w-full p-3">
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs" style={{ textColor: palette().pencilText }}>
          {`⌕ ${props.placeholder ?? "Search notebook commands..."}`}
        </Text>
        <View
          class="px-1.5 py-0.5"
          style={{
            bgColor: palette().paperShade,
            borderColor: palette().ink,
            borderWidth: 1,
            radius: 4,
          }}
        >
          <Text class="text-xs font-mono" style={{ textColor: palette().ink }}>
            ⌘K
          </Text>
        </View>
      </View>
      <Separator />
      <For each={groups()}>
        {(group) => (
          <View class="flex-col gap-1 w-full">
            <Text class="text-2xs font-bold tracking-wide" style={{ textColor: palette().pencilText }}>
              {group.toUpperCase()}
            </Text>
            <For each={props.items.filter((i) => i.group === group)}>
              {(item) => {
                const selected = () => props.selectedId === item.id;
                return (
                  <Focusable
                    onPress={() => props.onSelect?.(item.id)}
                    class="flex-row items-center justify-between px-2.5 py-1.5 w-full"
                    style={{
                      bgColor: selected() ? palette().hi : "#00000000",
                      radius: 5,
                    }}
                  >
                    <Text
                      class="text-xs font-bold"
                      style={{ textColor: selected() ? "#2A2420" : palette().ink }}
                    >
                      {item.label}
                    </Text>
                    <Show when={Boolean(item.shortcut)}>
                      <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
                        {item.shortcut}
                      </Text>
                    </Show>
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

/** Pad-stock (`#F8F2DE`) collapsible `<Sidebar>` with active notebook tab. */
export function Sidebar(props: {
  title?: string;
  items?: readonly { id: string; label: string }[];
  activeId?: string;
  onSelect?: (id: string) => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [collapsed, setCollapsed] = createSignal(false);
  const navItems = () =>
    props.items ?? [
      { id: "desk", label: "Desk" },
      { id: "notes", label: "Notes" },
      { id: "stamps", label: "Stamps" },
    ];
  const [localActive, setLocalActive] = createSignal(navItems()[0]?.id ?? "desk");
  const current = () => props.activeId ?? localActive();
  return (
    <View
      class="flex-row items-stretch w-full overflow-hidden"
      style={{
        bgColor: palette().paper,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 8,
      }}
    >
      <View
        class="flex-col gap-1.5 p-2.5 shrink-0"
        style={{
          width: collapsed() ? 54 : 124,
          bgColor: palette().pad,
        }}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {collapsed() ? "LL" : (props.title ?? "Notebook")}
        </Text>
        <Separator />
        <For each={navItems()}>
          {(nav) => {
            const active = () => current() === nav.id;
            return (
              <Focusable
                onPress={() => {
                  setLocalActive(nav.id);
                  props.onSelect?.(nav.id);
                }}
                class="px-2 py-1.5"
                style={{
                  bgColor: active() ? palette().hi : "#00000000",
                  radius: 5,
                }}
              >
                <Text
                  class="text-xs font-bold"
                  style={{ textColor: active() ? "#2A2420" : palette().ink }}
                >
                  {collapsed() ? nav.label.slice(0, 1) : nav.label}
                </Text>
              </Focusable>
            );
          }}
        </For>
      </View>
      <View class="w-[1.5]" style={{ bgColor: palette().padRule }} />
      <View class="flex-col gap-2 p-3 flex-1">
        <View class="flex-row items-center justify-between w-full">
          <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
            {current().toUpperCase()}
          </Text>
          <Button
            label={collapsed() ? "▸" : "◂"}
            variant="outline"
            size="xs"
            onPress={() => setCollapsed((c) => !c)}
          />
        </View>
        {props.children}
      </View>
    </View>
  );
}

/** Paper-framed `<ScrollArea>` list window with step controls. */
export function ScrollArea(props: {
  title?: string;
  items: readonly string[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [offset, setOffset] = createSignal(0);
  const visible = () => props.items.slice(offset(), offset() + 4);
  return (
    <Paper stock="slip" shadow="sheet" tilt={false}>
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {props.title ?? "Notebook Index"}
        </Text>
        <View class="flex-row items-center gap-1">
          <Button
            label="↑"
            variant="outline"
            size="xs"
            disabled={offset() <= 0}
            onPress={() => setOffset((o) => Math.max(0, o - 1))}
          />
          <Button
            label="↓"
            variant="outline"
            size="xs"
            disabled={offset() + 4 >= props.items.length}
            onPress={() => setOffset((o) => Math.min(Math.max(0, props.items.length - 4), o + 1))}
          />
        </View>
      </View>
      <View class="flex-col gap-1.5 w-full">
        <For each={visible()}>
          {(entry) => (
            <View class="flex-col gap-1 w-full">
              <Text class="text-xs" style={{ textColor: palette().ink }}>
                {entry}
              </Text>
              <Separator />
            </View>
          )}
        </For>
      </View>
    </Paper>
  );
}

/** Two-pane `<Resizable>` paper layout. */
export function Resizable(props: {
  leftLabel?: string;
  rightLabel?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [ratio, setRatio] = createSignal(40);
  const cycle = () => setRatio((r) => (r === 40 ? 55 : r === 55 ? 30 : 40));
  return (
    <View
      class="flex-row h-[84] w-full overflow-hidden"
      style={{
        bgColor: palette().slip,
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 6,
      }}
    >
      <View class="items-center justify-center" style={{ grow: ratio(), shrink: 1, basis: 0 }}>
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {`${props.leftLabel ?? "Margin"} (${String(ratio())}%)`}
        </Text>
      </View>
      <Focusable
        onPress={cycle}
        class="w-[16] h-[84] items-center justify-center"
        style={{ bgColor: palette().paperShade }}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          ⋮
        </Text>
      </Focusable>
      <View class="items-center justify-center" style={{ grow: 100 - ratio(), shrink: 1, basis: 0 }}>
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {`${props.rightLabel ?? "Sheet"} (${String(100 - ratio())}%)`}
        </Text>
      </View>
    </View>
  );
}

/** Paper `<AspectRatio>` frame switcher (`16:9`, `4:3`, `1:1`). */
export function AspectRatio(props: {
  caption?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [ratio, setRatio] = createSignal<"16:9" | "4:3" | "1:1">("16:9");
  const h = () => (ratio() === "16:9" ? 96 : ratio() === "4:3" ? 120 : 144);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {`AspectRatio (${ratio()})`}
        </Text>
        <View class="flex-row items-center gap-1">
          <For each={["16:9", "4:3", "1:1"] as const}>
            {(r) => (
              <Button
                label={r}
                size="xs"
                variant={ratio() === r ? "secondary" : "outline"}
                onPress={() => setRatio(r)}
              />
            )}
          </For>
        </View>
      </View>
      <View
        class="w-full items-center justify-center"
        style={{
          height: h(),
          bgColor: palette().photo,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 6,
        }}
      >
        <Text class="text-xs font-bold" style={{ textColor: palette().pencilText }}>
          {props.caption ?? `Sketch frame · ${ratio()}`}
        </Text>
      </View>
    </View>
  );
}

/** Card-flipping `<Carousel>` deck. */
export function Carousel(props: {
  slides: readonly { title: string; detail: string }[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [idx, setIdx] = createSignal(0);
  const current = () => props.slides[idx()] ?? props.slides[0]!;
  return (
    <View class="flex-col gap-2 w-full">
      <Paper stock="card" tape="top" shadow="hard">
        <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
          {`CARD ${String(idx() + 1)} OF ${String(props.slides.length)}`}
        </Text>
        <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
          {current().title}
        </Text>
        <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
          {current().detail}
        </Text>
      </Paper>
      <View class="flex-row items-center justify-between w-full">
        <Button
          label="← Prev card"
          variant="outline"
          size="xs"
          onPress={() => setIdx((i) => (i - 1 + props.slides.length) % props.slides.length)}
        />
        <Button
          label="Next card →"
          variant="outline"
          size="xs"
          onPress={() => setIdx((i) => (i + 1) % props.slides.length)}
        />
      </View>
    </View>
  );
}

/** Horizontal ticker strip `<Marquee>` of stationery badges. */
export function Marquee(props: {
  items: readonly string[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="flex-row flex-wrap items-center gap-2 px-3 py-2 w-full"
      style={{
        bgColor: palette().paperShade,
        borderColor: palette().ink,
        borderWidth: 1,
        radius: 6,
      }}
    >
      <For each={props.items}>
        {(item) => (
          <View class="flex-row items-center gap-2">
            <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
              {item}
            </Text>
            <Text class="text-xs" style={{ textColor: palette().marker }}>
              ✦
            </Text>
          </View>
        )}
      </For>
    </View>
  );
}

/** Looseleaf top `<LooseleafAppBar>` / `<LooseleafToolbar>` header bar on cream paper. */
export function LooseleafAppBar(props: {
  title: string;
  subtitle?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="flex-row items-center justify-between gap-3 w-full px-4 py-3"
      style={{
        bgColor: palette().paper,
        borderColor: palette().ink,
        borderWidth: 1.5,
      }}
    >
      <View class="flex-row items-center gap-2.5 flex-1">
        {props.leading}
        <View class="flex-col gap-0.5 flex-1">
          <Text class="text-lg font-bold" style={{ textColor: palette().ink }}>
            {props.title}
          </Text>
          <Show when={Boolean(props.subtitle)}>
            <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
              {props.subtitle}
            </Text>
          </Show>
        </View>
      </View>
      <View class="flex-row items-center gap-2 shrink-0">{props.trailing}</View>
    </View>
  );
}

export const LooseleafToolbar = LooseleafAppBar;

/**
 * Floating cream-paper dock `<LooseleafNavigationBar>` with hard umber shadow
 * and masking tape accent — parallel to `@pocket/ui`'s `AppleGlassNavigationBar`.
 */
export function LooseleafNavigationBar(props: {
  active: string;
  items: readonly NavigationItem[];
  onChange: (id: string) => void;
  geometry?: DisplayGeometry | (() => DisplayGeometry);
  visible?: boolean;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const isDark = () => palette().mode !== "notebook";
  return (
    <NavigationBar
      route={props.active}
      onNavigate={() => undefined}
      onItemPress={props.onChange}
      items={props.items}
      visible={props.visible}
      dark={isDark()}
      geometry={props.geometry}
      floating
      selectionIndicator
      background={
        <View class="absolute inset-0">
          <View
            class="absolute left-[2] top-[3] right-[-2] bottom-[-3]"
            style={{ bgColor: palette().shadowHard, radius: 999, hitPass: 1 }}
          />
          <View
            class="absolute inset-0"
            style={{
              bgColor: palette().card,
              borderColor: palette().ink,
              borderWidth: 2,
              radius: 999,
              hitPass: 1,
            }}
          />
          <View class="absolute top-[-6] left-0 right-0 items-center justify-center" style={{ hitPass: 1 }}>
            <Tape kind="washi-yellow" width={44} height={10} angle={-1.5} />
          </View>
        </View>
      }
    />
  );
}
