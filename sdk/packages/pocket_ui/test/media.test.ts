import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import type { HostBridge, HostEvent, JsonObject, JsonValue } from "../src/host.ts";
import { createMediaController, type MediaControllerOptions, type MediaLifecycleEvent } from "../src/media.ts";

class MediaBridge implements Pick<HostBridge, "emit" | "onEvent" | "scheduleTimeout"> {
  readonly sent: Array<{ method: string; params: JsonObject }> = [];
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly deadlines: Array<{ frames: number; callback: () => void; active: boolean }> = [];

  get listenerCount(): number { return this.listeners.size; }

  emit(method: string, params: JsonObject = {}): boolean {
    this.sent.push({ method, params });
    return true;
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  scheduleTimeout(frames: number, callback: () => void): () => void {
    const deadline = { frames, callback, active: true };
    this.deadlines.push(deadline);
    return () => { deadline.active = false; };
  }

  expireDeadlines(): void {
    for (const deadline of [...this.deadlines]) {
      if (!deadline.active) continue;
      deadline.active = false;
      deadline.callback();
    }
  }

  push(method: string, params: JsonObject): void {
    const event: HostEvent = { id: method, method, params, raw: params };
    for (const listener of [...this.listeners]) listener(event);
  }

  lifecycle(state: MediaLifecycleEvent["state"]): void {
    const params = { state } as JsonObject;
    const event: HostEvent = { id: "lifecycle", method: "platform.lifecycle", params, raw: params };
    for (const listener of [...this.listeners]) listener(event);
  }
}

function createTestMediaController(
  bridge: MediaBridge,
  options: Omit<MediaControllerOptions, "bridge" | "scheduleTimeoutMs"> = {},
) {
  return createMediaController({
    ...options,
    bridge,
    scheduleTimeoutMs: (timeoutMs, callback) => bridge.scheduleTimeout(Math.ceil(timeoutMs), callback),
  });
}

test("media lifecycle is idempotent and preserves explicit pause intent", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const video = media.register("home-video", { playing: true });
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play"]);

  bridge.lifecycle("onWillDisappear");
  bridge.lifecycle("onWillDisappear");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play", "video.pause"]);

  bridge.lifecycle("onResume");
  bridge.lifecycle("onDidAppear");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play", "video.pause", "video.play"]);

  video.pause();
  bridge.lifecycle("onWillDisappear");
  bridge.lifecycle("onResume");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play", "video.pause", "video.play", "video.pause"]);
  media.dispose();
});

test("playing while covered is remembered without leaking a background play", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const video = media.register("feed-a");
  bridge.lifecycle("frozenInStack");
  assert.equal(video.play(), true);
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause"]);
  bridge.lifecycle("onDidAppear");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play"]);
  video.dispose();
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play", "video.release"]);
  bridge.lifecycle("onResume");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play", "video.release"]);
  media.dispose();
});

test("feed group switching pauses the old item and does not restore it", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const first = media.register("feed-a", { group: "home-feed", playing: true });
  const second = media.register("feed-b", { group: "home-feed" });
  second.play();
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:feed-a",
    "video.pause:feed-b",
    "video.pause:feed-a",
    "video.play:feed-b",
  ]);
  bridge.lifecycle("onWillDisappear");
  bridge.lifecycle("onResume");
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:feed-a",
    "video.pause:feed-b",
    "video.pause:feed-a",
    "video.play:feed-b",
    "video.pause:feed-b",
    "video.play:feed-b",
  ]);
  first.dispose();
  second.dispose();
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:feed-a",
    "video.pause:feed-b",
    "video.pause:feed-a",
    "video.play:feed-b",
    "video.pause:feed-b",
    "video.play:feed-b",
    "video.release:feed-a",
    "video.release:feed-b",
  ]);
  media.dispose();
});

