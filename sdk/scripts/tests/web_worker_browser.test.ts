import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { buildWeb } from "../build_web.ts";

// Reuse one Chromium process; each case still receives a fresh browser context.
// Bun 1.3.9 can lose the stdio pipe on a second Playwright spawn in one realm.
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
beforeAll(async () => {
  if (process.env.POCKET_WEB_ENGINE) browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

// Maintainer integration gate: run against the newly built pinned Worker
// engine, not the older npm engine that deliberately lacks this ABI.
for (const renderWorker of [false, true]) {
test.skipIf(!process.env.POCKET_WEB_ENGINE)(`browser ${renderWorker ? "render Worker" : "main renderer"}: UI QJBC -> Worker QJBC -> real HTTP -> rendered progress`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-worker-browser-"));
  const project = join(root, "project"), output = join(root, "web");
  mkdirSync(project);
  let requests = 0;
  let responseGate: Promise<void> | null = null;
  let releaseResponse: (() => void) | undefined;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/response") {
      requests++;
      const body = requests === 1 ? "worker-response" : "r".repeat(requests + 19);
      return responseGate ? responseGate.then(() => new Response(body)) : new Response(body);
    }
    if (path === "/") return new Response(`<!doctype html><canvas id="pocket" style="width:360px;height:240px"></canvas>
      <script type="module">
      import { PocketWebRuntime } from '/pocket-web.js';
      window.errors=[]; window.PocketWebRuntime=PocketWebRuntime;
      const config=await fetch('/pocket.config.json').then(r=>r.json());
      window.runtime=new PocketWebRuntime({canvas:document.querySelector('canvas'),engineUrl:'/engine/pocketjs.wasm',
        qjbcUrl:'/app.qjbc',pakUrl:'/app.pak',config,gameInput:true,onError:e=>window.errors.push(String(e?.message||e))});
      window.runtime.mount().then(()=>window.ready=true).catch(e=>{window.errors.push(String(e));window.failed=true});
      </script>`, { headers: { "content-type": "text/html" } });
    const file = resolve(output, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(output + sep)) return new Response("forbidden", { status: 403 });
    const type = extname(file) === ".js" ? "text/javascript" : extname(file) === ".wasm" ? "application/wasm" : "application/octet-stream";
    return new Response(Bun.file(file), { headers: { "content-type": type } });
  } });
  let context: Awaited<ReturnType<NonNullable<typeof browser>["newContext"]>> | undefined;
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const upstream = resolve(import.meta.dir, "../../.cache/pocketjs/apps/worker-http");
    const pocket = JSON.parse(readFileSync(join(upstream, "pocket.json"), "utf8"));
    pocket.id = "pocket.test.webworker";
    pocket.app = { ...pocket.app, entry: "app.tsx" };
    pocket.domains.worker.entry = "worker.ts";
    writeFileSync(join(project, "pocket.json"), JSON.stringify(pocket));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: ["runtime.worker", "net.http"] } }));
    writeFileSync(join(project, "app.tsx"), readFileSync(join(upstream, "main.tsx"), "utf8"));
    const worker = readFileSync(join(upstream, "worker.ts"), "utf8")
      .replace("https://example.com/", `${origin}/response`)
      .replace("if (!ended) publish(5, total, outcome.status);", "if (!ended) publish(outcome.status === ResourceStatus.ok ? 4 : 5, total, outcome.status);");
    writeFileSync(join(project, "worker.ts"), worker);
    // A release engine includes its matching host bundle/worker entry assets.
    const runtimePath = process.env.POCKET_WEB_RUNTIME;
    if (!runtimePath) throw new Error("Set POCKET_WEB_RUNTIME to the matching newly built browser host bundle");
    await buildWeb({ projectRoot: project, outDir: output, enginePath: process.env.POCKET_WEB_ENGINE, runtimePath, renderWorker, workerHttpOrigins: [origin] });
    context = await browser!.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => (window as any).ready || (window as any).failed, { timeout: 30_000 });
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    const texts = async () => page.evaluate(async () => {
      const snapshot = await (window as any).runtime.inspect();
      return snapshot.nodes.map((node: any) => node.text).filter((value: unknown) => typeof value === "string");
    });
    expect(await texts()).toContain("Ready");
    const initial = createHash("sha256").update(await page.locator("canvas").screenshot()).digest("hex");
    await page.locator("canvas").focus();
    await page.keyboard.press("z");
    const deadline = Date.now() + 30_000;
    while (!(await texts()).includes("Complete") && Date.now() < deadline) await Bun.sleep(50);
    const completedTexts = await texts();
    expect({ texts: completedTexts, requests, errors: await page.evaluate(() => (window as any).errors) }).toMatchObject({ texts: expect.arrayContaining(["Complete"]), requests: 1, errors: [] });
    // The pinned compiler emits static/dynamic Text children as sibling
    // nodes. Inspect the dynamic values as well as the rendered screenshot.
    expect(completedTexts).toContain("15");
    expect(completedTexts).toContain("0");
    expect(requests).toBe(1);
    expect(createHash("sha256").update(await page.locator("canvas").screenshot()).digest("hex")).not.toBe(initial);
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    expect(pageErrors).toEqual([]);
    // A real response that arrives while hidden must wait for resume. This
    // exercises the Worker/UI lifecycle across two independent WASM heaps.
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.keyboard.press("z");
    const secondDeadline = Date.now() + 10_000;
    while (requests < 2 && Date.now() < secondDeadline) await Bun.sleep(20);
    expect(requests).toBe(2);
    await page.evaluate(() => (window as any).runtime.hide());
    const hiddenTexts = await texts();
    releaseResponse!();
    await Bun.sleep(150);
    expect(await texts()).toEqual(hiddenTexts);
    await page.evaluate(() => (window as any).runtime.show());
    const resumeDeadline = Date.now() + 10_000;
    while (!(await texts()).includes("21") && Date.now() < resumeDeadline) await Bun.sleep(30);
    expect(await texts()).toContain("Complete");
    expect(await texts()).toContain("21");
    // Cross the eight-request IPC window to catch lost acknowledgements and
    // reclaim official resource/request slots between real HTTP operations.
    for (let request = 3; request <= 12; request++) {
      await page.locator("canvas").focus();
      await page.keyboard.press("z");
      const deadline = Date.now() + 5000;
      while (!(await texts()).includes(String(request + 19)) && Date.now() < deadline) await Bun.sleep(20);
      expect({ requests, texts: await texts() }).toMatchObject({ requests: request, texts: expect.arrayContaining(["Complete", String(request + 19)]) });
    }
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    const rejected = await page.evaluate(async () => {
      const current = (window as any).runtime;
      const config = structuredClone(current.config);
      delete config.externalGuest;
      config.worker.descriptor.bytecode.sha256 = "0".repeat(64);
      current.dispose();
      const previous = document.querySelector("canvas")!;
      const canvas = document.createElement("canvas");
      canvas.style.cssText = previous.getAttribute("style") || "";
      previous.replaceWith(canvas);
      const candidate = new (window as any).PocketWebRuntime({ canvas,
        engineUrl: "/engine/pocketjs.wasm", qjbcUrl: "/app.qjbc", pakUrl: "/app.pak", config });
      try { await candidate.mount(); return { rejected: false }; }
      catch (error) { return { rejected: true, disposed: candidate.disposed, message: String(error) }; }
      finally { candidate.dispose(); }
    });
    expect(rejected).toMatchObject({ rejected: true, disposed: true });
    expect(rejected.message).toContain("descriptor");
    expect(requests).toBe(12);
  } finally {
    await context?.close();
    server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

}
