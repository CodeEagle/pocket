/**
 * Retained native video composition.
 *
 * `Video` is deliberately a thin JS composition helper: Flutter owns the
 * decoder/controller and `MediaController` owns playback policy. The stable
 * id is used for both the native surface package and media registration so an
 * asset update changes one retained surface instead of creating another
 * identity.
 */

import { CompositorSurface, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { MediaController, MediaRegistration } from "./media.ts";

type VideoSurfaceBridge = {
  registerSurface?: (packageId: string, kind: "video", payload: string) => unknown;
  releaseSurface?: (packageId: string) => void;
};

const videoGlobal = globalThis as typeof globalThis & { pocket?: VideoSurfaceBridge };

export type VideoFit = "cover" | "contain" | "fill";

export interface VideoProps {
  /** Stable lifecycle identity. It must not be reused for a different item while mounted. */
  id: string;
  /** Asset key resolved by Flutter's configured package source. */
  asset: string;
  /** Policy controller shared with the page/feed owner. */
  media: MediaController;
  group?: string;
  page?: string;
  active?: boolean;
  playing?: boolean;
  fit?: VideoFit;
  class?: string;
  style?: ViewProps["style"];
}

function stableVideoId(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Video id must be a non-empty stable string");
  }
  return value;
}

/**
 * Compose the official retained `CompositorSurface` with the host's video
 * provider. No private `_register` API or JS decoder is involved.
 */
export function Video(props: VideoProps): JSX.Element {
  const id = stableVideoId(props.id);
  const registration: MediaRegistration = props.media.register(id, {
    group: props.group,
    page: props.page,
    active: props.active !== false,
    playing: props.playing === true,
  });
  const [registered, setRegistered] = createSignal(false);
  const payload = createMemo(() => JSON.stringify({
    asset: props.asset,
    fit: props.fit ?? "cover",
    // The media controller is the sole source of playback intent.  Native
    // video surfaces retain a legacy autoplay default for older callers, so
    // this component must always make its policy explicit.
    autoplay: false,
  }));
  // A provider may reject this id because it is host-owned, or reject an
  // update because its payload is invalid.  Only a successful registration
  // gives this component release ownership; cleanup must never probe/release
  // an id it did not acquire.
  let releaseOwnedSurface: (() => void) | undefined;
  const surfaceStyle = createMemo(() => {
    const radius = props.style?.radius;
    return radius === undefined ? undefined : { radius };
  });

  const register = (nextPayload: string): void => {
    const provider = videoGlobal.pocket;
    const registerSurface = provider?.registerSurface;
    if (typeof registerSurface !== "function") {
      setRegistered(false);
      return;
    }
    try {
      // The native bridge updates the existing handle in place when `id`
      // remains stable, including when the asset or fit changes.
      const ok = registerSurface(id, "video", nextPayload) !== false;
      if (
        ok &&
        releaseOwnedSurface === undefined &&
        typeof provider?.releaseSurface === "function"
      ) {
        const owner = provider;
        releaseOwnedSurface = () => owner.releaseSurface?.(id);
      }
      setRegistered(ok);
    } catch {
      // A missing provider is a local unsupported-surface state. The decoder
      // error path is reported by Flutter's `video.state` diagnostics instead
      // of taking down the guest tree.
      setRegistered(false);
    }
  };

  createEffect(() => {
    const nextPayload = payload();
    register(nextPayload);
  });

  // Keep policy and native surface lifetimes tied to this retained node. The
  // explicit pause in `dispose()` preserves the JS intent boundary before the
  // native handle is released by the same cleanup turn.
  createEffect(() => {
    registration.setActive(props.active !== false);
  });
  createEffect(() => {
    if (props.playing === true) registration.play();
    else registration.pause();
  });

  onCleanup(() => {
    registration.dispose();
    const release = releaseOwnedSurface;
    releaseOwnedSurface = undefined;
    if (release) {
      try { release(); } catch { /* a foreign/retired provider owns this id */ }
    }
  });

  return (
    <View class="relative overflow-hidden">
      <View class={props.class} style={props.style}>
        <Show
          when={registered()}
          fallback={
            <View class="absolute inset-0 flex-col items-center justify-center bg-[#EEF1F6]" style={surfaceStyle()}>
              <Text class="text-xs text-[#7C8799]">Video unavailable</Text>
            </View>
          }
        >
          <CompositorSurface package={id} class="absolute inset-0" style={surfaceStyle()} />
        </Show>
      </View>
    </View>
  );
}

