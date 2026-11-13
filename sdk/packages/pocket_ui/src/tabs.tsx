// Generic tab strip: a label per open item, an optional unsaved marker and a close button.
import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";

import type { TabsBarItem } from "./tabs-model.ts";

export * from "./tabs-model.ts";

export interface TabsBarProps {
  tabs: readonly TabsBarItem[];
  active?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabsBar(props: TabsBarProps) {
  return (
    <View class="flex-row gap-1 flex-wrap">
      <For each={props.tabs}>{(tab) => (
        <View class={props.active === tab.id ? "flex-row items-center rounded-lg bg-[#27272A]" : "flex-row items-center rounded-lg bg-[#18181B]"}>
          <Focusable class="px-2 py-1" onPress={() => props.onActivate(tab.id)}>
            <Text class={props.active === tab.id ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#A1A1AA]"}>{`${tab.label}${tab.dirty ? " ●" : ""}`}</Text>
          </Focusable>
          <Focusable class="px-2 py-1" onPress={() => props.onClose(tab.id)}>
            <Text class="text-xs text-[#71717A]">×</Text>
          </Focusable>
        </View>
      )}</For>
    </View>
  );
}
