import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";
import {
  PREVIEW_MESH_WIRE_CODEC,
  previewMeshWireDecoderSource,
  createPreviewMeshWireDecoder,
  createPreviewMeshWireEncoder,
} from "../preview_mesh_wire";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeTriangle(
  xOffset: number,
  yOffset: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const x0 = 10.125 + xOffset;
  const y0 = 20.375 + yOffset;
  const x1 = 30.625 + xOffset;
  const y1 = 22.875 + yOffset;
  const x2 = 18.5 + xOffset;
  const y2 = 44.25 + yOffset;
  return {
    type: "textureTriangle",
    asset: "atlas-main",
    x: Math.min(x0, x1, x2),
    y: Math.min(y0, y1, y2),
    w: 20.50000011920929,
    h: 23.875000953674316,
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    uvs: [0.125, 0.25, 0.625, 0.25, 0.375, 0.875],
    color: 4294967295,
    ...extra,
  };
}

test.skipIf(!existsSync(new URL("../../.pocket-build/live2d-user-frame.json", import.meta.url)))("lossless roundtrip on saved Hiyori Live2D canonical frame across cold, moved, and unchanged frames", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../.pocket-build/live2d-user-frame.json", import.meta.url), "utf8"),
  );
  raw.resources = [];
  assert.equal(typeof raw.frame, "number");
  assert.equal(raw.ops.length, 3519);

  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();

  // 1. Cold frame
  const coldPacket = JSON.parse(JSON.stringify(encoder.encode({ type: "frame", revision: 1, frame: raw })));
  assert.equal(coldPacket.frame.meshWire, PREVIEW_MESH_WIRE_CODEC);
  const defineTuples = coldPacket.frame.ops.filter((op: unknown) => Array.isArray(op) && op[0] === "d");
  assert.ok(defineTuples.length >= 30, `expected >= 30 mesh run definitions, got ${defineTuples.length}`);
  const decodedCold = decoder.decode(coldPacket) as { type: string; revision: number; frame: unknown };
  assert.deepStrictEqual(decodedCold.frame, raw);

  // 2. Warm frame with moved positions
  const movedFrame = cloneJson(raw);
  movedFrame.frame = raw.frame + 1;
  for (const op of movedFrame.ops) {
    if (op.type === "textureTriangle" || op.type === "textureTriangleRepeat") {
      for (const pt of op.points) {
        pt.x += 0.3333333333333333;
        pt.y -= 0.14285714285714285;
      }
      op.x = Math.min(op.points[0].x, op.points[1].x, op.points[2].x);
      op.y = Math.min(op.points[0].y, op.points[1].y, op.points[2].y);
    }
  }
  const movedPacket = JSON.parse(JSON.stringify(encoder.encode({ type: "frame", revision: 2, frame: movedFrame })));
  const updateTuples = movedPacket.frame.ops.filter((op: unknown) => Array.isArray(op) && op[0] === "u");
  assert.equal(updateTuples.length, defineTuples.length);
  const decodedMoved = decoder.decode(movedPacket) as { type: string; revision: number; frame: unknown };
  assert.deepStrictEqual(decodedMoved.frame, movedFrame);

  // 3. Warm frame with unchanged geometry
  const sameFrame = cloneJson(movedFrame);
  sameFrame.frame = movedFrame.frame + 1;
  const samePacket = JSON.parse(JSON.stringify(encoder.encode({ type: "frame", revision: 3, frame: sameFrame })));
  const sameTuples = samePacket.frame.ops.filter((op: unknown) => Array.isArray(op) && op[0] === "s");
  assert.equal(sameTuples.length, defineTuples.length);
  const decodedSame = decoder.decode(samePacket) as { type: string; revision: number; frame: unknown };
  assert.deepStrictEqual(decodedSame.frame, sameFrame);
});

