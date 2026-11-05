import type { HostBridge, JsonObject, JsonValue } from "./host.ts";

export type PocketUpdateDeliveryMode = "auto" | "zip" | "granular";
export type PocketUpdateResolvedMode = "zip" | "granular";
export type PocketUpdateScope = "all" | "code" | "resource";

export type PocketUpdateTarget =
  | { readonly scope: "all" }
  | { readonly scope: "code" }
  | { readonly scope: "resource"; readonly resource: string };

export interface PocketManifestFileShape {
  readonly sha256: string;
  readonly size: number;
  readonly url: string;
}

export interface PocketManifestPakPartShape {
  readonly offset: number;
  readonly sha256: string;
  readonly size: number;
  readonly kind?: "blob" | "metadata";
  readonly key?: string;
  readonly dtype?: number;
}

export interface PocketManifestAssetShape {
  readonly sha256: string;
  readonly size: number;
}

export interface PocketManifestBundleShape {
  readonly format: "7z" | "zip";
  readonly sha256: string;
  readonly size: number;
  readonly url: string;
}

export interface PocketUpdateManifestShape {
  readonly appId: string;
  readonly version: string;
  readonly build: number;
  readonly entry: { readonly sha256: string; readonly size: number };
  readonly entryFormat?: string;
  readonly runtimeAbi?: string;
  readonly worker?: Readonly<Record<string, unknown>> & {
    readonly bytecode?: {
      readonly path?: string;
      readonly sha256?: string;
      readonly bytes?: number;
    };
  };
  readonly pak: {
    readonly sha256: string;
    readonly size: number;
    readonly parts: readonly PocketManifestPakPartShape[];
  };
  readonly files: readonly PocketManifestFileShape[];
  readonly bundle?: PocketManifestBundleShape;
  readonly assets?: Readonly<Record<string, PocketManifestAssetShape>>;
  readonly capabilities?: { readonly requires?: readonly string[]; readonly optional?: readonly string[] };
  readonly permissions?: { readonly requires?: readonly string[]; readonly optional?: readonly string[] };
  readonly memory?: { readonly heapLimitBytes?: number; readonly maxPakBytes?: number };
  readonly guest?: Readonly<Record<string, unknown>>;
}

export interface PocketUpdateDiff {
  readonly hasBaseline: boolean;
  readonly entryChanged: boolean;
  readonly workerChanged: boolean;
  readonly codeChanged: boolean;
  readonly policyChanged?: boolean;
  readonly pakChanged: boolean;
  readonly changedPakEntries: readonly string[];
  readonly changedAssets: readonly string[];
  readonly updatedComponents: readonly string[];
  readonly downloadFiles: readonly PocketManifestFileShape[];
  readonly reusedFiles: readonly PocketManifestFileShape[];
  readonly downloadBytes: number;
  readonly reusedBytes: number;
}

export interface PocketUpdatePlan {
  readonly deliveryMode: PocketUpdateResolvedMode;
  readonly target: PocketUpdateTarget;
  readonly resolvedResource?: string;
  readonly bundle?: PocketManifestBundleShape;
  readonly diff: PocketUpdateDiff;
  readonly downloadFiles: readonly PocketManifestFileShape[];
  readonly reusedFiles: readonly PocketManifestFileShape[];
  readonly downloadBytes: number;
  readonly reusedBytes: number;
}

export class PocketUpdatePlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PocketUpdatePlanError";
    this.code = code;
  }
}

function workerAssetPath(manifest: PocketUpdateManifestShape | null | undefined): string | undefined {
  const path = manifest?.worker?.bytecode?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value ?? null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined && record[key] !== null) {
      sorted[key] = canonicalizeValue(record[key]);
    }
  }
  return sorted;
}

function canonicalWorkerDescriptor(manifest: PocketUpdateManifestShape | null | undefined): string {
  if (!manifest?.worker) return "";
  return JSON.stringify(canonicalizeValue(manifest.worker));
}

function normalizeStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort();
}

