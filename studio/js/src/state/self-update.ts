// Studio updates itself through the SDK's signed update path (M6). This store only drives the guest-controlled
// refresh (`updates.status` / `updates.check` / `updates.apply`, wrapped by `createPocketUpdateClient`) and shows
// its facts: no downloader, verifier or package store lives here. The host verifies the signed package, replaces
// this guest and runs the health trial; an unhealthy build is rolled back by the host's coordinator, after which
// the previous version simply runs again and reports `lastError`.
import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";

/** The slice of `updates.status` the page needs. */
export interface UpdateStatus {
  configured: boolean;
  stage: string;
  activeVersion: string | null;
  activeBuild: number | null;
  preparedUpdate?: { version: string; build: number } | null;
  lastError?: string | null;
}

export interface UpdateBackend {
  status(): Promise<UpdateStatus>;
  /** Granular check of code and resources (no archive extractor is needed on any platform). */
  check(): Promise<UpdateStatus>;
  apply(): Promise<{ scheduled: boolean; version: string }>;
  /** Resolves after the new guest tried to restore the UI state handed over by the old one. */
  ready?: Promise<boolean>;
}

export type UpdatePhase = "idle" | "checking" | "available" | "current" | "applying" | "unavailable" | "error";
export interface SelfUpdateState {
  phase: UpdatePhase;
  activeVersion?: string;
  activeBuild?: number;
  candidateVersion?: string;
  candidateBuild?: number;
  stage?: string;
  /** The host's last update/rollback error (kept by the coordinator after a rollback). */
  lastError?: string;
  message?: string;
}

const norm = (s: UpdateStatus): Pick<SelfUpdateState, "activeVersion" | "activeBuild" | "stage" | "lastError"> => ({
  ...(s.activeVersion ? { activeVersion: s.activeVersion } : {}),
  ...(typeof s.activeBuild === "number" ? { activeBuild: s.activeBuild } : {}),
  stage: s.stage,
  lastError: s.lastError ? String(s.lastError) : undefined,
});

export function createSelfUpdate(deps: { backend?: UpdateBackend; toasts: Toasts; /** Asks about unsaved edits; false cancels the apply (the guest is replaced and drafts are lost). */ confirmLeave?: () => Promise<boolean> }) {
  const { backend, toasts } = deps;
  const store = createStore<SelfUpdateState>({ phase: "idle" });
  const state = () => store.get();
  let busy = false;

  /** Reads the host's current update facts (version, build, stage, last error) without touching the network. */
  async function load(): Promise<void> {
    if (!backend) { store.update({ phase: "unavailable", message: "此宿主未提供更新能力" }); return; }
    try {
      const status = await backend.status();
      if (!status.configured) { store.update({ ...norm(status), phase: "unavailable", message: "Studio 自更新未配置（服务尚未提供签名密钥，或宿主没有配置更新源）" }); return; }
      const keep = state().phase === "available" || state().phase === "applying" ? {} : { phase: "idle" as const };
      store.update({ ...norm(status), ...keep });
    } catch (error) {
      store.update({ phase: "unavailable", message: errorText(error) });
    }
  }

  async function check(): Promise<void> {
    if (busy || !backend) return;
    busy = true;
    store.update({ phase: "checking", message: undefined });
    try {
      const status = await backend.check();
      const next = status.preparedUpdate;
      const newer = next && (next.build !== status.activeBuild || next.version !== status.activeVersion);
      store.update({
        ...norm(status),
        phase: newer ? "available" : "current",
        candidateVersion: newer ? next.version : undefined,
        candidateBuild: newer ? next.build : undefined,
        message: newer ? undefined : "已是最新版本（没有更高构建号的已签名发布）",
      });
    } catch (error) {
      const message = errorText(error);
      store.update({ phase: "error", message });
      toasts.error(`检查 Studio 更新失败：${message}`);
    } finally {
      busy = false;
    }
  }

  async function apply(): Promise<void> {
    if (busy || !backend || state().phase !== "available") return;
    busy = true;
    let proceed = false;
    try {
      proceed = !deps.confirmLeave || (await deps.confirmLeave());
    } catch (error) {
      toasts.error(`无法确认未保存的更改：${errorText(error)}`);
    }
    if (!proceed) { busy = false; return; }
    store.update({ phase: "applying", message: "正在应用更新并重新加载 Studio…" });
    try {
      const result = await backend.apply();
      // `scheduled`: the host replaces this guest right after this response. A running guest never sees the end.
      if (!result.scheduled) store.update({ phase: "current", candidateVersion: undefined, candidateBuild: undefined, message: "已是最新版本" });
    } catch (error) {
      const message = errorText(error);
      store.update({ phase: "error", message });
      toasts.error(`应用 Studio 更新失败：${message}`);
    } finally {
      busy = false;
    }
  }

  /** Called once per guest start: tells the user an update was applied and the UI state came back. */
  void backend?.ready?.then((restored) => {
    if (restored) toasts.success("Studio 已更新，界面状态已恢复");
  }, () => { /* handoff is best effort; the page still shows the host's facts */ });

  return { store, state, load, check, apply };
}
export type SelfUpdate = ReturnType<typeof createSelfUpdate>;
