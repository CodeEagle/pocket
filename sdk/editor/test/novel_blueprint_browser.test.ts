import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { test } from "bun:test";
import { NativeSession, textOf, type Frame } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const projectId = "e02-4-chapter-blueprint";
const qaRoot = join(sdkRoot, ".pocket-build/chapter-blueprint-20261109");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe");
const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };

const initialStory = {
  id: "test.e02-4.chapter-blueprint",
  version: 1,
  start: "seed",
  script: {
    seed: [{ type: "say", id: "seed-line", speaker: "旁白", text: "Blueprint acceptance seed." }],
    body_below: [
      { type: "say", id: "below-body-line", speaker: "章节正文", text: "第 59 章正文 · score={{score}}" },
      { type: "return" },
    ],
    body_pass: [
      { type: "say", id: "pass-body-line", speaker: "章节正文", text: "第 60 章正文 · score={{score}}" },
      // Reaching the end of this called label must use the engine's implicit return.
    ],
  },
};

type BlueprintKind = "entry" | "chapter" | "condition" | "choice" | "assignment" | "end";
type BlueprintValues = Record<string, string | number | boolean | unknown>;

async function createBlueprintNode(page: Page, kind: BlueprintKind, label: string, title: string, values: BlueprintValues = {}): Promise<void> {
  await page.locator("[data-graph-add-blueprint-node]").click();
  const dialog = page.locator("dialog#novel-blueprint-dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("[data-blueprint-kind]").selectOption(kind);
  await page.waitForFunction(expected => document.querySelector("[data-blueprint-fields-kind]")?.getAttribute("data-blueprint-fields-kind") === expected, kind);
  await dialog.locator('[data-blueprint-field="label"]').fill(label);
  await dialog.locator('[data-blueprint-field="title"]').fill(title);
  for (const [name, raw] of Object.entries(values)) {
    const field = dialog.locator(`[data-blueprint-field="${name}"]`);
    if (await field.evaluate(element => element instanceof HTMLSelectElement)) {
      await field.selectOption(String(raw));
    } else {
      await field.fill(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    }
  }
  await dialog.locator("[data-blueprint-submit]").click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(`[data-blueprint-node="${label}"]`).waitFor();
}

async function saveStory(page: Page): Promise<void> {
  if (await page.locator("#novel-save-state").textContent() !== "已保存") {
    await page.locator("#novel-save").click();
  }
  await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
}

async function waitForNativeText(session: NativeSession, initial: Frame, fragment: string, maxFrames = 240): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    if (textOf(frame).includes(fragment)) return frame;
    frame = await session.frame();
  }
  throw new Error(`NativeSession did not paint ${JSON.stringify(fragment)}; painted=${textOf(frame)}`);
}

async function tapNativeText(session: NativeSession, frame: Frame, fragment: string): Promise<Frame> {
  const operation = (frame.ops ?? []).find(item => item.type === "text" && typeof item.text === "string" && item.text.includes(fragment));
  assert.ok(operation && Number.isFinite(operation.x) && Number.isFinite(operation.y) && Number.isFinite(operation.w) && Number.isFinite(operation.h),
    `NativeSession must expose a clickable text operation containing ${JSON.stringify(fragment)}; painted=${textOf(frame)}`);
  return session.tapPoint({ x: operation!.x! + operation!.w! / 2, y: operation!.y! + operation!.h! / 2 });
}

async function runNativeChoice(artifacts: NativeArtifacts, option: string, body: string, ending: string): Promise<{ bodyFrame: string; endingFrame: string }> {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 90_000 });
  try {
    let frame = await session.boot();
    frame = await waitForNativeText(session, frame, "启程 · 开始新的故事");
    frame = await tapNativeText(session, frame, "启程 · 开始新的故事");
    frame = await waitForNativeText(session, frame, option);
    assert.ok(textOf(frame).includes(option), `choice screen must expose the selected player option: ${textOf(frame)}`);
    frame = await tapNativeText(session, frame, option);
    frame = await waitForNativeText(session, frame, body);
    const bodyFrame = textOf(frame);
    assert.ok(bodyFrame.includes(body), `choice must execute its expected chapter body: ${bodyFrame}`);
    const score = option.includes("59") ? "score=59" : "score=60";
    assert.ok(bodyFrame.includes(score), `assignment must be visible through variable interpolation (${score}): ${bodyFrame}`);
    frame = await tapNativeText(session, frame, body);
    frame = await waitForNativeText(session, frame, ending);
    const endingFrame = textOf(frame);
    assert.ok(endingFrame.includes(ending), `chapter must return to its canonical end route: ${endingFrame}`);
    return { bodyFrame, endingFrame };
  } finally {
    await session.quit();
  }
}

