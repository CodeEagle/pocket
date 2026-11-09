import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NativeSession, center, textOf, type DrawOp, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
export const inventoryFixture = resolve(import.meta.dir, "fixtures/novel-inventory");
export const inventoryAutoKey = "inventory.slot.auto";
export const inventoryQuickKey = "inventory.slot.quick";

export type InventoryAcceptanceCatalog = {
  readonly currencyTitle: string;
  readonly currencyVariable: string;
  readonly lampTitle: string;
  readonly lampBody: string;
  readonly lampVariable: string;
  readonly lampBuyPrice: number;
  readonly extraVariables?: Readonly<Record<string, number>>;
  readonly rationTitle: string;
  readonly rationBody: string;
  readonly chartTitle: string;
  readonly chartBody: string;
};

export const defaultInventoryCatalog: InventoryAcceptanceCatalog = {
  currencyTitle: "雾港银币",
  currencyVariable: "harborCoins",
  lampTitle: "潮灯",
  lampBody: "铜制灯罩里封着一颗蓝色微光，能照亮雾里的石阶。",
  lampVariable: "lampCount",
  lampBuyPrice: 12,
  extraVariables: { editorLampStock: 0 },
  rationTitle: "咸鱼干",
  rationBody: "海风吹干的鱼肉，足够撑过一段雾路。",
  chartTitle: "远洋罗盘",
  chartBody: "以银针刻出的航海罗盘，标价高过旅人身上的银币。",
};

export type InventoryValues = { readonly coins: number; readonly lamp: number; readonly ration: number; readonly chart: number };
export const defaultInventoryValues: InventoryValues = { coins: 30, lamp: 0, ration: 1, chart: 0 };

/** Materialize the isolated project and bind package links to this checkout. */
export function materializeNovelInventoryFixture(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  cpSync(inventoryFixture, projectRoot, { recursive: true });
  const sdkRoot = join(repositoryRoot, "sdk");
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
    name: "pocket-vn-inventory-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
      "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
    },
  }, null, 2));
}

function normalize(value: string): string {
  return value.replace(/[\s\u200b\ufeff]/g, "");
}

function hasVisibleText(frame: Frame, expected: string): boolean {
  return normalize(textOf(frame)).includes(normalize(expected));
}

function matchingTextOp(frame: Frame, label: string): DrawOp | undefined {
  const target = normalize(label);
  const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string");
  return candidates.find(op => normalize(op.text!) === target)
    ?? candidates.find(op => normalize(op.text!).includes(target))
    ?? candidates.find(op => target.includes(normalize(op.text!)) && normalize(op.text!).length >= 2);
}

async function waitForText(session: NativeSession, initial: Frame, expected: string, maxFrames = 60): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index++) {
    if (hasVisibleText(frame, expected)) return frame;
    frame = await session.frame();
  }
  throw new Error(`Inventory flow did not paint ${JSON.stringify(expected)}; last frame:\n${textOf(frame)}`);
}

async function scrollUntilText(session: NativeSession, initial: Frame, expected: string, maxDrags = 7): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxDrags && !hasVisibleText(frame, expected); index++) {
    frame = await session.drag({ x: 300, y: 690 }, { x: 300, y: 320 }, 5);
    frame = await session.settle(frame, 1);
  }
  if (!hasVisibleText(frame, expected)) {
    const painted = (frame.ops ?? []).filter(op => op.type === "text").map(op => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h }));
    throw new Error(`Native scroll did not reveal ${JSON.stringify(expected)}; painted=${JSON.stringify(painted)}`);
  }
  return frame;
}

async function tapText(session: NativeSession, frame: Frame, label: string): Promise<Frame> {
  if (!hasVisibleText(frame, label)) frame = await scrollUntilText(session, frame, label);
  const op = matchingTextOp(frame, label);
  assert.ok(op, `cannot tap visible text ${JSON.stringify(label)}; frame:\n${textOf(frame)}`);
  return session.tapPoint(center(op!, label));
}

function expectedVariables(catalog: InventoryAcceptanceCatalog, values: InventoryValues): Record<string, number> {
  return {
    ...(catalog.extraVariables ?? {}),
    [catalog.currencyVariable]: values.coins,
    [catalog.lampVariable]: values.lamp,
    rationCount: values.ration,
    chartCount: values.chart,
  };
}

