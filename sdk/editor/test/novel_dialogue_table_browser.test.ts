import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";

test("dialogue table edits the canonical story, retains non-say data, and builds the changed line into a real Guest", { timeout: 180_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-dialogue-table-browser-"));
  const project = join(temporary, "project");
  const id = "dialogue-table-browser";
  const artifactRoot = process.env.POCKET_DIALOGUE_TABLE_ARTIFACT_DIR?.trim() || join(repository, "sdk/.pocket-build/novel-dialogue-table-20261108");
  mkdirSync(project);
  mkdirSync(artifactRoot, { recursive: true });
  for (const name of ["pocket.json", "package.json", "manifest.json", "fonts.json", "fonts"]) {
    cpSync(join(repository, "demo/js/apps/lantern", name), join(project, name), { recursive: true });
  }
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id, appId: id, name: id, version: "0.1.0", entry: "app.tsx", framework: "solid", build: 1, tickHz: 60 }, null, 2));

  const archiveLines = Array.from({ length: 25 }, (_, index) => ({
    type: "say",
    id: `archive_${String(index).padStart(2, "0")}`,
    speaker: "旁白",
    text: "An archived line.",
    editorial: { retained: index },
  }));
  const story = {
    id,
    version: 1,
    start: "start",
    locale: "zh-CN",
    metadata: { source: "dialogue-table-fixture", preserve: ["custom", "order"] },
    variableDefinitions: { chapterCount: { lifetime: "save", defaultValue: 0 } },
    script: {
      start: [
        { type: "set", variable: "chapterCount", value: 1, editorial: { position: "before" } },
        { type: "say", id: "opening", speaker: "Mira", text: "Original table dialogue.", editorial: { translated: false, notes: ["keep me"] } },
        { type: "inc", variable: "chapterCount", amount: 1, editorial: { position: "between" } },
        { type: "say", id: "second", speaker: "Narrator", text: "Second dialogue." },
        { type: "choice", id: "archive-choice", prompt: "Open the archive?", options: [
          { id: "open-archive", text: "Open", target: "archive" },
          { id: "finish", text: "Finish", target: "finish" },
        ] },
      ],
      archive: [...archiveLines, { type: "ending", id: "archive-end", text: "Archive closed." }],
      finish: [{ type: "ending", id: "finish-end", text: "Finished." }],
    },
  };
  const localeDocument = {
    format: "pocket-vn-locales",
    formatVersion: 1,
    catalogs: {
      en: {
        format: "pocket-vn-locale",
        formatVersion: 1,
        locale: "en",
        lines: { opening: "Original table dialogue." },
        speakers: { Mira: "Mira" },
        choices: {},
        endings: {},
        ui: {},
      },
    },
  };
  const localeBytes = JSON.stringify(localeDocument, null, 2);
  writeFileSync(join(project, "story.json"), JSON.stringify(story, null, 2));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }, null, 2));
  writeFileSync(join(project, "novel.locales.json"), localeBytes);
  writeFileSync(join(project, "images.json"), "{}\n");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createNovelEngine } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

