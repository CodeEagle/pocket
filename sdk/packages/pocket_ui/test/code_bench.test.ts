import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as api from "../src/code/index.ts";
import { buildCorpus } from "./code_corpus.ts";
import { runBench, type BenchResult } from "./code_bench.ts";

const corpus = buildCorpus(5000);

function expectSample(r: BenchResult) {
  expect(r.lines).toBe(5000);
  // line 16: `    <div class="list" data-id={props.items.length}>`
  expect(r.sample.tokens.slice(0, 4)).toEqual([["<", "jsx-tag"], ["div", "jsx-tag"], ["class", "jsx-attribute"], ["=", "operator"]]);
  expect(r.sample.tokens).toContainEqual(["\"list\"", "string"]);
}

test("benchmark in Bun: 5,000-line TSX tokenise, keystroke retokenise, viewport + hit-test", () => {
  const r = runBench(api, corpus, () => performance.now(), "bun");
  console.log("CODE_BENCH bun " + JSON.stringify({ ...r, sample: undefined }));
  expectSample(r);
  expect(corpus.length).toBeGreaterThan(150_000);
  expect(r.tokenizeFullMs).toBeLessThan(1500);
  expect(r.keystrokeRetokenizeMs).toBeLessThan(10);
  expect(r.keystrokeLinesRetokenized).toBeLessThan(50);
  expect(r.editorKeystrokeMs).toBeLessThan(10);
  expect(r.viewportHitTestUs).toBeLessThan(500);
  expect(r.bufferLookupUs).toBeLessThan(500);
});

test("2 MiB / 5,000 line buffer load and edit", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ("// line " + i + " ").padEnd(419, "x")).join("\n");
  expect(big.length).toBeGreaterThan(2 * 1024 * 1024 - 1);
  const t0 = performance.now();
  const ed = new api.CodeEditor(big);
  const cache = new api.TokenCache("tsx"); cache.attach(ed.buffer);
  ed.selection = api.single(ed.buffer.offsetAt(2500, 3));
  for (let i = 0; i < 50; i++) ed.handleInput({ kind: "commit", text: "z" });
  const ms = performance.now() - t0;
  console.log("CODE_BENCH bun 2MiB load+tokenise+50 keystrokes ms=" + ms.toFixed(1));
  expect(ed.buffer.length).toBe(big.length + 50);
  expect(ms).toBeLessThan(5000);
});

test("benchmark in the real QuickJS guest runtime (buildGuest + native probe)", () => {
  const sdk = resolve(import.meta.dir, "../../..");
  const probe = process.env.POCKET_NATIVE_PROBE ?? [
    "native/target/aarch64-apple-darwin/release/pocket_probe",
    "native/target/release/pocket_probe", "native/target/debug/pocket_probe",
  ].map(path => join(sdk, path)).find(existsSync);
  expect(probe).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "pocket-code-bench-"));
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "code-bench-fixture", type: "module" }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.code-bench", version: "0.1.0", app: { entry: "app.tsx", output: "app", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    for (const f of ["code_bench.ts", "code_corpus.ts"]) writeFileSync(join(project, f), readFileSync(join(import.meta.dir, f)));
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import * as code from "@pocket/ui/code";
import { buildCorpus } from "./code_corpus.ts";
import { runBench } from "./code_bench.ts";
let status = "running";
try {
  const r = runBench(code, buildCorpus(5000), () => Date.now(), "quickjs");
  status = "done";
  (globalThis as any).pocket._emitValue({ type: "event", name: "code.bench", payload: r });
} catch (e) {
  status = "error";
  (globalThis as any).pocket._emitValue({ type: "event", name: "code.bench.error", payload: { message: String(e && (e as any).stack || e) } });
}
mount(() => <View class="w-full h-full"><Text>{status}</Text></View>);
`);
    const out = join(project, "out");
    const build = spawnSync("bun", [join(sdk, "scripts/build_guest.ts"), "--project-root=" + project, "--outdir=" + out], { encoding: "utf8", timeout: 120_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const commands = [
      { op: "create", width: 360, height: 640 },
      { op: "loadBytecode", bytecodePath: join(out, "app.qjbc"), pakPath: join(out, "app.pak") },
      { op: "frame", deltaMs: 16 }, { op: "frame", deltaMs: 16 }, { op: "quit" },
    ];
    const result = spawnSync(probe!, [], { input: commands.map(v => JSON.stringify(v)).join("\n") + "\n", encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const replies = result.stdout.trim().split(/\r?\n/).map(l => JSON.parse(l));
    for (const rep of replies) expect(rep.ok, JSON.stringify(rep)).not.toBe(false);
    const events = replies.flatMap(v => v.frame?.events ?? []);
    const err = events.find((e: any) => e.name === "code.bench.error");
    expect(err, JSON.stringify(err)).toBeUndefined();
    const ev = events.find((e: any) => e.name === "code.bench");
    expect(ev, JSON.stringify(replies).slice(0, 2000)).toBeDefined();
    const r = ev.payload as BenchResult;
    console.log("CODE_BENCH quickjs " + JSON.stringify({ ...r, sample: undefined }) + " probe=" + probe);
    expectSample(r);
    expect(r.tokenizeFullMs).toBeLessThan(15_000);
    expect(r.keystrokeRetokenizeMs).toBeLessThan(200);
    expect(r.editorKeystrokeMs).toBeLessThan(200);
    expect(r.viewportHitTestUs).toBeLessThan(5000);
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 400_000);