test("inactive group selection pauses peers but waits to play until active", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const current = media.register("visible", { group: "feed", playing: true });
  const hidden = media.register("hidden", { group: "feed", active: false });

  hidden.play();
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:visible",
    "video.pause:hidden",
    "video.pause:visible",
  ]);
  hidden.setActive(true);
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:visible",
    "video.pause:hidden",
    "video.pause:visible",
    "video.play:hidden",
  ]);
  current.dispose();
  hidden.dispose();
  media.dispose();
});

test("active/page gates pause and restore the retained user intent", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const video = media.register("detail-video", { page: "detail", playing: true });
  media.setCurrentPage("home");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause"]);
  media.setCurrentPage("detail");
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play"]);
  video.setActive(false);
  video.setActive(false);
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play", "video.pause"]);
  video.setActive(true);
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.pause", "video.play", "video.pause", "video.play"]);
  media.dispose();
});

test("release is idempotent and same-id re-register follows the release event", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  const first = media.register("same-id", { playing: false });
  first.dispose();
  first.dispose();
  const replacement = media.register("same-id", { playing: false });
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.pause:same-id",
    "video.release:same-id",
    "video.pause:same-id",
  ]);
  replacement.play();
  media.dispose();
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.pause:same-id",
    "video.release:same-id",
    "video.pause:same-id",
    "video.play:same-id",
    "video.release:same-id",
  ]);
});

test("token and loop configuration precede policy and preserve exclusive group ordering", () => {
  const bridge = new MediaBridge();
  const media = createMediaController({ bridge });
  media.register("group-current", { group: "group", playing: true });
  media.register("group-next", { group: "group", playing: true, token: "video-1-1", loop: false });
  assert.deepEqual(bridge.sent.map(({ method, params }) => `${method}:${params.id}`), [
    "video.play:group-current",
    "video.pause:group-current",
    "video.configure:group-next",
    "video.play:group-next",
  ]);
  assert.deepEqual(bridge.sent[2]?.params, { id: "group-next", token: "video-1-1", loop: false });
  assert.equal(bridge.sent[3]?.params.token, "video-1-1");
  media.dispose();
});

class PlatformBridge implements HostBridge {
  readonly sent: Array<{ method: string; params: JsonObject }> = [];
  cancelFailure = false;
  private readonly listeners = new Set<(event: HostEvent) => void>();

  get listenerCount(): number { return this.listeners.size; }

  request<T extends JsonValue = JsonValue>(capability: string): Promise<T> {
    if (capability === "platform.apps.open") return Promise.resolve({ requestId: "launch-1" } as T);
    if (capability === "platform.apps.cancel") {
      return this.cancelFailure
        ? Promise.reject(new Error("cancel rejected"))
        : Promise.resolve(null as T);
    }
    return Promise.resolve(null as T);
  }

  handle(): boolean { return false; }
  emit(method: string, params: JsonObject = {}): boolean {
    this.sent.push({ method, params });
    return true;
  }
  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  push(method: string, params: JsonObject): void {
    const event: HostEvent = { id: method, method, params, raw: params };
    for (const listener of [...this.listeners]) listener(event);
  }
  tick(): void {}
  dispose(): void {}
}

test("platform app launch covers the root media scope without stopping its runtime", async () => {
  mock.module("@pocketjs/framework/clock", () => ({
    after: (_seconds: number, _callback: () => void) => () => {},
    simulationHz: () => 60,
  }));
  const { createPocketPlatformClient } = await import("../src/platform.ts");
  const bridge = new PlatformBridge();
  const platform = createPocketPlatformClient(undefined, { bridge });
  const video = platform.media!.register("root-video", { playing: true });
  const launch = await platform.launchApp("mini-app");
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:root-video",
    "video.pause:root-video",
  ]);
  bridge.push("platform.result", {
    requestId: launch.requestId,
    appId: "mini-app",
    cancelled: false,
    value: null,
  });
  await launch.result;
  assert.deepEqual(bridge.sent.map((event) => `${event.method}:${event.params.id}`), [
    "video.play:root-video",
    "video.pause:root-video",
    "video.play:root-video",
  ]);
  video.dispose();
  platform.dispose();
});

