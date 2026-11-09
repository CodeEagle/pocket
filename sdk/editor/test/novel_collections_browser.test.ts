import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import {
  materializeNovelCollectionsFixture,
  runNativeCollectionsAcceptance,
  type NovelCollectionsExpectation,
} from "../../../demo/js/tests/novel_collections_acceptance.ts";
import type { NativeArtifacts } from "../../../demo/js/tests/native_session.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("Editor persists collection authoring through reload and history, then the same project unlocks in a native Guest", { timeout: 300_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-vn-collections-browser-"));
  const evidenceRoot = process.env.POCKET_COLLECTIONS_ACCEPTANCE_OUTPUT?.trim();
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-collections-fixture";
  materializeNovelCollectionsFixture(project);
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const assetsPath = join(project, "novel.assets.json");
  const diskAssets = () => JSON.parse(readFileSync(assetsPath, "utf8"));
  const originalAssets = diskAssets();
  const expected: NovelCollectionsExpectation = {
    collectionTitle: "港口人物档案 · 编辑器验收",
    publicTitle: "旧车站",
    publicBody: "旧车站公示牌上留下了 preview.png 字样，那只是故事正文，不是图片资源。",
    privateTitle: "Mira 的档案 · 编辑器验收",
    privateBody: "PRIVATE_RECORD_BODY：这条由 Editor 保存的档案只会在 Mira 解锁后展示。",
    portraitAsset: "art/mira.svg",
  };
  try {
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    const addCollectionPrompt = page.waitForEvent("dialog").then(async dialog => {
      assert.equal(dialog.type(), "prompt");
      await dialog.accept("temporaryRecords");
    });
    await Promise.all([
      page.getByRole("button", { name: "＋ 添加收藏集", exact: true }).click(),
      addCollectionPrompt,
    ]);
    await page.getByLabel("收藏集标题 temporaryRecords", { exact: true }).waitFor();
    const addEntryPrompt = page.waitForEvent("dialog").then(async dialog => {
      assert.equal(dialog.type(), "prompt");
      await dialog.accept("temporaryEntry");
    });
    await Promise.all([
      page.getByRole("button", { name: "添加条目 temporaryRecords", exact: true }).click(),
      addEntryPrompt,
    ]);
    await page.getByLabel("条目正文 temporaryRecords.temporaryEntry", { exact: true }).waitFor();
    await page.getByRole("button", { name: "删除条目 temporaryRecords.temporaryEntry", exact: true }).click();
    await page.getByLabel("条目正文 temporaryRecords.temporaryEntry", { exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "删除收藏集 temporaryRecords", exact: true }).click();
    await page.getByLabel("收藏集标题 temporaryRecords", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(diskAssets(), originalAssets, "adding then deleting a draft collection and entry must not write before Save");

    const collectionTitle = page.getByLabel("收藏集标题 harborRecords", { exact: true });
    const entryTitle = page.getByLabel("条目标题 harborRecords.mira", { exact: true });
    const entryBody = page.getByLabel("条目正文 harborRecords.mira", { exact: true });
    await collectionTitle.waitFor();
    assert.equal(await collectionTitle.inputValue(), originalAssets.collections.harborRecords.title);
    assert.equal(await entryTitle.inputValue(), originalAssets.collections.harborRecords.entries.mira.title);

    await collectionTitle.fill(expected.collectionTitle);
    await entryTitle.fill(expected.privateTitle);
    await entryBody.fill(expected.privateBody);
    await page.getByLabel("肖像表情 harborRecords.mira", { exact: true }).selectOption("smile");
    await page.getByLabel("解锁变量 harborRecords.mira", { exact: true }).selectOption("miraRecordUnlocked");
    assert.deepEqual(diskAssets(), originalAssets, "Editor edits remain a draft until Save");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    let savedAssets = diskAssets();
    assert.equal(savedAssets.collections.harborRecords.title, expected.collectionTitle);
    assert.equal(savedAssets.collections.harborRecords.entries.mira.title, expected.privateTitle);
    assert.equal(savedAssets.collections.harborRecords.entries.mira.body, expected.privateBody);
    assert.deepEqual(savedAssets.collections.harborRecords.entries.mira.portrait, { character: "mira", expression: "smile" });
    assert.equal(savedAssets.collections.harborRecords.entries.mira.unlockVariable, "miraRecordUnlocked");
    assert.equal(savedAssets.collections.harborRecords.entries.harborStation.body, expected.publicBody);

    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await page.getByLabel("收藏集标题 harborRecords", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("收藏集标题 harborRecords", { exact: true }).inputValue(), expected.collectionTitle,
      "reopening the Editor must restore the saved collection title");
    assert.equal(await page.getByLabel("条目正文 harborRecords.mira", { exact: true }).inputValue(), expected.privateBody,
      "reopening the Editor must restore the saved entry body");
    if (evidenceRoot) await page.screenshot({ path: join(evidenceRoot, "editor-collections.png"), fullPage: true });

    await page.getByLabel("收藏集标题 harborRecords", { exact: true }).fill("临时标题");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("收藏集标题 harborRecords", { exact: true }).inputValue(), expected.collectionTitle,
      "undo after reopening must restore the persisted title");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("收藏集标题 harborRecords", { exact: true }).inputValue(), "临时标题",
      "redo after reopening must reapply the same edit");
    await clickNovelHistory(page, "undo");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    savedAssets = diskAssets();
    assert.equal(savedAssets.collections.harborRecords.title, expected.collectionTitle,
      "saving after undo must commit the restored title");

    const guestOutput = evidenceRoot ? join(evidenceRoot, "browser-guest") : join(temporary, "guest");
    const built = await buildGuest({ projectRoot: project, outDir: guestOutput, tickHz: 60 });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the edited project must build to the pinned QJBC Guest");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const result = await runNativeCollectionsAcceptance(artifacts, expected);
    assert.equal(result.autoSave.state.meta.persistentVariables.miraRecordUnlocked, true);
    assert.ok((result.finalFrame.ops ?? []).some(op => op.type === "image" && (op as typeof op & { asset?: string }).asset === expected.portraitAsset));
    assert.deepEqual(pageErrors, [], "Editor collection authoring must not raise browser errors");
    if (evidenceRoot) writeFileSync(join(evidenceRoot, "browser-result.json"), JSON.stringify({
      compiler: process.env.POCKET_COMPILER_PATH,
      projectId,
      bytecode: built.bytecode,
      pak: built.pak,
      metadata: built.metadata,
      sha256: { bytecode: sha256(built.bytecode), pak: sha256(built.pak), metadata: sha256(built.metadata) },
      savedCollection: savedAssets.collections.harborRecords.title,
      savedEntry: savedAssets.collections.harborRecords.entries.mira.title,
      persistentUnlock: result.autoSave.state.meta.persistentVariables.miraRecordUnlocked,
      pageErrors,
    }, null, 2));
    console.info("[novel-collections-browser]", JSON.stringify({
      project,
      guest: built.bytecode,
      pak: built.pak,
      savedCollection: savedAssets.collections.harborRecords.title,
      savedEntry: savedAssets.collections.harborRecords.entries.mira.title,
      persistentUnlock: result.autoSave.state.meta.persistentVariables.miraRecordUnlocked,
    }));
  } finally {
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
