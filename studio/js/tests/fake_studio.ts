// A stateful stand-in for the studio.* provider and the System host, serving
// the exact result shapes of the frozen contract (studio/docs/ARCHITECTURE.md).
// It exists only for guest-level tests on the real native probe: the Dart
// provider and the real service are tested elsewhere (pocket_studio tests and
// studio/test/studio_host_test.dart).
import { createHash } from "node:crypto";
import type { HostRequest, ProbeSession, Reply } from "./probe_session.ts";

export const projects = [
  { id: "alpha-app", appId: "pocket.alpha", name: "Alpha", title: "Alpha 应用", version: "0.1.0", build: 1, tickHz: 60, template: "app" },
  { id: "beta-game", appId: "pocket.beta", name: "Beta", title: "Beta 游戏", version: "0.1.0", build: 1, tickHz: 60, template: "game" },
];

const err = (code: string, message: string): Reply => ({ ok: false, error: { code, message } });
const ok = (result: unknown): Reply => ({ ok: true, result });

export class FakeStudio {
  files = new Map<string, string>([
    ["app.tsx", "export const MARKER_APP_TSX = 1;\n"],
    ["manifest.json", "{}\n"],
    ["src/alpha.ts", "export const MARKER_ALPHA = 2;\n"],
    ["src/deep/beta.ts", "export const MARKER_BETA = 3;\n"],
  ]);
  assets = ["logo.png", "hero.jpg"];
  revision = 1;
  builtRevision: number | null = null;
  busy = false;
  buildError: string | undefined;
  diagnostics: unknown[] = [];
  /** "ok" builds succeed; "fail" ends with a syntax error diagnostic. */
  buildMode: "ok" | "fail" = "ok";
  buildDelayMs = 30;
  previewBuild = 1;
  failPublish: Reply | undefined;
  failCreate: Reply | undefined;
  storage = new Map<string, unknown>();
  storageAvailable = true;
  requests: HostRequest[] = [];
  streams = new Map<string, { topic: string; params: Record<string, any> }>();
  cancelled = new Set<string>();
  instanceSeq = 0;
  instances = new Set<string>();
  session: ProbeSession | undefined;
  devices: unknown[] = [];
  deployPolls = 0;
  deployJob: Record<string, unknown> | undefined;
  logs: string[] = [];
  /** Overrides the size the tree reports for a path (to model files that are not worth materializing). */
  reportedBytes = new Map<string, number>();
  upload: { path: string; total: number; sha: string; parts: Buffer[] } | undefined;

  attach(session: ProbeSession): void {
    this.session = session;
    session.onGuestEvent = (name, payload) => {
      if (name === "stream.open") this.streams.set(String(payload.streamId), { topic: String(payload.topic), params: payload.params ?? {} });
      if (name === "stream.cancel" || name === "stream.end") this.cancelled.add(String(payload.streamId));
      if (name === "stream.open" && payload.topic === "studio.build.events") this.pushTo(String(payload.streamId), [{ type: "status", status: this.status() }]);
      if (name === "stream.open" && payload.topic === "studio.fs.watch") this.pushTo(String(payload.streamId), [{ type: "ready", revision: this.revision }]);
    };
  }

  calls(capability: string): HostRequest[] { return this.requests.filter((r) => r.capability === capability); }
  openStreams(topic: string): string[] {
    return [...this.streams].filter(([id, s]) => s.topic === topic && !this.cancelled.has(id)).map(([id]) => id);
  }

  status() {
    return {
      id: "alpha-app", revision: this.revision, builtRevision: this.builtRevision, busy: this.busy,
      ...(this.buildError ? { error: this.buildError, diagnostics: this.diagnostics } : {}), logs: this.logs.slice(-200),
    };
  }

  pushTo(streamId: string, events: unknown[]): void {
    try { this.session?.sendEvent("stream.data", { streamId, data: { events } }); } catch { /* session already closed */ }
  }
  push(topic: string, events: unknown[]): void { for (const id of this.openStreams(topic)) this.pushTo(id, events); }
  /** Ends every open stream of a topic as the provider does on a service-side drop. */
  drop(topic: string): void {
    for (const id of this.openStreams(topic)) {
      this.cancelled.add(id);
      try { this.session?.sendEvent("stream.end", { streamId: id, reason: "service closed" }); } catch { /* session already closed */ }
    }
  }

