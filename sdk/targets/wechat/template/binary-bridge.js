// Pocket 0xB1 TLV wire codec. Matches sdk/native/src/binary_bridge.rs.
// Uses Number arithmetic for safe JS integers, including signed int64 decoding.
const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
function utf8(value, maxBytes) {
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (length > maxBytes) throw new Error("Pocket binary message exceeds size limit");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  const put = byte => { bytes[offset++] = byte; };
  for (const character of value) {
    let code = character.codePointAt(0);
    // Match Dart's UTF-8 encoder for an incomplete UTF-16 input/IME edit.
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) put(code);
    else if (code < 0x800) { put(0xc0 | (code >> 6)); put(0x80 | (code & 63)); }
    else if (code < 0x10000) { put(0xe0 | (code >> 12)); put(0x80 | ((code >> 6) & 63)); put(0x80 | (code & 63)); }
    else { put(0xf0 | (code >> 18)); put(0x80 | ((code >> 12) & 63)); put(0x80 | ((code >> 6) & 63)); put(0x80 | (code & 63)); }
  }
  return bytes;
}
function text(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return decodeURIComponent(escape(binary));
}
function encodeMessage(value, limit = MAX_BYTES) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) throw new Error("Invalid Pocket binary message limit");
  let bytes = new Uint8Array(Math.min(limit, 256));
  let view = new DataView(bytes.buffer);
  let offset = 0;
  const ancestors = new Set();
  function need(n) {
    if (n > limit - offset) throw new Error("Pocket binary message exceeds size limit");
    if (offset + n <= bytes.length) return;
    const grown = new Uint8Array(Math.min(limit, Math.max(offset + n, bytes.length * 2)));
    grown.set(bytes); bytes = grown; view = new DataView(bytes.buffer);
  }
  function u8(n) { need(1); bytes[offset++] = n; }
  function u32(n) { need(4); view.setUint32(offset, n, true); offset += 4; }
  function raw(value) { u32(value.length); need(value.length); bytes.set(value, offset); offset += value.length; }
  function write(value, depth) {
    if (depth > MAX_DEPTH) throw new Error("Pocket binary message nesting is too deep");
    if (value == null) { u8(0); return; }
    if (typeof value === "boolean") { u8(value ? 2 : 1); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Pocket binary number must be finite");
      if (Number.isSafeInteger(value)) {
        u8(3); need(8);
        view.setUint32(offset, value >>> 0, true);
        view.setInt32(offset + 4, Math.floor(value / 4294967296), true);
      } else { u8(4); need(8); view.setFloat64(offset, value, true); }
      offset += 8; return;
    }
    if (typeof value === "string") { u8(5); raw(utf8(value, limit - offset - 4)); return; }
    if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    if (value instanceof Uint8Array) { u8(6); raw(value); return; }
    if (typeof value !== "object") throw new Error("Unsupported Pocket binary value");
    if (ancestors.has(value)) throw new Error("Cyclic Pocket binary message");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        u8(7); u32(value.length);
        for (let i = 0; i < value.length; i++) write(value[i], depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error("Pocket binary value must be a plain object");
        const keys = Object.keys(value).filter(key => value[key] !== undefined && typeof value[key] !== "function");
        u8(8); u32(keys.length);
        for (const key of keys) { raw(utf8(key, limit - offset - 4)); write(value[key], depth + 1); }
      }
    } finally { ancestors.delete(value); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error("Pocket message root must be an object");
  u8(0xb1); write(value, 0);
  return bytes.slice(0, offset);
}
function decodeMessage(bytes, limit = MAX_BYTES) {
  if (!(bytes instanceof Uint8Array) || bytes.length > limit) throw new Error("Invalid Pocket binary message size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  function need(n) { if (n > bytes.length - offset) throw new Error("Truncated Pocket binary message"); }
  function u8() { need(1); return bytes[offset++]; }
  function u32() { need(4); const n = view.getUint32(offset, true); offset += 4; return n; }
  function raw() { const n = u32(); need(n); const value = bytes.slice(offset, offset + n); offset += n; return value; }
  function read(depth) {
    if (depth > MAX_DEPTH) throw new Error("Pocket binary message nesting is too deep");
    const tag = u8();
    if (tag === 0) return null;
    if (tag === 1 || tag === 2) return tag === 2;
    if (tag === 3 || tag === 4) {
      need(8);
      const value = tag === 4 ? view.getFloat64(offset, true)
        : view.getInt32(offset + 4, true) * 4294967296 + view.getUint32(offset, true);
      offset += 8;
      if (!Number.isFinite(value) || (tag === 3 && !Number.isSafeInteger(value))) throw new Error("Invalid Pocket binary number");
      return value;
    }
    if (tag === 5) return text(raw());
    if (tag === 6) return raw();
    if (tag === 7 || tag === 8) {
      const n = u32();
      if (n > bytes.length - offset) throw new Error("Invalid Pocket binary collection count");
      if (tag === 7) { const result = []; for (let i = 0; i < n; i++) result.push(read(depth + 1)); return result; }
      const result = {};
      for (let i = 0; i < n; i++) Object.defineProperty(result, text(raw()), { value: read(depth + 1), writable: true, enumerable: true, configurable: true });
      return result;
    }
    throw new Error("Unknown Pocket binary tag");
  }
  if (u8() !== 0xb1) throw new Error("Invalid Pocket binary message magic");
  const value = read(0);
  if (offset !== bytes.length || value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error("Invalid Pocket binary message root or trailing bytes");
  return value;
}
module.exports = { encodeMessage, decodeMessage };
