import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession, center, textOf, textOp, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const sceneSurface = {
  kind: "scene" as const,
  targets: {
    archive: { x: 0.1, y: 0.2, w: 0.3, h: 0.16 },
    relay: { x: 0.6, y: 0.2, w: 0.3, h: 0.16 },
  },
};
const dialSurface = {
  kind: "dial" as const,
  image: "art/relay-dial.svg",
  frame: { x: 0.2, y: 0.1, w: 0.6, h: 0.5 },
  targets: {
    route_7: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    route_1: { x: 0.05, y: 0.35, w: 0.3, h: 0.5 },
    route_4: { x: 0.65, y: 0.35, w: 0.3, h: 0.5 },
  },
};
const surfaceTargets = { hub: sceneSurface, dial_one: dialSurface };

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function centerLabel(frame: Frame, label: string): { x: number; y: number } {
  return center(textOp(frame, label), label);
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

test("native scene hotspots and dial segments route the current engine choices through pointer hits", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-choice-surface-native-"));
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-choice-surface-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
        "@pocket/live2d": `file:${join(sdk, "packages/pocket_live2d")}`,
        "@pocket/spine": `file:${join(sdk, "packages/pocket_spine")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-choice-surface-fixture", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.vn-choice-surface-fixture", capabilities: { requires: [], optional: [] } }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, "art/station.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="512"><rect width="256" height="512" fill="#142B32"/><rect x="26" y="144" width="76" height="80" rx="8" fill="#526E6E"/><rect x="154" y="144" width="76" height="80" rx="8" fill="#6D6751"/></svg>');
    writeFileSync(join(project, "art/relay-dial.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="57" fill="#233C43" stroke="#D9B66A" stroke-width="6"/><circle cx="64" cy="64" r="24" fill="#6A5140"/><path d="M64 11v18M11 64h18M99 64h18M64 99v18" stroke="#E8D5AA" stroke-width="4"/></svg>');
    writeFileSync(join(project, "art/frame.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#182B30" stroke="#D8B65F" stroke-width="3"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
      backgrounds: { station: "art/station.svg" },
      characters: {},
      cgs: {},
      audio: {},
      skin: { frame: { image: "art/frame.svg", width: 16, height: 16, inset: 4 } },
      choiceSurfaces: surfaceTargets,
    }));
    const story = {
      id: "choice-surface-native-fixture",
      version: 1,
      start: "start",
      script: {
        start: [{
          type: "choice",
          id: "hub",
          prompt: "Choose a place on the station scene.",
          options: [
            { id: "archive", text: "Check the archive", target: "archive" },
            { id: "relay", text: "Go to the relay", target: "dial_one" },
          ],
        }],
        archive: [{ type: "say", id: "archive-selected", text: "The archive evidence is open." }],
        dial_one: [{
          type: "choice",
          id: "dial_one",
          prompt: "Set the relay route.",
          options: [
            { id: "route_7", text: "Route 7", target: "route_seven" },
            { id: "route_1", text: "Route 1", target: "route_one" },
            { id: "route_4", text: "Route 4", target: "route_four" },
          ],
        }],
        route_seven: [{ type: "say", id: "route-selected", text: "Seven is selected on the relay." }],
        route_one: [{ type: "say", id: "route-one-selected", text: "One is selected on the relay." }],
        route_four: [{ type: "say", id: "route-four-selected", text: "Four is selected on the relay." }],
      },
    };
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, FocusScope, Image, Text, View } from "@pocketjs/framework/solid/components";
import { createNovelEngine } from "@pocket/vn";
import { createNovelChoiceSurfaceLayout } from "@pocket/vn/choice-surface";
import { NovelChoiceSurfaceView } from "@pocket/vn/choice-surface-view";
import { NovelSkinFrame } from "@pocket/vn/skin-view";
const story = ${JSON.stringify(story)};
const surfaces = ${JSON.stringify(surfaceTargets)};
const frameSkin = { image: "art/frame.svg", width: 16, height: 16, inset: 4 };
function App() {
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const [snapshot, setSnapshot] = createSignal(engine.getSnapshot());
  const unsubscribe = engine.subscribe(update => setSnapshot(update.snapshot));
  const activeChoice = () => { const active = snapshot().active; return active?.kind === "choice" ? active : undefined; };
  const layout = () => {
    const active = activeChoice();
    return active ? createNovelChoiceSurfaceLayout(surfaces[active.id as keyof typeof surfaces], active.options, 360, 640, { width: 128, height: 128 }) : null;
  };
  onMount(() => engine.start());
  onCleanup(() => { unsubscribe(); engine.dispose(); });
  return <FocusScope class="relative w-full h-full" autoFocus>
    <Image src="art/station.svg" class="absolute" style={{ width: 360, height: 640, hitPass: 1 }} />
    <Show when={layout()}>{resolved => <NovelChoiceSurfaceView layout={resolved()} renderOption={(option, geometry, displayCaption) => <Focusable
      class="absolute flex-col items-center justify-center"
      style={{ insetL: geometry.x, insetT: geometry.y, width: geometry.width, height: geometry.height }}
      debugName={"choice-target-" + option.id}
      onPress={() => engine.selectChoice(option.id)}
    >
      <NovelSkinFrame frame={frameSkin} width={geometry.width} height={geometry.height} border={8} debugName={"choice-target-skin-" + option.id} />
      <Text class="text-sm text-[#F5ECD9]">{displayCaption}</Text>
    </Focusable>} />}</Show>
    <View class="absolute flex-col" style={{ insetL: 2, insetT: 2, width: 356, height: 48, hitPass: 1 }}>
      <Show when={activeChoice()} fallback={<Show when={snapshot().active?.kind === "say" ? snapshot().active : undefined}>{line => <Text class="text-sm text-[#F5ECD9]">{line().text}</Text>}</Show>}>
        {choice => <Text class="text-xs text-[#E4CF9E]">{choice().id === "hub" ? "Station evidence" : "Relay dial"}</Text>}
      </Show>
    </View>
  </FocusScope>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "choice surfaces must execute through the pinned QuickJS bytecode pipeline");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 60_000 });
    try {
      let frame = await session.boot();
      const station = (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === "art/station.svg");
      assert.ok(station, "scene surface fixture must paint the native station background image");
      expect(textOf(frame)).toContain("Check the archive");
      expect(textOf(frame)).toContain("Go to the relay");
      const sceneFrameSkin = (frame.ops ?? []).filter(op => op.type === "textureTriangle" && assetOf(op) === "art/frame.svg");
      expect(sceneFrameSkin.length, "scene hotspots must use the real image-backed skin mesh").toBeGreaterThan(0);

      frame = await session.tapPoint(centerLabel(frame, "Go to the relay"));
      expect(textOf(frame)).toContain("Relay dial");
      const dialArt = (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === "art/relay-dial.svg");
      assert.ok(dialArt, "dial surface must paint its registered illustration in the native image painter");
      expect(textOf(frame)).toContain("Route 7");
      expect(textOf(frame)).toContain("Route 1");
      expect(textOf(frame)).toContain("Route 4");

      frame = await session.tapPoint(centerLabel(frame, "Route 7"));
      frame = await waitForText(session, frame, "Seven is selected on the relay.");
      expect(textOf(frame)).toContain("Seven is selected on the relay.");
      expect((frame.ops ?? []).some(op => op.type === "image" && assetOf(op) === "art/relay-dial.svg"),
        "selecting a target must continue the actual engine branch and remove the active dial surface").toBe(false);
    } finally {
      await session.quit();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
