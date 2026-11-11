import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { NativeSession, readNativeArtifacts, textOf, textOps, type Frame } from "./native_session.ts";

test("native back events pop the real guest page before requesting container closure", { timeout: 30_000 }, async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_BACK"), {
    deferCapabilities: ["system.container.close"],
  });
  try {
    let frame = await session.boot();
    const visibleCard = (candidate: Frame) => textOps(candidate, "Mobile UI").find((op) =>
      (op.y ?? -1) >= Math.max(0, op.clip?.y ?? 0) &&
      (op.y ?? 0) + (op.h ?? 0) <= Math.min(700, (op.clip?.y ?? 0) + (op.clip?.h ?? 760)));
    for (let i = 0; !visibleCard(frame) && i < 5; i++) {
      frame = await session.settle(await session.drag({ x: 8, y: 350 }, { x: 8, y: 650 }, 12, 12));
    }
    assert.ok(visibleCard(frame), `Mobile UI must be reachable: ${textOf(frame)}`);
    frame = await session.settle(await session.tap("Mobile UI", frame, (op) => op === visibleCard(frame)));
    assert.match(textOf(frame), /Scaffold \+ AppBar/, "a native pointer tap must push the secondary page");
    session.sendEvent("platform.back.request", { requestId: "page-back" });
    frame = await session.settle(await session.frame(), 60);
    assert.match(textOf(frame), /Playground/, "a back event must paint the retained Home page");
    assert.doesNotMatch(textOf(frame), /Scaffold \+ AppBar/, "the secondary page must be popped");
    assert.equal(session.requests.filter((r) => r.capability === "system.container.close").length, 0,
      "returning from a secondary page must keep the container alive");
    session.sendEvent("platform.back.request", { requestId: "root-back" });
    frame = await session.settle(await session.frame(), 30);
    assert.equal(session.requests.filter((r) => r.capability === "system.container.close").length, 1,
      "a second back at the root must request one container close");
    session.respondPending("system.container.close", { closed: true });
    await session.settle(frame);
  } finally {
    await session.quit();
  }
});

