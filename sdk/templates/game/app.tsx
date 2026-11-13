import { For, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import {
  availableDisplayPanes,
  createDisplayGeometry,
  hasLocalLeftOcclusionInset,
  hasLocalRightOcclusionInset,
  MobileAppBar,
  pageInsets,
  SafeAreaScaffold,
} from "@pocket/ui";

// Keep the retained frame clock, JS state and Focusable input. Decorative art
// lives in the scaffold's full-canvas visual layer; the game field and every
// input target stay in the scaffold's once-inset content area.
const SPOTS = [[.22, .25], [.65, .18], [.48, .42], [.76, .55], [.27, .62], [.58, .77], [.2, .83], [.8, .8], [.24, .45]];
const STARS = Array.from({ length: 32 }, (_, i) => ({ x: ((i * 37 + 11) % 97) / 100, y: ((i * 23 + 7) % 97) / 100, size: i % 4 === 0 ? 3 : 2 }));
const RAYS = [[1, 0], [.5, .87], [-.5, .87], [-1, 0], [-.5, -.87], [.5, -.87]];
const HEADER_CONTENT_HEIGHT = 56;
const PROGRESS_HEIGHT = 2;
const FOOTER_HEIGHT = 14;

function Game() {
  const geometry = createDisplayGeometry();
  const pane = () => availableDisplayPanes(geometry())[0];
  const viewportWidth = () => geometry().width || 390;
  const viewportHeight = () => geometry().height || 844;
  const insets = () => pageInsets(geometry());
  const bodyLeftInset = () => hasLocalLeftOcclusionInset(geometry()) ? 0 : insets().left;
  const bodyRightInset = () => hasLocalRightOcclusionInset(geometry()) ? 0 : insets().right;
  const paneLeft = () => Math.max(0, (pane()?.left ?? bodyLeftInset()) - bodyLeftInset());
  const width = () => pane()?.width ?? Math.max(0, viewportWidth() - bodyLeftInset() - bodyRightInset());
  const height = () => pane()?.height ?? Math.max(0, viewportHeight() - insets().top - insets().bottom);
  // SafeAreaScaffold.appBar consumes the top inset once. This is the remaining
  // field height after the fixed HUD, progress line and footer; it has no
  // artificial minimum that can overflow a short landscape viewport.
  const fieldHeight = () => Math.max(1, height() - HEADER_CONTENT_HEIGHT - PROGRESS_HEIGHT - FOOTER_HEIGHT);
  const targetSize = () => Math.max(1, Math.min(80, width() - 16, fieldHeight() - 16));
  const panelIconSize = () => Math.max(1, Math.min(92, (fieldHeight() - 62) / 3));
  const panelActionWidth = () => Math.max(1, Math.min(180, width() - 32));
  const radius = () => targetSize() / 2;
  const [phase, setPhase] = createSignal<"ready" | "playing" | "paused" | "finished">("ready");
  const [score, setScore] = createSignal(0);
  const [remaining, setRemaining] = createSignal(30);
  const [target, setTarget] = createSignal(4);
  const [elapsed, setElapsed] = createSignal(0);
  const [burst, setBurst] = createSignal(0);
  let hitX = 0;
  let hitY = 0;

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const targetX = () => {
    const r = radius();
    return clamp(r + SPOTS[target()][0] * (width() - targetSize()) + Math.sin(elapsed() * 3) * 7, r, Math.max(r, width() - r));
  };
  const targetY = () => {
    const r = radius();
    return clamp(r + SPOTS[target()][1] * (fieldHeight() - targetSize()) + Math.cos(elapsed() * 2) * 9, r, Math.max(r, fieldHeight() - r));
  };

  function restart() {
    setScore(0);
    setRemaining(30);
    setElapsed(0);
    setBurst(0);
    setTarget(4);
    setPhase("playing");
  }
  function hit() {
    if (phase() !== "playing") return;
    hitX = targetX();
    hitY = targetY();
    setBurst(1);
    setScore(value => value + 1);
    setTarget(value => (value + 4) % SPOTS.length);
  }
  onFrame(() => {
    if (phase() !== "playing") return;
    const dt = 1 / simulationHz();
    setElapsed(value => value + dt);
    setRemaining(value => Math.max(0, value - dt));
    setBurst(value => Math.max(0, value - dt * 2));
    if (remaining() <= 0) { setPhase("finished"); return; }
  }, { continuous: () => phase() === "playing" });

  return <SafeAreaScaffold
    class="flex-col w-full h-full bg-[#080F21]"
    reservedActions="mini-app"
    appBar={() => <MobileAppBar
      dark
      title={"得分：" + score()}
      subtitle="POCKET ARCADE"
      trailing={<View class="flex-row items-center gap-4">
        <Text class="text-base text-[#CEE0F1]">{"剩余：" + Math.ceil(remaining()) + " 秒"}</Text>
        {phase() === "playing" ? <Focusable class="w-[48] h-[44] items-center justify-center" onPress={() => setPhase("paused")}>
          <Text class="text-sm text-[#90A8C6]">暂停</Text>
        </Focusable> : null}
      </View>}
    />}
    background={() => <>
      <For each={STARS}>{star => <View class="absolute bg-[#6687AC]" style={{
        posType: 1, insetL: star.x * viewportWidth(), insetT: star.y * viewportHeight(), width: star.size, height: star.size, radius: 2, hitPass: 1,
      }} />}</For>
      {/* Distant planet and orbit are visual-only and extend behind system areas. */}
      <View class="absolute" style={{ posType: 1, insetL: viewportWidth() * .55, insetT: viewportHeight() * .48,
        width: 210, height: 210, radius: 105, borderWidth: 1, borderColor: "#1A304A", hitPass: 1 }} />
      <View class="absolute bg-[#11273D]" style={{ posType: 1, insetL: viewportWidth() * .55 + 39, insetT: viewportHeight() * .48 + 39,
        width: 132, height: 132, radius: 66, hitPass: 1 }} />
      <View class="absolute bg-[#17354A]" style={{ posType: 1, insetL: viewportWidth() * .55 + 64, insetT: viewportHeight() * .48 + 56,
        width: 48, height: 24, radius: 12, hitPass: 1 }} />
    </>}
  >
    <View class="relative flex-col overflow-hidden w-full h-full" style={{ width: width(), marginL: paneLeft(), grow: 1 }}>
      <View class="h-[2] bg-[#1B2A44]" style={{ width: width() }}>
        <View class="h-[2] bg-[#F9CF72]" style={{ width: width() * remaining() / 30 }} />
      </View>
      <View class="relative flex-1 overflow-hidden" style={{ width: width(), height: fieldHeight() }}>
        {phase() === "playing" ? <Focusable debugName="star-core" class="absolute items-center justify-center" style={{
          posType: 1, insetL: targetX() - radius(), insetT: targetY() - radius(), width: targetSize(), height: targetSize(),
        }} onPress={hit}>
          <View class="absolute bg-[#312F36]" style={{ width: targetSize(), height: targetSize(), radius: radius() }} />
          <View class="absolute" style={{ width: targetSize() * .775, height: targetSize() * .775, radius: targetSize() * .3875, borderWidth: 1, borderColor: "#806846" }} />
          <View class="absolute bg-[#F9CF72]" style={{ width: targetSize() * .525, height: targetSize() * .525, radius: targetSize() * .2625 }} />
          <View class="absolute bg-[#FFF0BF]" style={{ width: targetSize() * .1, height: targetSize() * .7, radius: targetSize() * .05 }} />
          <View class="absolute bg-[#FFF0BF]" style={{ width: targetSize() * .7, height: targetSize() * .1, radius: targetSize() * .05 }} />
          <View class="absolute bg-[#FFF8DF]" style={{ width: targetSize() * .25, height: targetSize() * .25, radius: targetSize() * .125 }} />
        </Focusable> : null}
        {burst() > 0 ? <View class="absolute" style={{ posType: 1, insetL: hitX, insetT: hitY, width: 1, height: 1 }}>
          <For each={RAYS}>{ray => <View class="absolute bg-[#F9CF72]" style={{
            posType: 1, insetL: ray[0] * (24 + (1 - burst()) * 55) - 3,
            insetT: ray[1] * (24 + (1 - burst()) * 55) - 3,
            width: 6, height: 6, radius: 3, opacity: burst(),
          }} />}</For>
          <Text class="absolute text-xl text-[#FFF0BF] font-bold" style={{ posType: 1, insetL: -14, insetT: -45 - (1 - burst()) * 32, width: 50, opacity: burst() }}>+1</Text>
        </View> : null}
        {phase() !== "playing" ? <View class="absolute flex-col items-center justify-center gap-1" style={{
          posType: 1, insetL: 0, insetT: 0, width: width(), height: fieldHeight(),
        }}>
          <View class="items-center justify-center bg-[#26313E]" style={{
            width: panelIconSize(), height: panelIconSize(), radius: panelIconSize() / 2,
          }}>
            <View class="items-center justify-center bg-[#F9CF72]" style={{
              width: panelIconSize() * .61, height: panelIconSize() * .61, radius: panelIconSize() * .305,
            }}>
              <View class="bg-[#FFF8DF]" style={{ width: panelIconSize() * .22, height: panelIconSize() * .22, radius: panelIconSize() * .11 }} />
            </View>
          </View>
          <Text class="text-2xl text-[#FFF0CF] font-bold">{phase() === "ready" ? "星尘捕手" : phase() === "paused" ? "已暂停" : "本局结束"}</Text>
          <Text class="text-sm text-[#90A8C6]">{phase() === "ready" ? "追上星光，点击收集 · 30 秒挑战" : phase() === "paused" ? "星光在等你" : "收集了 " + score() + " 颗星尘"}</Text>
          <Focusable class="rounded-xl items-center justify-center bg-[#F9CF72]" style={{ width: panelActionWidth(), height: 44 }} onPress={() => phase() === "paused" ? setPhase("playing") : restart()}>
            <Text class="text-base text-[#17263C] font-bold">{phase() === "paused" ? "继续" : phase() === "finished" ? "再来一局" : "开始游戏"}</Text>
          </Focusable>
          {phase() === "paused" ? <Focusable class="rounded-lg items-center justify-center bg-[#16263A]" style={{ width: panelActionWidth(), height: 36 }} onPress={restart}>
            <Text class="text-sm text-[#90A8C6]">重新开始</Text>
          </Focusable> : null}
        </View> : null}
      </View>
      <Text class="text-xs text-[#7190AE] text-center w-full h-[14]">{phase() === "playing" ? "点击发光星核" : "STAR DUST / 01"}</Text>
    </View>
  </SafeAreaScaffold>;
}

mount(() => <Game />);
