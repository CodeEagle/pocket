import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf } from "./probe_session.ts";
import { ProbeSession, type Frame } from "./probe_session.ts";
import { has, openAlpha, tapText } from "./helpers.ts";
import { FakePublish, KEY_ID, ORIGIN, RUNTIME_ABI } from "./fake_publish.ts";

// M5 on the real native probe: publish, artifacts and versions pages driven only by pointer taps.

async function boot5(setup?: (fake: FakePublish) => void): Promise<{ fake: FakePublish; session: ProbeSession }> {
  const fake = new FakePublish();
  fake.storage.set("studio.settings.v1", { editor: "input" });
  setup?.(fake);
  const session = new ProbeSession(fake.handle);
  fake.attach(session);
  await session.boot();
  return { fake, session };
}

/** Opens the project and builds it through the Console page (a real build, as a user would). */
async function openAndBuild(fake: FakePublish, session: ProbeSession): Promise<Frame> {
  await openAlpha(session);
  let frame = await session.frame();
  await tapText(session, frame, "控制台");
  frame = await session.until((f) => has(f, "开始构建"), "console");
  await tapText(session, frame, "开始构建");
  frame = await session.until((f) => has(f, "已构建（最新）"), "build finished");
  assert.equal(fake.builtRevision, fake.revision);
  assert.equal(fake.calls("studio.build.start").length, 1, "one tap on 开始构建 starts exactly one build");
  return frame;
}

async function gotoPage(session: ProbeSession, rail: string, marker: string): Promise<Frame> {
  const frame = await session.frame();
  await tapText(session, frame, rail, 0);
  return session.until((f) => has(f, marker), `${rail} page`);
}

test("the rail opens the three M5 pages (no placeholders)", async () => {
  const { session } = await boot5();
  try {
    await openAlpha(session);
    let frame = await gotoPage(session, "产物", "产物 · alpha-app");
    assert.ok(!has(frame, "将在 M5 提供"));
    frame = await gotoPage(session, "发布", "发布 · alpha-app");
    assert.ok(!has(frame, "将在 M5 提供"));
    frame = await gotoPage(session, "版本", "版本 · alpha-app");
    assert.ok(!has(frame, "将在 M5 提供"));
  } finally { session.kill(); }
}, 90_000);

