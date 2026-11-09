import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCubismPhysics3Simulation } from "../src/physics.ts";
import { evaluateCubismMotion3, parseCubismMotion3 } from "../src/motion.ts";
import type { Live2dParameterMetadata } from "../src/transport.ts";

const packageRoot = resolve(import.meta.dir, "..");
const sdkRoot = resolve(packageRoot, "../..");
const frameworkRoot = resolve(process.env.CUBISM_WEB_FRAMEWORK_ROOT ?? join(packageRoot, ".cache", "cubism-web-framework-5-r.5"));
const cubismRoot = resolve(process.env.CUBISM_SDK_ROOT ?? join(packageRoot, ".cache", "cubism-sdk-native-5-r5", "CubismSdkForNative-5-r.5"));
const frameworkCommit = execFileSync("git", ["-C", frameworkRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (frameworkCommit !== "198a3769c26ca3d7b600e932590433badd392edd") throw new Error(`Expected CubismWebFramework 5-r.5 commit, got ${frameworkCommit}`);
const sampleRoot = join(cubismRoot, "Samples", "Resources", "Hiyori");
const model3 = readJson(join(sampleRoot, "Hiyori.model3.json"));
const fileReferences = model3.FileReferences as Record<string, unknown>;
const physicsFile = fileReferences.Physics;
if (typeof physicsFile !== "string") throw new Error("Hiyori model3 has no Physics reference");
const idleGroup = (fileReferences.Motions as Record<string, unknown> | undefined)?.Idle;
if (!Array.isArray(idleGroup) || typeof idleGroup[0]?.File !== "string") throw new Error("Hiyori model3 has no Idle:0 motion");
const physicsDocument = readJson(join(sampleRoot, physicsFile));
const motionDocument = readJson(join(sampleRoot, idleGroup[0].File as string));
const motion = parseCubismMotion3(motionDocument);

// These are facts read from the actual Hiyori MOC3 through the Pocket Core
// C ABI (Cubism Core 6.0.1). Other physics outputs are assigned wide bounds
// only because this reference comparison observes ParamHairFront; they are
// asserted not to feed any physics input, so they cannot affect that output.
const knownCoreFacts: readonly Live2dParameterMetadata[] = [
  { id: "ParamAngleX", minimum: -30, maximum: 30, defaultValue: 0 },
  { id: "ParamAngleZ", minimum: -30, maximum: 30, defaultValue: 0 },
  { id: "ParamBodyAngleX", minimum: -10, maximum: 10, defaultValue: 0 },
  { id: "ParamBodyAngleY", minimum: -10, maximum: 10, defaultValue: 0 },
  { id: "ParamBodyAngleZ", minimum: -10, maximum: 10, defaultValue: 0 },
  { id: "ParamHairFront", minimum: -1, maximum: 1, defaultValue: 0 },
];

const physicsSettings = (physicsDocument.PhysicsSettings as Record<string, unknown>[] | undefined) ?? [];
const inputIds = new Set<string>();
const outputIds = new Set<string>();
for (const setting of physicsSettings) {
  for (const input of (setting.Input as Record<string, unknown>[] | undefined) ?? []) {
    const source = input.Source as Record<string, unknown>;
    inputIds.add(String(source.Id));
  }
  for (const output of (setting.Output as Record<string, unknown>[] | undefined) ?? []) {
    const destination = output.Destination as Record<string, unknown>;
    outputIds.add(String(destination.Id));
  }
}
if (inputIds.has("ParamHairFront")) throw new Error("Hiyori HairFront is unexpectedly a physics input");
for (const id of inputIds) {
  if (!knownCoreFacts.some((fact) => fact.id === id)) throw new Error(`Missing actual Core input facts for ${id}`);
}
for (const id of inputIds) {
  if (outputIds.has(id)) throw new Error(`Physics output ${id} feeds another Hiyori physics setting; full Core bounds are required`);
}
if (!outputIds.has("ParamHairFront")) throw new Error("Hiyori physics no longer outputs ParamHairFront");
const parameterMetadata = [...new Set([...inputIds, ...outputIds])].map((id) => knownCoreFacts.find((fact) => fact.id === id)
  ?? { id, minimum: -1_000_000, maximum: 1_000_000, defaultValue: 0 });
const defaults = Object.fromEntries(parameterMetadata.map((fact) => [fact.id, fact.defaultValue]));
const values = new Float32Array(parameterMetadata.map((fact) => fact.defaultValue));
const minimumValues = new Float32Array(parameterMetadata.map((fact) => fact.minimum));
const maximumValues = new Float32Array(parameterMetadata.map((fact) => fact.maximum));
const defaultValues = new Float32Array(parameterMetadata.map((fact) => fact.defaultValue));
const indexById = new Map(parameterMetadata.map((fact, index) => [fact.id, index]));
const model = {
  getModel: () => ({ parameters: { values, minimumValues, maximumValues, defaultValues } }),
  getParameterCount: () => parameterMetadata.length,
  getParameterIndex: (id: { getString(): string }) => indexById.get(id.getString()) ?? -1,
};

// The upstream framework only consults Core at startup here. The solver itself
// receives exactly the same arrays and IDs as Pocket's adapted implementation.
(globalThis as unknown as { Live2DCubismCore: unknown }).Live2DCubismCore = {
  Version: { csmGetVersion: () => 0x05000000 },
  Logging: { csmSetLogFunction: () => undefined },
  Memory: { initializeAmountOfMemory: () => undefined },
};
const frameworkUrl = pathToFileURL(join(frameworkRoot, "src", "live2dcubismframework.ts")).href;
const physicsUrl = pathToFileURL(join(frameworkRoot, "src", "physics", "cubismphysics.ts")).href;
const [{ CubismFramework }, { CubismPhysics }] = await Promise.all([
  import(frameworkUrl) as Promise<{ CubismFramework: { startUp(): boolean; initialize(): void } }>,
  import(physicsUrl) as Promise<{ CubismPhysics: { create(buffer: ArrayBuffer, size: number): { evaluate(model: unknown, delta: number): void; release(): void } } }>,
]);
CubismFramework.startUp();
CubismFramework.initialize();
const physicsBytes = new TextEncoder().encode(JSON.stringify(physicsDocument));
const upstream = CubismPhysics.create(physicsBytes.buffer, physicsBytes.byteLength);
const adapted = createCubismPhysics3Simulation(physicsDocument, parameterMetadata);

let maximumDelta = 0;
let minimumHair = Number.POSITIVE_INFINITY;
let maximumHair = Number.NEGATIVE_INFINITY;
for (let frame = 1; frame <= 300; frame++) {
  const seconds = frame / 60;
  const sampled = evaluateCubismMotion3(motion, seconds).parameters;
  for (let index = 0; index < parameterMetadata.length; index++) {
    const fact = parameterMetadata[index]!;
    values[index] = Math.max(fact.minimum, Math.min(fact.maximum, sampled[fact.id] ?? fact.defaultValue));
  }
  upstream.evaluate(model, 1 / 60);
  const upstreamHair = values[indexById.get("ParamHairFront")!]!;
  const pocketParameters = adapted.advance({ ...defaults, ...sampled }, 1 / 60);
  const pocketHair = pocketParameters.ParamHairFront!;
  maximumDelta = Math.max(maximumDelta, Math.abs(upstreamHair - pocketHair));
  minimumHair = Math.min(minimumHair, pocketHair);
  maximumHair = Math.max(maximumHair, pocketHair);
}
upstream.release();
adapted.dispose();
if (maximumDelta > 1e-6) throw new Error(`Hiyori HairFront diverges from upstream by ${maximumDelta}`);
if (maximumHair - minimumHair <= 0.001) throw new Error("Hiyori Idle:0 did not produce a changing HairFront physics output");
console.log(JSON.stringify({
  upstream: "Live2D/CubismWebFramework 5-r.5",
  hiyori: "Hiyori.physics3.json + Idle:0 at 60 Hz for 5 seconds",
  actualCoreFacts: [...inputIds, "ParamHairFront"],
  comparedFrames: 300,
  maximumHairDifference: maximumDelta,
  hairRange: maximumHair - minimumHair,
}, null, 2));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
