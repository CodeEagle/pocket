import { expect, test } from "bun:test";
import { CodeEditor, TextBuffer, compileQuery, countMatches, findAll, findNext, findPrev, replaceAllEdits, replaceAllTransaction, replaceOneTransaction, single } from "../src/code/index.ts";

test("plain, case-insensitive default, case-sensitive, special chars", () => {
  const t = "Foo foo FOO f.o";
  expect(findAll(t, "foo").matches.map(m => m.from)).toEqual([0, 4, 8]);
  expect(findAll(t, "foo", { caseSensitive: true }).matches.map(m => m.from)).toEqual([4]);
  expect(findAll(t, "f.o").matches).toEqual([{ from: 12, to: 15 }]); // dot is literal
  expect(findAll("a+b (c) [d] $1 \\", "(c)").matches).toHaveLength(1);
  expect(findAll("a\nb", "\n").matches).toEqual([{ from: 1, to: 2 }]);
  expect(findAll("x", "").error).toBeDefined();
});

test("whole word (no lookbehind), unicode and underscores", () => {
  const t = "cat concat cat_ cat. (cat) 猫 cat";
  expect(findAll(t, "cat", { wholeWord: true }).matches.map(m => m.from)).toEqual([0, 16, 22, 29]);
  expect(findAll("foo.bar foobar", "foo", { wholeWord: true }).matches).toHaveLength(1);
  expect(findAll("a1 a", "a", { wholeWord: true }).matches).toEqual([{ from: 3, to: 4 }]);
});

test("regex mode, flags, multiline anchors, zero-length matches", () => {
  const t = "a1\nb22\nc";
  expect(findAll(t, "\\d+", { regex: true }).matches).toEqual([{ from: 1, to: 2 }, { from: 4, to: 6 }]);
  expect(findAll(t, "^[a-c]", { regex: true }).matches).toHaveLength(3);
  expect(findAll(t, "x*", { regex: true }).matches).toHaveLength(0); // empty matches skipped
  expect(findAll("Ab ab", "ab", { regex: true, caseSensitive: true }).matches).toEqual([{ from: 3, to: 5 }]);
  expect(findAll("foo foobar", "foo", { regex: true, wholeWord: true }).matches).toHaveLength(1);
});

test("regex guard: invalid, unsafe, too long, caps, time budget", () => {
  expect(findAll("abc", "(", { regex: true }).error).toMatch(/invalid/);
  expect(findAll("abc", "[", { regex: true }).matches).toEqual([]);
  expect(compileQuery("(a+)+$", { regex: true })).toHaveProperty("error");
  expect(findAll("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$", { regex: true }).error).toMatch(/backtrack/);
  expect(findAll("x", "a".repeat(501), { regex: true }).error).toMatch(/long/);
  const many = "a".repeat(50_000);
  const r = findAll(many, "a", { maxMatches: 100 });
  expect(r.matches).toHaveLength(100);
  expect(r.truncated).toBe(true);
  const slow = findAll("a ".repeat(500_000), "a", { timeBudgetMs: 0, maxMatches: 1_000_000 });
  expect(slow.timedOut || slow.truncated).toBe(true);
  expect(slow.matches.length).toBeLessThan(500_000);
  expect(countMatches("aXa", "a")).toEqual({ count: 2, capped: false, error: undefined });
});

test("findNext / findPrev with wrap", () => {
  const t = "ab ab ab";
  expect(findNext(t, "ab", {}, 0)).toEqual({ from: 0, to: 2 });
  expect(findNext(t, "ab", {}, 1)).toEqual({ from: 3, to: 5 });
  expect(findNext(t, "ab", {}, 7)).toEqual({ from: 0, to: 2 });
  expect(findNext(t, "ab", {}, 7, false)).toBeNull();
  expect(findNext(t, "zz", {}, 0)).toBeNull();
  expect(findPrev(t, "ab", {}, 8)).toEqual({ from: 6, to: 8 });
  expect(findPrev(t, "ab", {}, 6)).toEqual({ from: 3, to: 5 });
  expect(findPrev(t, "ab", {}, 0)).toEqual({ from: 6, to: 8 });
  expect(findPrev(t, "ab", {}, 0, false)).toBeNull();
  expect(findNext(t, "(", { regex: true }, 0)).toBeNull();
});

test("replace all: plain, regex groups, single undo step, CRLF doc", () => {
  expect(replaceAllEdits("a-b-c", "-", {}, "+").edits).toEqual([{ from: 1, to: 2, text: "+" }, { from: 3, to: 4, text: "+" }]);
  const e = new CodeEditor("John Smith\nJane Doe");
  const r = replaceAllTransaction(e.buffer, "(\\w+) (\\w+)", { regex: true }, "$2, $1 [$&] $$");
  expect(r.count).toBe(2);
  e.dispatch(r.transaction);
  expect(e.buffer.getText()).toBe("Smith, John [John Smith] $\nDoe, Jane [Jane Doe] $");
  expect(e.history.undoDepth).toBe(1);
  e.undo();
  expect(e.buffer.getText()).toBe("John Smith\nJane Doe");
  const crlf = new CodeEditor("a\r\nb\r\na");
  crlf.dispatch(replaceAllTransaction(crlf.buffer, "a", {}, "x\ny").transaction);
  expect(crlf.buffer.toString()).toBe("x\r\ny\r\nb\r\nx\r\ny");
  expect(replaceAllTransaction(new TextBuffer("abc"), "zzz", {}, "q").transaction).toBeNull();
  const cap = replaceAllEdits("a".repeat(1000), "a", { maxMatches: 10 }, "b");
  expect(cap.edits).toHaveLength(10);
  expect(cap.truncated).toBe(true);
  // 5,000 lines, 5,000 replacements, descending application stays fast
  const big = new CodeEditor(Array.from({ length: 5000 }, (_, i) => "let item" + i + " = 1;").join("\n"));
  const t0 = Date.now();
  const br = replaceAllTransaction(big.buffer, "item", { timeBudgetMs: 2000 }, "elem");
  big.dispatch(br.transaction);
  expect(br.count).toBe(5000);
  expect(big.buffer.line(4999)).toBe("let elem4999 = 1;");
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("replace one: replaces when selected, otherwise selects next", () => {
  const e = new CodeEditor("foo bar foo");
  e.selection = single(0);
  let tr = replaceOneTransaction(e.buffer, e.selection, "foo", {}, "X");
  expect(tr!.edits).toEqual([]);
  e.dispatch(tr);
  expect(e.selection).toEqual(single(0, 3));
  tr = replaceOneTransaction(e.buffer, e.selection, "foo", {}, "X");
  e.dispatch(tr);
  expect(e.buffer.getText()).toBe("X bar foo");
  expect(e.selection).toEqual(single(6, 9));
  e.dispatch(replaceOneTransaction(e.buffer, e.selection, "foo", {}, "X"));
  expect(e.buffer.getText()).toBe("X bar X");
  expect(e.selection).toEqual(single(7)); // no further match: cursor after the replacement
});