test("preserves non-integer coordinates, stride 6/8/10, UV repeat, vertex alpha, masks, clips, and unknown op fields", () => {
  const stride6A = {
    type: "textureTriangle",
    asset: "tex-a",
    repeatTexture: true,
    color: 0x80ff4020,
    clip: { x: 1.5, y: 2.5, w: 120.25, h: 240.75, radius: 4.125 },
    customUnknownMeta: { tag: "keep-me", weights: [0.1, 0.2, 0.3], flags: { a: true, b: null } },
    points: [
      { x: 1.1111111111111112, y: 2.2222222222222223 },
      { x: 15.333333333333334, y: 4.444444444444445 },
      { x: 8.555555555555555, y: 19.666666666666668 },
    ],
    uvs: [0.0, 0.0, 2.5, 0.0, 1.25, 3.75],
  };
  const stride6B = {
    ...cloneJson(stride6A),
    points: [
      { x: 21.11111111111111, y: 12.222222222222221 },
      { x: 35.333333333333336, y: 14.444444444444445 },
      { x: 28.555555555555557, y: 29.666666666666668 },
    ],
    uvs: [0.25, 0.5, 2.75, 0.5, 1.5, 4.25],
  };

  // Stride 10: explicit x/y that differ from Math.min(points)
  const stride10A = {
    type: "textureTriangleRepeat",
    asset: "tex-repeat",
    x: 99.123456789,
    y: 88.987654321,
    w: 45.5,
    h: 67.25,
    color: 0xcc112233,
    atlasRegion: { u0: 0, v0: 0, u1: 1, v1: 1 },
    points: [
      { x: 10.5, y: 11.25 },
      { x: 30.75, y: 15.125 },
      { x: 22.875, y: 40.625 },
    ],
    uvs: [0, 0, 4, 0, 4, 4],
  };
  const stride10B = {
    ...cloneJson(stride10A),
    x: 199.123456789,
    y: 188.987654321,
    points: [
      { x: 50.5, y: 61.25 },
      { x: 70.75, y: 65.125 },
      { x: 62.875, y: 90.625 },
    ],
  };
  const stride10C = {
    ...cloneJson(stride10A),
    x: 299.123456789,
    y: 288.987654321,
    points: [
      { x: 80.5, y: 91.25 },
      { x: 100.75, y: 95.125 },
      { x: 92.875, y: 120.625 },
    ],
  };

  const frame = {
    frame: 42,
    width: 375,
    height: 812,
    extraRootField: { preserved: true },
    ops: [
      { type: "meshLayerBegin", id: "layer-1", opacity: 0.85, blend: "multiply" },
      { type: "meshMaskBegin", inverted: false },
      stride6A,
      stride6B,
      { type: "meshMaskEnd" },
      stride10A,
      stride10B,
      stride10C,
      { type: "meshLayerRestore", id: "layer-1" },
    ],
    events: [],
    resources: [],
  };

  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();
  const encoded = encoder.encode(frame) as Record<string, unknown>;
  assert.equal(encoded.meshWire, PREVIEW_MESH_WIRE_CODEC);
  const wireRoundtrip = decoder.decode(JSON.parse(JSON.stringify(encoded))) as typeof frame;
  assert.deepStrictEqual(wireRoundtrip, frame);
});

test("unsupported ops and points with unknown fields stay canonical without dropping", () => {
  const badPointsOp1 = {
    ...makeTriangle(0, 0),
    points: [
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5 },
      { x: 6, y: 7 },
    ],
  };
  const badPointsOp2 = {
    ...makeTriangle(10, 10),
    points: [
      { x: 11, y: 12, w: 1 },
      { x: 14, y: 15 },
      { x: 16, y: 17 },
    ],
  };
  const unknownOp = { type: "futureCustomOp", payload: { any: [1, 2, 3] } };
  const singleTri = makeTriangle(5, 5, { asset: "isolated-single" });

  const frame = {
    frame: 7,
    width: 200,
    height: 200,
    ops: [
      badPointsOp1,
      badPointsOp2,
      unknownOp,
      singleTri,
      makeTriangle(0, 0, { asset: "valid-run" }),
      makeTriangle(20, 0, { asset: "valid-run" }),
      makeTriangle(40, 0, { asset: "valid-run" }),
    ],
  };

  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();
  const encoded = encoder.encode(frame) as typeof frame & { meshWire?: string };
  assert.equal(encoded.meshWire, PREVIEW_MESH_WIRE_CODEC);
  assert.deepStrictEqual(encoded.ops[0], badPointsOp1);
  assert.deepStrictEqual(encoded.ops[1], badPointsOp2);
  assert.deepStrictEqual(encoded.ops[2], unknownOp);
  assert.deepStrictEqual(encoded.ops[3], singleTri);
  assert.ok(Array.isArray(encoded.ops[4]));

  const restored = decoder.decode(JSON.parse(JSON.stringify(encoded)));
  assert.deepStrictEqual(restored, frame);
});

