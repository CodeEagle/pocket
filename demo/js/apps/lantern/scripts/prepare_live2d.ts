import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// This script only stages the already-cached official sample for local
// evaluation. It does not download, sign, or publish sample/runtime files.
const appRoot = resolve(import.meta.dir, "..");
const sdkPackageRoot = resolve(appRoot, "../../../../sdk/packages/pocket_live2d");
const cubismRoot = process.env.CUBISM_SDK_ROOT
  ? resolve(process.env.CUBISM_SDK_ROOT)
  : join(sdkPackageRoot, ".cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5");
const sampleRoot = join(cubismRoot, "Samples/Resources/Hiyori");
const destination = join(appRoot, ".pocket-build/live2d/Hiyori");
const temporary = `${destination}.staging-${process.pid}`;

const expectedSha256: Record<string, string> = {
  "Hiyori.2048/texture_00.png": "560aea0d910dc04950d669640b2ef17c0d817969e9909f477f166bb5cbd8ffbe",
  "Hiyori.2048/texture_01.png": "87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84",
  "Hiyori.cdi3.json": "0fc3fc76b7a68136056c8832c930c8af9f93899f359eded7349b481ea2342d03",
  "Hiyori.moc3": "0323f5f377b9afef54318be09e9b4eea2a8cb266190ff9d2f843f95ecb77716c",
  "Hiyori.model3.json": "973cb3392f7b01f5f73e9d3fedc495a81a0f3ee8014e5df72ef943311c56ee12",
  "Hiyori.physics3.json": "c7a6d641893519c0bbc615545887f03f6c5b8031b4096873740b618370452fc1",
  "Hiyori.pose3.json": "ff1cc242790f196c87a7379dc1340b608723db60af1b2825e00da8f351ffc1bf",
  "Hiyori.userdata3.json": "75fe50a89ea695b46c98dce8991c2f3d67e3d7a479786e6310460289b552d29b",
  "motions/Hiyori_m01.motion3.json": "c4f0d982c685b81c1af0ced96c8f6bd5118b8a3fa972c3a12a46652b8d78461d",
  "motions/Hiyori_m02.motion3.json": "858c582874a0c4badfec38d4caf19e232fea5ba714f5a2ac6a282c617910c154",
  "motions/Hiyori_m03.motion3.json": "de33a8ce78226a5ff80cfa941fb5a4c50b6c1c4b346031ed44b384f772b62cf9",
  "motions/Hiyori_m04.motion3.json": "54ddb94d0494772e10355429c547bb7e29601f38d663087804b0c793b29cc51f",
  "motions/Hiyori_m05.motion3.json": "7f71061c9207ac1da6e06098ede9318307a7e75715a3ef97c82646acd9ee8620",
  "motions/Hiyori_m06.motion3.json": "55c007646febe4cb76d20cbb0623086986dbb55c7ef82212693a5e26636a32ef",
  "motions/Hiyori_m07.motion3.json": "3f06cb70f5654eed3389978885e4dff151b6cf9e8d59248680addcd267ff793a",
  "motions/Hiyori_m08.motion3.json": "66022fff5cff3c30b7fc1295bf92e4975e3ab9980d5cb296b5e24a2a8acc6daf",
  "motions/Hiyori_m09.motion3.json": "9edbd6a88e977221fa90625b5f94c9fd27212e1183288105584be8272543ade7",
  "motions/Hiyori_m10.motion3.json": "ba0ba6764a80459432ffd48d6bd5ba261fd25f196208ade3016be74efb9d3dfc",
};

const longAttribution =
  "This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.";
