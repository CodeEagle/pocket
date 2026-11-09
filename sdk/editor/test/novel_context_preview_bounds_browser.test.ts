import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const expectedBun = join(sdkRoot, ".pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun");
const qaRoot = join(sdkRoot, ".pocket-build/context-preview-20261109");

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("Editor bounds context source facts, does not time out a blocked choice, and continues after the dialogue slice limit", { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-context-bounds-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "novel-context-preview-bounds";
  const runId = `bounds-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const runDir = join(qaRoot, runId);
  mkdirSync(project, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const priorOperations = 210;
  const timedChoiceMs = 60;
  const dialogueSlices = 257;
  const targetIndex = 1 + dialogueSlices;
  const story = {
    id: projectId,
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", visible: true }] },
        ...Array.from({ length: priorOperations }, () => ({ type: "inc", variable: "steps", amount: 1 })),
        {
          type: "choice",
          id: "timed-route",
          prompt: "选择路径",
          timeLimitMs: timedChoiceMs,
          timeoutTarget: "timed_out",
          options: [{ id: "continue", text: "继续到长对白", target: "long_route" }],
        },
      ],
      long_route: [
        { type: "set", variable: "route", value: "selected" },
        ...Array.from({ length: dialogueSlices }, (_, index) => ({ type: "say", id: `slice-${index}`, text: `前文对白 ${index}` })),
        { type: "say", id: "target-line", text: "重建目标对白" },
      ],
      timed_out: [
        { type: "set", variable: "route", value: "timed-out" },
        { type: "ending", id: "timeout-ending", text: "超时路线" },
      ],
    },
  };

  for (const [name, value] of [
    ["pocket.json", { pocket: 2, id: "test.context-preview-bounds", name: projectId, app: { entry: "app.tsx", framework: "solid" } }],
    ["manifest.json", { pocket: 2, id: "test.context-preview-bounds", capabilities: { requires: [], optional: [] } }],
    ["editor.json", { id: projectId, appId: "test.context-preview-bounds", name: projectId, version: "0.1.0", build: 1 }],
    ["package.json", { type: "module", dependencies: {} }],
    ["story.json", story],
    ["novel.assets.json", { backgrounds: {}, characters: {}, cgs: {}, audio: {} }],
  ] as const) writeJson(join(project, name), value);

  const sourceStoryBytes = readFileSync(join(project, "story.json"));
  const browserErrors: string[] = [];
  const observations: Record<string, unknown> = {};
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let outcome: "passed" | "failed" = "failed";
  let failure: string | undefined;
  let phase = "prepare";
  let screenshotFiles: Array<{ path: string; sha256: string }> = [];
  let browserVersion: string | undefined;
  const qaOutput = join(qaRoot, "context-bounds-browser-result.json");
  const capture = async (page: import("playwright").Page, name: string): Promise<void> => {
    const path = join(runDir, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshotFiles.push({ path: relative(qaRoot, path), sha256: sha256File(path) });
  };

  try {
    phase = "launch Editor with Playwright Chromium";
    assert.equal(resolve(process.execPath), resolve(expectedBun), "use the pinned Bun 1.4.4 executable");
    assert.equal(execFileSync(expectedBun, ["--version"], { encoding: "utf8" }).trim(), "1.4.4");
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "start:211");

    phase = "reconstruct through more than the trace window into a timed choice";
    await page.locator(".nv-jump-control select").selectOption("long_route");
    await page.locator(".nv-jump-control input").fill(String(targetIndex));
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    const traceRows = page.locator("#novel-execution-trace .nv-execution-trace-entry");
    assert.equal(await traceRows.count(), 200, "the Editor display retains only its newest 200 committed OPs");
    assert.equal(await page.locator('#novel-execution-trace [data-location="start:0"]').count(), 0, "the scene OP falls out of the display trace window");
    const sourceBeforeClear = page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"]');
    assert.equal(await sourceBeforeClear.getAttribute("data-source-location"), "start:0", "the current stage fact retains the actual source outside the trace row window");
    assert.equal(await sourceBeforeClear.isDisabled(), false);
    await capture(page, "bounded-trace-timed-choice");

    phase = "leave the timed choice unresolved beyond its timeout";
    await page.waitForTimeout(timedChoiceMs * 3);
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-status"), "choice", "context preview must not run a timer or choose for the player");
    let facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "choice");
    assert.equal(facts.active?.id, "timed-route");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "route"), false, "the timeout route remains unexecuted until a real choice");
    observations.timedChoiceAfterTimeout = { status: "choice", active: facts.active, route: facts.variables?.route ?? null, waitedMs: timedChoiceMs * 3 };
    await capture(page, "timed-choice-still-blocked");

    phase = "clear trace rows while retaining exact stage source facts";
    await page.locator("#novel-trace-clear").click();
    await page.locator(".nv-execution-trace-empty").waitFor();
    assert.equal(await traceRows.count(), 0);
    const sourceAfterClear = page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"]');
    assert.equal(await sourceAfterClear.getAttribute("data-source-location"), "start:0");
    assert.equal(await sourceAfterClear.isDisabled(), false);
    await sourceAfterClear.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "start");
    assert.equal(await page.locator(".nv-instruction").nth(0).locator(".nv-type-select").inputValue(), "scene");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-status"), "choice", "opening the source leaves the context engine and blocker intact");
    observations.sourceAfterClear = { location: "start:0", traceRows: await page.locator("#novel-execution-trace .nv-execution-trace-entry").count(), type: "scene" };
    await capture(page, "source-still-usable-after-clear");

    phase = "resolve the choice and continue through the 256 dialogue slice limit";
    await page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "继续到长对白" }).click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "limit");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "say");
    assert.equal(facts.active?.id, "slice-256", "the first bounded call stops at the next real dialogue rather than skipping the whole route");
    observations.dialogueLimit = { status: "limit", active: facts.active, stepsVariable: facts.variables?.steps, route: facts.variables?.route };
    await capture(page, "dialogue-slice-limit");

    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "say");
    assert.equal(facts.active?.id, "target-line", "the second bounded call resumes the same engine and reaches its target");
    assert.equal(facts.active?.complete, true);
    assert.equal(facts.variables?.route, "selected");
    assert.equal(facts.variables?.steps, priorOperations);
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-target-location"), `long_route:${targetIndex}`);
    const targetTraceRow = page.locator(`#novel-execution-trace [data-location="long_route:${targetIndex}"][data-op="say"]`);
    assert.equal(await targetTraceRow.count(), 1, "the bounded trace DOM includes helper-driven OPs after Continue");
    assert.equal(await targetTraceRow.locator(".nv-execution-trace-id").innerText(), "target-line");
    observations.continuedToTarget = { status: "reached", active: facts.active, location: facts.location, variables: facts.variables };
    observations.continuedTraceRow = { location: `long_route:${targetIndex}`, op: "say", id: "target-line" };
    await capture(page, "dialogue-slice-target-reached");

    assert.deepEqual(browserErrors, [], `Browser page errors: ${JSON.stringify(browserErrors)}`);
    assert.deepEqual(readFileSync(join(project, "story.json")), sourceStoryBytes, "preview and source navigation never write the project story");
    outcome = "passed";
  } catch (error) {
    failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    throw error;
  } finally {
    try { await browser?.close(); } finally {
      try { await server?.stop(true); } finally {
        const record = {
          outcome,
          failure,
          phase,
          projectId,
          fixture: { priorOperations, timedChoiceMs, dialogueSlices, target: `long_route:${targetIndex}`, storySha256: sha256(sourceStoryBytes) },
          environment: {
            bunVersion: execFileSync(expectedBun, ["--version"], { encoding: "utf8" }).trim(),
            playwrightChromium: browserVersion,
          },
          sourceHashes: {
            test: sha256File(import.meta.path),
            engineTs: sha256File(join(sdkRoot, "packages/pocket_vn/src/engine.ts")),
            previewContextTs: sha256File(join(sdkRoot, "packages/pocket_vn/src/preview-context.ts")),
            novelJs: sha256File(join(sdkRoot, "editor/client/novel.js")),
            novelCss: sha256File(join(sdkRoot, "editor/client/novel.css")),
          },
          observations,
          screenshots: screenshotFiles,
          browserErrors,
        };
        writeJson(join(runDir, "context-bounds-browser-result.json"), record);
        writeJson(qaOutput, { run: relative(qaRoot, runDir), ...record });
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
});
