// Deploy to a simulator or connected device (studio.preview.devices / deploy /
// deployStatus / deployCancel). Mirrors the web Studio: pick a target, deploy
// the latest saved build, poll the job, show its log, cancel.
import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Build } from "./build.ts";
import { errorText } from "./workspace.ts";
import type { StudioClient } from "../studio-client.ts";

export interface Device { id: string; name: string; platform: string; emulator: boolean; supported: boolean }
export interface DeployJob { id: string; status: string; logs: string[]; error?: string }

export const TERMINAL_JOB = ["completed", "success", "succeeded", "failed", "error", "cancelled", "canceled"];
export const ACTIVE_JOB = ["queued", "building", "starting", "running", "stopping"];
export const JOB_LABELS: Record<string, string> = {
  queued: "排队中", building: "构建中", starting: "启动中", running: "运行中", completed: "已完成", success: "成功", succeeded: "成功",
  failed: "失败", error: "错误", cancelled: "已取消", canceled: "已取消", stopping: "停止中",
};
const POLL_MS = 1500;
const MAX_POLLS = 400;

export interface DeployState {
  devices: Device[];
  devicesLoaded: boolean;
  devicesError?: string;
  selected?: string;
  job?: DeployJob;
  starting: boolean;
}

function toDevice(value: unknown): Device | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string") return undefined;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name ? r.name : r.id,
    platform: typeof r.platform === "string" && r.platform ? r.platform : "未知平台",
    emulator: r.emulator === true,
    supported: r.supported !== false && r.available !== false,
  };
}
function toJob(value: unknown): DeployJob | undefined {
  const r = (value !== null && typeof value === "object" ? ((value as { job?: unknown }).job ?? value) : undefined) as Record<string, unknown> | undefined;
  if (!r || typeof r.id !== "string") return undefined;
  const logs = Array.isArray(r.logs) ? r.logs.filter((l): l is string => typeof l === "string") : typeof r.logs === "string" ? [r.logs] : [];
  return { id: r.id, status: String(r.status ?? "queued").toLowerCase(), logs: logs.slice(-300), ...(typeof r.error === "string" ? { error: r.error } : {}) };
}

export function createDeploy(deps: { client: StudioClient; timers: Timers; toasts: Toasts; build: Build; project: () => string | undefined }) {
  const { client, timers, toasts, build } = deps;
  const store = createStore<DeployState>({ devices: [], devicesLoaded: false, starting: false });
  let cancelPoll: (() => void) | undefined;
  let polls = 0;
  const state = () => store.get();

  async function loadDevices(): Promise<void> {
    try {
      const result = await client.preview.devices();
      const raw = Array.isArray(result) ? result : (result as { devices?: unknown[] }).devices ?? [];
      const devices = raw.map(toDevice).filter((d): d is Device => d !== undefined);
      const selected = devices.some((d) => d.id === state().selected && d.supported) ? state().selected : devices.find((d) => d.supported)?.id;
      store.update({ devices, devicesLoaded: true, devicesError: undefined, selected });
    } catch (error) {
      store.update({ devices: [], devicesLoaded: true, devicesError: errorText(error) });
    }
  }

  function stopPolling(): void { cancelPoll?.(); cancelPoll = undefined; polls = 0; }

  function poll(project: string, id: string): void {
    stopPolling();
    const tick = async (): Promise<void> => {
      cancelPoll = undefined;
      polls += 1;
      try {
        const job = toJob(await client.preview.deployStatus(project, id));
        if (!job || state().job?.id !== id) return;
        store.update({ job });
        // A running Flutter process is a successful deploy; stop polling its log to avoid a background loop.
        if (TERMINAL_JOB.includes(job.status) || job.status === "running" || polls > MAX_POLLS) return;
      } catch (error) {
        toasts.error(`读取部署状态失败：${errorText(error)}`);
        return;
      }
      cancelPoll = timers.after(POLL_MS, () => void tick());
    };
    cancelPoll = timers.after(POLL_MS, () => void tick());
  }

  function select(id: string): void { store.update({ selected: id }); }

  async function start(): Promise<void> {
    const project = deps.project();
    const deviceId = state().selected;
    if (!project || !deviceId || state().starting) return;
    const job = state().job;
    if (job && ACTIVE_JOB.includes(job.status)) { toasts.warning("已有部署任务正在进行"); return; }
    store.update({ starting: true });
    try {
      const status = build.state().status;
      if (!status || status.builtRevision !== status.revision || status.error) {
        const done = await build.run();
        if (!done.ok) { toasts.error("部署前需要成功构建当前源码"); return; }
      }
      const created = toJob(await client.preview.deploy(project, deviceId));
      if (!created) { toasts.error("部署没有返回任务 ID"); return; }
      store.update({ job: created });
      poll(project, created.id);
    } catch (error) {
      toasts.error(`部署失败：${errorText(error)}`);
    } finally {
      store.update({ starting: false });
    }
  }

  async function cancel(): Promise<void> {
    const project = deps.project();
    const job = state().job;
    if (!project || !job) return;
    try {
      await client.preview.deployCancel(project, job.id);
      store.update({ job: { ...job, status: "cancelled", logs: [...job.logs, "部署已取消。"] } });
    } catch (error) {
      toasts.error(`取消部署失败：${errorText(error)}`);
    } finally {
      stopPolling();
    }
  }

  function reset(): void { stopPolling(); store.update({ job: undefined, starting: false }); }

  return { store, state, loadDevices, select, start, cancel, reset };
}
export type Deploy = ReturnType<typeof createDeploy>;
