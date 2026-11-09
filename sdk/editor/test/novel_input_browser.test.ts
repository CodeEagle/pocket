import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";

test("input authoring saves typed constraints and locales, preserves the live field, and executes the saved Guest", { timeout: 180_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-input-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "input-author";
  mkdirSync(project, { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "fonts.json", "fonts"]) cpSync(join(source, name), join(project, name), { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "pocket.demo.lantern", name: "Input Authoring", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  writeFileSync(join(project, "images.json"), "{}");
  writeFileSync(join(project, "story.json"), JSON.stringify({
    id: "input-author", version: 1, start: "start", script: {
      start: [
        { type: "input", id: "mailbox", variable: "box", inputType: "text", prompt: "请填写邮筒编号", placeholder: "请输入编号", minLength: 1, maxLength: 16, defaultValue: "7", custom: { retained: true } },
        { type: "ending", id: "done", text: "编号 {{box}}" },
      ],
      cancelled: [{ type: "ending", id: "cancelled", text: "已取消" }],
    },
  }));
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";
function App() {
  const host = createHostBridge();
  const engine = createNovelEngine(story as StoryDefinition);
  onCleanup(() => { engine.dispose(); host.dispose(); });
  return <NovelView host={host} engine={engine} assets={assets as NovelAssets} title="Input Authoring" onNewGame={() => engine.start()} />;
}
mount(App);
`);
  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "launch";
  const errors: string[] = [];
  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  const readStory = () => JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);

    phase = "context preview text input before a same-address boolean rebuild";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "start:0");
    await page.locator(".nv-jump-control select").selectOption("start");
    await page.locator(".nv-jump-control input").fill("0");
    await page.locator("#novel-context-preview-root").selectOption("main");
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached"
      && JSON.parse(document.querySelector("#novel-context-preview-facts")?.textContent ?? "{}").active?.kind === "input");
    const textInputPanel = page.locator("#novel-live-view .nv-preview-input");
    assert.equal(await textInputPanel.locator("input").getAttribute("type"), "text");
    assert.deepEqual(JSON.parse((await textInputPanel.getAttribute("data-input-key"))!), ["start", 0, "mailbox", "text"]);

    phase = "edit the same input to boolean and reconstruct at the same root/address";
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByLabel("输入类型", { exact: true }).selectOption("boolean");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached"
      && JSON.parse(document.querySelector("#novel-context-preview-facts")?.textContent ?? "{}").active?.kind === "input");
    const booleanInput = page.getByLabel("玩家布尔输入", { exact: true });
    await booleanInput.waitFor();
    assert.equal(await booleanInput.getAttribute("type"), "checkbox", "the adopted boolean engine receives a new checkbox DOM and listener");
    assert.deepEqual(JSON.parse((await page.locator("#novel-live-view .nv-preview-input").getAttribute("data-input-key"))!), ["start", 0, "mailbox", "boolean"]);
    await booleanInput.check();
    await page.locator("#novel-live-view .nv-preview-input-submit").click();
    await page.waitForFunction(() => JSON.parse(document.querySelector("#novel-context-preview-facts")?.textContent ?? "{}").active?.kind === "ending");
    const booleanFacts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(booleanFacts.variables?.box, true, "checking and submitting the rebuilt boolean input writes a boolean fact");
    assert.equal(booleanFacts.active?.kind, "ending");

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("输入类型", { exact: true }).inputValue(), "text", "the new preview flow does not consume the author's history");

    await page.getByLabel("输入类型", { exact: true }).selectOption("number").catch(async error => { throw new Error(`${error.message}; body=${await page.locator("body").innerText()}`); });
    phase = "numeric authoring";
    const edit = async (label: string, value: string) => {
      await page.getByLabel(label, { exact: true }).fill(value);
      await page.getByLabel(label, { exact: true }).press("Tab");
    };
    await edit("数值下限", "0");
    await edit("数值上限", "999");
    await page.getByLabel("仅允许整数", { exact: true }).check();
    await page.getByLabel("输入取消目标", { exact: true }).selectOption("cancelled");
    await page.getByLabel("输入类型", { exact: true }).selectOption("boolean");
    assert.equal(await page.getByLabel("布尔默认值", { exact: true }).count(), 1);
    assert.equal(await page.getByLabel("数值下限", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("输入占位提示", { exact: true }).count(), 0);
    await clickNovelHistory(page, "undo");
    // Repeated copies must receive distinct stable IDs, including input IDs.
    await page.locator(".nv-instruction").first().getByRole("button", { name: "复制", exact: true }).click();
    await page.locator(".nv-instruction").first().getByRole("button", { name: "复制", exact: true }).click();
    const ids = await page.getByLabel("稳定输入 ID", { exact: true }).evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value));
    assert.equal(new Set(ids).size, 3);
    await clickNovelHistory(page, "undo");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("稳定输入 ID", { exact: true }).count(), 1);
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const input = readStory().script.start[0];
    assert.deepEqual(input, { type: "input", id: "mailbox", variable: "box", inputType: "number", prompt: "请填写邮筒编号", placeholder: "请输入编号", custom: { retained: true }, min: 0, max: 999, integer: true, cancelTarget: "cancelled" });
    await page.reload();
    assert.equal(await page.getByLabel("输入类型", { exact: true }).inputValue(), "number");
    assert.equal(await page.getByLabel("数值上限", { exact: true }).inputValue(), "999");

    phase = "cancel route map";
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    const cancelEdge = page.getByLabel("start · 第 1 条 · 输入取消目标", { exact: true });
    assert.equal(await cancelEdge.inputValue(), "cancelled");
    await cancelEdge.selectOption("");
    await clickNovelHistory(page, "undo");
    assert.equal(await cancelEdge.inputValue(), "cancelled");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");

    phase = "localized prompts";
    await page.getByRole("button", { name: "文本本地化", exact: true }).click();
    await page.getByLabel("新语言标签", { exact: true }).fill("en");
    await page.getByRole("button", { name: "添加语言", exact: true }).click();
    await page.getByLabel("输入提示 mailbox", { exact: true }).fill("Mailbox number");
    await page.getByLabel("输入占位 mailbox", { exact: true }).fill("Enter a number");
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "novel.locales.json"), "utf8")).catalogs.en.inputs.mailbox, { prompt: "Mailbox number", placeholder: "Enter a number" });

    phase = "engine debug input";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.getByLabel("玩家输入草稿", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("玩家输入草稿", { exact: true }).isDisabled(), true);
    await page.locator("#novel-preview-pause").click();
    await page.getByLabel("玩家输入草稿", { exact: true }).fill("12.5");
    await page.getByRole("button", { name: "提交输入", exact: true }).click();
    assert.match(await page.locator(".nv-preview-input-error").innerText(), /整数/);
    assert.equal(await page.locator("#novel-variables").innerText(), "{}");
    await page.getByLabel("玩家输入草稿", { exact: true }).evaluate(input => {
      (window as any).__originalInput = input;
      (input as HTMLInputElement).setSelectionRange(1, 1);
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      (input as HTMLInputElement).value = "42";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "42", isComposing: true }));
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "42" }));
    });
    assert.equal(await page.getByLabel("玩家输入草稿", { exact: true }).evaluate(input => input === (window as any).__originalInput), true, "engine notifications must retain the actual field during composition");
    await page.getByRole("button", { name: "提交输入", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-variables")?.textContent?.includes('"box": 42'));
    assert.match(await page.locator("#novel-live-view").innerText(), /编号 42/);

    phase = "pinned Guest build";
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 35000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as any;
    assert.equal(status.builtRevision, status.revision);
    const artifact = join(workspace, "builds", projectId, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    process.env.POCKET_NATIVE_PROBE = join(repository, "sdk/.pocket-build/current-native-tools/bin/pocket_probe");
    native = new NativeSession({ bytecodePath: join(artifact, "app.qjbc"), pakPath: join(artifact, "app.pak"), metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 30000 });
    phase = "saved Guest native input";
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await native.settle(frame);
    const field = (frame.ops ?? []).find(op => op.type === "text" && op.text === "请输入编号");
    assert.ok(field, `compiled editor input must paint: ${textOf(frame)}`);
    native.sendEvent("input.pointer", { phase: "down", id: 0, x: field.x! + 8, y: field.y! + 8 });
    const down = await native.frame();
    native.sendEvent("input.pointer", { phase: "up", id: 0, x: field.x! + 8, y: field.y! + 8 });
    const up = await native.frame();
    let open = [...(down.events ?? []), ...(up.events ?? [])].find(item => item.name === "textInput.open")?.payload;
    assert.ok(open, "pointer must open the genuine native input protocol");
    const rejectedSession = open;
    native.sendEvent("textInput.edit", { id: open.id, editingSession: open.editingSession, revision: 1, jsRevision: open.jsRevision, text: "1".repeat(129), selectionBase: 129, selectionExtent: 129, composingBase: -1, composingExtent: -1 });
    frame = await native.frame();
    assert.ok(frame.events?.some(item => item.name === "textInput.close" && item.payload?.editingSession === rejectedSession.editingSession), "an over-cap native paste must close the rejected editor session");
    assert.ok((frame.ops ?? []).some(op => op.type === "text" && op.text === "请输入编号"), "a rejected paste must restore the engine's unmodified canonical draft");
    frame = await native.tap("请输入编号", frame);
    open = frame.events?.find(item => item.name === "textInput.open")?.payload;
    assert.ok(open && open.id !== rejectedSession.id, "the restored field must open a fresh native input session");
    native.sendEvent("textInput.edit", { id: rejectedSession.id, editingSession: rejectedSession.editingSession, revision: 2, jsRevision: rejectedSession.jsRevision, text: "999", selectionBase: 3, selectionExtent: 3, composingBase: -1, composingExtent: -1 });
    frame = await native.frame();
    assert.ok((frame.ops ?? []).some(op => op.type === "text" && op.text === "请输入编号"), "a stale rejected editor cannot overwrite the restored draft");
    native.sendEvent("textInput.edit", { id: open.id, editingSession: open.editingSession, revision: 1, jsRevision: open.jsRevision, text: "714", selectionBase: 3, selectionExtent: 3, composingBase: -1, composingExtent: -1 });
    frame = await native.frame();
    frame = await native.tap("提交", frame);
    frame = await native.settle(frame);
    assert.match(textOf(frame), /编号 714/);
    assert.deepEqual(errors, []);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}; phase=${phase}; browserErrors=${JSON.stringify(errors)}`);
  } finally {
    await native?.quit();
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    await browser?.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
