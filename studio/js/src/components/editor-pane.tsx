// The editor widget is swappable and selected by the `editor` setting. "input" is the M2 multi-line
// InputField (a controlled pane: it shows `text` and reports edits through `onChange`). "code" is the
// Pocket-native CodeView over a CodeEditor buffer that the workspace owns per document (`buffer`):
// the buffer is the live text, `onChange` is not used and dirty/save read the buffer version.
import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { InputField, inlineFontSlot } from "@pocket/ui";
import { CodeView, type CodeViewHandle } from "@pocket/ui/code-view";
import { single, type CodeEditor } from "@pocket/ui/code";
import { after } from "@pocketjs/framework/clock";
import { Text, View } from "@pocketjs/framework/solid/components";
import { C, CODE_THEME } from "../ui/theme.ts";
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
  /** Code pane only: the workspace-owned buffer of a document (created on first use, kept across tab switches). */
  buffer?: (path: string) => CodeEditor;
  /** Code pane only: incremented when the buffer was replaced from outside (external reload). */
  reload?: number;
  /** Code pane only: system clipboard client (`clipboard.*` capabilities); without it an internal clipboard is used. */
  clipboard?: { readText(): Promise<string | null>; writeText(text: string): Promise<void> };
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

const lastLine = new Map<string, number>();

/** One CodeView over the document's buffer. Keyed by path by the caller, so a tab switch builds a fresh view over that tab's buffer. */
function CodeSurface(props: EditorPaneProps & { path: string }): JSX.Element {
  const editor = props.buffer!(props.path);
  let handle: CodeViewHandle | undefined;
  const [cursor, setCursor] = createSignal({ line: 0, column: 0 });
  const lines = (): number => editor.buffer.lineCount;
  // Diagnostics are 1-based in the build output, 0-based in CodeView.
  const marks = () => props.diagnostics.map((d) => ({ line: d.line - 1, column: d.column - 1, severity: d.severity, message: d.message }));
  const goTo = (target: { line: number; column: number }): void => {
    if (!handle) return;
    const b = editor.buffer;
    const line = Math.min(Math.max(target.line - 1, 0), b.lineCount - 1);
    const column = Math.min(Math.max(target.column - 1, 0), b.lineLength(line));
    editor.setSelection(single(b.offsetAt(line, column)));
    handle.scrollToLine(Math.max(0, line - 5)); // context above the target line
    handle.refresh(); // repaint and keep the caret in view
    handle.focus(); // open the raw key/IME session so typing continues at the caret
  };
  let applied = 0;
  const jumpNow = (): void => {
    const jump = props.jump;
    if (jump && jump.seq !== applied) { applied = jump.seq; goTo(jump); }
  };
  // The first layout measurement happens after mount: wait a moment before revealing, then follow live jumps.
  after(0.1, () => {
    if (!props.jump && lastLine.has(props.path) && handle) handle.scrollToLine(Math.max(0, lastLine.get(props.path)! - 8)); // tab switch: back where this file was
    jumpNow();
  });
  createEffect(on(() => props.jump?.seq, () => { if (handle) jumpNow(); }, { defer: true }));
  // The buffer was replaced from outside (undoable edit): repaint from the buffer.
  createEffect(on(() => props.reload, () => handle?.refresh(), { defer: true }));
  return (
    <View class="flex-col flex-1 w-full gap-1">
      <View class="flex-1 w-full">
        <CodeView
          editor={editor} path={props.path} theme={CODE_THEME} fontSlot={inlineFontSlot("body")}
          diagnostics={marks()} clipboard={props.clipboard}
          onIntent={(intent) => { if (intent.type === "save") props.onSave(); }}
          onCursorChange={(c) => { lastLine.set(props.path, c.line); setCursor({ line: c.line, column: c.column }); }}
          ref={(h) => { handle = h; }}
        />
      </View>
      <Text class="text-xs" style={{ textColor: C.faint }}>{`第 ${cursor().line + 1} 行，第 ${cursor().column + 1} 列 · 共 ${lines()} 行 · Cmd+S 保存 · Cmd+F 查找`}</Text>
    </View>
  );
}

/** M4 editor: CodeView over a CodeEditor buffer (syntax colours, gutter diagnostics, find/replace, undo, clipboard). */
export const CodeViewEditor: EditorPane = (props) => (
  <Show when={props.path} keyed>
    {(path) => <CodeSurface {...props} path={path} />}
  </Show>
);

/** Editor implementations by setting value. `selfScrolling` panes fill their parent and scroll themselves. */
export const editorPanes: Record<"input" | "code", { pane: EditorPane; selfScrolling: boolean }> = {
  input: { pane: InputFieldEditor, selfScrolling: false },
  code: { pane: CodeViewEditor, selfScrolling: true },
};
export const resolveEditor = (kind: "input" | "code"): { pane: EditorPane; selfScrolling: boolean } => editorPanes[kind];
