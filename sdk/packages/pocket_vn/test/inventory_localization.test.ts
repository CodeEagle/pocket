import { expect, test } from "bun:test";
import { diagnoseStoryLocale, localizeStory, novelInventoryTextKey, novelSourceUiMessages } from "../src/localization.ts";
import type { StoryDefinition, StoryLocaleCatalogCollection } from "../src/index.ts";

const story: StoryDefinition = {
  id: "inventory-locale", version: 1, start: "start",
  variableDefinitions: { coins: { lifetime: "save", defaultValue: 20 }, lamp: { lifetime: "save", defaultValue: 0 } },
  inventory: { currency: { title: "旅资券", variable: "coins" }, items: {
    "lamp.part": { title: "灯芯", body: "一截备用灯芯。", quantityVariable: "lamp", buyPrice: 7, sellPrice: 3 },
  } },
  script: { start: [{ type: "ending", id: "done", text: "结束" }] },
};

test("inventory source text comes from the same story and escaped item IDs", () => {
  const messages = novelSourceUiMessages(undefined, story);
  expect(messages[novelInventoryTextKey(null)]).toBe("旅资券");
  expect(messages[novelInventoryTextKey("lamp.part")]).toBe("灯芯");
  expect(novelInventoryTextKey("lamp.part", "body")).toBe("inventory.item.lamp%2Epart.body");
  expect(messages[novelInventoryTextKey("lamp.part", "body")]).toBe("一截备用灯芯。");
});

test("inventory text uses locale fallback without changing quantities or prices", () => {
  const catalogs: StoryLocaleCatalogCollection = { en: {
    format: "pocket-vn-locale", formatVersion: 1, locale: "en",
    ui: { [novelInventoryTextKey(null)]: "Tokens", [novelInventoryTextKey("lamp.part")]: "Wick" },
  } };
  const localized = localizeStory(story, catalogs, "en");
  expect(localized.ui[novelInventoryTextKey(null)]).toBe("Tokens");
  expect(localized.ui[novelInventoryTextKey("lamp.part")]).toBe("Wick");
  expect(localized.ui[novelInventoryTextKey("lamp.part", "body")]).toBe("一截备用灯芯。");
  expect(localized.ui["panel.inventory"]).toBe("Travel bag");
  expect(localized.story.inventory).toEqual(story.inventory);
  expect(story.inventory!.items["lamp.part"]!.buyPrice).toBe(7);
});

test("inventory prose participates in normal translation diagnostics", () => {
  const source = novelSourceUiMessages(undefined, story);
  const diagnostics = diagnoseStoryLocale(story, {
    format: "pocket-vn-locale", formatVersion: 1, locale: "en",
    ui: { ...source, "inventory.quantity": "Owned", "inventory.item.unknown.title": "Ghost" },
  });
  expect(diagnostics.some(issue => issue.code === "ui-placeholder-mismatch" && issue.path.includes("inventory.quantity"))).toBe(true);
  expect(diagnostics.some(issue => issue.code === "extra-ui" && issue.path.includes("inventory.item.unknown.title"))).toBe(true);
});
