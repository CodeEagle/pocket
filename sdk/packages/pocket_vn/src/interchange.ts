import { formatStoryText, parseStoryText } from "./authoring.ts";
import type { StoryDefinition, StoryInstruction } from "./types.ts";

const FORMAT_VERSION = "1";
const CSV_FORMAT_ID = "pocket-vn-csv";
const TABLE_CSV_VERSION = "2";
const MARKDOWN_MARKER = "<!-- pocket-vn-interchange:markdown:1 -->";
const CSV_HEADER = ["record", "label", "index", "type", "payload"] as const;
const TABLE_CSV_HEADER = ["record", "label", "index", "type", "id", "speaker", "text", "target", "asset", "parameters", "present"] as const;
const TABLE_CSV_COLUMNS = ["id", "speaker", "text", "target", "asset"] as const;
const FENCE = String.fromCharCode(96, 96, 96);
const MAX_INTERCHANGE_BYTES = 8 * 1024 * 1024;
const MAX_CSV_RECORDS = 110_003;
const MAX_MARKDOWN_LINES = 250_000;
const MAX_LABELS = 10_000;
const MAX_INSTRUCTIONS_PER_LABEL = 20_000;
const MAX_TOTAL_INSTRUCTIONS = 100_000;

export type StoryInterchangeDiagnosticCode = "syntax" | "schema" | "duplicate" | "conflict" | "limit";

export interface StoryInterchangeDiagnostic {
  readonly severity: "error";
  readonly code: StoryInterchangeDiagnosticCode;
  readonly message: string;
  readonly row?: number;
  readonly column?: number;
}

export interface StoryInterchangeParseResult {
  readonly story: StoryDefinition | null;
  readonly diagnostics: readonly StoryInterchangeDiagnostic[];
}

interface CsvRecord {
  readonly cells: readonly string[];
  readonly row: number;
}

class InterchangeFailure extends Error {
  constructor(
    message: string,
    readonly code: StoryInterchangeDiagnosticCode = "schema",
    readonly row?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "InterchangeFailure";
  }
}

function fail(message: string, code: StoryInterchangeDiagnosticCode = "schema", row?: number, column?: number): never {
  throw new InterchangeFailure(message, code, row, column);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8Length(value: string): number {
  // The pinned QuickJS runtime intentionally omits Web TextEncoder. Count the
  // bytes directly so this format's size limit behaves the same in Guest and
  // native JS hosts. Lone UTF-16 surrogates are encoded as U+FFFD (three bytes).
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index)!;
    if (code > 0xffff) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 3;
    } else if (code < 0x80) {
      bytes++;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function checkSize(value: string): void {
  if (value.length > MAX_INTERCHANGE_BYTES || utf8Length(value) > MAX_INTERCHANGE_BYTES) {
    fail("Interchange files are limited to " + MAX_INTERCHANGE_BYTES + " UTF-8 bytes.", "limit");
  }
}

function parseResult(error: unknown): StoryInterchangeParseResult {
  if (error instanceof InterchangeFailure) {
    return {
      story: null,
      diagnostics: [{
        severity: "error",
        code: error.code,
        message: error.message,
        ...(error.row === undefined ? {} : { row: error.row }),
        ...(error.column === undefined ? {} : { column: error.column }),
      }],
    };
  }
  return {
    story: null,
    diagnostics: [{
      severity: "error",
      code: "schema",
      message: error instanceof Error ? error.message : String(error),
    }],
  };
}

function canonicalStory(story: StoryDefinition): StoryDefinition {
  const source = formatStoryText(story);
  const parsed = parseStoryText(source);
  if (!parsed.story || parsed.diagnostics.length > 0) {
    throw new TypeError(parsed.diagnostics[0]?.message ?? "Story could not be normalized by the existing authoring parser.");
  }
  const labelCount = Object.keys(parsed.story.script).length;
  if (labelCount > MAX_LABELS) fail("Story exceeds the " + MAX_LABELS + "-label interchange limit.", "limit");
  let totalInstructions = 0;
  for (const [label, instructions] of Object.entries(parsed.story.script)) {
    if (instructions.length > MAX_INSTRUCTIONS_PER_LABEL) {
      fail("Label " + JSON.stringify(label) + " exceeds the " + MAX_INSTRUCTIONS_PER_LABEL + "-instruction interchange limit.", "limit");
    }
    totalInstructions += instructions.length;
    if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) {
      fail("Story exceeds the " + MAX_TOTAL_INSTRUCTIONS + "-instruction interchange limit.", "limit");
    }
  }
  return parsed.story;
}

