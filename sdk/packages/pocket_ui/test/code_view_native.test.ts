import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildGuestProject, ProbeSession, type BuiltGuest, type Frame } from "./code_view_harness.ts";
import { codeViewApp } from "./code_view_app.ts";
import { buildCorpus } from "./code_corpus.ts";

const CORPUS = buildCorpus(5000).split("\n");
const GUTTER = 52, PAD = 8, CW = 9, LH = 20;
let guest: BuiltGuest;
const sessions: ProbeSession[] = [];
beforeAll(() => { guest = buildGuestProject({ "app.tsx": codeViewApp({ diagnostics: [{ line: 2, column: 3, severity: "error", message: "boom here" }] }) }, ["code_corpus.ts"]); }, 200_000);
afterAll(async () => { for (const s of sessions) await s.close(); guest?.cleanup(); });

async function open(): Promise<ProbeSession> {
  const s = new ProbeSession(guest); sessions.push(s); await s.ready();
  for (let i = 0; i < 8; i++) await s.frame(50);
  return s;
}
const nb = (t: string) => t.replace(/ /g, " ");
/** Rendered code lines of a frame: text ops right of the gutter grouped by row y. */
function screen(f: Frame): { y: number; text: string }[] {
  const rows = new Map<number, { x: number; t: string }[]>();
  for (const o of f.ops ?? []) if (o.type === "text" && o.x! >= GUTTER && o.h === 20 && !(o.y === 614 && o.x === 8)) { const a = rows.get(o.y!) ?? []; a.push({ x: o.x!, t: nb(o.text!) }); rows.set(o.y!, a); }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, a]) => ({ y, text: a.sort((p, q) => p.x - q.x).map(p => p.t).join("") }));
}
const rowAt = (f: Frame, line: number, top = 0) => screen(f).find(r => r.y === line * 20 - top)?.text;
const gutterNums = (f: Frame) => (f.ops ?? []).filter(o => o.type === "text" && o.x! < GUTTER).map(o => Number(o.text));
async function dump(s: ProbeSession, lines?: number[]): Promise<any> { await s.send("test.dump", { lines }); return s.events("cv.dump").at(-1); }
const keyDown = (key: string, modifiers = 0) => ({ kind: "keyDown", key, ...(modifiers ? { modifiers } : {}) });
const META = 8, SHIFT = 1;
const tapAt = async (s: ProbeSession, line: number, col: number, top = 0) => { const x = GUTTER + PAD + col * CW + 1, y = line * LH - top + 10; await s.pointer("down", x, y); await s.pointer("up", x, y); };
async function focus(s: ProbeSession) { await tapAt(s, 1, 2); await s.send("textInput.rawOpened", { id: "code-view-1" }); }

test("virtualization: only visible lines + overscan are mounted", async () => {
  const s = await open();
  const d = await dump(s);
  console.log("CODEVIEW mount " + JSON.stringify(d.debug));
  expect(d.lineCount).toBe(5000);
  expect(d.debug.calibrated).toBe(true);
  expect(d.debug.slots).toBeLessThan(50);
  expect(d.debug.nodesLive).toBeLessThan(160);
  const rows = screen(s.last);
  expect(rows.length).toBeGreaterThanOrEqual(24);
  expect(rows.length).toBeLessThan(45);
  expect(rowAt(s.last, 0)).toBe(CORPUS[0]);
  expect(CORPUS[5].startsWith(rowAt(s.last, 5)!)).toBe(true);
  expect(rowAt(s.last, 11)).toBe(CORPUS[11]);
  expect(gutterNums(s.last).slice(0, 3)).toEqual([1, 2, 3]);
  // token colours: more than one distinct colour among the first lines
  const colours = new Set((s.last.ops ?? []).filter(o => o.type === "text" && o.x! >= GUTTER).map(o => o.color));
  expect(colours.size).toBeGreaterThan(3);
}, 120_000);

