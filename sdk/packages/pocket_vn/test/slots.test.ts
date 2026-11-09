import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import {
  createNovelSlotManager,
  NovelSlotError,
  readNovelSlotThumbnail,
  type NovelSlotRawStorage,
  type NovelSlotStorageOperation,
  type NovelSlotThumbnailOperations,
} from "../src/slots.ts";
import type { JsonValue, NovelSlotThumbnail } from "../src/types.ts";

class MemoryStorage implements NovelSlotRawStorage {
  readonly values = new Map<string, JsonValue>();
  readonly calls: Array<{ type: string; key?: string }> = [];
  readonly batches: NovelSlotStorageOperation[][] = [];
  batch?: (operations: readonly NovelSlotStorageOperation[]) => Promise<void>;
  setBarrier?: Promise<void>;
  onSetStarted?: () => void;
  setFailure?: Error;
  getFailure?: Error;

  constructor(options: { batch?: boolean; initial?: Record<string, JsonValue> } = {}) {
    for (const [key, value] of Object.entries(options.initial ?? {})) this.values.set(key, value);
    if (options.batch !== false) {
      this.batch = async operations => {
        const next = new Map(this.values);
        this.batches.push(operations.map(operation => ({ ...operation })));
        for (const operation of operations) {
          if (operation.type === "set") next.set(operation.key, operation.value);
          else next.delete(operation.key);
        }
        this.values.clear();
        for (const [key, value] of next) this.values.set(key, value);
      };
    }
  }

  async get(key: string): Promise<JsonValue | null> {
    this.calls.push({ type: "get", key });
    if (this.getFailure) throw this.getFailure;
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    this.calls.push({ type: "set", key });
    this.onSetStarted?.();
    await this.setBarrier;
    if (this.setFailure) throw this.setFailure;
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.calls.push({ type: "remove", key });
    this.values.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    this.calls.push({ type: "keys" });
    return [...this.values.keys()].sort();
  }
}

class MemoryThumbnails implements NovelSlotThumbnailOperations {
  readonly files = new Set<string>();
  readonly removed: string[] = [];
  readonly captures: Array<NovelSlotThumbnail | null | Error> = [];
  readonly cleanupErrors: Array<{ error: unknown; id?: string }> = [];
  listCalls = 0;
  captureDelay?: (index: number) => Promise<void>;
  onCaptureStarted?: (index: number) => void;
  failRemove?: Error;
  private captureCount = 0;

  async capture(): Promise<NovelSlotThumbnail | null> {
    const index = this.captureCount++;
    this.onCaptureStarted?.(index);
    await this.captureDelay?.(index);
    const result = this.captures[index];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("No thumbnail capture result configured.");
    if (result) this.files.add(result.id);
    return result;
  }

  async list(): Promise<readonly string[]> {
    this.listCalls++;
    return [...this.files].sort();
  }

  async remove(id: string): Promise<void> {
    if (this.failRemove) throw this.failRemove;
    this.removed.push(id);
    this.files.delete(id);
  }

  onCleanupError(error: unknown, id?: string): void {
    this.cleanupErrors.push({ error, id });
  }
}

function manager(storage: MemoryStorage, prefix = "lantern.slot.", thumbnails?: NovelSlotThumbnailOperations) {
  return createNovelSlotManager(storage, { prefix, ...(thumbnails ? { thumbnails } : {}) });
}

function thumbnail(letter: string): NovelSlotThumbnail {
  return { version: 1, id: letter.repeat(64), width: 120, height: 80 };
}

function saveWithThumbnail(id: string, text = id): JsonValue {
  const image = thumbnail(id);
  return {
    storyId: "lantern",
    state: { line: text },
    thumbnail: { version: image.version, id: image.id, width: image.width, height: image.height },
  };
}

function errorCode(code: NovelSlotError["code"]) {
  return (error: unknown) => error instanceof NovelSlotError && error.code === code;
}

