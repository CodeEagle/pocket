import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { buildGuest, type BuildGuestResult } from "../../../sdk/scripts/build_guest.ts";
import { resolveSystemDocument, validateSystemFile } from "../../../sdk/scripts/build_system.ts";

const scriptRoot = resolve(import.meta.dir);
const demoRoot = resolve(scriptRoot, "../..");
const repositoryRoot = resolve(demoRoot, "..");
const sdkRoot = join(repositoryRoot, "sdk");
const officialBuildScript = join(sdkRoot, "scripts/official_demos.ts");
const officialArtifactRoot = join(demoRoot, "build/official-demos");
const officialAssetRoot = join(demoRoot, "assets/apps/official");
const generatedJsCatalog = join(demoRoot, "js/generated/official-demos.json");
const generatedCompositorSurfaces = join(demoRoot, "js/generated/compositor-surfaces.json");
const pubspecPath = join(demoRoot, "pubspec.yaml");
const pubspecAssetMarkerStart = "    # BEGIN GENERATED OFFICIAL DEMO ASSETS";
const pubspecAssetMarkerEnd = "    # END GENERATED OFFICIAL DEMO ASSETS";

const miniApps = [
  { name: "profile", projectRoot: resolve(scriptRoot, "../apps/profile") },
  { name: "lobby", projectRoot: resolve(scriptRoot, "../apps/lobby") },
  { name: "lantern", projectRoot: resolve(scriptRoot, "../apps/lantern") },
] as const;

const fixedCompositorSurfaces: Readonly<Record<string, number>> = {
  "pocket.demo.profile": 2,
  "pocket.demo.lobby": 3,
  "pocket.demo.lantern": 63,
};

type OfficialDemo = Record<string, any> & {
  id: string;
  packageId: string | null;
  version: string | null;
  title: string;
  status: string;
  qjbcPath: string;
  pakPath: string;
  metadataPath: string;
  guestManifestPath?: string;
  workerQjbcPath?: string;
  workerMetadataPath?: string;
  worker?: Record<string, any>;
  sourceAdaptation?: Record<string, any>;
  launchable?: boolean;
  launchability?: string;
  launchabilityDetails?: Record<string, any>;
};

interface Options {
  officialOnly: boolean;
  apps: string[] | null;
  frames: number | null;
  warmup: number | null;
  tickHz: number | null;
  density: number | null;
  benchBin: string | null;
}

