import { For, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { availableDisplayPanes, createDisplayGeometry } from "@pocket/ui";

// Retain the original JS frame clock and input/score loop. All artwork uses
// existing Pocket primitives, with no native game state or second renderer.
const SPOTS = [[.22, .25], [.65, .18], [.48, .42], [.76, .55], [.27, .62], [.58, .77], [.2, .83], [.8, .8], [.24, .45]];
const STARS = Array.from({ length: 32 }, (_, i) => ({ x: ((i * 37 + 11) % 97) / 100, y: ((i * 23 + 7) % 97) / 100, size: i % 4 === 0 ? 3 : 2 }));
const RAYS = [[1, 0], [.5, .87], [-.5, .87], [-1, 0], [-.5, -.87], [.5, -.87]];

function Game() {
  const geometry = createDisplayGeometry();
  const pane = () => availableDisplayPanes(geometry())[0];
  const width = () => pane()?.width ?? geometry().width;
  const height = () => pane()?.height ?? geometry().height;
  const fieldHeight = () => Math.max(240, height() - 112);
  const [phase, setPhase] = createSignal<"ready" | "playing" | "paused" | "finished">("ready");
  const [score, setScore] = createSignal(0);
  const [remaining, setRemaining] = createSignal(30);
  const [target, setTarget] = createSignal(4);
  const [elapsed, setElapsed] = createSignal(0);
  const [burst, setBurst] = createSignal(0);
  let hitX = 0;
  let hitY = 0;
  // Keep a target within its hit area while the player aims. Only a hit
  // changes its location; idle motion is limited to a gentle drift.
  const targetX = () => 40 + SPOTS[target()][0] * (width() - 80) + Math.sin(elapsed() * 3) * 7;
  const targetY = () => 32 + SPOTS[target()][1] * (fieldHeight() - 96) + Math.cos(elapsed() * 2) * 9;

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

  return <View class="relative flex-col overflow-hidden bg-[#080F21]" style={{
    width: width(), height: height(), marginL: pane()?.left ?? 0, marginT: pane()?.top ?? 0,
  }}>
    <View class="flex-row items-center justify-between px-5 pt-4 pb-3 w-full">
      <View class="flex-col gap-1">
        <Text class="text-xs text-[#7190AE] font-bold">POCKET ARCADE</Text>
        <Text class="text-2xl text-[#F9CF72] font-bold">{"得分：" + score()}</Text>
      </View>
      <View class="flex-row items-center gap-4">
        <Text class="text-base text-[#CEE0F1]">{"剩余：" + Math.ceil(remaining()) + " 秒"}</Text>
        {phase() === "playing" ? <Focusable class="w-[48] h-[44] items-center justify-center" onPress={() => setPhase("paused")}>
          <Text class="text-sm text-[#90A8C6]">暂停</Text>
        </Focusable> : null}
      </View>
    </View>
    <View class="h-[2] bg-[#1B2A44]" style={{ width: width() }}>
      <View class="h-[2] bg-[#F9CF72]" style={{ width: width() * remaining() / 30 }} />
    </View>
    <View class="relative overflow-hidden" style={{ width: width(), height: fieldHeight() }}>
      <For each={STARS}>{star => <View class="absolute bg-[#6687AC]" style={{
        posType: 1, insetL: star.x * width(), insetT: star.y * fieldHeight(), width: star.size, height: star.size, radius: 2,
      }} />}</For>
      {/* Distant planet and orbit are scenery, never button placeholders. */}
      <View class="absolute" style={{ posType: 1, insetL: width() * .55, insetT: fieldHeight() * .48,
        width: 210, height: 210, radius: 105, borderWidth: 1, borderColor: "#1A304A" }} />
      <View class="absolute bg-[#11273D]" style={{ posType: 1, insetL: width() * .55 + 39, insetT: fieldHeight() * .48 + 39,
        width: 132, height: 132, radius: 66 }} />
      <View class="absolute bg-[#17354A]" style={{ posType: 1, insetL: width() * .55 + 64, insetT: fieldHeight() * .48 + 56,
        width: 48, height: 24, radius: 12 }} />
      {phase() === "playing" ? <Focusable debugName="star-core" class="absolute items-center justify-center" style={{
        posType: 1, insetL: targetX() - 40, insetT: targetY() - 40, width: 80, height: 80,
      }} onPress={hit}>
        <View class="absolute w-[80] h-[80] bg-[#312F36] rounded-full" />
        <View class="absolute w-[62] h-[62] rounded-full" style={{ borderWidth: 1, borderColor: "#806846" }} />
        <View class="absolute w-[42] h-[42] bg-[#F9CF72] rounded-full" />
        <View class="absolute w-[8] h-[56] bg-[#FFF0BF]" style={{ radius: 4 }} />
        <View class="absolute w-[56] h-[8] bg-[#FFF0BF]" style={{ radius: 4 }} />
        <View class="absolute w-[20] h-[20] bg-[#FFF8DF] rounded-full" />
      </Focusable> : null}
      {burst() > 0 ? <View class="absolute" style={{ posType: 1, insetL: hitX, insetT: hitY, width: 1, height: 1 }}>
        <For each={RAYS}>{ray => <View class="absolute bg-[#F9CF72]" style={{
          posType: 1, insetL: ray[0] * (24 + (1 - burst()) * 55) - 3,
          insetT: ray[1] * (24 + (1 - burst()) * 55) - 3,
          width: 6, height: 6, radius: 3, opacity: burst(),
        }} />}</For>
        <Text class="absolute text-xl text-[#FFF0BF] font-bold" style={{ posType: 1, insetL: -14, insetT: -45 - (1 - burst()) * 32, width: 50, opacity: burst() }}>+1</Text>
      </View> : null}
      {phase() !== "playing" ? <View class="absolute flex-col items-center justify-center gap-4" style={{
        posType: 1, insetL: 0, insetT: 0, width: width(), height: fieldHeight(),
      }}>
        <View class="w-[92] h-[92] rounded-full items-center justify-center bg-[#26313E]">
          <View class="w-[56] h-[56] rounded-full items-center justify-center bg-[#F9CF72]">
            <View class="w-[20] h-[20] rounded-full bg-[#FFF8DF]" />
          </View>
        </View>
        <Text class="text-2xl text-[#FFF0CF] font-bold">{phase() === "ready" ? "星尘捕手" : phase() === "paused" ? "已暂停" : "本局结束"}</Text>
        <Text class="text-sm text-[#90A8C6]">{phase() === "ready" ? "追上星光，点击收集 · 30 秒挑战" : phase() === "paused" ? "星光在等你" : "收集了 " + score() + " 颗星尘"}</Text>
        <Focusable class="w-[180] h-[52] rounded-xl items-center justify-center bg-[#F9CF72]" onPress={() => phase() === "paused" ? setPhase("playing") : restart()}>
          <Text class="text-base text-[#17263C] font-bold">{phase() === "paused" ? "继续" : phase() === "finished" ? "再来一局" : "开始游戏"}</Text>
        </Focusable>
        {phase() === "paused" ? <Focusable class="w-[180] h-[44] items-center justify-center" onPress={restart}>
          <Text class="text-sm text-[#90A8C6]">重新开始</Text>
        </Focusable> : null}
      </View> : null}
    </View>
    <Text class="text-xs text-[#7190AE] text-center w-full">{phase() === "playing" ? "点击发光星核" : "STAR DUST / 01"}</Text>
  </View>;
}

mount(() => <Game />);
