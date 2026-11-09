import type { StoryDefinition, StoryInstruction } from "./types.ts";

/** Source location for a line in the Pocket VN authoring text. Lines and columns are one based. */
export interface StoryTextLocation {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface StoryTextDiagnostic extends StoryTextLocation {
  readonly severity: "error";
  readonly code: "syntax" | "duplicate-label" | "unknown-opcode" | "story-header" | "instruction";
  readonly message: string;
}

export interface StoryTextSourceMap {
  readonly header: StoryTextLocation;
  readonly labels: Readonly<Record<string, StoryTextLocation>>;
  readonly instructions: Readonly<Record<string, readonly StoryTextLocation[]>>;
}

/** A parse error with a source location suitable for an editor diagnostic. */
export class StoryTextError extends Error {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly code: StoryTextDiagnostic["code"];

  constructor(message: string, location: StoryTextLocation, code: StoryTextDiagnostic["code"] = "syntax") {
    super(message);
    this.name = "StoryTextError";
    this.line = location.line;
    this.column = location.column;
    this.offset = location.offset;
    this.code = code;
  }
}

export interface StoryTextParseResult {
  readonly story: StoryDefinition | null;
  readonly diagnostics: readonly StoryTextDiagnostic[];
  readonly sourceMap?: StoryTextSourceMap;
}

const knownOpcodes = new Set([
  "say", "scene", "audio", "video", "wait", "set", "inc", "trade", "branch", "jump", "call", "return", "choice", "input", "ending",
]);
const bareLabel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function locationAt(source: string, line: number, lineStart: number, columnIndex: number): StoryTextLocation {
  return { line, column: columnIndex + 1, offset: lineStart + columnIndex };
}

function jsonParseErrorOffset(message: string): number | undefined {
  const position = message.match(/\bposition\s+(\d+)/i);
  if (position) return Number(position[1]);
  const lineColumn = message.match(/\bline\s+1\s+column\s+(\d+)/i);
  if (lineColumn) return Math.max(0, Number(lineColumn[1]) - 1);
  return undefined;
}

function parseLineJson(source: string, line: number, lineStart: number, start: number, end = source.length): unknown {
  const payload = source.slice(start, end);
  try { return JSON.parse(payload) as unknown; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const relativeOffset = jsonParseErrorOffset(message);
    // V8 includes an exact JSON offset. Engines that omit it still point to the
    // payload start, the narrowest useful location in this single-line format.
    const columnIndex = relativeOffset === undefined ? start : start + relativeOffset;
    throw new StoryTextError(`Invalid JSON payload: ${message}`, locationAt(source, line, lineStart, columnIndex));
  }
}

function readLineJson(source: string, line: number, lineStart: number, start: number): unknown {
  return parseLineJson(source, line, lineStart, start);
}

function errorDiagnostic(error: StoryTextError): StoryTextDiagnostic {
  return {
    severity: "error",
    code: error.code,
    message: error.message,
    line: error.line,
    column: error.column,
    offset: error.offset,
  };
}

function storyWithoutScript(story: StoryDefinition): Record<string, unknown> {
  if (!isRecord(story)) throw new TypeError("Story must be a JSON object.");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(story)) {
    if (key === "script") continue;
    assertJsonValue(value, `story.${key}`);
    output[key] = value;
  }
  return output;
}

function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is null | boolean | number | string | unknown[] | Record<string, unknown> {
  if (depth > 128) throw new TypeError(`${path} exceeds the supported JSON nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers.`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must contain only plain JSON data.`);
  }
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`, depth + 1);
}

