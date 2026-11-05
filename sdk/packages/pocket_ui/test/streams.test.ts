import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createHostBridge, type JsonObject } from "../src/host.ts";
import {
  createPocketStreamAdapter,
  POCKET_STREAM_MAX_BATCH_BYTES,
  POCKET_STREAM_MAX_BATCH_EVENTS,
  type PocketStream,
  PocketStreamError,
} from "../src/streams.ts";

type Packet = {
  type?: string;
  name?: string;
  payload?: JsonObject;
};

function wire(): {
  host: ReturnType<typeof createHostBridge>;
  packets: Packet[];
} {
  const packets: Packet[] = [];
  const host = createHostBridge((line) => {
    packets.push(JSON.parse(line) as Packet);
    return true;
  });
  return { host, packets };
}

function event(name: string, payload: JsonObject): string {
  return JSON.stringify({ type: "event", name, payload });
}

function packetPayload(packet: Packet): JsonObject {
  assert.ok(packet.payload && typeof packet.payload === "object");
  return packet.payload!;
}

test("identical sensor samples in one turn remain distinct events", async () => {
  const { host } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("hardware.sensors.watch");
    const packet = event("stream.data", { streamId: stream.id, data: { x: 0, y: 0, z: 1 } });
    host.handle(packet);
    host.handle(packet);
    assert.deepEqual(await stream.read(), { x: 0, y: 0, z: 1 });
    assert.deepEqual(await Promise.race([stream.read(), Promise.resolve("missing sample")]), { x: 0, y: 0, z: 1 });
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("independent adapters do not collide on stream IDs", async () => {
  const { host } = wire();
  const first = createPocketStreamAdapter(host);
  const second = createPocketStreamAdapter(host);
  try {
    const a = first.open("hardware.sensors.watch");
    const b = second.open("platform.links.events");
    assert.notEqual(a.id, b.id);
    host.handle(event("stream.data", { streamId: a.id, data: 3 }));
    host.handle(event("stream.data", { streamId: b.id, data: 8 }));
    assert.equal(await a.read(), 3);
    assert.equal(await b.read(), 8);
  } finally {
    first.dispose();
    second.dispose();
    host.dispose();
  }
});

test("host-originated streams have one adapter owner and release it on dispose", async () => {
  const { host, packets } = wire();
  const idle = createPocketStreamAdapter(host);
  const first = createPocketStreamAdapter(host);
  const second = createPocketStreamAdapter(host);
  let firstIncoming: PocketStream | undefined;
  let secondIncoming: PocketStream | undefined;
  const removeFirst = first.onStream((stream) => { firstIncoming = stream; });
  const removeSecond = second.onStream((stream) => { secondIncoming = stream; });
  try {
    host.handle(event("stream.open", { streamId: "host-stream-shared", topic: "sensor" }));
    assert.equal(idle.get("host-stream-shared"), undefined, "an adapter without a listener must not claim the stream");
    assert.ok(firstIncoming);
    assert.equal(secondIncoming, undefined, "the second adapter must not duplicate the host stream");
    host.handle(event("stream.data", { streamId: "host-stream-shared", data: 1 }));
    assert.equal(await firstIncoming!.read(), 1);
    first.dispose("first_disposed");
    assert.equal(
      packets.filter((packet) => packet.name === "stream.cancel" && packet.payload?.streamId === "host-stream-shared").length,
      1,
      "only the owner may cancel the remote stream",
    );

    // Ownership is released after disposal. A retransmitted host open may be
    // claimed by the remaining adapter, while an adapter with no listener does
    // not claim it at all.
    host.handle(event("stream.open", { streamId: "host-stream-shared", topic: "sensor" }));
    assert.ok(secondIncoming, "the remaining listening adapter may claim a reopened stream");
    second.dispose("second_disposed");
    removeFirst();
    removeSecond();
  } finally {
    first.dispose();
    second.dispose();
    idle.dispose();
    host.dispose();
  }
});

test("sendBatch rejects count and UTF-8 byte overflow before sending", () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("batch-boundary");
    const batchCount = (): number => packets.filter((packet) => packet.name === "stream.batch").length;
    const beforeCount = batchCount();
    assert.throws(
      () => stream.sendBatch(Array.from({ length: POCKET_STREAM_MAX_BATCH_EVENTS + 1 }, () => 1)),
      (error: unknown) => error instanceof PocketStreamError && error.code === "stream_batch_too_large",
    );
    assert.equal(batchCount(), beforeCount, "count rejection must not emit a batch");
    assert.equal(stream.state, "open");

    // The bounded preflight must reject a huge string without first building a
    // complete JSON string for the item or the enclosing batch.
    const huge = "x".repeat(POCKET_STREAM_MAX_BATCH_BYTES + 1024);
    assert.throws(
      () => stream.sendBatch([huge]),
      (error: unknown) => error instanceof PocketStreamError && error.code === "stream_batch_too_large",
    );
    assert.equal(batchCount(), beforeCount, "byte rejection must not emit a batch");
    assert.equal(stream.state, "open");

    assert.equal(stream.sendBatch(["small"]), true);
    assert.equal(batchCount(), beforeCount + 1);
    const packet = packets.at(-1);
    assert.equal(packet?.name, "stream.batch");
    assert.ok(JSON.stringify(packet).length < POCKET_STREAM_MAX_BATCH_BYTES);
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("sendBatch rejects toJSON and accessors before the host stringify pass", () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("batch-json-shape");
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.value = 1;
    const valid = streams.open("batch-json-valid");
    assert.equal(valid.sendBatch([{ value: 1 }, nullPrototype as never]), true);
    const beforeRejectedBatches = packets.filter((packet) => packet.name === "stream.batch").length;

    const hiddenToJson: Record<string, unknown> = { value: 1 };
    Object.defineProperty(hiddenToJson, "toJSON", {
      configurable: true,
      enumerable: false,
      value: () => ({ value: "expanded" }),
    });
    assert.throws(
      () => stream.sendBatch([hiddenToJson as never]),
      (error: unknown) => error instanceof TypeError,
    );

    const inheritedToJson = Object.create({ toJSON: () => ({ value: "expanded" }) }) as Record<string, unknown>;
    inheritedToJson.value = 1;
    assert.throws(
      () => stream.sendBatch([inheritedToJson as never]),
      (error: unknown) => error instanceof TypeError,
    );

    let getterReads = 0;
    const getterValue: Record<string, unknown> = {};
    Object.defineProperty(getterValue, "value", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "should-not-run";
      },
    });
    assert.throws(
      () => stream.sendBatch([getterValue as never]),
      (error: unknown) => error instanceof TypeError,
    );
    assert.equal(getterReads, 0, "preflight must reject accessors without reading them");
    assert.equal(
      packets.filter((packet) => packet.name === "stream.batch").length,
      beforeRejectedBatches,
      "shape rejection must not emit a batch",
    );
    assert.equal(stream.state, "open");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("official deadline scheduling expires an idle stream without frame polling", async () => {
  let deadline: (() => void) | undefined;
  let cancellations = 0;
  const host = createHostBridge(() => true, {
    scheduleTimeout: (frames, callback) => {
      assert.equal(frames, 12);
      deadline = callback;
      return () => { cancellations++; };
    },
  });
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("test.wait", {}, { deadlineFrames: 12 });
    host.tick();
    assert.equal(stream.state, "open");
    host.handle(event("stream.data", { streamId: stream.id, data: 1 }));
    assert.equal(cancellations, 1);
    assert.equal(await stream.read(), 1);
    deadline!();
    assert.equal(stream.state, "errored");
    await assert.rejects(stream.read(), (error: unknown) => error instanceof PocketStreamError && error.code === "stream_deadline");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("resident streams and pending readers are bounded", async () => {
  const { host } = wire();
  const streams = createPocketStreamAdapter(host, { maxActiveStreams: 1, maxBufferedMessages: 1 });
  try {
    const stream = streams.open("test.watch");
    assert.throws(() => streams.open("test.other"), (error: unknown) => error instanceof PocketStreamError && error.code === "stream_quota");
    const pending = stream.read();
    const excess = stream.read();
    const results = await Promise.allSettled([pending, excess]);
    assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "stream_read_quota"), true);
    assert.equal(stream.state, "errored");
    const replacement = streams.open("test.replacement");
    replacement.cancel();
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("breaking an async iterator cancels its native producer", async () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("hardware.sensors.watch");
    host.handle(event("stream.data", { streamId: stream.id, data: [1, 2, 3] }));
    for await (const value of stream) {
      assert.deepEqual(value, [1, 2, 3]);
      break;
    }
    assert.equal(stream.state, "cancelled");
    assert.equal(packets.at(-1)?.name, "stream.cancel");
    assert.equal(packets.at(-1)?.payload?.reason, "iterator_closed");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("PocketStream uses the real host event envelope and supports data/end/batch", async () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open<{ uri: string }>("platform.links.events", {
      source: "test",
    });
    assert.equal(packets[0]?.name, "stream.open");
    const open = packetPayload(packets[0]!);
    assert.equal(open.streamId, stream.id);
    assert.equal(open.topic, "platform.links.events");
    assert.deepEqual(open.params, { source: "test" });

    host.handle(
      event("stream.data", {
        streamId: stream.id,
        data: { uri: "pocket://first" },
      }),
    );
    assert.deepEqual(await stream.read(), { uri: "pocket://first" });

    host.handle(
      event("stream.batch", {
        events: [
          {
            method: "stream.data",
            params: { streamId: stream.id, data: { uri: "pocket://second" } },
          },
          {
            method: "stream.data",
            params: { streamId: stream.id, data: { uri: "pocket://third" } },
          },
          { method: "stream.end", params: { streamId: stream.id } },
        ],
      }),
    );
    assert.deepEqual(await stream.read(), { uri: "pocket://second" });
    assert.deepEqual(await stream.read(), { uri: "pocket://third" });
    assert.equal(await stream.read(), undefined);
    assert.equal(stream.state, "ended");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("PocketStream sends batches and isolates guest IDs from host-owned IDs", () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    assert.throws(
      () => streams.open("example", {}, { id: "host-stream-1" }),
      (error: unknown) =>
        error instanceof PocketStreamError &&
        error.code === "stream_id_conflict",
    );
    const stream = streams.open("example");
    assert.equal(stream.send("one"), true);
    assert.equal(stream.sendBatch(["two", "three"]), true);
    assert.equal(packets.at(-1)?.name, "stream.batch");
    assert.equal(stream.end("done"), true);
    assert.equal(packets.at(-1)?.name, "stream.end");
    assert.equal(stream.state, "ended");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("incoming host streams, cancellation, late packets, and bounded overflow are deterministic", async () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host, { maxBufferedMessages: 1 });
  try {
    let incoming: PocketStream | undefined;
    streams.onStream((stream) => {
      incoming = stream;
    });
    host.handle(
      event("stream.open", {
        streamId: "host-stream-7",
        topic: "sensor.readings",
        params: { sensor: "accelerometer" },
      }),
    );
    assert.ok(incoming);
    assert.equal(incoming!.topic, "sensor.readings");
    host.handle(
      event("stream.data", { streamId: "host-stream-7", value: { x: 1 } }),
    );
    assert.deepEqual(await incoming!.read(), { x: 1 });
    const pending = incoming!.read();
    host.handle(
      event("stream.cancel", { streamId: "host-stream-7", reason: "revoked" }),
    );
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof PocketStreamError && error.code === "stream_cancelled",
    );
    host.handle(event("stream.end", { streamId: "host-stream-7" }));
    assert.equal(incoming!.state, "cancelled");

    const remoteError = streams.open("remote-error");
    const pendingError = remoteError.read();
    host.handle(
      event("stream.error", {
        streamId: remoteError.id,
        error: { code: "provider_failed", message: "provider stopped" },
      }),
    );
    await assert.rejects(
      pendingError,
      (error: unknown) =>
        error instanceof PocketStreamError && error.code === "provider_failed",
    );
    host.handle(event("stream.end", { streamId: remoteError.id }));
    assert.equal(remoteError.state, "errored");

    const bounded = streams.open("bounded");
    host.handle(event("stream.data", { streamId: bounded.id, data: "first" }));
    host.handle(event("stream.data", { streamId: bounded.id, data: "second" }));
    assert.equal(bounded.state, "errored");
    await assert.rejects(
      bounded.read(),
      (error: unknown) =>
        error instanceof PocketStreamError &&
        error.code === "stream_buffer_overflow",
    );
    const overflow = packets.find(
      (packet) =>
        packet.name === "stream.error" &&
        packet.payload?.streamId === bounded.id,
    );
    assert.equal(
      overflow?.payload?.error && (overflow.payload.error as JsonObject).code,
      "stream_buffer_overflow",
    );

    const destroyed = streams.open("destroyed");
    const pendingDestroyed = destroyed.read();
    streams.dispose("guest_destroyed");
    await assert.rejects(
      pendingDestroyed,
      (error: unknown) =>
        error instanceof PocketStreamError && error.code === "stream_disposed",
    );
    host.handle(event("stream.data", { streamId: destroyed.id, data: "late" }));
    assert.equal(destroyed.state, "disposed");
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("stream deadlines use HostBridge.tick without timers", async () => {
  const { host, packets } = wire();
  const streams = createPocketStreamAdapter(host);
  try {
    const stream = streams.open("deadline", {}, { deadlineFrames: 2 });
    host.tick();
    assert.equal(stream.state, "open");
    host.tick();
    assert.equal(stream.state, "errored");
    await assert.rejects(
      stream.read(),
      (error: unknown) =>
        error instanceof PocketStreamError && error.code === "stream_deadline",
    );
    assert.ok(
      packets.some(
        (packet) =>
          packet.name === "stream.error" &&
          packet.payload?.streamId === stream.id,
      ),
    );
  } finally {
    streams.dispose();
    host.dispose();
  }
});

test("HostBridge uses pocket._emitValue directly and marks __pocketEvent/__pocketDeliver __binaryCapable", async () => {
  const globalObject = globalThis as typeof globalThis & {
    pocket?: {
      _emit?: (line: string) => boolean;
      _emitValue?: (packet: Record<string, unknown>) => boolean;
    };
    __pocketEvent?: ((packet: string | Record<string, unknown>) => void) & { __binaryCapable?: boolean };
    __pocketDeliver?: ((packet: string | Record<string, unknown>) => void) & { __binaryCapable?: boolean };
  };
  const previousPocket = globalObject.pocket;
  const previousEvent = globalObject.__pocketEvent;
  const previousDeliver = globalObject.__pocketDeliver;

  const emittedObjects: Record<string, unknown>[] = [];
  let legacyStringCalls = 0;
  let lastLegacyParsed: Record<string, unknown> | undefined;

  const legacyPrevious = (line: string | Record<string, unknown>) => {
    assert.equal(typeof line, "string");
    lastLegacyParsed = JSON.parse(line as string) as Record<string, unknown>;
    legacyStringCalls += 1;
  };
  globalObject.__pocketEvent = legacyPrevious;
  globalObject.pocket = {
    _emit: () => {
      throw new Error("_emit should not be called when _emitValue is present");
    },
    _emitValue: (packet) => {
      emittedObjects.push(packet);
      return true;
    },
  };

  const host = createHostBridge();

  try {
    assert.equal(globalObject.__pocketEvent?.__binaryCapable, true);
    assert.equal(globalObject.__pocketDeliver?.__binaryCapable, true);

    const requestPromise = host.request<{ echoed: number; bytes: Uint8Array }>(
      "binary.echo",
      { count: 7, bytes: new Uint8Array([1, 2, 3]) },
    );
    assert.equal(emittedObjects.length, 1);
    assert.equal(emittedObjects[0]?.name, "host.request");
    const requestPayload = emittedObjects[0]?.payload as Record<string, unknown>;
    assert.equal(requestPayload.capability, "binary.echo");

    assert.equal(host.emit?.("guest.telemetry", { ok: true, bytes: new Uint8Array([4, 5]) }), true);
    assert.equal(emittedObjects.length, 2);
    assert.equal(emittedObjects[1]?.name, "guest.telemetry");

    let receivedBytes: Uint8Array | undefined;
    host.onEvent?.((ev) => {
      if (ev.method === "host.binary" && ev.params.bytes instanceof Uint8Array) {
        receivedBytes = ev.params.bytes;
      }
    });

    globalObject.__pocketEvent?.({
      type: "event",
      name: "host.binary",
      payload: { bytes: new Uint8Array([9, 8, 7]) },
    });
    assert.deepEqual(Array.from(receivedBytes ?? []), [9, 8, 7]);
    assert.equal(legacyStringCalls, 1);
    assert.deepEqual((lastLegacyParsed?.payload as { bytes?: unknown } | undefined)?.bytes, [9, 8, 7]);

    const streams = createPocketStreamAdapter(host, { idPrefix: "bin-stream" });
    const binStream = streams.open<Uint8Array>("binary.stream", { seed: new Uint8Array([6]) });
    assert.equal(binStream.send(new Uint8Array([11, 22])), true);

    globalObject.__pocketDeliver?.({
      type: "event",
      name: "host.response",
      payload: {
        requestId: requestPayload.requestId,
        capability: "binary.echo",
        ok: true,
        result: { echoed: 7, bytes: new Uint8Array([3, 2, 1]) },
      },
    });
    const echoResult = await requestPromise;
    assert.equal(echoResult.echoed, 7);
    assert.deepEqual(Array.from(echoResult.bytes), [3, 2, 1]);
    streams.dispose();
  } finally {
    host.dispose();
    globalObject.pocket = previousPocket;
    globalObject.__pocketEvent = previousEvent;
    globalObject.__pocketDeliver = previousDeliver;
  }
});
