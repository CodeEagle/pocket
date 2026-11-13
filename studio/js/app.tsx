import { For, Show } from "solid-js";
import {
  InputField, MOBILE_THEME_DARK, MobileButton, MobileDialog, MobileListTile, MobileSegmentedControl,
  MobileThemeProvider, ScrollablePage,
} from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketStreamAdapter } from "@pocket/ui/streams";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createStudioClient } from "./src/studio-client.ts";
import { createStudioModel, type StudioModel, type StudioPage } from "./src/model.ts";

const railItems: ReadonlyArray<{ id: StudioPage; label: string; ready: boolean }> = [
  { id: "projects", label: "项目", ready: true },
  { id: "source", label: "源码", ready: true },
  { id: "console", label: "控制台", ready: false },
  { id: "resources", label: "资源", ready: false },
  { id: "settings", label: "设置", ready: false },
  { id: "versions", label: "版本", ready: false },
];

function Rail(props: { model: StudioModel }) {
  return (
    <View class="flex-col gap-2 p-2 bg-[#18181B]" style={{ width: 88 }}>
      <Text class="text-xs text-[#A1A1AA] font-bold">POCKET STUDIO</Text>
      <For each={railItems}>{(item) => (
        <Focusable class={props.model.page() === item.id ? "px-2 py-2 rounded-lg bg-[#27272A]" : "px-2 py-2 rounded-lg"} onPress={() => props.model.setPage(item.id)}>
          <Text class={props.model.page() === item.id ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#A1A1AA]"}>{item.label}</Text>
        </Focusable>
      )}</For>
    </View>
  );
}

function ProjectsPage(props: { model: StudioModel }) {
  const m = props.model;
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">项目</Text>
        <MobileButton label="+ 新建项目" compact onPress={() => m.setDialogOpen(true)} />
        <MobileButton label="刷新" kind="text" compact onPress={() => void m.refreshProjects()} />
      </View>
      <Show when={m.loaded() && m.projects().length === 0}><Text class="text-sm text-[#A1A1AA]">暂无项目</Text></Show>
      <Show when={!m.loaded()}><Text class="text-sm text-[#A1A1AA]">正在加载项目…</Text></Show>
      <ScrollablePage>
        <View class="flex-col gap-2 w-full">
          <For each={m.projects()}>{(project) => (
            <MobileListTile
              title={project.title || project.name || project.id}
              detail={`${project.id} · ${project.appId} · ${project.template === "game" ? "游戏" : "应用"}`}
              selected={m.current() === project.id}
              onPress={() => void m.openProject(project.id)}
            />
          )}</For>
        </View>
      </ScrollablePage>
    </View>
  );
}

function SourcePage(props: { model: StudioModel }) {
  const m = props.model;
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <Text class="text-xl text-[#FAFAFA] font-bold">源码 · {m.current() ?? "请选择项目"}</Text>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col" style={{ width: 240 }}>
          <ScrollablePage>
            <View class="flex-col w-full">
              <For each={m.rows()}>{(row) => (
                <Focusable
                  class={m.selected() === row.node.path ? "py-1 rounded bg-[#27272A]" : "py-1 rounded"}
                  style={{ marginL: row.depth * 14 }}
                  onPress={() => row.node.kind === "directory" ? m.toggleFolder(row.node.path) : void m.selectFile(row.node.path)}
                >
                  <Text class="text-sm text-[#FAFAFA]">{row.node.kind === "directory" ? `${row.expanded ? "▾" : "▸"} ${row.node.name}` : row.node.name}</Text>
                </Focusable>
              )}</For>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col flex-1">
          <Show when={m.selected()} fallback={<Text class="text-sm text-[#A1A1AA]">选择文件以查看源码（只读）。</Text>}>
            <Text class="text-xs text-[#A1A1AA]">{m.selected()} · {m.viewer()?.bytes ?? 0} 字节</Text>
            <ScrollablePage>
              <View class="flex-col w-full">
                <For each={m.viewerView()?.lines ?? []}>{(line) => <Text class="text-xs text-[#E4E4E7]">{line.length ? line : " "}</Text>}</For>
                <Show when={m.viewerView()?.truncated}><Text class="text-xs text-[#F59E0B]">… 已截断（完整编辑器将在后续里程碑提供）</Text></Show>
              </View>
            </ScrollablePage>
          </Show>
        </View>
      </View>
    </View>
  );
}

function CreateDialog(props: { model: StudioModel }) {
  const m = props.model;
  const set = (key: "id" | "name" | "appId", value: string) => m.setDraft({ ...m.draft(), [key]: value });
  return (
    <MobileDialog open={() => m.dialogOpen()} title="新建 SDK 项目" confirmLabel="创建项目" cancelLabel="取消" onClose={() => m.setDialogOpen(false)} onConfirm={() => void m.createProject()}>
      <MobileSegmentedControl
        items={[{ id: "app", label: "应用" }, { id: "game", label: "游戏" }]}
        active={m.draft().template}
        onChange={(id) => m.setDraft({ ...m.draft(), template: id === "game" ? "game" : "app" })}
      />
      <Text class="text-xs text-[#A1A1AA]">文件夹 ID</Text>
      <InputField value={() => m.draft().id} onInput={(v) => set("id", v)} placeholder="my-pocket-app" />
      <Text class="text-xs text-[#A1A1AA]">显示名称</Text>
      <InputField value={() => m.draft().name} onInput={(v) => set("name", v)} />
      <Text class="text-xs text-[#A1A1AA]">应用 ID</Text>
      <InputField value={() => m.draft().appId} onInput={(v) => set("appId", v)} />
    </MobileDialog>
  );
}

function App() {
  const host = createHostBridge();
  const streams = createPocketStreamAdapter(host);
  const model = createStudioModel(createStudioClient(host, streams));
  void model.refreshProjects();
  return (
    <MobileThemeProvider theme={() => MOBILE_THEME_DARK}>
      <Screen class="w-full h-full flex-row bg-[#09090B]">
        <Rail model={model} />
        <View class="flex-col flex-1">
          <Show when={model.notice()}><Text class="text-xs text-[#F87171] px-4 py-1">{model.notice()}</Text></Show>
          <Show when={model.page() === "projects"}><ProjectsPage model={model} /></Show>
          <Show when={model.page() === "source"}><SourcePage model={model} /></Show>
          <Show when={model.page() !== "projects" && model.page() !== "source"}>
            <Text class="text-sm text-[#A1A1AA] p-4">此功能将在后续里程碑提供。</Text>
          </Show>
        </View>
        <CreateDialog model={model} />
      </Screen>
    </MobileThemeProvider>
  );
}

mount(() => <App />);
