// Typed JS client over the frozen studio.* capability contract
// (studio/docs/ARCHITECTURE.md). Orchestration (chunk loops, hashing, stream
// expansion) lives here in JS; the Dart provider only forwards.
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "./bytes.ts";
import { sha256Hex } from "./sha256.ts";

export const CHUNK_BYTES = 128 * 1024;
export const SMALL_WRITE_BYTES = 192 * 1024;
export const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;

export interface StudioHost {
  request<T = unknown>(capability: string, params?: Record<string, unknown>): Promise<T>;
}
export interface StudioStreamLike {
  onData(listener: (value: any) => void): () => void;
  onError(listener: (error: { code?: string; message?: string }) => void): () => void;
  onEnd(listener: (close: unknown) => void): () => void;
  cancel(reason?: string): void;
}
export interface StudioStreams {
  open(topic: string, params?: Record<string, unknown>): StudioStreamLike;
}

export class StudioError extends Error {
  readonly code: string;
  readonly capability: string;
  constructor(capability: string, code: string, message: string) {
    super(message);
    this.name = "StudioError";
    this.code = code;
    this.capability = capability;
  }
}

export interface ProjectStatus { revision: number; builtRevision: number | null; busy: boolean; error?: string; [key: string]: unknown }
export interface ProjectInfo {
  id: string; appId: string; name: string; title: string; version: string; build: number;
  tickHz: number; template: "app" | "game"; status?: ProjectStatus; [key: string]: unknown;
}
export interface FileEntry { path: string; bytes: number }
export interface TreeResult { files: FileEntry[]; revision: number; assets?: string[] }
export interface ChunkResult { path: string; offset: number; length: number; totalBytes: number; sha256: string; mtimeMs: number; data: string }
export type WatchEvent =
  | { type: "ready"; revision: number }
  | { type: "change"; path: string; kind: "file" | "directory"; event: "change" | "rename" }
  | { type: "revision"; revision: number }
  | { type: "status"; status: ProjectStatus }
  | { type: "log"; line: string }
  | { type: "done"; ok: boolean; builtRevision?: number | null; diagnostics?: unknown[] }
  | { type: "gap"; dropped: number };

export interface Subscription { close(): void }

