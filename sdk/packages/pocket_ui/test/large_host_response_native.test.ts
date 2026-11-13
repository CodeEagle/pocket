import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regression for sdk/docs/LARGE_HOST_RESPONSE_DELIVERY.md.
//  1. Back-to-back large host.response messages (100..250 KB each) reach the
//     guest through the real native probe, in the same tick and on later ticks.
//  2. A guest continuation that exceeds the per-turn execution budget after a
//     response is an explicit probe error, not a clean empty frame.

const sdk = resolve(import.meta.dir, "../../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? [
  "native/target/aarch64-apple-darwin/release/pocket_probe",
  "native/target/release/pocket_probe", "native/target/debug/pocket_probe",
].map(path => join(sdk, path)).find(existsSync);

const buttons = { parallel: 20, sequential: 100, spin: 180 } as const;

function buildGuest(project: string): string {
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "large-response-fixture", type: "module" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    pocket: 2, id: "dev.pocket.large-response-fixture", version: "0.1.0",
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [], optional: ["test.big"] }, permissions: { optional: ["network"] } }));
  writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Text, View, Focusable } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
const host = createHostBridge();
const [status, setStatus] = createSignal("Ready");
const note = (text: string) => setStatus((s) => s + " " + text);
function parallel() {
  setStatus("Parallel");
  for (const n of [1, 2, 3]) {
    host.request("test.big", { n }).then((r: any) => note("got" + n + ":" + r.data.length), (e: any) => note("err" + n + ":" + e.code));
  }
}
async function sequential() {
  setStatus("Sequential");
  for (const n of [1, 2, 3]) {
    try { const r: any = await host.request("test.big", { n }); note("got" + n + ":" + r.data.length); }
    catch (e: any) { note("err" + n + ":" + e.code); }
  }
}
async function spin() {
  setStatus("Spin");
  const r: any = await host.request("test.big", { n: 1 });
  note("got" + r.data.length);
  const start = Date.now();
  while (Date.now() - start < 700) { /* a continuation longer than the 250 ms turn budget */ }
  note("spun");
}
mount(() => <View class="w-full h-full flex-col">
  <Focusable class="w-full h-20" onPress={parallel}><Text>Go parallel</Text></Focusable>
  <Focusable class="w-full h-20" onPress={sequential}><Text>Go sequential</Text></Focusable>
  <Focusable class="w-full h-20" onPress={spin}><Text>Go spin</Text></Focusable>
  <Text>{status()}</Text>
</View>);
`);
  const out = join(project, "out");
  const build = spawnSync("bun", [join(sdk, "scripts/build_guest.ts"), `--project-root=${project}`, `--outdir=${out}`], { encoding: "utf8", timeout: 120_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  return out;
}

const textsOf = (responses: any[]): string[] =>
  responses.flatMap(r => r.frame?.ops ?? []).filter((op: any) => op.type === "text").map((op: any) => op.text);
const statusOf = (responses: any[], prefix: string): string | undefined =>
  textsOf(responses).filter(text => text === prefix || text.startsWith(`${prefix} `)).pop();

const bootstrap = (out: string) => [
  { op: "create", width: 360, height: 640 },
  { op: "loadBytecode", bytecodePath: join(out, "app.qjbc"), pakPath: join(out, "app.pak") },
  { op: "frame", deltaMs: 16 },
];
const tap = (y: number) => ["down", "up"].flatMap(phase => [
  { op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, x: 20, y } } },
  { op: "frame", deltaMs: 16 },
]);
const reply = (request: any, size: number) => ({ op: "send", message: { type: "event", name: "host.response", payload: {
  requestId: request.requestId, capability: request.capability, ok: true, result: { data: "x".repeat(size) } } } });
const frame = { op: "frame", deltaMs: 16 };

function run(commands: unknown[]): any[] {
  const result = spawnSync(probe!, [], { input: commands.map(value => JSON.stringify(value)).join("\n") + "\n", encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
}

function requestsOf(responses: any[]): any[] {
  return responses.flatMap(r => r.frame?.events ?? []).filter((e: any) => e.name === "host.request").map((e: any) => e.payload);
}

test("back-to-back large host.response messages are all delivered to the guest", () => {
  expect(probe).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "pocket-large-response-"));
  try {
    const out = buildGuest(project);
    const requests = requestsOf(run([...bootstrap(out), ...tap(buttons.parallel), { op: "quit" }]));
    expect(requests.length).toBe(3);
    for (const size of [100_000, 180_000, 200_000, 250_000]) {
      for (const sameTick of [true, false]) {
        const sends = requests.flatMap(request => sameTick ? [reply(request, size)] : [reply(request, size), frame]);
        const responses = run([...bootstrap(out), ...tap(buttons.parallel), ...sends, frame, frame, { op: "quit" }]);
        for (const response of responses) expect(response.ok, JSON.stringify(response).slice(0, 300)).not.toBe(false);
        expect(statusOf(responses, "Parallel"), `size=${size} sameTick=${sameTick}`).toBe(`Parallel got1:${size} got2:${size} got3:${size}`);
      }
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 300_000);

/** Answers each host.request as soon as its frame arrives, like studio's ProbeSession. */
async function liveSequential(out: string, size: number): Promise<string> {
  const child = spawn(probe!, [], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters: Array<(value: any) => void> = [];
  let buffer = "";
  const send = (command: unknown) => child.stdin.write(JSON.stringify(command) + "\n");
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const parsed = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      for (const event of parsed.frame?.events ?? []) if (event.name === "host.request") send(reply(event.payload, size));
      waiters.shift()?.(parsed);
    }
  });
  const next = () => new Promise<any>(ok => waiters.push(ok));
  const step = () => { send(frame); return next(); };
  try {
    for (const command of bootstrap(out)) { send(command); await next(); }
    for (const command of tap(buttons.sequential)) { send(command); await next(); }
    let text = "";
    for (let i = 0; i < 60 && !/got3|err3/.test(text); i += 1) {
      text = statusOf([await step()], "Sequential") ?? text;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    return text;
  } finally { child.kill(); }
}

test("large host.response messages answered live and sequentially are all delivered", async () => {
  expect(probe).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "pocket-large-response-live-"));
  try {
    const out = buildGuest(project);
    for (const size of [100_000, 180_000, 250_000]) {
      expect(await liveSequential(out, size), `size=${size}`).toBe(`Sequential got1:${size} got2:${size} got3:${size}`);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 300_000);

test("a continuation that exceeds the guest turn budget is an explicit probe frame error", () => {
  expect(probe).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "pocket-turn-budget-"));
  try {
    const out = buildGuest(project);
    const [request] = requestsOf(run([...bootstrap(out), ...tap(buttons.spin), { op: "quit" }]));
    expect(request).toBeTruthy();
    const responses = run([...bootstrap(out), ...tap(buttons.spin), reply(request, 10), frame, frame, frame, { op: "quit" }]);
    const failures = responses.filter(r => r.ok === false);
    expect(failures.length, "the aborted continuation must not look like a clean frame").toBeGreaterThan(0);
    expect(String(failures[0].error)).toContain("interrupted by budget");
    // The aborted continuation never reached its `spun` note.
    expect(textsOf(responses).some(text => text.endsWith("spun"))).toBe(false);
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 300_000);