function parsePositiveInteger(value: string, name: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseOptions(args: string[]): Options {
  const options: Options = { officialOnly: false, apps: null, frames: null, warmup: null, tickHz: null, density: null, benchBin: null };
  for (const arg of args) {
    if (arg === "--official-only") options.officialOnly = true;
    else if (arg.startsWith("--apps=")) {
      const ids = arg.slice("--apps=".length).split(",").map(value => value.trim()).filter(Boolean);
      options.apps = ids.includes("all") ? null : ids;
    } else if (arg.startsWith("--frames=")) options.frames = parsePositiveInteger(arg.slice("--frames=".length), "frames");
    else if (arg.startsWith("--warmup=")) options.warmup = parsePositiveInteger(arg.slice("--warmup=".length), "warmup", true);
    else if (arg.startsWith("--tick-hz=")) options.tickHz = parsePositiveInteger(arg.slice("--tick-hz=".length), "tick-hz");
    else if (arg.startsWith("--density=")) options.density = parsePositiveInteger(arg.slice("--density=".length), "density");
    else if (arg.startsWith("--bench-bin=")) options.benchBin = resolve(arg.slice("--bench-bin=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun scripts/build_mini_apps.ts [--official-only] [--apps=hero,motions] [--frames=N] [--warmup=N]

Builds the local profile/lobby guests, then runs the pinned official demo build,
native benchmark and asset staging. --official-only skips local guests so a
focused staging check does not rebuild unrelated apps.`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readObject(path: string): Record<string, any> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected JSON object: ${path}`);
  return value as Record<string, any>;
}

function assetRelative(path: string): string {
  return relative(join(demoRoot, "assets"), path).split(sep).join("/");
}

function safeArtifactPath(path: string): string {
  if (!path || typeof path !== "string") throw new Error("Official catalog has an empty artifact path");
  const absolute = resolve(officialArtifactRoot, path);
  const rel = relative(officialArtifactRoot, absolute);
  if (!rel || rel.startsWith("..") || resolve(absolute) !== absolute) {
    throw new Error(`Official artifact path escapes its build root: ${path}`);
  }
  return absolute;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort()
    : [];
}

/**
 * Generate checked-in runtime image variants before a mini-app is passed to
 * buildGuest.  Lantern keeps its authoring masters outside the PAK and its
 * prepare script is the single source of the 512px runtime derivatives.  The
 * staging path calls buildGuest directly (it does not run package.json
 * scripts), so invoke the declared preparation step here as part of the
 * reproducible build.
 */
function prepareMiniAppAssets(app: (typeof miniApps)[number]): void {
  if (app.name !== "lantern") return;
  for (const filename of ["prepare_textures.ts", "prepare_live2d.ts"]) {
    const script = join(app.projectRoot, "scripts", filename);
    if (!existsSync(script)) throw new Error(`build_mini_apps: ${app.name} is missing ${filename}`);
    console.log(`build_mini_apps: preparing ${app.name} assets with ${filename}`);
    const result = spawnSync(process.execPath, [script], {
      cwd: app.projectRoot,
      stdio: "inherit",
      timeout: 5 * 60 * 1000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`build_mini_apps: ${app.name} ${filename} exited with status ${result.status ?? 1}`);
  }
}

function compactDemo(demo: OfficialDemo, stagedManifest?: Record<string, any>): Record<string, unknown> {
  const manifestCaps = stagedManifest?.capabilities ?? {};
  const destination = join(officialAssetRoot, demo.id);
  const assets = {
    bytecode: assetRelative(join(destination, "app.qjbc")),
    pak: assetRelative(join(destination, "app.pak")),
    metadata: assetRelative(join(destination, "app.bytecode.json")),
    manifest: assetRelative(join(destination, "guest-manifest.json")),
  };
  const hostCompatibility = demo.hostCompatibility ?? {};
  const compatibility = demo.launchabilityDetails ?? {};
  const missing = stringList(hostCompatibility.missingSessionCapabilities);
  const pointerFallbackMissing = stringList(compatibility.pointerFallbackCapabilities);
  const blocked = stringList(compatibility.blockedCapabilities);

  return {
    id: demo.id,
    appId: demo.packageId,
    title: demo.title,
    version: demo.version,
    status: demo.status,
    statusReason: demo.statusReason ?? "Upstream mounted build and raw native benchmark passed.",
    framework: demo.framework ?? "solid",
    requiredCapabilities: stringList(demo.requiredCapabilities),
    enhancedCapabilities: stringList(demo.enhancedCapabilities),
    capabilities: stringList(demo.capabilities),
    viewport: demo.viewport ?? null,
    auxiliaryViewport: demo.auxiliaryViewport ?? null,
    motion: demo.motion,
    assets,
    ...(demo.worker ? { worker: demo.worker } : {}),
    ...(demo.sourceAdaptation ? { sourceAdaptation: demo.sourceAdaptation } : {}),
    ...(demo.nativeBenchmark?.workerAware ? {
      workerAwareBenchmark: {
        workerAttached: true,
        fpsMeasured: demo.nativeBenchmark.fpsMeasured === true,
        httpRequestExercised: demo.nativeBenchmark.httpRequestExercised === true,
        note: "The worker realm was attached before UI evaluation; HTTP request I/O remains unexercised by the frame benchmark.",
      },
    } : {}),
    hostCompatibility: {
      missingSessionCapabilities: missing,
      missingEnhancedSessionCapabilities: stringList(hostCompatibility.missingEnhancedSessionCapabilities),
      conditionalRequiredCapabilities: stringList(hostCompatibility.conditionalRequiredCapabilities),
      conditionalEnhancedCapabilities: stringList(hostCompatibility.conditionalEnhancedCapabilities),
      rawNativeBenchDoesNotExercise: stringList(hostCompatibility.rawNativeBenchDoesNotExercise),
      caveats: Array.isArray(hostCompatibility.caveats) ? hostCompatibility.caveats : [],
    },
    launchable: demo.launchable === true,
    launchability: demo.launchability ?? "platform_limited",
    guestManifestAdaptation: {
      requiredCapabilities: Array.isArray(manifestCaps.requires)
        ? stringList(manifestCaps.requires)
        : stringList(demo.requiredCapabilities).filter(name => !pointerFallbackMissing.includes(name)),
      optionalCapabilities: Array.isArray(manifestCaps.optional)
        ? stringList(manifestCaps.optional)
        : [...new Set([...stringList(demo.enhancedCapabilities), ...pointerFallbackMissing])].sort(),
      demotedRequirements: pointerFallbackMissing,
      ...(typeof stagedManifest?.fonts === "string" ? { fonts: stagedManifest.fonts } : {}),
      note: pointerFallbackMissing.length > 0
        ? "Flutter pointer adaptation removes the input requirement for admission; it is not equivalent to a physical gamepad."
        : stagedManifest?.fonts === "host"
          ? "Staged for host-native vector fonts (text.layout.native) without baked DCFA glyph atlases."
          : "No capability was changed in the staged guest manifest.",
    },
    launchabilityDetails: {
      pointerFallbackCapabilities: pointerFallbackMissing,
      blockedCapabilities: blocked,
      note: pointerFallbackMissing.length > 0
        ? "Pointer fallback is a portability suggestion and does not emulate physical gamepad semantics."
        : blocked.length > 0
          ? "One or more required capabilities are absent from PocketSession defaults; the host decides whether to expose this app."
          : "No required capability gap was found in the current PocketSession defaults.",
    },
  };
}

function bundledLocalApplications(): Record<string, unknown>[] {
  const system = readObject(join(demoRoot, "js/pocket.system.json"));
  const sourceApps = system.applications?.catalog;
  const installed = new Set<string>(system.installation?.installedPackages ?? []);
  if (!Array.isArray(sourceApps)) {
    throw new Error("build_mini_apps: pocket.system.json is missing applications.catalog");
  }
  const result: Record<string, unknown>[] = [];
  for (const source of sourceApps) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const app = source as Record<string, any>;
    if (typeof app.package !== "string" || typeof app.manifest !== "string") continue;
    const local = miniApps.find(({ name }) => app.manifest === `apps/${name}/pocket.json`);
    if (!local) continue;
    const assetDirectory = dirname(app.manifest).split(sep).join("/");
    const assets = {
      bytecode: `${assetDirectory}/app.qjbc`,
      pak: `${assetDirectory}/app.pak`,
      metadata: `${assetDirectory}/app.bytecode.json`,
      manifest: `${assetDirectory}/guest-manifest.json`,
    };
    for (const path of Object.values(assets)) {
      const absolute = join(demoRoot, "assets", path);
      if (!existsSync(absolute) || statSync(absolute).size === 0) {
        throw new Error(`build_mini_apps: missing compiled asset for ${app.package}: ${absolute}`);
      }
    }
    result.push({ appId: app.package, launchable: installed.has(app.package), assets });
  }
  if (result.length !== miniApps.length) {
    throw new Error(
      `build_mini_apps: expected ${miniApps.length} local apps in pocket.system.json, found ${result.length}`,
    );
  }
  return result;
}

function updateFlutterAssetDirectories(ids: string[]): void {
  const existing = readFileSync(pubspecPath, "utf8");
  const paths = [
    "    - assets/apps/official/catalog.json",
    ...ids.map(id => `    - assets/apps/official/${id}/`),
  ];
  const block = [pubspecAssetMarkerStart, ...paths, pubspecAssetMarkerEnd].join("\n");
  const start = existing.indexOf(pubspecAssetMarkerStart);
  const end = existing.indexOf(pubspecAssetMarkerEnd);
  let updated: string;
  if (start >= 0 && end > start) {
    updated = `${existing.slice(0, start)}${block}${existing.slice(end + pubspecAssetMarkerEnd.length)}`;
  } else {
    const broadAssetDirectory = "    - assets/apps/official/";
    if (!existing.includes(broadAssetDirectory)) throw new Error(`pubspec.yaml is missing ${broadAssetDirectory}`);
    updated = existing.replace(broadAssetDirectory, `${broadAssetDirectory}\n${block}`);
  }
  if (updated !== existing) writeFileSync(pubspecPath, updated);
}

function stageOfficialDemos(options: Options): { staged: number; failed: number; catalogPath: string } {
  const sourceCatalogPath = join(officialArtifactRoot, "catalog.json");
  // Do not stage an older successful catalog if the current sweep fails before
  // writing its own report.
  rmSync(sourceCatalogPath, { force: true });
  const command = [officialBuildScript, "all"];
  if (options.apps) command.push(`--apps=${options.apps.join(",")}`);
  if (options.frames !== null) command.push(`--frames=${options.frames}`);
  if (options.warmup !== null) command.push(`--warmup=${options.warmup}`);
  if (options.tickHz !== null) command.push(`--tick-hz=${options.tickHz}`);
  if (options.density !== null) command.push(`--density=${options.density}`);
  if (options.benchBin !== null) command.push(`--bench-bin=${options.benchBin}`);

  console.log(`build_mini_apps: official build + native bench: ${command.join(" ")}`);
  const run = spawnSync(process.execPath, command, {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: 30 * 60 * 1000,
  });
  if (run.error) throw run.error;

  if (!existsSync(sourceCatalogPath)) {
    throw new Error(`Official build did not produce catalog.json (exit ${run.status ?? "unknown"})`);
  }
  const sourceCatalog = readObject(sourceCatalogPath);
  if (sourceCatalog.schemaVersion !== 1 || !Array.isArray(sourceCatalog.demos)) {
    throw new Error(`Invalid official demo catalog: ${sourceCatalogPath}`);
  }

  const passed = (sourceCatalog.demos as OfficialDemo[])
    .filter(demo => demo.status === "passed" && typeof demo.packageId === "string" && demo.packageId.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const packageIds = new Set<string>();
  for (const demo of passed) {
    if (packageIds.has(demo.packageId)) {
      throw new Error(`Duplicate official package id ${demo.packageId}; target variants must not be registered as separate apps`);
    }
    packageIds.add(demo.packageId);
  }
  mkdirSync(officialAssetRoot, { recursive: true });
  const stagedIds = new Set(passed.map(demo => demo.id));
  for (const entry of readdirSync(officialAssetRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !stagedIds.has(entry.name)) {
      rmSync(join(officialAssetRoot, entry.name), { recursive: true, force: true });
    }
  }
  const staged = passed.map(demo => {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(demo.id)) throw new Error(`Unsafe official demo id: ${demo.id}`);
    const destination = join(officialAssetRoot, demo.id);
    mkdirSync(destination, { recursive: true });
    const generated = [
      [safeArtifactPath(demo.qjbcPath), join(destination, "app.qjbc")],
      [safeArtifactPath(demo.pakPath), join(destination, "app.pak")],
      [safeArtifactPath(demo.metadataPath), join(destination, "app.bytecode.json")],
      ...(demo.workerQjbcPath && demo.workerMetadataPath ? [
        [safeArtifactPath(demo.workerQjbcPath), join(destination, "app.worker.qjbc")],
        [safeArtifactPath(demo.workerMetadataPath), join(destination, "app.worker.bytecode.json")],
      ] : []),
    ] as const;
    for (const [source, target] of generated) {
      if (!existsSync(source) || statSync(source).size === 0) throw new Error(`Missing official artifact for ${demo.id}: ${source}`);
      copyFileSync(source, target);
    }
    const manifestSource = safeArtifactPath(demo.guestManifestPath ?? `demos/${demo.id}/guest-manifest.json`);
    if (!existsSync(manifestSource) || statSync(manifestSource).size === 0) {
      throw new Error(`Missing official guest manifest for ${demo.id}: ${manifestSource}`);
    }
    copyFileSync(manifestSource, join(destination, "guest-manifest.json"));
    return compactDemo(demo, readObject(manifestSource));
  });

  const compactCatalog = {
    schemaVersion: 1,
    source: {
      repository: sourceCatalog.source?.repository ?? "pocket-nexus/pocketjs",
      revision: sourceCatalog.source?.revision ?? null,
      provenance: sourceCatalog.source?.provenance ?? "Built from the pinned PocketJS source cache without copying upstream source files.",
    },
    fixedCompositorSurfaces,
    applications: [...staged, ...bundledLocalApplications()],
  };
  const assetCatalogPath = join(officialAssetRoot, "catalog.json");
  saveJson(assetCatalogPath, compactCatalog);
  saveJson(generatedJsCatalog, compactCatalog);
  saveJson(generatedCompositorSurfaces, {
    schemaVersion: 1,
    surfaces: Object.fromEntries([
      ...Object.entries(fixedCompositorSurfaces),
      ...staged.flatMap((demo, index) => {
        const record = demo as Record<string, any>;
        return record.launchable !== true
          ? []
          : [[String(record.appId), 4 + index]];
      }),
    ]),
    applications: Object.fromEntries(staged.flatMap((demo) => {
      const record = demo as Record<string, any>;
      return record.launchable !== true
        ? []
        : [[String(record.appId), {
          title: String(record.title),
          assetDirectory: `apps/official/${String(record.id)}`,
        }]];
    })),
  });
  updateFlutterAssetDirectories(staged.map(demo => (demo as Record<string, any>).id as string));

  const failed = (sourceCatalog.demos as OfficialDemo[]).filter(demo => demo.status !== "passed").length;
  console.log(`build_mini_apps: staged ${staged.length} official app(s), ${failed} build/runtime failure(s)`);
  console.log(`build_mini_apps: Flutter asset catalog=${assetCatalogPath}`);
  console.log(`build_mini_apps: JS import catalog=${generatedJsCatalog}`);
  console.log(`build_mini_apps: Editor compositor registry=${generatedCompositorSurfaces}`);
  if (run.status !== 0) {
    console.warn(`build_mini_apps: official sweep reported failures (exit ${run.status}); successful demos were staged and failures remain in ${sourceCatalogPath}`);
  }
  return { staged: staged.length, failed, catalogPath: assetCatalogPath };
}

export async function buildMiniApps(args: string[] = process.argv.slice(2)): Promise<BuildGuestResult[]> {
  const options = parseOptions(args);
  if (!options.officialOnly) {
    const systemFile = resolve(scriptRoot, "../pocket.system.json");
    const validated = await validateSystemFile(systemFile);
    if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
    const resolved = await resolveSystemDocument(validated.value.contract, {
      appRoot: dirname(systemFile),
      target: "pocket-flutter",
    });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  }

  const results: BuildGuestResult[] = [];
  if (!options.officialOnly) {
    for (const app of miniApps) {
      const assets = resolve(scriptRoot, `../../assets/apps/${app.name}`);
      console.log(`build_mini_apps: building ${app.name} from ${app.projectRoot}`);
      prepareMiniAppAssets(app);
      results.push(await buildGuest({
        projectRoot: app.projectRoot,
        copyAssetsTo: assets,
        keepSource: resolve(app.projectRoot, ".pocket-build/app.js"),
      }));
      console.log(`build_mini_apps: wrote ${assets}`);
    }
  }
  stageOfficialDemos(options);
  return results;
}

if (import.meta.main) {
  try {
    await buildMiniApps();
  } catch (error) {
    console.error(`build_mini_apps: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
