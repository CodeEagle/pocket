/**
 * @pocket/looseleaf — Feedback, Alerts, Paper-Slip Toasts, Modal Dialogs,
 * Drawers, Side Sheets, Popovers, HoverCards, Tooltips & Accordions.
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import { Focusable, Modal, Text, View } from "@pocketjs/framework/solid/components";
import { usePresenceTransition } from "@pocket/ui";
import { useLooseleafTheme, type LooseleafStock } from "./tokens.ts";
import { Button } from "./controls.tsx";
import { Avatar } from "./data.tsx";
import { Paper, Tape } from "./surfaces.tsx";

export type AlertTone = "default" | "info" | "success" | "warning" | "destructive";

/** Paper callout `<Alert>` slip with ink border and semantic left bar. */
export function Alert(props: {
  title: string;
  description?: string;
  tone?: AlertTone;
  actionLabel?: string;
  onAction?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const accent = () => {
    const p = palette();
    switch (props.tone) {
      case "destructive":
        return p.red;
      case "success":
        return p.green;
      case "warning":
        return p.tangerine;
      case "info":
        return p.inkYou;
      case "default":
      default:
        return p.marker;
    }
  };
  const stock = (): LooseleafStock =>
    props.tone === "warning" ? "sticky-yellow" : props.tone === "destructive" ? "sticky-pink" : "slip";
  return (
    <Paper stock={stock()} shadow="sheet" tilt={false} paddingClass="relative flex-row items-stretch w-full overflow-hidden">
      <View class="w-[5] shrink-0" style={{ bgColor: accent() }} />
      <View class="flex-col gap-1 p-3 flex-1">
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Show when={Boolean(props.description)}>
          <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
            {props.description}
          </Text>
        </Show>
        {props.children}
        <Show when={Boolean(props.actionLabel && props.onAction)}>
          <View class="flex-row justify-end pt-1">
            <Button label={props.actionLabel!} variant="outline" size="xs" onPress={props.onAction} />
          </View>
        </Show>
      </View>
    </Paper>
  );
}

/**
 * Paper-slip `<Toast>` / `<Sonner>` notification with top masking tape
 * ("Each kind is its own paper, so the meaning is not only a color" — Looseleaf `ToastCard`).
 */
export function Toast(props: {
  open: boolean | (() => boolean);
  title: string;
  description?: string;
  tone?: "default" | "success" | "error" | "info";
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const isOpen = () => (typeof props.open === "function" ? props.open() : props.open);
  const presence = usePresenceTransition(isOpen, { durationMs: 200, animateOnMount: true });
  const stock = (): LooseleafStock => {
    if (props.tone === "success") return "sticky-green";
    if (props.tone === "error") return "sticky-pink";
    if (props.tone === "info") return "sticky-blue";
    return "sticky-yellow";
  };
  return (
    <Show when={presence.mounted()}>
      <View
        class="w-full"
        style={{
          opacity: presence.progress(),
          translateY: (1 - presence.progress()) * -8,
        }}
      >
        <Paper stock={stock()} tape="top" shadow="hard" seed={props.title}>
          <View class="flex-row items-start justify-between gap-2 w-full">
            <View class="flex-col gap-0.5 flex-1">
              <Text class="text-sm font-bold" style={{ textColor: "#2A2420" }}>
                {props.title}
              </Text>
              <Show when={Boolean(props.description)}>
                <Text class="text-xs" style={{ textColor: "#4A423B" }}>
                  {props.description}
                </Text>
              </Show>
            </View>
            <View class="flex-row items-center gap-1.5 shrink-0">
              <Show when={Boolean(props.actionLabel && props.onAction)}>
                <Button label={props.actionLabel!} variant="outline" size="xs" onPress={props.onAction} />
              </Show>
              <Show when={Boolean(props.onClose)}>
                <Button label="✕" variant="ghost" size="xs" onPress={props.onClose} />
              </Show>
            </View>
          </View>
        </Paper>
      </View>
    </Show>
  );
}

export const Sonner = Toast;

/** Modal paper `<Dialog>` (and `<AlertDialog>`) with masking tape and umber scrim. */
export function Dialog(props: {
  open: boolean | (() => boolean);
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const isOpen = () => (typeof props.open === "function" ? props.open() : props.open);
  const presence = usePresenceTransition(isOpen, { durationMs: 220 });
  return (
    <Show when={presence.mounted()}>
      <Modal
        open
        backdropClass="absolute inset-0 bg-[#15110E]"
        class="absolute inset-0 z-50 flex-col items-center justify-center p-4"
        panelClass="relative flex-col w-[336] bg-transparent"
      >
        <View
          class="w-full"
          style={{
            opacity: presence.progress(),
            scale: 0.94 + 0.06 * presence.progress(),
          }}
        >
          <Paper stock="card" tape="top" shadow="hard" tilt={false}>
            <Text class="text-lg font-bold" style={{ textColor: palette().ink }}>
              {props.title}
            </Text>
            <Show when={Boolean(props.description)}>
              <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
                {props.description}
              </Text>
            </Show>
            {props.children}
            <View class="flex-row items-center justify-end gap-2 w-full pt-2">
              <Button
                label={props.cancelLabel ?? "Cancel"}
                variant="outline"
                size="sm"
                onPress={props.onClose}
              />
              <Show when={Boolean(props.onConfirm || props.confirmLabel)}>
                <Button
                  label={props.confirmLabel ?? "Confirm"}
                  variant={props.destructive ? "destructive" : "primary"}
                  size="sm"
                  onPress={() => {
                    props.onConfirm?.();
                    props.onClose();
                  }}
                />
              </Show>
            </View>
          </Paper>
        </View>
      </Modal>
    </Show>
  );
}

export const AlertDialog = Dialog;

/** Bottom notebook sheet `<Drawer>` (inline or modal). */
export function Drawer(props: {
  open?: boolean | (() => boolean);
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  if (props.open === undefined) {
    return (
      <Paper stock="card" shadow="hard" tilt={false}>
        <View class="items-center justify-center w-full pb-1">
          <View class="w-[42] h-[4]" style={{ bgColor: palette().pencilMark, radius: 2 }} />
        </View>
        <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Show when={Boolean(props.subtitle)}>
          <Text class="text-xs" style={{ textColor: palette().pencilText }}>
            {props.subtitle}
          </Text>
        </Show>
        {props.children}
      </Paper>
    );
  }
  const isOpen = () => (typeof props.open === "function" ? props.open() : Boolean(props.open));
  const presence = usePresenceTransition(isOpen, { durationMs: 220 });
  return (
    <Show when={presence.mounted()}>
      <Modal
        open
        backdropClass="absolute inset-0 bg-[#15110E]"
        class="absolute inset-0 z-50 flex-col items-center justify-end p-3"
        panelClass="relative flex-col w-[360] bg-transparent"
      >
        <View
          class="w-full"
          style={{
            opacity: presence.progress(),
            translateY: (1 - presence.progress()) * 24,
          }}
        >
          <Paper stock="card" shadow="hard" tilt={false}>
            <View class="items-center justify-center w-full">
              <Tape kind="masking" width={54} height={12} angle={-1} />
            </View>
            <View class="flex-row items-center justify-between w-full">
              <View class="flex-col gap-0.5 flex-1">
                <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
                  {props.title}
                </Text>
                <Show when={Boolean(props.subtitle)}>
                  <Text class="text-xs" style={{ textColor: palette().pencilText }}>
                    {props.subtitle}
                  </Text>
                </Show>
              </View>
              <Show when={Boolean(props.onClose)}>
                <Button label="Close" variant="outline" size="xs" onPress={props.onClose} />
              </Show>
            </View>
            {props.children}
          </Paper>
        </View>
      </Modal>
    </Show>
  );
}

export const Sheet = Drawer;

/** Toggleable slip `<Popover>`. */
export function Popover(props: {
  triggerLabel: string;
  title?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [open, setOpen] = createSignal(true);
  return (
    <View class="flex-col gap-2 w-full">
      <View class="flex-row items-center">
        <Button
          label={props.triggerLabel}
          variant="outline"
          size="sm"
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      <Show when={open()}>
        <Paper stock="slip" tape="corner" shadow="hard">
          <Show when={Boolean(props.title)}>
            <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
              {props.title}
            </Text>
          </Show>
          {props.children}
        </Paper>
      </Show>
    </View>
  );
}

/** Author bio `<HoverCard>` on index slip. */
export function HoverCard(props: {
  handle: string;
  bio: string;
  meta?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="slip" fastener="clip" shadow="sheet" seed={props.handle}>
      <View class="flex-row items-start gap-3 w-full">
        <Avatar name={props.handle.replace(/^@/, "")} />
        <View class="flex-col gap-0.5 flex-1">
          <Text class="text-sm font-bold" style={{ textColor: palette().inkYou }}>
            {props.handle}
          </Text>
          <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
            {props.bio}
          </Text>
          <Show when={Boolean(props.meta)}>
            <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
              {props.meta}
            </Text>
          </Show>
        </View>
      </View>
    </Paper>
  );
}

/** Sticky-note callout `<Tooltip>`. */
export function Tooltip(props: {
  label: string;
  tip: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [shown, setShown] = createSignal(true);
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <Button label={props.label} variant="outline" size="xs" onPress={() => setShown((s) => !s)} />
      <Show when={shown()}>
        <View
          class="px-2.5 py-1"
          style={{
            bgColor: palette().stickyYellow,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 5,
            rotate: -1.5,
          }}
        >
          <Text class="text-xs font-bold" style={{ textColor: "#2A2420" }}>
            {props.tip}
          </Text>
        </View>
      </Show>
    </View>
  );
}

export interface AccordionItemData {
  id: string;
  title: string;
  content: string;
}

/** Multi-row ruled `<Accordion>` disclosure list. */
export function Accordion(props: {
  items: readonly AccordionItemData[];
  defaultOpenId?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [openId, setOpenId] = createSignal<string | undefined>(
    props.defaultOpenId ?? props.items[0]?.id,
  );
  return (
    <Paper stock="paper" shadow="hard" tilt={false}>
      <For each={props.items}>
        {(item, idx) => {
          const expanded = () => openId() === item.id;
          return (
            <View class="flex-col gap-1.5 w-full">
              <Focusable
                onPress={() => setOpenId((cur) => (cur === item.id ? undefined : item.id))}
                class="flex-row items-center justify-between py-1 w-full"
              >
                <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
                  {item.title}
                </Text>
                <Text class="text-xs font-bold" style={{ textColor: palette().inkYou }}>
                  {expanded() ? "▴" : "▾"}
                </Text>
              </Focusable>
              <Show when={expanded()}>
                <Text class="text-xs pb-1" style={{ textColor: palette().inkSoft }}>
                  {item.content}
                </Text>
              </Show>
              <Show when={idx() < props.items.length - 1}>
                <View class="w-full h-[1]" style={{ bgColor: palette().pencilMark, opacity: 0.5 }} />
              </Show>
            </View>
          );
        }}
      </For>
    </Paper>
  );
}

/** Expandable `<Collapsible>` list group. */
export function Collapsible(props: {
  title: string;
  preview: string;
  moreItems: readonly string[];
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [open, setOpen] = createSignal(false);
  return (
    <View class="flex-col gap-1.5 w-full">
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Button
          label={open() ? "Fold ▴" : `More (${String(props.moreItems.length)}) ▾`}
          variant="outline"
          size="xs"
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      <Paper stock="slip" shadow="sheet" tilt={false} paddingClass="relative flex-col p-2.5 w-full">
        <Text class="text-xs font-mono" style={{ textColor: palette().inkYou }}>
          {props.preview}
        </Text>
      </Paper>
      <Show when={open()}>
        <For each={props.moreItems}>
          {(entry) => (
            <Paper stock="slip" shadow="sheet" tilt={false} paddingClass="relative flex-col p-2.5 w-full">
              <Text class="text-xs font-mono" style={{ textColor: palette().ink }}>
                {entry}
              </Text>
            </Paper>
          )}
        </For>
      </Show>
    </View>
  );
}