function canonicalGuestPolicy(manifest: PocketUpdateManifestShape | null | undefined): string {
  if (!manifest) return "";
  const guestObj =
    manifest.guest && typeof manifest.guest === "object" && !Array.isArray(manifest.guest)
      ? (manifest.guest as Record<string, unknown>)
      : undefined;
  const rawCaps = (manifest.capabilities ?? guestObj?.capabilities) as Record<string, unknown> | undefined;
  const rawPerms = (manifest.permissions ?? guestObj?.permissions) as Record<string, unknown> | undefined;
  const rawMem = (manifest.memory ?? guestObj?.memory) as Record<string, unknown> | undefined;

  const capReq = normalizeStringSet(rawCaps?.requires ?? rawCaps?.required);
  const capOpt = normalizeStringSet(rawCaps?.optional).filter((item) => !capReq.includes(item));
  const permReq = normalizeStringSet(rawPerms?.requires ?? rawPerms?.required);
  const permOpt = normalizeStringSet(rawPerms?.optional).filter((item) => !permReq.includes(item));
  const heapLimitBytes = typeof rawMem?.heapLimitBytes === "number" ? rawMem.heapLimitBytes : null;
  const maxPakBytes = typeof rawMem?.maxPakBytes === "number" ? rawMem.maxPakBytes : null;

  return JSON.stringify({
    capReq,
    capOpt,
    permReq,
    permOpt,
    heapLimitBytes,
    maxPakBytes,
  });
}

function collectPakBlobMap(manifest: PocketUpdateManifestShape): Map<string, { sha256: string; size: number; dtype: number }> {
  const result = new Map<string, { sha256: string; size: number; dtype: number }>();
  let unnamedIndex = 0;
  for (const part of manifest.pak.parts) {
    if (part.kind === "metadata") {
      if (part.key !== undefined || part.dtype !== undefined) {
        throw new PocketUpdatePlanError("manifest-parts", "Metadata PAK part must not declare key or dtype");
      }
      continue;
    }
    if (part.key !== undefined) {
      if (!part.key || part.key.trim().length === 0) {
        throw new PocketUpdatePlanError("manifest-parts", "PAK part key must not be empty");
      }
      if (result.has(part.key)) {
        throw new PocketUpdatePlanError("manifest-parts", `Duplicate PAK part key "${part.key}"`);
      }
      result.set(part.key, { sha256: part.sha256, size: part.size, dtype: part.dtype ?? 0 });
    } else if (part.kind === "blob") {
      result.set(`blob#${unnamedIndex}`, { sha256: part.sha256, size: part.size, dtype: part.dtype ?? 0 });
      unnamedIndex += 1;
    }
  }
  return result;
}

function collectLooseAssetMap(manifest: PocketUpdateManifestShape): Map<string, { sha256: string; size: number }> {
  const result = new Map<string, { sha256: string; size: number }>();
  const workerPath = workerAssetPath(manifest);
  for (const [name, asset] of Object.entries(manifest.assets ?? {})) {
    if (workerPath && name === workerPath) continue;
    result.set(name, { sha256: asset.sha256, size: asset.size });
  }
  return result;
}

/**
 * Compute the exact component and blob differential between an already-installed
 * baseline manifest and a candidate update manifest.
 */
