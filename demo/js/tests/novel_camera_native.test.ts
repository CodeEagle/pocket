import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import { NativeSession, center, textOf, textOp, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const beforeCamera = "Harbor before the lens moves.";
const afterCamera = "The harbor settles into a closer frame.";
const hudLabel = "手札";

type Rect = { x: number; y: number; w: number; h: number };
type ImageState = { readonly bounds: Rect; readonly uv: readonly number[] };
type CameraRun = {
  readonly baseline: { readonly background: ImageState; readonly character: ImageState };
  readonly mid: { readonly background: ImageState; readonly character: ImageState };
  readonly target: { readonly background: ImageState; readonly character: ImageState };
  readonly hudBefore: Rect;
  readonly hudMid: Rect;
  readonly hudTarget: Rect;
};
type CameraResult = { readonly run: CameraRun; readonly menuOpened?: boolean };

function rect(op: DrawOp, label: string): Rect {
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof op[key], "number", `${label} must expose ${key}`);
  }
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h! };
}

function imageOp(frame: Frame, asset: string): DrawOp {
  const op = (frame.ops ?? []).find(item => item.type === "image" && (item as DrawOp & { asset?: string }).asset === asset);
  assert.ok(op, `native frame must paint ${asset}; painted=${textOf(frame)}`);
  return op!;
}

function imageState(frame: Frame, asset: string): ImageState {
  const op = imageOp(frame, asset) as DrawOp & { uv?: number[] };
  assert.ok(Array.isArray(op.uv) && op.uv.length === 4, `${asset} must expose native source UV bounds`);
  return { bounds: rect(op, asset), uv: [...op.uv!] };
}

function dialoguePoint(session: NativeSession): { x: number; y: number } {
  const layout = createNovelViewportLayout({ width: session.width, height: session.height }, { top: 0, right: 0, bottom: 0, left: 0 });
  return {
    x: layout.insetL + layout.width / 2,
    y: layout.insetT + layout.height - layout.dialogueBottom - layout.dialogueHeight / 2,
  };
}

async function waitForText(session: NativeSession, initial: Frame, expected: string): Promise<Frame> {
  let frame = initial;
  const target = expected.replace(/\s/g, "");
  for (let index = 0; index < 12; index += 1) {
    if (textOf(frame).replace(/\s/g, "").includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error(`expected painted text ${JSON.stringify(expected)}; frame=${textOf(frame)}`);
}

async function runCamera(artifacts: NativeArtifacts, reduceMotion: boolean): Promise<CameraResult> {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 60_000 });
  try {
    let frame = await session.boot();
    if (reduceMotion) {
      session.sendEvent("accessibility.preferences", {
        reduceMotion: true,
        increaseContrast: false,
        textScale: 1,
        accessibleNavigation: false,
        reduceTransparency: null,
      });
      frame = await session.frame();
    }

    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForText(session, frame, "Before the camera move.");
    frame = await session.tapPoint(dialoguePoint(session));
    frame = await waitForText(session, frame, beforeCamera);

    const baseline = {
      background: imageState(frame, "art/harbor.svg"),
      character: imageState(frame, "art/mira.svg"),
    };
    const hudBefore = rect(textOp(frame, hudLabel), "header journal button");

    frame = await session.tapPoint(dialoguePoint(session));
    frame = await waitForText(session, frame, afterCamera);
    const midFrame = await session.settle(frame, 6);
    const mid = {
      background: imageState(midFrame, "art/harbor.svg"),
      character: imageState(midFrame, "art/mira.svg"),
    };
    const hudMid = rect(textOp(midFrame, hudLabel), "header journal button during camera move");

    const targetFrame = await session.settle(midFrame, 40);
    const target = {
      background: imageState(targetFrame, "art/harbor.svg"),
      character: imageState(targetFrame, "art/mira.svg"),
    };
    const hudTarget = rect(textOp(targetFrame, hudLabel), "header journal button at camera target");
    const run = { baseline, mid, target, hudBefore, hudMid, hudTarget };

    if (!reduceMotion) return { run };

    // The camera target remains a real player-visible state outside the art
    // transform. Tapping its painted header position must still reach the menu.
    const opened = await session.settle(await session.tapPoint(center(textOp(targetFrame, hudLabel), hudLabel)), 2);
    return { run, menuOpened: textOf(opened).includes("旅途手札") };
  } finally {
    await session.quit();
  }
}

