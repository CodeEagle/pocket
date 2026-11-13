// Byte helpers for the QuickJS guest, which has no TextEncoder, atob or btoa.

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/** Strict-ish UTF-8 decode; invalid sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    let code = 0xfffd;
    let size = 1;
    if (b < 0x80) code = b;
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) { code = ((b & 31) << 6) | (bytes[i + 1]! & 63); size = 2; }
    else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) { code = ((b & 15) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63); size = 3; }
    else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) { code = ((b & 7) << 18) | ((bytes[i + 1]! & 63) << 12) | ((bytes[i + 2]! & 63) << 6) | (bytes[i + 3]! & 63); size = 4; }
    i += size;
    if (code >= 0x10000) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else out += String.fromCharCode(code);
  }
  return out;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? alphabet[c & 63]! : "=";
  }
  return out;
}

const decodeTable = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

/** Table-driven (an `indexOf` per character blew the guest's 250 ms turn budget on a 175 KB chunk in the debug native build). */
export function base64Decode(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end -= 1;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? decodeTable[code]! : -1;
    if (digit < 0) throw new Error("invalid base64");
    value = ((value << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out.subarray(0, index);
}
