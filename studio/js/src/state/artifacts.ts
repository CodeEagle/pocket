// Artifact inspector (产物): the build outputs of the current revision. The Dart provider returns text
// artifacts (scrubbed) and METADATA ONLY for binaries (.qjbc/.pak embed debug paths it cannot scrub), so
// the pack contents summary comes from the build's resource snapshot (resources.json), not from the pak.
import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { asRecord, list, num, str } from "../lib/format.ts";
import type { StudioClient } from "../studio-client.ts";

export interface ArtifactFile {
  name: string;
  label: string;
  /** Short role in Chinese. */
  role: string;
  kind: "text" | "binary";
  bytes?: number;
  /** false: the service has no such file for this build. */
  available: boolean;
  error?: string;
  /** Only inspected on demand (large). */
  lazy?: boolean;
}

export interface BytecodeMeta {
  runtimeAbi?: string;
  bindingGeneration?: number;
  entryFormat?: string;
  tickHz?: number;
  payloadSha256?: string;
  sourceSha256?: string;
  engineAbi?: string;
  bytecodeBytes?: number;
  version?: string;
  build?: number;
  fonts?: string;
}
export interface ManifestSummary {
  protocolVersion?: number;
  version?: string;
  build?: number;
  requires: string[];
  optional: string[];
  permissionsRequired: string[];
  permissionsOptional: string[];
  memory?: { heapLimitBytes?: number; maxPakBytes?: number };
  memoryPolicy?: string;
}
export interface PackageContents {
  id: string;
  title?: string;
  version?: string;
  build?: number;
  /** Counts by placement and kind (from resources.json). */
  total: number;
  totalBytes: number;
  inPak: number;
  inPakBytes: number;
  network: number;
  networkBytes: number;
  assets: number;
}
export interface BuildInfoSummary {
  generation?: string;
  revision?: number;
  appId?: string;
  version?: string;
  build?: number;
  tickHz?: number;
  entryFormat?: string;
  runtimeAbi?: string;
  generatedAt?: string;
  packages: { id: string; version?: string; build?: number }[];
}

export interface Selected { name: string; loading: boolean; text?: string; bytes?: number; truncated?: boolean; error?: string }

export interface ArtifactsState {
  project?: string;
  loading: boolean;
  error?: string;
  loaded: boolean;
  revision?: number;
  builtRevision?: number | null;
  /** True when a successful build exists (artifacts are listed). */
  built: boolean;
  files: ArtifactFile[];
  bytecode?: BytecodeMeta;
  manifest?: ManifestSummary;
  packages: PackageContents[];
  /** Why the pack contents summary is unavailable (too large to parse, snapshot missing, ...). */
  packNote?: string;
  buildInfo?: BuildInfoSummary;
  selected?: Selected;
}

/** The fixed inspector rows. `key` is the field of `studio.artifacts.list`'s `artifacts` object that announces the file. */
const FILES: { name: string; label: string; role: string; kind: "text" | "binary"; key?: string; lazy?: boolean }[] = [
  { name: "app.qjbc", label: "app.qjbc", role: "QuickJS 字节码", kind: "binary", key: "bytecode" },
  { name: "app.bytecode.json", label: "app.bytecode.json", role: "字节码元数据", kind: "text", key: "metadata" },
  { name: "app.pak", label: "app.pak", role: "资源包", kind: "binary", key: "pak" },
  { name: "guest-manifest.json", label: "guest-manifest.json", role: "来宾清单", kind: "text", key: "manifest" },
  { name: "build.json", label: "build.json", role: "构建信息", kind: "text", key: "build" },
  { name: "resources.json", label: "resources.json", role: "资源快照（包内容）", kind: "text" },
  { name: "app.js", label: "app.js", role: "打包后的源码（仅供检查）", kind: "text", key: "appJs", lazy: true },
];

const strings = (value: unknown): string[] => list(value).filter((v): v is string => typeof v === "string");
const parse = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try { return asRecord(JSON.parse(text)); } catch { return undefined; }
};