function storyMetadata(story: StoryDefinition): Record<string, unknown> {
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(story)) if (key !== "script") metadata[key] = value;
  return metadata;
}

function jsonText(value: unknown, context: string, pretty = false): string {
  try {
    const text = JSON.stringify(value, null, pretty ? 2 : undefined);
    if (text === undefined) throw new TypeError("value is not JSON serializable");
    return text;
  } catch (error) {
    throw new TypeError(context + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

function formatCsvRecord(cells: readonly string[]): string {
  return cells.map(quoteCsv).join(",");
}

function blankTableCells(): string[] {
  return Array.from({ length: TABLE_CSV_HEADER.length }, () => "");
}

/** Export a lossless CSV envelope. Payload cells contain canonical JSON objects. */
export function formatStoryCsv(input: StoryDefinition): string {
  const story = canonicalStory(input);
  const rows: string[] = [
    formatCsvRecord(CSV_HEADER),
    formatCsvRecord(["format", CSV_FORMAT_ID, FORMAT_VERSION, "", ""]),
    formatCsvRecord(["document", "", "", "", jsonText(storyMetadata(story), "story metadata")]),
  ];
  for (const [label, instructions] of Object.entries(story.script)) {
    rows.push(formatCsvRecord(["label", label, "", "", ""]));
    for (const [index, instruction] of instructions.entries()) {
      rows.push(formatCsvRecord([
        "instruction",
        label,
        String(index),
        instruction.type,
        jsonText(instruction, "instruction " + label + "[" + index + "]"),
      ]));
    }
  }
  const output = rows.join("\r\n") + "\r\n";
  checkSize(output);
  return output;
}

function tableFieldForColumn(type: string, column: typeof TABLE_CSV_COLUMNS[number]): string {
  if (column !== "asset") return column;
  switch (type) {
    case "say": return "portrait";
    case "scene": return "background";
    case "ending": return "cg";
    case "audio":
    case "video": return "cue";
    default: return "asset";
  }
}

/**
 * Export an editor-friendly, lossless table CSV v2. Common string fields are
 * promoted to columns; all remaining instruction data stays in parameters.
 */
export function formatStoryTableCsv(input: StoryDefinition): string {
  const story = canonicalStory(input);
  const rows: string[] = [
    formatCsvRecord(TABLE_CSV_HEADER),
    formatCsvRecord(["format", CSV_FORMAT_ID, TABLE_CSV_VERSION, ...Array.from({ length: TABLE_CSV_HEADER.length - 3 }, () => "")]),
  ];
  const document = blankTableCells();
  document[0] = "document";
  document[9] = jsonText(storyMetadata(story), "story metadata");
  rows.push(formatCsvRecord(document));

  for (const [label, instructions] of Object.entries(story.script)) {
    const labelRow = blankTableCells();
    labelRow[0] = "label";
    labelRow[1] = label;
    rows.push(formatCsvRecord(labelRow));
    for (const [index, instruction] of instructions.entries()) {
      const row = blankTableCells();
      row[0] = "instruction";
      row[1] = label;
      row[2] = String(index);
      row[3] = instruction.type;
      const parameters: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const present: string[] = [];
      for (const [columnIndex, column] of TABLE_CSV_COLUMNS.entries()) {
        const key = tableFieldForColumn(instruction.type, column);
        if (!Object.hasOwn(instruction, key)) continue;
        const value = (instruction as unknown as Record<string, unknown>)[key];
        if (typeof value !== "string") {
          parameters[key] = value;
          continue;
        }
        row[4 + columnIndex] = value;
        present.push(column);
      }
      for (const [key, value] of Object.entries(instruction)) {
        if (key === "type" || TABLE_CSV_COLUMNS.some(column => key === tableFieldForColumn(instruction.type, column))) continue;
        parameters[key] = value;
      }
      row[9] = jsonText(parameters, "instruction parameters " + label + "[" + index + "]");
      row[10] = jsonText(present, "instruction field presence " + label + "[" + index + "]");
      rows.push(formatCsvRecord(row));
    }
  }
  const output = rows.join("\r\n") + "\r\n";
  checkSize(output);
  return output;
}

function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let rowCells: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let column = 1;
  let rowStart = 1;
  const pushField = (): void => {
    rowCells.push(field);
    if (rowCells.length > TABLE_CSV_HEADER.length) fail("CSV record has more than " + TABLE_CSV_HEADER.length + " columns.", "schema", line, column);
    field = "";
    afterQuote = false;
  };
  const pushRecord = (): void => {
    pushField();
    records.push({ cells: rowCells, row: rowStart });
    if (records.length > MAX_CSV_RECORDS) fail("CSV exceeds the record limit.", "limit", line, column);
    rowCells = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
          column += 2;
        } else {
          inQuotes = false;
          afterQuote = true;
          column++;
        }
        continue;
      }
      field += character;
      if (character === "\r" && text[index + 1] === "\n") {
        field += "\n";
        index++;
        line++;
        column = 1;
      } else if (character === "\r" || character === "\n") {
        line++;
        column = 1;
      } else column++;
      continue;
    }
    if (afterQuote) {
      if (character === ",") {
        pushField();
        column++;
        continue;
      }
      if (character === "\r" || character === "\n") {
        pushRecord();
        if (character === "\r" && text[index + 1] === "\n") index++;
        line++;
        column = 1;
        rowStart = line;
        continue;
      }
      fail("Only a comma or record ending may follow a quoted CSV field.", "syntax", line, column);
    }
    if (character === '"') {
      if (field.length !== 0) fail("A CSV quote must begin a field.", "syntax", line, column);
      inQuotes = true;
      column++;
    } else if (character === ",") {
      pushField();
      column++;
    } else if (character === "\r" || character === "\n") {
      pushRecord();
      if (character === "\r" && text[index + 1] === "\n") index++;
      line++;
      column = 1;
      rowStart = line;
    } else {
      field += character;
      column++;
    }
  }
  if (inQuotes) fail("CSV ends inside a quoted field.", "syntax", line, column);
  if (rowCells.length > 0 || field.length > 0 || afterQuote) {
    pushField();
    records.push({ cells: rowCells, row: rowStart });
    if (records.length > MAX_CSV_RECORDS) fail("CSV exceeds the record limit.", "limit", line, column);
  }
  return records;
}

