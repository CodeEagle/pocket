import { chromium } from "playwright";
import { buildWeb } from "./build_web.ts";
import { extname, join, resolve, sep } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Mode = "main" | "worker";
type Complexity = "light" | "heavy";

const ENGINE = process.env.POCKET_WEB_ENGINE || resolve("sdk/.pocket-build/web-engine/pocketjs.wasm");
const RUNTIME = process.env.POCKET_WEB_RUNTIME || resolve("sdk/.pocket-build/web-engine/pocket-web.js");
const REPORT = process.env.POCKET_RENDER_WORKER_BENCHMARK_REPORT || "/tmp/pocket-worker-performance.json";
const WARMUP_MS = 2_000;
const SAMPLE_MS = 5_000;
const ROUNDS = 3;

function cells(count: number): string {
  const columns = count <= 8 ? 4 : 16;
  return Array.from({ length: count }, (_, index) => {
    const x = (index % columns) * (count <= 8 ? 44 : 24) + 8;
    const y = Math.floor(index / columns) * (count <= 8 ? 38 : 20) + 38;
    const color = index % 2 ? "#5eead4" : "#60a5fa";
    return `<View class="absolute bg-[${color}] rounded-[2]" style={{ insetL: ${x} + ((frame() + ${index}) % 2), insetT: ${y} + ((frame() + ${index}) % 3), width: ${count <= 8 ? 34 : 18}, height: ${count <= 8 ? 28 : 14}, opacity: 0.35 + (((frame() + ${index}) % 5) / 10) }} />`;
  }).join("\n");
}

function appSource(complexity: Complexity): string {
  const count = complexity === "light" ? 8 : 256;
  return `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";

function App() {
  const [frame, setFrame] = createSignal(0);
  onFrame(() => setFrame(value => value + 1));
  return <View class="absolute left-0 top-0 w-full h-full bg-[#0b1020]">
    <Text class="absolute left-[8] top-[8] text-xs text-white">{"${complexity} frame=" + frame()}</Text>
    ${cells(count)}
  </View>;
}
mount(() => <App />);
`;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function summarizeDelays(values: number[]) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function makeHtml(prefix: string, mode: Mode): string {
  const explicitMode = mode === "main" ? "renderWorker: false," : "";
  return `<!doctype html>
<style>html,body{margin:0;width:100%;height:100%;background:#000}canvas{width:480px;height:320px;display:block}</style>
<canvas id="pocket" tabindex="0"></canvas>
<script type="module">
  import { PocketWebRuntime } from '${prefix}/pocket-web.js';
  const config = await fetch('${prefix}/pocket.config.json').then(response => response.json());
  window.errors = [];
  window.runtime = new PocketWebRuntime({
    canvas: document.querySelector('#pocket'),
    engineUrl: '${prefix}/engine/pocketjs.wasm',
    qjbcUrl: '${prefix}/app.qjbc',
    pakUrl: '${prefix}/app.pak',
    config,
    ${explicitMode}
    renderWorkerUrl: '${prefix}/pocket-render-worker.js',
    onError: error => window.errors.push(String(error?.message || error)),
  });
  window.runtime.mount().then(() => window.ready = true).catch(error => {
    window.errors.push(String(error?.message || error));
    window.failed = true;
  });
  window.beginSample = async () => {
    const before = await window.runtime.stats();
    const delays = [];
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      delays.push(Math.max(0, now - previous - 20));
      previous = now;
    }, 20);
    window.sampleState = { before, delays, timer, startedAt: performance.now() };
  };
  window.endSample = async () => {
    const state = window.sampleState;
    clearInterval(state.timer);
    const after = await window.runtime.stats();
    return { before: state.before, after, delays: state.delays, elapsedMs: performance.now() - state.startedAt };
  };
</script>`;
}

async function buildFixture(root: string, complexity: Complexity, output: string) {
  const project = join(root, complexity);
  mkdirSync(project, { recursive: true });
  // Keep the identity within the same accepted shape as the browser integration
  // gate; the benchmark compares placement, not app-id validation behavior.
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ id: "pocket.test.render-worker", app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "app.tsx"), appSource(complexity));
  await buildWeb({ projectRoot: project, outDir: output, enginePath: ENGINE, runtimePath: RUNTIME, renderWorker: true });
}

