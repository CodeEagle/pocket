import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { select } from "../ui/bind.ts";
import type { Studio } from "../state/studio.ts";
import { pages } from "../pages/index.tsx";

export function Rail(props: { studio: Studio }) {
  const page = select(props.studio.nav, (n) => n.page);
  return (
    <View class="flex-col gap-2 p-2 bg-[#18181B]" style={{ width: 88 }}>
      <Text class="text-xs text-[#A1A1AA] font-bold">POCKET STUDIO</Text>
      <For each={pages}>{(item) => (
        <Focusable class={page() === item.id ? "px-2 py-2 rounded-lg bg-[#27272A]" : "px-2 py-2 rounded-lg"} onPress={() => props.studio.setPage(item.id)}>
          <Text class={page() === item.id ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#A1A1AA]"}>{item.label}</Text>
        </Focusable>
      )}</For>
    </View>
  );
}
