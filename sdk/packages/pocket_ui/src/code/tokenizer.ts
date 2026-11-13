/**
 * Line-incremental tokenizer for TS / TSX / JS / JSX / JSON plus small CSS,
 * Markdown and plain fallbacks.
 *
 * Tokens are a flat `number[]` per line: [start, end, kind, start, end, kind...]
 * (UTF-16 columns, ascending, gaps = whitespace / default colour).
 *
 * The state at the start of a line is a short string = a stack of frames +
 * ":" + one bit "previous significant token ends an expression" (regex vs
 * divide). Frames:
 *   B  inside a block comment                T  inside template text
 *   S  inside a template `${ ... }`          X  inside a JSX `{ ... }` expression
 *   b  plain `{` nested inside S or X        J  JSX children (text) of an open element
 *   G  inside an opening tag `<Tag attrs>`   C  inside a closing tag `</Tag`
 *   D/d  JS string continued by a trailing backslash (" / ')
 *   Q/q  multi-line JSX attribute string (" / ')
 * Plain `{`/`(` at the top level are not tracked (the stack stays empty), so
 * states of ordinary code are tiny and compare cheaply. The stack depth is
 * capped at 48; deeper nesting degrades colouring but never throws.
 *
 * Limits (best effort, documented in CODE_EDITOR_CORE.md): `}` is treated as
 * "not an expression end" (a regex may follow), TypeScript type positions are
 * not parsed (`a < b > (c)` is an operator sequence), JSX is recognised when
 * `<` follows an operator/opening punctuation/`return`-like keyword and is not
 * `<T,>`/`<T extends`, ASI line breaks do not reset the regex flag.
 */

export const Kind = {
  Plain: 0, Keyword: 1, Identifier: 2, Type: 3, Number: 4, String: 5, Template: 6, Regexp: 7,
  Comment: 8, Punctuation: 9, Operator: 10, JsxTag: 11, JsxAttribute: 12, JsxText: 13,
} as const;
export type TokenKind = (typeof Kind)[keyof typeof Kind];
export const KIND_NAMES = ["plain", "keyword", "identifier", "type", "number", "string", "template", "regexp", "comment", "punctuation", "operator", "jsx-tag", "jsx-attribute", "jsx-text"] as const;

export type Language = "ts" | "tsx" | "js" | "jsx" | "json" | "css" | "md" | "plain";

/** Language for a file path by extension (unknown -> "plain"). */
export function languageForPath(path: string): Language {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts": case "mts": case "cts": return "ts";
    case "tsx": return "tsx";
    case "js": case "mjs": case "cjs": return "js";
    case "jsx": return "jsx";
    case "json": case "jsonc": return "json";
    case "css": case "scss": case "less": return "css";
    case "md": case "markdown": case "mdx": return "md";
    default: return "plain";
  }
}

export const INITIAL_STATE = ":0";
const MAX_STACK = 48;

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "async",
  "await", "of", "as", "from", "type", "interface", "implements", "namespace", "declare", "abstract", "readonly",
  "private", "protected", "public", "keyof", "satisfies", "is", "infer", "get", "set", "undefined",
  "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint",
]);
// keywords after which an expression (regex / JSX) may start
const VALUE_KEYWORDS = new Set(["this", "super", "null", "true", "false", "undefined"]);
const JSON_KEYWORDS = new Set(["true", "false", "null"]);
// contextual keywords: only coloured as keywords when not used as a name/key
const SOFT = new Set(["of", "as", "from", "type", "get", "set", "is", "static", "async", "keyof", "infer", "namespace", "declare", "abstract", "readonly", "satisfies", "interface", "implements"]);

function isSpace(c: number): boolean { return c === 32 || c === 9 || c === 13 || c === 0xa0 || c === 0xfeff || c === 0x3000 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029; }
function isIdStart(c: number): boolean { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || (c > 127 && !isSpace(c)); }
function isDigit(c: number): boolean { return c >= 48 && c <= 57; }
function isIdPart(c: number): boolean { return isIdStart(c) || isDigit(c); }
function isHex(c: number): boolean { return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) || c === 95; }

let strContinued = false;
/** Scan a JS string body starting at `i` (after the opening quote). Returns the index after the closing quote, or n. */
function scanString(t: string, i: number, q: number): number {
  const n = t.length;
  strContinued = false;
  let j = i;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 92) { if (j + 1 >= n) { strContinued = true; return n; } j += 2; continue; }
    if (c === q) return j + 1;
    j++;
  }
  return n;
}

