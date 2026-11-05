import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Op = { type: string; text?: string; color?: number; x: number; y: number; w: number; h: number };
type Frame = { ops: Op[] };
const sdk = resolve(import.meta.dir, "../../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? [
  join(sdk, "native/target/aarch64-apple-darwin/release/pocket_probe"),
  join(sdk, "native/target/debug/pocket_probe"),
].find(existsSync);
const frame = () => ({ op: "frame", deltaMs: 16 });
const frames = (count: number) => Array.from({ length: count }, frame);
const pointer = (phase: string, point: { x: number; y: number }) => ({
  op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, ...point } },
});
const tap = (point: { x: number; y: number }) => [pointer("down", point), frame(), pointer("up", point), frame()];
function text(f: Frame, label: string): Op {
  const op = f.ops.find((op) => op.type === "text" && op.text === label);
  assert.ok(op, `missing native label ${label}`);
  return op;
}
function center(op: Op) { return { x: op.x + op.w / 2, y: op.y + op.h / 2 }; }
function bounds(ops: Op[]) {
  assert.ok(ops.length, "native control must paint measurable shapes");
  const x = Math.min(...ops.map((op) => op.x));
  const y = Math.min(...ops.map((op) => op.y));
  return { x, y, w: Math.max(...ops.map((op) => op.x + op.w)) - x, h: Math.max(...ops.map((op) => op.y + op.h)) - y };
}
function thumb(f: Frame, label: string) {
  const anchor = center(text(f, label));
  return bounds(f.ops.filter((op) => (op.type === "rect" || op.type === "image") && op.color === 0xffffffff && op.x > 210 && Math.abs(op.y + op.h / 2 - anchor.y) < 18));
}
function sliderWidth(f: Frame, value: string) {
  const anchor = center(text(f, value));
  return bounds(f.ops.filter((op) => (op.type === "rect" || op.type === "image") && op.color === 0xff315deb && Math.abs(op.y + op.h / 2 - anchor.y) < 12)).w;
}

