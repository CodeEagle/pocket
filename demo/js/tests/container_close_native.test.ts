import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { backIconPoint } from "./navigation_geometry.ts";
import { NativeSession, readNativeArtifacts, textOps } from "./native_session.ts";

const healthyUpdateStatus = {
  configured: true,
  stage: "ready",
  activeVersion: "0.1.0-test.4",
  activeBuild: 4,
  availableVersion: "0.1.0-test.4",
  preparedUpdate: null,
  versions: [{ version: "0.1.0-test.4", build: 4, status: "active" }],
  lastError: null,
};

const phonePublishedSurfaces = Object.freeze({
  "pocket.demo.profile": 2,
  "pocket.demo.lobby": 3,
  "pocket.demo.lantern": 63,
});

test("Home exposes one container exit action at narrow and wide widths and closes through native input", { timeout: 30_000 }, async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_CONTAINER_CLOSE"), {
    deferCapabilities: ["system.container.close", "updates.status"],
    compositorSurfaces: phonePublishedSurfaces,
  });
  const answeredStatusRequests = new Set<string>();
  try {
    let frame = await session.boot();

    const settleHealthyUpdates = async (start: typeof frame): Promise<typeof frame> => {
      let latest = start;
      // Resolve realistic host health responses as they appear and give event
      // handlers a few native ticks to finish their asynchronous work.
      for (let pass = 0; pass < 5; pass += 1) {
        for (let count = 0; count < 12; count += 1) {
          const request = session.requests.find((candidate) =>
            candidate.capability === "updates.status" && !answeredStatusRequests.has(candidate.requestId));
          if (!request) break;
          answeredStatusRequests.add(request.requestId);
          session.respondPending("updates.status", healthyUpdateStatus, true, (candidate) => candidate.requestId === request.requestId);
          latest = await session.frame();
        }
        latest = await session.settle(latest, 2);
      }
      return latest;
    };

    frame = await settleHealthyUpdates(frame);
    assert.ok(answeredStatusRequests.size > 0, "the native session must answer updates.status with healthy host state");

    session.sendEvent("updates.changed", { version: "0.1.0-test.4", build: 4 });
    session.sendEvent("platform.lifecycle", { state: "onResume" });
    frame = await session.frame();
    frame = await settleHealthyUpdates(frame);

    const unsolicitedUpdateRequests = () => session.requests.filter((request) =>
      request.capability === "updates.check" || request.capability === "updates.apply");
    assert.deepEqual(unsolicitedUpdateRequests(), [], "healthy status, updates.changed, and onResume must not check or apply an update before a user action");

    assert.equal(textOps(frame, "退出容器").length, 1, "Home must show one discoverable exit action at narrow width");
    const narrowBackPoint = backIconPoint(frame);
    frame = await session.resize(1280, 800);
    assert.equal(textOps(frame, "退出容器").length, 1, "the shared Home header must keep one exit action at wide width");
    const wideBackPoint = backIconPoint(frame);

    assert.ok(narrowBackPoint.x < 88 && wideBackPoint.x < 88, "Home must show its back chevron in the leading slot at both widths");
    frame = await session.tapPoint(wideBackPoint);
    for (let index = 0; index < 20 && !session.requests.some((request) => request.capability === "system.container.close"); index += 1) {
      frame = await session.frame();
    }
    const requests = session.requests.filter((request) => request.capability === "system.container.close");
    assert.equal(requests.length, 1, "one native pointer tap on the Home back chevron must send one container close request");
    assert.deepEqual(requests[0]!.params, {});
    assert.deepEqual(unsolicitedUpdateRequests(), [], "using the exit action must not trigger package update work");
    session.respondPending("system.container.close", { closed: true });
    await session.settle(frame);
  } finally {
    await session.quit();
  }
});
