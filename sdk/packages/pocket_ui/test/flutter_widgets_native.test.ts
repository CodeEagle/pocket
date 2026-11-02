import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = {
  type?: string;
  text?: string;
  color?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
type FrameEvent = { name?: string; payload?: JsonObject };
type Frame = { ops?: DrawOp[]; events?: FrameEvent[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
let generatedFixture: string | undefined;
let artifactDir = process.env.POCKET_WIDGET_FIXTURE_DIR ?? process.env.POCKET_WIDGET_FIXTURE_OUTDIR;
if (!artifactDir) {
  // Keep `bun test` self-contained. This remains a real QuickJS/native probe;
  // it only builds its small public-widget fixture on demand for CI.
  generatedFixture = mkdtempSync(join(tmpdir(), "pocket-ui-flutter-widgets-native-"));
  const build = spawnSync("bun", [join(testDir, "flutter_widgets.test.ts")], {
    env: { ...process.env, POCKET_WIDGET_FIXTURE_OUTDIR: generatedFixture },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    rmSync(generatedFixture, { recursive: true, force: true });
    throw new Error(`flutter_widgets_native.test: fixture build failed\n${build.stdout}\n${build.stderr}`);
  }
  artifactDir = generatedFixture;
}

const bytecodePath = join(resolve(artifactDir!), "app.qjbc");
const pakPath = join(resolve(artifactDir!), "app.pak");
assert.ok(existsSync(bytecodePath), `fixture bytecode is missing: ${bytecodePath}`);
assert.ok(existsSync(pakPath), `fixture PAK is missing: ${pakPath}`);
const configuredProbe = process.env.POCKET_NATIVE_PROBE;
const probe = configuredProbe
  ? resolve(configuredProbe)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);
assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");

function event(name: string, payload: JsonObject): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function bootstrap(): JsonObject[] {
  return [
    { op: "create", width: 390, height: 844 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
  ];
}

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const result = spawnSync(probe!, {
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => response.frame ? [response.frame] : []);
}

function textOp(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing text label ${label}`);
  return op;
}

function hasText(frame: Frame, label: string): boolean {
  return (frame.ops ?? []).some((item) => item.type === "text" && item.text === label);
}

function textValue(frame: Frame, prefix: string): string {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text?.startsWith(prefix));
  assert.ok(op?.text, `frame is missing text prefix ${prefix}`);
  return op.text!;
}

function frameEvents(frame: Frame, name: string): FrameEvent[] {
  return (frame.events ?? []).filter((item) => item.name === name);
}

function progressFill(frame: Frame): DrawOp {
  // The track is 350px wide; the determinate child is emitted as two
  // rounded rect rows, both narrower than the track. Read the actual draw
  // command rather than inferring progress from the label.
  const op = (frame.ops ?? []).find((item) =>
    item.type === "rect" &&
    typeof item.w === "number" && item.w > 0 && item.w < 350 &&
    item.h === 4,
  );
  assert.ok(op, "frame is missing the determinate progress fill rect");
  return op;
}

function center(frame: Frame, label: string): { x: number; y: number } {
  const op = textOp(frame, label);
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function tap(point: { x: number; y: number }): JsonObject[] {
  return [
    event("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y }),
    { op: "frame", deltaMs: 16 },
    event("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y }),
    { op: "frame", deltaMs: 16 },
  ];
}

const initialResponses = runProbe([...bootstrap(), { op: "quit" }]);
const initial = framesOf(initialResponses)[0];
assert.ok(initial, "fixture did not produce an initial frame");
assert.equal(textValue(initial, "Progress "), "Progress 50%");
assert.equal(textValue(initial, "FAB "), "FAB enabled");

const advance = center(initial, "Advance");
const toggleDisabled = center(initial, "!");
const library = center(initial, "Library");
const chip = center(initial, "Toggle Chip");
const initialHomeColor = textOp(initial, "Home").color;
const initialLibraryColor = textOp(initial, "Library").color;
const initialChipColor = textOp(initial, "Toggle Chip").color;
const initialFill = progressFill(initial);

// Each tap contributes a down frame and an up frame. The final frame after
// tap N is therefore frames[2 + N * 2], which is the state after the native
// pointer path has dispatched the JS callback and settled the tree.
const interactiveResponses = runProbe([
  ...bootstrap(),
  ...tap(advance),       // 50 -> 60
  ...tap(toggleDisabled),
  ...tap(advance),       // disabled: remains 60
  ...tap(toggleDisabled),
  ...tap(advance),       // re-enabled: 60 -> 70
  ...tap(library),        // selected destination changes
  ...tap(chip),           // selected chip changes
  { op: "quit" },
]);
const frames = framesOf(interactiveResponses);
assert.ok(frames.length >= 15, `expected initial + 7 pointer taps, got ${frames.length} frames`);
const afterAdvance = frames[2]!;
const afterDisable = frames[4]!;
const afterDisabledAdvance = frames[6]!;
const afterEnable = frames[8]!;
const afterReenabledAdvance = frames[10]!;
const afterLibrary = frames[12]!;
const afterChip = frames[14]!;
const afterAdvanceFill = progressFill(afterAdvance);
const afterReenabledFill = progressFill(afterReenabledAdvance);

assert.equal(textValue(afterAdvance, "Progress "), "Progress 60%");
assert.equal(textValue(afterDisable, "FAB "), "FAB disabled");
assert.equal(textValue(afterDisabledAdvance, "Progress "), "Progress 60%");
assert.equal(textValue(afterEnable, "FAB "), "FAB enabled");
assert.equal(textValue(afterReenabledAdvance, "Progress "), "Progress 70%");
assert.ok(afterAdvanceFill.w! > initialFill.w!, `progress draw width did not grow at 60% (${initialFill.w} -> ${afterAdvanceFill.w})`);
assert.ok(afterReenabledFill.w! > afterAdvanceFill.w!, `progress draw width did not grow at 70% (${afterAdvanceFill.w} -> ${afterReenabledFill.w})`);
assert.ok(Math.abs((afterAdvanceFill.w! / initialFill.w!) - 1.2) < 0.08, "60% fill width is not proportional to 50%");

assert.notEqual(textOp(afterLibrary, "Home").color, initialHomeColor, "Home did not lose selected styling");
assert.notEqual(textOp(afterLibrary, "Library").color, initialLibraryColor, "Library did not gain selected styling");
assert.equal(textOp(afterLibrary, "Library").color, initialHomeColor, "Library selected color differs from initial Home color");
assert.notEqual(textOp(afterChip, "Toggle Chip").color, initialChipColor, "Chip selected styling did not update");

// The compiled fixture also mounts the real JS page scroller and input shell.
// Drive it through the native QuickJS probe so this is a QJBC layout/IME
// check, not only the isolated mocked geometry test in flutter_widgets.test.
const inputPoint = center(initial, "Tap to type");
const inputResponses = runProbe([
  ...bootstrap(),
  ...tap(inputPoint),
  event("textInput.edit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    text: "native input",
    selectionBase: 12,
    selectionExtent: 12,
    composingBase: -1,
    composingExtent: -1,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.submit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    text: "native submitted",
    selectionBase: 16,
    selectionExtent: 16,
    composingBase: -1,
    composingExtent: -1,
  }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const inputFrames = framesOf(inputResponses);
const openEvent = inputFrames
  .flatMap((frame) => frameEvents(frame, "textInput.open"))
  .find((item) => item.payload?.id === "guest-text-input-1");
assert.ok(openEvent, "native QJBC pointer input did not emit textInput.open");
const openRect = openEvent.payload?.rect;
assert.ok(openRect && typeof openRect === "object", "textInput.open must carry a measured rect");
assert.equal(typeof (openRect as JsonObject).x, "number", "textInput.open rect must have x");
assert.equal(typeof (openRect as JsonObject).y, "number", "textInput.open rect must have y");
assert.equal(typeof (openRect as JsonObject).width, "number", "textInput.open rect must have width");
assert.equal(typeof (openRect as JsonObject).height, "number", "textInput.open rect must have height");
const editedFrame = inputFrames.find((frame) => hasText(frame, "native input"));
assert.ok(editedFrame, "native textInput.edit did not update the QJBC draft");
assert.equal(frameEvents(editedFrame!, "textInput.update").length, 0, "native text echo caused a redundant update");
assert.ok(inputFrames.some((frame) => hasText(frame, "native submitted")), "textInput.submit did not update the QJBC draft");

const resizeResponses = runProbe([
  ...bootstrap(),
  ...tap(inputPoint),
  { op: "resize", width: 390, height: 200 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const resizeFrames = framesOf(resizeResponses);
const resizeOpen = resizeFrames
  .flatMap((frame) => frameEvents(frame, "textInput.open"))
  .find((item) => item.payload?.id === "guest-text-input-1");
assert.ok(resizeOpen, "QJBC resize scenario did not open the text input");
const resizeOpenRect = resizeOpen.payload?.rect as JsonObject | undefined;
assert.ok(resizeOpenRect && typeof resizeOpenRect.y === "number", "resize open rect must include y");
const movedRectUpdate = resizeFrames
  .flatMap((frame) => frameEvents(frame, "textInput.update"))
  .find((item) => {
    const rect = item.payload?.rect as JsonObject | undefined;
    return rect && typeof rect.y === "number" && rect.y !== resizeOpenRect.y && !Object.hasOwn(item.payload ?? {}, "text");
  });
assert.ok(movedRectUpdate, "live QJBC viewport resize did not emit a rect-only textInput.update");
assert.equal(
  resizeFrames.some((frame) => frameEvents(frame, "textInput.close").some((item) => item.payload?.id === "guest-text-input-1")),
  false,
  "QJBC viewport resize incorrectly closed the active input",
);

console.log(`flutter_widgets_native.test: pointer, compiled scroll and IME layout passed (${probe}; ${artifactDir})`);
if (generatedFixture) rmSync(generatedFixture, { recursive: true, force: true });
