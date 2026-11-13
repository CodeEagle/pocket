import { Show } from "solid-js";
import { MobileButton, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { FileTree } from "../components/file-tree.tsx";
import { Tabs } from "../components/tabs.tsx";
import { PreviewSurface, PREVIEW_PHASE_LABEL } from "../components/preview-surface.tsx";
import { resolveEditor, type EditorPaneProps } from "../components/editor-pane.tsx";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty } from "../state/workspace.ts";

/** Editor pane for the active document: banners, then the swappable editor widget. */
function ActiveEditor(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const doc = () => ws().docs.find((d) => d.path === ws().active);
  // A component (not a call in JSX) so edits update props instead of recreating the editor widget.
  const Editor = (p: EditorPaneProps) => resolveEditor(settings().editor).pane(p);
  const own = () => build().diagnostics.filter((d) => d.file === doc()?.path);
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
            <ScrollablePage>
              <Editor path={d().path} text={d().text} onChange={(t) => s.workspace.setText(d().path, t)} onSave={() => void s.workspace.save(d().path)} diagnostics={own()} jump={d().jump} />
            </ScrollablePage>
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
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col" style={{ width: 240 }}><FileTree studio={s} /></View>
        <View class="flex-col gap-2 flex-1">
          <Tabs studio={s} />
          <ActiveEditor studio={s} />
        </View>
        <Show when={settings().dockPreview && project()}>
          <View class="flex-col gap-1" style={{ width: 300 }}>
            <Text class="text-xs font-bold" style={{ textColor: C.muted }}>实时预览</Text>
            <PreviewSurface studio={s} />
          </View>
        </Show>
      </View>
    </View>
  );
}