function parseJsonCell(text: string, row: number, context: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) {
    fail("Invalid JSON in " + context + ": " + (error instanceof Error ? error.message : String(error)), "syntax", row);
  }
}

function expectCells(record: CsvRecord, values: readonly string[], rowKind: string): void {
  if (record.cells.length !== values.length || record.cells.some((value, index) => value !== values[index])) {
    fail("CSV row " + rowKind + " has an invalid shape.", "schema", record.row);
  }
}

function instructionPayload(value: unknown, row?: number): StoryInstruction {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) {
    fail("Instruction payload must be a JSON object with a non-empty string type.", "schema", row);
  }
  return value as unknown as StoryInstruction;
}

function storyFromParts(
  metadata: unknown,
  labels: readonly string[],
  groups: ReadonlyMap<string, ReadonlyMap<number, StoryInstruction>>,
): StoryDefinition {
  if (!isRecord(metadata) || Object.hasOwn(metadata, "script")) fail("Document metadata must be an object without a script field.");
  if (labels.length > MAX_LABELS) fail("Story exceeds the " + MAX_LABELS + "-label interchange limit.", "limit");
  const script: Record<string, StoryInstruction[]> = Object.create(null) as Record<string, StoryInstruction[]>;
  let totalInstructions = 0;
  for (const label of labels) {
    const entries = groups.get(label) ?? new Map<number, StoryInstruction>();
    if (entries.size > MAX_INSTRUCTIONS_PER_LABEL) {
      fail("Label " + JSON.stringify(label) + " exceeds the per-label instruction limit.", "limit");
    }
    const instructions: StoryInstruction[] = [];
    for (let index = 0; index < entries.size; index++) {
      const instruction = entries.get(index);
      if (!instruction) fail("Label " + JSON.stringify(label) + " has a missing instruction index " + index + ".", "conflict");
      instructions.push(instruction);
    }
    totalInstructions += instructions.length;
    if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) fail("Story exceeds the total instruction limit.", "limit");
    script[label] = instructions;
  }
  for (const label of groups.keys()) {
    if (!labels.includes(label)) fail("Instruction rows refer to undeclared label " + JSON.stringify(label) + ".", "conflict");
  }
  const candidate = Object.assign(Object.create(null) as Record<string, unknown>, metadata, { script }) as unknown as StoryDefinition;
  return canonicalStory(candidate);
}

