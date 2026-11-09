import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { chromium } from "playwright";
import { buildGuest } from "../../scripts/build_guest.ts";
import { startEditor } from "../server.ts";

test("production Editor keeps a quiet native preview connected beyond its HTTP idle timeout", { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-preview-idle-"));
  const projectRoot = join(directory, "project");
  cpSync(join(import.meta.dir, "fixtures/counter"), projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({ capabilities: {} }));
  const built = await buildGuest({ projectRoot, outDir: join(directory, "out"), tickHz: 60 });
  const bytecodeMetadata = JSON.parse(readFileSync(built.metadata, "utf8"));
  const server = await startEditor({
    port: 0,
    workspace: join(directory, "workspace"),
    projectRoot,
    buildRunner: async () => ({ appJs: built.source, pak: built.pak, bytecode: built.bytecode, metadata: built.metadata, runtimeAbi: bytecodeMetadata.runtimeAbi, bytecodeMetadata }),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://${server.hostname}:${server.port}`;
    const health = await (await fetch(`${origin}/health`)).json() as any;
    const prefix = `/api/projects/${health.projectId}`;
    const response = await fetch(`${origin}${prefix}/build`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: "{}" });
    assert.equal(response.status, 202);
    for (let attempt = 0; ; attempt++) {
      const status = await (await fetch(`${origin}${prefix}/status`)).json() as any;
      assert.equal(status.error, undefined);
      if (!status.busy) break;
      assert.ok(attempt < 600, "build must finish");
      await Bun.sleep(50);
    }
    const page = await browser.newPage();
    let streams = 0;
    page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/preview/stream")) streams++; });
    await page.addInitScript(() => {
      (window as any).__previewPackets = [];
      window.addEventListener("message", event => {
        if (event.data?.source === "pocket-editor-preview") (window as any).__previewPackets.push(event.data);
      });
    });
    await page.goto(`${origin}${prefix}/preview`);
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame?.()?.ops?.some((op: any) => op.text === "count=0"));
    // Demand-driven guests produce no frames while idle. Wait longer than
    // production's 120-second HTTP timeout, without polling or input traffic.
    await page.waitForTimeout(125_000);
    assert.equal(streams, 1, "a static guest must not lose and reopen its SSE connection");
    const failures = await page.evaluate(() => (window as any).__previewPackets.filter((packet: any) => packet.type === "preview.error" || packet.status?.state === "reconnecting"));
    assert.deepEqual(failures, []);
    const button = await page.evaluate(() => {
      const frame = (window as any).PocketEditorPreviewInstance.getFrame();
      const op = frame.ops.find((op: any) => op.text === "Increment counter");
      const rect = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: rect.x + (op.x + op.w / 2) * rect.width / frame.width, y: rect.y + (op.y + op.h / 2) * rect.height / frame.height };
    });
    await page.mouse.click(button.x, button.y);
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().ops.some((op: any) => op.text === "count=1"));
    assert.equal(streams, 1);
  } finally {
    await browser.close();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
