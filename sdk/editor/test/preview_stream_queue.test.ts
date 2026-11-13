import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  PREVIEW_STREAM_HIGH_WATER_MARK_BYTES,
  PreviewStreamSlowConsumerError,
  enqueuePreviewPacket,
  previewStreamByteLengthStrategy,
} from "../preview_stream_queue.ts";

const createPreviewStreamStrategy = (highWaterMark: number): QueuingStrategy<Uint8Array> => ({ highWaterMark, size: chunk => chunk!.byteLength });

test("consuming reader preserves exact packet ordering and drains desiredSize", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
    },
    previewStreamByteLengthStrategy,
  );
  const reader = stream.getReader();

  const messages = [
    `data: ${JSON.stringify({ type: "status", status: { state: "ready" } })}\n\n`,
    `data: ${JSON.stringify({ type: "frame", revision: 1, frame: { frame: 1, events: [{ name: "textInput.open" }] } })}\n\n`,
    `data: ${JSON.stringify({ type: "frame", revision: 1, frame: { frame: 2, presentationTokens: ["tok-1"] } })}\n\n`,
    `data: ${JSON.stringify({ type: "frame", revision: 1, frame: { frame: 3, releasedResources: ["atlas-0"] } })}\n\n`,
  ];

  for (const msg of messages) {
    enqueuePreviewPacket(streamController, encoder.encode(msg));
  }

  const received: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received.push(decoder.decode(chunk.value));
  }

  assert.deepEqual(received, messages);
  assert.equal(streamController.desiredSize, PREVIEW_STREAM_HIGH_WATER_MARK_BYTES);
  await reader.cancel();
});

test("undrained stream fails predictably at bounded byte queue and errors the reader", async () => {
  const hwm = 1024;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let cancelCalled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelCalled = true;
      },
    },
    createPreviewStreamStrategy(hwm),
  );
  const reader = stream.getReader();

  const chunk400 = new Uint8Array(400).fill(0x61);
  enqueuePreviewPacket(streamController, chunk400, hwm);
  assert.equal(streamController.desiredSize, 624);

  enqueuePreviewPacket(streamController, chunk400, hwm);
  assert.equal(streamController.desiredSize, 224);

  const chunk300 = new Uint8Array(300).fill(0x62);
  let thrown: unknown;
  try {
    enqueuePreviewPacket(streamController, chunk300, hwm);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof PreviewStreamSlowConsumerError);
  assert.equal(thrown.code, "preview_stream_slow_consumer");
  assert.equal(thrown.packetBytes, 300);
  assert.equal(thrown.queuedBytes, 800);
  assert.equal(thrown.highWaterMarkBytes, hwm);

  // Underlying source cancel() is NOT called automatically by controller.error();
  // parent must explicitly clean up subscriber state on catch.
  assert.equal(cancelCalled, false);

  await assert.rejects(async () => {
    await reader.read();
    await reader.read();
    await reader.read();
  }, /preview SSE stream slow consumer overflow/);
});

test("allows one oversized packet when queue is empty, then overflows on next packet if undrained", async () => {
  const hwm = 1024;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
    },
    createPreviewStreamStrategy(hwm),
  );
  const reader = stream.getReader();

  // First packet exceeds HWM (simulating a large valid replay frame or atlas update when queue is empty).
  const oversized = new Uint8Array(2500).fill(0x78);
  enqueuePreviewPacket(streamController, oversized, hwm);
  assert.equal(streamController.desiredSize, hwm - oversized.byteLength);

  // While undrained, even a tiny status/control packet must fail immediately rather than growing unboundedly.
  const statusPacket = new TextEncoder().encode(`data: {"type":"status"}\n\n`);
  assert.throws(
    () => enqueuePreviewPacket(streamController, statusPacket, hwm),
    (error: unknown) =>
      error instanceof PreviewStreamSlowConsumerError &&
      error.queuedBytes === oversized.byteLength &&
      error.packetBytes === statusPacket.byteLength,
  );

  await assert.rejects(() => reader.read(), /preview SSE stream slow consumer overflow/);
});

test("oversized packet drained by reader restores capacity for subsequent status and frame packets", async () => {
  const hwm = 1024;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
    },
    createPreviewStreamStrategy(hwm),
  );
  const reader = stream.getReader();

  const oversized = new Uint8Array(2048).fill(0x31);
  enqueuePreviewPacket(streamController, oversized, hwm);
  assert.ok((streamController.desiredSize ?? 0) < 0);

  const firstRead = await reader.read();
  assert.equal(firstRead.done, false);
  assert.equal(firstRead.value?.byteLength, 2048);
  assert.equal(streamController.desiredSize, hwm);

  const nextPacket = new Uint8Array(512).fill(0x32);
  enqueuePreviewPacket(streamController, nextPacket, hwm);
  assert.equal(streamController.desiredSize, 512);

  const secondRead = await reader.read();
  assert.equal(secondRead.done, false);
  assert.equal(secondRead.value?.byteLength, 512);
  await reader.cancel();
});

test("closed or cancelled controller throws deterministically without busy loops or timers", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
    },
    previewStreamByteLengthStrategy,
  );
  const reader = stream.getReader();
  await reader.cancel();

  assert.throws(
    () => enqueuePreviewPacket(streamController, new Uint8Array([1, 2, 3])),
    /closed|cancelled|overflow/i,
  );

  let closedController!: ReadableStreamDefaultController<Uint8Array>;
  new ReadableStream<Uint8Array>(
    {
      start(controller) {
        closedController = controller;
      },
    },
    previewStreamByteLengthStrategy,
  );
  closedController.close();
  assert.throws(
    () => enqueuePreviewPacket(closedController, new Uint8Array([1])),
    /closed|cancelled|overflow/i,
  );

  // Also verify exact-HWM open queue overflow (desiredSize === 0 while still open)
  // vs closed/cancelled stream (desiredSize === 0 after close/cancel).
  const exactHwm = 256;
  let exactController!: ReadableStreamDefaultController<Uint8Array>;
  const exactStream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        exactController = controller;
      },
    },
    createPreviewStreamStrategy(exactHwm),
  );
  const exactReader = exactStream.getReader();
  enqueuePreviewPacket(exactController, new Uint8Array(exactHwm), exactHwm);
  assert.equal(exactController.desiredSize, 0);
  assert.throws(
    () => enqueuePreviewPacket(exactController, new Uint8Array([1]), exactHwm),
    (error: unknown) =>
      error instanceof PreviewStreamSlowConsumerError &&
      error.queuedBytes === exactHwm &&
      error.packetBytes === 1,
  );
  await assert.rejects(() => exactReader.read(), /preview SSE stream slow consumer overflow/);
});