export function diffUpdateManifests(
  baseline: PocketUpdateManifestShape | null | undefined,
  candidate: PocketUpdateManifestShape,
  cachedBlobHashes?: Iterable<string>,
): PocketUpdateDiff {
  const knownHashes = new Set<string>(cachedBlobHashes ?? []);
  if (baseline) {
    for (const file of baseline.files) {
      knownHashes.add(file.sha256);
    }
  }

  const entryChanged =
    !baseline ||
    baseline.entry.sha256 !== candidate.entry.sha256 ||
    baseline.entry.size !== candidate.entry.size ||
    (baseline.entryFormat ?? "bytecode") !== (candidate.entryFormat ?? "bytecode") ||
    (baseline.runtimeAbi ?? "") !== (candidate.runtimeAbi ?? "");
  const workerChanged = !baseline
    ? Boolean(candidate.worker)
    : canonicalWorkerDescriptor(baseline) !== canonicalWorkerDescriptor(candidate);
  const policyChanged = !baseline ? false : canonicalGuestPolicy(baseline) !== canonicalGuestPolicy(candidate);
  const codeChanged = entryChanged || workerChanged;
  const pakChanged = !baseline || baseline.pak.sha256 !== candidate.pak.sha256 || baseline.pak.size !== candidate.pak.size;

  const basePakBlobs = baseline ? collectPakBlobMap(baseline) : new Map<string, { sha256: string; size: number; dtype: number }>();
  const nextPakBlobs = collectPakBlobMap(candidate);

  const changedPakEntries: string[] = [];
  if (!baseline) {
    for (const key of nextPakBlobs.keys()) {
      changedPakEntries.push(key);
    }
  } else if (pakChanged) {
    if (basePakBlobs.size === 0 && nextPakBlobs.size === 0) {
      // Legacy manifests without named blob annotations: identify changed non-entry/non-asset parts by hash.
      const basePartHashes = new Set(baseline.pak.parts.map((part) => part.sha256));
      for (const part of candidate.pak.parts) {
        if (!basePartHashes.has(part.sha256)) {
          changedPakEntries.push(part.key ?? `offset:${part.offset}`);
        }
      }
    } else if (basePakBlobs.size === 0 && nextPakBlobs.size > 0) {
      // Upgrade from an unannotated legacy baseline PAK to an annotated candidate PAK:
      // In PocketJS .pak layout, blob ranges start at 16-byte aligned offsets > 0.
      const legacyBlobParts = baseline.pak.parts.filter(
        (part) => part.kind !== "metadata" && part.offset > 0 && part.offset % 16 === 0,
      );
      const effectiveBaseParts = legacyBlobParts.length > 0 ? legacyBlobParts : baseline.pak.parts;
      const available = new Map<string, number>();
      for (const part of effectiveBaseParts) {
        const token = `${part.sha256}:${part.size}`;
        available.set(token, (available.get(token) ?? 0) + 1);
      }
      let matchedCount = 0;
      for (const key of [...nextPakBlobs.keys()].sort()) {
        const next = nextPakBlobs.get(key)!;
        const token = `${next.sha256}:${next.size}`;
        const count = available.get(token) ?? 0;
        if (count > 0) {
          available.set(token, count - 1);
          matchedCount += 1;
        } else {
          changedPakEntries.push(key);
        }
      }
      if (changedPakEntries.length === 0 && matchedCount !== effectiveBaseParts.length) {
        changedPakEntries.push("pak");
      }
    } else {
      const allKeys = new Set<string>([...basePakBlobs.keys(), ...nextPakBlobs.keys()]);
      for (const key of [...allKeys].sort()) {
        const prev = basePakBlobs.get(key);
        const next = nextPakBlobs.get(key);
        if (!prev || !next || prev.sha256 !== next.sha256 || prev.size !== next.size || prev.dtype !== next.dtype) {
          changedPakEntries.push(key);
        }
      }
    }
  }

  const changedAssets: string[] = [];
  if (!baseline) {
    for (const name of collectLooseAssetMap(candidate).keys()) {
      changedAssets.push(name);
    }
  } else {
    const baseAssets = collectLooseAssetMap(baseline);
    const nextAssets = collectLooseAssetMap(candidate);
    const allNames = new Set<string>([...baseAssets.keys(), ...nextAssets.keys()]);
    for (const name of [...allNames].sort()) {
      const prev = baseAssets.get(name);
      const next = nextAssets.get(name);
      if (!prev || !next || prev.sha256 !== next.sha256 || prev.size !== next.size) {
        changedAssets.push(name);
      }
    }
  }

  const updatedComponents: string[] = [];
  if (entryChanged) updatedComponents.push("code");
  if (workerChanged) updatedComponents.push("worker");
  if (policyChanged) updatedComponents.push("policy");
  for (const key of changedPakEntries) updatedComponents.push(`pak:${key}`);
  for (const name of changedAssets) updatedComponents.push(`asset:${name}`);

  const downloadFiles: PocketManifestFileShape[] = [];
  const reusedFiles: PocketManifestFileShape[] = [];
  for (const file of candidate.files) {
    if (knownHashes.has(file.sha256)) {
      reusedFiles.push(file);
    } else {
      downloadFiles.push(file);
    }
  }

  const downloadBytes = downloadFiles.reduce((sum, file) => sum + file.size, 0);
  const reusedBytes = reusedFiles.reduce((sum, file) => sum + file.size, 0);

  return {
    hasBaseline: Boolean(baseline),
    entryChanged,
    workerChanged,
    codeChanged,
    policyChanged,
    pakChanged,
    changedPakEntries,
    changedAssets,
    updatedComponents,
    downloadFiles,
    reusedFiles,
    downloadBytes,
    reusedBytes,
  };
}

