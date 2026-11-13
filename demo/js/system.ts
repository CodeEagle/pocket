import { installPocketSystem, type PocketSystemPresetUpdate, type PocketSystemV1 } from "@pocket/ui/system";
import { createPocketUpdateClient, type PocketUpdateStateOptions } from "@pocket/ui/updates";
import { hostError, type HostBridge } from "@pocket/ui/host";
import type { JsonObject } from "@pocket/ui/host";
import type { PocketSystemPolicies } from "@pocket/ui/system";
import { onCleanup } from "solid-js";
import manifest from "./pocket.system.json";
import lanternManifest from "./apps/lantern/pocket.json";
import lobbyManifest from "./apps/lobby/pocket.json";
import profileManifest from "./apps/profile/pocket.json";
import {
  officialDemoAppId,
  officialDemos,
  isOfficialDemoLaunchable,
  readTrustedCompositorSurfaceIds,
  type OfficialDemo,
} from "./official_demos.ts";

export { isOfficialDemoLaunchable } from "./official_demos.ts";

const BUILTIN_APP_MANIFESTS: Readonly<Record<string, unknown>> = {
  "pocket.demo.lantern": lanternManifest,
  "pocket.demo.lobby": lobbyManifest,
  "pocket.demo.profile": profileManifest,
};

function manifestPresentationOf(appManifest: unknown): JsonObject | undefined {
  if (!appManifest || typeof appManifest !== "object" || Array.isArray(appManifest)) return undefined;
  const record = appManifest as Record<string, unknown>;
  const appSection = record.app && typeof record.app === "object" && !Array.isArray(record.app)
    ? record.app as Record<string, unknown>
    : undefined;
  const rawPresentation = appSection?.presentation ?? record.presentation;
  const presentation = rawPresentation && typeof rawPresentation === "object" && !Array.isArray(rawPresentation)
    ? rawPresentation as JsonObject
    : undefined;
  const title = typeof record.title === "string" ? record.title : undefined;
  if (!presentation && !title) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(presentation ?? {}),
  };
}

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
  trustedAvailableIds: ReadonlySet<string> = new Set(),
): { manifest: PocketSystemV1; policies: PocketSystemPolicies } {
  if (demos.length > 59) throw new RangeError("Official demo catalog exceeds reserved compositor handles 4..62");
  const seen = new Set(base.applications.catalog.map((entry) => entry.package));
  const officialPackageIds = new Set(demos.map(officialDemoAppId));
  const systemUI = base.roles.systemUI;
  const installedBaseChildren = base.installation.installedPackages.filter(
    (appId) => appId !== systemUI && !officialPackageIds.has(appId),
  );
  const baseRegistryIsComplete = installedBaseChildren.every((appId) => trustedAvailableIds.has(appId));
  const launchableIds: string[] = [];
  const officialCatalog = demos.map((demo) => {
    if (!demo.id || !demo.title || !demo.assets?.manifest) {
      throw new TypeError("Official demo catalog entries require id, title, and manifest path");
    }
    const packageId = officialDemoAppId(demo);
    if (seen.has(packageId)) throw new TypeError(`Duplicate official demo package: ${packageId}`);
    seen.add(packageId);
    if (baseRegistryIsComplete && isOfficialDemoLaunchable(demo) && trustedAvailableIds.has(packageId)) {
      launchableIds.push(packageId);
    }
    return {
      package: packageId,
      manifest: demo.assets.manifest,
      required: false,
      presentation: presentationOf(demo),
    };
  });
  const baseCatalog = base.applications.catalog.map((entry) => {
    const manifestPresentation = manifestPresentationOf(BUILTIN_APP_MANIFESTS[entry.package]);
    if (!manifestPresentation && !entry.presentation) return entry;
    return {
      ...entry,
      presentation: {
        ...(manifestPresentation ?? {}),
        ...(entry.presentation ?? {}),
      },
    };
  });
  const nextManifest: PocketSystemV1 = {
    ...base,
    applications: {
      ...base.applications,
      catalog: [...baseCatalog, ...officialCatalog],
    },
    installation: {
      ...base.installation,
      installedPackages: [...new Set([
        ...base.installation.installedPackages.filter((appId) => !officialPackageIds.has(appId)),
        ...launchableIds,
      ])],
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
export function installShowcaseSystem(
  bridge: HostBridge,
  state?: PocketUpdateStateOptions,
  presets?: PocketSystemPresetUpdate,
) {
  const configuration = buildShowcaseSystemConfiguration(
    manifest as PocketSystemV1,
    officialDemos,
    readTrustedCompositorSurfaceIds(),
  );
  const system = installPocketSystem(configuration.manifest, {
    bridge,
    maxResidentApps: 3,
    policies: configuration.policies,
    presets,
  });
  // The host already prepares cache-first updates in the background for the
  // next open. A second guest auto-refresh would apply them over a live page.
  const updates = createPocketUpdateClient(bridge, {
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
