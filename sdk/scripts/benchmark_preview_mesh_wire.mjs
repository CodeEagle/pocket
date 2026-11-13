#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createPreviewMeshWireDecoder,
  createPreviewMeshWireEncoder,
} from "../editor/preview_mesh_wire.ts";

const sampleUrl = process.argv[2] || new URL("../.pocket-build/live2d-user-frame.json", import.meta.url);
const canonicalFrame = JSON.parse(readFileSync(sampleUrl, "utf8"));
canonicalFrame.resources = [];

assert.equal(typeof canonicalFrame.frame, "number", "Expected canonical top-level .frame to be a number");
assert.ok(Array.isArray(canonicalFrame.ops) && canonicalFrame.ops.some(op => op.type === "textureTriangle"), "Expected a real mesh DrawOp frame");

function buildMovedFrame(base) {
  const moved = JSON.parse(JSON.stringify(base));
  moved.frame = base.frame + 1;
  for (let i = 0; i < moved.ops.length; i += 1) {
    const op = moved.ops[i];
    if (op && (op.type === "textureTriangle" || op.type === "textureTriangleRepeat") && Array.isArray(op.points)) {
      for (let p = 0; p < op.points.length; p += 1) {
        op.points[p].x += 0.25;
        op.points[p].y -= 0.125;
      }
      if (typeof op.x === "number" && typeof op.y === "number") {
        op.x = Math.min(op.points[0].x, op.points[1].x, op.points[2].x);
        op.y = Math.min(op.points[0].y, op.points[1].y, op.points[2].y);
      }
    }
  }
  return moved;
}

const movedFrame = buildMovedFrame(canonicalFrame);
const sameFrame = JSON.parse(JSON.stringify(movedFrame));
sameFrame.frame = movedFrame.frame + 1;

const baselinePacket = { type: "frame", frame: canonicalFrame };
const movedPacket = { type: "frame", frame: movedFrame };
const samePacket = { type: "frame", frame: sameFrame };

// Verify exact lossless roundtrip before timing
{
  const enc = createPreviewMeshWireEncoder();
  const dec = createPreviewMeshWireDecoder();
  const coldWire = JSON.stringify(enc.encode(baselinePacket));
  const movedWire = JSON.stringify(enc.encode(movedPacket));
  const sameWire = JSON.stringify(enc.encode(samePacket));

  const coldDecoded = dec.decode(JSON.parse(coldWire));
  const movedDecoded = dec.decode(JSON.parse(movedWire));
  const sameDecoded = dec.decode(JSON.parse(sameWire));

  assert.deepStrictEqual(coldDecoded, baselinePacket);
  assert.deepStrictEqual(movedDecoded, movedPacket);
  assert.deepStrictEqual(sameDecoded, samePacket);
}

const iterations = 40;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Warmup
for (let i = 0; i < 8; i += 1) {
  const s = JSON.stringify(baselinePacket);
  JSON.parse(s);
  const enc = createPreviewMeshWireEncoder();
  const dec = createPreviewMeshWireDecoder();
  for (const pkt of [baselinePacket, movedPacket, samePacket]) {
    const w = JSON.stringify(enc.encode(pkt));
    dec.decode(JSON.parse(w));
  }
}

// 1. Baseline JSON
const baselineStringifyMs = [];
const baselineParseMs = [];
let baselineBytes = 0;

for (let i = 0; i < iterations; i += 1) {
  const t0 = performance.now();
  const json = JSON.stringify(baselinePacket);
  const t1 = performance.now();
  const parsed = JSON.parse(json);
  const t2 = performance.now();
  if (!parsed) throw new Error("unreachable");
  baselineBytes = Buffer.byteLength(json, "utf8");
  baselineStringifyMs.push(t1 - t0);
  baselineParseMs.push(t2 - t1);
}

// 2. MeshWire Cold, Warm (positions changed), Warm (same geometry)
const coldEncodeStringifyMs = [];
const coldParseDecodeMs = [];
const movedEncodeStringifyMs = [];
const movedParseDecodeMs = [];
const sameEncodeStringifyMs = [];
const sameParseDecodeMs = [];

