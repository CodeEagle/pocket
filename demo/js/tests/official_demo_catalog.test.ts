import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import type { PocketSystemV1 } from "../../../sdk/packages/pocket_ui/src/system.ts";

mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60 }));
mock.module("solid-js", () => ({ onCleanup: () => {} }));
const { buildShowcaseSystemConfiguration, isOfficialDemoLaunchable } = await import("../system.ts");
const { officialDemos, readTrustedCompositorSurfaceIds, showcaseCompositorSurfaces } = await import("../official_demos.ts");

const base: PocketSystemV1 = {
  pocketSystem: 1,
  id: "showcase.test",
  roles: { systemUI: "pocket.host.demo" },
  applications: {
    catalog: [
      { package: "pocket.host.demo", manifest: "pocket.json", required: true },
      { package: "pocket.demo.profile", manifest: "profile.json", required: true },
      { package: "pocket.demo.lobby", manifest: "lobby.json", required: true },
      { package: "pocket.demo.lantern", manifest: "lantern.json", required: true },
    ],
  },
  installation: {
    installedPackages: ["pocket.host.demo", "pocket.demo.profile", "pocket.demo.lobby", "pocket.demo.lantern"],
  },
};

const hero = {
  id: "hero",
  appId: "dev.pocket-nexus.hero",
  title: "PocketJS: Hero",
  status: "passed",
  launchable: true,
  statusReason: "Raw build and native benchmark passed.",
  launchability: "portable_pointer_fallback",
  assets: {
    bytecode: "apps/official/hero/app.qjbc",
    pak: "apps/official/hero/app.pak",
    metadata: "apps/official/hero/app.bytecode.json",
    manifest: "apps/official/hero/guest-manifest.json",
  },
  requiredCapabilities: ["text.glyphs.baked", "input.buttons"],
  enhancedCapabilities: ["display.viewport.live"],
  launchabilityDetails: { pointerFallbackCapabilities: ["input.buttons"] },
  hostCompatibility: { missingSessionCapabilities: ["input.buttons"] },
};

const limited = {
  id: "limited",
  appId: "dev.pocket-nexus.limited",
  title: "Limited demo",
  status: "platform-limited",
  launchable: false,
  statusReason: "Needs a capability that this host does not provide.",
  launchability: "platform-limited",
  assets: {
    bytecode: "apps/official/limited/app.qjbc",
    pak: "apps/official/limited/app.pak",
    metadata: "apps/official/limited/app.bytecode.json",
    manifest: "apps/official/limited/guest-manifest.json",
  },
  requiredCapabilities: ["input.buttons"],
};

test("official entries are cataloged, but only supported packages are installed and authorized", () => {
  const trustedAvailableIds = new Set([
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
    hero.appId,
  ]);
  const configuration = buildShowcaseSystemConfiguration(base, [hero, limited], trustedAvailableIds);
  const { manifest, policies } = configuration;
  const heroCatalog = manifest.applications.catalog.find((entry) => entry.package === hero.appId)!;
  const limitedCatalog = manifest.applications.catalog.find((entry) => entry.package === limited.appId)!;

  assert.equal(heroCatalog.required, false);
  assert.equal(heroCatalog.presentation?.officialDemo, true);
  assert.deepEqual(heroCatalog.presentation?.pointerFallbackCapabilities, ["input.buttons"]);
  assert.match(String(heroCatalog.presentation?.statusReason), /Raw build/);
  assert.equal(limitedCatalog.required, false);
  assert.deepEqual(manifest.installation.installedPackages, [
    "pocket.host.demo",
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
    hero.appId,
  ]);

  assert.deepEqual(policies["pocket.host.demo"]?.allowedOpenApps, [
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
    hero.appId,
  ]);
  assert.deepEqual(policies[hero.appId], {
    allowedOpenApps: [],
    messageTargets: [],
    sharedNamespaces: [],
  });
  assert.equal(policies[limited.appId], undefined);
  assert.equal(isOfficialDemoLaunchable(hero), true);
  assert.equal(isOfficialDemoLaunchable(limited), false);
  const surfaces = showcaseCompositorSurfaces();
  assert.equal(surfaces["pocket.demo.profile"], 2);
  assert.equal(surfaces["pocket.demo.lobby"], 3);
  assert.equal(surfaces["pocket.demo.lantern"], 63);
  assert.equal(surfaces[hero.appId], 14);
  assert.equal(surfaces[limited.appId], undefined);
});

test("launchable official demos stay cataloged but uninstalled without a trusted host surface", () => {
  const configuration = buildShowcaseSystemConfiguration(base, [hero, limited], new Set([
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
  ]));
  const heroCatalog = configuration.manifest.applications.catalog.find((entry) => entry.package === hero.appId)!;

  assert.equal(heroCatalog.required, false);
  assert.equal(configuration.manifest.applications.catalog.some((entry) => entry.package === limited.appId), true);
  assert.deepEqual(configuration.manifest.installation.installedPackages, [
    "pocket.host.demo",
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
  ]);
  assert.deepEqual(configuration.policies["pocket.host.demo"]?.allowedOpenApps, [
    "pocket.demo.profile",
    "pocket.demo.lobby",
    "pocket.demo.lantern",
  ]);
  assert.equal(configuration.policies[hero.appId], undefined);

  const incompleteBaseRegistry = buildShowcaseSystemConfiguration(base, [hero], new Set([hero.appId]));
  assert.equal(incompleteBaseRegistry.manifest.installation.installedPackages.includes(hero.appId), false);
});

test("trusted compositor IDs reject malformed native registries", () => {
  assert.deepEqual([...readTrustedCompositorSurfaceIds({
    "pocket.demo.profile": 2,
    "pocket.demo.lobby": 2,
    "pocket.demo.lantern": 63,
    [hero.appId]: 14,
  })], []);
  assert.deepEqual([...readTrustedCompositorSurfaceIds(null)], []);
  assert.deepEqual([...readTrustedCompositorSurfaceIds({
    "pocket.demo.profile": 2,
    "pocket.demo.lobby": 3,
    "pocket.demo.lantern": 63,
    [hero.appId]: 14,
  })], ["pocket.demo.profile", "pocket.demo.lobby", "pocket.demo.lantern", hero.appId]);
});

test("duplicate official IDs and oversized handle catalogs fail closed", () => {
  assert.throws(
    () => buildShowcaseSystemConfiguration(base, [hero, { ...hero, id: "hero-copy" }]),
    /Duplicate official demo package/,
  );
  const many = Array.from({ length: 60 }, (_, index) => ({
    ...hero,
    id: `demo-${index}`,
    appId: `official.demo-${index}`,
  }));
  assert.throws(() => buildShowcaseSystemConfiguration(base, many), /reserved compositor handles/);
});

test("staged Worker HTTP keeps Worker artifacts and honest benchmark scope", () => {
  const worker = officialDemos.find((entry: any) => entry.id === "worker-http") as any;
  assert.ok(worker, "worker-http must remain in the full staged official catalog");
  assert.equal(worker.status, "passed");
  assert.equal(worker.worker.bytecode.path, "app.worker.qjbc");
  assert.equal(worker.assets.metadata, "apps/official/worker-http/app.bytecode.json");
  assert.equal(worker.workerAwareBenchmark?.workerAttached, true);
  assert.equal(worker.workerAwareBenchmark?.httpRequestExercised, false);
  assert.equal(worker.guestManifestAdaptation?.demotedRequirements?.includes("input.buttons"), true);
});
