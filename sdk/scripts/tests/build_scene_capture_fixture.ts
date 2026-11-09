import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildGuest } from "../../scripts/build_guest.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const fixtureRoot = join(
  sdkRoot,
  "packages/pocket_flutter/test/fixtures/scene_capture",
);
const defaultOutputRoot = join(
  sdkRoot,
  ".pocket-build/save-thumbnail-20261108",
);

function outputRootFromArgs(args: string[]): string {
  if (args.length === 0) return defaultOutputRoot;
  if (args.length > 2) {
    throw new Error("usage: build_scene_capture_fixture.ts [--out-dir <path>]");
  }
  if (args.length === 1 && args[0]!.startsWith("--out-dir=")) {
    const value = args[0]!.slice("--out-dir=".length);
    if (value.trim().length === 0) throw new Error("--out-dir must not be empty");
    return resolve(value);
  }
  if (args.length === 2 && args[0] === "--out-dir") {
    if (args[1]!.trim().length === 0) throw new Error("--out-dir must not be empty");
    return resolve(args[1]!);
  }
  throw new Error("usage: build_scene_capture_fixture.ts [--out-dir <path>]");
}

const outputRoot = outputRootFromArgs(process.argv.slice(2));
const assetsRoot = join(outputRoot, "assets");
const compilerOutput = join(outputRoot, "compiler-output");
mkdirSync(assetsRoot, { recursive: true });
mkdirSync(compilerOutput, { recursive: true });

const result = await buildGuest({
  projectRoot: fixtureRoot,
  outDir: compilerOutput,
  copyAssetsTo: assetsRoot,
  tickHz: 60,
  rasterDensity: 1,
});

const requiredAssets = [
  "app.qjbc",
  "app.pak",
  "app.bytecode.json",
  "guest-manifest.json",
];
for (const name of requiredAssets) {
  if (!existsSync(join(assetsRoot, name))) {
    throw new Error(`build_guest did not publish ${join(assetsRoot, name)}`);
  }
}

const hash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const metadata = JSON.parse(
  readFileSync(join(assetsRoot, "app.bytecode.json"), "utf8"),
) as { entryFormat?: string; runtimeAbi?: string; payloadSha256?: string };
if (metadata.entryFormat !== "quickjs-bytecode" || !metadata.runtimeAbi) {
  throw new Error("build_guest did not emit admitted QuickJS bytecode metadata");
}

console.log(`scene-capture fixture output: ${outputRoot}`);
console.log(`runtimeAbi: ${metadata.runtimeAbi}`);
console.log(`payloadSha256: ${metadata.payloadSha256 ?? "missing"}`);
console.log(`app.qjbc sha256: ${hash(join(assetsRoot, "app.qjbc"))}`);
console.log(`app.pak sha256: ${hash(join(assetsRoot, "app.pak"))}`);
