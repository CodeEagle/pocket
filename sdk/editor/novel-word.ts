/** Pure Node/Bun DOCX export for Editor-owned visual novel stories. */

import { createZipArchive } from "../scripts/package_update.ts";
import { formatStoryText, parseStoryText } from "../packages/pocket_vn/src/authoring.ts";
import type { StoryDefinition } from "../packages/pocket_vn/src/types.ts";

const MAX_STORY_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_PART_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_LABELS = 10_000;
const MAX_INSTRUCTIONS_PER_LABEL = 20_000;
const MAX_TOTAL_INSTRUCTIONS = 100_000;

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const encoder = new TextEncoder();

type PlainRecord = Record<string, unknown>;
type RunPart = { readonly text: string; readonly bold?: boolean };

/**
 * Create an editable WordprocessingML DOCX for a complete script.
 *
 * The export is synchronous and read-only: it needs no resolved assets and
 * returns ZIP package bytes without reading or writing project files.
 */
export function createNovelWordDocument(story: StoryDefinition): Uint8Array {
  const canonical = canonicalStory(story);
  assertXmlScalars(canonical, "story");

  const documentXml = makeDocumentXml(canonical);
  const entries = new Map<string, Uint8Array>([
    ["[Content_Types].xml", encodeXml(CONTENT_TYPES_XML, "[Content_Types].xml")],
    ["_rels/.rels", encodeXml(PACKAGE_RELS_XML, "_rels/.rels")],
    ["word/document.xml", encodeXml(documentXml, "word/document.xml")],
    ["word/_rels/document.xml.rels", encodeXml(DOCUMENT_RELS_XML, "word/_rels/document.xml.rels")],
    ["word/styles.xml", encodeXml(STYLES_XML, "word/styles.xml")],
  ]);
  const archive = createZipArchive(entries);
  if (archive.byteLength > MAX_DOCX_ARCHIVE_BYTES) {
    throw new RangeError(`DOCX archive exceeds ${MAX_DOCX_ARCHIVE_BYTES} bytes.`);
  }
  return archive;
}

function canonicalStory(input: StoryDefinition): StoryDefinition {
  let source: string;
  try {
    source = formatStoryText(input);
  } catch (error) {
    throw new TypeError(`Story could not be formatted by the existing authoring boundary: ${errorMessage(error)}`);
  }
  if (encoder.encode(source).byteLength > MAX_STORY_SOURCE_BYTES) {
    throw new RangeError(`Story authoring source exceeds ${MAX_STORY_SOURCE_BYTES} UTF-8 bytes.`);
  }

  const parsed = parseStoryText(source);
  if (!parsed.story || parsed.diagnostics.length > 0) {
    throw new TypeError(parsed.diagnostics[0]?.message ?? "Story could not be parsed by the existing authoring boundary.");
  }
  const value = parsed.story as StoryDefinition;
  if (typeof value.id !== "string" || !Number.isSafeInteger(value.version) || typeof value.start !== "string" || !isRecord(value.script)) {
    throw new TypeError("Story header must include a string id, a safe integer version, a string start label, and a script object.");
  }

  const labels = Object.entries(value.script);
  if (labels.length > MAX_LABELS) throw new RangeError(`Story exceeds the ${MAX_LABELS}-label export limit.`);
  let instructionCount = 0;
  for (const [label, instructions] of labels) {
    if (!Array.isArray(instructions)) throw new TypeError(`story.script.${JSON.stringify(label)} must be an instruction array.`);
    if (instructions.length > MAX_INSTRUCTIONS_PER_LABEL) {
      throw new RangeError(`Label ${JSON.stringify(label)} exceeds the ${MAX_INSTRUCTIONS_PER_LABEL}-instruction export limit.`);
    }
    instructionCount += instructions.length;
    if (instructionCount > MAX_TOTAL_INSTRUCTIONS) {
      throw new RangeError(`Story exceeds the ${MAX_TOTAL_INSTRUCTIONS}-instruction export limit.`);
    }
  }
  return value;
}

