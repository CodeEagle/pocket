import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("child response settlement publishes before consuming the next animation tick", async () => {
  const manager = createPreviewManager();
  await manager.handle(new Request("http://127.0.0.1/api/projects/settle-time/preview/snapshot"), "settle-time", "snapshot");
  const session = (manager as any).sessions.get("settle-time");
  const deltas: number[] = [], publications: { deltas: number[]; pending: number }[] = [];
  const frame = { frame: 0, width: 390, height: 360, ops: [], events: [], resources: [] };
  const stop = async () => {};
  const root = { appId: "system", generation: 1, frame, probe: { stop }, pendingBrowserEvents: [] };
  const child: any = {
    appId: "child", generation: 1, frame, needsPump: false, pendingFrameDeltaMs: 0,
    pendingBrowserEvents: [], probe: {
      stop,
      async checked(command: any) {
        assert.equal(command.op, "frame");
        deltas.push(command.deltaMs);
        // External display ticks arrive while the host response is settling.
        if (deltas.length <= 4) child.pendingFrameDeltaMs += 16;
        // Advancing model time generates the next asynchronous host request.
        if (command.deltaMs > 0) child.needsPump = true;
        return { ok: true, frame: { ...frame, frame: deltas.length } };
      },
    },
  };
  session.rootRuntime = root;
  session.childRuntimes.set("child", child);
  session.hasFocusedVisibleSurface = () => true;
  session.schedule = async () => {};
  session.ingestRuntimeFrame = async (runtime: any, next: any) => (runtime.frame = next);
  session.publishCompositedFrame = () => publications.push({ deltas: [...deltas], pending: child.pendingFrameDeltaMs });
  try {
    session.startChildFramePump(child, 16);
    const deadline = Date.now() + 1000;
    while ((publications.length < 3 || child.frameInFlight) && Date.now() < deadline) await Bun.sleep(1);
    assert.equal(publications.length, 3);
    assert.deepEqual(publications[0]!.deltas, [16, 0, 0], "settlement must not create another timed model update");
    assert.equal(publications[0]!.pending, 48, "elapsed display time stays queued until this response is visible");
    assert.deepEqual(deltas.filter(delta => delta > 0), [16, 48, 16], "the following display pumps retain all queued time exactly once");
    assert.equal(child.pendingFrameDeltaMs, 0);
  } finally { await manager.dispose(); }
});
