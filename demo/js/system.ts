import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import { createPocketUpdateClient, type PocketUpdateStateOptions } from "@pocket/ui/updates";
import { hostError, type HostBridge } from "@pocket/ui/host";
import type { JsonObject } from "@pocket/ui/host";
import type { PocketSystemPolicies } from "@pocket/ui/system";
import { onCleanup } from "solid-js";
import manifest from "./pocket.system.json";
import {
  officialDemoAppId,
  officialDemos,
  isOfficialDemoLaunchable,
  type OfficialDemo,
} from "./official_demos.ts";

export { isOfficialDemoLaunchable } from "./official_demos.ts";

function presentationOf(demo: OfficialDemo): JsonObject {
  return {
    officialDemo: true,
    id: demo.id,
    title: demo.title,
    status: demo.status,
    ...(demo.statusReason ? { statusReason: demo.statusReason } : {}),
    ...(demo.launchability ? { launchability: demo.launchability } : {}),
    requiredCapabilities: demo.requiredCapabilities ?? [],
    enhancedCapabilities: demo.enhancedCapabilities ?? [],
    pointerFallbackCapabilities: demo.launchabilityDetails?.pointerFallbackCapabilities ?? [],
    missingSessionCapabilities: demo.hostCompatibility?.missingSessionCapabilities ?? [],
  };
}

/** Adds generated upstream entries to the existing system manifest and ACL. */
export function buildShowcaseSystemConfiguration(
  base: PocketSystemV1 = manifest as PocketSystemV1,
  demos: readonly OfficialDemo[] = officialDemos,
): { manifest: PocketSystemV1; policies: PocketSystemPolicies } {
  if (demos.length > 59) throw new RangeError("Official demo catalog exceeds reserved compositor handles 4..62");
  const seen = new Set(base.applications.catalog.map((entry) => entry.package));
  const launchableIds: string[] = [];
  const officialCatalog = demos.map((demo) => {
    if (!demo.id || !demo.title || !demo.assets?.manifest) {
      throw new TypeError("Official demo catalog entries require id, title, and manifest path");
    }
    const packageId = officialDemoAppId(demo);
    if (seen.has(packageId)) throw new TypeError(`Duplicate official demo package: ${packageId}`);
    seen.add(packageId);
    if (isOfficialDemoLaunchable(demo)) launchableIds.push(packageId);
    return {
      package: packageId,
      manifest: demo.assets.manifest,
      required: false,
      presentation: presentationOf(demo),
    };
  });
  const nextManifest: PocketSystemV1 = {
    ...base,
    applications: {
      ...base.applications,
      catalog: [...base.applications.catalog, ...officialCatalog],
    },
    installation: {
      ...base.installation,
      installedPackages: [...new Set([...base.installation.installedPackages, ...launchableIds])],
    },
  };
  const policies: PocketSystemPolicies = {
    "pocket.host.demo": {
      allowedOpenApps: ["pocket.demo.profile", "pocket.demo.lobby", "pocket.demo.lantern", ...launchableIds],
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
    "pocket.demo.lantern": {
      allowedOpenApps: [],
      messageTargets: [],
      sharedNamespaces: [],
    },
    ...Object.fromEntries(launchableIds.map((id) => [id, {
      allowedOpenApps: [],
      messageTargets: [],
      sharedNamespaces: [],
    }])) as PocketSystemPolicies,
  };
  return { manifest: nextManifest, policies };
}

/** Product policy stays in the SystemUI guest, outside the Flutter shell. */
export function installShowcaseSystem(bridge: HostBridge, state?: PocketUpdateStateOptions) {
  const configuration = buildShowcaseSystemConfiguration();
  const system = installPocketSystem(configuration.manifest, {
    bridge,
    maxResidentApps: 3,
    policies: configuration.policies,
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
