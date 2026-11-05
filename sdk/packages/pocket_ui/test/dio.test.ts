import { expect, test } from "bun:test";
import { createHostBridge } from "../src/host.ts";
import { createPocketDioClient } from "../src/dio.ts";

test("dio client shares host correlation, HTTP responses and unavailable errors", async () => {
  const sent: any[] = [];
  const host = createHostBridge(packet => { sent.push(packet); return true; });
  try {
    const dio = createPocketDioClient(host);
    const result = dio.request({ url: "https://example.com/api", method: "POST", data: { hello: "world" } });
    const packet = sent[0].payload;
    expect(packet.capability).toBe("dio.request");
    expect(packet.params.data).toEqual({ hello: "world" });
    host.handle({ type: "event", name: "host.response", payload: {
      requestId: packet.requestId, capability: "dio.request", ok: true,
      result: { statusCode: 404, headers: {}, data: "missing" },
    } });
    expect(await result).toEqual({ statusCode: 404, headers: {}, data: "missing" });
    const missing = dio.request({ url: "https://example.com" });
    host.handle({ type: "event", name: "host.response", payload: {
      requestId: sent[1].payload.requestId, capability: "dio.request", ok: false,
      error: { code: "capability_unavailable", message: "Provider not registered" },
    } });
    await expect(missing).rejects.toMatchObject({ code: "capability_unavailable" });
  } finally { host.dispose(); }
});
