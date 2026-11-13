import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { ProbeSession, textOf, type Frame } from "./probe_session.ts";
import { artifacts } from "./probe_session.ts";
import { focusEditor, has, openAlpha, openFile, press, tapText } from "./helpers.ts";
import { FakePublish } from "./fake_publish.ts";

// M7 profiling (Linux part): the built Studio guest on the real native probe (real QuickJS, debug native build) driven
// through scripted scenarios. Numbers are printed as a table (STUDIO_PROFILE ...) and compared with GENEROUS bounds: a
// bound catches an order-of-magnitude regression (a leak, an O(n^2) path), not a few percent. See studio/docs/PERFORMANCE.md.
//
// Measures per scenario:
//   frames        frame commands issued (guest turn + draw-list build + JSON, the probe's equivalent of one host frame)
//   changed       frames whose draw ops differ from the previous frame (a "built" frame; the rest were unchanged)
//   p50/p95/max   wall ms per frame command = guest time + native frame build (includes the probe's JSON serialisation)
//   rssMB         resident set size of the probe process after the scenario (QuickJS heap + native caches + draw lists)
// plus QuickJS heap high-water: the smallest `memory.heapLimitBytes` (a real allocator ceiling, see APP_MEMORY_LIMITS.md)
// under which the whole scenario sequence still completes. The SDK exposes no used-bytes counter, so the ceiling is bisected.

const heavy = process.env.STUDIO_PROFILE_HEAP !== "0";
const sourceLines = (n: number) => Array.from({ length: n }, (_, i) => `export const line${i + 1} = { id: ${i + 1}, label: "item ${i + 1}" }; // MARK${i + 1}\n`).join("");
const digest = (f: Frame) => createHash("sha1").update(JSON.stringify(f.ops ?? [])).digest("hex");
const rssMB = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Math.round(Number(m[1]) / 1024) : -1;
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };

interface Row { scenario: string; frames: number; changed: number; p50: number; p95: number; max: number; rssMB: number }

/** Wraps ProbeSession.frame to time every frame command and count changed frames. */
function instrument(session: ProbeSession) {
  const times: number[] = [];
  let changed = 0, last = "";
  const frame = session.frame.bind(session);
  session.frame = async () => {
    const t0 = performance.now();
    const f = await frame();
    times.push(performance.now() - t0);
    const d = digest(f);
    if (d !== last) { changed += 1; last = d; }
    return f;
  };
  return {
    reset: () => { times.length = 0; changed = 0; },
    row: (scenario: string): Row => ({ scenario, frames: times.length, changed, p50: +pct(times, 0.5).toFixed(1), p95: +pct(times, 0.95).toFixed(1), max: +Math.max(0, ...times).toFixed(1), rssMB: rssMB(session.pid) }),
  };
}

async function bootProfile(lines: number, memory?: { heapLimitBytes: number }) {
  const fake = new FakePublish();
  fake.storage.set("studio.settings.v1", { editor: "code", dockPreview: false });
  fake.files.set("app.tsx", sourceLines(lines));
  for (let i = 0; i < 6; i += 1) fake.files.set(`src/file${i}.ts`, sourceLines(120));
  const session = new ProbeSession(fake.handle, { width: 900, height: 640 }, memory);
  fake.attach(session);
  await session.boot();
  return { fake, session };
}

/** The scripted scenarios. `rows` receives one measurement row per scenario. */
async function runScenarios(session: ProbeSession, fake: FakePublish, rows: Row[], inst: ReturnType<typeof instrument>, lines: number, keys: number): Promise<void> {
  const record = (name: string) => { rows.push(inst.row(name)); inst.reset(); };
  inst.reset();
  await openAlpha(session);
  record("open project");
  let frame = await openFile(session, "app.tsx", "line1");
  frame = await session.until((f) => has(f, `共 ${lines + 1} 行`), "line count", 400);
  await session.settle(5);
  record(`open ${lines}-line file`);

  for (let i = 0; i < 60; i += 1) { session.sendEvent("input.scroll", { x: 600, y: 300, deltaY: 400, source: "wheel", phase: "update" }); await session.frame(); }
  for (let i = 0; i < 60; i += 1) { session.sendEvent("input.scroll", { x: 600, y: 300, deltaY: -400, source: "wheel", phase: "update" }); await session.frame(); }
  record("scroll 120 wheel steps");

  frame = await focusEditor(session, /^export$/);
  inst.reset();
  for (let i = 0; i < keys; i += 1) {
    session.sendEvent("input.text", [{ kind: "commit", text: String.fromCharCode(97 + (i % 26)) }] as unknown as Record<string, unknown>);
    await session.frame();
  }
  record(`type ${keys} keys`);

  // Save then build through Cmd+S / Cmd+B (the shell keymap).
  await press(session, "s", 8);
  await session.until((f) => has(f, "已保存 app.tsx"), "saved", 1200);
  inst.reset();
  await press(session, "b", 8);
  await session.until(() => fake.builtRevision === fake.revision && !fake.busy && fake.calls("studio.build.start").length > 0, "build finished", 600);
  await session.settle(10);
  record("build (Cmd+B)");

  frame = await press(session, "8", 8);
  frame = await session.until((f) => has(f, "发布测试包"), "publish page");
  inst.reset();
  await tapText(session, frame, "发布测试包");
  await session.until((f) => has(f, "已发布") || fake.releases.length > 0, "published", 600);
  await session.settle(10);
  record("publish (test channel)");
}