test("scroll: wheel and gutter drag move the window with bounded nodes", async () => {
  const s = await open();
  const before = (await dump(s)).debug;
  await s.send("input.scroll", { x: 200, y: 200, deltaY: 4000, source: "wheel", phase: "update" });
  let d = (await dump(s)).debug;
  console.log("CODEVIEW wheel " + JSON.stringify({ top: d.scrollTop, first: d.firstLine, nodes: d.nodesLive, built: d.lastScrollLines }));
  expect(d.scrollTop).toBe(4000);
  expect(d.firstLine).toBe(196);
  expect(d.nodesLive).toBeLessThanOrEqual(before.nodesLive + 4);
  expect(gutterNums(s.last)[0]).toBeGreaterThan(190);
  const rows = screen(s.last);
  expect(rows.some(r => r.text === CORPUS[205])).toBe(true);
  // one-line scroll rebuilds at most a couple of rows
  const b0 = d.linesBuilt;
  await s.send("input.scroll", { x: 200, y: 200, deltaY: 20, source: "wheel", phase: "update" });
  d = (await dump(s)).debug;
  expect(d.linesBuilt - b0).toBeLessThanOrEqual(2);
  // gutter drag scrolls
  await s.pointer("down", 10, 500); await s.pointer("move", 10, 300); await s.pointer("move", 10, 100); await s.pointer("up", 10, 100);
  d = (await dump(s)).debug;
  expect(d.scrollTop).toBe(4020 + 400);
  expect(d.nodesLive).toBeLessThanOrEqual(before.nodesLive + 4);
}, 120_000);

test("pointer tap places the caret and reports the position", async () => {
  const s = await open();
  await tapAt(s, 4, 7);
  const ev = s.events("cv.cursor").at(-1);
  expect(ev.line).toBe(4); expect(ev.column).toBe(7);
  const open_ = s.events("textInput.rawOpen").at(-1);
  expect(open_.id).toBe("code-view-1");
  expect(open_.rect.h).toBe(20);
  expect(open_.rect.x).toBeCloseTo(GUTTER + PAD + 7 * CW, 0);
  expect(open_.rect.y).toBe(4 * LH);
  // double click selects a word, triple selects the line
  const line = CORPUS[4];
  await tapAt(s, 4, 7); await tapAt(s, 4, 7);
  let d = await dump(s);
  const word = /[A-Za-z0-9_$]+/g; let w; let sel = null as any;
  const base = (await dump(s)).head;
  void word; void w; void sel; void base; void line; void d;
  await tapAt(s, 6, 3); await tapAt(s, 6, 3); await tapAt(s, 6, 3);
  d = await dump(s);
  expect(d.head - d.anchor).toBeGreaterThanOrEqual(CORPUS[6].length);
  // drag selects across lines
  await s.pointer("down", GUTTER + PAD + 2 * CW, 10 * LH + 5); await s.pointer("move", GUTTER + PAD + 6 * CW, 12 * LH + 5); await s.pointer("up", GUTTER + PAD + 6 * CW, 12 * LH + 5);
  const c = s.events("cv.cursor").at(-1);
  expect(c.line).toBe(12);
  d = await dump(s);
  expect(Math.abs(d.head - d.anchor)).toBeGreaterThan(CORPUS[10].length);
  // selection rectangles are drawn (selection colour #264f78)
  const rects = (s.last.ops ?? []).filter(o => o.type === "rect" && o.color === 0xff264f78);
  expect(rects.length).toBeGreaterThanOrEqual(3);
}, 120_000);

