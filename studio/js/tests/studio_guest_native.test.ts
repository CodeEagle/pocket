import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { ProbeSession, textOf, textOps, center } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, tapText, typeInEditor } from "./helpers.ts";

// Guest-level tests of the Studio on the real native probe (built bytecode,
// real QuickJS runtime, real input events). The studio.* provider and the
// System host are the stateful fake in fake_studio.ts; the Dart provider and
// the real service are covered by their own suites.

test("project list, open a project, expand folders and open a file in a tab by input", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await session.until((f) => has(f, "Alpha 应用"), "project list");
    const projectListFrame = textOf(frame);
    assert.ok(has(frame, "Beta 游戏") && has(frame, "项目"), projectListFrame);
    assert.equal(fake.requests.find((r) => r.capability.startsWith("studio."))?.capability, "studio.project.list"); // the update client (M6) asks updates.status first

    await tapText(session, frame, "Alpha 应用");
    frame = await session.until((f) => has(f, "app.tsx"), "file tree");
    assert.notEqual(textOf(frame), projectListFrame, "tapping a project must change the frame");
    for (const name of ["app.tsx", "manifest.json", "▸ src"]) assert.ok(has(frame, name), `${name} missing in\n${textOf(frame)}`);
    assert.ok(!has(frame, "alpha.ts"), "collapsed folder must hide children");
    assert.deepEqual(fake.calls("studio.fs.tree").map((r) => r.params), [{ project: "alpha-app", assets: true }]);

    await tapText(session, frame, "▸ src");
    frame = await session.until((f) => has(f, "alpha.ts"), "expanded folder");
    assert.ok(has(frame, "▾ src") && has(frame, "▸ deep"));

    await tapText(session, frame, "alpha.ts");
    frame = await session.until((f) => has(f, "MARKER_ALPHA"), "file in editor");
    assert.ok(has(frame, "src/alpha.ts"), "tab and header name the file");
    assert.deepEqual(fake.calls("studio.fs.read").map((r) => r.params), [{ project: "alpha-app", path: "src/alpha.ts" }]);

    await tapText(session, frame, "▾ src");
    frame = await session.until((f) => !has(f, "▸ deep") && has(f, "▸ src"), "collapsed folder");

    for (const r of fake.requests) assert.ok(/^(studio|system|platform|updates)\./.test(r.capability), r.capability);
  } finally { session.kill(); }
}, 60_000);

test("capability errors are shown as a toast instead of fake success", async () => {
  const session = new ProbeSession((r) => (r.capability.startsWith("studio.") ? { ok: false, error: { code: "service_unreachable", message: "Studio service is not reachable" } } : { ok: false, error: { code: "capability_unavailable", message: r.capability } }));
  try {
    await session.boot();
    const frame = await session.until((f) => has(f, "service_unreachable"), "error toast");
    assert.ok(has(frame, "Studio service is not reachable"));
    assert.ok(!has(frame, "Alpha"));
    // The toast sits at the bottom-right corner of the window.
    const toast = textOps(frame, /service_unreachable/)[0]!;
    assert.ok(toast.y! > 400 && toast.x! > 400, `toast at ${toast.x},${toast.y}`);
  } finally { session.kill(); }
}, 60_000);

test("edit in the multi-line InputField, dirty marker, Save button writes through studio.fs.write", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    assert.ok(!has(frame, "●"), "a freshly opened file is clean");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "export const EDITED_LINE = 42;\nsecond line\n");
    frame = await session.until((f) => has(f, "EDITED_LINE") && has(f, "未保存"), "dirty editor");
    assert.ok(has(frame, "app.tsx ●"), "tab shows the dirty marker");
    assert.equal(fake.files.get("app.tsx"), "export const MARKER_APP_TSX = 1;\n", "nothing is written before Save");
    assert.equal(fake.calls("studio.fs.write").length, 0);

    await tapText(session, frame, /^保存/);
    frame = await session.until((f) => has(f, "已保存 app.tsx"), "saved toast");
    assert.equal(fake.files.get("app.tsx"), "export const EDITED_LINE = 42;\nsecond line\n");
    assert.deepEqual(fake.calls("studio.fs.write").map((r) => r.params), [{ project: "alpha-app", path: "app.tsx", content: "export const EDITED_LINE = 42;\nsecond line\n" }]);
    assert.ok(!has(frame, "app.tsx ●") && !has(frame, "未保存"), "clean again after saving");
    // Our own write came back through fs.watch; it must not raise a conflict or reload.
    await session.settle(40);
    frame = await session.frame();
    assert.ok(!has(frame, "被外部修改"), textOf(frame));
  } finally { session.kill(); }
}, 60_000);

test("closing a dirty tab asks first: cancel keeps it, discard drops it, save writes then closes", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "changed one\n");
    frame = await session.until((f) => has(f, "app.tsx ●"), "dirty");

    await tapText(session, frame, "×");
    frame = await session.until((f) => has(f, "关闭前保存更改？"), "unsaved prompt");
    await tapText(session, frame, "取消");
    await session.until((f) => !has(f, "关闭前保存更改？"), "prompt gone");
    frame = await session.settle(30); // let the modal's exit transition finish before the next tap
    assert.ok(has(frame, "app.tsx ●"), "cancel keeps the dirty tab");

    await tapText(session, frame, "×");
    frame = await session.until((f) => has(f, "关闭前保存更改？"), "unsaved prompt again");
    await tapText(session, frame, "不保存");
    frame = await session.until((f) => has(f, "从左侧选择文件开始编辑。"), "tab closed");
    assert.equal(fake.files.get("app.tsx"), "export const MARKER_APP_TSX = 1;\n", "discard never writes");
    await session.settle(30);

    frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "saved on close\n");
    frame = await session.until((f) => has(f, "app.tsx ●"), "dirty again");
    await tapText(session, frame, "×");
    frame = await session.until((f) => has(f, "关闭前保存更改？"), "prompt 3");
    await tapText(session, frame, "保存");
    frame = await session.until((f) => has(f, "从左侧选择文件开始编辑。"), "closed after save");
    assert.equal(fake.files.get("app.tsx"), "saved on close\n");
  } finally { session.kill(); }
}, 90_000);

test("switching project with unsaved changes prompts; cancel stays, discard continues", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "unsaved\n");
    await session.until((f) => has(f, "app.tsx ●"), "dirty");

    frame = await session.frame();
    await tapText(session, frame, "项目", 0);
    frame = await session.until((f) => has(f, "新建项目"), "projects page");
    await tapText(session, frame, "Beta 游戏");
    frame = await session.until((f) => has(f, "有未保存的更改"), "leave prompt");
    assert.equal(fake.calls("studio.fs.tree").length, 1, "no new project is loaded while the prompt is open");
    await tapText(session, frame, "取消");
    await session.until((f) => !has(f, "有未保存的更改"), "prompt closed");
    frame = await session.settle(30);
    assert.ok(has(frame, "新建项目"), "cancel stays on the projects page");

    await tapText(session, frame, "Beta 游戏");
    frame = await session.until((f) => has(f, "有未保存的更改"), "leave prompt 2");
    await tapText(session, frame, "不保存，继续");
    frame = await session.until((f) => has(f, "源码 · beta-game"), "beta opened");
    assert.deepEqual(fake.calls("studio.fs.tree").map((r) => r.params.project), ["alpha-app", "beta-game"]);
    assert.ok(!has(frame, "app.tsx ●"));
  } finally { session.kill(); }
}, 90_000);
