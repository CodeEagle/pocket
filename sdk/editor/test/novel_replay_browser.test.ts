import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("Editor saves replay entries, follows label renames, rejects invalid references atomically, and runs isolated replay runtime", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-replay-browser-"));
  const project = join(temporary, "project");
  const id = "replay-browser";
  await mkdir(project);
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "test.replay", name: id, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "test.replay", name: id, version: "0.1.0" }));
  const story = {
    id, version: 1, start: "start",
    variableDefinitions: { score: { lifetime: "save", defaultValue: 0, custom: { author: "retained" } } },
    replayEntries: [{ id: "memory", title: "The memory", location: { label: "memory", index: 0 }, unlockEndingId: "proof", badge: "gallery", custom: { author: "retained" } }],
    author: { name: "Kei", credits: ["original metadata"] },
    script: {
      start: [
        { type: "set", variable: "score", value: 7 },
        { type: "say", id: "unlock-line", text: "The story remembers." },
        { type: "ending", id: "proof" },
      ],
      memory: [
        { type: "scene", background: "memory-room", characters: [{ id: "mira", expression: "hopeful", position: "center" }] },
        { type: "say", id: "memory-line", text: "A replay begins here." },
        { type: "set", variable: "score", value: 99 },
        { type: "ending", id: "memory-ending", cg: "memory-cg" },
      ],
    },
  };
  await writeFile(join(project, "story.json"), JSON.stringify(story));
  await writeFile(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  const server = await startEditor({ port: 0, updatePort: 0, workspace: join(temporary, "workspace"), projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.locator(".nv-label").first().waitFor();

    await page.getByRole("button", { name: "鉴赏回放", exact: true }).click();
    assert.equal(await page.getByLabel("入口 ID 1", { exact: true }).inputValue(), "memory");
    assert.equal(await page.getByLabel("回放标题 1", { exact: true }).inputValue(), "The memory");
    assert.equal(await page.getByLabel("入口标签 1", { exact: true }).inputValue(), "memory");
    assert.equal(await page.getByLabel("入口指令 1", { exact: true }).inputValue(), "0");
    assert.equal(await page.getByLabel("解锁结局 1", { exact: true }).inputValue(), "proof");

    await page.getByLabel("回放标题 1", { exact: true }).fill("The remembered coast");
    await page.getByLabel("回放标题 1", { exact: true }).press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("回放标题 1", { exact: true }).inputValue(), "The memory");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("回放标题 1", { exact: true }).inputValue(), "The remembered coast");

    page.once("dialog", dialog => dialog.accept("temporary_entry"));
    await page.getByRole("button", { name: "添加回放入口", exact: true }).click();
    assert.equal(await page.getByLabel("入口 ID 2", { exact: true }).inputValue(), "temporary_entry");
    await page.getByRole("button", { name: "删除回放入口 2", exact: true }).click();
    assert.equal(await page.locator(".nv-instruction[data-replay-id]").count(), 1);

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator(".nv-label").filter({ hasText: "memory" }).click();
    const labelId = page.getByLabel("标签 ID", { exact: true });
    await labelId.fill("memory_archive");
    await labelId.press("Tab");
    await page.getByRole("button", { name: "鉴赏回放", exact: true }).click();
    assert.equal(await page.getByLabel("入口标签 1", { exact: true }).inputValue(), "memory_archive");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = JSON.parse(await readFile(join(project, "story.json"), "utf8"));
    assert.equal(saved.replayEntries[0].title, "The remembered coast");
    assert.equal(saved.replayEntries[0].location.label, "memory_archive");
    assert.equal(saved.replayEntries[0].badge, "gallery");
    assert.deepEqual(saved.replayEntries[0].custom, { author: "retained" });
    assert.deepEqual(saved.author, story.author);
    assert.deepEqual(saved.variableDefinitions.score.custom, { author: "retained" });

    await page.reload();
    await page.getByRole("button", { name: "鉴赏回放", exact: true }).click();
    assert.equal(await page.getByLabel("回放标题 1", { exact: true }).inputValue(), "The remembered coast");
    assert.equal(await page.getByLabel("入口标签 1", { exact: true }).inputValue(), "memory_archive");

    for (const invalid of [
      { ...structuredClone(saved), replayEntries: [{ ...structuredClone(saved.replayEntries[0]), location: { ...saved.replayEntries[0].location, label: "missing_label" } }] },
      { ...structuredClone(saved), replayEntries: [{ ...structuredClone(saved.replayEntries[0]), unlockEndingId: "missing_ending" }] },
    ]) {
      const rejected = await fetch(`${origin}/api/projects/${id}/novel/story`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-pocket-editor": "1" },
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 422);
      assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), saved);
    }

    const runtimeFile = join(temporary, "runtime.mjs");
    const runtimeResponse = await fetch(`${origin}/api/projects/${id}/novel/runtime.js`);
    assert.equal(runtimeResponse.status, 200);
    await writeFile(runtimeFile, await runtimeResponse.text());
    const runtime = await import(pathToFileURL(runtimeFile).href);
    const source = runtime.createNovelEngine(saved, {
      initialVariables: { score: 5 },
      preferences: { mode: "skip", textSpeedCharsPerSecond: 0, skipSeenOnly: true },
    });
    let replay;
    try {
      assert.throws(() => runtime.createNovelReplayEngine(saved, source.getSnapshot(), "memory"), /locked/);
      source.start();
      if (source.getSnapshot().active?.kind === "say" && !source.getSnapshot().active.complete) source.advance();
      source.advance();
      assert.equal(source.getSnapshot().active?.kind, "ending");
      assert.ok(source.getSnapshot().meta.endingIds.includes("proof"));
      const sourceSnapshot = source.getSnapshot();
      const sourceSave = source.save();

      replay = runtime.createNovelReplayEngine(saved, sourceSnapshot, "memory");
      assert.equal(replay.getSnapshot().preferences.mode, "manual");
      assert.equal(replay.getSnapshot().active?.kind, "say");
      assert.equal(replay.getSnapshot().stage.background, "memory-room");
      assert.equal(replay.getSnapshot().variables.score, 7);
      if (replay.getSnapshot().active?.kind === "say" && !replay.getSnapshot().active.complete) replay.advance();
      replay.advance();
      assert.equal(replay.getSnapshot().active?.kind, "ending");
      assert.equal(replay.getSnapshot().variables.score, 99);
      assert.ok(replay.getSnapshot().meta.endingIds.includes("memory-ending"));
      assert.equal(source.getSnapshot(), sourceSnapshot);
      assert.deepEqual(source.save(), sourceSave);
      assert.deepEqual(saved.replayEntries[0].location, { label: "memory_archive", index: 0 });
      assert.deepEqual(pageErrors, []);
    } finally {
      replay?.dispose();
      source.dispose();
    }
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
