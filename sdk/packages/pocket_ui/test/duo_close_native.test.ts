import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { buildGuest } from "../../../scripts/build_guest.ts";
import { resolveNativeProbePath } from "../../../scripts/native_probe_path.ts";
import { DISPLAY_UI_SAFETY_GAP } from "../src/responsive.ts";

type JsonObject = Record<string, unknown>;
type FrameEvent = { name?: string; payload?: JsonObject };
type FrameOp = { type?: string; id?: string; x?: number; y?: number; w?: number; h?: number };
type Frame = { events?: FrameEvent[]; ops?: FrameOp[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const sdkRoot = resolve(import.meta.dir, "../../..");
const testTimeoutMs = 120_000;

function event(name: string, payload: JsonObject): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  for (const response of responses) assert.notEqual(response.ok, false, response.error);
  return responses.flatMap(response => response.frame ? [response.frame] : []);
}

function fixtureCloseEvents(frames: Frame[]): FrameEvent[] {
  return frames.flatMap(frame => (frame.events ?? []).filter(item => item.name === "fixture.close"));
}

function settleFrames(count = 32): JsonObject[] {
  // 32 × 16ms is longer than the 420ms retained transition, including one
  // frame for a display.viewport update and one for the event dispatch.
  return Array.from({ length: count }, () => ({ op: "frame", deltaMs: 16 }));
}

function tap(x: number, y: number): JsonObject[] {
  return [
    event("input.pointer", { phase: "down", id: 0, x, y }),
    { op: "frame", deltaMs: 16 },
    event("input.pointer", { phase: "up", id: 0, x, y }),
    { op: "frame", deltaMs: 16 },
  ];
}

function viewport(width: number, height: number, divisionActive: boolean): JsonObject {
  return event("display.viewport", {
    width,
    height,
    safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
    keyboardInset: 0,
    reservedRegions: [
      ...(width > 700 ? [{
        id: "duo-hinge",
        kind: "division",
        frame: { left: 455.5, top: 0, width: 40, height },
        margins: { top: 0, right: 20, bottom: 0, left: 20 },
        active: divisionActive,
      }] : []),
      {
        id: "duo-status-icons",
        kind: "occlusion",
        frame: { left: width - 84, top: 0, width: 84, height: width > 700 ? 124 : 174 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      },
    ],
  });
}

function runProbe(probe: string, bytecodePath: string, pakPath: string): ProbeResponse[] {
  const folded = viewport(466, 678, false);
  const open = viewport(951, 669, true);
  const commands: JsonObject[] = [
    { op: "create", width: 466, height: 678, compositorSurfaces: { "app.child": 2 } },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    folded,
    ...settleFrames(),
    // Folded close stays at the top in the app-bar action slot to the right of
    // Guest A (x=330..374, y=8..52). Both the raw top-right status area and the
    // right rail below the status contour must remain inert.
    ...tap(436, 30),
    ...tap(436, 208),
    ...tap(352, 30),
    // Keep the same runtime and update only its display geometry to open Duo.
    // The native input surface must follow the geometry update as well; the
    // display.viewport event is the JS source of truth, while resize makes
    // the probe's hit-test canvas use the same open dimensions.
    { op: "resize", width: 951, height: 669 },
    open,
    ...settleFrames(),
    // Open close remains top-left of the raw 84px safe edge (x=815..859).
    ...tap(921, 30),
    ...tap(837, 30),
    // Exercise the reverse open -> folded transition in the same runtime.
    { op: "resize", width: 466, height: 678 },
    folded,
    ...settleFrames(),
    ...tap(436, 30),
    ...tap(436, 190),
    ...tap(352, 30),
    { op: "quit" },
  ];
  const result = spawnSync(probe, {
    input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: testTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `duo_close_native probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `duo_close_native probe returned no output: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ProbeResponse);
}

test("native Duo close hitbox stays in the top app-bar slot across folded and open postures", async () => {
  const probe = resolveNativeProbePath(sdkRoot);
  assert.ok(existsSync(probe), "a bytecode-capable pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-duo-close-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.ui.duo-close-native",
      app: {
        entry: "app.tsx",
        framework: "solid",
        viewport: { fixed: { logical: [466, 678], presentation: "native" } },
      },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: ["ui.compositor-surfaces"] } }));
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";

const pocketGlobal = globalThis as typeof globalThis & { pocket?: { _emitValue?: (packet: Record<string, unknown>) => boolean } };
const binding = { appId: "app.child", instanceId: "child-1", surfaceHandle: 2, focused: true, ready: true };
const system = {
  surfaceBindings: () => [binding],
  subscribe: (_listener: () => void) => () => {},
  onBeforeDismiss: (_handler: (instanceIds: readonly string[]) => Promise<void>) => () => {},
};
function onClose(): void {
  pocketGlobal.pocket?._emitValue?.({ type: "event", name: "fixture.close", payload: { instanceId: binding.instanceId } });
}
mount(() => <SystemAppSurfaces presentation="mini-app" system={system} onClose={onClose} />);
`);

    const build = await buildGuest({ projectRoot: project, outDir: output });
    assert.ok(existsSync(build.bytecode), "duo close fixture bytecode is missing");
    assert.ok(existsSync(build.pak), "duo close fixture PAK is missing");
    // Keep the shared safety contract visible in the test source so a future
    // layout change cannot silently turn the 12px UI gap into an OS fact.
    assert.equal(DISPLAY_UI_SAFETY_GAP, 12);
    const frames = framesOf(runProbe(probe, build.bytecode, build.pak));
    const closeEvents = fixtureCloseEvents(frames);
    // Check each tap separately: each tap contributes two frames after the
    // initial frame and 32 settling frames.
    assert.equal(frames.length, 113, "all settling and pointer frames must complete");
    assert.deepEqual([
      fixtureCloseEvents(frames.slice(33, 35)).length,
      fixtureCloseEvents(frames.slice(35, 37)).length,
      fixtureCloseEvents(frames.slice(37, 39)).length,
      fixtureCloseEvents(frames.slice(71, 73)).length,
      fixtureCloseEvents(frames.slice(73, 75)).length,
      fixtureCloseEvents(frames.slice(107, 109)).length,
      fixtureCloseEvents(frames.slice(109, 111)).length,
      fixtureCloseEvents(frames.slice(111, 113)).length,
    ], [0, 0, 1, 0, 1, 0, 0, 1], "fold/open/fold close positions must accept only the top app-bar slot to the right of Guest A");
    assert.ok(closeEvents.every(item => item.payload?.instanceId === "child-1"));
    console.log(`duo_close_native: folded top slot and open top slot hit; status/rail points inert (${probe})`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, testTimeoutMs);

test("native late mini-app subscriber uses the latest viewport before its first settled close hit", async () => {
  const probe = resolveNativeProbePath(sdkRoot);
  assert.ok(existsSync(probe), "a bytecode-capable pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-display-replay-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.ui.display-replay-native",
      app: {
        entry: "app.tsx",
        framework: "solid",
        viewport: { fixed: { logical: [466, 678], presentation: "native" } },
      },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: ["ui.compositor-surfaces"] } }));
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createDisplayGeometry } from "@pocket/ui/display";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";
import { createEffect, createSignal, Show } from "solid-js";

const pocketGlobal = globalThis as typeof globalThis & { pocket?: { _emitValue?: (packet: Record<string, unknown>) => boolean } };
const binding = { appId: "app.child", instanceId: "late-child", surfaceHandle: 2, focused: true, ready: true };
const system = {
  surfaceBindings: () => [binding],
  subscribe: (_listener: () => void) => () => {},
  onBeforeDismiss: (_handler: (instanceIds: readonly string[]) => Promise<void>) => () => {},
};
function App() {
  // The root shell receives geometry before admitting the mini-app surface.
  // The child then creates a fresh display signal from the same bridge.
  const rootGeometry = createDisplayGeometry();
  const [admitted, setAdmitted] = createSignal(false);
  createEffect(() => {
    // Admit only after a same-size partial update. The root signal must carry
    // the prior safe area/occlusion snapshot across that update; a raw-packet
    // replay would lose the folded contour for this late child.
    if (rootGeometry().width === 466 && rootGeometry().keyboardInset === 18 && rootGeometry().reservedRegions.length > 0) setAdmitted(true);
  });
  const close = (): void => {
    pocketGlobal.pocket?._emitValue?.({ type: "event", name: "fixture.close", payload: { instanceId: binding.instanceId } });
  };
  return <Show when={admitted()}><SystemAppSurfaces presentation="mini-app" system={system} onClose={close} /></Show>;
}
mount(() => <App />);
`);

    const build = await buildGuest({ projectRoot: project, outDir: output });
    // The viewport arrives while only the root subscriber exists. After it
    // admits the child, the child's first settled hit test must use the
    // replayed right safe-area inset (`safeArea.right = 84`) and place the
    // close control in the top app-bar slot (`x = 330..374, y = 8..52`);
    // EMPTY_DISPLAY_GEOMETRY would leave the top slot inert and put the target
    // under the status icons at the raw right edge (`x = 414..458`).
    const commands = [
      { op: "create", width: 466, height: 678, compositorSurfaces: { "app.child": 2 } },
      { op: "loadBytecode", bytecodePath: build.bytecode, pakPath: build.pak },
      { op: "frame", deltaMs: 16 },
      viewport(466, 678, false),
      event("display.viewport", { width: 466, height: 678, keyboardInset: 18 }),
      ...settleFrames(),
      ...tap(436, 30),
      ...tap(352, 30),
      { op: "quit" },
    ];
    const responses = spawnSync(probe, {
      input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
      encoding: "utf8",
      timeout: testTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (responses.error) throw responses.error;
    assert.equal(responses.status, 0, `display replay probe exited ${String(responses.status)}: ${responses.stderr || responses.stdout}`);
    const replayFrames = framesOf(String(responses.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ProbeResponse));
    assert.equal(replayFrames.length, 37, "replay fixture must expose the initial, settled, and two tap frame pairs");
    assert.deepEqual([
      fixtureCloseEvents(replayFrames.slice(33, 35)).length,
      fixtureCloseEvents(replayFrames.slice(35, 37)).length,
    ], [0, 1], "late child must reject the raw top-right status tap and accept the top app-bar slot tap");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, testTimeoutMs);
