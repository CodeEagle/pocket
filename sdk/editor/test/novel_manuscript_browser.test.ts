import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";

test("plain manuscript is reviewed, cancelled, imported, undone, persisted and executed as pinned bytecode", { timeout: 180_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-manuscript-browser-"));
  const project = join(temporary, "project");
  const id = "manuscript-browser";
  mkdirSync(project);
  for (const name of ["pocket.json", "package.json", "manifest.json"]) cpSync(join(repository, "demo/js/apps/lantern", name), join(project, name), { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.lantern", name: id, version: "0.1.0", entry: "app.tsx", framework: "solid", build: 1, tickHz: 60 }));
  const original = { id, version: 1, start: "start", script: { start: [{ type: "say", id: "original_line", speaker: "Mira", text: "Original chapter" }, { type: "ending", id: "original_end" }] } };
  const storyPath = join(project, "story.json");
  writeFileSync(storyPath, JSON.stringify(original));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  writeFileSync(join(project, "novel.locales.json"), JSON.stringify({ format: "pocket-vn-locales", formatVersion: 1, catalogs: {} }));
  writeFileSync(join(project, "images.json"), "{}");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";
const engine = createNovelEngine(story);
function App() { const removeClock = attachNovelClock(engine); onCleanup(() => { removeClock(); engine.dispose(); }); return <NovelView engine={engine} assets={assets} title="Manuscript" onNewGame={() => engine.newGame()} />; }
mount(App);`);
  const server = await startEditor({ port: 0, updatePort: 0, workspace: join(temporary, "workspace"), projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let native: NativeSession | undefined;
  const upload = async (name = "chapter.txt", buffer = Buffer.from("23:08 the lamp is still on.\r\n\r\nMira：Keep the receipt.\r\n【Ren】I kept it.")) => {
    await page.locator("#novel-manuscript-input").setInputFiles({ name, mimeType: "text/plain", buffer });
  };
  const diskStory = () => JSON.parse(readFileSync(storyPath, "utf8"));
  try {
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    await page.getByLabel("对白文本", { exact: true }).first().waitFor();
    await upload();
    const dialog = page.getByRole("dialog", { name: "手稿导入预览" });
    await page.waitForFunction(() => document.querySelector("dialog[open]") || document.querySelector("#novel-notice")?.textContent?.includes("手稿导入失败"), undefined, { timeout: 10_000 });
    assert.equal(await dialog.count(), 1, `${await page.locator("#novel-notice").innerText()}; browser errors=${errors.join("; ")}`);
    const preview = await dialog.getByLabel("手稿转换预览").inputValue();
    assert.match(preview, /1 · 旁白 · 23:08/);
    assert.match(preview, /3 · 【Mira】Keep the receipt/);
    assert.match(preview, /4 · 【Ren】I kept it/);
    assert.deepEqual(diskStory(), original);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(diskStory(), original);
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "Original chapter");

    await upload();
    await dialog.getByLabel("新章节标签").fill("start");
    await dialog.getByRole("button", { name: "加入草稿", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "不会覆盖原章节" }).waitFor();
    assert.deepEqual(diskStory(), original);
    await dialog.getByLabel("新章节标签").fill("imported");
    await dialog.getByLabel("将导入章节设为故事起点").check();
    await dialog.getByRole("button", { name: "加入草稿", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "23:08 the lamp is still on.");
    assert.deepEqual(diskStory(), original, "preview/apply changes only the editable draft");
    await page.locator('#novel-history-state[data-phase="saved"]').waitFor();
    await page.reload();
    await page.locator(".nv-label").filter({ hasText: "imported" }).click();
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "23:08 the lamp is still on.");
    assert.deepEqual(diskStory(), original, "reopening an unsaved draft must not rewrite the canonical story");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "Original chapter");
    await clickNovelHistory(page, "redo");
    await page.locator(".nv-label").filter({ hasText: "imported" }).click();
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "23:08 the lamp is still on.");
    // An already-open preview must not mutate history while an undo is
    // awaiting its canonical-head check (keyboard shortcuts can overlap it).
    await upload("racing.txt", Buffer.from("A second chapter must not sneak in."));
    await dialog.waitFor();
    let releaseHead!: () => void;
    let observedHead!: () => void;
    let finishedHead!: () => void;
    let headRequested = false;
    const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
    const headObserved = new Promise<void>(resolve => { observedHead = resolve; });
    const headFinished = new Promise<void>(resolve => { finishedHead = resolve; });
    const headPattern = "**/novel/history?head=1";
    await page.route(headPattern, async route => { headRequested = true; observedHead(); await headGate; try { await route.continue(); } finally { finishedHead(); } });
    try {
      await page.keyboard.press("Control+z");
      await Promise.race([headObserved, new Promise((_, reject) => setTimeout(() => reject(new Error("undo head check was not requested")), 10_000))]);
      assert.equal(await page.locator("#novel-manuscript-button").isDisabled(), true);
      await dialog.getByRole("button", { name: "加入草稿", exact: true }).click();
      await dialog.getByRole("status").filter({ hasText: "正在核对历史" }).waitFor();
      assert.deepEqual(diskStory(), original);
    } finally {
      releaseHead();
      if (headRequested) await headFinished;
      await page.unroute(headPattern);
    }
    await page.locator('#novel-undo[aria-busy="false"]').waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await page.getByLabel("对白文本", { exact: true }).first().inputValue(), "Original chapter");
    await clickNovelHistory(page, "redo");
    await page.locator(".nv-label").filter({ hasText: "imported" }).click();
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = diskStory();
    assert.equal(saved.start, "imported");
    assert.deepEqual(saved.script.start, original.script.start);
    assert.equal(saved.script.imported.length, 3);
    assert.deepEqual(saved.script.imported.map((line: any) => line.speaker ?? null), [null, "Mira", "Ren"]);

    await upload("bad.txt", Buffer.from([0xff, 0xfe, 0x00]));
    await page.waitForFunction(() => document.querySelector("#novel-notice")?.textContent?.includes("手稿导入失败"));
    assert.deepEqual(diskStory(), saved);
    assert.equal(await dialog.count(), 0);
    await page.reload();
    await page.getByLabel("对白文本", { exact: true }).first().waitFor();
    assert.equal(diskStory().start, "imported");
    await page.locator("#novel-build").click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/status`)).json() as any;
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/, JSON.stringify(status));
    const artifact = join(temporary, "workspace", "builds", id, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    native = new NativeSession({ bytecodePath: join(artifact, "app.qjbc"), pakPath: join(artifact, "app.pak"), metadataPath, runtimeAbi: metadata.runtimeAbi }, { deadlineMs: 30_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await native.settle(frame, 120);
    assert.match(textOf(frame), /23:08\s+the\s+lamp\s+is\s+still\s+on/);
    assert.deepEqual(errors, []);
  } finally {
    await native?.quit(); await browser.close(); await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
