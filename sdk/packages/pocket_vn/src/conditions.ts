import type { Condition, JsonValue, ValueExpression } from "./types.ts";
import { isNovelVariableName, novelJsonValueIssue } from "./variables.ts";

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/** Shared condition schema validation for narrative instructions and scene objects. */
export function novelConditionIssue(value: unknown, path = "condition"): string | null {
  const expressionIssue = (expression: unknown, expressionPath: string): string | null => {
    if (!isRecord(expression) || (expression.type !== "literal" && expression.type !== "variable")) {
      return `${expressionPath} is not a value expression`;
    }
    if (expression.type === "literal") return novelJsonValueIssue(expression.value, expressionPath);
    if (!isNonEmptyString(expression.name) || !isNovelVariableName(expression.name)) {
      return `${expressionPath}.name is invalid`;
    }
    return null;
  };

  const visit = (condition: unknown, conditionPath: string, depth: number): string | null => {
    if (depth > 128) return `${conditionPath} exceeds the supported condition nesting depth`;
    if (!isRecord(condition) || !isString(condition.op)) return `${conditionPath} is not a condition`;
    switch (condition.op) {
      case "truthy": case "falsy":
        return expressionIssue(condition.value, `${conditionPath}.value`);
      case "eq": case "neq": case "gt": case "gte": case "lt": case "lte":
        return expressionIssue(condition.left, `${conditionPath}.left`) ?? expressionIssue(condition.right, `${conditionPath}.right`);
      case "and": case "or":
        if (!Array.isArray(condition.conditions)) return `${conditionPath}.conditions must be an array`;
        for (let index = 0; index < condition.conditions.length; index++) {
          if (!Object.hasOwn(condition.conditions, index)) return `${conditionPath}.conditions[${index}] is missing`;
          const issue = visit(condition.conditions[index], `${conditionPath}.conditions[${index}]`, depth + 1);
          if (issue !== null) return issue;
        }
        return null;
      case "not":
        return visit(condition.condition, `${conditionPath}.condition`, depth + 1);
      default:
        return `${conditionPath}.op is unsupported`;
    }
  };

  return visit(value, path, 0);
}

function evaluateValue(expression: ValueExpression, variables: Readonly<Record<string, JsonValue>>): JsonValue | undefined {
  return expression.type === "literal" ? expression.value : variables[expression.name];
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => jsonEqual(entry, b[index]));
  const aRecord = a as Readonly<Record<string, JsonValue>>;
  const bRecord = b as Readonly<Record<string, JsonValue>>;
  const ak = Object.keys(aRecord); const bk = Object.keys(bRecord);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(bRecord, key) && jsonEqual(aRecord[key], bRecord[key]));
}

function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  return true;
}

function compare(a: JsonValue | undefined, b: JsonValue | undefined, op: "gt" | "gte" | "lt" | "lte"): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (op === "gt") return a > b;
    if (op === "gte") return a >= b;
    if (op === "lt") return a < b;
    return a <= b;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (op === "gt") return a > b;
    if (op === "gte") return a >= b;
    if (op === "lt") return a < b;
    return a <= b;
  }
  return false;
}

/** Evaluate using the same semantics as branch and choice conditions. */
export function evaluateNovelCondition(condition: Condition, variables: Readonly<Record<string, JsonValue>>): boolean {
  switch (condition.op) {
    case "truthy": return truthy(evaluateValue(condition.value, variables));
    case "falsy": return !truthy(evaluateValue(condition.value, variables));
    case "eq": return jsonEqual(evaluateValue(condition.left, variables), evaluateValue(condition.right, variables));
    case "neq": return !jsonEqual(evaluateValue(condition.left, variables), evaluateValue(condition.right, variables));
    case "gt": case "gte": case "lt": case "lte": return compare(evaluateValue(condition.left, variables), evaluateValue(condition.right, variables), condition.op);
    case "and": return condition.conditions.every(entry => evaluateNovelCondition(entry, variables));
    case "or": return condition.conditions.some(entry => evaluateNovelCondition(entry, variables));
    case "not": return !evaluateNovelCondition(condition.condition, variables);
  }
}