function resolveResourceTarget(
  resource: string,
  baseline: PocketUpdateManifestShape | null | undefined,
  candidate: PocketUpdateManifestShape,
): { kind: "pak" | "asset"; id: string; canonical: string } {
  if (resource.trim().length === 0) {
    throw new PocketUpdatePlanError("update-resource-missing", "Resource target name must not be empty");
  }
  const candidateAssets = collectLooseAssetMap(candidate);
  const baselineAssets = baseline ? collectLooseAssetMap(baseline) : new Map<string, { sha256: string; size: number }>();
  const candidatePak = collectPakBlobMap(candidate);
  const baselinePak = baseline ? collectPakBlobMap(baseline) : new Map<string, { sha256: string; size: number; dtype: number }>();

  const hasAsset = (name: string): boolean => candidateAssets.has(name) || baselineAssets.has(name);
  const hasPak = (key: string): boolean => candidatePak.has(key) || baselinePak.has(key);

  if (resource.startsWith("asset:")) {
    const exactName = resource.slice("asset:".length);
    const name = hasAsset(exactName) ? exactName : hasAsset(exactName.trim()) ? exactName.trim() : exactName;
    if (!name.trim() || !hasAsset(name)) {
      throw new PocketUpdatePlanError("update-resource-missing", `Target asset "${name}" does not exist in package manifest`);
    }
    return { kind: "asset", id: name, canonical: `asset:${name}` };
  }
  if (resource.startsWith("pak:")) {
    const exactKey = resource.slice("pak:".length);
    const key = hasPak(exactKey) ? exactKey : hasPak(exactKey.trim()) ? exactKey.trim() : exactKey;
    if (!key.trim() || !hasPak(key)) {
      throw new PocketUpdatePlanError("update-resource-missing", `Target PAK resource "${key}" does not exist in package manifest`);
    }
    return { kind: "pak", id: key, canonical: `pak:${key}` };
  }
  if (hasAsset(resource)) {
    return { kind: "asset", id: resource, canonical: `asset:${resource}` };
  }
  if (hasPak(resource)) {
    return { kind: "pak", id: resource, canonical: `pak:${resource}` };
  }
  const trimmed = resource.trim();
  if (trimmed.startsWith("asset:")) {
    const name = trimmed.slice("asset:".length);
    if (name && hasAsset(name)) return { kind: "asset", id: name, canonical: `asset:${name}` };
  }
  if (trimmed.startsWith("pak:")) {
    const key = trimmed.slice("pak:".length);
    if (key && hasPak(key)) return { kind: "pak", id: key, canonical: `pak:${key}` };
  }
  if (hasAsset(trimmed)) {
    return { kind: "asset", id: trimmed, canonical: `asset:${trimmed}` };
  }
  if (hasPak(trimmed)) {
    return { kind: "pak", id: trimmed, canonical: `pak:${trimmed}` };
  }
  throw new PocketUpdatePlanError("update-resource-missing", `Target resource "${resource}" was not found in assets or PAK entries`);
}

export interface PlanPackageUpdateOptions {
  readonly baseline?: PocketUpdateManifestShape | null;
  readonly candidate: PocketUpdateManifestShape;
  readonly mode?: PocketUpdateDeliveryMode;
  readonly target?: PocketUpdateTarget;
  readonly cachedBlobHashes?: Iterable<string>;
}

