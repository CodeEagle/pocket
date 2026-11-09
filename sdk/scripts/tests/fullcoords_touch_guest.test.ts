import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

type JsonObject = Record<string, unknown>;
type DrawOp = { readonly type?: string; readonly text?: string };
type Frame = { readonly ops?: readonly DrawOp[] };
type ProbeResponse = { readonly error?: string; readonly frame?: Frame };

const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");

function nativeProbePath(): string | undefined {
  const configured = process.env.POCKET_FULL_COORDS_PROBE ?? process.env.POCKET_NATIVE_PROBE;
  const candidates = configured
    ? [resolve(configured)]
    : [
        join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
        join(sdkRoot, "native/target/release/pocket_probe"),
        join(sdkRoot, "native/target/debug/pocket_probe"),
      ];
  return candidates.find(existsSync);
}

function runProbe(probe: string, commands: readonly JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ProbeResponse);
}

test("pinned QJBC keeps coordinates above 1023 through the native touch sidecar", async () => {
  const probe = nativeProbePath();
  assert.ok(probe, "build a fresh pocket_probe and set POCKET_FULL_COORDS_PROBE to its path");
  const project = mkdtempSync(join(tmpdir(), "pocket-fullcoords-guest-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fullcoords-guest", private: true }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "fixture.fullcoords", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "fixture.fullcoords", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
function App() {
  const viewport = hostViewport(getOps()) ?? { w: 320, h: 240 };
  const targetX = Math.max(0, Math.floor(viewport.w - 200));
  const targetY = Math.max(0, Math.floor(viewport.h - 200));
  const [coordinate, setCoordinate] = createSignal("waiting");
  const [pressed, setPressed] = createSignal(false);
  createGesture({ onDown: contact => setCoordinate(contact.x + "," + contact.y) });
  return <Screen class="relative w-full h-full bg-white">
    <Text style={{ posType: 1, insetL: 8, insetT: 8, width: 400, height: 24 }}>coordinate={coordinate()}</Text>
    <Text style={{ posType: 1, insetL: 8, insetT: 40, width: 400, height: 24 }}>target={pressed() ? "pressed" : "idle"}</Text>
    <Focusable style={{ posType: 1, insetL: targetX, insetT: targetY, width: 160, height: 120, bgColor: 4279312947 }} onPress={() => setPressed(true)} />
  </Screen>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: output });
    const viewports = [
      { width: 1920, height: 1080, x: 1730, y: 890 },
      { width: 2560, height: 1440, x: 2370, y: 1250 },
      { width: 1200, height: 2400, x: 1010, y: 2210 },
    ];
    for (const viewport of viewports) {
      const responses = runProbe(probe, [
        { op: "create", width: viewport.width, height: viewport.height },
        { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 41, x: viewport.x, y: viewport.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 41, x: viewport.x, y: viewport.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]);
      const frames = responses.flatMap(response => response.frame ? [response.frame] : []);
      const texts = frames.flatMap(frame => frame.ops ?? []).filter(op => op.type === "text").map(op => op.text ?? "");
      assert.ok(texts.some(text => text.includes(`coordinate=${viewport.x},${viewport.y}`)), `lost exact coordinate ${viewport.x},${viewport.y} at ${viewport.width}x${viewport.height}: ${texts.join(" | ")} responses=${JSON.stringify(responses)}`);
      assert.ok(texts.includes("target=pressed"), `high-coordinate touch did not activate the real Focusable at ${viewport.width}x${viewport.height}: ${texts.join(" | ")}`);
      assert.ok(!responses.some(response => response.error), `native probe reported an error at ${viewport.width}x${viewport.height}`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
