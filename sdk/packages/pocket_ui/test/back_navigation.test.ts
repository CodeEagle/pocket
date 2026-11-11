import { test, expect } from "bun:test";
import {
  createPocketBackNavigation,
  shouldCommitPocketBackGesture,
} from "../src/back-navigation.ts";
import type { BridgeObject, HostEvent } from "../src/host.ts";

function harness() {
  let listener: ((event: HostEvent) => void) | undefined;
  const responses: { method: string; params?: BridgeObject }[] = [];
  const navigation = createPocketBackNavigation({
    onEvent(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    emit(method, params) {
      responses.push({ method, params });
      return true;
    },
  });
  return {
    navigation,
    responses,
    request(requestId: string) {
      listener?.({ method: "platform.back.request", params: { requestId } });
    },
    gesture(params: BridgeObject) {
      listener?.({ method: "platform.back.gesture", params });
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("back requests report consumption, unhandled requests and failures on the event lane", async () => {
  const h = harness();
  h.request("unregistered");
  await flush();
  let pages = ["root", "details"];
  h.navigation.setHandler(() => {
    if (pages.length === 1) return false;
    pages.pop();
    return true;
  });
  h.request("details");
  await flush();
  expect(pages).toEqual(["root"]);
  h.request("root");
  await flush();
  h.navigation.setHandler(async () => { throw new Error("page disposed"); });
  h.request("failed");
  await flush();
  expect(h.responses).toEqual([
    { method: "platform.back.response", params: { requestId: "unregistered", handled: false } },
    { method: "platform.back.response", params: { requestId: "details", handled: true } },
    { method: "platform.back.response", params: { requestId: "root", handled: false } },
    { method: "platform.back.response", params: { requestId: "failed", handled: false } },
  ]);
  h.navigation.dispose();
});

test("disposing a back handler suppresses a late response and removes its listener", async () => {
  const h = harness();
  let finish!: (value: boolean) => void;
  h.navigation.setHandler(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  h.request("pending");
  await flush();
  h.navigation.dispose();
  finish(true);
  h.request("after-dispose");
  await flush();
  expect(h.responses).toEqual([]);
});

test("back gestures synchronously negotiate start and gate later phases by handled gesture id", () => {
  const h = harness();
  const received: string[] = [];
  h.navigation.setGestureHandler((event) => {
    received.push(`${event.phase}:${event.gestureId}`);
    return event.phase === "start" && event.gestureId !== "declined";
  });
  const event = (gestureId: string, phase: string) => ({
    gestureId,
    phase,
    dx: phase === "start" ? 1 : 120,
    width: 390,
    velocity: 0,
    progress: phase === "start" ? 0 : 120 / 390,
  });

  h.gesture(event("first", "start"));
  expect(h.responses).toEqual([
    { method: "platform.back.gesture.ready", params: { ready: true } },
    {
      method: "platform.back.gesture.response",
      params: { gestureId: "first", handled: true },
    },
  ]);
  h.gesture(event("stale", "update"));
  h.gesture(event("first", "update"));
  h.gesture(event("declined", "start"));
  h.gesture(event("first", "end"));
  h.gesture(event("declined", "update"));

  expect(received).toEqual([
    "start:first",
    "update:first",
    "cancel:first",
    "start:declined",
  ]);
  expect(h.responses).toEqual([
    { method: "platform.back.gesture.ready", params: { ready: true } },
    {
      method: "platform.back.gesture.response",
      params: { gestureId: "first", handled: true },
    },
    {
      method: "platform.back.gesture.response",
      params: { gestureId: "declined", handled: false },
    },
  ]);
  h.navigation.dispose();
  expect(h.responses.at(-1)).toEqual({
    method: "platform.back.gesture.ready",
    params: { ready: false },
  });
});

test("replacing or disposing a gesture handler cancels its active gesture once", () => {
  const h = harness();
  const received: string[] = [];
  const handler = (event: { gestureId: string; phase: string }) => {
    received.push(`${event.phase}:${event.gestureId}`);
    return event.phase === "start";
  };
  h.navigation.setGestureHandler(handler);
  const start = {
    gestureId: "active",
    phase: "start",
    dx: 1,
    width: 390,
    velocity: 0,
    progress: 0,
  };
  h.gesture(start);
  h.navigation.setGestureHandler(undefined);
  h.navigation.dispose();
  expect(received).toEqual(["start:active", "cancel:active"]);
  expect(h.responses.filter((response) => response.method === "platform.back.gesture.ready")).toEqual([
    { method: "platform.back.gesture.ready", params: { ready: true } },
    { method: "platform.back.gesture.ready", params: { ready: false } },
  ]);
});

test("interactive back commits only past half-width using the latest end progress", () => {
  const gesture = (phase: "update" | "end" | "cancel", progress: number) => ({
    gestureId: "distance",
    phase,
    dx: progress * 390,
    width: 390,
    velocity: 2_000,
    progress,
  });
  expect(shouldCommitPocketBackGesture(gesture("end", 0.49))).toBe(false);
  expect(shouldCommitPocketBackGesture(gesture("end", 0.5))).toBe(false);
  expect(shouldCommitPocketBackGesture(gesture("end", 0.51))).toBe(true);
  expect(shouldCommitPocketBackGesture(gesture("update", 0.8))).toBe(false);
  expect(shouldCommitPocketBackGesture(gesture("end", 0.3))).toBe(false);
  expect(shouldCommitPocketBackGesture(gesture("cancel", 0.8))).toBe(false);
});
