import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";

const repository = resolve(import.meta.dir, "../../..");
const source = join(repository, "demo/js/apps/lantern");

function copyLanternArt(project: string): void {
  cpSync(join(source, "art"), join(project, "art"), { recursive: true });
}

function stageHiyoriForEditorFixture(project: string): void {
  const scripts = join(project, "scripts");
  mkdirSync(scripts, { recursive: true });
  const stageScript = join(scripts, "prepare_live2d.ts");
  cpSync(join(source, "scripts/prepare_live2d.ts"), stageScript);
  const cubismRoot = join(repository, "sdk/packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5");
  execFileSync(process.execPath, [stageScript], {
    cwd: project,
    env: { ...process.env, CUBISM_SDK_ROOT: cubismRoot },
    stdio: "pipe",
  });
}

test("author edits and persists a line, debugs the same core, builds it and clicks the native Guest", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-author-"));
  const workspace = mkdtempSync(join(tmpdir(), "pocket-novel-author-state-"));
  for (const name of ["app.tsx", "story.ts", "story.json", "revision-map.json", "revision-map-v2.json", "revision-map-v3.json", "revision-map-v4.json", "revision-map-v5.json", "pocket.json", "manifest.json", "package.json", "novel.assets.json", "novel.locales.json", "fonts.json", "images.json", "fonts", "assets", "models"]) cpSync(join(source, name), join(project, name), { recursive: true });
  copyLanternArt(project);
  stageHiyoriForEditorFixture(project);
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "novel-author", appId: "pocket.demo.lantern", name: "Novel Authoring", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const errors: string[] = [];
  const browserEvents: string[] = [];
  const startedAt = Date.now();
  let phase = "browser launch";
  const mark = (next: string): void => {
    phase = next;
    console.log(`[novel author native] ${next} +${Date.now() - startedAt}ms`);
  };
  let browser;
  let diagnosticsPage: import("playwright").Page | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    browser.on("disconnected", () => browserEvents.push("browser disconnected"));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    diagnosticsPage = page;
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("close", () => browserEvents.push("editor page closed"));
    page.on("crash", () => browserEvents.push("editor page crashed"));
    page.on("requestfailed", request => browserEvents.push(`request failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
    await page.goto(origin + "/novel?project=novel-author");
    await page.locator(".nv-instruction").first().waitFor();
    mark("editor loaded");
    const initialStory = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    expect(await page.locator(".nv-instruction").count()).toBe(initialStory.script[initialStory.start].length);
    const line = "Editor input reached the actual compiled Pocket Guest.";
    const originalLine = await page.getByLabel("对白文本", { exact: true }).first().inputValue();
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const textSource = page.getByRole("textbox", { name: "Pocket VN 文本剧本", exact: true });
    await textSource.waitFor();
    await textSource.fill((await textSource.inputValue()).replace(JSON.stringify(originalLine), JSON.stringify(line)));
    await page.getByRole("button", { name: "应用到剧情区块", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".nv-text-status")?.textContent?.includes("文本已应用"));
    mark("text applied to block editor");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    expect(await page.getByLabel("对白文本", { exact: true }).first().inputValue()).toBe(line);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const savedTextStory = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    const editedLineIndex = savedTextStory.script.start.findIndex((instruction: any) => instruction.type === "say" && instruction.text === line);
    expect(editedLineIndex).toBeGreaterThanOrEqual(0);
    expect(savedTextStory.script.start[editedLineIndex].text).toBe(line);
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    expect(await page.getByLabel("对白文本", { exact: true }).first().inputValue()).toBe(line);
    mark("saved story reopened");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(expected => document.querySelector("#novel-preview-location")?.textContent === expected, `start:${editedLineIndex}`);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.waitForFunction(expected => document.querySelector("#novel-live-view")?.textContent?.includes(expected), line);
    expect(await page.locator("#novel-live-view img").count()).toBeGreaterThanOrEqual(3);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    mark("editor preview reached edited line");

    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    const timeoutLabel = page.locator('.nv-graph-node[data-graph-label="signal_timeout"]');
    const timeoutRoute = timeoutLabel.locator('select[data-graph-target="jump"]');
    await timeoutRoute.selectOption("ending_shelter");
    await clickNovelHistory(page, "undo");
    expect(await timeoutLabel.locator('select[data-graph-target="jump"]').inputValue()).toBe("ending_train");
    await clickNovelHistory(page, "redo");
    expect(await timeoutLabel.locator('select[data-graph-target="jump"]').inputValue()).toBe("ending_shelter");
    await timeoutLabel.locator('[data-graph-start="signal_timeout"]').click();
    await clickNovelHistory(page, "undo");
    expect(await page.locator('.nv-graph-node[data-graph-label="start"] [data-graph-start="start"]').getAttribute("disabled")).toBe("");
    await clickNovelHistory(page, "redo");
    expect(await timeoutLabel.locator('[data-graph-start="signal_timeout"]').getAttribute("disabled")).toBe("");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const savedStory = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    expect(savedStory.start).toBe("signal_timeout");
    expect(savedStory.script.signal_timeout.find((instruction: any) => instruction.type === "jump")?.target).toBe("ending_shelter");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    expect(await page.locator('.nv-graph-node[data-graph-label="signal_timeout"] select[data-graph-target="jump"]').inputValue()).toBe("ending_shelter");
    expect(await page.locator('.nv-graph-node[data-graph-label="signal_timeout"] [data-graph-start="signal_timeout"]').getAttribute("disabled")).toBe("");

    mark("starting Guest build");
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    mark("Guest build button click returned");
    await page.waitForFunction(() => /Guest 已构建完成/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 30000 }).catch(async error => {
      let notice = "unavailable: page closed";
      if (!page.isClosed()) notice = await page.locator("#novel-notice").innerText({ timeout: 1000 }).catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
      let persistedStatus = "unavailable: status file not written";
      try { persistedStatus = readFileSync(join(workspace, "states", "novel-author.json"), "utf8"); }
      catch (value) { persistedStatus = `unavailable: ${value instanceof Error ? value.message : String(value)}`; }
      const statusResponse = await fetch(origin + "/api/projects/novel-author/status", { signal: AbortSignal.timeout(1500) }).catch(value => undefined);
      const status = statusResponse ? await statusResponse.text().catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`) : "unavailable: editor status request failed or timed out";
      let statusValue: any;
      try { if (statusResponse?.ok) statusValue = JSON.parse(status); }
      catch { /* Preserve the wait error and raw status body. */ }
      throw new Error(`${error.message}; phase=${phase}; pageClosed=${page.isClosed()}; notice=${notice}; persistedStatus=${persistedStatus}; status=${status}; buildLogs=${JSON.stringify(statusValue?.logs ?? [])}; browserEvents=${JSON.stringify(browserEvents)}; pageErrors=${JSON.stringify(errors)}`);
    });
    mark("Guest build notice visible");
    const status = await (await fetch(origin + "/api/projects/novel-author/status")).json();
    expect(status.builtRevision).toBe(status.revision);
    const preview = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
    preview.setDefaultTimeout(12000);
    preview.setDefaultNavigationTimeout(15000);
    preview.on("pageerror", error => errors.push(error.message));
    await preview.addInitScript(() => {
      const messages: any[] = [];
      (window as any).__novelFrames = messages;
      // Preview is the top document; it emits native frame messages to parent.
      window.addEventListener("message", event => {
        if (event.data?.source === "pocket-editor-preview" && event.data?.type === "preview.frame") {
          messages.push(event.data.frame);
          if (messages.length > 16) messages.splice(0, messages.length - 16);
        }
      });
    });
    await preview.goto(origin + "/api/projects/novel-author/preview");
    await preview.waitForFunction(() => (window as any).__novelFrames.some((f: any) => f.ops?.some((o: any) => o.type === "text" && o.text === "启程 · 开始新的故事")), undefined, { timeout: 10000 }).catch(async error => {
      const status = await fetch(origin + "/api/projects/novel-author/preview/status", { signal: AbortSignal.timeout(1500) }).then(response => response.text()).catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
      const body = preview.isClosed() ? "unavailable: page closed" : await preview.locator("body").innerText({ timeout: 1000 }).catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
      const frames = preview.isClosed() ? "unavailable: page closed" : await preview.evaluate(() => JSON.stringify((window as any).__novelFrames.slice(-1))).catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
      throw new Error(`${error.message}; status=${status}; body=${body}; errors=${JSON.stringify(errors)}; frames=${frames}`);
    });
    mark("native preview frame received");
    const clickNativeText = async (label: string): Promise<void> => {
      mark(`waiting for native text: ${label}`);
      await preview.waitForFunction(expected => (window as any).__novelFrames.some((f: any) => f.ops?.some((o: any) => o.type === "text" && o.text === expected)), label);
      const point = await preview.evaluate(expected => {
        const frames = (window as any).__novelFrames;
        const frame = [...frames].reverse().find((f: any) => f.ops?.some((o: any) => o.type === "text" && o.text === expected));
        const op = frame.ops.find((o: any) => o.type === "text" && o.text === expected);
        return { x: (op.x + op.w / 2) / frame.width, y: (op.y + op.h / 2) / frame.height };
      }, label);
      const canvas = preview.locator("canvas").first();
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("native preview canvas is not visible");
      await canvas.click({ position: { x: point.x * bounds.width, y: point.y * bounds.height } });
      mark(`clicked native text: ${label}`);
    };
    const clickNativeTextContaining = async (substring: string): Promise<void> => {
      mark(`waiting for native text containing: ${substring}`);
      await preview.waitForFunction(expected => (window as any).__novelFrames.some((f: any) => f.ops?.some((o: any) => o.type === "text" && String(o.text).includes(expected))), substring);
      const point = await preview.evaluate(expected => {
        const frames = (window as any).__novelFrames;
        const frame = [...frames].reverse().find((f: any) => f.ops?.some((o: any) => o.type === "text" && String(o.text).includes(expected)));
        const op = frame.ops.find((o: any) => o.type === "text" && String(o.text).includes(expected));
        return { x: (op.x + op.w / 2) / frame.width, y: (op.y + op.h / 2) / frame.height };
      }, substring);
      const canvas = preview.locator("canvas").first();
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("native preview canvas is not visible");
      await canvas.click({ position: { x: point.x * bounds.width, y: point.y * bounds.height } });
      mark(`clicked native text containing: ${substring}`);
    };
    await clickNativeText("启程 · 开始新的故事");
    mark("native start pointer clicked");
    await clickNativeTextContaining("十六秒过去");
    await clickNativeTextContaining("十六秒过去");
    mark("native dialogue pointer clicks completed");
    await preview.waitForFunction(() => (window as any).__novelFrames.some((f: any) => f.ops?.some((o: any) => o.type === "text" && String(o.text).includes("疏散铃压过了中继的低鸣"))), undefined, { timeout: 15000 });
    mark("native pointer progression reached saved signal_timeout branch");
    await preview.waitForFunction(() => (window as any).__novelFrames.some((f: any) => f.ops?.filter((o: any) => o.type === "textureTriangle").length > 10));
    expect(await preview.evaluate(() => (window as any).__novelFrames.some((f: any) => f.ops?.filter((o: any) => o.type === "textureTriangle").length > 10))).toBe(true);
    expect(errors).toEqual([]);
    const screenshots = join(repository, "demo/build/novel-acceptance");
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "editor-verified.png") });
    await preview.locator("canvas").first().screenshot({ path: join(screenshots, "edited-native-guest.png") });
    mark("native acceptance screenshots written");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; pageClosed=${diagnosticsPage?.isClosed() ?? "unavailable"}; browserEvents=${JSON.stringify(browserEvents)}; pageErrors=${JSON.stringify(errors)}`);
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(project, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}, 180000);

test("instruction add/edit/copy/reorder/delete history survives reopen and executes through the pinned Guest input", { timeout: 240_000 }, async () => {
  const projectId = "novel-instruction-workflow";
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-instruction-workflow-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  mkdirSync(project, { recursive: true });
  for (const name of ["app.tsx", "story.ts", "story.json", "revision-map.json", "revision-map-v2.json", "revision-map-v3.json", "revision-map-v4.json", "revision-map-v5.json", "pocket.json", "manifest.json", "package.json", "novel.assets.json", "novel.locales.json", "fonts.json", "images.json", "fonts", "assets", "models"]) cpSync(join(source, name), join(project, name), { recursive: true });
  copyLanternArt(project);
  stageHiyoriForEditorFixture(project);
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "pocket.demo.lantern", name: "Instruction Workflow", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));

  const repository = resolve(import.meta.dir, "../../..");
  const toolsPackage = process.env.POCKET_TOOLS_PACKAGE || join(repository, "sdk/.pocket-build/highres-native-tools-20261107");
  const nativeProbe = process.env.POCKET_NATIVE_PROBE || join(toolsPackage, "bin/pocket_probe");
  const previousToolsPackage = process.env.POCKET_TOOLS_PACKAGE;
  const previousNativeProbe = process.env.POCKET_NATIVE_PROBE;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "editor start";
  const errors: string[] = [];

  const instructionCardById = async (page: import("playwright").Page, id: string) => {
    const cards = page.locator(".nv-instruction");
    for (let index = 0; index < await cards.count(); index++) {
      const card = cards.nth(index);
      if (await card.getByLabel("稳定对白 ID", { exact: true }).count() === 0) continue;
      if (await card.getByLabel("稳定对白 ID", { exact: true }).inputValue() === id) return card;
    }
    throw new Error(`instruction ${id} is not present in the rendered editor list`);
  };
  const instructionIndex = async (page: import("playwright").Page, id: string): Promise<number> => page.locator(".nv-instruction").evaluateAll((cards, expectedId) => cards.findIndex(card => (card.querySelector('[aria-label="稳定对白 ID"]') as HTMLInputElement | null)?.value === expectedId), id);
  const waitInstructionIndex = async (page: import("playwright").Page, id: string, expected: number): Promise<void> => {
    await page.waitForFunction(({ id, expected }) => {
      const cards = [...document.querySelectorAll(".nv-instruction")];
      return cards.findIndex(card => (card.querySelector('[aria-label="稳定对白 ID"]') as HTMLInputElement | null)?.value === id) === expected;
    }, { id, expected });
  };
  const waitNativeText = async (session: NativeSession, initial: Awaited<ReturnType<NativeSession["boot"]>>, fragment: string, maxFrames = 240) => {
    let frame = initial;
    for (let index = 0; index < maxFrames; index++) {
      if (textOf(frame).replace(/\s+/g, "").includes(fragment.replace(/\s+/g, ""))) return frame;
      frame = await session.frame();
    }
    throw new Error(`native Guest did not paint ${JSON.stringify(fragment)}; frame=${textOf(frame)}`);
  };
  const viewportLayerSignature = (frame: Awaited<ReturnType<NativeSession["boot"]>>): string => JSON.stringify((frame.ops ?? [])
    .filter(op => op.type === "rect" && op.x === 0 && op.y === 0 && op.w === frame.width && op.h === frame.height)
    .map(op => op.color));
  const waitForViewportLayersStable = async (session: NativeSession, initial: Awaited<ReturnType<NativeSession["boot"]>>) => {
    let frame = initial;
    let previous: string | undefined;
    let stable = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      const signature = viewportLayerSignature(frame);
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return frame;
      frame = await session.frame();
    }
    throw new Error(`native scene transition did not settle before the pointer action; frame=${textOf(frame)}`);
  };
  const tapNativeTextContaining = async (session: NativeSession, initial: Awaited<ReturnType<NativeSession["boot"]>>, fragment: string) => {
    const frame = await waitForViewportLayersStable(session, await waitNativeText(session, initial, fragment));
    const normalized = fragment.replace(/\s+/g, "");
    const matches = (frame.ops ?? []).filter(op => op.type === "text" && (op.text ?? "").replace(/\s+/g, "").includes(normalized));
    expect(matches, `the real Guest should paint one tappable text fragment for ${JSON.stringify(fragment)}: ${textOf(frame)}`).toHaveLength(1);
    return session.tap(matches[0].text!, frame);
  };
  const waitNativeContinue = async (session: NativeSession, initial: Awaited<ReturnType<NativeSession["boot"]>>) => {
    let frame = initial;
    for (let index = 0; index < 240; index++) {
      const continueOp = (frame.ops ?? []).find(op => op.type === "text" && op.text?.includes("轻触继续"));
      if (continueOp?.text) return { frame, label: continueOp.text };
      frame = await session.frame();
    }
    throw new Error(`native dialogue did not reach its continue affordance; frame=${textOf(frame)}`);
  };

  try {
    process.env.POCKET_TOOLS_PACKAGE = toolsPackage;
    process.env.POCKET_NATIVE_PROBE = nativeProbe;
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();

    phase = "choose reveal and edit its direction through shared history";
    await page.locator(".nv-label-name").filter({ hasText: /^feature_tour$/ }).click();
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "feature_tour");
    const revealScene = page.locator(".nv-instruction").first();
    const transitionKind = revealScene.getByLabel("转场", { exact: true });
    expect(await transitionKind.inputValue()).toBe("fade");
    await transitionKind.selectOption("reveal");
    expect(await revealScene.getByLabel("转场", { exact: true }).inputValue()).toBe("reveal");
    const revealDirection = page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true });
    expect(await revealDirection.inputValue()).toBe("left", "left is the default when a reveal direction is omitted");
    await revealDirection.selectOption("down");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).inputValue()).toBe("down");
    await clickNovelHistory(page, "undo");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).inputValue()).toBe("left");
    await clickNovelHistory(page, "undo");
    expect(await page.locator(".nv-instruction").first().getByLabel("转场", { exact: true }).inputValue()).toBe("fade");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).count()).toBe(0);
    await clickNovelHistory(page, "redo");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).inputValue()).toBe("left");
    await clickNovelHistory(page, "redo");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).inputValue()).toBe("down");

    phase = "select executable input label";
    await page.locator(".nv-label-name").filter({ hasText: /^feature_tour_input$/ }).click();
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "feature_tour_input");
    expect(await page.locator(".nv-instruction").count()).toBe(4);
    const originalTourInput = JSON.parse(readFileSync(join(project, "story.json"), "utf8")).script.feature_tour_input;
    const originalStoryStart = JSON.parse(readFileSync(join(project, "story.json"), "utf8")).start;

    phase = "add and edit one say instruction";
    await page.locator(".nv-add-select").selectOption("say");
    await page.waitForFunction(() => document.querySelectorAll(".nv-instruction").length === 5);
    const added = page.locator(".nv-instruction").nth(4);
    await added.getByLabel("稳定对白 ID", { exact: true }).fill("e01_workflow_line");
    await added.getByLabel("对白文本", { exact: true }).fill("Original copy source from the Editor.");
    expect(await added.getByLabel("稳定对白 ID", { exact: true }).inputValue()).toBe("e01_workflow_line");
    expect(await added.getByLabel("对白文本", { exact: true }).inputValue()).toBe("Original copy source from the Editor.");

    phase = "copy, edit copy and reorder it";
    await added.getByRole("button", { name: "复制", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".nv-instruction").length === 6);
    const copyId = "e01_workflow_line_copy";
    let copy = await instructionCardById(page, copyId);
    expect(await copy.getByLabel("对白文本", { exact: true }).inputValue()).toBe("Original copy source from the Editor.");
    await copy.getByLabel("对白文本", { exact: true }).fill("E01.2 final authored line before input.");
    expect(await (await instructionCardById(page, "e01_workflow_line")).getByLabel("对白文本", { exact: true }).inputValue()).toBe("Original copy source from the Editor.");
    expect(await instructionIndex(page, copyId)).toBe(5);
    copy = await instructionCardById(page, copyId);
    await copy.locator(".nv-instruction-controls button").nth(0).click();
    await waitInstructionIndex(page, copyId, 4);
    expect(await instructionIndex(page, "e01_workflow_line")).toBe(5);

    phase = "delete, undo and redo the original instruction";
    const original = await instructionCardById(page, "e01_workflow_line");
    await original.locator(".nv-instruction-controls button").nth(3).click();
    await page.waitForFunction(() => document.querySelectorAll(".nv-instruction").length === 5);
    expect(await instructionIndex(page, "e01_workflow_line")).toBe(-1);
    await clickNovelHistory(page, "undo");
    await page.waitForFunction(() => document.querySelectorAll(".nv-instruction").length === 6);
    expect(await instructionIndex(page, "e01_workflow_line")).toBe(5);
    expect(await instructionIndex(page, copyId)).toBe(4);
    expect(await (await instructionCardById(page, "e01_workflow_line")).getByLabel("对白文本", { exact: true }).inputValue()).toBe("Original copy source from the Editor.");
    await clickNovelHistory(page, "redo");
    await page.waitForFunction(() => document.querySelectorAll(".nv-instruction").length === 5);
    expect(await instructionIndex(page, "e01_workflow_line")).toBe(-1);

    phase = "reorder the surviving copy before the live input";
    for (let expected = 3; expected >= 0; expected--) {
      const card = await instructionCardById(page, copyId);
      await card.locator(".nv-instruction-controls button").nth(0).click();
      await waitInstructionIndex(page, copyId, expected);
    }
    expect(await (await instructionCardById(page, copyId)).getByLabel("对白文本", { exact: true }).inputValue()).toBe("E01.2 final authored line before input.");

    phase = "localize the new stable dialogue ID through the Editor";
    await page.getByRole("button", { name: "文本本地化", exact: true }).click();
    const copyTranslation = page.getByLabel(`对白 ${copyId}`, { exact: true });
    await copyTranslation.waitFor();
    await copyTranslation.fill("A line written in the instruction editor.");
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    expect(JSON.parse(readFileSync(join(project, "novel.locales.json"), "utf8")).catalogs.en.lines[copyId]).toBe("A line written in the instruction editor.");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();

    phase = "save and reopen the same instruction order";
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const storyPath = join(project, "story.json");
    const savedStory = JSON.parse(readFileSync(storyPath, "utf8"));
    expect(savedStory.start).toBe(originalStoryStart);
    expect(savedStory.script.feature_tour_input.map((instruction: any) => instruction.type === "jump" ? [instruction.type, instruction.target] : [instruction.type, instruction.id])).toEqual([
      ["say", copyId], ["say", "tour_05"], ["input", "tour_note"], ["say", "tour_06"], ["jump", "feature_tour_finish"],
    ]);
    expect(savedStory.script.feature_tour_input[0]).toEqual({ type: "say", id: copyId, speaker: "旁白", text: "E01.2 final authored line before input." });
    expect(savedStory.script.feature_tour_input.slice(1)).toEqual(originalTourInput);
    expect(savedStory.script.feature_tour_input.some((instruction: any) => instruction.id === "e01_workflow_line")).toBe(false);
    expect(savedStory.script.feature_tour[0].transition).toEqual({ kind: "reveal", direction: "down", durationMs: 500 });
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.locator(".nv-label-name").filter({ hasText: /^feature_tour_input$/ }).click();
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "feature_tour_input");
    expect(await page.getByLabel("稳定对白 ID", { exact: true }).first().inputValue()).toBe(copyId);
    expect(await page.getByLabel("对白文本", { exact: true }).first().inputValue()).toBe("E01.2 final authored line before input.");
    await page.locator(".nv-label-name").filter({ hasText: /^feature_tour$/ }).click();
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "feature_tour");
    expect(await page.locator(".nv-instruction").first().getByLabel("转场", { exact: true }).inputValue()).toBe("reveal");
    expect(await page.locator(".nv-instruction").first().getByLabel("揭示方向", { exact: true }).inputValue()).toBe("down");
    expect(JSON.parse(readFileSync(storyPath, "utf8"))).toEqual(savedStory);

    phase = "pinned buildGuest";
    const buildButton = page.getByRole("button", { name: "构建 Guest", exact: true });
    const diagnostics = await page.locator("#novel-diagnostics").innerText();
    console.log(`[E01.2 pre-build diagnostics] ${JSON.stringify({ enabled: await buildButton.isEnabled(), diagnostics })}`);
    expect(await buildButton.isEnabled(), `Editor validation must permit the saved instruction workflow Guest: ${diagnostics}`).toBe(true);
    await buildButton.click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120000 });
    const buildNotice = await page.locator("#novel-notice").innerText();
    if (!buildNotice.includes("Guest 已构建完成")) {
      const failedBuildStatus = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as any;
      throw new Error(`${buildNotice}; build logs=${JSON.stringify(failedBuildStatus.logs ?? [])}`);
    }
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as any;
    expect(status.builtRevision).toBe(status.revision);
    const artifact = join(workspace, "builds", projectId, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata.entryFormat).toBe("quickjs-bytecode");
    const bytecodePath = join(artifact, "app.qjbc");
    const pakPath = join(artifact, "app.pak");
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    console.log(`[E01.2 pinned Guest] ${JSON.stringify({ projectId, builtRevision: status.builtRevision, storySha256: hash(storyPath), qjbcSha256: hash(bytecodePath), pakSha256: hash(pakPath), finalInstructionIds: savedStory.script.feature_tour_input.map((instruction: any) => instruction.id ?? null) })}`);

    phase = "NativeSession actual input and execution";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, {
      width: 360,
      height: 640,
      deadlineMs: 90_000,
      memory: { heapLimitBytes: 134_217_728, maxPakBytes: 75_497_472 },
    });
    let frame = await native.boot();
    frame = await native.tap("5分钟能力巡演", frame);
    frame = await waitNativeText(native, frame, "欢迎来到雾港的五分钟巡演");
    let ready = await waitNativeContinue(native, frame);
    frame = await native.tap(ready.label, ready.frame);
    frame = await waitNativeText(native, frame, "镜头正在缓慢靠近站台");
    ready = await waitNativeContinue(native, frame);
    frame = await native.tap(ready.label, ready.frame);
    frame = await waitNativeText(native, frame, "先体验哪一段");
    frame = await tapNativeTextContaining(native, frame, "留一句话");
    frame = await waitNativeText(native, frame, "E01.2 final authored line before input.");
    ready = await waitNativeContinue(native, frame);
    frame = await native.tap(ready.label, ready.frame);
    frame = await waitNativeText(native, frame, "你可以留下一句短话");
    ready = await waitNativeContinue(native, frame);
    frame = await native.tap(ready.label, ready.frame);
    frame = await waitNativeText(native, frame, "一句话即可");
    const field = (frame.ops ?? []).find(op => op.type === "text" && op.text === "一句话即可");
    expect(field, `the compiled input field must paint: ${textOf(frame)}`).toBeDefined();
    const point = { x: field!.x! + field!.w! / 2, y: field!.y! + field!.h! / 2 };
    native.sendEvent("input.pointer", { phase: "down", id: 0, ...point });
    const down = await native.frame();
    native.sendEvent("input.pointer", { phase: "up", id: 0, ...point });
    frame = await native.frame();
    const opened = [...(down.events ?? []), ...(frame.events ?? [])].find(event => event.name === "textInput.open")?.payload;
    expect(opened, "the saved Guest input opens through the real native textInput.open protocol").toBeDefined();
    native.sendEvent("textInput.edit", {
      id: opened!.id,
      editingSession: opened!.editingSession,
      revision: opened!.revision + 1,
      jsRevision: opened!.jsRevision,
      text: "EditorWorkflow714",
      selectionBase: 17,
      selectionExtent: 17,
      composingBase: -1,
      composingExtent: -1,
    });
    frame = await native.frame();
    frame = await native.tap("提交", frame);
    frame = await waitNativeText(native, frame, "EditorWorkflow714");
    expect(textOf(frame).replace(/\s+/g, "")).toContain("雾窗把你的话带回眼前：EditorWorkflow714");
    expect(errors).toEqual([]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; browserErrors=${JSON.stringify(errors)}`);
  } finally {
    await native?.quit();
    await browser?.close();
    await server?.stop(true);
    if (previousToolsPackage === undefined) delete process.env.POCKET_TOOLS_PACKAGE; else process.env.POCKET_TOOLS_PACKAGE = previousToolsPackage;
    if (previousNativeProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousNativeProbe;
    rmSync(temporary, { recursive: true, force: true });
  }
}, 240_000);

