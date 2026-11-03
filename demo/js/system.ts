import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import type { HostBridge } from "@pocket/ui/host";
import manifest from "./pocket.system.json";

/** Product policy stays in the SystemUI guest, outside the Flutter shell. */
export function installShowcaseSystem(bridge: HostBridge) {
  return installPocketSystem(manifest as PocketSystemV1, {
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
}
