import { expect, test } from "bun:test";
import { PocketWechatHost } from "../../targets/wechat/template/wechat-host.js";
import { decodeMessage } from "../../targets/wechat/template/binary-bridge.js";

function boundary(capability: string, handler: (params: unknown, context: any) => unknown) {
  const replies: any[] = [];
  const host = new PocketWechatHost({ wx: {}, canvas: {}, config: { requires: [capability] }, capabilityHandlers: { [capability]: handler } });
  host.exports = {}; host.host = 1; host.visible = true;
  host.deliverResponse = (bytes: Uint8Array) => replies.push(decodeMessage(bytes, 4 * 1024 * 1024).payload);
  return { host, replies };
}

function scheduledHost() {
  const capability = "media.live2d.model.update";
  const host = new PocketWechatHost({ wx: {}, canvas: {}, config: { requires: [capability] } });
  host.host = 1;
  host.visible = true;
  host.exports = { web_wechat_deliver: () => 0, web_destroy: () => {} };
  host.withBytes = (_bytes: Uint8Array, callback: (pointer: number, length: number) => unknown) => callback(1, _bytes.byteLength);
  host.drainOutbound = () => {};
  host.schedule = () => {};
  return host;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("scheduled Guest frame did not run before timeout");
    await delay(1);
  }
}

test("host transports bounded PMS1 responses above 64 KiB and uses real browser AbortSignal", async () => {
  const capability = "media.live2d.model.update";
  const one = boundary(capability, (_params, context) => {
    expect(context.signal instanceof AbortSignal).toBe(true);
    return { meshBytes: new Uint8Array(100_000).fill(123) };
  });
  const two = boundary(capability, () => ({ owner: "second" }));
  await one.host.handleRequest({ requestId: "one", capability, params: {} });
  await two.host.handleRequest({ requestId: "two", capability, params: {} });
  expect(one.replies[0].result.meshBytes).toEqual(new Uint8Array(100_000).fill(123));
  expect(two.replies[0].result).toEqual({ owner: "second" });
  expect(one.host.pending.size).toBe(0);
  expect(two.host.pending.size).toBe(0);
});

test("oversized host replies reject finitely instead of deleting the pending response before encoding", async () => {
  for (const capability of ["test.bounded", "media.live2d.model.update"]) {
    const { host, replies } = boundary(capability, () => ({ bytes: new Uint8Array(capability.startsWith("media.") ? 4 * 1024 * 1024 : 100_000) }));
    await host.handleRequest({ requestId: "oversized", capability, params: {} });
    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error.message).toContain("size limit");
    expect(host.pending.size).toBe(0);
  }
});

test("fast local provider responses yield to the Guest frame interval", async () => {
  const host = scheduledHost();
  const packet = new Uint8Array([1]);
  const frameTimes: number[] = [];
  host.advance = () => {
    frameTimes.push(Date.now());
    if (frameTimes.length < 4) queueMicrotask(() => host.deliverResponse(packet));
  };

  let heartbeat = false;
  const heartbeatReady = new Promise<void>(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 0));
  host.deliverResponse(packet);
  expect(frameTimes).toHaveLength(0);
  await heartbeatReady;
  expect(heartbeat).toBe(true);
  expect(frameTimes).toHaveLength(0);

  await waitFor(() => frameTimes.length === 4);
  expect(frameTimes).toHaveLength(4);
  for (let index = 1; index < frameTimes.length; index += 1) {
    expect(frameTimes[index]! - frameTimes[index - 1]!).toBeGreaterThanOrEqual(12);
  }
  host.dispose();
});

test("deferred host responses coalesce onto an already scheduled active frame", async () => {
  const host = scheduledHost();
  let frames = 0;
  host.workState = () => ({ continuous: true });
  host.advance = () => { frames += 1; };
  PocketWechatHost.prototype.schedule.call(host);
  const scheduledFrame = host.raf;
  expect(host.running).toBe(true);
  expect(scheduledFrame).not.toBe(0);

  // Keep the callback's post-frame scheduling inert after setting up the real
  // existing near-frame timer.
  host.schedule = () => {};
  host.deliverResponse(new Uint8Array([1]));
  expect(host.raf).toBe(scheduledFrame);
  expect(host.timer).toBe(0);
  await waitFor(() => frames === 1);
  expect(frames).toBe(1);
  host.dispose();
});

test("deferred response frames are canceled by hide and dispose", async () => {
  for (const cleanup of ["hide", "dispose"] as const) {
    const host = scheduledHost();
    let frames = 0;
    host.advance = () => { frames += 1; };
    host.deliverResponse(new Uint8Array([1]));
    expect(host.timer).not.toBe(0);
    expect(host.running).toBe(true);

    if (cleanup === "hide") host.hide();
    else host.dispose();
    expect(host.timer).toBe(0);
    expect(host.running).toBe(false);
    await delay(20);
    expect(frames).toBe(0);
    if (cleanup === "hide") host.dispose();
  }
});
