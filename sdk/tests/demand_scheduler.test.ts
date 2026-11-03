import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "../.cache/pocketjs/node_modules/solid-js/dist/server.js";
import {
  __advanceClock,
  __skipIdleClockFrames,
  after,
  framesUntilNextTimer,
  resetClock,
  virtualFrame,
} from "../.cache/pocketjs/framework/src/clock.ts";
import { __drainEffects, installEffectDriver, resetEffects, runEffect } from "../.cache/pocketjs/framework/src/effects.ts";
import { onButtonPress, onFrame, resetFrameHooks, runFrameHooks } from "../.cache/pocketjs/framework/src/frame.ts";
import { hasPendingServiceWork, registerServicePump } from "../.cache/pocketjs/framework/src/services.ts";
import { getPocketWorkState, skipPocketIdleFrames } from "../.cache/pocketjs/framework/src/work-state.ts";
import { BTN } from "../.cache/pocketjs/contracts/spec/spec.ts";
import { ActionHandler, Text, View } from "../.cache/pocketjs/framework/src/components.ts";
import { render } from "../.cache/pocketjs/framework/src/index.ts";
import { createScroller } from "../.cache/pocketjs/framework/src/kinetics.ts";
import type { HostOps } from "../.cache/pocketjs/framework/src/host.ts";

function freshClock(): void {
  (globalThis as typeof globalThis & { __simHz?: number }).__simHz = 60;
  resetClock();
  __advanceClock(); // Establish virtual frame 0 before testing future deadlines.
}

