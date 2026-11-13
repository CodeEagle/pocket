// The live preview: the signed child `dev.pocket.studio.preview` composited by
// the official CompositorSurface. At most one instance of this component is
// mounted at a time (the Source page's dock or the Preview page), because the
// host maps the child's surface handle to one slot.
import { Show, onCleanup } from "solid-js";
import { CompositorSurface, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore, select } from "../ui/bind.ts";
import { PREVIEW_APP_ID } from "../state/preview.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";

export const PREVIEW_PHASE_LABEL = {
  idle: "尚未运行预览", building: "构建中", publishing: "发布中", loading: "加载中", running: "运行中", error: "出错",
} as const;

export function PreviewSurface(props: { studio: Studio }) {
  const s = props.studio;
  s.preview.setSurfaceVisible(true);
  onCleanup(() => s.preview.setSurfaceVisible(false));
  const preview = fromStore(s.preview.store);
  const modal = select(s.dialogs.store, (d) => d.active !== undefined);
  return (
    <View class="flex-1 rounded-lg bg-[#000000]">
      <CompositorSurface package={PREVIEW_APP_ID} focused={!modal()} class="absolute inset-0 w-full h-full" />
      <Show when={preview().phase !== "running"}>
        <View class="absolute left-[8] right-[8] top-[8] flex-col gap-1 p-2 rounded-lg" style={{ bgColor: "#18181B" }}>
          <Text class="text-xs font-bold" style={{ textColor: preview().phase === "error" ? C.danger : C.body }}>{`预览：${PREVIEW_PHASE_LABEL[preview().phase]}`}</Text>
          <Show when={preview().message}><Text class="text-xs" style={{ textColor: C.muted }}>{preview().message}</Text></Show>
        </View>
      </Show>
    </View>
  );
}