test("changed UVs, op order, clip, color, or atlas metadata create fresh definitions", () => {
  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();

  const baseFrame = {
    frame: 1,
    ops: [
      makeTriangle(0, 0, { clip: { x: 0, y: 0, w: 100, h: 100 } }),
      makeTriangle(10, 0, { clip: { x: 0, y: 0, w: 100, h: 100 } }),
      makeTriangle(20, 0, { clip: { x: 0, y: 0, w: 100, h: 100 } }),
    ],
  };

  const enc1 = JSON.parse(JSON.stringify(encoder.encode(baseFrame)));
  assert.equal(enc1.ops[0][0], "d");
  const firstId = enc1.ops[0][1];
  assert.deepStrictEqual(decoder.decode(enc1), baseFrame);

  // Change UVs -> must emit fresh "d" definition
  const uvChanged = cloneJson(baseFrame);
  uvChanged.frame = 2;
  (uvChanged.ops[1]!.uvs as number[])[0] = 0.999;
  const encUv = JSON.parse(JSON.stringify(encoder.encode(uvChanged)));
  assert.equal(encUv.ops[0][0], "d");
  assert.notEqual(encUv.ops[0][1], firstId);
  assert.deepStrictEqual(decoder.decode(encUv), uvChanged);

  // Change clip metadata -> must emit fresh "d" definition
  const clipChanged = cloneJson(uvChanged);
  clipChanged.frame = 3;
  (clipChanged.ops[0]!.clip as Record<string, number>).w = 50;
  (clipChanged.ops[1]!.clip as Record<string, number>).w = 50;
  (clipChanged.ops[2]!.clip as Record<string, number>).w = 50;
  const encClip = JSON.parse(JSON.stringify(encoder.encode(clipChanged)));
  assert.equal(encClip.ops[0][0], "d");
  assert.deepStrictEqual(decoder.decode(encClip), clipChanged);

  // Change asset / atlas metadata -> must emit fresh "d" definition
  const assetChanged = cloneJson(clipChanged);
  assetChanged.frame = 4;
  for (const op of assetChanged.ops) op.asset = "atlas-alt";
  const encAsset = JSON.parse(JSON.stringify(encoder.encode(assetChanged)));
  assert.equal(encAsset.ops[0][0], "d");
  assert.deepStrictEqual(decoder.decode(encAsset), assetChanged);
});

test("in-place mutation of frame ops/points never causes false skips and decoded frames stay immutable", () => {
  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();

  const sharedFrame = {
    frame: 1,
    ops: [
      makeTriangle(0, 0),
      makeTriangle(10, 0),
      makeTriangle(20, 0),
    ],
  };

  const packet1 = JSON.parse(JSON.stringify(encoder.encode(sharedFrame)));
  const decoded1 = decoder.decode(packet1) as typeof sharedFrame;
  const decoded1Snapshot = cloneJson(decoded1);

  // Mutate sharedFrame in-place (same array and point object identities)
  sharedFrame.frame = 2;
  const pt0 = (sharedFrame.ops[0]!.points as Array<{ x: number; y: number }>)[0]!;
  pt0.x += 7.5;
  sharedFrame.ops[0]!.x = Math.min(
    pt0.x,
    (sharedFrame.ops[0]!.points as Array<{ x: number; y: number }>)[1]!.x,
    (sharedFrame.ops[0]!.points as Array<{ x: number; y: number }>)[2]!.x,
  );

  const packet2 = JSON.parse(JSON.stringify(encoder.encode(sharedFrame)));
  assert.equal(packet2.ops[0][0], "u", "in-place point mutation must emit position update 'u', not 's'");
  const decoded2 = decoder.decode(packet2) as typeof sharedFrame;
  assert.deepStrictEqual(decoded2, sharedFrame);
  assert.deepStrictEqual(decoded1, decoded1Snapshot, "previous decoded frame must remain immutable");
});