function variablesFromSave(save: Record<string, any>): Record<string, number> {
  return save.state.variables as Record<string, number>;
}

function assertVariables(save: Record<string, any>, catalog: InventoryAcceptanceCatalog, expected: InventoryValues, reason: string): void {
  assert.deepEqual(variablesFromSave(save), expectedVariables(catalog, expected), reason);
}

async function waitForAutoSave(
  session: NativeSession,
  predicate: (save: Record<string, any>) => boolean,
  maxFrames = 100,
): Promise<Record<string, any>> {
  for (let index = 0; index < maxFrames; index++) {
    const save = session.storage[inventoryAutoKey] as Record<string, any> | undefined;
    if (save && predicate(save)) return save;
    await session.frame();
  }
  assert.fail(`autosave did not reach expected inventory state: ${JSON.stringify(session.storage[inventoryAutoKey])}`);
}

async function assertInventoryPanel(
  session: NativeSession,
  initial: Frame,
  catalog: InventoryAcceptanceCatalog,
  values: InventoryValues,
): Promise<Frame> {
  let frame = initial;
  assert.ok(hasVisibleText(frame, "随身行囊"), `inventory panel title missing:\n${textOf(frame)}`);
  assert.ok(hasVisibleText(frame, `${catalog.currencyTitle} · ${values.coins}`), `currency balance missing:\n${textOf(frame)}`);
  const items = [
    { title: catalog.lampTitle, body: catalog.lampBody, count: values.lamp },
    { title: catalog.rationTitle, body: catalog.rationBody, count: values.ration },
    { title: catalog.chartTitle, body: catalog.chartBody, count: values.chart },
  ];
  for (const item of items) {
    assert.ok(hasVisibleText(frame, item.title), `inventory list is missing ${item.title}:\n${textOf(frame)}`);
    frame = await tapText(session, frame, item.title);
    frame = await waitForText(session, frame, item.body);
    assert.ok(hasVisibleText(frame, `持有 ${item.count}`), `${item.title} quantity detail is wrong:\n${textOf(frame)}`);
    frame = await tapText(session, frame, "返回行囊列表");
    frame = await waitForText(session, frame, item.title);
  }
  return frame;
}

async function openInventoryFromTitle(
  session: NativeSession,
  initial: Frame,
  catalog: InventoryAcceptanceCatalog,
  values: InventoryValues,
): Promise<Frame> {
  let frame = await tapText(session, initial, "随身行囊");
  frame = await waitForText(session, frame, `${catalog.currencyTitle} · ${values.coins}`);
  frame = await assertInventoryPanel(session, frame, catalog, values);
  frame = await tapText(session, frame, "返回");
  return waitForText(session, frame, "启程 · 开始新的故事");
}

async function openInventoryInGame(
  session: NativeSession,
  initial: Frame,
  catalog: InventoryAcceptanceCatalog,
  values: InventoryValues,
): Promise<Frame> {
  let frame = initial;
  if (!hasVisibleText(frame, "旅途手札")) {
    frame = await tapText(session, frame, "手札");
    frame = await waitForText(session, frame, "旅途手札");
  }
  frame = await tapText(session, frame, "随身行囊");
  frame = await waitForText(session, frame, `${catalog.currencyTitle} · ${values.coins}`);
  frame = await assertInventoryPanel(session, frame, catalog, values);
  return tapText(session, frame, "返回");
}