test("switch loading resolves or rolls back and manual slider changes animate in native frames", () => {
  assert.ok(probe, "a native bytecode pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-control-motion-"));
  const out = join(project, "out");
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "control-motion", private: true, type: "module" }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Text, View } from "@pocketjs/framework/solid/components";
import { MobileButton, MobileStepper, MobileSwitch } from "@pocket/ui";
function App() {
  const [sync, setSync] = createSignal(false);
  const [guarded, setGuarded] = createSignal(false);
  const [level, setLevel] = createSignal(2);
  const [requests, setRequests] = createSignal(0);
  const [commits, setCommits] = createSignal(0);
  const [errors, setErrors] = createSignal(0);
  let accept: ((value: boolean) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  return <FocusScope autoFocus class="flex-col w-[300] h-full gap-3">
    <MobileSwitch label={sync() ? "Sync ON" : "Sync OFF"} value={sync()} onChange={setSync} />
    <MobileSwitch label={guarded() ? "Guarded ON" : "Guarded OFF"} value={guarded()}
      onChange={(value) => { setGuarded(value); setCommits((count) => count + 1); }}
      onBeforeChange={() => { setRequests((count) => count + 1); return new Promise<boolean>((resolve, fail) => { accept = resolve; reject = fail; }); }}
      onError={() => setErrors((count) => count + 1)} />
    <MobileStepper value={level()} min={0} max={10} onChange={setLevel} />
    <View class="flex-row gap-2">
      <MobileButton label="Resolve" onPress={() => accept?.(true)} />
      <MobileButton label="Reject" onPress={() => reject?.(new Error("validation failed"))} />
    </View>
    <Text>{"Requests " + requests() + " commits " + commits() + " errors " + errors()}</Text>
  </FocusScope>;
}
mount(() => <App />);
`);
    const build = spawnSync("bun", [join(sdk, "scripts/build_guest.ts"), `--project-root=${project}`, `--outdir=${out}`], { encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const start = [
      { op: "create", width: 300, height: 460 },
      { op: "loadBytecode", bytecodePath: join(out, "app.qjbc"), pakPath: join(out, "app.pak") },
      ...frames(3),
    ];
    function run(commands: unknown[], wakeDelays?: number[]): Frame[] {
      const result = spawnSync(probe!, { input: [...start, ...commands, { op: "quit" }].map((command) => JSON.stringify(command)).join("\n") + "\n", encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").flatMap((line) => {
        const output = JSON.parse(line);
        assert.notEqual(output.ok, false, output.error);
        if (typeof output.nextWakeDelayMs === "number") wakeDelays?.push(output.nextWakeDelayMs);
        return output.frame ? [output.frame] : [];
      });
    }
    const initial = run([]).at(-1)!;
    const syncPoint = center(text(initial, "Sync OFF"));
    const sync = run([...tap(syncPoint), ...frames(22)]);
    const syncStart = thumb(initial, "Sync OFF").x;
    const syncEnd = thumb(sync.at(-1)!, "Sync ON").x;
    const syncXs = sync.slice(4).map((f) => thumb(f, "Sync ON").x);
    assert.ok(syncXs[0] >= syncStart + 1 && syncXs[0] < syncEnd - 1,
      "the input turn must already paint a visible intermediate thumb position");
    assert.ok(Math.abs(syncEnd - syncStart - 20) < 1, "switch must traverse the full track");
    assert.ok(syncXs.filter((x) => x > syncStart + 1 && x < syncEnd - 1).length >= 6, "switch must animate across multiple intermediate native frames");

    const reverseCommands = [...tap(syncPoint), ...frames(3)];
    const reverse = run([...reverseCommands, ...tap(syncPoint), ...frames(22)]);
    const reverseIndex = reverse.findIndex((f, index) => index > 0
      && f.ops.some(op => op.type === "text" && op.text === "Sync OFF")
      && reverse[index - 1].ops.some(op => op.type === "text" && op.text === "Sync ON"));
    assert.ok(reverseIndex > 0 && thumb(reverse[reverseIndex], "Sync OFF").x < thumb(reverse[reverseIndex - 1], "Sync ON").x,
      "reversing a moving switch must respond in its input turn");
    assert.ok(Math.abs(thumb(reverse.at(-1)!, "Sync OFF").x - syncStart) < 1,
      "a reversed switch must finish at the latest controlled value");

    const idleCommands = [...frames(120), { op: "schedule" }, ...tap(syncPoint), { op: "schedule" }];
    const wakeDelays: number[] = [];
    const afterIdle = run(idleCommands, wakeDelays).at(-1)!;
    assert.ok(thumb(afterIdle, "Sync ON").x >= syncStart + 1,
      "an idle switch must respond on its first input turn");
    assert.deepEqual(wakeDelays, [-1, 0], "switch must wake from a parked guest for its transition");
    const settledWakeDelays: number[] = [];
    run([...idleCommands, ...frames(22), { op: "schedule" }], settledWakeDelays);
    assert.equal(settledWakeDelays.at(-1), -1, "settled controls must let the guest park again");

    const guardPoint = center(text(initial, "Guarded OFF"));
    const pendingCommands = [...tap(guardPoint), ...frames(22)];
    const pending = run(pendingCommands).at(-1)!;
    const pendingThumb = thumb(pending, "Guarded OFF");
    const offThumb = thumb(initial, "Guarded OFF");
    assert.ok(Math.abs(pendingThumb.x - offThumb.x - 10) < 1, "loading thumb must park at the midpoint");
    text(pending, "Requests 1 commits 0 errors 0");
    const spinner = pending.ops.filter((op) => op.type !== "text" && op.w <= 3 && op.h <= 3 && op.x >= pendingThumb.x + 3 && op.x + op.w <= pendingThumb.x + pendingThumb.w - 3 && op.y >= pendingThumb.y + 3 && op.y + op.h <= pendingThumb.y + pendingThumb.h - 3);
    assert.ok(spinner.length >= 4, "loading indicator must paint inside the white thumb");
    const stillPending = run([...pendingCommands, ...tap(guardPoint), ...frames(4)]).at(-1)!;
    text(stillPending, "Requests 1 commits 0 errors 0");
    assert.notEqual(JSON.stringify(stillPending.ops), JSON.stringify(pending.ops), "loading indicator must animate while the thumb remains centered");

    const success = run([...pendingCommands, ...tap(center(text(pending, "Resolve"))), ...frames(22)]).at(-1)!;
    assert.ok(Math.abs(thumb(success, "Guarded ON").x - offThumb.x - 20) < 1, "success must commit at the on endpoint");
    text(success, "Requests 1 commits 1 errors 0");
    const failure = run([...pendingCommands, ...tap(center(text(pending, "Reject"))), ...frames(22)]).at(-1)!;
    assert.ok(Math.abs(thumb(failure, "Guarded OFF").x - offThumb.x) < 1, "failure must roll back to the off endpoint");
    text(failure, "Requests 1 commits 0 errors 1");

    const plus = center(text(initial, "+"));
    const slider = run([...tap(plus), ...frames(20)]);
    const beforeWidth = sliderWidth(initial, "2");
    const endWidth = sliderWidth(slider.at(-1)!, "3");
    const widths = slider.slice(4).map((f) => sliderWidth(f, "3"));
    assert.ok(endWidth > beforeWidth + 5, "manual plus must change the slider's actual fill width");
    assert.ok(widths.filter((width) => width > beforeWidth + 1 && width < endWidth - 1).length >= 4, "manual plus must paint intermediate slider widths");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 60_000);
