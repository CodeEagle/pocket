import { For, Show } from "solid-js";
import { InputField, MobileButton, MobileDialog, MobileListTile, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import type { Studio } from "../state/studio.ts";

export function ProjectsPage(props: { studio: Studio }) {
  const p = props.studio.projects;
  const state = fromStore(p.store);
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">项目</Text>
        <MobileButton label="+ 新建项目" compact onPress={() => p.setCreateOpen(true)} />
        <MobileButton label="刷新" kind="text" compact onPress={() => void p.refresh()} />
      </View>
      <Show when={state().loaded && state().list.length === 0}><Text class="text-sm text-[#A1A1AA]">暂无项目</Text></Show>
      <Show when={!state().loaded}><Text class="text-sm text-[#A1A1AA]">正在加载项目…</Text></Show>
      <ScrollablePage>
        <View class="flex-col gap-2 w-full">
          <For each={state().list}>{(project) => (
            <MobileListTile
              title={project.title || project.name || project.id}
              detail={`${project.id} · ${project.appId} · ${project.template === "game" ? "游戏" : "应用"}`}
              selected={state().current === project.id}
              onPress={() => void p.open(project.id)}
            />
          )}</For>
        </View>
      </ScrollablePage>
    </View>
  );
}

/** Rendered once by the shell so it overlays every page. */
export function CreateProjectDialog(props: { studio: Studio }) {
  const p = props.studio.projects;
  const state = fromStore(p.store);
  const set = (key: "id" | "name" | "appId", value: string) => p.setDraft({ ...state().draft, [key]: value });
  return (
    <MobileDialog open={() => state().createOpen} title="新建 SDK 项目" confirmLabel="创建项目" cancelLabel="取消" onClose={() => p.setCreateOpen(false)} onConfirm={() => void p.create()}>
      <MobileSegmentedControl
        items={[{ id: "app", label: "应用" }, { id: "game", label: "游戏" }]}
        active={state().draft.template}
        onChange={(id) => p.setDraft({ ...state().draft, template: id === "game" ? "game" : "app" })}
      />
      <Text class="text-xs text-[#A1A1AA]">文件夹 ID</Text>
      <InputField value={() => state().draft.id} onInput={(v) => set("id", v)} placeholder="my-pocket-app" />
      <Text class="text-xs text-[#A1A1AA]">显示名称</Text>
      <InputField value={() => state().draft.name} onInput={(v) => set("name", v)} />
      <Text class="text-xs text-[#A1A1AA]">应用 ID</Text>
      <InputField value={() => state().draft.appId} onInput={(v) => set("appId", v)} />
    </MobileDialog>
  );
}
