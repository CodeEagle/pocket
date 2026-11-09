import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Image, View } from "@pocketjs/framework/solid/components";
import { useAccessibilityPreferences } from "@pocket/ui";
import { createNovelRainMesh, novelAtmosphereIssue, type NovelAtmosphere } from "./atmosphere.ts";
import type { NovelAnimationDriver } from "./models.ts";
import { NovelMeshView } from "./mesh-view.tsx";

/** Presentation-only weather shares the existing model clock and retained textures. */
export function NovelAtmosphereView(props: { config: NovelAtmosphere; width: number; height: number; active: boolean; animations?: NovelAnimationDriver }) {
  const accessibility = useAccessibilityPreferences();
  const [elapsed, setElapsed] = createSignal(0);
  let rain: ReturnType<typeof createNovelRainMesh> | undefined;
  const config = createMemo(() => {
    const issue = novelAtmosphereIssue(props.config);
    if (issue) throw new Error(issue);
    return props.config;
  });
  const intensity = () => config().intensity ?? .65;
  createEffect(() => {
    if (!props.active || !props.animations || accessibility().reduceMotion || intensity() === 0) return;
    let pending = 0;
    const remove = props.animations.register(delta => {
      // Weather only needs 30 Hz. The shared clock still drives models normally.
      pending += Math.max(0, Math.min(250, delta));
      if (pending < 1000 / 30) return;
      const step = pending;
      pending = 0;
      setElapsed(value => value + step);
    });
    onCleanup(remove);
  });
  const geometry = createMemo(() => config().rain && !accessibility().reduceMotion
    ? (rain ??= createNovelRainMesh())(props.width, props.height, elapsed())
    : undefined);
  const flash = () => {
    if (!props.active || !config().lightning || accessibility().reduceMotion) return 0;
    const time = elapsed() % 11000;
    return time > 8300 && time < 8560 ? Math.sin((time - 8300) / 260 * Math.PI) * .085 * intensity() : 0;
  };
  return <View class="absolute inset-0 w-full h-full" debugName="vn-atmosphere">
    <Show when={!accessibility().reduceMotion && intensity() > 0 ? config().rain : undefined}>{texture =>
      <NovelMeshView src={texture()} geometry={geometry()!} version={elapsed()} class="absolute inset-0" style={{ width: props.width, height: props.height, opacity: intensity() }} debugName="vn-rain" />
    }</Show>
    <Show when={config().mist}>{texture => <>
      <Image src={texture()} class="absolute" style={{ width: props.width * 1.3, height: props.height * .8, insetL: -props.width * .18 + Math.sin(elapsed() / 14000) * props.width * .06, insetT: props.height * .22, opacity: .16 * intensity() }} />
      <Image src={texture()} class="absolute" style={{ width: props.width * 1.6, height: props.height * .75, insetL: -props.width * .3 - Math.sin(elapsed() / 18000) * props.width * .08, insetT: props.height * .47, opacity: .23 * intensity() }} />
    </>}</Show>
    <View class="absolute inset-0 w-full h-full bg-[#B8D6E9]" style={{ opacity: flash() }} debugName="vn-distant-lightning" />
  </View>;
}
