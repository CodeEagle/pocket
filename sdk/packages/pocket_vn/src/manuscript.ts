import type { StoryInstruction } from "./types.ts";

export const MANUSCRIPT_MAX_CHARACTERS = 1_000_000;
export const MANUSCRIPT_MAX_LINES = 5_000;
type Say = Extract<StoryInstruction, { type: "say" }>;

export interface ManuscriptDiagnostic {
  readonly severity: "error" | "warning";
  readonly line: number;
  readonly message: string;
}

export interface ManuscriptImportOptions {
  readonly idPrefix: string;
  /** Only recognized names use colon notation; timestamps and URLs stay text. */
  readonly speakerNames?: readonly string[];
  readonly existingLineIds?: readonly string[];
}

export interface ManuscriptImportResult {
  readonly instructions?: readonly Say[];
  readonly sourceLines: readonly number[];
  readonly diagnostics: readonly ManuscriptDiagnostic[];
}

/** One-shot conversion into canonical say instructions, not another runtime. */
export function parseNovelManuscript(input: string, options: ManuscriptImportOptions): ManuscriptImportResult {
  const diagnostics: ManuscriptDiagnostic[] = [];
  const error = (line: number, message: string): ManuscriptImportResult => ({
    sourceLines: [], diagnostics: [...diagnostics, { severity: "error", line, message }],
  });
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(options.idPrefix)) return error(1, "对白 ID 前缀必须是 1–80 位字母、数字、下划线、点或连字符，且不能以数字开头。");
  if (typeof input !== "string" || input.length > MANUSCRIPT_MAX_CHARACTERS) return error(1, "手稿超过 1,000,000 个 UTF-16 字符单元。");
  if (input.includes("\0")) return error(1, "手稿含 NUL 字符；请选择 UTF-8 纯文本文件。");
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const names = new Set(options.speakerNames ?? []);
  const usedIds = new Set(options.existingLineIds ?? []);
  const instructions: Say[] = [];
  const sourceLines: number[] = [];
  let ordinal = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (instructions.length >= MANUSCRIPT_MAX_LINES) return error(index + 1, "手稿最多导入 5,000 个非空行；未导入任何部分。");
    if (line.length > 16_000) return error(index + 1, "单句超过 16,000 个 UTF-16 字符单元，请先拆行。");
    let speaker: string | undefined;
    let text = line;
    const bracket = /^(?:【([^】\n]{1,80})】|\[([^\]\n]{1,80})\])\s*(.*)$/.exec(line);
    const colon = /^([^:：\n]{1,80})[:：]\s*(.*)$/.exec(line);
    if (bracket) {
      speaker = (bracket[1] ?? bracket[2])!.trim();
      text = bracket[3]!;
      if (!speaker || !text) return error(index + 1, "括号说话人之后必须有对白文本。");
    } else if (colon && names.has(colon[1]!.trim())) {
      speaker = colon[1]!.trim();
      text = colon[2]!;
      if (!text) return error(index + 1, "说话人之后必须有对白文本。");
    } else if (colon && !/^\d/.test(colon[1]!) && !/^https?$/i.test(colon[1]!)) {
      diagnostics.push({ severity: "warning", line: index + 1, message: `未识别说话人“${colon[1]!.trim()}”，保留整行为旁白；可改用【姓名】对白。` });
    }
    let id: string;
    do { id = `${options.idPrefix}_${String(++ordinal).padStart(4, "0")}`; } while (usedIds.has(id));
    usedIds.add(id);
    instructions.push({ type: "say", id, ...(speaker ? { speaker } : {}), text });
    sourceLines.push(index + 1);
  }
  if (!instructions.length) return error(1, "手稿没有可导入的非空行。");
  return { instructions, sourceLines, diagnostics };
}
