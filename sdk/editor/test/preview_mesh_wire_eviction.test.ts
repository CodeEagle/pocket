import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewMeshWireEncoder, createPreviewMeshWireDecoder } from "../preview_mesh_wire.ts";

const run = (asset: string, extra?: unknown) => Array.from({ length: 12 }, (_, i) => ({
  type: "textureTriangle", asset, color: 0xffffffff, repeatTexture: true,
  points: [{ x: i + .125319712, y: 0 }, { x: i + 1.125319712, y: 0 }, { x: i + .125319712, y: 1 }],
  uvs: [0, 0, 1, 0, 0, 1], ...(extra === undefined ? {} : { extra }),
}));
const frame = (ops: unknown[]) => ({ type: "frame", frame: { frame: 1, width: 64, height: 64, ops, events: [], resources: [] } });

test("changing a recently used UV template cannot evict another still-referenced run", () => {
  const encoder = createPreviewMeshWireEncoder({ maxSlots: 2 });
  const decoder = createPreviewMeshWireDecoder({ maxSlots: 2 });
  const a = run("a"), b = run("b");
  const transfer = (value: unknown) => {
    const encoded = encoder.encode(value) as any;
    assert.equal(encoded.frame.meshWire, "retained-v1");
    assert.ok(encoded.frame.ops.some(Array.isArray));
    return decoder.decode(JSON.parse(JSON.stringify(encoded)));
  };
  assert.deepEqual(transfer(frame([...a, ...b])), frame([...a, ...b]));
  assert.deepEqual(transfer(frame(a)), frame(a)); // a becomes the most recent slot
  a[0]!.uvs[0] = .25; // same slot ordinal/metadata, new template
  assert.deepEqual(transfer(frame([...a, ...b])), frame([...a, ...b]));
});

test("unknown metadata preserves JSON own properties without interpreting prototype keys", () => {
  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();
  const input = frame(run("a", JSON.parse('{"__proto__":{"value":7},"retained":true}')));
  const result = decoder.decode(JSON.parse(JSON.stringify(encoder.encode(input))));
  assert.deepEqual(result, input);
  assert.equal((Object.prototype as any).value, undefined);
});
