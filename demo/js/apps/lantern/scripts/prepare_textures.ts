import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// PAK TEX remains power-of-two <=512; static PAK IMG can use power-of-two
// dimensions through 2048. Preserve masters and prepare only runtime copies.
const project = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(project, "images.json"), "utf8")) as Record<string, {
  linear?: unknown;
  sourceSize?: unknown;
}>;
const args = process.argv.slice(2);
if (args.length > 1 || args.some(value => !value.startsWith("--only="))) throw new Error("Usage: prepare_textures.ts [--only=art/path.png]");
const only = args[0]?.slice("--only=".length);
if (only !== undefined && !Object.hasOwn(manifest, only)) throw new Error(`Texture is not registered: ${only}`);
const keys = only === undefined ? Object.keys(manifest) : [only];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let prepared = 0;
let retainedVectors = 0;
let skippedLive2d = 0;

function sourcePngDimensions(path: string): { width: number; height: number } {
  const data = readFileSync(path);
  if (data.length < 29 || !data.subarray(0, 8).equals(pngSignature) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Source-size texture must be a valid PNG: ${path}`);
  }
  const bitDepth = data[24];
  const colorType = data[25];
  const interlace = data[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Source-size texture must be non-interlaced RGBA8: ${path} (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value && result <= 2048) result <<= 1;
  return result;
}

function prepareSourceSizePng(key: string, master: string, output: string): void {
  const { width, height } = sourcePngDimensions(master);
  const outputWidth = nextPowerOfTwo(width);
  const outputHeight = nextPowerOfTwo(height);
  if (width < 1 || height < 1 || outputWidth > 2048 || outputHeight > 2048) {
    throw new Error(`Source-size texture exceeds static PAK IMG limits: ${key} ${width}x${height} (max 2048 power-of-two per side)`);
  }
  const left = Math.floor((outputWidth - width) / 2);
  // Top alignment preserves the authored hanging chain at the source top edge.
  const filter = `format=rgba,pad=${outputWidth}:${outputHeight}:${left}:0:color=black@0,format=rgba`;
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", master,
    "-vf", filter, "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", output,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Source-size texture preparation needs ffmpeg: ${result.error ?? result.stderr}`);
  }
  const resultDimensions = sourcePngDimensions(output);
  if (resultDimensions.width !== outputWidth || resultDimensions.height !== outputHeight) {
    throw new Error(`Source-size padding produced unexpected dimensions for ${key}: ${resultDimensions.width}x${resultDimensions.height}`);
  }
}

for (const key of keys) {
  const options = manifest[key];
  if (!options || typeof options !== "object" || typeof options.linear !== "boolean") {
    throw new Error(`Texture settings must declare a boolean linear field: ${key}`);
  }
  if (options.sourceSize !== undefined && options.sourceSize !== true) {
    throw new Error(`sourceSize must be true when present: ${key}`);
  }
  // Live2D images are prepared and dimension-checked by prepare_live2d.ts.
  // Do not feed those cache paths through the generic 512px image baker.
  if (/^\.pocket-build\/live2d\/.+\.png$/.test(key)) {
    if (options.sourceSize) throw new Error(`Live2D source dimensions belong to prepare_live2d.ts: ${key}`);
    skippedLive2d += 1;
    continue;
  }
  if (/^art\/fx\/[a-z-]+\.svg$/.test(key)) {
    if (options.sourceSize) throw new Error(`SVG textures cannot use sourceSize: ${key}`);
    if (!existsSync(join(project, key))) throw new Error(`Original vector is missing: ${key}`);
    retainedVectors += 1;
    continue;
  }
  if (!/^art\/(?:(?:ui|fx)\/)?[a-z-]+\.png$/.test(key)) throw new Error(`Unexpected texture key: ${key}`);
  const master = join(project, "art/masters", key.slice(4));
  if (!existsSync(master)) throw new Error(`Original art is missing: ${master}`);
  const output = join(project, key);
  if (options.sourceSize) {
    prepareSourceSizePng(key, master, output);
  } else {
    const result = spawnSync("sips", ["-z", "512", "512", master, "--out", output], { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`Texture preparation needs macOS sips: ${result.error ?? result.stderr}`);
  }
  prepared += 1;
}
console.log(`Prepared ${prepared} runtime textures from retained originals; retained ${retainedVectors} SVGs; skipped ${skippedLive2d} dedicated Live2D textures`);
