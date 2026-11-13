import { expect, test } from "bun:test";
import * as api from "../src/code/index.ts";

const { buildLineModel, tokenizeLine, hexToAbgr, calibrate, makeMetrics, sourceColX, displayToSourceCol, ClickTracker, spansForLines, matchesInRange, slotLine, diagnosticsByLine, RawTextSession, FindModel, CodeEditor, darkTheme, initialState } = api;

test("hexToAbgr packs ABGR", () => {
  expect(hexToAbgr("#112233")).toBe(0xff332211);
  expect(hexToAbgr("#11223380")).toBe(0x80332211);
});

test("line model: tabs expand, nbsp mode, runs merge and skip foreground", () => {
  const text = "\tlet x = 1;";
  const out: number[] = []; tokenizeLine("ts", text, initialState("ts"), out);
  const m = buildLineModel(text, out, darkTheme, 4, true);
  expect(m.display).toBe("    let x = 1;");
  expect(m.colMap[1]).toBe(4);
  expect(m.runs.length).toBeGreaterThan(0);
  for (let i = 1; i < m.runs.length; i++) expect(m.runs[i].start).toBeGreaterThanOrEqual(m.runs[i - 1].end);
  const kw = m.runs[0]; expect(kw.start).toBe(4); expect(kw.end).toBe(7);
  const plain = buildLineModel(text, out, darkTheme, 4, false);
  expect(plain.display).toBe("    let x = 1;");
});

test("line model: astral characters use codepoint offsets", () => {
  const text = "a😀 let";
  const out: number[] = []; tokenizeLine("ts", text, initialState("ts"), out);
  const m = buildLineModel(text, out, darkTheme, 4, false);
  const kw = m.runs.find(r => r.end - r.start === 3)!;
  expect(kw.start).toBe(3); // a=0, emoji=1 (one codepoint), space=2, "let" starts at codepoint 3
});

test("calibration and metrics", () => {
  const c = calibrate({ digit: 180, space: 100, nbsp: 180, cjk: 160 })!;
  expect(c.charWidth).toBe(9); expect(c.nbsp).toBe(true); expect(c.monospace).toBe(true);
  expect(c.cjkCells).toBeCloseTo(16 / 9, 5);
  expect(calibrate({ digit: 0, space: 0, nbsp: 0, cjk: 0 })).toBeNull();
  const half = calibrate({ digit: 180, space: 100, nbsp: 100, cjk: 160 })!;
  expect(half.nbsp).toBe(false); expect(half.monospace).toBe(false);
  const m = makeMetrics(20, half);
  const model = buildLineModel("a b", undefined, darkTheme, 4, false);
  expect(sourceColX(model, 2, m)).toBeCloseTo(9 + 5, 5);
  expect(displayToSourceCol(buildLineModel("\tx", undefined, darkTheme, 4, false), 2)).toBeLessThanOrEqual(1);
});

test("click tracker counts 1..3 and resets", () => {
  const c = new ClickTracker(500, 6);
  expect(c.register(10, 10, 0)).toBe(1); expect(c.register(11, 10, 100)).toBe(2); expect(c.register(11, 10, 200)).toBe(3);
  expect(c.register(11, 10, 300)).toBe(1);
  expect(c.register(11, 10, 2000)).toBe(1);
  expect(c.register(100, 100, 2100)).toBe(1);
});

test("spans, matches and slots", () => {
  const lines = ["abc", "defg", "hi"]; const starts = [0, 4, 9];
  const lineOf = (o: number) => (o >= 9 ? 2 : o >= 4 ? 1 : 0);
  const spans = spansForLines([{ from: 1, to: 11 }], 0, 3, lineOf, l => starts[l], l => lines[l].length, 3);
  expect(spans).toEqual([{ line: 0, fromCol: 1, toCol: 3, eol: true }, { line: 1, fromCol: 0, toCol: 4, eol: true }, { line: 2, fromCol: 0, toCol: 2, eol: false }]);
  expect(spansForLines([{ from: 1, to: 2 }], 1, 3, lineOf, l => starts[l], l => lines[l].length, 3)).toEqual([]);
  const ms = [{ from: 0, to: 2 }, { from: 5, to: 7 }, { from: 10, to: 12 }];
  expect(matchesInRange(ms, 3, 11)).toEqual([ms[1], ms[2]]);
  // ring slots: each line in [first,last) maps to a unique slot and survives a 1-line scroll
  const slots = 6; const at = (first: number) => { const m = new Map<number, number>(); for (let k = 0; k < slots; k++) { const l = slotLine(k, slots, first, first + 5); if (l >= 0) m.set(l, k); } return m; };
  const a = at(10), b = at(11);
  expect(a.size).toBe(5);
  for (let l = 11; l < 15; l++) expect(b.get(l)).toBe(a.get(l));
  expect(diagnosticsByLine([{ line: 1, severity: "warning", message: "w" }, { line: 1, severity: "error", message: "e" }]).get(1)![0].message).toBe("e");
});