test("native back gesture tracks retained pages, cancels cleanly, and commits once", { timeout: 30_000 }, async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_BACK"));
  try {
    let frame = await session.boot();
    const visibleCard = (candidate: Frame) => textOps(candidate, "Mobile UI").find((op) =>
      (op.y ?? -1) >= Math.max(0, op.clip?.y ?? 0) &&
      (op.y ?? 0) + (op.h ?? 0) <= Math.min(700, (op.y ?? 0) + (op.clip?.h ?? 760)));
    for (let i = 0; !visibleCard(frame) && i < 5; i++) {
      frame = await session.settle(await session.drag({ x: 8, y: 350 }, { x: 8, y: 650 }, 12, 12));
    }
    assert.ok(visibleCard(frame), "Mobile UI must be reachable: " + textOf(frame));
    frame = await session.settle(await session.tap("Mobile UI", frame, (op) => op === visibleCard(frame)), 30);
    assert.match(textOf(frame), /Scaffold \+ AppBar/, "the current route must be mounted before the gesture");

    const viewport = [frame.width, frame.height];
    const currentPageBefore = textOps(frame, "Scaffold + AppBar")[0]!;
    const currentBarBefore = textOps(frame, "Mobile UI").find((op) => (op.y ?? 999) < 60)!;
    const gestureWidth = frame.width ?? 360;
    session.sendEvent("platform.back.gesture", {
      gestureId: "back-cancel", phase: "start", dx: 0, width: gestureWidth, velocity: 0, progress: 0,
    });
    frame = await session.frame();
    const pageAtStart = textOps(frame, "Scaffold + AppBar")[0]!;
    assert.deepEqual([frame.width, frame.height], viewport, "starting a gesture must keep the native viewport unchanged");
    assert.equal(pageAtStart.y, currentPageBefore.y, "starting a gesture must not relayout the current page vertically");
    assert.equal(pageAtStart.clip?.h, currentPageBefore.clip?.h, "starting a gesture must preserve the current page viewport height");

    session.sendEvent("platform.back.gesture", {
      gestureId: "back-cancel", phase: "update", dx: gestureWidth * 0.5,
      width: gestureWidth, velocity: 0, progress: 0.5,
    });
    frame = await session.frame();
    const currentPageMid = textOps(frame, "Scaffold + AppBar")[0]!;
    const currentBarMid = textOps(frame, "Mobile UI").find((op) => (op.y ?? 999) < 60)!;
    assert.deepEqual([frame.width, frame.height], viewport, "dragging must keep the native viewport unchanged");
    assert.equal(currentPageMid.y, currentPageBefore.y, "dragging must keep the current page's vertical position");
    assert.equal(currentPageMid.clip?.h, currentPageBefore.clip?.h, "dragging must preserve the current page viewport height");
    assert.equal(currentBarMid.y, currentBarBefore.y, "the current AppBar must stay vertically fixed while it follows dx");
    assert.ok(
      Math.abs((currentPageMid.x ?? 0) - ((currentPageBefore.x ?? 0) + gestureWidth * 0.5)) <= 1,
      "current page must track half-width dx: before=" + currentPageBefore.x + ", mid=" + currentPageMid.x,
    );
    const underlayText = textOps(frame, "Playground")[0];
    const underlayBar = textOps(frame, "Pocket").find((op) => (op.y ?? 999) < 60);
    const revealsLeftText = (op: { x?: number; w?: number; y?: number; h?: number; clip?: { x?: number; y?: number; w?: number; h?: number } } | undefined) => {
      if (!op) return false;
      const left = Math.max(0, op.x ?? 0, op.clip?.x ?? 0);
      const right = Math.min(
        gestureWidth * 0.5,
        (op.x ?? 0) + (op.w ?? 0),
        (op.clip?.x ?? 0) + (op.clip?.w ?? gestureWidth),
      );
      const top = Math.max(0, op.y ?? 0, op.clip?.y ?? 0);
      const bottom = Math.min(
        frame.height ?? 640,
        (op.y ?? 0) + (op.h ?? 0),
        (op.clip?.y ?? 0) + (op.clip?.h ?? (frame.height ?? 640)),
      );
      return right > left && bottom > top;
    };
    assert.ok(revealsLeftText(underlayText), "the retained Home page must be painted in the revealed half of the frame");
    assert.ok(revealsLeftText(underlayBar), "the retained Home AppBar must be visible behind the current AppBar");
    assert.ok(
      textOps(frame, "UI").some((op) => (op.y ?? 0) >= (frame.height ?? 640) - 30),
      "the retained Home NavigationBar must remain in its page shell during the gesture",
    );

    session.sendEvent("platform.back.gesture", {
      gestureId: "back-cancel", phase: "cancel", dx: gestureWidth * 0.5,
      width: gestureWidth, velocity: 0, progress: 0.5,
    });
    frame = await session.settle(await session.frame(), 20);
    const currentPageAfterCancel = textOps(frame, "Scaffold + AppBar")[0]!;
    const currentBarAfterCancel = textOps(frame, "Mobile UI").find((op) => (op.y ?? 999) < 60)!;
    assert.equal(currentPageAfterCancel.y, currentPageBefore.y, "cancel must restore the same current page without vertical reflow");
    assert.equal(currentPageAfterCancel.clip?.h, currentPageBefore.clip?.h, "cancel must restore the same current page viewport height");
    assert.equal(currentPageAfterCancel.x, currentPageBefore.x, "cancel must settle the current page back to its original x");
    assert.equal(currentBarAfterCancel.x, currentBarBefore.x, "cancel must settle the current AppBar back to its original x");
    assert.doesNotMatch(textOf(frame), /Playground/, "cancel must leave the route stack unchanged");

    session.sendEvent("platform.back.gesture", {
      gestureId: "back-commit", phase: "start", dx: 0, width: gestureWidth, velocity: 0, progress: 0,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "back-commit", phase: "update", dx: gestureWidth * 0.65,
      width: gestureWidth, velocity: 0, progress: 0.65,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "back-commit", phase: "end", dx: gestureWidth * 0.65,
      width: gestureWidth, velocity: 0, progress: 0.65,
    });
    frame = await session.settle(await session.frame(), 20);
    assert.match(textOf(frame), /Playground/, "a completed gesture must expose the retained Home route");
    assert.doesNotMatch(textOf(frame), /Scaffold \+ AppBar/, "the current route must be popped after settle finishes");
    const homeAfterCommit = textOps(frame, "Playground")[0]!;
    assert.equal(homeAfterCommit.x, 32, "the completed route must settle at its normal destination x");

    // A duplicate terminal packet for the consumed gesture ID must not pop again.
    session.sendEvent("platform.back.gesture", {
      gestureId: "back-commit", phase: "end", dx: gestureWidth,
      width: gestureWidth, velocity: 900, progress: 1,
    });
    frame = await session.settle(await session.frame(), 4);
    assert.match(textOf(frame), /Playground/, "a repeated end packet must leave the single popped route at Home");
  } finally {
    await session.quit();
  }
});

