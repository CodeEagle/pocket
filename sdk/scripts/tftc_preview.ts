/** Real-device TFTC acceptance: pinned guest -> existing preview -> npm Noble. */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createPreviewManager } from "../editor/preview.ts";
import { createLocalBluetoothProvider, type LocalBluetoothPacket } from "../editor/local_bluetooth.ts";
import { resolveNativeProbePath } from "./native_probe_path.ts";
import { createBleSecurityProvider } from "../packages/pocket_tftc/src/security.js";

const root = resolve(import.meta.dir, "..");
const out = process.env.TFTC_BUILD_DIR || join(process.platform === "win32" ? tmpdir() : "/tmp", "pocket-tftc-live-build");
const projectId = "tftc-physical";
const native = createLocalBluetoothProvider();
const securityScopes = new Map<string, { provider: ReturnType<typeof createBleSecurityProvider>; sessions: Set<string> }>();
const records: unknown[] = [];
function log(record: Record<string, unknown>) {
  const line = { at: new Date().toISOString(), ...record };
  records.push(line);
  if (records.length > 1000) records.shift();
  console.log("TFTC_LIVE", JSON.stringify(line));
}
const localBluetooth = {
  async handle(packet: LocalBluetoothPacket, send: (message: Record<string, unknown>) => void) {
    const capability = packet.capability || "";
    if (capability.startsWith("hardware.bluetooth.tftcSecurity")) {
      try {
        let scope = securityScopes.get(packet.scope);
        if (!scope) {
          const file = process.env.TFTC_SECRETS_FILE;
          if (!file) throw new Error("Set TFTC_SECRETS_FILE for secure devices");
          scope = { provider: createBleSecurityProvider({ productSecretsByProductId: JSON.parse(readFileSync(file, "utf8")) }), sessions: new Set() };
          securityScopes.set(packet.scope, scope);
        }
        const params: any = packet.params || {};
        let result: unknown;
        if (capability.endsWith("Begin")) {
          result = await scope.provider.beginBleSecurity(params);
          scope.sessions.add((result as any).sessionId);
        } else if (capability.endsWith("Complete")) result = await scope.provider.completeBleSecurity(params);
        else if (capability.endsWith("Clear")) { result = await scope.provider.clearBleSecurity(params.sessionId); scope.sessions.delete(params.sessionId); }
        else throw new Error("Unsupported acceptance security method");
        log({ capability, ok: true });
        send({ type: "event", name: "host.response", payload: { requestId: packet.requestId, capability, ok: true, result } });
      } catch (error: any) {
        log({ capability, ok: false, code: error.code, message: error.message });
        send({ type: "event", name: "host.response", payload: { requestId: packet.requestId, capability, ok: false, error: { code: error.code || "tftc_security", message: error.message } } });
      }
      return;
    }
    if (packet.kind === "scope.dispose") {
      const scope = securityScopes.get(packet.scope);
      if (scope) for (const id of scope.sessions) await scope.provider.clearBleSecurity(id);
      securityScopes.delete(packet.scope);
    }
    log({ kind: packet.kind, capability, ...(capability.endsWith("write") ? { bytes: (packet.params?.value as number[])?.length, command: (packet.params?.value as number[])?.[1], header: (packet.params?.value as number[])?.slice(0, 4) } : {}) });
    await native.handle(packet, message => {
      const payload: any = message.payload || {};
      const result = payload.result;
      const value = payload.data?.value;
      if (process.env.TFTC_WITHOUT_ADVERTISEMENT === "1" && result?.devices) {
        for (const device of result.devices) delete device.manufacturerData;
      }
      log({ event: message.name, capability: payload.capability, ok: payload.ok, error: payload.error,
        ...(result?.devices ? { devices: result.devices.filter((device: any) => device.name === "DK-META2") } : {}),
        ...(result?.services ? { services: result.services } : {}),
        ...(result?.bytesWritten !== undefined ? { bytesWritten: result.bytesWritten } : {}),
        ...(value ? { notificationBytes: value.length, header: value.slice(0, 4), ...([1,3,7,9].includes(value[1]) ? { value } : {}) } : {}),
      });
      send(message);
    });
  },
  dispose: () => native.dispose(),
};
const manager = createPreviewManager({ probePath: resolveNativeProbePath(root), localBluetooth, width: 390, height: 900,
  idleDisposeMs: 300000, projectDirectory: resolve(root, "../demo/js"),
  artifacts: { bytecode: join(out, "app.qjbc"), pak: join(out, "app.pak"), revision: 1, tickHz: 60 },
});
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.TFTC_PREVIEW_PORT || 8797), idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(`${url.origin}/api/projects/${projectId}/preview?webBluetooth=1&bluetoothProvider=local`);
    if (url.pathname === "/acceptance-log") return Response.json(records);
    return manager.handle(request, projectId);
  },
});
console.log(`TFTC preview: http://127.0.0.1:${server.port}/`);
async function cleanup() { await manager.dispose(); await server.stop(true); process.exit(); }
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
