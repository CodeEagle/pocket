// Preview orchestration: build -> studio.preview.publish -> reload the signed
// child with system.runtime.destroy + system.runtime.create({prepareForOpen:true})
// WITHOUT cacheFirst (sdk/docs/STUDIO_SIGNED_PREVIEW.md), then wait for the
// child's first visible frame. Every state shown is a real fact; a failure is
// surfaced, never replaced by a success placeholder.
import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Build } from "./build.ts";
import { errorText } from "./workspace.ts";
import type { StudioClient } from "../studio-client.ts";

export const PREVIEW_APP_ID = "dev.pocket.studio.preview";

/** Host-side system capabilities the preview needs (real: system-link.ts; tests: a fake). */
export interface PreviewRuntime {
  /** Installs the System kernel (system.runtime.configure). Rejects when the host has no System support. */
  ensure(): Promise<void>;
  create(appId: string): Promise<{ instanceId: string; generation: number | string }>;
  destroy(instanceId: string): Promise<void>;
  awaitFirstFrame(instanceId: string, generation: number | string): Promise<void>;
}

export type PreviewPhase = "idle" | "building" | "publishing" | "loading" | "running" | "error";

export interface PreviewState {
  phase: PreviewPhase;
  message?: string;
  /** Machine-readable error code when phase is "error". */
  code?: string;
  instanceId?: string;
  version?: string;
  previewBuild?: number;
  /** Counts completed reloads (running states) so a test or the UI can tell a new frame from the old one. */
  reloads: number;
  /** Time from the request (a save, when triggered by one) to the child's first frame. */
  lastLatencyMs?: number;
  surfaceVisible: boolean;
  /** Set when the runtime could not be installed (no System host). */
  runtime: "unknown" | "ready" | "unavailable";
  runtimeMessage?: string;
}

export function createPreview(deps: { client: StudioClient; runtime: PreviewRuntime; build: Build; timers: Timers; toasts: Toasts; project: () => string | undefined }) {
  const { client, runtime, build, timers, toasts } = deps;
  const store = createStore<PreviewState>({ phase: "idle", reloads: 0, surfaceVisible: false, runtime: "unknown" });
  let running = false;
  let queued: { build: boolean; since: number } | undefined;
  /** A loaded child whose first frame waits for the preview surface to become visible (never holds a run open). */
  let pendingFrame: { instanceId: string; generation: number | string; since: number; mine: number } | undefined;
  let epoch = 0;
  const state = () => store.get();

  async function ensureRuntime(): Promise<boolean> {
    if (state().runtime === "ready") return true;
    try {
      await runtime.ensure();
      store.update({ runtime: "ready", runtimeMessage: undefined });
      return true;
    } catch (error) {
      store.update({ runtime: "unavailable", runtimeMessage: errorText(error), phase: "error", code: "runtime_unavailable", message: `预览运行时不可用：${errorText(error)}` });
      return false;
    }
  }

  function fail(code: string, message: string, notify = true): false {
    store.update({ phase: "error", code, message });
    if (notify) toasts.error(message);
    return false;
  }

  async function destroyChild(): Promise<void> {
    const id = state().instanceId;
    if (!id) return;
    store.update({ instanceId: undefined });
    try { await runtime.destroy(id); } catch { /* already gone */ }
  }

  /** Waits for the child's first visible frame and flips to running. Guarded by the run epoch. */
  async function finishFrame(instanceId: string, generation: number | string, since: number, mine: number): Promise<boolean> {
    store.update({ message: "等待预览首帧…" });
    try {
      await runtime.awaitFirstFrame(instanceId, generation);
    } catch (error) {
      if (mine !== epoch) return false;
      return fail((error as { code?: string }).code ?? "first_frame_failed", `预览首帧失败：${errorText(error)}`);
    }
    if (mine !== epoch) return false;
    store.update({ phase: "running", message: undefined, code: undefined, reloads: state().reloads + 1, lastLatencyMs: Math.max(0, timers.now() - since) });
    return true;
  }

  async function execute(withBuild: boolean, since: number): Promise<boolean> {
    const project = deps.project();
    if (!project) return fail("no_project", "请先打开项目", false);
    const mine = ++epoch;
    pendingFrame = undefined;
    if (!(await ensureRuntime())) return false;

    let published: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3 && !published; attempt += 1) {
      const status = build.state().status;
      const fresh = status !== undefined && status.builtRevision === status.revision && !status.error && !build.state().busy;
      if (withBuild || !fresh || attempt > 0) {
        store.update({ phase: "building", message: "正在构建…", code: undefined });
        const done = await build.run();
        if (mine !== epoch) return false;
        if (!done.ok) return fail("build_failed", "构建失败，请在控制台查看诊断信息");
      }
      store.update({ phase: "publishing", message: "正在签名并发布预览包…" });
      try {
        published = await client.preview.publish(project);
      } catch (error) {
        if (mine !== epoch) return false;
        const code = (error as { code?: string }).code;
        // 409: the source changed while building. Build the newer revision.
        if (code === "conflict" && attempt < 2) continue;
        return fail(code ?? "publish_failed", `发布预览失败：${errorText(error)}`);
      }
    }
    if (!published) return fail("publish_failed", "源码在构建期间持续变化，请稍后重试");
    if (mine !== epoch) return false;

    store.update({ phase: "loading", message: "正在加载预览子应用…", version: String(published.version ?? ""), previewBuild: Number(published.build) || undefined });
    await destroyChild();
    let created: { instanceId: string; generation: number | string };
    try {
      created = await runtime.create(PREVIEW_APP_ID);
    } catch (error) {
      return fail((error as { code?: string }).code ?? "reload_failed", `预览加载失败：${errorText(error)}`);
    }
    if (mine !== epoch) { try { await runtime.destroy(created.instanceId); } catch { /* ignore */ } return false; }
    store.update({ instanceId: created.instanceId });
    if (!state().surfaceVisible) {
      pendingFrame = { instanceId: created.instanceId, generation: created.generation, since, mine };
      store.update({ message: "预览已加载，打开预览面板后显示" });
      return true;
    }
    return finishFrame(created.instanceId, created.generation, since, mine);
  }

  /** Builds (optionally), publishes and reloads. Calls made while a run is active coalesce into one follow-up run. */
  async function run(options: { build?: boolean; since?: number } = {}): Promise<boolean> {
    const withBuild = options.build !== false;
    const since = options.since ?? timers.now();
    if (running) {
      queued = { build: (queued?.build ?? false) || withBuild, since: queued ? Math.min(queued.since, since) : since };
      return false;
    }
    running = true;
    let ok = false;
    try {
      ok = await execute(withBuild, since);
    } finally {
      running = false;
    }
    const next = queued;
    queued = undefined;
    if (next) return run(next);
    return ok;
  }

  function setSurfaceVisible(visible: boolean): void {
    if (state().surfaceVisible === visible) return;
    store.update({ surfaceVisible: visible });
    const pending = pendingFrame;
    if (visible && pending && pending.mine === epoch && pending.instanceId === state().instanceId) {
      pendingFrame = undefined;
      void finishFrame(pending.instanceId, pending.generation, pending.since, pending.mine);
    }
  }

  /** Closes the child (used when the project changes). */
  async function reset(): Promise<void> {
    epoch += 1;
    queued = undefined;
    pendingFrame = undefined;
    await destroyChild();
    store.update({ phase: "idle", message: undefined, code: undefined, version: undefined, previewBuild: undefined });
  }

  return { store, state, run, reset, setSurfaceVisible, isRunning: () => running };
}
export type Preview = ReturnType<typeof createPreview>;
