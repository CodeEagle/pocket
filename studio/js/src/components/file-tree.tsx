import { For, Show } from "solid-js";
import { MobileButton, ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { buildTree, visibleRows } from "../tree.ts";
import { dirname } from "../lib/path.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty } from "../state/workspace.ts";

/** Project tree with the create / rename / delete actions for the selected entry. */
export function FileTree(props: { studio: Studio }) {
  const ws = props.studio.workspace;
  const state = fromStore(ws.store);
  const rows = () => visibleRows(buildTree(state().files, state().emptyFolders), state().expanded);
  const dirtyPaths = () => new Set(state().docs.filter(isDirty).map((d) => d.path));
  const targetDir = () => {
    const s = state();
    if (!s.selected) return "";
    return s.selectedKind === "directory" ? s.selected : dirname(s.selected);
  };
  return (
    <View class="flex-col gap-2 flex-1">
      <View class="flex-row gap-1 flex-wrap">
        <MobileButton label="+ 文件" compact kind="tonal" onPress={() => void ws.createFile(targetDir())} />
        <MobileButton label="+ 文件夹" compact kind="tonal" onPress={() => void ws.createFolder(targetDir())} />
      </View>
      <View class="flex-row gap-1 flex-wrap">
        <MobileButton label="重命名" compact kind="text" disabled={!state().selected || state().selectedKind !== "file"} onPress={() => state().selected && void ws.rename(state().selected!)} />
        <MobileButton label="删除" compact kind="text" disabled={!state().selected} onPress={() => state().selected && void ws.remove(state().selected!)} />
        <MobileButton label="刷新" compact kind="text" onPress={() => void ws.refreshTree()} />
      </View>
      <Show when={state().treeLoading}><Text class="text-xs" style={{ textColor: C.muted }}>正在加载文件…</Text></Show>
      <ScrollablePage>
        <View class="flex-col w-full">
          <For each={rows()}>{(row) => (
            <Focusable
              class={state().selected === row.node.path ? "py-1 rounded bg-[#27272A]" : "py-1 rounded"}
              style={{ marginL: row.depth * 14 }}
              onPress={() => row.node.kind === "directory" ? ws.toggleFolder(row.node.path) : void ws.open(row.node.path)}
            >
              <Text class="text-sm text-[#FAFAFA]">{row.node.kind === "directory"
                ? `${row.expanded ? "▾" : "▸"} ${row.node.name}`
                : `${row.node.name}${dirtyPaths().has(row.node.path) ? " ●" : ""}`}</Text>
            </Focusable>
          )}</For>
        </View>
      </ScrollablePage>
    </View>
  );
}
