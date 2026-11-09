import { For, createMemo, createSignal, type JSX } from "solid-js";
import { Focusable, View } from "@pocketjs/framework/solid/components";
import { InlineText, inlineFontSlot, type InlineTextLayout, type InlineTextRun } from "@pocket/ui";
import type { NovelSayRich } from "./types.ts";

/** Color values use the Core DrawList's ABGR packing. */
const INK = 0xffd9ecf5;
const COLORS = { accent: 0xffa3e1ff, muted: 0xffb6c4c7, warning: 0xff8fb7f0 } as const;

/**
 * Core supplies both painted text and its link rectangles. This view stores
 * measured facts only; it never splits, wraps or measures another paragraph.
 */
export function NovelRichTextView(props: {
  text: string;
  rich: NovelSayRich;
  revealedCharacters: number;
  width: number;
  debugName: string;
  onLink(spanId: string): void;
  onHeight?(height: number): void;
}): JSX.Element {
  const [layout, setLayout] = createSignal<InlineTextLayout>({ width: 0, height: 0, lineCount: 0, links: [] });
  const runs = createMemo<readonly InlineTextRun[]>(() => props.rich.spans.map(span => ({
    start: span.start,
    end: span.end,
    ...(span.style?.emphasis === "strong" ? { fontSlot: inlineFontSlot("bodyBold") } : {}),
    ...(span.style?.color ? { color: COLORS[span.style.color] } : {}),
    ...(span.ruby ? { ruby: { text: span.ruby, fontSlot: inlineFontSlot("ruby"), color: COLORS.muted } } : {}),
    ...(span.link ? { linkId: span.id } : {}),
  })));
  const acceptLayout = (value: InlineTextLayout): void => {
    setLayout(value);
    props.onHeight?.(value.height);
  };
  return <View class="relative shrink-0" style={{ width: props.width }} debugName={props.debugName}>
    <InlineText source={props.text} runs={runs()} revealCodepoints={props.revealedCharacters}
      style={{ width: props.width, fontSlot: inlineFontSlot("body"), textColor: INK }} onLayout={acceptLayout} />
    <For each={layout().links}>{link => <For each={link.rects}>{(rect, index) =>
      <Focusable class="absolute" style={{ insetL: rect.x, insetT: rect.y, width: rect.width, height: rect.height }}
        debugName={`${props.debugName}-link-${link.id}-${index()}`} onPress={() => props.onLink(link.id)} />
    }</For>}</For>
  </View>;
}