test("lists existing slot keys without a catalog and preserves legacy auto/1/2/3 records", async () => {
  const storage = new MemoryStorage({ initial: {
    "lantern.slot.auto": { storyId: "lantern", state: { line: "auto" } },
    "lantern.slot.1": { storyId: "lantern", state: { line: "one" } },
    "lantern.slot.2": { storyId: "lantern", state: { line: "two" } },
    "lantern.slot.3": { storyId: "lantern", state: { line: "three" } },
    "lantern.audio.mix": { master: 0.75 },
    "other.slot.1": { storyId: "other" },
  } });
  const slots = manager(storage);

  expect(await slots.list()).toEqual(["1", "2", "3", "auto"]);
  expect(await slots.read("auto")).toEqual({ storyId: "lantern", state: { line: "auto" } });
  expect(storage.values.has("lantern.slot.index")).toBe(false);
  expect(storage.values.get("lantern.audio.mix")).toEqual({ master: 0.75 });

  await slots.write("1", { storyId: "lantern", state: { line: "updated" } });
  expect(storage.values.get("lantern.slot.1")).toEqual({ storyId: "lantern", state: { line: "updated" } });
  await slots.delete("3");
  await slots.delete("3");
  expect(await slots.list()).toEqual(["1", "2", "auto"]);
});

test("copies opaque save records, does not overwrite by default, and permits explicit replacement", async () => {
  const raw = { storyId: "lantern", storyVersion: 3, state: { active: { text: "canonical source" } }, custom: { locale: "canonical" } };
  const storage = new MemoryStorage({ initial: {
    "lantern.slot.auto": raw,
    "lantern.slot.1": { storyId: "older", state: {} },
  } });
  const slots = manager(storage);

  await slots.copy("auto", "2");
  expect(storage.values.get("lantern.slot.2")).toEqual(raw);
  expect(storage.values.get("lantern.slot.auto")).toEqual(raw);
  await assert.rejects(slots.copy("auto", "1"), errorCode("slot_exists"));
  expect(storage.values.get("lantern.slot.1")).toEqual({ storyId: "older", state: {} });
  await slots.copy("auto", "1", { overwrite: true });
  expect(storage.values.get("lantern.slot.1")).toEqual(raw);

  const nullStorage = new MemoryStorage({ initial: { "lantern.slot.null": null } });
  const nullSlots = manager(nullStorage);
  await nullSlots.copy("null", "null_copy");
  expect(nullStorage.values.has("lantern.slot.null_copy")).toBe(true);
  expect(nullStorage.values.get("lantern.slot.null_copy")).toBeNull();
});

test("move is one atomic batch, rejects missing/occupied slots before mutation, and can explicitly replace", async () => {
  const storage = new MemoryStorage({ initial: {
    "lantern.slot.auto": { save: "source" },
    "lantern.slot.1": { save: "destination" },
  } });
  const slots = manager(storage);

  await assert.rejects(slots.move("missing", "2"), errorCode("missing_source"));
  await assert.rejects(slots.move("auto", "1"), errorCode("slot_exists"));
  expect(storage.batches).toHaveLength(0);
  expect(storage.values.get("lantern.slot.auto")).toEqual({ save: "source" });
  expect(storage.values.get("lantern.slot.1")).toEqual({ save: "destination" });

  await slots.move("auto", "1", { overwrite: true });
  expect(storage.batches).toEqual([[
    { type: "set", key: "lantern.slot.1", value: { save: "source" } },
    { type: "remove", key: "lantern.slot.auto" },
  ]]);
  expect(storage.values.has("lantern.slot.auto")).toBe(false);
  expect(storage.values.get("lantern.slot.1")).toEqual({ save: "source" });

  const nullStorage = new MemoryStorage({ initial: { "lantern.slot.null": null } });
  await manager(nullStorage).move("null", "null_moved");
  expect(nullStorage.values.has("lantern.slot.null")).toBe(false);
  expect(nullStorage.values.has("lantern.slot.null_moved")).toBe(true);
  expect(nullStorage.values.get("lantern.slot.null_moved")).toBeNull();
});

test("swap exchanges two occupied records in one batch without staging duplicate saves", async () => {
  const first = { save: "first", state: { location: "start:1" } };
  const second = { save: "second", state: { location: "memory:4" } };
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": first, "lantern.slot.2": second } });
  const slots = manager(storage);

  await slots.swap("1", "2");
  expect(storage.batches).toEqual([[
    { type: "set", key: "lantern.slot.1", value: second },
    { type: "set", key: "lantern.slot.2", value: first },
  ]]);
  expect(storage.values.get("lantern.slot.1")).toEqual(second);
  expect(storage.values.get("lantern.slot.2")).toEqual(first);
  expect(storage.values.size).toBe(2);

  await assert.rejects(slots.swap("1", "empty"), errorCode("missing_slot"));
  await assert.rejects(slots.swap("1", "1"), errorCode("same_slot"));
  expect(storage.batches).toHaveLength(1);
});

