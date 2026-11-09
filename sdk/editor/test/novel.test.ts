import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { handleNovelRoute, validateAssetRegistry, validateStoryDefinition } from "../novel.ts";
import type { NovelAssetRegistry } from "../novel.ts";
import type { StoryDefinition } from "../../packages/pocket_vn/src/types.ts";
import type { StoryLocaleCatalogCollectionDocument } from "../../packages/pocket_vn/src/localization.ts";

const sampleStory: StoryDefinition = {
  id: "test.novel",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "set", variable: "visited", value: false },
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", position: "center" }] },
      { type: "say", id: "opening", speaker: "Mira", text: "Hello, {{name}}." },
      { type: "branch", when: { op: "truthy", value: { type: "variable", name: "visited" } }, then: "ending", else: "ending" },
    ],
    ending: [{ type: "ending", id: "end", text: "Goodbye", cg: "memory" }],
  },
};

const sampleAssets: NovelAssetRegistry = {
  backgrounds: { station: "art/station.png" },
  characters: { mira: { neutral: "art/mira.png" } },
  cgs: { memory: { image: "art/memory.png", title: "A memory" } },
  audio: { theme: "audio/theme.wav" },
};

function route(projectRoot: string, method: string, path: string, body?: unknown): Promise<Response> {
  return handleNovelRoute(new Request(`http://127.0.0.1${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), { projectRoot, projectId: "test-project" });
}

async function makeProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "pocket-novel-editor-"));
  await mkdir(join(project, "art"));
  await mkdir(join(project, "assets", "audio"), { recursive: true });
  await writeFile(join(project, "story.json"), `${JSON.stringify(sampleStory, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(sampleAssets, null, 2)}\n`);
  for (const image of ["station.png", "mira.png", "memory.png"]) await writeFile(join(project, "art", image), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(join(project, "assets", "audio", "theme.wav"), Buffer.from("wav"));
  return project;
}

async function makeSpineProject(): Promise<string> {
  const project = await makeProject();
  const models = join(project, "models");
  await mkdir(models);
  const fixtures = new URL("../../packages/pocket_spine/test/fixtures/", import.meta.url);
  await writeFile(join(models, "hero.spine.json"), await readFile(new URL("weighted-mesh.json", fixtures)));
  await writeFile(join(models, "hero.atlas"), await readFile(new URL("weighted-mesh.atlas", fixtures)));
  const assets = structuredClone(sampleAssets) as any;
  assets.models = {
    hero: {
      kind: "spine",
      source: "models/hero.spine.json",
      atlas: "models/hero.atlas",
      textures: { "fixture-page.png": "art/mira.png" },
      animations: ["idle", "wave"],
    },
  };
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  return project;
}

test("scene asset diagnostics distinguish model-backed, static and hidden characters", async () => {
  const project = await makeProject();
  try {
    await mkdir(join(project, "models"), { recursive: true });
    await writeFile(join(project, "models", "sample.model3.json"), "{}\n");
    const assets: any = structuredClone(sampleAssets);
    assets.models = {
      sample_model: {
        kind: "live2d",
        source: "models/sample.model3.json",
        animations: ["idle"],
        textures: { "sample-page.png": "art/mira.png" },
      },
    };
    await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);

    const diagnosticsFor = async (characters: unknown[]) => {
      const story = {
        id: "test.novel", version: 1, start: "start",
        script: {
          start: [
            { type: "scene", background: "station", characters },
            { type: "ending", id: "end", text: "Done." },
          ],
        },
      };
      await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
      const response = await route(project, "GET", "/api/projects/test-project/novel/story");
      assert.equal(response.status, 200);
      const payload = await response.json() as { validation: { diagnostics: Array<{ code: string; message: string }> } };
      return payload.validation.diagnostics;
    };

    const model = await diagnosticsFor([
      { id: "hiyori", visible: true, model: { key: "sample_model", animation: "idle", loop: true } },
    ]);
    assert.equal(model.some(item => item.code === "assets.reference" && /character asset key “hiyori”/.test(item.message)), false);
    assert.equal(model.some(item => item.code === "assets.model.animation"), false);

    const unknownModel = await diagnosticsFor([
      { id: "hiyori", visible: true, model: { key: "missing_model", animation: "idle", loop: true } },
    ]);
    assert.ok(unknownModel.some(item => item.code === "assets.reference" && /model asset key “missing_model”/.test(item.message)));
    assert.equal(unknownModel.some(item => item.code === "assets.reference" && /character asset key “hiyori”/.test(item.message)), false);

    const staticMissing = await diagnosticsFor([
      { id: "missing_static_character", visible: true, position: "center" },
    ]);
    assert.ok(staticMissing.some(item => item.code === "assets.reference" && /character asset key “missing_static_character”/.test(item.message)));

    const hiddenClear = await diagnosticsFor([
      { id: "cleared_placeholder", visible: false },
    ]);
    assert.equal(hiddenClear.some(item => item.code === "assets.reference" && /character asset key “cleared_placeholder”/.test(item.message)), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("story editor validates branches, unreachable labels and cycles without executing text", () => {
  const story = {
    id: "test.novel", version: 1, start: "start",
    script: {
      start: [{ type: "jump", target: "loop" }],
      loop: [{ type: "branch", when: { op: "truthy", value: { type: "literal", value: true } }, then: "loop", else: "ending" }],
      ending: [{ type: "ending", id: "done" }],
      unused: [{ type: "say", id: "unused-line", text: "unreachable" }],
    },
  };
  const result = validateStoryDefinition(story);
  assert.equal(result.valid, true);
  assert.ok(result.diagnostics.some(item => item.code === "story.cycle"));
  assert.ok(result.diagnostics.some(item => item.code === "label.unreachable" && item.location?.label === "unused"));

  const broken = structuredClone(story);
  (broken.script.start[0] as { target: string }).target = "missing";
  assert.equal(validateStoryDefinition(broken).valid, false);
  assert.ok(validateStoryDefinition(broken).diagnostics.some(item => item.code === "reference.label"));
});

test("story editor uses the shared say-presentation schema and reports invalid layouts", () => {
  const story: any = structuredClone(sampleStory);
  for (const presentation of ["dialogue", "fullscreen", "floating"]) {
    story.script.start[2].presentation = presentation;
    assert.equal(validateStoryDefinition(story).valid, true, presentation);
  }
  story.script.start[2].presentation = "unregistered-layout";
  const invalid = validateStoryDefinition(story);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some(item => item.code === "instruction.sayPresentation" && item.location?.field === "presentation"));
});

test("scene reveal transitions default left, accept four directions, and reject direction on other kinds", async () => {
  const project = await makeProject();
  try {
    const story: any = structuredClone(sampleStory);
    const scene = story.script.start[1];
    scene.transition = { kind: "reveal", durationMs: 450 };
    assert.equal(validateStoryDefinition(story).valid, true, "omitted reveal direction uses the runtime left default");
    for (const direction of ["left", "right", "up", "down"]) {
      scene.transition = { kind: "reveal", durationMs: 450, direction };
      assert.equal(validateStoryDefinition(story).valid, true, direction);
    }
    for (const kind of ["cut", "fade", "dissolve"]) {
      scene.transition = { kind, durationMs: 450 };
      assert.equal(validateStoryDefinition(story).valid, true, kind);
    }

    scene.transition = { kind: "reveal", durationMs: 450, direction: "diagonal" };
    let invalid = validateStoryDefinition(story);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.diagnostics.some(item => item.code === "instruction.transition" && item.location?.field === "transition"));

    scene.transition = { kind: "fade", durationMs: 450, direction: "left" };
    invalid = validateStoryDefinition(story);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.diagnostics.some(item => item.code === "instruction.transition"));

    scene.transition = { kind: "reveal", durationMs: 450, direction: "up" };
    assert.equal((await route(project, "PUT", "/api/projects/test-project/novel/story", story)).status, 200);
    scene.transition = { kind: "reveal", durationMs: 450, direction: "diagonal" };
    assert.equal((await route(project, "PUT", "/api/projects/test-project/novel/story", story)).status, 422);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), {
      ...sampleStory,
      script: { ...sampleStory.script, start: [sampleStory.script.start[0], { ...sampleStory.script.start[1], transition: { kind: "reveal", durationMs: 450, direction: "up" } }, ...sampleStory.script.start.slice(2)] },
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("scene camera uses the core schema, preserves author metadata, and rejects invalid bounds atomically", async () => {
  const project = await makeProject();
  try {
    const story: any = structuredClone(sampleStory);
    story.author = { credit: "preserve" };
    story.script.start[1] = {
      type: "scene",
      camera: { x: 120.5, y: -64, scale: 1.4, authorNote: { preserve: true } },
      cameraMotion: {
        durationMs: 600,
        easing: "easeInOut",
        shake: { amplitude: 12, cycles: 3, authorShakeNote: "preserve" },
        authorMotionNote: "preserve",
      },
      authorSceneNote: ["preserve", "this"],
    };
    assert.equal(validateStoryDefinition(story).valid, true);
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/story", story);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);

    for (const invalidCamera of [
      { ...story.script.start[1], camera: { ...story.script.start[1].camera, x: 4097 } },
      { ...story.script.start[1], camera: { ...story.script.start[1].camera, scale: 0.09 } },
      { ...story.script.start[1], cameraMotion: { ...story.script.start[1].cameraMotion, durationMs: 0 } },
      { ...story.script.start[1], cameraMotion: { ...story.script.start[1].cameraMotion, shake: { amplitude: 12, cycles: 0 } } },
      { type: "scene", cameraMotion: { durationMs: 500 } },
    ]) {
      const invalid = structuredClone(story);
      invalid.script.start[1] = invalidCamera;
      const validation = validateStoryDefinition(invalid);
      assert.equal(validation.valid, false);
      assert.ok(validation.diagnostics.some(item => item.code === "instruction.camera"));
      const rejected = await route(project, "PUT", "/api/projects/test-project/novel/story", invalid);
      assert.equal(rejected.status, 422);
      assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("timeline presets use the shared schema, resolve scene IDs, and validate registered audio cues", async () => {
  const project = await makeProject();
  try {
    const story: any = structuredClone(sampleStory);
    story.timelines = {
      motion: {
        durationMs: 1200,
        camera: [
          { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
          { atMs: 900, value: { x: 64, y: -8, scale: 1.2 }, easing: "easeInOut" },
        ],
        actors: [
          { id: "mira", keyframes: [
            { atMs: 0, value: { position: { x: 24, y: 260 }, scale: 1, rotation: 0 } },
            { atMs: 900, value: { position: { x: 90, y: 260 }, scale: 1.1, rotation: 8 } },
          ] },
          { id: "ren", keyframes: [
            { atMs: 0, value: { position: { x: 220, y: 260 }, scale: 1, rotation: 0 } },
            { atMs: 900, value: { position: { x: 200, y: 260 }, scale: 1, rotation: -5 } },
          ] },
        ],
        audio: [{ atMs: 300, cue: "theme", action: "play", channel: "sfx", loop: false }],
        audioGains: [{ channel: "sfx", keyframes: [
          { atMs: 0, value: 0 },
          { atMs: 600, value: 1, easing: "easeInOut" },
          { atMs: 1200, value: 0 },
        ] }],
      },
    };
    story.script.start[1].timeline = "motion";
    assert.equal(validateStoryDefinition(story).valid, true);
    const validWrite = await route(project, "PUT", "/api/projects/test-project/novel/story", story);
    assert.equal(validWrite.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")).timelines, story.timelines);

    const expectRejected = async (invalid: unknown, path: string) => {
      const localValidation = validateStoryDefinition(invalid);
      assert.ok(localValidation.diagnostics.some((item: any) => item.code === "story.timeline" && item.location?.field === path), `${path} must retain its field diagnostic`);
      const response = await route(project, "PUT", "/api/projects/test-project/novel/story", invalid);
      assert.equal(response.status, 422, path);
      const payload = await response.json() as any;
      assert.ok(payload.validation.diagnostics.some((item: any) => item.code === "story.timeline" && item.location?.field === path), path);
      assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story, "an invalid timeline must not replace the last valid story");
    };

    const unknownPreset = structuredClone(story);
    unknownPreset.script.start[1].timeline = "missing";
    await expectRejected(unknownPreset, "script.start[1].timeline");

    const duplicateActors = structuredClone(story);
    duplicateActors.timelines.motion.actors[1].id = "mira";
    await expectRejected(duplicateActors, "story.timelines.motion.actors[1].id");

    const invalidTime = structuredClone(story);
    invalidTime.timelines.motion.camera[1].atMs = 1201;
    await expectRejected(invalidTime, "story.timelines.motion.camera[1].atMs");

    const invalidGain = structuredClone(story);
    invalidGain.timelines.motion.audioGains[0].keyframes[1].value = 1.01;
    await expectRejected(invalidGain, "story.timelines.motion.audioGains[0].keyframes[1].value");

    const invalidGainStart = structuredClone(story);
    invalidGainStart.timelines.motion.audioGains[0].keyframes[0].atMs = 1;
    await expectRejected(invalidGainStart, "story.timelines.motion.audioGains[0].keyframes[0].atMs");

    const invalidGainOrder = structuredClone(story);
    invalidGainOrder.timelines.motion.audioGains[0].keyframes[1].atMs = 0;
    await expectRejected(invalidGainOrder, "story.timelines.motion.audioGains[0].keyframes[1].atMs");

    const duplicateGainChannel = structuredClone(story);
    duplicateGainChannel.timelines.motion.audioGains.push({ channel: "sfx", keyframes: [{ atMs: 0, value: 1 }] });
    await expectRejected(duplicateGainChannel, "story.timelines.motion.audioGains[1].channel");

    const reservedGainChannel = structuredClone(story);
    reservedGainChannel.timelines.motion.audioGains[0].channel = "__pocket_vn_voice";
    await expectRejected(reservedGainChannel, "story.timelines.motion.audioGains[0].channel");

    const tooManyGainFrames = structuredClone(story);
    tooManyGainFrames.timelines.motion.audioGains[0].keyframes = Array.from({ length: 65 }, (_item, index) => ({ atMs: index, value: index / 64 }));
    await expectRejected(tooManyGainFrames, "story.timelines.motion.audioGains[0].keyframes");

    const tooManyGainTracks = structuredClone(story);
    tooManyGainTracks.timelines.motion.audioGains = Array.from({ length: 33 }, (_item, index) => ({ channel: `sfx-${index}`, keyframes: [{ atMs: 0, value: 1 }] }));
    await expectRejected(tooManyGainTracks, "story.timelines.motion.audioGains");

    const nonFiniteGain = structuredClone(story);
    nonFiniteGain.timelines.motion.audioGains[0].keyframes[1].value = Number.NaN;
    assert.ok(validateStoryDefinition(nonFiniteGain).diagnostics.some((item: any) => item.location?.field === "story.timelines.motion.audioGains[0].keyframes[1].value"), "non-finite gains must be field-diagnosed before JSON transport");

    const unknownAudioCue = structuredClone(story);
    unknownAudioCue.timelines.motion.audio[0].cue = "not-registered";
    const audioWrite = await route(project, "PUT", "/api/projects/test-project/novel/story", unknownAudioCue);
    assert.equal(audioWrite.status, 422);
    const audioPayload = await audioWrite.json() as any;
    assert.ok(audioPayload.validation.diagnostics.some((item: any) => item.code === "assets.reference" && item.location?.field === "timelines.motion.audio[0].cue"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story, "an unregistered timeline cue must not replace the last valid story");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("reachability and cycle checks handle the configured maximum story label count iteratively", () => {
  const script: Record<string, any[]> = {};
  const count = 10_000;
  for (let index = 0; index < count - 1; index += 1) script[`label_${index}`] = [{ type: "jump", target: `label_${index + 1}` }];
  script[`label_${count - 1}`] = [{ type: "ending", id: "last" }];
  const result = validateStoryDefinition({ id: "long.story", version: 1, start: "label_0", script });
  assert.equal(result.valid, true);
  assert.equal(result.summary.reachableLabels, count);
  assert.equal(result.summary.endings, 1);
});

test("player input shares core schema, counts variable writes and validates cancel edges and stable IDs", () => {
  const story: any = {
    id: "input-editor", version: 1, start: "start", script: {
      start: [
        { type: "input", id: "name", variable: "name", inputType: "text", prompt: "Name?", minLength: 1, maxLength: 16, cancelTarget: "cancelled" },
        { type: "input", id: "box", variable: "box", inputType: "number", min: 0, max: 999, integer: true },
        { type: "input", id: "consent", variable: "consent", inputType: "boolean", defaultValue: false },
        { type: "say", id: "result", text: "{{name}}/{{box}}/{{consent}}" },
        { type: "ending", id: "done" },
      ],
      cancelled: [{ type: "ending", id: "cancel" }],
    },
  };
  const result = validateStoryDefinition(story);
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.some(item => item.code === "variable.unwritten"), false);
  const underscored = structuredClone(story);
  underscored.script.start[0].variable = "_player.name";
  assert.equal(validateStoryDefinition(underscored).valid, true, "the core variable schema also permits an underscore prefix");
  for (const patch of [
    { inputType: "boolean", minLength: 1 },
    { inputType: "number", minLength: undefined, maxLength: undefined, defaultValue: "7" },
    { minLength: 17, maxLength: 16 },
    { maxLength: 4097 },
  ]) {
    const invalid = structuredClone(story);
    invalid.script.start[0] = JSON.parse(JSON.stringify({ ...invalid.script.start[0], ...patch }));
    assert.equal(validateStoryDefinition(invalid).valid, false, JSON.stringify(patch));
  }
  const missing = structuredClone(story);
  missing.script.start[0].cancelTarget = "missing";
  assert.ok(validateStoryDefinition(missing).diagnostics.some(item => item.code === "reference.label"));
  const duplicate = structuredClone(story);
  duplicate.script.start[1].id = "name";
  assert.equal(validateStoryDefinition(duplicate).valid, false);
});

test("input route saves author fields losslessly and rejects invalid schema without changing the file", async () => {
  const project = await makeProject();
  try {
    const story: any = structuredClone(sampleStory);
    story.script.start.unshift({ type: "input", id: "player-name", variable: "name", inputType: "text", minLength: 1, maxLength: 16, cancelTarget: "ending", custom: { note: "preserve author metadata" } });
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/story", story);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);
    const invalid = structuredClone(story);
    invalid.script.start[0].inputType = "boolean";
    const rejected = await route(project, "PUT", "/api/projects/test-project/novel/story", invalid);
    assert.equal(rejected.status, 422);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("story route atomically round trips editable StoryDefinition and keeps semantic errors visible", async () => {
  const project = await makeProject();
  try {
    const next = structuredClone(sampleStory) as any;
    next.script.start[2].text = "Edited dialogue";
    next.script.start[3].then = "missing_route";
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/story", next);
    assert.equal(saved.status, 200);
    const payload = await saved.json() as any;
    assert.equal(payload.saved, true);
    assert.equal(payload.story.script.start[2].text, "Edited dialogue");
    assert.equal(payload.validation.valid, false, "unknown refs are saved as a correctable semantic diagnostic");
    assert.ok(payload.validation.diagnostics.some((item: any) => item.code === "reference.label"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), next);

    const read = await route(project, "GET", "/api/projects/test-project/novel/story");
    assert.equal(read.status, 200);
    assert.equal((await read.json() as any).story.script.start[2].text, "Edited dialogue");

    const before = await readFile(join(project, "story.json"), "utf8");
    const rejected = await route(project, "PUT", "/api/projects/test-project/novel/story", { ...next, script: [] });
    assert.equal(rejected.status, 422);
    assert.equal(await readFile(join(project, "story.json"), "utf8"), before, "structurally invalid JSON must not replace the last story file");
    for (const transform of [{ scale: 0 }, { rotation: 361 }, { layer: 1.5 }]) {
      const invalid = structuredClone(next);
      invalid.script.start.unshift({ type: "scene", characters: [{ id: "mira", ...transform }] });
      assert.equal((await route(project, "PUT", "/api/projects/test-project/novel/story", invalid)).status, 422);
      assert.equal(await readFile(join(project, "story.json"), "utf8"), before, "invalid transforms must preserve canonical data");
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("inventory Editor routes round trip one story catalog and reject invalid variables and trade references", async () => {
  const project = await makeProject();
  try {
    const story: any = structuredClone(sampleStory);
    story.variableDefinitions = {
      coins: { lifetime: "save", defaultValue: 30 },
      moonHerbs: { lifetime: "save", defaultValue: 0 },
    };
    story.inventory = {
      currency: { title: "Coins", variable: "coins" },
      items: {
        moon_herb: { title: "Moon Herb", body: "A silver leaf.", quantityVariable: "moonHerbs", buyPrice: 4, sellPrice: 2, maxQuantity: 12 },
      },
    };
    story.script.start.push({ type: "trade", item: "moon_herb", action: "buy", quantity: 1, onFailure: "ending" });
    assert.equal(validateStoryDefinition(story).valid, true);

    const initial = await route(project, "PUT", "/api/projects/test-project/novel/story", story);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json() as any).story, story);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), story);

    const locale = await route(project, "GET", "/api/projects/test-project/novel/locales");
    assert.equal(locale.status, 200);
    const localePayload = await locale.json() as any;
    assert.equal(localePayload.uiDefaults["inventory.currency.title"], "Coins");
    assert.equal(localePayload.uiDefaults["inventory.item.moon_herb.title"], "Moon Herb");
    assert.equal(localePayload.uiDefaults["inventory.item.moon_herb.body"], "A silver leaf.");

    const edited = structuredClone(story);
    edited.inventory.items.moon_herb.buyPrice = 5;
    edited.script.start.at(-1).action = "consume";
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/story", edited);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), edited);

    const unchanged = await readFile(join(project, "story.json"), "utf8");
    const invalidCases = [
      (value: any) => { value.inventory.unexpected = true; },
      (value: any) => { value.inventory.items.moon_herb.unexpected = true; },
      (value: any) => { value.inventory.items.moon_herb.quantityVariable = "missing_count"; },
      (value: any) => { value.variableDefinitions.moonHerbs.lifetime = "session"; },
      (value: any) => { value.variableDefinitions.moonHerbs.defaultValue = -1; },
      (value: any) => { value.variableDefinitions.moonHerbs.defaultValue = 13; },
      (value: any) => { value.inventory.items.moon_herb.quantityVariable = "coins"; },
      (value: any) => { value.script.start.at(-1).item = "missing_item"; },
      (value: any) => { value.script.start.at(-1).onFailure = "missing_route"; },
      (value: any) => { value.script.start.at(-1).extra = "not allowed"; },
    ];
    for (const mutate of invalidCases) {
      const invalid = structuredClone(edited);
      mutate(invalid);
      const rejected = await route(project, "PUT", "/api/projects/test-project/novel/story", invalid);
      assert.equal(rejected.status, 422, JSON.stringify(invalid));
      assert.equal(await readFile(join(project, "story.json"), "utf8"), unchanged, "invalid inventory edits must not replace canonical story data");
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("Editor history stores inventory in the StoryDefinition shape and keeps inventory fields strict", async () => {
  const project = await makeProject();
  const workspace = await mkdtemp(join(tmpdir(), "pocket-novel-inventory-history-"));
  const options = { projectRoot: project, projectId: "test-project", workspaceRoot: workspace, novelRestoreEpoch: 0 };
  const path = "http://127.0.0.1/api/projects/test-project/novel/history";
  const requestHistory = (method: string, body?: unknown) => handleNovelRoute(new Request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), options);
  try {
    const story: any = structuredClone(sampleStory);
    story.variableDefinitions = {
      coins: { lifetime: "save", defaultValue: 30 },
      moonHerbs: { lifetime: "save", defaultValue: 0 },
    };
    story.inventory = {
      currency: { title: "Coins", variable: "coins" },
      items: { moon_herb: { title: "Moon Herb", body: "A silver leaf.", quantityVariable: "moonHerbs", buyPrice: 4 } },
    };
    story.script.start.push({ type: "trade", item: "moon_herb", action: "buy", quantity: 1, onFailure: "ending" });
    const initial = await (await requestHistory("GET")).json() as any;
    const write = await requestHistory("PUT", {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: initial.historyRevision,
      draft: { story, assets: sampleAssets, authoringDraft: null },
      undo: [{ scope: "story", key: "inventory:create", restore: sampleStory }],
      redo: [],
    });
    assert.equal(write.status, 200);
    const reread = await (await requestHistory("GET")).json() as any;
    assert.deepEqual(reread.history.draft.story.inventory, story.inventory);
    assert.deepEqual(reread.history.undo[0].restore, sampleStory);

    const invalid = structuredClone(story);
    invalid.inventory.items.moon_herb.extra = "not allowed";
    const rejected = await requestHistory("PUT", {
      expectedToken: reread.sourceToken,
      expectedHistoryRevision: reread.historyRevision,
      draft: { story: invalid, assets: sampleAssets, authoringDraft: null },
      undo: [],
      redo: [],
    });
    assert.equal(rejected.status, 422, "durable drafts must retain the strict inventory field allowlist");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("asset editor enforces canonical registry shape, project paths and registry-only media lookup", async () => {
  const project = await makeProject();
  try {
    assert.deepEqual(validateAssetRegistry(sampleAssets, project), []);
    const read = await route(project, "GET", "/api/projects/test-project/novel/assets");
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as any).assets, sampleAssets);

    const image = await route(project, "GET", "/novel/resource?project=test-project&kind=background&key=station");
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    const arbitrary = await route(project, "GET", "/novel/resource?project=test-project&kind=background&key=../../story.json");
    assert.equal(arbitrary.status, 400);
    const unregistered = await route(project, "GET", "/novel/resource?project=test-project&kind=background&key=memory");
    assert.equal(unregistered.status, 404);

    const unsafe = structuredClone(sampleAssets) as any;
    unsafe.backgrounds.station = "../secret.png";
    const rejected = await route(project, "PUT", "/api/projects/test-project/novel/assets", unsafe);
    assert.equal(rejected.status, 422);
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), sampleAssets);

    const missing = structuredClone(sampleAssets) as any;
    missing.characters.mira.neutral = "art/missing.png";
    const savedMissing = await route(project, "PUT", "/api/projects/test-project/novel/assets", missing);
    assert.equal(savedMissing.status, 200, "missing files remain editable so authors can fix paths or add files");
    assert.ok((await savedMissing.json() as any).diagnostics.some((item: any) => item.code === "assets.missing"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("novel collections share asset registration and reject invalid portrait and persistent unlock references", async () => {
  const project = await makeProject();
  try {
    const unlockStory = {
      ...sampleStory,
      variableDefinitions: { memory_open: { lifetime: "persistent", defaultValue: false } },
    } satisfies StoryDefinition;
    await writeFile(join(project, "story.json"), `${JSON.stringify(unlockStory, null, 2)}\n`);
    const assets = {
      ...sampleAssets,
      collections: {
        memories: {
          title: "Station memories",
          entries: {
            arrival: {
              title: "At the station",
              body: "Mira's first letter.",
              portrait: { character: "mira", expression: "neutral" },
              unlockVariable: "memory_open",
            },
          },
        },
      },
    };
    const validWrite = await route(project, "PUT", "/api/projects/test-project/novel/assets", assets);
    assert.equal(validWrite.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets);
    assert.deepEqual((await validWrite.json() as any).diagnostics, []);

    const invalidPortrait = structuredClone(assets) as any;
    invalidPortrait.collections.memories.entries.arrival.portrait.expression = "missing";
    const portraitWrite = await route(project, "PUT", "/api/projects/test-project/novel/assets", invalidPortrait);
    assert.equal(portraitWrite.status, 422);
    const portraitPayload = await portraitWrite.json() as any;
    assert.ok(portraitPayload.diagnostics.some((item: any) => item.path === "collections.memories.entries.arrival.portrait" || item.location?.field === "collections.memories.entries.arrival.portrait"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets, "bad portrait references must not replace canonical assets");

    const invalidUnlock = structuredClone(assets) as any;
    invalidUnlock.collections.memories.entries.arrival.unlockVariable = "missing_flag";
    const unlockWrite = await route(project, "PUT", "/api/projects/test-project/novel/assets", invalidUnlock);
    assert.equal(unlockWrite.status, 422);
    const unlockPayload = await unlockWrite.json() as any;
    assert.ok(unlockPayload.diagnostics.some((item: any) => item.location?.field === "collections.memories.entries.arrival.unlockVariable"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets, "bad unlock references must not replace canonical assets");

    const invalidStory = structuredClone(unlockStory) as any;
    invalidStory.variableDefinitions.memory_open.lifetime = "save";
    const storyWrite = await route(project, "PUT", "/api/projects/test-project/novel/story", invalidStory);
    assert.equal(storyWrite.status, 422, "story edits cannot invalidate an existing collection unlock reference");
    const storyPayload = await storyWrite.json() as any;
    assert.ok(storyPayload.diagnostics.some((item: any) => item.location?.field === "collections.memories.entries.arrival.unlockVariable"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), unlockStory, "invalid variable changes must not replace canonical story data");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("Editor history accepts valid collection drafts and rejects unknown collection fields", async () => {
  const project = await makeProject();
  const workspace = await mkdtemp(join(tmpdir(), "pocket-novel-collections-history-"));
  const options = { projectRoot: project, projectId: "test-project", workspaceRoot: workspace, novelRestoreEpoch: 0 };
  const path = "http://127.0.0.1/api/projects/test-project/novel/history";
  const requestHistory = (method: string, body?: unknown) => handleNovelRoute(new Request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), options);
  try {
    const validAssets = {
      ...sampleAssets,
      collections: { people: { title: "People", entries: { mira: { title: "Mira", body: "Keeper.", portrait: { character: "mira", expression: "neutral" } } } } },
    };
    const initial = await (await requestHistory("GET")).json() as any;
    const validDraft = { story: sampleStory, assets: validAssets, authoringDraft: null };
    const validWrite = await requestHistory("PUT", {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: initial.historyRevision,
      draft: validDraft,
      undo: [{ scope: "assets", key: "collection:add:people", restore: sampleAssets }],
      redo: [],
    });
    assert.equal(validWrite.status, 200);
    const reread = await (await requestHistory("GET")).json() as any;
    assert.deepEqual(reread.history.draft.assets.collections, validAssets.collections);
    assert.deepEqual(reread.history.undo[0].restore, sampleAssets);

    const head = await (await requestHistory("GET")).json() as any;
    const invalidAssets = structuredClone(validAssets) as any;
    invalidAssets.collections.people.entries.mira.unexpected = "not allowed";
    const invalidWrite = await requestHistory("PUT", {
      expectedToken: head.sourceToken,
      expectedHistoryRevision: head.historyRevision,
      draft: { ...validDraft, assets: invalidAssets },
      undo: [],
      redo: [],
    });
    assert.equal(invalidWrite.status, 422, "durable draft history must keep collection entry allowlists strict");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("locale route atomically persists one canonical collection and diagnoses unsaved story revisions", async () => {
  const project = await makeProject();
  try {
    const assetsWithCollections = {
      ...sampleAssets,
      collections: { people: { title: "人物档案", entries: { mira: { title: "Mira", body: "港口守灯人。" } } } },
    };
    await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assetsWithCollections, null, 2)}\n`);
    const initial = await route(project, "GET", "/api/projects/test-project/novel/locales");
    assert.equal(initial.status, 200);
    const initialPayload = await initial.json() as any;
    assert.deepEqual(initialPayload.collection, { format: "pocket-vn-locales", formatVersion: 1, catalogs: {} });
    assert.ok(initialPayload.uiDefaults["player.menu"]);
    assert.equal(initialPayload.uiDefaults["collection.people.title"], "人物档案");
    assert.equal(initialPayload.uiDefaults["collection.people.mira.title"], "Mira");
    assert.equal(initialPayload.uiDefaults["collection.people.mira.body"], "港口守灯人。");

    const collection: StoryLocaleCatalogCollectionDocument = {
      format: "pocket-vn-locales",
      formatVersion: 1,
      catalogs: {
        en: {
          format: "pocket-vn-locale",
          formatVersion: 1,
          locale: "en",
          lines: { opening: "Hello, {{name}}." },
          speakers: { Mira: "Mira" },
          choices: { arrival_approach: { prompt: "Where will you go?", options: { listen_mira: "Ask Mira why she came." } } },
          endings: { end: "Goodbye" },
          ui: { "player.menu": "Journal" },
        },
      },
    };
    const storyBefore = await readFile(join(project, "story.json"), "utf8");
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/locales", collection);
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json() as any;
    assert.equal(savedPayload.saved, true);
    assert.equal(savedPayload.uiDefaults["collection.people.mira.body"], "港口守灯人。");
    assert.ok(savedPayload.diagnostics.en.some((item: any) => item.code === "missing-ui" && item.path === "ui.player.brand"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8")), collection);
    assert.equal(await readFile(join(project, "story.json"), "utf8"), storyBefore, "translation updates must not modify the canonical story source");

    const draftStory = structuredClone(sampleStory);
    draftStory.script.start = [...draftStory.script.start, { type: "say", id: "draft-line", text: "Draft source text." }];
    const checkedDraft = await route(project, "POST", "/api/projects/test-project/novel/locales/diagnostics", {
      locale: "en", collection, story: draftStory, assets: sampleAssets,
    });
    assert.equal(checkedDraft.status, 200);
    const draftPayload = await checkedDraft.json() as any;
    assert.ok(draftPayload.diagnostics.some((item: any) => item.code === "missing-line" && item.path === "lines.draft-line"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8")), collection, "draft diagnostics are read-only");

    const beforeInvalidImport = await readFile(join(project, "novel.locales.json"), "utf8");
    const invalid = await route(project, "PUT", "/api/projects/test-project/novel/locales", { ...collection, formatVersion: 99 });
    assert.equal(invalid.status, 422);
    assert.equal(await readFile(join(project, "novel.locales.json"), "utf8"), beforeInvalidImport, "invalid imported data must not replace the last valid collection");

    const reread = await route(project, "GET", "/api/projects/test-project/novel/locales");
    assert.equal(reread.status, 200);
    assert.deepEqual((await reread.json() as any).collection, collection);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("locale route rejects symbolic-link canonical files and never takes a caller-selected path", async () => {
  const project = await makeProject();
  const outside = join(project, "..", `outside-${Date.now()}.json`);
  try {
    await writeFile(outside, JSON.stringify({ format: "pocket-vn-locales", formatVersion: 1, catalogs: {} }));
    await symlink(outside, join(project, "novel.locales.json"));
    const read = await route(project, "GET", "/api/projects/test-project/novel/locales?path=story.json");
    assert.equal(read.status, 400);
    assert.match((await read.json() as any).error, /symbolic link/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("Spine model source and texture routes use registered paths and official metadata", async () => {
  const project = await makeSpineProject();
  try {
    const sourceResponse = await route(project, "GET", "/api/projects/test-project/novel/models/source?key=hero");
    assert.equal(sourceResponse.status, 200);
    const source = await sourceResponse.json() as any;
    assert.equal(source.skeleton.format, "json");
    assert.equal(source.atlasPages[0], "fixture-page.png");
    assert.deepEqual(source.missingTexturePages, []);
    assert.deepEqual(source.premultipliedPages, []);
    assert.deepEqual(source.animationNames, ["idle", "wave"]);
    assert.deepEqual(source.skinNames, ["default"]);
    assert.deepEqual(source.unsupported, []);

    const texture = await route(project, "GET", "/api/projects/test-project/novel/models/resource?key=hero&page=fixture-page.png");
    assert.equal(texture.status, 200);
    assert.equal(texture.headers.get("content-type"), "image/png");
    const traversal = await route(project, "GET", "/api/projects/test-project/novel/models/resource?key=hero&page=..%2Fstory.json");
    assert.equal(traversal.status, 404, "model page values only resolve exact registry keys");

    const registry = JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")) as any;
    registry.models.hero.textures = {};
    await writeFile(join(project, "novel.assets.json"), JSON.stringify(registry));
    const missingPage = await route(project, "GET", "/api/projects/test-project/novel/models/source?key=hero");
    assert.deepEqual((await missingPage.json() as any).missingTexturePages, ["fixture-page.png"]);

    const outside = join(project, "outside.spine.json");
    await writeFile(outside, await readFile(join(project, "models", "hero.spine.json")));
    await symlink(outside, join(project, "models", "linked.spine.json"));
    registry.models.hero.source = "models/linked.spine.json";
    await writeFile(join(project, "novel.assets.json"), JSON.stringify(registry));
    const linked = await route(project, "GET", "/api/projects/test-project/novel/models/source?key=hero");
    assert.equal(linked.status, 404, "registered source symlinks are rejected");

    registry.models.hero.source = "../outside.spine.json";
    const unsafeWrite = await route(project, "PUT", "/api/projects/test-project/novel/assets", registry);
    assert.equal(unsafeWrite.status, 422);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("asset skin accepts optional accent frames and icon atlases with project-local paths", async () => {
  const project = await makeProject();
  try {
    const assets = {
      ...sampleAssets,
      skin: {
        frame: { image: "art/station.png", width: 512, height: 512, inset: 120 },
        accentFrame: { image: "art/mira.png", width: 512, height: 512, inset: 96 },
        icons: { image: "art/memory.png", width: 512, height: 512, columns: 2, rows: 1, names: ["start", "journal"] },
      },
    };
    assert.deepEqual(validateAssetRegistry(assets, project), []);

    const saved = await route(project, "PUT", "/api/projects/test-project/novel/assets", assets);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets);
    const iconAtlas = await route(project, "GET", "/novel/resource?project=test-project&kind=skin&path=art/memory.png");
    assert.equal(iconAtlas.status, 200, "icon atlases reuse the same confined project image preview route");

    const invalidNames = structuredClone(assets);
    invalidNames.skin.icons.names = ["start", "start"];
    const invalidShape = await route(project, "PUT", "/api/projects/test-project/novel/assets", invalidNames);
    assert.equal(invalidShape.status, 422);
    const shapeBody = await invalidShape.json() as any;
    assert.ok(shapeBody.diagnostics.some((item: any) => item.code === "assets.skin.schema" && item.message.includes("icons")));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets, "invalid icon metadata must not replace canonical assets");

    for (const field of ["accentFrame", "icons"] as const) {
      const unsafe = structuredClone(assets);
      unsafe.skin[field].image = "../story.json";
      const rejected = await route(project, "PUT", "/api/projects/test-project/novel/assets", unsafe);
      assert.equal(rejected.status, 422, `${field} images must use project-relative paths`);
      assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), assets, "unsafe optional skin paths are rejected atomically");
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("editor Spine browser bundle exposes the same novel factory", { timeout: 30_000 }, async () => {
  const project = await makeProject();
  try {
    const response = await route(project, "GET", "/api/projects/test-project/novel/spine.js");
    const source = await response.text();
    assert.equal(response.status, 200, source.slice(0, 500));
    assert.match(source, /createNovelSpineFactory/);
    assert.match(source, /createSpineRig/);
    assert.doesNotMatch(source, /document\.createElement/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("story and asset registry fixed paths reject symbolic links and page requires its selected project", async () => {
  const project = await makeProject();
  const external = join(project, "outside.json");
  try {
    await writeFile(external, JSON.stringify(sampleStory));
    await rm(join(project, "story.json"));
    await symlink(external, join(project, "story.json"));
    const linkedStory = await route(project, "GET", "/api/projects/test-project/novel/story");
    assert.equal(linkedStory.status, 400);

    await rm(join(project, "story.json"));
    await writeFile(join(project, "story.json"), JSON.stringify(sampleStory));
    await rm(join(project, "novel.assets.json"));
    await symlink(external, join(project, "novel.assets.json"));
    const linkedAssets = await route(project, "GET", "/api/projects/test-project/novel/assets");
    assert.equal(linkedAssets.status, 400);

    const wrongProject = await route(project, "GET", "/novel?project=other-project");
    assert.equal(wrongProject.status, 404);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("runtime route bundles the same createNovelEngine and safe debug controls", { timeout: 30_000 }, async () => {
  const project = await makeProject();
  try {
    const response = await route(project, "GET", "/api/projects/test-project/novel/runtime.js");
    assert.equal(response.status, 200);
    const source = await response.text();
    assert.match(source, /createNovelEngine/);
    const bundlePath = join(project, "novel-runtime.mjs");
    await writeFile(bundlePath, source);
    const runtime = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`) as typeof import("../../packages/pocket_vn/src/index.ts");
    assert.equal(typeof runtime.resolveNovelCharacterPlacement, "function");
    assert.equal(typeof runtime.parseStoryText, "function");
    const engine = runtime.createNovelEngine(sampleStory);
    engine.start();
    engine.debug.pause();
    assert.equal(engine.getSnapshot().active?.kind, "say");
    engine.debug.step();
    assert.equal(engine.getSnapshot().active?.kind, "ending");
    assert.deepEqual(engine.getSnapshot().variables.visited, false);
    engine.dispose();
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
