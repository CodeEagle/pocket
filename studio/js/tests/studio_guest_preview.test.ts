import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, tapText, typeInEditor } from "./helpers.ts";
import { SETTINGS_KEY } from "../src/state/settings.ts";

// M3 on the real native probe: console and diagnostics, the preview child
// flow (build -> publish -> destroy/create without cacheFirst -> first frame),
// auto-build on save, deploy, and settings. The System host and the studio.*
// provider are the stateful fake; the real service + real child are covered by
// studio/test/studio_host_test.dart.

const seedSettings = (autoBuild: boolean) => (fake: { storage: Map<string, unknown> }) =>
  fake.storage.set(SETTINGS_KEY, { autoBuild, debounceMs: 300, dockPreview: true, editor: "input" });

test("console: build start streams logs; a failed build lists diagnostics that open the file at the line", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "控制台", 0);
    frame = await session.until((f) => has(f, "开始构建"), "console page");
    await tapText(session, frame, "开始构建");
    frame = await session.until((f) => has(f, "build: ok") && has(f, "已构建（最新）"), "successful build in the log", 200);
    assert.ok(has(frame, "build: start"));
    assert.equal(fake.calls("studio.build.start").length, 1);
    assert.deepEqual(fake.calls("studio.build.start")[0]!.params, { project: "alpha-app" });

    fake.buildMode = "fail";
    fake.mutate(); // the source changed
    frame = await session.frame();
    await tapText(session, frame, "开始构建");
    frame = await session.until((f) => has(f, "app.tsx:3:5  Unterminated JSX contents."), "diagnostic listed", 200);
    assert.ok(has(frame, "诊断（1）"), textOf(frame));
    assert.ok(has(frame, "失败"));

    await tapText(session, frame, "app.tsx:3:5  Unterminated JSX contents.");
    frame = await session.until((f) => has(f, "第 3 行，第 5 列"), "jump banner in the editor", 200);
    assert.ok(has(frame, "源码 · alpha-app"), "navigated to the source page");
    assert.ok(has(frame, "app.tsx · "), "the file is open in a tab");
    assert.ok(has(frame, "Unterminated JSX contents."));
    assert.equal(fake.calls("studio.fs.read").filter((r) => r.params.path === "app.tsx").length, 1);
  } finally { session.kill(); }
}, 120_000);

test("console: gap markers, cancel, and the build stream reconnects with backoff", async () => {
  const { fake, session } = await boot((f) => { f.buildDelayMs = 3000; });
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "控制台", 0);
    frame = await session.until((f) => has(f, "开始构建"), "console");
    await tapText(session, frame, "开始构建");
    frame = await session.until((f) => has(f, "build: start") && has(f, "构建中"), "running");
    const statusCalls = fake.calls("studio.build.status").length;
    fake.push("studio.build.events", [{ type: "gap", dropped: 7 }]);
    frame = await session.until((f) => has(f, "已丢失 7 条日志"), "gap marker");
    await session.settle(5);
    assert.ok(fake.calls("studio.build.status").length > statusCalls, "a gap forces an authoritative status read");

    await tapText(session, frame, "取消", 0);
    await session.until(() => fake.calls("studio.build.cancel").length === 1, "cancel request");

    const first = fake.openStreams("studio.build.events");
    assert.equal(first.length, 1);
    fake.drop("studio.build.events");
    await session.until((f) => has(f, "事件流重连中"), "retrying indicator");
    await session.until(() => fake.openStreams("studio.build.events").length === 1, "stream reopened", 300);
    assert.notEqual(fake.openStreams("studio.build.events")[0], first[0]);
  } finally { session.kill(); }
}, 120_000);

