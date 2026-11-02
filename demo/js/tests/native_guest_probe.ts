import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type ProbeResponse = {
  ok?: boolean;
  error?: string;
  runtimeAbi?: string;
  frame?: Frame;
};
type FrameEvent = {
  name?: string;
  payload?: JsonObject;
};
type DrawOp = {
  type?: string;
  text?: string;
  color?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
type Frame = {
  events?: FrameEvent[];
  ops?: DrawOp[];
  frame?: number;
  width?: number;
  height?: number;
};

const root = resolve(import.meta.dir, "..");
const sdkRoot = resolve(root, "..", "..", "sdk");
const flutterRoot = resolve(root, "..");
const bytecodePath = resolve(process.env.POCKET_GUEST_BYTECODE ?? join(flutterRoot, "assets/app.qjbc"));
const pakPath = resolve(process.env.POCKET_GUEST_PAK ?? join(flutterRoot, "assets/app.pak"));
const metadataPath = resolve(process.env.POCKET_GUEST_METADATA ?? join(flutterRoot, "assets/app.bytecode.json"));

function bytecodeCapable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const binary = readFileSync(path).toString("latin1");
    return binary.includes("loadBytecode") && binary.includes("pocket_load_bytecode_files");
  } catch {
    return false;
  }
}

const configuredProbe = process.env.POCKET_NATIVE_PROBE ? resolve(process.env.POCKET_NATIVE_PROBE) : undefined;
const probe = configuredProbe ?? [
  join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
  join(sdkRoot, "native/target/release/pocket_probe"),
  join(sdkRoot, "native/target/debug/pocket_probe"),
].find(bytecodeCapable);

if (!probe || !existsSync(probe) || !bytecodeCapable(probe)) {
  throw new Error(
    "native_guest_probe: a bytecode-capable pocket_probe is required (build native/target/.../pocket_probe)",
  );
}
if (!existsSync(bytecodePath) || !existsSync(pakPath) || !existsSync(metadataPath)) {
  throw new Error("native_guest_probe: app.qjbc, app.pak, and app.bytecode.json are required; run build:guest first");
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as JsonObject;
assert.equal(metadata.entryFormat, "quickjs-bytecode", "native probe must consume the QuickJS artifact");
assert.equal(metadata.kind, "script", "the guest artifact must be a serialized script");
assert.equal(typeof metadata.runtimeAbi, "string", "bytecode metadata must declare runtimeAbi");
assert.equal(typeof metadata.bindingGeneration, "number", "bytecode metadata must declare bindingGeneration");
assert.equal(typeof metadata.tickHz, "number", "bytecode metadata must declare tickHz");

function event(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function hostResponse(
  requestId: string,
  capability: string,
  result: JsonObject,
): JsonObject {
  return event("host.response", { requestId, capability, ok: true, result });
}

function bootstrap(width = 360, height = 640): JsonObject[] {
  const runtimeAbi = String(metadata.runtimeAbi);
  return [
    { op: "create", width, height },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    hostResponse("guest-1", "runtime.info", {
      entryFormat: "quickjs-bytecode",
      runtimeAbi,
      version: "embedded",
      build: 0,
      source: "embedded",
      entryBytes: metadata.bytecodeBytes,
    }),
    hostResponse("guest-2", "plugins.list", {
      plugins: [{ id: "probe.plugin", version: "1.0.0", kind: "capability" }],
    }),
    hostResponse("guest-3", "plugins.packageInfo", {
      provider: "package_info_plus",
      appName: "Pocket Host",
      packageName: "dev.tryjoy.pocket-host",
      version: "0.1.0",
      buildNumber: "1",
    }),
    hostResponse("guest-4", "updates.status", {
      configured: false,
      stage: "not_configured",
      activeVersion: "embedded",
      activeBuild: 0,
      availableVersion: null,
      versions: [],
      lastError: null,
    }),
    { op: "frame", deltaMs: 16 },
  ];
}

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const result = spawnSync(probe!, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `native probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `native probe produced no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as ProbeResponse;
    } catch (error) {
      throw new Error(`native probe returned invalid JSON: ${String(error)}\n${line}`);
    }
  });
}

function checked(response: ProbeResponse | undefined, operation: string): ProbeResponse {
  assert.ok(response, `${operation}: missing probe response`);
  assert.equal(response.ok, true, `${operation}: ${response.error ?? "unknown native error"}`);
  return response;
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => response.frame ? [response.frame] : []);
}

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

function textOp(frame: Frame, label: string): DrawOp | undefined {
  return (frame.ops ?? []).find((op) => op.type === "text" && op.text === label);
}

