import type { JsonValue, NovelSlotThumbnail } from "./types.ts";

/** A single-key mutation accepted by the platform storage batch boundary. */
export type NovelSlotStorageOperation =
  | { readonly type: "set"; readonly key: string; readonly value: JsonValue }
  | { readonly type: "remove"; readonly key: string };

/** Raw JSON storage used for novel saves. Values stay opaque to slot management. */
export interface NovelSlotRawStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: JsonValue): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  keys(): Promise<unknown>;
  /** Apply all mutations atomically within this app storage scope. */
  batch?(operations: readonly NovelSlotStorageOperation[]): Promise<unknown>;
}

export interface NovelSlotOperationOptions {
  /** Permit copy/move to replace an occupied destination. Defaults to false. */
  readonly overwrite?: boolean;
}

/** Options for an ordinary save write. Thumbnail capture is deliberately opt-in. */
export interface NovelSlotWriteOptions {
  readonly captureThumbnail?: boolean;
}

/** Native IO hooks for immutable slot-preview PNGs. */
export interface NovelSlotThumbnailOperations {
  capture(): Promise<NovelSlotThumbnail | null>;
  list(): Promise<readonly string[]>;
  remove(id: string): Promise<void>;
  /** Reports best-effort cleanup failures after a save has already committed. */
  onCleanupError?(error: unknown, id?: string): void;
}

export type NovelSlotErrorCode =
  | "invalid_prefix"
  | "invalid_slot"
  | "same_slot"
  | "missing_source"
  | "missing_slot"
  | "slot_exists"
  | "atomic_batch_unavailable";

/** An invalid or unavailable slot-management operation. */
export class NovelSlotError extends Error {
  readonly code: NovelSlotErrorCode;

  constructor(code: NovelSlotErrorCode, message: string) {
    super(message);
    this.name = "NovelSlotError";
    this.code = code;
  }
}

export interface NovelSlotManager {
  /** Read the stored value without interpreting or transforming the save record. */
  read(slot: string): Promise<unknown>;
  /** Write or replace one slot using the host's ordinary atomic single-key set. */
  write(slot: string, value: JsonValue, options?: NovelSlotWriteOptions): Promise<void>;
  /** Existing slot IDs under this manager's prefix, sorted lexically. */
  list(): Promise<readonly string[]>;
  /** Remove a slot; removing an absent slot is an idempotent no-op. */
  delete(slot: string): Promise<void>;
  /** Copy an opaque stored value. Destination replacement requires overwrite:true. */
  copy(source: string, destination: string, options?: NovelSlotOperationOptions): Promise<void>;
  /** Atomically move a value, with no remove-before-write failure window. */
  move(source: string, destination: string, options?: NovelSlotOperationOptions): Promise<void>;
  /** Atomically exchange two occupied slots. */
  swap(first: string, second: string): Promise<void>;
  /** Remove listed PNGs that are no longer referenced by any raw slot record. */
  collectThumbnails?(): Promise<readonly string[]>;
}

const maxStorageKeyBytes = 256;

/** Match Dart's UTF-8 key length calculation without depending on TextEncoder. */
function utf8ByteLength(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= value.length) return null;
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) return null;
      index++;
      bytes += 4;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return null;
    } else if (first <= 0x7f) bytes++;
    else if (first <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Match Pocket storage's key exclusions and 256-byte UTF-8 bound. */
function isStorageKey(value: string): boolean {
  const bytes = utf8ByteLength(value);
  return value.length > 0 && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) && bytes !== null && bytes <= maxStorageKeyBytes;
}

function assertPrefix(prefix: string): void {
  const bytes = utf8ByteLength(prefix);
  if (!isStorageKey(prefix) || bytes === null || bytes >= maxStorageKeyBytes) {
    throw new NovelSlotError("invalid_prefix", "Slot prefix must be a valid storage key prefix under 256 UTF-8 bytes.");
  }
}

function validateOptions(options: NovelSlotOperationOptions | undefined): boolean {
  if (options === undefined) return false;
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "overwrite") ||
      options.overwrite !== undefined && typeof options.overwrite !== "boolean") {
    throw new TypeError("Novel slot options may contain only a boolean overwrite field.");
  }
  return options.overwrite === true;
}

function stringKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(key => typeof key !== "string")) {
    throw new TypeError("Novel slot storage keys() must return an array of strings.");
  }
  return value as string[];
}

const thumbnailIdPattern = /^[0-9a-f]{64}$/;

function isNovelSlotThumbnail(value: unknown): value is NovelSlotThumbnail {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const thumbnail = value as Record<string, unknown>;
  const width = thumbnail.width;
  const height = thumbnail.height;
  return thumbnail.version === 1 &&
    typeof thumbnail.id === "string" && thumbnailIdPattern.test(thumbnail.id) &&
    typeof width === "number" && Number.isInteger(width) && width > 0 && width <= 256 &&
    typeof height === "number" && Number.isInteger(height) && height > 0 && height <= 256 &&
    width * height <= 65_536;
}

function candidateThumbnailId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && thumbnailIdPattern.test(id) ? id : null;
}

/** Read the optional thumbnail metadata from an otherwise opaque save record. */
export function readNovelSlotThumbnail(value: unknown): NovelSlotThumbnail | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const thumbnail = (value as Record<string, unknown>).thumbnail;
  return isNovelSlotThumbnail(thumbnail) ? thumbnail : null;
}

function validateWriteOptions(options: NovelSlotWriteOptions | undefined): boolean {
  if (options === undefined) return false;
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "captureThumbnail") ||
      options.captureThumbnail !== undefined && typeof options.captureThumbnail !== "boolean") {
    throw new TypeError("Novel slot write options may contain only a boolean captureThumbnail field.");
  }
  return options.captureThumbnail === true;
}

function withoutThumbnail(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Readonly<Record<string, JsonValue>>) } as Record<string, JsonValue>;
  delete record.thumbnail;
  return record;
}

function withThumbnail(value: JsonValue, thumbnail: NovelSlotThumbnail): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A captured novel slot thumbnail can be attached only to an object save record.");
  }
  const metadata: JsonValue = {
    version: thumbnail.version,
    id: thumbnail.id,
    width: thumbnail.width,
    height: thumbnail.height,
  };
  return { ...(value as Readonly<Record<string, JsonValue>>), thumbnail: metadata };
}

/**
 * Manage save records in an existing app-scoped key-value store.
 *
 * The manager writes each save directly to `<prefix><slot>`; it keeps no index,
 * catalog, transaction copies, or engine state. All operations made through
 * one manager instance share a serial queue. Apps should route autosave and UI
 * slot writes through the same instance to avoid racing slot operations.
 */
