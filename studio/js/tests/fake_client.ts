// In-memory StudioClient for unit tests of the state modules (no host, no probe).
import { StudioError, type StudioClient, type Subscription, type WatchEvent } from "../src/studio-client.ts";

type Handlers = { onEvent(e: WatchEvent): void; onError(e: StudioError): void; onEnd(): void };

export function createFakeClient() {
  const files = new Map<string, string>();
  const calls: { name: string; args: unknown[] }[] = [];
  const watchers: Handlers[] = [];
  const buildStreams: Handlers[] = [];
  const state = {
    revision: 1, builtRevision: null as number | null, busy: false, error: undefined as string | undefined,
    diagnostics: [] as unknown[], logs: [] as string[], failWrites: false, publishError: undefined as StudioError | undefined,
    previewBuild: 1, startBuildHook: undefined as undefined | (() => void),
  };
  const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  const status = () => ({
    id: "p", revision: state.revision, builtRevision: state.builtRevision, busy: state.busy,
    ...(state.error ? { error: state.error, diagnostics: state.diagnostics } : {}), logs: [...state.logs],
  });
  const notFound = (cap: string) => new StudioError(cap, "not_found", "file not found");
  const sub = (list: Handlers[], h: Handlers): Subscription => { list.push(h); return { close: () => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); } }; };

  const client = {
    project: { list: async () => [], create: async () => ({}), open: async () => ({}), settings: { get: async () => ({}), set: async () => ({}) } },
    fs: {
      tree: async (p: string, assets?: boolean) => { record("tree", p, assets); return { files: [...files].map(([path, t]) => ({ path, bytes: new TextEncoder().encode(t).length })), revision: state.revision, assets: ["a.png"] }; },
      readText: async (p: string, path: string, max?: number, known?: number) => {
        record("readText", p, path, max, known);
        const t = files.get(path);
        if (t === undefined) throw notFound("studio.fs.read");
        return { text: t, bytes: new TextEncoder().encode(t).length };
      },
      writeText: async (p: string, path: string, text: string) => {
        record("writeText", p, path, text);
        if (state.failWrites) throw new StudioError("studio.fs.write", "service_error", "disk full (HTTP 500)");
        files.set(path, text); state.revision += 1;
        return { path, bytes: new TextEncoder().encode(text).length, revision: state.revision };
      },
      rename: async (p: string, from: string, to: string) => { record("rename", p, from, to); const t = files.get(from); if (t === undefined) throw notFound("rename"); files.delete(from); files.set(to, t); state.revision += 1; return { from, to, revision: state.revision }; },
      delete: async (p: string, path: string) => { record("delete", p, path); if (!files.delete(path)) throw notFound("delete"); state.revision += 1; return { path, revision: state.revision }; },
      mkdir: async (p: string, path: string) => { record("mkdir", p, path); return { path, created: true, revision: ++state.revision }; },
      rmdir: async (p: string, path: string) => { record("rmdir", p, path); return { path, revision: ++state.revision }; },
      stat: async (p: string, path: string) => { record("stat", p, path); return { path, kind: "file" as const, bytes: 10, mtimeMs: 1, editable: false }; },
      watch: (p: string, onEvent: (e: WatchEvent) => void, onError?: (e: StudioError) => void, onEnd?: () => void) => { record("watch", p); const s = sub(watchers, { onEvent, onError: onError ?? (() => {}), onEnd: onEnd ?? (() => {}) }); onEvent({ type: "ready", revision: state.revision }); return s; },
    },
    build: {
      start: async (p: string) => { record("build.start", p); state.busy = true; state.error = undefined; state.diagnostics = []; state.startBuildHook?.(); return status(); },
      cancel: async (p: string) => { record("build.cancel", p); return { cancelled: true, status: status() }; },
      status: async (p: string) => { record("build.status", p); return status(); },
      events: (p: string, onEvent: (e: WatchEvent) => void, onError?: (e: StudioError) => void, onEnd?: () => void) => { record("build.events", p); const s = sub(buildStreams, { onEvent, onError: onError ?? (() => {}), onEnd: onEnd ?? (() => {}) }); onEvent({ type: "status", status: status() } as WatchEvent); return s; },
    },
    preview: {
      publish: async (p: string) => { record("publish", p); if (state.publishError) throw state.publishError; if (state.builtRevision !== state.revision) throw new StudioError("studio.preview.publish", "conflict", "build the current source first (HTTP 409)"); return { version: `0.1.0-preview.${++state.previewBuild}`, build: state.previewBuild }; },
      devices: async () => ({ devices: [] }), deploy: async () => ({}), deployStatus: async () => ({}), deployCancel: async () => ({}),
    },
    publish: {}, artifacts: {}, logs: {}, service: {},
  } as unknown as StudioClient;

  /** Finishes the running build the way the service does: status, then done. */
  const finishBuild = (ok: boolean, diagnostics: unknown[] = []) => {
    state.busy = false;
    if (ok) { state.builtRevision = state.revision; state.error = undefined; state.diagnostics = []; }
    else { state.error = "build failed"; state.diagnostics = diagnostics; }
    for (const h of [...buildStreams]) { h.onEvent({ type: "status", status: status() } as WatchEvent); h.onEvent({ type: "done", ok, builtRevision: state.builtRevision, diagnostics } as WatchEvent); }
  };
  return {
    client, files, calls, state, watchers, buildStreams, finishBuild,
    count: (name: string) => calls.filter((c) => c.name === name).length,
    emitWatch: (e: WatchEvent) => { for (const h of [...watchers]) h.onEvent(e); },
    emitBuild: (e: unknown) => { for (const h of [...buildStreams]) h.onEvent(e as WatchEvent); },
    dropWatch: () => { for (const h of [...watchers]) h.onEnd(); },
    errorBuildStream: () => { for (const h of [...buildStreams]) h.onError(new StudioError("studio.build.events", "plugin_stream_quota", "stream quota")); },
    external: (path: string, text: string | undefined) => { if (text === undefined) files.delete(path); else files.set(path, text); state.revision += 1; for (const h of [...watchers]) h.onEvent({ type: "change", path, kind: "file", event: "change" }); },
  };
}
export const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
