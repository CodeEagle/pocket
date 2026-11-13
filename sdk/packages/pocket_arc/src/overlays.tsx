import { Show, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createArcSpring } from "./motion.ts";
import { resolveArcPalette, useArcTheme } from "./tokens.ts";
import { ArcSurface } from "./skins.tsx";

/** Calm rising Arc Toast (`@uiarc/toast`) with spring entrance & `hitPass: 1`. */
export function ArcToast(props: {
  message: () => string | null;
  isDark?: boolean;
  bottomOffset?: number;
}): JSX.Element {
  const ctx = useArcTheme();
  const visible = () => Boolean(props.message());
  const rise = createArcSpring(() => (visible() ? 0 : 10), {
    preset: "gentle",
    reducedMotion: ctx.reducedMotion,
  });
  const pal = () =>
    resolveArcPalette(
      props.isDark ? (ctx.mode() === "amber-night" ? "amber-night" : "dark") : "light",
      ctx.accent(),
    );

  return (
    <Show when={visible()}>
      <View
        class="absolute left-4 right-4 z-50"
        style={{
          insetB: props.bottomOffset ?? 102,
          translateY: rise(),
          hitPass: 1,
        }}
      >
        <View
          class="relative w-full px-3.5 py-2.5 flex-row items-center justify-between gap-2"
          style={{
            bgColor: pal().surfaceRaised,
            borderColor: pal().borderStrong,
            borderWidth: 1,
            radius: pal().radiusControl + 2,
            hitPass: 1,
          }}
        >
          <View
            class="w-2 h-2 shrink-0"
            style={{ bgColor: pal().accent, radius: 999, hitPass: 1 }}
          />
          <Text
            class="text-xs font-bold flex-1"
            style={{ textColor: pal().foreground, hitPass: 1 }}
          >
            {props.message() ?? ""}
          </Text>
        </View>
      </View>
    </Show>
  );
}

export { ArcSurface as Dialog, ArcSurface as BottomSheet, ArcSurface as Alert };