export function createNovelSlotManager(
  storage: NovelSlotRawStorage,
  options: { readonly prefix: string; readonly thumbnails?: NovelSlotThumbnailOperations },
): NovelSlotManager {
  if (!storage || typeof storage !== "object" ||
      typeof storage.get !== "function" || typeof storage.set !== "function" ||
      typeof storage.remove !== "function" || typeof storage.keys !== "function") {
    throw new TypeError("Novel slot storage must provide get, set, remove, and keys.");
  }
  if (!options || typeof options !== "object") throw new TypeError("Novel slot manager requires a key prefix.");
  const prefix = options.prefix;
  if (typeof prefix !== "string") throw new NovelSlotError("invalid_prefix", "Slot prefix must be a string.");
  assertPrefix(prefix);
  const thumbnails = options.thumbnails;
  if (thumbnails !== undefined && (!thumbnails || typeof thumbnails !== "object" ||
      typeof thumbnails.capture !== "function" || typeof thumbnails.list !== "function" ||
      typeof thumbnails.remove !== "function" ||
      thumbnails.onCleanupError !== undefined && typeof thumbnails.onCleanupError !== "function")) {
    throw new TypeError("Novel slot thumbnails must provide capture, list, and remove operations.");
  }

  let queue: Promise<void> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const keyFor = (slot: string): string => {
    if (typeof slot !== "string" || !isStorageKey(slot) || !isStorageKey(prefix + slot)) {
      throw new NovelSlotError("invalid_slot", "Slot ID must form a valid Pocket storage key with this prefix.");
    }
    return prefix + slot;
  };
  const assertDistinct = (first: string, second: string): void => {
    if (first === second) throw new NovelSlotError("same_slot", "Source and destination slots must be different.");
  };
  const requireBatch = (): NonNullable<NovelSlotRawStorage["batch"]> => {
    if (typeof storage.batch !== "function") {
      throw new NovelSlotError("atomic_batch_unavailable", "This storage host does not support atomic slot moves or swaps.");
    }
    return storage.batch.bind(storage);
  };

  const existingSlotKeys = async (): Promise<readonly string[]> => {
    const found: string[] = [];
    for (const key of stringKeys(await storage.keys())) {
      if (!key.startsWith(prefix)) continue;
      const slot = key.slice(prefix.length);
      if (slot && isStorageKey(slot) && isStorageKey(prefix + slot)) found.push(key);
    }
    return found;
  };

  const reportCleanupError = (error: unknown, id?: string): void => {
    try { thumbnails?.onCleanupError?.(error, id); } catch { /* Cleanup reporting is best effort too. */ }
  };

  const scanReferencedThumbnails = async (): Promise<ReadonlySet<string>> => {
    if (!thumbnails) return new Set();
    const slotKeys = await existingSlotKeys();
    const records = await Promise.all(slotKeys.map(key => storage.get(key)));
    const referenced = new Set<string>();
    for (const record of records) {
      // Rendering requires the full supported metadata shape. Collection is
      // conservative: retain a named file even when an opaque save carries a
      // newer thumbnail version or dimensions this SDK cannot display.
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        const id = candidateThumbnailId((record as Record<string, unknown>).thumbnail);
        if (id) referenced.add(id);
      }
    }
    return referenced;
  };

  const removeUnreferencedCandidates = async (
    candidates: Iterable<string>,
    referenced: ReadonlySet<string>,
  ): Promise<readonly string[]> => {
    const removed: string[] = [];
    for (const id of new Set(candidates)) {
      if (!thumbnailIdPattern.test(id) || referenced.has(id)) continue;
      try {
        await thumbnails!.remove(id);
        removed.push(id);
      } catch (error) {
        reportCleanupError(error, id);
      }
    }
    return removed.sort();
  };

  const cleanupCandidates = async (candidateIds: Iterable<string>): Promise<void> => {
    if (!thumbnails) return;
    const candidates = [...new Set(candidateIds)].filter(id => thumbnailIdPattern.test(id));
    if (candidates.length === 0) return;
    try {
      // Read every current record before removing a candidate. If any read
      // fails, keep every candidate because one may still be shared.
      const referenced = await scanReferencedThumbnails();
      await removeUnreferencedCandidates(candidates, referenced);
    } catch (error) {
      // This is called only after a commit or a failed captured write, so
      // cleanup trouble must not replace the operation's result.
      reportCleanupError(error);
    }
  };

  const collectThumbnailsInner = async (): Promise<readonly string[]> => {
    if (!thumbnails) return [];
    // Full orphan discovery is explicit. Mutations only inspect known old
    // thumbnail IDs, keeping ordinary autosaves away from images.list().
    const referenced = await scanReferencedThumbnails();
    const listedValue: unknown = await thumbnails.list();
    if (!Array.isArray(listedValue) || listedValue.some(id => typeof id !== "string")) {
      throw new TypeError("Novel slot thumbnail list() must return an array of string IDs.");
    }
    return removeUnreferencedCandidates(listedValue as string[], referenced);
  };

  const manager: NovelSlotManager = {
    read: slot => serial(() => storage.get(keyFor(slot))),
    write: (slot, value, writeOptions) => serial(async () => {
      const captureThumbnail = validateWriteOptions(writeOptions);
      const key = keyFor(slot);
      const priorValue = thumbnails ? await storage.get(key) : null;
      const priorThumbnail = thumbnails ? readNovelSlotThumbnail(priorValue) : null;
      let valueToWrite = value;
      let capturedThumbnail: NovelSlotThumbnail | null = null;

      if (captureThumbnail) {
        if (!thumbnails) throw new TypeError("Novel slot thumbnail capture is not configured.");
        const captured: unknown = await thumbnails.capture();
        if (captured === null) {
          // A progress save is still useful without a preview; clear stale
          // metadata from a reused input record so it cannot misdescribe it.
          valueToWrite = withoutThumbnail(value);
        } else if (!isNovelSlotThumbnail(captured)) {
          const candidate = candidateThumbnailId(captured);
          if (candidate) await cleanupCandidates([candidate]);
          throw new TypeError("Novel slot thumbnail capture returned invalid metadata.");
        } else {
          capturedThumbnail = captured;
          try {
            valueToWrite = withThumbnail(value, captured);
          } catch (error) {
            await cleanupCandidates([captured.id]);
            throw error;
          }
        }
      }

      try {
        await storage.set(key, valueToWrite);
      } catch (error) {
        if (capturedThumbnail) await cleanupCandidates([capturedThumbnail.id]);
        throw error;
      }
      if (priorThumbnail) await cleanupCandidates([priorThumbnail.id]);
    }),
    list: () => serial(async () => {
      return (await existingSlotKeys()).map(key => key.slice(prefix.length)).sort();
    }),
    delete: slot => serial(async () => {
      const key = keyFor(slot);
      const priorThumbnail = thumbnails ? readNovelSlotThumbnail(await storage.get(key)) : null;
      await storage.remove(key);
      if (priorThumbnail) await cleanupCandidates([priorThumbnail.id]);
    }),
    copy: (source, destination, operationOptions) => serial(async () => {
      const overwrite = validateOptions(operationOptions);
      const sourceKey = keyFor(source);
      const destinationKey = keyFor(destination);
      assertDistinct(source, destination);
      const keys = new Set(stringKeys(await storage.keys()));
      if (!keys.has(sourceKey)) throw new NovelSlotError("missing_source", `Source slot '${source}' does not exist.`);
      if (!overwrite && keys.has(destinationKey)) throw new NovelSlotError("slot_exists", `Destination slot '${destination}' already exists.`);
      const priorDestination = thumbnails && keys.has(destinationKey) ? await storage.get(destinationKey) : null;
      const value = await storage.get(sourceKey);
      // Both reads and writes cross the platform JSON boundary. Values remain
      // opaque here; the host validates JSON shape and snapshots the mutation.
      await storage.set(destinationKey, value as JsonValue);
      const priorThumbnail = thumbnails ? readNovelSlotThumbnail(priorDestination) : null;
      if (priorThumbnail) await cleanupCandidates([priorThumbnail.id]);
    }),
    move: (source, destination, operationOptions) => serial(async () => {
      const overwrite = validateOptions(operationOptions);
      const sourceKey = keyFor(source);
      const destinationKey = keyFor(destination);
      assertDistinct(source, destination);
      const batch = requireBatch();
      const keys = new Set(stringKeys(await storage.keys()));
      if (!keys.has(sourceKey)) throw new NovelSlotError("missing_source", `Source slot '${source}' does not exist.`);
      if (!overwrite && keys.has(destinationKey)) throw new NovelSlotError("slot_exists", `Destination slot '${destination}' already exists.`);
      const priorDestination = thumbnails && keys.has(destinationKey) ? await storage.get(destinationKey) : null;
      const value = await storage.get(sourceKey);
      await batch([
        { type: "set", key: destinationKey, value: value as JsonValue },
        { type: "remove", key: sourceKey },
      ]);
      const priorThumbnail = thumbnails ? readNovelSlotThumbnail(priorDestination) : null;
      if (priorThumbnail) await cleanupCandidates([priorThumbnail.id]);
    }),
    swap: (first, second) => serial(async () => {
      const firstKey = keyFor(first);
      const secondKey = keyFor(second);
      assertDistinct(first, second);
      const batch = requireBatch();
      const keys = new Set(stringKeys(await storage.keys()));
      if (!keys.has(firstKey)) throw new NovelSlotError("missing_slot", `Slot '${first}' does not exist.`);
      if (!keys.has(secondKey)) throw new NovelSlotError("missing_slot", `Slot '${second}' does not exist.`);
      const [firstValue, secondValue] = await Promise.all([storage.get(firstKey), storage.get(secondKey)]);
      await batch([
        { type: "set", key: firstKey, value: secondValue as JsonValue },
        { type: "set", key: secondKey, value: firstValue as JsonValue },
      ]);
      if (thumbnails) {
        const candidates = [readNovelSlotThumbnail(firstValue), readNovelSlotThumbnail(secondValue)]
          .filter((thumbnail): thumbnail is NovelSlotThumbnail => thumbnail !== null)
          .map(thumbnail => thumbnail.id);
        await cleanupCandidates(candidates);
      }
    }),
  };

  if (thumbnails) manager.collectThumbnails = () => serial(collectThumbnailsInner);
  return manager;
}