const notice = `${longAttribution}\n\nLocal evaluation only. Review and comply with the sample-data terms before use. This staging does not grant publication, redistribution, or runtime licensing rights.\n\nHiyori sample data terms: https://www.live2d.com/eula/live2d-sample-model-terms_en.html\nFree Material License Agreement: https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html\nCubism Proprietary Software License Agreement: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html\nCubism Open Software License Agreement: https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html\n`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function referencedFiles(model: Record<string, unknown>): string[] {
  const refs = model.FileReferences;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    throw new Error("Hiyori model3.json has no valid FileReferences object");
  }
  const files = new Set<string>(["Hiyori.model3.json"]);
  const add = (value: unknown, field: string): void => {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe or missing Hiyori model reference: ${field}`);
    }
    files.add(value.replaceAll("\\", "/"));
  };
  const addOptional = (key: string): void => {
    if (refs[key] !== undefined && refs[key] !== "") add(refs[key], key);
  };
  addOptional("Moc");
  addOptional("Physics");
  addOptional("Pose");
  addOptional("UserData");
  addOptional("DisplayInfo");
  if (!Array.isArray(refs.Textures)) throw new Error("Hiyori model3.json Textures must be an array");
  refs.Textures.forEach((path: unknown, index: number) => add(path, `Textures[${index}]`));
  if (refs.Motions !== undefined) {
    if (!refs.Motions || typeof refs.Motions !== "object" || Array.isArray(refs.Motions)) {
      throw new Error("Hiyori model3.json Motions must be an object");
    }
    for (const [group, motions] of Object.entries(refs.Motions as Record<string, unknown>)) {
      if (!Array.isArray(motions)) throw new Error(`Hiyori motion group ${group} must be an array`);
      motions.forEach((motion, index) => {
        if (!motion || typeof motion !== "object" || Array.isArray(motion)) {
          throw new Error(`Hiyori motion ${group}[${index}] must be an object`);
        }
        add((motion as Record<string, unknown>).File, `Motions.${group}[${index}].File`);
      });
    }
  }
  return [...files].sort();
}

function imageDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Expected a PNG with an IHDR header: ${path}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`Invalid texture dimensions: ${path}`);
  return { width, height };
}

if (!existsSync(sampleRoot) || !lstatSync(sampleRoot).isDirectory() || lstatSync(sampleRoot).isSymbolicLink()) {
  throw new Error(`Local Hiyori sample cache is missing or not a directory: ${sampleRoot}`);
}
if (!existsSync(join(sampleRoot, "Hiyori.model3.json"))) {
  throw new Error(`Hiyori model3.json is missing: ${sampleRoot}`);
}
const model = JSON.parse(readFileSync(join(sampleRoot, "Hiyori.model3.json"), "utf8")) as Record<string, unknown>;
const files = referencedFiles(model);
const expectedFiles = Object.keys(expectedSha256).filter((path) => path !== "Hiyori.model3.json").sort();
const referencedPayloadFiles = files.filter((path) => path !== "Hiyori.model3.json");
if (JSON.stringify(referencedPayloadFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Hiyori model3 references changed; review source files and update the pinned hash allowlist deliberately");
}

for (const relativePath of files) {
  const source = join(sampleRoot, relativePath);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Hiyori source must be a regular file: ${relativePath}`);
  const expected = expectedSha256[relativePath];
  if (!expected) throw new Error(`No pinned source hash for ${relativePath}`);
  const actual = sha256(source);
  if (actual !== expected) throw new Error(`Hiyori source hash mismatch for ${relativePath}: expected ${expected}, got ${actual}`);
}

rmSync(temporary, { recursive: true, force: true });
mkdirSync(temporary, { recursive: true });
try {
  for (const relativePath of files) {
    const source = join(sampleRoot, relativePath);
    const target = join(temporary, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  for (const texture of ["Hiyori.2048/texture_00.png", "Hiyori.2048/texture_01.png"]) {
    const path = join(temporary, texture);
    const dimensions = imageDimensions(path);
    if (dimensions.width !== 2048 || dimensions.height !== 2048) {
      throw new Error(`Pinned Hiyori atlas must retain its original 2048x2048 pixels; got ${dimensions.width}x${dimensions.height} for ${texture}`);
    }
    if (sha256(path) !== expectedSha256[texture]) {
      throw new Error(`Staged Hiyori atlas must be byte-identical to its pinned source: ${texture}`);
    }
  }
  writeFileSync(join(temporary, "NOTICE.txt"), notice, "utf8");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(temporary, destination);
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}

const outputs = files.map((relativePath) => {
  const path = join(destination, relativePath);
  return { path: relativePath, bytes: lstatSync(path).size, sha256: sha256(path) };
});
const textureSizes = ["Hiyori.2048/texture_00.png", "Hiyori.2048/texture_01.png"].map((relativePath) => ({
  path: relativePath,
  ...imageDimensions(join(destination, relativePath)),
}));
console.log(JSON.stringify({
  purpose: "local-evaluation-only",
  source: sampleRoot,
  output: destination,
  files: outputs,
  textures: textureSizes,
  notice: join(destination, "NOTICE.txt"),
}, null, 2));
