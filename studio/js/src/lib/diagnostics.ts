export interface Diagnostic { file: string; line: number; column: number; severity: "error" | "warning"; message: string }

/** Accepts the service's `diagnostics` array (project-relative files) and drops anything malformed. */
export function normalizeDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.message !== "string" || !r.message) continue;
    const file = typeof r.file === "string" ? r.file : "";
    const line = typeof r.line === "number" && Number.isFinite(r.line) && r.line >= 1 ? Math.floor(r.line) : 1;
    const column = typeof r.column === "number" && Number.isFinite(r.column) && r.column >= 1 ? Math.floor(r.column) : 1;
    const severity = r.severity === "warning" ? "warning" : "error";
    const key = `${file}:${line}:${column}:${r.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, column, severity, message: r.message });
    if (out.length >= 200) break;
  }
  return out;
}

/** A few source lines around `line` (1-based) for the editor's jump banner. */
export function excerpt(text: string, line: number, radius = 1): { number: number; text: string }[] {
  const lines = text.split("\n");
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out: { number: number; text: string }[] = [];
  for (let n = from; n <= to; n += 1) out.push({ number: n, text: (lines[n - 1] ?? "").slice(0, 160) });
  return out;
}
