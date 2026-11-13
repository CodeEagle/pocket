import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf, type Frame } from "./probe_session.ts";
import { boot, focusEditor, has, openAlpha, openFile, press, tapText } from "./helpers.ts";

// M7 keyboard shell on the real native probe (built Studio bytecode, real QuickJS). Keys travel the raw input path:
// `input.text` batches with key edges and a modifier mask, folded by native admission into names such as "Meta+p".

const SHIFT = 1, META = 8;
const sourceLines = (n: number) => Array.from({ length: n }, (_, i) => `export const line${i + 1} = ${i + 1}; // MARK${i + 1}\n`).join("");

test("rail keys: Meta+3 / Meta+6 / Meta+2 switch pages, the Settings page lists the whole keymap", async () => {
  const { session } = await boot();
  try {
    await openAlpha(session);
    let frame = await press(session, "3", META);
    frame = await session.until((f) => has(f, "开始构建"), "console page");
    frame = await press(session, "6", META);
    frame = await session.until((f) => has(f, "键盘快捷键") && has(f, "⌘F"), "settings page with the shortcut list");
    for (const needle of ["⌘S", "⌘F"]) assert.ok(has(frame, needle), `${needle} in\n${textOf(frame)}`);
    frame = await press(session, "2", META);
    frame = await session.until((f) => has(f, "源码 · alpha-app"), "source page");
    // Plain keys and unknown chords do nothing.
    frame = await press(session, "q", META);
    assert.ok(has(frame, "源码 · alpha-app"));
  } finally { session.kill(); }
}, 90_000);

test("Cmd+P quick-open: the field takes focus, typing filters, Enter opens, Esc closes", async () => {
  const { session, fake } = await boot();
  try {
    await openAlpha(session);
    // Not on the Source page's editor: go to the Console first, quick-open must still work and land on Source.
    let frame = await press(session, "3", META);
    await session.until((f) => has(f, "开始构建"), "console page");
    frame = await press(session, "p", META);
    frame = await session.until((f) => has(f, "快速打开") && has(f, "没有匹配的文件") === false && has(f, "beta.ts"), "overlay with the project files");
    await session.settle(15);
    const open = [...session.guestEvents].reverse().find((e) => e.name === "textInput.open");
    assert.ok(open, "the overlay's field opens its editing session by itself (autoFocus)");
    await session.typeIntoOpenField("beta");
    frame = await session.until((f) => has(f, "beta.ts") && !has(f, "alpha.ts"), "filtered to beta.ts");
    await press(session, "Enter");
    frame = await session.until((f) => has(f, "src/deep/beta.ts · ") && has(f, "MARKER_BETA"), "beta.ts opened in a tab on the Source page");
    assert.equal(fake.calls("studio.fs.read").filter((r) => r.params.path === "src/deep/beta.ts").length, 1);
    assert.ok(!has(frame, "快速打开"), "overlay closed");

    // Esc closes the overlay without opening anything; Cmd+P again toggles it away.
    frame = await press(session, "p", META);
    await session.until((f) => has(f, "快速打开"), "overlay again");
    frame = await press(session, "Escape");
    frame = await session.until((f) => !has(f, "快速打开"), "Esc closed the overlay");
    frame = await press(session, "p", META);
    await session.until((f) => has(f, "快速打开"), "overlay once more");
    frame = await press(session, "p", META);
    await session.until((f) => !has(f, "快速打开"), "second Cmd+P toggled it off");
    // Tapping a row opens that file.
    await press(session, "p", META);
    frame = await session.until((f) => has(f, "alpha.ts"), "overlay rows");
    await tapText(session, frame, "alpha.ts", -1);
    frame = await session.until((f) => has(f, "src/alpha.ts · ") && !has(f, "快速打开"), "row tap opened alpha.ts");
  } finally { session.kill(); }
}, 120_000);

test("with the code editor focused: editor keys stay with the editor, shell keys still win", async () => {
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", sourceLines(40)); }, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    frame = await focusEditor(session, /^export$/);
    // Typing then Cmd+S: the CodeView's own save intent runs (exactly one write, no shell double-save).
    session.sendEvent("input.text", [{ kind: "commit", text: "ab" }] as unknown as Record<string, unknown>);
    await session.frame();
    await press(session, "s", META);
    frame = await session.until((f) => has(f, "已保存 app.tsx"), "saved through the editor's save intent");
    assert.equal(fake.calls("studio.fs.write").length, 1, "one save, not two");
    // Cmd+F belongs to the editor: the find bar opens (the shell does not hijack it).
    await press(session, "f", META);
    frame = await session.settle(3);
    assert.ok(!has(frame, "快速打开"));
    // Cmd+P is global: it wins although the editor has the keyboard.
    frame = await press(session, "p", META);
    frame = await session.until((f) => has(f, "快速打开"), "quick-open over a focused editor");
    frame = await press(session, "Escape");
    frame = await session.until((f) => !has(f, "快速打开"), "Esc closes it");
    // Cmd+3 switches the page from inside the editor too.
    await focusEditor(session, /^export$/).catch(() => undefined);
    frame = await press(session, "3", META);
    frame = await session.until((f) => has(f, "开始构建"), "console page from the editor");
    // Cmd+Shift+B builds and previews: the build starts on the (fake) service.
    frame = await press(session, "2", META);
    await session.until((f) => has(f, "源码 · alpha-app"), "back on source");
    await press(session, "B", META | SHIFT);
    await session.until(() => fake.calls("studio.build.start").length >= 1, "build requested by Cmd+Shift+B", 300);
    // Cmd+Shift+P opens the publish page.
    frame = await press(session, "P", META | SHIFT);
    frame = await session.until((f) => has(f, "发布测试包"), "publish page");
  } finally { session.kill(); }
}, 180_000);

test("Cmd+W closes the active tab and Cmd+Shift+] / [ switch tabs", async () => {
  const { session } = await boot();
  try {
    await openAlpha(session);
    await openFile(session, "app.tsx", "MARKER_APP_TSX");
    await openFile(session, "alpha.ts", "MARKER_ALPHA").catch(async () => {
      // the tree is collapsed under src/: expand it first
      const frame = await session.frame();
      await tapText(session, frame, "▸ src");
      return openFile(session, "alpha.ts", "MARKER_ALPHA");
    });
    let frame = await session.frame();
    assert.ok(has(frame, "src/alpha.ts · "));
    frame = await press(session, "[", META | SHIFT);
    frame = await session.until((f) => has(f, "app.tsx · "), "previous tab is app.tsx");
    frame = await press(session, "]", META | SHIFT);
    frame = await session.until((f) => has(f, "src/alpha.ts · "), "next tab is alpha.ts");
    frame = await press(session, "w", META);
    frame = await session.until((f) => has(f, "app.tsx · ") && !has(f, "src/alpha.ts · "), "alpha.ts closed");
  } finally { session.kill(); }
}, 120_000);
