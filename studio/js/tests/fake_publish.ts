// M5 extension of the stateful studio.* fake: publish plan / publish / history / offline, artifacts and the
// clipboard capability. Shapes follow what sdk/editor/server.ts returns through the provider (see
// ARCHITECTURE.md): the same field names, the signed envelope reduced to its public identity, no key material.
import { createHash } from "node:crypto";
import { FakeStudio } from "./fake_studio.ts";
import { ProbeSession, type HostRequest, type Reply } from "./probe_session.ts";

const err = (code: string, message: string): Reply => ({ ok: false, error: { code, message } });
const ok = (result: unknown): Reply => ({ ok: true, result });

export const KEY_ID = "editor-alpha-app";
export const RUNTIME_ABI = "quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021";
export const ORIGIN = "http://127.0.0.1:8795";

interface Release {
  id: string; releaseId: string; slot: "test" | "stable"; channel: "test" | "release"; version: string; build: number;
  revision: number; publishedAt: string; hostVersion: string; packageVersion: string; payloadSha256: string;
}

export class FakePublish extends FakeStudio {
  clipboard: string[] = [];
  clipboardAvailable = true;
  releases: Release[] = [];
  testBuild = 0;
  publishFailure: Reply | undefined;
  publishDelayMs = 40;
  /** Reused-package targets the plan reports. */
  reused: Record<string, unknown>[] = [];
  /** resources.json served by artifacts.inspect. */
  resources: unknown = {
    version: 1, revision: 1, policy: { version: 1, packages: {} },
    packages: [{
      id: "pocket.alpha", title: "Alpha 应用", manifest: "pocket.json", artifactDirectory: ".", version: "0.1.0", build: 1, runtimeAbi: RUNTIME_ABI,
      resources: [
        { key: "pak:logo", kind: "pak", bytes: 1000, placement: "pak" },
        { key: "asset:assets/hero.jpg", kind: "asset", bytes: 52_000, placement: "pak" },
        { key: "asset:assets/big.mp4", kind: "asset", bytes: 3_000_000, placement: "network" },
      ],
    }],
  };
  signalFailures = new Set<string>();

  constructor() {
    super();
    const base = this.handle;
    this.handle = (request) => {
      const reply = this.m5(request);
      if (reply === undefined) return base(request);
      this.requests.push(request); // the base handler records the requests it serves; record ours the same way
      return reply;
    };
  }
  attach(session: ProbeSession): void { super.attach(session); }

  private built(): boolean { return this.builtRevision !== null && this.builtRevision === this.revision && !this.buildError; }
  private current(slot: "test" | "stable"): Release | undefined { return this.releases.find((r) => r.slot === slot); }

  status() {
    const last = this.releases[0];
    return {
      ...super.status(),
      ...(this.builtRevision !== null ? { artifacts: { revision: this.builtRevision, generation: "gen-1", appJs: "/api/projects/alpha-app/artifacts/app.js", bytecode: "/api/projects/alpha-app/artifacts/app.qjbc", metadata: "/api/projects/alpha-app/artifacts/app.bytecode.json", pak: "/api/projects/alpha-app/artifacts/app.pak", manifest: "/api/projects/alpha-app/artifacts/guest-manifest.json", build: "/api/projects/alpha-app/artifacts/build.json", resources: "/api/projects/alpha-app/resources" } } : {}),
      ...(last ? { publish: this.publishFact(last) } : {}),
    };
  }

  private publishFact(r: Release) {
    const route = `${ORIGIN}/${r.slot}/pocket/studio/pocket.alpha/${r.packageVersion}`;
    return {
      revision: r.revision, updateUrl: `${route}/latest.json`, manifestUrl: `${route}/latest.json`, hostConfigUrl: `${route}/host.json`,
      archiveUrl: `/releases/alpha-app.tar.gz`, keyId: KEY_ID, runtimeAbi: RUNTIME_ABI, payloadSha256: r.payloadSha256,
      version: r.version, build: r.build, channel: r.channel, hostVersion: r.hostVersion, packageVersion: r.packageVersion,
      releaseId: r.releaseId, publishedAt: r.publishedAt,
      packages: [{ id: "pocket.alpha", updateUrl: `${route}/latest.json`, manifestUrl: `${route}/latest.json`, hostConfigUrl: `${route}/host.json`, keyId: KEY_ID, version: r.version, build: r.build }],
    };
  }

