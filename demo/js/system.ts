import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import { createPocketUpdateClient, type PocketUpdateStateOptions } from "@pocket/ui/updates";
import { hostError, type HostBridge } from "@pocket/ui/host";
import { onCleanup } from "solid-js";
import manifest from "./pocket.system.json";

/** Product policy stays in the SystemUI guest, outside the Flutter shell. */
export function installShowcaseSystem(bridge: HostBridge, state?: PocketUpdateStateOptions) {
  const system = installPocketSystem(manifest as PocketSystemV1, {
    bridge,
    maxResidentApps: 3,
    policies: {
      "pocket.host.demo": {
        allowedOpenApps: ["pocket.demo.profile", "pocket.demo.lobby"],
        messageTargets: ["pocket.demo.profile", "pocket.demo.lobby"],
        sharedNamespaces: ["identity"],
      },
      "pocket.demo.profile": {
        allowedOpenApps: ["pocket.demo.lobby"],
        messageTargets: ["pocket.host.demo"],
        sharedNamespaces: ["identity"],
      },
      "pocket.demo.lobby": {
        allowedOpenApps: [],
        messageTargets: ["pocket.host.demo", "pocket.demo.profile"],
        sharedNamespaces: ["identity"],
      },
    },
  });
  const updates = createPocketUpdateClient(bridge, {
    autoRefresh: true,
    state: state && {
      ...state,
      storage: {
        get: async (key, namespace) => { await system.ready; return state.storage.get(key, namespace); },
        set: async (key, value, namespace) => { await system.ready; return state.storage.set(key, value, namespace); },
        remove: async (key, namespace) => { await system.ready; return state.storage.remove(key, namespace); },
      },
    },
    onError: (error) => console.warn("SystemUI update", hostError(error).code),
  });
  onCleanup(() => updates.dispose());
  return Object.assign(system, { updates });
}
