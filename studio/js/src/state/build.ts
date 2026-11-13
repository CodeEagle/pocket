// Build control, the studio.build.events stream, a bounded log ring buffer and
// structured diagnostics. Reconnects the stream in JS with backoff.
import { createStore } from "./store.ts";
import { RingBuffer } from "./ring.ts";
import { openResilient, type ConnectionState } from "./resilient.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { normalizeDiagnostics, type Diagnostic } from "../lib/diagnostics.ts";
import type { ProjectStatus, StudioClient, WatchEvent } from "../studio-client.ts";

export const LOG_CAPACITY = 2000;

export interface LogEntry { id: number; text: string; gap?: number }
export interface BuildDone { ok: boolean; revision: number | undefined; builtRevision: number | null | undefined }

export interface BuildState {
  project?: string;
  status?: ProjectStatus;
  busy: boolean;
  error?: string;
  diagnostics: Diagnostic[];
  /** Newest lines, oldest first, bounded by LOG_CAPACITY. */
  logs: LogEntry[];
  logVersion: number;
  stream: ConnectionState | "off";
  lastDone?: BuildDone & { at: number };
  starting: boolean;
}

export function createBuild(deps: { client: StudioClient; timers: Timers; toasts: Toasts }) {
  const { client, timers, toasts } = deps;
  const store = createStore<BuildState>({ busy: false, diagnostics: [], logs: [], logVersion: 0, stream: "off", starting: false });
  const ring = new RingBuffer<LogEntry>(LOG_CAPACITY);
  let nextLogId = 1;
  let stream: { close(): void } | undefined;
  let epoch = 0;
  const doneListeners = new Set<(done: BuildDone) => void>();
  const waiters: ((done: BuildDone) => void)[] = [];
  /** The first `status` event of a connection carries the log window; later ones are state only. */
  let expectSnapshot = true;
  /** True from a build's start until its first terminal signal (`done` or a busy -> idle status). Dedupes the two. */
  let active = false;

  const state = () => store.get();
  const publishLogs = (): void => store.update({ logs: ring.toArray(), logVersion: state().logVersion + 1 });

  function appendLog(text: string, gap?: number): void {
    ring.push({ id: nextLogId++, text, ...(gap ? { gap } : {}) });
  }

  function seedLogs(lines: unknown): void {
    if (!Array.isArray(lines)) return;
    ring.clear();
    for (const line of lines) if (typeof line === "string") appendLog(line);
    publishLogs();
  }

  function applyStatus(status: ProjectStatus, previousBusy: boolean): void {
    if (status.busy === true) active = true;
    const diagnostics = normalizeDiagnostics((status as { diagnostics?: unknown }).diagnostics);
    store.update({
      status,
      busy: status.busy === true,
      error: typeof status.error === "string" ? status.error : undefined,
      diagnostics: status.error ? diagnostics : [],
    });
    // A terminal transition seen only through status (a dropped `done`) still finishes waiters.
    if (previousBusy && active && status.busy !== true) finish({ ok: !status.error && status.builtRevision === status.revision, revision: status.revision, builtRevision: status.builtRevision });
  }

  function finish(done: BuildDone): void {
    if (!active) return;
    active = false;
    store.update({ lastDone: { ...done, at: timers.now() }, starting: false });
    for (const wait of waiters.splice(0)) wait(done);
    for (const listener of [...doneListeners]) listener(done);
  }

  function onEvent(event: WatchEvent | { type: "done"; ok: boolean; builtRevision?: number | null; diagnostics?: unknown[] }): void {
    switch (event.type) {
      case "status": {
        const status = (event as { status: ProjectStatus }).status;
        if (status && typeof status === "object") {
          if (expectSnapshot) { expectSnapshot = false; seedLogs((status as { logs?: unknown }).logs); }
          applyStatus(status, state().busy);
        }
        break;
      }
      case "log": {
        appendLog(String((event as { line: unknown }).line));
        publishLogs();
        break;
      }
      case "done": {
        const done = event as { ok: boolean; builtRevision?: number | null; diagnostics?: unknown[] };
        const diagnostics = normalizeDiagnostics(done.diagnostics);
        store.update({ busy: false, ...(done.ok ? { error: undefined, diagnostics: [] } : diagnostics.length ? { diagnostics } : {}) });
        finish({ ok: done.ok === true, revision: state().status?.revision, builtRevision: done.builtRevision });
        break;
      }
      case "gap": {
        const dropped = (event as { dropped: number }).dropped;
        appendLog(`… 已丢失 ${dropped} 条日志 …`, dropped);
        publishLogs();
        void refresh(); // the stream said events were dropped: take the authoritative status
        break;
      }
      default: break;
    }
  }

  async function refresh(): Promise<void> {
    const project = state().project;
    if (!project) return;
    const mine = epoch;
    try {
      const status = await client.build.status(project);
      if (mine !== epoch) return;
      if (ring.size === 0) seedLogs(status.logs);
      applyStatus(status, state().busy);
    } catch (error) {
      if (mine === epoch) toasts.error(`读取构建状态失败：${errorText(error)}`);
    }
  }

  function attach(project: string): void {
    detach();
    epoch += 1;
    ring.clear();
    expectSnapshot = true;
    active = false;
    store.set({ project, busy: false, diagnostics: [], logs: [], logVersion: 0, stream: "connecting", starting: false });
    void refresh();
    stream = openResilient<WatchEvent>({
      timers,
      open: (h) => client.build.events(project, h.onEvent, h.onError, h.onEnd),
      onEvent: (event) => onEvent(event),
      onResync: () => { expectSnapshot = true; },
      onState: (s) => { if (state().project === project) store.update({ stream: s }); },
    });
  }

  function detach(): void {
    stream?.close();
    stream = undefined;
    epoch += 1;
    for (const wait of waiters.splice(0)) wait({ ok: false, revision: undefined, builtRevision: undefined });
    store.set({ busy: false, diagnostics: [], logs: [], logVersion: 0, stream: "off", starting: false });
    ring.clear();
  }

  /** Starts a build. Resolves true when the request was accepted. */
  async function start(): Promise<boolean> {
    const project = state().project;
    if (!project || state().busy || state().starting) return false;
    store.update({ starting: true, diagnostics: [] });
    try {
      const status = await client.build.start(project);
      active = true;
      store.update({ status, busy: status.busy === true, starting: false });
      return true;
    } catch (error) {
      store.update({ starting: false });
      toasts.error(`无法开始构建：${errorText(error)}`);
      return false;
    }
  }

  /** Starts a build and resolves when it finishes (ok = built the current revision without error). */
  async function run(): Promise<BuildDone> {
    const wait = new Promise<BuildDone>((resolve) => waiters.push(resolve));
    if (!state().busy && !(await start())) {
      waiters.pop();
      return { ok: false, revision: undefined, builtRevision: undefined };
    }
    const done = await wait;
    // The status event that follows a failed `done` may not have landed yet; ask once for authoritative state.
    await refresh();
    return done;
  }

  async function cancel(): Promise<void> {
    const project = state().project;
    if (!project || !state().busy) return;
    try {
      const result = await client.build.cancel(project);
      if (result.pending) toasts.info("正在取消构建…（共享缓存步骤结束后生效）");
      else toasts.info("构建已取消");
    } catch (error) { toasts.error(`取消失败：${errorText(error)}`); }
  }

  function clearLogs(): void { ring.clear(); publishLogs(); }

  return {
    store, state, attach, detach, start, run, cancel, refresh, clearLogs,
    onDone(listener: (done: BuildDone) => void): () => void { doneListeners.add(listener); return () => { doneListeners.delete(listener); }; },
    /** Newest `n` log entries. */
    tail: (n: number): LogEntry[] => ring.tail(n),
    logSize: (): number => ring.size,
  };
}
export type Build = ReturnType<typeof createBuild>;
