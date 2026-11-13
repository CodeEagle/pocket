// Generic toast stack (bottom-right). The caller owns the list and the lifetimes; a press dismisses.
import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";

export type ToastTone = "info" | "success" | "warning" | "danger";
export interface ToastItem { id: number; tone: ToastTone; message: string }

const TONE: Record<ToastTone, { bg: string; fg: string }> = {
  info: { bg: "#1E293B", fg: "#BFDBFE" },
  success: { bg: "#052E16", fg: "#BBF7D0" },
  warning: { bg: "#451A03", fg: "#FDE68A" },
  danger: { bg: "#450A0A", fg: "#FECACA" },
};

export function ToastHost(props: { items: readonly ToastItem[]; onDismiss: (id: number) => void; width?: number }) {
  return (
    <View class="absolute right-[12] bottom-[12] z-40 flex-col gap-2" style={{ width: props.width ?? 360 }}>
      <For each={props.items}>{(toast) => (
        <Focusable class="flex-row items-center gap-2 px-3 py-2 rounded-lg" style={{ bgColor: TONE[toast.tone].bg }} onPress={() => props.onDismiss(toast.id)}>
          <View class="flex-1"><Text class="text-xs" style={{ textColor: TONE[toast.tone].fg }}>{toast.message}</Text></View>
          <Text class="text-xs" style={{ textColor: TONE[toast.tone].fg }}>×</Text>
        </Focusable>
      )}</For>
    </View>
  );
}