function scanNumber(t: string, i: number): number {
  const n = t.length;
  let j = i;
  const c = t.charCodeAt(j), d = j + 1 < n ? t.charCodeAt(j + 1) | 32 : 0;
  if (c === 48 && (d === 120 || d === 98 || d === 111)) {
    j += 2;
    while (j < n && isHex(t.charCodeAt(j))) j++;
  } else {
    while (j < n && (isDigit(t.charCodeAt(j)) || t.charCodeAt(j) === 95)) j++;
    if (j < n && t.charCodeAt(j) === 46 && !(j + 1 < n && isIdStart(t.charCodeAt(j + 1)))) {
      j++;
      while (j < n && (isDigit(t.charCodeAt(j)) || t.charCodeAt(j) === 95)) j++;
    }
    if (j < n && (t.charCodeAt(j) | 32) === 101) {
      let k = j + 1;
      if (k < n && (t.charCodeAt(k) === 43 || t.charCodeAt(k) === 45)) k++;
      if (k < n && isDigit(t.charCodeAt(k))) { j = k; while (j < n && isDigit(t.charCodeAt(j))) j++; }
    }
  }
  if (j < n && t.charCodeAt(j) === 110) j++; // bigint
  return j;
}

function scanRegex(t: string, i: number): number {
  const n = t.length;
  let j = i + 1, inClass = false;
  if (j >= n) return -1;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) {
      j++;
      while (j < n) { const f = t.charCodeAt(j) | 32; if (f >= 97 && f <= 122) j++; else break; }
      return j;
    }
    j++;
  }
  return -1;
}

function isOpChar(c: number): boolean {
  // + - * % = < > ! & | ^ ~ ? :
  return c === 43 || c === 45 || c === 42 || c === 37 || c === 61 || c === 60 || c === 62 || c === 33 || c === 38 || c === 124 || c === 94 || c === 126 || c === 63 || c === 58;
}

function pascalOrType(w: string): boolean {
  const c = w.charCodeAt(0);
  if (c < 65 || c > 90) return false;
  if (w.length === 1) return true;
  for (let k = 1; k < w.length; k++) { const d = w.charCodeAt(k); if (d >= 97 && d <= 122) return true; }
  return false;
}

/** Is `<` at `i` the start of a JSX element (as opposed to a comparison / generic)? */
function looksLikeJsx(t: string, i: number): boolean {
  const n = t.length;
  if (i + 1 >= n) return false;
  const c = t.charCodeAt(i + 1);
  if (c === 62) return true; // fragment <>
  if (!isIdStart(c)) return false;
  let j = i + 1;
  while (j < n && (isIdPart(t.charCodeAt(j)) || t.charCodeAt(j) === 46 || t.charCodeAt(j) === 45 || t.charCodeAt(j) === 58)) j++;
  let k = j;
  while (k < n && isSpace(t.charCodeAt(k))) k++;
  if (k < n && t.charCodeAt(k) === 44) return false; // <T,>
  if (t.startsWith("extends", k) && k + 7 < n && isSpace(t.charCodeAt(k + 7)) && k > j) return false; // <T extends X>
  return true;
}

function top(stack: string): number { return stack.length ? stack.charCodeAt(stack.length - 1) : 0; }
const CH = (s: string) => s.charCodeAt(0);
const cB = CH("B"), cT = CH("T"), cS = CH("S"), cX = CH("X"), cb = CH("b"), cJ = CH("J"), cG = CH("G"), cC = CH("C"), cD = CH("D"), cd = CH("d"), cQ = CH("Q"), cq = CH("q");

/**
 * Tokenize one JS-family line. Appends [start,end,kind] triples to `out` and
 * returns the end state. Never throws.
 */
