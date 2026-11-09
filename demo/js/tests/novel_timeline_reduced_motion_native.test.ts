import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { createNovelChoiceSurfaceLayout } from "../../../sdk/packages/pocket_vn/src/choice-surface.ts";
import { resolveNovelCameraPose } from "../../../sdk/packages/pocket_vn/src/camera.ts";
import { NativeSession, center, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const viewport = { width: 360, height: 640 };
const backgroundAsset = "art/harbor.svg";
const actorAsset = "art/runner.svg";
const reducedTargetCamera = { x: 110, y: -36, scale: 1.42, motion: null };
const routeOptions = [
  { id: "east", text: "East", target: "route_east" },
  { id: "west", text: "West", target: "route_west" },
] as const;
const routeSurface = {
  kind: "scene",
  frame: { x: 0.04, y: 0.16, w: 0.92, h: 0.72 },
  targets: {
    east: { x: 0.03, y: 0.39, w: 0.42, h: 0.48 },
    west: { x: 0.55, y: 0.39, w: 0.42, h: 0.48 },
  },
} as const;

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type ImageState = Rect & { readonly uv: readonly number[] };
type VisualState = { readonly background: ImageState; readonly actor: ImageState };
type Pose = readonly [number, number, number, number, number, number];
type Diagnostic = {
  readonly elapsedMs: number;
  readonly savedElapsedMs: number;
  readonly canonical: Pose;
  readonly saved: Pose;
  readonly displayed: Pose;
  readonly reduceMotion: boolean;
  readonly musicGain: number;
};

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function imageState(frame: Frame, asset: string, label: string): ImageState {
  const op = (frame.ops ?? []).find(item => item.type === "image" && assetOf(item) === asset) as (DrawOp & { uv?: number[] }) | undefined;
  assert.ok(op, `${label} must be a native image DrawOp for ${asset}; ${textOf(frame)}`);
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof op[key], "number", `${label} native DrawOp must include ${key}`);
  }
  assert.ok(Array.isArray(op.uv) && op.uv.length === 4, `${label} native background crop must expose four UV coordinates`);
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h!, uv: [...op.uv!] };
}

function visualState(frame: Frame, phase: string): VisualState {
  return {
    background: imageState(frame, backgroundAsset, `${phase} background`),
    actor: imageState(frame, actorAsset, `${phase} actor`),
  };
}

function assertImageClose(actual: ImageState, expected: ImageState, phase: string): void {
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1,
      `${phase} ${key} should match within one native pixel (actual ${actual[key]}, expected ${expected[key]})`);
  }
  for (const [index, value] of actual.uv.entries()) {
    assert.ok(Math.abs(value - expected.uv[index]!) < 0.01,
      `${phase} UV ${index} should match (actual ${value}, expected ${expected.uv[index]})`);
  }
}

function assertVisualClose(actual: VisualState, expected: VisualState, phase: string): void {
  assertImageClose(actual.background, expected.background, `${phase} background`);
  assertImageClose(actual.actor, expected.actor, `${phase} actor`);
}

function rectOf(op: DrawOp, label: string): Rect {
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof op[key], "number", `${label} must expose ${key}`);
  }
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h! };
}

function hudButton(frame: Frame): Rect {
  const op = (frame.ops ?? []).find(item => item.type === "text" && item.text === "手札");
  assert.ok(op, `the real NovelView HUD must paint 手札; ${textOf(frame)}`);
  return rectOf(op!, "NovelView journal HUD label");
}

function diagnostic(frame: Frame): Diagnostic {
  const op = (frame.ops ?? []).find(item => item.type === "text" && typeof item.text === "string" && item.text.startsWith("diag:"));
  assert.ok(op, `the native frame must paint the fixture's canonical/save/presentation report; ${textOf(frame)}`);
  const fields = op!.text!.slice("diag:".length).split("|");
  assert.equal(fields.length, 7, `diagnostic fields are malformed: ${op!.text}`);
  const pose = (field: string | undefined): Pose => {
    assert.ok(field, "diagnostic pose is present");
    const values = field.split(",").map(Number);
    assert.equal(values.length, 6, `diagnostic pose is malformed: ${field}`);
    assert.ok(values.every(Number.isFinite), `diagnostic pose has finite values: ${field}`);
    return values as unknown as Pose;
  };
  return {
    elapsedMs: Number(fields[0]),
    savedElapsedMs: Number(fields[1]),
    canonical: pose(fields[2]),
    saved: pose(fields[3]),
    displayed: pose(fields[4]),
    reduceMotion: fields[5] === "1",
    musicGain: Number(fields[6]),
  };
}

