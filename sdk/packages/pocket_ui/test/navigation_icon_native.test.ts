import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type Point = { x: number; y: number };
type DrawOp = { type?: string; text?: string; points?: Point[]; x?: number; y?: number; w?: number; h?: number };
type Frame = { ops?: DrawOp[] };
type ProbeResponse = { frame?: Frame; error?: string };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);

const fixtureSource = `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { MobileBackButton, MobileThemeProvider, MOBILE_THEME_LIGHT } from "@pocket/ui";

function App() {
  const [pressed, setPressed] = createSignal(false);
  return (
    <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
      <Screen class="w-full h-full flex-col bg-[#FAFAFA]">
        <View class="relative w-full h-[64] flex-row items-center bg-white">
          <MobileBackButton onPress={() => setPressed(true)} />
          <View class="absolute left-[88] top-[20]">
            <Text class="text-base text-[#17233B]">Arrow fixture</Text>
          </View>
        </View>
        <Text class="text-base text-[#17233B]">{() => pressed() ? "Pressed" : "Ready"}</Text>
      </Screen>
    </MobileThemeProvider>
  );
}

mount(() => <App />);
`;

function runProbe(commands: Record<string, unknown>[]): ProbeResponse[] {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required");
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function lastFrame(responses: ProbeResponse[]): Frame {
  const frame = responses.flatMap((response) => response.frame ? [response.frame] : []).at(-1);
  assert.ok(frame, "arrow fixture did not produce a frame");
  return frame;
}

function textOp(frame: Frame, text: string): DrawOp {
  const op = (frame.ops ?? []).find((candidate) => candidate.type === "text" && candidate.text === text);
  assert.ok(op, `arrow fixture is missing ${text}`);
  return op;
}

function triangleOps(frame: Frame): DrawOp[] {
  return (frame.ops ?? []).filter((op) =>
    op.type === "triangle" &&
    op.points?.length === 3 &&
    op.points.every((point) => point.x >= 0 && point.x < 48 && point.y >= 0 && point.y < 64),
  );
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((point, index) =>
    index === 0 || point.x !== sorted[index - 1]!.x || point.y !== sorted[index - 1]!.y,
  );
  if (unique.length <= 1) return unique;
  const lower: Point[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function signedArea(polygon: Point[]): number {
  return polygon.reduce((area, point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function clipPolygon(subject: Point[], edgeA: Point, edgeB: Point, orientation: number): Point[] {
  const inside = (point: Point): boolean => cross(edgeA, edgeB, point) * orientation >= -1e-6;
  const output: Point[] = [];
  for (let index = 0; index < subject.length; index += 1) {
    const current = subject[index]!;
    const next = subject[(index + 1) % subject.length]!;
    const currentInside = inside(current);
    const nextInside = inside(next);
    if (currentInside) output.push(current);
    if (currentInside !== nextInside) {
      const currentCross = cross(edgeA, edgeB, current) * orientation;
      const nextCross = cross(edgeA, edgeB, next) * orientation;
      const ratio = currentCross / (currentCross - nextCross);
      output.push({
        x: current.x + (next.x - current.x) * ratio,
        y: current.y + (next.y - current.y) * ratio,
      });
    }
  }
  return output;
}

function intersectionArea(subject: Point[], clip: Point[]): number {
  let result = subject;
  const orientation = signedArea(clip) >= 0 ? 1 : -1;
  for (let index = 0; index < clip.length && result.length > 0; index += 1) {
    result = clipPolygon(result, clip[index]!, clip[(index + 1) % clip.length]!, orientation);
  }
  return Math.abs(signedArea(result));
}

function leftTip(stroke: Point[]): Point {
  const left = Math.min(...stroke.map((point) => point.x));
  const candidates = stroke.filter((point) => Math.abs(point.x - left) <= 0.25);
  assert.equal(candidates.length, 1, `stroke must have one pointed left tip: ${JSON.stringify(stroke)}`);
  return {
    x: candidates.reduce((sum, point) => sum + point.x, 0) / candidates.length,
    y: candidates.reduce((sum, point) => sum + point.y, 0) / candidates.length,
  };
}

test("MobileBackButton native chevron has one valley and remains tappable", { timeout: 180_000 }, () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-navigation-icon-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "navigation-icon-native-fixture", private: true, type: "module" }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.navigation-icon", entry: "app.tsx" }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), fixtureSource);

    const build = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const bytecodePath = join(output, "app.qjbc");
    const pakPath = join(output, "app.pak");
    assert.ok(existsSync(bytecodePath), "arrow fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "arrow fixture PAK is missing");

    const initial = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    textOp(initial, "Arrow fixture");
    textOp(initial, "Ready");
    const triangles = triangleOps(initial);
    assert.equal(triangles.length, 4, `back chevron must be two complete rotated rectangles: ${JSON.stringify(triangles)}`);
    const strokes = [
      convexHull(triangles.slice(0, 2).flatMap((op) => op.points!)),
      convexHull(triangles.slice(2).flatMap((op) => op.points!)),
    ];
    assert.ok(strokes.every((stroke) => stroke.length === 4), `back chevron strokes must stay convex quads: ${JSON.stringify(strokes)}`);
    const tips = strokes.map(leftTip);
    assert.ok(Math.abs(tips[0]!.x - tips[1]!.x) <= 0.25, `back chevron tips do not share x: ${JSON.stringify(tips)}`);
    assert.ok(Math.abs(tips[0]!.y - tips[1]!.y) <= 0.25, `back chevron tips do not share one valley: ${JSON.stringify(tips)}`);
    const overlap = intersectionArea(strokes[0]!, strokes[1]!);
    // The exact pivot geometry has 9 logical px² before native quantization;
    // the pinned DrawList currently reports 8, while the old 3x11/7-offset
    // bars only overlap by about 4.2 and leave the visible joint unstable.
    assert.ok(overlap >= 7.5, `back chevron strokes do not overlap inside the shared tip (${overlap})`);
    const allPoints = strokes.flat();
    const left = Math.min(...allPoints.map((point) => point.x));
    const right = Math.max(...allPoints.map((point) => point.x));
    const top = Math.min(...allPoints.map((point) => point.y));
    const bottom = Math.max(...allPoints.map((point) => point.y));
    assert.ok(right - left > 6 && right - left < 32, `back chevron width is out of bounds: ${right - left}`);
    assert.ok(bottom - top > 10 && bottom - top < 36, `back chevron height is out of bounds: ${bottom - top}`);
    const valley = { x: left + (right - left) * 0.2, y: (top + bottom) / 2 };
    const pressed = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: valley.x, y: valley.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: valley.x, y: valley.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    textOp(pressed, "Pressed");
    console.log(`navigation_icon_native.test: chevron shared tip ${JSON.stringify(tips)}, overlap ${overlap.toFixed(2)} logical px², bounds ${JSON.stringify({ left, top, right, bottom })}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
