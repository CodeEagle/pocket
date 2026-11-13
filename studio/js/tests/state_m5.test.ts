import { describe, expect, test } from "bun:test";
import { createManualTimers } from "../src/state/env.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createDialogs } from "../src/state/dialogs.ts";
import { createPublish, toPublishInfo } from "../src/state/publish.ts";
import { createArtifacts, toPackageContents } from "../src/state/artifacts.ts";
import { toVersions, createVersions } from "../src/state/versions.ts";
import { createCopier } from "../src/state/copy.ts";
import { absoluteUrl, formatBytes, originOf, shortHash } from "../src/lib/format.ts";
import { StudioError, type StudioClient } from "../src/studio-client.ts";
import { flush } from "./fake_client.ts";

const ORIGIN = "http://127.0.0.1:8795";
const publishResult = {
  status: { publish: { keyId: "k1", runtimeAbi: "abi-1", payloadSha256: "a".repeat(64), version: "1.0.0-test.2", build: 2, channel: "test", revision: 4, releaseId: "r-2", publishedAt: "2026-11-13T10:00:00.000Z", packages: [{ id: "pocket.app", version: "1.0.0-test.2", build: 2, manifestUrl: `${ORIGIN}/m`, hostConfigUrl: `${ORIGIN}/h` }] } },
  manifest: { keyId: "k1", signature: "sig", payloadBase64Bytes: 10 },
  manifestUrl: `${ORIGIN}/test/pocket/h/pocket.app/1.0.0-test.2/latest.json`,
  hostConfigUrl: `${ORIGIN}/test/pocket/h/pocket.app/1.0.0-test.2/host.json`,
  archiveUrl: "/releases/p.tar.gz",
};

function publishHarness(opts: { dirty?: boolean; status?: Record<string, unknown>; confirm?: boolean; publishError?: StudioError } = {}) {
  const calls: string[] = [];
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const status = { revision: 3, builtRevision: 3, busy: false, ...opts.status };
  const client = {
    publish: {
      plan: async (p: string, c: string) => { calls.push(`plan:${p}:${c}`); return { targets: [{ kind: "root", appId: "pocket.app", title: "App", version: "1.0.0", build: 2, built: true, canPublish: true }] }; },
      publish: async (p: string, c: string) => { calls.push(`publish:${p}:${c}`); if (opts.publishError) throw opts.publishError; return publishResult; },
      history: async () => ({ origin: ORIGIN }),
      offline: async (p: string) => { calls.push(`offline:${p}`); return { archiveUrl: "/releases/o.tar.gz", filename: "o.tar.gz" }; },
    },
    build: { status: async () => ({ ...status, logs: [] }) },
  } as unknown as StudioClient;
  const build = { refresh: async () => {}, state: () => ({ status }) } as any;
  let published = 0;
  const pub = createPublish({ client, timers, toasts, dialogs, build, project: () => "p1", hasUnsavedEdits: () => opts.dirty === true, onPublished: () => { published += 1; } });
  const confirms: string[] = [];
  dialogs.store.subscribe(() => {
    const d = dialogs.active();
    if (d) { confirms.push(d.title); queueMicrotask(() => (opts.confirm ? dialogs.confirmActive() : dialogs.cancel())); }
  });
  return { pub, calls, toasts, dialogs, confirms, published: () => published };
}

