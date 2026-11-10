import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { CompositorSurface, FocusScope, Text, View } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import {
  createDisplayGeometry,
  DEFAULT_SYSTEM_PRESETS,
  normalizePresentationStyle,
  type PocketSystemPresets,
} from "./display.ts";
import {
  avoidDisplayOcclusions,
  hasLocalLeftOcclusionInset,
  hasLocalRightOcclusionInset,
  reservedInsets,
} from "./responsive.ts";
import { Button } from "./ui.tsx";
import type { PocketSystemKernel, PocketSystemSurfaceBinding, PocketSystemOpeningApp } from "./system.ts";

type CloseSurface = (binding: PocketSystemSurfaceBinding) => void | Promise<void>;
type AnimateDismiss = () => Promise<void>;
type SurfaceProps = {
  system: Pick<PocketSystemKernel, "surfaceBindings" | "subscribe"> &
    Partial<Pick<PocketSystemKernel, "onBeforeDismiss" | "snapshot" | "presets">>;
  /** A SystemUI modal can take input focus while the child stays visible. */
  systemUIFocused?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
} & (
  /** Request kernel cancellation; its before-dismiss boundary runs the exit. */
  { presentation: "mini-app"; onClose: CloseSurface } |
  /** Plain surfaces retain consumer-owned multi-app geometry. */
  { presentation?: "surface"; onClose?: CloseSurface }
);

/** JS-owned presentation of the official retained compositor primitive. */
export function SystemAppSurfaces(props: SurfaceProps): JSX.Element {
  // Stack membership already belongs to the kernel. Retain those keyed
  // surfaces under the top sheet instead of unmounting a covered mini app.
  const readBindings = () => props.system.surfaceBindings({ includeStack: props.presentation === "mini-app" });
  const readPresets = (): PocketSystemPresets =>
    props.system.presets?.() ?? props.system.snapshot?.().presets ?? DEFAULT_SYSTEM_PRESETS;
  const readPresentation = () => ({
    bindings: readBindings(),
    opening: props.system.snapshot?.().opening ?? null,
    presets: readPresets(),
  });
  const [presentation, setPresentation] = createSignal(readPresentation());
  const bindings = () => presentation().bindings;
  const presets = () => presentation().presets;
  const loadingOpening = () => {
    const opening = presentation().opening;
    if (!opening) return null;
    if (opening.stage === "preparing") return opening;
    const binding = bindings().find(value => value.appId === opening.appId);
    return binding && binding.ready !== false ? null : opening;
  };
  const unsubscribe = props.system.subscribe(() => setPresentation(readPresentation()));
  onCleanup(unsubscribe);
  const dismissers = new Map<string, AnimateDismiss>();
  if (props.presentation === "mini-app") {
    if (!props.system.onBeforeDismiss) throw new Error("mini-app presentation requires the kernel dismissal boundary");
    const removeDismiss = props.system.onBeforeDismiss(async instanceIds => {
      // The kernel supplies top-to-bottom order. Each retained sheet uses the
      // same reverse timeline, including app-return and programmatic cancel.
      for (const instanceId of instanceIds) await dismissers.get(instanceId)?.();
    });
    onCleanup(removeDismiss);
  }
  return <><For each={bindings().map(binding => binding.instanceId)}>{instanceId => {
    // Kernel notifications publish fresh objects. Retain the component by ID
    // so unrelated lifecycle events cannot restart its entry animation.
    const initial = bindings().find(binding => binding.instanceId === instanceId)!;
    const binding = () => bindings().find(value => value.instanceId === instanceId) ?? initial;
    return <Show when={props.presentation === "mini-app"} fallback={
      <CompositorSurface package={binding().appId}
        focused={binding().focused && !props.systemUIFocused}
        class={props.class ?? "absolute inset-0 w-full h-full"} style={props.style} />
    }>
      <MiniAppSurface binding={binding} presets={presets} systemUIFocused={props.systemUIFocused}
        class={props.class} style={props.style} onClose={props.onClose!}
        registerDismiss={animate => {
          dismissers.set(instanceId, animate);
          return () => { if (dismissers.get(instanceId) === animate) dismissers.delete(instanceId); };
        }} />
    </Show>;
  }}</For>
    <Show when={props.presentation === "mini-app" ? loadingOpening() : null}>
      {opening => <MiniAppLoading opening={opening} />}
    </Show>
  </>;
}

