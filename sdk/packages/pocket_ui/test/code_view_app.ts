/** Guest app source for the CodeView native tests (written into a buildGuest project as app.tsx). */
export function codeViewApp(cfg: Record<string, unknown> = {}): string {
  return `
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
import { CodeView } from "@pocket/ui/code-view";
import { CodeEditor } from "@pocket/ui/code";
import { inlineFontSlot } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketClipboardClient } from "@pocket/ui/clipboard";
import { subscribeHostEvents } from "@pocket/ui/display";
import { buildCorpus } from "./code_corpus.ts";

const emit = (name: string, payload: any) => (globalThis as any).pocket._emitValue({ type: "event", name, payload });
const cfg: any = ${JSON.stringify(cfg)};
const lines = cfg.lines ?? 5000;
const text = cfg.text ?? buildCorpus(lines);
const editor = new CodeEditor(text, { platform: "mac" });
const host = createHostBridge();
const debug: any = {};
let handle: any;
subscribeHostEvents((ev: any) => {
  if (ev.method === "test.dump") {
    const sel = editor.selection.ranges[editor.selection.primary];
    emit("cv.dump", { debug: { ...handle.debug }, anchor: sel.anchor, head: sel.head, length: editor.buffer.length, lineCount: editor.buffer.lineCount,
      lines: ev.params.lines ? (ev.params.lines as number[]).map((l: number) => editor.buffer.line(l)) : undefined, marked: editor.marked,
      find: { label: handle.find.label(), q: handle.find.query, n: handle.find.matches.length } });
  } else if (ev.method === "test.scrollTo") handle.scrollToLine(ev.params.line as number);
  else if (ev.method === "test.setDiagnostics") setDiag(ev.params.list as any);
});
import { createSignal } from "solid-js";
const [diag, setDiag] = createSignal<any[]>(cfg.diagnostics ?? []);
mount(() => <View class="w-full h-full" style={{ width: 480, height: 640 }}>
  <CodeView editor={editor} path={cfg.path ?? "app.tsx"} theme={cfg.theme ?? "dark"} fontSlot={inlineFontSlot("body")} debug={debug} diagnostics={diag()}
    clipboard={cfg.noClipboard ? undefined : createPocketClipboardClient(host)} readOnly={cfg.readOnly}
    onIntent={(i: any) => { emit("cv.intent", i); }}
    onCursorChange={(c: any) => emit("cv.cursor", c)}
    ref={(h: any) => { handle = h; }} />
</View>);
`;
}