function assertXmlScalars(value: unknown, path: string, depth = 0): void {
  if (depth > 128) throw new RangeError(`${path} exceeds the supported JSON nesting depth.`);
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const first = value.charCodeAt(index);
      let codePoint = first;
      if (first >= 0xd800 && first <= 0xdbff) {
        if (index + 1 >= value.length) {
          throw new TypeError(`${path} contains an unpaired high surrogate at UTF-16 offset ${index}.`);
        }
        const second = value.charCodeAt(index + 1);
        if (!(second >= 0xdc00 && second <= 0xdfff)) {
          throw new TypeError(`${path} contains an unpaired high surrogate at UTF-16 offset ${index}.`);
        }
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new TypeError(`${path} contains an unpaired low surrogate at UTF-16 offset ${index}.`);
      }
      if (!isXml10Character(codePoint)) {
        throw new TypeError(`${path} contains XML 1.0-illegal character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} at UTF-16 offset ${index}.`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertXmlScalars(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertXmlScalars(key, `${path} key`, depth + 1);
      assertXmlScalars(child, `${path}.${key}`, depth + 1);
    }
  }
}

function isXml10Character(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function makeDocumentXml(story: StoryDefinition): string {
  const title = storyTitle(story);
  const body: string[] = [
    paragraph("Title", [{ text: title }]),
    paragraph("Subtitle", [{ text: `Story ID：${story.id}　版本：${story.version}　起始 label：${story.start}` }]),
  ];

  for (const [label, instructions] of Object.entries(story.script)) {
    body.push(paragraph("Heading1", [{ text: label ? `章节：${label}` : "章节：（空 label）" }]));
    for (const [index, rawInstruction] of instructions.entries()) {
      const instruction = rawInstruction as unknown as PlainRecord;
      const type = instruction.type as string;
      const id = typeof instruction.id === "string" ? JSON.stringify(instruction.id) : "（无）";
      body.push(paragraph("InstructionMeta", [{ text: `位置：script[${JSON.stringify(label)}][${index}]　类型：${type}　ID：${id}` }]));

      if (type === "say") {
        const speaker = instruction.speaker === undefined ? "旁白" : requireString(instruction.speaker, `script[${JSON.stringify(label)}][${index}].speaker`);
        const text = requireString(instruction.text, `script[${JSON.stringify(label)}][${index}].text`);
        body.push(paragraph("Dialogue", [
          { text: speaker || "旁白", bold: true },
          { text: "\t" },
          { text },
        ]));
        const extras = withoutKeys(instruction, ["type", "id", "speaker", "text"]);
        if (Object.keys(extras).length > 0) {
          body.push(paragraph("Parameters", [{ text: `附加对白参数：${prettyJson(extras, label, index)}` }]));
        }
        continue;
      }

      body.push(paragraph("InstructionSummary", [{ text: instructionSummary(type, instruction) }]));
      if (type === "choice") {
        const prompt = instruction.prompt === undefined ? "（无提示）" : requireString(instruction.prompt, `script[${JSON.stringify(label)}][${index}].prompt`);
        body.push(paragraph("InstructionDetail", [{ text: `选择提示：${prompt}` }]));
        if (!Array.isArray(instruction.options)) throw new TypeError(`script[${JSON.stringify(label)}][${index}].options must be an array.`);
        instruction.options.forEach((option, optionIndex) => {
          if (!isRecord(option)) throw new TypeError(`script[${JSON.stringify(label)}][${index}].options[${optionIndex}] must be an object.`);
          const optionId = typeof option.id === "string" ? ` ${JSON.stringify(option.id)}` : "";
          const optionText = requireString(option.text, `script[${JSON.stringify(label)}][${index}].options[${optionIndex}].text`);
          const target = requireString(option.target, `script[${JSON.stringify(label)}][${index}].options[${optionIndex}].target`);
          body.push(paragraph("ChoiceOption", [{ text: `选项${optionId}：${optionText}　→　目标 label：${target}` }]));
        });
      }
      body.push(paragraph("Parameters", [{ text: `完整指令 JSON：${prettyJson(instruction, label, index)}` }]));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${WORD_NS}" xmlns:r="${DOC_REL_NS}"><w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

function storyTitle(story: StoryDefinition): string {
  const title = (story as StoryDefinition & { readonly title?: unknown }).title;
  return typeof title === "string" && title.length > 0 ? title : story.id;
}

function instructionSummary(type: string, instruction: PlainRecord): string {
  switch (type) {
    case "scene": {
      const background = instruction.background === null ? "清除当前背景" : typeof instruction.background === "string" ? `切换背景到 ${instruction.background}` : "保持背景";
      const characters = Array.isArray(instruction.characters) ? instruction.characters.length : 0;
      const removed = Array.isArray(instruction.remove) ? instruction.remove.length : 0;
      return `场景更新：${background}；更新角色 ${characters} 位；移除角色 ${removed} 位。`;
    }
    case "audio":
      return `音频：${instruction.action === "stop" ? "停止" : "播放"} cue ${humanValue(instruction.cue)}；频道 ${humanValue(instruction.channel)}；循环 ${humanValue(instruction.loop)}。`;
    case "video": {
      const action = typeof instruction.action === "string" ? instruction.action : "未知动作";
      const description: Record<string, string> = { play: "播放", pause: "暂停", close: "关闭", seek: "定位" };
      return `视频：${description[action] ?? action}；cue ${humanValue(instruction.cue)}；位置 ${humanValue(instruction.positionMs)} 毫秒。`;
    }
    case "wait": return `等待 ${humanValue(instruction.durationMs)} 毫秒。`;
    case "set": return `设置变量 ${humanValue(instruction.variable)} = ${humanValue(instruction.value)}。`;
    case "inc": return `变量 ${humanValue(instruction.variable)} 增加 ${humanValue(instruction.amount)}。`;
    case "trade": return `道具交易：${humanValue(instruction.action)} ${humanValue(instruction.item)} × ${humanValue(instruction.quantity)}；失败时跳转到 ${humanValue(instruction.onFailure)}。`;
    case "branch": return `条件分支：条件为 ${humanValue(instruction.when)}；成立时跳转到 ${humanValue(instruction.then)}，否则跳转到 ${humanValue(instruction.else)}。`;
    case "jump": return `跳转到 label ${humanValue(instruction.target)}。`;
    case "call": return `调用 label ${humanValue(instruction.target)}。`;
    case "return": return "返回调用位置。";
    case "choice": return `选项选择：共 ${Array.isArray(instruction.options) ? instruction.options.length : 0} 个选项。`;
    case "input": return `输入：${humanValue(instruction.inputType)}；写入变量 ${humanValue(instruction.variable)}；取消时跳转到 ${humanValue(instruction.cancelTarget)}。`;
    case "ending": return `结局 ${humanValue(instruction.id)}：${humanValue(instruction.text)}；CG ${humanValue(instruction.cg)}。`;
    default: return `未知指令“${type}”：导出仅保留数据，不能据此认定当前引擎支持执行。`;
  }
}

function humanValue(value: unknown): string {
  if (value === undefined) return "（未设置）";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function withoutKeys(value: PlainRecord, omitted: readonly string[]): PlainRecord {
  const excluded = new Set(omitted);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

function prettyJson(value: unknown, label: string, index: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) throw new TypeError("instruction is not JSON serializable");
    return json;
  } catch (error) {
    throw new TypeError(`script[${JSON.stringify(label)}][${index}] JSON export failed: ${errorMessage(error)}`);
  }
}

function paragraph(style: string, parts: readonly RunPart[]): string {
  const runs = parts.map(part => textRun(part.text, part.bold === true)).join("");
  return `<w:p><w:pPr><w:pStyle w:val="${escapeAttribute(style)}"/></w:pPr>${runs}</w:p>`;
}

function textRun(value: string, bold: boolean): string {
  const segments = value.split(/(\r\n|\r|\n|\t)/);
  const contents = segments.map(segment => {
    if (segment === "\r\n" || segment === "\r" || segment === "\n") return "<w:br/>";
    if (segment === "\t") return "<w:tab/>";
    return `<w:t xml:space="preserve">${escapeText(segment)}</w:t>`;
  }).join("");
  return `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}${contents}</w:r>`;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function encodeXml(xml: string, part: string): Uint8Array {
  const bytes = encoder.encode(xml);
  if (bytes.byteLength > MAX_DOCX_PART_BYTES) {
    throw new RangeError(`${part} exceeds the ${MAX_DOCX_PART_BYTES}-byte DOCX part limit.`);
  }
  return bytes;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  return value;
}

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const PACKAGE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${DOC_REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${DOC_REL_NS}/styles" Target="styles.xml"/></Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:styles xmlns:w="${WORD_NS}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="000000"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="1F4E79"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="InstructionMeta"><w:name w:val="Instruction metadata"/><w:basedOn w:val="Normal"/><w:next w:val="InstructionSummary"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="40"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="18"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="InstructionSummary"><w:name w:val="Instruction summary"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="InstructionDetail"><w:name w:val="Instruction detail"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="80"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ChoiceOption"><w:name w:val="Choice option"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:spacing w:after="80"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Dialogue"><w:name w:val="Dialogue"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="200" w:line="340" w:lineRule="auto"/><w:keepLines/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Parameters"><w:name w:val="Complete parameters"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:before="80" w:after="200" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/><w:color w:val="404040"/></w:rPr></w:style>` +
  `</w:styles>`;
