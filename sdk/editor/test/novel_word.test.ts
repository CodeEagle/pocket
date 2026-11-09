import { expect, test } from "bun:test";
import { extractZipArchive } from "../../scripts/package_update.ts";
import { createNovelWordDocument } from "../novel-word.ts";
import type { StoryDefinition } from "../../packages/pocket_vn/src/types.ts";

const storyWithEveryInstruction = {
  id: "word-export-review",
  version: 3,
  start: "opening",
  title: "潮汐与灯塔：审阅稿",
  authoringNotes: { retained: ["writer", "voice actor"] },
  script: {
    opening: [
      { type: "say", id: "line-1", speaker: "林", text: "第一行：你好，世界！ 😀 <灯> &\n第二行\t尾", voice: "arrival", extraDirection: "保留" },
      { type: "scene", background: "harbor", characters: [{ id: "mira", expression: "worried" }], transition: { kind: "fade", durationMs: 400 }, lensNote: "35mm" },
      { type: "audio", cue: "wind", action: "play", channel: "ambience", loop: true },
      { type: "video", action: "seek", positionMs: 420 },
      { type: "wait", durationMs: 250 },
      { type: "set", variable: "coins", value: 2 },
      { type: "inc", variable: "coins", amount: 1 },
      { type: "trade", item: "lamp", action: "buy", quantity: 1, onFailure: "refused" },
      { type: "branch", when: { op: "truthy", value: { type: "variable", name: "met" } }, then: "accepted", else: "refused" },
      { type: "jump", target: "ending" },
      { type: "call", target: "helper" },
      { type: "return" },
      { type: "choice", id: "route", prompt: "下一步去哪？", options: [
        { id: "pier", text: "去码头", target: "accepted", when: { op: "truthy", value: { type: "variable", name: "open" } } },
        { id: "home", text: "回家", target: "refused" },
      ] },
      { type: "input", id: "name", variable: "hero", inputType: "text", prompt: "你的名字？", placeholder: "姓名" },
      { type: "ending", id: "end", text: "灯塔亮起。", cg: "dawn" },
      { type: "future.fx", id: "future", nested: { value: "保留 <新效果> & 参数" } },
    ],
    accepted: [],
    refused: [{ type: "say", id: "refusal", text: "暂时没有更多内容。" }],
    "": [],
  },
} as unknown as StoryDefinition;

function openDocx(bytes: Uint8Array): Map<string, string> {
  const entries = extractZipArchive(bytes, 64 * 1024 * 1024);
  return new Map([...entries].map(([name, value]) => [name, new TextDecoder("utf-8", { fatal: true }).decode(value)]));
}

function documentText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(match => decodeXmlText(match[1]!))
    .join("");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

test("exports a real editable Word package with internal part references and review styles", () => {
  const entries = openDocx(createNovelWordDocument(storyWithEveryInstruction));
  expect([...entries.keys()].sort()).toEqual([
    "[Content_Types].xml",
    "_rels/.rels",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
  ]);

  const contentTypes = entries.get("[Content_Types].xml")!;
  const packageRels = entries.get("_rels/.rels")!;
  const documentRels = entries.get("word/_rels/document.xml.rels")!;
  const document = entries.get("word/document.xml")!;
  const styles = entries.get("word/styles.xml")!;
  expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
  expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml");
  expect(packageRels).toContain('Target="word/document.xml"');
  expect(documentRels).toContain('Target="styles.xml"');
  expect(documentRels).toContain(`${"http://schemas.openxmlformats.org/officeDocument/2006/relationships"}/styles`);
  expect(packageRels + documentRels).not.toContain("TargetMode=\"External\"");
  expect(document).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  expect(document.match(/<w:p(?:\s|>)/g)?.length).toBeGreaterThan(30);
  expect(document).toContain('<w:pStyle w:val="Title"/>');
  expect(document).toContain('<w:pStyle w:val="Heading1"/>');
  expect(document).toContain("<w:br/>");
  expect(document).toContain("<w:tab/>");
  expect(document).toContain("&lt;灯&gt; &amp;");
  expect(styles).toMatch(/w:styleId="Heading1"[\s\S]*?<w:keepNext\/>/);
  expect(styles).toContain("w:line=\"300\"");
  expect(entries.has("word/vbaProject.bin")).toBe(false);
  expect(entries.has("docProps/core.xml")).toBe(false);
  expect(entries.has("word/_rels/document.xml.rels")).toBe(true);

  const visible = documentText(document);
  expect(visible).toContain("潮汐与灯塔：审阅稿");
  expect(visible).toContain("章节：accepted");
  expect(visible).toContain("章节：refused");
  expect(visible).toContain("章节：（空 label）");
  expect(visible).toContain("第一行：你好，世界！ 😀 <灯> &");
  expect(visible).toContain("第二行");
  expect(visible).toContain("尾");
  expect(visible).toContain("选择提示：下一步去哪？");
  expect(visible).toContain("选项 \"pier\"：去码头　→　目标 label：accepted");
  expect(visible).toContain("目标 label：refused");
  expect(visible).toContain("lensNote");
  expect(visible).toContain("保留 <新效果> & 参数");
  expect(visible).toContain("未知指令");
  expect(visible).toContain("不能据此认定当前引擎支持执行");
  for (const [index, type] of ["say", "scene", "audio", "video", "wait", "set", "inc", "trade", "branch", "jump", "call", "return", "choice", "input", "ending", "future.fx"].entries()) {
    expect(visible).toContain(`类型：${type}`);
    expect(visible).toContain(`script["opening"][${index}]`);
  }
});