/**
 * Plan a package update in JS:
 * - Selects `"zip"` (one-shot bundle download of code + resources) when no baseline is installed
 *   and `candidate.bundle` is available, or when `mode: "zip"` is explicitly requested.
 * - Selects `"granular"` when updating an already-downloaded mini-app (`baseline != null`)
 *   or when `mode: "granular"` / a granular `target` (`code` or single `resource`) is requested.
 * - Enforces that `code`-only updates do not mutate resources and single-`resource` updates
 *   do not mutate code or unrelated resources.
 */
export function planPackageUpdate(options: PlanPackageUpdateOptions): PocketUpdatePlan {
  const mode: PocketUpdateDeliveryMode = options.mode ?? "auto";
  const target: PocketUpdateTarget = options.target ?? { scope: "all" };
  const baseline = options.baseline ?? null;

  if (target.scope !== "all" && mode === "zip") {
    throw new PocketUpdatePlanError(
      "update-mode-conflict",
      `Granular target scope "${target.scope}" cannot be combined with one-shot "zip" mode`,
    );
  }
  if (target.scope !== "all" && !baseline) {
    throw new PocketUpdatePlanError(
      "update-baseline-missing",
      `Granular "${target.scope}" update requires an already-downloaded mini-app baseline`,
    );
  }

  const diff = diffUpdateManifests(baseline, options.candidate, options.cachedBlobHashes);
  let resolvedResource: string | undefined;

  if (target.scope === "code") {
    if (diff.changedPakEntries.length > 0 || diff.changedAssets.length > 0 || (diff.pakChanged && diff.changedPakEntries.length === 0)) {
      throw new PocketUpdatePlanError(
        "update-target-scope",
        `Code-only update rejected because resource files also changed: ${[
          ...diff.changedPakEntries.map((k) => `pak:${k}`),
          ...diff.changedAssets.map((a) => `asset:${a}`),
        ].join(", ") || "pak"}`,
      );
    }
  } else if (target.scope === "resource") {
    const resolved = resolveResourceTarget(target.resource, baseline, options.candidate);
    resolvedResource = resolved.canonical;
    if (diff.codeChanged) {
      throw new PocketUpdatePlanError(
        "update-target-scope",
        `Single-resource update for "${resolved.canonical}" rejected because code also changed`,
      );
    }
    if (diff.policyChanged) {
      throw new PocketUpdatePlanError(
        "update-target-scope",
        `Single-resource update for "${resolved.canonical}" rejected because guest policy (capabilities, permissions, or memory) also changed`,
      );
    }
    const unexpectedPak = diff.changedPakEntries.filter((key) => !(resolved.kind === "pak" && key === resolved.id));
    const unexpectedAssets = diff.changedAssets.filter((name) => !(resolved.kind === "asset" && name === resolved.id));
    const unattributedPakChange =
      diff.pakChanged && (resolved.kind !== "pak" || !diff.changedPakEntries.includes(resolved.id));
    if (unexpectedPak.length > 0 || unexpectedAssets.length > 0 || unattributedPakChange) {
      throw new PocketUpdatePlanError(
        "update-target-scope",
        `Single-resource update for "${resolved.canonical}" rejected because other resources changed: ${[
          ...unexpectedPak.map((k) => `pak:${k}`),
          ...(unattributedPakChange && unexpectedPak.length === 0 ? ["pak"] : []),
          ...unexpectedAssets.map((a) => `asset:${a}`),
        ].join(", ")}`,
      );
    }
  }

  let deliveryMode: PocketUpdateResolvedMode;
  if (mode === "zip") {
    if (!options.candidate.bundle) {
      throw new PocketUpdatePlanError("update-bundle-missing", "ZIP update mode requested, but manifest does not declare a bundle.zip");
    }
    deliveryMode = "zip";
  } else if (mode === "granular" || target.scope !== "all") {
    deliveryMode = "granular";
  } else {
    deliveryMode = !baseline && options.candidate.bundle ? "zip" : "granular";
  }

  if (deliveryMode === "zip" && options.candidate.bundle) {
    return {
      deliveryMode: "zip",
      target,
      bundle: options.candidate.bundle,
      diff,
      downloadFiles: options.candidate.files,
      reusedFiles: [],
      downloadBytes: options.candidate.bundle.size,
      reusedBytes: 0,
    };
  }

  return {
    deliveryMode: "granular",
    target,
    ...(resolvedResource === undefined ? {} : { resolvedResource }),
    diff,
    downloadFiles: diff.downloadFiles,
    reusedFiles: diff.reusedFiles,
    downloadBytes: diff.downloadBytes,
    reusedBytes: diff.reusedBytes,
  };
}

