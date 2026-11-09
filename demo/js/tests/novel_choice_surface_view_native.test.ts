import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { resolveNovelCameraPose } from "../../../sdk/packages/pocket_vn/src/camera.ts";
import { createNovelChoiceSurfaceLayout } from "../../../sdk/packages/pocket_vn/src/choice-surface.ts";
import { NativeSession, center, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const longRouteText = "Follow the old mail route to the receiving hut";
const longBellText = "Wait for the second chime before choosing a route";
const hubOptions = [
  { id: "archive", text: "Archive", target: "archive" },
  { id: "relay", text: "Relay", target: "dial_entry" },
  { id: "long", text: "More", target: "long_entry" },
] as const;
const dialOptions = [
  { id: "route_7", text: "7", target: "route_seven" },
  { id: "route_1", text: "1", target: "route_one" },
  { id: "route_4", text: "4", target: "route_four" },
] as const;
const hubCamera = { x: 10, y: -6, scale: 1.1, motion: null };
const dialCamera = { x: -8, y: 6, scale: 1.1, motion: null };
const choiceSurfaces = {
  hub: {
    kind: "scene",
    frame: { x: 0.06, y: 0.12, w: 0.88, h: 0.76 },
    targets: {
      archive: { x: 0.03, y: 0.16, w: 0.28, h: 0.18 },
      relay: { x: 0.36, y: 0.16, w: 0.28, h: 0.18 },
      long: { x: 0.69, y: 0.16, w: 0.28, h: 0.18 },
    },
  },
  dial_choice: {
    kind: "dial",
    image: "art/relay-dial.svg",
    frame: { x: 0.14, y: 0.22, w: 0.72, h: 0.42 },
    targets: {
      route_7: { x: 0.025, y: 0.18, w: 0.29, h: 0.64 },
      route_1: { x: 0.355, y: 0.18, w: 0.29, h: 0.64 },
      route_4: { x: 0.685, y: 0.18, w: 0.29, h: 0.64 },
    },
  },
  long_english: {
    kind: "dial",
    image: "art/relay-dial.svg",
    frame: { x: 0.14, y: 0.22, w: 0.72, h: 0.42 },
    targets: {
      long_a: { x: 0.02, y: 0.25, w: 0.43, h: 0.32 },
      long_b: { x: 0.55, y: 0.25, w: 0.43, h: 0.32 },
    },
  },
} as const;

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function textContaining(frame: Frame, fragment: string): DrawOp {
  const op = (frame.ops ?? []).find(item => item.type === "text" && typeof item.text === "string" && item.text.includes(fragment));
  assert.ok(op, `native frame is missing painted text ${JSON.stringify(fragment)}; painted=${textOf(frame)}`);
  return op!;
}

function compact(value: string): string { return value.replace(/\s/g, ""); }

function visibleUiText(frame: Frame): string {
  return (frame.ops ?? [])
    .filter(op => op.type === "text" && typeof op.text === "string" && !op.text.startsWith("diag:"))
    .map(op => op.text)
    .join("\n");
}

function fontGlyphGroups(frame: Frame): DrawOp[][] {
  const glyphOps = (frame.ops ?? [])
    .filter(op => op.type === "image" && /^pocket\.texture\.\d+$/.test(assetOf(op) ?? "") && (op.h ?? 0) >= 12)
    .sort((left, right) => (left.y ?? 0) - (right.y ?? 0) || (left.x ?? 0) - (right.x ?? 0));
  const rows: DrawOp[][] = [];
  for (const op of glyphOps) {
    let row = rows.find(candidate => Math.abs((candidate[0]?.y ?? 0) - (op.y ?? 0)) <= 1);
    if (!row) { row = []; rows.push(row); }
    row.push(op);
  }
  const groups: DrawOp[][] = [];
  for (const row of rows) {
    row.sort((left, right) => (left.x ?? 0) - (right.x ?? 0));
    let current: DrawOp[] | undefined;
    for (const op of row) {
      const previous = current?.at(-1);
      const gap = previous ? (op.x ?? 0) - ((previous.x ?? 0) + (previous.w ?? 0)) : 0;
      if (!current || !previous || gap > 24) {
        current = [op];
        groups.push(current);
      } else current.push(op);
    }
  }
  return groups;
}

function hasRenderedTexts(frame: Frame, expected: readonly string[]): boolean {
  const painted = compact(visibleUiText(frame));
  const missing = expected.filter(text => !painted.includes(compact(text)));
  if (missing.length === 0) return true;
  const available = fontGlyphGroups(frame).map(group => group.length);
  for (const text of missing) {
    const glyphCount = Array.from(text).filter(character => !/\s/.test(character)).length;
    const index = available.indexOf(glyphCount);
    if (index < 0) return false;
    available.splice(index, 1);
  }
  return true;
}

function spatialTargetCenter(
  frame: Frame,
  surfaceName: keyof typeof choiceSurfaces,
  optionId: string,
  options: readonly { readonly id: string; readonly text: string; readonly target: string }[],
  camera: typeof hubCamera | typeof dialCamera,
): { x: number; y: number } {
  const width = frame.width ?? 360;
  const height = frame.height ?? 640;
  const surface = choiceSurfaces[surfaceName];
  const dimensions = surface.kind === "dial" ? { width: 256, height: 128 } : undefined;
  const resolved = createNovelChoiceSurfaceLayout(surface, options, width, height, dimensions, 0);
  assert.ok(resolved, `choice surface ${surfaceName} should resolve through the SDK layout helper`);
  const target = resolved!.targets.find(candidate => candidate.option.id === optionId);
  assert.ok(target, `choice surface ${surfaceName} should map ${optionId}`);
  const pose = resolveNovelCameraPose(camera);
  return {
    x: width / 2 + (target!.x + target!.width / 2 - width / 2) * pose.scale + pose.x,
    y: height / 2 + (target!.y + target!.height / 2 - height / 2) * pose.scale + pose.y,
  };
}

async function waitForText(session: NativeSession, initial: Frame, text: string, limit = 180): Promise<Frame> {
  let frame = initial;
  const needle = compact(text);
  for (let index = 0; index < limit; index += 1) {
    if (compact(textOf(frame)).includes(needle)) return frame;
    frame = await session.frame();
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}; painted=${textOf(frame)}`);
}

async function waitForTexts(session: NativeSession, initial: Frame, texts: readonly string[], limit = 180): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < limit; index += 1) {
    if (hasRenderedTexts(frame, texts)) return frame;
    frame = await session.frame();
  }
  const textOps = (frame.ops ?? []).filter(op => op.type === "text").map(op => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h, color: op.color, clip: op.clip }));
  const drawOps = (frame.ops ?? []).map(op => {
    const record = op as DrawOp & { asset?: string; points?: unknown[]; uvs?: unknown[]; vertices?: unknown[]; indices?: unknown[] };
    return { type: record.type, text: record.text, asset: record.asset, x: record.x, y: record.y, w: record.w, h: record.h,
      color: record.color, clip: record.clip, points: record.points?.length, vertices: record.vertices?.length,
      indices: record.indices?.length, uvs: record.uvs?.length, keys: Object.keys(record) };
  });
  throw new Error("timed out waiting for painted options " + JSON.stringify(texts) +
    "; painted=" + textOf(frame) + "; station=" + JSON.stringify(imageOf(frame, "art/station.svg")) +
    "; textOps=" + JSON.stringify(textOps) + "; drawOps=" + JSON.stringify(drawOps));
}

function imageOf(frame: Frame, path: string): DrawOp | undefined {
  return (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === path);
}

function imageBoundsChanged(before: DrawOp, after: DrawOp): boolean {
  const beforeUv = (before as DrawOp & { uv?: number[] }).uv ?? [0, 0, 1, 1];
  const afterUv = (after as DrawOp & { uv?: number[] }).uv ?? [0, 0, 1, 1];
  const uvDelta = beforeUv.reduce((total, value, index) => total + Math.abs(value - (afterUv[index] ?? value)), 0);
  return Math.abs((after.x ?? 0) - (before.x ?? 0)) + Math.abs((after.y ?? 0) - (before.y ?? 0)) +
    Math.abs((after.w ?? 0) - (before.w ?? 0)) + Math.abs((after.h ?? 0) - (before.h ?? 0)) + uvDelta > 0.01;
}

async function waitForImageTransform(session: NativeSession, initial: Frame, before: DrawOp, path: string, limit = 180): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < limit; index += 1) {
    const after = imageOf(frame, path);
    if (after && imageBoundsChanged(before, after)) return frame;
    frame = await session.frame();
  }
  throw new Error(`timed out waiting for camera-transformed ${path}; before=${JSON.stringify(before)} after=${JSON.stringify(imageOf(frame, path))}`);
}

function imageSignature(op: DrawOp): string {
  const uv = (op as DrawOp & { uv?: number[] }).uv ?? [0, 0, 1, 1];
  return JSON.stringify([op.x, op.y, op.w, op.h, ...uv]);
}

async function waitForStableImage(session: NativeSession, initial: Frame, path: string, stableFrames = 4, limit = 180): Promise<Frame> {
  let frame = initial;
  let previous = imageOf(frame, path);
  let stable = 0;
  for (let index = 0; index < limit; index += 1) {
    frame = await session.frame();
    const current = imageOf(frame, path);
    if (!previous || !current || imageSignature(current) !== imageSignature(previous)) stable = 0;
    else stable += 1;
    if (stable >= stableFrames) return frame;
    previous = current;
  }
  throw new Error(`timed out waiting for stable ${path}; latest=${JSON.stringify(imageOf(frame, path))}`);
}

async function chooseDial(session: NativeSession, frame: Frame, digit: "7" | "1" | "4"): Promise<Frame> {
  const point = spatialTargetCenter(frame, "dial_choice", `route_${digit}`, dialOptions, dialCamera);
  frame = await session.tapPoint(point);
  return waitForText(session, frame, `Route ${digit} selected`);
}

test("real NovelView paints and routes scene/dial surfaces after camera motion, while HUD and fallback choices stay usable", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-choice-surface-view-native-"));
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-choice-surface-view-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
        "@pocket/live2d": `file:${join(sdk, "packages/pocket_live2d")}`,
        "@pocket/spine": `file:${join(sdk, "packages/pocket_spine")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-choice-surface-view-fixture", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-choice-surface-view-fixture", capabilities: { requires: [], optional: [] } }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, "art/station.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="512"><rect width="256" height="512" fill="#142B32"/><path d="M0 370h256v142H0z" fill="#314D4F"/><circle cx="198" cy="92" r="34" fill="#D9B66A"/></svg>');
    writeFileSync(join(project, "art/relay-dial.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"><rect width="256" height="128" rx="18" fill="#233C43" stroke="#D9B66A" stroke-width="6"/><circle cx="43" cy="64" r="28" fill="#6A5140"/><circle cx="128" cy="64" r="28" fill="#6A5140"/><circle cx="213" cy="64" r="28" fill="#6A5140"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
      backgrounds: { station: "art/station.svg" },
      characters: {},
      cgs: {},
      audio: {},
      imageDimensions: { "art/relay-dial.svg": { width: 256, height: 128 } },
      choiceSurfaces,
    }));

    const story = {
      id: "choice-surface-view-native-fixture",
      version: 1,
      start: "start",
      script: {
        start: [
          { type: "scene", background: "station", camera: { x: 0, y: 0, scale: 1 } },
          { type: "say", id: "opening", text: "The map is laid out." },
          { type: "scene", camera: { x: 10, y: -6, scale: 1.1 }, cameraMotion: { durationMs: 480, easing: "easeInOut" } },
          {
            type: "choice",
            id: "hub",
            prompt: "Choose a station lead",
            options: hubOptions,
          },
        ],
        archive: [{ type: "say", id: "archive-selected", text: "Archive target selected." }],
        dial_entry: [
          { type: "scene", camera: { x: -8, y: 6, scale: 1.1 }, cameraMotion: { durationMs: 360, easing: "easeInOut" } },
          {
            type: "choice",
            id: "dial_choice",
            prompt: "Set the relay route",
            options: dialOptions,
          },
        ],
        route_seven: [{ type: "say", id: "route-seven", text: "Route 7 selected." }],
        route_one: [{ type: "say", id: "route-one", text: "Route 1 selected." }],
        route_four: [{ type: "say", id: "route-four", text: "Route 4 selected." }],
        long_entry: [{
          type: "choice",
          id: "long_english",
          prompt: "Read the full station note",
          options: [
            { id: "long_a", text: longRouteText, target: "long_route" },
            { id: "long_b", text: longBellText, target: "long_bell" },
          ],
        }],
        long_route: [{ type: "say", id: "long-route", text: "The long route record is open." }],
        long_bell: [{ type: "say", id: "long-bell", text: "The long bell record is open." }],
      },
    };
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createAccessibilityPreferences, AccessibilityPreferencesProvider } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = {
  backgrounds: { station: "art/station.svg" },
  characters: {},
  cgs: {},
  imageDimensions: { "art/relay-dial.svg": { width: 256, height: 128 } },
  choiceSurfaces: ${JSON.stringify(choiceSurfaces)},
};
const ui = {
  "title.start": "Start game",
  "player.brand": "CHOICE SURFACE",
  "player.menu": "Journal",
  "panel.menu": "Journey journal",
  "panel.back": "Back",
  "menu.continue": "Continue reading",
  "menu.save": "Save this moment",
  "menu.load": "Load a letter",
  "menu.log": "Reading log",
  "menu.settings": "Reading preferences",
  "menu.gallery": "Memories",
  "menu.title": "Return to title",
};
function App() {
  const host = createHostBridge();
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const stopClock = attachNovelClock(engine);
  const debugState = () => {
    const snapshot = engine.getSnapshot();
    const active = snapshot.active as any;
    const motion = snapshot.stage.camera.motion;
    return "diag:" + [snapshot.phase, active?.kind ?? "none", active?.id ?? "", active?.options?.length ?? 0, snapshot.paused ? 1 : 0,
      snapshot.stage.camera.x, snapshot.stage.camera.y, snapshot.stage.camera.scale, motion?.elapsedMs ?? "-", motion?.durationMs ?? "-"].join(":");
  };
  const [debug, setDebug] = createSignal(debugState());
  const stopDebug = engine.subscribe(() => setDebug(debugState()));
  onCleanup(() => { stopDebug(); stopClock(); engine.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <>
      <NovelView engine={engine} host={host} assets={assets} ui={ui} locale="en" title="Choice surface" subtitle="Native pointer fixture" onNewGame={() => engine.start()} />
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: 360, height: 14, opacity: 0.15 }}><Text class="text-xs text-[#FFFFFF]">{debug()}</Text></View>
    </>
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the acceptance fixture must use the pinned QuickJS bytecode pipeline");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };

    const startHub = async (width = 360, height = 640): Promise<{ session: NativeSession; frame: Frame; baseline: DrawOp }> => {
      const session = new NativeSession(artifacts, { width, height, deadlineMs: 60_000 });
      let frame = await session.boot();
      frame = await session.tap("Start game", frame);
      frame = await waitForText(session, frame, "The map is laid out.");
      const baseline = (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === "art/station.svg");
      assert.ok(baseline, "the real NovelView must paint the station before moving the camera");
      frame = await session.tapPoint(center(textContaining(frame, "The map is laid"), "opening dialogue"));
      frame = await waitForText(session, frame, "Choose a station lead");
      return { session, frame, baseline: baseline! };
    };

    const runHub = async (width = 360, height = 640, requireAllLabels = true): Promise<{ session: NativeSession; frame: Frame; baseline: DrawOp }> => {
      const run = await startHub(width, height);
      let frame = await waitForImageTransform(run.session, run.frame, run.baseline, "art/station.svg");
      frame = await waitForStableImage(run.session, frame, "art/station.svg");
      if (requireAllLabels) frame = await waitForTexts(run.session, frame, ["Choose a station lead", "Archive", "Relay", "More"]);
      else frame = await waitForText(run.session, frame, "Choose a station lead");
      return { ...run, frame };
    };

    // Send a pointer from the label's painted center as soon as the transition
    // choices exist. The later run repeats the same route after camera motion
    // has settled, so both phases exercise the actual NovelView target.
    const duringMotion = await startHub();
    try {
      const frame = await waitForTexts(duringMotion.session, duringMotion.frame, ["Choose a station lead", "Archive", "Relay", "More"]);
      const relayText = textContaining(frame, "Relay");
      const relayPoint = center(relayText, "Relay option during camera transition");
      const diag = (frame.ops ?? []).find(op => op.type === "text" && op.text?.startsWith("diag:"))?.text ?? "";
      expect(diag, "the real engine must still be running its authored camera motion at this pointer").toContain(":480");
      let selectedFrame = await duringMotion.session.tapPoint(relayPoint);
      selectedFrame = await waitForText(duringMotion.session, selectedFrame, "Set the relay route");
      expect(textOf(selectedFrame), `painted Relay pointer ${JSON.stringify(relayPoint)} should select the dial during camera transition`).toContain("Set the relay route");
    } finally {
      await duringMotion.session.quit();
    }

    const normal = await runHub();
    try {
      let { frame } = normal;
      expect(hasRenderedTexts(frame, ["Archive", "Relay", "More"]),
        "camera-scaled captions may arrive as font-atlas image quads; all three labels must be visibly drawn").toBe(true);
      if (!["Archive", "Relay", "More"].every(label => compact(visibleUiText(frame)).includes(label))) {
        expect(fontGlyphGroups(frame).map(group => group.length).sort((left, right) => left - right),
          "the scaled scene labels are three ordered atlas glyph runs (Archive, Relay, More)").toEqual([4, 5, 7]);
      }
      const moved = (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === "art/station.svg");
      assert.ok(moved, "the camera-moved station remains a painted image");
      assert.ok(imageBoundsChanged(normal.baseline, moved!), "camera pan/scale must visibly transform the actual stage art before the pointer test");

      frame = await normal.session.tapPoint(center(textContaining(frame, "Journal"), "HUD Journal button"));
      frame = await waitForText(normal.session, frame, "Journey journal");
      expect(textOf(frame)).toContain("Back");
      frame = await normal.session.tapPoint(center(textContaining(frame, "Back"), "HUD Back button"));
      frame = await waitForTexts(normal.session, frame, ["Choose a station lead", "Archive", "Relay", "More"]);
      const hubArt = imageOf(frame, "art/station.svg");
      assert.ok(hubArt, "the settled hub frame paints station art");
      const relayPoint = spatialTargetCenter(frame, "hub", "relay", hubOptions, hubCamera);
      frame = await normal.session.tapPoint(relayPoint);
      frame = await waitForText(normal.session, frame, "Set the relay route");
      frame = await waitForImageTransform(normal.session, frame, hubArt!, "art/station.svg");
      frame = await waitForStableImage(normal.session, frame, "art/station.svg");
      frame = await waitForTexts(normal.session, frame, ["Set the relay route", "7", "1", "4"]);
      if (!["7", "1", "4"].every(label => compact(visibleUiText(frame)).includes(label))) {
        expect(fontGlyphGroups(frame).filter(group => group.length === 1).length,
          "the scaled dial labels each produce one glyph atlas quad").toBe(3);
      }
      assert.ok((frame.ops ?? []).some(op => op.type === "image" && assetOf(op) === "art/relay-dial.svg"), "the actual NovelView dial surface paints its registered art");
      for (const digit of ["7", "1", "4"] as const) {
        const dialRun = digit === "7" ? { session: normal.session, frame } : await enterDialForDigit(runHub);
        const selected = await chooseDial(dialRun.session, dialRun.frame, digit);
        expect(compact(textOf(selected))).toContain(compact(`Route ${digit} selected`));
        if (digit !== "7") await dialRun.session.quit();
      }
    } finally {
      await normal.session.quit();
    }

    // At a short, narrow viewport the 44px target/overflow checks must switch
    // to the ordinary list while retaining every legal option text.
    const compactRun = await runHub(190, 290, false);
    try {
      const labels = ["Archive", "Relay", "More"];
      let observed = new Set(labels.filter(label => textOf(compactRun.frame).includes(label)));
      let frame = compactRun.frame;
      for (let attempt = 0; attempt < 12 && observed.size < labels.length; attempt += 1) {
        frame = await sessionScroll(compactRun.session, frame);
        for (const label of labels) if (textOf(frame).includes(label)) observed.add(label);
      }
      expect([...observed].sort(), "small viewport fallback keeps every legal scene option reachable").toEqual([...labels].sort());
      frame = await compactRun.session.drag({ x: 95, y: 0.52 * (frame.height ?? 290) }, { x: 95, y: 0.72 * (frame.height ?? 290) }, 3);
      frame = await waitForText(compactRun.session, frame, "Archive");
      frame = await compactRun.session.tapPoint(center(textContaining(frame, "Archive"), "small viewport archive fallback option"));
      frame = await waitForText(compactRun.session, frame, "Archive target selected");
      expect(compact(textOf(frame))).toContain(compact("Archive target selected"));
    } finally {
      await compactRun.session.quit();
    }

    // Long English captions exceed the image targets, so NovelView must remove
    // the dial art layer and render the complete option set in its scroll list.
    const longRun = await runHub();
    try {
      const morePoint = spatialTargetCenter(longRun.frame, "hub", "long", hubOptions, hubCamera);
      let frame = await longRun.session.tapPoint(morePoint);
      frame = await waitForText(longRun.session, frame, "Read the full station note");
      frame = await waitForTexts(longRun.session, frame, ["Read the full station note", longRouteText, longBellText]);
      expect((frame.ops ?? []).some(op => op.type === "image" && assetOf(op) === "art/relay-dial.svg"),
        "long captions must fall back from spatial dial targets to the readable list").toBe(false);
      expect(compact(textOf(frame))).toContain(compact(longRouteText));
      expect(compact(textOf(frame))).toContain(compact(longBellText));
      frame = await longRun.session.tapPoint(center(textContaining(frame, "Wait for the second chime"), "long English fallback option"));
      frame = await waitForText(longRun.session, frame, "The long bell record is open.");
      expect(compact(textOf(frame))).toContain(compact("The long bell record is open."));
    } finally {
      await longRun.session.quit();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);

async function enterDialForDigit(
  runHub: (width?: number, height?: number) => Promise<{ session: NativeSession; frame: Frame; baseline: DrawOp }>,
): Promise<{ session: NativeSession; frame: Frame }> {
  const run = await runHub();
  const hubArt = imageOf(run.frame, "art/station.svg");
  assert.ok(hubArt, "settled hub must paint station art before changing scene");
  const relayPoint = spatialTargetCenter(run.frame, "hub", "relay", hubOptions, hubCamera);
  let frame = await run.session.tapPoint(relayPoint);
  frame = await waitForText(run.session, frame, "Set the relay route");
  frame = await waitForImageTransform(run.session, frame, hubArt!, "art/station.svg");
  frame = await waitForStableImage(run.session, frame, "art/station.svg");
  frame = await waitForTexts(run.session, frame, ["Set the relay route", "7", "1", "4"]);
  return { session: run.session, frame };
}

async function sessionScroll(session: NativeSession, frame: Frame): Promise<Frame> {
  const width = frame.width ?? session.width;
  const height = frame.height ?? session.height;
  return session.drag({ x: width / 2, y: height * 0.72 }, { x: width / 2, y: height * 0.52 }, 3);
}
