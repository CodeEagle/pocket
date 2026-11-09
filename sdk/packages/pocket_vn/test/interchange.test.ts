import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { formatStoryText, parseStoryText } from "../src/authoring.ts";
import {
  formatStoryCsv,
  formatStoryMarkdown,
  formatStoryTableCsv,
  parseStoryCsv,
  parseStoryMarkdown,
  parseStoryTableCsv,
} from "../src/interchange.ts";
import type { StoryDefinition } from "../src/types.ts";

const startLabel = "opening,\r\n\"day\"";

const supportedStory = {
  id: "harbor.chapter-one",
  version: 4,
  start: startLabel,
  title: "The Bell at Low Tide 🌊",
  customMetadata: { editor: "screenplay", note: "comma, quote \" and newline\nkept" },
  variableDefinitions: {
    visits: { lifetime: "save", defaultValue: 0, sourceNote: { createdBy: "author" } },
  },
  script: {
    [startLabel]: [
      {
        type: "say", id: "arrive", speaker: "Mira", portrait: "mira", voice: "arrival",
        text: "The tide is falling.\nLook: \"north\", then west.",
        extensions: { screenplay: { beat: 2, tags: ["unicode", "海"] } },
      },
      {
        type: "scene", background: "harbor", characters: [
          { id: "mira", expression: "worried", position: { x: 24, y: 90 }, scale: 1.25, rotation: -4, layer: 2, visible: true },
        ],
        transition: { kind: "dissolve", durationMs: 450 }, remove: [], sceneNotes: { lens: "35mm" },
      },
      { type: "audio", cue: "harbor-wind", action: "play", channel: "ambience", loop: true, mix: { gain: 0.7 } },
      { type: "wait", durationMs: 25 },
      { type: "set", variable: "visits", value: 1 },
      { type: "inc", variable: "visits", amount: 1 },
      { type: "branch", when: { op: "truthy", value: { type: "literal", value: true } }, then: "route", else: "ending" },
      { type: "jump", target: "ending" },
      { type: "call", target: "helper" },
      {
        type: "choice", id: "harbor-route", prompt: "Where should we go?",
        options: [
          { id: "street", text: "Follow the gulls", target: "route", when: { op: "falsy", value: { type: "literal", value: false } }, note: "primary" },
          { id: "wharf", text: "Take the key", target: "ending" },
        ],
        timeLimitMs: 3000, timeoutTarget: "ending", extensions: ["kept"],
      },
      {
        type: "input", id: "captain-name", variable: "captain.name", inputType: "text",
        prompt: "Who should we find?", placeholder: "Name", minLength: 1, maxLength: 40, cancelTarget: "ending",
        authorNote: { source: "script" },
      },
      { type: "input", id: "tide-height", variable: "tide.height", inputType: "number", min: -4.5, max: 8, integer: false },
      { type: "input", id: "consent", variable: "consent", inputType: "boolean", defaultValue: false },
      { type: "ending", id: "end", text: "The bell is silent.", cg: "harbor-dawn", credits: ["Mira", "海"] },
    ],
    route: [{ type: "ending", id: "route-end" }],
    helper: [{ type: "return" }],
    ending: [{ type: "ending", id: "alternate-ending" }],
  },
} as unknown as StoryDefinition;

