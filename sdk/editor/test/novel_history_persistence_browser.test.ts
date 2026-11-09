import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("editor restores the same draft and history after server restart and rejects changed source, restored backups and stale windows", { timeout: 75_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-persistent-history-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-persistent-history";
  const story = { id: "test.persistent.history", version: 1, start: "start", script: { start: [
    { type: "say", id: "line", text: "Original" }, { type: "ending", id: "end", text: "Done" },
  ] } };
  const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.history", name: projectId, title: "History", version: "0.1.0" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.history", name: projectId, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "story.json"), JSON.stringify(story));
  await writeFile(join(project, "novel.assets.json"), JSON.stringify(assets));
  let server = await startEditor({ port: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  const url = () => `http://127.0.0.1:${server.port}/novel?project=${projectId}`;
  const dialogue = (page: Page) => page.locator("label.nv-field").filter({ hasText: "对白文本" }).locator("textarea");
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    assert.equal((await page.goto(url()))?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    return page;
  };
  const remembered = async (page: Page) => { await page.locator('#novel-history-state[data-phase="saved"]').waitFor(); };
  const value = async (page: Page, expected: string) => {
    await page.waitForFunction(expected => [...document.querySelectorAll("label.nv-field")].some(label =>
      label.textContent?.includes("对白文本") && label.querySelector("textarea")?.value === expected), expected);
  };
  const api = async (page: Page, suffix: string, method = "POST", body?: unknown) => {
    const result = await page.evaluate(async ({ projectId, suffix, method, body }) => {
      const health = await fetch("/health").then(response => response.json());
      const response = await fetch(`/api/projects/${projectId}/novel/${suffix}`, {
        method, headers: { "x-pocket-editor": "1", "x-pocket-csrf": health.csrfToken, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    }, { projectId, suffix, method, body });
    assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.data));
    return result.data;
  };
  try {
    let page = await open();
    await dialogue(page).fill("Edited");
    await remembered(page);
    await page.locator("#novel-save").click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    await remembered(page);
    await page.close();
    server.stop(true);
    server = await startEditor({ port: 0, workspace, projectRoot: project });
    page = await open();
    assert.equal(await dialogue(page).inputValue(), "Edited");
    assert.equal(await page.locator("#novel-undo").isEnabled(), true);
    await page.locator("#novel-undo").click();
    await value(page, "Original");
    await remembered(page);
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].text, "Edited");
    await page.close();

    page = await open();
    assert.equal(await dialogue(page).inputValue(), "Original", "unsaved undo head must be recovered along with its redo stack");
    assert.equal(await page.locator("#novel-save-state").getAttribute("data-dirty"), "true");
    await page.locator("#novel-redo").click();
    await value(page, "Edited");
    await remembered(page);

    const backup = await api(page, "backups");
    await api(page, "backups/restore", "POST", { backupId: backup.backup.id });
    await page.locator("#novel-undo").click();
    await page.locator('#novel-history-state[data-phase="conflict"]').waitFor();
    assert.equal(await dialogue(page).inputValue(), "Edited", "restoring identical source must invalidate a live history context too");
    await page.close();

    page = await open();
    assert.equal(await dialogue(page).inputValue(), "Edited");
    assert.equal(await page.locator("#novel-undo").isDisabled(), true);
    await dialogue(page).fill("Unsaved local");
    await remembered(page);
    const external = structuredClone(story);
    external.script.start[0]!.text = "External file";
    await writeFile(join(project, "story.json"), JSON.stringify(external));
    await page.locator("#novel-undo").click();
    await page.locator('#novel-history-state[data-phase="conflict"]').waitFor();
    assert.equal(await dialogue(page).inputValue(), "Unsaved local");
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].text, "External file");
    await page.close();

    const first = await open();
    const second = await open();
    assert.equal(await dialogue(first).inputValue(), "External file");
    await dialogue(first).fill("First window");
    await remembered(first);
    await dialogue(second).fill("Second window");
    await second.locator('#novel-history-state[data-phase="conflict"]').waitFor();
    assert.equal(await dialogue(second).inputValue(), "Second window", "a rejected older window must keep its local draft for export");
    await first.close();
    await second.close();

    page = await open();
    assert.equal(await dialogue(page).inputValue(), "First window", "the older window must not overwrite the newer journal");
    await dialogue(page).fill("Partial source save");
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    const assetDraft = { ...assets, models: {}, characters: { recovered: {} } };
    await page.locator("#novel-assets-import").setInputFiles({
      name: "novel.assets.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(assetDraft)),
    });
    await page.getByText("资源 JSON 已导入草稿；点击保存才会写入项目 novel.assets.json。", { exact: true }).waitFor();
    await remembered(page);
    await page.route("**/novel/assets", async route => {
      if (route.request().method() === "PUT") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "asset IO interrupted" }) });
      } else await route.continue();
    });
    await page.locator("#novel-save").click();
    await page.getByText("保存失败：asset IO interrupted", { exact: true }).waitFor();
    await remembered(page);
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].text, "Partial source save");
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets);
    await page.close();
    page = await open();
    assert.equal(await dialogue(page).inputValue(), "Partial source save");
    assert.equal(await page.locator("#novel-save-state").getAttribute("data-dirty"), "true");
    await page.locator("#novel-save").click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    await remembered(page);
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assetDraft,
      "a partial source save must reanchor recovery without discarding the remaining asset draft");
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const rawText = 'pocket-vn this is an unfinished "draft';
    await page.getByRole("textbox", { name: "Pocket VN 文本剧本" }).fill(rawText);
    await remembered(page);
    await page.close();
    page = await open();
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Pocket VN 文本剧本" }).inputValue(), rawText);
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].text, "Partial source save", "recovery never implicitly saves source");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
