import { isNovelVariableName } from "./variables.ts";
import type {
  ChoiceOptionDefinition,
  Condition,
  JsonValue,
  NovelBlueprintNodeKind,
  NovelBlueprintNodeMetadata,
  NovelStoryBlueprintMetadata,
  StoryDefinition,
  StoryInstruction,
  ValueExpression,
} from "./types.ts";

type BlueprintNodeSpecBase = {
  readonly label: string;
  readonly title?: string;
};

export type NovelBlueprintNodeSpec =
  | (BlueprintNodeSpecBase & { readonly kind: "entry"; readonly target: string })
  | (BlueprintNodeSpecBase & { readonly kind: "chapter"; readonly chapterTarget: string; readonly next: string })
  | (BlueprintNodeSpecBase & { readonly kind: "condition"; readonly when: Condition; readonly then: string; readonly else: string })
  | (BlueprintNodeSpecBase & { readonly kind: "choice"; readonly prompt?: string; readonly options: readonly ChoiceOptionDefinition[] })
  | (BlueprintNodeSpecBase & { readonly kind: "assignment"; readonly variable: string; readonly value: JsonValue; readonly next: string })
  | (BlueprintNodeSpecBase & { readonly kind: "end"; readonly text?: string });

const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const blueprintKinds = new Set<NovelBlueprintNodeKind>(["entry", "chapter", "condition", "choice", "assignment", "end"]);
const maxTitleLength = 256;
const maxTextLength = 16_384;
const maxValidationDepth = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && labelPattern.test(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertAllowedFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected !== undefined) throw new TypeError(`${path}.${unexpected} is not a supported blueprint field.`);
}

function assertBaseSpec(spec: Record<string, unknown>): asserts spec is Record<string, unknown> & { kind: NovelBlueprintNodeKind; label: string; title?: string } {
  if (typeof spec.kind !== "string" || !blueprintKinds.has(spec.kind as NovelBlueprintNodeKind)) {
    throw new TypeError("spec.kind must be entry, chapter, condition, choice, assignment, or end.");
  }
  if (!isLabel(spec.label)) throw new TypeError("spec.label must be a safe story label.");
  if (spec.title !== undefined && (typeof spec.title !== "string" || spec.title.length > maxTitleLength)) {
    throw new TypeError(`spec.title must be a string of at most ${maxTitleLength} characters.`);
  }
}

function assertTarget(value: unknown, field: string): asserts value is string {
  if (!isLabel(value)) throw new TypeError(`${field} must be a safe story label.`);
}

function isJsonValue(value: unknown, active = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > maxValidationDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (active.has(value)) return false;
  active.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = true;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isJsonValue(descriptor.value, active, depth + 1)) {
        valid = false;
        break;
      }
    }
    if (valid) {
      valid = Object.keys(descriptors).every(key => key === "length" || /^\d+$/.test(key));
    }
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    valid = Object.keys(value).every(key => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable && isJsonValue(descriptor.value, active, depth + 1);
    });
  }
  active.delete(value);
  return valid;
}

function isValueExpression(value: unknown, depth: number): value is ValueExpression {
  if (depth > maxValidationDepth || !isRecord(value)) return false;
  if (value.type === "literal") return isJsonValue(value.value, new Set(), depth + 1);
  return value.type === "variable" && typeof value.name === "string" && isNovelVariableName(value.name);
}

function isCondition(value: unknown, depth = 0): value is Condition {
  if (depth > maxValidationDepth || !isRecord(value)) return false;
  switch (value.op) {
    case "truthy":
    case "falsy": return isValueExpression(value.value, depth + 1);
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": return isValueExpression(value.left, depth + 1) && isValueExpression(value.right, depth + 1);
    case "and":
    case "or": {
      if (!Array.isArray(value.conditions) || value.conditions.length === 0 || value.conditions.length > 128) return false;
      for (let index = 0; index < value.conditions.length; index++) {
        if (!hasOwn(value.conditions, index) || !isCondition(value.conditions[index], depth + 1)) return false;
      }
      return true;
    }
    case "not": return isCondition(value.condition, depth + 1);
    default: return false;
  }
}

function isChoiceOptions(value: unknown): value is readonly ChoiceOptionDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return false;
  const ids = new Set<string>();
  for (const option of value) {
    if (!isRecord(option) || !isLabel(option.id) || ids.has(option.id) || !isText(option.text) || !isLabel(option.target)) return false;
    ids.add(option.id);
    if (option.when !== undefined && !isCondition(option.when)) return false;
  }
  return true;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxTextLength;
}