test("move and swap refuse hosts without atomic batch before reads or writes", async () => {
  const storage = new MemoryStorage({ batch: false, initial: { "lantern.slot.1": { save: "one" }, "lantern.slot.2": { save: "two" } } });
  const slots = manager(storage);

  await assert.rejects(slots.move("1", "3"), errorCode("atomic_batch_unavailable"));
  await assert.rejects(slots.swap("1", "2"), errorCode("atomic_batch_unavailable"));
  expect(storage.calls).toEqual([]);
  expect(storage.values.get("lantern.slot.1")).toEqual({ save: "one" });
  expect(storage.values.get("lantern.slot.2")).toEqual({ save: "two" });
});

test("validates IDs and prefixes using Pocket's bounded storage-key rules", async () => {
  const storage = new MemoryStorage();
  expect(() => manager(storage, "../bad.")).toThrow(NovelSlotError);
  expect(() => manager(storage, "x".repeat(256))).toThrow(NovelSlotError);
  expect(() => manager(storage, "bad\u0000prefix.")).toThrow(NovelSlotError);

  const slots = manager(storage, "s.");
  for (const id of ["", ".", "..", "bad/name", "bad\\name", "bad\u007fname", "bad\u001fname", "\ud800", "a".repeat(255)]) {
    await assert.rejects(slots.read(id), errorCode("invalid_slot"));
  }
  await slots.write("😀", { valid: true });
  expect(storage.values.has("s.😀")).toBe(true);

  const maxPrefix = manager(storage, "p." + "x".repeat(253));
  await maxPrefix.write("y", { valid: true });
  expect(storage.values.has("p." + "x".repeat(253) + "y")).toBe(true);
  assert.throws(() => manager(storage, "p." + "x".repeat(254)), errorCode("invalid_prefix"));
});

test("serializes calls made through one manager instance", async () => {
  const storage = new MemoryStorage();
  let releaseFirstWrite!: () => void;
  let startedFirstWrite!: () => void;
  storage.setBarrier = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
  const firstStarted = new Promise<void>(resolve => { startedFirstWrite = resolve; });
  storage.onSetStarted = startedFirstWrite;
  const slots = manager(storage);

  const first = slots.write("1", { revision: 1 });
  await firstStarted;
  const second = slots.write("1", { revision: 2 });
  await Promise.resolve();
  expect(storage.calls.filter(call => call.type === "set")).toHaveLength(1);
  releaseFirstWrite();
  await Promise.all([first, second]);
  expect(storage.calls.filter(call => call.type === "set")).toHaveLength(2);
  expect(storage.values.get("lantern.slot.1")).toEqual({ revision: 2 });
  assert.equal(storage.batches.length, 0);
});

test("repeated thumbnail-enabled autosaves without images avoid list and full reference scans", async () => {
  const storage = new MemoryStorage();
  const images = new MemoryThumbnails();
  const slots = manager(storage, "lantern.slot.", images);

  await slots.write("auto", { storyId: "lantern", state: { line: 1 } });
  await slots.write("auto", { storyId: "lantern", state: { line: 2 } });
  await slots.write("auto", { storyId: "lantern", state: { line: 3 } });

  expect(images.listCalls).toBe(0);
  expect(storage.calls.filter(call => call.type === "keys")).toHaveLength(0);
  expect(storage.calls.filter(call => call.type === "get")).toHaveLength(3);
  expect(storage.values.get("lantern.slot.auto")).toEqual({ storyId: "lantern", state: { line: 3 } });
});

test("thumbnail metadata accepts only the host's bounded immutable image shape", () => {
  expect(readNovelSlotThumbnail({ state: {}, thumbnail: thumbnail("a") })).toEqual(thumbnail("a"));
  expect(readNovelSlotThumbnail({ thumbnail: { ...thumbnail("a"), width: 257 } })).toBeNull();
  expect(readNovelSlotThumbnail({ thumbnail: { ...thumbnail("a"), id: "A".repeat(64) } })).toBeNull();
  expect(readNovelSlotThumbnail(null)).toBeNull();
});

