import { expect, test } from "bun:test";
import { CodeEditor, History, TextBuffer, single } from "../src/code/index.ts";

function mk(text = "", now = { t: 0 }, opts: any = {}) {
  const e = new CodeEditor(text, { now: () => now.t, ...opts });
  e.selection = single(text.length);
  return { e, now };
}
const type = (e: CodeEditor, s: string, now?: { t: number }, dt = 50) => { for (const ch of s) { e.handleInput({ kind: "commit", text: ch }); if (now) now.t += dt; } };

test("consecutive typing coalesces; word->space and newline start new steps", () => {
  const { e, now } = mk();
  type(e, "hello", now);
  expect(e.history.undoDepth).toBe(1);
  type(e, " world", now);
  expect(e.history.undoDepth).toBe(3 - 1); // "hello" | " world"
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("hello");
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("");
  e.handleKey("Meta+Shift+z");
  expect(e.buffer.getText()).toBe("hello");
  e.handleKey("Meta+Shift+z");
  expect(e.buffer.getText()).toBe("hello world");
  expect(e.selection.ranges[0].head).toBe(11);
});

test("time window, cursor move, Enter and kind change break coalescing", () => {
  let { e, now } = mk();
  type(e, "ab", now); now.t += 5000; type(e, "cd", now);
  expect(e.history.undoDepth).toBe(2);
  ({ e, now } = mk());
  type(e, "ab", now); e.handleKey("ArrowLeft"); e.handleKey("ArrowRight"); type(e, "cd", now);
  expect(e.history.undoDepth).toBe(2);
  ({ e, now } = mk());
  type(e, "ab", now); e.handleKey("Enter"); type(e, "cd", now);
  expect(e.history.undoDepth).toBe(3);
  ({ e, now } = mk());
  type(e, "abc", now); e.handleKey("Backspace"); e.handleKey("Backspace");
  expect(e.history.undoDepth).toBe(2);
  e.handleKey("Meta+z"); expect(e.buffer.getText()).toBe("abc");
  e.handleKey("Meta+z"); expect(e.buffer.getText()).toBe("");
  ({ e, now } = mk());
  e.paste("xyz"); type(e, "q", now); expect(e.history.undoDepth).toBe(2);
});

test("typing inside an auto-closed pair stays in one step", () => {
  const { e, now } = mk();
  type(e, "f(abc)", now);
  expect(e.buffer.getText()).toBe("f(abc)");
  expect(e.history.undoDepth).toBe(1);
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("");
});

test("undo restores the selection; replacing a selection undoes to the old text and selection", () => {
  const { e } = mk("hello world");
  e.selection = single(0, 5);
  e.handleInput({ kind: "commit", text: "J" });
  expect(e.buffer.getText()).toBe("J world");
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("hello world");
  expect(e.selection).toEqual(single(0, 5));
});

test("redo cleared by a new edit; undo past the start is a no-op", () => {
  const { e, now } = mk();
  expect(e.handleKey("Meta+z").changed).toBe(false);
  type(e, "a", now); e.handleKey("Meta+z");
  expect(e.history.canRedo()).toBe(true);
  type(e, "b", now);
  expect(e.history.canRedo()).toBe(false);
  expect(e.buffer.getText()).toBe("b");
});

test("backspace and forward delete runs coalesce", () => {
  const { e, now } = mk("abcdef");
  e.selection = single(6);
  for (let i = 0; i < 3; i++) { e.handleKey("Backspace"); now.t += 30; }
  expect(e.buffer.getText()).toBe("abc");
  expect(e.history.undoDepth).toBe(1);
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("abcdef");
  e.selection = single(0);
  e.history.clear();
  for (let i = 0; i < 2; i++) { e.handleKey("Delete"); now.t += 30; }
  expect(e.history.undoDepth).toBe(1);
  e.handleKey("Meta+z");
  expect(e.buffer.getText()).toBe("abcdef");
});

test("bounded steps and bytes", () => {
  const b = new TextBuffer("");
  const h = new History({ maxSteps: 10, maxBytes: 1_000_000 });
  for (let i = 0; i < 100; i++) {
    const c = b.replace(b.length, b.length, "line" + i + "\n");
    h.record([c], single(0), single(0), "other", i);
  }
  expect(h.undoDepth).toBe(10);
  const small = new History({ maxSteps: 1000, maxBytes: 2000 });
  const b2 = new TextBuffer("");
  for (let i = 0; i < 100; i++) {
    const c = b2.replace(b2.length, b2.length, "x".repeat(200));
    small.record([c], single(0), single(0), "other", i);
  }
  expect(small.retainedBytes).toBeLessThanOrEqual(2000 + 600);
  expect(small.undoDepth).toBeGreaterThanOrEqual(1);
  expect(small.undoDepth).toBeLessThan(100);
});

test("5,000 line file: many edits and full undo", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const { e, now } = mk(text);
  const orig = e.buffer.getText();
  for (let i = 0; i < 200; i++) {
    e.selection = single(e.buffer.offsetAt(i * 20, 5));
    type(e, "zz", now, 10);
    e.handleKey("Enter");
    now.t += 2000;
  }
  while (e.history.canUndo()) e.undo();
  expect(e.buffer.getText()).toBe(orig);
});

test("replace-all is one undo step (via editor.dispatch)", async () => {
  const { replaceAllTransaction } = await import("../src/code/index.ts");
  const { e } = mk("foo foo\nfoo");
  const r = replaceAllTransaction(e.buffer, "foo", {}, "barbaz");
  expect(r.count).toBe(3);
  e.dispatch(r.transaction);
  expect(e.buffer.getText()).toBe("barbaz barbaz\nbarbaz");
  expect(e.history.undoDepth).toBe(1);
  e.undo();
  expect(e.buffer.getText()).toBe("foo foo\nfoo");
});
