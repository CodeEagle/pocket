import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & {
  type?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
type Frame = { ops?: DrawOp[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);
assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");

const project = mkdtempSync(join(tmpdir(), "pocket-ui-navigation-bar-native-"));
const output = join(project, "out");

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const outputText = String(result.stdout ?? "").trim();
  assert.ok(outputText, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return outputText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => response.frame ? [response.frame] : []);
}

function textOp(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing navigation label ${label}`);
  return op;
}

function center(frame: Frame, label: string): number {
  const op = textOp(frame, label);
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  return op.x! + op.w! / 2;
}

function centerPoint(frame: Frame, label: string): { x: number; y: number } {
  const op = textOp(frame, label);
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function assertEvenBottomNavigation(frame: Frame, width: number): void {
  const centers = ["Home", "Gallery", "Host"].map((label) => center(frame, label));
  const expected = [width / 6, width / 2, width * 5 / 6];
  for (let index = 0; index < centers.length; index += 1) {
    assert.ok(
      Math.abs(centers[index]! - expected[index]!) < 24,
      `${["Home", "Gallery", "Host"][index]} center ${centers[index]} is not in equal-width cell ${expected[index]}`,
    );
  }
  assert.ok(centers[1]! - centers[0]! > width * 0.25, `first and second tabs are still intrinsic-width packed: ${centers.join(", ")}`);
  assert.ok(centers[2]! - centers[1]! > width * 0.25, `second and third tabs are still intrinsic-width packed: ${centers.join(", ")}`);
}

try {
  const fixture = join(testDir, "navigation_bar_fixture");
  cpSync(fixture, project, { recursive: true });
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));

  const build = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const bytecodePath = join(output, "app.qjbc");
  const pakPath = join(output, "app.pak");
  assert.ok(existsSync(bytecodePath), "navigation fixture bytecode is missing");
  assert.ok(existsSync(pakPath), "navigation fixture PAK is missing");

  const narrowResponses = runProbe([
    { op: "create", width: 390, height: 844 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ]);
  const narrow = framesOf(narrowResponses)[0];
  assert.ok(narrow, "navigation fixture did not produce a narrow frame");
  assertEvenBottomNavigation(narrow, 390);

  const wideResponses = runProbe([
    { op: "create", width: 720, height: 844 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ]);
  const wide = framesOf(wideResponses)[0];
  assert.ok(wide, "navigation fixture did not produce a wide frame");
  assertEvenBottomNavigation(wide, 720);
  const wideCenters = ["Home", "Gallery", "Host"].map((label) => centerPoint(wide, label));
  assert.ok(Math.abs(wideCenters[0]!.y - wideCenters[1]!.y) < 1, `wide TabBar items are not aligned horizontally: ${JSON.stringify(wideCenters)}`);
  assert.ok(Math.abs(wideCenters[1]!.y - wideCenters[2]!.y) < 1, `wide TabBar items are not aligned horizontally: ${JSON.stringify(wideCenters)}`);
  assert.ok(wideCenters[0]!.y > 750, `wide TabBar is not anchored at the bottom: ${JSON.stringify(wideCenters)}`);

  const resizedResponses = runProbe([
    { op: "create", width: 390, height: 844 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "resize", width: 480, height: 844 },
    { op: "frame", deltaMs: 16 },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ]);
  const resizedFrames = framesOf(resizedResponses);
  const resized = resizedFrames[resizedFrames.length - 1];
  assert.ok(resized, "navigation fixture did not produce a resized frame");
  assertEvenBottomNavigation(resized, 480);

  const duoOpenPayload = {
    width: 951,
    height: 669,
    safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
    keyboardInset: 0,
    reservedRegions: [
      {
        id: "duo-hinge",
        kind: "division",
        frame: { left: 465.5, top: 0, width: 20, height: 669 },
        margins: { top: 0, right: 10, bottom: 0, left: 10 },
        active: true,
      },
      {
        id: "duo-status-icons",
        kind: "occlusion",
        frame: { left: 877, top: 0, width: 74, height: 114 },
        margins: { top: 0, right: 0, bottom: 10, left: 10 },
        active: true,
      },
    ],
  };
  const duoFoldedPayload = {
    width: 466,
    height: 678,
    safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
    keyboardInset: 0,
    reservedRegions: [
      {
        id: "duo-status-icons-folded",
        kind: "occlusion",
        frame: { left: 392, top: 0, width: 74, height: 164 },
        margins: { top: 0, right: 0, bottom: 10, left: 10 },
        active: true,
      },
    ],
  };
  const duoResponses = runProbe([
    { op: "create", width: 951, height: 669 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "send", message: { type: "event", name: "display.viewport", payload: duoOpenPayload } },
    { op: "frame", deltaMs: 16 },
    { op: "resize", width: 466, height: 678 },
    { op: "send", message: { type: "event", name: "display.viewport", payload: duoFoldedPayload } },
    { op: "frame", deltaMs: 16 },
    { op: "frame", deltaMs: 16 },
    { op: "resize", width: 951, height: 669 },
    { op: "send", message: { type: "event", name: "display.viewport", payload: duoOpenPayload } },
    { op: "frame", deltaMs: 16 },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ]);
  const duoFrames = framesOf(duoResponses);
  const duoOpen = duoFrames[0];
  const duoFolded = duoFrames[2];
  const duoReopened = duoFrames[4];
  assert.ok(duoOpen && duoFolded && duoReopened, "navigation fixture did not produce Duo posture frames");
  assertEvenBottomNavigation(duoOpen, 951);
  assertEvenBottomNavigation(duoFolded, 466);
  assertEvenBottomNavigation(duoReopened, 951);
  console.log(`navigation_bar_native.test: equal bottom TabBar across narrow, wide, resize, and Duo fold/unfold passed (${probe})`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
