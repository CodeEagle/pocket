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