describe("publish", () => {
  test("toPublishInfo reads the public facts and makes the archive link absolute", () => {
    const info = toPublishInfo(publishResult)!;
    expect(info).toMatchObject({ channel: "test", version: "1.0.0-test.2", build: 2, keyId: "k1", runtimeAbi: "abi-1", payloadSha256: "a".repeat(64), revision: 4, releaseId: "r-2" });
    expect(info.manifestUrl).toContain("/latest.json");
    expect(info.hostConfigUrl).toContain("/host.json");
    expect(info.archiveUrl).toBe(`${ORIGIN}/releases/p.tar.gz`);
    expect(info.packages).toHaveLength(1);
    // The signed envelope (payload/signature) is not part of the guest's model.
    expect(JSON.stringify(info)).not.toContain("sig");
    expect(toPublishInfo(null)).toBeUndefined();
    expect(toPublishInfo({ status: { revision: 1 } })).toBeUndefined();
  });

  test("a test publish needs no confirmation and records the facts", async () => {
    const h = publishHarness();
    await h.pub.enter();
    await h.pub.publish();
    expect(h.calls).toContain("publish:p1:test");
    expect(h.confirms).toEqual([]);
    expect(h.pub.state().phase).toBe("done");
    expect(h.pub.state().fresh).toBe(true);
    expect(h.pub.state().info?.keyId).toBe("k1");
    expect(h.published()).toBe(1);
  });

  test("a release publish asks first; declining publishes nothing", async () => {
    const declined = publishHarness({ confirm: false });
    await declined.pub.enter();
    await declined.pub.setChannel("release");
    await declined.pub.publish();
    expect(declined.confirms).toEqual(["发布稳定版？"]);
    expect(declined.calls.some((c) => c.startsWith("publish:"))).toBe(false);
    expect(declined.pub.state().phase).toBe("idle");

    const accepted = publishHarness({ confirm: true });
    await accepted.pub.enter();
    await accepted.pub.setChannel("release");
    await accepted.pub.publish();
    expect(accepted.calls).toContain("publish:p1:release");
    expect(accepted.pub.state().phase).toBe("done");
  });

  test("unsaved edits and a stale or running build stop the publish before any request", async () => {
    const dirty = publishHarness({ dirty: true });
    await dirty.pub.publish();
    expect(dirty.calls).toEqual([]);
    expect(dirty.pub.state().phase).toBe("error");
    const stale = publishHarness({ status: { revision: 5, builtRevision: 3 } });
    await stale.pub.publish();
    expect(stale.calls.some((c) => c.startsWith("publish:"))).toBe(false);
    expect(stale.pub.state().error).toContain("先构建");
    const failed = publishHarness({ status: { error: "SyntaxError" } });
    await failed.pub.publish();
    expect(failed.calls.some((c) => c.startsWith("publish:"))).toBe(false);
    const busy = publishHarness({ status: { busy: true } });
    await busy.pub.publish();
    expect(busy.pub.state().error).toContain("构建仍在进行");
  });

  test("a service error is shown, never a success; a timeout asks to check the versions page", async () => {
    const h = publishHarness({ publishError: new StudioError("studio.publish.publish", "conflict", "slot is owned by project x (HTTP 409)") });
    await h.pub.publish();
    expect(h.pub.state().phase).toBe("error");
    expect(h.pub.state().error).toContain("slot is owned by project x");
    expect(h.pub.state().info).toBeUndefined();
    expect(h.toasts.items().some((t) => t.tone === "danger")).toBe(true);
    const t = publishHarness({ publishError: new StudioError("studio.publish.publish", "service_timeout", "timed out") });
    await t.pub.publish();
    expect(t.pub.state().error).toContain("请到“版本”页确认");
    expect(t.published()).toBe(1); // the version list is refreshed: the service may have finished
  });

  test("a project switch drops a late publish result", async () => {
    const h = publishHarness();
    const running = h.pub.publish();
    h.pub.reset();
    await running;
    await flush();
    expect(h.pub.state().info).toBeUndefined();
    expect(h.pub.state().phase).toBe("idle");
  });

  test("a plan fetched while the service was finishing a build is re-read until it agrees with the build", async () => {
    const timers = createManualTimers();
    let serviceBusy = true;
    let plans = 0;
    const client = { publish: { plan: async () => { plans += 1; return { targets: [{ kind: "root", appId: "a", title: "A", built: !serviceBusy, busy: serviceBusy, canPublish: !serviceBusy }] }; } } } as unknown as StudioClient;
    const build = { state: () => ({ busy: false, status: { revision: 1, builtRevision: 1 } }), refresh: async () => {} } as any;
    const pub = createPublish({ client, timers, toasts: createToasts(timers), dialogs: createDialogs(), build, project: () => "p", hasUnsavedEdits: () => false });
    await pub.loadPlan();
    expect(pub.state().targets[0].busy).toBe(true);
    serviceBusy = false;
    timers.advance(1100);
    await flush();
    expect(plans).toBe(2);
    expect(pub.state().targets[0]).toMatchObject({ built: true, canPublish: true });
    timers.advance(5000);
    await flush();
    expect(plans).toBe(2); // agreed: no more polling
  });

  test("offline package resolves the service origin for the relative archive URL", async () => {
    const h = publishHarness();
    await h.pub.makeOffline();
    expect(h.pub.state().offline).toEqual({ phase: "done", filename: "o.tar.gz", archiveUrl: `${ORIGIN}/releases/o.tar.gz` });
  });
});