const engine = createNovelEngine(story as any);
function App() {
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeClock(); engine.dispose(); });
  return <NovelView engine={engine} assets={assets} title="Dialogue table" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const server = await startEditor({ port: 0, updatePort: 0, workspace: join(temporary, "workspace"), projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let native: NativeSession | undefined;
  try {
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    await page.waitForFunction(() => document.querySelector("#novel-diagnostics") !== null);
    await page.getByRole("button", { name: "对白表格", exact: true }).click();
    await page.locator("#novel-dialogue-table").waitFor();
    assert.equal(await page.locator("#novel-dialogue-table-body [data-dialogue-row]").count(), 25, "only the first bounded page is mounted");
    assert.match(await page.locator("#novel-dialogue-table-page-status").innerText(), /第 1 \/ 2 页/);
    await page.locator("#novel-dialogue-next").click();
    assert.equal(await page.locator("#novel-dialogue-table-body [data-dialogue-row]").count(), 2);
    assert.equal(await page.locator('[data-dialogue-row="archive:24"]').count(), 1, "the final row reports its original script index");
    await page.locator("#novel-dialogue-previous").click();

    const filter = page.getByLabel("筛选对白", { exact: true });
    await filter.fill("opening");
    await page.locator("#novel-dialogue-filter").click();
    const openingRow = page.locator('[data-dialogue-row="start:1"]');
    await openingRow.waitFor();
    assert.equal(await page.locator("#novel-dialogue-table-body [data-dialogue-row]").count(), 1);
    const stableId = openingRow.getByLabel("稳定对白 ID start:1", { exact: true });
    assert.equal(await stableId.inputValue(), "opening");
    assert.equal(await stableId.evaluate(element => (element as HTMLInputElement).readOnly), true, "table edits keep the localization key and external references stable");
    assert.equal(await openingRow.getByLabel("说话人 start:1", { exact: true }).inputValue(), "Mira");

    await openingRow.getByLabel("说话人 start:1", { exact: true }).fill("Mira Revised");
    const dialogueText = openingRow.getByLabel("对白文本 start:1", { exact: true });
    await dialogueText.click();
    await dialogueText.press("ControlOrMeta+A");
    await dialogueText.pressSequentially("Table edit reached by Guest.");
    assert.equal(await openingRow.getAttribute("data-dialogue-row"), "start:1", "editing leaves the filtered row at its original label/index without rerendering it");
    await clickNovelHistory(page, "undo");
    const originalRow = page.locator('[data-dialogue-row="start:1"]');
    assert.equal(await originalRow.getByLabel("稳定对白 ID start:1", { exact: true }).inputValue(), "opening");
    assert.equal(await originalRow.getByLabel("说话人 start:1", { exact: true }).inputValue(), "Mira Revised", "a single undo reverses the grouped text typing only");
    assert.equal(await originalRow.getByLabel("对白文本 start:1", { exact: true }).inputValue(), "Original table dialogue.");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.locator('[data-dialogue-row="start:1"]').getByLabel("对白文本 start:1", { exact: true }).inputValue(), "Table edit reached by Guest.");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const afterSave = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    const expected = structuredClone(story);
    expected.script.start[1]!.speaker = "Mira Revised";
    expected.script.start[1]!.text = "Table edit reached by Guest.";
    assert.deepEqual(afterSave, expected, "only editable speaker/text fields change; source positions and extra fields remain intact");
    assert.equal(readFileSync(join(project, "novel.locales.json"), "utf8"), localeBytes, "table editing does not rewrite the locale catalog");

    await page.screenshot({ path: join(artifactRoot, "dialogue-table-filtered.png") });
    await page.reload();
    await page.getByRole("button", { name: "对白表格", exact: true }).click();
    await page.getByLabel("筛选对白", { exact: true }).fill("opening");
    await page.locator("#novel-dialogue-filter").click();
    const reopenedRow = page.locator('[data-dialogue-row="start:1"]');
    await reopenedRow.waitFor();
    assert.equal(await reopenedRow.getByLabel("对白文本 start:1", { exact: true }).inputValue(), "Table edit reached by Guest.");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "story.json"), "utf8")), expected);
    assert.equal(readFileSync(join(project, "novel.locales.json"), "utf8"), localeBytes);

    await page.locator("#novel-build").click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/status`)).json() as any;
    assert.equal(status.revision, status.builtRevision);
    const artifact = join(temporary, "workspace", "builds", id, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    native = new NativeSession({
      bytecodePath: join(artifact, "app.qjbc"),
      pakPath: join(artifact, "app.pak"),
      metadataPath,
      runtimeAbi: metadata.runtimeAbi,
    }, { width: 360, height: 640, deadlineMs: 30_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    for (let attempt = 0; attempt < 90 && !textOf(frame).includes("Table edit reached by Guest."); attempt++) frame = await native.frame();
    assert.match(textOf(frame), /Table edit reached by Guest\./, "the built Guest shows the edited line after real title pointer input");
    assert.deepEqual(errors, []);
  } finally {
    await native?.quit();
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