export function tokenizeCodeLine(lang: Language, t: string, state: string, out: number[]): string {
  const n = t.length;
  const jsx = lang === "tsx" || lang === "jsx" || lang === "js";
  const json = lang === "json";
  const kw = json ? JSON_KEYWORDS : KEYWORDS;
  const sp = state.length - 2;
  let stack = sp > 0 ? state.slice(0, sp) : "";
  let exprEnd = state.charCodeAt(state.length - 1) === 49;
  let i = 0;
  let carry = -1;       // start of a template token begun by the opening backtick
  let expectName = false; // first identifier after `<` in a tag is the tag name

  while (i < n) {
    const tp = top(stack);
    // ---- block comment -----------------------------------------------
    if (tp === cB) {
      const e = t.indexOf("*/", i);
      if (e < 0) { out.push(i, n, Kind.Comment); i = n; break; }
      out.push(i, e + 2, Kind.Comment); i = e + 2; stack = stack.slice(0, -1); continue;
    }
    // ---- template text -----------------------------------------------
    if (tp === cT) {
      const s = carry >= 0 ? carry : i; carry = -1;
      let j = i, done = false;
      while (j < n) {
        const c = t.charCodeAt(j);
        if (c === 92) { j += 2; continue; }
        if (c === 96) { out.push(s, j + 1, Kind.Template); i = j + 1; stack = stack.slice(0, -1); exprEnd = true; done = true; break; }
        if (c === 36 && j + 1 < n && t.charCodeAt(j + 1) === 123) {
          if (j > s) out.push(s, j, Kind.Template);
          out.push(j, j + 2, Kind.Punctuation);
          i = j + 2; if (stack.length < MAX_STACK) stack += "S"; exprEnd = false; done = true; break;
        }
        j++;
      }
      if (!done) { if (n > s) out.push(s, n, Kind.Template); i = n; }
      continue;
    }
    // ---- continued JS string / multi-line JSX attr string --------------
    if (tp === cD || tp === cd || tp === cQ || tp === cq) {
      const q = tp === cD || tp === cQ ? 34 : 39;
      if (tp === cD || tp === cd) {
        const e = scanString(t, i, q);
        out.push(i, e, Kind.String);
        i = e; stack = stack.slice(0, -1);
        if (strContinued) { stack += tp === cD ? "D" : "d"; }
      } else {
        const e = t.indexOf(String.fromCharCode(q), i);
        if (e < 0) { out.push(i, n, Kind.String); i = n; break; }
        out.push(i, e + 1, Kind.String); i = e + 1; stack = stack.slice(0, -1);
      }
      continue;
    }
    // ---- JSX children text -------------------------------------------
    if (tp === cJ) {
      let j = i;
      while (j < n) { const c = t.charCodeAt(j); if (c === 60 || c === 123) break; j++; }
      if (j > i) {
        let k = i; while (k < j && isSpace(t.charCodeAt(k))) k++;
        if (k < j) { let e = j; while (e > k && isSpace(t.charCodeAt(e - 1))) e--; out.push(k, e, Kind.JsxText); }
        i = j; if (i >= n) break;
      }
      const c = t.charCodeAt(i);
      if (c === 123) { out.push(i, i + 1, Kind.Punctuation); i++; if (stack.length < MAX_STACK) stack += "X"; exprEnd = false; continue; }
      // '<'
      if (i + 1 < n && t.charCodeAt(i + 1) === 47) {
        out.push(i, i + 2, Kind.JsxTag); i += 2;
        stack = stack.slice(0, -1);
        if (stack.length < MAX_STACK) stack += "C";
      } else {
        out.push(i, i + 1, Kind.JsxTag); i++;
        if (stack.length < MAX_STACK) stack += "G";
        expectName = true;
      }
      continue;
    }
    // ---- inside tags -----------------------------------------------------
    if (tp === cG || tp === cC) {
      const c = t.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (tp === cC) {
        if (c === 62) { out.push(i, i + 1, Kind.JsxTag); i++; stack = stack.slice(0, -1); if (top(stack) !== cJ) exprEnd = true; continue; }
        if (isIdPart(c) || c === 46 || c === 58 || c === 45) {
          let j = i + 1; while (j < n && (isIdPart(t.charCodeAt(j)) || t.charCodeAt(j) === 46 || t.charCodeAt(j) === 58 || t.charCodeAt(j) === 45)) j++;
          out.push(i, j, Kind.JsxTag); i = j; continue;
        }
        out.push(i, i + 1, Kind.Plain); i++; continue;
      }
      // opening tag
      if (c === 62) { out.push(i, i + 1, Kind.JsxTag); i++; stack = stack.slice(0, -1); if (stack.length < MAX_STACK) stack += "J"; expectName = false; continue; }
      if (c === 47 && i + 1 < n && t.charCodeAt(i + 1) === 62) {
        out.push(i, i + 2, Kind.JsxTag); i += 2; stack = stack.slice(0, -1); expectName = false;
        if (top(stack) !== cJ) exprEnd = true;
        continue;
      }
      if (c === 123) { out.push(i, i + 1, Kind.Punctuation); i++; if (stack.length < MAX_STACK) stack += "X"; exprEnd = false; continue; }
      if (c === 61) { out.push(i, i + 1, Kind.Operator); i++; continue; }
      if (c === 34 || c === 39) {
        const e = t.indexOf(String.fromCharCode(c), i + 1);
        if (e < 0) { out.push(i, n, Kind.String); i = n; if (stack.length < MAX_STACK) stack += c === 34 ? "Q" : "q"; break; }
        out.push(i, e + 1, Kind.String); i = e + 1; continue;
      }
      if (isIdPart(c) || c === 46 || c === 58 || c === 45) {
        let j = i + 1; while (j < n && (isIdPart(t.charCodeAt(j)) || t.charCodeAt(j) === 46 || t.charCodeAt(j) === 58 || t.charCodeAt(j) === 45)) j++;
        out.push(i, j, expectName ? Kind.JsxTag : Kind.JsxAttribute); expectName = false; i = j; continue;
      }
      out.push(i, i + 1, Kind.Plain); i++; continue;
    }

    // ---- ordinary code ---------------------------------------------------
    const c = t.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 47) { // '/'
      const d = i + 1 < n ? t.charCodeAt(i + 1) : 0;
      if (d === 47) { out.push(i, n, Kind.Comment); i = n; break; }
      if (d === 42) {
        const e = t.indexOf("*/", i + 2);
        if (e < 0) { out.push(i, n, Kind.Comment); i = n; if (stack.length < MAX_STACK) stack += "B"; break; }
        out.push(i, e + 2, Kind.Comment); i = e + 2; continue;
      }
      if (!exprEnd && !json) {
        const e = scanRegex(t, i);
        if (e > 0) { out.push(i, e, Kind.Regexp); i = e; exprEnd = true; continue; }
      }
      const e = d === 61 ? i + 2 : i + 1;
      out.push(i, e, Kind.Operator); i = e; exprEnd = false; continue;
    }
    if (isDigit(c) || (c === 46 && i + 1 < n && isDigit(t.charCodeAt(i + 1)))) {
      const e = c === 46 ? scanNumber(t, i + 1) : scanNumber(t, i);
      out.push(i, e, Kind.Number); i = e; exprEnd = true; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isIdPart(t.charCodeAt(j))) j++;
      const w = t.slice(i, j);
      const afterDot = i > 0 && t.charCodeAt(i - 1) === 46 && !(i > 1 && t.charCodeAt(i - 2) === 46);
      let isKw = !afterDot && kw.has(w);
      if (isKw && SOFT.has(w)) {
        let k = j; while (k < n && isSpace(t.charCodeAt(k))) k++;
        const nc = k < n ? t.charCodeAt(k) : 0;
        // `{ type: 1 }`, `f(type)`, `type = x`, `a.set(...)`: a name, not a keyword
        if (nc === 58 || nc === 44 || nc === 41 || nc === 61 || nc === 59 || nc === 46 || nc === 0 || nc === 125) isKw = false;
      }
      if (isKw) {
        out.push(i, j, Kind.Keyword);
        exprEnd = VALUE_KEYWORDS.has(w);
      } else {
        out.push(i, j, json ? Kind.Plain : pascalOrType(w) ? Kind.Type : Kind.Identifier);
        exprEnd = true;
      }
      i = j; continue;
    }
    if (c === 34 || c === 39) {
      const e = scanString(t, i + 1, c);
      out.push(i, e, Kind.String); i = e; exprEnd = true;
      if (strContinued && stack.length < MAX_STACK) stack += c === 34 ? "D" : "d";
      continue;
    }
    if (c === 96 && !json) { carry = i; i++; if (stack.length < MAX_STACK) stack += "T"; continue; }
    if (c === 123) { out.push(i, i + 1, Kind.Punctuation); i++; if (stack.length && stack.length < MAX_STACK) stack += "b"; exprEnd = false; continue; }
    if (c === 125) {
      out.push(i, i + 1, Kind.Punctuation); i++;
      const p = top(stack);
      if (p === cb || p === cS || p === cX) stack = stack.slice(0, -1);
      exprEnd = false; continue;
    }
    if (c === 40 || c === 91 || c === 59 || c === 44) { out.push(i, i + 1, Kind.Punctuation); i++; exprEnd = false; continue; }
    if (c === 41 || c === 93) { out.push(i, i + 1, Kind.Punctuation); i++; exprEnd = true; continue; }
    if (c === 46) {
      const e = t.startsWith("...", i) ? i + 3 : i + 1;
      out.push(i, e, Kind.Punctuation); i = e; exprEnd = false; continue;
    }
    if (c === 60 && jsx && !exprEnd && looksLikeJsx(t, i)) {
      out.push(i, i + 1, Kind.JsxTag); i++;
      if (stack.length < MAX_STACK) stack += "G";
      expectName = true; continue;
    }
    if (isOpChar(c)) {
      if (c === 63 && i + 1 < n && t.charCodeAt(i + 1) === 46 && !(i + 2 < n && isDigit(t.charCodeAt(i + 2)))) {
        out.push(i, i + 2, Kind.Punctuation); i += 2; exprEnd = false; continue;
      }
      let j = i + 1;
      while (j < n && j - i < 4 && isOpChar(t.charCodeAt(j))) {
        const d = t.charCodeAt(j);
        if (d === 60 && t.charCodeAt(j - 1) !== 60) break;
        j++;
      }
      const pp = t.charCodeAt(i), qq = j - i === 2 ? t.charCodeAt(i + 1) : 0;
      const incdec = j - i === 2 && qq === pp && (pp === 43 || pp === 45);
      out.push(i, j, Kind.Operator); i = j;
      if (!incdec) exprEnd = false;
      continue;
    }
    if (c === 64 || c === 35) { out.push(i, i + 1, Kind.Punctuation); i++; continue; }
    out.push(i, i + 1, Kind.Plain); i++;
  }
  return stack + (exprEnd ? ":1" : ":0");
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function tokenizeCssLine(t: string, state: string, out: number[]): string {
  const n = t.length;
  // state: "" | "B<depth>" | "<depth>" encoded as "B3" / "3"
  let inComment = state.charCodeAt(0) === 66;
  let depth = parseInt(inComment ? state.slice(1) : state, 10) || 0;
  let i = 0;
  while (i < n) {
    if (inComment) {
      const e = t.indexOf("*/", i);
      if (e < 0) { out.push(i, n, Kind.Comment); i = n; break; }
      out.push(i, e + 2, Kind.Comment); i = e + 2; inComment = false; continue;
    }
    const c = t.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 47 && t.charCodeAt(i + 1) === 42) {
      const e = t.indexOf("*/", i + 2);
      if (e < 0) { out.push(i, n, Kind.Comment); i = n; inComment = true; break; }
      out.push(i, e + 2, Kind.Comment); i = e + 2; continue;
    }
    if (c === 34 || c === 39) { const e = scanString(t, i + 1, c); out.push(i, e, Kind.String); i = e; continue; }
    if (c === 123) { depth++; out.push(i, i + 1, Kind.Punctuation); i++; continue; }
    if (c === 125) { if (depth > 0) depth--; out.push(i, i + 1, Kind.Punctuation); i++; continue; }
    if (c === 58 || c === 59 || c === 44 || c === 40 || c === 41 || c === 62 || c === 43 || c === 126 || c === 42 || c === 91 || c === 93 || c === 61) { out.push(i, i + 1, Kind.Punctuation); i++; continue; }
    if (c === 64) { let j = i + 1; while (j < n && (isIdPart(t.charCodeAt(j)) || t.charCodeAt(j) === 45)) j++; out.push(i, j, Kind.Keyword); i = j; continue; }
    if (c === 33) { let j = i + 1; while (j < n && isIdPart(t.charCodeAt(j))) j++; out.push(i, j, Kind.Keyword); i = j; continue; }
    if (c === 35 && depth > 0) {
      let j = i + 1; while (j < n && isHex(t.charCodeAt(j))) j++;
      out.push(i, j, j - i >= 4 ? Kind.Number : Kind.Plain); i = j; continue;
    }
    if (isDigit(c) || ((c === 45 || c === 46) && i + 1 < n && (isDigit(t.charCodeAt(i + 1)) || t.charCodeAt(i + 1) === 46))) {
      let j = i + 1;
      while (j < n && (isDigit(t.charCodeAt(j)) || t.charCodeAt(j) === 46)) j++;
      while (j < n && ((t.charCodeAt(j) | 32) >= 97 && (t.charCodeAt(j) | 32) <= 122 || t.charCodeAt(j) === 37)) j++;
      out.push(i, j, Kind.Number); i = j; continue;
    }
    if (c === 46 || c === 35 || isIdStart(c) || c === 45) {
      let j = i + 1; while (j < n && (isIdPart(t.charCodeAt(j)) || t.charCodeAt(j) === 45)) j++;
      let kind: number;
      if (depth === 0) kind = Kind.Type;
      else { let k = j; while (k < n && isSpace(t.charCodeAt(k))) k++; kind = t.charCodeAt(k) === 58 ? Kind.Identifier : Kind.Plain; }
      out.push(i, j, kind); i = j; continue;
    }
    out.push(i, i + 1, Kind.Plain); i++;
  }
  return inComment ? "B" + depth : depth ? String(depth) : "";
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function tokenizeMdLine(t: string, state: string, out: number[]): string {
  const n = t.length;
  let k = 0; while (k < n && isSpace(t.charCodeAt(k))) k++;
  if (k >= n) return state;
  const fence = t.startsWith("```", k) || t.startsWith("~~~", k);
  if (state === "F") {
    if (fence) { out.push(k, n, Kind.Punctuation); return ""; }
    out.push(k, n, Kind.String); return "F";
  }
  if (fence) { out.push(k, n, Kind.Punctuation); return "F"; }
  const c = t.charCodeAt(k);
  if (c === 35) { let h = k; while (h < n && t.charCodeAt(h) === 35) h++; if (h - k <= 6 && (h >= n || isSpace(t.charCodeAt(h)))) { out.push(k, n, Kind.Keyword); return ""; } }
  if (c === 62) { out.push(k, n, Kind.Comment); return ""; }
  let i = k;
  if ((c === 45 || c === 42 || c === 43) && k + 1 < n && t.charCodeAt(k + 1) === 32) { out.push(k, k + 1, Kind.Punctuation); i = k + 2; }
  else if (isDigit(c)) { let j = k; while (j < n && isDigit(t.charCodeAt(j))) j++; if (t.charCodeAt(j) === 46 && j + 1 < n && t.charCodeAt(j + 1) === 32) { out.push(k, j + 1, Kind.Punctuation); i = j + 2; } }
  while (i < n) {
    const d = t.charCodeAt(i);
    if (d === 96) {
      const e = t.indexOf("`", i + 1);
      if (e > 0) { out.push(i, e + 1, Kind.String); i = e + 1; continue; }
    } else if (d === 42 && t.charCodeAt(i + 1) === 42) {
      const e = t.indexOf("**", i + 2);
      if (e > 0) { out.push(i, e + 2, Kind.Keyword); i = e + 2; continue; }
    } else if (d === 91) {
      const e = t.indexOf("](", i + 1);
      if (e > 0) { const e2 = t.indexOf(")", e + 2); if (e2 > 0) { out.push(i, e2 + 1, Kind.Type); i = e2 + 1; continue; } }
    }
    i++;
  }
  return "";
}

