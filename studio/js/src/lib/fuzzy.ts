// Fuzzy file matching for quick-open. Pure.
import { basename } from "./path.ts";

export interface FuzzyMatch { path: string; score: number; /** Indices into `path` of the matched characters. */ positions: number[] }

/**
 * Subsequence match of `query` (case-insensitive, spaces ignored) against `path`.
 * Bonuses: consecutive characters, matches at a word start (after / . _ - or a camelCase hump), matches inside the
 * file name rather than the folders, and shorter paths. Returns undefined when `query` is not a subsequence.
 */
export function fuzzyScore(path: string, query: string): FuzzyMatch | undefined {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.length - basename(path).length;
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    // Prefer a word-start occurrence over the first occurrence when both exist ahead.
    let at = lower.indexOf(ch, from);
    if (at < 0) return undefined;
    for (let probe = at; probe >= 0; probe = lower.indexOf(ch, probe + 1)) {
      if (isWordStart(path, probe) || probe === previous + 1) { at = probe; break; }
    }
    let gain = 1;
    if (at === previous + 1) gain += 5; // consecutive
    if (isWordStart(path, at)) gain += 4;
    if (at >= nameStart) gain += 2; // inside the file name
    score += gain;
    positions.push(at);
    previous = at;
    from = at + 1;
  }
  const exactName = basename(path).toLowerCase().startsWith(q);
  if (exactName) score += 8;
  score -= Math.min(10, Math.floor(path.length / 16)); // shorter paths first on ties
  return { path, score, positions };
}

function isWordStart(path: string, at: number): boolean {
  if (at === 0) return true;
  const prev = path[at - 1]!;
  if (prev === "/" || prev === "." || prev === "_" || prev === "-" || prev === " ") return true;
  const ch = path[at]!;
  return prev >= "a" && prev <= "z" && ch >= "A" && ch <= "Z";
}

/**
 * Ranked matches. An empty query lists `recent` paths first (most recent first), then the rest alphabetically.
 */
export function fuzzyFilter(paths: readonly string[], query: string, options: { limit?: number; recent?: readonly string[] } = {}): FuzzyMatch[] {
  const limit = options.limit ?? 50;
  if (!query.trim()) {
    const known = new Set(paths);
    const recent = (options.recent ?? []).filter((p) => known.has(p));
    const seen = new Set(recent);
    const rest = paths.filter((p) => !seen.has(p)).sort((a, b) => a.localeCompare(b));
    return [...recent, ...rest].slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  }
  const out: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = fuzzyScore(path, query);
    if (match) out.push(match);
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}