/** Keep the caller visible and interactive while the existing open waits for IO. */
function MiniAppLoading(props: { opening: () => PocketSystemOpeningApp }): JSX.Element {
  const geometry = createDisplayGeometry();
  const insets = () => reservedInsets(geometry());
  return <View class="absolute left-[16] right-[16] top-[16] flex-col gap-1 p-3 rounded-lg bg-[#17233B]"
    style={{ translateY: insets().top, borderWidth: 1, borderColor: "#52636A" }}>
    <Text class="text-sm font-bold text-[#FFFFFF]">{`正在打开 ${props.opening().title ?? props.opening().appId}`}</Text>
    <Text class="text-xs text-[#D6DCE7]">{props.opening().stage === "firstFrame" ? "正在准备应用画面…" : "正在加载应用…"}</Text>
  </View>;
}

function MiniAppSurface(props: {
  binding: () => PocketSystemSurfaceBinding;
  presets?: () => PocketSystemPresets;
  systemUIFocused?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
  onClose: CloseSurface;
  registerDismiss: (animate: AnimateDismiss) => () => void;
}): JSX.Element {
  if (!props.onClose) throw new Error("mini-app presentation requires an onClose handler");
  const geometry = createDisplayGeometry();
  const width = () => Math.max(1, geometry().width || 390);
  const height = () => Math.max(1, geometry().height || 844);
  const resolvedPresentationStyle = () => normalizePresentationStyle(
    props.binding().presentationStyle,
    props.presets ? props.presets().presentationStyle : "sheet",
  );
  // Native first-frame admission needs a visible child surface. Leave 1px
  // of the full-viewport surface visible until its launch fact is ready.
  const entryOffsetY = () => Math.max(0, height() - 1);
  const entryOffsetX = () => Math.max(0, width() - 1);
  const [timeline, setTimeline] = createSignal(0);
  const [phase, setPhase] = createSignal<"preparing" | "entering" | "open" | "closing" | "waiting">(props.binding().ready === false ? "preparing" : "entering");
  const [closeFailed, setCloseFailed] = createSignal(false);
  let latchedPresentationStyle = resolvedPresentationStyle();
  const presentationStyle = () => {
    const currentPhase = phase();
    if (currentPhase !== "entering" && currentPhase !== "closing") {
      latchedPresentationStyle = resolvedPresentationStyle();
    }
    return latchedPresentationStyle;
  };
  const darkMode = () => (props.presets ? props.presets().darkMode === true : false);
  const closeStyle = () => {
    const current = geometry();
    const padding = reservedInsets(current);
    const effectiveRight = hasLocalRightOcclusionInset(current) ? 0 : padding.right;
    // Apply the effective host safe area once, then use target-only horizontal
    // avoidance so the close control stays in the top app-bar slot to the
    // right of trailing badges (e.g. Guest A / Guest B) across both folded
    // and open Duo postures and mid-side local cutouts.
    const target = { left: current.width - 52 - effectiveRight, top: 8 + padding.top, width: 44, height: 44 };
    const local = avoidDisplayOcclusions(current, target, { prefer: "horizontal" });
    return { translateX: -effectiveRight + local.offsetX, translateY: padding.top + local.offsetY };
  };
  const backStyle = () => {
    const current = geometry();
    const padding = reservedInsets(current);
    const effectiveLeft = hasLocalLeftOcclusionInset(current) ? 0 : padding.left;
    const target = { left: 8 + effectiveLeft, top: 8 + padding.top, width: 44, height: 44 };
    const local = avoidDisplayOcclusions(current, target, { prefer: "horizontal" });
    return { translateX: effectiveLeft + local.offsetX, translateY: padding.top + local.offsetY };
  };
  const closeFailedStyle = () => {
    const current = geometry();
    const padding = reservedInsets(current);
    if (presentationStyle() === "page") {
      const effectiveRight = hasLocalRightOcclusionInset(current) ? 0 : padding.right;
      return { translateX: -effectiveRight, translateY: padding.top };
    }
    const effectiveLeft = hasLocalLeftOcclusionInset(current) ? 0 : padding.left;
    return { translateX: effectiveLeft, translateY: padding.top };
  };
  const enterDuration = 420;
  const dismissDuration = 360;
  let startedAt = 0;
  let transitionFrom = 0;
  let transitionAnchored = false;
  let alive = true;
  let closeRequestPending = false;
  let pendingDismiss: { promise: Promise<void>; resolve: () => void } | undefined;
  onCleanup(() => { alive = false; pendingDismiss?.resolve(); pendingDismiss = undefined; });
  createEffect(() => {
    if (phase() === "preparing" && props.binding().ready !== false) {
      transitionFrom = 0;
      transitionAnchored = false;
      setPhase("entering");
    }
  });

  const finishClose = async (): Promise<void> => {
    closeRequestPending = true;
    try {
      await props.onClose(props.binding());
    } catch {
      if (alive) {
        setCloseFailed(true);
        setTimeline(1);
        setPhase("open");
      }
    } finally {
      closeRequestPending = false;
    }
  };
  const close = (): void => {
    if (closeRequestPending || !props.binding().focused || phase() === "preparing" || phase() === "closing" || phase() === "waiting" || props.systemUIFocused) return;
    setCloseFailed(false);
    // Request the policy operation first. The kernel calls the same animation
    // boundary for this button, guest returnResult, and programmatic cancel.
    void finishClose();
  };
  const animateDismiss = (): Promise<void> => {
    if (pendingDismiss) return pendingDismiss.promise;
    if (phase() === "waiting") return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    pendingDismiss = { promise, resolve };
    transitionFrom = timeline();
    transitionAnchored = false;
    setPhase("closing");
    return promise;
  };
  onCleanup(props.registerDismiss(animateDismiss));
  onFrame(() => {
    const current = phase();
    if (current !== "entering" && current !== "closing") return;
    // Anchor on the first frame in the active phase so readiness catch-up
    // cannot make the full-screen sheet jump into its middle.
    if (!transitionAnchored) {
      startedAt = virtualNow();
      transitionAnchored = true;
    }
    const target = current === "entering" ? 1 : 0;
    const distance = Math.abs(target - transitionFrom);
    const duration = (current === "entering" ? enterDuration : dismissDuration) * distance;
    const t = duration === 0 ? 1 : Math.min(1, Math.max(0, (virtualNow() - startedAt) * 1000 / duration));
    // Store the presented position itself. Reversing an interrupted entry
    // starts at that position instead of reinterpreting a second eased clock.
    // Entry settles cubically; dismissal uses a gentler quadratic deceleration
    // so a full-screen surface does not pause and then rush through its middle.
    const eased = 1 - Math.pow(1 - t, current === "entering" ? 3 : 2);
    const next = transitionFrom + (target - transitionFrom) * eased;
    setTimeline(next);
    if (current === "entering") {
      if (t === 1) setPhase("open");
    } else {
      if (t === 1) {
        setPhase("waiting");
        pendingDismiss?.resolve();
        pendingDismiss = undefined;
      }
    }
  }, { continuous: () => phase() === "entering" || phase() === "closing" });

  return <View class={props.class ?? "absolute inset-0 w-full h-full"} style={props.style}>
    <FocusScope class="absolute inset-0 w-full h-full" active={() => props.binding().focused && !props.systemUIFocused} autoFocus restoreFocus>
    <View class="absolute inset-0 w-full h-full bg-black" style={{ opacity: timeline() * 0.16 }} />
    <View
      class={darkMode()
        ? "absolute left-0 top-0 w-full overflow-hidden bg-[#09090B]"
        : "absolute left-0 top-0 w-full overflow-hidden bg-white"}
      style={presentationStyle() === "page"
        ? { height: Math.max(1, height()), translateX: entryOffsetX() * (1 - timeline()), translateY: 0 }
        : { height: Math.max(1, height()), translateX: 0, translateY: entryOffsetY() * (1 - timeline()) }}
    >
      <CompositorSurface package={props.binding().appId}
        focused={props.binding().focused && !props.systemUIFocused && phase() !== "closing" && phase() !== "waiting"}
        class="absolute inset-0 w-full h-full" />
      <Show when={closeFailed()}>
        <Text
          class={presentationStyle() === "page" ? "absolute right-[8] top-[8] text-xs text-[#B4233A]" : "absolute left-[8] top-[8] text-xs text-[#B4233A]"}
          style={closeFailedStyle()}
        >
          Close failed. Please retry.
        </Text>
      </Show>
      <Show when={presentationStyle() === "page"} fallback={
        /* Keep the 44px Button as a transparent hit target; even-sized rings keep the 30px affordance crisp and centered. */
        <Button class="absolute right-[8] top-[8] w-[44] h-[44] flex-col items-center justify-center rounded-full bg-transparent focus:bg-transparent active:bg-transparent"
          debugName="mini-app-close"
          style={closeStyle()}
          onPress={close}>
          <View class={darkMode()
            ? "w-[30] h-[30] items-center justify-center rounded-full bg-[#18181B] border-[#27272A]"
            : "w-[30] h-[30] items-center justify-center rounded-full bg-[#F5F6F7] border-[#D6DCE7]"}>
            <View class={darkMode()
              ? "w-[14] h-[14] items-center justify-center rounded-full bg-[#FAFAFA]"
              : "w-[14] h-[14] items-center justify-center rounded-full bg-[#17233B]"}>
              <View class={darkMode()
                ? "w-[10] h-[10] items-center justify-center rounded-full bg-[#18181B]"
                : "w-[10] h-[10] items-center justify-center rounded-full bg-[#F5F6F7]"}>
                <View class={darkMode()
                  ? "w-[6] h-[6] rounded-full bg-[#FAFAFA]"
                  : "w-[6] h-[6] rounded-full bg-[#17233B]"} />
              </View>
            </View>
          </View>
        </Button>
      }>
        <Button class="absolute left-[8] top-[8] w-[44] h-[44] flex-col items-center justify-center rounded-full bg-transparent focus:bg-transparent active:bg-transparent"
          debugName="mini-app-back"
          style={backStyle()}
          onPress={close}>
          <View class={darkMode()
            ? "w-[30] h-[30] items-center justify-center rounded-full bg-[#18181B] border-[#27272A]"
            : "w-[30] h-[30] items-center justify-center rounded-full bg-[#F5F6F7] border-[#D6DCE7]"}>
            <View class="relative w-[24] h-[24]">
              <View
                class="absolute"
                style={{ bgColor: darkMode() ? "#FAFAFA" : "#17233B", insetL: 7, insetT: 1, width: 3, height: 11, originX: -0.5, originY: 0.5, rotate: 45 }}
              />
              <View
                class="absolute"
                style={{ bgColor: darkMode() ? "#FAFAFA" : "#17233B", insetL: 7, insetT: 12, width: 3, height: 11, originX: -0.5, originY: -0.5, rotate: -45 }}
              />
            </View>
          </View>
        </Button>
      </Show>
    </View>
    </FocusScope>
  </View>;
}
