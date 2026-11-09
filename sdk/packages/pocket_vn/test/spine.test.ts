import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createNovelEngine } from "../src/engine.ts";
import { createNovelSpineFactory } from "../src/spine.ts";
import type { CharacterModelIntent } from "../src/types.ts";
const fixtures = new URL("../../pocket_spine/test/fixtures/", import.meta.url);
const skeletonJson = readFileSync(new URL("weighted-mesh.json", fixtures), "utf8");
const atlasText = readFileSync(new URL("weighted-mesh.atlas", fixtures), "utf8");

type FixtureSkin = {
  name: string;
  attachments: Record<string, Record<string, { vertices?: number[]; color?: string }>>;
};

function fixtureWithSkin(name: string, options: {
  onlySkin?: boolean;
  differentBounds?: boolean;
  color?: string;
} = {}): string {
  const skeleton = JSON.parse(skeletonJson) as { skins: FixtureSkin[] };
  const skin = structuredClone(skeleton.skins[0]!);
  skin.name = name;
  if (options.differentBounds) {
    // Use an unweighted mesh with a deliberately asymmetric setup bound. A
    // model without a default skin otherwise has no setup attachments to fit.
    skin.attachments["body"]!["body"]!.vertices = [-80, -40, 8, -40, 8, 40, -80, 40];
    skin.attachments["clip-slot"]!["window"]!.vertices = [-80, -80, 8, -80, 8, 80, -80, 80];
  }
  if (options.color) skin.attachments["body"]!["body"]!.color = options.color;
  skeleton.skins = options.onlySkin ? [skin] : [...skeleton.skins, skin];
  return JSON.stringify(skeleton);
}

function sources(skeleton = skeletonJson) {
  return { rig: { skeleton: { format: "json" as const, data: skeleton }, atlasText } };
}

function meshPositions(meshes: readonly { geometry: Uint8Array }[]) {
  return meshes.map(mesh => {
    const view = new DataView(mesh.geometry.buffer, mesh.geometry.byteOffset, mesh.geometry.byteLength);
    const vertexCount = view.getUint32(4, true);
    return Array.from({ length: vertexCount * 2 }, (_, index) => view.getFloat32(16 + (index >> 1) * 16 + (index % 2) * 4, true));
  });
}

test("Spine model intents drive official deformation into reusable PMS1 geometry", async () => {
  const factory = createNovelSpineFactory({ rig: {
    skeleton: { format: "json", data: skeletonJson },
    atlasText,
  } });
  const rig = await factory({ kind: "spine", source: "rig", textures: { "fixture-page.png": "rig.svg" } }, { key: "mira", animation: "idle", loop: true });
  const first = await rig.advance(0);
  expect(first.length).toBeGreaterThan(0);
  const bytes = first[0]!.geometry.slice();
  const moved = await rig.advance(250);
  const second = await rig.advance(10);
  expect(second[0]!.geometry).toBe(moved[0]!.geometry);
  const beforeWave = second[0]!.geometry.slice();
  expect(moved[0]!.geometry).not.toEqual(bytes);
  rig.setIntent({ key: "mira", animation: "wave", loop: false });
  const wave = await rig.advance(250);
  expect(wave[0]!.geometry).not.toEqual(beforeWave);
  expect(wave[0]!.texture).toBe("rig.svg");
  expect(() => rig.setIntent({ key: "other" })).toThrow("resource key");
  expect(() => rig.setIntent({ key: "mira", expression: "blink" })).toThrow("uses skins");
  rig.dispose();
  expect(() => rig.advance(20)).toThrow("disposed");
});

test("changing only a Spine skin preserves the running motion's phase", async () => {
  const factory = createNovelSpineFactory(sources(fixtureWithSkin("worried", { color: "ff3333ff" })));
  const definition = { kind: "spine" as const, source: "rig", textures: { "fixture-page.png": "rig.svg" } };
  const intent = { key: "mira", animation: "idle", loop: true };
  const changed = await factory(definition, intent);
  const control = await factory(definition, intent);
  try {
    await changed.advance(250); await control.advance(250);
    changed.setIntent({ ...intent, skin: "worried" });
    const actual = await changed.advance(100);
    const expected = await control.advance(100);
    expect(actual.map(mesh => [...mesh.geometry])).not.toEqual(expected.map(mesh => [...mesh.geometry]));
    expect(meshPositions(actual)).toEqual(meshPositions(expected));
  } finally { changed.dispose(); control.dispose(); }
});

