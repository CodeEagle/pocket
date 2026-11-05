import { expect, test } from "bun:test";
import { createHostBridge } from "../src/host.ts";
import { createPocketPermissionsClient } from "../src/permissions.ts";

test("permissions client preserves limited and denied OS facts and uses the existing bridge", async () => {
  const packets: any[] = [];
  const host = createHostBridge(packet => { packets.push(packet); return true; });
  try {
    const permissions = createPocketPermissionsClient(host);
    const status = permissions.status("hardware.photos");
    const request = packets[0].payload;
    expect(request.capability).toBe("permissions.status");
    expect(request.params).toEqual({ policyKey: "hardware.photos" });
    host.handle({ type: "event", name: "host.response", payload: {
      requestId: request.requestId, capability: request.capability, ok: true,
      result: { ok: true, permission: "hardware.photos", status: "limited", granted: false, limited: true, realHardware: true },
    } });
    expect(await status).toMatchObject({ status: "limited", granted: false, limited: true });
    const denied = permissions.request("hardware.camera");
    host.handle({ type: "event", name: "host.response", payload: {
      requestId: packets[1].payload.requestId, capability: "permissions.request", ok: true,
      result: { ok: true, permission: "hardware.camera", status: "permanentlyDenied", granted: false, realHardware: true },
    } });
    expect(await denied).toMatchObject({ status: "permanentlyDenied", granted: false });
    const settings = permissions.openSettings();
    expect(packets[2].payload.params).toEqual({});
    host.handle({ type: "event", name: "host.response", payload: {
      requestId: packets[2].payload.requestId, capability: "permissions.openSettings", ok: true,
      result: { ok: true, opened: true, realHardware: true },
    } });
    expect((await settings).opened).toBe(true);
  } finally { host.dispose(); }
});