test("copy, move, swap, and delete collect only images no remaining save references", async () => {
  const storage = new MemoryStorage({ initial: {
    "lantern.slot.a": saveWithThumbnail("a"),
    "lantern.slot.b": saveWithThumbnail("d"),
    "lantern.slot.c": saveWithThumbnail("b"),
    "lantern.slot.d": saveWithThumbnail("c"),
    "lantern.slot.e": saveWithThumbnail("d"),
  } });
  const images = new MemoryThumbnails();
  for (const id of ["a", "b", "c", "d"]) images.files.add(thumbnail(id).id);
  const slots = manager(storage, "lantern.slot.", images);

  await slots.copy("a", "c", { overwrite: true });
  expect(storage.values.get("lantern.slot.c")).toEqual(saveWithThumbnail("a"));
  expect(images.files.has(thumbnail("a").id)).toBe(true); // Source and another slot still reference it.
  expect(images.files.has(thumbnail("b").id)).toBe(false);

  await slots.move("c", "d", { overwrite: true });
  expect(storage.values.has("lantern.slot.c")).toBe(false);
  expect(storage.values.get("lantern.slot.d")).toEqual(saveWithThumbnail("a"));
  expect(images.files.has(thumbnail("a").id)).toBe(true);
  expect(images.files.has(thumbnail("c").id)).toBe(false);

  await slots.swap("a", "b");
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.a"))?.id).toBe(thumbnail("d").id);
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.b"))?.id).toBe(thumbnail("a").id);
  expect(images.files.has(thumbnail("d").id)).toBe(true); // Slot e shares this image.
  expect(images.files.has(thumbnail("a").id)).toBe(true); // Slot d still shares this image.

  await slots.delete("b");
  expect(images.files.has(thumbnail("a").id)).toBe(true);
  await slots.delete("d");
  expect(images.files.has(thumbnail("a").id)).toBe(false);
  expect(images.removed).toEqual(expect.arrayContaining([thumbnail("a").id, thumbnail("b").id, thumbnail("c").id]));
  expect(images.listCalls).toBe(0); // Known replaced IDs are checked without an all-images listing.
});

test("capture is opt-in and a null capture clears stale thumbnail metadata", async () => {
  const storage = new MemoryStorage();
  const images = new MemoryThumbnails();
  images.captures.push(null);
  const slots = manager(storage, "lantern.slot.", images);
  const value = { storyId: "lantern", thumbnail: thumbnail("a"), state: { line: "fresh" } } as JsonValue;

  await slots.write("plain", value);
  expect(storage.values.get("lantern.slot.plain")).toBe(value);
  expect(images.captures).toEqual([null]);

  await slots.write("captured", value, { captureThumbnail: true });
  expect(storage.values.get("lantern.slot.captured")).toEqual({ storyId: "lantern", state: { line: "fresh" } });
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.captured"))).toBeNull();
});

test("a failed capture leaves the prior slot record intact", async () => {
  const prior = saveWithThumbnail("a", "prior");
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": prior } });
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("a").id);
  images.captures.push(new Error("capture failed"));
  const slots = manager(storage, "lantern.slot.", images);

  await assert.rejects(slots.write("1", { storyId: "lantern", state: { line: "new" } }, { captureThumbnail: true }), /capture failed/);
  expect(storage.values.get("lantern.slot.1")).toEqual(prior);
  expect(images.files.has(thumbnail("a").id)).toBe(true);
});

test("a failed save write removes the newly captured unreferenced image", async () => {
  const prior = saveWithThumbnail("a", "prior");
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": prior } });
  storage.setFailure = new Error("write failed");
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("a").id);
  images.captures.push(thumbnail("b"));
  const slots = manager(storage, "lantern.slot.", images);

  await assert.rejects(slots.write("1", { storyId: "lantern", state: { line: "new" } }, { captureThumbnail: true }), /write failed/);
  expect(storage.values.get("lantern.slot.1")).toEqual(prior);
  expect(images.files.has(thumbnail("a").id)).toBe(true);
  expect(images.files.has(thumbnail("b").id)).toBe(false);
  expect(images.removed).toContain(thumbnail("b").id);
});