/** Tokenize one line for any language. Appends triples to `out`; returns the end state. */
export function tokenizeLine(lang: Language, text: string, state: string, out: number[]): string {
  switch (lang) {
    case "css": return tokenizeCssLine(text, state, out);
    case "md": return tokenizeMdLine(text, state, out);
    case "plain": return "";
    default: return tokenizeCodeLine(lang, text, state.length >= 2 ? state : INITIAL_STATE, out);
  }
}

/** Start state of the first line for a language. */
export function initialState(lang: Language): string { return lang === "css" || lang === "md" || lang === "plain" ? "" : INITIAL_STATE; }

// ---------------------------------------------------------------------------
// Incremental cache
// ---------------------------------------------------------------------------

export interface LineChange { startLine: number; oldLineCount: number; newLineCount: number }

/**
 * Per-line token cache. `update` re-tokenizes from the first changed line and
 * stops once a line's end state equals the stored start state of the next
 * (already tokenized) line.
 */
export class TokenCache {
  states: string[] = [];
  tokens: number[][] = [];
  /** Lines re-tokenized by the last `reset`/`update`/`advance` (for tests/benchmarks). */
  lastRetokenized = 0;
  /** Lines [0, valid) are tokenized; later lines are `undefined` until `advance` reaches them (uncoloured meanwhile). */
  valid = 0;
  private lineTotal = 0;
  private detach: (() => void) | null = null;

