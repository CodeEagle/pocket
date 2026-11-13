/**
 * Line-based text buffer for the Pocket code editor core.
 *
 * Design: `lines: string[]` (no terminators) plus a lazily extended prefix-sum
 * array of line start offsets. A piece table was rejected: the target is
 * 5,000 lines / 2 MiB (average 400 chars per line), where splicing a 5,000
 * pointer array per edit costs microseconds, line access is O(1), and
 * offset -> line is an O(log n) binary search over the prefix sums. All
 * offsets are UTF-16 code units in the *logical* document in which every line
 * break counts as exactly 1 unit ("\n"), whatever the file's EOL is.
 *
 * EOL: "\n" and "\r\n" are detected on load; the dominant one is preserved by
 * `toString()`. Mixed files are normalised to the dominant EOL on save
 * (`mixedEol` reports it). A lone "\r" is an ordinary character.
 *
 * Complexity: line(i) O(1); offsetAt O(1) amortised (starts are extended
 * lazily from the first edited line); positionAt O(log n); replace O(k + n)
 * for k inserted units and n lines (array splice).
 */

export interface Position { line: number; column: number }

/** Describes one applied replacement. Old lines [startLine, startLine+oldLineCount)
 * were replaced by new lines [startLine, startLine+newLineCount). */
export interface BufferChange {
  version: number;
  offset: number;
  removed: string;
  inserted: string;
  startLine: number;
  oldLineCount: number;
  newLineCount: number;
}

export type BufferListener = (change: BufferChange) => void;

export class TextBuffer {
  private lines: string[];
  private starts: number[] = [0];
  private validTo = 0;
  private len = 0;
  private listeners: BufferListener[] = [];
  /** Increments on every applied change. */
  version = 0;
  /** EOL used when serialising. */
  eol: "\n" | "\r\n" = "\n";
  /** True when the loaded text contained both EOL styles. */
  mixedEol = false;

  constructor(text = "") {
    this.lines = [""];
    this.setText(text, true);
  }

  static from(text: string): TextBuffer { return new TextBuffer(text); }

