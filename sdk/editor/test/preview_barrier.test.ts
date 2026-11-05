import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type AnyRecord = Record<string, any>;

async function sessionFor(projectId: string): Promise<{ manager: ReturnType<typeof createPreviewManager>; session: AnyRecord }> {
  const manager = createPreviewManager();
  const response = await manager.handle(
    new Request(`http://127.0.0.1/api/projects/${projectId}/preview/snapshot`),
    projectId,
    "snapshot",
  );
  assert.equal(response.status, 200);
  const session = (manager as any).sessions.get(projectId) as AnyRecord;
  assert.ok(session, "snapshot must create a preview session");
  session.ensureStarted = async () => {};
  return { manager, session };
}

function fakeProbe(onCommand?: (command: AnyRecord) => Promise<AnyRecord>): AnyRecord {
  return { checked: onCommand ?? (async () => ({})), stop: async () => {} };
}

function fakeRuntime(appId: string, probe: AnyRecord): AnyRecord {
  return {
    appId,
    instanceId: appId === "system" ? "system-ui" : `pocket-${appId}`,
    generation: 1,
    probe,
    artifacts: {},
    viewportWidth: 390,
    viewportHeight: 360,
    resources: new Map(),
    initialEvents: [],
    needsPump: false,
    pumping: 0,
  };
}

test("presentation ACK remains retryable until the native response succeeds", async () => {
  const { manager, session } = await sessionFor("presentation-ack");
  const probe = fakeProbe();
  const child = fakeRuntime("child", probe);
  session.probe = probe;
  session.childRuntimes.set(child.appId, child);
  let attempts = 0;
  session.pendingPresentations.set("token", {
    child,
    published: true,
    respond: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("native response failed");
    },
  });
  try {
    await assert.rejects(session.sendInput({ type: "presented", tokens: ["token"] }), /native response failed/);
    assert.equal(session.pendingPresentations.has("token"), true, "failed ACK must remain pending");
    await session.sendInput({ type: "presented", tokens: ["token"] });
    assert.equal(session.pendingPresentations.has("token"), false, "successful ACK must retire the token");
    assert.equal(attempts, 2);
  } finally {
    await manager.dispose();
  }
});

test("lost browser presentation rejects awaitFirstFrame and pumps the root", async () => {
  const { manager, session } = await sessionFor("presentation-disconnect");
  let frameCalls = 0;
  const probe = fakeProbe(async (command) => {
    if (command.op === "frame") {
      frameCalls += 1;
      return { frame: { frame: frameCalls, width: 390, height: 360, ops: [], events: [], resources: [] } };
    }
    if (command.op === "schedule") return { nextWakeDelayMs: -1 };
    return {};
  });
  const root = fakeRuntime("system", probe);
  root.frame = { frame: 0, width: 390, height: 360, ops: [], events: [], resources: [] };
  session.probe = probe;
  session.rootRuntime = root;
  const child = fakeRuntime("child", probe);
  let responseError: AnyRecord | undefined;
  session.pendingPresentations.set("token", {
    child,
    published: true,
    respond: async (_result: unknown, error?: AnyRecord) => { responseError = error; },
  });
  try {
    session.failPendingPresentationsIfBrowserGone();
    const deadline = Date.now() + 1_000;
    while (session.pendingPresentations.size > 0 && Date.now() < deadline) await Bun.sleep(1);
    assert.equal(session.pendingPresentations.size, 0, "disconnect must settle pending presentation requests");
    assert.equal(responseError?.code, "presentation_unavailable");
    assert.ok(frameCalls > 0, "failed presentation response must receive a root pump turn");
  } finally {
    await manager.dispose();
  }
});

test("destroyed child assets are released and not released after same-app restart", async () => {
  const { manager, session } = await sessionFor("presentation-resources");
  const probe = fakeProbe();
  const root = fakeRuntime("system", probe);
  session.probe = probe;
  session.rootRuntime = root;
  const asset = "pocket.runtime.child.texture";
  session.resourceCache.set(asset, { asset, revision: 1, width: 1, height: 1, psm: 1 });
  session.dropRuntimeResources("child");
  assert.equal(session.resourceCache.has(asset), false);
  assert.equal(session.pendingReleasedResources.has(asset), true);

  const child = fakeRuntime("child", probe);
  child.frame = { frame: 2, width: 390, height: 360, ops: [], events: [], resources: [] };
  child.resources.set("texture", { asset: "texture", revision: 2, width: 1, height: 1, psm: 1 });
  session.childRuntimes.set(child.appId, child);
  const frame = session.compositeFrame({
    frame: 1,
    width: 390,
    height: 360,
    ops: [{ type: "hostSurface", surfaceHandle: 1, id: "child", x: 0, y: 0, w: 390, h: 360 }],
    events: [],
    resources: [],
  });
  assert.ok(frame.resources.some((value: AnyRecord) => value.asset === asset), "restarted child must publish its replacement resource");
  assert.equal(frame.releasedResources?.includes(asset), false, "replacement must not be deleted by the stale release");
  await manager.dispose();
});

test("resource deltas compare omitted-revision pixel payloads", async () => {
  const { manager, session } = await sessionFor("resource-payload-delta");
  const probe = fakeProbe();
  const root = fakeRuntime("system", probe);
  session.probe = probe;
  session.rootRuntime = root;
  const asset = "atlas.static";
  const cached = { asset, width: 1, height: 1, psm: 1, linear: false, pixels: [7, 8], palette: [9] };
  session.resourceCache.set(asset, cached);
  root.resources.set(asset, { ...cached, pixels: [7, 8], palette: [9] });

  const stable = session.compositeFrame({
    frame: 1,
    width: 390,
    height: 360,
    ops: [],
    events: [],
    resources: [],
  });
  assert.equal(stable.resources.length, 0, "unchanged revision-less pixels should not be resent");

  root.resources.set(asset, { ...cached, pixels: [7, 10], palette: [9] });
  const changed = session.compositeFrame({
    frame: 2,
    width: 390,
    height: 360,
    ops: [],
    events: [],
    resources: [],
  });
  assert.deepEqual(changed.resources, [{ ...cached, pixels: [7, 10], palette: [9] }]);
  await manager.dispose();
});