type NativeArtifacts = {
  bytecodePath: string;
  pakPath: string;
  metadataPath: string;
  runtimeAbi: string;
};

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

test("chapter blueprint authoring uses canonical routes through the pinned native Guest", { timeout: 600_000 }, async () => {
  assert.ok(existsSync(nativeProbe), `release pocket_probe must exist: ${nativeProbe}`);
  const temporary = mkdtempSync(join(tmpdir(), "pocket-chapter-blueprint-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const storyPath = join(project, "story.json");
  mkdirSync(project, { recursive: true });
  mkdirSync(qaRoot, { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "test.e02-4.chapter-blueprint", name: "Chapter Blueprint Acceptance", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    pocket: 2,
    id: "test.e02-4.chapter-blueprint",
    name: "Chapter Blueprint Acceptance",
    app: { entry: "app.tsx", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "test.e02-4.chapter-blueprint", capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
      "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
    },
  }));
  writeFileSync(storyPath, `${JSON.stringify(initialStory, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "app.tsx"), `
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

function App() {
  const host = createHostBridge();
  const engine = createNovelEngine(story as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
  onCleanup(() => { engine.dispose(); host.dispose(); });
  return <NovelView host={host} engine={engine} assets={assets as NovelAssets} title="Chapter blueprint acceptance" onNewGame={() => engine.start()} />;
}

mount(App);
`);

  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = nativeProbe;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let phase = "fixture setup";
  const pageErrors: string[] = [];
  const buildArtifacts = async (page: Page, origin: string, suffix: string): Promise<NativeArtifacts> => {
    phase = `pinned buildGuest (${suffix})`;
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const notice = await page.locator("#novel-notice").innerText();
    assert.ok(notice.includes("Guest 已构建完成"), `${suffix} pinned buildGuest failed: ${notice}; diagnostics=${await page.locator("#novel-diagnostics").innerText()}`);
    const statusResponse = await fetch(`${origin}/api/projects/${projectId}/status`);
    assert.equal(statusResponse.status, 200);
    const status: any = await statusResponse.json();
    assert.equal(status.builtRevision, status.revision, `${suffix} Guest must be built from the current saved story revision`);

    const output = join(qaRoot, suffix);
    mkdirSync(output, { recursive: true });
    for (const name of ["app.qjbc", "app.pak", "app.bytecode.json"]) {
      const response = await fetch(`${origin}/api/projects/${projectId}/artifacts/${name}`);
      assert.equal(response.status, 200, `${suffix} pinned artifact ${name} must be served by the editor`);
      writeFileSync(join(output, name), Buffer.from(await response.arrayBuffer()));
    }
    const metadata = JSON.parse(readFileSync(join(output, "app.bytecode.json"), "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    assert.equal(typeof metadata.runtimeAbi, "string");
    writeFileSync(join(output, "build-status.json"), `${JSON.stringify({ revision: status.revision, builtRevision: status.builtRevision, runtimeAbi: metadata.runtimeAbi, bytecodeBytes: metadata.bytecodeBytes, logs: status.logs }, null, 2)}\n`);
    return {
      bytecodePath: join(output, "app.qjbc"),
      pakPath: join(output, "app.pak"),
      metadataPath: join(output, "app.bytecode.json"),
      runtimeAbi: metadata.runtimeAbi as string,
    };
  };

  try {
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1680, height: 1280 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on("pageerror", error => pageErrors.push(error.message));

    phase = "open the visual novel graph panel";
    const response = await page.goto(`${origin}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await page.locator("[data-graph-canvas]").waitFor();

    phase = "create executable blueprints for all six roles";
    // Targets are created before their dependants, so every canonical script route is valid at submit time.
    await createBlueprintNode(page, "end", "end_below", "59 章结局", { text: "结局：59 分支。" });
    await createBlueprintNode(page, "end", "end_pass", "60 章结局", { text: "结局：60 分支。" });
    await createBlueprintNode(page, "chapter", "chapter_below", "第 59 章", { target: "body_below", next: "end_pass" });
    await createBlueprintNode(page, "chapter", "chapter_pass", "第 60 章", { target: "body_pass", next: "end_pass" });
    await createBlueprintNode(page, "condition", "condition_route", "分数分流", {
      when: { op: "gte", left: { type: "variable", name: "score" }, right: { type: "literal", value: 60 } },
      then: "chapter_pass",
      else: "chapter_below",
    });
    await createBlueprintNode(page, "assignment", "set_below", "设置为 59", { variable: "score", value: 59, next: "condition_route" });
    await createBlueprintNode(page, "assignment", "set_pass", "设置为 60", { variable: "score", value: 60, next: "condition_route" });
    await createBlueprintNode(page, "choice", "player_choice", "选择章节", {
      prompt: "选择要走的章节路线",
      options: [
        { id: "choose_below", text: "走 59 分路线", target: "set_below" },
        { id: "choose_pass", text: "走 60 分路线", target: "set_pass" },
      ],
    });
    await createBlueprintNode(page, "entry", "story_entry", "故事入口", { target: "player_choice" });
    const visibleRoles = await page.locator("[data-blueprint-node] .nv-graph-blueprint-kind").allTextContents();
    for (const [kind, title] of Object.entries({ entry: "流程入口", chapter: "章节", condition: "条件", choice: "玩家选择", assignment: "变量赋值", end: "流程终点" })) {
      assert.ok(visibleRoles.includes(title), `graph canvas must display the ${kind} role as ${title}; visible=${visibleRoles.join(", ")}`);
    }
    assert.equal(await page.locator("[data-blueprint-node]").count(), 9, "canvas must show every created role node, including the two assignment and ending nodes");
    await page.locator('[data-graph-start="story_entry"]').click();
    await page.waitForFunction(() => document.querySelector('[data-graph-start="story_entry"]')?.disabled === true);
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    await page.screenshot({ path: join(qaRoot, "blueprint-canvas-initial.png") });

    phase = "edit a chapter's cross-chapter route through its graph port";
    await page.locator('[data-graph-port="chapter_below:1:jump"]').click();
    await page.locator('[data-graph-connect-target="end_below"]').click();
    await page.waitForFunction(() => document.querySelector('[data-graph-node="chapter_below"] [data-graph-target="jump"]')?.value === "end_below");
    const chapterBelowRoute = page.locator('[data-graph-node="chapter_below"] [data-graph-target="jump"]');
    assert.equal(await chapterBelowRoute.inputValue(), "end_below");
    await page.locator('#novel-graph-edges [data-graph-edge="chapter_below:1:jump"][data-graph-target="end_below"]').waitFor();
    await clickNovelHistory(page, "undo");
    assert.equal(await page.locator('[data-graph-node="chapter_below"] [data-graph-target="jump"]').inputValue(), "end_pass", "one undo must restore the original canonical chapter exit");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.locator('[data-graph-node="chapter_below"] [data-graph-target="jump"]').inputValue(), "end_below", "one redo must restore the edited canonical chapter exit");

    phase = "rename a chapter role while preserving its body and metadata key through history";
    await page.locator('[data-graph-node="chapter_below"] [data-graph-connect-target="chapter_below"]').click();
    const labelId = page.getByLabel("标签 ID", { exact: true });
    await labelId.fill("chapter_below_v2");
    await labelId.press("Tab");
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "chapter_below_v2");
    await saveStory(page);
    let renamed = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.deepEqual(renamed.editor.blueprint.nodes.chapter_below_v2, { kind: "chapter", title: "第 59 章" }, "rename must carry the role and title under the new metadata key");
    assert.equal(Object.hasOwn(renamed.editor.blueprint.nodes, "chapter_below"), false);
    assert.deepEqual(renamed.script.chapter_below_v2, [
      { type: "call", target: "body_below" },
      { type: "jump", target: "end_below" },
    ], "renaming a chapter wrapper must preserve its body call and downstream jump");
    assert.equal(renamed.script.condition_route[0].else, "chapter_below_v2", "rename must update canonical cross-chapter references");
    assert.deepEqual(renamed.script.body_below, initialStory.script.body_below, "the chapter正文 script must remain intact during role rename");
    await clickNovelHistory(page, "undo");
    await saveStory(page);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(storyPath, "utf8")).editor.blueprint.nodes, "chapter_below_v2"), false, "undo must restore the old role key");
    await clickNovelHistory(page, "redo");
    await saveStory(page);
    renamed = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.deepEqual(renamed.editor.blueprint.nodes.chapter_below_v2, { kind: "chapter", title: "第 59 章" }, "redo must restore the renamed role key");
    assert.deepEqual(renamed.script.body_below, initialStory.script.body_below, "rename undo/redo must not consume or rewrite chapter body instructions");

    phase = "delete a temporary blueprint and restore its role key with undo/redo";
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await createBlueprintNode(page, "chapter", "scratch_blueprint", "临时章节", { target: "body_below", next: "end_below" });
    await page.locator('[data-graph-node="scratch_blueprint"] [data-graph-connect-target="scratch_blueprint"]').click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "删除标签", exact: true }).click();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-graph-node="scratch_blueprint"]'));
    await saveStory(page);
    let afterDelete = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.equal(Object.hasOwn(afterDelete.script, "scratch_blueprint"), false);
    assert.equal(Object.hasOwn(afterDelete.editor.blueprint.nodes, "scratch_blueprint"), false, "delete must remove the matching role key");
    assert.deepEqual(afterDelete.script.body_below, initialStory.script.body_below, "deleting a wrapper must preserve the separately authored chapter body");
    await clickNovelHistory(page, "undo");
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    await page.locator('[data-graph-node="scratch_blueprint"]').waitFor();
    await saveStory(page);
    const restored = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.equal(restored.editor.blueprint.nodes.scratch_blueprint.kind, "chapter", "undo must restore the deleted role key");
    assert.deepEqual(restored.script.scratch_blueprint, [{ type: "call", target: "body_below" }, { type: "jump", target: "end_below" }]);
    assert.deepEqual(restored.script.body_below, initialStory.script.body_below);
    await clickNovelHistory(page, "redo");
    await saveStory(page);
    afterDelete = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.equal(Object.hasOwn(afterDelete.editor.blueprint.nodes, "scratch_blueprint"), false, "redo must remove the role key again");
    assert.deepEqual(afterDelete.script.body_below, initialStory.script.body_below);

    phase = "save and reopen the blueprint roles and canonical graph routes";
    await page.locator('[data-graph-zoom="fit"]').click();
    await page.screenshot({ path: join(qaRoot, "blueprint-canvas-routed.png") });
    await saveStory(page);
    const savedStory = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.equal(savedStory.start, "story_entry");
    assert.equal(savedStory.script.story_entry[0].target, "player_choice");
    assert.deepEqual(Object.fromEntries(Object.entries(savedStory.editor.blueprint.nodes).map(([label, node]: [string, any]) => [label, node.kind])), {
      end_below: "end",
      end_pass: "end",
      chapter_below_v2: "chapter",
      chapter_pass: "chapter",
      condition_route: "condition",
      set_below: "assignment",
      set_pass: "assignment",
      player_choice: "choice",
      story_entry: "entry",
    }, "saved editor metadata must retain all six blueprint roles under their current labels");
    assert.equal(savedStory.script.chapter_pass[0].type, "call");
    assert.equal(savedStory.script.chapter_pass[0].target, "body_pass");
    assert.equal(savedStory.script.chapter_pass[1].type, "jump");
    assert.equal(savedStory.script.chapter_pass[1].target, "end_pass");
    assert.deepEqual(savedStory.editor.blueprint.nodes.chapter_below_v2, { kind: "chapter", title: "第 59 章" });
    assert.deepEqual(savedStory.editor.blueprint.nodes.player_choice, { kind: "choice", title: "选择章节" });
    for (const node of Object.values(savedStory.editor.blueprint.nodes) as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(node).sort(), node.title === undefined ? ["kind"] : ["kind", "title"], "route parameters must stay in canonical script, outside blueprint metadata");
    }
    assert.deepEqual(savedStory.script.body_below, initialStory.script.body_below, "the saved chapter body must still have its explicit return");
    assert.deepEqual(savedStory.script.body_pass, initialStory.script.body_pass, "the saved chapter body must still end by EOF for implicit return");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await page.locator('[data-blueprint-node="chapter_below_v2"]').waitFor();
    assert.equal(await page.locator('[data-graph-node="chapter_below_v2"] [data-graph-target="jump"]').inputValue(), "end_below");
    assert.equal(await page.locator('[data-graph-start="story_entry"]').isDisabled(), true);

    phase = "capture final canonical script and build the story with blueprint metadata";
    const storyWithMetadata = JSON.parse(readFileSync(storyPath, "utf8"));
    const withMetadata = await buildArtifacts(page, origin, "with-editor-blueprint");
    phase = "click both player choices in the actual native Guest with metadata";
    const belowWithMetadata = await runNativeChoice(withMetadata, "走 59 分路线", "第 59 章正文", "结局：59 分支。");
    const passWithMetadata = await runNativeChoice(withMetadata, "走 60 分路线", "第 60 章正文", "结局：60 分支。");
    assert.ok(belowWithMetadata.bodyFrame.includes("score=59"));
    assert.ok(passWithMetadata.bodyFrame.includes("score=60"));

    phase = "remove editor metadata and rebuild the identical canonical story";
    const storyWithoutEditor = JSON.parse(readFileSync(storyPath, "utf8"));
    delete storyWithoutEditor.editor;
    assert.deepEqual(storyWithoutEditor.script, storyWithMetadata.script, "metadata ablation must leave every executable script instruction byte-for-byte equivalent");
    writeFileSync(storyPath, `${JSON.stringify(storyWithoutEditor, null, 2)}\n`);
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(storyPath, "utf8")), "editor"), false);
    const withoutMetadata = await buildArtifacts(page, origin, "without-editor-metadata");
    phase = "verify both real player choices through the same runtime without editor metadata";
    const belowWithoutMetadata = await runNativeChoice(withoutMetadata, "走 59 分路线", "第 59 章正文", "结局：59 分支。");
    const passWithoutMetadata = await runNativeChoice(withoutMetadata, "走 60 分路线", "第 60 章正文", "结局：60 分支。");
    assert.deepEqual(belowWithoutMetadata, belowWithMetadata, "removing editor metadata must keep the 59 route execution identical");
    assert.deepEqual(passWithoutMetadata, passWithMetadata, "removing editor metadata must keep the 60 route execution identical");
    assert.deepEqual(pageErrors, [], "Playwright Chromium must not report page errors");

    const sourcePaths = [
      "sdk/packages/pocket_vn/src/blueprint.ts",
      "sdk/packages/pocket_vn/src/index.ts",
      "sdk/packages/pocket_vn/src/types.ts",
      "sdk/packages/pocket_vn/src/engine.ts",
      "sdk/editor/novel.ts",
      "sdk/editor/client/novel.js",
      "sdk/editor/client/novel.css",
      "sdk/editor/test/novel_blueprint_browser.test.ts",
      "sdk/editor/test/novel_blueprint_schema.test.ts",
      "sdk/editor/test/novel_graph_browser.test.ts",
      "sdk/editor/test/novel_graph_canvas_browser.test.ts",
      "sdk/editor/test/novel_authoring_browser.test.ts",
      "demo/js/tests/native_session.ts",
      "sdk/scripts/build_guest.ts",
    ];
    const playwrightExecutable = chromium.executablePath();
    const toolPaths = [process.execPath, playwrightExecutable, nativeProbe];
    const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(join(repository, path))] as const)));
    const toolHashes = Object.fromEntries(await Promise.all(toolPaths.map(async path => [path, await hashFile(path)] as const)));
    const buildHashes = Object.fromEntries(await Promise.all([
      join(qaRoot, "with-editor-blueprint/app.qjbc"),
      join(qaRoot, "with-editor-blueprint/app.pak"),
      join(qaRoot, "with-editor-blueprint/app.bytecode.json"),
      join(qaRoot, "without-editor-metadata/app.qjbc"),
      join(qaRoot, "without-editor-metadata/app.pak"),
      join(qaRoot, "without-editor-metadata/app.bytecode.json"),
    ].map(async path => [path.slice(qaRoot.length + 1), await hashFile(path)] as const)));
    const result = {
      projectId,
      browser: { name: "Playwright Chromium", executablePath: playwrightExecutable },
      nativeProbe,
      screenshots: ["blueprint-canvas-initial.png", "blueprint-canvas-routed.png"],
      paths: { below: belowWithMetadata, pass: passWithMetadata },
      metadataFreePathsMatch: {
        below: JSON.stringify(belowWithoutMetadata) === JSON.stringify(belowWithMetadata),
        pass: JSON.stringify(passWithoutMetadata) === JSON.stringify(passWithMetadata),
      },
      sourceHashes,
      toolHashes,
      buildHashes,
      pageErrors,
    };
    writeFileSync(join(qaRoot, "acceptance.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(qaRoot, "final-hashes.json"), `${JSON.stringify({ sourceHashes, toolHashes, buildHashes }, null, 2)}\n`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; pageErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await browser?.close();
    await server?.stop(true);
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    rmSync(temporary, { recursive: true, force: true });
  }
});
