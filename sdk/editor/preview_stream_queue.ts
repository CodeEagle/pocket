/** Byte-bound the application SSE queue without silently coalescing state edges.
 * A valid oversized packet is admitted once while the queue is within budget
 * (including the small initial status). Further growth fails the connection.
 * The parent must run subscriber cleanup: controller.error does not call cancel.
 * Socket/HTTP/browser buffers are outside this application queue bound.
 */
export const PREVIEW_STREAM_HIGH_WATER_MARK_BYTES = 8 * 1024 * 1024;
export const previewStreamByteLengthStrategy: QueuingStrategy<Uint8Array> = {
  highWaterMark: PREVIEW_STREAM_HIGH_WATER_MARK_BYTES,
  size: chunk => chunk!.byteLength,
};

export class PreviewStreamSlowConsumerError extends Error {
  readonly code = "preview_stream_slow_consumer";
  constructor(readonly packetBytes: number, readonly queuedBytes: number, readonly highWaterMarkBytes: number) {
    super(`preview SSE stream slow consumer overflow: ${queuedBytes} queued bytes + ${packetBytes} packet bytes exceed ${highWaterMarkBytes}`);
    this.name = "PreviewStreamSlowConsumerError";
  }
}

export function enqueuePreviewPacket(
  controller: ReadableStreamDefaultController<Uint8Array>,
  bytes: Uint8Array,
  highWaterMarkBytes = PREVIEW_STREAM_HIGH_WATER_MARK_BYTES,
): void {
  const desiredSize = controller.desiredSize;
  if (desiredSize === null) throw new Error("preview SSE stream is closed or cancelled");
  const queuedBytes = Math.max(0, highWaterMarkBytes - desiredSize);
  const oversized = bytes.byteLength > highWaterMarkBytes && queuedBytes <= highWaterMarkBytes;
  if (!oversized && queuedBytes > 0 && queuedBytes + bytes.byteLength > highWaterMarkBytes) {
    const error = new PreviewStreamSlowConsumerError(bytes.byteLength, queuedBytes, highWaterMarkBytes);
    controller.error(error);
    throw error;
  }
  controller.enqueue(bytes);
}