test("pinned NovelView camera motion transforms stage art, preserves HUD hit targets, and honors host reduce-motion facts", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-camera-native-"));
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-camera-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
        "@pocket/live2d": `file:${join(sdk, "packages/pocket_live2d")}`,
        "@pocket/spine": `file:${join(sdk, "packages/pocket_spine")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-camera-fixture",
      app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-camera-fixture", capabilities: { requires: [], optional: [] } }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, "art/harbor.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#274A55"/><circle cx="135" cy="65" r="32" fill="#DAAF72"/></svg>');
    writeFileSync(join(project, "art/mira.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="350"><rect x="8" y="8" width="224" height="334" rx="18" fill="#B46B5C"/><circle cx="120" cy="78" r="44" fill="#E2B892"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
      backgrounds: { harbor: "art/harbor.svg" },
      characters: { mira: { neutral: "art/mira.svg" } },
      cgs: {},
    }));

    const story = {
      id: "camera-native-fixture",
      version: 1,
      start: "start",
      script: {
        start: [
          { type: "say", id: "opening", text: "Before the camera move." },
          {
            type: "scene",
            background: "harbor",
            characters: [{ id: "mira", expression: "neutral", position: "left" }],
            camera: { x: 0, y: 0, scale: 1 },
          },
          { type: "say", id: "before-camera", text: beforeCamera },
          {
            type: "scene",
            camera: { x: 64, y: -28, scale: 1.45 },
            cameraMotion: { durationMs: 480, easing: "linear", shake: { amplitude: 12, cycles: 3 } },
          },
          { type: "say", id: "after-camera", text: afterCamera },
          { type: "ending", id: "end" },
        ],
      },
    };
    writeFileSync(join(project, "app.tsx"), `
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createAccessibilityPreferences, AccessibilityPreferencesProvider } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = {
  backgrounds: { harbor: "art/harbor.svg" },
  characters: { mira: { neutral: "art/mira.svg" } },
  cgs: {},
};
function App() {
  const host = createHostBridge();
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const stopClock = attachNovelClock(engine);
  onCleanup(() => { stopClock(); engine.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <NovelView engine={engine} host={host} assets={assets} title="Camera acceptance" subtitle="Stage movement fixture" onNewGame={() => engine.start()} />
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the camera fixture must execute pinned QJBC");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };

    const normalResult = await runCamera(artifacts, false);
    const normal = normalResult.run;
    const baselineUv = normal.baseline.background.uv;
    const midUv = normal.mid.background.uv;
    const targetUv = normal.target.background.uv;
    const baselineCenter = [(baselineUv[0]! + baselineUv[2]!) / 2, (baselineUv[1]! + baselineUv[3]!) / 2];
    const midCenter = [(midUv[0]! + midUv[2]!) / 2, (midUv[1]! + midUv[3]!) / 2];
    expect(Math.abs(midCenter[0]! - baselineCenter[0]!) + Math.abs(midCenter[1]! - baselineCenter[1]!),
      "the clipped background must expose the native camera pan as a changed UV crop").toBeGreaterThan(0.01);
    expect(midUv[2]! - midUv[0]!, "the clipped background UV span must narrow during zoom").toBeLessThan(baselineUv[2]! - baselineUv[0]! - 0.01);
    expect(Math.abs(normal.mid.character.bounds.x - normal.baseline.character.bounds.x) + Math.abs(normal.mid.character.bounds.y - normal.baseline.character.bounds.y),
      "the character image bounds must reflect camera pan").toBeGreaterThan(2);
    expect(normal.mid.character.bounds.w + normal.mid.character.bounds.h,
      "the character image bounds must reflect mid-motion camera scaling").toBeGreaterThan(normal.baseline.character.bounds.w + normal.baseline.character.bounds.h + 2);
    expect(targetUv[2]! - targetUv[0]!, "the background UV span must reach the authored zoom target")
      .toBeLessThan(baselineUv[2]! - baselineUv[0]! - 0.1);
    expect(normal.target.character.bounds.w + normal.target.character.bounds.h,
      "the character image bounds must reach the authored zoom target").toBeGreaterThan(normal.baseline.character.bounds.w + normal.baseline.character.bounds.h + 20);
    for (const rect of [normal.hudMid, normal.hudTarget]) {
      for (const key of ["x", "y", "w", "h"] as const) {
        expect(rect[key], `the HUD ${key} must stay outside the camera transform`).toBeCloseTo(normal.hudBefore[key], 1);
      }
    }

    const reducedResult = await runCamera(artifacts, true);
    expect(reducedResult.menuOpened, "the fixed HUD pointer target must still open its real menu").toBe(true);
    for (const key of ["x", "y", "w", "h"] as const) {
      expect(reducedResult.run.mid.character.bounds[key], `reduced-motion character ${key} must jump to the target pose`).toBeCloseTo(normal.target.character.bounds[key], 1);
    }
    for (const [index, value] of reducedResult.run.mid.background.uv.entries()) {
      expect(value, `reduced-motion background UV ${index} must jump to the target crop`).toBeCloseTo(normal.target.background.uv[index]!, 2);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
