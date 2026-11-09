import { createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { getOps } from "@pocketjs/framework/host";
import {
  ResourceImage,
  failed,
  pending,
  ready,
  type ResourceState,
  type TextureResource,
} from "@pocketjs/framework/resource";
import {
  View,
  type ViewProps,
} from "@pocketjs/framework/solid/components";
import type { PocketImagesClient, PocketStoredImageData } from "./images.ts";
import { PocketImagesError } from "./images.ts";

export {
  createPocketImagesClient,
  PocketImagesError,
  POCKET_IMAGE_MAX_HEIGHT,
  POCKET_IMAGE_MAX_IMG_BYTES,
  POCKET_IMAGE_MAX_PIXELS,
  POCKET_IMAGE_MAX_TEXTURE_HEIGHT,
  POCKET_IMAGE_MAX_TEXTURE_WIDTH,
  POCKET_IMAGE_MAX_WIDTH,
  type PocketImageCaptureOptions,
  type PocketImageReference,
  type PocketImagesClient,
  type PocketStoredImageData,
} from "./images.ts";

export interface PocketStoredImageProps {
  client: Pick<PocketImagesClient, "read">;
  imageId?: string | null;
  /** Visible layout box in logical pixels. The source is contained in this box. */
  width: number;
  height: number;
  class?: string;
  style?: ViewProps["style"];
  debugName?: string;
  fallback?: JSX.Element;
  onError?: (error: unknown) => void;
}

interface PreparedImageResource {
  readonly handle: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

interface DisplayImageResource extends TextureResource {
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/**
 * Read one app-private image and own its native texture for this node's life.
 * Each mount uploads one handle; no process-wide thumbnail cache is retained.
 */
export function PocketStoredImage(props: PocketStoredImageProps): JSX.Element {
  if (!Number.isFinite(props.width) || props.width <= 0 ||
      !Number.isFinite(props.height) || props.height <= 0) {
    throw new RangeError("PocketStoredImage width and height must be finite and positive");
  }

  const [resource, setResource] = createSignal(
    pending<PreparedImageResource>(),
  );
  let ownedHandle = -1;
  let generation = 0;

  const releaseTexture = () => {
    const handle = ownedHandle;
    ownedHandle = -1;
    if (handle >= 0) {
      try {
        getOps().freeTexture?.(handle);
      } catch {
        // Native cleanup is best-effort once the owning node is detached.
      }
    }
  };

  const reportError = (error: unknown) => {
    try {
      props.onError?.(error);
    } catch {
      // A consumer callback must not turn a failed resource read into an
      // unhandled promise rejection.
    }
  };

  // Keep the uploaded envelope dimensions and derive its logical size from
  // the current layout box. A resize updates only geometry; it does not reread
  // or reupload the stored image.
  const displayResource = createMemo<ResourceState<DisplayImageResource>>(() => {
    const current = resource();
    if (current.status !== "ready") return current;
    const source = current.value;
    const scale = Math.min(
      props.width / source.sourceWidth,
      props.height / source.sourceHeight,
    );
    return ready({
      ...source,
      width: source.textureWidth * scale,
      height: source.textureHeight * scale,
    });
  });

  const resourceImage = ResourceImage({
    state: displayResource,
    fallback: () => props.fallback ?? null,
    errorFallback: () => props.fallback ?? null,
    get style() {
      const current = resource();
      if (current.status !== "ready") {
        return {
          posType: 1,
          insetL: 0,
          insetT: 0,
          width: props.width,
          height: props.height,
        };
      }
      const source = current.value;
      const scale = Math.min(
        props.width / source.sourceWidth,
        props.height / source.sourceHeight,
      );
      const contentWidth = source.sourceWidth * scale;
      const contentHeight = source.sourceHeight * scale;
      return {
        posType: 1,
        insetL: (props.width - contentWidth) / 2,
        insetT: (props.height - contentHeight) / 2,
        width: contentWidth,
        height: contentHeight,
        overflow: 1,
      };
    },
  });

  createEffect(() => {
    const id = props.imageId;
    const client = props.client;
    const requestGeneration = ++generation;
    setResource(pending<PreparedImageResource>());
    releaseTexture();
    if (!id) return;

    let readPromise: Promise<PocketStoredImageData>;
    try {
      readPromise = client.read(id);
    } catch (error) {
      setResource(failed(error));
      reportError(error);
      return;
    }
    void readPromise.then((loaded) => {
      if (requestGeneration !== generation) return;
      const ops = getOps();
      if (typeof ops.uploadImgEntry !== "function" || typeof ops.freeTexture !== "function") {
        throw new PocketImagesError("image_texture_unsupported", "This host cannot own dynamic image textures");
      }
      const handle = ops.uploadImgEntry(loaded.img);
      if (handle < 0) {
        throw new PocketImagesError("image_upload_failed", "Native host rejected the IMG entry");
      }
      if (requestGeneration !== generation) {
        ops.freeTexture(handle);
        return;
      }
      ownedHandle = handle;
      setResource(ready({
        handle,
        textureWidth: loaded.textureWidth,
        textureHeight: loaded.textureHeight,
        sourceWidth: loaded.width,
        sourceHeight: loaded.height,
      }));
    }).catch((error: unknown) => {
      if (requestGeneration !== generation) return;
      releaseTexture();
      setResource(failed(error));
      reportError(error);
    });
  });

  onCleanup(() => {
    generation++;
    setResource(pending<PreparedImageResource>());
    releaseTexture();
  });

  const containerStyle = (): NonNullable<ViewProps["style"]> => ({
    ...props.style,
    width: props.width,
    height: props.height,
    overflow: 1,
  });

  return (
    <View class={props.class} debugName={props.debugName} style={containerStyle()}>
      {resourceImage}
    </View>
  );
}
