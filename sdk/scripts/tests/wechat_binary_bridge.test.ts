import { expect, test } from "bun:test";
import { encodeMessage, decodeMessage } from "../../targets/wechat/template/binary-bridge.js";

test("WeChat event, response, input and scheduler packets work with JSON disabled", () => {
  const parse = JSON.parse, stringify = JSON.stringify;
  let result: any;
  try {
    JSON.parse = () => { throw new Error("JSON.parse reached transport"); };
    JSON.stringify = () => { throw new Error("JSON.stringify reached transport"); };
    const packet = { type: "event", name: "host.response", payload: {
      requestId: "中😀", ok: true, result: { bytes: new Uint8Array([0, 128, 255]), count: -42, ratio: 1.25, none: null },
    } };
    result = decodeMessage(encodeMessage(packet));
  } finally { JSON.parse = parse; JSON.stringify = stringify; }
  expect(result.payload.requestId).toBe("中😀");
  expect(result.payload.result).toEqual({ bytes: new Uint8Array([0, 128, 255]), count: -42, ratio: 1.25, none: null });
});

test("WeChat decoder admits native int64 TLV and rejects old JSON/malformed input", () => {
  // Native wire: object {n: -42} with signed int64 (tag 3).
  const golden = new Uint8Array([0xb1, 8, 1,0,0,0, 1,0,0,0, 110, 3, 214,255,255,255,255,255,255,255]);
  expect(decodeMessage(golden)).toEqual({ n: -42 });
  expect(encodeMessage({ n: -42 })).toEqual(golden);
  expect(decodeMessage(encodeMessage({ text: "\ud800中😀\udfff" })).text).toBe("\ufffd中😀\ufffd");
  const numbers = [0, -1, 2147483648, -4294967297, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1.25];
  expect(decodeMessage(encodeMessage({ numbers })).numbers).toEqual(numbers);
  expect(() => decodeMessage(new TextEncoder().encode('{"n":-42}'))).toThrow();
  expect(() => decodeMessage(golden.slice(0, -1))).toThrow();
  expect(() => decodeMessage(new Uint8Array([...golden, 0]))).toThrow();
  expect(() => encodeMessage({ value: NaN })).toThrow();
  const cycle: any = {}; cycle.self = cycle;
  expect(() => encodeMessage(cycle)).toThrow();
  expect(() => encodeMessage({ value: "x".repeat(65536) })).toThrow();
});

test("binary object keys cannot mutate the host prototype", () => {
  const value = Object.create(null); value.__proto__ = { polluted: true };
  const result = decodeMessage(encodeMessage(value));
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
  expect(({} as any).polluted).toBeUndefined();
});
