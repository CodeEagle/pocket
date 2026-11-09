import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { buildGuest } from "../build_guest.ts";
import { unpack } from "../../.cache/pocketjs/framework/compiler/pak.ts";

test("VN package view uses the pinned JSX and asset pipeline and restores consumer source", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-vn-"));
  const source = join(project, "vendor/pocket-vn");
  try {
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({
      name: "@pocket/vn", type: "module", exports: { ".": "./src/index.ts", "./view": "./src/view.tsx" },
    }));
    writeFileSync(join(source, "src/index.ts"), "export const title = 'Harbor';\n");
    const view = `import { Text, View } from "@pocketjs/framework/solid/components";
export function NovelView() { return <View class="w-[317] h-[193] bg-[#123456]"><Text class="text-sm">Novel package view</Text></View>; }
`;
    writeFileSync(join(source, "src/view.tsx"), view);
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:vendor/pocket-vn" } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    mkdirSync(join(project, "art"));
    writeFileSync(join(project, "art/scene.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: { room: "art/scene.png" } }));
    writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { NovelView } from "@pocket/vn/view";
mount(() => <NovelView />);
`);
    const result = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const js = readFileSync(result.source, "utf8");
    expect(js).toContain("Novel package view");
    expect(js).not.toContain('<View class="');
    expect(JSON.parse(readFileSync(result.metadata, "utf8")).entryFormat).toBe("quickjs-bytecode");
    expect(unpack(new Uint8Array(readFileSync(result.pak))).some(entry => entry.key.includes("scene.png"))).toBe(true);
    expect(readFileSync(join(source, "src/view.tsx"), "utf8")).toBe(view);
    expect(existsSync(join(project, "node_modules/@pocket/vn"))).toBe(false);
    expect(existsSync(join(project, ".pocket-vn.lock"))).toBe(false);
    expect(existsSync(join(project, ".pocket-ui.lock"))).toBe(false);
    mkdirSync(join(project, "models"));
    const model = { Version: 3, FileReferences: { Moc: "actor.moc3", Textures: ["texture.png"], Motions: { Idle: [{ File: "idle.motion3.json" }] }, Physics: "actor.physics3.json", Pose: "actor.pose3.json" } };
    writeFileSync(join(project, "models/actor.model3.json"), JSON.stringify(model));
    writeFileSync(join(project, "models/idle.motion3.json"), JSON.stringify({ fixture: "canonical JS motion data" }));
    writeFileSync(join(project, "models/actor.physics3.json"), JSON.stringify({ fixture: "canonical JS physics data" }));
    writeFileSync(join(project, "models/actor.pose3.json"), JSON.stringify({ fixture: "canonical JS pose data" }));
    const moc = Buffer.from("model-binary-copy-fixture");
    writeFileSync(join(project, "models/actor.moc3"), moc);
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ models: { actor: { kind: "live2d", source: "models/actor.model3.json", textures: { "texture.png": "art/scene.png" } } } }));
    const modelBuild = await buildGuest({ projectRoot: project, outDir: join(project, "out"), copyAssetsTo: join(project, "flutter-assets") });
    const modelEntries = unpack(new Uint8Array(readFileSync(modelBuild.pak)));
    expect(modelEntries.some(entry => entry.key.includes("scene.png"))).toBe(true);
    expect(modelEntries.some(entry => entry.key.includes("texture.png"))).toBe(false);
    expect(readFileSync(modelBuild.source, "utf8")).toContain("canonical JS motion data");
    expect(readFileSync(modelBuild.source, "utf8")).toContain("canonical JS physics data");
    expect(readFileSync(modelBuild.source, "utf8")).toContain("canonical JS pose data");
    const nativeModel = `native-models/${createHash("sha256").update(moc).digest("hex")}.moc3`;
    expect(readFileSync(join(project, "out", nativeModel))).toEqual(moc);
    expect(readFileSync(join(project, "flutter-assets", nativeModel))).toEqual(moc);
    expect(JSON.parse(readFileSync(join(project, "flutter-assets/novel.native-assets.json"), "utf8"))).toEqual({ version: 1, assets: { "models/actor.moc3": nativeModel } });
    expect(existsSync(join(project, ".pocket-live2d.lock"))).toBe(false);
    expect(existsSync(join(project, "node_modules/@pocket/live2d"))).toBe(false);
    writeFileSync(join(project, "flutter-assets/native-models/custom.txt"), "consumer file");
    writeFileSync(join(project, "models/actor.moc3"), Buffer.from("replacement model binary"));
    await buildGuest({ projectRoot: project, outDir: join(project, "out"), copyAssetsTo: join(project, "flutter-assets") });
    expect(existsSync(join(project, "flutter-assets", nativeModel))).toBe(false);
    expect(readFileSync(join(project, "flutter-assets/native-models/custom.txt"), "utf8")).toBe("consumer file");
    writeFileSync(join(project, "models/actor.model3.json"), JSON.stringify({ ...model, FileReferences: { ...model.FileReferences, Moc: "../escape.moc3" } }));
    await expect(buildGuest({ projectRoot: project, outDir: join(project, "out") })).rejects.toThrow("unsafe Live2D reference");
    expect(existsSync(join(project, ".pocket-vn.lock"))).toBe(false);
    expect(existsSync(join(project, ".pocket-ui.lock"))).toBe(false);
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: { room: "art/missing.png" } }));
    await expect(buildGuest({ projectRoot: project, outDir: join(project, "out") })).rejects.toThrow("missing VN image");
    expect(existsSync(join(project, ".pocket-vn.lock"))).toBe(false);
    expect(existsSync(join(project, ".pocket-ui.lock"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
