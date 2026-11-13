import { Show, type JSX } from "solid-js";
import { MobileButton } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { C } from "../ui/theme.ts";

/** A titled panel (the Studio's card). */
export function Panel(props: { title?: string; note?: string; children: JSX.Element }) {
  return (
    <View class="flex-col gap-1 p-3 rounded-lg bg-[#18181B] w-full">
      <Show when={props.title}><Text class="text-sm font-bold" style={{ textColor: C.body }}>{props.title}</Text></Show>
      <Show when={props.note}><Text class="text-xs" style={{ textColor: C.faint }}>{props.note}</Text></Show>
      {props.children}
    </View>
  );
}

/** `label: value` with an optional copy button (hashes and URLs are copied whole, shown in full or shortened). */
export function Field(props: { label: string; value: string | number | undefined; shown?: string; copyLabel?: string; onCopy?: (text: string, label: string) => void; tone?: "ok" | "warn" | "danger" }) {
  const text = () => (props.value === undefined ? "" : String(props.value));
  return (
    <Show when={props.value !== undefined && text().length > 0}>
      <View class="flex-col w-full">
        <Text class="text-xs" style={{ textColor: C.faint }}>{props.label}</Text>
        <View class="flex-row items-center gap-2 w-full">
          <Text class="text-xs flex-1" style={{ textColor: props.tone ? C[props.tone] : C.body }}>{props.shown ?? text()}</Text>
          <Show when={props.onCopy}>
            <MobileButton label="复制" kind="text" compact onPress={() => props.onCopy!(text(), props.copyLabel ?? props.label)} />
          </Show>
        </View>
      </View>
    </Show>
  );
}

/** One short `label  value` line without a copy button. */
export function Line(props: { label: string; value: string | number | undefined; tone?: "ok" | "warn" | "danger" }) {
  return (
    <Show when={props.value !== undefined && String(props.value).length > 0}>
      <View class="flex-row gap-2 w-full">
        <Text class="text-xs" style={{ textColor: C.faint, width: 118 }}>{props.label}</Text>
        <Text class="text-xs flex-1" style={{ textColor: props.tone ? C[props.tone] : C.body }}>{String(props.value)}</Text>
      </View>
    </Show>
  );
}
