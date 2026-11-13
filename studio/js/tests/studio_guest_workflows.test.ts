import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf, textOps } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, tapText, typeInEditor } from "./helpers.ts";

// M2 editing workflows on the real native probe: tree operations, external
// changes (fs.watch), reconnect, large files, assets and the Save button.

const settleModal = (s: Awaited<ReturnType<typeof boot>>["session"]) => s.settle(30);

test("create a file from the tree: invalid names are refused in the dialog, a valid one is written and opened", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "+ 文件");
    frame = await session.until((f) => has(f, "新建文件"), "create dialog");
    await tapText(session, frame, "components/button.tsx"); // the input placeholder
    await session.typeIntoOpenField("logo.png");
    await session.settle(2);
    frame = await session.frame();
    await tapText(session, frame, "创建");
    frame = await session.until((f) => has(f, "仅支持"), "extension refused");
    assert.equal(fake.calls("studio.fs.write").length, 0, "an invalid name never reaches the service");

    await session.typeIntoOpenField("src/new_file.ts");
    frame = await session.settle(3);
    await tapText(session, frame, "创建");
    frame = await session.until((f) => has(f, "已创建 src/new_file.ts"), "created toast");
    assert.equal(fake.files.get("src/new_file.ts"), "");
    assert.deepEqual(fake.calls("studio.fs.write").map((r) => r.params), [{ project: "alpha-app", path: "src/new_file.ts", content: "" }]);
    frame = await session.until((f) => has(f, "new_file.ts"), "tree shows the new file");
    assert.ok(has(frame, "src/new_file.ts · 0 字节"), "the new file is opened in a tab");
  } finally { session.kill(); }
}, 90_000);

test("rename and delete the selected file; service errors become toasts", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openFile(session, "manifest.json", "{}");
    await tapText(session, frame, "重命名");
    frame = await session.until((f) => has(f, "重命名 / 移动"), "rename dialog");
    await tapText(session, frame, "manifest.json", -1); // the dialog input (the last occurrence)
    await session.typeIntoOpenField("app.tsx"); // already exists
    frame = await session.settle(3);
    await tapText(session, frame, "确定");
    frame = await session.until((f) => has(f, "目标已存在"), "client-side conflict message");
    assert.equal(fake.calls("studio.fs.rename").length, 0);
    await session.typeIntoOpenField("config.json");
    frame = await session.settle(3);
    await tapText(session, frame, "确定");
    frame = await session.until((f) => has(f, "已移动到 config.json"), "moved toast");
    assert.deepEqual(fake.calls("studio.fs.rename").map((r) => r.params), [{ project: "alpha-app", from: "manifest.json", to: "config.json" }]);
    assert.ok(fake.files.has("config.json") && !fake.files.has("manifest.json"));
    frame = await session.until((f) => has(f, "config.json · "), "the open tab follows the rename");
    await settleModal(session);

    frame = await session.frame();
    await tapText(session, frame, "删除");
    frame = await session.until((f) => has(f, "删除文件？"), "delete dialog");
    await tapText(session, frame, "取消");
    await session.until((f) => !has(f, "删除文件？"), "closed");
    assert.ok(fake.files.has("config.json"), "cancel keeps the file");
    frame = await settleModal(session);
    await tapText(session, frame, "删除");
    frame = await session.until((f) => has(f, "删除文件？"), "delete dialog 2");
    // The service refuses (another process removed it first): the error is shown, never swallowed.
    fake.files.delete("config.json");
    await tapText(session, frame, "删除", 1);
    frame = await session.until((f) => has(f, "删除失败") && has(f, "file not found"), "error toast");
  } finally { session.kill(); }
}, 120_000);

test("folders: create an empty folder, refuse to delete a non-empty one, delete the empty one", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "+ 文件夹");
    frame = await session.until((f) => has(f, "新建文件夹"), "folder dialog");
    await tapText(session, frame, "components");
    await session.typeIntoOpenField("widgets");
    frame = await session.settle(3);
    await tapText(session, frame, "创建");
    frame = await session.until((f) => has(f, "已创建文件夹 widgets"), "folder created");
    assert.deepEqual(fake.calls("studio.fs.mkdir").map((r) => r.params), [{ project: "alpha-app", path: "widgets" }]);
    frame = await session.until((f) => has(f, "▾ widgets"), "the empty folder is listed");
    await settleModal(session);

    frame = await session.frame();
    await tapText(session, frame, "删除");
    frame = await session.until((f) => has(f, "删除文件夹？"), "rmdir confirm");
    await tapText(session, frame, "删除", 1);
    frame = await session.until((f) => has(f, "已删除 widgets"), "rmdir toast");
    assert.deepEqual(fake.calls("studio.fs.rmdir").map((r) => r.params), [{ project: "alpha-app", path: "widgets" }]);
    await settleModal(session);

    frame = await session.frame();
    await tapText(session, frame, "▸ src"); // select + expand a non-empty folder
    frame = await session.until((f) => has(f, "▾ src"), "expanded");
    await tapText(session, frame, "删除");
    frame = await session.until((f) => has(f, "文件夹不为空"), "non-empty refusal");
    assert.equal(fake.calls("studio.fs.rmdir").length, 1, "no second rmdir request");
  } finally { session.kill(); }
}, 120_000);

