import { expect, test } from "bun:test";
import { createNovelRainMesh, novelAtmosphereIssue } from "../src/atmosphere.ts";
test("weather paths and scalar bounds reject malformed project configuration", () => {
  expect(novelAtmosphereIssue({ mist: "art/mist.png", rain: "art/rain.svg", intensity: .5, lightning: true })).toBeNull();
  for (const value of [{mist:"../secret.png"},{rain:"/rain.png"},{intensity:NaN},{intensity:2},{lightning:"yes"},null]) expect(novelAtmosphereIssue(value)).not.toBeNull();
});
test("one bounded rain mesh changes real vertices and reuses its serialized buffer", () => {
  const sample = createNovelRainMesh(40);
  const first = sample(800, 600, 0);
  const before = Array.from(first);
  const next = sample(800, 600, 500);
  expect(next).toBe(first);
  expect(Array.from(next)).not.toEqual(before);
  const view = new DataView(next.buffer, next.byteOffset, next.byteLength);
  expect(view.getUint32(0,true)).toBe(0x31534d50);
  expect(view.getUint32(4,true)).toBe(160);
  expect(view.getUint32(8,true)).toBe(240);
  expect(next.byteLength).toBe(16 + 160*16 + 240*4);
  expect(() => createNovelRainMesh(65)).toThrow();
  expect(() => sample(0,600,0)).toThrow();
  expect(() => sample(800,600,Infinity)).toThrow();
});
