import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { basename } from "../lib/path.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty } from "../state/workspace.ts";

/** Open documents with a dirty marker; closing a dirty tab asks first (see workspace.close). */
export function Tabs(props: { studio: Studio }) {
  const ws = props.studio.workspace;
  const state = fromStore(ws.store);
  return (
    <View class="flex-row gap-1 flex-wrap">
      <For each={state().docs}>{(doc) => (
        <View class={state().active === doc.path ? "flex-row items-center rounded-lg bg-[#27272A]" : "flex-row items-center rounded-lg bg-[#18181B]"}>
          <Focusable class="px-2 py-1" onPress={() => ws.activate(doc.path)}>
            <Text class={state().active === doc.path ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#A1A1AA]"}>{`${basename(doc.path)}${isDirty(doc) ? " ●" : ""}`}</Text>
          </Focusable>
          <Focusable class="px-2 py-1" onPress={() => void ws.close(doc.path)}>
            <Text class="text-xs text-[#71717A]">×</Text>
          </Focusable>
        </View>
      )}</For>
    </View>
  );
}