test("canonical export preserves source order and data without changing the story, and is byte deterministic", () => {
  const before = structuredClone(storyWithEveryInstruction);
  const first = createNovelWordDocument(storyWithEveryInstruction);
  const second = createNovelWordDocument(storyWithEveryInstruction);
  expect(storyWithEveryInstruction).toEqual(before);
  expect(second).toEqual(first);

  const xml = openDocx(first).get("word/document.xml")!;
  const visible = documentText(xml);
  const firstMeta = visible.indexOf('script["opening"][0]');
  const secondMeta = visible.indexOf('script["opening"][1]');
  const choiceMeta = visible.indexOf('script["opening"][12]');
  const unknownMeta = visible.indexOf('script["opening"][15]');
  expect(firstMeta).toBeGreaterThanOrEqual(0);
  expect(firstMeta).toBeLessThan(secondMeta);
  expect(secondMeta).toBeLessThan(choiceMeta);
  expect(choiceMeta).toBeLessThan(unknownMeta);
  expect(visible).toContain('完整指令 JSON：{  "background": "harbor"');
  expect(visible).toContain('"lensNote": "35mm"');
  expect(visible).toContain('"nested": {    "value": "保留 <新效果> & 参数"');
});

test("rejects XML-illegal controls and unpaired UTF-16 surrogates instead of replacing source characters", () => {
  const withNul = structuredClone(storyWithEveryInstruction) as any;
  withNul.script.opening[0].text = "before\u0000after";
  const nulSnapshot = structuredClone(withNul);
  expect(() => createNovelWordDocument(withNul)).toThrow(/XML 1\.0-illegal character U\+0000/);
  expect(withNul).toEqual(nulSnapshot);

  const withUnpairedSurrogate = structuredClone(storyWithEveryInstruction) as any;
  withUnpairedSurrogate.script.opening[0].text = `before${String.fromCharCode(0xd800)}after`;
  const surrogateSnapshot = structuredClone(withUnpairedSurrogate);
  expect(() => createNovelWordDocument(withUnpairedSurrogate)).toThrow(/unpaired high surrogate/);
  expect(withUnpairedSurrogate).toEqual(surrogateSnapshot);

  const trailingHighSurrogate = structuredClone(storyWithEveryInstruction) as any;
  trailingHighSurrogate.script.opening[0].text = `末尾${String.fromCharCode(0xd800)}`;
  expect(() => createNovelWordDocument(trailingHighSurrogate)).toThrow(/unpaired high surrogate at UTF-16 offset/);
});

test("rejects an XML-expanded document over the DOCX part bound and keeps the caller story intact", () => {
  const large = {
    id: "large-word-export",
    version: 1,
    start: "start",
    script: { start: [{ type: "say", id: "line", text: "&".repeat(7_000_000) }] },
  } as StoryDefinition;
  const before = (large.script.start[0] as any).text;
  expect(() => createNovelWordDocument(large)).toThrow(/word\/document\.xml exceeds the .* DOCX part limit/);
  expect((large.script.start[0] as any).text).toBe(before);
});

test("enforces the existing 8 MiB authoring-source limit", () => {
  const oversized = {
    id: "oversized-word-export",
    version: 1,
    start: "start",
    script: { start: [{ type: "say", id: "line", text: "x".repeat(8 * 1024 * 1024) }] },
  } as StoryDefinition;
  expect(() => createNovelWordDocument(oversized)).toThrow(/authoring source exceeds 8388608 UTF-8 bytes/);
});
