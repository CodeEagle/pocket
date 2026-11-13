import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import type { Toast, Toasts, ToastTone } from "../state/toasts.ts";

const TONE: Record<ToastTone, { bg: string; fg: string }> = {
  info: { bg: "#1E293B", fg: "#BFDBFE" },
  success: { bg: "#052E16", fg: "#BBF7D0" },
  warning: { bg: "#451A03", fg: "#FDE68A" },
  danger: { bg: "#450A0A", fg: "#FECACA" },
};

export function ToastHost(props: { toasts: Toasts }) {
  const state = fromStore(props.toasts.store);
  return (
    <View class="absolute right-[12] bottom-[12] z-40 flex-col gap-2" style={{ width: 360 }}>
      <For each={state().items}>{(toast: Toast) => (
        <Focusable class="flex-row items-center gap-2 px-3 py-2 rounded-lg" style={{ bgColor: TONE[toast.tone].bg }} onPress={() => props.toasts.dismiss(toast.id)}>
          <View class="flex-1"><Text class="text-xs" style={{ textColor: TONE[toast.tone].fg }}>{toast.message}</Text></View>
          <Text class="text-xs" style={{ textColor: TONE[toast.tone].fg }}>×</Text>
        </Focusable>
      )}</For>
    </View>
  );
}
