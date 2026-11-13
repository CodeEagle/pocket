import { Show, createSignal } from "solid-js";
import { MobileButton, ScrollablePage } from "@pocket/ui";
import { SplitPane } from "@pocket/ui/split-pane";
import { TabsBar } from "@pocket/ui/tabs";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { FileTree } from "../components/file-tree.tsx";
import { PreviewSurface, PREVIEW_PHASE_LABEL } from "../components/preview-surface.tsx";
import { resolveEditor, type EditorPaneProps } from "../components/editor-pane.tsx";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty, MAX_INPUT_BYTES } from "../state/workspace.ts";
import { DOCK_WIDTH_LIMITS, TREE_WIDTH_LIMITS } from "../state/settings.ts";
import { basename } from "../lib/path.ts";

/** Editor pane for the active document: banners, then the swappable editor widget. */
function ActiveEditor(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const doc = () => ws().docs.find((d) => d.path === ws().active);
  // A component (not a call in JSX) so edits update props instead of recreating the editor widget.
  const Editor = (p: EditorPaneProps) => resolveEditor(settings().editor).pane(p);
  // A document opened under the code editor can exceed what the InputField can shape; say so instead of freezing it.
  const tooBigForInput = () => settings().editor === "input" && (doc()?.bytes ?? 0) > MAX_INPUT_BYTES;
  const own = () => build().diagnostics.filter((d) => d.file === doc()?.path);
  const commands = fromStore(s.commands.requests);
  return (
    <Show when={doc()} fallback={<Text class="text-sm" style={{ textColor: C.muted }}>从左侧选择文件开始编辑。</Text>}>
      {(d) => (
        <View class="flex-col gap-2 flex-1">
          <Show when={d().conflict}>
            <View class="flex-col gap-1 p-2 rounded-lg bg-[#451A03]">
              <Text class="text-xs text-[#FDE68A] font-bold">{d().conflict?.kind === "deleted" ? "此文件已在磁盘上被删除" : "此文件在磁盘上被外部修改"}</Text>
              <View class="flex-row gap-2">
                <MobileButton label="保留我的版本" compact kind="tonal" onPress={() => s.workspace.resolveConflict(d().path, "mine")} />
                <MobileButton label={d().conflict?.kind === "deleted" ? "关闭标签" : "载入磁盘版本"} compact kind="outlined" onPress={() => s.workspace.resolveConflict(d().path, "theirs")} />
              </View>
            </View>
          </Show>
          <Show when={d().status === "loading"}><Text class="text-sm" style={{ textColor: C.muted }}>正在读取…</Text></Show>
          <Show when={d().status === "blocked" || d().status === "error"}><Text class="text-sm" style={{ textColor: C.warn }}>{d().message ?? "无法打开"}</Text></Show>
          <Show when={d().status === "ready"}>
            <Text class="text-xs" style={{ textColor: C.muted }}>{`${d().path} · ${d().bytes} 字节${isDirty(d()) ? " · 未保存" : ""}${d().saving ? " · 保存中…" : ""}`}</Text>
            <Show when={!tooBigForInput()} fallback={<Text class="text-sm" style={{ textColor: C.warn }}>此文件超过多行输入框的 1 MiB 上限：请在“设置”中切换到“代码视图”编辑器。</Text>}>
              <Show
                when={resolveEditor(settings().editor).selfScrolling}
                fallback={<ScrollablePage><Editor path={d().path} text={d().text} onChange={(t) => s.workspace.setText(d().path, t)} onSave={() => void s.workspace.save(d().path)} diagnostics={own()} jump={d().jump} /></ScrollablePage>}
              >
                <View class="flex-col flex-1">
                  <Editor
                    path={d().path} text={d().text} onChange={(t) => s.workspace.setText(d().path, t)} onSave={() => void s.workspace.save(d().path)}
                    diagnostics={own()} jump={d().jump} buffer={(path) => s.workspace.editorFor(path)} reload={d().reload} clipboard={s.clipboard}
                    findRequest={commands().find} onKeyDown={(key) => s.commands.handleKey(key, { editorFocused: true })}
                  />
                </View>
              </Show>
            </Show>
          </Show>
        </View>
      )}
    </Show>
  );
}

export function SourcePage(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const preview = fromStore(s.preview.store);
  const project = () => ws().project;
  const dirtyCount = () => ws().docs.filter(isDirty).length;
  // Live sizes while a split handle is dragged; the persisted setting is written once on release.
  const [live, setLive] = createSignal<{ tree?: number; dock?: number }>({});
  const tree = () => live().tree ?? settings().treeWidth;
  const dock = () => live().dock ?? settings().dockWidth;
  const EditorColumn = () => (
    <>
      <TabsBar
        tabs={ws().docs.map((d) => ({ id: d.path, label: basename(d.path), dirty: isDirty(d) }))} active={ws().active}
        onActivate={(path) => s.workspace.activate(path)} onClose={(path) => void s.workspace.close(path)}
      />
      <ActiveEditor studio={s} />
    </>
  );
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`源码 · ${project() ?? "请选择项目"}`}</Text>
        <Show when={project()}>
          <MobileButton label={dirtyCount() > 0 ? `保存 (${dirtyCount()})` : "保存"} compact disabled={dirtyCount() === 0} onPress={() => void s.workspace.saveAll()} />
          <MobileButton label={build().busy ? "构建中…" : "构建"} compact kind="tonal" disabled={build().busy} onPress={() => void s.preview.run({ build: true })} />
          <Show when={build().busy}><MobileButton label="取消构建" compact kind="text" onPress={() => void s.build.cancel()} /></Show>
          <Text class="text-xs" style={{ textColor: settings().autoBuild ? C.ok : C.faint }}>{settings().autoBuild ? "保存后自动构建" : "手动构建"}</Text>
          <Text class="text-xs" style={{ textColor: C.muted }}>{`预览：${PREVIEW_PHASE_LABEL[preview().phase]}`}</Text>
        </Show>
      </View>
      <SplitPane
        size={tree()} min={TREE_WIDTH_LIMITS.min} max={TREE_WIDTH_LIMITS.max}
        onResize={(w) => setLive({ ...live(), tree: w })}
        onResizeEnd={(w) => { void s.settings.set({ treeWidth: w }); setLive({ ...live(), tree: undefined }); }}
        first={<FileTree studio={s} />}
        second={(
          <Show when={settings().dockPreview && project()} fallback={<View class="flex-col gap-2 flex-1 pl-2"><EditorColumn /></View>}>
            <SplitPane
              fixed="second" size={dock()} min={DOCK_WIDTH_LIMITS.min} max={DOCK_WIDTH_LIMITS.max}
              onResize={(w) => setLive({ ...live(), dock: w })}
              onResizeEnd={(w) => { void s.settings.set({ dockWidth: w }); setLive({ ...live(), dock: undefined }); }}
              first={<View class="flex-col gap-2 flex-1 px-2"><EditorColumn /></View>}
              second={(
                <View class="flex-col gap-1 pl-2">
                  <Text class="text-xs font-bold" style={{ textColor: C.muted }}>实时预览</Text>
                  <PreviewSurface studio={s} />
                </View>
              )}
            />
          </Show>
        )}
      />
    </View>
  );
}
