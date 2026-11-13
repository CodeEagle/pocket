import { expect, test } from "bun:test";
import { decodeMessage } from "../targets/wechat/template/binary-bridge.js";
import { PocketWechatHost, registerCapability, setPermissionHandler } from "../targets/wechat/template/wechat-host.js";

function createFakeHost(overrides?: {
  onInput?: (state: Record<string, unknown>) => void;
  hideKeyboard?: (opts: { complete?: () => void }) => void;
}) {
  const host = new PocketWechatHost({
    wx: overrides?.hideKeyboard ? { hideKeyboard: overrides.hideKeyboard } : {},
    config: { appId: "wechat-target-test", requires: ["test.cap"] },
    canvas: { width: 1, height: 1 },
    context: { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) },
    onInput: overrides?.onInput ?? (() => {}),
    onError: (error: unknown) => { throw error; },
    isActive: () => true,
  });
  const memory = new ArrayBuffer(64 * 1024);
  host.exports = {
    memory: { buffer: memory },
    web_alloc: () => 1,
    web_free: () => {},
    web_wechat_deliver: () => 0,
    web_wechat_guest_event: () => 0,
    web_destroy: () => {},
  } as any;
  host.host = 1;
  host.visible = true;
  return host;
}

test("hide() rejects reentrant requests emitted synchronously during cancelPending", async () => {
  const host = createFakeHost();
  const unregister = registerCapability("test.cap", () => new Promise(() => {}));
  setPermissionHandler(() => true);

  const deliveredPackets: Array<Record<string, any>> = [];
  let emittedReentrant = false;
  const originalDeliverResponse = host.deliverResponse.bind(host);
  host.deliverResponse = (packet: Uint8Array) => {
    const parsed = decodeMessage(packet);
    deliveredPackets.push(parsed);
    if (!emittedReentrant && parsed.payload?.requestId === "in-flight") {
      emittedReentrant = true;
      host.outbound.push({
        type: "event",
        name: "host.request",
        payload: { requestId: "reentrant-from-catch", capability: "test.cap", params: {} },
      });
    }
    originalDeliverResponse(packet);
  };

  host.pending.set("in-flight", {
    request: { requestId: "in-flight", capability: "test.cap" },
    generation: host.generation,
    timer: 0,
    cancelled: false,
    controller: {
      abort: () => {
        void host.handleRequest({ requestId: "reentrant-from-abort", capability: "test.cap", params: {} });
      },
    },
  } as any);

  try {
    host.hide();
    await Promise.resolve();
    expect(host.visible).toBe(false);
    expect(host.pending.size).toBe(0);
    expect(deliveredPackets.map((packet) => ({
      requestId: packet.payload?.requestId,
      ok: packet.payload?.ok,
      code: packet.payload?.error?.code,
    }))).toEqual([
      { requestId: "reentrant-from-abort", ok: false, code: "cancelled" },
      { requestId: "in-flight", ok: false, code: "cancelled" },
      { requestId: "reentrant-from-catch", ok: false, code: "cancelled" },
    ]);
  } finally {
    unregister();
    setPermissionHandler(null);
  }
});

test("dispose() closes active IME input and hides the WeChat keyboard when called directly", () => {
  const inputStates: Array<Record<string, unknown>> = [];
  let hideKeyboardCalls = 0;
  const host = createFakeHost({
    onInput: (state) => inputStates.push(state),
    hideKeyboard: (opts) => {
      hideKeyboardCalls += 1;
      opts.complete?.();
    },
  });

  host.openInput({
    id: "input-1",
    editingSession: 1,
    revision: 0,
    jsRevision: 1,
    text: "hello",
  });
  expect(host.input).not.toBeNull();
  expect(inputStates.at(-1)?.visible).toBe(true);

  host.dispose();
  expect(host.disposed).toBe(true);
  expect(host.input).toBeNull();
  expect(inputStates.at(-1)).toEqual({ visible: false });
  expect(hideKeyboardCalls).toBe(1);
});
