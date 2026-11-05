import type { JsonValue } from "./host.ts";

/** Shared bounded direct-value snapshot limits for System and update state. */
export const POCKET_VALUE_SNAPSHOT_MAX_BYTES = 64 * 1024;
export const POCKET_VALUE_SNAPSHOT_MAX_DEPTH = 16;
export const POCKET_VALUE_SNAPSHOT_MAX_NODES = 4096;

export type PocketValueSnapshotErrorCode = "invalid" | "too_large";

export class PocketValueSnapshotError extends TypeError {
  readonly code: PocketValueSnapshotErrorCode;

  constructor(code: PocketValueSnapshotErrorCode, message: string) {
    super(message);
    this.name = "PocketValueSnapshotError";
    this.code = code;
  }
}

export interface PocketValueSnapshotOptions {
  /** Preserve System's undefined handling: omit object fields, use null in arrays. */
  readonly jsonSemantics?: boolean;
}

interface SnapshotBudget {
  bytes: number;
  nodes: number;
  readonly ancestors: Set<object>;
}

function failSnapshot(code: PocketValueSnapshotErrorCode, message: string): never {
  throw new PocketValueSnapshotError(code, `Pocket value snapshot ${message}`);
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // Count the direct-value record conservatively as JSON text would encode
    // it, without invoking a serializer. Unpaired UTF-16 surrogates are
    // rejected by neither JS nor the old JSON path, so reserve six escaped
    // bytes for them.
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) bytes += 6;
    else if (code === 0x22 || code === 0x5c) bytes += 2;
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > POCKET_VALUE_SNAPSHOT_MAX_BYTES) failSnapshot("too_large", "exceeds the 64 KiB limit");
  }
  return bytes;
}

function addBytes(budget: SnapshotBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > POCKET_VALUE_SNAPSHOT_MAX_BYTES) {
    failSnapshot("too_large", "exceeds the 64 KiB limit");
  }
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    failSnapshot("invalid", "contains an accessor or non-enumerable field");
  }
  return descriptor.value;
}

function assertPlainObject(value: object): void {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    failSnapshot("invalid", "contains an unreadable object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    failSnapshot("invalid", "contains a non-plain object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    failSnapshot("invalid", "contains symbol properties");
  }
}

const OMIT_UNDEFINED = Symbol("pocket.snapshot.omit-undefined");
type CopiedValue = JsonValue | typeof OMIT_UNDEFINED;

function copyValue(
  value: unknown,
  depth: number,
  budget: SnapshotBudget,
  jsonSemantics: boolean,
  omitUndefined: boolean,
): CopiedValue {
  budget.nodes += 1;
  if (budget.nodes > POCKET_VALUE_SNAPSHOT_MAX_NODES) {
    failSnapshot("too_large", "contains too many nodes");
  }
  if (depth > POCKET_VALUE_SNAPSHOT_MAX_DEPTH) {
    failSnapshot("too_large", "exceeds the depth limit");
  }
  if (value === undefined) {
    if (!jsonSemantics) failSnapshot("invalid", "contains an unsupported value");
    if (omitUndefined) return OMIT_UNDEFINED;
    addBytes(budget, 4);
    return null;
  }
  if (value === null) {
    addBytes(budget, 4);
    return null;
  }
  switch (typeof value) {
    case "string":
      addBytes(budget, 2 + utf8Bytes(value));
      return value;
    case "boolean":
      addBytes(budget, value ? 4 : 5);
      return value;
    case "number":
      if (!Number.isFinite(value)) failSnapshot("invalid", "contains a non-finite number");
      addBytes(budget, 1 + String(value).length);
      return value;
    case "object":
      break;
    default:
      failSnapshot("invalid", "contains an unsupported value");
  }

  const object = value as object;
  if (budget.ancestors.has(object)) failSnapshot("invalid", "contains a cycle");
  budget.ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) failSnapshot("invalid", "contains an invalid array");
      const keys = Object.keys(value);
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== length + 1 || !names.includes("length") ||
          keys.length !== length || keys.some((key, index) => key !== String(index))) {
        failSnapshot("invalid", "contains a sparse or extended array");
      }
      addBytes(budget, 2);
      const output: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        addBytes(budget, 1);
        const child = copyValue(ownDataValue(value, String(index)), depth + 1, budget, jsonSemantics, false);
        output.push(child === OMIT_UNDEFINED ? null : child);
      }
      return output;
    }

    assertPlainObject(object);
    const keys = Object.keys(value as Record<string, unknown>);
    if (Object.getOwnPropertyNames(object).length !== keys.length) {
      failSnapshot("invalid", "contains non-enumerable fields");
    }
    addBytes(budget, 2);
    const output: Record<string, JsonValue> = {};
    for (const key of keys) {
      // Four bytes cover comma, quotes and colon in the conservative envelope
      // estimate; the first-entry comma is intentionally over-counted.
      const child = copyValue(ownDataValue(object, key), depth + 1, budget, jsonSemantics, true);
      if (child === OMIT_UNDEFINED) continue;
      addBytes(budget, 4 + utf8Bytes(key));
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    return output;
  } finally {
    budget.ancestors.delete(object);
  }
}

/** Clone and validate one bounded plain-data value without a JSON round trip. */
export function clonePocketValue(value: unknown, options: PocketValueSnapshotOptions = {}): JsonValue {
  const copied = copyValue(value, 0, { bytes: 0, nodes: 0, ancestors: new Set<object>() }, options.jsonSemantics === true, false);
  return copied === OMIT_UNDEFINED ? null : copied;
}

/** Deep equality for already validated bounded values. */
export function samePocketValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!samePocketValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  const leftRecord = left as { [key: string]: JsonValue };
  const rightRecord = right as { [key: string]: JsonValue };
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !samePocketValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