  constructor(readonly lang: Language) {}

  /** True while some lines are not tokenized yet (only after a budgeted `reset`). */
  get pending(): boolean { return this.valid < this.lineTotal; }

  /**
   * Tokenize from the first line. With `budgetMs` it stops once that wall time is used (the guest runs every turn
   * under a 250 ms interrupt budget, and a multi-thousand-line file can exceed it); call `advance` in later turns.
   */
  reset(lineCount: number, getLine: (i: number) => string, budgetMs = Infinity): void {
    const init = initialState(this.lang);
    this.states = new Array(lineCount + 1);
    this.tokens = new Array(lineCount);
    this.states[0] = init;
    this.valid = 0;
    this.lineTotal = lineCount;
    this.advance(getLine, budgetMs);
  }

  /** Continue tokenizing where the last call stopped, for at most `budgetMs`. Returns true while lines remain. */
  advance(getLine: (i: number) => string, budgetMs = Infinity): boolean {
    const t0 = budgetMs === Infinity ? 0 : Date.now();
    let st = this.states[this.valid]!;
    let i = this.valid;
    for (; i < this.lineTotal; i++) {
      const out: number[] = [];
      st = tokenizeLine(this.lang, getLine(i), st, out);
      this.tokens[i] = out;
      this.states[i + 1] = st;
      if (budgetMs !== Infinity && (i & 15) === 15 && Date.now() - t0 >= budgetMs) { i++; break; }
    }
    this.lastRetokenized = i - this.valid;
    this.valid = i;
    return this.pending;
  }

