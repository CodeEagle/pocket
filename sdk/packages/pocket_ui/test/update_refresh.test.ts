import { expect, test } from "bun:test";
import type { BridgeObject, BridgeValue, HostBridge, HostEvent, HostEventListener } from "../src/host.ts";
import { createPocketUpdateClient, type PocketUpdateStatusSnapshot } from "../src/updates.ts";

class UpdateHost implements HostBridge {
  readonly calls: Array<{ capability: string; params: BridgeObject }> = [];
  readonly listeners = new Set<HostEventListener>();
  snapshot: PocketUpdateStatusSnapshot = {
    configured: true, stage: "ready", activeVersion: "1.0.0", activeBuild: 1, versions: [],
  };
  scheduled = true;
  checkError: unknown;
  waitForDownload?: Promise<void>;

  async request<T extends BridgeValue>(capability: string, params: BridgeObject = {}): Promise<T> {
    this.calls.push({ capability, params });
    if (capability === "updates.status") return this.snapshot as unknown as T;
    if (capability === "updates.check") {
      await this.waitForDownload;
      if (this.checkError) {
        this.snapshot = { ...this.snapshot, stage: "error" };
        throw this.checkError;
      }
      this.snapshot = {
        ...this.snapshot, stage: "verified", availableVersion: "1.0.1",
        preparedUpdate: {
          version: "1.0.1", build: 2, deliveryMode: "granular", scope: "all",
          downloadedFiles: 1, reusedFiles: 1, downloadedBytes: 10, reusedBytes: 10,
          updatedComponents: ["code"],
        },
      };
      return this.snapshot as unknown as T;
    }
    if (capability === "updates.apply") return { scheduled: this.scheduled, version: "1.0.1" } as T;
    throw new Error(`Unexpected capability ${capability}`);
  }
  onEvent(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  deliver(method: string, params: BridgeObject = {}): void {
    const event: HostEvent = { id: "test-event", method, params, raw: { method, params } };
    for (const listener of this.listeners) listener(event);
  }
  handle(): boolean { return false; }
  tick(): void {}
  dispose(): void {}
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

test("refresh verifies then schedules the current guest's replacement using direct objects", async () => {
  const host = new UpdateHost();
  const client = createPocketUpdateClient(host);
  const parse = JSON.parse, stringify = JSON.stringify;
  try {
    JSON.parse = () => { throw new Error("JSON parse is not a refresh transport"); };
    JSON.stringify = () => { throw new Error("JSON stringify is not a refresh transport"); };
    const result = await client.refresh({ mode: "granular", scope: "code" });
    expect(result).toEqual({ scheduled: true, version: "1.0.1" });
    expect(host.calls).toEqual([
      { capability: "updates.status", params: {} },
      { capability: "updates.check", params: { mode: "granular", scope: "code" } },
      { capability: "updates.apply", params: {} },
    ]);
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
    client.dispose();
  }
});

test("automatic refresh waits for host health readiness and never installs a polling callback", async () => {
  const host = new UpdateHost();
  host.snapshot = { ...host.snapshot, stage: "loading" };
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  expect(host.calls.map((call) => call.capability)).toEqual(["updates.status"]);
  host.deliver("unrelated", {});
  host.tick();
  await settle();
  expect(host.calls).toHaveLength(1);
  host.snapshot = { ...host.snapshot, stage: "ready" };
  host.deliver("updates.changed", { configured: true, stage: "ready" });
  await settle();
  expect(host.calls.filter((call) => call.capability === "updates.apply")).toHaveLength(1);
  client.dispose();
  expect(host.listeners.size).toBe(0);
});

test("duplicate resume and ready events share the download and cannot schedule two remounts", async () => {
  const host = new UpdateHost();
  let finish!: () => void;
  host.waitForDownload = new Promise<void>((resolve) => { finish = resolve; });
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  const first = client.refresh();
  host.deliver("platform.lifecycle", { state: "onResume" });
  host.deliver("updates.changed", { configured: true, stage: "ready" });
  expect(client.refresh()).toBe(first);
  expect(host.calls.filter((call) => call.capability === "updates.check")).toHaveLength(1);
  finish();
  await first;
  host.deliver("updates.changed", { configured: true, stage: "ready" });
  await settle();
  expect(host.calls.filter((call) => call.capability === "updates.apply")).toHaveLength(1);
  client.dispose();
});

test("an unchanged package is not latched as scheduled and can be checked on a later resume", async () => {
  const host = new UpdateHost();
  host.scheduled = false;
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  expect(await client.refresh()).toEqual({ scheduled: false, version: "1.0.1" });
  const beforeResume = host.calls.length;
  host.deliver("platform.lifecycle", { state: "onResume" });
  await settle();
  expect(host.calls.length).toBeGreaterThan(beforeResume);
  client.dispose();
});

test("unconfigured hosts are left running without check or apply", async () => {
  const host = new UpdateHost();
  host.snapshot = { ...host.snapshot, configured: false, stage: "not_configured" };
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  expect(host.calls.map((call) => call.capability)).toEqual(["updates.status"]);
  expect(await client.refresh()).toEqual({ scheduled: false, version: "1.0.0" });
  client.dispose();
});

test("verification failure never applies and retries only on a later lifecycle event", async () => {
  const host = new UpdateHost();
  const failure = new Error("signature verification failed");
  host.checkError = failure;
  const errors: unknown[] = [];
  const client = createPocketUpdateClient(host, { autoRefresh: true, onError: (error) => errors.push(error) });
  await settle();
  expect(errors).toEqual([failure]);
  expect(host.calls.some((call) => call.capability === "updates.apply")).toBe(false);
  const beforeResume = host.calls.length;
  await settle();
  expect(host.calls).toHaveLength(beforeResume);
  host.checkError = undefined;
  host.deliver("platform.lifecycle", { state: "onResume" });
  await settle();
  expect(host.calls.some((call) => call.capability === "updates.apply")).toBe(true);
  client.dispose();
});

test("disposal while downloading prevents apply and removes the lifecycle listener", async () => {
  const host = new UpdateHost();
  let finish!: () => void;
  host.waitForDownload = new Promise<void>((resolve) => { finish = resolve; });
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  client.dispose();
  expect(host.listeners.size).toBe(0);
  finish();
  await settle();
  expect(host.calls.some((call) => call.capability === "updates.apply")).toBe(false);
  await expect(client.refresh()).rejects.toMatchObject({ code: "update-client-disposed" });
});

test("a new guest restores the UI checkpoint created by refresh", async () => {
  const saved = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => saved.get(key) ?? null,
    set: async (key: string, value: unknown) => { saved.set(key, value); },
    remove: async (key: string) => { saved.delete(key); },
  };
  const host = new UpdateHost();
  let count = 3;
  const old = createPocketUpdateClient(host, { state: {
    key: "update.ui", schema: "ui/1", storage,
    capture: () => ({ count }), restore: () => false,
  } });
  expect(await old.refresh()).toEqual({ scheduled: true, version: "1.0.1" });
  expect(host.calls.find((call) => call.capability === "updates.apply")?.params)
    .toEqual({ expectedVersion: "1.0.1", expectedBuild: 2 });
  old.dispose();

  count = 0;
  const nextHost = new UpdateHost();
  nextHost.snapshot = { ...nextHost.snapshot, activeVersion: "1.0.1", activeBuild: 2, stage: "loading" };
  const next = createPocketUpdateClient(nextHost, { state: {
    key: "update.ui", schema: "ui/1", storage,
    capture: () => ({ count }),
    restore: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.count !== "number") return false;
      count = value.count;
      return true;
    },
  } });
  expect(await next.ready).toBe(true);
  expect(count).toBe(3);
  next.dispose();
});

