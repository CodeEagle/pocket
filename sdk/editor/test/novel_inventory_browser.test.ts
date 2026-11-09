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
  defaultInventoryCatalog,
  materializeNovelInventoryFixture,
  runNativeInventoryAcceptance,
  type InventoryAcceptanceCatalog,
} from "../../../demo/js/tests/novel_inventory_acceptance.ts";
import type { NativeArtifacts } from "../../../demo/js/tests/native_session.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("Editor persists inventory and trade authoring, then the edited project passes native trade/save flow", { timeout: 360_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-vn-inventory-browser-"));
  const evidenceRoot = process.env.POCKET_INVENTORY_ACCEPTANCE_OUTPUT?.trim();
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-inventory-fixture";
  materializeNovelInventoryFixture(project);
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const storyPath = join(project, "story.json");
  const readStory = () => JSON.parse(readFileSync(storyPath, "utf8"));
  const originalStory = readStory();
  const expected: InventoryAcceptanceCatalog = {
    ...defaultInventoryCatalog,
    currencyTitle: "雾港银币 · 编辑器版",
    lampTitle: "编辑器潮灯",
    lampVariable: "editorLampStock",
    lampBuyPrice: 10,
    extraVariables: { lampCount: 0 },
  };

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.getByRole("button", { name: "库存与商店", exact: true }).click();
    const currencyTitle = page.getByLabel("货币标题", { exact: true });
    const lampTitle = page.getByLabel("物品标题 lamp", { exact: true });
    const lampVariable = page.getByLabel("物品数量变量 lamp", { exact: true });
    const lampPrice = page.getByLabel("购买价格 lamp", { exact: true });
    await currencyTitle.waitFor();

    const edit = async (field: ReturnType<typeof page.getByLabel>, value: string) => {
      await field.fill(value);
      await field.press("Tab");
    };
    await edit(currencyTitle, expected.currencyTitle);
    await edit(lampTitle, expected.lampTitle);
    await lampVariable.selectOption(expected.lampVariable);
    await edit(lampPrice, String(expected.lampBuyPrice));
    assert.deepEqual(readStory(), originalStory, "inventory edits stay in the Editor draft until Save");

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByRole("button", { name: /consume_empty_ration/ }).click();
    const emptyRationTrade = page.locator("#novel-instruction-list article.nv-instruction").first();
    const tradeQuantity = emptyRationTrade.getByLabel("交易数量", { exact: true });
    await tradeQuantity.fill("2");
    await tradeQuantity.press("Tab");
    assert.deepEqual(readStory(), originalStory, "trade instruction edits stay in the Editor draft until Save");

    await clickNovelHistory(page, "undo");
    assert.equal(await tradeQuantity.inputValue(), "1", "undo must restore the saved trade quantity");
    await clickNovelHistory(page, "redo");
    assert.equal(await tradeQuantity.inputValue(), "2", "redo must reapply the trade quantity");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    let savedStory = readStory();
    assert.equal(savedStory.inventory.currency.title, expected.currencyTitle);
    assert.equal(savedStory.inventory.items.lamp.title, expected.lampTitle);
    assert.equal(savedStory.inventory.items.lamp.quantityVariable, expected.lampVariable);
    assert.equal(savedStory.inventory.items.lamp.buyPrice, expected.lampBuyPrice);
    assert.equal(savedStory.variableDefinitions.editorLampStock.defaultValue, 0);
    assert.equal(savedStory.script.consume_empty_ration[0].type, "trade");
    assert.equal(savedStory.script.consume_empty_ration[0].quantity, 2);
    if (evidenceRoot) await page.screenshot({ path: join(evidenceRoot, "editor-trade.png"), fullPage: true });

    await page.reload();
    await page.getByRole("button", { name: "库存与商店", exact: true }).click();
    await page.getByLabel("货币标题", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("货币标题", { exact: true }).inputValue(), expected.currencyTitle);
    assert.equal(await page.getByLabel("物品标题 lamp", { exact: true }).inputValue(), expected.lampTitle);
    assert.equal(await page.getByLabel("物品数量变量 lamp", { exact: true }).inputValue(), expected.lampVariable);
    assert.equal(await page.getByLabel("购买价格 lamp", { exact: true }).inputValue(), String(expected.lampBuyPrice));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByLabel("货币标题", { exact: true }).scrollIntoViewIfNeeded();
    if (evidenceRoot) await page.screenshot({ path: join(evidenceRoot, "inventory-catalog.png") });

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByRole("button", { name: /consume_empty_ration/ }).click();
    const reopenedTradeQuantity = page.locator("#novel-instruction-list article.nv-instruction").first().getByLabel("交易数量", { exact: true });
    assert.equal(await reopenedTradeQuantity.inputValue(), "2", "reopen must restore the saved trade instruction");
    await page.getByRole("button", { name: "库存与商店", exact: true }).click();
    const reopenedLampTitle = page.getByLabel("物品标题 lamp", { exact: true });
    await reopenedLampTitle.fill("临时潮灯");
    await reopenedLampTitle.press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("物品标题 lamp", { exact: true }).inputValue(), expected.lampTitle,
      "undo after reopening must restore the persisted item title");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("物品标题 lamp", { exact: true }).inputValue(), "临时潮灯");
    await clickNovelHistory(page, "undo");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    savedStory = readStory();
    assert.equal(savedStory.inventory.items.lamp.title, expected.lampTitle,
      "saving after undo must commit the restored item title");
    assert.equal(savedStory.script.consume_empty_ration[0].quantity, 2);

    const guestOutput = evidenceRoot ? join(evidenceRoot, "browser-guest") : join(temporary, "guest");
    const built = await buildGuest({ projectRoot: project, outDir: guestOutput, tickHz: 60 });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the edited story must build to pinned QuickJS bytecode");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const result = await runNativeInventoryAcceptance(artifacts, expected);
    assert.deepEqual(result.finalSave.state.variables, {
      harborCoins: 30,
      lampCount: 0,
      editorLampStock: 0,
      rationCount: 1,
      chartCount: 0,
    });
    assert.deepEqual(pageErrors, [], "Editor inventory authoring must not raise browser errors");
    if (evidenceRoot) writeFileSync(join(evidenceRoot, "browser-result.json"), JSON.stringify({
      compiler: process.env.POCKET_COMPILER_PATH,
      projectId,
      bytecode: built.bytecode,
      pak: built.pak,
      metadata: built.metadata,
      sha256: { bytecode: sha256(built.bytecode), pak: sha256(built.pak), metadata: sha256(built.metadata) },
      inventory: expected,
      finalVariables: result.finalSave.state.variables,
      editedTrade: savedStory.script.consume_empty_ration[0],
      pageErrors,
      viewport: { width: 360, height: 800 },
    }, null, 2));
    console.info("[novel-inventory-browser]", JSON.stringify({
      projectId,
      guest: built.bytecode,
      pak: built.pak,
      finalVariables: result.finalSave.state.variables,
      editedTrade: savedStory.script.consume_empty_ration[0],
    }));
  } finally {
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