function parseCsvV1Records(records: readonly CsvRecord[]): StoryDefinition {
  if (records.length < 3) fail("CSV must contain a header, format row and document row.", "schema");
  expectCells(records[0]!, CSV_HEADER, "header");
  expectCells(records[1]!, ["format", CSV_FORMAT_ID, FORMAT_VERSION, "", ""], "format");
  const document = records[2]!;
  if (document.cells.length !== 5 || document.cells[0] !== "document" ||
      document.cells[1] !== "" || document.cells[2] !== "" || document.cells[3] !== "") {
    fail("CSV must begin with exactly one document metadata row.", "schema", document.row);
  }
  const metadata = parseJsonCell(document.cells[4]!, document.row, "document metadata");
  if (!isRecord(metadata) || Object.hasOwn(metadata, "script")) {
    fail("Document metadata must be an object without a script field.", "schema", document.row);
  }

  const labels: string[] = [];
  const labelSet = new Set<string>();
  const groups = new Map<string, Map<number, StoryInstruction>>();
  let totalInstructions = 0;
  for (const record of records.slice(3)) {
    if (record.cells.length !== 5) fail("CSV data rows must have exactly five columns.", "schema", record.row);
    const [kind, label, indexText, type, payload] = record.cells as readonly [string, string, string, string, string];
    if (kind === "label") {
      if (indexText !== "" || type !== "" || payload !== "") fail("Label rows must leave index, type and payload blank.", "schema", record.row);
      if (labelSet.has(label)) fail("Label " + JSON.stringify(label) + " is declared more than once.", "duplicate", record.row);
      labelSet.add(label);
      labels.push(label);
      groups.set(label, new Map());
      if (labels.length > MAX_LABELS) fail("CSV exceeds the label limit.", "limit", record.row);
      continue;
    }
    if (kind === "instruction") {
      if (!labelSet.has(label)) fail("Instruction row refers to undeclared label " + JSON.stringify(label) + ".", "conflict", record.row);
      if (!/^(0|[1-9][0-9]*)$/.test(indexText)) fail("Instruction index must be a canonical non-negative integer.", "schema", record.row);
      const index = Number(indexText);
      if (!Number.isSafeInteger(index) || index >= MAX_INSTRUCTIONS_PER_LABEL) fail("Instruction index exceeds the per-label limit.", "limit", record.row);
      if (!type) fail("Instruction type column must be non-empty.", "schema", record.row);
      const instruction = instructionPayload(parseJsonCell(payload, record.row, "instruction payload"), record.row);
      if (instruction.type !== type) fail("Instruction type column conflicts with the payload type.", "conflict", record.row);
      const entries = groups.get(label)!;
      if (entries.has(index)) fail("Instruction index " + index + " is duplicated for label " + JSON.stringify(label) + ".", "duplicate", record.row);
      entries.set(index, instruction);
      totalInstructions++;
      if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) fail("CSV exceeds the total instruction limit.", "limit", record.row);
      continue;
    }
    fail("Unknown CSV record type " + JSON.stringify(kind) + ".", "schema", record.row);
  }
  return storyFromParts(metadata, labels, groups);
}

