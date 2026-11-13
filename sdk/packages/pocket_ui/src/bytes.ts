/**
 * QuickJS-portable UTF-8 and Base64 byte codecs for PocketJS guest packages.
 *
 * PocketJS's QuickJS runtime intentionally omits Web `TextEncoder`,
 * `TextDecoder`, `btoa`, `atob`, and Node `Buffer`. These pure-JS helpers
 * provide deterministic, spec-compliant byte conversion without mutating
 * `globalThis`.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INVERSE: Record<string, number> = {};
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_INVERSE[BASE64_ALPHABET[index]!] = index;
}

/**
 * Encode a JS string into well-formed UTF-8 bytes.
 * Astral code points (surrogate pairs) encode as 4-byte UTF-8 sequences;
 * lone UTF-16 surrogates are replaced with U+FFFD (`EF BF BD`).
 */
export function utf8ToBytes(text: string): Uint8Array {
  let byteLength = 0;
  for (let i = 0; i < text.length; i += 1) {
    let code = text.codePointAt(i)!;
    if (code > 0xffff) i += 1;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    byteLength += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  const out = new Uint8Array(byteLength);
  let offset = 0;
  for (let i = 0; i < text.length; i += 1) {
    let code = text.codePointAt(i)!;
    if (code > 0xffff) i += 1;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) {
      out[offset++] = code;
    } else if (code < 0x800) {
      out[offset++] = 0xc0 | (code >> 6);
      out[offset++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[offset++] = 0xe0 | (code >> 12);
      out[offset++] = 0x80 | ((code >> 6) & 0x3f);
      out[offset++] = 0x80 | (code & 0x3f);
    } else {
      out[offset++] = 0xf0 | (code >> 18);
      out[offset++] = 0x80 | ((code >> 12) & 0x3f);
      out[offset++] = 0x80 | ((code >> 6) & 0x3f);
      out[offset++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/**
 * Decode UTF-8 bytes into a JS string.
 * Throws `Error("invalid UTF-8")` when `strict` is true and a malformed,
 * overlong, or surrogate byte sequence is encountered; otherwise replaces
 * invalid bytes with U+FFFD.
 */
export function bytesToUtf8(bytes: Uint8Array, options: { strict?: boolean } = {}): string {
  const strict = options.strict === true;
  const parts: string[] = [];
  let chunkCodes: number[] = [];
  const flush = (): void => {
    if (chunkCodes.length === 0) return;
    parts.push(String.fromCharCode(...chunkCodes));
    chunkCodes = [];
  };
  const emitScalar = (scalar: number): void => {
    if (scalar <= 0xffff) {
      chunkCodes.push(scalar);
    } else {
      const shifted = scalar - 0x10000;
      chunkCodes.push(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    }
    if (chunkCodes.length >= 4096) flush();
  };
  const failOrReplace = (): void => {
    if (strict) throw new Error("invalid UTF-8");
    emitScalar(0xfffd);
  };

  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      emitScalar(b0);
      i += 1;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= bytes.length) {
        failOrReplace();
        i += 1;
        continue;
      }
      const b1 = bytes[i + 1]!;
      if ((b1 & 0xc0) !== 0x80) {
        failOrReplace();
        i += 1;
        continue;
      }
      emitScalar(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
      continue;
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= bytes.length) {
        failOrReplace();
        i += 1;
        continue;
      }
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const validSecond =
        (b1 & 0xc0) === 0x80 &&
        !(b0 === 0xe0 && b1 < 0xa0) &&
        !(b0 === 0xed && b1 >= 0xa0);
      if (!validSecond || (b2 & 0xc0) !== 0x80) {
        failOrReplace();
        i += 1;
        continue;
      }
      emitScalar(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
      i += 3;
      continue;
    }
    if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 >= bytes.length) {
        failOrReplace();
        i += 1;
        continue;
      }
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      const validSecond =
        (b1 & 0xc0) === 0x80 &&
        !(b0 === 0xf0 && b1 < 0x90) &&
        !(b0 === 0xf4 && b1 >= 0x90);
      if (!validSecond || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
        failOrReplace();
        i += 1;
        continue;
      }
      emitScalar(((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
      i += 4;
      continue;
    }
    failOrReplace();
    i += 1;
  }
  flush();
  return parts.join("");
}

/** Encode arbitrary bytes to standard RFC 4648 Base64 with `=` padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += BASE64_ALPHABET[a >> 2]! + BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 63]! : "=";
  }
  return out;
}

/** Decode standard or URL-safe Base64 into a `Uint8Array`. */
export function base64ToBytes(encoded: string): Uint8Array {
  let normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.endsWith("=")) normalized = normalized.slice(0, -1);
  const out = new Uint8Array(Math.floor((normalized.length * 3) / 4));
  let offset = 0;
  for (let i = 0; i < normalized.length; i += 4) {
    const n =
      ((BASE64_INVERSE[normalized[i]!] ?? 0) << 18) |
      ((BASE64_INVERSE[normalized[i + 1]!] ?? 0) << 12) |
      ((BASE64_INVERSE[normalized[i + 2]!] ?? 0) << 6) |
      (BASE64_INVERSE[normalized[i + 3]!] ?? 0);
    if (offset < out.length) out[offset++] = (n >> 16) & 0xff;
    if (offset < out.length) out[offset++] = (n >> 8) & 0xff;
    if (offset < out.length) out[offset++] = n & 0xff;
  }
  return out;
}