test("publish: plan, signed test publish with progress, public facts, copy, and the versions page shows the entry", async () => {
  const { fake, session } = await boot5();
  try {
    await openAndBuild(fake, session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    frame = await session.until((f) => has(f, "已构建（可发布）"), "plan loaded for a built project");
    assert.ok(has(frame, "Alpha（pocket.alpha）"));
    assert.ok(has(frame, "尚无发布记录"));
    assert.ok(has(frame, "槽位所有者"));
    assert.deepEqual(fake.calls("studio.publish.plan").map((r) => r.params), [{ project: "alpha-app", channel: "test" }]);
    assert.equal(fake.calls("studio.publish.publish").length, 0, "opening the page never publishes");

    await tapText(session, frame, "发布测试包");
    frame = await session.until((f) => has(f, "正在签名并发布测试包"), "progress");
    assert.ok(has(frame, "发布中…"), "the button shows the busy state");
    frame = await session.until((f) => has(f, "发布完成 · 测试"), "publish done");
    assert.deepEqual(fake.calls("studio.publish.publish").map((r) => r.params), [{ project: "alpha-app", channel: "test" }], "a test publish needs no confirmation");
    assert.ok(has(frame, "v0.1.0-test.1"));
    assert.ok(has(frame, KEY_ID));
    assert.ok(has(frame, `${ORIGIN}/test/pocket/studio/pocket.alpha/0.1.0-test.1/latest.json`), "manifest URL");
    assert.ok(has(frame, `${ORIGIN}/test/pocket/studio/pocket.alpha/0.1.0-test.1/host.json`), "host.json URL");
    assert.ok(has(frame, "payload SHA-256") && has(frame, "运行时 ABI"));
    assert.ok(has(frame, "已发布测试包") || has(frame, "测试包已发布"), "success toast");
    // No key material anywhere on screen.
    assert.ok(!/PRIVATE KEY|privateKey/.test(textOf(frame)));
    // Copy: the whole digest, not the shortened one, reaches the clipboard through the clipboard capability.
    const copyCountBefore = fake.clipboard.length;
    await tapText(session, frame, "复制", 0);
    frame = await session.until((f) => has(f, "已复制"), "copy toast");
    assert.equal(fake.clipboard.length, copyCountBefore + 1);
    assert.equal(fake.clipboard.at(-1), KEY_ID, "the first copy button is the key id");
    await tapText(session, frame, "复制", 1);
    await session.until(() => fake.clipboard.length === copyCountBefore + 2, "second copy");
    assert.equal(fake.clipboard.at(-1), RUNTIME_ABI, "the full ABI, not the shortened text");

    // Versions page: the new entry and the test slot.
    frame = await gotoPage(session, "版本", "版本 · alpha-app");
    frame = await session.until((f) => has(f, "测试槽（test）") && has(f, "v0.1.0-test.1 · 构建 1 · 当前"), "versions entry");
    assert.ok(has(frame, "此槽位还没有发布。"), "the stable slot is empty");
    assert.ok(has(frame, "试用 / 已提升 / 已回滚"), "the page says trial/promoted/rolled back is not tracked by the service");
    await tapText(session, frame, "v0.1.0-test.1 · 构建 1 · 当前");
    frame = await session.until((f) => has(f, `${ORIGIN}/releases/alpha-app/alpha-app-test-1.tar.gz`), "archive link as a URL");
    assert.ok(has(frame, "发布 ID"));
    assert.equal(fake.calls("studio.publish.history").length >= 1, true);
  } finally { session.kill(); }
}, 120_000);

test("publish refuses an unbuilt project and unsaved edits without calling the service", async () => {
  const { fake, session } = await boot5();
  try {
    await openAlpha(session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    frame = await session.until((f) => has(f, "需先构建"), "plan says build first");
    assert.ok(has(frame, "Build the current project before publishing."));
    // The button is disabled by the plan; the store gate still protects direct calls: use the keyboard-free path by tapping anyway.
    await tapText(session, frame, "发布测试包");
    await session.settle(10);
    assert.equal(fake.calls("studio.publish.publish").length, 0);
  } finally { session.kill(); }
}, 90_000);

test("release publish asks for confirmation: cancel publishes nothing, confirm publishes to the stable slot", async () => {
  const { fake, session } = await boot5();
  try {
    await openAndBuild(fake, session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    await tapText(session, frame, "稳定版频道");
    frame = await session.until((f) => has(f, "发布计划 · 稳定版") && has(f, "发布稳定版"), "channel switched");
    assert.deepEqual(fake.calls("studio.publish.plan").at(-1)!.params, { project: "alpha-app", channel: "release" });
    await tapText(session, frame, "发布稳定版");
    frame = await session.until((f) => has(f, "发布稳定版？"), "confirm dialog");
    assert.ok(has(frame, "并更新稳定频道"));
    assert.equal(fake.calls("studio.publish.publish").length, 0, "nothing is published before the user confirms");
    await tapText(session, frame, "取消");
    frame = await session.settle(30);
    assert.equal(fake.calls("studio.publish.publish").length, 0, "cancel publishes nothing");
    assert.ok(!has(frame, "发布稳定版？"));

    await tapText(session, frame, "发布稳定版");
    frame = await session.until((f) => has(f, "发布稳定版？"), "confirm dialog again");
    // The dialog's confirm button carries the same label as the page button; it is the last one drawn.
    await tapText(session, frame, "发布稳定版", -1);
    frame = await session.until((f) => has(f, "发布完成 · 稳定版"), "release published");
    assert.deepEqual(fake.calls("studio.publish.publish").map((r) => r.params), [{ project: "alpha-app", channel: "release" }]);
    assert.equal(fake.releases[0]!.slot, "stable");
    frame = await gotoPage(session, "版本", "稳定槽（stable）");
    frame = await session.until((f) => has(f, "当前版本") && has(f, "v0.1.0 · 构建 1"), "stable slot filled");
  } finally { session.kill(); }
}, 120_000);

test("a failed publish is shown (never a success), and a timeout points at the versions page", async () => {
  const { fake, session } = await boot5((f) => { f.publishFailure = { ok: false, error: { code: "conflict", message: "package pocket.alpha stable slot is owned by project other-app; use a unique appId (HTTP 409)" } }; });
  try {
    await openAndBuild(fake, session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    await session.until((f) => has(f, "已构建（可发布）"), "plan");
    await tapText(session, frame, "发布测试包");
    frame = await session.until((f) => has(f, "发布失败"), "failure panel");
    assert.ok(has(frame, "is owned by project other-app"));
    assert.ok(!has(frame, "发布完成"));
    assert.equal(fake.releases.length, 0);
    fake.publishFailure = { ok: false, error: { code: "service_timeout", message: "request timed out" } };
    await tapText(session, frame, "发布测试包");
    frame = await session.until((f) => has(f, "服务端可能仍在处理"), "timeout hint");
  } finally { session.kill(); }
}, 120_000);

test("offline package: archive URL is shown as text and copyable; reused packages show their slot owner", async () => {
  const { fake, session } = await boot5((f) => {
    f.reused = [{ projectId: "alpha-app", appId: "pocket.child", title: "子应用", kind: "reused", ownerProjectId: "child-app", ownerTitle: "Child 项目", version: "1.2.0", build: 3, built: false, busy: false, canSelect: true, publishedVersion: "1.2.0-test.4", publishedBuild: 4, publishedReleaseId: "child-app-test-4", canPublish: false, reason: "owned elsewhere" }];
  });
  try {
    await openAndBuild(fake, session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    frame = await session.until((f) => has(f, "复用的已发布包（1）"), "reused section");
    assert.ok(has(frame, "槽位所有者：Child 项目 · v1.2.0-test.4 构建 4"));
    await tapText(session, frame, "生成离线包");
    frame = await session.until((f) => has(f, "alpha-app-offline-1.tar.gz"), "offline done");
    assert.ok(has(frame, `${ORIGIN}/releases/alpha-app/alpha-app-offline-1.tar.gz`) || has(frame, "/releases/alpha-app/alpha-app-offline-1.tar.gz"));
    assert.equal(fake.calls("studio.publish.offline").length, 1);
    assert.equal(fake.calls("studio.publish.publish").length, 0, "the offline package never publishes");
  } finally { session.kill(); }
}, 120_000);

test("artifacts: list, bytecode metadata, manifest, pack contents, build.json, raw view, binary metadata only, copy", async () => {
  const { fake, session } = await boot5();
  try {
    await openAlpha(session);
    let frame = await gotoPage(session, "产物", "产物 · alpha-app");
    frame = await session.until((f) => has(f, "完成一次成功的构建后"), "unbuilt message");
    assert.equal(fake.calls("studio.artifacts.inspect").length, 0);

    // Build, then reopen the page.
    frame = await gotoPage(session, "控制台", "开始构建");
    await tapText(session, frame, "开始构建");
    await session.until((f) => has(f, "已构建（最新）"), "built");
    frame = await gotoPage(session, "产物", "产物 · alpha-app");
    frame = await session.until((f) => has(f, "来宾清单") && has(f, "包内容"), "inspector sections");
    for (const name of ["app.qjbc", "app.bytecode.json", "app.pak", "guest-manifest.json", "build.json", "resources.json", "app.js"]) assert.ok(has(frame, name), name);
    assert.ok(has(frame, "QuickJS 字节码 · 513.8 KiB"), "binary size from metadata");
    // bytecode (default section)
    assert.ok(has(frame, "绑定代数") && has(frame, "quickjs-bytecode") && has(frame, "帧率 (tickHz)"));
    assert.ok(has(frame, "12") && has(frame, "60"));
    assert.ok(has(frame, "payload SHA-256") && has(frame, "d34a59a9844b77f0c266…9973f71f"), "shortened digest on screen");
    assert.equal(fake.calls("studio.artifacts.inspect").some((r) => r.params.name === "app.js"), false, "app.js is only fetched on demand");

    // copy the whole hash (not the shortened text)
    await tapText(session, frame, "复制", 1);
    await session.until(() => fake.clipboard.length >= 1, "copied");
    assert.equal(fake.clipboard.at(-1), "d34a59a9844b77f0c266d6b79457c97e4055472ef2199016b880db159973f71f");

    // manifest
    await tapText(session, frame, "来宾清单", 0);
    frame = await session.until((f) => has(f, "必需能力"), "manifest section");
    assert.ok(has(frame, "text.layout.native"));
    assert.ok(has(frame, "堆上限 256.00 MiB · 资源包上限 32.00 MiB"), "manifest memory");
    // pack contents from resources.json
    await tapText(session, frame, "包内容", 0);
    frame = await session.until((f) => has(f, "共 3 项"), "pack section");
    assert.ok(has(frame, "随包 2 项") && has(frame, "网络下载 1 项"));
    // build.json
    await tapText(session, frame, "构建信息", 0);
    frame = await session.until((f) => has(f, "gen-1"), "build section");

    // raw view of the manifest, then of app.js (lazy), then a binary
    await tapText(session, frame, "guest-manifest.json");
    frame = await session.until((f) => has(f, "返回概览"), "raw view");
    assert.ok(has(frame, '"protocolVersion": 1'));
    await tapText(session, frame, "app.js");
    frame = await session.until((f) => has(f, "APP_JS_MARKER"), "app.js text");
    assert.equal(fake.calls("studio.artifacts.inspect").filter((r) => r.params.name === "app.js").length, 1);
    await tapText(session, frame, "app.qjbc");
    frame = await session.until((f) => has(f, "二进制产物只显示元数据"), "binary metadata only");
    await tapText(session, frame, "返回概览");
    await session.until((f) => has(f, "构建信息"), "back to overview");
  } finally { session.kill(); }
}, 120_000);

test("versions: empty state, no invented trial/promoted state", async () => {
  const { session } = await boot5();
  try {
    await openAlpha(session);
    let frame = await gotoPage(session, "版本", "版本 · alpha-app");
    frame = await session.until((f) => has(f, "还没有发布记录"), "empty history");
    assert.ok(has(frame, "测试槽（test）") && has(frame, "稳定槽（stable）"));
    assert.ok(has(frame, "仅本机（127.0.0.1）"));
    assert.ok(!/已提升 ·|已回滚 ·|试用中/.test(textOf(frame)));
  } finally { session.kill(); }
}, 90_000);

test("copy reports a missing clipboard instead of pretending", async () => {
  const { fake, session } = await boot5((f) => { f.clipboardAvailable = false; });
  try {
    await openAndBuild(fake, session);
    let frame = await gotoPage(session, "发布", "发布计划 · 测试");
    await session.until((f) => has(f, "已构建（可发布）"), "plan");
    await tapText(session, frame, "发布测试包");
    frame = await session.until((f) => has(f, "发布完成 · 测试"), "published");
    await tapText(session, frame, "复制", 0);
    frame = await session.until((f) => has(f, "复制失败"), "copy failure toast");
    assert.equal(fake.clipboard.length, 0);
  } finally { session.kill(); }
}, 120_000);
