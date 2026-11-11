/**
 * Safe error and JSON data normalization for @pocket/diagnostics.
 * Handles circular references, deep nesting, oversized strings/payloads,
 * Error causes, AggregateError.errors, non-plain objects, BigInt, Symbols,
 * and throwing property getters without ever throwing.
 */

import {
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_CAUSE_DEPTH,
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_OBJECT_KEYS,
  DEFAULT_MAX_STACK_LENGTH,
  DEFAULT_MAX_STRING_LENGTH,
  type DiagnosticContext,
  type DiagnosticDataValue,
  type DiagnosticNormalizationLimits,
  type NormalizedDiagnosticError,
} from "./types.ts";

interface ResolvedLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxStringLength: number;
  readonly maxStackLength: number;
  readonly maxCauseDepth: number;
  readonly maxDataBytes: number;
}

interface WalkState {
  nodes: number;
  bytes: number;
  truncated: boolean;
  readonly ancestors: Set<object>;
  readonly limits: ResolvedLimits;
}

function clampPositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function resolveNormalizationLimits(limits?: DiagnosticNormalizationLimits): ResolvedLimits {
  return {
    maxDepth: clampPositiveInt(limits?.maxDepth, DEFAULT_MAX_DEPTH, 1, 32),
    maxNodes: clampPositiveInt(limits?.maxNodes, DEFAULT_MAX_NODES, 8, 8192),
    maxArrayLength: clampPositiveInt(limits?.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH, 1, 1024),
    maxObjectKeys: clampPositiveInt(limits?.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS, 1, 1024),
    maxStringLength: clampPositiveInt(limits?.maxStringLength, DEFAULT_MAX_STRING_LENGTH, 32, 256 * 1024),
    maxStackLength: clampPositiveInt(limits?.maxStackLength, DEFAULT_MAX_STACK_LENGTH, 128, 512 * 1024),
    maxCauseDepth: clampPositiveInt(limits?.maxCauseDepth, DEFAULT_MAX_CAUSE_DEPTH, 1, 16),
    maxDataBytes: clampPositiveInt(limits?.maxDataBytes, DEFAULT_MAX_DATA_BYTES, 256, 512 * 1024),
  };
}

export function estimateUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function truncateString(value: string, maxLength: number, state?: { truncated: boolean }): string {
  if (value.length <= maxLength) return value;
  if (state) state.truncated = true;
  const suffix = `... [truncated ${value.length - maxLength} chars]`;
  if (maxLength <= suffix.length) return value.slice(0, maxLength);
  return value.slice(0, maxLength - suffix.length) + suffix;
}

function safeReadProperty(target: object, key: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: (target as Record<string, unknown>)[key] };
  } catch (error) {
    let reason = "unreadable property";
    try {
      reason = error instanceof Error ? error.message : String(error);
    } catch {
      // ignore
    }
    return { ok: false, error: `[Thrown: ${ truncateString(reason, 120) }]` };
  }
}

function isErrorLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Error) return true;
  const prototype = Object.getPrototypeOf(value);
  if (prototype && prototype !== Object.prototype) {
    const ctorName = typeof prototype.constructor?.name === "string" ? prototype.constructor.name : "";
    if (ctorName.endsWith("Error") || ctorName === "DOMException") return true;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.message === "string" &&
    (typeof record.name === "string" || typeof record.stack === "string")
  );
}

