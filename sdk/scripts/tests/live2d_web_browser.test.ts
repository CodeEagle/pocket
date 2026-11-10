import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { buildWeb } from "../build_web.ts";

const fixture = resolve(process.env.POCKET_LIVE2D_WEB_PROJECT || join(import.meta.dir, "../../packages/pocket_live2d/.cache/hiyori-guest-pixels/project"));
const core = process.env.POCKET_CUBISM_WEB_CORE;
// Official Core and sample assets are local development dependencies, not
// redistributed test fixtures. Build them with build_hiyori_guest_fixture.ts.
test.skipIf(!core || !process.env.POCKET_WEB_ENGINE || !process.env.POCKET_WEB_RUNTIME || !existsSync(join(fixture, "app.tsx")))(
  "real Hiyori Guest animates through the same Web QJBC on main and render Worker",
  async () => {
    const work = mkdtempSync(join(tmpdir(), "pocket-live2d-web-"));
    const output = join(work, "web");
    const evidence = process.env.POCKET_LIVE2D_WEB_EVIDENCE;
    if (evidence) mkdirSync(evidence, { recursive: true });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await buildWeb({ projectRoot: fixture, outDir: output, enginePath: process.env.POCKET_WEB_ENGINE,
        runtimePath: process.env.POCKET_WEB_RUNTIME, live2dCorePath: core });
      server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/") return new Response(`<!doctype html><style>body{margin:0}canvas{width:240px;height:340px}</style><canvas tabindex="0"></canvas><script type="module">
import { PocketWebRuntime } from '/pocket-web.js';
window.errors=[];window.frames=[];
const debug=${JSON.stringify(Boolean(process.env.POCKET_LIVE2D_WEB_DEBUG))};
const config=await fetch('/pocket.config.json').then(r=>r.json());
window.runtime=new PocketWebRuntime({canvas:document.querySelector('canvas'),engineUrl:'/engine/pocketjs.wasm',qjbcUrl:'/app.qjbc',pakUrl:'/app.pak',config,renderWorker:new URL(location).searchParams.get('mode')==='worker',gameInput:true,onError:e=>errors.push(String(e.message||e))});
const invoke=runtime.live2d.invoke.bind(runtime.live2d);
runtime.live2d.invoke=async(...args)=>{if(debug)console.log("invoke",args[0],frames.length);let result;try{result=await invoke(...args);}catch(e){errors.push(String(e.message||e)+" "+String(e.cause?.message||""));throw e;}if(debug)console.log('received',args[0]);if(args[0].endsWith('.update')){let sum=0;for(const d of result.drawables){const b=d.meshBytes;if(b.length>16){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);for(let i=16;i<Math.min(256,b.length);i+=16)sum+=v.getFloat32(i,true);}}frames.push({count:result.drawables.length,sum});}return result;};
try{if(debug)console.log("mount:start");await runtime.mount();window.ready=true;if(debug)console.log("mount:ready");}catch(e){errors.push(String(e.message||e));window.failed=true;}
</script>`, { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:" } });
        const path = resolve(output, `.${url.pathname}`);
        if (!path.startsWith(output + sep)) return new Response("forbidden", { status: 403 });
        const type = ({ ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" } as Record<string,string>)[extname(path)] || "application/octet-stream";
        return new Response(Bun.file(path), { headers: { "content-type": type } });
      } });
      browser = await chromium.launch({ headless: true });
      const reports = [];
      let startPoint: { x: number; y: number } | undefined;
      for (const mode of ["main", "worker"]) {
        const page = await browser.newPage({ viewport: { width: 240, height: 340 }, deviceScaleFactor: 2 });
        if (process.env.POCKET_LIVE2D_WEB_DEBUG) page.on("console", message => console.log(mode, message.type(), message.text()));
        const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/?mode=${mode}`);
        await page.waitForFunction(() => (window as any).ready || (window as any).failed, { timeout: 30000 });
        expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
        // Read the actual main runtime's retained title layout; the Worker uses
        // the identical QJBC, viewport and pointer coordinates.
        if (!startPoint) startPoint = await page.evaluate(async () => {
          const runtime = (window as any).runtime, snapshot = await runtime.inspect();
          const nodes = snapshot.nodes, parents = new Map<number, number>();
          for (const node of nodes) for (const child of node.children || []) parents.set(child, node.id);
          const title = nodes.find((node: any) => node.text?.includes("启程"));
          if (!title) throw new Error("Actual Hiyori title action is missing: " + JSON.stringify(nodes.filter((n: any) => n.text)));
          const host = runtime.host;
          const rect = (id: number) => host.withBytes(new Uint8Array(32), (pointer: number) => {
            if (!host.exports.web_layout(host.host, id, pointer)) throw new Error("Title layout is missing");
            return Array.from(new Float32Array(host.exports.memory.buffer, pointer, 4));
          });
          const own = rect(title.id); let x = own[0] + own[2] / 2, y = own[1] + own[3] / 2;
          const seen = new Set<number>(); let parent = parents.get(title.id);
          while (parent !== undefined && !seen.has(parent)) { seen.add(parent); const p = rect(parent); x += p[0]; y += p[1]; parent = parents.get(parent); }
          return { x, y };
        });
        if (process.env.POCKET_LIVE2D_WEB_DEBUG) console.log(mode, "pointer", startPoint);
        await page.locator("canvas").click({ position: startPoint });
        if (process.env.POCKET_LIVE2D_WEB_DEBUG) console.log(mode, "pointer:done");
        try { await page.waitForFunction(() => (window as any).frames.length >= 4 || (window as any).errors.length, { timeout: 30000 }); }
        catch (error) { console.error(mode, startPoint, await page.evaluate(async () => ({ errors: (window as any).errors, frames: (window as any).frames, nodes: (await (window as any).runtime.inspect()).nodes.filter((n: any) => n.text) }))); throw error; }
        expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
        await page.waitForFunction(() => new Set((window as any).frames.map((frame: any) => frame.sum.toFixed(3))).size > 1, { timeout: 15000 });
        const report = await page.evaluate(async () => ({ frames: (window as any).frames, stats: await (window as any).runtime.stats(), errors: (window as any).errors }));
        expect(report.frames.every((frame: any) => frame.count >= 100)).toBe(true);
        expect(report.stats.mode).toBe(mode);
        expect(pageErrors).toEqual([]);
        // Mesh deformation must also reach visible pixels. Crop the model's
        // upper body so dialogue typewriter/cursor changes cannot satisfy it.
        const clip = { x: 60, y: 30, width: 120, height: 170 };
        const firstPixels = await page.screenshot({ clip });
        const firstFrame = await page.evaluate(() => (window as any).frames.length);
        await page.waitForFunction((count: number) => (window as any).frames.length >= count + 8, firstFrame, { timeout: 15000 });
        const nextPixels = await page.screenshot({ clip });
        expect(firstPixels.equals(nextPixels)).toBe(false);
        const screenshot = await page.screenshot();
        if (evidence) writeFileSync(join(evidence, `${mode}.png`), screenshot);
        reports.push({ mode, ...report, pageErrors });
        await page.evaluate(() => (window as any).runtime.dispose()); await page.close();
      }
      if (evidence) writeFileSync(join(evidence, "browser-acceptance.json"), JSON.stringify(reports, null, 2));
    } finally { await browser?.close(); await server?.stop(true); rmSync(work, { recursive: true, force: true }); }
  }, { timeout: 120000 },
);
