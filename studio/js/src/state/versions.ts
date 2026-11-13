// Version history and slots (版本): a read-only view of the service's version journal
// (studio.publish.history -> GET /api/projects/:id/versions).
//
// What the service knows: the `test` and `stable` slot (newest successful publish per slot), every published
// release (version, build, revision, time, key identity, payload digest, per-package versions, archive) and the
// public update URLs. What it does NOT know: whether any device is on trial, has promoted or rolled back a
// version. That state lives in each device's update coordinator (see sdk/docs/RELEASE_TRUST_POLICY.md); the
// page says so instead of inventing a status.
import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { absoluteUrl, asRecord, list, num, str } from "../lib/format.ts";
import type { StudioClient } from "../studio-client.ts";

export interface VersionPackage { id: string; version: string; build: number; manifestUrl?: string; hostConfigUrl?: string }
export interface ReusedPackage { id: string; version: string; build: number; ownerProjectId?: string; releaseId?: string }

export interface Slot {
  name: "test" | "stable";
  label: string;
  version?: string;
  build?: number;
  releaseId?: string;
  archiveUrl?: string;
  packages: VersionPackage[];
  reusedPackages: ReusedPackage[];
}

export interface HistoryEntry {
  id: string;
  releaseId: string;
  slot: "test" | "stable";
  channel: "test" | "release";
  version: string;
  build: number;
  revision?: number;
  publishedAt?: string;
  payloadSha256?: string;
  hostVersion?: string;
  archiveUrl?: string;
  appConfigUrl?: string;
  packages: VersionPackage[];
  reusedPackages: ReusedPackage[];
}

export interface VersionsState {
  project?: string;
  loading: boolean;
  loaded: boolean;
  error?: string;
  origin?: string;
  hostVersion?: string;
  packageVersion?: string;
  /** The backend is reachable beyond loopback (LAN devices can fetch updates). */
  lan: boolean;
  /** Service-side note, e.g. the LAN backend could not bind. */
  backendError?: string;
  appConfigUrl?: string;
  slots: Slot[];
  history: HistoryEntry[];
  selected?: string;
}

const SLOT_LABEL = { test: "测试槽（test）", stable: "稳定槽（stable）" } as const;

const packagesOf = (value: unknown): VersionPackage[] => list(value).flatMap((p) => {
  const r = asRecord(p);
  return r && str(r.id) ? [{ id: str(r.id)!, version: str(r.version) ?? "", build: num(r.build) ?? 0, ...(str(r.manifestUrl) ? { manifestUrl: str(r.manifestUrl)! } : {}), ...(str(r.hostConfigUrl) ? { hostConfigUrl: str(r.hostConfigUrl)! } : {}) }] : [];
});
const reusedOf = (value: unknown): ReusedPackage[] => list(value).flatMap((p) => {
  const r = asRecord(p);
  return r && str(r.id) ? [{ id: str(r.id)!, version: str(r.version) ?? "", build: num(r.build) ?? 0, ...(str(r.ownerProjectId) ? { ownerProjectId: str(r.ownerProjectId)! } : {}), ...(str(r.releaseId) ? { releaseId: str(r.releaseId)! } : {}) }] : [];
});

/** Normalizes the service's snapshot. Archive links become absolute URLs (the page shows them as text). */
export function toVersions(snapshot: unknown): Pick<VersionsState, "origin" | "hostVersion" | "packageVersion" | "lan" | "backendError" | "appConfigUrl" | "slots" | "history"> {
  const r = asRecord(snapshot) ?? {};
  const origin = str(r.origin);
  const slots: Slot[] = list(r.slots).flatMap((s): Slot[] => {
    const q = asRecord(s);
    const name = q?.name === "test" || q?.name === "stable" ? q.name : undefined;
    if (!q || !name) return [];
    return [{
      name, label: SLOT_LABEL[name],
      ...(str(q.version) ? { version: str(q.version)! } : {}), ...(num(q.build) !== undefined ? { build: num(q.build)! } : {}),
      ...(str(q.releaseId) ? { releaseId: str(q.releaseId)! } : {}),
      ...(absoluteUrl(str(q.archiveUrl), origin) ? { archiveUrl: absoluteUrl(str(q.archiveUrl), origin)! } : {}),
      packages: packagesOf(q.packages), reusedPackages: reusedOf(q.reusedPackages),
    }];
  });
  const history: HistoryEntry[] = list(r.history).flatMap((e): HistoryEntry[] => {
    const q = asRecord(e);
    const slot = q?.slot === "test" || q?.slot === "stable" ? q.slot : undefined;
    if (!q || !slot || !str(q.id)) return [];
    return [{
      id: str(q.id)!, releaseId: str(q.releaseId) ?? str(q.id)!, slot, channel: q.channel === "release" ? "release" : "test",
      version: str(q.version) ?? "", build: num(q.build) ?? 0,
      ...(num(q.revision) !== undefined ? { revision: num(q.revision)! } : {}), ...(str(q.publishedAt) ? { publishedAt: str(q.publishedAt)! } : {}),
      ...(str(q.payloadSha256) ? { payloadSha256: str(q.payloadSha256)! } : {}), ...(str(q.hostVersion) ? { hostVersion: str(q.hostVersion)! } : {}),
      ...(absoluteUrl(str(q.archiveUrl), origin) ? { archiveUrl: absoluteUrl(str(q.archiveUrl), origin)! } : {}),
      ...(str(q.appConfigUrl) ? { appConfigUrl: str(q.appConfigUrl)! } : {}),
      packages: packagesOf(q.packages), reusedPackages: reusedOf(q.reusedPackages),
    }];
  });
  return {
    ...(origin ? { origin } : {}), ...(str(r.hostVersion) ? { hostVersion: str(r.hostVersion)! } : {}),
    ...(str(r.packageVersion) ? { packageVersion: str(r.packageVersion)! } : {}),
    lan: r.lan === true, ...(str(r.error) ? { backendError: str(r.error)! } : {}),
    ...(str(r.appConfigUrl) ? { appConfigUrl: str(r.appConfigUrl)! } : {}),
    slots, history,
  };
}

export function createVersions(deps: { client: StudioClient; toasts: Toasts; project: () => string | undefined }) {
  const { client, toasts } = deps;
  const store = createStore<VersionsState>({ loading: false, loaded: false, lan: false, slots: [], history: [] });
  const state = () => store.get();
  let epoch = 0;

  async function refresh(): Promise<void> {
    const project = deps.project();
    if (!project) return;
    const mine = epoch;
    store.update({ project, loading: true, error: undefined });
    try {
      const snapshot = await client.publish.history(project);
      if (mine !== epoch) return;
      const next = toVersions(snapshot);
      const keep = state().selected && next.history.some((e) => e.id === state().selected) ? state().selected : undefined;
      store.update({ ...next, loading: false, loaded: true, selected: keep });
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ loading: false, loaded: true, error: errorText(error) });
      toasts.error(`读取版本记录失败：${errorText(error)}`);
    }
  }

  function select(id: string | undefined): void { store.update({ selected: state().selected === id ? undefined : id }); }

  function reset(): void {
    epoch += 1;
    store.set({ loading: false, loaded: false, lan: false, slots: [], history: [] });
  }

  return { store, state, refresh, select, reset };
}
export type Versions = ReturnType<typeof createVersions>;
