import { Show } from "solid-js";
import { MobileButton } from "@pocket/ui";
import { Tree } from "@pocket/ui/tree";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { dirname } from "../lib/path.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty } from "../state/workspace.ts";

/** Project tree with the create / rename / delete actions for the selected entry. */
export function FileTree(props: { studio: Studio }) {
  const ws = props.studio.workspace;
  const state = fromStore(ws.store);
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
      <Tree
        files={state().files} directories={state().emptyFolders} expanded={state().expanded} selected={state().selected} marked={dirtyPaths()}
        onOpenFile={(path) => void ws.open(path)} onToggleFolder={(path) => ws.toggleFolder(path)}
      />
    </View>
  );
}
