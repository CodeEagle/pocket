import { expect, test } from "bun:test";
import { validateStoryDefinition } from "../novel.ts";
import { addNovelBlueprintNode, type NovelBlueprintNodeSpec } from "../../packages/pocket_vn/src/blueprint.ts";
import type { StoryDefinition } from "../../packages/pocket_vn/src/types.ts";

const baseStory: StoryDefinition = {
  id: "blueprint-schema",
  version: 1,
  start: "entry",
  script: {
    entry: [{ type: "jump", target: "finish" }],
    finish: [{ type: "ending", id: "finish" }],
  },
};

test("Editor validates blueprint role metadata against existing script labels", () => {
  const valid = validateStoryDefinition({
    ...baseStory,
    editor: { blueprint: { version: 1, nodes: { entry: { kind: "entry", title: "Start" }, finish: { kind: "end" } } } },
  });
  expect(valid.diagnostics.filter(diagnostic => diagnostic.code === "story.editor.blueprint")).toEqual([]);

  const missingLabel = validateStoryDefinition({
    ...baseStory,
    editor: { blueprint: { version: 1, nodes: { missing: { kind: "entry" } } } },
  });
  expect(missingLabel.diagnostics).toContainEqual(expect.objectContaining({
    code: "story.editor.blueprint",
    location: { field: 'editor.blueprint.nodes["missing"]' },
  }));

  const invalidRole = validateStoryDefinition({
    ...baseStory,
    editor: { blueprint: { version: 1, nodes: { entry: { kind: "route" } } } },
  });
  expect(invalidRole.diagnostics).toContainEqual(expect.objectContaining({
    code: "story.editor.blueprint",
    location: { field: 'editor.blueprint.nodes["entry"].kind' },
  }));
});

test("legacy story files without blueprint metadata remain valid", () => {
  const result = validateStoryDefinition(baseStory);
  expect(result.valid).toBe(true);
  expect(result.diagnostics).toEqual([]);
});

test("blueprint helper boundaries match Editor instruction text and JSON validation", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = 0;
    for (let index = 0; index < depth; index++) value = [value];
    return value;
  };
  const assignment = (depth: number): StoryDefinition => addNovelBlueprintNode(baseStory, {
    kind: "assignment", label: "boundary-assignment", variable: "score", value: nest(depth) as never, next: "finish",
  });
  expect(validateStoryDefinition(assignment(32)).valid).toBe(true);
  expect(() => assignment(33)).toThrow(/nesting depth at most 32/);

  const condition = (depth: number): StoryDefinition => addNovelBlueprintNode(baseStory, {
    kind: "condition",
    label: "boundary-condition",
    when: { op: "truthy", value: { type: "literal", value: nest(depth) as never } },
    then: "finish",
    else: "finish",
  });
  expect(validateStoryDefinition(condition(30)).valid).toBe(true);
  expect(() => condition(31)).toThrow(/valid Pocket VN condition/);
  expect(() => addNovelBlueprintNode(baseStory, {
    kind: "condition", label: "sparse-condition", when: { op: "and", conditions: new Array(1) } as never, then: "finish", else: "finish",
  })).toThrow(/valid Pocket VN condition/);

  const choiceAtLimit = addNovelBlueprintNode(baseStory, {
    kind: "choice", label: "boundary-choice", prompt: "p".repeat(16_384),
    options: [{ id: "go", text: "o".repeat(16_384), target: "finish" }],
  });
  expect(validateStoryDefinition(choiceAtLimit).valid).toBe(true);
  expect(() => addNovelBlueprintNode(baseStory, { kind: "choice", label: "long-prompt", prompt: "p".repeat(16_385), options: [{ id: "go", text: "Go", target: "finish" }] })).toThrow(/prompt.*16384/);
  expect(() => addNovelBlueprintNode(baseStory, { kind: "choice", label: "long-option", options: [{ id: "go", text: "o".repeat(16_385), target: "finish" }] })).toThrow(/valid Pocket VN choice options/);
  expect(() => addNovelBlueprintNode(baseStory, { kind: "end", label: "long-ending", text: "e".repeat(16_385) })).toThrow(/text.*16384/);

  const accessorValue: Record<string, unknown> = {};
  Object.defineProperty(accessorValue, "score", { enumerable: true, get: () => 1 });
  const symbolValue = { [Symbol("extra")]: 1 };
  const customArray = [1] as unknown[] & { extra?: number };
  customArray.extra = 2;
  for (const value of [accessorValue, symbolValue, customArray]) {
    const spec = { kind: "assignment", label: "unsafe-json", variable: "score", value, next: "finish" } as unknown as NovelBlueprintNodeSpec;
    expect(() => addNovelBlueprintNode(baseStory, spec)).toThrow(/JSON value/);
  }
});
