import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

test("text authoring preserves draft conflicts across remounts, imports and exports, and reports JSON source locations", { timeout: 60_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-text-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-text-roundtrip";
  const story = {
    id: "test.text-roundtrip",
    version: 1,
    start: "start",
    credits: { writer: "Mira", tags: ["coast", { chapter: 1 }] },
    script: {
      start: [
        { type: "say", id: "arrival", speaker: "Mira", text: "Original line", voice: "arrival", custom: { color: "teal" } },
        { type: "ending", id: "end", text: "The end." },
      ],
    },
  };
  const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.novel.text", name: "Text Authoring", version: "0.1.0", build: 1, entry: "app.tsx" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel.text", name: "Text Authoring", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(project, "app.tsx"), 'import { render } from "solid-js/web";\nrender(() => null, document.body);\n');
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  let browser;
  const pageErrors: string[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();

    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const source = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await source.waitFor();
    const originalText = await source.inputValue();
    expect(originalText).toContain('"credits":{"writer":"Mira","tags":["coast",{"chapter":1}]}');
    expect(originalText).toContain('say {"id":"arrival","speaker":"Mira","text":"Original line","voice":"arrival","custom":{"color":"teal"}}');

    const edited = originalText.replace("Original line", "Edited from text mode");
    await source.fill(edited);
    await page.getByRole("button", { name: "应用到剧情区块", exact: true }).click();
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    const blockText = page.locator('label.nv-field').filter({ hasText: "对白文本" }).locator("textarea");
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited from text mode", undefined, { timeout: 8000 }).catch(async error => {
      throw new Error(`${error.message}; body=${await page.locator("body").innerText()}`);
    });
    expect(await blockText.inputValue()).toBe("Edited from text mode");
    expect(await page.locator(".nv-instruction").count()).toBe(2);

    await clickNovelHistory(page, "undo");
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Original line");
    expect(await blockText.inputValue()).toBe("Original line");
    await clickNovelHistory(page, "redo");
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited from text mode");
    expect(await blockText.inputValue()).toBe("Edited from text mode");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(JSON.parse(readFileSync(join(project, "story.json"), "utf8")).script.start[0].text).toBe("Edited from text mode");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited from text mode");
    expect(await page.locator('label.nv-field').filter({ hasText: "对白文本" }).locator("textarea").inputValue()).toBe("Edited from text mode");

    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const draftSource = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await draftSource.waitFor();
    await draftSource.fill((await draftSource.inputValue()).replace("Edited from text mode", "Unapplied text draft"));
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited from text mode");
    await page.locator('label.nv-field').filter({ hasText: "对白文本" }).locator("textarea").fill("Block edit after draft");
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const conflictSource = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await conflictSource.waitFor();
    await page.waitForFunction(() => !document.querySelector(".nv-text-conflict")?.hasAttribute("hidden"));
    expect(await conflictSource.inputValue()).toContain("Unapplied text draft");
    await conflictSource.fill((await conflictSource.inputValue()).replace("Unapplied text draft", "Edited while conflicted"));
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const restoredConflictSource = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await restoredConflictSource.waitFor();
    await page.waitForFunction(() => !document.querySelector(".nv-text-conflict")?.hasAttribute("hidden"));
    expect(await restoredConflictSource.inputValue()).toContain("Edited while conflicted");
    await page.getByRole("button", { name: "保留文本草稿", exact: true }).click();
    await page.getByRole("button", { name: "应用到剧情区块", exact: true }).click();
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited while conflicted");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    expect(JSON.parse(readFileSync(join(project, "story.json"), "utf8")).script.start[0].text).toBe("Edited while conflicted");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Edited while conflicted");
    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const reopenedSource = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    await reopenedSource.waitFor();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出当前文本", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`${projectId}-story.pvn.txt`);
    const exportedPath = await download.path();
    expect(readFileSync(exportedPath!, "utf8")).toContain("Edited while conflicted");

    const imported = (await reopenedSource.inputValue()).replace("Edited while conflicted", "Imported from text file");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入文本", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "chapter.pvn.txt", mimeType: "text/plain", buffer: Buffer.from(imported) });
    await page.waitForFunction(() => document.querySelector(".nv-text-source")?.value.includes("Imported from text file"));
    expect(await reopenedSource.inputValue()).toContain("Imported from text file");
    await page.getByRole("button", { name: "应用到剧情区块", exact: true }).click();
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".nv-instruction textarea")?.value === "Imported from text file");
    expect(await page.locator('label.nv-field').filter({ hasText: "对白文本" }).locator("textarea").inputValue()).toBe("Imported from text file");

    await page.getByRole("button", { name: "文本剧本", exact: true }).click();
    const sourceWithError = page.getByRole("textbox", { name: "Pocket VN 文本剧本" });
    const malformed = [
      '# Pocket VN authoring v1',
      'story {"id":"syntax-error","version":1,"start":"start"}',
      "label start:",
      '  say {"id":"arrival","text": ]}',
    ].join("\n");
    await sourceWithError.fill(malformed);
    await page.waitForFunction(() => document.querySelector(".nv-text-diagnostics")?.textContent?.includes("第 4 行，第 7 列"));
    expect(await page.locator(".nv-text-diagnostics").textContent()).toContain("第 4 行，第 7 列");
    expect(await page.getByRole("button", { name: "应用到剧情区块", exact: true }).isDisabled()).toBe(true);
    expect(JSON.parse(readFileSync(join(project, "story.json"), "utf8")).script.start[0].text).toBe("Edited while conflicted");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