  private m5(request: HostRequest): Reply | Promise<Reply> | undefined {
    const p = request.params;
    switch (request.capability) {
      case "clipboard.writeText":
        if (!this.clipboardAvailable) return err("capability_unavailable", "clipboard.writeText");
        this.clipboard.push(String(p.text));
        return ok({ ok: true });
      case "studio.build.status": return ok(this.status());
      case "studio.publish.plan": {
        const built = this.built();
        const slot = p.channel === "release" ? "stable" : "test";
        const published = this.current(slot);
        return ok({
          currentProjectId: "alpha-app", channel: p.channel,
          targets: [{
            projectId: "alpha-app", appId: "pocket.alpha", title: "Alpha", kind: "root", version: "0.1.0", build: 1, revision: this.revision, builtRevision: this.builtRevision,
            built, busy: this.busy, canSelect: true, canPublish: built && !this.busy,
            ...(published ? { publishedVersion: published.version, publishedBuild: published.build, publishedReleaseId: published.releaseId } : {}),
            ...(!built ? { reason: "Build the current project before publishing." } : {}),
          }, ...this.reused],
        });
      }
      case "studio.publish.publish": {
        if (p.channel !== "test" && p.channel !== "release") return err("invalid_params", "channel");
        if (!this.built()) return err("conflict", "build the current source before publishing (HTTP 409)");
        if (this.publishFailure) return this.publishFailure;
        return new Promise<Reply>((resolve) => setTimeout(() => {
          const test = p.channel === "test";
          const build = test ? ++this.testBuild : 1;
          const version = test ? `0.1.0-test.${build}` : "0.1.0";
          const id = `alpha-app-${test ? "test" : "stable"}-${build}`;
          const release: Release = {
            id, releaseId: id, slot: test ? "test" : "stable", channel: p.channel, version, build, revision: this.revision,
            publishedAt: new Date(Date.UTC(2026, 10, 13, 10, build, 0)).toISOString(), hostVersion: "studio",
            packageVersion: version, payloadSha256: createHash("sha256").update(`${id}:${this.revision}`).digest("hex"),
          };
          this.releases.unshift(release);
          const fact = this.publishFact(release);
          this.pushLog(`published ${version}`);
          resolve(ok({
            status: this.status(),
            manifest: { keyId: KEY_ID, signature: "c2lnbmF0dXJl", payloadBase64Bytes: 1234 },
            manifestUrl: fact.manifestUrl, hostConfigUrl: fact.hostConfigUrl, appConfigUrl: `${ORIGIN}/${release.slot}/pocket/studio/pocket.alpha/latest.json`,
            updateUrl: fact.updateUrl, archiveUrl: "/releases/alpha-app.tar.gz", packages: fact.packages,
          }));
        }, this.publishDelayMs));
      }
      case "studio.publish.history": {
        const slots = (["test", "stable"] as const).map((name) => {
          const cur = this.current(name);
          return cur
            ? { name, version: cur.version, build: cur.build, releaseId: cur.releaseId, archiveUrl: `/releases/alpha-app/${cur.releaseId}.tar.gz`, packages: [{ id: "pocket.alpha", version: cur.version, build: cur.build, manifestUrl: `${ORIGIN}/${name}/pocket/studio/pocket.alpha/${cur.packageVersion}/latest.json`, hostConfigUrl: `${ORIGIN}/${name}/pocket/studio/pocket.alpha/${cur.packageVersion}/host.json` }] }
            : { name, releaseId: null, packages: [] };
        });
        return ok({
          origin: ORIGIN, hostVersion: "studio", packageVersion: "0.1.0", packageVersionSource: "config", hostVersionSource: "flag", lan: false,
          slots, current: {},
          history: this.releases.map((r) => ({
            id: r.id, releaseId: r.releaseId, slot: r.slot, channel: r.channel, version: r.version, build: r.build, revision: r.revision, publishedAt: r.publishedAt,
            hostVersion: r.hostVersion, packageVersion: r.packageVersion, payloadSha256: r.payloadSha256, compatVersion: "0.1.0", routeVersion: r.version,
            archiveUrl: `/releases/alpha-app/${r.releaseId}.tar.gz`, appConfigUrl: `${ORIGIN}/pocket/studio/pocket.alpha/${r.releaseId}/host.json`,
            packages: [{ id: "pocket.alpha", version: r.version, build: r.build, updateUrl: "", manifestUrl: `${ORIGIN}/${r.slot}/pocket/studio/pocket.alpha/${r.packageVersion}/latest.json`, hostConfigUrl: `${ORIGIN}/${r.slot}/pocket/studio/pocket.alpha/${r.packageVersion}/host.json` }],
            reusedPackages: [],
          })),
          ...(this.releases[0] ? { appConfigUrl: `${ORIGIN}/${this.releases[0].slot}/pocket/studio/pocket.alpha/latest.json` } : {}),
        });
      }
      case "studio.publish.offline":
        if (!this.built()) return err("conflict", "build the current source before publishing (HTTP 409)");
        return ok({ archiveUrl: "/releases/alpha-app/alpha-app-offline-1.tar.gz", filename: "alpha-app-offline-1.tar.gz" });
      case "studio.artifacts.list":
        return ok({ revision: this.revision, builtRevision: this.builtRevision, artifacts: this.builtRevision === null ? undefined : (this.status() as any).artifacts });
      case "studio.artifacts.inspect": {
        if (this.builtRevision === null) return err("not_found", "artifact not available; build first (HTTP 404)");
        const text = (value: unknown) => { const data = JSON.stringify(value, null, 2); return ok({ name: p.name, bytes: data.length, encoding: "utf8", truncated: false, data }); };
        switch (p.name) {
          case "app.qjbc": return ok({ name: p.name, bytes: 526_140, encoding: "binary" });
          case "app.pak": return ok({ name: p.name, bytes: 25_232, encoding: "binary" });
          case "app.js": return ok({ name: p.name, bytes: 60, encoding: "utf8", truncated: false, data: "// bundled\nexport const APP_JS_MARKER = 1;\n" });
          case "app.bytecode.json": return text({ bindingGeneration: 12, bytecodeBytes: 526140, engineAbi: "5ab2246b", entryFormat: "quickjs-bytecode", payloadSha256: "d34a59a9844b77f0c266d6b79457c97e4055472ef2199016b880db159973f71f", sourceSha256: "2a60b435a77fecee7a03e04ea032cf0e2a4b32e77cb764a91789c0f60c3488a1", runtimeAbi: RUNTIME_ABI, tickHz: 60, version: "0.1.0", build: 1 });
          case "guest-manifest.json": return text({ protocolVersion: 1, capabilities: { requires: ["text.layout.native"], optional: ["studio.fs.read", "clipboard.writeText"] }, permissions: { optional: ["studio.read"] }, memory: { heapLimitBytes: 268435456, maxPakBytes: 33554432 }, version: "0.1.0", build: 1 });
          case "build.json": return text({ generation: "gen-1", id: "alpha-app", revision: this.builtRevision, appId: "pocket.alpha", version: "0.1.0", build: 1, tickHz: 60, entryFormat: "quickjs-bytecode", runtimeAbi: RUNTIME_ABI, resources: { snapshot: "resources.json", packages: [{ id: "pocket.alpha", artifactDirectory: ".", version: "0.1.0", build: 1 }] }, generatedAt: "2026-11-13T10:00:00.000Z" });
          case "resources.json": return text(this.resources);
          default: return err("not_found", "artifact not available; build first (HTTP 404)");
        }
      }
      default: return undefined;
    }
  }

  private pushLog(line: string): void { this.logs.push(line); this.push("studio.build.events", [{ type: "log", line }]); }
}