const simpleStory: StoryDefinition = {
  id: "simple.interchange",
  version: 1,
  start: "start",
  script: {
    start: [{ type: "say", id: "line", text: "Hello, 世界." }],
    ending: [{ type: "ending", id: "end" }],
  },
};

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function csvRecord(cells: readonly string[]): string {
  return cells.map(value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join(",");
}

test("CSV v1 round-trips every supported instruction, custom JSON and Unicode labels", () => {
  const csv = formatStoryCsv(supportedStory);
  expect(csv.startsWith("record,label,index,type,payload\r\n")).toBe(true);
  const imported = parseStoryCsv("\uFEFF" + csv);
  expect(imported.diagnostics).toEqual([]);
  expect(jsonValue(imported.story)).toEqual(jsonValue(supportedStory));

  const engine = createNovelEngine(imported.story!);
  engine.dispose();
});

test("friendly CSV v2 promotes common fields and round-trips metadata, ordering and nested extensions", () => {
  const tableStory = {
    ...simpleStory,
    emptyLabelExtension: { empty: "", nullable: null, enabled: false },
    script: {
      "": [],
      [startLabel]: [
        { type: "say", id: "absent-speaker", text: "第一句，带逗号、引号\"和\n换行。", voice: "harbor.voice" },
        { type: "say", id: "empty-fields", speaker: "", text: "", portrait: "", extension: { note: "nested, value" } },
        { type: "scene", background: null, camera: { x: 0, y: 3, scale: 1 }, custom: ["keep", { nested: true }] },
        {
          type: "choice", id: "choice", prompt: "Pick one", options: [
            { id: "one", text: "One, \"first\"", target: "next", when: { op: "truthy", value: { type: "literal", value: true } }, customOption: { rank: 1 } },
            { id: "two", text: "Two", target: "end" },
          ], customInstruction: null,
        },
        { type: "future.fx", id: "future", target: "next", asset: "future.asset", text: "unknown stays data", extension: { ok: true } },
      ],
      next: [{ type: "ending", id: "end", cg: "sunrise" }],
      unusedLabel: [],
    },
  } as unknown as StoryDefinition;
  const csv = formatStoryTableCsv(tableStory);
  expect(csv.startsWith("record,label,index,type,id,speaker,text,target,asset,parameters,present\r\n")).toBe(true);
  expect(csv).toContain("format,pocket-vn-csv,2,,,,,,,,\r\n");

  const imported = parseStoryCsv("\uFEFF" + csv);
  const tableImported = parseStoryTableCsv(csv);
  expect(imported.diagnostics).toEqual([]);
  expect(tableImported.diagnostics).toEqual([]);
  expect(jsonValue(imported.story)).toEqual(jsonValue(tableStory));
  expect(jsonValue(tableImported.story)).toEqual(jsonValue(tableStory));
  expect(parseStoryTableCsv(formatStoryCsv(simpleStory)).diagnostics[0]?.code).toBe("schema");

  const allInstructions = {
    ...supportedStory,
    script: {
      ...supportedStory.script,
      route: [
        ...supportedStory.script.route!,
        { type: "trade", item: "lantern", action: "buy", quantity: 2, onFailure: "ending", extension: { audit: true } },
        { type: "video", action: "play", cue: "harbor-loop", loop: true },
        { type: "video", action: "seek", positionMs: 1234 },
        { type: "video", action: "pause" },
        { type: "video", action: "close" },
      ],
    },
  } as unknown as StoryDefinition;
  const allInstructionsResult = parseStoryTableCsv(formatStoryTableCsv(allInstructions));
  expect(allInstructionsResult.diagnostics).toEqual([]);
  expect(jsonValue(allInstructionsResult.story)).toEqual(jsonValue(allInstructions));
});

test("friendly CSV v2 distinguishes absent, present-empty and newly typed promoted fields", () => {
  const story: StoryDefinition = {
    ...simpleStory,
    script: {
      start: [
        { type: "say", id: "absent", text: "Visible" },
        { type: "say", id: "empty", speaker: "", text: "" },
      ],
    },
  };
  const csv = formatStoryTableCsv(story);
  expect(csv).toContain(csvRecord(["instruction", "start", "0", "say", "absent", "", "Visible", "", "", "{}", '["id","text"]']));
  expect(csv).toContain(csvRecord(["instruction", "start", "1", "say", "empty", "", "", "", "", "{}", '["id","speaker","text"]']));

  // A non-empty edit in an unmarked column adds that property without requiring
  // spreadsheet users to edit the presence metadata as a second step.
  const addedSpeakerRow = csvRecord(["instruction", "start", "0", "say", "absent", "New speaker", "Visible", "", "", "{}", '["id","text"]']);
  const editedSpeaker = parseStoryCsv(csv.replace(
    csvRecord(["instruction", "start", "0", "say", "absent", "", "Visible", "", "", "{}", '["id","text"]']),
    addedSpeakerRow,
  ));
  expect(editedSpeaker.diagnostics).toEqual([]);
  expect((editedSpeaker.story?.script.start?.[0] as { speaker?: string }).speaker).toBe("New speaker");

  // Clearing an existing promoted string leaves the presence marker intact,
  // so an explicit empty string remains distinct from an absent field.
  const clearedTextRow = csvRecord(["instruction", "start", "1", "say", "empty", "", "", "", "", "{}", '["id","speaker","text"]']);
  const clearedText = parseStoryCsv(csv.replace(
    csvRecord(["instruction", "start", "1", "say", "empty", "", "", "", "", "{}", '["id","speaker","text"]']),
    clearedTextRow,
  ));
  expect(clearedText.diagnostics).toEqual([]);
  const emptyInstruction = clearedText.story?.script.start?.[1] as { speaker?: string; text?: string };
  expect(Object.hasOwn(emptyInstruction, "speaker")).toBe(true);
  expect(emptyInstruction.speaker).toBe("");
  expect(Object.hasOwn(emptyInstruction, "text")).toBe(true);
  expect(emptyInstruction.text).toBe("");

  // Presence may also be explicitly removed when an author wants absence.
  const withoutSpeakerPresence = csv.replace(csvRecord(['["id","speaker","text"]']), csvRecord(['["id","text"]']));
  expect(parseStoryCsv(withoutSpeakerPresence).story?.script.start?.[1]).toEqual({ type: "say", id: "empty", text: "" });
});

test("friendly CSV v2 rejects duplicate columns, conflicting parameters and malformed presence atomically", () => {
  const csv = formatStoryTableCsv(simpleStory);
  const header = csv.split("\r\n", 1)[0]!;
  const instruction = csv.split("\r\n").find(row => row.startsWith("instruction,start,0,say,"))!;
  const duplicateHeader = parseStoryCsv(csv.replace(header, header.replace(",speaker,", ",id,")));
  expect(duplicateHeader.story).toBeNull();
  expect(duplicateHeader.diagnostics[0]?.code).toBe("schema");

  const duplicateIndex = parseStoryCsv(csv.replace(instruction, instruction + "\r\n" + instruction));
  expect(duplicateIndex.story).toBeNull();
  expect(duplicateIndex.diagnostics[0]?.code).toBe("duplicate");

  const conflict = csv.replace(csvRecord(["instruction", "start", "0", "say", "line", "", "Hello, 世界.", "", "", "{}", '["id","text"]']),
    csvRecord(["instruction", "start", "0", "say", "line", "", "Hello, 世界.", "", "", '{"text":"shadow"}', '["id","text"]']));
  const conflictResult = parseStoryCsv(conflict);
  expect(conflictResult.story).toBeNull();
  expect(conflictResult.diagnostics[0]?.code).toBe("conflict");

  const malformedPresence = csv.replace(csvRecord(['["id","text"]']), csvRecord(['["id","text","text"]']));
  const malformedPresenceResult = parseStoryCsv(malformedPresence);
  expect(malformedPresenceResult.story).toBeNull();
  expect(malformedPresenceResult.diagnostics[0]?.code).toBe("duplicate");
  expect(parseStoryCsv(csv + '"unterminated').diagnostics[0]?.code).toBe("syntax");
});

test("CSV and Markdown preserve say presentation as canonical instruction data", () => {
  const story: StoryDefinition = {
    ...simpleStory,
    script: {
      start: [
        { type: "say", id: "reader", presentation: "fullscreen", text: "长段落" },
        { type: "say", id: "float", presentation: "floating", text: "浮动文字" },
      ],
    },
  };
  for (const result of [
    parseStoryCsv(formatStoryCsv(story)),
    parseStoryMarkdown(formatStoryMarkdown(story)),
  ]) {
    expect(result.diagnostics).toEqual([]);
    expect(jsonValue(result.story)).toEqual(jsonValue(story));
  }
});

test("authored and timeline audio groups survive story-text and table-CSV round trips", () => {
  const story: StoryDefinition = {
    ...simpleStory,
    timelines: { crossfade: {
      durationMs: 100,
      audio: [
        { atMs: 0, cue: "theme-a", channel: "harbor-a", loop: true, group: "music" },
        { atMs: 100, cue: "stop-a", action: "stop", channel: "harbor-a" },
      ],
      audioGains: [{ channel: "harbor-a", keyframes: [
        { atMs: 0, value: 1 }, { atMs: 100, value: 0 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "crossfade" },
      { type: "audio", cue: "storm-bells", channel: "storm-bed", group: "effects", loop: true },
      { type: "say", id: "line", text: "The music carries the rain." },
    ] },
  };
  const expected = jsonValue(story);
  const textRoundTrip = parseStoryText(formatStoryText(story));
  expect(textRoundTrip.diagnostics).toEqual([]);
  expect(jsonValue(textRoundTrip.story)).toEqual(expected);

  const csvRoundTrip = parseStoryTableCsv(formatStoryTableCsv(story));
  expect(csvRoundTrip.diagnostics).toEqual([]);
  expect(jsonValue(csvRoundTrip.story)).toEqual(expected);
  const engine = createNovelEngine(textRoundTrip.story!);
  engine.dispose();
});

test("CSV accepts LF, BOM, quoted commas, doubled quotes and multiline fields", () => {
  const lf = formatStoryCsv(simpleStory).replaceAll("\r\n", "\n");
  const parsedLf = parseStoryCsv("\uFEFF" + lf);
  expect(parsedLf.diagnostics).toEqual([]);
  expect(jsonValue(parsedLf.story)).toEqual(jsonValue(simpleStory));

  const parsedMultiline = parseStoryCsv(formatStoryCsv(supportedStory));
  expect(parsedMultiline.diagnostics).toEqual([]);
  expect(parsedMultiline.story?.start).toBe(startLabel);
  expect((parsedMultiline.story?.customMetadata as { note: string }).note).toBe("comma, quote \" and newline\nkept");
});

test("interchange round-trips without TextEncoder and bounds true UTF-8 size", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  try {
    expect(Reflect.deleteProperty(globalThis, "TextEncoder")).toBe(true);
    expect("TextEncoder" in globalThis).toBe(false);

    const csv = parseStoryCsv(formatStoryCsv(supportedStory));
    const markdown = parseStoryMarkdown(formatStoryMarkdown(supportedStory));
    expect(csv.diagnostics).toEqual([]);
    expect(markdown.diagnostics).toEqual([]);
    expect(jsonValue(csv.story)).toEqual(jsonValue(supportedStory));
    expect(jsonValue(markdown.story)).toEqual(jsonValue(supportedStory));

    // Each BMP CJK character occupies one UTF-16 code unit but three UTF-8
    // bytes. This remains below the code-unit cap and crosses the actual byte cap.
    const oversizedUtf8 = "海".repeat(Math.floor((8 * 1024 * 1024) / 3) + 1);
    expect(oversizedUtf8.length).toBeLessThan(8 * 1024 * 1024);
    expect(parseStoryCsv(oversizedUtf8).diagnostics[0]?.code).toBe("limit");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "TextEncoder", descriptor);
  }
});

test("Markdown v1 round-trips the same source through one JSON block per ordered label", () => {
  const markdown = formatStoryMarkdown(supportedStory);
  expect(markdown).toContain("### Label 1");
  expect(markdown).toContain("### Label 2");
  expect(markdown).toContain('"type": "scene"');
  const imported = parseStoryMarkdown("\uFEFF" + markdown.replaceAll("\n", "\r\n"));
  expect(imported.diagnostics).toEqual([]);
  expect(jsonValue(imported.story)).toEqual(jsonValue(supportedStory));

  const engine = createNovelEngine(imported.story!);
  engine.dispose();
});

test("future instruction records and metadata stay lossless without a second interpreter", () => {
  const futureStory = {
    ...simpleStory,
    metadataExtension: { nested: { feature: "future" } },
    script: {
      start: [{ type: "future.fx", strength: 0.75, extension: { seed: 17 }, text: "不翻译" }],
      ending: simpleStory.script.ending,
    },
  } as unknown as StoryDefinition;
  const csv = parseStoryCsv(formatStoryCsv(futureStory));
  const markdown = parseStoryMarkdown(formatStoryMarkdown(futureStory));
  expect(csv.diagnostics).toEqual([]);
  expect(markdown.diagnostics).toEqual([]);
  expect(jsonValue(csv.story)).toEqual(jsonValue(futureStory));
  expect(jsonValue(markdown.story)).toEqual(jsonValue(futureStory));
});

test("CSV rejects duplicate, gapped and type-conflicting rows atomically", () => {
  const csv = formatStoryCsv(simpleStory);
  const rows = csv.trimEnd().split("\r\n");
  const labelRow = rows.findIndex(row => row.startsWith("label,start,"));
  const instructionRow = rows.findIndex(row => row.startsWith("instruction,start,"));
  const valid = parseStoryCsv(csv);
  expect(valid.diagnostics).toEqual([]);

  const duplicateLabel = [...rows];
  duplicateLabel.splice(labelRow + 1, 0, rows[labelRow]!);
  const duplicateLabelResult = parseStoryCsv(duplicateLabel.join("\r\n"));
  expect(duplicateLabelResult.story).toBeNull();
  expect(duplicateLabelResult.diagnostics[0]?.code).toBe("duplicate");

  const duplicateIndex = [...rows];
  duplicateIndex.splice(instructionRow + 1, 0, rows[instructionRow]!);
  const duplicateIndexResult = parseStoryCsv(duplicateIndex.join("\r\n"));
  expect(duplicateIndexResult.story).toBeNull();
  expect(duplicateIndexResult.diagnostics[0]?.code).toBe("duplicate");

  const gap = [...rows];
  gap[instructionRow] = gap[instructionRow]!.replace("instruction,start,0,", "instruction,start,1,");
  expect(parseStoryCsv(gap.join("\r\n")).diagnostics[0]?.code).toBe("conflict");

  const conflict = [...rows];
  conflict[instructionRow] = conflict[instructionRow]!.replace(",say,", ",ending,");
  const conflictResult = parseStoryCsv(conflict.join("\r\n"));
  expect(conflictResult.story).toBeNull();
  expect(conflictResult.diagnostics[0]?.code).toBe("conflict");

  const malformed = parseStoryCsv(csv + '"unterminated');
  expect(malformed.story).toBeNull();
  expect(malformed.diagnostics[0]?.code).toBe("syntax");
});

test("Markdown rejects duplicate labels and unrecognized content without returning a partial story", () => {
  const markdown = formatStoryMarkdown(simpleStory);
  const duplicate = markdown.replace('"label": "ending"', '"label": "start"');
  const duplicateResult = parseStoryMarkdown(duplicate);
  expect(duplicateResult.story).toBeNull();
  expect(duplicateResult.diagnostics[0]?.code).toBe("duplicate");

  const trailing = parseStoryMarkdown(markdown + "## Conflicting edit\n");
  expect(trailing.story).toBeNull();
  expect(trailing.diagnostics[0]?.code).toBe("schema");

  const badJson = parseStoryMarkdown(markdown.replace('"id": "simple.interchange"', '"id": ]'));
  expect(badJson.story).toBeNull();
  expect(badJson.diagnostics[0]?.code).toBe("syntax");
});

test("import sizes are bounded before parsing", () => {
  const oversized = "x".repeat(8 * 1024 * 1024 + 1);
  expect(parseStoryCsv(oversized).diagnostics[0]?.code).toBe("limit");
  expect(parseStoryTableCsv(oversized).diagnostics[0]?.code).toBe("limit");
  expect(parseStoryMarkdown(oversized).diagnostics[0]?.code).toBe("limit");
});
