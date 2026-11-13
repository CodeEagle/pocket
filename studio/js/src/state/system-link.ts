// The only module that talks to the System capabilities: it installs the
// PocketSystem kernel (system.runtime.configure) once and exposes the few
// host requests the preview and the settings need. Orchestration stays in
// the stores; Dart only owns the child runtime lifetime and compositing.
import type { HostBridge } from "@pocket/ui/host";
import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import { PREVIEW_APP_ID, type PreviewRuntime } from "./preview.ts";
import type { SettingsBackend } from "./settings.ts";

export const STUDIO_APP_ID = "dev.pocket.studio";

const manifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: STUDIO_APP_ID,
  roles: { systemUI: STUDIO_APP_ID },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: STUDIO_APP_ID, manifest: "pocket.json", required: true },
      { package: PREVIEW_APP_ID, manifest: "preview/pocket.json", required: true },
    ],
  },
  installation: { installedPackages: [STUDIO_APP_ID, PREVIEW_APP_ID] },
};

export function createSystemLink(host: HostBridge): PreviewRuntime & SettingsBackend {
  let installed: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (!installed) {
      installed = (async () => {
        const system = installPocketSystem(manifest, { bridge: host, maxResidentApps: 2 });
        await system.ready;
      })();
      installed.catch(() => { installed = undefined; }); // allow a later retry
    }
    return installed;
  };
  const request = async <T>(capability: string, params: Record<string, unknown>): Promise<T> => {
    await ensure();
    return await host.request(capability, params as never) as T;
  };
  return {
    ensure,
    async create(appId) {
      // prepareForOpen without cacheFirst: the signed update is checked and verified before the child can run.
      const created = await request<{ instanceId: string; generation: number | string }>("system.runtime.create", { appId, prepareForOpen: true });
      return { instanceId: String(created.instanceId), generation: created.generation };
    },
    async destroy(instanceId) { await request("system.runtime.destroy", { instanceId }); },
    async awaitFirstFrame(instanceId, generation) { await request("system.runtime.awaitFirstFrame", { instanceId, generation }); },
    async get(key) { return await request<unknown>("system.storage.get", { appId: STUDIO_APP_ID, key }); },
    async set(key, value) { await request("system.storage.set", { appId: STUDIO_APP_ID, key, value }); },
  };
}
