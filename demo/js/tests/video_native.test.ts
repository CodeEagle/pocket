import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { resolveNativeProbePath } from "../../../sdk/scripts/native_probe_path.ts";

type JsonObject = Record<string, unknown>;
type FrameEvent = { name?: string; payload?: JsonObject };
type DrawOp = { type?: string; id?: string; asset?: string; fit?: string; autoplay?: boolean; text?: string; x?: number; y?: number; w?: number; h?: number };
type Frame = { events?: FrameEvent[]; ops?: DrawOp[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");
const TEST_TIMEOUT_MS = 150_000;

function probePath(): string {
  return resolveNativeProbePath(sdkRoot);
}

function event(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => response.frame ? [response.frame] : []);
}

function runProbe(probe: string, commands: readonly JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function labelCenter(frame: Frame, label: string): { x: number; y: number } {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `fixture frame is missing button ${label}`);
  assert.equal(typeof op.x, "number");
  assert.equal(typeof op.y, "number");
  assert.equal(typeof op.w, "number");
  assert.equal(typeof op.h, "number");
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function tap(commands: JsonObject[], frame: Frame, label: string): void {
  const point = labelCenter(frame, label);
  commands.push(
    event("input.pointer", { phase: "down", id: 0, x: point.x, y: point.y }),
    { op: "frame", deltaMs: 16 },
    event("input.pointer", { phase: "up", id: 0, x: point.x, y: point.y }),
    { op: "frame", deltaMs: 16 },
  );
}

function videoOps(frame: Frame, id?: string): DrawOp[] {
  return (frame.ops ?? []).filter((op) => op.type === "video" && (id === undefined || op.id === id));
}

function videoEvents(frame: Frame): FrameEvent[] {
  return (frame.events ?? []).filter((item) =>
    item.name === "video.play" || item.name === "video.pause");
}

function releaseEvents(frame: Frame): FrameEvent[] {
  return (frame.events ?? []).filter((item) => item.name === "video.release");
}

function videoEventKey(item: FrameEvent): string {
  return `${item.name}:${String(item.payload?.id ?? "")}`;
}

/**
 * This fixture deliberately uses the public Video + platform bridge in a
 * bytecode guest. It validates retained surface ops and command ordering; it
 * does not claim that pocket_probe decodes an MP4 or advances native position.
 */
test("bytecode Video fixture emits real surface ops and lifecycle commands", async () => {
  const probe = probePath();
  assert.ok(probe, "Build pocket_probe or set POCKET_NATIVE_PROBE");
  const project = mkdtempSync(join(tmpdir(), "pocket-video-native-"));
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-video-native-fixture",
      private: true,
      type: "module",
      dependencies: { "@pocket/ui": `file:${join(repositoryRoot, "sdk/packages/pocket_ui")}` },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.video-fixture",
      version: "0.1.0",
      app: {
        entry: "app.tsx",
        output: "video-fixture",
        framework: "solid",
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `
import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MOBILE_THEME_LIGHT,
  MobileButton,
  MobileScaffold,
  MobileThemeProvider,
  Video,
} from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";

const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host });
const media = platform.media!;
media.setCurrentPage("video");

function VideoFixture() {
  const [heroPlaying, setHeroPlaying] = createSignal(false);
  const [feedAPlaying, setFeedAPlaying] = createSignal(false);
  const [feedBPlaying, setFeedBPlaying] = createSignal(false);
  const [swapPlaying, setSwapPlaying] = createSignal(false);
  const [showHero, setShowHero] = createSignal(true);
  const [heroFit, setHeroFit] = createSignal("cover");
  const [swapAsset, setSwapAsset] = createSignal("assets/videos/clip-a.mp4");
  const [retryAsset, setRetryAsset] = createSignal("assets/videos/missing-video.mp4");
  const [status, setStatus] = createSignal("ready");

  const openCoverage = () => {
    setStatus("coverage");
    void platform.openApp("fixture.child").then(() => setStatus("returned"), () => setStatus("failed"));
  };
  host.onEvent((incoming) => {
    if (incoming.method !== "fixture.command") return;
    if (incoming.params.action === "other-page") media.setCurrentPage("other");
    if (incoming.params.action === "video-page") media.setCurrentPage("video");
  });

  return (
    <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
      <MobileScaffold class="flex-col w-full">
        <View class="flex-col gap-2 p-4">
          <Text>Video fixture · {status()}</Text>
          <Show when={showHero()} fallback={<View class="w-full h-[56] items-center justify-center"><Text>Hero Video disposed</Text></View>}>
            <Video id="video-lab-hero" asset="assets/videos/clip-a.mp4" media={media} page="video" active={true} playing={heroPlaying()} fit={heroFit()} class="w-full h-[56]" />
          </Show>
          <Video id="video-lab-feed-a" asset="assets/videos/clip-a.mp4" media={media} page="video" group="fixture-feed" active={true} playing={feedAPlaying()} fit="cover" class="w-full h-[56]" />
          <Video id="video-lab-feed-b" asset="assets/videos/clip-b.mp4" media={media} page="video" group="fixture-feed" active={true} playing={feedBPlaying()} fit="cover" class="w-full h-[56]" />
          <Video id="video-lab-same-id" asset={swapAsset()} media={media} page="video" active={true} playing={swapPlaying()} fit="cover" class="w-full h-[56]" />
          <Video id="video-lab-retry" asset={retryAsset()} media={media} page="video" active={true} playing={false} fit="cover" class="w-full h-[56]" />
          <View class="flex-row flex-wrap gap-2">
            <MobileButton label="Play hero" onPress={() => setHeroPlaying(true)} compact />
            <MobileButton label="Pause hero" onPress={() => setHeroPlaying(false)} compact />
            <MobileButton label="Play feed A" onPress={() => { setFeedAPlaying(true); setFeedBPlaying(false); }} compact />
            <MobileButton label="Play feed B" onPress={() => { setFeedAPlaying(false); setFeedBPlaying(true); }} compact />
            <MobileButton label="Swap same id" onPress={() => setSwapAsset("assets/videos/clip-b.mp4")} compact />
            <MobileButton label="Play same id" onPress={() => setSwapPlaying(true)} compact />
            <MobileButton label="Pause same id" onPress={() => setSwapPlaying(false)} compact />
            <MobileButton label="Remove Video" onPress={() => setShowHero(false)} compact />
            <MobileButton label="Rebuild Video" onPress={() => setShowHero(true)} compact />
            <MobileButton label="Retry with clip A" onPress={() => setRetryAsset("assets/videos/clip-a.mp4")} compact />
            <MobileButton label="Cover fit" onPress={() => setHeroFit("cover")} compact />
            <MobileButton label="Contain fit" onPress={() => setHeroFit("contain")} compact />
            <MobileButton label="Fill fit" onPress={() => setHeroFit("fill")} compact />
            <MobileButton label="Open coverage" onPress={openCoverage} compact />
          </View>
        </View>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}

mount(VideoFixture);
`);

    const output = join(project, "out");
    const built = await buildGuest({ projectRoot: project, outDir: output });
    assert.ok(existsSync(built.bytecode) && existsSync(built.pak), "fixture bytecode and PAK must be built");

    const base = [
      { op: "create", width: 360, height: 640 },
      { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
    ] satisfies JsonObject[];
    const initialResponses = runProbe(probe!, [...base, { op: "quit" }]);
    for (const response of initialResponses) assert.notEqual(response.ok, false, response.error ?? "initial fixture probe failed");
    const initial = framesOf(initialResponses).at(-1);
    assert.ok(initial, "initial fixture must return a settled frame");
    assert.ok(videoOps(initial, "video-lab-hero").length > 0, "initial frame must retain hero video surface");
    assert.ok(videoOps(initial, "video-lab-feed-a").length > 0, "initial frame must retain feed A video surface");
    assert.ok(videoOps(initial, "video-lab-feed-b").length > 0, "initial frame must retain feed B video surface");
    assert.ok(videoOps(initial, "video-lab-same-id").some((op) => op.asset === "assets/videos/clip-a.mp4"));
    assert.ok(videoOps(initial, "video-lab-retry").some((op) => op.asset === "assets/videos/missing-video.mp4"));
    assert.ok(videoOps(initial, "video-lab-hero").some((op) => op.fit === "cover"), "hero starts with cover fit");
    for (const op of videoOps(initial)) {
      assert.equal(op.autoplay, false, `JS-managed video ${String(op.id)} must disable native autoplay`);
    }

    const openDiscovery = [...base];
    tap(openDiscovery, initial, "Open coverage");
    openDiscovery.push({ op: "quit" });
    const discovered = runProbe(probe!, openDiscovery);
    const openRequest = framesOf(discovered)
      .flatMap((frame) => frame.events ?? [])
      .find((item) => item.name === "host.request" && item.payload?.capability === "platform.apps.open");
    assert.equal(typeof openRequest?.payload?.requestId, "string", "coverage button must emit platform.apps.open");
    const openRequestId = openRequest!.payload!.requestId as string;

    const commands = [...base];
    tap(commands, initial, "Play hero");
    tap(commands, initial, "Play feed A");
    tap(commands, initial, "Play feed B");
    tap(commands, initial, "Play same id");
    tap(commands, initial, "Pause same id");
    tap(commands, initial, "Swap same id");
    tap(commands, initial, "Remove Video");
    tap(commands, initial, "Rebuild Video");
    tap(commands, initial, "Retry with clip A");
    tap(commands, initial, "Cover fit");
    tap(commands, initial, "Contain fit");
    tap(commands, initial, "Fill fit");
    tap(commands, initial, "Play hero");
    tap(commands, initial, "Open coverage");
    commands.push(
      event("host.response", {
        requestId: openRequestId,
        capability: "platform.apps.open",
        ok: true,
        result: { requestId: "fixture-launch" },
      }),
      { op: "frame", deltaMs: 16 },
      event("platform.result", { requestId: "fixture-launch", appId: "fixture.child", cancelled: false, value: null }),
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    );
    const responses = runProbe(probe!, commands);
    for (const response of responses) assert.notEqual(response.ok, false, response.error ?? "video fixture probe failed");
    const frames = framesOf(responses);
    const allEvents = frames.flatMap((frame) => videoEvents(frame).map(videoEventKey));
    assert.ok(allEvents.includes("video.play:video-lab-hero"), "Play hero must emit video.play through the native event lane");
    assert.ok(allEvents.includes("video.pause:video-lab-hero"), "pause/dispose/coverage must emit video.pause through the native event lane");
    assert.ok(allEvents.includes("video.play:video-lab-same-id"), "same-id Play must emit video.play");
    assert.ok(allEvents.includes("video.pause:video-lab-same-id"), "same-id Pause must emit video.pause before asset replacement");
    const releaseEventsSeen = frames.flatMap((frame) => releaseEvents(frame).map(videoEventKey));
    assert.ok(
      releaseEventsSeen.includes("video.release:video-lab-hero"),
      "disposing the hero registration must emit video.release",
    );
    assert.ok(
      frames.some((frame) => {
        const keys = videoEvents(frame).map(videoEventKey);
        return keys.includes("video.pause:video-lab-feed-a") && keys.includes("video.play:video-lab-feed-b");
      }),
      "feed B selection must pause feed A before playing feed B",
    );
    assert.ok(
      frames.some((frame) => videoOps(frame, "video-lab-same-id").some((op) => op.asset === "assets/videos/clip-b.mp4")),
      "same-id asset swap must update the retained video FrameOp",
    );
    const disposed = frames.find((frame) => (frame.ops ?? []).some((op) => op.type === "text" && op.text === "Hero Video disposed"));
    assert.ok(disposed, "Remove Video must render the disposal state");
    assert.equal(videoOps(disposed!, "video-lab-hero").length, 0, "removed hero must leave no video FrameOp");
    assert.ok(
      frames.some((frame) => videoOps(frame, "video-lab-retry").some((op) => op.asset === "assets/videos/clip-a.mp4")),
      "retry must update the retained failing asset to clip A",
    );
    assert.ok(frames.some((frame) => videoOps(frame, "video-lab-hero").some((op) => op.fit === "contain")), "contain fit must reach the native surface op");
    assert.ok(frames.some((frame) => videoOps(frame, "video-lab-hero").some((op) => op.fit === "fill")), "fill fit must reach the native surface op");
    const openFrameIndex = frames.findIndex((frame) => (frame.events ?? []).some((item) =>
      item.name === "host.request" && item.payload?.capability === "platform.apps.open"));
    assert.ok(openFrameIndex >= 0, "coverage must produce a host request frame");
    const openFrame = frames[openFrameIndex]!;
    const openEvents = openFrame.events ?? [];
    const pauseIndex = openEvents.findIndex((item) => item.name === "video.pause" && item.payload?.id === "video-lab-hero");
    const requestIndex = openEvents.findIndex((item) => item.name === "host.request" && item.payload?.capability === "platform.apps.open");
    assert.ok(pauseIndex >= 0 && requestIndex > pauseIndex, "coverage must pause hero before platform.apps.open");
    assert.ok(
      frames.slice(openFrameIndex + 1).some((frame) => videoEvents(frame).some((item) => item.name === "video.play" && item.payload?.id === "video-lab-hero")),
      "platform.result must release coverage and restore the retained hero intent",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