export function toBytecodeMeta(r: Record<string, unknown>): BytecodeMeta {
  const pick = <T,>(k: string, f: (v: unknown) => T | undefined): Partial<Record<string, T>> => { const v = f(r[k]); return v === undefined ? {} : { [k]: v }; };
  return {
    ...pick("runtimeAbi", str), ...pick("bindingGeneration", num), ...pick("entryFormat", str), ...pick("tickHz", num),
    ...pick("payloadSha256", str), ...pick("sourceSha256", str), ...pick("engineAbi", str), ...pick("bytecodeBytes", num),
    ...pick("version", str), ...pick("build", num), ...pick("fonts", str),
  } as BytecodeMeta;
}

export function toManifestSummary(r: Record<string, unknown>): ManifestSummary {
  const caps = asRecord(r.capabilities);
  const perms = asRecord(r.permissions);
  const mem = asRecord(r.memory);
  return {
    ...(num(r.protocolVersion) !== undefined ? { protocolVersion: num(r.protocolVersion)! } : {}),
    ...(str(r.version) ? { version: str(r.version)! } : {}),
    ...(num(r.build) !== undefined ? { build: num(r.build)! } : {}),
    requires: strings(caps?.requires), optional: strings(caps?.optional),
    permissionsRequired: strings(perms?.required), permissionsOptional: strings(perms?.optional),
    ...(mem ? { memory: { ...(num(mem.heapLimitBytes) !== undefined ? { heapLimitBytes: num(mem.heapLimitBytes)! } : {}), ...(num(mem.maxPakBytes) !== undefined ? { maxPakBytes: num(mem.maxPakBytes)! } : {}) } } : {}),
    ...(str(r.memoryPolicy) ? { memoryPolicy: str(r.memoryPolicy)! } : {}),
  };
}

/** Counts and sizes per package from the resource snapshot (`resources.json`: packages[].resources[{key,kind,bytes,placement}]). */
export function toPackageContents(snapshot: Record<string, unknown>): PackageContents[] {
  return list(snapshot.packages).flatMap((p): PackageContents[] => {
    const r = asRecord(p);
    if (!r || !str(r.id)) return [];
    const out: PackageContents = {
      id: str(r.id)!, ...(str(r.title) ? { title: str(r.title)! } : {}), ...(str(r.version) ? { version: str(r.version)! } : {}),
      ...(num(r.build) !== undefined ? { build: num(r.build)! } : {}),
      total: 0, totalBytes: 0, inPak: 0, inPakBytes: 0, network: 0, networkBytes: 0, assets: 0,
    };
    for (const item of list(r.resources)) {
      const e = asRecord(item);
      if (!e) continue;
      const bytes = num(e.bytes) ?? 0;
      out.total += 1; out.totalBytes += bytes;
      if (e.kind === "asset") out.assets += 1;
      if (e.placement === "network") { out.network += 1; out.networkBytes += bytes; } else { out.inPak += 1; out.inPakBytes += bytes; }
    }
    return [out];
  });
}

export function toBuildInfo(r: Record<string, unknown>): BuildInfoSummary {
  return {
    ...(str(r.generation) ? { generation: str(r.generation)! } : {}), ...(num(r.revision) !== undefined ? { revision: num(r.revision)! } : {}),
    ...(str(r.appId) ? { appId: str(r.appId)! } : {}), ...(str(r.version) ? { version: str(r.version)! } : {}),
    ...(num(r.build) !== undefined ? { build: num(r.build)! } : {}), ...(num(r.tickHz) !== undefined ? { tickHz: num(r.tickHz)! } : {}),
    ...(str(r.entryFormat) ? { entryFormat: str(r.entryFormat)! } : {}), ...(str(r.runtimeAbi) ? { runtimeAbi: str(r.runtimeAbi)! } : {}),
    ...(str(r.generatedAt) ? { generatedAt: str(r.generatedAt)! } : {}),
    packages: list(asRecord(r.resources)?.packages).flatMap((p) => { const q = asRecord(p); return q && str(q.id) ? [{ id: str(q.id)!, ...(str(q.version) ? { version: str(q.version)! } : {}), ...(num(q.build) !== undefined ? { build: num(q.build)! } : {}) }] : []; }),
  };
}

