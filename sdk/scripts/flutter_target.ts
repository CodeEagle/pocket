import type { PlatformContractRegistry } from "../.cache/pocketjs/contracts/spec/platform-types.ts";

/** A native Flutter host target, resolved through the pinned manifest API. */
export const POCKET_FLUTTER_TARGET_ID = "pocket-flutter";

/**
 * Runtime capabilities implemented by the Pocket Flutter host and System
 * policy bridge. Independent worker realms are available; external providers remain policy
 * scoped. The default target does not advertise io.offload, network, camera,
 * or audio capabilities.
 */
const FLUTTER_TARGET_CAPABILITIES = [
  "text.glyphs.baked",
  "runtime.worker",
  "input.touch",
  "display.viewport.live",
  "platform.apps.list",
  "platform.apps.open",
  "platform.apps.cancel",
  "platform.apps.return",
  "platform.apps.prewarm",
  "platform.storage.get",
  "platform.storage.set",
  "platform.storage.remove",
  "platform.storage.keys",
  "platform.messages.send",
  "platform.messages.receive",
] as const;

const FLUTTER_SYSTEM_CAPABILITIES = FLUTTER_TARGET_CAPABILITIES.filter(
  (capability) => capability.startsWith("platform."),
);

/**
 * Load the framework's capability vocabulary, then add the SDK System APIs and
 * a profile for the real Flutter target. Kept lazy so a clean checkout can
 * materialize the ignored pinned upstream cache before resolving this module.
 */
export async function loadPocketFlutterPlatformContracts(): Promise<PlatformContractRegistry> {
  const [platform, generation] = await Promise.all([
    import("../.cache/pocketjs/contracts/spec/platform-types.ts"),
    import("../.cache/pocketjs/contracts/spec/binding-generation.ts"),
  ]);
  const capabilities = platform.defineCapabilityRegistry([
    ...platform.POCKET_CAPABILITIES,
    ...FLUTTER_SYSTEM_CAPABILITIES,
  ]);
  const target = {
    hostAbi: generation.POCKET_BINDING_GENERATION,
    platform: "flutter",
    form: "window",
    display: {
      physicalViewport: [360, 640] as const,
      logicalViewports: [[360, 640]] as const,
      dynamicViewport: {
        min: [1, 1] as const,
        max: [1024, 1024] as const,
        acceptsFixed: true,
      },
      presentations: ["native"] as const,
      rasterDensity: 1,
      animation: "composited" as const,
    },
    capabilities: FLUTTER_TARGET_CAPABILITIES,
    roleCapabilities: {
      systemUI: ["ui.compositor-surfaces"] as const,
    },
    tickHz: 60,
  } as const;
  const targets = platform.defineTargetRegistry({
    [POCKET_FLUTTER_TARGET_ID]: target,
  });
  return platform.definePlatformContractRegistry(capabilities, targets);
}
