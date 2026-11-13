import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildGuestProject, ProbeSession, type BuiltGuest, type Frame } from "./code_view_harness.ts";
import { sharedComponentsApp } from "./shared_components_app.ts";

// Rendering of the shared Studio components (Tree, SplitPane, TabsBar, ToastHost) on the real native probe:
// taps, expand/collapse, pan-drag of the split handle, tab close and toast dismiss, asserted from the draw ops.

let guest: BuiltGuest;
const sessions: ProbeSession[] = [];
beforeAll(() => { guest = buildGuestProject({ "app.tsx": sharedComponentsApp() }); }, 200_000);
afterAll(async () => { for (const s of sessions) await s.close(); guest?.cleanup(); });

async function open(): Promise<ProbeSession> {
  const s = new ProbeSession(guest, 600, 500); sessions.push(s); await s.ready();
  for (let i = 0; i < 6; i++) await s.frame(50);
  return s;
}
const texts = (f: Frame) => (f.ops ?? []).filter(o => o.type === "text").map(o => o.text as string);
const textOp = (f: Frame, label: string) => (f.ops ?? []).find(o => o.type === "text" && o.text === label);
async function dump(s: ProbeSession): Promise<any> { await s.send("test.dump", {}); return s.events("sc.dump").at(-1); }
async function tap(s: ProbeSession, label: string): Promise<void> {
  const op = textOp(s.last, label);
  expect(op, `no "${label}" in ${JSON.stringify(texts(s.last))}`).toBeTruthy();
  const x = op!.x! + op!.w! / 2, y = op!.y! + op!.h! / 2;
  await s.pointer("down", x, y); await s.pointer("up", x, y);
}

test("tree: folders first, collapsed by default, expand/collapse by tap, files report a press, empty folders and dirty markers show", async () => {
  const s = await open();
  expect(texts(s.last)).toEqual(expect.arrayContaining(["▸ empty", "▸ src", "app.tsx", "manifest.json"]));
  expect(texts(s.last)).not.toContain("a.ts");
  await tap(s, "▸ src");
  expect(texts(s.last)).toEqual(expect.arrayContaining(["▾ src", "▸ deep", "a.ts ●", "b.ts"]));
  const indent = textOp(s.last, "▸ deep")!.x! - textOp(s.last, "▾ src")!.x!;
  expect(indent).toBe(14);
  await tap(s, "▸ deep");
  expect(texts(s.last)).toContain("c.ts");
  await tap(s, "▾ src");
  expect(texts(s.last)).not.toContain("a.ts ●");
  await tap(s, "app.tsx");
  expect(s.events("sc.open").at(-1)).toEqual({ path: "app.tsx" });
  expect((await dump(s)).selected).toBe("app.tsx");
  // The selected row is highlighted (a filled rect behind it).
  expect((s.last.ops ?? []).some(o => o.type === "rounded" || o.type === "rect")).toBe(true);
}, 120_000);

test("split pane: dragging the handle resizes the fixed pane within [min, max] and reports the end once", async () => {
  const s = await open();
  const d0 = await dump(s);
  expect(d0.size).toBe(200);
  const handle = textOp(s.last, "⋮")!;
  const hx = handle.x! + handle.w! / 2, hy = handle.y! + handle.h! / 2;
  const right = textOp(s.last, "RIGHT_PANE")!;
  await s.pointer("down", hx, hy); await s.pointer("move", hx + 20, hy); await s.pointer("move", hx + 60, hy);
  let d = await dump(s);
  expect(d.size).toBeGreaterThan(200);
  expect(d.size).toBeLessThanOrEqual(260);
  const mid = d.size;
  expect(textOp(s.last, "RIGHT_PANE")!.x!).toBeGreaterThan(right.x!);
  await s.pointer("move", hx + 250, hy); // far right: clamped at max
  d = await dump(s);
  expect(d.size).toBe(400);
  expect(d.ended).toBe(0);
  await s.pointer("up", hx + 250, hy);
  d = await dump(s);
  expect(d.ended).toBe(1);
  expect(s.events("sc.end").at(-1).size).toBe(400);
  // Drag left past the minimum: clamped at min.
  const h2 = textOp(s.last, "⋮")!;
  const x2 = h2.x! + h2.w! / 2;
  await s.pointer("down", x2, hy); await s.pointer("move", x2 - 100, hy); await s.pointer("move", x2 - 300, hy); await s.pointer("up", x2 - 300, hy);
  d = await dump(s);
  expect(d.size).toBe(100);
  expect(d.ended).toBe(2);
  expect(mid).toBeGreaterThan(200);
}, 120_000);

test("a tap on the handle does not resize or report an end", async () => {
  const s = await open();
  const handle = textOp(s.last, "⋮")!;
  const hx = handle.x! + handle.w! / 2, hy = handle.y! + handle.h! / 2;
  await s.pointer("down", hx, hy); await s.pointer("up", hx, hy);
  const d = await dump(s);
  expect(d.size).toBe(200);
  expect(d.ended).toBe(0);
}, 60_000);

test("tabs: active tab, dirty marker, activate and close", async () => {
  const s = await open();
  expect(texts(s.last)).toEqual(expect.arrayContaining(["tab-a", "tab-b ●", "tab-c"]));
  await tap(s, "tab-c");
  expect((await dump(s)).active).toBe("c");
  // The close buttons are the "×" glyphs of the tabs (toasts also draw "×"): the first one belongs to a.ts.
  const closers = (s.last.ops ?? []).filter(o => o.type === "text" && o.text === "×").sort((p, q) => p.x! - q.x!);
  const x = closers[0]!.x! + closers[0]!.w! / 2, y = closers[0]!.y! + closers[0]!.h! / 2;
  await s.pointer("down", x, y); await s.pointer("up", x, y);
  const d = await dump(s);
  expect(d.tabs).toEqual(["b", "c"]);
  expect(texts(s.last)).not.toContain("tab-a");
}, 60_000);

test("toast host: stacked toasts at the bottom right, a press dismisses one", async () => {
  const s = await open();
  const one = textOp(s.last, "TOAST_ONE")!, two = textOp(s.last, "TOAST_TWO")!;
  expect(one.x!).toBeGreaterThan(200);
  expect(one.y!).toBeGreaterThan(300);
  expect(two.y!).toBeGreaterThan(one.y!);
  await tap(s, "TOAST_ONE");
  expect((await dump(s)).toasts).toEqual([2]);
  expect(texts(s.last)).not.toContain("TOAST_ONE");
  expect(texts(s.last)).toContain("TOAST_TWO");
}, 60_000);