async function runSample(page: any, prefix: string, mode: Mode, complexity: Complexity, round: number, serverPort: number) {
  await page.goto(`http://127.0.0.1:${serverPort}/run?prefix=${encodeURIComponent(prefix)}&mode=${mode}&complexity=${complexity}`);
  await page.waitForFunction(() => (window as any).ready || (window as any).failed, { timeout: 30_000 });
  const diagnostics = await page.evaluate(() => ({ errors: (window as any).errors, failed: (window as any).failed }));
  if (diagnostics.errors.length || diagnostics.failed) {
    throw new Error(`render benchmark ${complexity}/${mode} failed: ${diagnostics.errors.join("; ")}`);
  }
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => (window as any).beginSample());
  await page.waitForTimeout(SAMPLE_MS);
  const sample = await page.evaluate(async () => {
    const result = await (window as any).endSample();
    return { before: result.before, after: result.after, delays: result.delays, elapsedMs: result.elapsedMs, errors: (window as any).errors };
  });
  const frameDelta = Math.max(0, sample.after.frameCount - sample.before.frameCount);
  const elapsedMs = Math.max(1, Number(sample.elapsedMs) || SAMPLE_MS);
  const frameDurationMs = Math.max(0, sample.after.frameDurationMs - sample.before.frameDurationMs);
  const result = {
    round,
    mode,
    complexity,
    elapsedMs,
    frameDelta,
    advanceHz: frameDelta * 1000 / elapsedMs,
    averageAdvanceMs: frameDelta ? frameDurationMs / frameDelta : null,
    totalAdvanceMs: frameDurationMs,
    eventLoopDelay: summarizeDelays(sample.delays),
    errors: sample.errors,
  };
  await page.close();
  return result;
}

let server: ReturnType<typeof Bun.serve> | undefined;

async function main() {
  if (!readFileSync(ENGINE).length) throw new Error(`Missing WebAssembly engine: ${ENGINE}`);
  if (!readFileSync(RUNTIME).length) throw new Error(`Missing browser runtime: ${RUNTIME}`);
  const root = mkdtempSync(join(tmpdir(), "pocket-render-worker-bench-"));
  const outputs = new Map<Complexity, string>();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const complexity of ["light", "heavy"] as Complexity[]) {
      const output = join(root, `${complexity}-web`);
      await buildFixture(root, complexity, output);
      outputs.set(complexity, output);
    }
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/run") {
          const prefix = url.searchParams.get("prefix");
          const mode = url.searchParams.get("mode");
          const complexity = url.searchParams.get("complexity");
          if (!prefix || (mode !== "main" && mode !== "worker") || (complexity !== "light" && complexity !== "heavy")) return new Response("bad request", { status: 400 });
          return new Response(makeHtml(prefix, mode), { headers: { "content-type": "text/html" } });
        }
        const match = url.pathname.match(/^\/(light|heavy)-web(\/.*)$/);
        if (!match) return new Response("not found", { status: 404 });
        const output = outputs.get(match[1] as Complexity)!;
        const file = resolve(output, `.${decodeURIComponent(match[2])}`);
        if (!file.startsWith(output + sep)) return new Response("forbidden", { status: 403 });
        const suffix = extname(file);
        const contentType = suffix === ".js" ? "text/javascript" : suffix === ".wasm" ? "application/wasm" : suffix === ".json" ? "application/json" : "application/octet-stream";
        return new Response(Bun.file(file), { headers: { "content-type": contentType } });
      },
    });
    const results: any[] = [];
    const orders: Mode[][] = [["main", "worker"], ["worker", "main"], ["main", "worker"]];
    for (const complexity of ["light", "heavy"] as Complexity[]) {
      const prefix = `/${complexity}-web`;
      for (let round = 0; round < ROUNDS; round++) {
        for (const mode of orders[round]) {
          const page = await browser.newPage();
          const result = await runSample(page, prefix, mode, complexity, round + 1, server.port);
          results.push(result);
          console.error(`${complexity}/${mode} round ${round + 1}: ${result.advanceHz.toFixed(2)} Hz, timer p95 ${result.eventLoopDelay.p95Ms?.toFixed(2)} ms`);
        }
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      engine: ENGINE,
      runtime: RUNTIME,
      warmupMs: WARMUP_MS,
      sampleMs: SAMPLE_MS,
      rounds: ROUNDS,
      note: "advanceHz is completed host.advance frequency, not display GPU FPS. Event-loop delay is sampled by a 20ms main-thread timer. Input-to-pixel latency is not measured because inspect() observes the runtime tree rather than the exact Canvas presentation timestamp.",
      results,
    };
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
