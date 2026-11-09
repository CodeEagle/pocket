import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

const projectId = "novel-graph-test";
const story = {
  id: "test.graph",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "line", speaker: "旁白", text: "你好。" },
      { type: "jump", target: "first" },
      { type: "call", target: "first" },
      { type: "branch", when: { op: "truthy", value: { type: "literal", value: true } }, then: "first", else: "second" },
      { type: "choice", id: "choice", prompt: "去哪里？", timeLimitMs: 10000, timeoutTarget: "first", options: [{ id: "option", text: "继续", target: "first" }] },
    ],
    first: [{ type: "say", id: "first_line", speaker: "Mira", text: "第一条路线。" }],
    second: [{ type: "ending", id: "second_end", text: "第二条路线。" }],
  },
};
const assets = {
  backgrounds: {},
  characters: {},
  cgs: {},
  audio: { voice_test: "audio/voice_test.wav" },
};

test("graph edits canonical starts and every route edge with undo/redo, save/reopen and optional voice cue", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-graph-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  await mkdir(join(project, "assets", "audio"), { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.novel", name: projectId, version: "0.1.0" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel", name: projectId, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(join(project, "assets", "audio", "voice_test.wav"), Buffer.alloc(44));

  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  const browserEvents: string[] = [];
  const startedAt = Date.now();
  let phase = "editor navigation";
  const mark = (next: string): void => {
    phase = next;
    console.log(`[novel graph browser] ${next} +${Date.now() - startedAt}ms`);
  };
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("close", () => browserEvents.push("editor page closed"));
  page.on("crash", () => browserEvents.push("editor page crashed"));
  page.on("requestfailed", request => browserEvents.push(`request failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
  browser.on("disconnected", () => browserEvents.push("browser disconnected"));
  const route = (kind: string) => page.locator(`.nv-graph-node[data-graph-label="start"] select[data-graph-target="${kind}"]`);
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    mark("editor loaded");

    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    mark("graph panel opened");
    await route("jump").selectOption("second");
    await route("call").selectOption("second");
    await route("branch-then").selectOption("second");
    await route("branch-else").selectOption("start");
    await route("choice-option-0").selectOption("second");
    await route("choice-timeout").selectOption("second");
    assert.equal(await route("jump").inputValue(), "second");
    assert.equal(await route("call").inputValue(), "second");
    assert.equal(await route("branch-then").inputValue(), "second");
    assert.equal(await route("branch-else").inputValue(), "start");
    assert.equal(await route("choice-option-0").inputValue(), "second");
    assert.equal(await route("choice-timeout").inputValue(), "second");
    mark("all route edges edited");

    await clickNovelHistory(page, "undo");
    assert.equal(await route("choice-timeout").inputValue(), "first");
    await clickNovelHistory(page, "redo");
    assert.equal(await route("choice-timeout").inputValue(), "second");
    mark("route undo redo passed");

    await page.locator('.nv-graph-node[data-graph-label="second"] [data-graph-start="second"]').click();
    assert.equal(await page.locator('.nv-graph-node[data-graph-label="second"]').getByRole("button", { name: "当前起点", exact: true }).count(), 1);
    await clickNovelHistory(page, "undo");
    assert.equal(await page.locator('.nv-graph-node[data-graph-label="start"] [data-graph-start="start"]').getAttribute("disabled"), "");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.locator('.nv-graph-node[data-graph-label="second"] [data-graph-start="second"]').getAttribute("disabled"), "");
    mark("start label undo redo passed");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = JSON.parse(await readFile(join(project, "story.json"), "utf8"));
    assert.equal(saved.start, "second");
    assert.equal(saved.script.start[1].target, "second");
    assert.equal(saved.script.start[2].target, "second");
    assert.equal(saved.script.start[3].then, "second");
    assert.equal(saved.script.start[3].else, "start");
    assert.equal(saved.script.start[4].options[0].target, "second");
    assert.equal(saved.script.start[4].timeoutTarget, "second");
    mark("graph changes saved");

    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    assert.equal(await route("jump").inputValue(), "second");
    assert.equal(await route("call").inputValue(), "second");
    assert.equal(await route("branch-then").inputValue(), "second");
    assert.equal(await route("branch-else").inputValue(), "start");
    assert.equal(await route("choice-option-0").inputValue(), "second");
    assert.equal(await route("choice-timeout").inputValue(), "second");
    mark("saved graph reopened");

    await page.locator('.nv-graph-node[data-graph-label="start"] [aria-label="打开标签 start 的指令"]').click();
    await page.locator(".nv-instruction").first().waitFor();
    const voice = () => page.locator(".nv-instruction").first().locator("label.nv-field").filter({ hasText: "语音 Cue" }).locator("select");
    assert.equal(await voice().count(), 1, await page.locator("#novel-editor").innerText());
    await voice().selectOption("voice_test");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const withVoice = JSON.parse(await readFile(join(project, "story.json"), "utf8"));
    assert.equal(withVoice.script.start[0].voice, "voice_test");
    mark("voice cue added and saved");

    await voice().selectOption("");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const withoutVoice = JSON.parse(await readFile(join(project, "story.json"), "utf8"));
    assert.equal(Object.hasOwn(withoutVoice.script.start[0], "voice"), false);
    mark("voice cue cleared and saved");

    await page.getByRole("button", { name: "文本本地化", exact: true }).click();
    await page.locator("#novel-localization-panel .nv-locale-workspace").waitFor({ timeout: 8000 }).catch(async error => {
      throw new Error(`${error.message}; panel=${await page.locator("#novel-localization-panel").innerText()}; errors=${JSON.stringify(errors)}`);
    });
    await page.getByLabel("新语言标签", { exact: true }).waitFor();
    assert.equal(await page.locator("#novel-localization-styles").count(), 1);
    assert.deepEqual(errors, []);
    mark("localization panel loaded");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; pageClosed=${page.isClosed()}; browserEvents=${JSON.stringify(browserEvents)}; pageErrors=${JSON.stringify(errors)}`);
  } finally {
    await page.close();
    await browser.close();
    server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
