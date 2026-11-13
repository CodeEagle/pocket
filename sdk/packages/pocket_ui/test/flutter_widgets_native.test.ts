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

function hasVisibleText(frame: Frame, label: string): boolean {
  return (frame.ops ?? []).some((item) =>
    item.type === "text" &&
    item.text === label &&
    (item.color === undefined || ((item.color >>> 24) & 0xff) !== 0),
  );
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
assert.ok(hasText(initial, "Tap to type"), "closed input must paint its placeholder fallback");
const inputColorKeys = [
  "textColor",
  "placeholderColor",
  "fillColor",
  "borderColor",
  "focusedBorderColor",
] as const;
const expectedInputColors: Record<(typeof inputColorKeys)[number], string> = {
  textColor: "#09090B",
  placeholderColor: "#71717A",
  fillColor: "#ffffff",
  borderColor: "#E4E4E7",
  focusedBorderColor: "#18181B",
};
function assertInputColors(
  payload: JsonObject | undefined,
  color: string | Record<(typeof inputColorKeys)[number], string>,
  label: string,
): void {
  assert.ok(payload, `${label} must have an input payload`);
  for (const key of inputColorKeys) {
    const expected = typeof color === "string" ? color : color[key];
    assert.equal(payload[key], expected, `${label} ${key} must be ${expected}`);
  }
}
const inputResponses = runProbe([
  ...bootstrap(),
  ...tap(inputPoint),
  // A native edit can arrive while the overlay is mounted but its attach ACK
  // is still in flight. The older ACK remains a mount fact for this session.
  event("textInput.edit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    text: "林岚🙂",
    selectionBase: 4,
    selectionExtent: 4,
    composingBase: 2,
    composingExtent: 4,
    revision: 1,
    jsRevision: 1,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    // These revisions can be older than an edit delivered after this mount
    // ACK was created. They must not invalidate the successful attachment.
    revision: 0,
    jsRevision: 0,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 0,
    jsRevision: 0,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    text: "林岚🙂",
    selectionBase: 4,
    selectionExtent: 4,
    composingBase: 2,
    composingExtent: 4,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.dismiss", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 1,
    jsRevision: 1,
    reason: "outside",
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 1,
    jsRevision: 1,
  }),
  { op: "frame", deltaMs: 16 },
  ...tap(inputPoint),
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 0,
    jsRevision: 2,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:2",
    revision: 0,
    jsRevision: 2,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.submit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:2",
    text: "native submitted",
    selectionBase: 16,
    selectionExtent: 16,
    composingBase: -1,
    composingExtent: -1,
    revision: 1,
    jsRevision: 2,
  }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const inputFrames = framesOf(inputResponses);
assert.ok(inputFrames.length >= 14, `expected input lifecycle frames, received ${inputFrames.length}`);
const openEvent = inputFrames
  .flatMap((frame) => frameEvents(frame, "textInput.open"))
  .find((item) => item.payload?.id === "guest-text-input-1");
assert.ok(openEvent, "native QJBC pointer input did not emit textInput.open");
assertInputColors(openEvent.payload, "transparent", "initial textInput.open");
const openRect = openEvent.payload?.rect;
assert.ok(openRect && typeof openRect === "object", "textInput.open must carry a measured rect");
assert.equal(typeof (openRect as JsonObject).x, "number", "textInput.open rect must have x");
assert.equal(typeof (openRect as JsonObject).y, "number", "textInput.open rect must have y");
assert.equal(typeof (openRect as JsonObject).width, "number", "textInput.open rect must have width");
assert.equal(typeof (openRect as JsonObject).height, "number", "textInput.open rect must have height");
const openHeight = (openRect as JsonObject).height as number;
assert.ok(openHeight > 0, "textInput.open rect height must be positive");
const inputFontSize = openEvent.payload?.fontSize;
const inputPaddingVertical = openEvent.payload?.paddingVertical;
assert.equal(typeof inputFontSize, "number", "textInput.open must describe its font size");
assert.equal(typeof inputPaddingVertical, "number", "textInput.open must describe vertical padding");
const requiredInputHeight = Math.ceil((inputFontSize as number) * 1.2) + 2 * (inputPaddingVertical as number);
assert.ok(
  openHeight >= requiredInputHeight,
  `textInput.open shell is shorter than its line box plus padding: rect=${openHeight}, required=${requiredInputHeight}`,
);
const openFrame = inputFrames.find((frame) => frameEvents(frame, "textInput.open").length > 0);
assert.ok(openFrame, "textInput.open frame is missing");
assert.ok(hasText(openFrame!, "Tap to type"), "guest fallback should remain until the host confirms overlay attachment");
const preAckEditFrame = inputFrames[3];
assert.ok(preAckEditFrame && hasText(preAckEditFrame, "林岚🙂"), "pre-ACK native edit should remain visible through the Guest fallback");
const openedFrame = inputFrames[4];
assert.ok(openedFrame && !hasVisibleText(openedFrame, "Tap to type"), "textInput.opened did not hide the duplicate guest placeholder");
const openedUpdates = frameEvents(openedFrame!, "textInput.update");
const restoredAppearanceEvents = openedUpdates.filter((item) =>
  inputColorKeys.every((key) => Object.hasOwn(item.payload ?? {}, key)),
);
assert.equal(restoredAppearanceEvents.length, 1, "a successful first ACK should emit one appearance restore");
const restoredAppearance = restoredAppearanceEvents[0]!.payload;
assertInputColors(restoredAppearance, expectedInputColors, "ACK appearance restore");
for (const key of [
  "text",
  "selectionBase",
  "selectionExtent",
  "composingBase",
  "composingExtent",
  "rect",
  "clip",
]) {
  assert.equal(Object.hasOwn(restoredAppearance ?? {}, key), false, `ACK appearance restore must omit ${key}`);
}
assert.equal(restoredAppearance?.id, "guest-text-input-1");
assert.equal(restoredAppearance?.editingSession, "guest-text-input-1:1");
const duplicateOpenedFrame = inputFrames[5];
assert.equal(frameEvents(duplicateOpenedFrame!, "textInput.update").length, 0, "duplicate current-session ACK must not resend appearance restore");
const editedFrame = inputFrames[6];
assert.ok(editedFrame, "native textInput.edit frame is missing");
assert.equal(hasVisibleText(editedFrame, "林岚🙂"), false, "focused native editor should be the sole visible copy of the CJK/emoji value");
assert.equal(frameEvents(editedFrame, "textInput.update").length, 0, "native text echo caused a redundant update");
const dismissedFrame = inputFrames[7];
assert.ok(dismissedFrame && hasText(dismissedFrame, "林岚🙂"), "textInput.dismiss did not restore the edited guest value");
assert.equal((dismissedFrame!.ops ?? []).filter((item) => item.type === "text" && item.text === "林岚🙂").length, 1, "dismissed guest fallback should paint the CJK/emoji value once");
assert.ok(hasText(inputFrames[8]!, "林岚🙂"), "late opened acknowledgement after dismissal must not hide fallback text");
assert.ok(hasText(inputFrames[11]!, "林岚🙂"), "stale opened acknowledgement from the previous editingSession must not hide text");
const reopenedFrame = inputFrames[10];
const reopenedEvent = frameEvents(reopenedFrame!, "textInput.open").find((item) => item.payload?.id === "guest-text-input-1");
assert.ok(reopenedEvent, "reopened input did not emit textInput.open");
assert.equal(reopenedEvent.payload?.editingSession, "guest-text-input-1:2");
assertInputColors(reopenedEvent.payload, "transparent", "reopened textInput.open");
const reopenedAckFrame = inputFrames[12];
assert.equal(hasVisibleText(reopenedAckFrame!, "林岚🙂"), false, "current editingSession acknowledgement should hide the duplicate guest copy");
assert.equal(
  frameEvents(reopenedAckFrame!, "textInput.update").filter((item) =>
    inputColorKeys.every((key) => Object.hasOwn(item.payload ?? {}, key)),
  ).length,
  1,
  "reopened current-session ACK should restore appearance once",
);
assert.ok(hasText(inputFrames[13]!, "native submitted"), "textInput.submit did not restore the submitted QJBC value");

const earlySubmitFrames = framesOf(runProbe([
  ...bootstrap(),
  ...tap(inputPoint),
  event("textInput.submit", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    text: "done before attach",
    selectionBase: 18,
    selectionExtent: 18,
    revision: 1,
    jsRevision: 1,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 1,
    jsRevision: 1,
  }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
assert.ok(
  hasText(earlySubmitFrames.at(-1)!, "done before attach"),
  "an immediate submit must restore the guest text and reject a later attach acknowledgement",
);

const resizeResponses = runProbe([
  ...bootstrap(),
  ...tap(inputPoint),
  event("textInput.opened", {
    id: "guest-text-input-1",
    editingSession: "guest-text-input-1:1",
    revision: 0,
    jsRevision: 0,
  }),
  { op: "frame", deltaMs: 16 },
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
assert.ok(typeof resizeOpenRect.height === "number", "resize open rect must include height");
const resizeOpenHeight = resizeOpenRect.height as number;
assert.ok(resizeOpenHeight > 0, "resize open rect height must be positive");
const resizeInputFontSize = resizeOpen.payload?.fontSize;
const resizeInputPaddingVertical = resizeOpen.payload?.paddingVertical;
assert.equal(typeof resizeInputFontSize, "number");
assert.equal(typeof resizeInputPaddingVertical, "number");
assert.ok(
  resizeOpenHeight >= Math.ceil((resizeInputFontSize as number) * 1.2) +
    2 * (resizeInputPaddingVertical as number),
  "resized input shell opened below its line box plus vertical padding",
);
const movedRectUpdate = resizeFrames
  .flatMap((frame) => frameEvents(frame, "textInput.update"))
  .find((item) => {
    const rect = item.payload?.rect as JsonObject | undefined;
    return rect && typeof rect.y === "number" && rect.y !== resizeOpenRect.y && !Object.hasOwn(item.payload ?? {}, "text");
  });
assert.ok(movedRectUpdate, "live QJBC viewport resize did not emit a rect-only textInput.update");
assert.equal(
  (movedRectUpdate.payload?.rect as JsonObject).height,
  resizeOpenHeight,
  "viewport resize after textInput.opened collapsed the shell height",
);
assert.equal(
  resizeFrames.some((frame) => frameEvents(frame, "textInput.close").some((item) => item.payload?.id === "guest-text-input-1")),
  false,
  "QJBC viewport resize incorrectly closed the active input",
);

console.log(`flutter_widgets_native.test: pointer, compiled scroll and IME layout passed (${probe}; ${artifactDir})`);
if (generatedFixture) rmSync(generatedFixture, { recursive: true, force: true });
