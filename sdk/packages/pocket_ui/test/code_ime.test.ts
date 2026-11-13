import { expect, test } from "bun:test";
import { CodeEditor, single } from "../src/code/index.ts";

function mk(text: string, sel = single(text.length)) {
  const e = new CodeEditor(text);
  e.selection = sel;
  return e;
}
const comp = (e: CodeEditor, text: string, s?: number, t?: number) => e.handleInput({ kind: "composition", text, selectionStart: s ?? text.length, selectionEnd: t ?? s ?? text.length });

test("Pinyin: ni -> candidate 你 is one undo step, composition never enters history", () => {
  const e = mk("ab");
  comp(e, "n"); comp(e, "ni");
  expect(e.buffer.getText()).toBe("abni");
  expect(e.marked).toEqual({ from: 2, to: 4 });
  expect(e.selection).toEqual(single(4));
  expect(e.history.undoDepth).toBe(0);
  e.handleInput({ kind: "compositionEnd" });
  expect(e.buffer.getText()).toBe("ab");
  expect(e.marked).toBeNull();
  e.handleInput({ kind: "commit", text: "你" });
  expect(e.buffer.getText()).toBe("ab你");
  expect(e.selection).toEqual(single(3));
  expect(e.history.undoDepth).toBe(1);
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("ab");
  expect(e.selection).toEqual(single(2));
});

test("commit while still composing equals end + commit", () => {
  const e = mk("");
  comp(e, "ni");
  e.handleInput({ kind: "commit", text: "你" });
  expect(e.buffer.getText()).toBe("你");
  expect(e.marked).toBeNull();
  expect(e.history.undoDepth).toBe(1);
});

test("Japanese conversion with a clause selection inside the composition", () => {
  const e = mk("x");
  comp(e, "にほんご", 0, 2);   // first clause selected
  expect(e.buffer.getText()).toBe("xにほんご");
  expect(e.selection).toEqual(single(1, 3));
  comp(e, "日本語", 3, 3);
  expect(e.selection).toEqual(single(4));
  expect(e.marked).toEqual({ from: 1, to: 4 });
  e.handleInput({ kind: "compositionEnd" });
  e.handleInput({ kind: "commit", text: "日本語" });
  expect(e.buffer.getText()).toBe("x日本語");
  expect(e.selection).toEqual(single(4));
});

test("cancel (compositionEnd without commit) restores text and selection exactly", () => {
  const e = mk("hello world", single(6, 11)); // "world" selected
  const v = e.buffer.getText();
  comp(e, "sh"); comp(e, "shi");
  expect(e.buffer.getText()).toBe("hello shi");
  e.handleInput({ kind: "compositionEnd" });
  expect(e.buffer.getText()).toBe(v);
  expect(e.selection).toEqual(single(6, 11));
  expect(e.history.undoDepth).toBe(0);
});

test("composition replaces the current selection; commit replaces it too", () => {
  const e = mk("hello world", single(6, 11));
  comp(e, "ni");
  expect(e.buffer.getText()).toBe("hello ni");
  e.handleInput({ kind: "compositionEnd" });
  e.handleInput({ kind: "commit", text: "你" });
  expect(e.buffer.getText()).toBe("hello 你");
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("hello world");
  expect(e.selection).toEqual(single(6, 11));
});

test("composition in the middle, non-BMP offsets, out-of-range offsets", () => {
  const e = mk("ab", single(1));
  comp(e, "😀x", 2, 3);
  expect(e.buffer.getText()).toBe("a😀xb");
  expect(e.selection).toEqual(single(3, 4));
  comp(e, "😀", 1, 1); // inside the surrogate pair snaps back
  expect(e.selection).toEqual(single(1));
  comp(e, "ab", 99, 50);
  expect(e.selection).toEqual(single(3));
  comp(e, "");
  expect(e.buffer.getText()).toBe("ab");
  expect(e.marked).toEqual({ from: 1, to: 1 });
});

test("pointer selection change cancels composition; keys during composition are ignored", () => {
  const e = mk("abc");
  comp(e, "ni");
  expect(e.handleKey("Backspace").handled).toBe(false);
  e.setSelection(single(0));
  expect(e.buffer.getText()).toBe("abc");
  expect(e.marked).toBeNull();
});

test("commit after compositionEnd is plain insert (no auto-close), plain commit is typing", () => {
  const e = mk("");
  comp(e, "（"); e.handleInput({ kind: "compositionEnd" });
  e.handleInput({ kind: "commit", text: "(" });
  expect(e.buffer.getText()).toBe("(");
  const t = mk("");
  t.handleInput({ kind: "commit", text: "(" });
  expect(t.buffer.getText()).toBe("()");
  t.handleInput({ kind: "commit", text: "\n" });
  expect(t.buffer.getText()).toBe("(\n  \n)");
});

test("multi-cursor selection survives cancel and receives the commit at every cursor", () => {
  const e = new CodeEditor("a\nb");
  e.selection = { ranges: [{ anchor: 1, head: 1 }, { anchor: 3, head: 3 }], primary: 0 };
  comp(e, "ni");
  e.handleInput({ kind: "compositionEnd" });
  expect(e.selection.ranges).toHaveLength(2);
  e.handleInput({ kind: "commit", text: "你" });
  expect(e.buffer.getText()).toBe("a你\nb你");
});
