import { expect, test } from "bun:test";
import { addNovelBlueprintNode, novelBlueprintMetadataIssue } from "../src/blueprint.ts";
import { conditions, createNovelEngine, value } from "../src/engine.ts";
import type { NovelBlueprintNodeSpec } from "../src/blueprint.ts";
import type { StoryDefinition } from "../src/types.ts";

const consumerAuthoring = { consumer: "kept", theme: { color: "navy" } };
const initialStory = {
  id: "blueprint-execution",
  version: 1,
  start: "unused",
  authoring: consumerAuthoring,
  editor: { graph: { version: 1, positions: { unused: { x: 5, y: 7 } } }, consumerEditorData: { selectedTab: "script" } },
  script: {
    unused: [],
    "chapter-low-body": [
      { type: "say", id: "low-body-line", text: "The low route returns explicitly." },
      { type: "return" },
    ],
    "chapter-high-body": [
      { type: "say", id: "high-body-line", text: "The high route returns at EOF." },
    ],
  },
} as StoryDefinition;

const lowOption = { id: "low", text: "Choose 59", target: "assign-low" } as const;
const highOption = { id: "high", text: "Choose 60", target: "assign-high" } as const;

function buildStory(): StoryDefinition {
  const specs: readonly NovelBlueprintNodeSpec[] = [
    { kind: "end", label: "end-low", title: "Low ending", text: "The tide waits." },
    { kind: "end", label: "end-high", title: "High ending", text: "The bell answers." },
    { kind: "chapter", label: "chapter-low", chapterTarget: "chapter-low-body", next: "end-low" },
    { kind: "chapter", label: "chapter-high", chapterTarget: "chapter-high-body", next: "end-high" },
    {
      kind: "condition",
      label: "score-condition",
      title: "Score threshold",
      when: conditions.gte(value.variable("score"), value.literal(60)),
      then: "chapter-high",
      else: "chapter-low",
    },
    { kind: "assignment", label: "assign-low", variable: "score", value: 59, next: "score-condition" },
    { kind: "assignment", label: "assign-high", variable: "score", value: 60, next: "score-condition" },
    { kind: "choice", label: "route-choice", title: "Pick a score", prompt: "Choose a route.", options: [lowOption, highOption] },
    { kind: "entry", label: "blueprint-entry", title: "Story entry", target: "route-choice" },
  ];
  return specs.reduce((story, spec) => addNovelBlueprintNode(story, spec), initialStory);
}

function finishDialogue(engine: ReturnType<typeof createNovelEngine>): void {
  for (let step = 0; step < 4; step++) {
    const active = engine.getSnapshot().active;
    if (active?.kind !== "say") return;
    if (!active.complete) engine.advance();
    engine.advance();
  }
  throw new Error("The chapter did not return to its ending node.");
}

function withoutBlueprint(story: StoryDefinition): StoryDefinition {
  const editor = story.editor!;
  const { blueprint: _blueprint, ...consumerEditor } = editor;
  return { ...story, editor: consumerEditor };
}

function playToEnding(story: StoryDefinition, optionId: string, saveAtChapter = false) {
  const engine = createNovelEngine(story);
  engine.start();
  expect(engine.getSnapshot().active?.kind).toBe("choice");
  engine.selectChoice(optionId);
  expect(engine.getSnapshot().active?.kind).toBe("say");
  if (saveAtChapter) {
    const save = engine.save();
    const restored = createNovelEngine(story);
    restored.load(save);
    finishDialogue(restored);
    return { engine: restored, save };
  }
  finishDialogue(engine);
  return { engine, save: engine.save() };
}

test("blueprint nodes compile to canonical instructions and execute both chapter return forms", () => {
  const story = buildStory();
  expect(story.start).toBe(initialStory.start); // adding an entry does not silently change the start label
  expect(story.script["blueprint-entry"]).toEqual([{ type: "jump", target: "route-choice" }]);
  expect(story.script["chapter-low"]).toEqual([
    { type: "call", target: "chapter-low-body" },
    { type: "jump", target: "end-low" },
  ]);
  expect(story.script["score-condition"]).toEqual([{
    type: "branch",
    when: conditions.gte(value.variable("score"), value.literal(60)),
    then: "chapter-high",
    else: "chapter-low",
  }]);
  expect(story.script["route-choice"]?.[0]).toMatchObject({
    type: "choice", prompt: "Choose a route.", options: [lowOption, highOption],
  });
  expect(story.script["assign-low"]).toEqual([
    { type: "set", variable: "score", value: 59 },
    { type: "jump", target: "score-condition" },
  ]);
  expect(story.script["end-low"]?.[0]).toMatchObject({ type: "ending", text: "The tide waits." });
  expect(story.editor?.blueprint?.nodes["score-condition"]).toEqual({ kind: "condition", title: "Score threshold" });
  expect((story as StoryDefinition & { readonly authoring: typeof consumerAuthoring }).authoring).toEqual(consumerAuthoring);
  expect(story.editor?.consumerEditorData).toEqual({ selectedTab: "script" });
  expect(story.script.unused).toBe(initialStory.script.unused);

  const startedStory: StoryDefinition = { ...story, start: "blueprint-entry" };
  const low = playToEnding(startedStory, "low", true);
  const lowEnding = story.script["end-low"]?.[0];
  if (lowEnding?.type !== "ending") throw new Error("Expected generated low ending instruction.");
  expect(low.engine.getSnapshot().variables.score).toBe(59);
  expect(low.engine.getSnapshot().active).toMatchObject({ kind: "ending", id: lowEnding.id });
  expect(low.engine.getSnapshot().meta.endingIds).toContain(lowEnding.id);

  const highWithMetadata = playToEnding(startedStory, "high");
  const highWithoutMetadata = playToEnding(withoutBlueprint(startedStory), "high");
  expect(highWithMetadata.engine.getSnapshot().variables.score).toBe(60);
  expect(highWithMetadata.engine.getSnapshot().active).toMatchObject({ kind: "ending", text: "The bell answers." });
  expect(highWithMetadata.save).toEqual(highWithoutMetadata.save);
  highWithMetadata.engine.dispose();
  highWithoutMetadata.engine.dispose();
  low.engine.dispose();
});

