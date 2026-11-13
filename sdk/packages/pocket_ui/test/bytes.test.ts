import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  utf8ToBytes,
} from "../src/bytes.ts";

describe("@pocket/ui/bytes QuickJS-safe codecs", () => {
  test("round-trips ASCII, CJK, and emoji astral pairs without touching globalThis", () => {
    const sample = "BabyLink 多宝同屏 🍼✨ Looseleaf v0.1.0";
    const encoded = utf8ToBytes(sample);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(bytesToUtf8(encoded, { strict: true })).toBe(sample);
  });

  test("replaces lone UTF-16 surrogates with U+FFFD", () => {
    const loneHigh = "A\uD800B";
    const encoded = utf8ToBytes(loneHigh);
    expect(bytesToUtf8(encoded, { strict: true })).toBe("A\uFFFDB");
  });

  test("strict UTF-8 decode throws on invalid sequences while non-strict replaces", () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0x41]);
    expect(() => bytesToUtf8(invalid, { strict: true })).toThrow("invalid UTF-8");
    expect(bytesToUtf8(invalid)).toBe("\uFFFD\uFFFDA");
  });

  test("round-trips Base64 across padding lengths", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "手绘纸墨"]) {
      const raw = utf8ToBytes(text);
      const b64 = bytesToBase64(raw);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(raw));
    }
  });
});
