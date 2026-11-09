import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

test("pinned model frames bypass idle narrative transactions and auto reading still wakes", async () => {
  const probe = process.env.POCKET_NATIVE_PROBE;
  assert.ok(probe && existsSync(probe), "set POCKET_NATIVE_PROBE to the pinned native probe");
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-clock-"));
  try {
    const vendor = join(project, "vendor/pocket-vn");
    mkdirSync(vendor, { recursive: true });
    cpSync(join(sdkRoot, "packages/pocket_vn/src"), join(vendor, "src"), { recursive: true });
    writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "@pocket/vn", type: "module", exports: {
      ".": "./src/index.ts", "./clock": "./src/clock.ts", "./models": "./src/models.ts",
    } }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:vendor/pocket-vn" } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-clock", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-clock", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { createNovelAnimationDriver } from "@pocket/vn/models";
function App() {
const engine = createNovelEngine({ id: "clock", version: 1, start: "start", script: {
  start: [{ type: "say", id: "line", text: "Reading" }, { type: "ending", id: "end" }],
} }, { preferences: { textSpeedCharsPerSecond: 0, autoDelayMs: 100 } });
const animations = createNovelAnimationDriver();
const [steps, setSteps] = createSignal(0);
let updates = 0;
const [observed, setObserved] = createSignal(0);
const [phase, setPhase] = createSignal("ready");
animations.register(() => setSteps(value => value + 1));
attachNovelClock(engine, { animations });
engine.start();
engine.subscribe(update => { setObserved(++updates); setPhase(update.snapshot.phase); });
return <Screen class="relative w-full h-full">
  <Text class="absolute left-0 top-0">steps={steps()} updates={observed()} phase={phase()}</Text>
  <Focusable class="absolute left-0 top-[50] w-[100] h-[80]" onPress={() => engine.setPreferences({ mode: "auto" })}>
    <Text>auto</Text>
  </Focusable>
</Screen>;
}
mount(() => <App />);
`);
    const clockPath = join(vendor, "src/clock.ts");
    const optimized = readFileSync(clockPath, "utf8");
    const needle = "if (novelNeedsClock(engine.getSnapshot())) engine.tick(delta);";
    assert.ok(optimized.includes(needle), "ablation must target the production conditional tick");
    const facts: Record<string, { steps: number; updates: number }> = {};
    for (const variant of ["original", "optimized"] as const) {
      writeFileSync(clockPath, variant === "original" ? optimized.replace(needle, "engine.tick(delta);") : optimized);
      const built = await buildGuest({ projectRoot: project, outDir: join(project, variant) });
      const commands = [
        { op: "create", width: 320, height: 240 },
        { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
        ...Array.from({ length: 65 }, () => ({ op: "frame", deltaMs: 1000 / 60 })),
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 30, y: 70 } } },
        { op: "frame", deltaMs: 1000 / 60 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 30, y: 70 } } },
        ...Array.from({ length: 16 }, () => ({ op: "frame", deltaMs: 1000 / 60 })),
        { op: "quit" },
      ];
      const result = spawnSync(probe, { input: commands.map(command => JSON.stringify(command)).join("\n") + "\n", encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr);
      const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.ok(!responses.some(response => response.error), result.stdout);
      const frames = responses.filter(response => response.frame).map(response => response.frame);
      const text = (frame: any): string => frame.ops.filter((op: any) => op.type === "text").map((op: any) => op.text).join(" ");
      const reading = text(frames[64]);
      const matched = /steps=(\d+) updates=(\d+)/.exec(reading);
      assert.ok(matched, reading);
      facts[variant] = { steps: Number(matched[1]), updates: Number(matched[2]) };
      assert.match(text(frames.at(-1)), /phase=ending/, "pointer-selected auto mode must still advance the real compiled engine");
    }
    console.log("novel_clock_guest: " + JSON.stringify(facts));
    assert.ok(facts.original.steps >= 30);
    assert.equal(facts.optimized.steps, facts.original.steps, "ablation must retain identical model steps");
    assert.equal(facts.original.updates, facts.original.steps, "negative control must expose one story transaction per model step");
    assert.equal(facts.optimized.updates, 0);
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 180_000);