function assertPoseClose(actual: Pose, expected: Pose, phase: string): void {
  for (const [index, value] of actual.entries()) {
    assert.ok(Math.abs(value - expected[index]!) < 0.02,
      `${phase} pose component ${index} should match (actual ${value}, expected ${expected[index]})`);
  }
}

function assertCanonicalSave(diagnosticValue: Diagnostic, phase: string): void {
  assert.equal(diagnosticValue.savedElapsedMs, diagnosticValue.elapsedMs,
    `${phase}: engine.save() must preserve the canonical timeline cursor`);
  assertPoseClose(diagnosticValue.saved, diagnosticValue.canonical,
    `${phase}: engine.save() must preserve the canonical stage pose`);
}

function routePoint(frame: Frame, optionId: "east" | "west"): { x: number; y: number } {
  const width = frame.width ?? viewport.width;
  const height = frame.height ?? viewport.height;
  const resolved = createNovelChoiceSurfaceLayout(routeSurface, routeOptions, width, height, undefined, 44 / reducedTargetCamera.scale);
  assert.ok(resolved, "the stage route surface must resolve through the SDK layout helper");
  const target = resolved!.targets.find(entry => entry.option.id === optionId);
  assert.ok(target, `the stage route surface must include ${optionId}`);
  const pose = resolveNovelCameraPose(reducedTargetCamera);
  return {
    x: width / 2 + (target!.x + target!.width / 2 - width / 2) * pose.scale + pose.x,
    y: height / 2 + (target!.y + target!.height / 2 - height / 2) * pose.scale + pose.y,
  };
}

function audioPlayAssets(session: NativeSession): string[] {
  return session.requests
    .filter(request => request.capability === "media.audio.play")
    .map(request => String(request.params.asset));
}

function musicVolumes(session: NativeSession): number[] {
  return session.requests
    .filter(request => request.capability === "media.audio.volume" && request.params.channel === "music")
    .map(request => Number(request.params.volume))
    .filter(Number.isFinite);
}

async function waitForText(session: NativeSession, initial: Frame, expected: string, maxFrames = 120): Promise<Frame> {
  let frame = initial;
  const compact = (value: string): string => value.replace(/[\s\u200b\ufeff]/g, "");
  const needle = compact(expected);
  for (let index = 0; index < maxFrames; index += 1) {
    if (compact(textOf(frame)).includes(needle)) return frame;
    frame = await session.frame();
  }
  throw new Error(`pinned guest never painted ${expected}; frame=${textOf(frame)}`);
}

async function bootStory(session: NativeSession, reduceMotion: boolean): Promise<Frame> {
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
  return waitForText(session, frame, "The timeline is in motion.");
}

