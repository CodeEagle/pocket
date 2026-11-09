import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createSpineRig, getSpineAtlasInfo, getSpineAtlasPages, type SpineMeshFrame } from "../src/index.ts";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const skeletonJson = readFileSync(new URL("weighted-mesh.json", fixtureDirectory), "utf8");
const atlasText = readFileSync(new URL("weighted-mesh.atlas", fixtureDirectory), "utf8");

function createRig() {
  return createSpineRig({
    skeleton: { format: "json", data: skeletonJson },
    atlasText,
    textureKeys: { "fixture-page.png": "art/hero-atlas" },
  });
}

function mesh(rig: ReturnType<typeof createRig>): SpineMeshFrame {
  const result = rig.frame();
  const item = result.find((entry) => entry.kind === "mesh");
  expect(item).toBeDefined();
  if (!item || item.kind !== "mesh") throw new Error("expected a renderable Spine mesh");
  return item;
}

describe("Pocket Spine adapter", () => {
  test("reads atlas page names and PMA metadata using the official atlas parser", () => {
    expect(getSpineAtlasPages(atlasText)).toEqual(["fixture-page.png"]);
    expect(getSpineAtlasInfo(atlasText)).toEqual([{ name: "fixture-page.png", premultipliedAlpha: false }]);
    expect(getSpineAtlasInfo(atlasText.replace("format: RGBA8888", "format: RGBA8888\npma: true"))).toEqual([
      { name: "fixture-page.png", premultipliedAlpha: true },
    ]);
  });

  test("runs headlessly and returns official weighted mesh plus CPU-clipped triangles", () => {
    expect(typeof globalThis.document).toBe("undefined");
    const rig = createRig();
    expect(rig.animationNames).toEqual(["idle", "wave"]);
    expect(rig.skinNames).toEqual(["default"]);
    const frame = mesh(rig);

    expect(frame.texture).toBe("art/hero-atlas");
    expect(frame.blendMode).toBe("normal");
    expect(frame.clipped).toBe(true);
    expect(frame.positions.length).toBeGreaterThan(8);
    expect(frame.uvs.length).toBe(frame.positions.length);
    expect(frame.triangles.length).toBeGreaterThan(0);
    expect(frame.triangles.length % 3).toBe(0);
    expect(Math.max(...Array.from(frame.triangles))).toBeLessThan(frame.positions.length / 2);
    for (let i = 0; i < frame.positions.length; i += 2) {
      expect(Math.abs(frame.positions[i])).toBeLessThanOrEqual(4.0001);
    }
    expect(frame.premultipliedAlpha).toBe(false);
    rig.setSkin("default");
    rig.dispose();
    expect(rig.disposed).toBe(true);
    expect(() => rig.frame()).toThrow("Spine rig has been disposed");
  });

  test("advances weighted vertices and applies Spine's animation mixing", () => {
    const rig = createRig();
    const setup = mesh(rig);
    const setupPositions = Array.from(setup.positions);

    rig.play("idle");
    rig.advance(0.25);
    const idle = mesh(rig).positions;
    expect(idle).not.toEqual(setup.positions);
    expect(Array.from(setup.positions)).toEqual(setupPositions);

    rig.setMix("idle", "wave", 1);
    rig.play("wave");
    rig.advance(0.5);
    const mixed = mesh(rig).positions;

    const directWave = createRig();
    directWave.play("wave");
    directWave.advance(0.5);
    const wave = mesh(directWave).positions;
    expect(mixed).not.toEqual(wave);
    rig.dispose();
    directWave.dispose();
  });

  test("reports unsupported blend modes instead of returning srcOver-ready meshes", () => {
    const skeleton = JSON.parse(skeletonJson) as {
      slots: Array<Record<string, unknown>>;
    };
    skeleton.slots[1]!.blend = "additive";
    const rig = createSpineRig({
      skeleton: { format: "json", data: skeleton },
      atlasText,
      textureKeys: { "fixture-page.png": "art/hero-atlas" },
    });
    const frame = rig.frame();
    expect(frame.some((item) => item.kind === "mesh")).toBe(false);
    expect(frame).toContainEqual({
      kind: "unsupported",
      slot: "body",
      attachment: "body",
      reason: "blend-mode",
      detail: "Additive",
    });
    rig.dispose();
  });

  test("requires a Pocket logical texture key for every atlas page", () => {
    expect(() => createSpineRig({
      skeleton: { format: "json", data: skeletonJson },
      atlasText,
      textureKeys: {},
    })).toThrow("No Pocket texture key configured for atlas page: fixture-page.png");
  });
});
