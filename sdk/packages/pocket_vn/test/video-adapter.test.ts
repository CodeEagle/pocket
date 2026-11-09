import { expect, test } from "bun:test";
import type { HostEvent, JsonObject } from "@pocket/ui/host";
import { createNovelEngine } from "../src/engine.ts";
import "./clock-test-fixture.ts";
import type { StoryDefinition } from "../src/types.ts";

const { createNovelVideoAdapter } = await import("../src/video.ts");

const story: StoryDefinition = {
  id: "video-adapter-test",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "video", action: "play", cue: "clip", loop: false },
      { type: "say", id: "intro", text: "The saved video remains part of the stage." },
      { type: "ending", id: "done" },
    ],
  },
};

function fakeVideoHost() {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const listeners = new Set<(event: HostEvent) => void>();
  let token: string | null = null;
  let loop = true;
  let positionMs = 0;
  let durationMs = 3_000;
  let state = "ready";
  let requestDelay: ((run: () => void) => void) = run => queueMicrotask(run);
  const push = (method: string, params: JsonObject): void => {
    const event: HostEvent = { id: method, method, params, raw: { type: "event", name: method, payload: params } };
    for (const listener of [...listeners]) listener(event);
  };
  const item = (requestId?: string) => ({
    id: "adapter-test-video",
    token,
    asset: "assets/video/clip.mp4",
    state,
    playing: state === "playing",
    visible: true,
    active: true,
    positionMs,
    durationMs,
    error: null,
    ...(requestId ? { requestId } : {}),
  });
  const host = {
    emit(method: string, params: JsonObject = {}): boolean {
      calls.push({ method, params });
      if (method === "video.configure") {
        token = typeof params.token === "string" ? params.token : null;
        loop = params.loop === true;
      } else if (method === "video.play") state = "playing";
      else if (method === "video.pause") state = "paused";
      else if (method === "video.seek") {
        positionMs = Number(params.positionMs);
        state = positionMs === durationMs ? "paused" : state;
      } else if (method === "video.inspect" || method === "video.seek") {
        const requestId = String(params.requestId);
        requestDelay(() => push("video.snapshot", {
          id: "adapter-test-video",
          token: typeof params.token === "string" ? params.token : token,
          requestId,
          items: [item(requestId)],
        }));
      }
      if (method === "video.seek") {
        const requestId = String(params.requestId);
        requestDelay(() => push("video.snapshot", {
          id: "adapter-test-video",
          token: typeof params.token === "string" ? params.token : token,
          requestId,
          items: [item(requestId)],
        }));
      }
      return true;
    },
    onEvent(listener: (event: HostEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    host,
    calls,
    pushState(nextState: string, position = positionMs, duration = durationMs, eventToken: string | null = token): void {
      state = nextState;
      positionMs = position;
      durationMs = duration;
      push("video.state", {
        id: "adapter-test-video", token: eventToken, asset: "assets/video/clip.mp4", state: nextState,
        playing: nextState === "playing", visible: true, active: true, positionMs, durationMs, error: null,
      });
    },
    setRequestDelay(delay: (run: () => void) => void): void { requestDelay = delay; },
    get positionMs(): number { return positionMs; },
    get token(): string | null { return token; },
    get loop(): boolean { return loop; },
  };
}

test("VN adapter restores from native readiness, serializes seek, and captures same-engine native facts", async () => {
  const bridge = fakeVideoHost();
  const engine = createNovelEngine(story);
  engine.start();
  const adapter = createNovelVideoAdapter(bridge.host, {
    id: "adapter-test-video",
    scheduleTimeoutMs: () => () => {},
  });
  const errors: unknown[] = [];
  const unbind = adapter.bind(engine, error => errors.push(error));
  adapter.media.register(adapter.surfaceId, {
    token: engine.getSnapshot().videoToken!, loop: false, playing: true,
  });
  bridge.pushState("ready", 0, 3_000, engine.getSnapshot().videoToken);
  const initialSave = await adapter.captureForSave(engine, () => true);
  expect(initialSave.state.stage.video).toMatchObject({ positionMs: 0, durationMs: 3_000 });
  expect(bridge.calls.some(call => call.method === "video.play")).toBe(true);
  expect(engine.getSnapshot().stage.video).toMatchObject({ cue: "clip", durationMs: 3_000, status: "playing" });

  const previousToken = engine.getSnapshot().videoToken;
  await adapter.seekTo(engine, 1_250, () => true);
  expect(bridge.positionMs).toBe(1_250);
  expect(engine.getSnapshot().stage.video).toMatchObject({ positionMs: 1_250, durationMs: 3_000, status: "playing" });
  expect(engine.getSnapshot().videoToken).not.toBe(previousToken);
  expect(bridge.token).toBe(engine.getSnapshot().videoToken);

  const saved = await adapter.captureForSave(engine, () => true);
  expect(saved.state.stage.video).toMatchObject({ positionMs: 1_250, durationMs: 3_000, status: "playing" });
  expect(bridge.calls.filter(call => call.method === "video.inspect").length).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
  unbind();
  adapter.dispose();
  engine.dispose();
});

test("adapter drops stale native facts and rejects an in-flight capture after engine replacement", async () => {
  const bridge = fakeVideoHost();
  const engine = createNovelEngine(story);
  engine.start();
  const adapter = createNovelVideoAdapter(bridge.host, {
    id: "adapter-test-video",
    scheduleTimeoutMs: () => () => {},
  });
  const unbind = adapter.bind(engine);
  adapter.media.register(adapter.surfaceId, {
    token: engine.getSnapshot().videoToken!, loop: false, playing: true,
  });
  bridge.pushState("ready", 0, 3_000, engine.getSnapshot().videoToken);

  let releaseSnapshot!: () => void;
  bridge.setRequestDelay(run => { releaseSnapshot = run; });
  const capture = adapter.captureForSave(engine, () => true);
  await Promise.resolve();
  await Promise.resolve();
  expect(bridge.calls.some(call => call.method === "video.inspect")).toBe(true);

  const replacement = createNovelEngine(story);
  replacement.start();
  const removeOldBinding = unbind;
  removeOldBinding();
  adapter.bind(replacement);
  releaseSnapshot();
  await expect(capture).rejects.toThrow(/changed|stale/i);

  const oldToken = engine.getSnapshot().videoToken!;
  const before = replacement.getSnapshot();
  bridge.pushState("ended", 3_000, 3_000, oldToken);
  expect(replacement.getSnapshot()).toEqual(before);
  adapter.dispose();
  engine.dispose();
  replacement.dispose();
});

test("a failed old-token seek cannot poison capture for a later token", async () => {
  const bridge = fakeVideoHost();
  const engine = createNovelEngine(story);
  engine.start();
  const adapter = createNovelVideoAdapter(bridge.host, {
    id: "adapter-test-video",
    scheduleTimeoutMs: () => () => {},
  });
  const errors: unknown[] = [];
  const unbind = adapter.bind(engine, error => errors.push(error));
  adapter.media.register(adapter.surfaceId, {
    token: engine.getSnapshot().videoToken!, loop: false, playing: true,
  });
  bridge.pushState("ready", 0, 3_000, engine.getSnapshot().videoToken);
  await adapter.captureForSave(engine, () => true);

  let staleRequest: (() => void) | undefined;
  bridge.setRequestDelay(run => { staleRequest = run; });
  const seek = engine.controlVideo({ type: "video", action: "seek", positionMs: 500 });
  expect(seek.snapshot.videoToken).not.toBeNull();
  engine.controlVideo({ type: "video", action: "pause" });
  bridge.setRequestDelay(run => queueMicrotask(run));
  const currentToken = engine.getSnapshot().videoToken;
  expect(currentToken).not.toBe(seek.snapshot.videoToken);
  const saved = await adapter.captureForSave(engine, () => true);
  staleRequest?.();
  expect(saved.state.stage.video).toMatchObject({ status: "paused", durationMs: 3_000 });
  expect(errors).toEqual([]);
  unbind();
  adapter.dispose();
  engine.dispose();
});

test("position restore waits only to the guest-clock deadline and releases on disposal", async () => {
  const bridge = fakeVideoHost();
  const engine = createNovelEngine(story);
  engine.start();
  const deadlines: Array<() => void> = [];
  const adapter = createNovelVideoAdapter(bridge.host, {
    id: "adapter-test-video",
    scheduleTimeoutMs: (_timeoutMs, callback) => { deadlines.push(callback); return () => {}; },
  });
  const unbind = adapter.bind(engine);
  const capture = adapter.captureForSave(engine, () => true);
  await Promise.resolve();
  expect(deadlines.length).toBe(1);
  deadlines[0]!();
  await expect(capture).rejects.toThrow(/timed out/i);
  unbind();
  adapter.dispose();
  engine.dispose();
});