test("external changes: a clean tab reloads silently, a dirty tab shows a conflict banner (keep mine / reload theirs)", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    const reads = fake.calls("studio.fs.read").length;

    // Clean tab: silent reload, no banner, no dialog.
    fake.externalWrite("app.tsx", "export const FROM_DISK_ONE = 1;\n");
    frame = await session.until((f) => has(f, "FROM_DISK_ONE"), "silent reload");
    assert.ok(fake.calls("studio.fs.read").length > reads);
    assert.ok(!has(frame, "被外部修改") && !has(frame, "app.tsx ●"), textOf(frame));

    // Dirty tab: conflict banner; "载入磁盘版本" replaces the text.
    frame = await typeInEditor(session, frame, /FROM_DISK_ONE/, "my local edit\n");
    frame = await session.until((f) => has(f, "app.tsx ●"), "dirty");
    fake.externalWrite("app.tsx", "export const FROM_DISK_TWO = 2;\n");
    frame = await session.until((f) => has(f, "此文件在磁盘上被外部修改"), "conflict banner");
    assert.ok(has(frame, "my local edit"), "the local text is kept until the user chooses");
    await tapText(session, frame, "载入磁盘版本");
    frame = await session.until((f) => has(f, "FROM_DISK_TWO") && !has(f, "此文件在磁盘上被外部修改"), "theirs loaded");
    assert.ok(!has(frame, "app.tsx ●"));

    // Dirty again, conflict again: "保留我的版本" keeps the text and a save overwrites the disk.
    frame = await typeInEditor(session, frame, /FROM_DISK_TWO/, "keep me\n");
    await session.until((f) => has(f, "app.tsx ●"), "dirty 2");
    fake.externalWrite("app.tsx", "export const FROM_DISK_THREE = 3;\n");
    frame = await session.until((f) => has(f, "此文件在磁盘上被外部修改"), "conflict 2");
    await tapText(session, frame, "保留我的版本");
    frame = await session.until((f) => !has(f, "此文件在磁盘上被外部修改"), "banner closed");
    assert.ok(has(frame, "keep me") && has(frame, "app.tsx ●"));
    await tapText(session, frame, /^保存/);
    await session.until((f) => has(f, "已保存 app.tsx"), "saved");
    assert.equal(fake.files.get("app.tsx"), "keep me\n");

    // A file created by another process appears in the tree.
    fake.externalWrite("extra.ts", "export {};\n");
    frame = await session.until((f) => has(f, "extra.ts"), "external create listed");
    // A file deleted by another process closes its clean tab.
    fake.externalWrite("manifest.json", undefined);
    frame = await session.until((f) => !has(f, "manifest.json"), "external delete unlisted");
  } finally { session.kill(); }
}, 120_000);

test("the watch stream reconnects with backoff after a drop and re-lists the tree", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    await session.settle(5);
    const first = fake.openStreams("studio.fs.watch");
    assert.equal(first.length, 1);
    const trees = fake.calls("studio.fs.tree").length;
    fake.drop("studio.fs.watch");
    fake.files.set("added_while_down.ts", "export {};\n");
    await session.settle(10);
    assert.equal(fake.openStreams("studio.fs.watch").length, 0, "not reopened before the backoff elapses");
    const frame = await session.until((f) => has(f, "added_while_down.ts"), "resync after reconnect", 300);
    const second = fake.openStreams("studio.fs.watch");
    assert.equal(second.length, 1);
    assert.notEqual(second[0], first[0], "a new stream was opened");
    assert.ok(fake.calls("studio.fs.tree").length > trees, "the tree was re-read after the gap");
    assert.ok(has(frame, "added_while_down.ts"));
  } finally { session.kill(); }
}, 90_000);

test("files above the editor cap are not opened and no bytes are requested", async () => {
  const { fake, session } = await boot((f) => {
    f.files.set("huge.ts", "x");
    f.reportedBytes.set("huge.ts", 2 * 1024 * 1024);
  });
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "huge.ts");
    frame = await session.until((f) => has(f, "超过多行输入框"), "cap message");
    assert.ok(has(frame, "2048 KiB"));
    assert.equal(fake.calls("studio.fs.read").length + fake.calls("studio.fs.readChunk").length, 0, "no bytes are requested for a capped file");
    assert.equal(has(frame, "huge.ts ●"), false);
  } finally { session.kill(); }
}, 60_000);

test("code editor lifts the InputField cap up to 4 MiB: a 5 MiB file is refused with a clear message and no bytes are requested", async () => {
  const { fake, session } = await boot((f) => {
    f.files.set("huge.ts", "x");
    f.reportedBytes.set("huge.ts", 5 * 1024 * 1024);
  }, "code");
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "huge.ts");
    frame = await session.until((f) => has(f, "超过代码编辑器 4 MiB"), "cap message");
    assert.ok(has(frame, "5120 KiB"));
    assert.equal(fake.calls("studio.fs.read").length + fake.calls("studio.fs.readChunk").length, 0);
  } finally { session.kill(); }
}, 60_000);

test("resources page lists assets and shows metadata with an honest 'preview unavailable'", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "资源", 0);
    frame = await session.until((f) => has(f, "logo.png") && has(f, "hero.jpg"), "asset list");
    await tapText(session, frame, "logo.png");
    frame = await session.until((f) => has(f, "大小：2.0 KiB"), "asset metadata");
    assert.ok(has(frame, "预览不可用"), "no fake preview");
    assert.deepEqual(fake.calls("studio.fs.stat").map((r) => r.params), [{ project: "alpha-app", path: "assets/logo.png" }]);
    assert.ok(has(frame, "上传新资源需要文件选择器能力"));
    assert.equal(textOps(frame, /预览不可用/).length, 1);
  } finally { session.kill(); }
}, 60_000);
