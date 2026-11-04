import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../../scripts/build_guest.ts";
import { startEditor } from "../server.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const fixture = join(import.meta.dir, "fixtures/counter");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

async function request(server: ReturnType<typeof Bun.serve>, path: string, init: RequestInit = {}): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET" && !headers.has("x-pocket-editor")) headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  const type = response.headers.get("content-type") || "";
  const value = type.includes("application/json") ? await response.json() : await response.text();
  return { response, value };
}

async function waitForBuilt(server: ReturnType<typeof Bun.serve>, projectId: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = (await request(server, `/api/projects/${encodeURIComponent(projectId)}/status`)).value;
    if (!status.busy) return status;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for project ${projectId} build`);
}

async function waitForPreviewStageStable(page: any, mode: "low" | "high", baseline = 0): Promise<void> {
  await page.evaluate(() => { delete (window as any).__pocketPreviewStageStability; });
  await page.waitForFunction(({ mode: expectedMode, baseline: minimumHeight }) => {
    const handle = document.querySelector("#resize-preview-height");
    const stage = document.querySelector("#preview-stage");
    const value = Number(handle?.getAttribute("aria-valuenow"));
    const height = stage?.getBoundingClientRect().height ?? 0;
    if (!Number.isFinite(value) || height <= 0) return false;
    const previous = (window as any).__pocketPreviewStageStability as { height?: number; stable?: number } | undefined;
    const state = previous ?? { stable: 0 };
    state.stable = typeof state.height === "number" && Math.abs(state.height - height) < 0.5
      ? (state.stable ?? 0) + 1
      : 0;
    state.height = height;
    (window as any).__pocketPreviewStageStability = state;
    const stable = (state.stable ?? 0) >= 3;
    return expectedMode === "low"
      ? value === 240 && height < 240 && stable
      : value > 600 && height > minimumHeight && stable;
  }, { mode, baseline }, { timeout: 5_000 });
}

async function runPreviewPageAcceptance(): Promise<void> {
  expect(existsSync(probe)).toBe(true);
  expect(existsSync(playwrightPath)).toBe(true);
  const workspace = mkdtempSync(join(tmpdir(), "pocket-editor-preview-page-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pocket-editor-preview-project-"));
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-preview-build-"));
  cpSync(fixture, projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({ capabilities: {} }));
  const built = await buildGuest({ projectRoot, outDir: output, tickHz: 60 });
  const bytecodeMetadata = JSON.parse(readFileSync(built.metadata, "utf8"));
  const server = await startEditor({
    port: 0,
    workspace,
    projectRoot,
    buildRunner: async () => ({
      appJs: built.source,
      pak: built.pak,
      bytecode: built.bytecode,
      metadata: built.metadata,
      runtimeAbi: bytecodeMetadata.runtimeAbi,
      bytecodeMetadata,
    }),
  });
  let browser: any;
  try {
    const health = await request(server, "/health");
    expect(health.response.status).toBe(200);
    const projectId = health.value.projectId;
    expect(typeof projectId).toBe("string");

    const build = await request(server, `/api/projects/${encodeURIComponent(projectId)}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(build.response.status).toBe(202);
    const status = await waitForBuilt(server, projectId);
    expect(status.error).toBeUndefined();
    expect(status.builtRevision).toBe(status.revision);

    const { chromium } = await import(pathToFileURL(playwrightPath).href);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      const writes: string[] = [];
      (window as any).__pocketClipboardWrites = writes;
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (value: string) => { writes.push(value); } },
        });
      } catch {
        // Some browsers expose a non-configurable clipboard in this context.
      }
    });
    const pageErrors: string[] = [];
    const codexRequests: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("request", (request: any) => {
      if (/\/api\/codex(?:\/|$)|\/codex\/turn/.test(new URL(request.url()).pathname)) codexRequests.push(request.url());
    });

    const rootResponse = await page.goto(`http://127.0.0.1:${server.port}/`);
    expect(rootResponse?.status()).toBe(200);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview-frame");
      return Boolean(frame && !frame.hidden && document.querySelector("#preview-state")?.textContent?.includes("Ready"));
    }, undefined, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview-frame");
      return Boolean(frame?.contentWindow && (frame.contentWindow as any).PocketEditorPreviewInstance?.getFrame?.());
    }, undefined, { timeout: 30_000 });

    expect(await page.locator("#project-title").textContent()).not.toBe("Select a project");
    expect(await page.locator("#preview-url").count()).toBe(0);
    expect(await page.locator("#toggle-regions").getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator("#toggle-regions").isDisabled()).toBe(false);
    expect(await page.locator(".preview-toolbar #device-picker").count()).toBe(1);
    expect(await page.locator(".preview-toolbar #deploy").textContent()).toBe("Run");
    expect(await page.locator(".preview-toolbar #deploy-cancel").textContent()).toBe("Stop");
    expect(await page.locator(".deploy-panel #device-picker").count()).toBe(0);
    expect(await page.locator(".deploy-panel #deploy").count()).toBe(0);
    const logicalBefore = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview-frame");
      return (frame?.contentWindow as any)?.PocketEditorPreviewInstance?.getFrame?.();
    });
    const heightHandle = page.locator("#resize-preview-height");
    await heightHandle.focus();
    await page.keyboard.press("Home");
    await waitForPreviewStageStable(page, "low");
    const lowStage = await page.locator("#preview-stage").boundingBox();
    expect(lowStage).not.toBeNull();
    const heightBefore = Number(await heightHandle.getAttribute("aria-valuenow"));
    expect(heightBefore).toBe(240);
    const heightBox = await heightHandle.boundingBox();
    expect(heightBox).not.toBeNull();
    await page.mouse.move(heightBox!.x + heightBox!.width / 2, heightBox!.y + heightBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(heightBox!.x + heightBox!.width / 2, heightBox!.y + heightBox!.height / 2 + 400);
    await page.mouse.up();
    await waitForPreviewStageStable(page, "high", lowStage!.height);
    const heightAfter = Number(await heightHandle.getAttribute("aria-valuenow"));
    expect(heightAfter).toBeGreaterThan(heightBefore);
    const stageAfter = await page.locator("#preview-stage").boundingBox();
    expect(stageAfter).not.toBeNull();
    expect(stageAfter!.height).toBeGreaterThan(lowStage!.height);
    const logicalAfter = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview-frame");
      return (frame?.contentWindow as any)?.PocketEditorPreviewInstance?.getFrame?.();
    });
    expect(logicalAfter.width).toBe(logicalBefore.width);
    expect(logicalAfter.height).toBe(logicalBefore.height);

    const removedIds = [
      "codex-panel", "codex-form", "codex-input", "codex-messages", "model-picker", "thinking-picker",
      "scope-picker", "image-input", "image-list", "annotation-mode", "annotation-layer",
    ];
    for (const id of removedIds) expect(await page.locator(`#${id}`).count()).toBe(0);
    expect(codexRequests).toEqual([]);
    expect(pageErrors).toEqual([]);

    await page.locator("#toggle-regions").click();
    expect(await page.locator("#toggle-regions").getAttribute("aria-pressed")).toBe("true");
    await page.locator(".preview-options > summary").click();
    await page.locator("#copy-preview-link").click();
    await page.locator(".preview-options > summary").click();
    const copied = await page.evaluate(() => (window as any).__pocketClipboardWrites?.at(-1));
    expect(copied).toBe(`http://127.0.0.1:${server.port}/api/projects/${projectId}/preview?regions=1`);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#capture-preview").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain(projectId);
    await page.waitForFunction(() => document.querySelector('#notice')?.getAttribute('data-tone') === 'success');
    expect(await page.locator('#notice').getAttribute('role')).toBe('status');
    await page.locator('#notice-close').click();
    expect(await page.locator('#notice').isHidden()).toBe(true);
    expect(codexRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
}

if (process.env.POCKET_PREVIEW_PAGE_CHILD === "1") {
  test("configured project opens its real preview without Codex UI or API calls", { timeout: 90_000 }, runPreviewPageAcceptance);
} else {
  test("configured project preview acceptance runs in an isolated Bun process", { timeout: 65_000 }, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, POCKET_PREVIEW_PAGE_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill(), 60_000);
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const output = `${await stdout}\n${await stderr}`;
    expect(exitCode, output).toBe(0);
  });
}
