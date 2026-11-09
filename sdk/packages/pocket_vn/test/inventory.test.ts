import { expect, test } from "bun:test";
import {
  createNovelEngine,
  planNovelInventoryTrade,
  validateNovelInventory,
  type NovelInventory,
  type NovelTradeInstruction,
} from "../src/index.ts";
import type { JsonValue, StoryDefinition, StoryInstruction } from "../src/types.ts";

const baseInventory: NovelInventory = {
  currency: { title: "Coins", variable: "coins" },
  items: {
    potion: {
      title: "Potion",
      body: "Restores one point.",
      quantityVariable: "potion_count",
      buyPrice: 5,
      sellPrice: 2,
      maxQuantity: 4,
    },
  },
};

const baseDefinitions = {
  coins: { lifetime: "save", defaultValue: 20 },
  potion_count: { lifetime: "save", defaultValue: 0 },
} as const;

const say = (id: string): StoryInstruction => ({ type: "say", id, text: id });
const trade = (action: NovelTradeInstruction["action"], quantity: number): StoryInstruction => ({
  type: "trade", item: "potion", action, quantity, onFailure: "failed",
});

function story(
  instructions: readonly StoryInstruction[],
  options: {
    inventory?: NovelInventory;
    variableDefinitions?: StoryDefinition["variableDefinitions"];
    initialFailure?: boolean;
  } = {},
): StoryDefinition {
  const start = options.initialFailure
    ? [{ type: "set", variable: "coins", value: -1 } as const, ...instructions]
    : instructions;
  return {
    id: "test.inventory",
    version: 1,
    start: "start",
    ...(options.inventory === undefined ? { inventory: baseInventory } : { inventory: options.inventory }),
    variableDefinitions: options.variableDefinitions ?? baseDefinitions,
    script: {
      start,
      failed: [say("failed")],
    },
  };
}

const fastPreferences = { textSpeedCharsPerSecond: 0 } as const;

test("inventory validator accepts bounded plain catalog data and checks save-variable declarations", () => {
  expect(validateNovelInventory(baseInventory)).toEqual([]);
  expect(validateNovelInventory(baseInventory, { story: { variableDefinitions: baseDefinitions } })).toEqual([]);

  const invalid = {
    currency: { title: "Coins", variable: "coins", icon: "gold.png" },
    items: {
      "bad id": { title: "Potion", body: "", quantityVariable: "coins", buyPrice: 1.25, maxQuantity: 0, imagePath: "../outside.png" },
    },
  };
  const issues = validateNovelInventory(invalid);
  expect(issues.map(issue => issue.code)).toContain("inventory.fields");
  expect(issues.map(issue => issue.code)).toContain("inventory.id");
  expect(issues.map(issue => issue.code)).toContain("inventory.price");
  expect(issues.map(issue => issue.code)).toContain("inventory.maxQuantity");
  expect(issues.map(issue => issue.code)).toContain("inventory.variable.duplicate");
  expect(issues.every(issue => issue.path.startsWith("inventory"))).toBe(true);

  expect(validateNovelInventory(baseInventory, {
    story: { variableDefinitions: { coins: { lifetime: "persistent", defaultValue: 0 }, potion_count: { lifetime: "save", defaultValue: 0 } } },
  }).map(issue => issue.code)).toContain("inventory.variable.save");
  expect(validateNovelInventory(baseInventory, {
    story: { variableDefinitions: { coins: { lifetime: "save", defaultValue: 1.5 }, potion_count: { lifetime: "save", defaultValue: 0 } } },
  }).map(issue => issue.code)).toContain("inventory.variable.save");
  expect(validateNovelInventory(baseInventory, {
    story: { variableDefinitions: { coins: { lifetime: "save", defaultValue: 0 } } },
  }).map(issue => issue.code)).toContain("inventory.variable.missing");
  expect(validateNovelInventory(baseInventory, {
    story: {
      variableDefinitions: {
        coins: { lifetime: "save", defaultValue: 20 },
        potion_count: { lifetime: "save", defaultValue: 5 },
      },
    },
  })).toContainEqual(expect.objectContaining({
    code: "inventory.maxQuantity.default",
    path: "inventory.items.potion.maxQuantity",
  }));
  expect(validateNovelInventory({ currency: baseInventory.currency, items: Object.create({ potion: baseInventory.items.potion }) }))
    .toContainEqual(expect.objectContaining({ code: "inventory.items" }));
});

