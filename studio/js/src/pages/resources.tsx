import { For, Show } from "solid-js";
import { MobileButton, MobileListTile, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { extension } from "../lib/path.ts";
import type { Studio } from "../state/studio.ts";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

/**
 * Asset browser. The service lists `assets/` and reports name, size and
 * modification time (studio.fs.stat). Asset BYTES are not readable through any
 * studio capability (the chunk route refuses `assets/`), and the SDK has no
 * guest-side decoder for arbitrary PNG/JPEG bytes, so an image preview is not
 * available and is reported as such rather than faked. Adding new binary
 * assets needs a file-dialog capability (out of scope); text files are created
 * and replaced from the Source page (chunked upload above 192 KiB).
 */
export function ResourcesPage(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const asset = () => ws().asset;
  const kb = (n: number) => (n < 1024 ? `${n} 字节` : `${(n / 1024).toFixed(1)} KiB`);
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`资源 · ${ws().project ?? "请选择项目"}`}</Text>
        <MobileButton label="刷新" kind="text" compact onPress={() => void s.workspace.refreshTree()} />
      </View>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col flex-1">
          <Show when={ws().project && ws().assets.length === 0}><Text class="text-sm" style={{ textColor: C.muted }}>assets/ 中还没有资源。</Text></Show>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={ws().assets}>{(name) => (
                <MobileListTile title={name} detail={IMAGE_EXTENSIONS.includes(extension(name)) ? "图片" : "文件"} selected={asset()?.name === name} onPress={() => void s.workspace.selectAsset(name)} />
              )}</For>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-2" style={{ width: 340 }}>
          <Show when={asset()} fallback={<Text class="text-sm" style={{ textColor: C.muted }}>选择资源以查看信息。</Text>}>
            {(a) => (
              <View class="flex-col gap-1 p-3 rounded-lg bg-[#18181B]">
                <Text class="text-sm font-bold" style={{ textColor: C.text }}>{a().name}</Text>
                <Text class="text-xs" style={{ textColor: C.muted }}>{a().path}</Text>
                <Show when={a().bytes !== undefined}><Text class="text-xs" style={{ textColor: C.body }}>{`大小：${kb(a().bytes!)}`}</Text></Show>
                <Show when={a().mtimeMs !== undefined}><Text class="text-xs" style={{ textColor: C.body }}>{`修改时间：${new Date(a().mtimeMs!).toISOString().replace("T", " ").slice(0, 19)} UTC`}</Text></Show>
                <Show when={a().error}><Text class="text-xs" style={{ textColor: C.danger }}>{a().error}</Text></Show>
                <Text class="text-xs" style={{ textColor: C.warn }}>{IMAGE_EXTENSIONS.includes(extension(a().name)) ? "预览不可用：Studio 能力不提供资源字节，且 SDK 没有 PNG/JPEG 解码器。" : "预览不可用：此类型不可预览。"}</Text>
              </View>
            )}
          </Show>
          <Text class="text-xs" style={{ textColor: C.faint }}>上传新资源需要文件选择器能力（不在本里程碑范围）。文本文件可在“源码”页创建或替换。</Text>
        </View>
      </View>
    </View>
  );
}