let coldBytes = 0;
let movedBytes = 0;
let sameBytes = 0;

for (let i = 0; i < iterations; i += 1) {
  const enc = createPreviewMeshWireEncoder();
  const dec = createPreviewMeshWireDecoder();

  // Cold
  const c0 = performance.now();
  const coldWire = JSON.stringify(enc.encode(baselinePacket));
  const c1 = performance.now();
  const coldRestored = dec.decode(JSON.parse(coldWire));
  const c2 = performance.now();
  if (!coldRestored) throw new Error("unreachable");
  coldBytes = Buffer.byteLength(coldWire, "utf8");
  coldEncodeStringifyMs.push(c1 - c0);
  coldParseDecodeMs.push(c2 - c1);

  // Warm - Positions Changed
  const m0 = performance.now();
  const movedWire = JSON.stringify(enc.encode(movedPacket));
  const m1 = performance.now();
  const movedRestored = dec.decode(JSON.parse(movedWire));
  const m2 = performance.now();
  if (!movedRestored) throw new Error("unreachable");
  movedBytes = Buffer.byteLength(movedWire, "utf8");
  movedEncodeStringifyMs.push(m1 - m0);
  movedParseDecodeMs.push(m2 - m1);

  // Warm - Unchanged Geometry
  const s0 = performance.now();
  const sameWire = JSON.stringify(enc.encode(samePacket));
  const s1 = performance.now();
  const sameRestored = dec.decode(JSON.parse(sameWire));
  const s2 = performance.now();
  if (!sameRestored) throw new Error("unreachable");
  sameBytes = Buffer.byteLength(sameWire, "utf8");
  sameEncodeStringifyMs.push(s1 - s0);
  sameParseDecodeMs.push(s2 - s1);
}

const summary = {
  sample: String(sampleUrl),
  frameNumber: canonicalFrame.frame,
  totalOps: canonicalFrame.ops.length,
  iterations,
  baselineJson: {
    wireBytes: baselineBytes,
    stringifyMedianMs: Number(median(baselineStringifyMs).toFixed(3)),
    parseMedianMs: Number(median(baselineParseMs).toFixed(3)),
    totalMedianMs: Number(median(baselineStringifyMs.map((ms, i) => ms + baselineParseMs[i])).toFixed(3)),
  },
  retainedV1Cold: {
    wireBytes: coldBytes,
    byteReductionPct: Number((((baselineBytes - coldBytes) / baselineBytes) * 100).toFixed(2)),
    encodeAndStringifyMedianMs: Number(median(coldEncodeStringifyMs).toFixed(3)),
    parseAndDecodeMedianMs: Number(median(coldParseDecodeMs).toFixed(3)),
    totalMedianMs: Number(median(coldEncodeStringifyMs.map((ms, i) => ms + coldParseDecodeMs[i])).toFixed(3)),
  },
  retainedV1MovedPositions: {
    wireBytes: movedBytes,
    byteReductionPct: Number((((baselineBytes - movedBytes) / baselineBytes) * 100).toFixed(2)),
    encodeAndStringifyMedianMs: Number(median(movedEncodeStringifyMs).toFixed(3)),
    parseAndDecodeMedianMs: Number(median(movedParseDecodeMs).toFixed(3)),
    totalMedianMs: Number(median(movedEncodeStringifyMs.map((ms, i) => ms + movedParseDecodeMs[i])).toFixed(3)),
  },
  retainedV1SameGeometry: {
    wireBytes: sameBytes,
    byteReductionPct: Number((((baselineBytes - sameBytes) / baselineBytes) * 100).toFixed(2)),
    encodeAndStringifyMedianMs: Number(median(sameEncodeStringifyMs).toFixed(3)),
    parseAndDecodeMedianMs: Number(median(sameParseDecodeMs).toFixed(3)),
    totalMedianMs: Number(median(sameEncodeStringifyMs.map((ms, i) => ms + sameParseDecodeMs[i])).toFixed(3)),
  },
};

console.log(JSON.stringify(summary, null, 2));