test("post-commit thumbnail cleanup failures are reported without rejecting a saved write", async () => {
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": saveWithThumbnail("a", "prior") } });
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("a").id);
  images.captures.push(thumbnail("b"));
  images.failRemove = new Error("cleanup failed");
  const slots = manager(storage, "lantern.slot.", images);

  await slots.write("1", { storyId: "lantern", state: { line: "committed" } }, { captureThumbnail: true });
  expect(storage.values.get("lantern.slot.1")).toEqual({
    storyId: "lantern", state: { line: "committed" }, thumbnail: thumbnail("b"),
  });
  expect(images.cleanupErrors).toEqual([{ error: images.failRemove, id: thumbnail("a").id }]);
});

test("explicit startup collection removes crash orphans before the next capture", async () => {
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": { storyId: "lantern", state: {} } } });
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("c").id); // Left behind by a prior capture-before-save crash.
  images.captures.push(thumbnail("a"));
  let filesAtCapture: readonly string[] = [];
  images.onCaptureStarted = () => { filesAtCapture = [...images.files]; };
  const slots = manager(storage, "lantern.slot.", images);

  await slots.collectThumbnails!();
  expect(images.listCalls).toBe(1);
  expect(storage.calls.filter(call => call.type === "keys")).toHaveLength(1);
  await slots.write("1", { storyId: "lantern", state: { line: "new" } }, { captureThumbnail: true });
  expect(filesAtCapture).not.toContain(thumbnail("c").id);
  expect(images.removed).toContain(thumbnail("c").id);
  expect(images.listCalls).toBe(1);
  expect(storage.calls.filter(call => call.type === "keys")).toHaveLength(1);
  expect(images.files.has(thumbnail("a").id)).toBe(true);
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.1"))?.id).toBe(thumbnail("a").id);
});

test("collection preserves opaque newer thumbnail references without rendering them", async () => {
  const futureThumbnail = { ...thumbnail("a"), version: 2, width: 512 };
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": { thumbnail: futureThumbnail } } });
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("a").id);
  images.files.add(thumbnail("b").id);
  const slots = manager(storage, "lantern.slot.", images);
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.1"))).toBeNull();
  expect(await slots.collectThumbnails!()).toEqual([thumbnail("b").id]);
  expect(images.files.has(thumbnail("a").id)).toBe(true);
});

test("thumbnail collection aborts before deletion when a slot reference scan fails", async () => {
  const storage = new MemoryStorage({ initial: { "lantern.slot.1": saveWithThumbnail("a") } });
  storage.getFailure = new Error("slot read failed");
  const images = new MemoryThumbnails();
  images.files.add(thumbnail("a").id);
  images.files.add(thumbnail("b").id);
  const slots = manager(storage, "lantern.slot.", images);

  await assert.rejects(slots.collectThumbnails!(), /slot read failed/);
  expect(images.removed).toEqual([]);
  expect(images.files).toEqual(new Set([thumbnail("a").id, thumbnail("b").id]));
});

test("thumbnail captures share the slot queue and cannot race each other", async () => {
  const storage = new MemoryStorage();
  const images = new MemoryThumbnails();
  images.captures.push(thumbnail("a"), thumbnail("b"));
  let releaseFirstCapture!: () => void;
  let startedFirstCapture!: () => void;
  const firstCaptureGate = new Promise<void>(resolve => { releaseFirstCapture = resolve; });
  const firstCaptureStarted = new Promise<void>(resolve => { startedFirstCapture = resolve; });
  const captureStarts: number[] = [];
  images.onCaptureStarted = index => {
    captureStarts.push(index);
    if (index === 0) startedFirstCapture();
  };
  images.captureDelay = index => index === 0 ? firstCaptureGate : Promise.resolve();
  const slots = manager(storage, "lantern.slot.", images);

  const first = slots.write("1", { storyId: "lantern", state: { line: "one" } }, { captureThumbnail: true });
  await firstCaptureStarted;
  const second = slots.write("2", { storyId: "lantern", state: { line: "two" } }, { captureThumbnail: true });
  await Promise.resolve();
  expect(captureStarts).toEqual([0]);
  releaseFirstCapture();
  await Promise.all([first, second]);

  expect(captureStarts).toEqual([0, 1]);
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.1"))?.id).toBe(thumbnail("a").id);
  expect(readNovelSlotThumbnail(storage.values.get("lantern.slot.2"))?.id).toBe(thumbnail("b").id);
});
