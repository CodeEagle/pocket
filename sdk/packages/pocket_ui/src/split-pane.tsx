// Resizable two-pane layout: one pane has a fixed pixel size, the other fills the rest; a drag handle
// between them resizes. Row direction only (what the editor shell needs); the handle is a pan gesture.
import { createSignal, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { Text, View, type NodeMirror } from "@pocketjs/framework/solid/components";
import { clampSplit, dragSplit, type SplitFixed } from "./split-pane-model.ts";

export * from "./split-pane-model.ts";

export interface SplitPaneProps {
  first: JSX.Element;
  second: JSX.Element;
  /** Which pane keeps the pixel size (the other one flexes). Default "first". */
  fixed?: SplitFixed;
  /** Pixel size of the fixed pane. */
  size: number;
  min?: number;
  max?: number;
  /** Called with the new clamped size while dragging. The caller stores it (and may persist it). */
  onResize: (size: number) => void;
  /** Called once when a drag that changed the size is released (persist the size here, not on every frame). */
  onResizeEnd?: (size: number) => void;
  /** Handle thickness in px (default 8). */
  handle?: number;
}

export function SplitPane(props: SplitPaneProps) {
  const fixed = (): SplitFixed => props.fixed ?? "first";
  const limits = () => ({ min: props.min ?? 120, max: props.max ?? 2000 });
  const [dragging, setDragging] = createSignal(false);
  let handleNode: NodeMirror | undefined;
  let moved = false;
  const finish = (): void => {
    setDragging(false);
    if (moved) { moved = false; props.onResizeEnd?.(clampSplit(props.size, limits())); }
  };
  createGesture({
    axis: "x",
    region: { node: () => handleNode },
    panSlop: 1,
    onDown: () => setDragging(true),
    onPanMove: (contact) => {
      if (contact.fdx === 0) return;
      const next = dragSplit(props.size, contact.fdx, fixed(), limits());
      if (next !== props.size) { moved = true; props.onResize(next); }
    },
    onUp: finish,
    onCancel: finish,
  });
  const fixedStyle = () => ({ width: clampSplit(props.size, limits()) });
  return (
    <View class="flex-row flex-1">
      {fixed() === "first" ? <View class="flex-col" style={fixedStyle()}>{props.first}</View> : <View class="flex-col flex-1">{props.first}</View>}
      <View
        ref={(node) => { handleNode = node; }}
        class={dragging() ? "items-center justify-center bg-[#3F3F46]" : "items-center justify-center bg-[#27272A]"}
        style={{ width: props.handle ?? 8 }}
      >
        <Text class="text-xs text-[#71717A]">⋮</Text>
      </View>
      {fixed() === "second" ? <View class="flex-col" style={fixedStyle()}>{props.second}</View> : <View class="flex-col flex-1">{props.second}</View>}
    </View>
  );
}
