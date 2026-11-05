import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import type { HostBridge, HostEvent, JsonObject, JsonValue } from "../src/host.ts";
import { createMediaController, type MediaLifecycleEvent } from "../src/media.ts";

class MediaBridge implements Pick<HostBridge, "emit" | "onEvent"> {
  readonly sent: Array<{ method: string; params: JsonObject }> = [];
  private readonly listeners = new Set<(event: HostEvent) => void>();

  emit(method: string, params: JsonObject = {}): boolean {
    this.sent.push({ method, params });
    return true;
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  lifecycle(state: MediaLifecycleEvent["state"]): void {
    const params = { state } as JsonObject;
    const event: HostEvent = { id: "lifecycle", method: "platform.lifecycle", params, raw: params };
    for (const listener of [...this.listeners]) listener(event);
  }
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

class PlatformBridge implements HostBridge {
  readonly sent: Array<{ method: string; params: JsonObject }> = [];
  cancelFailure = false;
  private readonly listeners = new Set<(event: HostEvent) => void>();

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
