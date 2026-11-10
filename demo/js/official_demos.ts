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

type RuntimeSurfaceGlobal = typeof globalThis & {
  ui?: { __surfaces?: unknown };
};

/**
 * Reads only handles actually published by the native host. A missing or
 * malformed registry disables optional demos; it never falls back to the
 * generated local catalog.
 */
export function readTrustedCompositorSurfaceIds(registry?: unknown): ReadonlySet<string> {
  let raw = registry;
  if (raw === undefined) {
    try {
      raw = (globalThis as RuntimeSurfaceGlobal).ui?.__surfaces;
    } catch {
      return new Set();
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();

  const ids = new Set<string>();
  const handles = new Set<number>();
  try {
    for (const [appId, rawHandle] of Object.entries(raw)) {
      if (appId === "pocket.flutter.surface" && rawHandle === 1) continue;
      if (typeof rawHandle === "number" && Number.isInteger(rawHandle) && rawHandle >= 100) continue;
      if (typeof rawHandle !== "number" || !Number.isInteger(rawHandle) || rawHandle < 2 || rawHandle > 63 || handles.has(rawHandle)) {
        return new Set();
      }
      handles.add(rawHandle);
      ids.add(appId);
    }
  } catch {
    return new Set();
  }
  return ids;
}

/** Mirrors the Flutter host's reserved child handles from the generated catalog. */
export function showcaseCompositorSurfaces(): Readonly<Record<string, number>> {
  return Object.freeze({
    ...compositorRegistry.surfaces,
  }) as Readonly<Record<string, number>>;
}