function compactJson(value: unknown, path: string): string {
  assertJsonValue(value, path);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${path} could not be serialized as JSON.`);
  return serialized;
}

function encodeLabel(label: string): string {
  return bareLabel.test(label) ? label : JSON.stringify(label);
}

function parseQuotedLabel(line: string, lineNumber: number, lineStart: number, start: number): { readonly value: string; readonly end: number } {
  let end = start + 1;
  let escaped = false;
  while (end < line.length) {
    const character = line[end]!;
    if (!escaped && character === '"') { end++; break; }
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
    end++;
  }
  if (line[end - 1] !== '"') throw new StoryTextError("Unterminated JSON string label.", locationAt(line, lineNumber, lineStart, start));
  const parsed = parseLineJson(line, lineNumber, lineStart, start, end);
  if (typeof parsed !== "string") throw new StoryTextError("A quoted label must be a JSON string.", locationAt(line, lineNumber, lineStart, start));
  return { value: parsed, end };
}

/** Parse a Pocket VN authoring text document. Syntax errors always include their source line and column. */
export function parseStoryText(text: string): StoryTextParseResult {
  if (typeof text !== "string") {
    const error = new StoryTextError("Story text must be a string.", { line: 1, column: 1, offset: 0 });
    return { story: null, diagnostics: [errorDiagnostic(error)] };
  }
  const hadBom = text.startsWith("\uFEFF");
  const normalized = hadBom ? text.slice(1) : text;
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let lineStart = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] !== "\n" && normalized[index] !== "\r") continue;
    lines.push(normalized.slice(lineStart, index));
    lineStarts.push((hadBom ? 1 : 0) + lineStart);
    if (normalized[index] === "\r" && normalized[index + 1] === "\n") index++;
    lineStart = index + 1;
  }
  lines.push(normalized.slice(lineStart));
  lineStarts.push((hadBom ? 1 : 0) + lineStart);
  const script: Record<string, StoryInstruction[]> = Object.create(null) as Record<string, StoryInstruction[]>;
  const labelLocations: Record<string, StoryTextLocation> = Object.create(null) as Record<string, StoryTextLocation>;
  const instructionLocations: Record<string, StoryTextLocation[]> = Object.create(null) as Record<string, StoryTextLocation[]>;
  let header: Record<string, unknown> | undefined;
  let headerLocation: StoryTextLocation | undefined;
  let currentLabel: string | undefined;

  try {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const lineNumber = lineIndex + 1;
      const leading = line.length - line.trimStart().length;
      const content = line.slice(leading);
      if (!content || content.startsWith("#") || content.startsWith("//")) continue;

      if (content === "story" || content.startsWith("story ") || content.startsWith("story\t")) {
        if (header) throw new StoryTextError("A story header may appear only once.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "story-header");
        if (currentLabel !== undefined) throw new StoryTextError("The story header must come before all labels.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "story-header");
        const payloadStart = leading + "story".length;
        const parsed = readLineJson(line, lineNumber, lineStarts[lineIndex]!, payloadStart);
        if (!isRecord(parsed)) throw new StoryTextError("The story header must contain a JSON object.", locationAt(line, lineNumber, lineStarts[lineIndex]!, payloadStart), "story-header");
        if (Object.hasOwn(parsed, "script")) {
          const propertyColumn = line.indexOf('"script"', payloadStart);
          throw new StoryTextError("Do not put 'script' in the story header; label blocks define the script.", locationAt(line, lineNumber, lineStarts[lineIndex]!, propertyColumn >= 0 ? propertyColumn : payloadStart), "story-header");
        }
        header = parsed;
        headerLocation = locationAt(line, lineNumber, lineStarts[lineIndex]!, leading);
        continue;
      }

      if (content === "label" || content.startsWith("label ") || content.startsWith("label\t")) {
        if (!header) throw new StoryTextError("Add a 'story {...}' header before labels.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "story-header");
        let nameStart = leading + "label".length;
        while (line[nameStart] === " " || line[nameStart] === "\t") nameStart++;
        let label: string;
        let colon: number;
        if (line[nameStart] === '"') {
          const parsed = parseQuotedLabel(line, lineNumber, lineStarts[lineIndex]!, nameStart);
          label = parsed.value;
          colon = parsed.end;
          while (line[colon] === " " || line[colon] === "\t") colon++;
          if (line[colon] !== ":") throw new StoryTextError("Expected ':' after the label name.", locationAt(line, lineNumber, lineStarts[lineIndex]!, colon));
          colon++;
        } else {
          const match = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}/.exec(line.slice(nameStart));
          if (!match) throw new StoryTextError("Expected a label name or a quoted JSON string.", locationAt(line, lineNumber, lineStarts[lineIndex]!, nameStart));
          label = match[0];
          colon = nameStart + match[0].length;
          while (line[colon] === " " || line[colon] === "\t") colon++;
          if (line[colon] !== ":") throw new StoryTextError("Expected ':' after the label name.", locationAt(line, lineNumber, lineStarts[lineIndex]!, colon));
          colon++;
        }
        while (line[colon] === " " || line[colon] === "\t") colon++;
        if (colon !== line.length) throw new StoryTextError("A label declaration must end with ':'.", locationAt(line, lineNumber, lineStarts[lineIndex]!, colon));
        if (Object.hasOwn(script, label)) throw new StoryTextError(`Label ${JSON.stringify(label)} is declared more than once.`, locationAt(line, lineNumber, lineStarts[lineIndex]!, nameStart), "duplicate-label");
        script[label] = [];
        labelLocations[label] = locationAt(line, lineNumber, lineStarts[lineIndex]!, leading);
        instructionLocations[label] = [];
        currentLabel = label;
        continue;
      }

      if (!header) throw new StoryTextError("Add a 'story {...}' header before instructions.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "story-header");
      if (currentLabel === undefined) throw new StoryTextError("Instructions must be inside a label block.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "instruction");
      const opcodeMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(content);
      if (!opcodeMatch) throw new StoryTextError("Expected an instruction name.", locationAt(line, lineNumber, lineStarts[lineIndex]!, leading));
      const opcode = opcodeMatch[0];
      let payloadStart = leading + opcode.length;
      while (line[payloadStart] === " " || line[payloadStart] === "\t") payloadStart++;
      let instruction: Record<string, unknown>;
      if (opcode === "json") {
        const parsed = readLineJson(line, lineNumber, lineStarts[lineIndex]!, payloadStart);
        if (!isRecord(parsed) || typeof parsed.type !== "string" || parsed.type.length === 0) {
          throw new StoryTextError("'json' requires a complete instruction object with a string 'type' field.", locationAt(line, lineNumber, lineStarts[lineIndex]!, payloadStart), "instruction");
        }
        instruction = parsed;
      } else {
        if (!knownOpcodes.has(opcode)) {
          throw new StoryTextError(`Unknown instruction '${opcode}'. Use an engine-supported opcode or 'json { ... }' for an explicit data instruction.`, locationAt(line, lineNumber, lineStarts[lineIndex]!, leading), "unknown-opcode");
        }
        let payload: Record<string, unknown>;
        if (opcode === "return" && payloadStart >= line.length) payload = Object.create(null) as Record<string, unknown>;
        else {
          const parsed = readLineJson(line, lineNumber, lineStarts[lineIndex]!, payloadStart);
          if (!isRecord(parsed)) throw new StoryTextError(`'${opcode}' payload must be a JSON object.`, locationAt(line, lineNumber, lineStarts[lineIndex]!, payloadStart), "instruction");
          payload = parsed;
        }
        if (Object.hasOwn(payload, "type")) {
          const typeKeyColumn = line.indexOf('"type"', payloadStart);
          throw new StoryTextError(`'${opcode}' supplies the instruction type; remove the 'type' field from its payload.`, locationAt(line, lineNumber, lineStarts[lineIndex]!, typeKeyColumn >= 0 ? typeKeyColumn : payloadStart), "instruction");
        }
        instruction = { ...payload, type: opcode };
      }
      script[currentLabel]!.push(instruction as unknown as StoryInstruction);
      instructionLocations[currentLabel]!.push(locationAt(line, lineNumber, lineStarts[lineIndex]!, leading));
    }

    if (!header) throw new StoryTextError("A story document needs a 'story {...}' header.", { line: 1, column: 1, offset: 0 }, "story-header");
    const story = { ...header, script: Object.fromEntries(Object.entries(script)) } as unknown as StoryDefinition;
    return {
      story,
      diagnostics: [],
      sourceMap: { header: headerLocation!, labels: labelLocations, instructions: instructionLocations },
    };
  } catch (error) {
    const authoringError = error instanceof StoryTextError
      ? error
      : new StoryTextError(error instanceof Error ? error.message : String(error), { line: 1, column: 1, offset: 0 });
    return { story: null, diagnostics: [errorDiagnostic(authoringError)] };
  }
}

/** Serialize the same StoryDefinition edited by the block view into Pocket VN text. */
export function formatStoryText(story: StoryDefinition): string {
  if (!isRecord(story) || !isRecord(story.script)) throw new TypeError("Story must have an object script.");
  const header = storyWithoutScript(story);
  const lines = ["# Pocket VN authoring v1", `story ${compactJson(header, "story header")}`, ""];
  for (const [label, rawInstructions] of Object.entries(story.script)) {
    if (!Array.isArray(rawInstructions)) throw new TypeError(`story.script.${label} must be an instruction array.`);
    lines.push(`label ${encodeLabel(label)}:`);
    for (const [index, raw] of rawInstructions.entries()) {
      if (!isRecord(raw) || typeof raw.type !== "string" || raw.type.length === 0) {
        throw new TypeError(`story.script.${label}[${index}] must be an instruction object with a string type.`);
      }
      if (knownOpcodes.has(raw.type)) {
        const payload: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, value] of Object.entries(raw)) {
          if (key === "type") continue;
          assertJsonValue(value, `story.script.${label}[${index}].${key}`);
          payload[key] = value;
        }
        lines.push(`  ${raw.type} ${compactJson(payload, `story.script.${label}[${index}] payload`)}`);
      } else {
        lines.push(`  json ${compactJson(raw, `story.script.${label}[${index}]`)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
