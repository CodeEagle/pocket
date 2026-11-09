import { createMemo, Show, type JSX } from "solid-js";
import { encodeNovelMesh } from "./mesh.ts";
import { NovelMeshView, type NovelMeshViewProps } from "./mesh-view.tsx";
import { createNovelSkinFrameGeometry, createNovelSkinIconGeometry, type NovelAssetSkinFrame, type NovelAssetSkinIcons } from "./skin.ts";

export interface NovelSkinFrameProps extends Pick<NovelMeshViewProps, "style" | "debugName"> {
  /** Registered skin image plus its source-pixel dimensions and inset. */
  readonly frame: NovelAssetSkinFrame;
  /** Target image-node and PMS1 geometry width in local pixels. */
  readonly width: number;
  /** Target image-node and PMS1 geometry height in local pixels. */
  readonly height: number;
  /** Target-space border width, clamped to avoid overlapping center edges. */
  readonly border: number;
}

/** A retained-mesh background only; parent controls keep their own focus/hit targets. */
export function NovelSkinFrame(props: NovelSkinFrameProps): JSX.Element {
  const geometry = createMemo(() => encodeNovelMesh(createNovelSkinFrameGeometry(
    props.frame,
    props.width,
    props.height,
    props.border,
  )));
  return <NovelMeshView
    src={props.frame.image}
    geometry={geometry()}
    class="absolute"
    style={{ insetL: 0, insetT: 0, ...props.style, width: props.width, height: props.height, hitPass: 1 }}
    debugName={props.debugName}
  />;
}

export interface NovelSkinIconProps extends Pick<NovelMeshViewProps, "style" | "debugName"> {
  /** Registered equal-cell atlas metadata. */
  readonly atlas: NovelAssetSkinIcons;
  /** Stable atlas cell name, looked up in row-major order. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** Optional image-backed icon; unknown cells disappear without a fallback glyph. */
export function NovelSkinIcon(props: NovelSkinIconProps): JSX.Element {
  const geometry = createMemo(() => {
    const value = createNovelSkinIconGeometry(props.atlas, props.name, props.width, props.height);
    return value ? encodeNovelMesh(value) : undefined;
  });
  return <Show when={geometry()}>{data => <NovelMeshView
    src={props.atlas.image}
    geometry={data()}
    class="shrink-0"
    style={{ ...props.style, width: props.width, height: props.height, hitPass: 1 }}
    debugName={props.debugName}
  />}</Show>;
}
