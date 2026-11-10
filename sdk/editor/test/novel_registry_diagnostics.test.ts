import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { validateNovelAssetReferences } from "../../packages/pocket_vn/src/index.ts";
import type { StoryDefinition } from "../../packages/pocket_vn/src/types.ts";
import { handleNovelRoute, validateAssetRegistry, validateStoryDefinition, type NovelAssetRegistry } from "../novel.ts";

const validAssets: NovelAssetRegistry = {
  backgrounds: { station: "art/station.png" },
  characters: { mira: { neutral: "art/mira.png" } },
  cgs: { memory: { image: "art/memory.png", title: "A memory" } },
  audio: { theme: "audio/theme.wav" },
  videos: { loop: "video/loop.mp4" },
  models: {
    hero_model: {
      kind: "spine",
      source: "models/hero.json",
      atlas: "models/hero.atlas",
      textures: { "hero.png": "art/mira.png" },
      animations: ["idle"],
    },
  },
};

const validStory: StoryDefinition = {
  id: "registry-diagnostics",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral" }] },
      { type: "say", id: "hello", voice: "theme", text: "Hello." },
      { type: "audio", cue: "theme" },
      { type: "video", action: "play", cue: "loop" },
      { type: "ending", id: "end", cg: "memory" },
    ],
  },
};

