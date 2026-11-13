import { For } from "solid-js";
import { MobileSegmentedControl, MobileSwitch } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { DEBOUNCE_CHOICES } from "../state/settings.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";

export function SettingsPage(props: { studio: Studio }) {
  const s = props.studio;
  const settings = fromStore(s.settings.store);
  const preview = fromStore(s.preview.store);
  return (
    <View class="flex-col gap-3 p-4 flex-1">
      <Text class="text-xl text-[#FAFAFA] font-bold">设置</Text>
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
        items={[{ id: "input", label: "多行输入框" }, { id: "code", label: "代码视图（即将推出）" }]}
        active={settings().editor}
        onChange={(id) => void s.settings.set({ editor: id === "code" ? "code" : "input" })}
      />
      <Text class="text-xs" style={{ textColor: settings().persistence === "unavailable" ? C.warn : C.faint }}>
        {settings().persistence === "ok" ? "设置已保存到本机。" : settings().persistence === "unavailable" ? "设置存储不可用：更改仅在本次会话有效。" : "正在读取设置…"}
      </Text>
      <Text class="text-xs" style={{ textColor: preview().runtime === "unavailable" ? C.danger : C.faint }}>
        {preview().runtime === "unavailable" ? `预览运行时不可用：${preview().runtimeMessage ?? ""}` : "预览运行时：按需初始化"}
      </Text>
    </View>
  );
}