describe("artifacts", () => {
  const text = (value: unknown, extra: Record<string, unknown> = {}) => { const data = JSON.stringify(value); return { name: "x", bytes: data.length, encoding: "utf8" as const, data, truncated: false, ...extra }; };
  function harness(opts: { built?: boolean; resources?: unknown; truncatedResources?: boolean } = {}) {
    const inspected: string[] = [];
    const client = {
      artifacts: {
        list: async () => opts.built === false ? { revision: 2, builtRevision: null } : { revision: 2, builtRevision: 2, artifacts: { appJs: "/a", bytecode: "/b", metadata: "/m", pak: "/p", manifest: "/g", build: "/bj" } },
        inspect: async (_p: string, name: string) => {
          inspected.push(name);
          switch (name) {
            case "app.qjbc": return { name, bytes: 100, encoding: "binary" as const };
            case "app.pak": throw new StudioError("studio.artifacts.inspect", "too_large", "response too large");
            case "app.bytecode.json": return text({ runtimeAbi: "abi", bindingGeneration: 12, entryFormat: "quickjs-bytecode", tickHz: 60, payloadSha256: "p".repeat(64), bytecodeBytes: 10 });
            case "guest-manifest.json": return text({ protocolVersion: 1, capabilities: { requires: ["a"], optional: ["b", "c"] }, permissions: { optional: ["studio.read"] }, memory: { heapLimitBytes: 1024 } });
            case "build.json": return text({ generation: "g", revision: 2, appId: "pocket.app", resources: { packages: [{ id: "pocket.app", version: "1", build: 1 }] } });
            case "resources.json":
              if (opts.truncatedResources) return { name, bytes: 999999, encoding: "utf8" as const, data: "{\"packages\":[", truncated: true };
              if (opts.resources === undefined) throw new StudioError("studio.artifacts.inspect", "not_found", "artifact not available (HTTP 404)");
              return text(opts.resources);
            default: return { name, bytes: 5, encoding: "utf8" as const, data: "x", truncated: false };
          }
        },
      },
    } as unknown as StudioClient;
    const toasts = createToasts(createManualTimers());
    return { a: createArtifacts({ client, toasts, project: () => "p1" }), inspected, toasts };
  }

  test("an unbuilt project lists nothing and inspects nothing", async () => {
    const h = harness({ built: false });
    await h.a.refresh();
    expect(h.a.state()).toMatchObject({ loaded: true, built: false, files: [] });
    expect(h.inspected).toEqual([]);
  });

  test("a built project: metadata, manifest, pack summary, build info; app.js only on demand; big binaries stay available", async () => {
    const resources = { packages: [{ id: "pocket.app", title: "App", version: "1", build: 1, resources: [{ key: "pak:a", kind: "pak", bytes: 10, placement: "pak" }, { key: "asset:b.png", kind: "asset", bytes: 20, placement: "pak" }, { key: "asset:c.mp4", kind: "asset", bytes: 1000, placement: "network" }] }] };
    const h = harness({ resources });
    await h.a.refresh();
    const s = h.a.state();
    expect(s.bytecode).toMatchObject({ runtimeAbi: "abi", bindingGeneration: 12, entryFormat: "quickjs-bytecode", tickHz: 60, bytecodeBytes: 10 });
    expect(s.manifest).toMatchObject({ requires: ["a"], optional: ["b", "c"], permissionsOptional: ["studio.read"], memory: { heapLimitBytes: 1024 } });
    expect(s.packages).toEqual([{ id: "pocket.app", title: "App", version: "1", build: 1, total: 3, totalBytes: 1030, inPak: 2, inPakBytes: 30, network: 1, networkBytes: 1000, assets: 2 }]);
    expect(s.buildInfo).toMatchObject({ generation: "g", appId: "pocket.app" });
    expect(h.inspected).not.toContain("app.js");
    const files = Object.fromEntries(s.files.map((f) => [f.name, f]));
    expect(files["app.qjbc"]).toMatchObject({ bytes: 100, available: true });
    expect(files["app.pak"]).toMatchObject({ available: true }); // bigger than the provider's response cap, still exists
    expect(files["app.js"]).toMatchObject({ lazy: true, available: true });
    await h.a.select("app.js");
    expect(h.a.state().selected).toMatchObject({ name: "app.js", text: "x" });
    await h.a.select("app.qjbc");
    expect(h.a.state().selected?.text).toBeUndefined(); // binaries: metadata only
    expect(h.a.state().selected?.bytes).toBe(100);
  });

  test("a missing or oversized resource snapshot is reported, not invented", async () => {
    const missing = harness();
    await missing.a.refresh();
    expect(missing.a.state().packages).toEqual([]);
    expect(missing.a.state().packNote).toContain("没有资源快照");
    const big = harness({ truncatedResources: true });
    await big.a.refresh();
    expect(big.a.state().packNote).toContain("超过 128 KiB");
  });

  test("toPackageContents counts placement and asset kinds", () => {
    expect(toPackageContents({ packages: [{ id: "x", resources: [] }, { nope: 1 }] })).toEqual([{ id: "x", total: 0, totalBytes: 0, inPak: 0, inPakBytes: 0, network: 0, networkBytes: 0, assets: 0 }]);
  });
});

