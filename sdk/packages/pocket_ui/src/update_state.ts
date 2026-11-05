import type { JsonValue } from "./host.ts";
import {
  clonePocketValue,
  samePocketValue,
  POCKET_VALUE_SNAPSHOT_MAX_BYTES,
  POCKET_VALUE_SNAPSHOT_MAX_DEPTH,
  POCKET_VALUE_SNAPSHOT_MAX_NODES,
} from "./value_snapshot.ts";

/** The direct-object record protocol used for one update handoff. */
export const POCKET_UPDATE_STATE_PROTOCOL = "pocket.update-state.v1" as const;
export const POCKET_UPDATE_STATE_MAX_BYTES = POCKET_VALUE_SNAPSHOT_MAX_BYTES;
export const POCKET_UPDATE_STATE_MAX_DEPTH = POCKET_VALUE_SNAPSHOT_MAX_DEPTH;
export const POCKET_UPDATE_STATE_MAX_NODES = POCKET_VALUE_SNAPSHOT_MAX_NODES;

export interface PocketUpdateStateTarget {
  readonly version: string;
  readonly build: number;
}

export interface PocketUpdateStateCurrent {
  readonly version: string | null;
  readonly build: number | null;
}

/** Storage mirrors PocketPlatformClient.storage and carries direct values. */
export interface PocketUpdateStateStorage {
  get(key: string, namespace?: string): unknown | PromiseLike<unknown>;
  set(key: string, value: JsonValue, namespace?: string): unknown | PromiseLike<unknown>;
  remove(key: string, namespace?: string): unknown | PromiseLike<unknown>;
}

export interface PocketUpdateStateOptions {
  readonly key: string;
  readonly schema: string;
  readonly storage: PocketUpdateStateStorage;
  /** Return the current business state synchronously. */
  readonly capture: () => JsonValue;
  /** Validate and commit a restored state synchronously. */
  readonly restore: (value: JsonValue) => boolean;
  /** Optional platform-storage namespace. */
  readonly namespace?: string;
}

export interface PocketUpdateState {
  /** Restore a matching handoff unless the business state changed during I/O. */
  restore(current: PocketUpdateStateCurrent): Promise<boolean>;
  /** Capture a state for the target, optionally retaining its source version. */
  capture(target: PocketUpdateStateTarget, source?: PocketUpdateStateTarget | null): Promise<void>;
  /** Consume a matching record only after the new guest is healthy. */
  commit(current: PocketUpdateStateCurrent): Promise<void>;
  /** Remove only a still-matching record. */
  discard(target: PocketUpdateStateTarget): Promise<void>;
}

interface StoredUpdateState {
  readonly protocol: typeof POCKET_UPDATE_STATE_PROTOCOL;
  readonly schema: string;
  readonly targetVersion: string;
  readonly targetBuild: number;
  readonly sourceVersion?: string;
  readonly sourceBuild?: number;
  readonly value: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
  } catch {
    return false;
  }
}

function readRecordField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
}

function validTarget(target: PocketUpdateStateTarget): void {
  if (!target || typeof target.version !== "string" || target.version.length === 0) {
    throw new TypeError("Pocket update state target version must be a non-empty string");
  }
  if (!Number.isSafeInteger(target.build) || target.build < 0) {
    throw new TypeError("Pocket update state target build must be a non-negative integer");
  }
}

function matchesTarget(record: StoredUpdateState, target: PocketUpdateStateTarget): boolean {
  return record.targetVersion === target.version && record.targetBuild === target.build;
}

function matchesCurrent(record: StoredUpdateState, current: PocketUpdateStateCurrent): boolean {
  return typeof current.version === "string" && Number.isSafeInteger(current.build) &&
    ((current.version === record.targetVersion && current.build === record.targetBuild) ||
      (current.version === record.sourceVersion && current.build === record.sourceBuild));
}

function sameStoredRecord(left: StoredUpdateState, right: StoredUpdateState): boolean {
  return left.protocol === right.protocol && left.schema === right.schema &&
    left.targetVersion === right.targetVersion && left.targetBuild === right.targetBuild &&
    left.sourceVersion === right.sourceVersion && left.sourceBuild === right.sourceBuild &&
    samePocketValue(left.value, right.value);
}

function readStoredState(raw: unknown, schema: string): StoredUpdateState | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw).sort();
  const basicKeys = "protocol\0schema\0targetBuild\0targetVersion\0value";
  const sourceKeys = "protocol\0schema\0sourceBuild\0sourceVersion\0targetBuild\0targetVersion\0value";
  if ((keys.length !== 5 && keys.length !== 7) ||
      (keys.length === 5 ? keys.join("\0") !== basicKeys : keys.join("\0") !== sourceKeys)) return undefined;
  const protocol = readRecordField(raw, "protocol");
  const storedSchema = readRecordField(raw, "schema");
  const targetVersion = readRecordField(raw, "targetVersion");
  const targetBuild = readRecordField(raw, "targetBuild");
  const sourceVersion = readRecordField(raw, "sourceVersion");
  const sourceBuild = readRecordField(raw, "sourceBuild");
  if (protocol !== POCKET_UPDATE_STATE_PROTOCOL || storedSchema !== schema ||
      typeof targetVersion !== "string" || targetVersion.length === 0 ||
      typeof targetBuild !== "number" || !Number.isSafeInteger(targetBuild) || targetBuild < 0 ||
      (keys.length === 7 && (typeof sourceVersion !== "string" || sourceVersion.length === 0 ||
        typeof sourceBuild !== "number" || !Number.isSafeInteger(sourceBuild) || sourceBuild < 0))) return undefined;
  try {
    const copied = clonePocketValue(raw);
    if (!isRecord(copied)) return undefined;
    const result: StoredUpdateState = {
      protocol: POCKET_UPDATE_STATE_PROTOCOL,
      schema,
      targetVersion,
      targetBuild: targetBuild as number,
      value: copied.value as JsonValue,
    };
    if (keys.length === 7) {
      Object.assign(result, { sourceVersion, sourceBuild: sourceBuild as number });
    }
    return result;
  } catch {
    return undefined;
  }
}

