import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ContractDiagnostic,
  PocketManifestV2,
  PocketSystemPackageV1,
  PocketSystemV1,
  ResolvedSystemPlan,
  SystemPackageInput,
  SystemResolutionResult,
} from "../.cache/pocketjs/framework/src/manifest/index.ts";
import {
  loadPocketFlutterPlatformContracts,
  POCKET_FLUTTER_TARGET_ID,
} from "./flutter_target.ts";

const sdkRoot = resolve(import.meta.dir, "..");
const upstreamRoot = join(sdkRoot, ".cache/pocketjs");
const upstreamMarker = join(upstreamRoot, ".pocketjs-revision");

type UpstreamManifestApi = Pick<
  typeof import("../.cache/pocketjs/framework/src/manifest/index.ts"),
  | "validatePocketSystem"
  | "validatePocketManifest"
  | "validateAndResolveSystemPlan"
>;

let upstreamApiPromise: Promise<UpstreamManifestApi> | undefined;

function ensurePinnedUpstream(): void {
  const bootstrap = join(sdkRoot, "scripts/prepare_upstream.py");
  if (!existsSync(bootstrap)) {
    throw new Error(`build_system: pinned upstream bootstrap is missing: ${bootstrap}`);
  }
  const result = spawnSync("python3", [bootstrap], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `build_system: pinned PocketJS bootstrap failed (${result.status ?? result.signal ?? "unknown"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  if (!existsSync(upstreamMarker)) {
    throw new Error(`build_system: pinned PocketJS cache has no revision marker: ${upstreamMarker}`);
  }
}

async function upstreamManifestApi(): Promise<UpstreamManifestApi> {
  if (!upstreamApiPromise) {
    upstreamApiPromise = (async () => {
      ensurePinnedUpstream();
      // Keep this lazy: a clean checkout materializes the ignored upstream
      // cache in ensurePinnedUpstream before Bun evaluates its TypeScript.
      return await import("../.cache/pocketjs/framework/src/manifest/index.ts") as UpstreamManifestApi;
    })().catch((error) => {
      upstreamApiPromise = undefined;
      throw error;
    });
  }
  return upstreamApiPromise;
}

export interface ValidatedSystemPackage {
  readonly package: string;
  /** Catalog manifest path, interpreted relative to the supplied appRoot. */
  readonly source: string;
  readonly path: string;
  readonly required: boolean;
  readonly installed: boolean;
  readonly manifest: PocketManifestV2;
}

/**
 * A schema-valid official PocketSystemV1 contract plus its checked package
 * inputs. This result is not a ResolvedSystemPlan: no host profile, target
 * capabilities, compositor surfaces, or runtime projection have been inferred.
 */
export interface ValidatedSystemContract {
  readonly kind: "validated-pocket-system-contract";
  /** Canonical field ordering using the official PocketSystemV1 shape. */
  readonly contract: PocketSystemV1;
  readonly packages: readonly ValidatedSystemPackage[];
}

export type SystemContractValidationResult =
  | { readonly ok: true; readonly value: ValidatedSystemContract }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

export interface ValidateSystemOptions {
  /** Root for catalog manifest paths. It must be supplied by the consumer. */
  readonly appRoot: string;
}

export interface ResolveSystemOptions extends ValidateSystemOptions {
  /** Must name a pinned upstream target or the SDK's explicit Flutter target. */
  readonly target?: string;
}

export type ResolvedSystemDocument =
  | {
      readonly ok: true;
      readonly plan: ResolvedSystemPlan;
      readonly compositorSurfaces?: Readonly<Record<string, number>>;
    }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

function diagnostic(code: string, path: string, message: string): ContractDiagnostic {
  return { code, path, message };
}

function normalizeContract(system: PocketSystemV1): PocketSystemV1 {
  return {
    $schema: system.$schema,
    pocketSystem: system.pocketSystem,
    id: system.id,
    name: system.name,
    title: system.title,
    version: system.version,
    roles: { systemUI: system.roles.systemUI },
    applications: {
      installPolicy: {
        model: system.applications.installPolicy.model,
        mutable: system.applications.installPolicy.mutable,
      },
      backgroundExecution: system.applications.backgroundExecution,
      catalog: system.applications.catalog.map((entry) => ({
        package: entry.package,
        manifest: entry.manifest,
        required: entry.required,
        ...(entry.presentation
          ? {
              presentation: {
                title: entry.presentation.title,
                viewport: [entry.presentation.viewport[0], entry.presentation.viewport[1]] as const,
              },
            }
          : {}),
      })),
    },
    installation: {
      installedPackages: [...system.installation.installedPackages],
    },
  };
}

function insideRoot(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function parseJsonFile(path: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate the official PocketSystemV1 schema and build-time product
 * admission rules without inventing a target profile. Catalog package
 * manifests are resolved from the caller-supplied appRoot and validated by
 * the pinned upstream Pocket manifest validator.
 */
export async function validateSystemDocument(
  input: unknown,
  options: ValidateSystemOptions,
): Promise<SystemContractValidationResult> {
  const api = await upstreamManifestApi();
  const systemResult = api.validatePocketSystem(input);
  if (!systemResult.ok) return { ok: false, diagnostics: systemResult.diagnostics };

  const system = systemResult.value;
  const appRoot = resolve(options.appRoot);
  const diagnostics: ContractDiagnostic[] = [];
  const catalogByPackage = new Map<string, PocketSystemPackageV1>();
  const catalogByManifest = new Map<string, PocketSystemPackageV1>();
  const installed = new Set(system.installation.installedPackages);
  const checkedPackages: ValidatedSystemPackage[] = [];
  const outputOwners = new Map<string, string>();

  system.applications.catalog.forEach((entry, index) => {
    const entryPath = `/applications/catalog/${index}`;
    const previousPackage = catalogByPackage.get(entry.package);
    if (previousPackage) {
      diagnostics.push(diagnostic(
        "system.duplicatePackage",
        `${entryPath}/package`,
        `package ${JSON.stringify(entry.package)} appears more than once`,
      ));
    } else {
      catalogByPackage.set(entry.package, entry);
    }

    const previousManifest = catalogByManifest.get(entry.manifest);
    if (previousManifest) {
      diagnostics.push(diagnostic(
        "system.duplicateManifest",
        `${entryPath}/manifest`,
        `manifest ${JSON.stringify(entry.manifest)} appears more than once`,
      ));
    } else {
      catalogByManifest.set(entry.manifest, entry);
    }

    if (entry.required && !installed.has(entry.package)) {
      diagnostics.push(diagnostic(
        "system.requiredPackageNotInstalled",
        "/installation/installedPackages",
        `required package ${entry.package} is absent from the installation snapshot`,
      ));
    }

    const manifestPath = resolve(appRoot, entry.manifest);
    if (!insideRoot(appRoot, manifestPath)) {
      diagnostics.push(diagnostic(
        "system.manifestOutsideRoot",
        `${entryPath}/manifest`,
        `manifest ${JSON.stringify(entry.manifest)} resolves outside ${appRoot}`,
      ));
      return;
    }
    if (!existsSync(manifestPath)) {
      diagnostics.push(diagnostic(
        "system.manifestMissing",
        `${entryPath}/manifest`,
        `manifest file does not exist: ${manifestPath}`,
      ));
      return;
    }

    const parsed = parseJsonFile(manifestPath);
    if (!parsed.ok) {
      diagnostics.push(diagnostic(
        "system.manifestInvalidJson",
        `${entryPath}/manifest`,
        `${manifestPath}: ${parsed.message}`,
      ));
      return;
    }
    const manifestResult = api.validatePocketManifest(parsed.value);
    if (!manifestResult.ok) {
      for (const item of manifestResult.diagnostics) {
        diagnostics.push({
          ...item,
          path: `${entryPath}/resolved${item.path}`,
          message: `${manifestPath}: ${item.message}`,
        });
      }
      return;
    }

    const manifest = manifestResult.value;
    if (manifest.id !== entry.package) {
      diagnostics.push(diagnostic(
        "system.packageMismatch",
        `${entryPath}/package`,
        `catalog names ${entry.package}, manifest declares ${manifest.id}`,
      ));
    }

    const output = manifest.app.output ?? manifest.app.entry.split("/").pop()!.replace(/\.tsx?$/, "");
    const outputOwner = outputOwners.get(output);
    if (outputOwner && outputOwner !== entry.package) {
      diagnostics.push(diagnostic(
        "system.duplicateOutput",
        `${entryPath}/resolved/app/output`,
        `artifact output ${JSON.stringify(output)} is already owned by ${outputOwner}`,
      ));
    } else {
      outputOwners.set(output, entry.package);
    }

    checkedPackages.push({
      package: entry.package,
      source: entry.manifest,
      path: manifestPath,
      required: entry.required,
      installed: installed.has(entry.package),
      manifest,
    });
  });

  const systemUI = system.roles.systemUI;
  const systemUIEntry = catalogByPackage.get(systemUI);
  if (!systemUIEntry) {
    diagnostics.push(diagnostic(
      "system.systemUIMissing",
      "/roles/systemUI",
      "roles.systemUI must name one applications.catalog entry",
    ));
  } else {
    if (!systemUIEntry.required) {
      diagnostics.push(diagnostic(
        "system.systemUIRemovable",
        "/roles/systemUI",
        "the System UI package must be required by install policy",
      ));
    }
    if (!installed.has(systemUI)) {
      diagnostics.push(diagnostic(
        "system.systemUINotInstalled",
        "/installation/installedPackages",
        `System UI package ${systemUI} is absent from the installation snapshot`,
      ));
    }
  }

  for (const packageId of installed) {
    if (!catalogByPackage.has(packageId)) {
      diagnostics.push(diagnostic(
        "system.installedPackageUnknown",
        "/installation/installedPackages",
        `installed package ${packageId} is absent from the application catalog`,
      ));
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      kind: "validated-pocket-system-contract",
      contract: normalizeContract(system),
      packages: checkedPackages,
    },
  };
}

/**
 * Read a PocketSystemV1 document and resolve its catalog manifests relative to
 * the directory containing that file.
 */
export async function validateSystemFile(systemPath: string): Promise<SystemContractValidationResult> {
  const absoluteSystemPath = resolve(systemPath);
  if (!existsSync(absoluteSystemPath)) {
    return {
      ok: false,
      diagnostics: [diagnostic("system.manifestMissing", "/", `system manifest does not exist: ${absoluteSystemPath}`)],
    };
  }
  const parsed = parseJsonFile(absoluteSystemPath);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: [diagnostic("system.manifestInvalidJson", "/", `${absoluteSystemPath}: ${parsed.message}`)],
    };
  }
  return validateSystemDocument(parsed.value, { appRoot: dirname(absoluteSystemPath) });
}

/**
 * Resolve through the pinned upstream target registry, or the SDK's explicit
 * Pocket Flutter profile. Flutter's trusted consumer registry is derived
 * from the official catalog order; Dart consumes it without choosing handles.
 */
export async function resolveSystemDocument(
  input: unknown,
  options: ResolveSystemOptions,
): Promise<ResolvedSystemDocument> {
  const validation = await validateSystemDocument(input, options);
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };
  if (!options.target) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        "system.targetRequired",
        "/target",
        "a registered target is required to produce a ResolvedSystemPlan",
      )],
    };
  }

  const api = await upstreamManifestApi();
  const packages: SystemPackageInput[] = validation.value.packages.map((entry) => ({
    source: entry.source,
    manifest: entry.manifest,
  }));
  const flutterTarget = options.target === POCKET_FLUTTER_TARGET_ID;
  const registry = flutterTarget ? await loadPocketFlutterPlatformContracts() : undefined;
  const resolution = api.validateAndResolveSystemPlan(
    validation.value.contract,
    { target: options.target, packages },
    registry,
  ) as SystemResolutionResult;
  if (!resolution.ok || !flutterTarget) return resolution;

  const compositorSurfaces = deriveCompositorSurfaceRegistry(
    validation.value,
    resolution.plan,
  );
  if (!compositorSurfaces.ok) return compositorSurfaces;
  return { ...resolution, compositorSurfaces: compositorSurfaces.value };
}

const FIRST_APPLICATION_SURFACE_HANDLE = 2;
const LAST_APPLICATION_SURFACE_HANDLE = 63;

type CompositorSurfaceRegistryResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

/**
 * Assign stable native surface ids from official catalog order. The System UI
 * is omitted and does not consume a slot. Uninstalled catalog entries reserve
 * their position so installing one cannot renumber later applications.
 */
export function deriveCompositorSurfaceRegistry(
  validation: ValidatedSystemContract,
  plan: ResolvedSystemPlan,
): CompositorSurfaceRegistryResult {
  const catalogApplications = validation.contract.applications.catalog
    .filter((entry) => entry.package !== validation.contract.roles.systemUI);
  if (catalogApplications.length > LAST_APPLICATION_SURFACE_HANDLE - FIRST_APPLICATION_SURFACE_HANDLE + 1) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        "system.compositorHandleCapacityExceeded",
        "/applications/catalog",
        `Pocket Flutter supports at most ${LAST_APPLICATION_SURFACE_HANDLE - FIRST_APPLICATION_SURFACE_HANDLE + 1} child application handles (reserved range ${FIRST_APPLICATION_SURFACE_HANDLE}..${LAST_APPLICATION_SURFACE_HANDLE})`,
      )],
    };
  }

  const plannedApplications = new Set(plan.applications.map((application) => application.package));
  const installedApplications = new Set(
    validation.contract.installation.installedPackages.filter(
      (packageId) => packageId !== validation.contract.roles.systemUI,
    ),
  );
  if (
    plannedApplications.size !== installedApplications.size ||
    plan.applications.length !== installedApplications.size ||
    [...plannedApplications].some((packageId) => !installedApplications.has(packageId))
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        "system.compositorPlanCatalogMismatch",
        "/applications/catalog",
        "resolved child applications do not match the validated installation snapshot",
      )],
    };
  }

  const registry: Record<string, number> = {};
  catalogApplications.forEach((entry, index) => {
    if (plannedApplications.has(entry.package)) {
      registry[entry.package] = FIRST_APPLICATION_SURFACE_HANDLE + index;
    }
  });
  return { ok: true, value: registry };
}

export type OfficialPocketSystemPlan = ResolvedSystemPlan;

function printDiagnostics(diagnostics: readonly ContractDiagnostic[]): void {
  for (const item of diagnostics) {
    console.error(`${item.code} ${item.path}: ${item.message}`);
  }
}

async function main(args: readonly string[]): Promise<void> {
  let systemPath: string | undefined;
  let target: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--target") {
      target = args[index + 1];
      if (!target || target.startsWith("--")) throw new Error("build_system: --target requires a target id");
      index += 1;
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      if (!target) throw new Error("build_system: --target requires a target id");
    } else if (arg.startsWith("-")) {
      throw new Error(`build_system: unknown option ${arg}`);
    } else if (!systemPath) {
      systemPath = arg;
    } else {
      throw new Error(`build_system: unexpected positional argument ${arg}`);
    }
  }

  if (!systemPath) {
    console.error("Usage: bun sdk/scripts/build_system.ts <pocket.system.json> [--target=<registered-target>]");
    process.exitCode = 2;
    return;
  }

  const validation = await validateSystemFile(systemPath);
  if (!validation.ok) {
    printDiagnostics(validation.diagnostics);
    process.exitCode = 1;
    return;
  }
  if (target) {
    const resolution = await resolveSystemDocument(validation.value.contract, {
      appRoot: dirname(resolve(systemPath)),
      target,
    });
    if (!resolution.ok) {
      printDiagnostics(resolution.diagnostics);
      process.exitCode = 1;
      return;
    }
    if (target === POCKET_FLUTTER_TARGET_ID) {
      const compositorSurfaces = resolution.compositorSurfaces;
      if (compositorSurfaces === undefined) {
        throw new Error('build_system: Pocket Flutter resolution omitted compositor surfaces');
      }
      console.log(JSON.stringify({ plan: resolution.plan, compositorSurfaces }, null, 2));
    } else {
      console.log(JSON.stringify(resolution.plan, null, 2));
    }
    return;
  }

  // Without an explicit target, emit only the normalized official contract;
  // this does not claim that a target System plan or compositor is implemented.
  console.log(JSON.stringify(validation.value.contract, null, 2));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
