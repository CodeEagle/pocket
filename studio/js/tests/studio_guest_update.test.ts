import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf } from "./probe_session.ts";
import { boot, has, openAlpha, tapText } from "./helpers.ts";

// M6 on the real native probe: the Settings page drives the SDK's guest-controlled refresh client
// (`updates.status` / `updates.check` / `updates.apply`) against a fake host. The real signed download, health
// trial and rollback run in studio/test/studio_self_update_test.dart.

test("settings: shows host update facts, checks, finds a higher signed build and applies it with a UI handoff", async () => {
  const { fake, session } = await boot((f) => { f.updates.available = { version: "0.1.0-test.2", build: 2 }; });
  try {
    let frame = await openAlpha(session);
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "Studio 更新") && has(f, "v0.1.0 · 构建 1"), "update panel with the host's active version");
    assert.ok(has(frame, "检查 Studio 更新"));
    assert.ok(!has(frame, "应用更新"), "apply is hidden until a check found an update");
    assert.equal(fake.calls("updates.check").length, 0, "opening the page never checks the network");

    await tapText(session, frame, "检查 Studio 更新");
    frame = await session.until((f) => has(f, "v0.1.0-test.2 · 构建 2") && has(f, "应用更新"), "available update", 200);
    assert.deepEqual(fake.calls("updates.check")[0]!.params, { mode: "granular", scope: "all" });
    assert.equal(fake.calls("updates.apply").length, 0);

    await tapText(session, frame, "应用更新");
    frame = await session.until((f) => has(f, "正在应用更新"), "applying", 200);
    await session.until(() => fake.calls("updates.apply").length === 1, "apply request", 200);
    assert.deepEqual(fake.calls("updates.apply")[0]!.params, { expectedVersion: "0.1.0-test.2", expectedBuild: 2 });
    // The handoff was checkpointed in the app's private platform storage before apply: page + open project only.
    const record = fake.storage.get("platform:studio.update-state") as any;
    assert.ok(record, "state handoff stored before apply");
    assert.equal(record.schema, "studio-ui/1");
    assert.equal(record.targetVersion, "0.1.0-test.2");
    assert.equal(record.targetBuild, 2);
    assert.deepEqual(record.value, { page: "settings", project: "alpha-app" });
  } finally { session.kill(); }
}, 120_000);

test("settings: an up-to-date host, a failed check and a rolled-back build are reported honestly", async () => {
  const { fake, session } = await boot((f) => { f.updates.lastError = "Guest did not produce its first frame within 15 seconds"; f.updates.activeVersion = "0.1.0-test.2"; f.updates.activeBuild = 2; });
  try {
    let frame = await session.until((f) => has(f, "Alpha 应用"), "projects");
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "上次更新失败（已回滚到可用版本）"), "rollback error shown", 200);
    assert.ok(has(frame, "first frame within 15 seconds"));
    assert.ok(has(frame, "v0.1.0-test.2 · 构建 2"));

    await tapText(session, frame, "检查 Studio 更新");
    frame = await session.until((f) => has(f, "已是最新版本"), "no newer build", 200);
    assert.ok(!has(frame, "应用更新"));

    fake.updates.failCheck = { ok: false, error: { code: "manifest-signature", message: "signature invalid" } };
    await tapText(session, frame, "检查 Studio 更新");
    frame = await session.until((f) => has(f, "manifest-signature: signature invalid"), "check failure shown", 200);
    assert.ok(!has(frame, "应用更新"));
  } finally { session.kill(); }
}, 120_000);

test("settings: a host without update configuration says so and disables the check", async () => {
  const { session } = await boot((f) => { f.updates.configured = false; f.updates.stage = "not_configured"; });
  try {
    let frame = await session.until((f) => has(f, "Alpha 应用"), "projects");
    await tapText(session, frame, "设置", 0);
    frame = await session.until((f) => has(f, "自更新未配置"), "unavailable message", 200);
    assert.ok(has(frame, "检查 Studio 更新"), textOf(frame));
  } finally { session.kill(); }
}, 120_000);

test("a restored update handoff reopens the page and the project after the new guest starts", async () => {
  const { fake, session } = await boot((f) => {
    f.updates.activeVersion = "0.1.0-test.2"; f.updates.activeBuild = 2;
    f.storage.set("platform:studio.update-state", { protocol: "pocket.update-state.v1", schema: "studio-ui/1", targetVersion: "0.1.0-test.2", targetBuild: 2, sourceVersion: "0.1.0", sourceBuild: 1, value: { page: "console", project: "alpha-app" } });
  });
  try {
    const frame = await session.until((f) => has(f, "开始构建"), "the console page of the restored project", 300);
    await session.until(() => fake.calls("studio.fs.tree").length > 0, "the project reopened", 300);
    await session.until((f) => has(f, "界面状态已恢复"), "restore toast", 300);
    assert.ok(has(frame, "控制台"), textOf(frame));
    // The record is consumed (acknowledged) once the new guest reports a healthy package.
    await session.until(() => !fake.storage.has("platform:studio.update-state"), "handoff acknowledged", 300);
  } finally { session.kill(); }
}, 120_000);