test("trade instruction validation requires catalog items, exact fields, positive quantity, and a failure label", () => {
  const valid = story([trade("buy", 1), say("complete")]);
  expect(() => createNovelEngine(valid)).not.toThrow();

  const invalidInstruction = (instruction: Record<string, unknown>): StoryDefinition => ({
    ...story([], { inventory: baseInventory }),
    script: { start: [instruction as unknown as StoryInstruction], failed: [say("failed")] },
  });
  expect(() => createNovelEngine(invalidInstruction({ type: "trade", item: "missing", action: "buy", quantity: 1, onFailure: "failed" })))
    .toThrow(/unknown inventory item/);
  expect(() => createNovelEngine(invalidInstruction({ type: "trade", item: "potion", action: "buy", quantity: 0, onFailure: "failed" })))
    .toThrow(/positive safe integer/);
  expect(() => createNovelEngine(invalidInstruction({ type: "trade", item: "potion", action: "buy", quantity: 1, onFailure: "missing" })))
    .toThrow(/unknown label/);
  expect(() => createNovelEngine(invalidInstruction({ type: "trade", item: "potion", action: "buy", quantity: 1, onFailure: "failed", extra: true })))
    .toThrow(/only type, item, action, quantity, and onFailure/);
  const withoutCatalog = story([trade("buy", 1)]);
  delete (withoutCatalog as { inventory?: NovelInventory }).inventory;
  expect(() => createNovelEngine(withoutCatalog)).toThrow(/unknown inventory item/);
});

test("pure trade planning returns all variable updates together and leaves inputs unchanged", () => {
  const variables: Readonly<Record<string, JsonValue>> = { coins: 20, potion_count: 1 };
  const before = structuredClone(variables);
  expect(planNovelInventoryTrade(baseInventory, variables, { item: "potion", action: "buy", quantity: 2 }))
    .toEqual({ ok: true, updates: { coins: 10, potion_count: 3 } });
  expect(planNovelInventoryTrade(baseInventory, variables, { item: "potion", action: "sell", quantity: 1 }))
    .toEqual({ ok: true, updates: { coins: 22, potion_count: 0 } });
  expect(planNovelInventoryTrade(baseInventory, variables, { item: "potion", action: "consume", quantity: 1 }))
    .toEqual({ ok: true, updates: { potion_count: 0 } });
  expect(variables).toEqual(before);

  expect(planNovelInventoryTrade(baseInventory, { coins: -1, potion_count: 0 }, { item: "potion", action: "buy", quantity: 1 }))
    .toEqual({ ok: false, reason: "invalid-currency" });
  expect(planNovelInventoryTrade(baseInventory, { coins: 20, potion_count: 1.5 }, { item: "potion", action: "consume", quantity: 1 }))
    .toEqual({ ok: false, reason: "invalid-stock" });
  expect(planNovelInventoryTrade(baseInventory, { coins: 4, potion_count: 0 }, { item: "potion", action: "buy", quantity: 1 }))
    .toEqual({ ok: false, reason: "insufficient-funds" });
  expect(planNovelInventoryTrade(baseInventory, { coins: 20, potion_count: 4 }, { item: "potion", action: "buy", quantity: 1 }))
    .toEqual({ ok: false, reason: "quantity-limit" });
  expect(planNovelInventoryTrade(baseInventory, { coins: 20, potion_count: 0 }, { item: "potion", action: "sell", quantity: 1 }))
    .toEqual({ ok: false, reason: "insufficient-stock" });

  const hugePrice: NovelInventory = {
    currency: baseInventory.currency,
    items: { potion: { ...baseInventory.items.potion, buyPrice: Number.MAX_SAFE_INTEGER } },
  };
  expect(planNovelInventoryTrade(hugePrice, { coins: Number.MAX_SAFE_INTEGER, potion_count: 0 },
    { item: "potion", action: "buy", quantity: 2 })).toEqual({ ok: false, reason: "arithmetic-overflow" });
  expect(planNovelInventoryTrade(baseInventory, { coins: Number.MAX_SAFE_INTEGER, potion_count: 1 },
    { item: "potion", action: "sell", quantity: 1 })).toEqual({ ok: false, reason: "arithmetic-overflow" });

  const aliasedCatalog: NovelInventory = {
    currency: { title: "Coins", variable: "potion_count" },
    items: baseInventory.items,
  };
  expect(planNovelInventoryTrade(aliasedCatalog, { potion_count: 2 },
    { item: "potion", action: "buy", quantity: 1 })).toEqual({ ok: false, reason: "invalid-catalog" });
});

