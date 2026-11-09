import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import { NativeSession, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const viewport = { width: 360, height: 640 };
const backgroundAsset = "art/harbor.svg";
const actorAsset = "art/runner.svg";
const quickSlotKey = "timeline.slot.quick";

type Rect = { x: number; y: number; w: number; h: number };
type ImageState = Rect & { uv?: number[] };

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function imageOp(frame: Frame, asset: string, label: string): DrawOp & { uv?: number[] } {
  const op = (frame.ops ?? []).find(item => item.type === "image" && assetOf(item) === asset);
  assert.ok(op, `${label} must reach the actual native image DrawOp for ${asset}; ${textOf(frame)}`);
  return op as DrawOp & { uv?: number[] };
}

function imageState(frame: Frame, asset: string, label: string): ImageState {
  const op = imageOp(frame, asset, label);
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof op[key], "number", `${label} native DrawOp must include ${key}`);
  }
  return {
    x: op.x!, y: op.y!, w: op.w!, h: op.h!,
    ...(Array.isArray(op.uv) ? { uv: [...op.uv] } : {}),
  };
}

function rectDelta(left: Rect, right: Rect): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) +
    Math.abs(left.w - right.w) + Math.abs(left.h - right.h);
}

function uvDelta(left: ImageState, right: ImageState): number {
  assert.ok(left.uv && right.uv && left.uv.length === 4 && right.uv.length === 4,
    "camera sampling must be visible in the actual native background UV crop");
  return left.uv!.reduce((total, value, index) => total + Math.abs(value - right.uv![index]!), 0);
}

function dialoguePoint(): { x: number; y: number } {
  const layout = createNovelViewportLayout(viewport, { top: 0, right: 0, bottom: 0, left: 0 });
  return {
    x: layout.insetL + layout.width / 2,
    y: layout.insetT + layout.height - layout.dialogueBottom - layout.dialogueHeight / 2,
  };
}