async function saveQuickSlotAtChoice(
  session: NativeSession,
  initial: Frame,
  catalog: InventoryAcceptanceCatalog,
  expected: InventoryValues,
): Promise<Frame> {
  let frame = await tapText(session, initial, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  frame = await tapText(session, frame, "封存此刻");
  frame = await waitForText(session, frame, "快速保存此刻");
  frame = await tapText(session, frame, "快速保存此刻");
  for (let index = 0; index < 100 && !session.storage[inventoryQuickKey]; index++) frame = await session.frame();
  const quick = session.storage[inventoryQuickKey] as Record<string, any> | undefined;
  assert.ok(quick, "the visible quick-save action must write a manual slot");
  assertVariables(quick!, catalog, expected, "the manual quick slot must capture the initial currency and item quantities");
  assert.equal(quick!.state?.active?.kind, "choice", "the quick slot must capture the real merchant choice");
  frame = await tapText(session, frame, "返回");
  return waitForText(session, frame, "买一盏潮灯");
}

async function chooseAndCheck(
  session: NativeSession,
  initial: Frame,
  catalog: InventoryAcceptanceCatalog,
  choice: string,
  resultText: string,
  activeId: string,
  expected: InventoryValues,
  failure: boolean,
): Promise<Frame> {
  const beforeSave = await waitForAutoSave(session, save => save.state?.active?.kind === "choice");
  const beforeVariables = structuredClone(variablesFromSave(beforeSave));
  let frame = await tapText(session, initial, choice);
  frame = await waitForText(session, frame, resultText);
  const afterSave = await waitForAutoSave(session, save => save.state?.active?.id === activeId);
  if (failure) {
    assert.deepEqual(variablesFromSave(afterSave), beforeVariables, `${choice}: a failed trade must leave every inventory variable unchanged`);
  } else {
    assertVariables(afterSave, catalog, expected, `${choice}: successful trade must atomically update its currency and quantity`);
  }
  return frame;
}

async function advanceToNextMerchant(
  session: NativeSession,
  frame: Frame,
  resultText: string,
): Promise<Frame> {
  frame = await tapText(session, frame, resultText);
  return waitForText(session, frame, "买一盏潮灯");
}

async function returnToTitle(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = await tapText(session, initial, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  frame = await tapText(session, frame, "返回扉页");
  return waitForText(session, frame, "启程 · 开始新的故事");
}

async function loadQuickSlot(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = await tapText(session, initial, "手札");
  frame = await waitForText(session, frame, "旅途手札");
  frame = await tapText(session, frame, "重读信笺");
  for (let index = 0; index < 100; index++) {
    if (hasVisibleText(frame, "快速存档") && hasVisibleText(frame, "已保存的旅程") && !hasVisibleText(frame, "正在读取")) break;
    frame = await session.frame();
  }
  assert.ok(hasVisibleText(frame, "快速存档") && hasVisibleText(frame, "已保存的旅程") && !hasVisibleText(frame, "正在读取"),
    `load panel did not finish listing the saved quick slot:\n${textOf(frame)}`);
  const readsBefore = session.storageGets.filter(request => request.key === inventoryQuickKey).length;
  assert.ok(readsBefore > 0, "the load panel must have read the quick slot before it is selected");
  frame = await tapText(session, frame, "快速存档");
  assert.ok(session.storageGets.filter(request => request.key === inventoryQuickKey).length > readsBefore,
    "selecting the visible quick slot must issue a host read");
  frame = await waitForText(session, frame, "买一盏潮灯");
  assert.ok(session.storageGets.filter(request => request.key === inventoryQuickKey).length > readsBefore,
    "selecting the visible quick slot must read and load that old manual save");
  return frame;
}

/** Exercise actual painted bag controls and story-authored trade choices on a compiled Guest. */
export async function runNativeInventoryAcceptance(
  artifacts: NativeArtifacts,
  catalog: InventoryAcceptanceCatalog = defaultInventoryCatalog,
): Promise<{ finalSave: Record<string, any>; finalFrame: Frame }> {
  const session = new NativeSession(artifacts, { width: 360, height: 800, deadlineMs: 120_000, storage: {} });
  const initial = defaultInventoryValues;
  const boughtLamp: InventoryValues = { coins: initial.coins - catalog.lampBuyPrice, lamp: 1, ration: 1, chart: 0 };
  const soldLamp: InventoryValues = { coins: boughtLamp.coins + 7, lamp: 0, ration: 1, chart: 0 };
  const consumedRation: InventoryValues = { coins: soldLamp.coins, lamp: 0, ration: 0, chart: 0 };
  try {
    let frame = await session.boot();
    frame = await waitForText(session, frame, "启程 · 开始新的故事");
    frame = await openInventoryFromTitle(session, frame, catalog, initial);

    frame = await tapText(session, frame, "启程 · 开始新的故事");
    frame = await waitForText(session, frame, "雾港集市开张了");
    frame = await tapText(session, frame, "雾港集市开张了");
    frame = await waitForText(session, frame, "买一盏潮灯");
    frame = await saveQuickSlotAtChoice(session, frame, catalog, initial);

    frame = await chooseAndCheck(session, frame, catalog, "买一盏潮灯", "潮灯买好了。", "lamp_bought", boughtLamp, false);
    frame = await openInventoryInGame(session, frame, catalog, boughtLamp);
    frame = await tapText(session, frame, "回溯");
    frame = await waitForText(session, frame, "雾港集市开张了");
    const rolledBack = await waitForAutoSave(session, save => save.state?.active?.id === "market_open");
    assertVariables(rolledBack, catalog, initial, "rollback before the trade result was completed must restore the pre-trade checkpoint variables");
    frame = await tapText(session, frame, "雾港集市开张了");
    frame = await waitForText(session, frame, "买一盏潮灯");

    const scenarios: readonly {
      choice: string;
      resultText: string;
      activeId: string;
      expected: InventoryValues;
      failure: boolean;
    }[] = [
      { choice: "买一盏潮灯", resultText: "潮灯买好了。", activeId: "lamp_bought", expected: boughtLamp, failure: false },
      { choice: "再买一盏潮灯（测试携带上限）", resultText: "潮灯已达到携带上限。", activeId: "lamp_limit_failed", expected: boughtLamp, failure: true },
      { choice: "试买远洋罗盘（测试余额）", resultText: "银币不足，这笔交易没有扣款。", activeId: "funds_failed", expected: boughtLamp, failure: true },
      { choice: "卖出潮灯", resultText: "潮灯已卖出。", activeId: "lamp_sold", expected: soldLamp, failure: false },
      { choice: "卖出空仓潮灯", resultText: "没有潮灯可卖，交易没有改变行囊。", activeId: "lamp_stock_failed", expected: soldLamp, failure: true },
      { choice: "吃一份咸鱼干", resultText: "咸鱼干吃完了。", activeId: "ration_consumed", expected: consumedRation, failure: false },
      { choice: "再吃一份咸鱼干", resultText: "咸鱼干已经用完，行囊没有变化。", activeId: "ration_stock_failed", expected: consumedRation, failure: true },
    ];
    for (let index = 0; index < scenarios.length; index++) {
      const scenario = scenarios[index]!;
      frame = await chooseAndCheck(session, frame, catalog, scenario.choice, scenario.resultText, scenario.activeId, scenario.expected, scenario.failure);
      frame = index + 1 < scenarios.length
        ? await advanceToNextMerchant(session, frame, scenario.resultText)
        : await tapText(session, frame, scenario.resultText);
    }
    frame = await waitForText(session, frame, "集市收摊，雾港的灯仍亮着。");
    const completed = await waitForAutoSave(session, save => save.state?.active?.id === "market_close");
    assertVariables(completed, catalog, consumedRation, "completed shopping route must persist successful buy/sell/consume effects");

    frame = await loadQuickSlot(session, frame);
    const restored = await waitForAutoSave(session, save => save.state?.active?.kind === "choice");
    assertVariables(restored, catalog, initial, "loading the old quick slot must restore its saved currency and item quantities");
    frame = await openInventoryInGame(session, frame, catalog, initial);
    frame = await chooseAndCheck(session, frame, catalog, "买一盏潮灯", "潮灯买好了。", "lamp_bought", boughtLamp, false);

    frame = await returnToTitle(session, frame);
    frame = await tapText(session, frame, "启程 · 开始新的故事");
    frame = await waitForText(session, frame, "雾港集市开张了");
    const reset = await waitForAutoSave(session, save => save.state?.active?.id === "market_open");
    assertVariables(reset, catalog, initial, "newGame must reset all save-lifetime inventory variables to their declared defaults");
    frame = await openInventoryInGame(session, frame, catalog, initial);
    return { finalSave: reset, finalFrame: frame };
  } finally {
    await session.quit();
  }
}
