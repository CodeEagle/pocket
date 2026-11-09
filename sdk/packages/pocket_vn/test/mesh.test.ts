import { expect, test } from "bun:test";
import { encodeNovelMesh } from "../src/mesh.ts";

test("mesh encoding reuses storage and rejects invalid updates atomically", () => {
  const geometry = { vertices: [0, 0, 0, 0, 100, 0, 1, 0, 50, 100, .5, 1], indices: [0, 1, 2], color: 0x80ffffff };
  const bytes = encodeNovelMesh(geometry);
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x31534d50);
  expect(bytes.byteLength).toBe(76);
  geometry.vertices[0] = 10;
  expect(encodeNovelMesh(geometry, bytes)).toBe(bytes);
  const before = bytes.slice();
  expect(() => encodeNovelMesh({ ...geometry, indices: [0, 1, 3] }, bytes)).toThrow("index");
  expect(bytes).toEqual(before);
  expect(() => encodeNovelMesh({ ...geometry, vertices: [NaN, ...geometry.vertices.slice(1)] }, bytes)).toThrow("position");
  expect(bytes).toEqual(before);
});

test("Float32Array PMS1 writes match the wire format and preserve reusable storage", () => {
  const geometry = { vertices: new Float32Array([0, 0, 0.1, 0.2, 100, 0, 1, 0.9, 50, 100, .5, 1]), indices: [0, 1, 2], color: 0x80ffffff };
  const bytes = encodeNovelMesh(geometry);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x31534d50);
  expect(view.getUint32(4, true)).toBe(3);
  expect(view.getUint32(8, true)).toBe(3);
  expect(view.getUint32(12, true)).toBe(0x80ffffff);
  for (let index = 0; index < geometry.vertices.length; index++) {
    expect(view.getFloat32(16 + index * 4, true)).toBe(geometry.vertices[index]);
  }
  for (let index = 0; index < geometry.indices.length; index++) {
    expect(view.getUint32(16 + geometry.vertices.length * 4 + index * 4, true)).toBe(geometry.indices[index]);
  }
  const reuse = new Uint8Array(bytes.length);
  expect(encodeNovelMesh(geometry, reuse)).toBe(reuse);
  expect(reuse).toEqual(bytes);
});

test("mesh encoder falls back without reading generic ArrayLike buffer getters", () => {
  const values = [0, 0, .1, .2, 100, 0, 1, .9, 50, 100, .5, 1];
  const vertices = Object.create(null) as { length: number; [index: number]: number; readonly buffer?: unknown };
  vertices.length = values.length;
  for (let index = 0; index < values.length; index++) vertices[index] = values[index]!;
  Object.defineProperty(vertices, "buffer", { get() { throw new Error("generic ArrayLike buffer must not be read"); } });
  const expected = encodeNovelMesh({ vertices: values, indices: [0, 1, 2], color: 0x80ffffff });
  expect(encodeNovelMesh({ vertices, indices: [0, 1, 2], color: 0x80ffffff })).toEqual(expected);
});

test("typed mesh update validates Float32 values before modifying reused bytes", () => {
  const geometry = { vertices: new Float32Array([0, 0, .1, .2, 100, 0, 1, .9, 50, 100, .5, 1]), indices: [0, 1, 2] };
  const reuse = encodeNovelMesh(geometry);
  const before = reuse.slice();
  geometry.vertices[2] = 1e40;
  expect(() => encodeNovelMesh(geometry, reuse)).toThrow("position");
  expect(reuse).toEqual(before);
});

test("mesh encoder uses the captured ArrayLike index count", () => {
  let lengthReads = 0;
  const indices = { get length() { lengthReads++; return lengthReads === 1 ? 3 : 1; }, 0: 0, 1: 1, 2: 2 };
  const bytes = encodeNovelMesh({ vertices: new Float32Array([0, 0, 0, 0, 10, 0, 1, 0, 0, 10, 0, 1]), indices });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(lengthReads).toBe(1);
  expect([0, 1, 2].map(index => view.getUint32(64 + index * 4, true))).toEqual([0, 1, 2]);
});