function compact(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

async function waitForText(session: NativeSession, initial: Frame, expected: string, attempts = 40): Promise<Frame> {
  let frame = initial;
  const target = compact(expected);
  for (let index = 0; index < attempts; index += 1) {
    if (compact(textOf(frame)).includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error(`pinned guest never painted ${expected}; frame=${textOf(frame)}`);
}

async function waitForQuickSlotReady(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const painted = textOf(frame);
    if (painted.includes("快速存档") && !painted.includes("正在读取")) return frame;
    frame = await session.frame();
  }
  throw new Error(`quick slot never finished its native storage reads: ${textOf(frame)}`);
}

async function waitForLoadedStory(session: NativeSession, initial: Frame, expected: string): Promise<Frame> {
  let frame = initial;
  const target = compact(expected);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const painted = textOf(frame);
    if (compact(painted).includes(target) && !painted.includes("自动记录") && !painted.includes("空白信笺")) return frame;
    frame = await session.frame();
  }
  throw new Error(`quick-load request did not close the slot panel and restore ${expected}: ${textOf(frame)}`);
}

function timelineAudio(session: NativeSession): string[] {
  return session.requests
    .filter(request => request.capability === "media.audio.play")
    .map(request => String(request.params.asset));
}

function assertAudioSequence(session: NativeSession, expected: readonly string[], phase: string): void {
  assert.deepEqual(timelineAudio(session), expected, `${phase}: one-shot cue requests must follow timeline order exactly`);
}

test("pinned Guest runs, pauses, saves, loads, rolls back, cancels and completes native VN timelines", { timeout: 360_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-timeline-native-"));
  let session: NativeSession | undefined;
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-timeline-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-timeline-native-fixture",
      app: { entry: "app.tsx", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-timeline-native-fixture",
      capabilities: {
        requires: ["platform.storage.get", "platform.storage.set", "platform.storage.remove", "platform.storage.keys"],
        optional: ["media.audio.play", "media.audio.pause", "media.audio.resume", "media.audio.stop", "media.audio.volume"],
      },
    }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, backgroundAsset), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#264D59"/><circle cx="146" cy="54" r="28" fill="#F0CE83"/><path d="M0 252h180M0 280h180" stroke="#D9C8A6" stroke-width="5"/></svg>');
    writeFileSync(join(project, actorAsset), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="350"><rect x="18" y="8" width="204" height="334" rx="28" fill="#A95852"/><circle cx="120" cy="86" r="48" fill="#E7BE9A"/><path d="M54 222h132" stroke="#F7EAD1" stroke-width="16"/></svg>');

    const story = {
      id: "timeline-native-fixture",
      version: 1,
      start: "start",
      timelines: {
        choreography: {
          durationMs: 1600,
          camera: [
            { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
            { atMs: 800, value: { x: 42, y: -20, scale: 1.15 }, easing: "easeInOut" },
            { atMs: 1600, value: { x: 84, y: -42, scale: 1.32 }, easing: "linear" },
          ],
          actors: [{
            id: "runner",
            keyframes: [
              { atMs: 0, value: { position: { x: 30, y: 320 }, scale: 0.65, rotation: 0 } },
              { atMs: 800, value: { position: { x: 110, y: 250 }, scale: 1, rotation: 0 } },
              { atMs: 1600, value: { position: { x: 190, y: 160 }, scale: 1.3, rotation: 0 } },
            ],
          }],
          audio: [
            { atMs: 0, cue: "opening" },
            { atMs: 240, cue: "footstep" },
            { atMs: 1200, cue: "arrival" },
          ],
        },
        interruptible: {
          durationMs: 1000,
          camera: [
            { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
            { atMs: 1000, value: { x: -42, y: 12, scale: 0.84 } },
          ],
          actors: [{
            id: "runner",
            keyframes: [
              { atMs: 0, value: { position: { x: 30, y: 320 }, scale: 0.65, rotation: 0 } },
              { atMs: 1000, value: { position: { x: 200, y: 140 }, scale: 1.25, rotation: 0 } },
            ],
          }],
        },
      },
      script: {
        start: [
          { type: "scene", background: "harbor", characters: [{ id: "runner", expression: "neutral", position: { x: 30, y: 320 }, scale: 0.65, rotation: 0 }], camera: { x: 0, y: 0, scale: 1 } },
          { type: "say", id: "before", text: "Before the timeline starts." },
          { type: "scene", timeline: "choreography" },
          { type: "say", id: "timeline-first", text: "The synchronized camera and actor tracks are moving." },
          { type: "say", id: "timeline-second", text: "Rollback returns to the saved timeline point." },
          { type: "scene", background: "harbor", characters: [{ id: "runner", expression: "neutral", position: { x: 30, y: 320 }, scale: 0.65, rotation: 0 }], camera: { x: 0, y: 0, scale: 1 }, transition: { kind: "cut", durationMs: 0 }, timeline: null },
          { type: "say", id: "static-control", text: "This identical stage is now static without a timeline." },
          { type: "scene", timeline: "interruptible" },
          { type: "say", id: "interrupting", text: "This scene can be interrupted before the endpoint." },
          { type: "scene", timeline: null },
          { type: "say", id: "cancelled", text: "The omitted scene motion was cleared and held at this pose." },
          { type: "ending", id: "done", text: "Timeline acceptance complete." },
        ],
      },
    };
    const assets = {
      backgrounds: { harbor: backgroundAsset },
      characters: { runner: { neutral: actorAsset } },
      cgs: {},
      imageDimensions: {
        [backgroundAsset]: { width: 180, height: 320 },
        [actorAsset]: { width: 240, height: 350 },
      },
    };
    writeFileSync(join(project, "app.tsx"), `
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { AccessibilityPreferencesProvider, createAccessibilityPreferences } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createNovelEngine, createNovelSlotManager } from "@pocket/vn";
import { createNovelAudioAdapter } from "@pocket/vn/audio";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = ${JSON.stringify(assets)};
const audioAssets = { opening: "audio/opening.wav", footstep: "audio/footstep.wav", arrival: "audio/arrival.wav" };
function App() {
  const host = createHostBridge();
  const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const storage = createNovelSlotManager({
    get: key => platform.storage.get(key),
    set: (key, value) => platform.storage.set(key, value),
    remove: key => platform.storage.remove(key),
    keys: () => platform.storage.keys(),
  }, { prefix: "timeline.slot." });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0, skipSeenOnly: true } });
  const audio = createNovelAudioAdapter(host, audioAssets);
  const removeAudio = engine.subscribe(update => audio.apply(update), { emitCurrent: true });
  const stopClock = attachNovelClock(engine);
  onCleanup(() => { stopClock(); removeAudio(); audio.dispose(); engine.dispose(); platform.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <NovelView engine={engine} host={host} storage={storage} assets={assets} locale="zh" title="Timeline acceptance" shortTitle="Timeline" subtitle="Pinned native multi-track fixture" onNewGame={() => engine.start()} />
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "timeline fixture must execute pinned QuickJS bytecode");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    session = new NativeSession(artifacts, { ...viewport, deadlineMs: 180_000 });

    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForText(session, frame, "Before the timeline starts.");
    const baseline = {
      background: imageState(frame, backgroundAsset, "static baseline background"),
      actor: imageState(frame, actorAsset, "static baseline actor"),
    };

    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "The synchronized camera and actor tracks are moving.");
    const start = {
      background: imageState(frame, backgroundAsset, "timeline start background"),
      actor: imageState(frame, actorAsset, "timeline start actor"),
    };
    assert.ok(rectDelta(start.actor, baseline.actor) < 2, "the authored timeline begins at the same actor pose as its scene composition");
    assert.ok(uvDelta(start.background, baseline.background) < 0.01, "the authored timeline begins at the same camera pose as its scene composition");
    assertAudioSequence(session, ["audio/opening.wav"], "timeline start cue");

    frame = await session.settle(frame, 18);
    const middle = {
      background: imageState(frame, backgroundAsset, "timeline middle background"),
      actor: imageState(frame, actorAsset, "timeline middle actor"),
    };
    assert.ok(uvDelta(middle.background, start.background) > 0.015,
      "middle native background UVs must show the camera track advancing");
    assert.ok(rectDelta(middle.actor, start.actor) > 12,
      "middle native actor bounds must show the actor track advancing in the same clock interval");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav"], "middle timeline cue");

    // The fixed NovelView HUD pauses the shared engine clock while the real
    // quick-save action persists its current single timeline cursor.
    frame = await session.tap("手札", frame);
    assert.ok(textOf(frame).includes("旅途手札"), "the actual fixed HUD opens during the running timeline");
    const paused = {
      background: imageState(frame, backgroundAsset, "paused timeline background"),
      actor: imageState(frame, actorAsset, "paused timeline actor"),
    };
    frame = await session.settle(frame, 10);
    assert.equal(uvDelta(imageState(frame, backgroundAsset, "paused background after frames"), paused.background), 0,
      "pause freezes the camera track across native clock frames");
    assert.equal(rectDelta(imageState(frame, actorAsset, "paused actor after frames"), paused.actor), 0,
      "pause freezes the actor track across native clock frames");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav"], "paused timeline");
    frame = await session.tap("快速保存此刻", frame);
    for (let attempt = 0; attempt < 40 && !session.storage[quickSlotKey]; attempt += 1) frame = await session.frame();
    const quickSave = session.storage[quickSlotKey] as { state?: { paused?: boolean; stage?: { timeline?: { id?: string; elapsedMs?: number } | null } } } | undefined;
    assert.ok(quickSave?.state, "NovelView quick save must go through NativeSession's injected capability-backed storage");
    assert.equal(quickSave!.state!.paused, false, "the real player saves a resumable snapshot while the menu holds pause");
    const savedTimeline = quickSave!.state!.stage?.timeline;
    assert.equal(savedTimeline?.id, "choreography", "the save retains the active preset id");
    assert.ok(Number(savedTimeline?.elapsedMs) > 0 && Number(savedTimeline?.elapsedMs) < 1200,
      "the save retains the in-flight shared-clock elapsed time before the late cue");
    const savedElapsedMs = Number(savedTimeline!.elapsedMs);

    frame = await session.tap("继续阅读", frame);
    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "Rollback returns to the saved timeline point.");
    frame = await session.settle(frame, 62);
    const beforeRollback = {
      background: imageState(frame, backgroundAsset, "pre-rollback camera"),
      actor: imageState(frame, actorAsset, "pre-rollback actor"),
    };
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav"], "late cue before rollback");

    // The real NovelView rollback restores the first completed dialogue's
    // StageState cursor. Earlier cues are already behind it and must not replay.
    frame = await session.tap("回溯", frame);
    frame = await waitForText(session, frame, "The synchronized camera and actor tracks are moving.");
    const rolledBack = {
      background: imageState(frame, backgroundAsset, "rolled-back camera"),
      actor: imageState(frame, actorAsset, "rolled-back actor"),
    };
    assert.ok(uvDelta(rolledBack.background, beforeRollback.background) > 0.04,
      "rollback restores the earlier camera timeline sample");
    assert.ok(rectDelta(rolledBack.actor, beforeRollback.actor) > 24,
      "rollback restores the earlier actor timeline sample");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav"], "immediately after rollback");

    frame = await session.settle(frame, 90);
    const completed = {
      background: imageState(frame, backgroundAsset, "completed camera"),
      actor: imageState(frame, actorAsset, "completed actor"),
    };
    assert.ok(uvDelta(completed.background, start.background) > 0.08,
      "the camera reaches its authored end pose in native image UVs");
    assert.ok(rectDelta(completed.actor, start.actor) > 80,
      "the actor reaches its authored end position and scale in native image bounds");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav", "audio/arrival.wav"],
      "rollback traversal completion");
    frame = await session.settle(frame, 20);
    assert.equal(uvDelta(imageState(frame, backgroundAsset, "completed camera after sleep"), completed.background), 0,
      "completed camera has no remaining timeline work to clock");
    assert.equal(rectDelta(imageState(frame, actorAsset, "completed actor after sleep"), completed.actor), 0,
      "completed actor has no remaining timeline work to clock");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav", "audio/arrival.wav"],
      "completed timeline after sleep");

    // Load the saved in-flight point through NovelView's real load menu. The
    // save starts after both earlier cues, so neither can be requested again.
    frame = await session.tap("手札", frame);
    frame = await session.tap("重读信笺", frame);
    frame = await waitForQuickSlotReady(session, frame);
    frame = await session.tap("快速存档", frame);
    frame = await waitForLoadedStory(session, frame, "The synchronized camera and actor tracks are moving.");
    const loaded = {
      background: imageState(frame, backgroundAsset, "loaded camera"),
      actor: imageState(frame, actorAsset, "loaded actor"),
    };
    assert.ok(uvDelta(loaded.background, middle.background) < 0.08,
      `quick load restores the saved camera sample near ${savedElapsedMs}ms: ${JSON.stringify({ loaded: loaded.background, middle: middle.background, save: quickSave!.state!.stage?.timeline })}`);
    assert.ok(rectDelta(loaded.actor, middle.actor) < 32,
      `quick load restores the saved actor sample near ${savedElapsedMs}ms: ${JSON.stringify({ loaded: loaded.actor, middle: middle.actor, save: quickSave!.state!.stage?.timeline })}`);
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav", "audio/arrival.wav"],
      "quick load does not replay cues at zero or before the saved cursor");
    frame = await session.settle(frame, 90);
    const loadedCompleted = {
      background: imageState(frame, backgroundAsset, "loaded completed camera"),
      actor: imageState(frame, actorAsset, "loaded completed actor"),
    };
    assert.ok(uvDelta(loadedCompleted.background, completed.background) < 0.02,
      "resumed camera reaches the same authored terminal pose");
    assert.ok(rectDelta(loadedCompleted.actor, completed.actor) < 2,
      "resumed actor reaches the same authored terminal bounds");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav", "audio/arrival.wav", "audio/arrival.wav"],
      "quick load dispatches only the not-yet-crossed cue once");

    // Ablation: the identical initial stage with an immediate cut and null
    // timeline stays still under the same real Guest frame pump.
    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "Rollback returns to the saved timeline point.");
    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "This identical stage is now static without a timeline.");
    const staticControl = {
      background: imageState(frame, backgroundAsset, "static control camera"),
      actor: imageState(frame, actorAsset, "static control actor"),
    };
    assert.ok(rectDelta(staticControl.actor, baseline.actor) < 2,
      "the same unanimated scene returns to the initial actor geometry after its immediate cut");
    assert.ok(uvDelta(staticControl.background, baseline.background) < 0.01,
      "the same unanimated scene returns to the initial camera crop after its immediate cut");
    frame = await session.settle(frame, 24);
    assert.equal(rectDelta(imageState(frame, actorAsset, "static actor after clock frames"), staticControl.actor), 0,
      "the no-timeline cut control remains static across native frames");
    assert.equal(uvDelta(imageState(frame, backgroundAsset, "static camera after clock frames"), staticControl.background), 0,
      "the no-timeline cut control has no camera track to clock");

    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "This scene can be interrupted before the endpoint.");
    const interruptStart = {
      background: imageState(frame, backgroundAsset, "interruptible timeline start camera"),
      actor: imageState(frame, actorAsset, "interruptible timeline start actor"),
    };
    frame = await session.settle(frame, 8);
    const interruptMiddle = {
      background: imageState(frame, backgroundAsset, "interruptible timeline middle camera"),
      actor: imageState(frame, actorAsset, "interruptible timeline middle actor"),
    };
    assert.ok(rectDelta(interruptMiddle.background, interruptStart.background) > 4,
      `the second timeline begins moving its native camera: ${JSON.stringify({ start: interruptStart, middle: interruptMiddle, text: textOf(frame) })}`);
    assert.ok(rectDelta(interruptMiddle.actor, interruptStart.actor) > 4,
      `the second timeline begins moving its native actor: ${JSON.stringify({ start: interruptStart, middle: interruptMiddle, text: textOf(frame) })}`);

    frame = await session.tapPoint(dialoguePoint());
    frame = await waitForText(session, frame, "The omitted scene motion was cleared and held at this pose.");
    const cancelled = {
      background: imageState(frame, backgroundAsset, "cancelled camera"),
      actor: imageState(frame, actorAsset, "cancelled actor"),
    };
    frame = await session.settle(frame, 30);
    assert.equal(uvDelta(imageState(frame, backgroundAsset, "cancelled camera after frames"), cancelled.background), 0,
      "scene.timeline null cancels the unfinished camera track and retains its sampled pose");
    assert.equal(rectDelta(imageState(frame, actorAsset, "cancelled actor after frames"), cancelled.actor), 0,
      "scene.timeline null cancels the unfinished actor track and retains its sampled pose");
    assertAudioSequence(session, ["audio/opening.wav", "audio/footstep.wav", "audio/arrival.wav", "audio/arrival.wav", "audio/arrival.wav"],
      "timeline cancellation does not synthesize any extra provider requests");

    console.log(`novel_timeline_native: pinned buildGuest ${artifacts.runtimeAbi}; native image samples ${JSON.stringify({ start, middle, completed, loaded, interruptStart, interruptMiddle, cancelled })}; audio ${JSON.stringify(timelineAudio(session))}; timeline save ${savedElapsedMs}ms; pause/load/rollback/null cancellation/static-cut ablation passed`);
  } finally {
    await session?.quit();
    rmSync(project, { recursive: true, force: true });
  }
});
