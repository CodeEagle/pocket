import { afterEach, expect, test } from "bun:test";
import { mountHotRoot, registerHotState } from "../src/dev.ts";

const global = globalThis as any;
afterEach(() => { delete global.__pocketDevHot; });

test("hot root replacement preserves opted-in state and disposes the original root once", () => {
  let count = 3, stops = 0;
  let cleanup = registerHotState("counter", { read: () => count, write: value => { count = value as number; } });
  const dispose = mountHotRoot(() => () => { stops++; cleanup(); });
  const h = global.__pocketDevHot;
  expect(h.bind({ protocol: 1, session: "editor-1", version: "one" })).toBe(true);
  const transition = { protocol: 1, session: "editor-1", base: "one", version: "two" };
  h.prepare(transition);
  expect(stops).toBe(1);
  count = 0;
  cleanup = registerHotState("counter", { read: () => count, write: value => { count = value as number; } });
  mountHotRoot(() => () => { stops++; cleanup(); });
  expect(count).toBe(3);
  expect(h.commit(transition)).toBe(true);
  dispose();
  expect(stops).toBe(1);
  count = 4;
  expect(h.checkpoint().counter).toBe(4);
});

test("stale session/base, protocol mismatch and duplicate updates leave the root mounted", () => {
  let stops = 0;
  mountHotRoot(() => () => { stops++; });
  const h = global.__pocketDevHot;
  h.bind({ protocol: 1, session: "editor", version: "one" });
  for (const next of [
    { protocol: 1, session: "old-server", base: "one", version: "two" },
    { protocol: 1, session: "editor", base: "zero", version: "two" },
    { protocol: 2, session: "editor", base: "one", version: "two" },
    { protocol: 1, session: "editor", base: "one", version: "one" },
  ]) expect(() => h.prepare(next)).toThrow();
  expect(stops).toBe(0);
  expect(() => h.commit({ protocol: 1, session: "editor", base: "one", version: "two" })).toThrow();
});

test("invalid and oversized checkpoints fail before disposing the root", () => {
  let stops = 0;
  mountHotRoot(() => () => { stops++; });
  const h = global.__pocketDevHot;
  h.bind({ protocol: 1, session: "editor", version: "one" });
  const next = { protocol: 1, session: "editor", base: "one", version: "two" };
  for (const value of [NaN, undefined, new Date(), "字".repeat(30000), { bad: () => {} }]) {
    const remove = registerHotState("bad", { read: () => value as any, write: () => {} });
    expect(() => h.prepare(next)).toThrow();
    expect(stops).toBe(0);
    remove();
  }
  const cyclic: any = {}; cyclic.self = cyclic;
  registerHotState("cycle", { read: () => cyclic, write: () => {} });
  expect(() => h.prepare(next)).toThrow();
  expect(stops).toBe(0);
});