test("metadata is display-only, validates node roles, titles and script references, and stays optional", () => {
  const story = buildStory();
  expect(novelBlueprintMetadataIssue(undefined, story.script)).toBeNull();
  expect(novelBlueprintMetadataIssue(story.editor?.blueprint, story.script)).toBeNull();
  expect(novelBlueprintMetadataIssue({ version: 2, nodes: {} }, story.script)).toContain("editor.blueprint.version");
  expect(novelBlueprintMetadataIssue({ version: 1, nodes: { missing: { kind: "entry" } } }, story.script)).toContain("existing script label");
  expect(novelBlueprintMetadataIssue({ version: 1, nodes: { unused: { kind: "route" } } }, story.script)).toContain(".kind");
  expect(novelBlueprintMetadataIssue({ version: 1, nodes: { unused: { kind: "entry", title: 4 } } }, story.script)).toContain(".title");
  expect(novelBlueprintMetadataIssue({ version: 1, nodes: { unused: { kind: "entry", target: "other" } } }, story.script)).toContain("routes belong in script instructions");

  const started = { ...story, start: "blueprint-entry" };
  const withMetadata = createNovelEngine(started);
  const withoutMetadata = createNovelEngine(withoutBlueprint(started));
  expect(withMetadata.start().snapshot).toEqual(withoutMetadata.start().snapshot);
  expect(withMetadata.save()).toEqual(withoutMetadata.save());
  withMetadata.dispose();
  withoutMetadata.dispose();
});

test("generated choice and ending IDs avoid existing story IDs, and invalid adds leave the story untouched", () => {
  const base: StoryDefinition = {
    id: "blueprint-ids", version: 1, start: "start", script: {
      start: [], target: [{ type: "ending", id: "existing-end" }],
    },
  };
  const choiceSpec: NovelBlueprintNodeSpec = { kind: "choice", label: "new-choice", options: [{ id: "go", text: "Go", target: "target" }] };
  const firstChoiceStory = addNovelBlueprintNode(base, choiceSpec);
  const firstChoiceId = (firstChoiceStory.script["new-choice"]?.[0] as { id: string }).id;
  const collisionStory: StoryDefinition = {
    ...base,
    script: { ...base.script, existing: [{ type: "say", id: firstChoiceId, text: "Collision" }] },
  };
  const secondChoiceStory = addNovelBlueprintNode(collisionStory, choiceSpec);
  const secondChoiceId = (secondChoiceStory.script["new-choice"]?.[0] as { id: string }).id;
  expect(secondChoiceId).toBe(`${firstChoiceId}-2`);

  const endSpec: NovelBlueprintNodeSpec = { kind: "end", label: "new-end", text: "Done." };
  const firstEndStory = addNovelBlueprintNode(base, endSpec);
  const firstEndId = (firstEndStory.script["new-end"]?.[0] as { id: string }).id;
  const endingCollisionStory: StoryDefinition = {
    ...base,
    script: { ...base.script, start: [{ type: "say", id: firstEndId, text: "Collision" }] },
  };
  const secondEndStory = addNovelBlueprintNode(endingCollisionStory, endSpec);
  expect((secondEndStory.script["new-end"]?.[0] as { id: string }).id).toBe(`${firstEndId}-2`);

  const invalidBefore = structuredClone(base);
  expect(() => addNovelBlueprintNode(base, { kind: "entry", label: "start", target: "target" })).toThrow(/already exists/);
  expect(() => addNovelBlueprintNode(base, { kind: "assignment", label: "bad-assignment", variable: "no space", value: 1, next: "target" })).toThrow(/variable name/);
  expect(() => addNovelBlueprintNode(base, { kind: "condition", label: "bad-condition", when: { op: "gte", left: { type: "variable", name: "score" }, right: { type: "literal", value: 60 } }, then: "target", else: "target", route: "duplicate edge" } as never)).toThrow(/not a supported blueprint field/);
  expect(base).toEqual(invalidBefore);

  const malformedMetadata: StoryDefinition = { ...base, editor: { blueprint: { version: 1, nodes: { missing: { kind: "entry" } } } } };
  const malformedBefore = structuredClone(malformedMetadata);
  expect(() => addNovelBlueprintNode(malformedMetadata, { kind: "end", label: "new-end" })).toThrow(/existing script label/);
  expect(malformedMetadata).toEqual(malformedBefore);
});