function walkDataValue(value: unknown, depth: number, state: WalkState): DiagnosticDataValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") {
    state.bytes += 5;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      state.bytes += 10;
      return String(value);
    }
    state.bytes += 12;
    return value;
  }
  if (typeof value === "string") {
    const str = truncateString(value, state.limits.maxStringLength, state);
    const len = estimateUtf8Bytes(str) + 2;
    if (state.bytes + len > state.limits.maxDataBytes) {
      state.truncated = true;
      const remaining = Math.max(0, state.limits.maxDataBytes - state.bytes);
      if (remaining < 16) return "[MaxBytes]";
      const clipped = truncateString(str, remaining, state);
      state.bytes += estimateUtf8Bytes(clipped) + 2;
      return clipped;
    }
    state.bytes += len;
    return str;
  }
  if (typeof value === "bigint") {
    const str = `${value.toString()}n`;
    state.bytes += str.length + 2;
    return str;
  }
  if (typeof value === "symbol") {
    const str = String(value);
    state.bytes += str.length + 2;
    return str;
  }
  if (typeof value === "function") {
    const fnName = typeof value.name === "string" && value.name.length > 0 ? value.name : "anonymous";
    const str = `[Function: ${fnName}]`;
    state.bytes += str.length + 2;
    return str;
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const obj = value as object;
  if (state.ancestors.has(obj)) {
    state.bytes += 12;
    return "[Circular]";
  }
  if (state.nodes >= state.limits.maxNodes) {
    state.truncated = true;
    return "[MaxNodes]";
  }
  if (state.bytes >= state.limits.maxDataBytes) {
    state.truncated = true;
    return "[MaxBytes]";
  }
  if (depth > state.limits.maxDepth) {
    state.truncated = true;
    return "[MaxDepth]";
  }

  state.nodes += 1;

  if (obj instanceof Date) {
    const iso = Number.isFinite(obj.getTime()) ? obj.toISOString() : "Invalid Date";
    state.bytes += iso.length + 2;
    return iso;
  }
  if (obj instanceof RegExp) {
    const str = String(obj);
    state.bytes += str.length + 2;
    return str;
  }
  if (ArrayBuffer.isView(obj)) {
    const ctor = obj.constructor?.name ?? "TypedArray";
    const str = `[${ctor}(${obj.byteLength} bytes)]`;
    state.bytes += str.length + 2;
    return str;
  }
  if (obj instanceof ArrayBuffer) {
    const str = `[ArrayBuffer(${obj.byteLength} bytes)]`;
    state.bytes += str.length + 2;
    return str;
  }

  state.ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: DiagnosticDataValue[] = [];
      const limit = Math.min(obj.length, state.limits.maxArrayLength);
      state.bytes += 2;
      for (let i = 0; i < limit; i += 1) {
        if (state.bytes >= state.limits.maxDataBytes || state.nodes >= state.limits.maxNodes) {
          state.truncated = true;
          out.push("[Truncated]");
          break;
        }
        const read = safeReadProperty(obj, String(i));
        if (!read.ok) {
          out.push(read.error);
          continue;
        }
        const item = walkDataValue(read.value, depth + 1, state);
        out.push(item === undefined ? null : item);
      }
      if (obj.length > limit) {
        state.truncated = true;
        out.push(`... [${obj.length - limit} more items]`);
      }
      return out;
    }

    if (obj instanceof Map) {
      const entries: Record<string, DiagnosticDataValue> = {};
      let count = 0;
      for (const [k, v] of obj.entries()) {
        if (count >= state.limits.maxObjectKeys || state.bytes >= state.limits.maxDataBytes) {
          state.truncated = true;
          entries.__truncated__ = true;
          break;
        }
        const keyStr = truncateString(String(k), 256, state);
        const normalizedVal = walkDataValue(v, depth + 1, state);
        if (normalizedVal !== undefined) {
          entries[keyStr] = normalizedVal;
          count += 1;
        }
      }
      return entries;
    }

    if (obj instanceof Set) {
      const items: DiagnosticDataValue[] = [];
      let count = 0;
      for (const v of obj.values()) {
        if (count >= state.limits.maxArrayLength || state.bytes >= state.limits.maxDataBytes) {
          state.truncated = true;
          items.push("[Truncated]");
          break;
        }
        const normalizedVal = walkDataValue(v, depth + 1, state);
        items.push(normalizedVal === undefined ? null : normalizedVal);
        count += 1;
      }
      return items;
    }

    if (isErrorLike(obj)) {
      const normErr = normalizeErrorInternal(obj, 0, state.ancestors, state.limits);
      return normErr as unknown as DiagnosticDataValue;
    }

    let keys: string[] = [];
    try {
      keys = Object.keys(obj);
    } catch {
      return "[UnreadableObject]";
    }

    const out: Record<string, DiagnosticDataValue> = {};
    const limit = Math.min(keys.length, state.limits.maxObjectKeys);
    state.bytes += 2;
    for (let i = 0; i < limit; i += 1) {
      if (state.bytes >= state.limits.maxDataBytes || state.nodes >= state.limits.maxNodes) {
        state.truncated = true;
        out.__truncated__ = true;
        break;
      }
      const rawKey = keys[i]!;
      if (rawKey === "__proto__" || rawKey === "constructor" || rawKey === "prototype") continue;
      const key = truncateString(rawKey, 256, state);
      const read = safeReadProperty(obj, rawKey);
      if (!read.ok) {
        out[key] = read.error;
        continue;
      }
      if (read.value === undefined) continue;
      state.bytes += estimateUtf8Bytes(key) + 4;
      const child = walkDataValue(read.value, depth + 1, state);
      if (child !== undefined) {
        out[key] = child;
      }
    }
    if (keys.length > limit) {
      state.truncated = true;
      out.__truncatedKeys__ = keys.length - limit;
    }
    return out;
  } finally {
    state.ancestors.delete(obj);
  }
}