  /** Tokens of a line: flat [start,end,kind,...]; undefined while the line is not tokenized yet. */
  line(i: number): number[] { return this.tokens[i]; }
  /** Start state of line `i` (index lineCount = end state of the document). */
  stateAt(i: number): string { return this.states[i]; }

  update(change: LineChange, lineCount: number, getLine: (i: number) => string): void {
    const s = change.startLine, o = change.oldLineCount, nn = change.newLineCount;
    this.lineTotal = lineCount;
    if (s >= this.valid) {
      // The edit is past the tokenized prefix: keep the arrays aligned and let `advance` get there.
      this.states.splice(s + 1, o, ...new Array(nn));
      this.tokens.splice(s, o, ...new Array(nn));
      this.lastRetokenized = 0;
      return;
    }
    const newValid = s + o <= this.valid ? this.valid + nn - o : s + nn;
    // states of lines s+1..s+o-1 go away; s+1..s+nn-1 are placeholders; states[s+o] (next untouched start) is kept
    const placeholders = new Array(Math.max(nn - 1, 0)).fill("");
    this.states.splice(s + 1, Math.max(o - 1, 0), ...placeholders);
    const empties: number[][] = new Array(nn);
    for (let k = 0; k < nn; k++) empties[k] = [];
    this.tokens.splice(s, o, ...empties);
    this.valid = newValid;
    let count = 0;
    for (let i = s; i < newValid; i++) {
      const out: number[] = [];
      const end = tokenizeLine(this.lang, getLine(i), this.states[i], out);
      this.tokens[i] = out;
      count++;
      if (i >= s + nn - 1) {
        const stable = this.states[i + 1] === end;
        this.states[i + 1] = end;
        if (stable) break;
      } else this.states[i + 1] = end;
    }
    this.lastRetokenized = count;
  }

  /** Keep the cache in sync with a TextBuffer-like source. Returns a detach function. */
  attach(buffer: { lineCount: number; line(i: number): string; onChange(l: (c: LineChange) => void): () => void }, budgetMs = Infinity): () => void {
    this.reset(buffer.lineCount, i => buffer.line(i), budgetMs);
    this.detach?.();
    const off = buffer.onChange(c => this.update(c, buffer.lineCount, i => buffer.line(i)));
    this.detach = off;
    return off;
  }
}
