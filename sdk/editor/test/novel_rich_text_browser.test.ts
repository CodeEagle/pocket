import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

test("Editor rich dialogue ranges share say.text, preserve authoring roundtrips, and activate notes at a local pause", { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-rich-text-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-rich-roundtrip";
  const storyPath = join(project, "story.json");
  const story = {
    id: "test.rich-roundtrip",
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "say", id: "letter", speaker: "旁白", text: "A😀BC" },
        { type: "ending", id: "end", text: "Rich text preview complete." },
      ],
    },
  };
  const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.novel.rich", name: "Rich Text Authoring", version: "0.1.0", build: 1, entry: "app.tsx" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel.rich", name: "Rich Text Authoring", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(project, "app.tsx"), 'import { render } from "solid-js/web";\nrender(() => null, document.body);\n');
  writeFileSync(storyPath, `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const pageErrors: string[] = [];
  const readStory = () => JSON.parse(readFileSync(storyPath, "utf8"));
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();

    const card = page.locator(".nv-instruction").first();
    const text = card.locator('label.nv-field').filter({ hasText: "对白文本" }).locator("textarea");
    await text.evaluate(element => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(1, 4);
      input.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await card.locator("[data-add-say-rich-span]").click();
    let span = page.locator("[data-rich-span-id]").first();
    await span.waitFor();
    expect(await span.getByLabel("开始字符（含）").inputValue()).toBe("1");
    expect(await span.getByLabel("结束字符（不含）").inputValue()).toBe("3");
    const spanId = await span.getByLabel("范围 ID").inputValue();
    expect(spanId).toMatch(/^span_/);

    await clickNovelHistory(page, "undo");
    await page.locator("[data-rich-span-id]").waitFor({ state: "detached" });
    await clickNovelHistory(page, "redo");
    span = page.locator("[data-rich-span-id]").first();
    await span.waitFor();
    expect(await span.getByLabel("范围 ID").inputValue()).toBe(spanId);

    const end = span.getByLabel("结束字符（不含）");
    await end.fill("1");
    await page.locator(".nv-rich-diagnostic.error").waitFor();
    await page.locator("#novel-diagnostics").getByText(/script\.start\[0\]\.rich/).waitFor();
    await end.fill("3");
    await page.waitForFunction(() => !document.querySelector(".nv-rich-diagnostic.error"));
    expect(await end.evaluate(element => document.activeElement === element)).toBe(true);

    await span.getByLabel("文本颜色").selectOption("accent");
    await span.getByLabel("字重").selectOption("strong");
    await span.getByLabel("注音（Ruby）").fill("ねこ");
    await span.getByRole("button", { name: "添加内部注释", exact: true }).click();
    span = page.locator("[data-rich-span-id]").first();
    await span.getByLabel("内部注释标题").fill("Harbor note");
    await span.getByLabel("内部注释正文").fill("The return mark points back to the first page.");

    await text.evaluate(element => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await card.locator("[data-add-say-rich-pause]").click();
    let pause = page.locator("[data-rich-pause-id]").first();
    await pause.waitFor();
    expect(await pause.getByLabel("停顿位置（Unicode 字符）").inputValue()).toBe("3");
    expect(await pause.getByLabel("停顿方式").inputValue()).toBe("manual");
    const pauseId = await pause.getByLabel("停顿 ID").inputValue();
    await page.waitForFunction(() => !document.querySelector("#novel-diagnostics")?.textContent?.includes("个错误"));

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    let savedRich = readStory().script.start[0].rich;
    expect(savedRich.spans).toEqual([{
      id: spanId,
      start: 1,
      end: 3,
      style: { color: "accent", emphasis: "strong" },
      ruby: "ねこ",
      link: { title: "Harbor note", text: "The return mark points back to the first page." },
    }]);
    expect(savedRich.pauses).toEqual([{ id: pauseId, at: 3, durationMs: null }]);

    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    span = page.locator("[data-rich-span-id]").first();
    expect(await span.getByLabel("范围 ID").inputValue()).toBe(spanId);
    expect(await page.locator("[data-rich-pause-id]").first().getByLabel("停顿 ID").inputValue()).toBe(pauseId);

    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const authoring = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await authoring.waitFor();
    const authoringText = await authoring.inputValue();
    expect(authoringText).toContain('"rich":{"spans":[{"id":"');
    const textDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出当前文本", exact: true }).click();
    const textDownload = await textDownloadPromise;
    const textPath = await textDownload.path();
    const exportedText = readFileSync(textPath!, "utf8");
    expect(exportedText).toContain('"rich":{"spans":[{"id":"');
    const changedText = exportedText.replace('"speaker":"旁白"', '"speaker":"旁白·页边"');
    expect(changedText).not.toBe(exportedText);
    const textChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入文本", exact: true }).click();
    const textChooser = await textChooserPromise;
    await textChooser.setFiles({ name: "rich.pvn.txt", mimeType: "text/plain", buffer: Buffer.from(changedText) });
    await page.waitForFunction(() => document.querySelector(".nv-text-source")?.value.includes("旁白·页边"));
    await page.getByRole("button", { name: "应用到剧情区块", exact: true }).click();
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator(".nv-instruction").first().waitFor();
    await page.waitForFunction(() => (document.querySelector('.nv-instruction input[aria-label="角色/旁白"]') as HTMLInputElement | null)?.value === "旁白·页边");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(readStory().script.start[0].speaker).toBe("旁白·页边");
    expect(readStory().script.start[0].rich).toEqual(savedRich);

    const format = page.getByLabel("剧本导出格式");
    await format.selectOption("table-csv");
    const csvDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 表格 CSV", exact: true }).click();
    const csvDownload = await csvDownloadPromise;
    const csvPath = await csvDownload.path();
    const csvBytes = readFileSync(csvPath!);
    expect(csvBytes.toString("utf8")).toContain('"rich"');
    const csvChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入剧本", exact: true }).click();
    const csvChooser = await csvChooserPromise;
    await csvChooser.setFiles({ name: "rich-story.csv", mimeType: "text/csv", buffer: csvBytes });
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "未保存");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(readStory().script.start[0].rich).toEqual(savedRich);

    await format.selectOption("json");
    const jsonDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonPath = await jsonDownload.path();
    const jsonBytes = readFileSync(jsonPath!);
    expect(JSON.parse(jsonBytes.toString("utf8")).script.start[0].rich).toEqual(savedRich);
    const jsonChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入剧本", exact: true }).click();
    const jsonChooser = await jsonChooserPromise;
    await jsonChooser.setFiles({ name: "rich-story.json", mimeType: "application/json", buffer: jsonBytes });
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "未保存");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(readStory().script.start[0].rich).toEqual(savedRich);

    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    const previewLink = page.locator(`[data-say-link-id="${spanId}"]`);
    await page.waitForFunction(id => {
      const link = document.querySelector(`[data-say-link-id="${CSS.escape(id)}"]`) as HTMLButtonElement | null;
      return Boolean(link && !link.disabled && document.querySelector("[data-say-pause-release]"));
    }, spanId);
    expect(await page.locator("#novel-preview-location").innerText()).toBe("start:0");
    await previewLink.click();
    const note = page.locator("dialog.nv-preview-note");
    await page.waitForFunction(() => document.querySelector("dialog.nv-preview-note")?.open === true);
    expect(await note.locator(".nv-preview-note-body").innerText()).toBe("The return mark points back to the first page.");
    expect(await page.locator(".nv-preview-dialogue").innerText()).toContain("手动停顿");
    expect(await page.locator("#novel-preview-location").innerText()).toBe("start:0");
    await note.getByRole("button", { name: "关闭注释并继续", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("dialog.nv-preview-note")?.open !== true);
    expect(await page.locator("[data-say-pause-release]").isVisible()).toBe(true);
    expect(await page.locator("#novel-preview-location").innerText()).toBe("start:0");
    await page.locator("[data-say-pause-release]").click();
    expect(await page.locator("#novel-preview-location").innerText()).toBe("start:0");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