function parseCsvV2Records(records: readonly CsvRecord[]): StoryDefinition {
  if (records.length < 3) fail("CSV v2 must contain a header, format row and document row.", "schema");
  expectCells(records[0]!, TABLE_CSV_HEADER, "header");
  expectCells(records[1]!, ["format", CSV_FORMAT_ID, TABLE_CSV_VERSION, ...Array.from({ length: TABLE_CSV_HEADER.length - 3 }, () => "")], "format");
  const document = records[2]!;
  if (document.cells.length !== TABLE_CSV_HEADER.length || document.cells[0] !== "document" ||
      document.cells.slice(1, 9).some(value => value !== "") || document.cells[10] !== "") {
    fail("CSV v2 must begin with exactly one document metadata row.", "schema", document.row);
  }
  const metadata = parseJsonCell(document.cells[9]!, document.row, "document metadata");
  if (!isRecord(metadata) || Object.hasOwn(metadata, "script")) {
    fail("Document metadata must be an object without a script field.", "schema", document.row);
  }

  const labels: string[] = [];
  const labelSet = new Set<string>();
  const groups = new Map<string, Map<number, StoryInstruction>>();
  let totalInstructions = 0;
  for (const record of records.slice(3)) {
    if (record.cells.length !== TABLE_CSV_HEADER.length) fail("CSV v2 data rows must have exactly eleven columns.", "schema", record.row);
    const [kind, label, indexText, type, id, speaker, text, target, asset, parametersText, presentText] = record.cells;
    if (kind === "label") {
      if (record.cells.slice(2).some(value => value !== "")) fail("Label rows must leave instruction columns blank.", "schema", record.row);
      if (labelSet.has(label!)) fail("Label " + JSON.stringify(label) + " is declared more than once.", "duplicate", record.row);
      labelSet.add(label!);
      labels.push(label!);
      groups.set(label!, new Map());
      if (labels.length > MAX_LABELS) fail("CSV exceeds the label limit.", "limit", record.row);
      continue;
    }
    if (kind !== "instruction") fail("Unknown CSV record type " + JSON.stringify(kind) + ".", "schema", record.row);
    if (!labelSet.has(label!)) fail("Instruction row refers to undeclared label " + JSON.stringify(label) + ".", "conflict", record.row);
    if (!/^(0|[1-9][0-9]*)$/.test(indexText!)) fail("Instruction index must be a canonical non-negative integer.", "schema", record.row);
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index >= MAX_INSTRUCTIONS_PER_LABEL) fail("Instruction index exceeds the per-label limit.", "limit", record.row);
    if (!type) fail("Instruction type column must be non-empty.", "schema", record.row);

    const rawParameters = parseJsonCell(parametersText!, record.row, "instruction parameters");
    if (!isRecord(rawParameters) || Object.hasOwn(rawParameters, "type")) {
      fail("Instruction parameters must be an object without a type field.", "schema", record.row);
    }
    const rawPresence = parseJsonCell(presentText!, record.row, "instruction field presence");
    if (!Array.isArray(rawPresence) || rawPresence.some(value => typeof value !== "string" || !(TABLE_CSV_COLUMNS as readonly string[]).includes(value))) {
      fail("Instruction field presence must be an array of promoted column names.", "schema", record.row);
    }
    const present = new Set<string>();
    for (const value of rawPresence) {
      if (present.has(value)) fail("Instruction field presence contains a duplicate column.", "duplicate", record.row);
      present.add(value);
    }

    const cells = [id!, speaker!, text!, target!, asset!];
    const instruction = Object.assign(Object.create(null) as Record<string, unknown>, rawParameters);
    for (const [columnIndex, column] of TABLE_CSV_COLUMNS.entries()) {
      const key = tableFieldForColumn(type!, column);
      const cell = cells[columnIndex]!;
      const hasParameter = Object.hasOwn(rawParameters, key);
      const isPresent = present.has(column);
      if (isPresent || cell !== "") {
        if (hasParameter) fail("Promoted column " + column + " conflicts with the same field in parameters.", "conflict", record.row);
        instruction[key] = cell;
      } else if (hasParameter && typeof rawParameters[key] === "string") {
        fail("String field " + JSON.stringify(key) + " must be stored in its promoted column.", "conflict", record.row);
      }
    }
    instruction.type = type;
    const normalized = instructionPayload(instruction, record.row);
    const entries = groups.get(label!)!;
    if (entries.has(index)) fail("Instruction index " + index + " is duplicated for label " + JSON.stringify(label) + ".", "duplicate", record.row);
    entries.set(index, normalized);
    totalInstructions++;
    if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) fail("CSV exceeds the total instruction limit.", "limit", record.row);
  }
  return storyFromParts(metadata, labels, groups);
}

