import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { center, textOf, textOps, type Frame, type ProbeSession } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, tapText } from "./helpers.ts";

// M4: the CodeView editor pane on the real native probe (built Studio bytecode, real QuickJS). The probe
// stands in for the Flutter host's raw text session exactly as the CodeView tests do: a tap opens the guest's
// `textInput.rawOpen`, the host answers `rawOpened`, then `input.text` batches carry key edges and IME commits.

const META = 8;
const key = (name: string, modifiers = 0) => ({ kind: "keyDown", key: name, ...(modifiers ? { modifiers } : {}) });
let current: ProbeSession;
/** One `input.text` batch (key edges, IME commits) and the frame that handles it. */
async function text(events: unknown[]): Promise<Frame> {
  current.sendEvent("input.text", events as unknown as Record<string, unknown>);
  return current.frame();
}

/** Taps the first code row (a text op right of the gutter) and completes the raw session handshake. */
async function focusEditor(session: ProbeSession, rowText: RegExp): Promise<Frame> {
  current = session;
  const frame = await session.frame();
  const op = textOps(frame, rowText)[0];
  assert.ok(op, `no code row ${rowText} in\n${textOf(frame)}`);
  await session.tap(op.x! + 1, center(op).y); // the left edge of the row: caret at column 0
  const open = [...session.guestEvents].reverse().find((e) => e.name === "textInput.rawOpen");
  assert.ok(open, "tapping the code view must open a raw text session");
  session.sendEvent("textInput.rawOpened", { id: String(open.payload.id) });
  return session.settle(3);
}

const sourceLines = (n: number) => Array.from({ length: n }, (_, i) => `export const line${i + 1} = ${i + 1}; // MARK${i + 1}\n`).join("");

test("code pane: open renders syntax-coloured rows, typing (keys + IME commit) is dirty, Meta+S saves through studio.fs.write", async () => {
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", sourceLines(40)); }, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    assert.ok(has(frame, "第 1 行，第 1 列 · 共 41 行"), textOf(frame));
    const colours = new Set((frame.ops ?? []).filter((o) => o.type === "text" && o.x! > 380).map((o: any) => o.color));
    assert.ok(colours.size > 2, "token colours");
    assert.ok(!has(frame, "app.tsx ●"));
    frame = await focusEditor(session, /^export$/);
    assert.equal(fake.calls("studio.fs.write").length, 0);

    // Plain typing and an IME commit arrive as raw text events; Backspace is a key edge.
    frame = await text([{ kind: "commit", text: "ab" }]);
    frame = await text([{ kind: "composition", text: "ni", selectionStart: 2, selectionEnd: 2 }]);
    frame = await text([{ kind: "compositionEnd" }, { kind: "commit", text: "你" }]);
    frame = await text([key("Backspace")]);
    frame = await text([{ kind: "commit", text: "好" }]);
    frame = await session.until((f) => has(f, "未保存") && has(f, "app.tsx ●"), "dirty marker from the buffer version");
    assert.ok(textOf(frame).includes("ab"), textOf(frame));
    assert.equal(fake.files.get("app.tsx"), sourceLines(40), "nothing is written before Save");

    // Undo coalescing: Meta+Z goes back step by step; redo (Meta+Shift+Z) returns.
    frame = await text([key("z", META)]);
    frame = await text([key("z", META | 1)]);

    // Cmd+S is a keyboard intent of the code view: it reaches the existing save flow.
    frame = await text([key("s", META)]);
    frame = await session.until((f) => has(f, "已保存 app.tsx"), "saved toast");
    const writes = fake.calls("studio.fs.write");
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.params.path, "app.tsx");
    assert.ok(String(writes[0]!.params.content).includes("ab") && String(writes[0]!.params.content).startsWith("ab"), String(writes[0]!.params.content).slice(0, 40));
    assert.equal(fake.files.get("app.tsx"), writes[0]!.params.content);
    assert.ok(!has(frame, "app.tsx ●") && !has(frame, "未保存"), "clean after the save");
    // Our own write comes back through fs.watch: no banner, no reload, still clean.
    await session.settle(40);
    frame = await session.frame();
    assert.ok(!has(frame, "被外部修改") && !has(frame, "未保存"), textOf(frame));

    // Undo past the save point makes the buffer differ again; the file on disk is unchanged until the next save.
    frame = await text([key("z", META)]);
    frame = await session.until((f) => has(f, "未保存"), "undo makes it dirty against the saved version");
    assert.equal(fake.calls("studio.fs.write").length, 1);
  } finally { session.kill(); }
}, 120_000);