test("launch cancel keeps coverage until the matching result, including RPC rejection", async () => {
  mock.module("@pocketjs/framework/clock", () => ({
    after: (_seconds: number, _callback: () => void) => () => {},
    simulationHz: () => 60,
  }));
  const { createPocketPlatformClient } = await import("../src/platform.ts");
  const bridge = new PlatformBridge();
  const platform = createPocketPlatformClient(undefined, { bridge });
  const video = platform.media!.register("root-video-cancel", { playing: true });

  const launch = await platform.launchApp("mini-app-cancel");
  await launch.cancel();
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play", "video.pause"]);
  bridge.push("platform.result", {
    requestId: launch.requestId,
    appId: "mini-app-cancel",
    cancelled: true,
    value: null,
  });
  await launch.result;
  assert.deepEqual(bridge.sent.map((event) => event.method), ["video.play", "video.pause", "video.play"]);
  video.dispose();
  platform.dispose();

  const rejectedBridge = new PlatformBridge();
  rejectedBridge.cancelFailure = true;
  const rejected = createPocketPlatformClient(undefined, { bridge: rejectedBridge });
  const rejectedVideo = rejected.media!.register("root-video-rejected", { playing: true });
  const rejectedLaunch = await rejected.launchApp("mini-app-rejected");
  await assert.rejects(rejectedLaunch.cancel(), /cancel rejected/);
  assert.deepEqual(rejectedBridge.sent.map((event) => event.method), ["video.play", "video.pause"]);
  rejectedBridge.push("platform.result", {
    requestId: rejectedLaunch.requestId,
    appId: "mini-app-rejected",
    cancelled: true,
    value: null,
  });
  await rejectedLaunch.result;
  assert.deepEqual(rejectedBridge.sent.map((event) => event.method), [
    "video.play",
    "video.pause",
    "video.play",
  ]);
  rejectedVideo.dispose();
  rejected.dispose();
});

function snapshotEvent(requestId: string, id: string, overrides: JsonObject = {}): JsonObject {
  return {
    requestId,
    controllers: 1,
    loading: 0,
    items: [{
      id,
      asset: "showcase/clip.mp4",
      state: "ready",
      playing: false,
      visible: true,
      active: true,
      positionMs: 125,
      durationMs: 2_000,
      ...overrides,
    }],
  };
}

test("video inspect correlates one real snapshot and ignores unrelated broadcasts", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge);
  media.register("clip-a");

  const inspected = media.inspect("clip-a");
  const request = bridge.sent.at(-1)!;
  assert.equal(request.method, "video.inspect");
  assert.equal(request.params.id, "clip-a");
  assert.equal(typeof request.params.requestId, "string");
  const requestId = request.params.requestId as string;

  let settled = false;
  void inspected.then(() => { settled = true; });
  bridge.push("video.snapshot", snapshotEvent("old-request", "clip-a", { positionMs: 700 }));
  bridge.push("video.snapshot", { ...snapshotEvent(requestId, "clip-a"), id: "another-video" });
  await Promise.resolve();
  assert.equal(settled, false, "an unrelated snapshot must not resolve this request");

  bridge.push("video.snapshot", snapshotEvent(requestId, "clip-a"));
  assert.deepEqual(await inspected, {
    id: "clip-a",
    token: null,
    asset: "showcase/clip.mp4",
    state: "ready",
    playing: false,
    visible: true,
    active: true,
    positionMs: 125,
    durationMs: 2_000,
    error: null,
  });
  media.dispose();
});