export function normalizeDiagnosticData(
  value: unknown,
  limits?: DiagnosticNormalizationLimits,
): DiagnosticDataValue | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveNormalizationLimits(limits);
  const state: WalkState = {
    nodes: 0,
    bytes: 0,
    truncated: false,
    ancestors: new Set<object>(),
    limits: resolved,
  };
  return walkDataValue(value, 0, state);
}

function normalizeErrorInternal(
  input: unknown,
  causeDepth: number,
  seenCauses: Set<object>,
  limits: ResolvedLimits,
): NormalizedDiagnosticError {
  const truncState = { truncated: false };

  if (input === null || input === undefined) {
    return {
      name: "Error",
      message: input === null ? "null" : "undefined",
    };
  }

  if (typeof input === "string") {
    return {
      name: "Error",
      message: truncateString(input, limits.maxStringLength, truncState),
      ...(truncState.truncated ? { truncated: true } : {}),
    };
  }

  if (typeof input !== "object") {
    return {
      name: typeof input,
      message: truncateString(String(input), limits.maxStringLength, truncState),
      ...(truncState.truncated ? { truncated: true } : {}),
    };
  }

  const obj = input as object;
  if (seenCauses.has(obj)) {
    return {
      name: "CircularError",
      message: "[Circular Error Cause]",
      truncated: true,
    };
  }

  seenCauses.add(obj);
  try {
    const rawName = safeReadProperty(obj, "name");
    const ctorName =
      typeof (obj as { constructor?: { name?: unknown } }).constructor?.name === "string"
        ? ((obj as { constructor: { name: string } }).constructor.name)
        : "Error";
    const nameStr =
      rawName.ok && typeof rawName.value === "string" && rawName.value.trim().length > 0
        ? truncateString(rawName.value.trim(), 256, truncState)
        : truncateString(ctorName || "Error", 256, truncState);

    const rawMessage = safeReadProperty(obj, "message");
    let messageStr = "";
    if (rawMessage.ok && typeof rawMessage.value === "string") {
      messageStr = truncateString(rawMessage.value, limits.maxStringLength, truncState);
    } else if (!rawMessage.ok) {
      messageStr = rawMessage.error;
    } else {
      try {
        const serialized = JSON.stringify(obj);
        messageStr =
          typeof serialized === "string" && serialized !== "{}"
            ? truncateString(serialized, limits.maxStringLength, truncState)
            : truncateString(String(obj), limits.maxStringLength, truncState);
      } catch {
        messageStr = truncateString(Object.prototype.toString.call(obj), limits.maxStringLength, truncState);
      }
    }

    const rawStack = safeReadProperty(obj, "stack");
    const stackStr =
      rawStack.ok && typeof rawStack.value === "string" && rawStack.value.length > 0
        ? truncateString(rawStack.value, limits.maxStackLength, truncState)
        : undefined;

    const rawCode = safeReadProperty(obj, "code");
    const codeVal =
      rawCode.ok && (typeof rawCode.value === "string" || (typeof rawCode.value === "number" && Number.isFinite(rawCode.value)))
        ? typeof rawCode.value === "string"
          ? truncateString(rawCode.value, 256, truncState)
          : rawCode.value
        : undefined;

    let causeVal: NormalizedDiagnosticError | undefined;
    const rawCause = safeReadProperty(obj, "cause");
    if (rawCause.ok && rawCause.value !== undefined && rawCause.value !== null) {
      if (causeDepth + 1 >= limits.maxCauseDepth) {
        truncState.truncated = true;
        causeVal = {
          name: "MaxCauseDepth",
          message: "[Max cause depth reached]",
          truncated: true,
        };
      } else {
        causeVal = normalizeErrorInternal(rawCause.value, causeDepth + 1, seenCauses, limits);
        if (causeVal.truncated) truncState.truncated = true;
      }
    }

    // Collect extra enumerable properties (and AggregateError.errors if present) into details
    const extra: Record<string, unknown> = {};
    let hasExtra = false;

    const rawErrors = safeReadProperty(obj, "errors");
    if (rawErrors.ok && Array.isArray(rawErrors.value)) {
      const limit = Math.min(rawErrors.value.length, 16);
      extra.errors = rawErrors.value.slice(0, limit).map((item) =>
        normalizeErrorInternal(item, causeDepth + 1, seenCauses, limits),
      );
      if (rawErrors.value.length > limit) {
        truncState.truncated = true;
      }
      hasExtra = true;
    }

    try {
      const keys = Object.keys(obj);
      const reserved = new Set(["name", "message", "stack", "code", "cause", "errors"]);
      for (const k of keys) {
        if (reserved.has(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
        const prop = safeReadProperty(obj, k);
        if (prop.ok && prop.value !== undefined) {
          extra[k] = prop.value;
          hasExtra = true;
        } else if (!prop.ok) {
          extra[k] = prop.error;
          hasExtra = true;
        }
      }
    } catch {
      // ignore key enumeration errors
    }

    let detailsVal: DiagnosticDataValue | undefined;
    if (hasExtra) {
      const state: WalkState = {
        nodes: 0,
        bytes: 0,
        truncated: false,
        ancestors: new Set<object>(seenCauses),
        limits,
      };
      detailsVal = walkDataValue(extra, 0, state);
      if (state.truncated) truncState.truncated = true;
    }

    return {
      name: nameStr,
      message: messageStr,
      ...(stackStr !== undefined ? { stack: stackStr } : {}),
      ...(codeVal !== undefined ? { code: codeVal } : {}),
      ...(causeVal !== undefined ? { cause: causeVal } : {}),
      ...(detailsVal !== undefined ? { details: detailsVal } : {}),
      ...(truncState.truncated ? { truncated: true } : {}),
    };
  } finally {
    seenCauses.delete(obj);
  }
}

export function normalizeDiagnosticError(
  error: unknown,
  limits?: DiagnosticNormalizationLimits,
): NormalizedDiagnosticError {
  const resolved = resolveNormalizationLimits(limits);
  return normalizeErrorInternal(error, 0, new Set<object>(), resolved);
}

export function normalizeContextString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

export function normalizeRevision(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 128);
  }
  return undefined;
}

export function normalizeDiagnosticContext(context?: Partial<DiagnosticContext>): DiagnosticContext {
  if (!context || typeof context !== "object") return {};
  const source = normalizeContextString(context.source);
  const projectId = normalizeContextString(context.projectId);
  const sessionId = normalizeContextString(context.sessionId);
  const runtimeId = normalizeContextString(context.runtimeId);
  const revision = normalizeRevision(context.revision);
  return {
    ...(source !== undefined ? { source } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

export function normalizeTimestamp(value: string | number | Date | undefined, fallbackNow: () => Date | string | number): string {
  const candidate = value !== undefined ? value : fallbackNow();
  if (candidate instanceof Date) {
    return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : new Date(0).toISOString();
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const d = new Date(candidate);
    return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
  }
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return candidate.trim().slice(0, 64);
  }
  return new Date().toISOString();
}
