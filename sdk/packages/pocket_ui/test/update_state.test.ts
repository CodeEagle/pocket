import { expect, test } from "bun:test";
import type { JsonValue } from "../src/host.ts";
import {
  POCKET_UPDATE_STATE_PROTOCOL,
  PocketUpdateStateError,
  createPocketUpdateState,
} from "../src/update_state.ts";

type Target = { version: string; build: number };

class MemoryStorage {
  value: unknown;
  onSet?: () => void;
  private gate: Promise<void> | undefined;
  private releaseGate: (() => void) | undefined;

  constructor(value?: unknown) {
    this.value = value;
  }

  holdGet(): void {
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  releaseGet(): void {
    this.releaseGate?.();
    this.releaseGate = undefined;
  }

  async get(): Promise<unknown> {
    await this.gate;
    return this.value;
  }

  async set(_key: string, value: JsonValue): Promise<void> {
    this.value = value;
    this.onSet?.();
  }

  async remove(): Promise<void> {
    this.value = undefined;
  }
}

function stateRecord(schema = "profile.v1", target: Target = { version: "2.0.0", build: 2 }, value: JsonValue = { draft: "saved" }) {
  return {
    protocol: POCKET_UPDATE_STATE_PROTOCOL,
    schema,
    targetVersion: target.version,
    targetBuild: target.build,
    value,
  };
}

function createState(
  storage: MemoryStorage,
  state: { value: JsonValue },
  restored: JsonValue[] = [],
) {
  return createPocketUpdateState({
    key: "update-state",
    schema: "profile.v1",
    storage,
    capture: () => state.value,
    restore: (value) => {
      restored.push(value);
      state.value = value;
      return true;
    },
  });
}

test("captures a direct record, restores from target or source, and commits after health", async () => {
  const storage = new MemoryStorage();
  const state = { value: { draft: "saved", count: 3 } as JsonValue };
  const restored: JsonValue[] = [];
  const helper = createState(storage, state, restored);
  const target = { version: "2.0.0", build: 2 };
  const source = { version: "1.0.0", build: 1 };

  await helper.capture(target, source);
  expect(storage.value).toEqual({
    ...stateRecord("profile.v1", target, { draft: "saved", count: 3 }),
    sourceVersion: "1.0.0",
    sourceBuild: 1,
  });

  expect(await helper.restore(source)).toBe(true);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toEqual({ draft: "saved", count: 3 });
  await helper.commit(source);
  expect(storage.value).toBeUndefined();
});

test("does not use JSON parsing or stringification on the direct-object path", async () => {
  const storage = new MemoryStorage();
  const state = { value: { text: "direct 😀", enabled: true } as JsonValue };
  const helper = createState(storage, state);
  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  try {
    JSON.parse = (() => { throw new Error("JSON.parse must not be used"); }) as typeof JSON.parse;
    JSON.stringify = (() => { throw new Error("JSON.stringify must not be used"); }) as typeof JSON.stringify;
    await helper.capture({ version: "2.0.0", build: 2 });
    expect(await helper.restore({ version: "2.0.0", build: 2 })).toBe(true);
  } finally {
    JSON.parse = originalParse;
    JSON.stringify = originalStringify;
  }
});

test("rejects wrong schema, version/build, protocol, and malformed records", async () => {
  const state = { value: { draft: "initial" } as JsonValue };
  const restored: JsonValue[] = [];

  const schemaStorage = new MemoryStorage(stateRecord("other-schema"));
  const schemaHelper = createState(schemaStorage, state, restored);
  expect(await schemaHelper.restore({ version: "2.0.0", build: 2 })).toBe(false);

  const wrongTargetStorage = new MemoryStorage(stateRecord());
  const wrongTargetHelper = createState(wrongTargetStorage, state, restored);
  expect(await wrongTargetHelper.restore({ version: "9.0.0", build: 9 })).toBe(false);

  const protocolStorage = new MemoryStorage({ ...stateRecord(), protocol: "other.protocol" });
  const protocolHelper = createState(protocolStorage, state, restored);
  expect(await protocolHelper.restore({ version: "2.0.0", build: 2 })).toBe(false);

  const malformedStorage = new MemoryStorage({ ...stateRecord(), value: new Uint8Array([1, 2, 3]) });
  const malformedHelper = createState(malformedStorage, state, restored);
  expect(await malformedHelper.restore({ version: "2.0.0", build: 2 })).toBe(false);
  expect(restored).toHaveLength(0);
});

test("does not restore over local input changed while storage is pending", async () => {
  const storage = new MemoryStorage(stateRecord());
  storage.holdGet();
  const state = { value: { draft: "initial", localInput: "" } as JsonValue };
  const restored: JsonValue[] = [];
  const helper = createState(storage, state, restored);
  const pending = helper.restore({ version: "2.0.0", build: 2 });
  state.value = { draft: "initial", localInput: "typed while waiting" };
  storage.releaseGet();

  expect(await pending).toBe(false);
  expect(restored).toHaveLength(0);
  expect(state.value).toEqual({ draft: "initial", localInput: "typed while waiting" });
  await helper.commit({ version: "2.0.0", build: 2 });
  expect(storage.value).toBeUndefined();
});

test("commit acknowledges an observed record even after post-restore input", async () => {
  const storage = new MemoryStorage(stateRecord());
  const state = { value: { draft: "initial" } as JsonValue };
  const helper = createState(storage, state);
  expect(await helper.restore({ version: "2.0.0", build: 2 })).toBe(true);
  state.value = { draft: "new input after restore" };
  await helper.commit({ version: "2.0.0", build: 2 });
  expect(storage.value).toBeUndefined();
});

test("commit never removes a newer writer's same-target record", async () => {
  const storage = new MemoryStorage(stateRecord());
  const state = { value: { draft: "initial" } as JsonValue };
  const helper = createState(storage, state);
  expect(await helper.restore({ version: "2.0.0", build: 2 })).toBe(true);
  storage.value = stateRecord("profile.v1", { version: "2.0.0", build: 2 }, { draft: "new writer" });
  await helper.commit({ version: "2.0.0", build: 2 });
  expect(storage.value).toEqual(stateRecord("profile.v1", { version: "2.0.0", build: 2 }, { draft: "new writer" }));
});

test("detects a capture conflict and removes only the exact write", async () => {
  const storage = new MemoryStorage();
  const state = { value: { draft: "before" } as JsonValue };
  storage.onSet = () => { state.value = { draft: "changed during write" }; };
  const helper = createState(storage, state);

  await expect(helper.capture({ version: "2.0.0", build: 2 })).rejects.toBeInstanceOf(PocketUpdateStateError);
  expect(storage.value).toBeUndefined();
});

test("discard protects a newer same-target value and removes a matching captured record", async () => {
  const storage = new MemoryStorage();
  const state = { value: { draft: "old" } as JsonValue };
  const helper = createState(storage, state);
  const target = { version: "2.0.0", build: 2 };
  await helper.capture(target);

  storage.value = stateRecord("profile.v1", target, { draft: "new" });
  await helper.discard(target);
  expect(storage.value).toEqual(stateRecord("profile.v1", target, { draft: "new" }));

  state.value = { draft: "new" };
  await helper.capture(target);
  await helper.discard(target);
  expect(storage.value).toBeUndefined();
});

test("enforces bounded plain snapshots and rejects a promised restore result", async () => {
  const storage = new MemoryStorage();
  const cyclic: Record<string, JsonValue> = {};
  cyclic.self = cyclic;
  expect(() => createPocketUpdateState({
    key: "cycle",
    schema: "profile.v1",
    storage,
    capture: () => cyclic,
    restore: () => true,
  })).toThrow(/cycle/);

  const state = { value: { draft: "saved" } as JsonValue };
  const badRestore = createPocketUpdateState({
    key: "promise-restore",
    schema: "profile.v1",
    storage,
    capture: () => state.value,
    restore: () => Promise.resolve(true) as unknown as boolean,
  });
  await badRestore.capture({ version: "2.0.0", build: 2 });
  expect(await badRestore.restore({ version: "2.0.0", build: 2 })).toBe(false);
});