test("raw text session: open/update/close, events, dismiss, exclusion", () => {
  const sent: any[] = []; let handler: any = null; let hostL: any = null; const got: any[] = []; const states: any[] = [];
  const mk = (id: string) => new RawTextSession({
    id, emit: (n, p) => { sent.push([n, p]); return true; },
    subscribeText: h => { handler = h; return () => { handler = null; }; },
    subscribeHost: l => { hostL = l; return () => { hostL = null; }; },
    onEvent: e => got.push(e), onState: (o, r) => states.push([id, o, r]),
  });
  const a = mk("a"), b = mk("b");
  const rect = { x: 1, y: 2, w: 2, h: 16 };
  expect(a.open(rect)).toBe(true);
  expect(sent[0]).toEqual(["textInput.rawOpen", { id: "a", rect }]);
  a.update(rect); expect(sent.length).toBe(1); // unchanged -> no message
  a.update({ ...rect, x: 5 }); expect(sent[1][0]).toBe("textInput.rawUpdate");
  expect(handler({ kind: "key", key: "Meta+z", pressed: true, repeat: false })).toBe(true);
  expect(handler({ kind: "composition", text: "ni", selectionStart: 2, selectionEnd: 2 })).toBe(true);
  handler({ kind: "key", key: "a", pressed: false, repeat: false }); handler({ kind: "compositionEnd" }); handler({ kind: "commit", text: "你" });
  expect(got.map(e => e.kind)).toEqual(["keyDown", "composition", "keyUp", "compositionEnd", "commit"]);
  hostL({ method: "textInput.rawOpened", params: { id: "a" } }); expect(a.isAcked).toBe(true);
  b.open(rect); // second session closes the first locally
  expect(a.isOpen).toBe(false); expect(b.isOpen).toBe(true); expect(a.lastDismiss).toBe("replaced");
  hostL({ method: "textInput.rawDismiss", params: { id: "b", reason: "blur" } });
  expect(b.isOpen).toBe(false); expect(states.at(-1)).toEqual(["b", false, "blur"]);
  expect(handler).toBeNull();
  b.open(rect); b.close();
  expect(sent.at(-1)).toEqual(["textInput.rawClose", { id: "b" }]);
  b.close(); expect(sent.filter(s => s[0] === "textInput.rawClose").length).toBe(1);
});

test("raw session: refused emit leaves it closed", () => {
  const s = new RawTextSession({ id: "x", emit: () => false, subscribeText: () => () => {}, onEvent: () => {} });
  expect(s.open({ x: 0, y: 0, w: 2, h: 16 })).toBe(false); expect(s.isOpen).toBe(false);
});

test("find model: next/prev/replace/replaceAll/label", () => {
  const ed = new CodeEditor("foo bar foo\nfoo");
  const f = new FindModel(ed);
  f.query = "foo"; f.refresh();
  expect(f.matches.length).toBe(3); expect(f.label()).toBe("3");
  f.next(); expect(f.label()).toBe("1/3");
  f.next(); expect(f.label()).toBe("2/3");
  f.prev(); expect(f.label()).toBe("1/3");
  f.replacement = "X"; f.replaceOne();
  expect(ed.buffer.getText()).toBe("X bar foo\nfoo");
  expect(f.replaceAll()).toBe(2);
  expect(ed.buffer.getText()).toBe("X bar X\nX");
  expect(ed.undo()).toBe(true); expect(ed.buffer.getText()).toBe("X bar foo\nfoo");
  f.query = "("; f.options = { regex: true }; f.refresh(); expect(f.label()).toBe("!");
  f.query = "zzz"; f.options = {}; f.refresh(); expect(f.label()).toBe("No results");
});
