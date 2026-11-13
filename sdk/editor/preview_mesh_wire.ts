/**
 * Browser-only lossless SSE mesh transport codec (`retained-v1`).
 *
 * Canonical native frames, snapshots, recordings and the native probe JSON
 * wire remain untouched. When a browser preview stream subscribes with
 * `meshes=retained-v1`, consecutive supported `textureTriangle` and
 * `textureTriangleRepeat` runs that share identical static metadata are
 * encoded into compact array placeholders with cached static metadata + UV
 * templates and explicit little-endian IEEE-754 Float64 base64 positions.
 *
 * Why Float64 is required for lossless browser wire transport:
 * Although native PMS1 buffers start as `f32`, `transformedChildOp` scales and
 * offsets child surface coordinates in JS double precision (`number`), and
 * `JSON.parse` produces IEEE-754 Float64 numbers whose exact decimal roundtrip
 * values (including `x`, `y`, `w`, `h` and `points`) would be altered by
 * quantizing back to `Float32Array`. Packing little-endian Float64 via
 * `DataView` preserves every JS numeric bit pattern (including `-0`) without
 * inventing a second layout or binary PMS1 engine.
 */

export const PREVIEW_MESH_WIRE_CODEC = "retained-v1" as const;
export const DEFAULT_MAX_MESH_WIRE_SLOTS = 64;
export const DEFAULT_MAX_MESH_WIRE_BYTES = 8 * 1024 * 1024;

export type PreviewMeshWireOptions = {
  maxSlots?: number;
  maxBytes?: number;
};

export type PreviewMeshWireEncoder = {
  encode(value: unknown): unknown;
  reset(): void;
};

export type PreviewMeshWireDecoder = {
  decode(value: unknown): unknown;
  reset(): void;
};

type JsonRecord = Record<string, unknown>;

type SupportedOpInfo = {
  meta: JsonRecord;
  metaKey: string;
  stride: 6 | 8 | 10;
};

type EncoderSlot = {
  id: number;
  metaKey: string;
  count: number;
  stride: 6 | 8 | 10;
  uvBytes: Uint8Array;
  posBytes: Uint8Array;
  byteSize: number;
};

type DecoderSlot = {
  id: number;
  count: number;
  stride: 6 | 8 | 10;
  meta: JsonRecord;
  uvs: number[];
  pos: number[];
  byteSize: number;
};

function isPlainObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("non-finite number in mesh metadata");
      return JSON.stringify(value); // Match metadata after JSON transport, including -0.
    }
    if (typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    throw new Error(`unsupported metadata value type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      items.push(canonicalJson(value[i]));
    }
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new Error("non-plain object in mesh metadata");
  }
  const keys = Object.keys(value).sort();
  const entries: string[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const item = value[key];
    if (item === undefined) throw new Error("undefined property in mesh metadata");
    entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${entries.join(",")}}`;
}

function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue) as unknown as T;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "__proto__") Object.defineProperty(out, key, { value: cloneJsonValue(record[key]), enumerable: true, writable: true, configurable: true });
    else out[key] = cloneJsonValue(record[key]);
  }
  return out as T;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameJsonValue(value, b[index]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameJsonValue(a[key], b[key]));
}

