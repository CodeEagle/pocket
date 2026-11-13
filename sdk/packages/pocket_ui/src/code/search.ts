/**
 * Find / replace over the logical document text (offsets as in TextBuffer).
 *
 * No RegExp lookbehind is used (whole-word checks are done by hand), so it
 * runs on QuickJS. Regexes are guarded: invalid patterns return an error
 * instead of throwing, nested-quantifier patterns such as `(a+)+` are refused
 * (a single `exec` cannot be interrupted, so catastrophic backtracking has to
 * be prevented up front), and match collection is capped by count and by a
 * wall-clock budget checked between matches.
 */
import type { TextBuffer } from "./buffer.ts";
import { wordClass } from "./buffer.ts";
import type { Edit, SelectionSet } from "./selection.ts";
import { single } from "./selection.ts";
import type { Transaction } from "./commands.ts";

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Match cap (default 10,000). */
  maxMatches?: number;
  /** Wall-clock budget in ms per call (default 50). */
  timeBudgetMs?: number;
}

export interface Match { from: number; to: number }

export interface FindResult {
  matches: Match[];
  /** Hit `maxMatches`. */
  truncated: boolean;
  /** Hit the time budget. */
  timedOut: boolean;
  /** Invalid / unsafe pattern or empty query -> no matches. */
  error?: string;
}

interface Compiled { re: RegExp; whole: boolean; regex: boolean }

const UNSAFE = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;

function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"); }

export function compileQuery(query: string, opts: SearchOptions = {}): Compiled | { error: string } {
  if (query === "") return { error: "empty query" };
  let source = query;
  if (opts.regex) {
    if (query.length > 500) return { error: "pattern too long" };
    if (UNSAFE.test(query)) return { error: "pattern may backtrack catastrophically" };
  } else source = escapeRegex(query);
  try {
    return { re: new RegExp(source, "gm" + (opts.caseSensitive ? "" : "i")), whole: !!opts.wholeWord, regex: !!opts.regex };
  } catch (e) {
    return { error: "invalid pattern: " + (e instanceof Error ? e.message : String(e)) };
  }
}

function isWordAt(text: string, i: number): boolean {
  if (i < 0 || i >= text.length) return false;
  return wordClass(text.charCodeAt(i)) === 1;
}

function wholeOk(text: string, from: number, to: number): boolean {
  return !(isWordAt(text, from - 1) && isWordAt(text, from)) && !(isWordAt(text, to) && isWordAt(text, to - 1));
}

/** Next match at or after `pos` (no wrap). Returns the exec result or null. */
function execFrom(c: Compiled, text: string, pos: number, deadline: number): RegExpExecArray | null {
  const re = c.re;
  re.lastIndex = pos;
  let guard = 0;
  for (;;) {
    const m = re.exec(text);
    if (!m) return null;
    const from = m.index, to = from + m[0].length;
    if (to === from) { re.lastIndex = from + 1; if (from >= text.length) return null; }
    else if (!c.whole || wholeOk(text, from, to)) return m;
    else re.lastIndex = from + 1;
    if ((++guard & 63) === 0 && Date.now() > deadline) return null;
  }
}

/** All matches (capped, time-bounded). */
export function findAll(text: string, query: string, opts: SearchOptions = {}): FindResult {
  const c = compileQuery(query, opts);
  if ("error" in c) return { matches: [], truncated: false, timedOut: false, error: c.error };
  const max = opts.maxMatches ?? 10000, deadline = Date.now() + (opts.timeBudgetMs ?? 50);
  const matches: Match[] = [];
  let pos = 0, truncated = false, timedOut = false;
  while (pos <= text.length) {
    const m = execFrom(c, text, pos, deadline);
    if (!m) { if (Date.now() > deadline) timedOut = true; break; }
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (matches.length >= max) { truncated = true; break; }
    if ((matches.length & 63) === 0 && Date.now() > deadline) { timedOut = true; break; }
    pos = m.index + m[0].length;
  }
  return { matches, truncated, timedOut };
}

/** First match whose start is >= `from`; wraps to the document start when `wrap`. */
export function findNext(text: string, query: string, opts: SearchOptions, from: number, wrap = true): Match | null {
  const c = compileQuery(query, opts);
  if ("error" in c) return null;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50);
  let m = execFrom(c, text, Math.max(0, from), deadline);
  if (!m && wrap && from > 0) m = execFrom(c, text, 0, deadline);
  return m ? { from: m.index, to: m.index + m[0].length } : null;
}

