import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { UPSTREAM_REVISION } from "./prebuilt_tools.mjs";
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
import {
  POCKET_MEMORY_POLICIES,
  POCKET_MEMORY_POLICY_BUDGETS,
  type PocketMemoryBudget,
  type PocketMemoryPolicy,
} from "../packages/pocket_ui/src/system-memory.ts";
import { validatePocketProjectFonts } from "./project_fonts.ts";

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

function resolvePinnedUpstreamRoot(): string {
  const sourceBuild = process.env.POCKET_SOURCE_BUILD === "1";
  if (
    !sourceBuild &&
    existsSync(upstreamMarker) &&
    readFileSync(upstreamMarker, "utf8").trim() === UPSTREAM_REVISION &&
    existsSync(join(upstreamRoot, "framework/src/manifest/index.ts"))
  ) {
    return upstreamRoot;
  }
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
  return upstreamRoot;
}

async function upstreamManifestApi(): Promise<UpstreamManifestApi> {
  if (!upstreamApiPromise) {
    upstreamApiPromise = (async () => {
      const root = resolvePinnedUpstreamRoot();
      // Keep this lazy: a clean checkout materializes the ignored upstream
      // cache in resolvePinnedUpstreamRoot before Bun evaluates its TypeScript.
      return await import(pathToFileURL(join(root, "framework/src/manifest/index.ts")).href) as UpstreamManifestApi;
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

type PocketSystemCatalogEntryWithMemory = Omit<PocketSystemPackageV1, "presentation"> & {
  readonly memory?: PocketMemoryBudget;
  readonly memoryPolicy?: PocketMemoryPolicy;
  readonly presentation?: {
    readonly title?: string;
    readonly viewport?: readonly [number, number];
    readonly style?: string;
  };
};

type PocketSystemWithMemory = Omit<PocketSystemV1, "applications"> & {
  readonly applications: Omit<PocketSystemV1["applications"], "catalog"> & {
    readonly presentation?: Readonly<Record<string, unknown>>;
    readonly catalog: readonly PocketSystemCatalogEntryWithMemory[];
  };
};

/**
 * A schema-valid official PocketSystemV1 contract plus its checked package
 * inputs. This result is not a ResolvedSystemPlan: no host profile, target
 * capabilities, compositor surfaces, or runtime projection have been inferred.
 */
export interface ValidatedSystemContract {
  readonly kind: "validated-pocket-system-contract";
  /** Canonical field ordering using the official PocketSystemV1 shape. */
  readonly contract: PocketSystemWithMemory;
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
      readonly plan: ResolvedSystemPlanWithMemory;
      readonly compositorSurfaces?: Readonly<Record<string, number>>;
    }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

type ResolvedSystemPackageWithMemory = ResolvedSystemPackage & {
  readonly memory?: PocketMemoryBudget;
  readonly memoryPolicy?: PocketMemoryPolicy;
  readonly presentation?: {
    readonly title?: string;
    readonly viewport?: readonly [number, number];
    readonly style?: string;
  };
};

type ResolvedSystemPlanWithMemory = Omit<ResolvedSystemPlan, "systemUI" | "applications"> & {
  readonly presentation?: Readonly<Record<string, unknown>>;
  readonly systemUI: ResolvedSystemPackageWithMemory;
  readonly applications: readonly ResolvedSystemPackageWithMemory[];
};

function diagnostic(code: string, path: string, message: string): ContractDiagnostic {
  return { code, path, message };
}

const MIN_HEAP_LIMIT_BYTES = 64 * 1024;
const MAX_HEAP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_PAK_BYTES = 1;
const MAX_PAK_BYTES = 512 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMemoryInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  diagnostics: ContractDiagnostic[],
): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    diagnostics.push(diagnostic(
      "system.invalidMemoryBudget",
      path,
      `must be a safe integer from ${minimum} through ${maximum}`,
    ));
    return undefined;
  }
  return value as number;
}

function readMemoryPolicy(
  value: unknown,
  path: string,
  diagnostics: ContractDiagnostic[],
): PocketMemoryPolicy | undefined {
  if (typeof value !== "string" || !(POCKET_MEMORY_POLICIES as readonly string[]).includes(value)) {
    diagnostics.push(diagnostic(
      "system.invalidMemoryPolicy",
      path,
      `must be one of ${POCKET_MEMORY_POLICIES.join(", ")}`,
    ));
    return undefined;
  }
  return value as PocketMemoryPolicy;
}

function parseMemoryExtension(
  entry: Record<string, unknown>,
  entryPath: string,
  diagnostics: ContractDiagnostic[],
): { memory?: PocketMemoryBudget; memoryPolicy?: PocketMemoryPolicy } {
  const hasMemory = Object.prototype.hasOwnProperty.call(entry, "memory");
  const hasMemoryPolicy = Object.prototype.hasOwnProperty.call(entry, "memoryPolicy");
  if (!hasMemory && !hasMemoryPolicy) return {};

  const policy = hasMemoryPolicy
    ? readMemoryPolicy(entry.memoryPolicy, `${entryPath}/memoryPolicy`, diagnostics)
    : undefined;
  let memory: PocketMemoryBudget | undefined;
  if (hasMemory) {
    if (!isRecord(entry.memory)) {
      diagnostics.push(diagnostic(
        "system.invalidMemoryBudget",
        `${entryPath}/memory`,
        "must be an object when provided",
      ));
    } else {
      const unknown = Object.keys(entry.memory).filter((key) => key !== "heapLimitBytes" && key !== "maxPakBytes");
      for (const key of unknown) {
        diagnostics.push(diagnostic(
          "system.invalidMemoryBudget",
          `${entryPath}/memory/${key}`,
          "unknown memory field",
        ));
      }
      const parsed: PocketMemoryBudget = {};
      if (Object.prototype.hasOwnProperty.call(entry.memory, "heapLimitBytes")) {
        const value = readMemoryInteger(
          entry.memory.heapLimitBytes,
          `${entryPath}/memory/heapLimitBytes`,
          MIN_HEAP_LIMIT_BYTES,
          MAX_HEAP_LIMIT_BYTES,
          diagnostics,
        );
        if (value !== undefined) parsed.heapLimitBytes = value;
      }
      if (Object.prototype.hasOwnProperty.call(entry.memory, "maxPakBytes")) {
        const value = readMemoryInteger(
          entry.memory.maxPakBytes,
          `${entryPath}/memory/maxPakBytes`,
          MIN_PAK_BYTES,
          MAX_PAK_BYTES,
          diagnostics,
        );
        if (value !== undefined) parsed.maxPakBytes = value;
      }
      memory = parsed;
    }
  }
  if (policy !== undefined) {
    const expected = POCKET_MEMORY_POLICY_BUDGETS[policy];
    if (memory?.heapLimitBytes !== undefined && memory.heapLimitBytes !== expected.heapLimitBytes) {
      diagnostics.push(diagnostic(
        "system.memoryPolicyMismatch",
        `${entryPath}/memory/heapLimitBytes`,
        `must match ${entryPath}/memoryPolicy=${policy}`,
      ));
    }
    memory = { ...expected, ...memory };
  }
  return { memory, memoryPolicy: policy };
}

const VALID_PRESENTATION_STYLES = ["sheet", "page", "modal", "bottom-sheet", "push"] as const;

function parsePresentationStyleField(
  rawStyle: unknown,
  path: string,
  diagnostics: ContractDiagnostic[],
): string | undefined {
  if (typeof rawStyle === "string") {
    const normalized = rawStyle.trim().toLowerCase();
    if ((VALID_PRESENTATION_STYLES as readonly string[]).includes(normalized)) {
      return normalized;
    }
  }
  diagnostics.push(diagnostic(
    "system.invalidPresentationStyle",
    path,
    `must be one of ${VALID_PRESENTATION_STYLES.join(", ")}`,
  ));
  return undefined;
}

function sanitizeManifestPresentation(
  input: unknown,
  entryPath: string,
  diagnostics: ContractDiagnostic[],
): { value: unknown; style?: string } {
  if (!isRecord(input)) return { value: input };
  let style: string | undefined;
  const checkPresentation = (raw: unknown, path: string): void => {
    if (raw === undefined) return;
    if (!isRecord(raw)) {
      diagnostics.push(diagnostic("system.invalidPresentation", path, "presentation must be an object"));
      return;
    }
    for (const key of Object.keys(raw)) {
      if (key !== "style") {
        diagnostics.push(diagnostic(
          "system.invalidPresentation",
          `${path}/${key}`,
          `unknown presentation field ${key}`,
        ));
      }
    }
    if (Object.prototype.hasOwnProperty.call(raw, "style")) {
      const parsed = parsePresentationStyleField(raw.style, `${path}/style`, diagnostics);
      if (parsed) style = parsed;
    }
  };
  checkPresentation(input.presentation, `${entryPath}/resolved/presentation`);
  if (isRecord(input.app)) {
    checkPresentation(input.app.presentation, `${entryPath}/resolved/app/presentation`);
  }
  const next: Record<string, unknown> = { ...input };
  delete next.presentation;
  if (isRecord(next.app) && Object.prototype.hasOwnProperty.call(next.app, "presentation")) {
    const nextApp = { ...next.app };
    delete nextApp.presentation;
    next.app = nextApp;
  }
  return { value: next, ...(style ? { style } : {}) };
}

interface SanitizedSystemInput {
  readonly value: unknown;
  readonly defaultPresentation?: Record<string, unknown>;
  readonly memoryByPackage: ReadonlyMap<string, {
    memory?: PocketMemoryBudget;
    memoryPolicy?: PocketMemoryPolicy;
    presentationStyle?: string;
  }>;
  readonly diagnostics: readonly ContractDiagnostic[];
}

/** Remove only this SDK extension before the pinned upstream schema validator. */
function sanitizeSystemMemory(input: unknown): SanitizedSystemInput {
  const diagnostics: ContractDiagnostic[] = [];
  const memoryByPackage = new Map<string, {
    memory?: PocketMemoryBudget;
    memoryPolicy?: PocketMemoryPolicy;
    presentationStyle?: string;
  }>();
  if (!isRecord(input) || !isRecord(input.applications) || !Array.isArray(input.applications.catalog)) {
    return { value: input, memoryByPackage, diagnostics };
  }
  let defaultPresentation: Record<string, unknown> | undefined;
  if (Object.prototype.hasOwnProperty.call(input.applications, "presentation")) {
    if (!isRecord(input.applications.presentation)) {
      diagnostics.push(diagnostic(
        "system.invalidPresentation",
        "/applications/presentation",
        "must be an object when provided",
      ));
    } else {
      for (const key of Object.keys(input.applications.presentation)) {
        if (key !== "style") {
          diagnostics.push(diagnostic(
            "system.invalidPresentation",
            `/applications/presentation/${key}`,
            `unknown presentation field ${key}`,
          ));
        }
      }
      const rawStyle = input.applications.presentation.style;
      if (rawStyle !== undefined) {
        const parsed = parsePresentationStyleField(rawStyle, "/applications/presentation/style", diagnostics);
        if (parsed) defaultPresentation = { ...input.applications.presentation, style: parsed };
      } else {
        defaultPresentation = { ...input.applications.presentation };
      }
    }
  }
  const catalog = input.applications.catalog.map((rawEntry, index) => {
    if (!isRecord(rawEntry)) return rawEntry;
    const packageId = typeof rawEntry.package === "string" ? rawEntry.package : `index-${index}`;
    const parsed = parseMemoryExtension(
      rawEntry,
      `/applications/catalog/${index}`,
      diagnostics,
    );
    let presentationStyle: string | undefined;
    let sanitizedPresentation = rawEntry.presentation;
    if (isRecord(rawEntry.presentation) && Object.prototype.hasOwnProperty.call(rawEntry.presentation, "style")) {
      presentationStyle = parsePresentationStyleField(
        rawEntry.presentation.style,
        `/applications/catalog/${index}/presentation/style`,
        diagnostics,
      );
      const { style: _style, ...restPresentation } = rawEntry.presentation;
      sanitizedPresentation = Object.keys(restPresentation).length > 0 ? restPresentation : undefined;
    }
    if (typeof rawEntry.package === "string") {
      memoryByPackage.set(packageId, {
        ...parsed,
        ...(presentationStyle ? { presentationStyle } : {}),
      });
    }
    const { memory: _memory, memoryPolicy: _memoryPolicy, presentation: _presentation, ...baseEntry } = rawEntry;
    return {
      ...baseEntry,
      ...(sanitizedPresentation !== undefined ? { presentation: sanitizedPresentation } : {}),
    };
  });
  const { presentation: _appPresentation, ...baseApplications } = input.applications;
  return {
    value: {
      ...input,
      applications: { ...baseApplications, catalog },
    },
    ...(defaultPresentation ? { defaultPresentation } : {}),
    memoryByPackage,
    diagnostics,
  };
}

function normalizeContract(
  system: PocketSystemV1,
  memoryByPackage: ReadonlyMap<string, {
    memory?: PocketMemoryBudget;
    memoryPolicy?: PocketMemoryPolicy;
    presentationStyle?: string;
  }>,
  defaultPresentation?: Record<string, unknown>,
  manifestStyleByPackage?: ReadonlyMap<string, string>,
): PocketSystemWithMemory {
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
      ...(defaultPresentation ? { presentation: { ...defaultPresentation } } : {}),
      catalog: system.applications.catalog.map((entry) => {
        const resolvedStyle = memoryByPackage.get(entry.package)?.presentationStyle
          ?? manifestStyleByPackage?.get(entry.package);
        const hasPresentation = Boolean(entry.presentation || resolvedStyle);
        return {
          package: entry.package,
          manifest: entry.manifest,
          required: entry.required,
          ...(memoryByPackage.get(entry.package)?.memory
            ? { memory: { ...memoryByPackage.get(entry.package)!.memory } }
            : {}),
          ...(memoryByPackage.get(entry.package)?.memoryPolicy
            ? { memoryPolicy: memoryByPackage.get(entry.package)!.memoryPolicy }
            : {}),
          ...(hasPresentation
            ? {
                presentation: {
                  ...(entry.presentation
                    ? {
                        title: entry.presentation.title,
                        viewport: [entry.presentation.viewport[0], entry.presentation.viewport[1]] as const,
                      }
                    : {}),
                  ...(resolvedStyle ? { style: resolvedStyle } : {}),
                },
              }
            : {}),
        };
      }),
    },
    installation: {
      installedPackages: [...system.installation.installedPackages],
    },
  };
}

