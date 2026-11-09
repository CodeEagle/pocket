import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { formatStoryText, parseStoryText } from "../src/authoring.ts";
import type { StoryDefinition } from "../src/types.ts";

const sourceStory = {
  id: "harbor.chapter-one",
  version: 4,
  start: "opening",
  title: "The Bell at Low Tide",
  authoring: { color: "teal", tags: ["coast", { private: true }] },
  script: {
    opening: [
      { type: "say", id: "arrive", speaker: "Mira", portrait: "mira", voice: "arrival", text: "The tide is {{tide}}.", extensions: { screenplay: { beat: 2 } } },
      {
        type: "scene",
        background: "harbor",
        characters: [
          { id: "mira", expression: "worried", position: { x: 24, y: 90 }, scale: 1.25, rotation: -4, layer: 2, visible: true, model: { key: "mira_spine", animation: "idle", loop: true } },
        ],
        transition: { kind: "dissolve", durationMs: 450 },
        remove: [],
        sceneNotes: { lens: "35mm" },
      },
      { type: "audio", cue: "harbor-wind", action: "play", channel: "ambience", loop: true, mix: { gain: 0.7 } },
      { type: "video", action: "play", cue: "harbor-loop", loop: true, overlayNotes: { purpose: "scene atmosphere" } },
      { type: "set", variable: "tide", value: "falling" },
      { type: "inc", variable: "visits", amount: 1 },
      { type: "branch", when: { op: "and", conditions: [{ op: "truthy", value: { type: "variable", name: "hasKey" } }, { op: "gte", left: { type: "variable", name: "visits" }, right: { type: "literal", value: 1 } }] }, then: "key-route", else: "open-route" },
      { type: "call", target: "helper" },
      { type: "input", id: "captain-name", variable: "captain.name", inputType: "text", prompt: "Who should we find?", placeholder: "Name", minLength: 1, maxLength: 40, cancelTarget: "open-route" },
      { type: "choice", id: "harbor-route", prompt: "Where should we go?", options: [
        { id: "street", text: "Follow the gulls", target: "open-route", when: { op: "falsy", value: { type: "variable", name: "closed" } }, note: "primary" },
        { id: "wharf", text: "Take the key", target: "key-route" },
      ], timeLimitMs: 3000, timeoutTarget: "open-route", extensions: ["kept"] },
      { type: "wait", durationMs: 25 },
      { type: "jump", target: "ending" },
    ],
    helper: [{ type: "return" }],
    "key-route": [{ type: "say", id: "key-line", text: "The brass key was warm." }, { type: "ending", id: "key-ending", text: "The locked room opens.", cg: "archive" }],
    "open-route": [{ type: "say", id: "gull-line", text: "The gulls circle the lighthouse." }, { type: "ending", id: "gull-ending" }],
    ending: [{ type: "ending", id: "end", text: "The bell is silent.", cg: "harbor-dawn" }],
  },
} as unknown as StoryDefinition;

test("Pocket VN text losslessly round-trips every current instruction and custom JSON metadata", () => {
  const text = formatStoryText(sourceStory);
  const parsed = parseStoryText(text);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story).toEqual(sourceStory);
  expect(formatStoryText(parsed.story!)).toBe(text);

  const engine = createNovelEngine(parsed.story!);
  engine.dispose();
});

test("unknown future instructions remain explicit JSON data and the engine still rejects unsupported types", () => {
  const text = [
    'story {"id":"future","version":1,"start":"start","custom":{"nested":[1,true]}}',
    "label start:",
    '  json {"type":"future.fx","strength":0.75,"extension":{"seed":17}}',
  ].join("\n");
  const parsed = parseStoryText(text);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story?.script.start).toEqual([{ type: "future.fx", strength: 0.75, extension: { seed: 17 } }]);
  expect(formatStoryText(parsed.story!)).toContain('json {"type":"future.fx","strength":0.75,"extension":{"seed":17}}');
  expect(() => createNovelEngine(parsed.story!)).toThrow(/unsupported/);
});

test("syntax and unknown opcodes point at the real source line and column", () => {
  const badJson = parseStoryText([
    '# Pocket VN authoring v1',
    'story {"id":"bad","version":1,"start":"start"}',
    "label start:",
    '  say {"id":"line","text": ]}',
  ].join("\n"));
  expect(badJson.story).toBeNull();
  expect(badJson.diagnostics[0]).toMatchObject({ line: 4, column: 7, code: "syntax" });
  expect(badJson.diagnostics[0]?.message).toContain("Invalid JSON payload");

  const typo = parseStoryText([
    'story {"id":"bad","version":1,"start":"start"}',
    "label start:",
    "  sayy {}",
  ].join("\n"));
  expect(typo.story).toBeNull();
  expect(typo.diagnostics[0]).toMatchObject({ line: 3, column: 3, code: "unknown-opcode" });
  expect(typo.diagnostics[0]?.message).toContain("Unknown instruction 'sayy'");
});

test("quoted labels, comments, CRLF and malformed header errors are handled without dropping data", () => {
  const source = [
    "# title comment",
    'story {"id":"quoted","version":1,"start":"opening day","credits":{"a":1}}',
    'label "opening day": // inline comments are not supported',
  ].join("\r\n");
  const parsed = parseStoryText(source);
  expect(parsed.story).toBeNull();
  expect(parsed.diagnostics[0]).toMatchObject({ line: 3, column: 22 });

  const valid = parseStoryText([
    "// comment",
    'story {"id":"quoted","version":1,"start":"opening day","credits":{"a":1}}',
    'label "opening day":',
    '  ending {"id":"last"}',
  ].join("\n"));
  expect(valid.story?.script["opening day"]).toEqual([{ type: "ending", id: "last" }]);
  expect(valid.story?.credits).toEqual({ a: 1 });
});

test("duplicate labels and duplicated instruction type fields fail explicitly", () => {
  const duplicate = parseStoryText([
    'story {"id":"dup","version":1,"start":"start"}',
    "label start:",
    "label start:",
  ].join("\n"));
  expect(duplicate.diagnostics[0]).toMatchObject({ line: 3, code: "duplicate-label" });

  const typeField = parseStoryText([
    'story {"id":"dup","version":1,"start":"start"}',
    "label start:",
    '  say {"type":"say","id":"one","text":"Hi"}',
  ].join("\n"));
  expect(typeField.diagnostics[0]).toMatchObject({ line: 3, code: "instruction" });
  expect(typeField.diagnostics[0]?.message).toContain("remove the 'type' field");
});


test("inventory catalog and trade instructions round-trip through ordinary authoring text", () => {
  const story: StoryDefinition = {
    id: "trade-text", version: 1, start: "opening",
    variableDefinitions: { coins: { lifetime: "save", defaultValue: 20 }, lamps: { lifetime: "save", defaultValue: 0 } },
    inventory: { currency: { title: "Tokens", variable: "coins" }, items: { lamp: { title: "Lamp", body: "A light.", quantityVariable: "lamps", buyPrice: 12 } } },
    script: { opening: [{ type: "trade", item: "lamp", action: "buy", quantity: 1, onFailure: "failed" }, { type: "ending", id: "bought" }], failed: [{ type: "ending", id: "refused" }] },
  };
  const text = formatStoryText(story);
  expect(text).toContain('trade {"item":"lamp"');
  const parsed = parseStoryText(text);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.story).toEqual(story);
  const engine = createNovelEngine(parsed.story!);
  try {
    engine.start();
    expect(engine.getSnapshot().variables).toMatchObject({ coins: 8, lamps: 1 });
  } finally { engine.dispose(); }
});