  /** Simulates another process editing a file on disk. */
  externalWrite(path: string, content: string | undefined): void {
    if (content === undefined) this.files.delete(path); else this.files.set(path, content);
    this.revision += 1;
    this.push("studio.fs.watch", [{ type: "change", path, kind: "file", event: content === undefined ? "rename" : "change" }]);
  }

  private startBuild(): void {
    this.busy = true;
    this.buildError = undefined;
    this.diagnostics = [];
    this.logs = ["build: start"];
    this.push("studio.build.events", [{ type: "status", status: this.status() }, { type: "log", line: "build: start" }]);
    setTimeout(() => {
      this.busy = false;
      if (this.buildMode === "fail") {
        this.buildError = "SyntaxError: app.tsx: Unterminated JSX contents. (3:5)";
        this.diagnostics = [{ file: "app.tsx", line: 3, column: 5, severity: "error", message: "Unterminated JSX contents." }];
        this.logs.push(this.buildError);
        this.push("studio.build.events", [{ type: "log", line: this.buildError }, { type: "status", status: this.status() }, { type: "done", ok: false, builtRevision: this.builtRevision, diagnostics: this.diagnostics }]);
      } else {
        this.builtRevision = this.revision;
        this.logs.push("build: ok");
        this.push("studio.build.events", [{ type: "log", line: "build: ok" }, { type: "status", status: this.status() }, { type: "done", ok: true, builtRevision: this.builtRevision, diagnostics: [] }]);
      }
    }, this.buildDelayMs);
  }

  mutate(): void {
    this.revision += 1;
    this.builtRevision = this.builtRevision; // a source change leaves builtRevision behind
  }