test("a checkpoint write failure leaves the existing guest active", async () => {
  const host = new UpdateHost();
  const failure = new Error("storage unavailable");
  const client = createPocketUpdateClient(host, { state: {
    key: "update.ui", schema: "ui/1",
    storage: { get: async () => null, set: async () => { throw failure; }, remove: async () => {} },
    capture: () => ({ count: 3 }), restore: () => false,
  } });
  await expect(client.refresh()).rejects.toBe(failure);
  expect(host.calls.some((call) => call.capability === "updates.apply")).toBe(false);
  client.dispose();
});

test("manual apply and automatic refresh share a scheduled activation", async () => {
  const host = new UpdateHost();
  const client = createPocketUpdateClient(host);
  await client.check();
  const first = client.apply();
  expect(client.apply()).toBe(first);
  expect(client.refresh()).toBe(first);
  await first;
  expect(client.apply()).toBe(first);
  expect(host.calls.filter((call) => call.capability === "updates.apply")).toHaveLength(1);
  client.dispose();
});

test("recovery health does not immediately reactivate a broken release", async () => {
  const host = new UpdateHost();
  host.snapshot = { ...host.snapshot, lastError: "Guest failed before health readiness" };
  const client = createPocketUpdateClient(host, { autoRefresh: true });
  await settle();
  host.deliver("updates.changed", { stage: "ready" });
  await settle();
  expect(host.calls.some((call) => call.capability === "updates.check")).toBe(false);
  host.deliver("platform.lifecycle", { state: "onResume" });
  await settle();
  expect(host.calls.filter((call) => call.capability === "updates.apply")).toHaveLength(1);
  client.dispose();
});
