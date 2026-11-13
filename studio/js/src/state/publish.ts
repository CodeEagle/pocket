// Signed publish (发布): plan -> confirm -> studio.publish.publish -> result facts,
// plus the offline package. The signing key lives in the service; the guest only
// ever sees the public facts of a publish (keyId, digests, URLs). Business policy
// (build gate, unsaved-edit gate, release confirmation) is here in JS.
import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Dialogs } from "./dialogs.ts";
import type { Build } from "./build.ts";
import { errorText } from "./workspace.ts";
import { absoluteUrl, asRecord, list, num, originOf, str } from "../lib/format.ts";
import type { StudioClient } from "../studio-client.ts";

export type Channel = "test" | "release";

export interface PlanTarget {
  kind: "root" | "reused";
  appId: string;
  title: string;
  version?: string;
  build?: number;
  built: boolean;
  busy: boolean;
  canPublish: boolean;
  /** false: a reused package whose owner project cannot be resolved. */
  canSelect?: boolean;
  reason?: string;
  publishedVersion?: string;
  publishedBuild?: number;
  publishedReleaseId?: string;
  /** Project that owns the channel slot of a reused package. */
  ownerProjectId?: string;
  ownerTitle?: string;
  sourcePath?: string;
}

export interface PublishedPackage { id: string; version: string; build: number; manifestUrl?: string; hostConfigUrl?: string }
export interface PublishInfo {
  channel?: Channel;
  version?: string;
  build?: number;
  revision?: number;
  keyId?: string;
  runtimeAbi?: string;
  payloadSha256?: string;
  releaseId?: string;
  publishedAt?: string;
  manifestUrl?: string;
  hostConfigUrl?: string;
  appConfigUrl?: string;
  archiveUrl?: string;
  packages: PublishedPackage[];
  reusedPackages: { id: string; version: string; build: number; ownerProjectId?: string }[];
}

export type PublishPhase = "idle" | "publishing" | "done" | "error";
export interface OfflineState { phase: "idle" | "working" | "done" | "error"; filename?: string; archiveUrl?: string; error?: string }

export interface PublishState {
  channel: Channel;
  planState: "idle" | "loading" | "ready" | "error";
  targets: PlanTarget[];
  planError?: string;
  phase: PublishPhase;
  /** What the publish is doing right now (shown above the live service log). */
  step?: string;
  error?: string;
  /** Facts of the newest publish (this session, or the service's last publish after a reload). */
  info?: PublishInfo;
  /** Set when `info` came from a publish done in this session. */
  fresh: boolean;
  offline: OfflineState;
}

const targetOf = (value: unknown): PlanTarget | undefined => {
  const r = asRecord(value);
  const appId = str(r?.appId) ?? str(r?.projectId);
  if (!r || !appId) return undefined;
  return {
    kind: r.kind === "reused" ? "reused" : "root",
    appId,
    title: str(r.title) ?? appId,
    ...(str(r.version) ? { version: str(r.version)! } : {}),
    ...(num(r.build) !== undefined ? { build: num(r.build)! } : {}),
    built: r.built === true,
    busy: r.busy === true,
    canPublish: r.canPublish === true,
    ...(r.canSelect === false ? { canSelect: false } : {}),
    ...(str(r.reason) ? { reason: str(r.reason)! } : {}),
    ...(str(r.publishedVersion) ? { publishedVersion: str(r.publishedVersion)! } : {}),
    ...(num(r.publishedBuild) !== undefined ? { publishedBuild: num(r.publishedBuild)! } : {}),
    ...(str(r.publishedReleaseId) ? { publishedReleaseId: str(r.publishedReleaseId)! } : {}),
    ...(str(r.ownerProjectId) ? { ownerProjectId: str(r.ownerProjectId)! } : {}),
    ...(str(r.ownerTitle) ? { ownerTitle: str(r.ownerTitle)! } : {}),
    ...(str(r.sourcePath) ? { sourcePath: str(r.sourcePath)! } : {}),
  };
};

