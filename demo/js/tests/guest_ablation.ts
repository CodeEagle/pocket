import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type ProbeResponse = { ok?: boolean; error?: string; runtimeAbi?: string; frame?: Frame };
type Frame = { ops?: Array<{ type?: string; text?: string }> };

const root = resolve(import.meta.dir, "..");
const sdkRoot = resolve(root, "..", "..", "sdk");
const flutterRoot = resolve(root, "..");
const bytecodePath = resolve(process.env.POCKET_GUEST_BYTECODE ?? join(flutterRoot, "assets/app.qjbc"));
const pakPath = resolve(process.env.POCKET_GUEST_PAK ?? join(flutterRoot, "assets/app.pak"));
const metadataPath = resolve(process.env.POCKET_GUEST_METADATA ?? join(flutterRoot, "assets/app.bytecode.json"));

function bytecodeCapable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const binary = readFileSync(path).toString("latin1");
    return binary.includes("loadBytecode") && binary.includes("pocket_load_bytecode_files");
  } catch {
    return false;
  }
}

const configuredProbe = process.env.POCKET_NATIVE_PROBE ? resolve(process.env.POCKET_NATIVE_PROBE) : undefined;
const probe = configuredProbe ?? [
  join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
  join(sdkRoot, "native/target/release/pocket_probe"),
  join(sdkRoot, "native/target/debug/pocket_probe"),
].find(bytecodeCapable);
if (!probe || !bytecodeCapable(probe)) {
  throw new Error("guest_ablation: a bytecode-capable pocket_probe is required; source-mode fallback is not allowed");
}
if (!existsSync(bytecodePath) || !existsSync(pakPath) || !existsSync(metadataPath)) {
  throw new Error("guest_ablation: app.qjbc, app.pak, and app.bytecode.json are required; run build:guest first");
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as JsonObject;
assert.equal(metadata.entryFormat, "quickjs-bytecode");
assert.equal(metadata.kind, "script");
assert.equal(typeof metadata.runtimeAbi, "string");
assert.equal(typeof metadata.bindingGeneration, "number");
assert.equal(typeof metadata.tickHz, "number");

function command(op: string, values: JsonObject = {}): JsonObject {
  return { op, ...values };
}

function frameFor(bytecode: string, pak: string): Frame {
  const commands = [
    command("create", { width: 360, height: 640 }),
    command("loadBytecode", { bytecodePath: bytecode, pakPath: pak }),
    command("frame", { deltaMs: 16 }),
    command("quit"),
  ];
  const result = spawnSync(probe!, {
    input: `${commands.map((item) => JSON.stringify(item)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `guest_ablation probe failed: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, "guest_ablation probe returned no responses");
  const responses = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
  assert.equal(responses[1]?.ok, true, `QuickJS bytecode load failed: ${responses[1]?.error ?? "unknown error"}`);
  assert.equal(responses[1]?.runtimeAbi, metadata.runtimeAbi, "ablation runtime ABI does not match guest metadata");
  const frameResponse = responses.find((response) => response.frame);
  assert.equal(frameResponse?.ok, true, `guest_ablation frame failed: ${frameResponse?.error ?? "unknown error"}`);
  assert.ok(frameResponse?.frame, "guest_ablation frame response is missing JSON");
  return frameResponse.frame;
}

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

const buildGuestScript = join(sdkRoot, "scripts/build_guest.ts");
assert.ok(existsSync(buildGuestScript), `guest_ablation build pipeline is missing: ${buildGuestScript}`);
const originalBuild = mkdtempSync(join(tmpdir(), "pocketjs-guest-ablation-build-"));
const alteredBuild = mkdtempSync(join(tmpdir(), "pocketjs-guest-ablation-bytecode-"));
try {
  const compile = spawnSync("bun", [
    buildGuestScript,
    `--project-root=${root}`,
    `--outdir=${originalBuild}`,
    `--tick-hz=${String(metadata.tickHz)}`,
  ], { cwd: root, stdio: "inherit", timeout: 120_000 });
  if (compile.error) throw compile.error;
  assert.equal(compile.status, 0, "build_guest failed during the guest ablation");

  const generatedSource = join(originalBuild, "app.js");
  const generatedPak = join(originalBuild, "app.pak");
  assert.ok(existsSync(generatedSource) && existsSync(generatedPak), "build_guest did not produce app.js/app.pak");
  const original = readFileSync(generatedSource, "utf8");
  const marker = "One runtime, one source of truth";
  const replacement = "Ablated guest source is live";
  assert.ok(original.includes(marker), "generated guest bundle must contain the ablation marker");
  const alteredSource = join(alteredBuild, "app.js");
  const originalBytecode = join(alteredBuild, "original.qjbc");
  const alteredBytecode = join(alteredBuild, "app.qjbc");
  await Bun.write(alteredSource, original.replace(marker, replacement));

  const configuredCompiler = process.env.POCKET_BYTECODE_COMPILER
    ? resolve(process.env.POCKET_BYTECODE_COMPILER)
    : undefined;
  const bytecodeCompiler = configuredCompiler ?? [
    join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocketjs_bytecode"),
    join(sdkRoot, "native/target/release/pocketjs_bytecode"),
    join(sdkRoot, "native/target/debug/pocketjs_bytecode"),
  ].find(existsSync);
  assert.ok(bytecodeCompiler, "guest_ablation requires the native pocketjs_bytecode compiler");
  const serialize = (source: string, output: string): void => {
    const bytecodeResult = spawnSync(bytecodeCompiler!, [
      "--input", source,
      "--output", output,
      "--kind", "script",
      "--binding-generation", String(metadata.bindingGeneration),
      "--tick-hz", String(metadata.tickHz),
    ], { cwd: root, stdio: "inherit", timeout: 120_000 });
    if (bytecodeResult.error) throw bytecodeResult.error;
    assert.equal(bytecodeResult.status, 0, `native QuickJS bytecode compiler failed for ${source}`);
  };
  // Serialize both variants from this test's package-aware build output. The
  // PAK therefore includes the same @pocket/ui styles as the production path.
  serialize(generatedSource, originalBytecode);
  serialize(alteredSource, alteredBytecode);
  assert.ok(existsSync(alteredBytecode), "native QuickJS compiler did not write altered app.qjbc");

  const before = frameFor(originalBytecode, generatedPak);
  const after = frameFor(alteredBytecode, generatedPak);
  const beforeText = textOf(before);
  const afterText = textOf(after);
  assert.notEqual(JSON.stringify(after), JSON.stringify(before), "changing JS must change the native frame");
  assert.match(afterText, new RegExp(replacement), "mutated guest title must reach the DrawList text");
  assert.doesNotMatch(beforeText, new RegExp(replacement), "baseline qjbc unexpectedly contains the ablation marker");
  console.log(`guest_ablation: altered QuickJS bytecode changed the native first frame (${probe})`);
} finally {
  rmSync(originalBuild, { recursive: true, force: true });
  rmSync(alteredBuild, { recursive: true, force: true });
}
