import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("compact native pixels and palette stay compact in cache and decode only at HTTP delivery", async () => {
  const manager = createPreviewManager();
  try {
    const session = (manager as any).session("compact-resources");
    const resource = { asset: "atlas", revision: 1, width: 2, height: 2, psm: 1,
      bytesEncoding: "base64", pixels: Buffer.from([0, 1, 2, 3]).toString("base64"),
      palette: Buffer.from([7, 8, 9, 255]).toString("base64") };
    session.updateResourceCache({ resources: [resource] });
    const packet = session.encodeExternalPacket({ type: "frame", frame: { resources: [resource] } });
    const descriptor = JSON.parse(new TextDecoder().decode(packet).slice(6)).frame.resources[0];
    assert.equal(descriptor.bytesEncoding, "external");
    assert.equal(descriptor.pixelsBytes, 4);
    assert.equal(descriptor.paletteBytes, 4);
    assert.equal(descriptor.pixels, undefined);
    assert.equal(descriptor.palette, undefined);
    for (const [part, expected] of [["pixels", [0, 1, 2, 3]], ["palette", [7, 8, 9, 255]]] as const) {
      const url = `http://localhost${descriptor[`${part}Url`]}`;
      const response = await manager.handle(new Request(url), "compact-resources");
      assert.equal(response.status, 200);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...expected]);
      const head = await manager.handle(new Request(url, { method: "HEAD" }), "compact-resources");
      assert.equal(head.headers.get("content-length"), "4");
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    assert.equal(session.resourceCache.get("atlas"), resource);
    assert.equal(typeof resource.pixels, "string");
  } finally { await manager.dispose(); }
});

test("HTTP textures use scoped raw bytes while SSE remains metadata and stale URLs expire", async () => {
  const manager = createPreviewManager({ artifacts: { bytecodePath: "/unused", pakPath: "/unused" } });
  const session = (manager as any).session("resource-transport");
  const resource = { asset: "texture/a", revision: 7, width: 1, height: 1, psm: 0, pixels: [1, 2, 3, 255] };
  session.updateResourceCache({ resources: [resource] });
  const packet = session.encodeExternalPacket({ type: "frame", frame: { resources: [resource] } });
  const wire = JSON.parse(new TextDecoder().decode(packet).slice(6));
  const descriptor = wire.frame.resources[0];
  assert.equal(descriptor.pixels, undefined);
  assert.equal(descriptor.pixelsBytes, 4);
  assert.deepEqual(resource.pixels, [1, 2, 3, 255]);
  const url = `http://localhost${descriptor.pixelsUrl}`;
  const response = await manager.handle(new Request(url), "resource-transport");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], resource.pixels);
  session.updateResourceCache({ resources: [{ ...resource, revision: 8 }] });
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  // A guest may omit or reuse its native revision. The retained bytes still
  // need a new URL so an old in-flight fetch cannot win after replacement.
  session.updateResourceCache({ resources: [{ ...resource, pixels: [4, 5, 6, 255] }] });
  const replacement = JSON.parse(new TextDecoder().decode(session.encodeExternalPacket({ type: "frame", frame: { resources: [...session.resourceCache.values()] } })).slice(6)).frame.resources[0];
  assert.notEqual(replacement.pixelsUrl, descriptor.pixelsUrl);
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  session.updateResourceCache({ resources: [resource] });
  await session.stopProbe();
  session.updateResourceCache({ resources: [resource] });
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  await manager.dispose();
});