export class PocketUpdateStateError extends Error {
  readonly code: "capture-conflict";

  constructor(message = "Pocket update state changed while it was being stored") {
    super(message);
    this.name = "PocketUpdateStateError";
    this.code = "capture-conflict";
  }
}

/**
 * Build a bounded, direct-object handoff for update transitions. Storage is
 * intentionally one-shot: no polling or background frame work is installed.
 * Without a storage CAS, commit/discard recheck protocol/schema/target and the
 * snapshot immediately before removal; an external writer racing that final
 * remove remains outside the guarantees of the platform storage API.
 */
export function createPocketUpdateState(options: PocketUpdateStateOptions): PocketUpdateState {
  if (!options || typeof options.key !== "string" || options.key.length === 0) {
    throw new TypeError("Pocket update state key must be a non-empty string");
  }
  if (typeof options.schema !== "string" || options.schema.length === 0) {
    throw new TypeError("Pocket update state schema must be a non-empty string");
  }
  if (!options.storage || typeof options.storage.get !== "function" ||
      typeof options.storage.set !== "function" || typeof options.storage.remove !== "function") {
    throw new TypeError("Pocket update state storage must provide get, set and remove");
  }
  if (typeof options.capture !== "function" || typeof options.restore !== "function") {
    throw new TypeError("Pocket update state requires capture and restore callbacks");
  }

  // Capture once at construction so an async updates.status request cannot
  // silently widen the restore window. The caller should construct this
  // helper at the start of the update transition.
  const restoreBaseline = clonePocketValue(options.capture());
  let tail: Promise<void> = Promise.resolve();
  let lastCapturedRecord: StoredUpdateState | undefined;
  let observedRecord: StoredUpdateState | undefined;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = async (): Promise<unknown> => await options.storage.get(options.key, options.namespace);

  return {
    async restore(current): Promise<boolean> {
      return enqueue(async () => {
        const stored = readStoredState(await read(), options.schema);
        if (!stored || !matchesCurrent(stored, current)) return false;
        // A matching record is considered observed even if local input wins
        // the baseline race or the business validator declines the value.
        // commit() can then acknowledge that record without replaying it on
        // the next launch.
        observedRecord = stored;
        const latest = clonePocketValue(options.capture());
        if (!samePocketValue(restoreBaseline, latest)) return false;
        return options.restore(clonePocketValue(stored.value)) === true;
      });
    },
    async capture(target, source): Promise<void> {
      validTarget(target);
      if (source !== undefined && source !== null) validTarget(source);
      const value = clonePocketValue(options.capture());
      const record: StoredUpdateState = {
        protocol: POCKET_UPDATE_STATE_PROTOCOL,
        schema: options.schema,
        targetVersion: target.version,
        targetBuild: target.build,
        value,
      };
      if (source !== undefined && source !== null) {
        Object.assign(record, { sourceVersion: source.version, sourceBuild: source.build });
      }
      // Measure the complete direct-value envelope, not only the business
      // value. The copied result is intentionally discarded.
      clonePocketValue(record as unknown as JsonValue);
      await enqueue(async () => {
        await options.storage.set(options.key, record as unknown as JsonValue, options.namespace);
        const afterWrite = clonePocketValue(options.capture());
        if (!samePocketValue(value, afterWrite)) {
          const stored = readStoredState(await read(), options.schema);
          if (stored && sameStoredRecord(stored, record)) {
            await options.storage.remove(options.key, options.namespace);
          }
          throw new PocketUpdateStateError();
        }
        lastCapturedRecord = record;
      });
    },
    async commit(current): Promise<void> {
      if (!observedRecord) return;
      await enqueue(async () => {
        const stored = readStoredState(await read(), options.schema);
        if (stored && observedRecord && matchesCurrent(stored, current) && sameStoredRecord(stored, observedRecord)) {
          await options.storage.remove(options.key, options.namespace);
          observedRecord = undefined;
          lastCapturedRecord = undefined;
        }
      });
    },
    async discard(target): Promise<void> {
      validTarget(target);
      if (!lastCapturedRecord) return;
      await enqueue(async () => {
        const stored = readStoredState(await read(), options.schema);
        if (stored && matchesTarget(stored, target) && lastCapturedRecord &&
            sameStoredRecord(stored, lastCapturedRecord)) {
          await options.storage.remove(options.key, options.namespace);
          observedRecord = undefined;
          lastCapturedRecord = undefined;
        }
      });
    },
  };
}
