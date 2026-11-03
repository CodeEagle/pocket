import { For, createSignal, onCleanup, type JSX } from "solid-js";
import { CompositorSurface } from "@pocketjs/framework/solid/components";
import type { PocketSystemKernel } from "./system.ts";

/** Render the JS kernel's presentation with the official retained primitive.
 * The consumer chooses geometry, clipping and sibling overlays in JS. */
export function SystemAppSurfaces(props: {
  system: Pick<PocketSystemKernel, "surfaceBindings" | "subscribe">;
  /** A SystemUI modal can take input focus while the child surface remains visible. */
  systemUIFocused?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
}): JSX.Element {
  const [bindings, setBindings] = createSignal(props.system.surfaceBindings());
  const unsubscribe = props.system.subscribe(() => setBindings(props.system.surfaceBindings()));
  onCleanup(unsubscribe);
  return <For each={bindings()}>{binding =>
    <CompositorSurface package={binding.appId}
      focused={binding.focused && !props.systemUIFocused}
      class={props.class ?? "absolute inset-0 w-full h-full"} style={props.style} />
  }</For>;
}
