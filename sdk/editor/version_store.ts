import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The editor's version history is deliberately a small metadata journal.  The
 * signed package files live in the immutable release directory recorded by
 * each package entry; `current` is the only mutable pointer.
 */
export type VersionSlot = "test" | "stable";
export type VersionChannel = "test" | "release";

export type PublishedVersionPackage = {
  id: string;
  version: string;
  build: number;
  artifactRoot: string;
};

export type PublishedVersionReusedPackage = {
  id: string;
  version: string;
  build: number;
  ownerProjectId: string;
  releaseId: string;
};

export type PublishedVersion = {
  id: string;
  /** Alias kept explicit for clients that call the value a release id. */
  releaseId: string;
  slot: VersionSlot;
  channel: VersionChannel;
  version: string;
  build: number;
  /** Root signed version used by the aggregate app-config URL. */
  routeVersion: string;
  /** Frozen compatibility branch used by the current auto-update entrypoint. */
  compatVersion: string;
  revision: number;
  publishedAt: string;
  hostVersion: string;
  packageVersion: string;
  keyId: string;
  runtimeAbi: string;
  payloadSha256: string;
  archivePath: string;
  packages: PublishedVersionPackage[];
  /** Immutable child package references published by a separate owner. */
  reusedPackages?: PublishedVersionReusedPackage[];
};

export type VersionHistory = {
  schemaVersion: 1;
  /** Legacy `test`/`stable` keys remain valid; branch keys isolate host+compat. */
  current: Record<string, string>;
  entries: PublishedVersion[];
};

export function emptyVersionHistory(): VersionHistory {
  return { schemaVersion: 1, current: {}, entries: [] };
}

export function versionHistoryPath(statesDir: string, projectId: string): string {
  return join(statesDir, `${projectId}.versions.json`);
}

function legacyCompatibilityVersion(value: string): string {
  return value.replace(/-test\.[0-9]+$/, "");
}

export async function readVersionHistory(path: string): Promise<VersionHistory> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<VersionHistory>;
    if (parsed.schemaVersion !== 1 || !parsed.current || !Array.isArray(parsed.entries)) {
      throw new Error("invalid editor version history schema");
    }
    return {
      schemaVersion: 1,
      current: Object.fromEntries(Object.entries(parsed.current).filter((entry): entry is [string, string] =>
        typeof entry[0] === "string" && entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0)),
      // Histories written by the pre-aggregate backend have no routeVersion.
      // Keep those releases readable at their signed payload version while
      // new entries use an explicit collision-free alias.
      entries: parsed.entries.map((entry) => ({
        ...entry,
        compatVersion: typeof entry.compatVersion === "string" && entry.compatVersion.length > 0
          ? entry.compatVersion
          : legacyCompatibilityVersion(entry.version),
        routeVersion: typeof entry.routeVersion === "string" && entry.routeVersion.length > 0
          ? entry.routeVersion
          : entry.version,
      })) as PublishedVersion[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVersionHistory();
    throw error;
  }
}

/** Replace the pointer file in one same-directory rename. */
export async function writeVersionHistoryAtomic(path: string, history: VersionHistory): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function versionBranchKey(hostVersion: string, compatVersion: string, slot: VersionSlot): string {
  return `branch:${slot}:${hostVersion}:${compatVersion}`;
}

export function currentVersion(history: VersionHistory, slot: VersionSlot, hostVersion?: string, compatVersion?: string): PublishedVersion | undefined {
  const id = hostVersion && compatVersion
    ? history.current[versionBranchKey(hostVersion, compatVersion, slot)] ?? history.current[slot]
    : history.current[slot];
  if (!id) return undefined;
  const entry = history.entries.find((candidate) => candidate.id === id);
  if (!entry) return undefined;
  if (hostVersion && entry.hostVersion !== hostVersion) return undefined;
  if (compatVersion && (entry.compatVersion ?? entry.version) !== compatVersion) return undefined;
  return entry;
}

export function newReleaseId(slot: VersionSlot, projectId?: string): string {
  const prefix = projectId ? `${projectId}-` : "";
  return `${prefix}${slot}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "")}`;
}