test("generation-scoped state, inspect, seek, and explicit replay ignore stale facts", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge);
  const registration = media.register("vn-video", { token: "video-3-1", loop: false });
  const ready: JsonObject = {
    id: "vn-video",
    token: "video-3-1",
    asset: "showcase/clip.mp4",
    state: "ready",
    playing: false,
    visible: true,
    active: true,
    positionMs: 0,
    durationMs: 2_000,
  };
  bridge.push("video.state", ready);

  const seeking = media.seek("vn-video", 2_000);
  const seekRequest = bridge.sent.at(-1)!;
  assert.equal(seekRequest.method, "video.seek");
  assert.equal(seekRequest.params.token, "video-3-1");
  bridge.push("video.snapshot", {
    requestId: seekRequest.params.requestId,
    id: "vn-video",
    token: "video-3-1",
    items: [{ ...ready, state: "paused", positionMs: 2_000 }],
  });
  const atEnd = await seeking;
  assert.equal(atEnd.state, "paused", "seek-to-duration remains a paused fact, not a completion fact");

  const beforeGates = bridge.sent.length;
  bridge.lifecycle("onWillDisappear");
  bridge.lifecycle("onResume");
  registration.setActive(false);
  registration.setActive(true);
  assert.equal(bridge.sent.slice(beforeGates).some((event) => event.method === "video.play"), false);

  registration.play();
  assert.deepEqual(bridge.sent.at(-1), {
    method: "video.play",
    params: { id: "vn-video", token: "video-3-1", restart: true },
  });
  bridge.push("video.state", { ...ready, token: "old-token", state: "ended", positionMs: 2_000 });
  assert.equal(registration.pause(), true, "stale completion must not have cleared current JS intent");
  assert.equal(bridge.sent.at(-1)?.method, "video.pause");

  media.configure("vn-video", { token: "video-3-2", loop: false, playing: true });
  assert.deepEqual(bridge.sent.slice(-2).map(({ method, params }) => [method, params.token]), [
    ["video.configure", "video-3-2"],
    ["video.play", "video-3-2"],
  ]);
  registration.dispose();
  media.dispose();
});

test("a token change cancels requests and stale-token snapshots cannot resolve them", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge);
  const registration = media.register("token-request", { token: "generation-a" });
  const inspect = media.inspect("token-request");
  const request = bridge.sent.at(-1)!;
  assert.equal(request.params.token, "generation-a");
  registration.setToken("generation-b");
  await assert.rejects(inspect, (error: Error & { code?: string }) => error.code === "video_token_changed");
  bridge.push("video.snapshot", {
    requestId: request.params.requestId,
    id: "token-request",
    token: "generation-a",
    items: [{ id: "token-request", token: "generation-a", state: "ready", positionMs: 0, durationMs: 2_000 }],
  });
  const next = media.inspect("token-request");
  const nextRequest = bridge.sent.at(-1)!;
  assert.equal(nextRequest.params.token, "generation-b");
  bridge.push("video.snapshot", {
    requestId: nextRequest.params.requestId,
    id: "token-request",
    token: "generation-a",
    items: [{ id: "token-request", token: "generation-a", state: "ready", positionMs: 0, durationMs: 2_000 }],
  });
  await assert.rejects(next, (error: Error & { code?: string }) => error.code === "stale_token");
  registration.dispose();
  media.dispose();
});

test("video seek is bounded by inspected duration and resolves only after native facts return", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge);
  media.register("clip-b");

  const inspect = media.inspect("clip-b");
  let request = bridge.sent.at(-1)!;
  bridge.push("video.snapshot", snapshotEvent(request.params.requestId as string, "clip-b"));
  await inspect;

  const beforeOutOfRange = bridge.sent.length;
  await assert.rejects(media.seek("clip-b", 2_001), RangeError);
  assert.equal(bridge.sent.length, beforeOutOfRange, "out-of-range seek must not reach native");

  const seeking = media.seek("clip-b", 900);
  request = bridge.sent.at(-1)!;
  assert.equal(request.method, "video.seek");
  assert.equal(request.params.id, "clip-b");
  assert.equal(request.params.positionMs, 900);
  const requestId = request.params.requestId as string;
  let settled = false;
  void seeking.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "a queued seek is not a successful seek yet");

  bridge.push("video.snapshot", snapshotEvent(requestId, "clip-b", { positionMs: 900 }));
  const result = await seeking;
  assert.equal(result.positionMs, 900);
  assert.equal(result.durationMs, 2_000);
  media.dispose();
});

