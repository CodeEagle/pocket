import { createRenderEffect, type JSX } from "solid-js";
import { getOps } from "@pocketjs/framework/solid";
import { Image, type ImageProps, type NodeMirror } from "@pocketjs/framework/solid/components";

export interface NovelMeshViewProps extends Pick<ImageProps, "class" | "style" | "debugName"> {
  /** Ordinary PAK image key, uploaded once by the native host. */
  src: string;
  /** PMS1 local-pixel geometry. Pass a new value/version for reactive updates. */
  geometry: Uint8Array;
  version?: number;
  onNode?: (id: number) => void;
}

/** Uses the existing image node's transforms, clipping and paint order.
 * Geometry ownership is the node's; the PAK texture remains borrowed.
 * No raster fallback is provided for hosts missing the mesh extension. */
export function NovelMeshView(props: NovelMeshViewProps): JSX.Element {
  let node: NodeMirror | undefined;
  const result = <Image class={props.class} style={props.style} debugName={props.debugName} ref={value => { node = value; props.onNode?.(value.id); }} />;
  createRenderEffect(() => {
    const ops = getOps() as ReturnType<typeof getOps> & {
      __textures?: Record<string, number>;
      setMesh?(id: number, texture: number, data: Uint8Array): boolean;
    };
    props.version;
    const geometry = props.geometry;
    if (!ops.setMesh) throw new Error("Pocket host does not support retained meshes");
    const texture = ops.__textures?.[props.src];
    if (texture === undefined) throw new Error(`Mesh image is not registered in the native PAK: ${props.src}`);
    if (!node || !ops.setMesh(node.id, texture, geometry)) throw new Error("Pocket refused invalid or over-budget mesh geometry");
  });
  return result;
}
