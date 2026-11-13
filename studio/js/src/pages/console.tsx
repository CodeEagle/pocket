import { For, Show, createSignal } from "solid-js";
import { MobileButton, ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";

const PAGE_LINES = 150;

/** Build control, the streamed log (bounded ring buffer) and clickable diagnostics. */
export function ConsolePage(props: { studio: Studio }) {
  const s = props.studio;
  const build = fromStore(s.build.store);
  const [window, setWindow] = createSignal(PAGE_LINES);
  const lines = () => { build(); return s.build.tail(window()); };
  const size = () => { build(); return s.build.logSize(); };
  const status = () => {
    const b = build();
    if (b.busy) return "构建中";
    if (b.error) return "失败";
    const st = b.status;
    if (st && st.builtRevision !== null && st.builtRevision === st.revision) return "已构建（最新）";
    if (st && st.builtRevision !== null) return "已构建（源码已更改）";
    return "尚未构建";
  };
  const open = (file: string, line: number, column: number) => {
    if (!file) return;
    s.setPage("source");
    void s.workspace.open(file, { line, column });
  };
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">控制台</Text>
        <Text class="text-xs" style={{ textColor: build().error ? C.danger : build().busy ? C.warn : C.ok }}>{status()}</Text>
        <Text class="text-xs" style={{ textColor: C.faint }}>{build().stream === "open" ? "事件流已连接" : build().stream === "retrying" ? "事件流重连中…" : build().stream === "connecting" ? "事件流连接中…" : ""}</Text>
      </View>
      <View class="flex-row items-center gap-2">
        <MobileButton label={build().busy ? "构建中…" : "开始构建"} compact disabled={build().busy || !build().project} onPress={() => void s.build.start()} />
        <MobileButton label="取消" compact kind="outlined" disabled={!build().busy} onPress={() => void s.build.cancel()} />
        <MobileButton label="清空日志" compact kind="text" onPress={() => s.build.clearLogs()} />
      </View>
      <Show when={build().error}><Text class="text-xs" style={{ textColor: C.danger }}>{build().error}</Text></Show>
      <Show when={build().diagnostics.length > 0}>
        <View class="flex-col gap-1 p-2 rounded-lg bg-[#18181B]">
          <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`诊断（${build().diagnostics.length}）· 点击跳转到源码`}</Text>
          <For each={build().diagnostics.slice(0, 20)}>{(d) => (
            <Focusable class="py-1" onPress={() => open(d.file, d.line, d.column)}>
              <Text class="text-xs" style={{ textColor: d.severity === "warning" ? C.warn : C.danger }}>{`${d.file || "(项目)"}:${d.line}:${d.column}  ${d.message}`}</Text>
            </Focusable>
          )}</For>
        </View>
      </Show>
      <Text class="text-xs" style={{ textColor: C.muted }}>{`构建日志 · 显示最近 ${Math.min(window(), size())} / ${size()} 行（缓冲上限 2000）`}</Text>
      <ScrollablePage>
        <View class="flex-col w-full">
          <Show when={size() > window()}>
            <MobileButton label="显示更早的日志" compact kind="text" onPress={() => setWindow(window() + PAGE_LINES)} />
          </Show>
          <Show when={size() === 0}><Text class="text-xs" style={{ textColor: C.faint }}>暂无日志。</Text></Show>
          <For each={lines()}>{(line) => (
            <Text class="text-xs" style={{ textColor: line.gap ? C.warn : C.body }}>{line.text.length ? line.text : " "}</Text>
          )}</For>
        </View>
      </ScrollablePage>
    </View>
  );
}
