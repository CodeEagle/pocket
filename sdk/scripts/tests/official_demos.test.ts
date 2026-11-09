import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { resolveManagedBun } from "../prebuilt_tools.mjs";
import { classifyOfficialDemoLaunchability } from "../official_demos.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const buildScript = join(sdkRoot, "scripts/official_demos.ts");

test("official catalog launchability is emitted from host capability facts", () => {
  assert.deepEqual(classifyOfficialDemoLaunchability({
    status: "passed",
    hostCompatibility: { missingSessionCapabilities: ["input.buttons"] },
  }), {
    launchable: true,
    launchability: "portable_pointer_fallback",
    launchabilityDetails: {
      pointerFallbackCapabilities: ["input.buttons"],
      blockedCapabilities: [],
    },
  });
  assert.deepEqual(classifyOfficialDemoLaunchability({
    status: "passed",
    hostCompatibility: { missingSessionCapabilities: ["net.http"] },
  }), {
    launchable: false,
    launchability: "platform_limited",
    launchabilityDetails: {
      pointerFallbackCapabilities: [],
      blockedCapabilities: ["net.http"],
    },
  });
  assert.equal(classifyOfficialDemoLaunchability({ status: "build_failed" }).launchable, false);
});

test("official worker-http build emits real Worker bytecode, metadata, and manifest", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-official-worker-test-"));
  try {
    const run = spawnSync(resolveManagedBun(sdkRoot), [
      buildScript,
      "build",
      "--apps=worker-http",
      `--out-dir=${outputRoot}`,
    ], {
      cwd: sdkRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const report = JSON.parse(readFileSync(join(outputRoot, "build-report.json"), "utf8")) as any;
    assert.equal(report.defaultSessionCapabilities.includes("input.touch"), true);
    assert.equal(report.defaultSessionCapabilities.includes("display.viewport.live"), true);
    assert.equal(report.defaultSessionCapabilities.includes("runtime.worker"), true);
    assert.equal(report.defaultSessionCapabilities.includes("input.buttons"), false);
    assert.equal(report.conditionallyAvailableSessionCapabilities.includes("input.buttons"), true);
    assert.equal(report.defaultSessionCapabilities.includes("ui.compositor-surfaces"), false);
    const demo = report.demos.find((entry: any) => entry.id === "worker-http");
    assert.equal(demo.build.status, "passed");
    assert.equal(demo.worker.requiredCaps.includes("runtime.worker"), true);
    assert.equal(demo.worker.requiredCaps.includes("net.http"), true);
    assert.equal(demo.sourceAdaptation.kind, "flutter_pointer_fallback");

    const directory = join(outputRoot, "demos/worker-http");
    const uiBytecode = join(directory, "app.qjbc");
    const workerBytecode = join(directory, "app.worker.qjbc");
    const metadataPath = join(directory, "app.bytecode.json");
    const workerMetadataPath = join(directory, "app.worker.bytecode.json");
    const guestManifestPath = join(directory, "guest-manifest.json");
    for (const path of [uiBytecode, workerBytecode, metadataPath, workerMetadataPath, guestManifestPath]) {
      assert.equal(existsSync(path), true, `missing ${path}`);
    }
    assert.equal(readFileSync(workerBytecode).subarray(0, 4).toString(), "PJBC");

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as any;
    const descriptor = metadata.worker;
    assert.equal(descriptor.bytecode.path, "app.worker.qjbc");
    assert.equal(descriptor.bytecode.bytes, readFileSync(workerBytecode).byteLength);
    assert.equal(
      descriptor.bytecode.sha256,
      createHash("sha256").update(readFileSync(workerBytecode)).digest("hex"),
    );
    assert.equal(JSON.parse(readFileSync(workerMetadataPath, "utf8")).bytecodeBytes, readFileSync(workerBytecode).byteLength);

    const manifest = JSON.parse(readFileSync(guestManifestPath, "utf8")) as any;
    assert.deepEqual(manifest.worker, descriptor);
    assert.deepEqual(manifest.domains.worker, descriptor.declaration);
    assert.equal(manifest.capabilities.requires.includes("runtime.worker"), true);
    assert.equal(manifest.capabilities.requires.includes("net.http"), true);
    assert.equal(manifest.capabilities.optional.includes("input.buttons"), true);
    assert.equal(manifest.capabilities.requires.includes("input.buttons"), false);

    // Benchmark mode must reuse the mounted pak name and hydrate the Worker
    // descriptor from existing metadata instead of falling back to plain
    // pocket_bench (which would fail before evaluating a channel-using UI).
    const benchmark = spawnSync(resolveManagedBun(sdkRoot), [
      buildScript,
      "benchmark",
      "--apps=worker-http",
      `--out-dir=${outputRoot}`,
      "--frames=1",
      "--warmup=0",
    ], {
      cwd: sdkRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(benchmark.error, undefined, benchmark.error?.message);
    assert.equal(benchmark.status, 0, `${benchmark.stdout}\n${benchmark.stderr}`);
    const benchmarkReport = JSON.parse(readFileSync(join(outputRoot, "report.json"), "utf8")) as any;
    assert.equal(benchmarkReport.demos[0].status, "passed");
    assert.equal(benchmarkReport.demos[0].nativeBenchmark.workerAware, true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}, 120_000);