function parseCsv(input: string, required: "any" | "table"): StoryInterchangeParseResult {
  try {
    if (typeof input !== "string") fail("CSV input must be a string.", "schema");
    checkSize(input);
    const records = parseCsvRecords(input);
    if (records.length === 0) fail("CSV is missing its header.", "schema");
    const header = records[0]!.cells;
    const isV1 = header.length === CSV_HEADER.length && header.every((value, index) => value === CSV_HEADER[index]);
    const isV2 = header.length === TABLE_CSV_HEADER.length && header.every((value, index) => value === TABLE_CSV_HEADER[index]);
    if (required === "table" && !isV2) fail("Expected the friendly CSV v2 table header.", "schema", records[0]!.row);
    if (!isV1 && !isV2) fail("CSV header does not match a supported Pocket VN interchange format.", "schema", records[0]!.row);
    const story = isV2 ? parseCsvV2Records(records) : parseCsvV1Records(records);
    return { story, diagnostics: [] };
  } catch (error) {
    return parseResult(error);
  }
}

/** Import CSV v1 or the friendly table CSV v2. A malformed row rejects the full import. */
export function parseStoryCsv(input: string): StoryInterchangeParseResult {
  return parseCsv(input, "any");
}

/** Import only the friendly table CSV v2 format. */
export function parseStoryTableCsv(input: string): StoryInterchangeParseResult {
  return parseCsv(input, "table");
}

/** Export a readable Markdown outline whose JSON blocks are the authoritative data. */
export function formatStoryMarkdown(input: StoryDefinition): string {
  const story = canonicalStory(input);
  const lines = [
    "# Pocket VN Markdown interchange v1",
    MARKDOWN_MARKER,
    "",
    "## Document metadata",
    FENCE + "json",
    jsonText(storyMetadata(story), "story metadata", true),
    FENCE,
    "",
    "## Script",
  ];
  for (const [index, [label, instructions]] of Object.entries(story.script).entries()) {
    lines.push(
      "",
      "### Label " + (index + 1),
      FENCE + "json",
      jsonText({ label, instructions }, "label " + JSON.stringify(label), true),
      FENCE,
    );
  }
  const output = lines.join("\n") + "\n";
  checkSize(output);
  return output;
}

function parseMarkdownJsonBlock(lines: readonly string[], cursor: { value: number }, context: string): unknown {
  if (lines[cursor.value] !== FENCE + "json") fail("Expected a fenced JSON block for " + context + ".", "schema", cursor.value + 1);
  const startLine = cursor.value + 1;
  cursor.value++;
  const payload: string[] = [];
  while (cursor.value < lines.length && lines[cursor.value] !== FENCE) {
    payload.push(lines[cursor.value]!);
    cursor.value++;
  }
  if (cursor.value >= lines.length) fail("Unclosed JSON block for " + context + ".", "syntax", startLine);
  cursor.value++;
  return parseJsonCell(payload.join("\n"), startLine, context);
}