  handle = (request: HostRequest): Reply | Promise<Reply> => {
    this.requests.push(request);
    const p = request.params;
    switch (request.capability) {
      case "studio.project.list": return ok({ projects });
      case "studio.project.create": return ok({ ...projects[0], id: p.id, title: p.settings?.name ?? p.id });
      case "studio.fs.tree": return ok({
        files: [...this.files].map(([path, text]) => ({ path, bytes: this.reportedBytes.get(path) ?? new TextEncoder().encode(text).length })),
        revision: this.revision, ...(p.assets ? { assets: this.assets } : {}),
      });
      case "studio.fs.read": {
        const text = this.files.get(p.path);
        return text === undefined ? err("not_found", "file not found") : ok({ path: p.path, content: text, bytes: new TextEncoder().encode(text).length, revision: this.revision });
      }
      case "studio.fs.readChunk": {
        const bytes = Buffer.from(this.files.get(p.path) ?? "", "utf8");
        if (!this.files.has(p.path)) return err("not_found", "file not found");
        const length = Math.min(Number(p.length ?? 131072), 131072, bytes.length - p.offset);
        return ok({ path: p.path, offset: p.offset, length, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: 1, data: bytes.subarray(p.offset, p.offset + length).toString("base64") });
      }
      case "studio.fs.write": {
        this.files.set(p.path, p.content);
        this.mutate();
        // The service's watcher reports our own writes too; the guest must ignore them.
        this.push("studio.fs.watch", [{ type: "change", path: p.path, kind: "file", event: "change" }, { type: "revision", revision: this.revision }]);
        return ok({ path: p.path, bytes: new TextEncoder().encode(p.content).length, revision: this.revision });
      }
      case "studio.fs.upload.begin": { this.upload = { path: p.path, total: p.totalBytes, sha: p.sha256, parts: [] }; return ok({ uploadId: "up-1", chunkBytes: 131072 }); }
      case "studio.fs.upload.chunk": { this.upload?.parts.push(Buffer.from(p.data, "base64")); return ok({ uploadId: p.uploadId, received: this.upload?.parts.reduce((n, b) => n + b.length, 0) ?? 0, totalBytes: this.upload?.total ?? 0 }); }
      case "studio.fs.upload.commit": {
        const up = this.upload;
        if (!up) return err("not_found", "no upload");
        const all = Buffer.concat(up.parts);
        if (createHash("sha256").update(all).digest("hex") !== up.sha) return err("checksum_mismatch", "sha256 mismatch (HTTP 422)");
        this.files.set(up.path, all.toString("utf8")); this.mutate(); this.upload = undefined;
        return ok({ path: up.path, bytes: all.length, sha256: up.sha, revision: this.revision });
      }
      case "studio.fs.upload.abort": this.upload = undefined; return ok({ uploadId: p.uploadId, aborted: true });
      case "studio.fs.rename": {
        const text = this.files.get(p.from);
        if (text === undefined) return err("not_found", "source missing");
        if (this.files.has(p.to)) return err("conflict", "target exists (HTTP 409)");
        this.files.delete(p.from); this.files.set(p.to, text); this.mutate();
        return ok({ from: p.from, to: p.to, revision: this.revision });
      }
      case "studio.fs.delete": {
        if (!this.files.delete(p.path)) return err("not_found", "file not found");
        this.mutate();
        return ok({ path: p.path, revision: this.revision });
      }
      case "studio.fs.mkdir": this.mutate(); return ok({ path: p.path, created: true, revision: this.revision });
      case "studio.fs.rmdir": this.mutate(); return ok({ path: p.path, revision: this.revision });
      case "studio.fs.stat": return p.path.startsWith("assets/")
        ? ok({ path: p.path, kind: "file", bytes: 2048, mtimeMs: 1_700_000_000_000, editable: false })
        : err("not_found", "missing");
      case "studio.build.status": return ok(this.status());
      case "studio.build.start": {
        if (this.busy) return err("conflict", "build already running (HTTP 409)");
        this.startBuild();
        return ok(this.status());
      }
      case "studio.build.cancel": {
        if (!this.busy) return err("conflict", "no build is running (HTTP 409)");
        return ok({ cancelled: true, status: this.status() });
      }
      case "studio.preview.publish": {
        if (this.failPublish) return this.failPublish;
        if (this.builtRevision !== this.revision) return err("conflict", "build the current source successfully before preview publish (HTTP 409)");
        this.previewBuild += 1;
        return ok({ buildId: `alpha-app@${this.revision}`, revision: this.revision, version: `0.1.0-preview.${this.previewBuild}`, build: this.previewBuild, packageId: "dev.pocket.studio.preview" });
      }
      case "studio.preview.devices": return ok({ devices: this.devices });
      case "studio.preview.deploy": {
        this.deployPolls = 0;
        this.deployJob = { id: "job-1", status: "queued", logs: ["queued"] };
        return ok({ job: this.deployJob });
      }
      case "studio.preview.deployStatus": {
        this.deployPolls += 1;
        this.deployJob = this.deployPolls < 2
          ? { id: "job-1", status: "building", logs: ["queued", "flutter build"] }
          : { id: "job-1", status: "running", logs: ["queued", "flutter build", "app is running"] };
        return ok(this.deployJob);
      }
      case "studio.preview.deployCancel": return ok({ id: "job-1", status: "cancelled", logs: [] });
      case "system.runtime.configure": return ok({ systemInstanceId: "system-ui", generation: 1 });
      case "system.runtime.post": return ok({ delivered: true });
      case "system.runtime.create": {
        if (this.failCreate) return this.failCreate;
        const instanceId = `pocket-app-${++this.instanceSeq}`;
        this.instances.add(instanceId);
        return ok({ instanceId, appId: p.appId, generation: 1, preparedForOpen: p.prepareForOpen === true });
      }
      case "system.runtime.destroy": {
        if (!this.instances.delete(p.instanceId)) return err("instance_not_found", "no such instance");
        return ok({});
      }
      case "system.runtime.awaitFirstFrame": return ok({ ready: true });
      case "system.storage.get": return this.storageAvailable ? ok(this.storage.get(p.key) ?? null) : err("not_configured", "storage unavailable");
      case "system.storage.set": {
        if (!this.storageAvailable) return err("not_configured", "storage unavailable");
        this.storage.set(p.key, p.value);
        return ok(null);
      }
      default: return err("capability_unavailable", request.capability);
    }
  };
}