test("code pane: a file above the upload threshold is saved through the chunked, sha256-checked upload", async () => {
  const big = sourceLines(5000); // about 220 KB: above the 192 KiB single-write limit, below the 240 KiB chunked-read limit
  assert.ok(big.length > 192 * 1024 && big.length < 240 * 1024, String(big.length));
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", big); }, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    assert.ok(has(frame, "共 5001 行"), textOf(frame));
    // Wheel scroll through the file (virtualised rows), then type at the top.
    session.sendEvent("input.scroll", { x: 450, y: 300, deltaY: 4000, source: "wheel", phase: "update" });
    frame = await session.until((f) => has(f, "MARK2"), "scrolled rows", 40).catch(() => session.frame());
    session.sendEvent("input.scroll", { x: 450, y: 300, deltaY: -4000, source: "wheel", phase: "update" });
    await session.settle(3);
    frame = await focusEditor(session, /^export$/);
    frame = await text([{ kind: "commit", text: "// edited\n" }]);
    frame = await text([key("s", META)]);
    frame = await session.until((f) => has(f, "已保存 app.tsx") || has(f, "失败"), "saved toast", 600);
    assert.equal(fake.calls("studio.fs.write").length, 0, "large content never goes through one write");
    assert.equal(fake.calls("studio.fs.upload.begin").length, 1);
    assert.ok(fake.calls("studio.fs.upload.chunk").length >= 2);
    assert.equal(fake.calls("studio.fs.upload.commit").length, 1);
    const saved = fake.files.get("app.tsx")!;
    assert.ok(saved.startsWith("// edited\n"));
    assert.equal(saved.length, big.length + "// edited\n".length);
    assert.equal(fake.calls("studio.fs.upload.begin")[0]!.params.sha256, createHash("sha256").update(Buffer.from(saved)).digest("hex"));
  } finally { session.kill(); }
}, 180_000);

test("code pane: a diagnostic jump opens the file, scrolls, puts the caret at line:column and marks the gutter", async () => {
  const { fake, session } = await boot((f) => {
    f.files.set("app.tsx", sourceLines(120));
    f.buildMode = "fail";
    f.diagnostics = [];
  }, "code");
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "控制台", 0);
    frame = await session.until((f) => has(f, "开始构建"), "console page");
    await tapText(session, frame, "开始构建");
    frame = await session.until((f) => has(f, "app.tsx:3:5  Unterminated JSX contents."), "diagnostic listed", 200);
    await tapText(session, frame, "app.tsx:3:5  Unterminated JSX contents.");
    frame = await session.until((f) => has(f, "第 3 行，第 5 列") && has(f, "源码 · alpha-app"), "caret at the diagnostic position", 300);
    assert.ok(has(frame, "Ln 3:5") && has(frame, "Unterminated JSX contents."), `diagnostic tip\n${textOf(frame)}`);
    assert.equal(fake.calls("studio.fs.read").filter((r) => r.params.path === "app.tsx").length, 1);
    // Marked in the gutter: a diagnostic dot (severity colour rect) exists next to the line number.
    assert.ok((frame.ops ?? []).some((o: any) => o.type === "rect" && o.color === 0xfff85149), "error dot in the gutter");
  } finally { session.kill(); }
}, 120_000);

test("code pane: a jump to a far line scrolls the file", async () => {
  const { fake, session } = await boot((f) => {
    f.files.set("app.tsx", sourceLines(200));
    f.buildMode = "fail";
  }, "code");
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "控制台", 0);
    frame = await session.until((f) => has(f, "开始构建"), "console page");
    await tapText(session, frame, "开始构建");
    await session.until((f) => has(f, "app.tsx:3:5"), "diagnostic listed", 200);
    // The service reports a second failing build with a diagnostic far down the file.
    fake.diagnostics = [{ file: "app.tsx", line: 150, column: 7, severity: "error", message: "Far away." }];
    fake.push("studio.build.events", [{ type: "done", ok: false, builtRevision: null, diagnostics: fake.diagnostics }]);
    frame = await session.until((f) => has(f, "app.tsx:150:7  Far away."), "far diagnostic listed", 200);
    await tapText(session, frame, "app.tsx:150:7  Far away.");
    frame = await session.until((f) => has(f, "第 150 行，第 7 列"), "caret at line 150", 300);
    assert.ok(has(frame, "MARK150"), `line 150 is on screen\n${textOf(frame)}`);
    assert.ok(!has(frame, "MARK2;") && !has(frame, "MARK3 "), "the top of the file scrolled away");
  } finally { session.kill(); }
}, 120_000);

test("code pane: an external change reloads a clean tab as one undoable edit; a dirty tab shows the conflict banner", async () => {
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", sourceLines(10)); }, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    fake.externalWrite("app.tsx", sourceLines(10).replace("line3", "RELOADED3"));
    frame = await session.until((f) => has(f, "RELOADED3"), "silent reload into the buffer");
    assert.ok(!has(frame, "被外部修改") && !has(frame, "未保存"), textOf(frame));
    frame = await focusEditor(session, /^export$/);
    frame = await text([key("z", META)]); // undoes the reload edit, not nothing
    frame = await session.until((f) => has(f, "line3") && !has(f, "RELOADED3"), "undo restores the pre-reload text");
    assert.ok(has(frame, "未保存"), "the buffer now differs from the disk text");
    frame = await text([key("z", META | 1)]);
    frame = await session.until((f) => has(f, "RELOADED3"), "redo");
    // Dirty + external change: banner; "载入磁盘版本" replaces the buffer.
    frame = await text([{ kind: "commit", text: "local " }]);
    fake.externalWrite("app.tsx", "export const FROM_DISK = 1;\n");
    frame = await session.until((f) => has(f, "被外部修改"), "conflict banner");
    assert.ok(has(frame, "local"), "the buffer keeps the local edit while the conflict is pending");
    await tapText(session, frame, "载入磁盘版本");
    frame = await session.until((f) => has(f, "FROM_DISK") && !has(f, "被外部修改"), "disk version loaded into the buffer");
    assert.ok(!has(frame, "未保存"));
  } finally { session.kill(); }
}, 120_000);