export function createStudioClient(host: StudioHost, streams?: StudioStreams) {
  async function call<T = any>(capability: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await host.request<T>(capability, params);
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      throw new StudioError(capability, typeof e?.code === "string" ? e.code : "host_error", typeof e?.message === "string" ? e.message : String(error));
    }
  }

  /** Subscribes to a studio stream and expands the provider's `{events:[...]}` batches. */
  function subscribe(topic: string, project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void): Subscription {
    if (!streams) throw new StudioError(topic, "streams_unavailable", "stream adapter was not provided");
    const stream = streams.open(topic, { project });
    stream.onData((batch) => {
      const events = batch && Array.isArray(batch.events) ? batch.events : [];
      for (const event of events) onEvent(event as WatchEvent);
    });
    stream.onError((e) => onError?.(new StudioError(topic, e.code ?? "stream_error", e.message ?? "stream failed")));
    stream.onEnd(() => onEnd?.());
    return { close: () => stream.cancel("closed by guest") };
  }

  const fs = {
    tree: (project: string, withAssets = false) => call<TreeResult>("studio.fs.tree", { project, ...(withAssets ? { assets: true } : {}) }),
    read: (project: string, path: string) => call<{ path: string; content: string; bytes: number; revision: number }>("studio.fs.read", { project, path }),
    write: (project: string, path: string, content: string) => call<{ path: string; bytes: number; revision: number }>("studio.fs.write", { project, path, content }),
    rename: (project: string, from: string, to: string, overwrite = false) => call<{ from: string; to: string; revision: number }>("studio.fs.rename", { project, from, to, ...(overwrite ? { overwrite } : {}) }),
    delete: (project: string, path: string) => call<{ path: string; revision: number }>("studio.fs.delete", { project, path }),
    stat: (project: string, path: string) => call<{ path: string; kind: "file" | "directory"; bytes: number; mtimeMs: number; editable: boolean }>("studio.fs.stat", { project, path }),
    mkdir: (project: string, path: string) => call<{ path: string; created: boolean; revision: number }>("studio.fs.mkdir", { project, path }),
    rmdir: (project: string, path: string) => call<{ path: string; revision: number }>("studio.fs.rmdir", { project, path }),
    readChunk: (project: string, path: string, offset: number, length = CHUNK_BYTES) => call<ChunkResult>("studio.fs.readChunk", { project, path, offset, length }),
    upload: {
      begin: (project: string, path: string, totalBytes: number, sha256: string) => call<{ uploadId: string; chunkBytes: number }>("studio.fs.upload.begin", { project, path, totalBytes, sha256 }),
      chunk: (project: string, uploadId: string, offset: number, data: string) => call<{ received: number; totalBytes: number }>("studio.fs.upload.chunk", { project, uploadId, offset, data }),
      commit: (project: string, uploadId: string) => call<{ path: string; bytes: number; sha256: string; revision: number }>("studio.fs.upload.commit", { project, uploadId }),
      abort: (project: string, uploadId: string) => call<{ aborted: boolean }>("studio.fs.upload.abort", { project, uploadId }),
    },
    watch: (project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void) =>
      subscribe("studio.fs.watch", project, onEvent, onError, onEnd),

    /** Reads a whole file as bytes. Splits into <=128 KiB chunks and verifies the service's whole-file sha256. */
    async readBytes(project: string, path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<{ bytes: Uint8Array; sha256: string }> {
      let first = await fs.readChunk(project, path, 0);
      if (first.totalBytes > maxBytes) throw new StudioError("studio.fs.readChunk", "too_large", `file is ${first.totalBytes} bytes (limit ${maxBytes})`);
      const out = new Uint8Array(first.totalBytes);
      let offset = 0;
      for (;;) {
        const part = base64Decode(first.data);
        if (first.sha256 !== undefined && part.length !== first.length) throw new StudioError("studio.fs.readChunk", "invalid_response", "chunk length mismatch");
        out.set(part, offset);
        offset += part.length;
        if (offset >= first.totalBytes || part.length === 0) break;
        const next = await fs.readChunk(project, path, offset);
        if (next.sha256 !== first.sha256 || next.totalBytes !== first.totalBytes) throw new StudioError("studio.fs.readChunk", "conflict", "file changed while it was being read");
        first = next;
      }
      if (offset !== out.length) throw new StudioError("studio.fs.readChunk", "invalid_response", "short read");
      const digest = sha256Hex(out);
      if (digest !== first.sha256) throw new StudioError("studio.fs.readChunk", "checksum_mismatch", "sha256 does not match the transferred bytes");
      return { bytes: out, sha256: digest };
    },
    /** Reads UTF-8 text: one small call when possible, chunked and verified otherwise. */
    async readText(project: string, path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<{ text: string; bytes: number; revision?: number }> {
      try {
        const small = await fs.read(project, path);
        return { text: small.content, bytes: small.bytes, revision: small.revision };
      } catch (error) {
        if (!(error instanceof StudioError) || error.code !== "too_large") throw error;
      }
      const { bytes } = await fs.readBytes(project, path, maxBytes);
      return { text: utf8Decode(bytes), bytes: bytes.length };
    },
    /** Writes UTF-8 text: one call when small, otherwise a verified chunked upload that is aborted on failure. */
    async writeText(project: string, path: string, text: string): Promise<{ path: string; bytes: number; revision: number }> {
      const bytes = utf8Encode(text);
      if (bytes.length <= SMALL_WRITE_BYTES) return fs.write(project, path, text);
      const begin = await fs.upload.begin(project, path, bytes.length, sha256Hex(bytes));
      try {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          await fs.upload.chunk(project, begin.uploadId, offset, base64Encode(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))));
        }
        const done = await fs.upload.commit(project, begin.uploadId);
        return { path: done.path, bytes: done.bytes, revision: done.revision };
      } catch (error) {
        try { await fs.upload.abort(project, begin.uploadId); } catch { /* upload already gone */ }
        throw error;
      }
    },
  };

  return {
    project: {
      async list(): Promise<ProjectInfo[]> { return (await call<{ projects: ProjectInfo[] }>("studio.project.list")).projects; },
      create: (id: string, template: "app" | "game", settings: Record<string, unknown> = {}) => call<ProjectInfo>("studio.project.create", { id, template, settings }),
      open: (project: string) => call<ProjectInfo>("studio.project.open", { project }),
      settings: {
        get: (project: string) => call<Record<string, unknown>>("studio.project.settings.get", { project }),
        set: (project: string, settings: Record<string, unknown>) => call<Record<string, unknown>>("studio.project.settings.set", { project, settings }),
      },
    },
    fs,
    build: {
      start: (project: string) => call<ProjectStatus>("studio.build.start", { project }),
      cancel: (project: string) => call<{ cancelled: boolean; pending?: boolean; status: ProjectStatus }>("studio.build.cancel", { project }),
      status: (project: string) => call<ProjectStatus & { logs: string[] }>("studio.build.status", { project }),
      events: (project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void) =>
        subscribe("studio.build.events", project, onEvent, onError, onEnd),
    },
    logs: { tail: (project: string) => call<{ logs: string[]; error: string | null }>("studio.logs.tail", { project }) },
    preview: {
      publish: (project: string) => call<Record<string, unknown>>("studio.preview.publish", { project }),
      devices: () => call<{ devices: unknown[] }>("studio.preview.devices"),
      deploy: (project: string, deviceId: string) => call<Record<string, unknown>>("studio.preview.deploy", { project, deviceId }),
      deployStatus: (project: string, job: string) => call<Record<string, unknown>>("studio.preview.deployStatus", { project, job }),
      deployCancel: (project: string, job: string) => call<Record<string, unknown>>("studio.preview.deployCancel", { project, job }),
    },
    publish: {
      plan: (project: string, channel: "test" | "release" = "test") => call<Record<string, unknown>>("studio.publish.plan", { project, channel }),
      publish: (project: string, channel: "test" | "release" = "test") => call<Record<string, unknown>>("studio.publish.publish", { project, channel }),
      history: (project: string) => call<Record<string, unknown>>("studio.publish.history", { project }),
      offline: (project: string) => call<{ archiveUrl: string; filename: string }>("studio.publish.offline", { project }),
    },
    artifacts: {
      list: (project: string) => call<{ revision: number; builtRevision: number | null; artifacts?: Record<string, unknown> }>("studio.artifacts.list", { project }),
      inspect: (project: string, name: string) => call<{ name: string; bytes: number; encoding: "utf8" | "binary"; data?: string; truncated?: boolean }>("studio.artifacts.inspect", { project, name }),
    },
    service: {
      health: () => call<{ ok: boolean; service: string; version?: string }>("studio.service.health"),
      upgradeStatus: () => call<Record<string, unknown>>("studio.service.upgrade.status"),
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;
