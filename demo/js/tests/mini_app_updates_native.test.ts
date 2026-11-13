import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { backIconPoint } from "./navigation_geometry.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOp,
  textOf,
  textOps,
  type DrawOp,
  type Frame,
  type HostRequest,
} from "./native_session.ts";

const width = 390;
const height = 844;
const statusCapability = "platform.apps.update.status";
const prepareCapability = "platform.apps.update.prepare";
const lanternId = "pocket.demo.lantern";
const profileId = "pocket.demo.profile";
const lobbyId = "pocket.demo.lobby";

function visibleText(frame: Frame, label: string): DrawOp | undefined {
  return (frame.ops ?? []).filter((op) => op.type === "text" && typeof op.text === "string" && op.text.includes(label)).find((op) => {
    const centerX = (op.x ?? -Infinity) + (op.w ?? 0) / 2;
    const centerY = (op.y ?? -Infinity) + (op.h ?? 0) / 2;
    const clipLeft = Math.max(0, op.clip?.x ?? 0);
    const clipRight = Math.min(frame.width ?? width, (op.clip?.x ?? 0) + (op.clip?.w ?? Infinity));
    const clipTop = Math.max(0, op.clip?.y ?? 0);
    const clipBottom = Math.min(frame.height ?? height, (op.clip?.y ?? 0) + (op.clip?.h ?? Infinity));
    return centerX >= clipLeft && centerX <= clipRight && centerY >= clipTop && centerY <= clipBottom;
  });
}

async function revealText(session: NativeSession, frame: Frame, label: string): Promise<{ frame: Frame; op: DrawOp }> {
  let latest = frame;
  let op = visibleText(latest, label);
  for (let attempt = 0; !op && attempt < 12; attempt += 1) {
    latest = await session.settle(await session.drag({ x: 8, y: 690 }, { x: 8, y: 300 }, 8), 4);
    op = visibleText(latest, label);
  }
  assert.ok(op, label + " must become visible after real page scrolling; painted=" + (latest.ops ?? []).map((item) => item.text ?? "").join("\n"));
  return { frame: latest, op: op! };
}

async function scrollToTop(session: NativeSession, frame: Frame): Promise<Frame> {
  let latest = frame;
  for (let attempt = 0; attempt < 20 && !visibleText(latest, "Check all updates"); attempt += 1) {
    latest = await session.settle(await session.drag({ x: 8, y: 300 }, { x: 8, y: 690 }, 8), 3);
  }
  assert.ok(visibleText(latest, "Check all updates"), "global update action should be reachable at the top of the page");
  return latest;
}

function updateStatus(appId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId,
    configured: true,
    running: appId === lanternId,
    installedVersion: "0.1.0",
    installedBuild: appId === profileId ? 3 : 5,
    activeVersion: "0.1.0",
    activeBuild: appId === profileId ? 3 : 5,
    latestVersion: null,
    latestBuild: null,
    stagedVersion: null,
    stagedBuild: null,
    updateAvailable: false,
    stage: "idle",
    lastError: null,
    ...overrides,
  };
}

function remoteRequests(session: NativeSession): HostRequest[] {
  return session.requests.filter((request) =>
    request.capability === statusCapability && request.params.checkLatest === true
  );
}

async function waitForRequests(
  session: NativeSession,
  frame: Frame,
  capability: string,
  expectedCount: number,
): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < 90; index += 1) {
    const count = session.requests.filter((request) => request.capability === capability).length;
    if (count >= expectedCount) return latest;
    latest = await session.frame();
  }
  assert.fail("timed out waiting for " + expectedCount + " " + capability + " requests; painted=" +
    textOf(latest) + "; received=" + JSON.stringify(session.requests));
}

function respondForApp(
  session: NativeSession,
  capability: string,
  appId: string,
  response: unknown,
  ok = true,
): void {
  session.respondPending(capability, response, ok, (request: HostRequest) => request.params.appId === appId);
}