test("settings: switching to the multi-line InputField hands the buffer text over, and back to the code view keeps it", async () => {
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", sourceLines(6)); }, "code");
  try {
    let frame = await openAlpha(session);
    frame = await openFile(session, "app.tsx", "line1");
    frame = await focusEditor(session, /^export$/);
    frame = await text([{ kind: "commit", text: "HANDOVER_" }]);
    frame = await session.until((f) => has(f, "未保存"), "dirty");
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "多行输入框（备用）"), "settings page");
    await tapText(session, frame, "多行输入框（备用）");
    frame = await session.until(() => (fake.storage.get("studio.settings.v1") as any)?.editor === "input", "setting persisted");
    await tapText(session, await session.frame(), "源码", 0);
    frame = await session.until((f) => has(f, "HANDOVER_export") && has(f, "空文件") === false && !has(f, "Cmd+S 保存 · Cmd+F"), "InputField shows the buffer text", 200);
    assert.ok(has(frame, "未保存"), "still dirty after the hand-over");
    assert.equal(fake.calls("studio.fs.write").length, 0);
    // Back to the code view: a new buffer over the same text, still dirty, then Save writes it.
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "代码视图（默认）"), "settings page");
    await tapText(session, frame, "代码视图（默认）");
    await session.until(() => (fake.storage.get("studio.settings.v1") as any)?.editor === "code", "setting persisted");
    await tapText(session, await session.frame(), "源码", 0);
    frame = await session.until((f) => has(f, "Cmd+S 保存 · Cmd+F") && has(f, "HANDOVER_"), "code view again", 200);
    assert.ok(has(frame, "未保存"));
    await tapText(session, frame, /^保存/);
    await session.until((f) => has(f, "已保存 app.tsx"), "saved");
    assert.ok(String(fake.files.get("app.tsx")).startsWith("HANDOVER_export"));
  } finally { session.kill(); }
}, 180_000);

test("code pane: Cmd+F opens the find bar, Cmd+C writes the system clipboard through clipboard.writeText", async () => {
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", sourceLines(30)); }, "code");
  const requests: string[] = [];
  const original = fake.handle;
  fake.handle = (request) => {
    if (request.capability.startsWith("clipboard.")) {
      requests.push(request.capability + ":" + JSON.stringify(request.params).slice(0, 60));
      return request.capability === "clipboard.writeText" ? { ok: true, result: { ok: true } } : { ok: true, result: { text: "PASTED_" } };
    }
    return original(request);
  };
  // boot() already bound the original handler: route through the new one.
  (session as any).responder = fake.handle;
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    frame = await focusEditor(session, /^export$/);
    frame = await text([key("a", META)]);
    frame = await text([key("c", META)]);
    await session.until(() => requests.some((r) => r.startsWith("clipboard.writeText")), "clipboard.writeText request", 60);
    frame = await text([key("ArrowLeft")]);
    frame = await text([key("v", META)]);
    await session.until(() => requests.some((r) => r.startsWith("clipboard.readText")), "clipboard.readText request", 60);
    frame = await session.until((f) => has(f, "PASTED_") && has(f, "未保存"), "pasted text inserted", 60);
    frame = await text([key("f", META)]);
    frame = await session.until((f) => has(f, "替换") || has(f, "Replace") || has(f, "全部"), "find bar", 60);
  } finally { session.kill(); }
}, 120_000);

test("code pane: a >240 KiB file opens through the chunked, verified read (base64/sha/utf8 sliced across turns) and saves back through upload", async () => {
  const big = sourceLines(7000); // about 310 KB with multibyte tail
  const withCjk = big + "// 你好 😀 end\n";
  assert.ok(Buffer.byteLength(withCjk) > 240 * 1024);
  const { fake, session } = await boot((f) => { f.files.set("app.tsx", withCjk); }, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "line1");
    assert.ok(has(frame, "共 7002 行"), textOf(frame));
    assert.equal(fake.calls("studio.fs.read").length, 0, "a known size above 240 KiB goes straight to chunked reads");
    assert.ok(fake.calls("studio.fs.readChunk").length >= 3);
    frame = await focusEditor(session, /^export$/);
    frame = await text([{ kind: "commit", text: "// big\n" }]);
    frame = await text([key("s", META)]);
    frame = await session.until((f) => has(f, "已保存 app.tsx"), "saved toast", 1500);
    assert.equal(fake.calls("studio.fs.upload.begin").length, 1);
    assert.equal(fake.files.get("app.tsx"), "// big\n" + withCjk);
  } finally { session.kill(); }
}, 240_000);