function upstreamSystemDocument(system: PocketSystemWithMemory): PocketSystemV1 {
  return sanitizeSystemMemory(system).value as PocketSystemV1;
}

function attachMemoryToPlan(
  plan: ResolvedSystemPlan,
  contract: PocketSystemWithMemory,
): ResolvedSystemPlanWithMemory {
  const memoryByPackage = new Map(
    contract.applications.catalog.map((entry) => [entry.package, entry]),
  );
  const attach = (entry: ResolvedSystemPackage): ResolvedSystemPackageWithMemory => {
    const memory = memoryByPackage.get(entry.package);
    return {
      ...entry,
      ...(memory?.memory ? { memory: { ...memory.memory } } : {}),
      ...(memory?.memoryPolicy ? { memoryPolicy: memory.memoryPolicy } : {}),
      ...(memory?.presentation ? { presentation: { ...memory.presentation } } : {}),
    };
  };
  return {
    ...plan,
    ...(contract.applications.presentation ? { presentation: { ...contract.applications.presentation } } : {}),
    systemUI: attach(plan.systemUI),
    applications: plan.applications.map(attach),
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
  const sanitized = sanitizeSystemMemory(input);
  const systemResult = api.validatePocketSystem(sanitized.value);
  if (!systemResult.ok) {
    return {
      ok: false,
      diagnostics: [...sanitized.diagnostics, ...systemResult.diagnostics],
    };
  }

  const system = systemResult.value;
  const appRoot = resolve(options.appRoot);
  const diagnostics: ContractDiagnostic[] = [...sanitized.diagnostics];
  const catalogByPackage = new Map<string, PocketSystemPackageV1>();
  const catalogByManifest = new Map<string, PocketSystemPackageV1>();
  const installed = new Set(system.installation.installedPackages);
  const checkedPackages: ValidatedSystemPackage[] = [];
  const outputOwners = new Map<string, string>();
  const manifestStyleByPackage = new Map<string, string>();

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
    const fontValidation = validatePocketProjectFonts(parsed.value, dirname(manifestPath));
    if (!fontValidation.ok) {
      for (const issue of fontValidation.issues) {
        diagnostics.push(diagnostic(
          "system.invalidProjectFont",
          `${entryPath}/resolved/${issue.path}`,
          issue.message,
        ));
      }
    }
    const sanitizedManifest = sanitizeManifestPresentation(fontValidation.schemaInput, entryPath, diagnostics);
    if (sanitizedManifest.style) {
      manifestStyleByPackage.set(entry.package, sanitizedManifest.style);
    }
    const manifestResult = api.validatePocketManifest(sanitizedManifest.value);
    if (!manifestResult.ok) {
      for (const item of manifestResult.diagnostics) {
        // Invalid fonts already have the SDK's precise portable-path error;
        // keep all other official schema failures, including unknown fields.
        if (!fontValidation.ok && item.path === "/fonts" && item.code === "schema.additionalProperty") continue;
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
      contract: normalizeContract(
        system,
        sanitized.memoryByPackage,
        sanitized.defaultPresentation,
        manifestStyleByPackage,
      ),
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
    upstreamSystemDocument(validation.value.contract),
    { target: options.target, packages },
    registry,
  ) as SystemResolutionResult;
  if (!resolution.ok) return resolution;
  const plan = attachMemoryToPlan(resolution.plan, validation.value.contract);
  if (!flutterTarget) return { ...resolution, plan };

  const compositorSurfaces = deriveCompositorSurfaceRegistry(
    validation.value,
    plan,
  );
  if (!compositorSurfaces.ok) return compositorSurfaces;
  return { ...resolution, plan, compositorSurfaces: compositorSurfaces.value };
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
