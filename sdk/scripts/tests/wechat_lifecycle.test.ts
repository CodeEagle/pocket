import { expect, test } from "bun:test";
import { PocketWechatHost, registerCapability, setPermissionHandler } from "../../targets/wechat/template/wechat-host.js";

type Fake = PocketWechatHost & { destroyCalls: number };

function fakeHost(): Fake {
  const host = new PocketWechatHost({
    wx: {},
    config: { appId: "lifecycle", requires: ["test.cap"] },
    canvas: { width: 1, height: 1 },
    context: { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) },
    onInput: () => {},
    onError: (error: unknown) => { throw error; },
    isActive: () => true,
  }) as Fake;
  const memory = new ArrayBuffer(64 * 1024);
  host.destroyCalls = 0;
  host.exports = {
    memory: { buffer: memory },
    web_alloc: () => 1,
    web_free: () => {},
    web_wechat_deliver: () => 0,
    web_wechat_guest_event: () => 0,
    web_destroy: () => { host.destroyCalls += 1; },
  } as any;
  host.host = 1;
  host.visible = true;
  return host;
}

test("dispose rejects reentrant host requests and destroys the WASM host once", async () => {
  const host = fakeHost();
  const unregister = registerCapability("test.cap", () => new Promise(() => {}));
  setPermissionHandler(() => true);
  host.exports.web_wechat_deliver = () => {
    host.outbound.push(JSON.stringify({
      type: "event",
      name: "host.request",
      payload: { requestId: "reentrant", capability: "test.cap", params: {} },
    }));
    host.drainOutbound();
    return 0;
  };
  host.pending.set("original", {
    request: { requestId: "original", capability: "test.cap" },
    timer: 0,
    cancelled: false,
    controller: { abort: () => {
      void host.handleRequest({ requestId: "from-abort", capability: "test.cap", params: {} });
      host.dispose();
    } },
  } as any);

  try {
    host.dispose();
    await Promise.resolve();
    expect(host.disposed).toBe(true);
    expect(host.pending.size).toBe(0);
    expect(host.destroyCalls).toBe(1);
    host.dispose();
    expect(host.destroyCalls).toBe(1);
  } finally {
    unregister();
    setPermissionHandler(null);
  }
});

test("one abort failure does not prevent remaining pending requests from being cancelled", () => {
  const host = fakeHost();
  host.pending.set("throws", {
    request: { requestId: "throws", capability: "test.cap" }, timer: 0, cancelled: false,
    controller: { abort: () => { throw new Error("provider abort failed"); } },
  } as any);
  let secondAbort = 0;
  host.pending.set("continues", {
    request: { requestId: "continues", capability: "test.cap" }, timer: 0, cancelled: false,
    controller: { abort: () => { secondAbort += 1; } },
  } as any);

  host.cancelPending("page inactive");
  expect(secondAbort).toBe(1);
  expect(host.pending.size).toBe(0);
});

test("native destroy failure still releases host references and prevents double destruction", () => {
  const host = fakeHost();
  host.exports.web_destroy = () => { host.destroyCalls += 1; throw new Error("destroy failed"); };
  expect(() => host.dispose()).toThrow("destroy failed");
  expect(host.host).toBe(0);
  expect(host.exports).toBeNull();
  expect(host.instance).toBeNull();
  expect(() => host.dispose()).not.toThrow();
  expect(host.destroyCalls).toBe(1);
});

test("dispose during WASM initialization prevents a late native host allocation", async () => {
  const host = fakeHost();
  let finish: (value: unknown) => void = () => {};
  let createCalls = 0;
  host.wx.WXWebAssembly = { instantiate: () => new Promise((resolve) => { finish = resolve; }) };
  host.exports = null;
  host.host = 0;
  const starting = host.start(100, 100, 2);
  host.dispose();
  finish({ instance: { exports: { web_create: () => { createCalls += 1; return 2; } } } });
  await starting;
  expect(createCalls).toBe(0);
  expect(host.exports).toBeNull();
});

test("resize keeps the startup scale invariant while hide and show remain reusable", () => {
  const host = fakeHost();
  host.scale = 2;
  host.logicalWidth = 100;
  host.logicalHeight = 100;
  host.width = 100;
  host.height = 100;
  host.imageData = { data: new Uint8ClampedArray(100 * 100 * 4) } as any;
  host.exports.web_resize = () => 0;
  host.exports.web_resize_viewport = undefined;
  host.exports.web_pixels = () => 1;
  host.exports.web_pixels_len = () => 100 * 100 * 4;
  host.exports.web_wechat_work_state = () => 0;
  host.exports.web_result_ptr = () => 1;
  host.exports.web_result_len = () => 2;
  host.stopScheduled = () => {};
  host.schedule = () => {};
  host.draw = () => {};
  host.drainOutbound = () => {};
  let wakeCount = 0;
  host.wake = () => { wakeCount += 1; };

  host.resize(200, 120);
  expect(host.scale).toBe(2);
  expect([host.logicalWidth, host.logicalHeight]).toEqual([200, 120]);
  host.hide();
  expect(host.visible).toBe(false);
  host.show();
  expect(host.visible).toBe(true);
  expect(wakeCount).toBe(1);
});

test("scheduled frames retain an active touch until the real release or cancellation", () => {
  const host = fakeHost();
  const facts: any[] = [];
  host.exports.web_advance = (_handle: number, pointer: number, length: number) => {
    facts.push(JSON.parse(new TextDecoder().decode(new Uint8Array(host.exports.memory.buffer, pointer, length))));
    return 0;
  };
  host.exports.web_present = () => 0;
  host.draw = () => {};
  host.drainOutbound = () => {};
  const contact = { surface: 0, id: 1, x: 50, y: 70, cancelled: false };
  host.advance([contact]);
  host.advance();
  host.advance([]);
  host.advance();
  host.advance([{ ...contact, cancelled: true }]);
  host.advance();
  expect(facts.map(frame => frame.contacts)).toEqual([[contact], [contact], [], [], [{ ...contact, cancelled: true }], []]);
});

test("the page IME transport reaches the focused child runtime", () => {
  const host = fakeHost();
  const edits: any[] = [];
  host.system = { root: host, imeOwner: { imeEdit: (detail: unknown) => edits.push(detail) } } as any;
  host.imeEdit({ value: "selected account", cursor: 16 });
  expect(edits).toEqual([{ value: "selected account", cursor: 16 }]);
});