test("encoder/decoder reset produces self-contained first reconnect packet and rejects stale/malformed refs", () => {
  const encoder = createPreviewMeshWireEncoder();
  const decoder = createPreviewMeshWireDecoder();

  const frame1 = {
    frame: 1,
    ops: [makeTriangle(0, 0), makeTriangle(10, 0), makeTriangle(20, 0)],
  };
  const pkt1 = JSON.parse(JSON.stringify(encoder.encode(frame1)));
  assert.deepStrictEqual(decoder.decode(pkt1), frame1);

  // Reset encoder (simulating new SSE connection): next packet must be self-contained "d"
  encoder.reset();
  decoder.reset();
  const pktReconnect = JSON.parse(JSON.stringify(encoder.encode(frame1)));
  assert.equal(pktReconnect.ops[0][0], "d");
  assert.deepStrictEqual(decoder.decode(pktReconnect), frame1);

  // If decoder resets (reconnect) but receives a stale "s" or "u" reference, it must throw
  decoder.reset();
  assert.throws(
    () => decoder.decode({ frame: 2, meshWire: PREVIEW_MESH_WIRE_CODEC, ops: [["s", 1]] }),
    /Missing meshWire slot reference/,
  );
  assert.throws(
    () => decoder.decode({ frame: 2, meshWire: PREVIEW_MESH_WIRE_CODEC, ops: [["u", 999, "AAAAAAAA"]] }),
    /Missing meshWire slot reference/,
  );
  assert.throws(
    () => decoder.decode({ frame: 2, meshWire: "unknown-v99", ops: [] }),
    /Unsupported preview meshWire codec/,
  );
  assert.throws(
    () => decoder.decode({ frame: 2, ops: [["s", 1]] }),
    /Unexpected mesh wire placeholder in unencoded frame/,
  );
});

test("bounded cache evicts oldest slots deterministically while keeping IDs coherent", () => {
  const encoder = createPreviewMeshWireEncoder({ maxSlots: 2, maxBytes: 64 * 1024 });
  const decoder = createPreviewMeshWireDecoder({ maxSlots: 2, maxBytes: 64 * 1024 });

  const frameWithThreeRuns = {
    frame: 1,
    ops: [
      makeTriangle(0, 0, { asset: "run-1" }),
      makeTriangle(5, 0, { asset: "run-1" }),
      makeTriangle(10, 0, { asset: "run-1" }),
      makeTriangle(0, 10, { asset: "run-2" }),
      makeTriangle(5, 10, { asset: "run-2" }),
      makeTriangle(10, 10, { asset: "run-2" }),
      makeTriangle(0, 20, { asset: "run-3" }),
      makeTriangle(5, 20, { asset: "run-3" }),
      makeTriangle(10, 20, { asset: "run-3" }),
    ],
  };

  const pkt1 = JSON.parse(JSON.stringify(encoder.encode(frameWithThreeRuns)));
  assert.deepStrictEqual(decoder.decode(pkt1), frameWithThreeRuns);

  // Next frame with same 3 runs: run-1 was evicted when run-3 was inserted (maxSlots=2),
  // so run-1 is re-defined with a new slot id while stays coherent between encoder and decoder.
  const frame2 = cloneJson(frameWithThreeRuns);
  frame2.frame = 2;
  const pkt2 = JSON.parse(JSON.stringify(encoder.encode(frame2)));
  assert.deepStrictEqual(decoder.decode(pkt2), frame2);
});