  /** Replace the whole document (detects EOL). Fires one change event. */
  setText(text: string, silent = false): void {
    let crlf = 0, lf = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
    }
    this.mixedEol = crlf > 0 && lf > 0;
    this.eol = crlf > lf ? "\r\n" : "\n";
    const logical = crlf > 0 ? text.split("\r\n").join("\n") : text;
    const old = silent ? "" : this.getText();
    const oldCount = this.lines.length;
    this.lines = logical.split("\n");
    this.len = logical.length;
    this.starts = [0]; this.validTo = 0;
    this.version++;
    if (!silent) this.emit({ version: this.version, offset: 0, removed: old, inserted: logical, startLine: 0, oldLineCount: oldCount, newLineCount: this.lines.length });
  }

  get lineCount(): number { return this.lines.length; }
  /** Document length in logical UTF-16 units (line breaks count 1). */
  get length(): number { return this.len; }

  line(i: number): string { return this.lines[i]; }
  lineLength(i: number): number { return this.lines[i].length; }

  /** Offset of the first unit of `line` (clamped). */
  lineStart(line: number): number {
    if (line <= 0) return 0;
    if (line >= this.lines.length) line = this.lines.length - 1;
    const s = this.starts;
    if (line > this.validTo) {
      let off = s[this.validTo];
      for (let i = this.validTo; i < line; i++) { off += this.lines[i].length + 1; s[i + 1] = off; }
      this.validTo = line;
    }
    return s[line];
  }
  lineEnd(line: number): number { return this.lineStart(line) + this.lines[Math.min(Math.max(line, 0), this.lines.length - 1)].length; }

  /** Line containing `offset` (clamped). O(log n). */
  lineAt(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.len) return this.lines.length - 1;
    const st = this.starts;
    let hi = this.validTo;
    if (offset >= st[hi]) {
      // walk forward from the last valid start (cost ~ distance from the last edit)
      let line = hi, off = st[hi];
      const last = this.lines.length - 1;
      while (line < last) {
        const next = off + this.lines[line].length + 1;
        if (next > offset) break;
        line++; off = next; st[line] = off; this.validTo = line;
      }
      return line;
    }
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  offsetAt(line: number, column: number): number {
    if (line < 0) return 0;
    if (line >= this.lines.length) return this.len;
    const c = Math.min(Math.max(column, 0), this.lines[line].length);
    return this.lineStart(line) + c;
  }

  positionAt(offset: number): Position {
    const line = this.lineAt(offset);
    const o = Math.min(Math.max(offset, 0), this.len);
    return { line, column: o - this.lineStart(line) };
  }

  columnAt(offset: number): number { return Math.min(Math.max(offset, 0), this.len) - this.lineStart(this.lineAt(offset)); }

  /** Text between logical offsets, with "\n" line breaks. */
  getRange(from: number, to: number): string {
    from = Math.max(0, from); to = Math.min(this.len, to);
    if (to <= from) return "";
    const l1 = this.lineAt(from), l2 = this.lineAt(to);
    const c1 = from - this.lineStart(l1), c2 = to - this.lineStart(l2);
    if (l1 === l2) return this.lines[l1].slice(c1, c2);
    let out = this.lines[l1].slice(c1);
    for (let i = l1 + 1; i < l2; i++) out += "\n" + this.lines[i];
    return out + "\n" + this.lines[l2].slice(0, c2);
  }

  /** Whole document with logical "\n". */
  getText(): string { return this.lines.join("\n"); }
  /** Whole document serialised with the preserved EOL. */
  toString(): string { return this.eol === "\n" ? this.lines.join("\n") : this.lines.join("\r\n"); }

  onChange(listener: BufferListener): () => void {
    this.listeners.push(listener);
    return () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); };
  }
  private emit(c: BufferChange): void { for (const l of this.listeners.slice()) l(c); }

  /** Replace [from, to) with `text` (CRLF in `text` is normalised to LF). Returns the change. */
  replace(from: number, to: number, text: string): BufferChange {
    from = Math.min(Math.max(from, 0), this.len);
    to = Math.min(Math.max(to, from), this.len);
    if (text.indexOf("\r") >= 0) text = text.split("\r\n").join("\n");
    const l1 = this.lineAt(from), l2 = this.lineAt(to);
    const s1 = this.lineStart(l1);
    const c1 = from - s1, c2 = to - this.lineStart(l2);
    const removed = this.getRange(from, to);
    const head = this.lines[l1].slice(0, c1), tail = this.lines[l2].slice(c2);
    let repl: string[];
    if (text.indexOf("\n") < 0) repl = [head + text + tail];
    else {
      repl = text.split("\n");
      repl[0] = head + repl[0];
      repl[repl.length - 1] += tail;
    }
    const oldCount = l2 - l1 + 1;
    if (repl.length === 1 && oldCount === 1) this.lines[l1] = repl[0];
    else this.lines.splice(l1, oldCount, ...repl);
    this.len += text.length - (to - from);
    if (this.validTo > l1) this.validTo = l1;
    this.version++;
    const change: BufferChange = { version: this.version, offset: from, removed, inserted: text, startLine: l1, oldLineCount: oldCount, newLineCount: repl.length };
    this.emit(change);
    return change;
  }
}

// ---------------------------------------------------------------------------
// Grapheme / word helpers (approximation, no Intl.Segmenter)
// ---------------------------------------------------------------------------

/**
 * Approximate extended grapheme clusters. A cluster is a code point plus any
 * following: combining marks (U+0300-036F, 1AB0-1AFF, 1DC0-1DFF, 20D0-20FF,
 * FE20-FE2F), variation selectors (FE00-FE0F, E0100-E01EF), Indic/Thai/Hebrew/
 * Arabic combining ranges (a coarse subset), emoji skin tones (1F3FB-1F3FF),
 * tag characters (E0020-E007F), ZWJ (200D) joining the following code point,
 * keycap (20E3); regional indicators pair up; CR LF is one cluster. Hangul
 * jamo sequences and rarer scripts are NOT merged (single-code-point clusters).
 */
export function isCombining(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x591 && cp <= 0x5bd) || (cp >= 0x64b && cp <= 0x65f) || (cp >= 0x900 && cp <= 0x903) ||
    (cp >= 0x93a && cp <= 0x94f && cp !== 0x93d) || (cp >= 0xe31 && cp <= 0xe3a && cp !== 0xe32 && cp !== 0xe33) ||
    (cp >= 0xe47 && cp <= 0xe4e) || cp === 0x200c || (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0020 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}
