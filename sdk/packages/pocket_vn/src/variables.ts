import type { NovelVariableLifetime } from "./types.ts";

/** Variable names used by the story language and all variable-bearing APIs. */
export const NOVEL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isNovelVariableName(value: string): boolean {
  return NOVEL_VARIABLE_NAME.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValueIssue(value: unknown, path: string, active = new Set<object>(), depth = 0): string | null {
  if (depth > 128) return `${path} exceeds the supported JSON nesting depth.`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path} must contain only finite JSON numbers.`;
  if (typeof value !== "object") return `${path} must be a JSON value.`;
  if (!Array.isArray(value) && !isRecord(value)) return `${path} must contain only plain JSON data.`;
  if (active.has(value)) return `${path} must not contain a circular JSON value.`;
  active.add(value);
  let issue: string | null = null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && issue === null; index++) {
      if (!Object.hasOwn(value, index)) issue = `${path}[${index}] must be a JSON value.`;
      else issue = jsonValueIssue(value[index], `${path}[${index}]`, active, depth + 1);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      issue = jsonValueIssue(child, `${path}.${key}`, active, depth + 1);
      if (issue !== null) break;
    }
  }
  active.delete(value);
  return issue;
}

/** Validate one plain JSON value while retaining the caller's path in diagnostics. */
export function novelJsonValueIssue(value: unknown, path = "value"): string | null {
  return jsonValueIssue(value, path);
}

/**
 * Validate the engine-owned fields in a story's variable definitions. Unknown
 * JSON authoring metadata is deliberately left intact for other consumers.
 */
export function novelVariableDefinitionsIssue(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "variableDefinitions must be an object.";
  for (const [name, definition] of Object.entries(value)) {
    if (!isNovelVariableName(name)) return `variableDefinitions has an invalid variable name '${name}'.`;
    if (!isRecord(definition)) return `variableDefinitions.${name} must be an object.`;
    const lifetime = definition.lifetime as NovelVariableLifetime;
    if (lifetime !== "session" && lifetime !== "save" && lifetime !== "persistent") {
      return `variableDefinitions.${name}.lifetime must be 'session', 'save', or 'persistent'.`;
    }
    if (Object.hasOwn(definition, "defaultValue")) {
      const issue = jsonValueIssue(definition.defaultValue, `variableDefinitions.${name}.defaultValue`);
      if (issue !== null) return issue;
    }
  }
  return null;
}