/** Reads a publish from `studio.publish.publish` ({status:{publish}, manifestUrl, ...}) or from an EditorStatus.publish. */
export function toPublishInfo(result: unknown): PublishInfo | undefined {
  const top = asRecord(result);
  if (!top) return undefined;
  const publish = asRecord(asRecord(top.status)?.publish) ?? asRecord(top.publish) ?? (top.keyId !== undefined || top.manifestUrl !== undefined ? top : undefined);
  if (!publish) return undefined;
  const pick = (key: string): string | undefined => str(top[key]) ?? str(publish[key]);
  const manifestUrl = pick("manifestUrl");
  const origin = originOf(manifestUrl) ?? originOf(pick("hostConfigUrl"));
  const channel = publish.channel === "test" || publish.channel === "release" ? publish.channel : undefined;
  const packages = list(publish.packages ?? top.packages).flatMap((p): PublishedPackage[] => {
    const r = asRecord(p);
    return r && str(r.id) ? [{ id: str(r.id)!, version: str(r.version) ?? "", build: num(r.build) ?? 0, ...(str(r.manifestUrl) ? { manifestUrl: str(r.manifestUrl)! } : {}), ...(str(r.hostConfigUrl) ? { hostConfigUrl: str(r.hostConfigUrl)! } : {}) }] : [];
  });
  const reusedPackages = list(publish.reusedPackages ?? top.reusedPackages).flatMap((p) => {
    const r = asRecord(p);
    return r && str(r.id) ? [{ id: str(r.id)!, version: str(r.version) ?? "", build: num(r.build) ?? 0, ...(str(r.ownerProjectId) ? { ownerProjectId: str(r.ownerProjectId)! } : {}) }] : [];
  });
  return {
    ...(channel ? { channel } : {}),
    ...(str(publish.version) ? { version: str(publish.version)! } : {}),
    ...(num(publish.build) !== undefined ? { build: num(publish.build)! } : {}),
    ...(num(publish.revision) !== undefined ? { revision: num(publish.revision)! } : {}),
    ...(str(publish.keyId) ? { keyId: str(publish.keyId)! } : {}),
    ...(str(publish.runtimeAbi) ? { runtimeAbi: str(publish.runtimeAbi)! } : {}),
    ...(str(publish.payloadSha256) ? { payloadSha256: str(publish.payloadSha256)! } : {}),
    ...(str(publish.releaseId) ? { releaseId: str(publish.releaseId)! } : {}),
    ...(str(publish.publishedAt) ? { publishedAt: str(publish.publishedAt)! } : {}),
    ...(manifestUrl ? { manifestUrl } : {}),
    ...(pick("hostConfigUrl") ? { hostConfigUrl: pick("hostConfigUrl")! } : {}),
    ...(pick("appConfigUrl") ? { appConfigUrl: pick("appConfigUrl")! } : {}),
    ...(absoluteUrl(pick("archiveUrl"), origin) ? { archiveUrl: absoluteUrl(pick("archiveUrl"), origin)! } : {}),
    packages, reusedPackages,
  };
}

const PLAN_RETRY_MS = 1000;
const PLAN_RETRIES = 8;

