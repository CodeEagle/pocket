import { expect, test } from "bun:test";
import { clonePocketValue } from "../src/value_snapshot.ts";

test("snapshot budgets include escaped characters and object separators", () => {
  expect(() => clonePocketValue("\ud800".repeat(12_000))).toThrow(/64 KiB/);
  expect(() => clonePocketValue('"'.repeat(40_000))).toThrow(/64 KiB/);
  const fields = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    "k" + String(index).padStart(4, "0"), "x".repeat(55),
  ]));
  expect(() => clonePocketValue(fields)).toThrow(/64 KiB/);
});

test("omitted System fields still consume the structural work budget", () => {
  const omitted = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [String(index), undefined]));
  expect(() => clonePocketValue(omitted, { jsonSemantics: true })).toThrow(/too many nodes/);
  expect(clonePocketValue({ absent: undefined, list: [undefined] }, { jsonSemantics: true }))
    .toEqual({ list: [null] });
});

test("deep input is rejected before it can exhaust the guest stack", () => {
  let nested: unknown = 0;
  for (let depth = 0; depth < 17; depth++) nested = { child: nested };
  expect(() => clonePocketValue(nested)).toThrow(/depth limit/);
});