test("engine commits buy, sell, and consume together and reuses save, rollback, load, and newGame state", () => {
  const game = createNovelEngine(story([
    say("start_line"),
    trade("buy", 2),
    say("bought"),
    trade("sell", 1),
    say("sold"),
    trade("consume", 1),
    say("consumed"),
  ]), { preferences: fastPreferences });
  try {
    let update = game.start();
    expect(update.snapshot.active?.id).toBe("start_line");
    expect(update.snapshot.variables).toMatchObject({ coins: 20, potion_count: 0 });

    update = game.advance();
    expect(update.snapshot.active?.id).toBe("bought");
    expect(update.snapshot.variables).toMatchObject({ coins: 10, potion_count: 2 });
    const afterBuy = game.save();

    const loaded = createNovelEngine(story([say("start_line"), trade("buy", 2), say("bought"), trade("sell", 1), say("sold")]), {
      preferences: fastPreferences,
    });
    try {
      const loadedUpdate = loaded.load(afterBuy);
      expect(loadedUpdate.snapshot.active?.id).toBe("bought");
      expect(loadedUpdate.snapshot.variables).toMatchObject({ coins: 10, potion_count: 2 });
      const afterLoadedSale = loaded.advance();
      expect(afterLoadedSale.snapshot.active?.id).toBe("sold");
      expect(afterLoadedSale.snapshot.variables).toMatchObject({ coins: 12, potion_count: 1 });
    } finally {
      loaded.dispose();
    }

    update = game.advance();
    expect(update.snapshot.active?.id).toBe("sold");
    expect(update.snapshot.variables).toMatchObject({ coins: 12, potion_count: 1 });
    update = game.advance();
    expect(update.snapshot.active?.id).toBe("consumed");
    expect(update.snapshot.variables).toMatchObject({ coins: 12, potion_count: 0 });

    update = game.rollback(2);
    expect(update.snapshot.active?.id).toBe("bought");
    expect(update.snapshot.variables).toMatchObject({ coins: 10, potion_count: 2 });
    update = game.advance();
    expect(update.snapshot.active?.id).toBe("sold");
    expect(update.snapshot.variables).toMatchObject({ coins: 12, potion_count: 1 });

    update = game.newGame();
    expect(update.snapshot.active?.id).toBe("start_line");
    expect(update.snapshot.variables).toMatchObject({ coins: 20, potion_count: 0 });
  } finally {
    game.dispose();
  }
});

test("failed trades jump without partial writes, including invalid runtime values and safe-integer overflow", () => {
  const insufficientFunds = createNovelEngine(story([trade("buy", 1)] , {
    variableDefinitions: {
      coins: { lifetime: "save", defaultValue: 4 },
      potion_count: { lifetime: "save", defaultValue: 0 },
    },
  }), { preferences: fastPreferences });
  try {
    const before = insufficientFunds.getSnapshot().variables;
    const failed = insufficientFunds.start();
    expect(failed.snapshot.active?.id).toBe("failed");
    expect(failed.snapshot.variables).toEqual(before);
  } finally {
    insufficientFunds.dispose();
  }

  const invalidRuntime = createNovelEngine(story([trade("buy", 1)], { initialFailure: true }), { preferences: fastPreferences });
  try {
    const failed = invalidRuntime.start();
    expect(failed.snapshot.active?.id).toBe("failed");
    expect(failed.snapshot.variables).toMatchObject({ coins: -1, potion_count: 0 });
  } finally {
    invalidRuntime.dispose();
  }

  const sellOverflowInventory: NovelInventory = {
    currency: baseInventory.currency,
    items: { potion: { ...baseInventory.items.potion, sellPrice: 1 } },
  };
  const sellOverflow = createNovelEngine(story([trade("sell", 1)], {
    inventory: sellOverflowInventory,
    variableDefinitions: {
      coins: { lifetime: "save", defaultValue: Number.MAX_SAFE_INTEGER },
      potion_count: { lifetime: "save", defaultValue: 1 },
    },
  }), { preferences: fastPreferences });
  try {
    const failed = sellOverflow.start();
    expect(failed.snapshot.active?.id).toBe("failed");
    expect(failed.snapshot.variables).toMatchObject({ coins: Number.MAX_SAFE_INTEGER, potion_count: 1 });
  } finally {
    sellOverflow.dispose();
  }
});