test("model assets load official Spine data and paint animated PMS1 meshes through the shared TEX_TRI projector", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-model-author-"));
  const workspace = mkdtempSync(join(tmpdir(), "pocket-novel-model-state-"));
  for (const name of ["app.tsx", "story.ts", "story.json", "revision-map.json", "revision-map-v2.json", "revision-map-v3.json", "revision-map-v4.json", "revision-map-v5.json", "pocket.json", "manifest.json", "package.json", "novel.assets.json", "novel.locales.json", "fonts.json", "images.json", "fonts", "assets", "models"]) cpSync(join(source, name), join(project, name), { recursive: true });
  copyLanternArt(project);
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "novel-model-author", appId: "pocket.demo.lantern", name: "Novel Model Authoring", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const errors: string[] = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=novel-model-author`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    const card = page.locator('.nv-model-card[data-model-key="mira_spine"]');
    await card.waitFor();
    await card.getByRole("button", { name: "读取模型信息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.nv-model-card[data-model-key="mira_spine"] .nv-model-info')?.textContent?.includes("idle"));
    expect(await card.locator(".nv-model-info").innerText()).toContain("alert");
    await card.getByLabel("预览动作").selectOption("alert");
    await card.getByRole("button", { name: "实时预览", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.nv-model-card[data-model-key="mira_spine"] .nv-model-preview-status')?.textContent?.includes("Spine 官方运行库"), undefined, { timeout: 15000 }).catch(async error => {
      throw new Error(`${error.message}; status=${await card.locator(".nv-model-preview-status").innerText()}; errors=${JSON.stringify(errors)}`);
    });
    const canvas = card.locator(".nv-model-preview-canvas");
    const initial = await canvas.evaluate(element => {
      const context = (element as HTMLCanvasElement).getContext("2d")!;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let colored = 0;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] !== 16 || pixels[index + 1] !== 23 || pixels[index + 2] !== 19) colored++;
        hash = Math.imul(hash ^ pixels[index]!, 16777619);
      }
      return { colored, hash: hash >>> 0 };
    });
    expect(initial.colored).toBeGreaterThan(1000);
    await page.waitForTimeout(450);
    const next = await canvas.evaluate(element => {
      const context = (element as HTMLCanvasElement).getContext("2d")!;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) hash = Math.imul(hash ^ pixels[index]!, 16777619);
      return hash >>> 0;
    });
    expect(next).not.toBe(initial.hash);
    expect(errors).toEqual([]);
    await card.getByRole("button", { name: "停止预览", exact: true }).click();
    expect(await card.locator(".nv-model-preview-status").innerText()).toContain("已停止");

    page.once("dialog", dialog => { void dialog.accept("second_model"); });
    await page.getByRole("button", { name: "＋ 添加模型", exact: true }).click();
    let secondModel = page.locator('.nv-model-card[data-model-key="second_model"]');
    await secondModel.waitFor();
    await secondModel.getByLabel("Spine Skeleton 路径").fill("models/mira.spine.json");
    expect(await secondModel.getByLabel("Spine Skeleton 路径").inputValue()).toBe("models/mira.spine.json");
    await secondModel.getByLabel("Spine Atlas 路径").fill("models/mira.atlas");
    const actualAtlas = await secondModel.getByLabel("Spine Atlas 路径").inputValue();
    expect(actualAtlas).toBe("models/mira.atlas");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const savedSecond = JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")).models.second_model;
    expect(savedSecond.source).toBe("models/mira.spine.json");
    expect(savedSecond.atlas).toBe("models/mira.atlas");
    const modelSourceResponse = await fetch(`http://127.0.0.1:${server.port}/api/projects/novel-model-author/novel/models/source?key=second_model`);
    expect(modelSourceResponse.status).toBe(200, await modelSourceResponse.text());
    await secondModel.getByRole("button", { name: "读取模型信息", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-model-card")].some(card => card.getAttribute("data-model-key") === "second_model" && card.querySelector(".nv-model-info")?.textContent?.includes("idle")), undefined, { timeout: 5000 }).catch(async error => {
      throw new Error(`${error.message}; notice=${await page.locator("#novel-notice").innerText()}; model=${await secondModel.innerText()}; errors=${JSON.stringify(errors)}`);
    });
    for (const textureRow of await secondModel.locator(".nv-model-texture-row").all()) {
      const pageName = (await textureRow.locator("code").innerText()).trim();
      await textureRow.getByLabel("项目内贴图路径").fill(`art/${pageName}`);
    }
    await secondModel.getByLabel("动作清单（每行一个，也可逗号分隔）").fill("idle\nalert\nsettle");
    await secondModel.getByLabel("模型键").fill("mira_second");
    secondModel = page.locator('.nv-model-card[data-model-key="mira_second"]');
    expect(await secondModel.getByLabel("模型键").inputValue()).toBe("mira_second");
    await secondModel.waitFor();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    secondModel = page.locator('.nv-model-card[data-model-key="second_model"]');
    await secondModel.waitFor();
    expect(await secondModel.getByLabel("模型键").inputValue()).toBe("second_model");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    secondModel = page.locator('.nv-model-card[data-model-key="mira_second"]');
    await secondModel.waitFor();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")).models.mira_second.animations).toEqual(["idle", "alert", "settle"]);
    await secondModel.getByRole("button", { name: "移除模型", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")).models.mira_second).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(project, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}, 60000);
