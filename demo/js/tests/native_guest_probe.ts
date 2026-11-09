import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { backIconPoint } from "./navigation_geometry.ts";
import { showcaseCompositorSurfaces } from "../official_demos.ts";

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
  clip?: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
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
const compositorSurfaces = showcaseCompositorSurfaces();

function bytecodeCapable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const binary = readFileSync(path).toString("latin1");
    return binary.includes("loadBytecode") && binary.includes("pocket_load_bytecode_files") && binary.includes("compositorSurfaces");
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

const initialSystemUiParams: JsonObject = {
  statusBarBrightness: "light",
  statusBarColor: 0x00000000,
  statusBarIconBrightness: "dark",
  systemNavigationBarColor: 0xfff5f6fa,
  systemNavigationBarIconBrightness: "dark",
};

function event(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function frameCommands(count: number): JsonObject[] {
  return Array.from({ length: count }, () => ({ op: "frame", deltaMs: 16 }));
}

const BOOT_STABILIZATION_FRAMES = 20;

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
    { op: "create", width, height, compositorSurfaces },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    hostResponse(bootRequestId("platform.systemUi.set"), "platform.systemUi.set", {
      applied: true,
    }),
    hostResponse(bootRequestId("runtime.info"), "runtime.info", {
      entryFormat: "quickjs-bytecode",
      runtimeAbi,
      version: "embedded",
      build: 0,
      source: "embedded",
      entryBytes: metadata.bytecodeBytes,
    }),
    hostResponse(bootRequestId("plugins.list"), "plugins.list", {
      plugins: [{ id: "probe.plugin", version: "1.0.0", kind: "capability" }],
    }),
    hostResponse(bootRequestId("plugins.packageInfo"), "plugins.packageInfo", {
      provider: "package_info_plus",
      appName: "Pocket Host",
      packageName: "dev.tryjoy.pocket-host",
      version: "0.1.0",
      buildNumber: "1",
    }),
    ...updatesStatusRequestIds.map((requestId) => hostResponse(requestId, "updates.status", {
      configured: false,
      stage: "not_configured",
      activeVersion: "embedded",
      activeBuild: 0,
      availableVersion: null,
      versions: [],
      lastError: null,
    })),
    // This single-instance probe deliberately has no System runtime adapter.
    // Reject that capability explicitly rather than leaving a stray RPC alive.
    event("host.response", {
      requestId: bootRequestId("system.runtime.configure"),
      capability: "system.runtime.configure",
      ok: false,
      error: { code: "capability_unavailable", message: "single-instance native probe" },
    }),
    { op: "frame", deltaMs: 16 },
    // Retained RouteView adds one layout/visibility pass before the host
    // response is painted. Keep the real host responses above, then allow the
    // pinned frame scheduler to settle before any coordinate is measured.
    ...frameCommands(BOOT_STABILIZATION_FRAMES),
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

function frameMatching(
  frames: Frame[],
  predicate: (frame: Frame) => boolean,
  description: string,
): Frame {
  const frame = frames.find(predicate);
  assert.ok(frame, `native probe is missing ${description} checkpoint`);
  return frame!;
}

// Discover real request IDs from actual bytecode execution. Adding an unrelated
// bootstrap capability must not redirect a synthetic response to another RPC.
const bootRequests = framesOf(runProbe([
  { op: "create", width: 360, height: 640, compositorSurfaces },
  { op: "loadBytecode", bytecodePath, pakPath },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
])).flatMap((frame) => frameEvents(frame, "host.request"));
function bootRequestIds(capability: string): string[] {
  const packets = bootRequests.filter((request) => request.payload?.capability === capability);
  assert.ok(packets.length > 0, `missing bootstrap RPC ${capability}`);
  return packets.map((packet, index) => {
    assert.equal(typeof packet.payload?.requestId, "string", `bootstrap RPC ${capability}[${index}] has no request ID`);
    return packet.payload!.requestId as string;
  });
}
function bootRequestId(capability: string): string {
  const requestIds = bootRequestIds(capability);
  assert.equal(requestIds.length, 1, `expected one bootstrap RPC ${capability}, got ${requestIds.length}`);
  return requestIds[0]!;
}

const updatesStatusRequestIds = bootRequestIds("updates.status");
assert.equal(updatesStatusRequestIds.length, 2, "automatic refresh and the Showcase status view each request updates.status");
assert.equal(new Set(updatesStatusRequestIds).size, updatesStatusRequestIds.length, "each updates.status request must have its own correlation ID");

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
const runtimeInfoFrame = frameMatching(resultFrames, (frame) => textOf(frame).includes("quickjs-bytecode"), "runtime.info");
assert.match(textOf(runtimeInfoFrame), /package_info_plus/, "package_info_plus response did not reach JS");
const pluginsFrame = frameMatching(resultFrames, (frame) => textOf(frame).includes("probe.plugin"), "plugins.list");
assert.match(textOf(pluginsFrame), /probe\.plugin/, "plugins.list response did not reach the JS plugin page");
const updatesFrame = frameMatching(resultFrames, (frame) => textOf(frame).includes("configured=false"), "updates.status");
assert.match(textOf(updatesFrame), /stage=not_configured/, "updates.status stage was not rendered");
assert.match(textOf(updatesFrame), /active=embedded/, "updates.status active version was not rendered");
assert.match(textOf(updatesFrame), /lastError=none/, "updates.status lastError was not rendered");

const readyHome = frameMatching(
  resultFrames,
  (frame) => textOf(frame).includes("Made to feel native.") && textOp(frame, "+1") !== undefined,
  "stable Home layout",
);
const gallery = frameMatching(resultFrames, (frame) => textOf(frame).includes("Official building blocks"), "Gallery layout");
const homePoint = labelCenter(gallery, "Home");
const plusPoint = labelCenter(readyHome, "+1");
const checkPoint = labelCenter(updatesFrame, "Check");

const pointerCommands: JsonObject[] = [
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
];
const checkRequests = framesOf(runProbe([...pointerCommands, { op: "quit" }]))
  .flatMap((frame) => frameEvents(frame, "host.request"));
const checkRequest = checkRequests.find((item) => item.payload?.capability === "updates.check");
assert.equal(typeof checkRequest?.payload?.requestId, "string", "Check must emit a correlated request ID");
const checkRequestId = checkRequest!.payload!.requestId as string;
const pointerAndStressResponses = runProbe([
  ...pointerCommands,
  event("host.response", {
    requestId: checkRequestId,
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
const incrementedFrame = frameMatching(
  pointerFrames,
  (frame) => /01/.test(textOf(frame)) && textOf(frame).includes("Incremented in JS"),
  "demo.increment",
);
assert.match(textOf(incrementedFrame), /01/, "demo.increment did not reach the retained frame");
const setTextFrame = frameMatching(pointerFrames, (frame) => textOf(frame).includes("native guest"), "demo.setText");
assert.match(textOf(setTextFrame), /native guest/, "demo.setText did not reach the retained frame");
const pointerGalleryIndex = pointerFrames.findIndex((frame) => textOf(frame).includes("Official building blocks"));
assert.ok(pointerGalleryIndex >= 0, "native probe is missing guest Gallery navigation checkpoint");
const pointerGalleryFrame = pointerFrames[pointerGalleryIndex]!;
assert.match(textOf(pointerGalleryFrame), /Official building blocks/, "guest route did not reach Gallery");
const pointerHomeFrame = frameMatching(pointerFrames.slice(pointerGalleryIndex + 1), (frame) => textOf(frame).includes("Made to feel native"), "native pointer Home navigation");
assert.match(textOf(pointerHomeFrame), /Made to feel native/, "native pointer Home navigation did not reach the guest route");
const pointerPlusFrame = frameMatching(
  pointerFrames.slice(pointerGalleryIndex + 1),
  (frame) => /02/.test(textOf(frame)) && textOf(frame).includes("Incremented in JS"),
  "native pointer +1",
);
assert.match(textOf(pointerPlusFrame), /02/, "native pointer +1 did not update JS state");
assert.match(textOf(pointerPlusFrame), /Incremented in JS/, "native pointer +1 did not dispatch the JS action");

// The refreshed Gallery is taller than the probe viewport, so the Lazy card is
// below the initial clip. Toggle it through the guest event, then use the
// official page-scroller gesture to reveal the actual mounted subtree.
const lazyResponses = runProbe([
  ...bootstrap(),
  event("demo.navigate", { route: "gallery" }),
  { op: "frame", deltaMs: 16 },
  event("demo.toggleLazy"),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, x: 180, y: 500 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "move", id: 0, x: 180, y: 180 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: 180, y: 180 }),
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
assert.ok(
  framesOf(lazyResponses).some((frame) => textOf(frame).includes("Lazy subtree is mounted")),
  "guest lazy state did not render its subtree after the Gallery scroll",
);

const updateRequestFrame = frameMatching(
  pointerFrames,
  (frame) => frameEvents(frame, "host.request").some((item) => item.payload?.capability === "updates.check"),
  "native pointer Check request",
);
const updateRequests = frameEvents(updateRequestFrame, "host.request");
const updateRequest = updateRequests.find((item) => item.payload?.capability === "updates.check");
assert.ok(updateRequest, "native pointer Check did not produce host.request updates.check");
assert.equal(updateRequest.payload?.requestId, checkRequestId, "host.response must correlate with the observed updates.check request");
const updateErrorResponses = runProbe([
  ...pointerCommands,
  event("host.response", {
    requestId: checkRequestId,
    capability: "updates.check",
    ok: false,
    error: { code: "capability_unavailable", message: "updates are not configured in probe" },
  }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "down", id: 0, x: 180, y: 500 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "move", id: 0, x: 180, y: 180 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: 180, y: 180 }),
  { op: "frame", deltaMs: 16 },
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const updateErrorFrame = framesOf(updateErrorResponses).find((frame) => textOf(frame).includes("capability_unavailable"));
assert.ok(updateErrorFrame, "host.response error was not rendered by the updates capability lane");
assert.match(textOf(updateErrorFrame), /not configured/, "host.response error detail was not rendered");

const stress100 = frameMatching(pointerFrames, (frame) => textOf(frame).includes("100 retained nodes"), "100-node stress");
const stress500 = frameMatching(pointerFrames, (frame) => textOf(frame).includes("500 retained nodes"), "500-node stress");
assert.match(textOf(stress100), /100 retained nodes/, "100-node JS stress run was not rendered");
assert.match(textOf(stress500), /500 retained nodes/, "500-node JS stress run was not rendered");
assert.ok((stress500.ops?.length ?? 0) > (stress100.ops?.length ?? 0), "500-node stress frame did not redraw more retained nodes");

// Secondary routes use the fixed app bar and release the entire bottom tab
// extent. Activate Back through the native input path and require the primary
// navigation to return without losing the guest's application state.
const mobileResponses = runProbe([
  ...bootstrap(390, 669),
  event("demo.navigate", { route: "mobile" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  { op: "quit" },
]);
const mobileReady = framesOf(mobileResponses).at(-1)!;

for (const label of ["Home", "UI", "Host", "Settings"]) {
  assert.equal((mobileReady.ops ?? []).some((op) => op.type === "text" && op.text === label && Number(op.y) > 610), false, `secondary route must hide ${label} tab`);
}
const backPoint = backIconPoint(mobileReady);
const returnedFrames = framesOf(runProbe([
  ...bootstrap(390, 669),
  event("demo.navigate", { route: "mobile" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  event("input.pointer", { phase: "down", id: 0, ...backPoint }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...backPoint }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  { op: "quit" },
]));
const returnedHome = returnedFrames.at(-1)!;
assert.match(textOf(returnedHome), /Made to feel native/, "native Back did not pop to Home");
for (const label of ["Home", "UI", "Host", "Settings"]) {
  assert.ok(textOp(returnedHome, label), `Back must restore ${label} tab`);
}

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
const liveWide = frameMatching(
  liveResizeFrames,
  (frame) => frame.width === 951 && textOp(frame, "+1") !== undefined && textOf(frame).includes("01"),
  "wide resize checkpoint",
);
const liveNarrow = frameMatching(
  liveResizeFrames,
  (frame) => frame.width === 390 && textOp(frame, "+1") !== undefined && textOf(frame).includes("01"),
  "narrow resize checkpoint",
);
assert.ok(liveWide && liveNarrow, "native resize probe did not return both orientation frames");
for (const [label, frame] of [["wide", liveWide], ["narrow", liveNarrow]] as const) {
  const rendered = textOf(frame!);
  assert.match(rendered, /Made to feel native/, `${label} resize dropped the JS content pane`);
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
  // Use a real compact 360x480 viewport so Home has a genuine content extent;
  // the down point is in the Playground description, away from the
  // counter buttons, while remaining inside the scroll content clip.
  ...bootstrap(360, 480),
  event("input.pointer", { phase: "down", id: 0, x: 180, y: 350 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "move", id: 0, x: 180, y: 250 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: 180, y: 250 }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]);
const scrollFrames = framesOf(scrollResponses);
const scrollMarker = "Playground";
const markerFrames = scrollFrames.filter((frame) => textOp(frame, scrollMarker));
assert.ok(markerFrames.length >= 2, `scroll probe could not locate the Home ${scrollMarker} marker`);
const beforeScrollMarker = textOp(markerFrames[0]!, scrollMarker);
const afterScrollMarker = textOp(markerFrames.at(-1)!, scrollMarker);
assert.ok(beforeScrollMarker && afterScrollMarker, `scroll probe could not locate the Home ${scrollMarker} marker`);
assert.equal(typeof beforeScrollMarker.y, "number", "pre-scroll marker must have a y bound");
assert.equal(typeof afterScrollMarker.y, "number", "post-scroll marker must have a y bound");
assert.ok(afterScrollMarker.y! < beforeScrollMarker.y!, "vertical pointer drag did not scroll the guest page");

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
const replacementIndex = revisionFrames.findIndex((frame) => textOf(frame).includes("Draft: JS replacement"));
assert.ok(replacementIndex >= 0, "explicit JS replacement did not render");
const framesBeforeReplacement = revisionFrames.slice(0, replacementIndex);
const stableDraftFrames = framesBeforeReplacement.filter((frame) => textOf(frame).includes("Draft: abc"));
assert.ok(stableDraftFrames.length >= 3, "stale native edits did not preserve the latest draft through their checkpoints");
assert.match(textOf(stableDraftFrames.at(-1)!), /Draft: abc/, "previous editing generation overwrote the draft");
assert.match(textOf(revisionFrames.at(-1)!), /Draft: JS replacement/, "native echo before the JS replacement overwrote its controlled value");
const replacement = revisionFrames[replacementIndex]!;
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

// Client-controlled recording: starting recording is triggered from the JS
// guest rather than automatically at boot, and the remounted generation
// restores the Runtime view with the active recording status. The Runtime
// page is intentionally tested at the compact host viewport: its recording
// card is below the initial clip, so first reveal it through the official
// page-scroll gesture and then tap the measured native bounds.
const recordingScrollGesture: JsonObject[] = [
  event("input.pointer", { phase: "down", id: 0, x: 10, y: 500 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "move", id: 0, x: 10, y: 100 }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, x: 10, y: 100 }),
  { op: "frame", deltaMs: 16 },
];
const recordingBootFrames = framesOf(runProbe([
  ...bootstrap(360, 640),
  event("demo.navigate", { route: "about" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  { op: "quit" },
]));
const recordingInitialFrame = recordingBootFrames.at(-1)!;
assert.equal(textOp(recordingInitialFrame, "Start recording"), undefined, "recording controls should begin below the compact page clip");
const recordingRevealFrames = framesOf(runProbe([
  ...bootstrap(360, 640),
  event("demo.navigate", { route: "about" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  ...recordingScrollGesture,
  { op: "quit" },
]));
const runtimeFrame = recordingRevealFrames.findLast((frame) => textOp(frame, "Start recording") !== undefined);
const startRecordingOp = runtimeFrame ? textOp(runtimeFrame, "Start recording") : undefined;
assert.ok(startRecordingOp, "scrolling the Runtime page must reveal Start recording");
assert.equal(typeof startRecordingOp!.x, "number", "revealed Start recording must have an x bound");
assert.equal(typeof startRecordingOp!.y, "number", "revealed Start recording must have a y bound");
assert.equal(typeof startRecordingOp!.w, "number", "revealed Start recording must have a width bound");
assert.equal(typeof startRecordingOp!.h, "number", "revealed Start recording must have a height bound");
const startClip = startRecordingOp!.clip;
assert.ok(startClip && typeof startClip.x === "number" && typeof startClip.y === "number" && typeof startClip.w === "number" && typeof startClip.h === "number", "revealed Start recording must expose its page clip");
const startRecordingPoint = labelCenter(runtimeFrame!, "Start recording");
assert.ok(
  startRecordingPoint.x >= startClip!.x! &&
    startRecordingPoint.x <= startClip!.x! + startClip!.w! &&
    startRecordingPoint.y >= startClip!.y! &&
    startRecordingPoint.y <= startClip!.y! + startClip!.h!,
  "measured Start recording point must be inside the scroll clip",
);
const recordingStartFrames = framesOf(runProbe([
  ...bootstrap(360, 640),
  event("demo.navigate", { route: "about" }),
  ...Array.from({ length: 40 }, () => ({ op: "frame", deltaMs: 16 })),
  ...recordingScrollGesture,
  event("input.pointer", { phase: "down", id: 0, ...startRecordingPoint }),
  { op: "frame", deltaMs: 16 },
  event("input.pointer", { phase: "up", id: 0, ...startRecordingPoint }),
  { op: "frame", deltaMs: 16 },
  event("diagnostics.recording.started", {
    enabled: true,
    recording: true,
    stopped: false,
    incomplete: false,
    runtimes: [{ id: "1-pocket.host.demo", appId: "pocket.host.demo", entries: 3 }],
  }),
  { op: "frame", deltaMs: 16 },
  { op: "quit" },
]));
assert.ok(
  recordingStartFrames.some((frame) =>
    frameEvents(frame, "host.request").some((item) => item.payload?.capability === "diagnostics.recording.start"),
  ),
  "tapping Start recording must emit diagnostics.recording.start",
);
assert.match(
  textOf(recordingStartFrames.at(-1)!),
  /Recording · 1 guests · 3 transactions/,
  "diagnostics.recording.started must render active recording status on Runtime page",
);

const initialEvents = frameEvents(resultFrames[0], "host.request");
const initialSystemUiRequest = initialEvents.find(
  (item) => item.payload?.capability === "platform.systemUi.set",
);
assert.ok(initialSystemUiRequest, "initial guest host.request must include platform.systemUi.set");
assert.deepEqual(
  initialSystemUiRequest.payload?.params,
  initialSystemUiParams,
  "initial platform.systemUi.set must use the light showcase bar style",
);
assert.deepEqual(
  initialEvents.map((item) => item.payload?.capability).sort(),
  ["platform.systemUi.set", "runtime.info", "runtime.performance", "plugins.list", "plugins.packageInfo", "updates.status", "updates.status", "system.runtime.configure"].sort(),
  "initial guest host.request capability set drifted",
);
const loadResponse = checked(resultResponses[1], "pocket_load_bytecode_files");
assert.equal(loadResponse.runtimeAbi, metadata.runtimeAbi, "native runtime ABI differs from bytecode metadata");

console.log(
  `native_guest_probe: QuickJS bytecode load/ABI/host request-response/frame/send/pointer/input/stress passed (${probe}; ` +
    `${stress100.ops?.length ?? 0} ops at 100 nodes, ${stress500.ops?.length ?? 0} ops at 500 nodes)`,
);
