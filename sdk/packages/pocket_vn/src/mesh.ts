/** PMS1 geometry for the pinned Core's retained 2D image mesh boundary. */
export interface NovelMeshGeometry {
  /** Interleaved local pixel x,y and texture u,v; UVs may cross atlas edges. */
  vertices: ArrayLike<number>;
  /** Triangle indices, in painter order. */
  indices: ArrayLike<number>;
  /** Native modulation color, 0xAABBGGRR (not Flutter ARGB). */
  color?: number;
}

const nativeLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

/** Reuse a same-sized buffer across frames; no second retained vertex copy. */
export function encodeNovelMesh(geometry: NovelMeshGeometry, reuse?: Uint8Array): Uint8Array {
  const vertices = geometry.vertices;
  const indices = geometry.indices;
  const n = vertices.length / 4;
  const m = indices.length;
  if (!Number.isInteger(n) || n < 1 || n > 16384 || m < 3 || m > 98304 || m % 3) throw new Error("Invalid Pocket mesh vertex/index counts");
  const color = geometry.color ?? 0xffffffff;
  if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new Error("Mesh color must be unsigned ABGR");
  // Validate before changing a caller's reused buffer.
  for (let i = 0; i < vertices.length; i++) {
    const value = vertices[i]!;
    if (!Number.isFinite(value) || Math.abs(value) > 1000000) throw new Error("Invalid mesh position/UV");
  }
  for (let i = 0; i < m; i++) if (!Number.isInteger(indices[i]) || indices[i]! < 0 || indices[i]! >= n) throw new Error("Mesh index outside vertex range");
  const length = 16 + n * 16 + m * 4;
  const result = reuse?.byteLength === length ? reuse : new Uint8Array(length);
  const standardFloat32 = ArrayBuffer.isView(vertices) && Object.getPrototypeOf(vertices) === Float32Array.prototype &&
    !Object.hasOwn(vertices, "length") && !Object.hasOwn(vertices, "buffer");
  const vertexBuffer = standardFloat32 ? (vertices as Float32Array).buffer : undefined;
  const indicesAreView = ArrayBuffer.isView(indices);
  const indicesBuffer = indicesAreView && !Object.hasOwn(indices, "buffer")
    ? (indices as unknown as { buffer: ArrayBufferLike }).buffer
    : undefined;
  const canUseTypedWrites = nativeLittleEndian && standardFloat32 && result.buffer instanceof ArrayBuffer &&
    vertexBuffer instanceof ArrayBuffer && indicesBuffer !== result.buffer &&
    (!indicesAreView || indicesBuffer instanceof ArrayBuffer) && vertexBuffer !== result.buffer && (result.byteOffset & 3) === 0;
  if (canUseTypedWrites) {
    const header = new Uint32Array(result.buffer, result.byteOffset, 4);
    header[0] = 0x31534d50;
    header[1] = n;
    header[2] = m;
    header[3] = color;
    new Float32Array(result.buffer, result.byteOffset + 16, vertices.length).set(vertices as Float32Array);
    const indexWords = new Uint32Array(result.buffer, result.byteOffset + 16 + n * 16, m);
    for (let i = 0; i < m; i++) indexWords[i] = indices[i]!;
    return result;
  }
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, 0x31534d50, true);
  view.setUint32(4, n, true);
  view.setUint32(8, m, true);
  view.setUint32(12, color, true);
  for (let i = 0; i < vertices.length; i++) view.setFloat32(16 + i * 4, vertices[i]!, true);
  for (let i = 0; i < m; i++) view.setUint32(16 + n * 16 + i * 4, indices[i]!, true);
  return result;
}
