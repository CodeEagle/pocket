import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & { type?: string; text?: string; x?: number; y?: number; w?: number; h?: number; color?: number };
type ProbeResponse = { ok?: boolean; error?: string; frame?: { ops?: DrawOp[] } };

const sdkRoot = resolve(import.meta.dir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);

assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

test("MobileScaffold background stays in its current edges=none canvas and passes a real button tap", () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-safe-area-background-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.ui.safe-area-background-fixture",
      name: "safe-area-background-fixture",
      version: "0.1.0",
      engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
      app: { entry: "app.tsx", output: "app", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      protocolVersion: 1,
      capabilities: { requires: ["text.glyphs.baked"], optional: [] },
      permissions: { optional: [] },
    }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "safe-area-background-fixture", version: "0.1.0", private: true, type: "module" }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { MobileScaffold, SafeAreaScaffold } from "@pocket/ui";

function App() {
  const [taps, setTaps] = createSignal(0);
  return <SafeAreaScaffold class="flex-col w-full h-full bg-[#080F21]">
    <MobileScaffold class="flex-col w-full bg-[#09090B]" background={<View class="absolute inset-0 w-full h-full bg-[#123456]" style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0, hitPass: 1 }} />}>
      <Focusable class="w-[160] h-[44] items-center justify-center bg-[#F9CF72]" onPress={() => setTaps(value => value + 1)}>
        <Text class="text-sm text-[#17263C]">{"Taps:" + taps()}</Text>
      </Focusable>
    </MobileScaffold>
  </SafeAreaScaffold>;
}

mount(() => <App />);
`);

    const built = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    const bytecodePath = join(output, "app.qjbc");
    const pakPath = join(output, "app.pak");
    assert.ok(existsSync(bytecodePath), "background fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "background fixture PAK is missing");

    const width = 390;
    const height = 640;
    const responses = runProbe([
      { op: "create", width, height },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      {
        op: "send",
        message: {
          type: "event",
          name: "display.viewport",
          payload: { width, height, safeArea: { top: 24, right: 0, bottom: 18, left: 0 }, keyboardInset: 0, reservedRegions: [] },
        },
      },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 60, y: 48 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 60, y: 48 } } },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]);
    const frames = responses.flatMap((entry) => entry.frame ? [entry.frame] : []);
    const beforeTap = frames.filter((frame) => frame.ops?.some((op) => op.type === "text" && op.text === "Taps:0")).at(-1);
    const afterTap = frames.find((frame) => frame.ops?.some((op) => op.type === "text" && op.text === "Taps:1"));
    assert.ok(beforeTap, "nested MobileScaffold must paint its initial control");
    assert.ok(afterTap, "the real button must receive the tap through its full-canvas background");
    const background = beforeTap.ops?.find((op) => op.type === "rect" && op.color === 0xff123456);
    const control = beforeTap.ops?.find((op) => op.type === "text" && op.text === "Taps:0");
    assert.ok(background, "nested background must paint into the current MobileScaffold canvas");
    assert.ok(Math.abs(background.y! - 24) <= 1, `edges=none must not consume the outer 24px top inset again: background=${JSON.stringify(background)} control=${JSON.stringify(control)}`);
    assert.ok(Math.abs(background.h! - (height - 24 - 18)) <= 1, `nested background must fill the already-safe canvas once: background=${JSON.stringify(background)} control=${JSON.stringify(control)}`);
    assert.ok(control && control.y! >= 24 && control.y! < 48, `nested control should start below one inset, not two: ${JSON.stringify(control)}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
