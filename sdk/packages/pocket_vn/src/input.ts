import type {
  NovelInputInstruction,
  NovelInputValidationError,
} from "./types.ts";

/** Maximum raw text draft size, counted in Unicode code points. */
export const NOVEL_INPUT_TEXT_RAW_LIMIT = 4096;
/** Maximum raw numeric draft size, counted in Unicode code points. */
export const NOVEL_INPUT_NUMBER_RAW_LIMIT = 128;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Decimal syntax with an optional sign and optional base-10 exponent. It accepts
// 12, -12.5, .5, 12., and 1e+3; Number.isFinite below rejects overflow.
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: PlainRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Return the first issue in an input instruction's own fields. Story label
 * references such as `cancelTarget` are checked by the story-level validator.
 * Unknown extension fields remain lossless; fields belonging to another input
 * variant are explicitly rejected.
 */
export function novelInputInstructionIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "input") return "type must be 'input'";
  if (!isNonEmptyString(value.id)) return "id must be a non-empty string";
  if (!isNonEmptyString(value.variable) || !VARIABLE_NAME.test(value.variable)) return "variable must use the story variable name format";
  if (value.prompt !== undefined && typeof value.prompt !== "string") return "prompt must be a string";
  if (value.cancelTarget !== undefined && !isNonEmptyString(value.cancelTarget)) return "cancelTarget must be a non-empty label";
  if (value.inputType !== "text" && value.inputType !== "number" && value.inputType !== "boolean") {
    return "inputType must be 'text', 'number', or 'boolean'";
  }

  const branchFields: Record<NovelInputInstruction["inputType"], readonly string[]> = {
    text: ["min", "max", "integer"],
    number: ["minLength", "maxLength"],
    boolean: ["placeholder", "minLength", "maxLength", "min", "max", "integer"],
  };
  for (const field of branchFields[value.inputType]) {
    if (hasOwn(value, field)) return `${field} is not supported for ${value.inputType} inputs`;
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== "string") return "placeholder must be a string";

  if (value.inputType === "text") {
    if (value.defaultValue !== undefined && typeof value.defaultValue !== "string") return "defaultValue must be a string for text inputs";
    for (const field of ["minLength", "maxLength"] as const) {
      const bound = value[field];
      if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0 || (bound as number) > NOVEL_INPUT_TEXT_RAW_LIMIT)) {
        return `${field} must be a safe integer from 0 to ${NOVEL_INPUT_TEXT_RAW_LIMIT}`;
      }
    }
    const minLength = value.minLength;
    const maxLength = value.maxLength;
    if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
      return "minLength must not exceed maxLength";
    }
    if (typeof value.defaultValue === "string" && codePointLength(value.defaultValue) > NOVEL_INPUT_TEXT_RAW_LIMIT) {
      return `defaultValue must not exceed ${NOVEL_INPUT_TEXT_RAW_LIMIT} Unicode code points`;
    }
  } else if (value.inputType === "number") {
    if (value.defaultValue !== undefined && (typeof value.defaultValue !== "number" || !Number.isFinite(value.defaultValue))) {
      return "defaultValue must be a finite number for number inputs";
    }
    for (const field of ["min", "max"] as const) {
      const bound = value[field];
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) return `${field} must be a finite number`;
    }
    if (value.integer !== undefined && typeof value.integer !== "boolean") return "integer must be a boolean";
    const minimum = value.min;
    const maximum = value.max;
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) return "min must not exceed max";
  } else {
    if (value.defaultValue !== undefined && typeof value.defaultValue !== "boolean") return "defaultValue must be a boolean for boolean inputs";
  }

  if (value.defaultValue !== undefined) {
    const instruction = value as unknown as NovelInputInstruction;
    const defaultDraft = instruction.inputType === "boolean"
      ? instruction.defaultValue ?? false
      : instruction.inputType === "number"
        ? instruction.defaultValue === undefined ? "" : String(instruction.defaultValue)
        : instruction.defaultValue ?? "";
    const validation = validateNovelInputDraft(instruction, defaultDraft);
    if (!validation.valid) return `defaultValue is invalid: ${validation.error.code}${validation.error.limit === undefined ? "" : ` (${validation.error.limit})`}`;
  }
  return null;
}

export type NovelInputDraftValidation =
  | { readonly valid: true; readonly value: string | number | boolean; readonly error: null }
  | { readonly valid: false; readonly error: NovelInputValidationError };

function invalid(code: NovelInputValidationError["code"], limit?: number): NovelInputDraftValidation {
  return { valid: false, error: limit === undefined ? { code } : { code, limit } };
}

/** Validate an active raw draft using the same rules for submit and save checking. */
export function validateNovelInputDraft(
  instruction: NovelInputInstruction,
  draft: string | boolean,
): NovelInputDraftValidation {
  if (instruction.inputType === "boolean") {
    if (typeof draft !== "boolean") throw new RangeError("Boolean input draft must be a boolean");
    return { valid: true, value: draft, error: null };
  }
  if (typeof draft !== "string") throw new RangeError(`${instruction.inputType} input draft must be a string`);

  if (instruction.inputType === "text") {
    const length = codePointLength(draft);
    if (instruction.minLength !== undefined && length < instruction.minLength) return invalid("tooShort", instruction.minLength);
    if (instruction.maxLength !== undefined && length > instruction.maxLength) return invalid("tooLong", instruction.maxLength);
    return { valid: true, value: draft, error: null };
  }

  if (draft === "") return invalid("required");
  if (!DECIMAL_NUMBER.test(draft)) return invalid("number");
  const value = Number(draft);
  if (!Number.isFinite(value)) return invalid("number");
  if (instruction.integer && !Number.isInteger(value)) return invalid("integer");
  if (instruction.min !== undefined && value < instruction.min) return invalid("min", instruction.min);
  if (instruction.max !== undefined && value > instruction.max) return invalid("max", instruction.max);
  return { valid: true, value, error: null };
}

/** Build a typed initial draft from static instruction data only. */
export function novelInputDefaultDraft(instruction: NovelInputInstruction): string | boolean {
  if (instruction.inputType === "boolean") return instruction.defaultValue ?? false;
  if (instruction.inputType === "number") return instruction.defaultValue === undefined ? "" : String(instruction.defaultValue);
  return instruction.defaultValue ?? "";
}
