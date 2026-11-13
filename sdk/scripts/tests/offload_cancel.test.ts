import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const sdk = join(import.meta.dir, "../..");
const bootstrap = spawnSync("python3", [join(sdk, "scripts/prepare_upstream.py")], {
  cwd: sdk,
  encoding: "utf8",
  timeout: 120_000,
});
if (bootstrap.status !== 0) {
  throw new Error(
    `PocketJS bootstrap failed (${bootstrap.status ?? bootstrap.signal}):\n${bootstrap.stdout ?? ""}${bootstrap.stderr ?? ""}`,
  );
}

test("pinned offload client completes provider replies and propagates cancellation", async () => {
  const { createOffloadClient } = await import(
    "../../.cache/pocketjs/framework/src/offload.ts"
  );

  let session = 9;
  let submitted: { id: number; method: string } | undefined;
  let reply: { id: number; payload: string } | undefined;
  const cancellations: Array<[number, number]> = [];
  const client = createOffloadClient({
    session: () => session,
    submitValue(record: { id: number; method: string }) {
      submitted = record;
      return true;
    },
    takeValue() {
      const next = reply;
      reply = undefined;
      return next;
    },
    cancel(id: number, providerSession: number) {
      cancellations.push([id, providerSession]);
    },
  });
  let result: unknown;
  const id = client.request("compute.sum", "1,2,3", (value) => {
    result = value;
  });
  client.step();
  expect(submitted?.method).toBe("compute.sum");
  expect(client.pending()).toBe(1);
  client.cancel(id);
  expect(client.pending()).toBe(0);
  expect(cancellations).toEqual([[id, session]]);

  const completed = client.request("compute.sum", "4,5", (value) => {
    result = value;
  });
  client.step();
  const request = submitted!;
  expect(request.id).toBe(completed);
  reply = { id: completed, payload: "9" };
  client.step();
  expect(result).toEqual({ ok: true, value: "9" });
  expect(client.pending()).toBe(0);
});

test("offload reports a missing provider on its next frame pump", async () => {
  const { createOffloadClient } = await import(
    "../../.cache/pocketjs/framework/src/offload.ts"
  );
  let submits = 0;
  let result: unknown;
  const client = createOffloadClient({
    session: () => 0,
    submitValue() {
      submits++;
      return false;
    },
    takeValue: () => undefined,
  });
  client.request("http.get", "{}", (value) => {
    result = value;
  });
  client.step();
  expect(submits).toBe(0);
  expect(result).toEqual({ ok: false, error: "Provider unavailable" });
  expect(client.pending()).toBe(0);
  expect(client.needsPump()).toBe(false);
});

test("native event-driven offload parks sent requests until a host wake", async () => {
  const { createOffloadClient } = await import(
    "../../.cache/pocketjs/framework/src/offload.ts"
  );
  let submitted: { id: number; method: string } | undefined;
  let reply: { id: number; payload: string } | undefined;
  const ops = {
    eventDriven: true,
    session: () => 11,
    submitValue(record: { id: number; method: string }) {
      submitted = record;
      return true;
    },
    takeValue() {
      const next = reply;
      reply = undefined;
      return next;
    },
  };
  const client = createOffloadClient(ops);
  let result: unknown;
  client.request("compute.sum", "[1,2,3]", (value) => {
    result = value;
  });
  expect(client.needsPump()).toBe(true);
  client.step();
  expect(submitted?.method).toBe("compute.sum");
  expect(client.needsPump()).toBe(false);
  for (let frame = 0; frame < 100; frame++) client.step();
  expect(client.needsPump()).toBe(false);
  expect(result).toBeUndefined();

  const request = submitted!;
  reply = { id: request.id, payload: "6" };
  // In production this step is called by the single NativeCallable wake.
  client.step();
  expect(result).toEqual({ ok: true, value: "6" });
  expect(client.needsPump()).toBe(false);
});

test("disposing an event-driven client forwards cancellation for every sent request", async () => {
  const { createOffloadClient } = await import(
    "../../.cache/pocketjs/framework/src/offload.ts"
  );
  const cancellations: Array<[number, number]> = [];
  const client = createOffloadClient({
    eventDriven: true,
    session: () => 13,
    submitValue: () => true,
    takeValue: () => undefined,
    cancel(id: number, session: number) {
      cancellations.push([id, session]);
    },
  });
  const first = client.request("compute.sum", "[1]", () => {});
  const second = client.request("compute.sum", "[2]", () => {});
  client.step();
  client.dispose();
  expect(cancellations).toEqual([[first, 13], [second, 13]]);
  expect(client.needsPump()).toBe(false);
});
