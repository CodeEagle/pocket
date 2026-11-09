import type { JsonValue, StoryDefinition } from "./types.ts";
import { isNovelVariableName } from "./variables.ts";

export interface NovelInventoryCurrency {
  readonly title: string;
  readonly variable: string;
}

export interface NovelInventoryItem {
  readonly title: string;
  readonly body: string;
  readonly quantityVariable: string;
  readonly buyPrice: number;
  readonly sellPrice?: number;
  readonly maxQuantity?: number;
}

/** Immutable authored catalog; live quantities and currency remain story variables. */
export interface NovelInventory {
  readonly currency: NovelInventoryCurrency;
  readonly items: Readonly<Record<string, NovelInventoryItem>>;
}

/** Immediate story instruction that trades against the current variable projection. */
export interface NovelTradeInstruction {
  readonly type: "trade";
  readonly item: string;
  readonly action: "buy" | "sell" | "consume";
  readonly quantity: number;
  readonly onFailure: string;
}

export interface NovelInventoryValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface NovelInventoryValidationContext {
  readonly story?: Pick<StoryDefinition, "variableDefinitions">;
}

export type NovelInventoryTradeFailureReason =
  | "invalid-instruction"
  | "invalid-quantity"
  | "unknown-item"
  | "invalid-catalog"
  | "invalid-currency"
  | "invalid-stock"
  | "insufficient-funds"
  | "insufficient-stock"
  | "not-sellable"
  | "quantity-limit"
  | "arithmetic-overflow";

export type NovelInventoryTradePlan =
  | { readonly ok: true; readonly updates: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly reason: NovelInventoryTradeFailureReason };

const inventoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ITEMS = 2048;
const MAX_TITLE_LENGTH = 512;
const MAX_BODY_LENGTH = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  });
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function addIssue(
  issues: NovelInventoryValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

/** Validate bounded authored inventory data and, when supplied, its save-variable declarations. */
export function validateNovelInventory(
  value: unknown,
  context: NovelInventoryValidationContext = {},
): readonly NovelInventoryValidationIssue[] {
  const issues: NovelInventoryValidationIssue[] = [];
  if (!isPlainDataRecord(value)) {
    return [{ code: "inventory.schema", path: "inventory", message: "Inventory must be a plain object with currency and items." }];
  }
  if (!hasOnlyFields(value, ["currency", "items"])) {
    addIssue(issues, "inventory.fields", "inventory", "Inventory may contain only currency and items.");
  }

  const usedVariables = new Set<string>();
  const validateVariable = (raw: unknown, path: string): void => {
    if (typeof raw !== "string" || !isNovelVariableName(raw)) {
      addIssue(issues, "inventory.variable", path, "Inventory variables must use a valid Pocket story variable name.");
      return;
    }
    if (usedVariables.has(raw)) {
      addIssue(issues, "inventory.variable.duplicate", path, `Inventory variable '${raw}' is already assigned to another balance or item quantity.`);
    }
    usedVariables.add(raw);
    if (context.story !== undefined) {
      const definitions = context.story.variableDefinitions;
      const definition = definitions && Object.hasOwn(definitions, raw) ? definitions[raw] : undefined;
      if (!definition) {
        addIssue(issues, "inventory.variable.missing", path, `Inventory variable '${raw}' must be declared in the story.`);
      } else if (definition.lifetime !== "save" || !isNonNegativeSafeInteger(definition.defaultValue)) {
        addIssue(issues, "inventory.variable.save", path, "Inventory variables must use lifetime 'save' and a non-negative safe-integer defaultValue.");
      }
    }
  };

  const currency = value.currency;
  if (!isPlainDataRecord(currency)) {
    addIssue(issues, "inventory.currency", "inventory.currency", "Currency must be a plain object with title and variable.");
  } else {
    if (!hasOnlyFields(currency, ["title", "variable"])) {
      addIssue(issues, "inventory.fields", "inventory.currency", "Currency may contain only title and variable.");
    }
    if (!isNonEmptyText(currency.title, MAX_TITLE_LENGTH)) {
      addIssue(issues, "inventory.title", "inventory.currency.title", `Currency titles must be non-empty text up to ${MAX_TITLE_LENGTH} characters.`);
    }
    validateVariable(currency.variable, "inventory.currency.variable");
  }

  const items = value.items;
  if (!isPlainDataRecord(items)) {
    addIssue(issues, "inventory.items", "inventory.items", "Inventory items must be a plain object keyed by item ID.");
    return issues;
  }
  const itemIds = Reflect.ownKeys(items);
  if (itemIds.some(key => typeof key !== "string")) {
    addIssue(issues, "inventory.items", "inventory.items", "Inventory item IDs must be string keys.");
  }
  const stringItemIds = itemIds.filter((key): key is string => typeof key === "string");
  if (stringItemIds.length > MAX_ITEMS) {
    addIssue(issues, "inventory.limit", "inventory.items", `An inventory may define at most ${MAX_ITEMS} items.`);
  }

  for (const itemId of stringItemIds.slice(0, MAX_ITEMS)) {
    const itemPath = `inventory.items.${itemId}`;
    if (!inventoryIdPattern.test(itemId)) {
      addIssue(issues, "inventory.id", itemPath, "Item IDs must be 1–128 letters, digits, dots, underscores, colons, or dashes and start with a letter or digit.");
    }
    const item = items[itemId];
    if (!isPlainDataRecord(item)) {
      addIssue(issues, "inventory.item", itemPath, "An inventory item must be a plain object with title, body, quantityVariable, and buyPrice.");
      continue;
    }
    if (!hasOnlyFields(item, ["title", "body", "quantityVariable", "buyPrice", "sellPrice", "maxQuantity"])) {
      addIssue(issues, "inventory.fields", itemPath, "An item may contain only title, body, quantityVariable, buyPrice, sellPrice, and maxQuantity.");
    }
    if (!isNonEmptyText(item.title, MAX_TITLE_LENGTH)) {
      addIssue(issues, "inventory.title", `${itemPath}.title`, `Item titles must be non-empty text up to ${MAX_TITLE_LENGTH} characters.`);
    }
    if (typeof item.body !== "string" || item.body.length > MAX_BODY_LENGTH) {
      addIssue(issues, "inventory.body", `${itemPath}.body`, `Item body must be text up to ${MAX_BODY_LENGTH} characters.`);
    }
    validateVariable(item.quantityVariable, `${itemPath}.quantityVariable`);
    if (!isNonNegativeSafeInteger(item.buyPrice)) {
      addIssue(issues, "inventory.price", `${itemPath}.buyPrice`, "buyPrice must be a non-negative safe integer.");
    }
    if (item.sellPrice !== undefined && !isNonNegativeSafeInteger(item.sellPrice)) {
      addIssue(issues, "inventory.price", `${itemPath}.sellPrice`, "sellPrice must be a non-negative safe integer.");
    }
    const validMaxQuantity = item.maxQuantity === undefined ||
      Number.isSafeInteger(item.maxQuantity) && (item.maxQuantity as number) > 0;
    if (!validMaxQuantity) {
      addIssue(issues, "inventory.maxQuantity", `${itemPath}.maxQuantity`, "maxQuantity must be a positive safe integer when supplied.");
    }
    if (item.maxQuantity !== undefined && validMaxQuantity &&
        typeof item.quantityVariable === "string" && isNovelVariableName(item.quantityVariable) &&
        context.story !== undefined) {
      const definitions = context.story.variableDefinitions;
      const definition = definitions && Object.hasOwn(definitions, item.quantityVariable)
        ? definitions[item.quantityVariable]
        : undefined;
      if (definition && isNonNegativeSafeInteger(definition.defaultValue) &&
          definition.defaultValue > (item.maxQuantity as number)) {
        addIssue(issues, "inventory.maxQuantity.default", `${itemPath}.maxQuantity`,
          "An item's non-negative default quantity must not exceed maxQuantity.");
      }
    }
  }
  return issues;
}

/** Plan one all-or-nothing trade without mutating catalog or variable inputs. */
export function planNovelInventoryTrade(
  catalog: NovelInventory,
  variables: Readonly<Record<string, JsonValue>>,
  trade: Pick<NovelTradeInstruction, "item" | "action" | "quantity">,
): NovelInventoryTradePlan {
  if (!isRecord(catalog) || !isRecord(catalog.currency) || !isRecord(catalog.items) || !isRecord(variables) || !isRecord(trade)) {
    return { ok: false, reason: "invalid-catalog" };
  }
  if (typeof trade.item !== "string" || !inventoryIdPattern.test(trade.item) ||
      (trade.action !== "buy" && trade.action !== "sell" && trade.action !== "consume")) {
    return { ok: false, reason: "invalid-instruction" };
  }
  if (!Number.isSafeInteger(trade.quantity) || trade.quantity <= 0) {
    return { ok: false, reason: "invalid-quantity" };
  }
  if (typeof catalog.currency.variable !== "string" || !Object.hasOwn(catalog.items, trade.item) ||
      typeof catalog.items[trade.item] !== "object" || catalog.items[trade.item] === null) {
    return { ok: false, reason: "unknown-item" };
  }
  const item = catalog.items[trade.item];
  if (typeof item.quantityVariable !== "string" || typeof item.buyPrice !== "number") {
    return { ok: false, reason: "invalid-catalog" };
  }
  if (catalog.currency.variable === item.quantityVariable) {
    return { ok: false, reason: "invalid-catalog" };
  }
  const currency = variables[catalog.currency.variable];
  const stock = variables[item.quantityVariable];
  if (!isNonNegativeSafeInteger(currency)) return { ok: false, reason: "invalid-currency" };
  if (!isNonNegativeSafeInteger(stock)) return { ok: false, reason: "invalid-stock" };

  const updates: Record<string, number> = Object.create(null) as Record<string, number>;
  if (trade.action === "buy") {
    if (!isNonNegativeSafeInteger(item.buyPrice)) return { ok: false, reason: "invalid-catalog" };
    const cost = item.buyPrice * trade.quantity;
    if (!Number.isSafeInteger(cost)) return { ok: false, reason: "arithmetic-overflow" };
    if (currency < cost) return { ok: false, reason: "insufficient-funds" };
    const nextStock = stock + trade.quantity;
    if (!Number.isSafeInteger(nextStock)) return { ok: false, reason: "arithmetic-overflow" };
    if (item.maxQuantity !== undefined && (!Number.isSafeInteger(item.maxQuantity) || item.maxQuantity <= 0)) {
      return { ok: false, reason: "invalid-catalog" };
    }
    if (item.maxQuantity !== undefined && nextStock > item.maxQuantity) return { ok: false, reason: "quantity-limit" };
    updates[catalog.currency.variable] = currency - cost;
    updates[item.quantityVariable] = nextStock;
    return { ok: true, updates };
  }

  if (stock < trade.quantity) return { ok: false, reason: "insufficient-stock" };
  const nextStock = stock - trade.quantity;
  if (trade.action === "consume") {
    updates[item.quantityVariable] = nextStock;
    return { ok: true, updates };
  }
  if (item.sellPrice === undefined) return { ok: false, reason: "not-sellable" };
  if (!isNonNegativeSafeInteger(item.sellPrice)) return { ok: false, reason: "invalid-catalog" };
  const proceeds = item.sellPrice * trade.quantity;
  if (!Number.isSafeInteger(proceeds)) return { ok: false, reason: "arithmetic-overflow" };
  const nextCurrency = currency + proceeds;
  if (!Number.isSafeInteger(nextCurrency)) return { ok: false, reason: "arithmetic-overflow" };
  updates[catalog.currency.variable] = nextCurrency;
  updates[item.quantityVariable] = nextStock;
  return { ok: true, updates };
}