test("pinned NovelView projects reduced-motion timelines without changing saved state or pointer targets", { timeout: 360_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-timeline-reduced-native-"));
  const qaDir = process.env.POCKET_TIMELINE_REDUCED_ARTIFACT_DIR ??
    join(repositoryRoot, "sdk/.pocket-build/timeline-accessibility/native-reduced");
  const qaResultPath = join(qaDir, "results.json");
  mkdirSync(qaDir, { recursive: true });
  let normalSession: NativeSession | undefined;
  let reducedSession: NativeSession | undefined;
  const evidence: Record<string, unknown> = {
    test: "pinned NovelView reduced-motion timeline",
    entryFormat: "unknown",
    outcome: "running",
  };
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-timeline-reduced-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdk, "packages/pocket_vn")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-timeline-reduced-native-fixture",
      app: { entry: "app.tsx", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-timeline-reduced-native-fixture",
      capabilities: { requires: [], optional: ["media.audio.play", "media.audio.pause", "media.audio.resume", "media.audio.stop", "media.audio.volume"] },
    }));
    mkdirSync(join(project, "art"), { recursive: true });
    writeFileSync(join(project, backgroundAsset), '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="360"><rect width="220" height="360" fill="#264D59"/><circle cx="170" cy="58" r="34" fill="#F0CE83"/><path d="M0 260h220M0 294h220" stroke="#D9C8A6" stroke-width="6"/></svg>');
    writeFileSync(join(project, actorAsset), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="350"><rect x="18" y="8" width="204" height="334" rx="28" fill="#A95852"/><circle cx="120" cy="86" r="48" fill="#E7BE9A"/><path d="M54 222h132" stroke="#F7EAD1" stroke-width="16"/></svg>');

    const story = {
      id: "timeline-reduced-native-fixture",
      version: 1,
      start: "start",
      timelines: {
        choreography: {
          durationMs: 1800,
          camera: [
            { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
            { atMs: 900, value: { x: 38, y: -18, scale: 1.14 }, easing: "easeInOut" },
            { atMs: 1800, value: { x: reducedTargetCamera.x, y: reducedTargetCamera.y, scale: reducedTargetCamera.scale } },
          ],
          actors: [{
            id: "runner",
            keyframes: [
              { atMs: 0, value: { position: { x: 28, y: 318 }, scale: 0.64, rotation: 0 } },
              { atMs: 900, value: { position: { x: 105, y: 244 }, scale: 0.96, rotation: 0 }, easing: "easeInOut" },
              { atMs: 1800, value: { position: { x: 202, y: 152 }, scale: 1.28, rotation: 0 } },
            ],
          }],
          audio: [
            { atMs: 0, cue: "musicBed", channel: "music", loop: true },
            { atMs: 240, cue: "footstep" },
            { atMs: 880, cue: "arrival" },
          ],
          audioGains: [{ channel: "music", keyframes: [
            { atMs: 0, value: 1 },
            { atMs: 900, value: 0.45 },
            { atMs: 1800, value: 0.15 },
          ] }],
        },
      },
      script: {
        start: [
          { type: "scene", background: "harbor", characters: [{ id: "runner", expression: "neutral", position: { x: 28, y: 318 }, scale: 0.64, rotation: 0 }], camera: { x: 0, y: 0, scale: 1 } },
          { type: "scene", timeline: "choreography" },
          { type: "say", id: "timeline-running", text: "The timeline is in motion." },
          { type: "choice", id: "route", prompt: "Choose the projected route.", options: routeOptions },
        ],
        route_east: [{ type: "say", id: "route-east", text: "Projected route selected." }],
        route_west: [{ type: "say", id: "route-west", text: "Other route selected." }],
      },
    };
    const assets = {
      backgrounds: { harbor: backgroundAsset },
      characters: { runner: { neutral: actorAsset } },
      cgs: {},
      imageDimensions: {
        [backgroundAsset]: { width: 220, height: 360 },
        [actorAsset]: { width: 240, height: 350 },
      },
      choiceSurfaces: { route: routeSurface },
    };
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify(assets));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text } from "@pocketjs/framework/solid/components";
import { AccessibilityPreferencesProvider, createAccessibilityPreferences } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine } from "@pocket/vn";
import { createNovelAudioAdapter } from "@pocket/vn/audio";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
const story = ${JSON.stringify(story)};
const assets = ${JSON.stringify(assets)};
const audioAssets = { musicBed: "audio/music.wav", footstep: "audio/footstep.wav", arrival: "audio/arrival.wav" };
const poseText = stage => {
  const actor = stage.characters.runner;
  if (!actor) return "pending";
  return [stage.camera.x, stage.camera.y, stage.camera.scale, actor.position.x, actor.position.y, actor.scale]
    .map(value => Number(value).toFixed(2)).join(",");
};
function App() {
  const host = createHostBridge();
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const audio = createNovelAudioAdapter(host, audioAssets);
  const removeAudio = engine.subscribe(update => audio.apply(update), { emitCurrent: true });
  const [snapshot, setSnapshot] = createSignal(engine.getSnapshot());
  const [savedStage, setSavedStage] = createSignal(engine.save().state.stage);
  const removeState = engine.subscribe(update => {
    setSnapshot(update.snapshot);
    setSavedStage(engine.save().state.stage);
  }, { emitCurrent: true });
  const report = () => {
    const current = snapshot();
    const canonical = current.stage;
    const saved = savedStage();
    const reduced = accessibility().reduceMotion;
    const displayed = reduced ? engine.getStagePresentation({ reduceMotion: true }) : canonical;
    const elapsed = canonical.timeline?.elapsedMs ?? -1;
    const savedElapsed = saved.timeline?.elapsedMs ?? -1;
    const musicGain = current.audioIntents.music?.gain ?? 1;
    return "diag:" + [elapsed, savedElapsed, poseText(canonical), poseText(saved), poseText(displayed), reduced ? 1 : 0, musicGain.toFixed(4)].join("|");
  };
  const stopClock = attachNovelClock(engine);
  onCleanup(() => { stopClock(); removeState(); removeAudio(); audio.dispose(); engine.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}>
    <>
      <NovelView engine={engine} host={host} assets={assets} locale="zh" title="Timeline acceptance" shortTitle="Timeline" subtitle="Reduced-motion native fixture" onNewGame={() => engine.start()} />
      <Text class="absolute text-xs text-[#FFFFFF]" style={{ insetL: 2, insetT: 0, width: 356, height: 16 }}>{report()}</Text>
    </>
  </AccessibilityPreferencesProvider>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the fixture must execute pinned QuickJS bytecode");
    evidence.entryFormat = metadata.entryFormat;
    evidence.runtimeAbi = metadata.runtimeAbi;
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };

    normalSession = new NativeSession(artifacts, { ...viewport, deadlineMs: 180_000 });
    let frame = await bootStory(normalSession, false);
    const normalStart = visualState(frame, "normal start");
    const normalStartData = diagnostic(frame);
    assert.equal(normalStartData.reduceMotion, false);
    assert.ok(normalStartData.elapsedMs >= 0 && normalStartData.elapsedMs < 64,
      `normal session should start at the authored first timeline frame; ${JSON.stringify(normalStartData)}`);
    assertCanonicalSave(normalStartData, "normal start");
    assertPoseClose(normalStartData.displayed, normalStartData.canonical, "normal display should use the canonical sample");

    frame = await normalSession.settle(frame, 40);
    const normalAt40 = visualState(frame, "normal middle");
    const normalAt40Data = diagnostic(frame);
    assert.ok(normalAt40Data.elapsedMs > normalStartData.elapsedMs + 500,
      "normal timeline time must advance across actual NativeSession frames");
    assertCanonicalSave(normalAt40Data, "normal middle");
    assertPoseClose(normalAt40Data.displayed, normalAt40Data.canonical, "normal display follows canonical mid-pose");
    assert.ok(Math.abs(normalAt40.background.uv[0]! - normalStart.background.uv[0]!) > 0.01,
      "normal middle background UVs must expose the in-flight camera projection");
    assert.ok(Math.abs(normalAt40.actor.x - normalStart.actor.x) + Math.abs(normalAt40.actor.y - normalStart.actor.y) > 8,
      "normal middle actor bounds must expose the in-flight actor projection");
    const normalHud = hudButton(frame);

    frame = await normalSession.frame();
    const normalAt41 = visualState(frame, "normal comparison sample");
    frame = await normalSession.settle(frame, 90);
    const normalEnd = visualState(frame, "normal endpoint");
    const normalEndData = diagnostic(frame);
    assertCanonicalSave(normalEndData, "normal endpoint");
    assert.ok(normalEndData.canonical[0] === reducedTargetCamera.x && normalEndData.canonical[2] === reducedTargetCamera.scale,
      `natural timeline endpoint must reach the authored camera target; ${JSON.stringify(normalEndData)}`);
    assert.ok(normalEndData.canonical[3] === 202 && normalEndData.canonical[4] === 152,
      `natural timeline endpoint must reach the authored actor target; ${JSON.stringify(normalEndData)}`);
    const normalAudio = audioPlayAssets(normalSession);
    assert.ok(normalAudio.includes("audio/music.wav"), "timeline music must reach the real native host request boundary");
    assert.ok(normalAudio.includes("audio/footstep.wav"), "the crossing cue must reach the real native host request boundary");
    assert.ok(normalAudio.includes("audio/arrival.wav"), "the later cue must continue to its native host request");
    const normalVolumes = musicVolumes(normalSession);
    assert.ok(normalVolumes.some(value => value > 0.65), `initial music gain must reach the real host adapter: ${normalVolumes}`);
    assert.ok(normalVolumes.some(value => value < 0.5), `timeline music gain must ramp through real host volume requests: ${normalVolumes}`);
    evidence.normal = {
      elapsedAtStart: normalStartData.elapsedMs,
      elapsedAtMiddle: normalAt40Data.elapsedMs,
      middlePose: normalAt40Data.canonical,
      endpointPose: normalEndData.canonical,
      hud: normalHud,
      audioAssets: normalAudio,
      musicVolumes: { count: normalVolumes.length, first: normalVolumes[0], last: normalVolumes.at(-1) },
    };
    await normalSession.quit();
    normalSession = undefined;

    reducedSession = new NativeSession(artifacts, { ...viewport, deadlineMs: 180_000 });
    frame = await bootStory(reducedSession, true);
    const reducedStart = visualState(frame, "reduced initial endpoint projection");
    const reducedStartData = diagnostic(frame);
    assert.equal(reducedStartData.reduceMotion, true, "official host preference event must enable reduced motion");
    assert.ok(reducedStartData.elapsedMs >= 0 && reducedStartData.elapsedMs < 64,
      `reduced session should begin with the timeline cursor at its start; ${JSON.stringify(reducedStartData)}`);
    assertCanonicalSave(reducedStartData, "reduced start");
    assert.ok(reducedStartData.canonical[0] === 0 && reducedStartData.canonical[2] === 1,
      "canonical timeline state must remain at the authored starting camera pose");
    assert.ok(reducedStartData.displayed[0] === reducedTargetCamera.x && reducedStartData.displayed[2] === reducedTargetCamera.scale,
      "reduced-motion display data must project the final camera pose without changing canonical state");
    assert.ok(reducedStartData.displayed[3] === 202 && reducedStartData.displayed[4] === 152,
      "reduced-motion display data must project the final actor pose without changing canonical state");
    assertVisualClose(reducedStart, normalEnd, "reduced motion from start must draw the natural timeline endpoint");
    const reducedHudStart = hudButton(frame);

    frame = await reducedSession.settle(frame, 40);
    const reducedStable = visualState(frame, "reduced stable endpoint projection");
    const reducedAt40Data = diagnostic(frame);
    assert.ok(reducedAt40Data.elapsedMs > reducedStartData.elapsedMs + 500,
      "canonical timeline elapsed time must keep advancing while reduced-motion art is projected to its endpoint");
    assertCanonicalSave(reducedAt40Data, "reduced stable frames");
    assertPoseClose(reducedAt40Data.displayed, normalEndData.canonical, "reduced display stays at the final pose");
    assertVisualClose(reducedStable, reducedStart, "reduced endpoint projection must remain stable across native frames");
    assert.deepEqual(audioPlayAssets(reducedSession).slice(0, 2), ["audio/music.wav", "audio/footstep.wav"],
      "reduced motion must not stop or duplicate canonical timeline audio cues");

    reducedSession.sendEvent("accessibility.preferences", {
      reduceMotion: false,
      increaseContrast: false,
      textScale: 1,
      accessibleNavigation: false,
      reduceTransparency: null,
    });
    frame = await reducedSession.frame();
    const normalAgain = visualState(frame, "runtime reduce-motion disabled");
    const normalAgainData = diagnostic(frame);
    assert.equal(normalAgainData.reduceMotion, false, "the accessibility provider must adopt the host fact while running");
    assertCanonicalSave(normalAgainData, "runtime reduce-motion disabled");
    assertPoseClose(normalAgainData.displayed, normalAgainData.canonical,
      "turning reduce-motion off must immediately restore the current canonical sample");
    assertVisualClose(normalAgain, normalAt41, "turning reduce-motion off must draw the matching in-flight canonical frame");
    assert.ok(Math.abs(normalAgain.actor.x - reducedStable.actor.x) + Math.abs(normalAgain.actor.y - reducedStable.actor.y) > 8,
      "disabling reduce-motion must leave the projected endpoint and return to current actor motion");

    reducedSession.sendEvent("accessibility.preferences", {
      reduceMotion: true,
      increaseContrast: false,
      textScale: 1,
      accessibleNavigation: false,
      reduceTransparency: null,
    });
    frame = await reducedSession.frame();
    const endpointAgain = visualState(frame, "runtime reduce-motion enabled again");
    const endpointAgainData = diagnostic(frame);
    assert.equal(endpointAgainData.reduceMotion, true, "the accessibility provider must adopt a second live host fact");
    assertCanonicalSave(endpointAgainData, "runtime reduce-motion enabled again");
    assertPoseClose(endpointAgainData.displayed, normalEndData.canonical,
      "turning reduce-motion on again must restore the final display projection");
    assertVisualClose(endpointAgain, normalEnd, "turning reduce-motion on again must draw the same final native art");
    const hudAfterProjection = hudButton(frame);
    for (const key of ["x", "y", "w", "h"] as const) {
      assert.ok(Math.abs(hudAfterProjection[key] - reducedHudStart[key]) < 1,
        `the real NovelView HUD ${key} must remain fixed outside stage projection`);
    }

    const hudPoint = center((frame.ops ?? []).find(item => item.type === "text" && item.text === "手札")!, "projected-stage HUD");
    frame = await reducedSession.tapPoint(hudPoint);
    assert.ok(textOf(frame).includes("旅途手札"), `native pointer input at the projected-stage HUD must open the real menu; ${textOf(frame)}`);
    frame = await reducedSession.tap("继续阅读", frame);
    frame = await waitForText(reducedSession, frame, "The timeline is in motion.");
    frame = await reducedSession.tap("The timeline is in motion.", frame);
    frame = await waitForText(reducedSession, frame, "Choose the projected route.");
    const choiceData = diagnostic(frame);
    assert.equal(choiceData.reduceMotion, true, "the route choice must be projected under the real reduce-motion provider");
    assertCanonicalSave(choiceData, "while the stage choice is open");

    const selectedPoint = routePoint(frame, "east");
    frame = await reducedSession.tapPoint(selectedPoint);
    frame = await waitForText(reducedSession, frame, "Projected route selected.");
    const selectedData = diagnostic(frame);
    assertCanonicalSave(selectedData, "after native pointer selects a projected stage choice");
    const reducedAudio = audioPlayAssets(reducedSession);
    const reducedVolumes = musicVolumes(reducedSession);
    assert.ok(reducedVolumes.some(value => value < 0.5), `reduced-motion gain must still reach the host adapter: ${reducedVolumes}`);

    evidence.reducedMotion = {
      elapsedAtStart: reducedStartData.elapsedMs,
      elapsedAfterStableFrames: reducedAt40Data.elapsedMs,
      elapsedAfterLiveSwitch: normalAgainData.elapsedMs,
      elapsedAtChoice: choiceData.elapsedMs,
      initialPose: reducedStartData.canonical,
      savedPoseAtChoice: choiceData.saved,
      finalDisplayedPose: endpointAgainData.displayed,
      hudStart: reducedHudStart,
      hudAfterProjection,
      audioAssets: reducedAudio,
      musicVolumes: { count: reducedVolumes.length, first: reducedVolumes[0], last: reducedVolumes.at(-1) },
      selectedChoice: "east",
      selectedPoint,
    };
    evidence.outcome = "passed";
    writeFileSync(qaResultPath, JSON.stringify(evidence, null, 2) + "\n");
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    writeFileSync(qaResultPath, JSON.stringify(evidence, null, 2) + "\n");
    throw error;
  } finally {
    if (normalSession) await normalSession.quit();
    if (reducedSession) await reducedSession.quit();
    rmSync(project, { recursive: true, force: true });
  }
});