test("MiniApp version page reads local status first and bounds signed update checks", { timeout: 60_000 }, async () => {
  const session = new NativeSession(readNativeArtifacts(), {
    width,
    height,
    deferCapabilities: [statusCapability, prepareCapability],
    deadlineMs: 90_000,
  });
  try {
    let frame = await session.boot();
    const manage = await revealText(session, frame, "Manage MiniApp versions");
    frame = await session.settle(await session.tapPoint(center(manage.op, "Manage MiniApp versions")), 4);
    frame = await session.settle(frame, 8);
    assert.ok(frame.ops?.some((op) => op.type === "text" && op.text === "MiniApp versions"),
      "secondary route title must render");

    frame = await waitForRequests(session, frame, statusCapability, 3);
    const systemConfigure = session.requests.find((request) => request.capability === "system.runtime.configure");
    const grants = systemConfigure?.params.grants;
    assert.ok(Array.isArray(grants), "SystemUI should expose the installed catalog grants");
    const appIds = (grants as Array<{ appId: string }>)
      .map((grant) => grant.appId)
      .filter((appId) => appId !== "pocket.host.demo");
    assert.equal(appIds.length, 33, "the installed catalog fixture should contain 33 MiniApps");
    assert.ok(appIds.includes(lanternId) && appIds.includes(profileId) && appIds.includes(lobbyId),
      "the installed catalog should include Lantern, Profile, and Lobby");
    const configuredIds = Array.from(new Set([
      lanternId,
      profileId,
      ...appIds.filter((appId) => appId !== lanternId && appId !== profileId && appId !== lobbyId).slice(0, 5),
    ]));
    assert.ok(configuredIds.length >= 5, "test catalog needs enough configured packages to exercise the three-request limit");

    const respondedLocal = new Set<string>();
    while (respondedLocal.size < appIds.length) {
      const localRequests = session.requests.filter((request) =>
        request.capability === statusCapability && request.params.checkLatest !== true
      );
      const pending = localRequests.filter((request) => !respondedLocal.has(request.requestId));
      assert.ok(pending.length <= 3, "local status reads should not exceed the host request window");
      if (pending.length === 0) {
        frame = await session.frame();
        continue;
      }
      const request = pending[0]!;
      const appId = String(request.params.appId);
      const response = appId === lobbyId
        ? updateStatus(appId, {
            configured: false,
            activeVersion: null,
            activeBuild: null,
            stage: "not_configured",
          })
        : updateStatus(appId, { configured: configuredIds.includes(appId) });
      respondForApp(session, statusCapability, appId, response);
      respondedLocal.add(request.requestId);
      frame = await session.frame();
    }
    frame = await session.settle(await session.frame(), 10);
    const localRequests = session.requests.filter((request) =>
      request.capability === statusCapability && request.params.checkLatest !== true
    );
    assert.equal(localRequests.length, 33, "the page should read each installed MiniApp's local package facts");
    assert.equal(new Set(localRequests.map((request) => request.params.appId)).size, 33,
      "local status should be requested once per installed app");
    assert.equal(remoteRequests(session).length, 0, "mount must not start any remote latest-version checks");
    assert.ok(frame.ops?.some((op) => op.type === "text" && op.text === "33 installed MiniApps"),
      "the page should identify the full installed package catalog");
    const notChecked = await revealText(session, frame, "NOT CHECKED");
    frame = notChecked.frame;

    const singleCheck = await revealText(session, frame, "Check latest");
    frame = await session.tapPoint(center(singleCheck.op, "Check latest"));
    frame = await waitForRequests(session, frame, statusCapability, 34);
    const perAppRequest = remoteRequests(session)[0]!;
    const perAppId = String(perAppRequest.params.appId);
    respondForApp(session, statusCapability, perAppId, updateStatus(perAppId, {
      latestVersion: "0.1.0",
      latestBuild: perAppId === lanternId ? 6 : 2,
      updateAvailable: true,
    }));
    frame = await session.settle(await session.frame(), 4);
    const priorRemoteIds = new Set(remoteRequests(session).map((request) => request.requestId));
    assert.equal(priorRemoteIds.size, 1, "single-row check should issue exactly one remote request");
    frame = await scrollToTop(session, frame);

    const checkAll = await revealText(session, frame, "Check all updates");
    frame = await session.tapPoint(center(checkAll.op, "Check all updates"));
    frame = await waitForRequests(session, frame, statusCapability, 33 + 1 + 3);
    const checkAllRequests = () => remoteRequests(session)
      .filter((request) => !priorRemoteIds.has(request.requestId));
    assert.equal(checkAllRequests().length, 3,
      "the global action should start at most three signed checks at once");

    const responded = new Set<string>();
    let maxOutstanding = 0;
    while (responded.size < configuredIds.length) {
      const pending = checkAllRequests().filter((request) => !responded.has(request.requestId));
      maxOutstanding = Math.max(maxOutstanding, pending.length);
      assert.ok(pending.length <= 3, "check-all concurrency must stay at or below three");
      if (pending.length === 0) {
        frame = await session.frame();
        continue;
      }
      const request = pending[0]!;
      const appId = String(request.params.appId);
      if (appId === profileId) {
        respondForApp(session, statusCapability, appId, null, false);
      } else if (appId === lanternId) {
        respondForApp(session, statusCapability, appId, updateStatus(appId, {
          latestVersion: "0.1.0",
          latestBuild: 6,
          updateAvailable: true,
        }));
      } else {
        respondForApp(session, statusCapability, appId, updateStatus(appId, {
          latestVersion: "0.1.0",
          latestBuild: 5,
        }));
      }
      responded.add(request.requestId);
      frame = await session.frame();
    }
    frame = await session.settle(frame, 8);
    assert.equal(checkAllRequests().length, configuredIds.length,
      "check-all should inspect each configured app once and skip apps without a source");
    assert.equal(maxOutstanding, 3, "the test must exercise all three allowed workers");

    const lanternBadge = await revealText(session, frame, "UPDATE AVAILABLE");
    frame = lanternBadge.frame;
    const automaticUpdates = await revealText(session, frame, "Automatic updates");
    assert.equal(automaticUpdates.op.text, "Automatic updates", "Lantern should keep its automatic update notice");
    frame = automaticUpdates.frame;
    const automaticDetail = await revealText(session, frame, "Checked on app");
    assert.ok(automaticDetail.op.text?.includes("Checked on app") && automaticDetail.op.text.includes("open"));
    frame = automaticDetail.frame;
    const automaticBadge = await revealText(session, frame, "ON");
    assert.equal(automaticBadge.op.text, "ON", "Lantern's automatic update-on-open path should remain enabled");
    frame = automaticBadge.frame;
    const sameVersionBuilds = await revealText(session, frame, "v0.1.0 · build 6");
    frame = sameVersionBuilds.frame;
    assert.ok(textOf(frame).includes("v0.1.0 · build 5") && textOf(frame).includes("v0.1.0 · build 6"),
      "same-SemVer build updates must keep installed and latest build numbers distinct");

    const download = await revealText(session, frame, "Download update");
    frame = await session.tapPoint(center(download.op, "Download update"));
    frame = await waitForRequests(session, frame, prepareCapability, 1);
    respondForApp(session, prepareCapability, lanternId, updateStatus(lanternId, {
      latestVersion: "0.1.0",
      latestBuild: 6,
      stagedVersion: "0.1.0",
      stagedBuild: 6,
      updateAvailable: true,
      stage: "ready",
    }));
    frame = await session.settle(await session.frame(), 8);
    assert.ok((frame.ops ?? []).some((op) => op.type === "text" && op.text === "STAGED"),
      "the selected update should be shown as staged");
    const stagedFact = await revealText(session, frame, "Staged · activates on next healthy open");
    frame = stagedFact.frame;
    const activeFact = await revealText(session, frame, "Active");
    frame = activeFact.frame;
    assert.ok(textOf(frame).includes("Active") && textOf(frame).includes("v0.1.0 · build 5"),
      "preparing an update must not claim the running app is already on build 6");
    const stagedBuild = await revealText(session, frame, "v0.1.0 · build 6");
    frame = stagedBuild.frame;
    assert.ok(textOf(frame).includes("v0.1.0 · build 6"),
      "the staged build should be visible next to the unchanged active build");

    const profileError = await revealText(session, frame, "Update check failed");
    frame = profileError.frame;
    assert.ok(textOf(frame).includes("v0.1.0 · build 3"),
      "a failed per-app check must preserve that app's local installed version");
    const lobbySource = await revealText(session, frame, "No signed update source is configured for this host.");
    frame = lobbySource.frame;

    const outgoing = textOp(frame, "MiniApp versions", (op) => (op.y ?? 999) < 70);
    frame = await session.tapPoint(backIconPoint(frame));
    const afterPop = textOp(frame, "MiniApp versions", (op) => (op.y ?? 999) < 70);
    assert.ok(afterPop.x! >= outgoing.x! - 1, "the page title should remain painted as its route begins popping");
    let previousX = afterPop.x!;
    let moved = false;
    for (let index = 0; index < 8; index += 1) {
      frame = await session.frame();
      const title = textOps(frame, "MiniApp versions").find((op) => (op.y ?? 999) < 70);
      if (!title) break;
      assert.ok(title.x! >= previousX - 1, "the outgoing page should move right during exit animation");
      moved ||= title.x! > afterPop.x! + 1;
      previousX = title.x!;
    }
    assert.ok(moved, "the package page should keep the existing native-backed JS secondary-route exit animation");
    frame = await session.settle(frame, 20);
    assert.ok(textOps(frame, "Pocket").some((op) => (op.y ?? 999) < 70),
      "back should return to Home after the outgoing route finishes");
  } finally {
    await session.quit();
  }
});
