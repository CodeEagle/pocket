import { For, Show, onMount } from "solid-js";
import { MobileButton, MobileSegmentedControl, MobileSwitch, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { DEBOUNCE_CHOICES } from "../state/settings.ts";
import { C } from "../ui/theme.ts";
import { Line, Panel } from "../components/info.tsx";
import { helpRows } from "../keymap.ts";
import type { Studio } from "../state/studio.ts";

export function SettingsPage(props: { studio: Studio }) {
  const s = props.studio;
  const settings = fromStore(s.settings.store);
  const preview = fromStore(s.preview.store);
  const update = fromStore(s.selfUpdate.store);
  onMount(() => { void s.selfUpdate.load(); });
  return (
    <View class="flex-col gap-3 p-4 flex-1">
      <Text class="text-xl text-[#FAFAFA] font-bold">设置</Text>
      <ScrollablePage>
      <View class="flex-col gap-3 w-full">
      <MobileSwitch label="保存后自动构建并刷新预览" value={settings().autoBuild} onChange={(v: boolean) => void s.settings.set({ autoBuild: v })} />
      <Text class="text-xs" style={{ textColor: C.muted }}>保存文件 → 构建 → 发布预览包 → 重新加载预览子应用</Text>
      <Text class="text-xs" style={{ textColor: C.muted }}>自动构建等待时间</Text>
      <MobileSegmentedControl
        items={DEBOUNCE_CHOICES.map((ms) => ({ id: String(ms), label: ms < 1000 ? `${ms} 毫秒` : `${ms / 1000} 秒` }))}
        active={String(settings().debounceMs)}
        onChange={(id) => void s.settings.set({ debounceMs: Number(id) })}
      />
      <MobileSwitch label="在“源码”页右侧显示实时预览" value={settings().dockPreview} onChange={(v: boolean) => void s.settings.set({ dockPreview: v })} />
      <Text class="text-xs" style={{ textColor: C.muted }}>编辑器</Text>
      <MobileSegmentedControl
        items={[{ id: "input", label: "多行输入框（备用）" }, { id: "code", label: "代码视图（默认）" }]}
        active={settings().editor}
        onChange={(id) => void s.settings.set({ editor: id === "code" ? "code" : "input" })}
      />
      <Text class="text-xs" style={{ textColor: settings().persistence === "unavailable" ? C.warn : C.faint }}>
        {settings().persistence === "ok" ? "设置已保存到本机。" : settings().persistence === "unavailable" ? "设置存储不可用：更改仅在本次会话有效。" : "正在读取设置…"}
      </Text>
      <Text class="text-xs" style={{ textColor: preview().runtime === "unavailable" ? C.danger : C.faint }}>
        {preview().runtime === "unavailable" ? `预览运行时不可用：${preview().runtimeMessage ?? ""}` : "预览运行时：按需初始化"}
      </Text>
      <Panel title="Studio 更新" note="Studio 通过服务的已签名测试频道更新自己；内置版本始终是后备。应用后由宿主验证签名并试运行，不健康会自动回滚。">
        <Line label="当前版本" value={update().activeVersion ? `v${update().activeVersion} · 构建 ${update().activeBuild ?? "?"}` : undefined} />
        <Line label="宿主阶段" value={update().stage} />
        <Show when={update().candidateVersion}><Line label="可用更新" value={`v${update().candidateVersion} · 构建 ${update().candidateBuild}`} tone="ok" /></Show>
        <Show when={update().lastError}><Text class="text-xs" style={{ textColor: C.warn }}>{`上次更新失败（已回滚到可用版本）：${update().lastError}`}</Text></Show>
        <Show when={update().message}><Text class="text-xs" style={{ textColor: update().phase === "error" || update().phase === "unavailable" ? C.danger : C.muted }}>{update().message}</Text></Show>
        <View class="flex-row gap-2">
          <MobileButton label="检查 Studio 更新" kind="tonal" compact disabled={update().phase === "checking" || update().phase === "applying" || update().phase === "unavailable"} onPress={() => void s.selfUpdate.check()} />
          <Show when={update().phase === "available"}><MobileButton label="应用更新" compact onPress={() => void s.selfUpdate.apply()} /></Show>
        </View>
      </Panel>
      <Panel title="键盘快捷键" note="Cmd 为主修饰键（非 macOS 为 Ctrl）。标有“编辑器”的快捷键在代码视图获得键盘时由编辑器处理，其余快捷键始终由 Studio 外壳优先处理。输入框获得焦点时按键属于输入框。">
        <For each={helpRows("mac")}>{(row) => <Line label={row.chord} value={`${row.label}${row.scope === "editor" ? "（编辑器内由编辑器处理）" : ""}`} />}</For>
      </Panel>
      </View>
      </ScrollablePage>
    </View>
  );
}
