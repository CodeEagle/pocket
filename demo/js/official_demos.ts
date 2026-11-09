import officialDemoCatalog from "./generated/official-demos.json";
import compositorRegistry from "./generated/compositor-surfaces.json";

export type OfficialDemo = {
  id: string;
  appId?: string;
  packageId?: string;
  title: string;
  status: string;
  launchable: boolean;
  statusReason?: string;
  launchability?: string;
  assets: {
    bytecode: string;
    pak: string;
    metadata: string;
    manifest: string;
  };
  requiredCapabilities?: string[];
  enhancedCapabilities?: string[];
  launchabilityDetails?: { pointerFallbackCapabilities?: string[] };
  hostCompatibility?: { missingSessionCapabilities?: string[] };
};

const bundledApplications = officialDemoCatalog.applications as readonly Record<string, unknown>[];
function isOfficialDemo(
  application: Record<string, unknown>,
): application is Record<string, unknown> & OfficialDemo {
  return typeof application.id === "string" &&
    typeof application.status === "string" &&
    typeof application.title === "string" &&
    typeof application.launchable === "boolean" &&
    typeof application.assets === "object" &&
    application.assets !== null;
}

export const officialDemos: readonly OfficialDemo[] = bundledApplications
  .filter(isOfficialDemo);

export function officialDemoAppId(demo: OfficialDemo): string {
  const appId = demo.appId ?? demo.packageId;
  if (!appId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(appId)) {
    throw new TypeError(`Official demo ${demo.id || "<unknown>"} has an invalid app id`);
  }
  return appId;
}

export function isOfficialDemoLaunchable(demo: OfficialDemo): boolean {
  return demo.launchable === true;
}

/** Mirrors the Flutter host's reserved child handles from the generated catalog. */
export function showcaseCompositorSurfaces(): Readonly<Record<string, number>> {
  return Object.freeze({
    ...compositorRegistry.surfaces,
  }) as Readonly<Record<string, number>>;
}
