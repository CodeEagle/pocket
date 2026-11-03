// Explicit integration/ablation runner: pinned JSX compiler -> QJBC/PAK ->
// production Rust host. Run with bun tests/demand_scheduler_native_probe.ts.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildGuest } from "../scripts/build_guest.ts";

const sdk = resolve(import.meta.dir, "..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdk, "native/target/aarch64-apple-darwin/release/pocket_probe");
assert.ok(existsSync(probe), "Build the current native pocket_probe first");
const project = mkdtempSync(join(tmpdir(), "pocket-demand-native-"));
try {
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  const source = (continuous: boolean) => `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { View, Text } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { after, virtualFrame } from "@pocketjs/framework/clock";
function App() {
  const [label, setLabel] = createSignal("waiting");
  let callbacks = 0;
  onFrame(() => callbacks++, { continuous: ${continuous} });
  after(5, () => {
    setLabel("deadline reached");
    (globalThis as any).pocket._emit(JSON.stringify({type:"event",name:"deadline",payload:{callbacks,virtual:virtualFrame()}}));
  });
  return <View><Text>{label()}</Text></View>;
}
mount(() => <App />);
`;
  const outcomes: Record<string, unknown> = {};
  for (const continuous of [false, true]) {
    writeFileSync(join(project, "app.tsx"), source(continuous));
    const build = await buildGuest({ projectRoot: project, outDir: join(project, continuous ? "continuous" : "demand") });
    const commands: Record<string, unknown>[] = [
      { op: "create", width: 320, height: 480 },
      { op: "loadBytecode", bytecodePath: build.bytecode, pakPath: build.pak },
      { op: "frame", deltaMs: 0 },
      { op: "schedule" },
    ];
    if (continuous) {
      // Continuous work deliberately retains the normal bounded fixed-step
      // path rather than applying a quiescent fast-forward.
      for (let n = 0; n < 5; n++) commands.push({ op: "frame", deltaMs: 1000 });
    } else {
      commands.push({ op: "frame", deltaMs: 5000 });
    }
    commands.push({ op: "schedule" }, { op: "quit" });
    const result = spawnSync(probe, {
      input: commands.map(value => JSON.stringify(value)).join("\n") + "\n",
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(responses.every(value => value.ok === true), JSON.stringify(responses));
    const initial = responses[3].nextWakeDelayMs;
    assert.equal(initial, continuous ? 0 : 5000);
    const frames = responses.filter(value => value.frame).map(value => value.frame);
    const deadline = frames.flatMap(value => value.events ?? []).find(value => value.name === "deadline");
    assert.ok(deadline, "the actual framework after() did not wake");
    assert.equal(deadline.payload.virtual, 300);
    assert.equal(deadline.payload.callbacks, continuous ? 300 : 1);
    assert.ok(frames.at(-1).ops.some(value => value.text === "deadline reached"), "timer's reactive UI did not render");
    assert.equal(responses.at(-2).nextWakeDelayMs, continuous ? 0 : -1);
    outcomes[continuous ? "continuous" : "demand"] = {
      initialWakeDelayMs: initial, deadline: deadline.payload,
      finalWakeDelayMs: responses.at(-2).nextWakeDelayMs,
    };
  }
  console.log(JSON.stringify({ passed: true, outcomes }, null, 2));
} finally {
  rmSync(project, { recursive: true, force: true });
}
