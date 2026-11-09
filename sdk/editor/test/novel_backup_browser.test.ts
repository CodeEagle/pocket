import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("Editor restores a complete saved project, preserves a recovery point and persists its automatic backup policy", { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-backup-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const id = "backup-browser";
  await mkdir(join(project, "assets", "models"), { recursive: true });
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "test.backup", name: id, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "test.backup", name: id, version: "0.1.0" }));
  await writeFile(join(project, "app.tsx"), "export {};\n");
  const story = { id, version: 1, start: "start", script: { start: [{ type: "say", id: "hello", text: "Original line" }, { type: "ending", id: "end" }] } };
  await writeFile(join(project, "story.json"), JSON.stringify(story));
  await writeFile(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  const model = Buffer.from([0, 255, 81, 33, 0]);
  await writeFile(join(project, "assets/models/character.pak"), model);
  let server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = () => `http://127.0.0.1:${server.port}`;
  const path = `/api/projects/${id}/novel/backups`;
  const post = (suffix: string, body: unknown) => fetch(origin() + path + suffix, { method: "POST", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(body) });
  try {
    await page.goto(`${origin()}/novel?project=${id}`);
    await page.getByLabel("对白文本", { exact: true }).fill("Unsaved draft");
    await page.getByRole("button", { name: "项目备份", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "备份已保存项目", exact: true }).isDisabled(), true);
    await clickNovelHistory(page, "undo");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    await page.getByRole("button", { name: "备份已保存项目", exact: true }).click();
    await page.locator(".nv-backup-row").waitFor();
    const backupId = await page.locator(".nv-backup-row").getAttribute("data-backup-id");
    const initial = (await (await fetch(origin() + `/api/projects/${id}/status`)).json() as any).revision;
    story.script.start[0]!.text = "Changed on disk";
    await writeFile(join(project, "story.json"), JSON.stringify(story));
    await writeFile(join(project, "assets/models/character.pak"), "changed model");
    await writeFile(join(project, "new-custom.ts"), "export const added = true;\n");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "恢复这个版本", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-instruction textarea")].some(node => (node as HTMLTextAreaElement).value === "Original line"));
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].text, "Original line");
    assert.deepEqual(await readFile(join(project, "assets/models/character.pak")), model);
    assert.equal(await Bun.file(join(project, "new-custom.ts")).exists(), false);
    assert.equal((await (await fetch(origin() + `/api/projects/${id}/status`)).json() as any).revision, initial + 1);
    const history = (await (await fetch(origin() + path)).json() as any).backups;
    assert.equal(history.length, 2);
    const recovery = history.find((entry: any) => entry.id !== backupId);
    assert.equal(JSON.parse(await readFile(join(workspace, "backups", id, recovery.id, "files/story.json"), "utf8")).script.start[0].text, "Changed on disk");

    assert.equal((await post("/schedule", { intervalMinutes: 2 })).status, 422);
    assert.equal((await post("/schedule", { intervalMinutes: 1, projectRoot: "/tmp" })).status, 422);
    await page.getByRole("button", { name: "项目备份", exact: true }).click();
    await page.getByLabel("自动备份间隔", { exact: true }).selectOption("1");
    await page.waitForFunction(() => document.querySelector(".nv-backup-status")?.textContent?.includes("自动备份已保存文件"));
    await server.stop(true);
    server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
    await page.goto(`${origin()}/novel?project=${id}`);
    await page.getByRole("button", { name: "项目备份", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="自动备份间隔"]') as HTMLSelectElement)?.value === "1");
    // Real scheduler acceptance: a changed custom source is captured after one minute.
    await writeFile(join(project, "custom-scene.ts"), "export const restoredTimer = true;\n");
    let policy: any;
    const deadline = Date.now() + 75_000;
    do {
      policy = await (await fetch(origin() + path + "/schedule")).json();
      if (policy.lastRunAt && policy.lastBackupId) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.equal(typeof policy.lastBackupId, "string", JSON.stringify(policy));
    assert.equal(await readFile(join(workspace, "backups", id, policy.lastBackupId, "files/custom-scene.ts"), "utf8"), "export const restoredTimer = true;\n");
    assert.equal((await post("/schedule", { intervalMinutes: 0 })).status, 200);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