describe("versions", () => {
  const snapshot = {
    origin: ORIGIN, hostVersion: "studio", packageVersion: "0.1.0", lan: true,
    slots: [
      { name: "test", version: "0.1.0-test.2", build: 2, releaseId: "r2", archiveUrl: "/releases/p/r2.tar.gz", packages: [{ id: "pocket.app", version: "0.1.0-test.2", build: 2, manifestUrl: `${ORIGIN}/m` }], reusedPackages: [{ id: "pocket.child", version: "1", build: 3, ownerProjectId: "child" }] },
      { name: "stable", releaseId: null, packages: [] },
    ],
    history: [
      { id: "r2", releaseId: "r2", slot: "test", channel: "test", version: "0.1.0-test.2", build: 2, revision: 5, publishedAt: "2026-11-13T10:02:00.000Z", payloadSha256: "b".repeat(64), archiveUrl: "/releases/p/r2.tar.gz", packages: [] },
      { id: "r1", releaseId: "r1", slot: "test", channel: "test", version: "0.1.0-test.1", build: 1, packages: [] },
      { nope: true },
    ],
    appConfigUrl: `${ORIGIN}/test/pocket/studio/pocket.app/latest.json`,
  };

  test("slots, history and absolute archive links; unknown rows are dropped, no trial state is invented", () => {
    const v = toVersions(snapshot);
    expect(v.lan).toBe(true);
    expect(v.slots.map((s) => s.name)).toEqual(["test", "stable"]);
    expect(v.slots[0]).toMatchObject({ version: "0.1.0-test.2", build: 2, archiveUrl: `${ORIGIN}/releases/p/r2.tar.gz` });
    expect(v.slots[0].reusedPackages[0]).toMatchObject({ id: "pocket.child", ownerProjectId: "child" });
    expect(v.slots[1].version).toBeUndefined();
    expect(v.history.map((e) => e.id)).toEqual(["r2", "r1"]);
    expect(v.history[0].archiveUrl).toBe(`${ORIGIN}/releases/p/r2.tar.gz`);
    expect(JSON.stringify(v)).not.toMatch(/trial|promot|rollback/i);
    expect(toVersions(undefined)).toMatchObject({ slots: [], history: [], lan: false });
  });

  test("refresh, selection toggle, error and project switch", async () => {
    let fail = false;
    const client = { publish: { history: async () => { if (fail) throw new StudioError("studio.publish.history", "service_unreachable", "down"); return snapshot; } } } as unknown as StudioClient;
    const toasts = createToasts(createManualTimers());
    const v = createVersions({ client, toasts, project: () => "p1" });
    await v.refresh();
    expect(v.state().history).toHaveLength(2);
    v.select("r2");
    expect(v.state().selected).toBe("r2");
    v.select("r2");
    expect(v.state().selected).toBeUndefined();
    v.select("r1");
    await v.refresh();
    expect(v.state().selected).toBe("r1");
    fail = true;
    await v.refresh();
    expect(v.state().error).toContain("down");
    expect(toasts.items().some((t) => t.message.includes("读取版本记录失败"))).toBe(true);
    v.reset();
    expect(v.state()).toMatchObject({ loaded: false, history: [] });
  });
});

describe("copy and formatting", () => {
  test("copy reports a missing or failing clipboard and a success", async () => {
    const toasts = createToasts(createManualTimers());
    expect(await createCopier({ toasts })("x", "哈希")).toBe(false);
    expect(toasts.items().at(-1)!.message).toContain("剪贴板不可用");
    const written: string[] = [];
    expect(await createCopier({ toasts, clipboard: { writeText: async (t) => { written.push(t); } } })("abc", "哈希")).toBe(true);
    expect(written).toEqual(["abc"]);
    expect(toasts.items().at(-1)!.message).toBe("已复制哈希");
    expect(await createCopier({ toasts, clipboard: { writeText: async () => { throw new StudioError("clipboard.writeText", "plugin_permission_denied", "denied"); } } })("abc", "哈希")).toBe(false);
    expect(toasts.items().at(-1)!.message).toContain("denied");
  });

  test("format helpers", () => {
    expect(formatBytes(10)).toBe("10 字节");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(shortHash("a".repeat(64), 6, 4)).toBe("aaaaaa…aaaa");
    expect(shortHash("short")).toBe("short");
    expect(originOf(`${ORIGIN}/x/y`)).toBe(ORIGIN);
    expect(absoluteUrl("/r/x.tar.gz", ORIGIN)).toBe(`${ORIGIN}/r/x.tar.gz`);
    expect(absoluteUrl("https://h/x", ORIGIN)).toBe("https://h/x");
    expect(absoluteUrl("/r", undefined)).toBe("/r");
  });
});
