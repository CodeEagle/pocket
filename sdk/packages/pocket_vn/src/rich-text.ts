import type { JsonValue, NovelSayColorToken, NovelSayRich, NovelSaySpan, NovelSayPause } from "./types.ts";

export const NOVEL_SAY_RICH_MAX_SPANS = 256;
export const NOVEL_SAY_RICH_MAX_PAUSES = 128;
export const NOVEL_SAY_RICH_MAX_RUBY_CHARACTERS = 256;
export const NOVEL_SAY_RICH_MAX_NOTE_TITLE_CHARACTERS = 256;
export const NOVEL_SAY_RICH_MAX_NOTE_TEXT_CHARACTERS = 8_192;
export const NOVEL_SAY_RICH_MAX_ANNOTATION_TEXT_CHARACTERS = 65_536;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
const COLORS = new Set<NovelSayColorToken>(["accent", "muted", "warning"]);

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validOffset(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

/** Validate one line's inline annotations against its canonical source string. */
export function novelSayRichIssue(text: string, rich: unknown): string | null {
  if (typeof text !== "string") return "对白正文必须是字符串。";
  if (!record(rich) || !hasOnlyKeys(rich, ["spans", "pauses"])) return "rich 必须只包含 spans 和 pauses。";
  if (!Array.isArray(rich.spans) || rich.spans.length > NOVEL_SAY_RICH_MAX_SPANS) return `spans 最多包含 ${NOVEL_SAY_RICH_MAX_SPANS} 项。`;
  if (!Array.isArray(rich.pauses) || rich.pauses.length > NOVEL_SAY_RICH_MAX_PAUSES) return `pauses 最多包含 ${NOVEL_SAY_RICH_MAX_PAUSES} 项。`;

  const length = codePointLength(text);
  const ids = new Set<string>();
  let previousSpanEnd = 0;
  let annotationTextCharacters = 0;
  for (const [index, raw] of rich.spans.entries()) {
    const path = `spans[${index}]`;
    if (!record(raw) || !hasOnlyKeys(raw, ["id", "start", "end", "style", "ruby", "link"])) return `${path} 结构无效。`;
    if (!validId(raw.id)) return `${path}.id 必须是有效稳定 ID。`;
    if (ids.has(raw.id)) return `annotation ID ${raw.id} 重复。`;
    ids.add(raw.id);
    if (!validOffset(raw.start, length) || !validOffset(raw.end, length) || raw.end <= raw.start) return `${path} 范围必须是正文内非空的 code-point [start,end) 区间。`;
    if (index > 0 && raw.start < previousSpanEnd) return `${path} 与前一 span 重叠或未按起点排序。`;
    previousSpanEnd = raw.end as number;

    if (raw.style !== undefined) {
      if (!record(raw.style) || !hasOnlyKeys(raw.style, ["color", "emphasis"])) return `${path}.style 结构无效。`;
      if (raw.style.color !== undefined && !COLORS.has(raw.style.color as NovelSayColorToken)) return `${path}.style.color 必须是 accent、muted 或 warning。`;
      if (raw.style.emphasis !== undefined && raw.style.emphasis !== "strong") return `${path}.style.emphasis 目前只支持 strong。`;
      if (raw.style.color === undefined && raw.style.emphasis === undefined) return `${path}.style 至少需要 color 或 emphasis。`;
    }
    if (raw.ruby !== undefined) {
      if (typeof raw.ruby !== "string" || !raw.ruby.trim() || codePointLength(raw.ruby) > NOVEL_SAY_RICH_MAX_RUBY_CHARACTERS) return `${path}.ruby 必须是 1–${NOVEL_SAY_RICH_MAX_RUBY_CHARACTERS} 个 code point。`;
      annotationTextCharacters += raw.ruby.length;
    }
    if (raw.link !== undefined) {
      if (!record(raw.link) || !hasOnlyKeys(raw.link, ["title", "text"])) return `${path}.link 必须是内部注释 {title,text}。`;
      if (typeof raw.link.title !== "string" || !raw.link.title.trim() || codePointLength(raw.link.title) > NOVEL_SAY_RICH_MAX_NOTE_TITLE_CHARACTERS) return `${path}.link.title 必须是 1–${NOVEL_SAY_RICH_MAX_NOTE_TITLE_CHARACTERS} 个 code point。`;
      if (typeof raw.link.text !== "string" || !raw.link.text.trim() || codePointLength(raw.link.text) > NOVEL_SAY_RICH_MAX_NOTE_TEXT_CHARACTERS) return `${path}.link.text 必须是 1–${NOVEL_SAY_RICH_MAX_NOTE_TEXT_CHARACTERS} 个 code point。`;
      annotationTextCharacters += raw.link.title.length + raw.link.text.length;
    }
  }

  let previousPauseAt = -1;
  for (const [index, raw] of rich.pauses.entries()) {
    const path = `pauses[${index}]`;
    if (!record(raw) || !hasOnlyKeys(raw, ["id", "at", "durationMs"])) return `${path} 结构无效。`;
    if (!validId(raw.id)) return `${path}.id 必须是有效稳定 ID。`;
    if (ids.has(raw.id)) return `annotation ID ${raw.id} 重复。`;
    ids.add(raw.id);
    if (!validOffset(raw.at, length)) return `${path}.at 必须是正文内的 code-point 边界。`;
    if ((raw.at as number) < previousPauseAt) return `${path} 必须按 at 升序排列。`;
    previousPauseAt = raw.at as number;
    if (raw.durationMs !== null && (!Number.isSafeInteger(raw.durationMs) || (raw.durationMs as number) <= 0)) return `${path}.durationMs 必须是正整数或 null（手动暂停）。`;
  }
  if (annotationTextCharacters > NOVEL_SAY_RICH_MAX_ANNOTATION_TEXT_CHARACTERS) return `注音与注释文本总量不能超过 ${NOVEL_SAY_RICH_MAX_ANNOTATION_TEXT_CHARACTERS} 个 UTF-16 code unit。`;
  return null;
}

/** Match the VN engine's existing variable interpolation semantics. */
export function interpolateNovelText(text: string, variables: Readonly<Record<string, JsonValue>>): string {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

interface ResolvedTextMapping {
  readonly text: string;
  readonly mapBoundary: readonly (number | null)[];
}

function resolveTextMapping(text: string, variables: Readonly<Record<string, JsonValue>>): ResolvedTextMapping {
  const sourcePoints = Array.from(text);
  const utf16ToCodePoint: Array<number | null> = Array(text.length + 1).fill(null);
  let sourcePointOffset = 0;
  for (let utf16 = 0; utf16 < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(utf16)!);
    utf16ToCodePoint[utf16] = sourcePointOffset;
    utf16 += point.length;
    sourcePointOffset++;
    utf16ToCodePoint[utf16] = sourcePointOffset;
  }

  const mapBoundary: Array<number | null> = Array(sourcePoints.length + 1).fill(null);
  const output: string[] = [];
  let sourceUtf16 = 0;
  let sourcePoint = 0;
  const appendLiteral = (literal: string): void => {
    for (const point of literal) {
      mapBoundary[sourcePoint] = output.length;
      output.push(point);
      sourcePoint++;
      mapBoundary[sourcePoint] = output.length;
    }
  };
  PLACEHOLDER_PATTERN.lastIndex = 0;
  for (let match = PLACEHOLDER_PATTERN.exec(text); match; match = PLACEHOLDER_PATTERN.exec(text)) {
    appendLiteral(text.slice(sourceUtf16, match.index));
    const start = utf16ToCodePoint[match.index];
    const endUtf16 = match.index + match[0].length;
    const end = utf16ToCodePoint[endUtf16];
    if (start === null || end === null) throw new Error("placeholder boundary split a Unicode code point");
    sourcePoint = start;
    mapBoundary[start] = output.length;
    for (let offset = start + 1; offset < end; offset++) mapBoundary[offset] = null;
    const value = variables[match[1]!];
    const replacement = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    output.push(...Array.from(replacement));
    sourcePoint = end;
    mapBoundary[end] = output.length;
    sourceUtf16 = endUtf16;
  }
  appendLiteral(text.slice(sourceUtf16));
  return { text: output.join(""), mapBoundary };
}

/** Validate a source template's annotations, including placeholder-safe boundaries. */
export function novelSayRichTemplateIssue(text: string, rich: unknown): string | null {
  const issue = novelSayRichIssue(text, rich);
  if (issue !== null) return issue;
  const mapping = resolveTextMapping(text, {});
  const boundaries: Array<{ readonly offset: number; readonly path: string }> = [];
  const typed = rich as NovelSayRich;
  typed.spans.forEach((span, index) => {
    boundaries.push({ offset: span.start, path: `spans[${index}].start` });
    boundaries.push({ offset: span.end, path: `spans[${index}].end` });
  });
  typed.pauses.forEach((pause, index) => boundaries.push({ offset: pause.at, path: `pauses[${index}].at` }));
  for (const boundary of boundaries) {
    if (mapping.mapBoundary[boundary.offset] === null) return `${boundary.path} cannot split a {{variable}} placeholder.`;
  }
  return null;
}

/** Resolve a canonical say template and translate annotation boundaries through its interpolations. */
export function resolveNovelSayRich(
  textTemplate: string,
  variables: Readonly<Record<string, JsonValue>>,
  rich?: NovelSayRich,
): { readonly text: string; readonly rich?: NovelSayRich } {
  if (rich === undefined) return { text: interpolateNovelText(textTemplate, variables) };
  const issue = novelSayRichTemplateIssue(textTemplate, rich);
  if (issue !== null) throw new TypeError(`say.rich: ${issue}`);
  const mapping = resolveTextMapping(textTemplate, variables);
  const boundary = (offset: number, path: string): number => {
    const mapped = mapping.mapBoundary[offset];
    if (mapped === null || mapped === undefined) throw new TypeError(`${path} cannot split a {{variable}} placeholder`);
    return mapped;
  };
  const spans: NovelSaySpan[] = [];
  for (const [index, span] of rich.spans.entries()) {
    const start = boundary(span.start, `say.rich.spans[${index}].start`);
    const end = boundary(span.end, `say.rich.spans[${index}].end`);
    // A whole placeholder can resolve to an empty value. There is then no
    // visible range to style or activate, so omit that annotation.
    if (end <= start) continue;
    spans.push({ ...span, start, end });
  }
  const pauses: NovelSayPause[] = rich.pauses.map((pause, index) => ({
    ...pause,
    at: boundary(pause.at, `say.rich.pauses[${index}].at`),
  }));
  const resolvedRich: NovelSayRich = {
    spans: spans.map(span => span.link === undefined ? span : {
      ...span,
      link: {
        title: interpolateNovelText(span.link.title, variables),
        text: interpolateNovelText(span.link.text, variables),
      },
    }),
    pauses,
  };
  const resolvedIssue = novelSayRichIssue(mapping.text, resolvedRich);
  if (resolvedIssue !== null) throw new TypeError(`resolved say.rich: ${resolvedIssue}`);
  return { text: mapping.text, rich: resolvedRich };
}
