import { expect, test } from "bun:test";
import { TextBuffer, nextBoundary, prevBoundary, snapBoundary, wordLeft, wordRight } from "../src/code/index.ts";

test("empty document", () => {
  const b = new TextBuffer("");
  expect(b.lineCount).toBe(1);
  expect(b.length).toBe(0);
  expect(b.positionAt(0)).toEqual({ line: 0, column: 0 });
  expect(b.offsetAt(5, 5)).toBe(0);
  expect(b.getText()).toBe("");
});

test("offset <-> position, last line without newline, trailing newline", () => {
  const b = new TextBuffer("ab\ncde\nf");
  expect(b.lineCount).toBe(3);
  expect(b.offsetAt(1, 2)).toBe(5);
  expect(b.positionAt(5)).toEqual({ line: 1, column: 2 });
  expect(b.positionAt(3)).toEqual({ line: 1, column: 0 });
  expect(b.positionAt(2)).toEqual({ line: 0, column: 2 });
  expect(b.positionAt(8)).toEqual({ line: 2, column: 1 });
  expect(b.positionAt(999)).toEqual({ line: 2, column: 1 });
  const t = new TextBuffer("a\n");
  expect(t.lineCount).toBe(2);
  expect(t.line(1)).toBe("");
  expect(t.toString()).toBe("a\n");
});

test("CRLF round trip, LF round trip, dominant EOL and mixed flag", () => {
  const crlf = "a\r\nb\r\nc";
  const b = new TextBuffer(crlf);
  expect(b.eol).toBe("\r\n");
  expect(b.getText()).toBe("a\nb\nc");
  expect(b.length).toBe(5);
  b.replace(1, 1, "x\ny");
  expect(b.toString()).toBe("ax\r\ny\r\nb\r\nc");
  expect(new TextBuffer("a\nb\n").toString()).toBe("a\nb\n");
  const m = new TextBuffer("a\r\nb\nc\nd");
  expect(m.mixedEol).toBe(true);
  expect(m.eol).toBe("\n");
  const ins = new TextBuffer("a");
  ins.replace(1, 1, "\r\nb");
  expect(ins.getText()).toBe("a\nb");
});

test("replace emits change events with line ranges and bumps version", () => {
  const b = new TextBuffer("one\ntwo\nthree");
  const events: any[] = [];
  const off = b.onChange(c => events.push(c));
  const v = b.version;
  b.replace(2, 9, "X\nY\nZ\nW");
  expect(b.getText()).toBe("onX\nY\nZ\nWhree");
  expect(b.version).toBe(v + 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ startLine: 0, oldLineCount: 3, newLineCount: 4, offset: 2, removed: "e\ntwo\nt" });
  off();
  b.replace(0, 0, "q");
  expect(events).toHaveLength(1);
});

test("random edits stay consistent with a string model", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const b = new TextBuffer("hello\nworld\n\nlast");
  let model = b.getText();
  const alphabet = ["a", "b", "\n", "😀", "你", " "];
  for (let i = 0; i < 400; i++) {
    const from = rnd(model.length + 1), to = Math.min(model.length, from + rnd(6));
    let ins = ""; for (let k = rnd(4); k > 0; k--) ins += alphabet[rnd(alphabet.length)];
    b.replace(from, to, ins);
    model = model.slice(0, from) + ins + model.slice(to);
    expect(b.length).toBe(model.length);
    if (i % 20 === 0) {
      expect(b.getText()).toBe(model);
      const o = rnd(model.length + 1);
      const p = b.positionAt(o);
      expect(b.offsetAt(p.line, p.column)).toBe(o);
      expect(b.getRange(o, Math.min(model.length, o + 7))).toBe(model.slice(o, o + 7));
    }
  }
  expect(b.getText()).toBe(model);
});

test("5,000 line / 2 MiB document edits", () => {
  const line = "x".repeat(399);
  const text = Array.from({ length: 5000 }, () => line).join("\n");
  expect(text.length).toBeGreaterThan(1_900_000);
  const b = new TextBuffer(text);
  expect(b.lineCount).toBe(5000);
  expect(b.lineStart(4999)).toBe(4999 * 400);
  b.replace(b.offsetAt(2500, 10), b.offsetAt(2500, 10), "INS\nERT");
  expect(b.lineCount).toBe(5001);
  expect(b.line(2500)).toBe("x".repeat(10) + "INS");
  expect(b.positionAt(b.length)).toEqual({ line: 5000, column: 399 });
  b.replace(0, b.length, "");
  expect(b.lineCount).toBe(1);
});

test("very long single line", () => {
  const b = new TextBuffer("y".repeat(1_000_000));
  b.replace(500_000, 500_001, "ZZ");
  expect(b.length).toBe(1_000_001);
  expect(b.positionAt(500_001)).toEqual({ line: 0, column: 500_001 });
});

test("grapheme boundaries: surrogates, combining, ZWJ, flags, CRLF", () => {
  const s = "a😀b";
  expect(nextBoundary(s, 1)).toBe(3);
  expect(prevBoundary(s, 3)).toBe(1);
  expect(snapBoundary(s, 2)).toBe(1);
  const e = "éx"; // e + combining acute
  expect(nextBoundary(e, 0)).toBe(2);
  expect(prevBoundary(e, 2)).toBe(0);
  const fam = "👨‍👩‍👧x"; // man ZWJ woman ZWJ girl
  expect(nextBoundary(fam, 0)).toBe(fam.length - 1);
  expect(prevBoundary(fam, fam.length - 1)).toBe(0);
  const skin = "👍🏽!";
  expect(nextBoundary(skin, 0)).toBe(4);
  expect(prevBoundary(skin, 4)).toBe(0);
  const flags = "🇯🇵🇺🇸";
  expect(nextBoundary(flags, 0)).toBe(4);
  expect(prevBoundary(flags, 8)).toBe(4);
  expect(nextBoundary("\r\nz", 0)).toBe(2);
  expect(prevBoundary("\r\nz", 2)).toBe(0);
  expect(nextBoundary("", 0)).toBe(0);
  expect(prevBoundary("abc", 0)).toBe(0);
  // lone surrogate halves never loop
  expect(nextBoundary("\ud83d", 0)).toBe(1);
  expect(prevBoundary("\ude00", 1)).toBe(0);
});

test("word movement helpers", () => {
  expect(wordLeft("foo bar", 7)).toBe(4);
  expect(wordLeft("foo  bar", 5)).toBe(0);
  expect(wordLeft("a.b", 3)).toBe(2);
  expect(wordRight("foo bar", 0)).toBe(3);
  expect(wordRight("foo bar", 3)).toBe(7);
  expect(wordRight("你好世界 abc", 0)).toBe(4);
  expect(wordLeft("你好 abc", 2)).toBe(0);
  expect(wordRight("x", 1)).toBe(1);
});
