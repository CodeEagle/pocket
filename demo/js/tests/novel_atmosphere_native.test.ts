import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import { NativeSession, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const rainAsset = "art/rain.svg";
const mistAsset = "art/mist.svg";
const clearLine = "The rain gives way to a quiet station.";

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function rainTriangles(frame: Frame): DrawOp[] {
  return (frame.ops ?? []).filter(op => op.type === "textureTriangle" && assetOf(op) === rainAsset);
}

function mistImages(frame: Frame): DrawOp[] {
  return (frame.ops ?? []).filter(op => op.type === "image" && assetOf(op) === mistAsset);
}

function rainGeometry(frame: Frame): string {
  return JSON.stringify(rainTriangles(frame).map(op => op.points));
}

function mistGeometry(frame: Frame): string {
  return JSON.stringify(mistImages(frame).map(({ x, y, w, h, uv }) => ({ x, y, w, h, uv })));
}

function lightningAlpha(frame: Frame): number {
  const op = (frame.ops ?? []).find(candidate => candidate.type === "rect"
    && typeof candidate.color === "number"
    && (candidate.color & 0x00ffffff) === 0xB8D6E9
    && ((candidate.color >>> 24) & 0xff) > 0);
  return op && typeof op.color === "number" ? ((op.color >>> 24) & 0xff) / 255 : 0;
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

async function frameWithClock(session: NativeSession, initial: Frame, expected: "clock:on" | "clock:off"): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 12; index += 1) {
    if (textOf(frame).includes(expected)) return frame;
    frame = await session.frame();
  }
  throw new Error(`expected scheduler state ${expected}; frame=${textOf(frame)}`);
}

async function framesWithFlash(session: NativeSession, initial: Frame, limit = 760): Promise<{ frame: Frame; maxAlpha: number; frames: number }> {
  let frame = initial;
  let maxAlpha = lightningAlpha(frame);
  let used = 0;
  while (maxAlpha === 0 && used < limit) {
    frame = await session.frame();
    maxAlpha = Math.max(maxAlpha, lightningAlpha(frame));
    used += 1;
  }
  return { frame, maxAlpha, frames: used };
}

