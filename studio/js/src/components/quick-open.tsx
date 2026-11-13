import { For, Show } from "solid-js";
import { InputField } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { basename, dirname } from "../lib/path.ts";
import type { QuickOpen } from "../state/quick-open.ts";

const VISIBLE_ROWS = 10;

/** Cmd+P overlay: a text field (focused on open) over the ranked file list. Rows are tappable; Up/Down/Enter/Esc come from the keymap. */
export function QuickOpenOverlay(props: { quickOpen: QuickOpen }) {
  const state = fromStore(props.quickOpen.store);
  // Keep the selected row inside the visible window.
  const window = () => {
    const { results, selected } = state();
    const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), results.length - VISIBLE_ROWS));
    return results.slice(start, start + VISIBLE_ROWS).map((match, i) => ({ match, index: start + i }));
  };
  return (
    <Show when={state().open}>
      <View class="absolute inset-0 z-50 flex-col items-center p-4" style={{ bgColor: "#000000A0" }}>
        <View class="flex-col gap-2 p-3 rounded-xl w-full max-w-[520] mt-[48]" style={{ bgColor: C.panel, borderColor: C.border, borderWidth: 1 }}>
          <Text class="text-sm font-bold" style={{ textColor: C.text }}>快速打开</Text>
          <InputField autoFocus value={() => state().query} onInput={(v) => props.quickOpen.setQuery(v)} onSubmit={() => void props.quickOpen.accept()} placeholder="输入文件名，例如 src/app" />
          <Show when={state().results.length === 0}><Text class="text-xs" style={{ textColor: C.muted }}>没有匹配的文件</Text></Show>
          <For each={window()}>{(row) => (
            <Focusable class={row.index === state().selected ? "px-2 py-1 rounded bg-[#27272A] flex-row gap-2" : "px-2 py-1 rounded flex-row gap-2"} onPress={() => void props.quickOpen.accept(row.index)}>
              <Text class="text-sm text-[#FAFAFA]">{basename(row.match.path)}</Text>
              <Text class="text-xs" style={{ textColor: C.faint }}>{dirname(row.match.path)}</Text>
            </Focusable>
          )}</For>
          <Text class="text-xs" style={{ textColor: C.faint }}>↑↓ 选择 · Enter 打开 · Esc 关闭</Text>
        </View>
      </View>
    </Show>
  );
}