for (const forceCanvas of [false, true]) {
  test(`browser SSE meshWire codec renders identical pixels, updates geometry, and recovers on reconnect (${forceCanvas ? "Canvas" : "GPU"})`, { timeout: 30_000 }, async () => {
    const source = previewMeshWireDecoderSource() + "\n" + readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><body></body>", { headers: { "content-type": "text/html" } }),
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addInitScript((forceCanvasMode: boolean) => {
        if (forceCanvasMode) {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (kind: any, ...args: any[]) {
            return kind === "webgl2" ? null : original.call(this, kind, ...args);
          } as any;
        }
        (window as any).createdStreams = [];
        (window as any).EventSource = class {
          url: string;
          readyState = 1;
          onopen: (() => void) | null = null;
          onmessage: ((event: { data: string }) => void) | null = null;
          onerror: (() => void) | null = null;
          constructor(url: string) {
            this.url = url;
            (window as any).fixtureSource = this;
            (window as any).createdStreams.push(this);
          }
          close() {
            this.readyState = 2;
          }
        };
      }, forceCanvas);

      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.addScriptTag({ content: source });

      // Build canonical and encoded packets in Node using createPreviewMeshWireEncoder
      const encoder = createPreviewMeshWireEncoder();
      const resources = [
        {
          asset: "checker",
          width: 4,
          height: 4,
          psm: 3,
          pixels: [
            255, 40, 40, 255, 40, 255, 40, 255, 255, 40, 40, 255, 40, 255, 40, 255,
            40, 40, 255, 255, 255, 255, 40, 255, 40, 40, 255, 255, 255, 255, 40, 255,
            255, 40, 40, 255, 40, 255, 40, 255, 255, 40, 40, 255, 40, 255, 40, 255,
            40, 40, 255, 255, 255, 255, 40, 255, 40, 40, 255, 255, 255, 255, 40, 255,
          ],
        },
      ];

      function buildMeshFrame(frameNum: number, shiftX: number, includeResources: boolean) {
        const ops: any[] = [{ type: "rect", x: 0, y: 0, w: 64, h: 64, color: 0xff101820 }];
        const cells = 4;
        for (let gy = 0; gy < cells; gy += 1) {
          for (let gx = 0; gx < cells; gx += 1) {
            const x0 = 6 + shiftX + gx * 8;
            const y0 = 8 + gy * 8;
            const x1 = x0 + 8;
            const y1 = y0 + 8;
            ops.push(
              {
                type: "textureTriangle",
                asset: "checker",
                repeatTexture: true,
                color: 0xffffffff,
                x: x0,
                y: y0,
                w: 8,
                h: 8,
                points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }],
                uvs: [0, 0, 1, 0, 1, 1],
              },
              {
                type: "textureTriangle",
                asset: "checker",
                repeatTexture: true,
                color: 0xffffffff,
                x: x0,
                y: y0,
                w: 8,
                h: 8,
                points: [{ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
                uvs: [0, 0, 1, 1, 0, 1],
              },
            );
          }
        }
        return {
          frame: frameNum,
          width: 64,
          height: 64,
          ops,
          events: [],
          resources: includeResources ? resources : [],
        };
      }

      const canonical1 = buildMeshFrame(1, 0, true);
      const canonical2 = buildMeshFrame(2, 18, false);
      const canonical3 = buildMeshFrame(3, 18, false);

      const encoded1 = encoder.encode({ type: "frame", revision: 1, frame: canonical1 });
      const encoded2 = encoder.encode({ type: "frame", revision: 2, frame: canonical2 });
      const encoded3 = encoder.encode({ type: "frame", revision: 3, frame: canonical3 });

      encoder.reset();
      const reconnectFreshEncoded = encoder.encode({ type: "frame", revision: 4, frame: canonical2 });

      const result = await page.evaluate(
        async ({ canonical1, canonical2, encoded1, encoded2, encoded3, reconnectFreshEncoded }) => {
          // Mount 1: Baseline canonical frames
          const rootA = document.createElement("div");
          document.body.append(rootA);
          const instA = (window as any).PocketEditorPreview.mount(rootA, { projectId: "canon", width: 64, height: 64 });
          const streamA = (window as any).fixtureSource;
          streamA.onopen?.();
          streamA.onmessage({ data: JSON.stringify({ type: "frame", frame: canonical1 }) });
          const pixelsCanon1 = Array.from(instA.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);
          streamA.onmessage({ data: JSON.stringify({ type: "frame", frame: canonical2 }) });
          const pixelsCanon2 = Array.from(instA.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);
          await instA.close();

          // Mount 2: Encoded meshWire frames (d -> u -> s)
          const rootB = document.createElement("div");
          document.body.append(rootB);
          const instB = (window as any).PocketEditorPreview.mount(rootB, { projectId: "wire", width: 64, height: 64 });
          const streamB = (window as any).fixtureSource;
          const streamUrl = streamB.url;
          streamB.onopen?.();

          streamB.onmessage({ data: JSON.stringify(encoded1) });
          const pixelsWire1 = Array.from(instB.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);
          const installedFrame1 = JSON.parse(JSON.stringify(instB.getFrame()));

          streamB.onmessage({ data: JSON.stringify(encoded2) });
          const pixelsWire2 = Array.from(instB.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);
          const installedFrame2 = JSON.parse(JSON.stringify(instB.getFrame()));

          streamB.onmessage({ data: JSON.stringify(encoded3) });
          const pixelsWire3 = Array.from(instB.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);

          // Simulate automatic browser EventSource reconnect on the SAME object:
          // onopen fires again, resetting the decoder so stale "s" references fail
          streamB.onopen?.();
          const streamsBeforeBadRef = (window as any).createdStreams.length;
          streamB.onmessage({ data: JSON.stringify(encoded3) });
          await new Promise((resolve) => setTimeout(resolve, 320));
          const streamsAfterBadRef = (window as any).createdStreams.length;

          // After automatic reconnect creates a fresh EventSource, feed fresh definition packet
          const streamReconnected = (window as any).fixtureSource;
          streamReconnected.onopen?.();
          streamReconnected.onmessage({ data: JSON.stringify(reconnectFreshEncoded) });
          const pixelsAfterReconnect = Array.from(instB.canvas.getContext("2d").getImageData(0, 0, 64, 64).data);

          await instB.close();
          return {
            streamUrl,
            pixelsCanon1,
            pixelsCanon2,
            pixelsWire1,
            pixelsWire2,
            pixelsWire3,
            pixelsAfterReconnect,
            installedFrame1,
            installedFrame2,
            streamsBeforeBadRef,
            streamsAfterBadRef,
          };
        },
        { canonical1, canonical2, encoded1, encoded2, encoded3, reconnectFreshEncoded },
      );

      assert.ok(
        result.streamUrl.includes("meshes=retained-v1"),
        `Expected SSE URL to negotiate meshes=retained-v1, got ${result.streamUrl}`,
      );
      assert.deepStrictEqual(result.installedFrame1, canonical1);
      assert.deepStrictEqual(result.installedFrame2, canonical2);
      assert.deepStrictEqual(result.pixelsWire1, result.pixelsCanon1, "cold encoded frame pixels must match canonical");
      assert.deepStrictEqual(result.pixelsWire2, result.pixelsCanon2, "moved encoded frame pixels must match canonical");
      assert.deepStrictEqual(result.pixelsWire3, result.pixelsCanon2, "same-geometry encoded frame pixels must match canonical");
      assert.notDeepStrictEqual(result.pixelsWire1, result.pixelsWire2, "geometry shift must change rendered pixels");
      assert.ok(
        result.streamsAfterBadRef > result.streamsBeforeBadRef,
        "stale reference after same-object onopen reset must close and reconnect the stream",
      );
      assert.deepStrictEqual(
        result.pixelsAfterReconnect,
        result.pixelsCanon2,
        "fresh definition after reconnect must restore exact rendered pixels",
      );
    } finally {
      await browser.close();
      await server.stop(true);
    }
  });
}
