// The editor widget is swappable: M2 ships a multi-line InputField; the
// Pocket-native CodeView (M4) registers itself under "code" without touching
// the Source page. An EditorPane is controlled: it shows `text`, reports edits
// through `onChange`, and asks the Source page to save through `onSave`.
import { For, Show, type JSX } from "solid-js";
import { InputField } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { C } from "../ui/theme.ts";
import { excerpt, type Diagnostic } from "../lib/diagnostics.ts";
import type { JumpTarget } from "../state/workspace.ts";

export interface EditorPaneProps {
  path: string;
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
  /** Diagnostics of this file only. */
  diagnostics: readonly Diagnostic[];
  /** The line a diagnostic click asked to reveal. CodeView scrolls to it; the InputField shows the context. */
  jump?: JumpTarget;
}
export type EditorPane = (props: EditorPaneProps) => JSX.Element;

/** M2 editor: a multi-line InputField plus a context strip for the jump target and diagnostics. */
export const InputFieldEditor: EditorPane = (props) => (
  <View class="flex-col gap-2 w-full">
    <Show when={props.jump}>
      {(jump) => (
        <View class="flex-col p-2 rounded-lg bg-[#18181B] gap-1">
          <Text class="text-xs text-[#F59E0B] font-bold">{`第 ${jump().line} 行，第 ${jump().column} 列`}</Text>
          <For each={excerpt(props.text, jump().line)}>{(row) => (
            <Text class={row.number === jump().line ? "text-xs text-[#F87171]" : "text-xs text-[#A1A1AA]"}>{`${row.number}  ${row.text.length ? row.text : " "}`}</Text>
          )}</For>
        </View>
      )}
    </Show>
    <Show when={props.diagnostics.length > 0}>
      <View class="flex-col gap-1">
        <For each={props.diagnostics.slice(0, 5)}>{(d) => (
          <Text class={d.severity === "warning" ? "text-xs text-[#F59E0B]" : "text-xs text-[#F87171]"}>{`${d.line}:${d.column}  ${d.message}`}</Text>
        )}</For>
      </View>
    </Show>
    <InputField multiline minLines={12} value={() => props.text} onInput={(value) => props.onChange(value)} placeholder="空文件" />
    <Text class="text-xs" style={{ textColor: C.faint }}>Cmd/Ctrl+S 或工具栏“保存”写入磁盘</Text>
  </View>
);

/** Editor implementations by setting value. M4 adds `code`. */
export const editorPanes: Record<"input" | "code", EditorPane | undefined> = { input: InputFieldEditor, code: undefined };
export const resolveEditor = (kind: "input" | "code"): { pane: EditorPane; fellBack: boolean } => {
  const pane = editorPanes[kind];
  return pane ? { pane, fellBack: false } : { pane: InputFieldEditor, fellBack: true };
};
