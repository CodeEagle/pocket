import { For, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton, SafeAreaScaffold } from "@pocket/ui";

// One JS game loop, driven by the pinned runtime's simulation clock.
// No browser timers, native game state, or external assets are required.
function Game() {
  const [phase, setPhase] = createSignal<"ready" | "playing" | "paused" | "finished">("ready");
  const [score, setScore] = createSignal(0);
  const [seconds, setSeconds] = createSignal(30);
  const [target, setTarget] = createSignal(4);
  let remaining = 30;
  let moveElapsed = 0;

  function restart() {
    remaining = 30;
    moveElapsed = 0;
    setScore(0);
    setSeconds(30);
    setTarget(4);
    setPhase("playing");
  }
  function hit(cell: number) {
    if (phase() !== "playing" || cell !== target()) return;
    setScore(value => value + 1);
    setTarget(value => (value + 4) % 9);
    moveElapsed = 0;
  }
  onFrame(() => {
    if (phase() !== "playing") return;
    const dt = 1 / simulationHz();
    remaining = Math.max(0, remaining - dt);
    setSeconds(Math.ceil(remaining));
    if (remaining <= 0) {
      setPhase("finished");
      return;
    }
    moveElapsed += dt;
    if (moveElapsed >= 1) {
      moveElapsed -= 1;
      setTarget(value => (value + 1) % 9);
    }
  }, { continuous: () => phase() === "playing" });

  return <SafeAreaScaffold class="flex-col w-full bg-slate-950" edges="all">
    <View class="flex-col gap-3 p-4 w-full">
      <Text class="text-2xl text-white font-bold">Pocket 游戏</Text>
      <Text class="text-sm text-slate-300">点击亮起的格子，在 30 秒内尽量多得分。</Text>
      <Text class="text-xl text-white">{"得分：" + score() + " | 剩余：" + seconds()}</Text>
      <Text class="text-sm text-slate-300">{phase() === "ready" ? "准备开始" : phase() === "playing" ? "进行中" : phase() === "paused" ? "已暂停" : "本局结束"}</Text>
      <For each={[0, 1, 2]}>{row => <View class="flex-row gap-2 w-full">
        <For each={[0, 1, 2]}>{column => <ActionButton
          label={target() === row * 3 + column ? "命中" : "."}
          kind={target() === row * 3 + column ? "primary" : "secondary"}
          style={{ grow: 1, height: 64 }}
          disabled={phase() !== "playing"}
          onPress={() => hit(row * 3 + column)}
        />}</For>
      </View>}</For>
      <ActionButton label={phase() === "ready" ? "开始游戏" : "重新开始"} onPress={restart} />
      <ActionButton label={phase() === "paused" ? "继续" : "暂停"} kind="secondary"
        disabled={phase() === "ready" || phase() === "finished"}
        onPress={() => setPhase(phase() === "playing" ? "paused" : "playing")} />
    </View>
  </SafeAreaScaffold>;
}

mount(() => <Game />);