export function createPublish(deps: {
  client: StudioClient;
  timers: Timers;
  toasts: Toasts;
  dialogs: Dialogs;
  build: Build;
  project: () => string | undefined;
  /** True while a source tab has unsaved edits (publishing signs the saved build only). */
  hasUnsavedEdits: () => boolean;
  /** Runs after a successful publish (the composition root refreshes the version history). */
  onPublished?: () => void;
}) {
  const { client, toasts, dialogs, build } = deps;
  const store = createStore<PublishState>({ channel: "test", planState: "idle", targets: [], phase: "idle", fresh: false, offline: { phase: "idle" } });
  const state = () => store.get();
  let epoch = 0;
  let retries = 0;
  let cancelRetry: (() => void) | undefined;

  /** What the build store (fed by the event stream) believes about the current source. */
  const buildReady = (): boolean => {
    const b = build.state();
    const st = b.status;
    return !b.busy && !!st && !st.error && st.builtRevision !== null && st.builtRevision === st.revision;
  };

  async function loadPlan(): Promise<void> {
    const project = deps.project();
    if (!project) return;
    const mine = epoch;
    cancelRetry?.(); cancelRetry = undefined;
    store.update({ planState: "loading", planError: undefined });
    try {
      const plan = asRecord(await client.publish.plan(project, state().channel));
      if (mine !== epoch) return;
      const targets = list(plan?.targets).map(targetOf).filter((t): t is PlanTarget => t !== undefined);
      store.update({ planState: "ready", targets });
      // A plan fetched while the service was still finishing a build disagrees with the build store: look again
      // shortly (bounded) rather than leaving a stale "needs build" on screen.
      const r = targets.find((t) => t.kind === "root");
      if (r && (r.built && !r.busy) !== buildReady() && retries < PLAN_RETRIES && !build.state().busy) {
        retries += 1;
        cancelRetry = deps.timers.after(PLAN_RETRY_MS, () => { cancelRetry = undefined; void loadPlan(); });
      } else retries = 0;
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ planState: "error", targets: [], planError: errorText(error) });
    }
  }

  /** The service's last publish survives a restart in EditorStatus.publish: show it before any publish in this session. */
  async function loadLast(): Promise<void> {
    const project = deps.project();
    if (!project || state().fresh) return;
    const mine = epoch;
    try {
      const info = toPublishInfo({ status: await client.build.status(project) });
      if (mine === epoch && !state().fresh && info) store.update({ info });
    } catch { /* the plan error already tells the user the service is unreachable */ }
  }

  async function enter(): Promise<void> {
    await Promise.all([loadPlan(), loadLast()]);
  }

  async function setChannel(channel: Channel): Promise<void> {
    if (state().channel === channel || state().phase === "publishing") return;
    store.update({ channel });
    await loadPlan();
  }

  const root = (): PlanTarget | undefined => state().targets.find((t) => t.kind === "root");

  async function publish(): Promise<void> {
    const project = deps.project();
    if (!project || state().phase === "publishing") return;
    const mine = epoch;
    const channel = state().channel;
    const label = channel === "test" ? "测试" : "稳定版";
    if (deps.hasUnsavedEdits()) {
      toasts.warning("发布前请先保存源文件修改。");
      store.update({ phase: "error", error: "有未保存的源文件修改；发布只会签名已保存并已构建的版本。" });
      return;
    }
    // The build gate reads the service's current truth, not a possibly stale local copy.
    await build.refresh();
    if (mine !== epoch) return;
    const status = build.state().status;
    if (!status || status.busy || status.error || status.builtRevision === null || status.builtRevision !== status.revision) {
      toasts.warning("发布前请先构建已保存的项目。");
      store.update({ phase: "error", error: status?.busy ? "构建仍在进行，请等待完成。" : "当前源码还没有成功的构建；请先构建。" });
      return;
    }
    if (channel === "release") {
      const target = root();
      const ok = await dialogs.confirm({
        title: "发布稳定版？",
        body: `将签名 ${target?.appId ?? project} ${target?.version ? `v${target.version}` : ""}${target?.build !== undefined ? `（构建 ${target.build}）` : ""} 并更新稳定频道。已接入该频道的设备会收到此版本；稳定版不允许降低构建号。`,
        confirmLabel: "发布稳定版",
        tone: "danger",
      });
      if (!ok || mine !== epoch) return;
    }
    store.update({ phase: "publishing", step: `正在签名并发布${label}包…`, error: undefined });
    try {
      const result = await client.publish.publish(project, channel);
      if (mine !== epoch) return;
      const info = toPublishInfo(result);
      if (!info) throw Object.assign(new Error("发布结果缺少发布信息"), { code: "invalid_response" });
      store.update({ phase: "done", step: undefined, info, fresh: true });
      toasts.success(`${label}包已发布${info.version ? ` · v${info.version}` : ""}${info.build !== undefined ? ` 构建 ${info.build}` : ""}`);
      deps.onPublished?.();
      void loadPlan();
    } catch (error) {
      if (mine !== epoch) return;
      const code = (error as { code?: string })?.code;
      const hint = code === "service_timeout" ? "（请求超时；服务端可能仍在处理，请到“版本”页确认）" : "";
      store.update({ phase: "error", step: undefined, error: `${errorText(error)}${hint}` });
      toasts.error(`发布失败：${errorText(error)}`);
      if (code === "service_timeout") deps.onPublished?.();
    }
  }

  async function makeOffline(): Promise<void> {
    const project = deps.project();
    if (!project || state().offline.phase === "working") return;
    const mine = epoch;
    store.update({ offline: { phase: "working" } });
    try {
      const result = await client.publish.offline(project);
      if (mine !== epoch) return;
      // The offline route returns a service-relative URL; the origin comes from the last publish or the version backend.
      let origin = originOf(state().info?.manifestUrl);
      if (!origin && result.archiveUrl.startsWith("/")) origin = str(asRecord(await client.publish.history(project).catch(() => undefined))?.origin);
      store.update({ offline: { phase: "done", filename: result.filename, archiveUrl: absoluteUrl(result.archiveUrl, origin) ?? result.archiveUrl } });
      toasts.success(`离线包已生成：${result.filename}`);
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ offline: { phase: "error", error: errorText(error) } });
      toasts.error(`生成离线包失败：${errorText(error)}`);
    }
  }

  /** Project switch: drop everything about the previous project. */
  function reset(): void {
    epoch += 1;
    cancelRetry?.(); cancelRetry = undefined; retries = 0;
    store.set({ channel: state().channel, planState: "idle", targets: [], phase: "idle", fresh: false, offline: { phase: "idle" } });
  }

  return { store, state, enter, loadPlan, setChannel, publish, makeOffline, reset, root };
}
export type Publish = ReturnType<typeof createPublish>;