/** Tab open/close churn: every cycle opens and closes the six small files; used for the leak bound. */
async function churn(session: ProbeSession, cycles: number): Promise<void> {
  for (let c = 0; c < cycles; c += 1) {
    for (let i = 0; i < 6; i += 1) {
      await press(session, "p", 8);
      await session.settle(12); // the field opens its editing session shortly after the overlay mounts
      await session.typeIntoOpenField(`file${i}`);
      await session.settle(2);
      await press(session, "Enter");
      await session.settle(4);
    }
    for (let i = 0; i < 6; i += 1) { await press(session, "w", 8); await session.settle(3); }
  }
}

test("profile: scripted scenarios, frame timings, RSS, leak bound", async () => {
  const LINES = Number(process.env.STUDIO_PROFILE_LINES ?? 5000);
  const KEYS = 100;
  const { fake, session } = await bootProfile(LINES);
  const inst = instrument(session);
  const rows: Row[] = [];
  try {
    await runScenarios(session, fake, rows, inst, LINES, KEYS);

    // Leak check: the open-tab / close-tab churn must not grow the resident set without bound.
    await openAlpha(session).catch(() => undefined);
    await session.settle(5);
    const before = rssMB(session.pid);
    await churn(session, 2); // warm up caches
    const warm = rssMB(session.pid);
    inst.reset();
    await churn(session, Number(process.env.STUDIO_PROFILE_CHURN ?? 6));
    const after = rssMB(session.pid);
    rows.push(inst.row("tab churn 6x6 open+close"));
    assert.ok(fake.calls("studio.fs.read").length >= 36, `the churn really opened files (${fake.calls("studio.fs.read").length} reads)`);
    assert.ok(textOf(await session.frame()).length > 0);

    console.log("STUDIO_PROFILE table");
    console.log("scenario".padEnd(28), "frames changed   p50   p95   max  rssMB");
    for (const r of rows) console.log(r.scenario.padEnd(28), String(r.frames).padStart(6), String(r.changed).padStart(7), String(r.p50).padStart(6), String(r.p95).padStart(5), String(r.max).padStart(5), String(r.rssMB).padStart(6));
    console.log(`STUDIO_PROFILE churn rss before=${before}MB warm=${warm}MB after=${after}MB`);
    console.log("STUDIO_PROFILE json " + JSON.stringify({ lines: LINES, keys: KEYS, rows, churn: { before, warm, after } }));

    // Generous regression bounds (debug native build, shared CI-like machine).
    for (const r of rows) {
      assert.ok(r.p95 < 250, `${r.scenario}: p95 ${r.p95} ms exceeds the 250 ms guest turn budget`);
      assert.ok(r.max < 2000, `${r.scenario}: max frame ${r.max} ms`);
      assert.ok(r.rssMB < 900, `${r.scenario}: RSS ${r.rssMB} MB`);
    }
    const typing = rows.find((r) => r.scenario.startsWith("type"))!;
    assert.ok(typing.p50 < 120, `typing p50 ${typing.p50} ms`);
    assert.ok(after - warm < 40, `tab churn leaked ${after - warm} MB across 36 open/close cycles after warm-up`);
  } finally { session.kill(); }
}, 600_000);

test("profile: QuickJS heap high-water for the scenario sequence (bisected allocator ceiling)", async () => {
  if (!heavy) return;
  const LINES = 2000; // smaller file: the ceiling search repeats the sequence
  const pak = artifacts().pakPath;
  const pakBytes = readFileSync(pak).length;
  const attempt = async (heapLimitBytes: number): Promise<boolean> => {
    let session: ProbeSession | undefined;
    try {
      const b = await bootProfile(LINES, { heapLimitBytes });
      session = b.session;
      const inst = instrument(session);
      await runScenarios(session, b.fake, [], inst, LINES, 40);
      return true;
    } catch { return false; } finally { session?.kill(); }
  };
  // The ceiling counts the PAK copy too. Search above the PAK size; the default is 16 MiB + PAK.
  let lo = pakBytes + 2 * 1024 * 1024, hi = pakBytes + 64 * 1024 * 1024;
  assert.ok(await attempt(hi), "the sequence must complete with a 64 MiB guest heap");
  while (hi - lo > 4 * 1024 * 1024) {
    const mid = Math.floor((lo + hi) / 2);
    if (await attempt(mid)) hi = mid; else lo = mid;
  }
  const guestMiB = +((hi - pakBytes) / 1024 / 1024).toFixed(1);
  console.log(`STUDIO_PROFILE heap pak=${(pakBytes / 1024 / 1024).toFixed(2)}MiB sequenceFitsIn=${(hi / 1024 / 1024).toFixed(1)}MiB (guest heap above the PAK ~${guestMiB} MiB, resolution 4 MiB, ${LINES}-line file, 40 keys)`);
  // The historical default is 16 MiB above the PAK: the Studio must stay inside it with headroom.
  assert.ok(guestMiB <= 16, `Studio guest heap high-water ${guestMiB} MiB exceeds the 16 MiB default above the PAK`);
}, 900_000);