describe("PocketJS demand scheduler", () => {
  test("a rendered static UI with input observers settles to event-driven work", () => {
    let nextId = 2;
    const noop = () => {};
    const ops: HostOps = {
      createNode: () => nextId++,
      destroyNode: noop,
      insertBefore: noop,
      removeChild: noop,
      setStyle: noop,
      setProp: noop,
      setText: noop,
      replaceText: noop,
      uploadTexture: () => 0,
      setImage: noop,
      setSprite: noop,
      animate: () => 1,
      cancelAnim: noop,
      setFocus: noop,
      measureText: () => 0,
    };
    const dispose = render(() => View({
      children: [
        Text({ children: "static" }),
        ActionHandler({ button: BTN.SELECT, onPress: () => {}, children: Text({ children: "button" }) }),
      ],
    }), { ops, styles: {} });

    expect(getPocketWorkState().continuous).toBe(false);
    const frame = (globalThis as typeof globalThis & { frame?: (buttons: number) => void }).frame;
    frame?.(0);
    expect(getPocketWorkState().continuous).toBe(false);
    dispose();
    expect(getPocketWorkState().continuous).toBe(false);
  });

  test("a static page reports no continuous work or timer", () => {
    resetFrameHooks();
    resetEffects();
    freshClock();

    expect(getPocketWorkState()).toEqual({
      version: 1,
      continuous: false,
      framesUntilTimer: null,
      simulationHz: 60,
    });
  });

  test("unannotated frame callbacks remain continuous until disposed", () => {
    resetFrameHooks();
    freshClock();
    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      onFrame(() => {});
    });

    expect(getPocketWorkState().continuous).toBe(true);
    disposeRoot?.();
    expect(getPocketWorkState().continuous).toBe(false);
  });

  test("many constant-passive observers still receive event frames without scheduler work", () => {
    resetFrameHooks();
    freshClock();
    let disposeRoot: (() => void) | undefined;
    let delivered = 0;
    createRoot((dispose) => {
      disposeRoot = dispose;
      for (let i = 0; i < 256; i++) {
        onFrame((buttons) => { delivered += buttons; }, { continuous: false });
      }
    });

    expect(getPocketWorkState().continuous).toBe(false);
    runFrameHooks(1);
    expect(delivered).toBe(256);
    expect(getPocketWorkState().continuous).toBe(false);
    disposeRoot?.();
  });

  test("skips only to the frame before the next deadline and preserves due order", () => {
    freshClock();
    const fired: string[] = [];
    after(3 / 60, () => fired.push("first"));
    after(3 / 60, () => fired.push("second"));
    after(2 / 60, () => fired.push("earlier"));

    expect(framesUntilNextTimer()).toBe(2);
    expect(__skipIdleClockFrames(100)).toBe(1);
    expect(virtualFrame()).toBe(1);
    expect(fired).toEqual([]);
    __advanceClock();
    expect(fired).toEqual(["earlier"]);
    expect(framesUntilNextTimer()).toBe(1);
    expect(__skipIdleClockFrames(8)).toBe(0);
    __advanceClock();
    expect(fired).toEqual(["earlier", "first", "second"]);
    expect(framesUntilNextTimer()).toBeNull();
  });

  test("cancelling the earliest timer recomputes the live deadline", () => {
    freshClock();
    let cancelledFired = false;
    let laterFired = false;
    const cancel = after(3 / 60, () => { cancelledFired = true; });
    after(6 / 60, () => { laterFired = true; });
    cancel();

    expect(framesUntilNextTimer()).toBe(6);
    expect(__skipIdleClockFrames(10_000)).toBe(5);
    expect(cancelledFired).toBe(false);
    expect(laterFired).toBe(false);
    __advanceClock();
    expect(laterFired).toBe(true);
  });

  test("long virtual deadlines fast-forward without running per-frame hooks", () => {
    freshClock();
    let fired = 0;
    after(600, () => { fired++; });

    expect(framesUntilNextTimer()).toBe(36_000);
    expect(__skipIdleClockFrames(100_000)).toBe(35_999);
    expect(fired).toBe(0);
    expect(framesUntilNextTimer()).toBe(1);
    __advanceClock();
    expect(fired).toBe(1);
    expect(virtualFrame()).toBe(36_000);
  });

  test("continuous hints react to state, while delivered frames still reach passive callbacks", () => {
    resetFrameHooks();
    freshClock();
    let disposeRoot: (() => void) | undefined;
    const observed: number[] = [];
    const root = createRoot((dispose) => {
      disposeRoot = dispose;
      const [moving, setMoving] = createSignal(false);
      onFrame((buttons) => observed.push(buttons), { continuous: () => moving() });
      return setMoving;
    });
    const setMoving = root as (value: boolean) => void;

    expect(getPocketWorkState().continuous).toBe(false);
    runFrameHooks(7);
    expect(observed).toEqual([7]);
    setMoving(true);
    expect(getPocketWorkState().continuous).toBe(true);
    runFrameHooks(3);
    expect(observed).toEqual([7, 3]);
    setMoving(false);
    expect(getPocketWorkState().continuous).toBe(false);
    disposeRoot?.();
    expect(getPocketWorkState().continuous).toBe(false);
  });

  test("kinetic scrolling keeps frames flowing only while it moves", () => {
    resetFrameHooks();
    freshClock();
    let disposeRoot: (() => void) | undefined;
    let scroller: ReturnType<typeof createScroller> | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      scroller = createScroller({ max: () => 200 });
      onFrame(() => scroller!.step(), { continuous: () => scroller!.state() !== "idle" });
    });
    expect(getPocketWorkState().continuous).toBe(false);

    scroller!.nudge(48);
    expect(getPocketWorkState().continuous).toBe(true);
    let frames = 0;
    while (scroller!.state() !== "idle" && frames < 200) {
      runFrameHooks(0);
      frames++;
    }
    expect(frames).toBeGreaterThan(0);
    expect(scroller!.state()).toBe("idle");
    expect(getPocketWorkState().continuous).toBe(false);
    disposeRoot?.();
  });

  test("button observers and completed async effects do not hold the loop open", () => {
    resetFrameHooks();
    resetEffects();
    freshClock();
    let pressed = 0;
    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      onButtonPress(1, () => { pressed++; });
    });
    expect(getPocketWorkState().continuous).toBe(false);
    runFrameHooks(1);
    expect(pressed).toBe(1);
    disposeRoot?.();

    let deliver: ((result: unknown) => void) | undefined;
    installEffectDriver((_command, resolve) => { deliver = resolve; });
    let result: unknown;
    runEffect("scheduler.test", {}, (value) => { result = value; });
    expect(getPocketWorkState().continuous).toBe(true);
    deliver?.("ready");
    expect(getPocketWorkState().continuous).toBe(true);
    __drainEffects();
    expect(result).toBe("ready");
    expect(getPocketWorkState().continuous).toBe(false);
  });

  test("active service pumps and unsafe skips refuse fast-forward", () => {
    freshClock();
    let active = true;
    const unregister = registerServicePump(() => {}, () => active);
    expect(hasPendingServiceWork()).toBe(true);
    expect(getPocketWorkState().continuous).toBe(true);
    const before = virtualFrame();
    expect(skipPocketIdleFrames(12)).toBe(0);
    expect(virtualFrame()).toBe(before);
    active = false;
    expect(hasPendingServiceWork()).toBe(false);
    expect(getPocketWorkState().continuous).toBe(false);
    unregister();
    expect(skipPocketIdleFrames(2)).toBe(2);
    expect(virtualFrame()).toBe(before + 2);
  });
});