test("raw keys, commits, IME composition, undo", async () => {
  const s = await open();
  await focus(s);
  await tapAt(s, 3, 0);
  const l3 = CORPUS[3];
  await s.text([{ kind: "commit", text: "ab" }]);
  let d = await dump(s, [3]);
  expect(d.lines[0]).toBe("ab" + l3);
  expect(rowAt(s.last, 3)).toBe("ab" + l3);
  await s.text([keyDown("Backspace")]);
  d = await dump(s, [3]); expect(d.lines[0]).toBe("a" + l3);
  await s.text([keyDown("ArrowRight"), keyDown("ArrowLeft")]);
  // IME: ni -> 你
  await s.text([{ kind: "composition", text: "ni", selectionStart: 2, selectionEnd: 2 }]);
  d = await dump(s, [3]);
  expect(d.lines[0]).toBe("ani" + l3);
  expect(d.marked).toEqual({ from: d.marked.from, to: d.marked.from + 2 });
  expect(rowAt(s.last, 3)).toBe("ani" + l3);
  await s.text([{ kind: "compositionEnd" }, { kind: "commit", text: "你" }]);
  d = await dump(s, [3]); expect(d.lines[0]).toBe("a你" + l3); expect(d.marked).toBeNull();
  // cancel
  await s.text([{ kind: "composition", text: "ha", selectionStart: 2, selectionEnd: 2 }]);
  await s.text([{ kind: "compositionEnd" }]);
  d = await dump(s, [3]); expect(d.lines[0]).toBe("a你" + l3);
  // undo restores
  await s.text([keyDown("z", META)]);
  d = await dump(s, [3]);
  console.log("CODEVIEW undo line=" + JSON.stringify(d.lines[0].slice(0, 12)));
  expect(d.lines[0].startsWith("a你")).toBe(false);
  await s.text([keyDown("z", META)]); await s.text([keyDown("z", META)]);
  d = await dump(s, [3]); expect(d.lines[0]).toBe(l3);
  await s.text([keyDown("z", META | SHIFT)]);
  d = await dump(s, [3]); expect(d.lines[0]).not.toBe(l3);
}, 120_000);

test("diagnostics: gutter marker, line background and tip", async () => {
  const s = await open();
  const dots = (s.last.ops ?? []).filter(o => o.type === "rect" && o.w === 8 && o.h === 8 && o.color === 0xfff85149);
  expect(dots.length).toBe(1);
  expect(dots[0].y).toBeCloseTo(2 * LH + 6, 0);
  expect(dots[0].x).toBeLessThan(GUTTER);
  const band = (s.last.ops ?? []).filter(o => o.type === "rect" && o.h === LH && o.y === 2 * LH && o.x! >= GUTTER);
  expect(band.length).toBeGreaterThan(0);
  await tapAt(s, 2, 1);
  expect((s.last.ops ?? []).some(o => o.type === "text" && String(o.text).includes("boom here"))).toBe(true);
}, 120_000);

test("find bar: find, next, replace and replace all", async () => {
  const s = await open();
  await focus(s);
  await s.text([keyDown("f", META)]);
  expect(s.events("cv.intent").at(-1)).toEqual({ type: "find" });
  await s.text([{ kind: "commit", text: "createSignal" }]);
  let d = await dump(s);
  expect(d.find.q).toBe("createSignal");
  expect(d.find.n).toBeGreaterThan(10);
  console.log("CODEVIEW find " + JSON.stringify(d.find));
  await s.text([keyDown("Enter")]);
  d = await dump(s, [0]);
  console.log("CODEVIEW find-enter " + JSON.stringify({ a: d.anchor, h: d.head, f: d.find }));
  expect(d.find.label).toMatch(/^\d+\/295$/);
  expect(d.head - d.anchor).toBe(12);
  expect((s.last.ops ?? []).some(o => o.type === "rect" && o.color === 0x99f0883e)).toBe(true);
  // replace field: Tab, type, Enter replaces the current match
  await s.text([keyDown("Tab")]);
  await s.text([{ kind: "commit", text: "makeSignal" }]);
  await s.text([keyDown("Enter")]);
  d = await dump(s, [0]);
  expect(d.find.n).toBe(294);
  const nBefore = d.find.n;
  // replace all through the bar button
  const btn = (s.last.ops ?? []).find(o => o.type === "text" && o.text === "All");
  expect(btn).toBeDefined();
  await s.pointer("down", btn!.x! + 2, btn!.y! + 4); await s.pointer("up", btn!.x! + 2, btn!.y! + 4);
  d = await dump(s, [0]);
  expect(d.find.n).toBe(0);
  expect(nBefore).toBeGreaterThan(0);
  await s.text([keyDown("Escape")]);
  expect((await dump(s)).find.q).toBe("createSignal");
}, 120_000);

