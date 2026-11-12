import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

type DrawOp = { type?: string; asset?: string; points?: { x: number; y: number }[]; text?: string };
type Frame = { ops?: DrawOp[] };
type ProbeResponse = { error?: string; frame?: Frame };

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "ascii");
  const payload = Buffer.from(data);
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.byteLength);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([length, type, payload, checksum]);
}

function fixturePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [190, 130, 64, 255]).flat()]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat([row, row, row, row]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function runProbe(probe: string, commands: readonly Record<string, unknown>[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ProbeResponse);
}

function fixtureSource(): string {
  return `
import { createSignal, onMount } from "solid-js";
import { mount, getOps } from "@pocketjs/framework/solid";
import { after } from "@pocketjs/framework/clock";
import { Screen, Text } from "@pocketjs/framework/solid/components";
import { NovelModelView } from "@pocket/vn/model-view";
import { createNovelAnimationDriver } from "@pocket/vn/models";
import { encodeNovelMesh } from "@pocket/vn/mesh";

function App() {
  const ops = getOps() as any;
  const originalSetMesh = ops.setMesh.bind(ops);
  const originalSetMeshEffect = ops.setMeshEffect.bind(ops);
  const [metrics, setMetrics] = createSignal({ advances: 0, meshes: 0, effects: 0, scheduled: 0 });
  ops.setMesh = (id: number, texture: number, bytes: Uint8Array) => {
    const result = originalSetMesh(id, texture, bytes);
    setMetrics(value => ({ ...value, meshes: value.meshes + 1 }));
    return result;
  };
  ops.setMeshEffect = (id: number, bytes: Uint8Array) => {
    const result = originalSetMeshEffect(id, bytes);
    setMetrics(value => ({ ...value, effects: value.effects + 1 }));
    return result;
  };

  const animations = createNovelAnimationDriver();
  let x = 12;
  let step = 0;
  const effect = { blend: "normal", repeatTexture: true, multiplyRgb: [1, 1, 1] };
  let geometry = encodeNovelMesh({ vertices: [x, 14, 0, 0, x + 18, 14, 1, 0, x + 4, 34, 0, 1], indices: [0, 1, 2] });
  const factory = () => ({
    setIntent() {},
    advance(deltaMs: number) {
      if (deltaMs > 0) {
        step++;
        if (step === 3) effect.multiplyRgb[0] = 0.5;
        x += 4;
        geometry = encodeNovelMesh({ vertices: [x, 14, 0, 0, x + 18, 14, 1, 0, x + 4, 34, 0, 1], indices: [0, 1, 2] }, geometry);
        setMetrics(value => ({ ...value, advances: value.advances + 1 }));
      }
      return [{ id: "body", texture: "fixture/texture.png", geometry, effect: step >= 4 ? undefined : effect }];
    },
    dispose() {},
  });
  let scheduled = 0;
  const scheduleAdvance = () => {
    after(3 / 60, () => {
      setMetrics(value => ({ ...value, scheduled: value.scheduled + 1 }));
      animations.advance(16);
      if (++scheduled < 6) scheduleAdvance();
    });
  };
  onMount(scheduleAdvance);
  return <Screen class="relative w-full h-full">
    <NovelModelView definition={{ kind: "live2d", source: "fixture", textures: {} }} intent={{ key: "fixture" }} factory={factory as any} animations={animations} />
        <Text class="absolute left-0 top-[60]">advances={metrics().advances} setMesh={metrics().meshes} setMeshEffect={metrics().effects} scheduled={metrics().scheduled}</Text>
  </Screen>;
}
mount(() => <App />);
`;
}

function modelFailureFixtureSource(): string {
  return `
import { createSignal, onCleanup, onMount } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { after } from "@pocketjs/framework/clock";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { NovelModelView } from "@pocket/vn/model-view";
import { createNovelAnimationDriver } from "@pocket/vn/models";
import { encodeNovelMesh } from "@pocket/vn/mesh";

function App() {
  const [intent, setIntent] = createSignal({ key: "advance-fail", animation: "idle" });
  const [metrics, setMetrics] = createSignal({ advanceFailCalls: 0, advanceFailDisposes: 0, intentFailCalls: 0, intentFailDisposes: 0, recoveredCalls: 0, actors: 0, pulses: 0 });
  const animations = createNovelAnimationDriver();
  const removeObserver = animations.subscribe(() => setMetrics(value => ({ ...value, actors: animations.needsClock() ? 1 : 0 })));
  onCleanup(removeObserver);

  const factory = (_definition: unknown, initial: { key: string }) => {
    const identity = initial.key;
    let x = 48;
    let geometry = encodeNovelMesh({ vertices: [x, 150, 0, 0, x + 38, 150, 1, 0, x + 10, 195, 0, 1], indices: [0, 1, 2] });
    return {
      setIntent(next: { animation: string }) {
        if (identity === "set-intent-fail" && next.animation === "throw") throw new Error("setIntent-fail");
      },
      advance(deltaMs: number) {
        if (identity === "advance-fail") {
          setMetrics(value => ({ ...value, advanceFailCalls: value.advanceFailCalls + 1 }));
          return Promise.reject(new Error("advance-fail"));
        }
        if (identity === "set-intent-fail") setMetrics(value => ({ ...value, intentFailCalls: value.intentFailCalls + 1 }));
        else setMetrics(value => ({ ...value, recoveredCalls: value.recoveredCalls + 1 }));
        if (deltaMs > 0) x += 2;
        geometry = encodeNovelMesh({ vertices: [x, 150, 0, 0, x + 38, 150, 1, 0, x + 10, 195, 0, 1], indices: [0, 1, 2] }, geometry);
        return [{ id: "body", texture: "fixture/texture.png", geometry }];
      },
      dispose() {
        if (identity === "advance-fail") setMetrics(value => ({ ...value, advanceFailDisposes: value.advanceFailDisposes + 1 }));
        if (identity === "set-intent-fail") setMetrics(value => ({ ...value, intentFailDisposes: value.intentFailDisposes + 1 }));
      },
    };
  };

  let pulses = 0;
  const pulse = () => after(1 / 60, () => {
    pulses++;
    setMetrics(value => ({ ...value, pulses }));
    animations.advance(16);
    pulse();
  });
  onMount(pulse);

  return <Screen class="relative w-full h-full bg-[#08151D]">
    <NovelModelView definition={{ kind: "live2d", source: "fixture", textures: {} }} intent={intent()} factory={factory as any} animations={animations} />
    <Focusable class="absolute left-0 top-0 w-[150] h-[38] bg-[#273B44]" onPress={() => setIntent({ key: "set-intent-fail", animation: "idle" })}>
      <Text class="absolute left-[4] top-[8] text-xs">retry with another model key</Text>
    </Focusable>
    <Focusable class="absolute left-0 top-[42] w-[150] h-[38] bg-[#273B44]" onPress={() => setIntent(value => ({ ...value, animation: "throw" }))}>
      <Text class="absolute left-[4] top-[8] text-xs">trigger setIntent failure</Text>
    </Focusable>
    <Focusable class="absolute left-0 top-[84] w-[150] h-[38] bg-[#273B44]" onPress={() => setIntent({ key: "recovered", animation: "idle" })}>
      <Text class="absolute left-[4] top-[8] text-xs">recover on next model key</Text>
    </Focusable>
    <Text class="absolute left-0 top-[126] text-xs">key={intent().key}</Text>
    <Text class="absolute left-0 top-[142] text-xs">advanceDisposals={metrics().advanceFailDisposes} advanceCalls={metrics().advanceFailCalls}</Text>
    <Text class="absolute left-0 top-[158] text-xs">intentDisposals={metrics().intentFailDisposes} intentCalls={metrics().intentFailCalls}</Text>
    <Text class="absolute left-0 top-[174] text-xs">actors={metrics().actors} recoveredCalls={metrics().recoveredCalls} pulses={metrics().pulses}</Text>
  </Screen>;
}
mount(() => <App />);
`;
}

function sourceVariants(production: string): { unbatched: string; batched: string } {
  const body = "if (alive && !failed) { setMeshes([...frame]); setVersion(value => value + 1); }";
  const batchedBody = "if (alive && !failed) batch(() => { setMeshes([...frame]); setVersion(value => value + 1); });";
  const importNeedle = 'import { Index, Show, createEffect, createMemo, createRenderEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js";';
  const importWithBatch = 'import { Index, Show, batch, createEffect, createMemo, createRenderEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js";';
  if (production.includes(batchedBody)) {
    assert.ok(production.includes(importWithBatch), "production batch call must import Solid batch");
    const unbatched = production.replace(importWithBatch, importNeedle).replace(batchedBody, body);
    assert.notEqual(unbatched, production, "vendored negative control must remove only the production batch");
    return { unbatched, batched: production };
  }
  assert.ok(production.includes(body), "ablation target must be the existing two signal writes");
  return {
    unbatched: production,
    batched: production.replace(importNeedle, importWithBatch).replace(body, batchedBody),
  };
}

function preFixFailureLifecycleSource(production: string): string {
  const patchedFailure = `      if (!alive || failed) return;
      failed = true;
      setError(cause instanceof Error ? cause.message : String(cause));
      const failedInstance = instance;
      const removeAnimation = unregister;
      unregister = undefined;
      removeAnimation?.();
      instance = undefined;
      if (current === failedInstance) current = undefined;
      if (failCurrent === fail) failCurrent = undefined;
      failedInstance?.dispose();
      setMeshes([]);`;
  const originalFailure = `      if (!alive) return;
      failed = true;
      setError(cause instanceof Error ? cause.message : String(cause));
      unregister?.();
      if (current === instance) current = undefined;
      instance?.dispose();
      setMeshes([]);`;
  const patchedCleanup = `    onCleanup(() => { alive = false; const removeAnimation = unregister; unregister = undefined; removeAnimation?.(); if (current === instance) current = undefined; if (failCurrent === fail) failCurrent = undefined; const activeInstance = instance; instance = undefined; activeInstance?.dispose(); });`;
  const originalCleanup = `    onCleanup(() => { alive = false; unregister?.(); if (current === instance) current = undefined; if (failCurrent === fail) failCurrent = undefined; instance?.dispose(); });`;
  assert.equal(production.split(patchedFailure).length - 1, 1, "production failure cleanup must stay an explicit guest-test target");
  assert.equal(production.split(patchedCleanup).length - 1, 1, "production owner cleanup must stay an explicit guest-test target");
  const baseline = production.replace(patchedFailure, originalFailure).replace(patchedCleanup, originalCleanup);
  assert.notEqual(baseline, production, "negative control must restore the pre-fix retained failure instance");
  return baseline;
}

test("NovelModelView batches one async frame commit without losing retained PMS1 updates", async () => {
  const probe = process.env.POCKET_NATIVE_PROBE;
  assert.ok(probe && existsSync(probe), "set POCKET_NATIVE_PROBE to the pinned native probe");
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-model-commit-"));
  try {
    const vendor = join(project, "vendor/pocket-vn");
    const source = join(vendor, "src");
    mkdirSync(source, { recursive: true });
    cpSync(join(sdkRoot, "packages/pocket_vn/src"), source, { recursive: true });
    const modelViewPath = join(source, "model-view.tsx");
    const variants = sourceVariants(await Bun.file(modelViewPath).text());
    writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "@pocket/vn", type: "module", exports: {
      "./model-view": "./src/model-view.tsx", "./models": "./src/models.ts", "./mesh": "./src/mesh.ts",
    } }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:vendor/pocket-vn" } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-model-commit", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-model-commit", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "images.json"), JSON.stringify({ "fixture/texture.png": { linear: true } }));
    mkdirSync(join(project, "fixture"), { recursive: true });
    writeFileSync(join(project, "fixture/texture.png"), fixturePng());
    writeFileSync(join(project, "app.tsx"), fixtureSource());

    const facts: Record<string, { frames: number; advances: number; setMesh: number; setMeshEffect: number; scheduled: number; meshOps: DrawOp[][] }> = {};
    for (const variant of ["unbatched", "batched"] as const) {
      writeFileSync(modelViewPath, variants[variant]);
      const built = await buildGuest({ projectRoot: project, outDir: join(project, variant) });
      const commands: Record<string, unknown>[] = [
        { op: "create", width: 320, height: 240 },
        { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
        ...Array.from({ length: 48 }, () => ({ op: "frame", deltaMs: 1000 / 60 })),
        { op: "quit" },
      ];
      const responses = runProbe(probe, commands);
      assert.ok(!responses.some(response => response.error), `${variant} native probe error: ${JSON.stringify(responses.filter(response => response.error))}`);
      const frames = responses.flatMap(response => response.frame ? [response.frame] : []);
      const finalText = frames.flatMap(frame => frame.ops ?? []).filter(op => op.type === "text").map(op => op.text ?? "").findLast(text => text.startsWith("advances="));
      assert.ok(finalText, `${variant} metrics text was not painted`);
      const match = /advances=(\d+) setMesh=(\d+) setMeshEffect=(\d+) scheduled=(\d+)/.exec(finalText!);
      assert.ok(match, `${variant} metrics malformed: ${finalText}`);
      const meshOps = frames.map(frame => (frame.ops ?? []).filter(op => op.type === "textureTriangle" && op.asset === "fixture/texture.png"));
      assert.ok(meshOps.at(-1)!.length > 0, `${variant} must paint the native retained PMS1 triangle`);
      facts[variant] = {
        frames: frames.length,
        advances: Number(match[1]),
        setMesh: Number(match[2]),
        setMeshEffect: Number(match[3]),
        scheduled: Number(match[4]),
        meshOps,
      };
    }
    console.log("novel_model_commit_guest: " + JSON.stringify({
      unbatched: { frames: facts.unbatched!.frames, scheduled: facts.unbatched!.scheduled, advances: facts.unbatched!.advances, setMesh: facts.unbatched!.setMesh, setMeshEffect: facts.unbatched!.setMeshEffect },
      batched: { frames: facts.batched!.frames, scheduled: facts.batched!.scheduled, advances: facts.batched!.advances, setMesh: facts.batched!.setMesh, setMeshEffect: facts.batched!.setMeshEffect },
    }));
    assert.equal(facts.batched!.frames, facts.unbatched!.frames, "batching must not change native frame count");
    assert.equal(facts.batched!.advances, facts.unbatched!.advances, "batching must retain the same number of model steps");
    assert.equal(facts.batched!.scheduled, facts.unbatched!.scheduled, "both controls must receive the same deterministic timer advances");
    assert.ok(facts.unbatched!.advances >= 3, "fixture must exercise several reused-buffer updates");
    assert.ok(facts.batched!.setMesh < facts.unbatched!.setMesh, "batch must reduce actual setMesh submissions");
    assert.equal(facts.batched!.setMeshEffect, 3, "only initial effect, in-place tint change and effect removal may cross the native boundary");
    assert.equal(facts.unbatched!.setMeshEffect, 3, "duplicate signal commits must also skip unchanged encoded effects");
    assert.equal(facts.batched!.advances, 6, "keep advancing after effect removal to detect repeated empty submissions");
    assert.deepEqual(facts.batched!.meshOps, facts.unbatched!.meshOps, "native PMS1 output for every frame must remain identical");
    const renderedFirstVertexX = facts.batched!.meshOps.map(ops => ops[0]?.points?.[0]?.x).filter((value): value is number => value !== undefined);
    assert.ok(new Set(renderedFirstVertexX).size >= 3, "in-place versioned PMS1 buffer changes must reach native output on repeated frames");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);

test("NovelModelView failures unregister and dispose once, then recover on a new model key", async () => {
  const probe = process.env.POCKET_NATIVE_PROBE;
  assert.ok(probe && existsSync(probe), "set POCKET_NATIVE_PROBE to the pinned native probe");
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-model-failure-"));
  try {
    const vendor = join(project, "vendor/pocket-vn");
    const source = join(vendor, "src");
    mkdirSync(source, { recursive: true });
    cpSync(join(sdkRoot, "packages/pocket_vn/src"), source, { recursive: true });
    writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "@pocket/vn", type: "module", exports: {
      "./model-view": "./src/model-view.tsx", "./models": "./src/models.ts", "./mesh": "./src/mesh.ts",
    } }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:vendor/pocket-vn" } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-model-failure", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "fixture.novel-model-failure", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "images.json"), JSON.stringify({ "fixture/texture.png": { linear: true } }));
    mkdirSync(join(project, "fixture"), { recursive: true });
    writeFileSync(join(project, "fixture/texture.png"), fixturePng());
    writeFileSync(join(project, "app.tsx"), modelFailureFixtureSource());

    const modelViewPath = join(source, "model-view.tsx");
    const productionModelView = await Bun.file(modelViewPath).text();
    const tap = (x: number, y: number): Record<string, unknown>[] => [
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x, y } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x, y } } },
      { op: "frame", deltaMs: 16 },
    ];
    const frames = (count: number): Record<string, unknown>[] => Array.from({ length: count }, () => ({ op: "frame", deltaMs: 16 }));
    const commandsFor = (built: { bytecode: string; pak: string }): Record<string, unknown>[] => [
      { op: "create", width: 320, height: 240 },
      { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
      ...frames(36),
      ...tap(20, 20),
      ...frames(24),
      ...tap(20, 60),
      ...frames(24),
      ...tap(20, 102),
      ...frames(36),
      { op: "quit" },
    ];
    const paintedText = (frame: Frame) => (frame.ops ?? []).filter(op => op.type === "text").map(op => op.text ?? "").join(" ");
    const runLifecycle = async (modelViewSource: string, outDir: string) => {
      writeFileSync(modelViewPath, modelViewSource);
      const built = await buildGuest({ projectRoot: project, outDir: join(project, outDir) });
      const responses = runProbe(probe, commandsFor(built));
      assert.ok(!responses.some(response => response.error), `native probe error: ${JSON.stringify(responses.filter(response => response.error))}`);
      return responses.flatMap(response => response.frame ? [response.frame] : []);
    };

    const baseline = await runLifecycle(preFixFailureLifecycleSource(productionModelView), "out-before-fix");
    const baselineText = baseline.map(paintedText).findLast(text => text.includes("key=recovered"));
    assert.ok(baselineText, "negative control must reach recovery after native input");
    assert.match(baselineText!, /advanceDisposals=2/, "pre-fix control must expose the advance-failure double dispose");
    assert.match(baselineText!, /intentDisposals=2/, "pre-fix control must expose the setIntent-failure double dispose");

    const observed = await runLifecycle(productionModelView, "out-after-fix");
    const advanceErrorFrames = observed.filter(frame => paintedText(frame).includes("advance-fail"));
    const intentErrorFrames = observed.filter(frame => paintedText(frame).includes("setIntent-fail"));
    assert.ok(advanceErrorFrames.length >= 8, "advance failure UI must remain mounted across later native frames");
    assert.ok(intentErrorFrames.length >= 8, "setIntent failure UI must remain mounted across later native frames");
    assert.ok(advanceErrorFrames.some(frame => paintedText(frame).includes("actors=0")), "advance failure must unregister its animation actor");
    assert.ok(intentErrorFrames.some(frame => paintedText(frame).includes("actors=0")), "setIntent failure must unregister its animation actor");

    const latestText = observed.map(paintedText).findLast(text => text.includes("key=recovered"));
    assert.ok(latestText, "native input must change the errored model key and recover the mounted view");
    assert.match(latestText!, /advanceDisposals=1/, "advance failure must dispose its instance once when its key changes");
    assert.match(latestText!, /intentDisposals=1/, "setIntent failure must dispose its instance once when the next key replaces it");
    assert.match(latestText!, /actors=1/, "the recovered model must register with the animation driver");
    assert.match(latestText!, /recoveredCalls=[1-9]\d*/, "the recovered model must advance on guest frames");

    const recovered = observed.filter(frame => paintedText(frame).includes("key=recovered"));
    const meshFrames = recovered.map(frame => (frame.ops ?? []).filter(op => op.type === "textureTriangle" && op.asset === "fixture/texture.png"));
    assert.ok(meshFrames.some(ops => ops.length > 0), "the recovered model must paint native PMS1 textured triangles");
    const firstVertexXs = meshFrames.flatMap(ops => ops.flatMap(op => op.points?.[0] ? [op.points[0].x] : []));
    assert.ok(new Set(firstVertexXs).size >= 2, "scheduled model advances must change the painted mesh after recovery");
    console.log("novel_model_failure_guest: " + JSON.stringify({
      beforeFix: { advanceDisposals: /advanceDisposals=(\d+)/.exec(baselineText!)?.[1], intentDisposals: /intentDisposals=(\d+)/.exec(baselineText!)?.[1] },
      afterFix: { advanceDisposals: /advanceDisposals=(\d+)/.exec(latestText!)?.[1], intentDisposals: /intentDisposals=(\d+)/.exec(latestText!)?.[1], recoveredMeshFrames: meshFrames.filter(ops => ops.length > 0).length },
    }));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);
