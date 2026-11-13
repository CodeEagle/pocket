import { expect, test } from "bun:test";
import { CodeEditor, lookupKey, parseKey, commandTable, normalize, ChangeMap, rangeFrom, rangeTo } from "../src/code/index.ts";

/** Build an editor from text with `|` cursors or one `[sel]`. */
function mk(marked: string, opts: any = {}): CodeEditor {
  const ranges: { anchor: number; head: number }[] = [];
  let text = "", open = -1;
  for (const ch of marked) {
    if (ch === "|") ranges.push({ anchor: text.length, head: text.length });
    else if (ch === "[") open = text.length;
    else if (ch === "]") ranges.push({ anchor: open, head: text.length });
    else text += ch;
  }
  const e = new CodeEditor(text, opts);
  if (ranges.length) e.selection = { ranges, primary: 0 };
  return e;
}
function show(e: CodeEditor): string {
  const t = e.buffer.getText();
  const marks: [number, string][] = [];
  for (const r of e.selection.ranges) {
    if (r.anchor === r.head) marks.push([r.head, "|"]);
    else { marks.push([rangeFrom(r), "["]); marks.push([rangeTo(r), "]"]); }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let out = "", last = 0;
  for (const [pos, m] of marks) { out += t.slice(last, pos) + m; last = pos; }
  return out + t.slice(last);
}
const key = (e: CodeEditor, k: string) => e.handleKey(k);
const type = (e: CodeEditor, s: string) => { for (const ch of s) e.handleInput({ kind: "commit", text: ch }); };

test("keymap: real key names", () => {
  expect(lookupKey("Meta+z")).toBe("undo");
  expect(lookupKey("Meta+Shift+z")).toBe("redo");
  expect(lookupKey("Meta+Shift+Z")).toBe("redo");
  expect(lookupKey("Control+Shift+z", "other")).toBe("redo");
  expect(lookupKey("Control+z", "other")).toBe("undo");
  expect(lookupKey("Control+y", "other")).toBe("redo");
  expect(lookupKey("Alt+ArrowLeft")).toBe("cursorWordLeft");
  expect(lookupKey("Alt+Shift+ArrowRight")).toBe("selectWordRight");
  expect(lookupKey("Control+ArrowLeft", "other")).toBe("cursorWordLeft");
  expect(lookupKey("Meta+ArrowLeft")).toBe("cursorLineStart");
  expect(lookupKey("Meta+ArrowDown")).toBe("cursorDocEnd");
  expect(lookupKey("Shift+ArrowUp")).toBe("selectUp");
  expect(lookupKey("Meta+a")).toBe("selectAll");
  expect(lookupKey("Meta+c")).toBe("copy");
  expect(lookupKey("Meta+x")).toBe("cut");
  expect(lookupKey("Meta+v")).toBe("paste");
  expect(lookupKey("Meta+f")).toBe("find");
  expect(lookupKey("Meta+g")).toBe("findNext");
  expect(lookupKey("Meta+Shift+g")).toBe("findPrev");
  expect(lookupKey("Meta+s")).toBe("save");
  expect(lookupKey("Meta+/")).toBe("toggleLineComment");
  expect(lookupKey("Control+/", "other")).toBe("toggleLineComment");
  expect(lookupKey("Tab")).toBe("indent");
  expect(lookupKey("Shift+Tab")).toBe("outdent");
  expect(lookupKey("Alt+Backspace")).toBe("deleteWordBackward");
  expect(lookupKey("Alt+ArrowUp")).toBe("moveLineUp");
  expect(lookupKey("Alt+Shift+ArrowDown")).toBe("duplicateLineDown");
  expect(lookupKey("Alt+Meta+ArrowDown")).toBe("addCursorBelow");
  expect(lookupKey("Enter")).toBe("newline");
  // printable keys and foreign modifiers are not shortcuts
  expect(lookupKey("a")).toBeNull();
  expect(lookupKey("Shift+A")).toBeNull();
  expect(lookupKey("Control+z", "mac")).toBeNull();
  expect(lookupKey("Meta+z", "other")).toBeNull();
  expect(lookupKey("Meta+q")).toBeNull();
  expect(parseKey("Control++")).toMatchObject({ key: "+", control: true });
  expect(parseKey("Control+Alt+Shift+Meta+ArrowUp")).toMatchObject({ key: "ArrowUp", control: true, alt: true, shift: true, meta: true });
  for (const id of ["cursorLeft", "selectAll", "outdent"]) expect(commandTable[id]).toBeDefined();
});

test("typing, auto-close, overtype, wrap selection", () => {
  const e = mk("|");
  type(e, "f(");
  expect(show(e)).toBe("f(|)");
  type(e, "a)");
  expect(show(e)).toBe("f(a)|");
  const q = mk("|"); type(q, "'"); expect(show(q)).toBe("'|'"); type(q, "'"); expect(show(q)).toBe("''|");
  const apos = mk("don|"); type(apos, "'"); expect(show(apos)).toBe("don'|");
  const w = mk("a[bc]d"); type(w, "("); expect(show(w)).toBe("a([bc])d");
  const wq = mk("[x]"); type(wq, '"'); expect(show(wq)).toBe('"[x]"');
  const nx = mk("|x"); type(nx, "("); expect(show(nx)).toBe("(|x");
  const off = mk("|", { command: { autoClose: false } }); type(off, "("); expect(show(off)).toBe("(|");
  const br = mk("|"); type(br, "{"); expect(show(br)).toBe("{|}");
});

test("newline auto-indent and extra indent", () => {
  let e = mk("  foo|"); key(e, "Enter"); expect(show(e)).toBe("  foo\n  |");
  e = mk("  foo {|"); key(e, "Enter"); expect(show(e)).toBe("  foo {\n    |");
  e = mk("x = (|"); key(e, "Enter"); expect(show(e)).toBe("x = (\n  |");
  e = mk("const f = () =>|"); key(e, "Enter"); expect(show(e)).toBe("const f = () =>\n  |");
  e = mk("  if (a) {|}"); key(e, "Enter"); expect(show(e)).toBe("  if (a) {\n    |\n  }");
  e = mk("    ab|cd"); key(e, "Enter"); expect(show(e)).toBe("    ab\n    |cd");
  e = mk(" |  x"); key(e, "Enter"); expect(show(e)).toBe(" \n |  x");
  e = mk("a[bc]d"); key(e, "Enter"); expect(show(e)).toBe("a\n|d");
  e = mk("\t[a]", { command: { indentUnit: "\t" } }); key(e, "Enter"); expect(show(e)).toBe("\t\n\t|");
});

test("backspace / delete: char, word, grapheme, pair, smart indent, selection", () => {
  let e = mk("ab|c"); key(e, "Backspace"); expect(show(e)).toBe("a|c");
  e = mk("a|"); key(e, "Backspace"); expect(show(e)).toBe("|");
  e = mk("|a"); expect(key(e, "Backspace").changed).toBe(false);
  e = mk("a\n|b"); key(e, "Backspace"); expect(show(e)).toBe("a|b");
  e = mk("a😀|b"); key(e, "Backspace"); expect(show(e)).toBe("a|b");
  e = mk("é|x"); key(e, "Backspace"); expect(show(e)).toBe("|x");
  e = mk("👨‍👩‍👧|"); key(e, "Backspace"); expect(show(e)).toBe("|");
  e = mk("a|😀b"); key(e, "Delete"); expect(show(e)).toBe("a|b");
  e = mk("foo bar|"); key(e, "Alt+Backspace"); expect(show(e)).toBe("foo |");
  e = mk("foo bar|"); key(e, "Meta+Backspace"); expect(show(e)).toBe("|");
  e = mk("|foo bar"); key(e, "Alt+Delete"); expect(show(e)).toBe("| bar");
  e = mk("|foo bar"); key(e, "Delete"); expect(show(e)).toBe("|oo bar");
  e = mk("a|\nb"); key(e, "Delete"); expect(show(e)).toBe("a|b");
  e = mk("(|)"); key(e, "Backspace"); expect(show(e)).toBe("|");
  e = mk("'|'"); key(e, "Backspace"); expect(show(e)).toBe("|");
  e = mk("(|x)"); key(e, "Backspace"); expect(show(e)).toBe("|x)");
  e = mk("     |x"); key(e, "Backspace"); expect(show(e)).toBe("    |x");
  e = mk("    |x"); key(e, "Backspace"); expect(show(e)).toBe("  |x");
  e = mk("a[bc]d"); key(e, "Backspace"); expect(show(e)).toBe("a|d");
  e = mk("a[bc]d"); key(e, "Delete"); expect(show(e)).toBe("a|d");
  e = mk("a|b c|d"); key(e, "Backspace"); expect(show(e)).toBe("|b |d");
  e = mk("ab|c|d"); key(e, "Alt+Backspace"); expect(show(e)).toBe("|d");
});

test("indent / outdent", () => {
  let e = mk("a|"); key(e, "Tab"); expect(show(e)).toBe("a |");
  e = mk("|a"); key(e, "Tab"); expect(show(e)).toBe("  |a");
  e = mk("[a\nb]"); key(e, "Tab"); expect(show(e)).toBe("[  a\n  b]");
  e = mk("[a\nb\n]c"); key(e, "Tab"); expect(e.buffer.getText()).toBe("  a\n  b\nc");
  e = mk("[a\n\nb]"); key(e, "Tab"); expect(e.buffer.getText()).toBe("  a\n\n  b");
  e = mk("  a\n   [b]\n"); key(e, "Shift+Tab"); expect(e.buffer.getText()).toBe("  a\n b\n");
  e = mk("\ta|"); key(e, "Shift+Tab"); expect(e.buffer.getText()).toBe("a");
  e = mk("x|"); expect(key(e, "Shift+Tab").changed).toBe(false);
  e = mk("    a|", { command: { indentUnit: "    " } }); key(e, "Shift+Tab"); expect(show(e)).toBe("a|");
  e = mk("a|", { command: { indentUnit: "\t" } }); key(e, "Tab"); expect(show(e)).toBe("a\t|");
  e = mk("a|\nb|"); key(e, "Tab"); expect(e.buffer.getText()).toBe("a \nb ");
  // Cmd+] indents lines
  e = mk("a|"); key(e, "Meta+]"); expect(e.buffer.getText()).toBe("  a");
});

test("movement: char, word, line, doc, page, goal column, collapse", () => {
  let e = mk("ab|c"); key(e, "ArrowLeft"); expect(show(e)).toBe("a|bc");
  e = mk("a|\nb"); key(e, "ArrowRight"); expect(show(e)).toBe("a\n|b");
  e = mk("a|😀b"); key(e, "ArrowRight"); expect(show(e)).toBe("a😀|b");
  e = mk("a[bc]d"); key(e, "ArrowLeft"); expect(show(e)).toBe("a|bcd");
  e = mk("a[bc]d"); key(e, "ArrowRight"); expect(show(e)).toBe("abc|d");
  e = mk("a|bc"); key(e, "Shift+ArrowRight"); expect(show(e)).toBe("a[b]c");
  e = mk("foo bar|"); key(e, "Alt+ArrowLeft"); expect(show(e)).toBe("foo |bar");
  e = mk("|foo bar"); key(e, "Alt+ArrowRight"); expect(show(e)).toBe("foo| bar");
  e = mk("|foo bar"); key(e, "Alt+Shift+ArrowRight"); expect(show(e)).toBe("[foo] bar");
  e = mk("|\nfoo"); key(e, "Alt+ArrowRight"); expect(show(e)).toBe("\n|foo");
  e = mk("  ab|c"); key(e, "Home"); expect(show(e)).toBe("  |abc"); key(e, "Home"); expect(show(e)).toBe("|  abc");
  e = mk("  a|bc"); key(e, "End"); expect(show(e)).toBe("  abc|");
  e = mk("a|bc\nd"); key(e, "Meta+ArrowDown"); expect(show(e)).toBe("abc\nd|");
  e = mk("a\nb|c"); key(e, "Meta+ArrowUp"); expect(show(e)).toBe("|a\nbc");
  e = mk("a\nb|c"); key(e, "Meta+Shift+ArrowUp"); expect(show(e)).toBe("[a\nb]c");
  e = mk("long|line\nx\nlonger line"); key(e, "ArrowDown"); expect(show(e)).toBe("longline\nx|\nlonger line");
  key(e, "ArrowDown"); expect(show(e)).toBe("longline\nx\nlong|er line");
  e = mk("|a"); key(e, "ArrowUp"); expect(show(e)).toBe("|a");
  e = mk("a|"); key(e, "ArrowDown"); expect(show(e)).toBe("a|");
  e = mk("你好|吗\nabc"); key(e, "ArrowDown"); expect(show(e)).toBe("你好吗\nab|c");
  const lines = Array.from({ length: 50 }, (_, i) => "l" + i).join("\n");
  e = new CodeEditor(lines, { command: { pageLines: 10 } }); key(e, "PageDown"); expect(e.buffer.positionAt(e.selection.ranges[0].head).line).toBe(10);
  key(e, "Shift+PageDown"); expect(e.selection.ranges[0].anchor).not.toBe(e.selection.ranges[0].head);
  e = mk("a|b"); key(e, "Meta+a"); expect(show(e)).toBe("[ab]");
  e = mk("a|b"); key(e, "Control+ArrowLeft"); expect(show(e)).toBe("a|b"); // mac keymap ignores Control
});

test("duplicate line, move lines, toggle comment", () => {
  let e = mk("a\nb|\nc"); key(e, "Alt+Shift+ArrowDown"); expect(show(e)).toBe("a\nb\nb|\nc");
  e = mk("a\nb|\nc"); key(e, "Alt+Shift+ArrowUp"); expect(show(e)).toBe("a\nb|\nb\nc");
  e = mk("[a\nb]\nc"); key(e, "Alt+Shift+ArrowDown"); expect(show(e)).toBe("a\nb\n[a\nb]\nc");
  e = mk("a\nb|\nc"); key(e, "Alt+ArrowUp"); expect(show(e)).toBe("b|\na\nc");
  e = mk("a\nb|\nc"); key(e, "Alt+ArrowDown"); expect(show(e)).toBe("a\nc\nb|");
  e = mk("a|\nb"); expect(key(e, "Alt+ArrowUp").changed).toBe(false);
  e = mk("a\nb|"); expect(key(e, "Alt+ArrowDown").changed).toBe(false);
  e = mk("[a\nb]\nc\nd"); key(e, "Alt+ArrowDown"); expect(show(e)).toBe("c\n[a\nb]\nd");
  e = mk("a|"); key(e, "Meta+/"); expect(show(e)).toBe("// a|"); key(e, "Meta+/"); expect(show(e)).toBe("a|");
  e = mk("  a\n\n    [b\n  c]"); key(e, "Meta+/"); expect(e.buffer.getText()).toBe("  a\n\n  //   b\n  // c");
  key(e, "Meta+/"); expect(e.buffer.getText()).toBe("  a\n\n    b\n  c");
  e = mk("//x|"); key(e, "Meta+/"); expect(show(e)).toBe("x|");
  e = mk("|"); key(e, "Meta+/"); expect(e.buffer.getText()).toBe("// ");
  e = mk("a|", { command: { lineComment: null } }); expect(key(e, "Meta+/").changed).toBe(false);
  e = mk("a|", { command: { lineComment: "#" } }); key(e, "Meta+/"); expect(e.buffer.getText()).toBe("# a");
  // undo of a line operation is one step
  e = mk("a\nb|\nc"); key(e, "Alt+Shift+ArrowDown"); key(e, "Meta+z"); expect(show(e)).toBe("a\nb|\nc");
});

test("multi-cursor: typing, backspace, add cursor, escape, overlapping merge", () => {
  let e = mk("a|\nb|\nc|");
  type(e, "x");
  expect(show(e)).toBe("ax|\nbx|\ncx|");
  key(e, "Backspace"); expect(show(e)).toBe("a|\nb|\nc|");
  key(e, "Escape"); expect(show(e)).toBe("a|\nb\nc");
  e = mk("ab|\ncd"); key(e, "Alt+Meta+ArrowDown"); expect(e.selection.ranges.length).toBe(2); expect(show(e)).toBe("ab|\ncd|");
  type(e, "!"); expect(show(e)).toBe("ab!|\ncd!|");
  key(e, "Meta+z"); expect(show(e)).toBe("ab|\ncd|");
  e = mk("foo bar|\nfoo|"); key(e, "Alt+Backspace"); expect(show(e)).toBe("foo |\n|");
  e = mk("a|b|"); key(e, "Alt+Backspace"); expect(show(e)).toBe("|");
  // newline at each cursor
  e = mk("  a|\n  b|"); key(e, "Enter"); expect(e.buffer.getText()).toBe("  a\n  \n  b\n  ");
  const n = normalize({ ranges: [{ anchor: 5, head: 8 }, { anchor: 2, head: 6 }], primary: 0 });
  expect(n.ranges).toEqual([{ anchor: 2, head: 8 }]);
  const m = new ChangeMap([{ from: 2, to: 4, text: "xyz" }]);
  expect(m.map(1)).toBe(1); expect(m.map(4)).toBe(5); expect(m.map(10)).toBe(11);
});

test("clipboard intents, paste distribution, cut line", () => {
  let e = mk("a[bc]d");
  let o = key(e, "Meta+c"); expect(o.intent).toEqual({ type: "clipboard.write", text: "bc", cut: false });
  o = key(e, "Meta+x"); expect(o.intent).toEqual({ type: "clipboard.write", text: "bc", cut: true }); expect(show(e)).toBe("a|d");
  o = key(e, "Meta+v"); expect(o.intent).toEqual({ type: "clipboard.read" });
  e.paste("XY"); expect(show(e)).toBe("aXY|d");
  e = mk("one|\ntwo"); expect(key(e, "Meta+c").intent).toEqual({ type: "clipboard.write", text: "one\n", cut: false });
  key(e, "Meta+x"); expect(e.buffer.getText()).toBe("two");
  e = mk("one\ntwo|"); key(e, "Meta+x"); expect(e.buffer.getText()).toBe("one");
  e = mk("a|\nb|"); e.paste("1\n2"); expect(e.buffer.getText()).toBe("a1\nb2");
  e = mk("a|\nb|"); e.paste("1\n2\n3"); expect(e.buffer.getText()).toBe("a1\n2\n3\nb1\n2\n3");
  for (const [k, t] of [["Meta+f", "find"], ["Meta+g", "findNext"], ["Meta+Shift+g", "findPrev"], ["Meta+s", "save"]]) expect(key(mk("x|"), k).intent).toEqual({ type: t });
  expect(key(mk("x|"), "Meta+q").handled).toBe(false);
});

test("CRLF document keeps its EOL through commands", () => {
  const e = new CodeEditor("a\r\nb\r\n");
  e.selection = { ranges: [{ anchor: 1, head: 1 }], primary: 0 };
  key(e, "Enter");
  expect(e.buffer.toString()).toBe("a\r\n\r\nb\r\n");
});