test("video request rejects on release, timeout, malformed facts, and stale responses", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge, { requestTimeoutMs: 500 });
  const registration = media.register("clip-c");

  const releasedRequest = media.inspect("clip-c");
  const releasedId = bridge.sent.at(-1)!.params.requestId as string;
  registration.dispose();
  await assert.rejects(releasedRequest, (error: Error & { code?: string }) => error.code === "video_released");
  bridge.push("video.snapshot", snapshotEvent(releasedId, "clip-c"));

  const replacement = media.register("clip-c");
  const timedRequest = media.inspect("clip-c");
  const timedId = bridge.sent.at(-1)!.params.requestId as string;
  bridge.expireDeadlines();
  await assert.rejects(timedRequest, (error: Error & { code?: string }) => error.code === "timeout");
  bridge.push("video.snapshot", snapshotEvent(timedId, "clip-c"));

  const malformedRequest = media.inspect("clip-c");
  const malformedId = bridge.sent.at(-1)!.params.requestId as string;
  bridge.push("video.snapshot", snapshotEvent(malformedId, "clip-c", { positionMs: "125" }));
  await assert.rejects(malformedRequest, (error: Error & { code?: string }) => error.code === "invalid_snapshot");
  replacement.dispose();
  media.dispose();
});

test("video request quota is bounded and externally routed events use the same handler", async () => {
  const bridge = new MediaBridge();
  const media = createTestMediaController(bridge, { subscribeLifecycle: false });
  media.register("clip-routed");
  assert.equal(bridge.listenerCount, 0, "an owning event dispatcher should not gain a second listener");

  const requests = Array.from({ length: 16 }, () => media.inspect("clip-routed"));
  const inspectEvents = bridge.sent.filter((event) => event.method === "video.inspect");
  assert.equal(inspectEvents.length, 16);
  await assert.rejects(media.inspect("clip-routed"), (error: Error & { code?: string }) => error.code === "request_quota");
  assert.equal(bridge.sent.filter((event) => event.method === "video.inspect").length, 16);

  for (const [index, request] of inspectEvents.entries()) {
    const params = snapshotEvent(request.params.requestId as string, "clip-routed", { positionMs: index });
    const event: HostEvent = { id: "video.snapshot", method: "video.snapshot", params, raw: params };
    media.handleHostEvent(event);
  }
  const results = await Promise.all(requests);
  assert.deepEqual(results.map((snapshot) => snapshot.positionMs), Array.from({ length: 16 }, (_, index) => index));
  media.dispose();
});

test("platform reuses its one HostBridge listener to return video snapshots", async () => {
  mock.module("@pocketjs/framework/clock", () => ({
    after: (_seconds: number, _callback: () => void) => () => {},
    simulationHz: () => 60,
  }));
  const { createPocketPlatformClient } = await import("../src/platform.ts");
  const bridge = new PlatformBridge();
  const platform = createPocketPlatformClient(undefined, { bridge });
  assert.equal(bridge.listenerCount, 1, "platform and media must share the existing event listener");
  platform.media!.register("clip-platform");

  const inspected = platform.media!.inspect("clip-platform");
  const request = bridge.sent.at(-1)!;
  assert.equal(request.method, "video.inspect");
  bridge.push("video.snapshot", snapshotEvent(request.params.requestId as string, "clip-platform"));
  assert.equal((await inspected).positionMs, 125);

  platform.dispose();
  assert.equal(bridge.listenerCount, 0);
});