function skipBlankLines(lines: readonly string[], cursor: { value: number }): void {
  while (cursor.value < lines.length && lines[cursor.value]!.trim() === "") cursor.value++;
}

/** Import the strict Markdown v1 outline. Prose-only Markdown is not a story interchange file. */
export function parseStoryMarkdown(input: string): StoryInterchangeParseResult {
  try {
    if (typeof input !== "string") fail("Markdown input must be a string.", "schema");
    checkSize(input);
    const withoutBom = input.startsWith("\uFEFF") ? input.slice(1) : input;
    let lineCount = 1;
    for (let index = 0; index < withoutBom.length; index++) {
      if (withoutBom[index] === "\n" || withoutBom[index] === "\r") {
        lineCount++;
        if (withoutBom[index] === "\r" && withoutBom[index + 1] === "\n") index++;
        if (lineCount > MAX_MARKDOWN_LINES) fail("Markdown exceeds the line limit.", "limit");
      }
    }
    const lines = withoutBom.replace(/\r\n?/g, "\n").split("\n");
    const cursor = { value: 0 };
    const expectLine = (expected: string): void => {
      if (lines[cursor.value] !== expected) fail("Expected " + JSON.stringify(expected) + ".", "schema", cursor.value + 1);
      cursor.value++;
    };
    expectLine("# Pocket VN Markdown interchange v1");
    expectLine(MARKDOWN_MARKER);
    skipBlankLines(lines, cursor);
    expectLine("## Document metadata");
    const metadata = parseMarkdownJsonBlock(lines, cursor, "document metadata");
    if (!isRecord(metadata) || Object.hasOwn(metadata, "script")) {
      fail("Document metadata must be an object without a script field.", "schema", cursor.value);
    }
    skipBlankLines(lines, cursor);
    expectLine("## Script");

    const labels: string[] = [];
    const labelSet = new Set<string>();
    const groups = new Map<string, Map<number, StoryInstruction>>();
    let totalInstructions = 0;
    for (;;) {
      skipBlankLines(lines, cursor);
      if (cursor.value >= lines.length) break;
      const heading = lines[cursor.value]!;
      const match = /^### Label ([1-9][0-9]*)$/.exec(heading);
      if (!match) fail("Expected a numbered label heading.", "schema", cursor.value + 1);
      const ordinal = labels.length + 1;
      if (Number(match[1]) !== ordinal) fail("Markdown label headings must be numbered in order.", "conflict", cursor.value + 1);
      cursor.value++;
      const block = parseMarkdownJsonBlock(lines, cursor, "label " + ordinal);
      if (!isRecord(block) || Object.keys(block).sort().join(",") !== "instructions,label" ||
          typeof block.label !== "string" || !Array.isArray(block.instructions)) {
        fail("Label block must contain only a string label and an instruction array.", "schema", cursor.value);
      }
      const label = block.label;
      if (labelSet.has(label)) fail("Label " + JSON.stringify(label) + " is declared more than once.", "duplicate", cursor.value);
      if (block.instructions.length > MAX_INSTRUCTIONS_PER_LABEL) fail("Label block exceeds the per-label instruction limit.", "limit", cursor.value);
      const entries = new Map<number, StoryInstruction>();
      block.instructions.forEach((value, index) => entries.set(index, instructionPayload(value, cursor.value)));
      totalInstructions += entries.size;
      if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) fail("Markdown exceeds the total instruction limit.", "limit", cursor.value);
      labelSet.add(label);
      labels.push(label);
      groups.set(label, entries);
      if (labels.length > MAX_LABELS) fail("Markdown exceeds the label limit.", "limit", cursor.value);
    }
    return { story: storyFromParts(metadata, labels, groups), diagnostics: [] };
  } catch (error) {
    return parseResult(error);
  }
}
