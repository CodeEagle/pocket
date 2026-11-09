import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type AnyRecord = Record<string, any>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rootFrame(frame: number, focused = true): AnyRecord {
  return {
    frame,
    width: 390,
    height: 360,
    ops: [
      { type: "hostSurface", kind: "application", surfaceHandle: 1, id: "child", x: 0, y: 0, w: 390, h: 360, focused },
      { type: "text", text: `root-${frame}`, x: 8, y: 8, w: 80, h: 16 },
    ],
    events: [],
    resources: [],
  };
}

function childFrame(frame: number, label: string, resources: AnyRecord[] = []): AnyRecord {
  return {
    frame,
    width: 390,
    height: 360,
    ops: [{ type: "text", text: label, x: 8, y: 40, w: 120, h: 16 }],
    events: [],
    resources,
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  assert.ok(predicate(), message);
}

test("slow child frame leaves root ticks live, defers lifecycle post, and drops stale generation", async () => {
  const manager = createPreviewManager();
  const response = await manager.handle(
    new Request("http://127.0.0.1/api/projects/child-frame-scheduler/preview/snapshot"),
    "child-frame-scheduler",
    "snapshot",
  );
  assert.equal(response.status, 200);
  const session = (manager as any).sessions.get("child-frame-scheduler") as AnyRecord;
  assert.ok(session);
  session.ensureStarted = async () => {};

  let rootFrames = 0;
  let rootFocused = true;
  const rootCommands: AnyRecord[] = [];
  const rootProbe = {
    checked: async (command: AnyRecord) => {
      rootCommands.push(command);
      if (command.op === "frame") return { ok: true, frame: rootFrame(++rootFrames, rootFocused) };
      if (command.op === "schedule") return { ok: true, nextWakeDelayMs: -1 };
      return { ok: true };
    },
    stop: async () => {},
  };

  const firstChildFrame = deferred<AnyRecord>();
  const deferredPostResponse = deferred<AnyRecord>();
  let childFrameCalls = 0;
  const childFrameDeltas: number[] = [];
  let activeChildFrames = 0;
  let maxActiveChildFrames = 0;
  let childPostStarted = false;
  const childProbe = {
    checked: async (command: AnyRecord) => {
      if (command.op === "frame") {
        childFrameCalls += 1;
        childFrameDeltas.push(Number(command.deltaMs));
        if (childFrameCalls === 1) {
          activeChildFrames += 1;
          maxActiveChildFrames = Math.max(maxActiveChildFrames, activeChildFrames);
          try { return await firstChildFrame.promise; }
          finally { activeChildFrames -= 1; }
        }
        return {
          ok: true,
          frame: childFrame(2, "current-generation-child"),
        };
      }
      if (command.op === "send" && command.message?.name === "platform.lifecycle") {
        childPostStarted = true;
        // The real line-oriented probe processes this command after the
        // outstanding frame command. Preserve that ordering in the fixture.
        return deferredPostResponse.promise;
      }
      if (command.op === "schedule") return { ok: true, nextWakeDelayMs: -1 };
      return { ok: true };
    },
    stop: async () => {},
  };

  const root: AnyRecord = {
    appId: "system",
    instanceId: "system-ui",
    generation: 1,
    probe: rootProbe,
    artifacts: {},
    viewportWidth: 390,
    viewportHeight: 360,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    resources: new Map(),
    initialEvents: [],
    pendingBrowserEvents: [],
    needsPump: false,
    pumping: 0,
    frame: rootFrame(0),
  };
  const child: AnyRecord = {
    appId: "child",
    instanceId: "pocket-app-1",
    generation: 1,
    probe: childProbe,
    artifacts: {},
    viewportWidth: 390,
    viewportHeight: 360,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    resources: new Map(),
    initialEvents: [],
    pendingBrowserEvents: [],
    needsPump: false,
    pumping: 0,
    frame: childFrame(0, "loading-screen"),
  };
  session.probe = rootProbe;
  session.rootRuntime = root;
  session.childRuntimes.set(child.appId, child);

  try {
    await session.enqueue(() => session.tickNow(16));
    assert.equal(childFrameCalls, 1, "one child frame should be in flight");
    const rootFrameBeforePost = Number(session.frame.frame);

    const postStarted = session.enqueue(() => session.handleSystemRuntimeRequest(
      root,
      "lifecycle-post",
      "system.runtime.post",
      { instanceId: child.instanceId, event: "platform.lifecycle", params: { state: "onDidAppear" } },
      0,
    )).then(() => true);
    const returnedBeforeChildFrame = await Promise.race([
      postStarted,
      Bun.sleep(80).then(() => false),
    ]);
    assert.equal(returnedBeforeChildFrame, true,
      "SystemUI must not hold the root queue while a child frame is pending");
    assert.equal(childPostStarted, true, "the lifecycle post must retain native command order");

    await session.enqueue(() => session.tickNow(16));
    assert.ok(Number(session.frame.frame) > rootFrameBeforePost,
      "root frames must advance while the child native frame is delayed");
    assert.equal(activeChildFrames, 1);
    assert.equal(maxActiveChildFrames, 1, "a child probe must never receive overlapping frame pumps");

    // Move the root away from the child while its slow response is still in
    // flight. Time accumulated for the old surface must not be replayed when
    // that suspended child eventually resumes.
    rootFocused = false;
    await session.enqueue(() => session.tickNow(16));
    assert.equal(child.pendingFrameDeltaMs, 0, "suspending the child must drop accumulated elapsed time");

    // A reload can change the child generation while the old native call is
    // still returning. Its DrawOps and texture must not enter the new guest.
    child.generation = 2;
    firstChildFrame.resolve({
      ok: true,
      frame: childFrame(1, "stale-generation-child", [
        { asset: "stale-child-texture", revision: 1, width: 1, height: 1, psm: 3, pixels: [1, 2, 3, 4] },
      ]),
    });
    deferredPostResponse.resolve({ ok: true });

    await waitFor(() => rootCommands.some((command) =>
      command.op === "send" && command.message?.name === "host.response" &&
      command.message?.payload?.requestId === "lifecycle-post"),
    "the deferred lifecycle post must receive its host response");
    await waitFor(() => childFrameCalls >= 2 && session.frame.ops.some((op: AnyRecord) =>
      op.type === "text" && op.text === "current-generation-child"),
    "the current child generation must resume after the stale frame settles");
    assert.deepEqual(childFrameDeltas.slice(1), childFrameDeltas.slice(1).map(() => 0),
      "the resumed child must not receive elapsed time accumulated before it was suspended");

    assert.equal(child.resources.has("stale-child-texture"), false,
      "a stale child response must not cache its texture");
    assert.equal(session.frame.ops.some((op: AnyRecord) => op.text === "stale-generation-child"), false,
      "a stale child response must not replace the visible child frame");
    assert.equal(maxActiveChildFrames, 1);
  } finally {
    firstChildFrame.resolve({ ok: true, frame: childFrame(1, "cleanup") });
    deferredPostResponse.resolve({ ok: true });
    await manager.dispose();
  }
});
