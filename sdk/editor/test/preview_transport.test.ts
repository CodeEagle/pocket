import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";
import { createPreviewMeshWireDecoder } from "../preview_mesh_wire.ts";

const frame = (ops: unknown[] = []) => ({ frame: 1, width: 375, height: 812, ops, events: [], resources: [], presentationTokens: [], releasedResources: [] });
const packet = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value).trim().slice(6));

// Exercise real PreviewSession stream construction and teardown, not a duplicate
// queue/encoder. The native frame boundary is supplied directly to isolate wire IO.
test("slow preview subscribers fail independently and reconnect with a full replay", async () => {
  const manager = createPreviewManager();
  const id = "transport-test";
  await manager.handle(new Request(`http://127.0.0.1/api/projects/${id}/preview/snapshot`), id, "snapshot");
  const session = (manager as any).sessions.get(id);
  session.frame = frame();
  const slow = session.stream(true).body!.getReader();
  const fast = session.stream(true).body!.getReader();
  let cancellations = 0;
  session.cancelActivePointersIfBrowserGone = () => { cancellations++; };
  try {
    await fast.read(); // status
    await fast.read(); // replay
    for (let i = 0; i < 12; i++) {
      session.emit({ type: "test", sequence: i, data: "x".repeat(1024 * 1024) });
      const value = await fast.read();
      assert.equal(packet(value.value!).sequence, i);
    }
    assert.equal(session.subscribers.size, 1, "only the slow subscriber is removed");
    await assert.rejects(slow.read(), /slow|queue|consumer|backpressure/i);
    assert.ok(cancellations > 0, "overflow uses the browser disconnect cleanup path");
    session.frame = { ...frame(), frame: 9, events: [{ name: "retained-state" }] };
    const resumed = session.stream(true).body!.getReader();
    try {
      assert.equal(packet((await resumed.read()).value!).type, "status");
      const replay = packet((await resumed.read()).value!);
      assert.equal(replay.frame.frame, 9);
      assert.deepEqual(replay.frame.events, [{ name: "retained-state" }]);
    } finally { await resumed.cancel(); }
  } finally { await fast.cancel(); await manager.dispose(); }
});

test("legacy replay accepts a single large snapshot after its initial status", async () => {
  const manager = createPreviewManager();
  const id = "large-replay";
  await manager.handle(new Request(`http://127.0.0.1/api/projects/${id}/preview/snapshot`), id, "snapshot");
  const session = (manager as any).sessions.get(id);
  session.frame = { ...frame(), data: "x".repeat(9 * 1024 * 1024) };
  const reader = session.stream().body!.getReader();
  try {
    assert.equal(packet((await reader.read()).value!).type, "status");
    assert.equal(packet((await reader.read()).value!).frame.data.length, 9 * 1024 * 1024);
  } finally { await reader.cancel(); await manager.dispose(); }
});


test("negotiated mesh streams retain exact geometry while snapshots and legacy subscribers stay canonical", async () => {
  const manager = createPreviewManager();
  const id = "retained-wire";
  const session = (manager as any).session(id);
  const ops = Array.from({ length: 30 }, (_, i) => ({ type: "textureTriangle", asset: "model/atlas", color: 0xffffffff,
    repeatTexture: true, clip: { x: 0, y: 0, w: 375, h: 812 },
    points: [{ x: i + .123456789, y: .2 }, { x: i + 1.123456789, y: .2 }, { x: i + .123456789, y: 1.2 }],
    uvs: [0, 0, 1, 0, 0, 1] }));
  session.frame = frame(ops);
  const response = session.stream(true, undefined, false, true, true);
  assert.equal(response.headers.get("x-pocket-preview-transport"), "native-probe-retained-meshes-v1");
  const reader = response.body!.getReader();
  const decoder = createPreviewMeshWireDecoder();
  try {
    await reader.read();
    const first = packet((await reader.read()).value!);
    assert.equal(first.frame.meshWire, "retained-v1");
    assert.deepEqual((decoder.decode(first) as any).frame, session.frame);
    ops[0]!.points[0]!.x += .0000000001;
    session.emit({ type: "frame", frame: session.frame });
    const changed = packet((await reader.read()).value!);
    assert.deepEqual((decoder.decode(changed) as any).frame, session.frame);
    session.emit({ type: "frame", frame: session.frame });
    const repeated = packet((await reader.read()).value!);
    assert.ok(JSON.stringify(repeated).length < JSON.stringify(first).length / 2);
    assert.deepEqual((decoder.decode(repeated) as any).frame, session.frame);
    assert.deepEqual(session.snapshot().frame, session.frame);
    const legacy = session.stream().body!.getReader();
    try {
      await legacy.read();
      const replay = packet((await legacy.read()).value!);
      assert.equal(replay.frame.meshWire, undefined);
      assert.deepEqual(replay.frame, session.frame);
    } finally { await legacy.cancel(); }
    const resumed = session.stream(true, undefined, false, true, true).body!.getReader();
    try {
      await resumed.read();
      const replay = packet((await resumed.read()).value!);
      assert.deepEqual((createPreviewMeshWireDecoder().decode(replay) as any).frame, session.frame);
    } finally { await resumed.cancel(); }
  } finally { await reader.cancel(); await manager.dispose(); }
});