test("preview: build -> publish -> destroy/create (prepareForOpen, no cacheFirst) -> first frame; a reload replaces the child", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "预览", 0);
    frame = await session.until((f) => has(f, "构建并刷新预览"), "preview page");
    assert.ok(has(frame, "尚未运行预览"));
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until((f) => has(f, "运行中") && fake.calls("studio.preview.publish").length === 1, "running", 300);

    const order = fake.requests.map((r) => r.capability).filter((c) => /^(studio\.build\.start|studio\.preview\.publish|system\.runtime\.(create|destroy|awaitFirstFrame))$/.test(c));
    assert.deepEqual(order, ["studio.build.start", "studio.preview.publish", "system.runtime.create", "system.runtime.awaitFirstFrame"]);
    const create = fake.calls("system.runtime.create")[0]!.params;
    assert.deepEqual(create, { appId: "dev.pocket.studio.preview", prepareForOpen: true }, "strict check-before-entry: no cacheFirst");
    assert.deepEqual(fake.calls("system.runtime.awaitFirstFrame")[0]!.params, { instanceId: "pocket-app-1", generation: 1 });
    assert.ok(has(frame, "0.1.0-preview.2"), "the published preview version is shown");
    assert.ok(has(frame, "上次耗时"));
    // The preview child is composited by an application surface op for its registered handle.
    const surface = (frame.ops ?? []).find((o) => o.type !== "text" && (o as any).package === "dev.pocket.studio.preview" || (o as any).type === "application" || (o as any).type === "hostSurface");
    assert.ok(surface, `no compositor surface op among ${[...new Set((frame.ops ?? []).map((o) => o.type))]}`);

    // Reload: the previous child is destroyed before the new one is created.
    fake.mutate();
    await tapText(session, frame, "构建并刷新预览");
    await session.until(() => fake.calls("system.runtime.create").length === 2 && fake.calls("system.runtime.awaitFirstFrame").length === 2, "second reload", 300);
    const seq = fake.requests.map((r) => r.capability).filter((c) => c.startsWith("system.runtime.") && /create|destroy/.test(c));
    assert.deepEqual(seq, ["system.runtime.create", "system.runtime.destroy", "system.runtime.create"]);
    assert.deepEqual(fake.calls("system.runtime.destroy")[0]!.params, { instanceId: "pocket-app-1" });
    frame = await session.until((f) => has(f, "0.1.0-preview.3"), "version of the second reload");
  } finally { session.kill(); }
}, 120_000);

test("preview: build failure, publish failure and child-creation failure are shown, never faked", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "预览", 0);
    frame = await session.until((f) => has(f, "构建并刷新预览"), "preview page");

    fake.buildMode = "fail";
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until((f) => has(f, "构建失败，请在控制台查看诊断信息"), "build failure", 300);
    assert.ok(has(frame, "出错"));
    assert.equal(fake.calls("studio.preview.publish").length, 0, "a failed build never publishes");
    assert.equal(fake.calls("system.runtime.create").length, 0);
    await session.settle(30);

    fake.buildMode = "ok";
    fake.failPublish = { ok: false, error: { code: "conflict", message: "another preview publish is using this slot (HTTP 409)" } };
    frame = await session.frame();
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until((f) => has(f, "发布预览失败") && has(f, "another preview publish"), "publish failure", 300);
    assert.equal(fake.calls("system.runtime.create").length, 0);
    await session.settle(30);

    fake.failPublish = undefined;
    fake.failCreate = { ok: false, error: { code: "update_rejected", message: "manifest-signature: signature does not verify" } };
    frame = await session.frame();
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until((f) => has(f, "预览加载失败") && has(f, "manifest-signature"), "child creation failure", 300);
    assert.ok(!has(frame, "运行中"));
  } finally { session.kill(); }
}, 120_000);

test("auto-build on save: edit + save -> build -> publish -> reload with no further input; rapid saves coalesce", async () => {
  const { fake, session } = await boot(seedSettings(true));
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "export const V1 = 1;\n");
    frame = await session.until((f) => has(f, "app.tsx ●"), "dirty");
    assert.equal(fake.calls("studio.build.start").length, 0, "nothing builds before a save");
    await tapText(session, frame, /^保存/);
    frame = await session.until((f) => has(f, "已保存 app.tsx"), "saved");
    assert.equal(fake.calls("studio.build.start").length, 0, "the build waits for the debounce");
    frame = await session.until(() => fake.calls("system.runtime.awaitFirstFrame").length === 1, "automatic reload", 400);
    assert.equal(fake.calls("studio.build.start").length, 1);
    assert.equal(fake.calls("studio.preview.publish").length, 1);
    assert.equal(fake.calls("system.runtime.create").length, 1);
    frame = await session.until((f) => has(f, "预览：运行中"), "docked preview status");

    // A second save within the debounce window and a third later coalesce into ONE more cycle.
    frame = await typeInEditor(session, frame, /V1/, "export const V2 = 2;\n");
    await session.until((f) => has(f, "app.tsx ●"), "dirty 2");
    frame = await session.frame();
    await tapText(session, frame, /^保存/);
    await session.until((f) => has(f, "已保存 app.tsx"), "saved 2");
    await session.until(() => fake.calls("system.runtime.awaitFirstFrame").length === 2, "second automatic reload", 400);
    assert.equal(fake.calls("studio.build.start").length, 2);
    assert.deepEqual(fake.calls("system.runtime.destroy").map((r) => r.params.instanceId), ["pocket-app-1"]);
    assert.equal(fake.files.get("app.tsx"), "export const V2 = 2;\n");
  } finally { session.kill(); }
}, 120_000);

