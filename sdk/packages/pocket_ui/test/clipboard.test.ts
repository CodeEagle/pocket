import { expect, test } from "bun:test";
import { createHostBridge } from "../src/host.ts";
import { createPocketClipboardClient, readClipboardText, writeClipboardText } from "../src/clipboard.ts";

function setup() {
  const sent: any[] = [];
  const host = createHostBridge(packet => { sent.push(packet); return true; });
  const respond = (index: number, body: Record<string, unknown>) => host.handle({
    type: "event", name: "host.response",
    payload: { requestId: sent[index].payload.requestId, capability: sent[index].payload.capability, ...body },
  });
  return { sent, host, respond };
}

test("readClipboardText shares host correlation and maps null", async () => {
  const { sent, host, respond } = setup();
  try {
    const text = readClipboardText(host);
    expect(sent[0].payload.capability).toBe("clipboard.readText");
    respond(0, { ok: true, result: { text: "hello" } });
    expect(await text).toBe("hello");
    const empty = readClipboardText(host);
    respond(1, { ok: true, result: { text: null } });
    expect(await empty).toBeNull();
  } finally { host.dispose(); }
});

test("writeClipboardText and hasText send typed requests", async () => {
  const { sent, host, respond } = setup();
  try {
    const write = writeClipboardText(host, "copied");
    expect(sent[0].payload.capability).toBe("clipboard.writeText");
    expect(sent[0].payload.params).toEqual({ text: "copied" });
    respond(0, { ok: true, result: { ok: true } });
    expect(await write).toBeUndefined();
    const has = createPocketClipboardClient(host).hasText();
    expect(sent[1].payload.capability).toBe("clipboard.hasText");
    respond(1, { ok: true, result: { hasText: true } });
    expect(await has).toBe(true);
  } finally { host.dispose(); }
});

test("denied, too_large and unavailable errors reject with host codes", async () => {
  const { host, respond } = setup();
  try {
    for (const [i, code] of ["plugin_permission_denied", "too_large", "capability_unavailable"].entries()) {
      const pending = readClipboardText(host);
      respond(i, { ok: false, error: { code, message: code } });
      await expect(pending).rejects.toMatchObject({ code });
    }
  } finally { host.dispose(); }
});