function assertSpec(specValue: NovelBlueprintNodeSpec): NovelBlueprintNodeSpec {
  if (!isRecord(specValue)) throw new TypeError("spec must be a plain object.");
  const spec = specValue;
  assertBaseSpec(spec);
  switch (spec.kind) {
    case "entry":
      assertAllowedFields(spec, ["kind", "label", "title", "target"], "spec");
      assertTarget(spec.target, "spec.target");
      break;
    case "chapter":
      assertAllowedFields(spec, ["kind", "label", "title", "chapterTarget", "next"], "spec");
      assertTarget(spec.chapterTarget, "spec.chapterTarget");
      assertTarget(spec.next, "spec.next");
      break;
    case "condition":
      assertAllowedFields(spec, ["kind", "label", "title", "when", "then", "else"], "spec");
      if (!isCondition(spec.when)) throw new TypeError("spec.when must be a valid Pocket VN condition.");
      assertTarget(spec.then, "spec.then");
      assertTarget(spec.else, "spec.else");
      break;
    case "choice":
      assertAllowedFields(spec, ["kind", "label", "title", "prompt", "options"], "spec");
      if (spec.prompt !== undefined && !isText(spec.prompt)) throw new TypeError(`spec.prompt must be a string of at most ${maxTextLength} characters.`);
      if (!isChoiceOptions(spec.options)) throw new TypeError("spec.options must contain unique, valid Pocket VN choice options.");
      break;
    case "assignment":
      assertAllowedFields(spec, ["kind", "label", "title", "variable", "value", "next"], "spec");
      if (typeof spec.variable !== "string" || !isNovelVariableName(spec.variable)) throw new TypeError("spec.variable must be a valid story variable name.");
      if (!isJsonValue(spec.value)) throw new TypeError(`spec.value must be a JSON value with nesting depth at most ${maxValidationDepth}.`);
      assertTarget(spec.next, "spec.next");
      break;
    case "end":
      assertAllowedFields(spec, ["kind", "label", "title", "text"], "spec");
      if (spec.text !== undefined && !isText(spec.text)) throw new TypeError(`spec.text must be a string of at most ${maxTextLength} characters.`);
      break;
  }
  return specValue;
}

function stableIds(script: Readonly<Record<string, readonly StoryInstruction[]>>): Set<string> {
  const ids = new Set<string>();
  for (const instructions of Object.values(script)) {
    if (!Array.isArray(instructions)) continue;
    for (const instruction of instructions) {
      if (typeof instruction !== "object" || instruction === null) continue;
      if ("id" in instruction && typeof instruction.id === "string") ids.add(instruction.id);
      if (instruction.type === "choice" && Array.isArray(instruction.options)) {
        for (const option of instruction.options) {
          if (typeof option?.id === "string" && typeof instruction.id === "string") ids.add(`${instruction.id}/${option.id}`);
        }
      }
    }
  }
  return ids;
}

function labelHash(label: string): string {
  // FNV-1a keeps generated instruction IDs deterministic in JS and browser bundles.
  let hash = 0x811c9dc5;
  for (const codePoint of label) {
    hash ^= codePoint.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function generatedId(kind: "choice" | "end", label: string, used: Set<string>, optionIds: readonly string[] = []): string {
  const compactLabel = label.slice(0, 72);
  const base = `blueprint-${kind}-${compactLabel}-${labelHash(label)}`;
  for (let suffix = 1; ; suffix++) {
    const id = suffix === 1 ? base : `${base}-${suffix}`;
    if (id.length > 128 || used.has(id) || optionIds.some(optionId => used.has(`${id}/${optionId}`))) continue;
    used.add(id);
    for (const optionId of optionIds) used.add(`${id}/${optionId}`);
    return id;
  }
}

function generatedInstructions(spec: NovelBlueprintNodeSpec, script: StoryDefinition["script"]): readonly StoryInstruction[] {
  switch (spec.kind) {
    case "entry": return [{ type: "jump", target: spec.target }];
    case "chapter": return [{ type: "call", target: spec.chapterTarget }, { type: "jump", target: spec.next }];
    case "condition": return [{ type: "branch", when: spec.when, then: spec.then, else: spec.else }];
    case "choice": return [{ type: "choice", id: generatedId("choice", spec.label, stableIds(script), spec.options.map(option => option.id)), ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }), options: spec.options }];
    case "assignment": return [{ type: "set", variable: spec.variable, value: spec.value }, { type: "jump", target: spec.next }];
    case "end": return [{ type: "ending", id: generatedId("end", spec.label, stableIds(script)), ...(spec.text === undefined ? {} : { text: spec.text }) }];
  }
}