export interface PocketUpdateCheckRequest {
  readonly mode?: PocketUpdateDeliveryMode;
  readonly scope?: PocketUpdateScope;
  readonly resource?: string;
}

export interface PocketPreparedUpdateSummary {
  readonly version: string;
  readonly build: number;
  readonly deliveryMode: PocketUpdateResolvedMode;
  readonly scope: PocketUpdateScope;
  readonly targetResource?: string | null;
  readonly downloadedFiles: number;
  readonly reusedFiles: number;
  readonly downloadedBytes: number;
  readonly reusedBytes: number;
  readonly updatedComponents: readonly string[];
}

export interface PocketUpdateStatusSnapshot {
  readonly configured: boolean;
  readonly stage: string;
  readonly activeVersion: string;
  readonly activeBuild: number;
  readonly availableVersion?: string | null;
  readonly preparedUpdate?: PocketPreparedUpdateSummary | null;
  readonly versions: readonly JsonObject[];
  readonly lastError?: string | null;
}

export interface PocketUpdateClient {
  status(): Promise<PocketUpdateStatusSnapshot>;
  check(request?: PocketUpdateCheckRequest): Promise<PocketUpdateStatusSnapshot>;
  /** One-shot ZIP archive download of code and all resources. */
  checkZip(): Promise<PocketUpdateStatusSnapshot>;
  /** Granular update of code (`entry` / `worker`) only for an already-downloaded mini-app. */
  checkCodeOnly(): Promise<PocketUpdateStatusSnapshot>;
  /** Granular update of a single resource file (`asset:<name>` or `pak:<key>`) for an already-downloaded mini-app. */
  checkResource(resource: string): Promise<PocketUpdateStatusSnapshot>;
  apply(): Promise<{ scheduled: boolean; version: string }>;
  rollback(): Promise<{ scheduled: boolean; version: string }>;
}

/**
 * Guest JS SDK client for orchestrating package updates over `HostBridge`.
 */
export function createPocketUpdateClient(host: HostBridge): PocketUpdateClient {
  const check = async (request?: PocketUpdateCheckRequest): Promise<PocketUpdateStatusSnapshot> => {
    const params: JsonObject = {};
    if (request?.mode) params.mode = request.mode;
    if (request?.scope) params.scope = request.scope;
    if (request?.resource !== undefined) params.resource = request.resource;
    return await host.request<JsonValue>("updates.check", params) as unknown as PocketUpdateStatusSnapshot;
  };

  return {
    async status(): Promise<PocketUpdateStatusSnapshot> {
      return await host.request<JsonValue>("updates.status", {}) as unknown as PocketUpdateStatusSnapshot;
    },
    check,
    checkZip(): Promise<PocketUpdateStatusSnapshot> {
      return check({ mode: "zip", scope: "all" });
    },
    checkCodeOnly(): Promise<PocketUpdateStatusSnapshot> {
      return check({ mode: "granular", scope: "code" });
    },
    checkResource(resource: string): Promise<PocketUpdateStatusSnapshot> {
      if (!resource.trim()) {
        return Promise.reject(new PocketUpdatePlanError("update-resource-missing", "Resource name must not be empty"));
      }
      return check({ mode: "granular", scope: "resource", resource });
    },
    async apply(): Promise<{ scheduled: boolean; version: string }> {
      return await host.request<JsonValue>("updates.apply", {}) as unknown as { scheduled: boolean; version: string };
    },
    async rollback(): Promise<{ scheduled: boolean; version: string }> {
      return await host.request<JsonValue>("updates.rollback", {}) as unknown as { scheduled: boolean; version: string };
    },
  };
}