test("native edge-back previews the actual SystemUI MiniApp binding and returns its pending call once", { timeout: 45_000 }, async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_BACK"), {
    deferCapabilities: ["system.runtime.create", "system.runtime.awaitFirstFrame"],
  });
  try {
    let frame = await session.boot();
    const waitForRequest = async (capability: string, seen: Set<string>) => {
      for (let index = 0; index < 80; index++) {
        const request = session.requests.find((candidate) =>
          candidate.capability === capability && !seen.has(candidate.requestId));
        if (request) {
          seen.add(request.requestId);
          return request;
        }
        frame = await session.frame();
      }
      assert.fail(`native guest did not request ${capability}: ${JSON.stringify(session.requests)}`);
    };
    const seenRequests = new Set<string>();
    session.sendEvent("system.request", {
      requestId: "native-lobby-open",
      sourceAppId: "pocket.host.demo",
      sourceInstanceId: "system-ui",
      sourceGeneration: "probe-system-generation",
      capability: "platform.apps.open",
      params: { appId: "pocket.demo.lobby", presentationStyle: "page", arguments: { source: "native-regression" } },
    });

    const create = await waitForRequest("system.runtime.create", seenRequests);
    assert.equal(create.params.appId, "pocket.demo.lobby");
    session.respondPending("system.runtime.create", {
      appId: "pocket.demo.lobby",
      instanceId: "native-lobby-instance",
      generation: 101,
      preparedForOpen: true,
    });
    await session.frame();
    await waitForRequest("system.runtime.awaitFirstFrame", seenRequests);
    session.respondPending("system.runtime.awaitFirstFrame", { ready: true, generation: 101 });

    const miniAppSurface = (candidate: Frame) => candidate.ops?.find((op) =>
      op.type === "hostSurface" && (op as { id?: string }).id === "pocket.demo.lobby");
    for (let index = 0; !miniAppSurface(frame) && index < 40; index++) frame = await session.frame();
    frame = await session.settle(frame, 35);
    const surfaceBefore = miniAppSurface(frame);
    assert.ok(surfaceBefore, `the actual Kernel binding must be presented through SystemAppSurfaces: ${textOf(frame)}`);
    assert.equal(surfaceBefore!.x, 0, "page presentation must settle at its normal position before gesture start");
    const launch = session.requests.find((request) =>
      request.capability === "system.runtime.post" && request.params.event === "platform.launch" &&
      request.params.params?.appId === "pocket.demo.lobby");
    assert.ok(launch, "the kernel must launch the existing MiniApp invocation through the runtime event lane");
    const callId = String(launch!.params.params.requestId);
    const width = frame.width ?? 390;

    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-cancel", phase: "start", dx: 0, width, velocity: 0, progress: 0,
    });
    frame = await session.frame();
    assert.ok(frame.events?.some((event) => event.name === "platform.back.gesture.response" && event.payload?.handled === true),
      `SystemUI must synchronously accept the edge gesture for the current MiniApp invocation: ${JSON.stringify(frame.events)}`);
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-cancel", phase: "update", dx: width * 0.49, width, velocity: 0, progress: 0.49,
    });
    frame = await session.frame();
    const surfaceMid = miniAppSurface(frame);
    assert.ok(surfaceMid, "the same official MiniApp compositor binding must remain painted during the drag");
    assert.ok(Math.abs((surfaceMid!.x ?? 0) - width * 0.49) <= 2,
      `the MiniApp surface must track the 49% frame: expected=${width * 0.49}, actual=${surfaceMid!.x}`);
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-cancel", phase: "cancel", dx: width * 0.49, width, velocity: 0, progress: 0.49,
    });
    frame = await session.settle(await session.frame(), 22);
    const surfaceAfterCancel = miniAppSurface(frame);
    assert.ok(surfaceAfterCancel, "cancel must keep the same invocation binding alive");
    assert.equal(surfaceAfterCancel!.x, surfaceBefore!.x, "cancel must return the surface to its original position");
    const resultPosts = () => session.requests.filter((request) =>
      request.capability === "system.runtime.post" && request.params.event === "platform.result");
    assert.equal(resultPosts().length, 0, "cancel must not complete or cancel the pending system call");

    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-reverse", phase: "start", dx: 0, width, velocity: 0, progress: 0,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-reverse", phase: "update", dx: width * 0.8, width, velocity: 0, progress: 0.8,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-reverse", phase: "update", dx: width * 0.3, width, velocity: 0, progress: 0.3,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-reverse", phase: "end", dx: width * 0.3, width, velocity: 1_400, progress: 0.3,
    });
    frame = await session.settle(await session.frame(), 22);
    assert.ok(miniAppSurface(frame), "end uses latest progress; reversing below half must keep the same invocation surface");
    assert.equal(resultPosts().length, 0, "reversing below half must not resolve the call, even with fast velocity");

    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-commit", phase: "start", dx: 0, width, velocity: 0, progress: 0,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-commit", phase: "update", dx: width * 0.51, width, velocity: 0, progress: 0.51,
    });
    await session.frame();
    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-commit", phase: "end", dx: width * 0.51, width, velocity: 0, progress: 0.51,
    });
    frame = await session.settle(await session.frame(), 45);
    assert.ok(!miniAppSurface(frame), "a completed gesture must remove the existing MiniApp surface binding");
    assert.equal(resultPosts().length, 1, "commit must use the existing result path exactly once");
    assert.deepEqual(resultPosts()[0]!.params.params, {
      requestId: callId,
      appId: "pocket.demo.lobby",
      cancelled: true,
      value: null,
      reason: "back",
    }, "the existing call result must retain cancellation reason=back");

    session.sendEvent("platform.back.gesture", {
      gestureId: "lobby-commit", phase: "end", dx: width, width, velocity: 2_000, progress: 1,
    });
    frame = await session.settle(await session.frame(), 4);
    assert.equal(resultPosts().length, 1, "a duplicate terminal packet must not resolve the invocation twice");
    assert.ok(!miniAppSurface(frame), "duplicate terminal delivery must not recreate the dismissed binding");
  } finally {
    await session.quit();
  }
});
