import { For, Show, type JSX } from "solid-js";
import { Image, View } from "@pocketjs/framework/solid/components";
import type {
  NovelChoiceSurfaceLayout,
  NovelChoiceSurfaceOption,
  NovelChoiceSurfaceTarget,
} from "./choice-surface.ts";

export interface NovelChoiceSurfaceViewProps<Option extends NovelChoiceSurfaceOption> {
  readonly layout: NovelChoiceSurfaceLayout<Option>;
  /** The parent supplies its existing FocusTarget, skin and choice transaction. */
  readonly renderOption: (
    option: Option,
    geometry: NovelChoiceSurfaceTarget<Option>,
    displayCaption: string,
  ) => JSX.Element;
}

/** Draws optional choice artwork and delegates each live option to the caller. */
export function NovelChoiceSurfaceView<Option extends NovelChoiceSurfaceOption>(
  props: NovelChoiceSurfaceViewProps<Option>,
): JSX.Element {
  return <View
    class="absolute inset-0 w-full h-full"
    style={{ width: props.layout.width, height: props.layout.height, hitPass: 1 }}
    debugName="vn-choice-surface"
  >
    <Show when={props.layout.image}>{image => <Image
      src={image().src}
      class="absolute"
      style={{ insetL: image().x, insetT: image().y, width: image().width, height: image().height, hitPass: 1 }}
      debugName="vn-choice-surface-art"
    />}</Show>
    <For each={props.layout.targets}>{target =>
      props.renderOption(target.option, target, target.displayCaption)
    }</For>
  </View>;
}