/** Last match whose start is < `before`; wraps to the document end when `wrap`. */
export function findPrev(text: string, query: string, opts: SearchOptions, before: number, wrap = true): Match | null {
  const r = findAll(text, query, opts);
  if (!r.matches.length) return null;
  let lo = 0, hi = r.matches.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (r.matches[mid].from < before) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found >= 0) return r.matches[found];
  return wrap ? r.matches[r.matches.length - 1] : null;
}

/** Number of matches (capped like findAll). */
export function countMatches(text: string, query: string, opts: SearchOptions = {}): { count: number; capped: boolean; error?: string } {
  const r = findAll(text, query, opts);
  return { count: r.matches.length, capped: r.truncated || r.timedOut, error: r.error };
}

/** Expand `$&`, `$1`..`$99`, `$$` in regex mode. */
function expand(m: RegExpExecArray, repl: string): string {
  if (repl.indexOf("$") < 0) return repl;
  let out = "";
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i];
    if (ch !== "$" || i + 1 >= repl.length) { out += ch; continue; }
    const d = repl[i + 1];
    if (d === "$") { out += "$"; i++; }
    else if (d === "&") { out += m[0]; i++; }
    else if (d >= "0" && d <= "9") {
      let k = i + 2, num = d.charCodeAt(0) - 48;
      if (k < repl.length && repl[k] >= "0" && repl[k] <= "9" && num * 10 + (repl.charCodeAt(k) - 48) < m.length) { num = num * 10 + (repl.charCodeAt(k) - 48); k++; }
      if (num > 0 && num < m.length) { out += m[num] ?? ""; i = k - 1; } else out += ch;
    } else out += ch;
  }
  return out;
}

/** Edits replacing every match (ascending, non-overlapping). `truncated` when the cap/time budget stopped early. */
export function replaceAllEdits(text: string, query: string, opts: SearchOptions, replacement: string): { edits: Edit[]; truncated: boolean; error?: string } {
  const c = compileQuery(query, opts);
  if ("error" in c) return { edits: [], truncated: false, error: c.error };
  const max = opts.maxMatches ?? 100000, deadline = Date.now() + (opts.timeBudgetMs ?? 250);
  const edits: Edit[] = [];
  let pos = 0, truncated = false;
  while (pos <= text.length) {
    const m = execFrom(c, text, pos, deadline);
    if (!m) { if (Date.now() > deadline) truncated = true; break; }
    edits.push({ from: m.index, to: m.index + m[0].length, text: c.regex ? expand(m, replacement) : replacement });
    if (edits.length >= max) { truncated = true; break; }
    pos = m.index + m[0].length;
  }
  return { edits, truncated };
}

/** Replace all matches as ONE transaction (one undo step). The new selection is the cursor at the first replacement end. */
export function replaceAllTransaction(buffer: TextBuffer, query: string, opts: SearchOptions, replacement: string): { transaction: Transaction | null; count: number; truncated: boolean; error?: string } {
  const r = replaceAllEdits(buffer.getText(), query, opts, replacement);
  if (!r.edits.length) return { transaction: null, count: 0, truncated: r.truncated, error: r.error };
  const first = r.edits[0];
  const p = first.from + first.text.length;
  return { transaction: { edits: r.edits, selection: single(p, p), kind: "other" }, count: r.edits.length, truncated: r.truncated };
}

/**
 * Replace-one with VS Code semantics: when the primary selection is exactly a
 * match it is replaced and the selection moves to the next match; otherwise
 * the next match is just selected (transaction without edits).
 */
export function replaceOneTransaction(buffer: TextBuffer, selection: SelectionSet, query: string, opts: SearchOptions, replacement: string): Transaction | null {
  const text = buffer.getText();
  const r = selection.ranges[selection.primary];
  const from = Math.min(r.anchor, r.head), to = Math.max(r.anchor, r.head);
  const c = compileQuery(query, opts);
  if ("error" in c) return null;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50);
  const m = from < to ? execFrom(c, text, from, deadline) : null;
  if (m && m.index === from && from + m[0].length === to) {
    const rep = c.regex ? expand(m, replacement) : replacement;
    const edit: Edit = { from, to, text: rep };
    const afterText = text.slice(0, from) + rep + text.slice(to);
    const nxt = findNext(afterText, query, opts, from + rep.length, true);
    return { edits: [edit], selection: nxt ? single(nxt.from, nxt.to) : single(from + rep.length), kind: "other" };
  }
  const nxt = findNext(text, query, opts, Math.max(from, 0), true);
  return nxt ? { edits: [], selection: single(nxt.from, nxt.to), kind: "move" } : null;
}