test("auto-build off: saving does not build", async () => {
  const { fake, session } = await boot(seedSettings(false));
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    frame = await typeInEditor(session, frame, /MARKER_APP_TSX/, "export const Q = 1;\n");
    await session.until((f) => has(f, "app.tsx ●"), "dirty");
    frame = await session.frame();
    await tapText(session, frame, /^保存/);
    await session.until((f) => has(f, "已保存 app.tsx"), "saved");
    await session.settle(100);
    assert.equal(fake.calls("studio.build.start").length, 0);
    assert.ok(has(await session.frame(), "手动构建"));
  } finally { session.kill(); }
}, 60_000);

test("settings: values load from storage, a toggle persists through system.storage, an unavailable store is reported", async () => {
  const { fake, session } = await boot(seedSettings(true));
  try {
    let frame = await openAlpha(session);
    assert.ok(has(frame, "保存后自动构建"), "autoBuild was read from storage");
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "保存后自动构建并刷新预览"), "settings page");
    assert.ok(has(frame, "设置已保存到本机。"));
    await tapText(session, frame, "保存后自动构建并刷新预览");
    await session.until(() => (fake.storage.get(SETTINGS_KEY) as any)?.autoBuild === false, "autoBuild persisted as off");
    assert.deepEqual((fake.storage.get(SETTINGS_KEY) as any).debounceMs, 300);
    assert.ok(fake.calls("system.storage.set").every((r) => r.params.appId === "dev.pocket.studio"), "scoped to the Studio app id");
  } finally { session.kill(); }

  const unavailable = await boot((f) => { f.storageAvailable = false; });
  try {
    let frame = await unavailable.session.until((f) => has(f, "Alpha 应用"), "list");
    await tapText(unavailable.session, frame, "设置", 0);
    frame = await unavailable.session.until((f) => has(f, "设置存储不可用"), "unavailable notice");
    await tapText(unavailable.session, frame, "保存后自动构建并刷新预览");
    frame = await unavailable.session.until((f) => has(f, "设置仅在本次会话生效"), "session-only warning");
  } finally { unavailable.session.kill(); }
}, 120_000);

test("deploy: devices list, select, deploy builds first, polls the job, shows the log and cancels", async () => {
  const { fake, session } = await boot((f) => {
    f.devices = [
      { id: "sim-1", name: "iPhone 15 Pro", platform: "ios", emulator: true, supported: true },
      { id: "dev-2", name: "Pixel 8", platform: "android", emulator: false, supported: false },
    ];
  });
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "预览", 0);
    frame = await session.until((f) => has(f, "刷新设备"), "preview page");
    assert.ok(has(frame, "点击“刷新设备”以发现目标。"));
    await tapText(session, frame, "刷新设备");
    frame = await session.until((f) => has(f, "iPhone 15 Pro") && has(f, "Pixel 8"), "devices");
    assert.ok(has(frame, "ios · 模拟器") && has(frame, "android · 已连接设备 · 不支持"));

    await tapText(session, frame, /^部署$/);
    frame = await session.until((f) => has(f, "部署：排队中"), "job queued", 400);
    assert.equal(fake.calls("studio.build.start").length, 1, "deploy builds the current source first");
    assert.deepEqual(fake.calls("studio.preview.deploy")[0]!.params, { project: "alpha-app", deviceId: "sim-1" });
    frame = await session.until((f) => has(f, "部署：运行中") && has(f, "app is running"), "job running with log", 600);
    assert.ok(fake.calls("studio.preview.deployStatus").length >= 2);
    const before = fake.calls("studio.preview.deployStatus").length;
    await session.settle(200);
    assert.equal(fake.calls("studio.preview.deployStatus").length, before, "polling stops once the job is running");
  } finally { session.kill(); }
}, 180_000);