const ZWJ = 0x200d;
function isRegional(cp: number): boolean { return cp >= 0x1f1e6 && cp <= 0x1f1ff; }

function cpAt(s: string, i: number): number { return s.codePointAt(i) as number; }
function cpLen(cp: number): number { return cp > 0xffff ? 2 : 1; }
function cpBefore(s: string, i: number): { cp: number; start: number } {
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return { cp: cpAt(s, i - 2), start: i - 2 };
  }
  return { cp: lo, start: i - 1 };
}

/** Column of the next cluster boundary after `col` (== length at the end). */
export function nextBoundary(s: string, col: number): number {
  const n = s.length;
  if (col >= n) return n;
  let cp = cpAt(s, col);
  let i = col + cpLen(cp);
  if (cp === 13 && i < n && s.charCodeAt(i) === 10) return i + 1;
  if (isRegional(cp) && i < n && isRegional(cpAt(s, i))) i += 2;
  while (i < n) {
    cp = cpAt(s, i);
    if (isCombining(cp) || cp === 0x20e3) i += cpLen(cp);
    else if (cp === ZWJ) { i += 1; if (i < n) i += cpLen(cpAt(s, i)); }
    else break;
  }
  return i;
}

/** Column of the previous cluster boundary before `col` (0 at the start). */
export function prevBoundary(s: string, col: number): number {
  if (col <= 0) return 0;
  if (col > s.length) col = s.length;
  let { cp, start } = cpBefore(s, col);
  if (cp === 10 && start > 0 && s.charCodeAt(start - 1) === 13) return start - 1;
  while (start > 0) {
    if (isCombining(cp) || cp === 0x20e3) {
      const b = cpBefore(s, start); start = b.start; cp = b.cp;
    } else if (cp === ZWJ) {
      const b = cpBefore(s, start); start = b.start; cp = b.cp;
    } else {
      // preceding ZWJ joins this code point to the previous cluster
      if (start > 0 && s.charCodeAt(start - 1) === ZWJ && start >= 2) {
        const b = cpBefore(s, start - 1); start = b.start; cp = b.cp; continue;
      }
      if (isRegional(cp)) {
        // count regional indicators before to decide pairing
        let n = 0, j = start;
        while (j > 0) { const b = cpBefore(s, j); if (!isRegional(b.cp)) break; n++; j = b.start; }
        if (n % 2 === 1) start -= 2;
      }
      break;
    }
  }
  return start;
}

/** Snap `col` to a cluster boundary (never inside a surrogate pair or cluster). */
export function snapBoundary(s: string, col: number): number {
  if (col <= 0) return 0;
  if (col >= s.length) return s.length;
  const p = prevBoundary(s, nextBoundary(s, col));
  return p === col ? col : p;
}


export function isCjk(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x20000 && cp <= 0x2ffff);
}

/** 0 whitespace, 1 word, 2 punctuation, 3 CJK. */
export function wordClass(cp: number): number {
  if (cp === 32 || cp === 9 || cp === 10 || cp === 13 || cp === 0xa0 || cp === 0x3000 || (cp >= 0x2000 && cp <= 0x200a)) return 0;
  if ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95 || cp === 36) return 1;
  if (cp < 128) return 2;
  if (isCjk(cp)) return 3;
  if ((cp >= 0x2010 && cp <= 0x2027) || (cp >= 0x3001 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xff0f) || cp === 0xd7 || cp === 0xf7) return 2;
  return 1;
}

/** Column of the previous word start within `s` (0 when none). */
export function wordLeft(s: string, col: number): number {
  let i = col;
  while (i > 0) { const b = cpBefore(s, i); if (wordClass(b.cp) !== 0) break; i = b.start; }
  if (i === 0) return 0;
  const cls = wordClass(cpBefore(s, i).cp);
  while (i > 0) { const b = cpBefore(s, i); if (wordClass(b.cp) !== cls) break; i = b.start; }
  return i;
}

/** Column of the next word end within `s` (s.length when none). */
export function wordRight(s: string, col: number): number {
  const n = s.length;
  let i = col;
  while (i < n) { const cp = cpAt(s, i); if (wordClass(cp) !== 0) break; i += cpLen(cp); }
  if (i >= n) return n;
  const cls = wordClass(cpAt(s, i));
  while (i < n) { const cp = cpAt(s, i); if (wordClass(cp) !== cls) break; i += cpLen(cp); }
  return i;
}
