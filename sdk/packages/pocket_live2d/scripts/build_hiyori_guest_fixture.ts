import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { buildGuest } from "../../../scripts/build_guest.ts";

const packageRoot = resolve(import.meta.dir, "..");
const sdkRoot = resolve(packageRoot, "../..");
const cacheRoot = process.env.POCKET_LIVE2D_GUEST_FIXTURE_DIR
  ? resolve(process.env.POCKET_LIVE2D_GUEST_FIXTURE_DIR)
  : join(packageRoot, ".cache", "hiyori-guest-pixels");
const cubismRoot = process.env.CUBISM_SDK_ROOT
  ? resolve(process.env.CUBISM_SDK_ROOT)
  : join(packageRoot, ".cache", "cubism-sdk-native-5-r5", "CubismSdkForNative-5-r.5");
const sampleRoot = join(cubismRoot, "Samples", "Resources", "Hiyori");

rmSync(cacheRoot, { recursive: true, force: true });
mkdirSync(cacheRoot, { recursive: true });
const projectRoot = join(cacheRoot, "project");
const output = join(cacheRoot, "out");
const flutterAssets = join(cacheRoot, "flutter-assets");
mkdirSync(join(projectRoot, "models"), { recursive: true });
cpSync(sampleRoot, join(projectRoot, "models", "Hiyori"), { recursive: true });
// Pocket's bounded image-Pak format accepts up to 512px per side. Keep this
// test fixture local and scale only its two referenced textures; the MOC and
// Cubism UVs remain the official sample facts and no official image is copied
// into the repository or demo bundle.
for (const texture of [
  "Hiyori.2048/texture_00.png",
  "Hiyori.2048/texture_01.png",
]) {
  const path = join(projectRoot, "models", "Hiyori", texture);
  const scaledPath = `${path}.scaled.png`;
  execFileSync("sips", ["-Z", "512", path, "--out", scaledPath], {
    stdio: "ignore",
  });
  renameSync(scaledPath, path);
}

const packageFile = (name: string): string => {
  const path = relative(projectRoot, join(sdkRoot, "packages", name));
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
};
writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
  name: "pocket-live2d-hiyori-fixture",
  version: "1.0.0",
  private: true,
  type: "module",
  dependencies: {
    "@pocket/ui": packageFile("pocket_ui"),
    "@pocket/vn": packageFile("pocket_vn"),
    "@pocket/spine": packageFile("pocket_spine"),
    "@pocket/live2d": packageFile("pocket_live2d"),
  },
}, null, 2));
writeFileSync(join(projectRoot, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }, null, 2));
writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({
  capabilities: {
    requires: [
      "media.live2d.model.load",
      "media.live2d.model.update",
      "media.live2d.model.release",
    ],
  },
}, null, 2));
writeFileSync(join(projectRoot, "novel.assets.json"), JSON.stringify({
  models: {
    hiyori: {
      kind: "live2d",
      source: "models/Hiyori/Hiyori.model3.json",
      animations: ["Idle:0"],
      textures: {
        "Hiyori.2048/texture_00.png": "models/Hiyori/Hiyori.2048/texture_00.png",
        "Hiyori.2048/texture_01.png": "models/Hiyori/Hiyori.2048/texture_01.png",
      },
    },
  },
  backgrounds: {},
  characters: {},
  cgs: {},
}, null, 2));

const app = `import { mount } from "@pocketjs/framework/solid";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, createNovelAnimationDriver } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { createBundledNovelLive2dFactory } from "@pocket/vn/live2d";
import { NovelView } from "@pocket/vn/view";
import assets from "./novel.assets.json";

const story = {
  id: "test.live2d.hiyori.pixels",
  version: 1,
  start: "opening",
  script: {
    opening: [
      { type: "scene", characters: [
        { id: "hiyori", expression: "neutral", position: "center", model: { key: "hiyori", animation: "Idle:0", loop: true } },
      ] },
      { type: "say", id: "pixel-proof", speaker: "Hiyori", text: "The official Core moves this mesh through the Pocket host." },
    ],
  },
};
const engine = createNovelEngine(story);
const animations = createNovelAnimationDriver();
attachNovelClock(engine, { animations });
const host = createHostBridge();
const modelFactory = createBundledNovelLive2dFactory(host);
mount(() => <NovelView engine={engine} assets={assets} title="Hiyori Core fixture" subtitle="Actual QJBC → host → Core → PMS1/MFX1" modelFactory={modelFactory} animations={animations} onNewGame={() => engine.start()} />);
`;
writeFileSync(join(projectRoot, "app.tsx"), app);

const built = await buildGuest({
  projectRoot,
  outDir: output,
  copyAssetsTo: flutterAssets,
});
const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
if (metadata.entryFormat !== "quickjs-bytecode" || metadata.kind !== "script") {
  throw new Error("Hiyori fixture did not produce QuickJS script bytecode");
}
console.log(JSON.stringify({ cacheRoot, projectRoot, output, flutterAssets, bytecode: built.bytecode, metadata: built.metadata }));