async function makeProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "pocket-vn-registry-diagnostics-"));
  await mkdir(join(project, "art"), { recursive: true });
  await mkdir(join(project, "assets/audio"), { recursive: true });
  await mkdir(join(project, "assets/video"), { recursive: true });
  await mkdir(join(project, "models"), { recursive: true });
  for (const name of ["station.png", "mira.png", "memory.png"]) {
    await writeFile(join(project, "art", name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  await writeFile(join(project, "assets/audio/theme.wav"), Buffer.from("wav"));
  await writeFile(join(project, "assets/video/loop.mp4"), Buffer.from("mp4"));
  await writeFile(join(project, "models/hero.json"), "{}\n");
  await writeFile(join(project, "models/hero.atlas"), "hero.png\n");
  await writeFile(join(project, "models/actor.model3.json"), "{}\n");
  await writeFile(join(project, "story.json"), `${JSON.stringify(validStory, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(validAssets, null, 2)}\n`);
  return project;
}

function route(projectRoot: string, method: string, path: string, body?: unknown, workspaceRoot?: string): Promise<Response> {
  return handleNovelRoute(new Request(`http://127.0.0.1${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), { projectRoot, projectId: "test-project", ...(workspaceRoot === undefined ? {} : { workspaceRoot }) });
}

test("the rich-text authoring module is available from both local Editor static route forms", async () => {
  for (const path of [
    "/novel-rich-editor.js",
    "/api/projects/test-project/novel/novel-rich-editor.js",
  ]) {
    const response = await handleNovelRoute(new Request(`http://127.0.0.1${path}`), { projectRoot: tmpdir(), projectId: "test-project" });
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /renderRichEditor/);
  }
});

test("the shared registry helper covers story, character, media, model, CG, choice and timeline references", async () => {
  const project = await makeProject();
  try {
    assert.deepEqual(validateAssetRegistry(validAssets, project), []);
    assert.deepEqual(validateNovelAssetReferences(validStory, validAssets), [], "valid optional registry maps remain valid");
    const response = await route(project, "GET", "/api/projects/test-project/novel/story");
    assert.equal(response.status, 200);
    const payload = await response.json() as { validation: { valid: boolean; diagnostics: Array<{ code: string; location?: { label?: string; index?: number; field?: string } }> } };
    assert.equal(payload.validation.valid, true);
    assert.equal(payload.validation.diagnostics.some(item => item.code === "assets.reference"), false);

    const fallbackStory: any = structuredClone(validStory);
    fallbackStory.script.start[0].characters[0].expression = "smiling";
    assert.equal(
      validateNovelAssetReferences(fallbackStory, validAssets).some(item => item.location?.field === "characters[0].expression"),
      false,
      "a registered neutral expression remains a valid fallback",
    );
    const optionalStory: StoryDefinition = {
      id: "optional-registry-entries",
      version: 1,
      start: "start",
      script: {
        start: [
          { type: "scene", characters: [
            { id: "cleared-placeholder", visible: false },
            { id: "model-only-actor", model: { key: "hero_model" } },
          ] },
          { type: "ending", id: "end" },
        ],
      },
    };
    assert.deepEqual(
      validateNovelAssetReferences(optionalStory, validAssets),
      [],
      "hidden static characters and model-backed actors do not require optional static character resources",
    );

    const story: any = structuredClone(validStory);
    story.timelines = { fade: { durationMs: 1, audio: [{ atMs: 0, cue: "missing_timeline_cue" }] } };
    story.script.start = [
      {
        type: "scene",
        background: "missing_background",
        backgroundLayers: [{ background: "missing_layer", parallax: 0.5 }],
        objects: [{ id: "letter", image: "missing_object", frame: { x: 0, y: 0, w: 1, h: 1 } }],
        characters: [
          { id: "missing_character", position: "left" },
          { id: "mira", expression: "missing_expression" },
          { id: "model_actor", model: { key: "missing_model", animation: "idle" } },
          { id: "hero_actor", model: { key: "hero_model", animation: "missing_animation" } },
        ],
      },
      { type: "say", id: "voice", voice: "missing_voice", text: "Voice." },
      { type: "audio", cue: "missing_audio" },
      { type: "video", action: "play", cue: "missing_video" },
      { type: "ending", id: "end", cg: "missing_cg" },
    ];
    const surfaces = {
      ...validAssets,
      characters: { mira: { happy: "art/mira.png" } },
      choiceSurfaces: { orphan: { kind: "scene", targets: { yes: { x: 0, y: 0, w: 1, h: 1 } } } },
      atmospheres: { missing_atmosphere_background: { mist: "art/mist.png" } },
    };
    const diagnostics = validateNovelAssetReferences(story, surfaces);
    const fields = new Set(diagnostics.map(item => item.location?.field));
    for (const field of [
      "background",
      "backgroundLayers[0].background",
      "objects[0].image",
      "characters[0].id",
      "characters[1].expression",
      "characters[2].model.key",
      "characters[3].model.animation",
      "voice",
      "cue",
      "cg",
      "timelines.fade.audio[0].cue",
      "choiceSurfaces.orphan",
      "atmospheres.missing_atmosphere_background",
    ]) assert.ok(fields.has(field), `expected a precise reference location for ${field}; got ${JSON.stringify([...fields])}`);
    assert.ok(diagnostics.every(item => item.severity === "error"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("invalid conditions point to their exact story field and rejected story writes leave disk and history untouched", async () => {
  const project = await makeProject();
  const workspace = await mkdtemp(join(tmpdir(), "pocket-vn-registry-history-"));
  try {
    const invalidStory: any = structuredClone(validStory);
    invalidStory.script.start.push(
      { type: "branch", when: { op: "xor" }, then: "start", else: "start" },
      { type: "choice", id: "conditional", options: [{ id: "yes", text: "Yes", target: "start", when: { op: "truthy", value: { type: "variable" } } }] },
      { type: "scene", objects: [{ id: "note", image: "station", frame: { x: 0, y: 0, w: 1, h: 1 }, interaction: { label: "Read", effects: [{ type: "set", variable: "read", value: true }], when: { op: "not" } } }] },
    );
    const validation = validateStoryDefinition(invalidStory);
    const conditionDiagnostics = validation.diagnostics.filter(item => item.code === "instruction.condition");
    assert.ok(conditionDiagnostics.some(item => item.location?.field === "when" && item.message.includes("script.start[5].when.op")));
    assert.ok(conditionDiagnostics.some(item => item.location?.field === "options[0].when" && item.message.includes("script.start[6].options[0].when.value.name")));
    assert.ok(conditionDiagnostics.some(item => item.location?.field === "objects[0].interaction.when" && item.message.includes("script.start[7].objects[0].interaction.when.condition")));

    const initialHistory = await (await route(project, "GET", "/api/projects/test-project/novel/history?head=1", undefined, workspace)).json() as { sourceToken: string; historyRevision: number };
    const rejected = await route(project, "PUT", "/api/projects/test-project/novel/story", invalidStory, workspace);
    assert.equal(rejected.status, 422);
    const rejectedPayload = await rejected.json() as { validation: { diagnostics: Array<{ code: string; location?: { field?: string } }> } };
    assert.ok(rejectedPayload.validation.diagnostics.some(item => item.code === "instruction.condition" && item.location?.field === "when"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), validStory);
    const afterHistory = await (await route(project, "GET", "/api/projects/test-project/novel/history?head=1", undefined, workspace)).json() as { sourceToken: string; historyRevision: number };
    assert.deepEqual(afterHistory, initialHistory, "a rejected condition write must not change durable history");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("registry asset path diagnostics identify fields while retaining the editable missing-file workflow", async () => {
  const project = await makeProject();
  try {
    const original = JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8"));
    const unsafe: any = structuredClone(validAssets);
    unsafe.backgrounds.station = "../private.png";
    const rejected = await route(project, "PUT", "/api/projects/test-project/novel/assets", unsafe);
    assert.equal(rejected.status, 422);
    const rejectedPayload = await rejected.json() as { diagnostics: Array<{ code: string; location?: { field?: string } }> };
    assert.ok(rejectedPayload.diagnostics.some(item => item.code === "assets.path" && item.location?.field === "backgrounds.station"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), original);

    const missingFile: any = structuredClone(validAssets);
    missingFile.characters.mira.neutral = "art/missing.png";
    const saved = await route(project, "PUT", "/api/projects/test-project/novel/assets", missingFile);
    assert.equal(saved.status, 200, "missing files stay editable so authors can correct paths or add the file");
    const savedPayload = await saved.json() as { diagnostics: Array<{ code: string; location?: { field?: string } }> };
    assert.ok(savedPayload.diagnostics.some(item => item.code === "assets.missing" && item.location?.field === "characters.mira.neutral"));
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")), missingFile);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("Spine and Live2D registry paths keep field locations without blanket Live2D warnings", async () => {
  const project = await makeProject();
  try {
    const spineCases: Array<{ field: string; update: (assets: any) => void }> = [
      { field: "models.hero_model.source", update: assets => { assets.models.hero_model.source = "models/missing.json"; } },
      { field: "models.hero_model.atlas", update: assets => { assets.models.hero_model.atlas = "models/missing.atlas"; } },
      { field: "models.hero_model.textures.hero.png", update: assets => { assets.models.hero_model.textures["hero.png"] = "art/missing.png"; } },
    ];
    for (const item of spineCases) {
      const assets: any = structuredClone(validAssets);
      item.update(assets);
      const diagnostic = validateAssetRegistry(assets, project).find(issue => issue.location?.field === item.field);
      assert.equal(diagnostic?.code, "assets.missing", `expected ${item.field} to identify its missing file`);
    }

    const missingAtlas: any = structuredClone(validAssets);
    missingAtlas.models.hero_model = { kind: "spine", source: "models/hero.json", textures: {} };
    const atlasDiagnostic = validateAssetRegistry(missingAtlas, project).find(issue => issue.code === "models.atlas.missing");
    assert.equal(atlasDiagnostic?.location?.field, "models.hero_model.atlas");

    const live2dAssets: any = structuredClone(validAssets);
    live2dAssets.models = {
      actor: { kind: "live2d", source: "models/actor.model3.json", textures: { page: "art/mira.png" } },
    };
    const live2dDiagnostics = validateAssetRegistry(live2dAssets, project);
    assert.deepEqual(live2dDiagnostics.filter(issue => issue.severity === "error"), []);
    assert.equal(live2dDiagnostics.some(issue => issue.code === "models.runtime.unsupported"), false);

    live2dAssets.models.actor.source = "models/missing.model3.json";
    const live2dSource = validateAssetRegistry(live2dAssets, project).find(issue => issue.code === "assets.missing");
    assert.equal(live2dSource?.location?.field, "models.actor.source");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