test("selected initial skin supplies the fitted bounds even without a default skin", async () => {
  const factory = createNovelSpineFactory(sources(fixtureWithSkin("only-skin", { onlySkin: true, differentBounds: true })));
  const model = await factory(
    { kind: "spine", source: "rig", textures: { "fixture-page.png": "rig.svg" } },
    { key: "mira", animation: "idle", skin: "only-skin" },
  );
  try {
    const meshes = await model.advance(0);
    expect(meshes.length).toBeGreaterThan(0);
    const xs = meshes.flatMap(mesh => {
      const view = new DataView(mesh.geometry.buffer, mesh.geometry.byteOffset, mesh.geometry.byteLength);
      const vertexCount = view.getUint32(4, true);
      return Array.from({ length: vertexCount }, (_, index) => view.getFloat32(16 + index * 16, true));
    });
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(220, 2);
    expect(Math.min(...xs)).toBeCloseTo(10, 2);
    expect(Math.max(...xs)).toBeCloseTo(230, 2);
  } finally { model.dispose(); }
});

test("engine rollback restores the setup skin and preserves official animation phase", async () => {
  const story = {
    id: "spine-rollback", version: 1, start: "start", script: { start: [
      { type: "scene" as const, characters: [{ id: "mira", model: { key: "mira-rig", animation: "idle", loop: true } }] },
      { type: "say" as const, id: "one", text: "One" },
      { type: "scene" as const, characters: [{ id: "mira", model: { key: "mira-rig", animation: "idle", loop: true, skin: "worried" } }] },
      { type: "say" as const, id: "two", text: "Two" },
      { type: "scene" as const, characters: [{ id: "mira", model: { key: "mira-rig", animation: "idle", loop: true } }] },
      { type: "say" as const, id: "three", text: "Three" },
      { type: "scene" as const, characters: [{ id: "mira", model: { key: "mira-rig", animation: "idle", loop: true, skin: "worried" } }] },
      { type: "say" as const, id: "four", text: "Four" },
    ] },
  };
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const factory = createNovelSpineFactory(sources(fixtureWithSkin("worried", { differentBounds: true })));
  const definition = { kind: "spine" as const, source: "rig", textures: { "fixture-page.png": "rig.svg" } };
  let update = engine.start();
  const initialIntent = update.snapshot.stage.characters.mira!.model!;
  const model = await factory(definition, initialIntent);
  const control = await factory(definition, initialIntent);
  const intentFor = (): CharacterModelIntent => engine.getSnapshot().stage.characters.mira!.model!;
  try {
    await model.advance(250);
    await control.advance(250);
    const setupPose = await control.advance(0);

    update = engine.advance();
    model.setIntent(intentFor());
    const worriedPose = await model.advance(0);
    expect(worriedPose.map(mesh => [...mesh.geometry])).not.toEqual(setupPose.map(mesh => [...mesh.geometry]));

    await model.advance(100);
    await control.advance(100);
    engine.advance(); // Clear skin to the setup default before the third line.
    model.setIntent(intentFor());
    const resetPose = await model.advance(0);
    const expectedResetPose = await control.advance(0);
    expect(resetPose.map(mesh => [...mesh.geometry])).toEqual(expectedResetPose.map(mesh => [...mesh.geometry]));

    engine.advance();
    model.setIntent(intentFor()); // The fourth line switches back to worried.
    const beforeRollback = await model.advance(100);
    await control.advance(100);
    expect(beforeRollback.map(mesh => [...mesh.geometry])).not.toEqual(expectedResetPose.map(mesh => [...mesh.geometry]));

    update = engine.rollback();
    expect(update.snapshot.stage.characters.mira!.model).toEqual({ key: "mira-rig", animation: "idle", loop: true });
    model.setIntent(intentFor());
    const restored = await model.advance(0);
    const expected = await control.advance(0);
    expect(restored.map(mesh => [...mesh.geometry])).toEqual(expected.map(mesh => [...mesh.geometry]));
  } finally { model.dispose(); control.dispose(); }
});