/**
 * Validate editor-only blueprint metadata. The blueprint stores labels, roles,
 * and optional display titles only; script instructions remain authoritative.
 */
export function novelBlueprintMetadataIssue(value: unknown, script: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "editor.blueprint must be an object.";
  const unknownBlueprintField = Object.keys(value).find(key => key !== "version" && key !== "nodes");
  if (unknownBlueprintField !== undefined) return `editor.blueprint.${unknownBlueprintField} is not a supported metadata field.`;
  if (value.version !== 1) return "editor.blueprint.version must be 1.";
  if (!isRecord(value.nodes)) return "editor.blueprint.nodes must be an object.";
  const labels = isRecord(script) ? script : null;
  for (const [label, rawNode] of Object.entries(value.nodes)) {
    const nodePath = `editor.blueprint.nodes[${JSON.stringify(label)}]`;
    if (!isLabel(label)) return `${nodePath} must use a safe script label.`;
    if (labels === null || !hasOwn(labels, label)) return `${nodePath} must reference an existing script label.`;
    if (!isRecord(rawNode)) return `${nodePath} must be an object.`;
    const unknownNodeField = Object.keys(rawNode).find(key => key !== "kind" && key !== "title");
    if (unknownNodeField !== undefined) return `${nodePath}.${unknownNodeField} is not supported; routes belong in script instructions.`;
    if (typeof rawNode.kind !== "string" || !blueprintKinds.has(rawNode.kind as NovelBlueprintNodeKind)) {
      return `${nodePath}.kind must be entry, chapter, condition, choice, assignment, or end.`;
    }
    if (rawNode.title !== undefined && (typeof rawNode.title !== "string" || rawNode.title.length > maxTitleLength)) {
      return `${nodePath}.title must be a string of at most ${maxTitleLength} characters.`;
    }
  }
  return null;
}

function metadataIssueField(issue: string): string {
  return issue.match(/^editor\.blueprint(?:\.version|\.nodes(?:\[(?:"(?:\\.|[^"\\])*")\])?(?:\.(?:kind|title))?)/)?.[0] ?? "editor.blueprint";
}

/**
 * Add one executable script node and its display-only graph metadata. This
 * does not change `story.start`; consumers use their existing start controls.
 */
export function addNovelBlueprintNode(story: StoryDefinition, specValue: NovelBlueprintNodeSpec): StoryDefinition {
  const spec = assertSpec(specValue);
  if (!isRecord(story) || !isRecord(story.script)) throw new TypeError("story and story.script must be plain objects.");
  if (story.editor !== undefined && !isRecord(story.editor)) throw new TypeError("story.editor must be a plain object when present.");
  if (hasOwn(story.script, spec.label)) throw new TypeError(`Story label '${spec.label}' already exists.`);
  const currentBlueprint = story.editor?.blueprint;
  const metadataIssue = novelBlueprintMetadataIssue(currentBlueprint, story.script);
  if (metadataIssue !== null) throw new TypeError(metadataIssue);
  const script = { ...story.script, [spec.label]: generatedInstructions(spec, story.script) };
  const oldEditor = story.editor ?? {};
  const oldBlueprint = oldEditor.blueprint as NovelStoryBlueprintMetadata | undefined;
  const oldNodes = oldBlueprint?.nodes ?? {};
  const node: NovelBlueprintNodeMetadata = spec.title === undefined ? { kind: spec.kind } : { kind: spec.kind, title: spec.title };
  const blueprint: NovelStoryBlueprintMetadata = {
    version: 1,
    nodes: { ...oldNodes, [spec.label]: node },
  };
  return {
    ...story,
    script,
    editor: { ...oldEditor, blueprint },
  };
}

/** Return the metadata path for Editor diagnostics produced by the shared issue helper. */
export function novelBlueprintMetadataIssueField(issue: string): string {
  return metadataIssueField(issue);
}