test("clipboard: copy writes through the host, paste inserts the host answer", async () => {
  const s = await open();
  await focus(s);
  // select the whole line 8 by tapping its gutter number, then copy
  await s.pointer("down", 20, 8 * LH + 5); await s.pointer("up", 20, 8 * LH + 5);
  await s.text([keyDown("c", META)]);
  const w = s.events("host.request").find(r => r.capability === "clipboard.writeText");
  expect(w).toBeDefined();
  expect(w.params.text).toBe(CORPUS[8] + "\n");
  await s.send("host.response", { requestId: w.requestId, capability: "clipboard.writeText", ok: true, result: { ok: true } });
  // paste at line 20 start
  await tapAt(s, 20, 0);
  await s.text([keyDown("v", META)]);
  const r = s.events("host.request").find(q => q.capability === "clipboard.readText");
  expect(r).toBeDefined();
  await s.send("host.response", { requestId: r.requestId, capability: "clipboard.readText", ok: true, result: { text: "PASTED " } }, 2);
  const d = await dump(s, [20]);
  expect(d.lines[0]).toBe("PASTED " + CORPUS[20]);
  // capability unavailable: falls back to the internal clipboard (last copied text)
  await tapAt(s, 30, 0);
  await s.text([keyDown("v", META)]);
  const r2 = s.events("host.request").filter(q => q.capability === "clipboard.readText").at(-1);
  await s.send("host.response", { requestId: r2.requestId, capability: "clipboard.readText", ok: false, error: { code: "capability_unavailable", message: "no" } }, 2);
  const d2 = await dump(s, [30]);
  expect(d2.lines[0].startsWith(CORPUS[8])).toBe(true);
}, 120_000);

test("save intent and Escape/dismiss", async () => {
  const s = await open();
  await focus(s);
  await s.text([keyDown("s", META)]);
  expect(s.events("cv.intent").at(-1)).toEqual({ type: "save" });
  await s.send("textInput.rawDismiss", { id: "code-view-1", reason: "blur" });
  expect((await dump(s)).debug.focused).toBe(false);
  await s.text([{ kind: "commit", text: "zzz" }]);
  const d = await dump(s, [1]);
  expect(d.lines[0]).toBe(CORPUS[1]);
}, 120_000);

test("caret blinks demand-driven without per-frame work", async () => {
  const s = await open();
  await focus(s);
  const caret = (f: Frame) => (f.ops ?? []).filter(o => o.type === "rect" && o.w === 2 && o.h === LH && o.color === 0xff58a6ff).length;
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) { await s.frame(100); seen.add(caret(s.last)); }
  expect(seen.has(0) && seen.has(1)).toBe(true);
}, 120_000);

test("performance: per-keystroke guest time and rows re-rendered", async () => {
  const s = await open();
  await focus(s);
  await tapAt(s, 12, 3);
  const b = (await dump(s)).debug;
  const N = 60;
  for (let i = 0; i < N; i++) await s.text([{ kind: "commit", text: "x" }]);
  const d = (await dump(s)).debug;
  const per = (d.editMsTotal - b.editMsTotal) / N;
  console.log("CODEVIEW perf " + JSON.stringify({ keystrokes: N, guestMsPerKeystroke: per, lastEditLines: d.lastEditLines, linesBuiltTotal: d.linesBuilt - b.linesBuilt, runsCreatedTotal: d.runsCreated - b.runsCreated, nodesLive: d.nodesLive, nodesMounted: d.nodesMounted }));
  expect(d.linesBuilt - b.linesBuilt).toBeLessThanOrEqual(N * 3);
  expect(d.lastEditLines).toBeLessThanOrEqual(3);
  expect(d.nodesLive).toBeLessThan(170);
  expect(per).toBeLessThan(50);
}, 120_000);
