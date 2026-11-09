import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("Chromium shows bounded committed OP trace, respects breakpoints and step, locates source, and leaves story JSON unchanged", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-debug-trace-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const id = "novel-debug-trace-browser";
  await mkdir(project, { recursive: true });
  const story = {
    id, version: 1, start: "start",
    script: {
      start: [
        { type: "set", variable: "counter", value: 0 },
        { type: "jump", target: "loop" },
      ],
      loop: [
        { type: "inc", variable: "counter", amount: 1 },
        { type: "branch", when: { op: "gte", left: { type: "variable", name: "counter" }, right: { type: "literal", value: 101 } }, then: "call", else: "loop" },
      ],
      call: [
        { type: "call", target: "sub" },
        { type: "jump", target: "halt" },
      ],
      sub: [{ type: "set", variable: "nested", value: true }],
      halt: [
        { type: "say", id: "last-line", text: "The timeline records committed execution." },
        { type: "ending", id: "end", text: "Done" },
      ],
    },
  };
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "test.novel-debug-trace", name: id, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "test.novel-debug-trace", capabilities: { requires: [], optional: [] } }));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "test.novel-debug-trace", name: id, version: "0.1.0", build: 1 }));
  await writeFile(join(project, "package.json"), JSON.stringify({ type: "module", dependencies: {} }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const pageErrors: string[] = [];
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();

    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.locator('#novel-execution-trace [data-op="say"]').waitFor();
    const traceRows = page.locator("#novel-execution-trace .nv-execution-trace-entry");
    assert.equal(await traceRows.count(), 200, "the UI retains only its newest 200 entries");
    assert.equal(await traceRows.first().getAttribute("data-sequence"), "10");
    assert.equal(await traceRows.last().getAttribute("data-sequence"), "209");
    assert.equal(await page.locator('#novel-execution-trace [data-op="implicitReturn"]').count(), 1);
    assert.equal(await page.locator('#novel-execution-trace [data-location="halt:1"][data-op="ending"]').count(), 0, "a later ending is not listed before it executes");
    await traceRows.first().evaluate(row => { row.dataset.domMarker = "stable-through-clock"; });

    const pauseToggle = page.locator("#novel-preview-pause");
    assert.equal(await pauseToggle.innerText(), "继续");
    await pauseToggle.click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await pauseToggle.click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    assert.equal(await traceRows.last().getAttribute("data-sequence"), "209", "pause/resume clock updates do not create instruction entries");
    assert.equal(await traceRows.first().getAttribute("data-dom-marker"), "stable-through-clock", "no-OP preview updates preserve trace row DOM identity");

    const endingBreakpoint = page.locator(".nv-breakpoint-row").filter({ hasText: "halt:1 · ending" }).locator("input");
    await endingBreakpoint.check();
    await traceRows.nth(1).evaluate(row => { row.dataset.domMarker = "stable-through-append"; });
    await page.locator(".nv-jump-control select").selectOption("halt");
    await page.locator(".nv-jump-control input").fill("1");
    await page.getByRole("button", { name: "跳到指令", exact: true }).click();
    assert.equal(await page.locator('#novel-execution-trace [data-location="halt:1"][data-op="ending"]').count(), 0, "jumping to a breakpoint leaves the target operation unexecuted");
    await page.getByRole("button", { name: "单步到下一阻塞点", exact: true }).click();
    await page.locator('#novel-execution-trace [data-location="halt:1"][data-op="ending"]').waitFor();
    assert.equal(await traceRows.count(), 200);
    assert.equal(await traceRows.first().getAttribute("data-sequence"), "11");
    assert.equal(await traceRows.last().getAttribute("data-sequence"), "210");
    assert.equal(await traceRows.first().getAttribute("data-dom-marker"), "stable-through-append", "a committed new batch preserves rows that remain inside the bounded window");

    await page.locator('#novel-execution-trace [data-location="halt:0"][data-op="say"]').click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "halt", "trace selection navigates to the authored instruction label");
    assert.equal(await page.locator(".nv-instruction").count(), 2);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story, "viewing the trace must not edit or persist story data");

    await page.locator(".nv-instruction").first().getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    const staleSay = page.locator('#novel-execution-trace [data-location="halt:0"][data-op="say"]');
    assert.equal(await staleSay.isDisabled(), true, "story revision refresh disables a source row whose authored instruction was removed");

    await page.locator("#novel-trace-clear").click();
    await page.locator(".nv-execution-trace-empty").waitFor();
    assert.equal(await page.locator("#novel-preview-location").innerText(), "halt:1", "clearing the UI history does not reset the shared engine");
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);

    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.locator('#novel-execution-trace [data-location="halt:0"][data-op="ending"]').waitFor();
    const restartedRows = page.locator("#novel-execution-trace .nv-execution-trace-entry");
    assert.equal(await restartedRows.last().getAttribute("data-sequence"), "209", "replacing the preview engine starts a fresh trace ordinal");
    assert.equal(await page.locator('#novel-execution-trace [data-op="say"]').count(), 0, "the new engine trace uses the edited story source");
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story, "unsaved Editor changes remain out of the project story file");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