function extractSupportedOpMeta(op: unknown, template?: SupportedOpInfo): SupportedOpInfo | null {
  if (!isPlainObject(op)) return null;
  if (op.type !== "textureTriangle" && op.type !== "textureTriangleRepeat") return null;
  if (!Array.isArray(op.points) || op.points.length !== 3) return null;
  for (let i = 0; i < 3; i += 1) {
    const pt = op.points[i];
    if (!isPlainObject(pt)) return null;
    if (Object.keys(pt).length !== 2 || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) return null;
  }
  if (!Array.isArray(op.uvs) || op.uvs.length !== 6) return null;
  for (let i = 0; i < 6; i += 1) {
    if (!isFiniteNumber(op.uvs[i])) return null;
  }
  const hasX = Object.prototype.hasOwnProperty.call(op, "x");
  const hasY = Object.prototype.hasOwnProperty.call(op, "y");
  const hasW = Object.prototype.hasOwnProperty.call(op, "w");
  const hasH = Object.prototype.hasOwnProperty.call(op, "h");
  let stride: 6 | 8 | 10 = 6;
  if (hasX || hasY || hasW || hasH) {
    if (!(hasX && hasY && hasW && hasH)) return null;
    if (!isFiniteNumber(op.x) || !isFiniteNumber(op.y) || !isFiniteNumber(op.w) || !isFiniteNumber(op.h)) return null;
    const p0 = op.points[0] as { x: number; y: number };
    const p1 = op.points[1] as { x: number; y: number };
    const p2 = op.points[2] as { x: number; y: number };
    const minX = Math.min(p0.x, p1.x, p2.x);
    const minY = Math.min(p0.y, p1.y, p2.y);
    stride = Object.is(op.x, minX) && Object.is(op.y, minY) ? 8 : 10;
  }
  if (template) {
    if (stride !== template.stride) return null;
    let fields = 0;
    for (const key of Object.keys(op)) {
      if (key === "points" || key === "uvs" || key === "x" || key === "y" || key === "w" || key === "h") continue;
      if (!Object.prototype.hasOwnProperty.call(template.meta, key) || !sameJsonValue(op[key], template.meta[key])) return null;
      fields++;
    }
    return fields === Object.keys(template.meta).length ? template : null;
  }
  const meta: JsonRecord = {};
  for (const key of Object.keys(op)) {
    if (key === "points" || key === "uvs" || key === "x" || key === "y" || key === "w" || key === "h") continue;
    if (key === "__proto__") Object.defineProperty(meta, key, { value: op[key], enumerable: true, writable: true, configurable: true });
    else meta[key] = op[key];
  }
  try {
    const metaKey = `${stride}:${canonicalJson(meta)}`;
    return { meta: cloneJsonValue(meta), metaKey, stride };
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function encodeFloat64Le(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i += 1) {
    view.setFloat64(i * 8, values[i]!, true);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function createPreviewMeshWireEncoder(options: PreviewMeshWireOptions = {}): PreviewMeshWireEncoder {
  const maxSlots = Math.max(1, Math.trunc(options.maxSlots ?? DEFAULT_MAX_MESH_WIRE_SLOTS));
  const maxBytes = Math.max(256, Math.trunc(options.maxBytes ?? DEFAULT_MAX_MESH_WIRE_BYTES));
  const slots = new Map<string, EncoderSlot>();
  let totalBytes = 0;
  let nextSlotId = 1;

  function evictOldest(): void {
    const oldestKey = slots.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = slots.get(oldestKey);
      if (oldest) totalBytes = Math.max(0, totalBytes - oldest.byteSize);
      slots.delete(oldestKey);
    }
  }

  return {
    reset(): void {
      slots.clear();
      totalBytes = 0;
      nextSlotId = 1;
    },
    encode(value: unknown): unknown {
      if (!isPlainObject(value)) return value;
      const isEnvelope = value.type === "frame" && isPlainObject(value.frame) && Array.isArray(value.frame.ops);
      const isDirectFrame = !isEnvelope && typeof value.frame === "number" && Array.isArray(value.ops);
      if (!isEnvelope && !isDirectFrame) return value;

      const frameObj = (isEnvelope ? value.frame : value) as JsonRecord;
      if (Object.prototype.hasOwnProperty.call(frameObj, "meshWire") && frameObj.meshWire !== undefined) {
        return value;
      }
      const ops = frameObj.ops as unknown[];
      const outOps: unknown[] = [];
      let encodedAny = false;
      let runOrdinal = 0;
      let i = 0;

      while (i < ops.length) {
        const info0 = extractSupportedOpMeta(ops[i]);
        if (!info0) {
          outOps.push(ops[i]);
          i += 1;
          continue;
        }
        let j = i + 1;
        while (j < ops.length) {
          const infoJ = extractSupportedOpMeta(ops[j], info0);
          if (!infoJ || infoJ.metaKey !== info0.metaKey) break;
          j += 1;
        }
        const count = j - i;
        const currentOrdinal = runOrdinal;
        runOrdinal += 1;
        if (count < 2) {
          for (let k = i; k < j; k += 1) outOps.push(ops[k]);
          i = j;
          continue;
        }

        const stride = info0.stride;
        const posValues = new Array<number>(count * stride);
        const uvValues = new Array<number>(count * 6);
        let pIdx = 0;
        let uIdx = 0;
        for (let k = i; k < j; k += 1) {
          const op = ops[k] as JsonRecord;
          const pts = op.points as Array<{ x: number; y: number }>;
          const uvs = op.uvs as number[];
          posValues[pIdx++] = pts[0]!.x;
          posValues[pIdx++] = pts[0]!.y;
          posValues[pIdx++] = pts[1]!.x;
          posValues[pIdx++] = pts[1]!.y;
          posValues[pIdx++] = pts[2]!.x;
          posValues[pIdx++] = pts[2]!.y;
          if (stride === 8) {
            posValues[pIdx++] = op.w as number;
            posValues[pIdx++] = op.h as number;
          } else if (stride === 10) {
            posValues[pIdx++] = op.x as number;
            posValues[pIdx++] = op.y as number;
            posValues[pIdx++] = op.w as number;
            posValues[pIdx++] = op.h as number;
          }
          for (let u = 0; u < 6; u += 1) uvValues[uIdx++] = uvs[u]!;
        }

        const posBytes = encodeFloat64Le(posValues);
        const uvBytes = encodeFloat64Le(uvValues);
        const metaBytes = info0.metaKey.length * 2;
        const entryByteSize = posBytes.byteLength + uvBytes.byteLength + metaBytes;
        if (entryByteSize > maxBytes) {
          for (let k = i; k < j; k += 1) outOps.push(ops[k]);
          i = j;
          continue;
        }

        const slotKey = `${currentOrdinal}:${info0.metaKey}`;
        const existing = slots.get(slotKey);
        if (
          existing &&
          existing.count === count &&
          existing.stride === stride &&
          existing.metaKey === info0.metaKey &&
          bytesEqual(existing.uvBytes, uvBytes)
        ) {
          slots.delete(slotKey);
          slots.set(slotKey, existing);
          if (bytesEqual(existing.posBytes, posBytes)) {
            outOps.push(["s", existing.id]);
          } else {
            existing.posBytes = posBytes;
            outOps.push(["u", existing.id, bytesToBase64(posBytes)]);
          }
          encodedAny = true;
          i = j;
          continue;
        }

        const id = nextSlotId;
        const uvB64 = bytesToBase64(uvBytes);
        const posB64 = bytesToBase64(posBytes);
        const placeholder = ["d", id, count, stride, info0.meta, uvB64, posB64, ...(existing ? [existing.id] : [])];
        const rawSliceBytes = JSON.stringify(ops.slice(i, j)).length;
        const placeholderBytes = JSON.stringify(placeholder).length;
        if (placeholderBytes >= rawSliceBytes) {
          for (let k = i; k < j; k += 1) outOps.push(ops[k]);
          i = j;
          continue;
        }

        nextSlotId += 1;
        if (existing) {
          totalBytes = Math.max(0, totalBytes - existing.byteSize);
          slots.delete(slotKey);
        }
        while (slots.size >= maxSlots || (slots.size > 0 && totalBytes + entryByteSize > maxBytes)) {
          evictOldest();
        }
        slots.set(slotKey, {
          id,
          metaKey: info0.metaKey,
          count,
          stride,
          uvBytes,
          posBytes,
          byteSize: entryByteSize,
        });
        totalBytes += entryByteSize;
        outOps.push(placeholder);
        encodedAny = true;
        i = j;
      }

      if (!encodedAny) return value;
      const nextFrame: JsonRecord = {
        ...frameObj,
        meshWire: PREVIEW_MESH_WIRE_CODEC,
        ops: outOps,
      };
      return isEnvelope ? { ...value, frame: nextFrame } : nextFrame;
    },
  };
}

export function createPreviewMeshWireDecoder(options: PreviewMeshWireOptions = {}): PreviewMeshWireDecoder {
  // Self-contained: the exact same decoder function is embedded in the browser.
  const PREVIEW_MESH_WIRE_CODEC = "retained-v1";
  const DEFAULT_MAX_MESH_WIRE_SLOTS = 64;
  const DEFAULT_MAX_MESH_WIRE_BYTES = 8 * 1024 * 1024;
  function isPlainObject(value: unknown): value is JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("non-finite number in mesh metadata");
        return JSON.stringify(value); // Match metadata after JSON transport, including -0.
      }
      if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
      }
      throw new Error(`unsupported metadata value type: ${typeof value}`);
    }
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        items.push(canonicalJson(value[i]));
      }
      return `[${items.join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw new Error("non-plain object in mesh metadata");
    }
    const keys = Object.keys(value).sort();
    const entries: string[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      const item = value[key];
      if (item === undefined) throw new Error("undefined property in mesh metadata");
      entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${entries.join(",")}}`;
  }

  function cloneJsonValue<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneJsonValue) as unknown as T;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key === "__proto__") Object.defineProperty(out, key, { value: cloneJsonValue(record[key]), enumerable: true, writable: true, configurable: true });
      else out[key] = cloneJsonValue(record[key]);
    }
    return out as T;
  }

  function base64ToBytes(encoded: string): Uint8Array {
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
      throw new Error("Invalid mesh wire base64 payload");
    }
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(encoded, "base64"));
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decodeFloat64Le(encoded: unknown, expectedFloats: number): number[] {
    if (typeof encoded !== "string") throw new Error("Mesh wire binary field must be a base64 string");
    const bytes = base64ToBytes(encoded);
    if (bytes.byteLength !== expectedFloats * 8) {
      throw new Error(`Mesh wire byte length mismatch: expected ${expectedFloats * 8}, got ${bytes.byteLength}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = new Array<number>(expectedFloats);
    for (let i = 0; i < expectedFloats; i += 1) {
      const value = view.getFloat64(i * 8, true);
      if (!Number.isFinite(value)) throw new Error("Mesh wire payload contains a non-finite number");
      result[i] = value;
    }
    return result;
  }

  function buildCanonicalOps(
    meta: JsonRecord,
    count: number,
    stride: 6 | 8 | 10,
    uvs: readonly number[],
    pos: readonly number[],
  ): JsonRecord[] {
    const ops = new Array<JsonRecord>(count);
    for (let i = 0; i < count; i += 1) {
      const pOff = i * stride;
      const uOff = i * 6;
      const x0 = pos[pOff]!;
      const y0 = pos[pOff + 1]!;
      const x1 = pos[pOff + 2]!;
      const y1 = pos[pOff + 3]!;
      const x2 = pos[pOff + 4]!;
      const y2 = pos[pOff + 5]!;
      const op = cloneJsonValue(meta);
      if (stride === 8) {
        op.x = Math.min(x0, x1, x2);
        op.y = Math.min(y0, y1, y2);
        op.w = pos[pOff + 6]!;
        op.h = pos[pOff + 7]!;
      } else if (stride === 10) {
        op.x = pos[pOff + 6]!;
        op.y = pos[pOff + 7]!;
        op.w = pos[pOff + 8]!;
        op.h = pos[pOff + 9]!;
      }
      op.points = [
        { x: x0, y: y0 },
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ];
      op.uvs = [
        uvs[uOff]!, uvs[uOff + 1]!,
        uvs[uOff + 2]!, uvs[uOff + 3]!,
        uvs[uOff + 4]!, uvs[uOff + 5]!,
      ];
      ops[i] = op;
    }
    return ops;
  }

  const maxSlots = Math.max(1, Math.trunc(options.maxSlots ?? DEFAULT_MAX_MESH_WIRE_SLOTS));
  const maxBytes = Math.max(256, Math.trunc(options.maxBytes ?? DEFAULT_MAX_MESH_WIRE_BYTES));
  const slots = new Map<number, DecoderSlot>();
  let totalBytes = 0;

  function evictOldest(): void {
    const oldestId = slots.keys().next().value;
    if (oldestId !== undefined) {
      const oldest = slots.get(oldestId);
      if (oldest) totalBytes = Math.max(0, totalBytes - oldest.byteSize);
      slots.delete(oldestId);
    }
  }

  return {
    reset(): void {
      slots.clear();
      totalBytes = 0;
    },
    decode(value: unknown): unknown {
      if (!isPlainObject(value)) return value;
      const isEnvelope = value.type === "frame" && isPlainObject(value.frame);
      const frameObj = (isEnvelope ? value.frame : value) as JsonRecord;
      if (!isPlainObject(frameObj) || !Array.isArray(frameObj.ops)) return value;

      const codec = frameObj.meshWire;
      if (codec === undefined) {
        for (let i = 0; i < frameObj.ops.length; i += 1) {
          if (Array.isArray(frameObj.ops[i])) {
            throw new Error("Unexpected mesh wire placeholder in unencoded frame");
          }
        }
        return value;
      }
      if (codec !== PREVIEW_MESH_WIRE_CODEC) {
        throw new Error(`Unsupported preview meshWire codec: ${String(codec)}`);
      }

      const rawOps = frameObj.ops;
      const decodedOps: unknown[] = [];

      for (let i = 0; i < rawOps.length; i += 1) {
        const entry = rawOps[i];
        if (!Array.isArray(entry)) {
          if (!isPlainObject(entry)) {
            throw new Error("Invalid DrawOp in meshWire frame");
          }
          decodedOps.push(entry);
          continue;
        }
        const tag = entry[0];
        if (tag === "d") {
          if (entry.length !== 7 && entry.length !== 8) throw new Error("Invalid meshWire define tuple length");
          const id = entry[1];
          const count = entry[2];
          const stride = entry[3];
          const meta = entry[4];
          const uvB64 = entry[5];
          const posB64 = entry[6];
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
            throw new Error("Invalid meshWire slot id");
          }
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 100_000) {
            throw new Error("Invalid meshWire triangle count");
          }
          if (stride !== 6 && stride !== 8 && stride !== 10) {
            throw new Error("Invalid meshWire position stride");
          }
          if (!isPlainObject(meta) || (meta.type !== "textureTriangle" && meta.type !== "textureTriangleRepeat")) {
            throw new Error("Invalid meshWire static metadata");
          }
          if (
            Object.prototype.hasOwnProperty.call(meta, "points") ||
            Object.prototype.hasOwnProperty.call(meta, "uvs") ||
            Object.prototype.hasOwnProperty.call(meta, "x") ||
            Object.prototype.hasOwnProperty.call(meta, "y") ||
            Object.prototype.hasOwnProperty.call(meta, "w") ||
            Object.prototype.hasOwnProperty.call(meta, "h")
          ) {
            throw new Error("MeshWire static metadata must not contain geometry fields");
          }
          const metaKey = canonicalJson(meta);
          const uvs = decodeFloat64Le(uvB64, count * 6);
          const pos = decodeFloat64Le(posB64, count * stride);
          const byteSize = count * (6 + stride) * 8 + `${stride}:${metaKey}`.length * 2;
          if (byteSize > maxBytes) {
            throw new Error("MeshWire slot definition exceeds cache byte budget");
          }
          const replacedId = entry[7];
          if (replacedId !== undefined) {
            if (!Number.isSafeInteger(replacedId) || replacedId < 1 || replacedId === id) throw new Error("Invalid meshWire replaced slot id");
            const replaced = slots.get(replacedId);
            if (!replaced) throw new Error(`Missing meshWire replaced slot ${replacedId}`);
            totalBytes -= replaced.byteSize;
            slots.delete(replacedId);
          }
          const existing = slots.get(id);
          if (existing) {
            totalBytes = Math.max(0, totalBytes - existing.byteSize);
            slots.delete(id);
          }
          while (slots.size >= maxSlots || (slots.size > 0 && totalBytes + byteSize > maxBytes)) {
            evictOldest();
          }
          const slot: DecoderSlot = {
            id,
            count,
            stride,
            meta: cloneJsonValue(meta),
            uvs,
            pos,
            byteSize,
          };
          slots.set(id, slot);
          totalBytes += byteSize;
          const restored = buildCanonicalOps(slot.meta, slot.count, slot.stride, slot.uvs, slot.pos);
          for (let k = 0; k < restored.length; k += 1) decodedOps.push(restored[k]);
        } else if (tag === "u") {
          if (entry.length !== 3) throw new Error("Invalid meshWire update tuple length");
          const id = entry[1];
          const posB64 = entry[2];
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
            throw new Error("Invalid meshWire slot id");
          }
          const slot = slots.get(id);
          if (!slot) {
            throw new Error(`Missing meshWire slot reference ${id}`);
          }
          slots.delete(id);
          slots.set(id, slot);
          slot.pos = decodeFloat64Le(posB64, slot.count * slot.stride);
          const restored = buildCanonicalOps(slot.meta, slot.count, slot.stride, slot.uvs, slot.pos);
          for (let k = 0; k < restored.length; k += 1) decodedOps.push(restored[k]);
        } else if (tag === "s") {
          if (entry.length !== 2) throw new Error("Invalid meshWire same tuple length");
          const id = entry[1];
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
            throw new Error("Invalid meshWire slot id");
          }
          const slot = slots.get(id);
          if (!slot) {
            throw new Error(`Missing meshWire slot reference ${id}`);
          }
          slots.delete(id);
          slots.set(id, slot);
          const restored = buildCanonicalOps(slot.meta, slot.count, slot.stride, slot.uvs, slot.pos);
          for (let k = 0; k < restored.length; k += 1) decodedOps.push(restored[k]);
        } else {
          throw new Error(`Unknown meshWire tuple tag: ${String(tag)}`);
        }
      }

      const { meshWire: _codec, ...nextFrame } = frameObj;
      nextFrame.ops = decodedOps;
      return isEnvelope ? { ...value, frame: nextFrame } : nextFrame;
    },
  };
}

/** Embed one implementation in both Studio's served client and browser tests. */
export function previewMeshWireDecoderSource(): string {
  return `globalThis.PocketPreviewMeshWireDecoder = ${createPreviewMeshWireDecoder.toString()};`;
}