function labelCenter(frame: Frame, label: string): { x: number; y: number } {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing interactive label ${label}`);
  assert.equal(typeof op.x, "number", `${label} must have an x bound`);
  assert.equal(typeof op.y, "number", `${label} must have a y bound`);
  assert.equal(typeof op.w, "number", `${label} must have a width bound`);
  assert.equal(typeof op.h, "number", `${label} must have a height bound`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function frameEvents(frame: Frame, name: string): FrameEvent[] {
  return (frame.events ?? []).filter((item) => item.name === name);
}

// First exercise each host result on the page that renders it. This also gives
// the pointer test measured coordinates rather than embedding Dart hit boxes.
const resultResponses = runProbe([
  ...bootstrap(),
  event("demo.navigate", { route: "about" }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "plugins" }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "updates" }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "gallery" }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const resultFrames = framesOf(resultResponses);
assert.ok(resultFrames.length >= 6, "native probe must return all bootstrap/page frames");
assert.match(textOf(resultFrames[2]), /quickjs-bytecode/, "runtime.info response did not reach the JS runtime page");
assert.match(textOf(resultFrames[2]), /package_info_plus/, "package_info_plus response did not reach JS");
assert.match(textOf(resultFrames[3]), /probe\.plugin/, "plugins.list response did not reach the JS plugin page");
assert.match(textOf(resultFrames[4]), /configured=false/, "updates.status response did not reach the JS update page");
assert.match(textOf(resultFrames[4]), /stage=not_configured/, "updates.status stage was not rendered");
assert.match(textOf(resultFrames[4]), /active=embedded/, "updates.status active version was not rendered");
assert.match(textOf(resultFrames[4]), /lastError=none/, "updates.status lastError was not rendered");

const readyHome = resultFrames[1];
const gallery = resultFrames[5];
const homePoint = labelCenter(gallery, "Home");
const plusPoint = labelCenter(readyHome, "+1");
const checkPoint = labelCenter(resultFrames[4], "Check");

const pointerAndStressResponses = runProbe([
  ...bootstrap(),
  event("demo.increment"),
  { op: "frame", deltaMs: 16 },
  event("demo.setText", { value: "native guest" }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "gallery" }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, x: homePoint.x, y: homePoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: homePoint.x, y: homePoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, x: plusPoint.x, y: plusPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: plusPoint.x, y: plusPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "gallery" }),
  { op: "frame", deltaMs: 16 },
  event("demo.toggleLazy"),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "updates" }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, x: checkPoint.x, y: checkPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: checkPoint.x, y: checkPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("host.response", {
    requestId: "guest-5",
    capability: "updates.check",
    ok: false,
    error: { code: "capability_unavailable", message: "updates are not configured in probe" },
  }),
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "stress" }),
  { op: "frame", deltaMs: 16 },
  event("demo.stress", { nodes: 100 }),
  { op: "frame", deltaMs: 16 },
  event("demo.stress", { nodes: 500 }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const pointerFrames = framesOf(pointerAndStressResponses);
assert.ok(pointerFrames.length >= 20, "native probe must return pointer and stress frames");
assert.match(textOf(pointerFrames[2]), /01/, "demo.increment did not reach the retained frame");
assert.match(textOf(pointerFrames[3]), /native guest/, "demo.setText did not reach the retained frame");
assert.match(textOf(pointerFrames[4]), /Official building blocks/, "guest route did not reach Gallery");
assert.match(textOf(pointerFrames[6]), /One runtime, one source of truth/, "native pointer Home navigation did not reach the guest route");
assert.match(textOf(pointerFrames[8]), /02/, "native pointer +1 did not update JS state");
assert.match(textOf(pointerFrames[8]), /Incremented in JS/, "native pointer +1 did not dispatch the JS action");
assert.match(textOf(pointerFrames[10]), /Lazy subtree is mounted/, "guest lazy state did not render its subtree");

const updateRequestFrame = pointerFrames[13];
const updateRequests = frameEvents(updateRequestFrame, "host.request");
const updateRequest = updateRequests.find((item) => item.payload?.capability === "updates.check");
assert.ok(updateRequest, "native pointer Check did not produce host.request updates.check");
assert.equal(updateRequest.payload?.requestId, "guest-5", "updates.check request id drifted from the bounded bridge sequence");
assert.match(textOf(pointerFrames[16]), /capability_unavailable/, "host.response error was not rendered by the updates capability lane");
assert.match(textOf(pointerFrames[16]), /not configured/, "host.response error detail was not rendered");

const stress100 = pointerFrames[18];
const stress500 = pointerFrames[19];
assert.match(textOf(stress100), /100 retained nodes/, "100-node JS stress run was not rendered");
assert.match(textOf(stress500), /500 retained nodes/, "500-node JS stress run was not rendered");
assert.ok((stress500.ops?.length ?? 0) > (stress100.ops?.length ?? 0), "500-node stress frame did not redraw more retained nodes");

// Mobile UI pointer regression: the hidden JS-owned dialog must not leave a
// full-screen overlay in the native bounds hit tree. Resolve the Dark button
// from its painted text bounds, press it through the native touch path, and
// require the theme label to change without a Dart handler.
const mobileResponses = runProbe([
  ...bootstrap(390, 669),
  event("demo.navigate", { route: "mobile" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  { op: "quit" },
]);
const mobileFrames = framesOf(mobileResponses);
const mobileReady = mobileFrames.at(-1)!;
const darkPoint = labelCenter(mobileReady, "Dark");
const mobilePointerResponses = runProbe([
  ...bootstrap(390, 669),
  event("demo.navigate", { route: "mobile" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  event("input.pointer", { phase: "down", id: 0, x: darkPoint.x, y: darkPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: darkPoint.x, y: darkPoint.y }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const mobilePointerFrames = framesOf(mobilePointerResponses);
const mobileDarkFrame = mobilePointerFrames.at(-1)!;
assert.match(textOf(mobileDarkFrame), /Light/, "native Mobile UI Dark button did not toggle JS theme state");
assert.doesNotMatch(textOf(mobileDarkFrame), /\bDark\b/, "native Mobile UI theme button remained dark after press");
const mobileRootBackground = (mobileDarkFrame.ops ?? []).find((op) =>
  op.type === "rect" && op.x === 0 && op.y === 0 && op.w === 390 && op.h === 669,
);
assert.equal(
  mobileRootBackground?.color,
  0xff0d1726,
  "mobileDark must drive the root Screen canvas color, not only child labels",
);

// Live orientation/DeviceHub resize must preserve the mounted JS page. The
// native runtime changes its canvas dimensions without reloading QuickJS;
// this catches a responsive FocusScope/layout regression where the rail
// remained visible but the content pane collapsed to zero height.
const liveResizeResponses = runProbe([
  ...bootstrap(390, 669),
  event("demo.increment"),
  { op: "frame", deltaMs: 16 },
  { op: "resize", width: 951, height: 669 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "resize", width: 390, height: 669 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const liveResizeFrames = framesOf(liveResizeResponses);
const liveWide = liveResizeFrames[3];
const liveNarrow = liveResizeFrames.at(-1);
assert.ok(liveWide && liveNarrow, "native resize probe did not return both orientation frames");
for (const [label, frame] of [["wide", liveWide], ["narrow", liveNarrow]] as const) {
  const rendered = textOf(frame!);
  assert.match(rendered, /One runtime, one source of truth/, `${label} resize dropped the JS content pane`);
  assert.match(rendered, /Draft: \(empty\)/, `${label} resize dropped the input panel`);
  assert.match(rendered, /01/, `${label} resize lost the JS counter state`);
  assert.equal(
    (frame!.ops ?? []).some((op) => op.type === "text" && op.text === "JS-owned"),
    false,
    `${label} resize reintroduced the global header badge`,
  );
}

// Measure the actual +1 bounds in both orientations, then drive those
// measured bounds through the native pointer bridge. This is intentionally a
// separate probe from the state-preservation check above: it proves a wide
// counter button is still focusable/hittable at its new pane position.
const orientationLayoutFrames = framesOf(runProbe([
  ...bootstrap(390, 669),
  { op: "resize", width: 951, height: 669 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
const measuredNarrowFrame = orientationLayoutFrames.find((frame) => frame.width === 390 && textOp(frame, "+1"));
const measuredWideFrame = orientationLayoutFrames.find((frame) => frame.width === 951 && textOp(frame, "+1"));
assert.ok(measuredNarrowFrame, "orientation preflight did not paint narrow +1");
assert.ok(measuredWideFrame, "orientation preflight did not paint wide +1");
const measuredNarrowPlus = labelCenter(measuredNarrowFrame!, "+1");
const measuredWidePlus = labelCenter(measuredWideFrame!, "+1");

const widePointerFrames = framesOf(runProbe([
  ...bootstrap(951, 669),
  event("input.pointer", { phase: "down", id: 0, ...measuredWidePlus }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...measuredWidePlus }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
assert.match(textOf(widePointerFrames.at(-1)!), /01/, "wide initial native pointer +1 did not update JS state");
assert.match(textOf(widePointerFrames.at(-1)!), /Incremented in JS/, "wide initial native pointer did not dispatch the JS action");

const resizedPointerFrames = framesOf(runProbe([
  ...bootstrap(390, 669),
  event("input.pointer", { phase: "down", id: 0, ...measuredNarrowPlus }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...measuredNarrowPlus }),
  { op: "frame", deltaMs: 16 },
  { op: "resize", width: 951, height: 669 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, ...measuredWidePlus }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...measuredWidePlus }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
assert.match(textOf(resizedPointerFrames.at(-1)!), /02/, "resize-then-wide native pointer +1 did not update JS state");
assert.match(textOf(resizedPointerFrames.at(-1)!), /Incremented in JS/, "resize-then-wide native pointer did not dispatch the JS action");

// Page-level scroll uses the official gesture/kinetics path. A vertical drag
// inside Home must move a guest text op while preserving the normal tap owner
// for Focusable children.
const scrollResponses = runProbe([
  // Home fits exactly in the normal 360x640 shell. Use the real compact
  // viewport used by the keyboard/rotation path so this exercises a genuine
  // content extent rather than asserting movement where maxScroll is zero.
  ...bootstrap(360, 480),
  event("input.pointer", { phase: "down", id: 0, x: 180, y: 250 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "move", id: 0, x: 180, y: 150 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: 180, y: 150 }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const scrollFrames = framesOf(scrollResponses);
const beforeScrollDraft = textOp(scrollFrames[1]!, "Draft: (empty)");
const afterScrollDraft = textOp(scrollFrames.at(-1)!, "Draft: (empty)");
assert.ok(beforeScrollDraft && afterScrollDraft, "scroll probe could not locate the Home draft label");
assert.equal(typeof beforeScrollDraft.y, "number", "pre-scroll draft must have a y bound");
assert.equal(typeof afterScrollDraft.y, "number", "post-scroll draft must have a y bound");
assert.ok(afterScrollDraft.y! < beforeScrollDraft.y!, "vertical pointer drag did not scroll the guest page");

// The text field is a real Focusable shell. A native pointer activation must
// emit a measured textInput.open packet (the Flutter host consumes its rect
// to place the system TextField), and host edit/submit events must round-trip
// back into the JS-owned draft without a Dart handler.
const inputPoint = labelCenter(readyHome, "Tap to type");
const inputResponses = runProbe([
  ...bootstrap(),
  event("input.pointer", { phase: "down", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", {
    id: "guest-text-input-1",
    text: "native input",
    selectionBase: 12,
    selectionExtent: 12,
    composingBase: -1,
    composingExtent: -1,
  }),
  { op: "frame", deltaMs: 16 },
  event("textInput.submit", {
    id: "guest-text-input-1",
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
assert.ok(openEvent, "native pointer input did not emit textInput.open");
const openRect = openEvent.payload?.rect;
assert.ok(openRect && typeof openRect === "object", "textInput.open must carry a measured rect");
assert.equal(typeof (openRect as JsonObject).x, "number", "textInput.open rect must have x");
assert.equal(typeof (openRect as JsonObject).y, "number", "textInput.open rect must have y");
assert.equal(typeof (openRect as JsonObject).width, "number", "textInput.open rect must have width");
assert.equal(typeof (openRect as JsonObject).height, "number", "textInput.open rect must have height");
const editedFrame = inputFrames.find((frame) => textOf(frame).includes("native input"));
assert.ok(editedFrame, "textInput.edit did not update the JS draft");
assert.equal(frameEvents(editedFrame, "textInput.update").length, 0, "native text echo caused a redundant textInput.update");
assert.match(textOf(inputFrames.at(-1)!), /native submitted/, "textInput.submit did not update the JS draft");

// A delayed native echo must not overwrite a newer draft, and a packet from
// a previous editing session must not close or mutate the current editor.
const editingSession = openEvent.payload?.editingSession;
assert.equal(typeof editingSession, "string", "open packet must identify its editing generation");
const revisionFrames = framesOf(runProbe([
  ...bootstrap(),
  event("input.pointer", { phase: "down", id: 0, ...inputPoint }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...inputPoint }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", { id: "guest-text-input-1", editingSession, revision: 1, text: "ab" }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", { id: "guest-text-input-1", editingSession, revision: 2, text: "abc" }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", { id: "guest-text-input-1", editingSession, revision: 1, text: "ab" }),
  { op: "frame", deltaMs: 16 },
  event("textInput.closed", { id: "guest-text-input-1", editingSession: "previous-session", revision: 99, text: "stale" }),
  { op: "frame", deltaMs: 16 },
  event("demo.setText", { value: "JS replacement" }),
  { op: "frame", deltaMs: 16 },
  event("textInput.edit", { id: "guest-text-input-1", editingSession, revision: 3, jsRevision: 0, text: "old native" }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
assert.match(textOf(revisionFrames[6]!), /Draft: abc/, "old same-ID edit overwrote the newer draft");
assert.match(textOf(revisionFrames[7]!), /Draft: abc/, "previous editing generation overwrote the draft");
assert.match(textOf(revisionFrames.at(-1)!), /Draft: JS replacement/, "native echo before the JS replacement overwrote its controlled value");
const replacement = revisionFrames.at(-2)!;
assert.match(textOf(replacement), /Draft: JS replacement/, "explicit JS controlled value was blocked");
assert.ok(frameEvents(replacement, "textInput.update").some((packet) =>
  packet.payload?.text === "JS replacement" && packet.payload?.source === "js" && packet.payload?.force === true && packet.payload?.revision === 2,
), "JS replacement must use explicit programmatic update with latest observed revision");

// A keyboard resize changes the guest viewport while the real Flutter text
// field remains active. Layout ABI coordinates intentionally exclude paint
// transforms, so the guest must send a rect-only update using its translated
// visual rectangle and must not mistake the pre-transform layout for an
// outside-viewport field. This is the native bridge regression that a frame
// snapshot alone cannot catch.
const resizeResponses = runProbe([
  ...bootstrap(),
  event("input.pointer", { phase: "down", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  // The compact showcase keeps the field at y≈233. Use a genuinely short
  // host viewport so the official page scroller must reveal it and emit a
  // translated rect-only update.
  { op: "resize", width: 360, height: 200 },
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const resizeFrames = framesOf(resizeResponses);
const resizeOpen = resizeFrames
  .flatMap((frame) => frameEvents(frame, "textInput.open"))
  .find((item) => item.payload?.id === "guest-text-input-1");
assert.ok(resizeOpen, "resize scenario did not open the native text input");
const resizeOpenRect = resizeOpen.payload?.rect as JsonObject | undefined;
assert.ok(resizeOpenRect && typeof resizeOpenRect.y === "number", "resize open rect must include y");
const resizeUpdates = resizeFrames
  .flatMap((frame) => frameEvents(frame, "textInput.update"))
  .filter((item) => item.payload?.id === "guest-text-input-1");
const movedRectUpdate = resizeUpdates.find((item) => {
  const rect = item.payload?.rect as JsonObject | undefined;
  return rect && typeof rect.y === "number" && rect.y !== resizeOpenRect.y;
});
assert.ok(movedRectUpdate, "viewport resize did not emit a translated rect-only textInput.update");
assert.equal(
  Object.hasOwn(movedRectUpdate!.payload ?? {}, "text"),
  false,
  "viewport rect update must not echo text or reset the Flutter selection",
);
assert.equal(
  resizeFrames.some((frame) => frameEvents(frame, "textInput.close").some((item) => item.payload?.id === "guest-text-input-1")),
  false,
  "viewport resize incorrectly closed the active native text input",
);

const cleanupResponses = runProbe([
  ...bootstrap(),
  event("input.pointer", { phase: "down", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: inputPoint.x, y: inputPoint.y }),
  { op: "frame", deltaMs: 16 },
  event("demo.navigate", { route: "gallery" }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const cleanupFrames = framesOf(cleanupResponses);
assert.ok(
  cleanupFrames.some((frame) => frameEvents(frame, "textInput.close").some((item) => item.payload?.id === "guest-text-input-1")),
  "unmounting the input page did not emit textInput.close",
);

const initialEvents = frameEvents(resultFrames[0], "host.request");
assert.deepEqual(
  initialEvents.map((item) => item.payload?.capability),
  ["runtime.info", "plugins.list", "plugins.packageInfo", "updates.status"],
  "initial guest host.request capability set drifted",
);
const loadResponse = checked(resultResponses[1], "pocket_load_bytecode_files");
assert.equal(loadResponse.runtimeAbi, metadata.runtimeAbi, "native runtime ABI differs from bytecode metadata");

console.log(
  `native_guest_probe: QuickJS bytecode load/ABI/host request-response/frame/send/pointer/input/stress passed (${probe}; ` +
    `${stress100.ops?.length ?? 0} ops at 100 nodes, ${stress500.ops?.length ?? 0} ops at 500 nodes)`,
);