test("NovelView atmosphere uses its shared clock, pauses cleanly, honors host reduce-motion and releases on a clear scene", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-atmosphere-native-"));
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-atmosphere-native-fixture",
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
      id: "dev.pocket.vn-atmosphere-fixture",
      app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-atmosphere-fixture", capabilities: { requires: [], optional: [] } }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, "art/harbor.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#274A55"/><circle cx="135" cy="65" r="32" fill="#DAAF72"/></svg>');
    writeFileSync(join(project, "art/quiet.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#314A46"/><circle cx="135" cy="65" r="32" fill="#DAAF72"/></svg>');
    writeFileSync(join(project, "art/mira.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="220"><rect x="8" y="8" width="104" height="204" rx="18" fill="#B46B5C"/></svg>');
    writeFileSync(join(project, "art/rain.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="40"><rect x="7" y="2" width="2" height="28" fill="#C8E8F2"/></svg>');
    writeFileSync(join(project, "art/mist.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><rect x="0" y="8" width="84" height="10" rx="5" fill="#D6E7E1"/><rect x="36" y="27" width="92" height="12" rx="6" fill="#D6E7E1"/><rect x="4" y="48" width="68" height="9" rx="4" fill="#D6E7E1"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
      backgrounds: { harbor: "art/harbor.svg", quiet: "art/quiet.svg" },
      characters: { mira: { neutral: "art/mira.svg" } },
      cgs: {},
      atmospheres: { harbor: { mist: mistAsset, rain: rainAsset, intensity: 1, lightning: true } },
    }));

    const story = {
      id: "atmosphere-native-fixture",
      version: 1,
      start: "start",
      script: {
        start: [
          { type: "scene", background: "harbor", characters: [{ id: "mira", expression: "neutral", position: "left" }] },
          { type: "say", id: "harbor-rain", text: "Rain crosses the old harbor." },
          { type: "scene", background: "quiet", characters: [{ id: "mira", expression: "neutral", position: "left" }] },
          { type: "say", id: "quiet-station", text: clearLine },
          { type: "ending", id: "end" },
        ],
      },
    };
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text } from "@pocketjs/framework/solid/components";
import { AccessibilityPreferencesProvider, createAccessibilityPreferences } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelAnimationDriver, createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = {
  backgrounds: { harbor: "art/harbor.svg", quiet: "art/quiet.svg" },
  characters: { mira: { neutral: "art/mira.svg" } },
  cgs: {},
  atmospheres: { harbor: { mist: "${mistAsset}", rain: "${rainAsset}", intensity: 1, lightning: true } },
};
function App() {
  const host = createHostBridge();
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const animations = createNovelAnimationDriver();
  const [clockState, setClockState] = createSignal(animations.needsClock());
  const stopState = animations.subscribe(() => setClockState(animations.needsClock()));
  const stopClock = attachNovelClock(engine, { animations });
  onCleanup(() => { stopState(); stopClock(); engine.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <>
      <NovelView engine={engine} host={host} animations={animations} assets={assets} title="Atmosphere acceptance" subtitle="Shared clock fixture" onNewGame={() => engine.start()} />
      <Text class="absolute" style={{ insetL: 1, insetT: 1 }}>{clockState() ? "clock:on" : "clock:off"}</Text>
    </>
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the atmosphere fixture must execute pinned QJBC");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 120_000 });
    try {
      let frame = await session.boot();
      frame = await session.tap("启程 · 开始新的故事", frame);
      frame = await waitForText(session, frame, "Rain crosses the old harbor.");
      frame = await frameWithClock(session, frame, "clock:on");
      assert.ok(rainTriangles(frame).length > 0, "authored rain must reach the native PMS1 texture-triangle painter");
      expect(mistImages(frame), "both authored mist layers must reach the native image painter").toHaveLength(2);

      const firstWeather = await session.settle(frame, 18);
      expect(rainGeometry(firstWeather), "rain vertices must move across real native frames").not.toBe(rainGeometry(frame));
      expect(mistGeometry(firstWeather), "the two real mist image layers must drift on the same clock").not.toBe(mistGeometry(frame));

      // Opening the real NovelView menu pauses the shared presentation actor;
      // the retained stage remains painted at a stable geometry behind it.
      frame = await session.tap("手札", firstWeather);
      assert.ok(textOf(frame).includes("旅途手札"), `painted journal menu must open from its HUD pointer: ${textOf(frame)}`);
      frame = await frameWithClock(session, frame, "clock:off");
      const pausedGeometry = rainGeometry(frame);
      frame = await session.settle(frame, 18);
      expect(rainGeometry(frame), "paused menu frames must not advance weather vertices").toBe(pausedGeometry);
      frame = await session.tap("继续阅读", frame);
      frame = await waitForText(session, frame, "Rain crosses the old harbor.");
      frame = await frameWithClock(session, frame, "clock:on");
      const resumedGeometry = rainGeometry(frame);
      frame = await session.settle(frame, 18);
      expect(rainGeometry(frame), "resuming the story must resume weather on the shared clock").not.toBe(resumedGeometry);

      const lightning = await framesWithFlash(session, frame);
      assert.ok(lightning.maxAlpha > 0, `the authored distant lightning pulse must appear on real native frames; sampled ${lightning.frames} frames`);
      frame = lightning.frame;

      // This is an actual host preference event delivered over HostBridge, not
      // a test-only atmosphere flag. Rain/flash stop; decorative mist stays.
      session.sendEvent("accessibility.preferences", {
        reduceMotion: true,
        increaseContrast: false,
        textScale: 1,
        accessibleNavigation: false,
        reduceTransparency: null,
      });
      frame = await session.frame();
      expect(rainTriangles(frame), "reduce-motion must remove the animated rain mesh").toHaveLength(0);
      expect(mistImages(frame), "reduce-motion must retain the two still mist layers").toHaveLength(2);
      const stillMist = mistGeometry(frame);
      for (let index = 0; index < 20; index += 1) {
        frame = await session.frame();
        expect(lightningAlpha(frame), "reduce-motion must suppress the lightning flash").toBe(0);
        expect(rainTriangles(frame), "reduce-motion must keep the rain mesh absent").toHaveLength(0);
        expect(mistGeometry(frame), "reduce-motion mist remains still").toBe(stillMist);
      }

      // Return to ordinary preferences before a real dialogue pointer advance.
      session.sendEvent("accessibility.preferences", {
        reduceMotion: false,
        increaseContrast: false,
        textScale: 1,
        accessibleNavigation: false,
        reduceTransparency: null,
      });
      frame = await session.frame();
      frame = await session.tapPoint(dialoguePoint(session));
      frame = await waitForText(session, frame, clearLine);
      frame = await frameWithClock(session, frame, "clock:off");
      expect(rainTriangles(frame), "moving to a background without atmosphere must remove rain mesh ops").toHaveLength(0);
      expect(mistImages(frame), "moving to a background without atmosphere must remove both mist layers").toHaveLength(0);
      const quiet = frame;
      frame = await session.settle(frame, 20);
      expect(rainTriangles(frame), "a cleared scene cannot retain an invisible atmosphere actor").toHaveLength(0);
      expect(mistImages(frame), "a cleared scene cannot retain fog images").toHaveLength(0);
      expect(textOf(frame).replace(/\s/g, ""), "the real dialogue/HUD remains painted above atmosphere stages").toContain(clearLine.replace(/\s/g, ""));
      expect(textOf(quiet)).toContain("clock:off");
    } finally {
      await session.quit();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);