export function createArtifacts(deps: { client: StudioClient; toasts: Toasts; project: () => string | undefined }) {
  const { client, toasts } = deps;
  const store = createStore<ArtifactsState>({ loading: false, loaded: false, built: false, files: [], packages: [] });
  const state = () => store.get();
  let epoch = 0;

  async function refresh(): Promise<void> {
    const project = deps.project();
    if (!project) return;
    const mine = epoch;
    store.update({ project, loading: true, error: undefined });
    try {
      const listing = await client.artifacts.list(project);
      if (mine !== epoch) return;
      const announced = asRecord(listing.artifacts);
      if (!announced || listing.builtRevision === null || listing.builtRevision === undefined) {
        store.update({ loading: false, loaded: true, built: false, revision: listing.revision, builtRevision: listing.builtRevision, files: [], bytecode: undefined, manifest: undefined, packages: [], packNote: undefined, buildInfo: undefined, selected: undefined });
        return;
      }
      // Inspect each announced file once: metadata for binaries (size), parsed content for the small JSON documents.
      // app.js is large and only fetched when the user opens it.
      const announcedFiles = FILES.filter((f) => f.key === undefined || announced[f.key] !== undefined);
      const results = await Promise.all(announcedFiles.filter((f) => !f.lazy).map(async (f) => {
        try { return { f, r: await client.artifacts.inspect(project, f.name), error: undefined as string | undefined, code: undefined as string | undefined }; }
        catch (error) { return { f, r: undefined, error: errorText(error), code: (error as { code?: string })?.code }; }
      }));
      if (mine !== epoch) return;
      const textOf = (name: string): string | undefined => results.find((x) => x.f.name === name)?.r?.data;
      const truncatedOf = (name: string): boolean => results.find((x) => x.f.name === name)?.r?.truncated === true;
      const files: ArtifactFile[] = announcedFiles.map((f) => {
        const hit = results.find((x) => x.f === f);
        if (!hit) return { name: f.name, label: f.label, role: f.role, kind: f.kind, available: true, lazy: true };
        // A file bigger than the provider's response cap exists but cannot be measured through it.
        return { name: f.name, label: f.label, role: f.role, kind: f.kind, ...(hit.r ? { bytes: hit.r.bytes } : {}), available: hit.r !== undefined || hit.code === "too_large", ...(hit.error ? { error: hit.error } : {}) };
      });
      const meta = parse(textOf("app.bytecode.json"));
      const manifest = parse(textOf("guest-manifest.json"));
      const buildInfo = parse(textOf("build.json"));
      const snapshot = parse(textOf("resources.json"));
      store.update({
        loading: false, loaded: true, built: true, revision: listing.revision, builtRevision: listing.builtRevision,
        files,
        bytecode: meta ? toBytecodeMeta(meta) : undefined,
        manifest: manifest ? toManifestSummary(manifest) : undefined,
        buildInfo: buildInfo ? toBuildInfo(buildInfo) : undefined,
        packages: snapshot ? toPackageContents(snapshot) : [],
        packNote: snapshot ? undefined : truncatedOf("resources.json") ? "资源快照超过 128 KiB，无法在 Studio 内汇总。" : results.find((x) => x.f.name === "resources.json")?.error ? "此构建没有资源快照。" : "资源快照不可用。",
        selected: undefined,
      });
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ loading: false, loaded: true, error: errorText(error) });
      toasts.error(`读取构建产物失败：${errorText(error)}`);
    }
  }

  /** Shows one artifact: text files as (possibly truncated) text, binaries as metadata only. */
  async function select(name: string): Promise<void> {
    const project = deps.project();
    if (!project) return;
    const mine = epoch;
    store.update({ selected: { name, loading: true } });
    try {
      const r = await client.artifacts.inspect(project, name);
      if (mine !== epoch || state().selected?.name !== name) return;
      store.update({ selected: { name, loading: false, bytes: r.bytes, ...(r.encoding === "utf8" ? { text: r.data ?? "", truncated: r.truncated === true } : {}) } });
    } catch (error) {
      if (mine !== epoch || state().selected?.name !== name) return;
      store.update({ selected: { name, loading: false, error: errorText(error) } });
    }
  }

  function closeSelected(): void { store.update({ selected: undefined }); }

  function reset(): void {
    epoch += 1;
    store.set({ loading: false, loaded: false, built: false, files: [], packages: [] });
  }

  return { store, state, refresh, select, closeSelected, reset };
}
export type Artifacts = ReturnType<typeof createArtifacts>;
