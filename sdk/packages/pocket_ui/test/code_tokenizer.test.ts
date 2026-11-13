import { expect, test } from "bun:test";
import { Kind, KIND_NAMES, TextBuffer, TokenCache, tokenizeLine, initialState, languageForPath, lightTheme, darkTheme, colorFor, type Language } from "../src/code/index.ts";
import { TSX_SAMPLE, buildCorpus } from "./code_corpus.ts";

/** Tokenize a whole text; returns [text, kindName] pairs per line plus end state. */
function tok(lang: Language, text: string) {
  const lines = text.split("\n");
  let st = initialState(lang);
  const rows: [string, string][][] = [];
  for (const l of lines) {
    const out: number[] = [];
    st = tokenizeLine(lang, l, st, out);
    const row: [string, string][] = [];
    for (let i = 0; i < out.length; i += 3) row.push([l.slice(out[i], out[i + 1]), KIND_NAMES[out[i + 2]]]);
    rows.push(row);
  }
  return { rows, state: st };
}
const flat = (lang: Language, text: string) => tok(lang, text).rows.flat();
const kindOf = (lang: Language, text: string, needle: string) => flat(lang, text).find(([t]) => t === needle)?.[1];

test("languageForPath", () => {
  expect(languageForPath("a/b.tsx")).toBe("tsx");
  expect(languageForPath("x.test.ts")).toBe("ts");
  expect(languageForPath("pocket.json")).toBe("json");
  expect(languageForPath("README.md")).toBe("md");
  expect(languageForPath("noext")).toBe("plain");
  expect(languageForPath("a.CSS")).toBe("css");
});

test("basic kinds", () => {
  const r = flat("ts", "const Foo = new Bar(12, 'x', \"y\") + a.b; // note");
  expect(r).toContainEqual(["const", "keyword"]);
  expect(r).toContainEqual(["Foo", "type"]);
  expect(r).toContainEqual(["new", "keyword"]);
  expect(r).toContainEqual(["12", "number"]);
  expect(r).toContainEqual(["'x'", "string"]);
  expect(r).toContainEqual(["\"y\"", "string"]);
  expect(r).toContainEqual(["+", "operator"]);
  expect(r).toContainEqual(["a", "identifier"]);
  expect(r).toContainEqual(["(", "punctuation"]);
  expect(r).toContainEqual(["// note", "comment"]);
  expect(kindOf("ts", "const FOO = 1", "FOO")).toBe("identifier"); // ALL_CAPS is not type-ish
  expect(kindOf("ts", "let x: T", "T")).toBe("type");
  expect(kindOf("ts", "a.default", "default")).toBe("identifier");
  expect(kindOf("ts", "({ type: 1 })", "type")).toBe("identifier");
  expect(kindOf("ts", "type X = 1", "type")).toBe("keyword");
});

test("numbers", () => {
  for (const n of ["0xFF_ff", "1_000", ".5", "1.5e-3", "10n", "0b101", "3."]) expect(flat("ts", `x = ${n};`)).toContainEqual([n, "number"]);
});

test("block comments across lines, unterminated", () => {
  const { rows, state } = tok("ts", "a /* x\nstill\nend */ b\n/* open");
  expect(rows[1]).toEqual([["still", "comment"]]);
  expect(rows[2]).toEqual([["end */", "comment"], ["b", "identifier"]]);
  expect(state.startsWith("B")).toBe(true);
});

test("regex vs divide", () => {
  expect(kindOf("ts", "x = /ab+c/gi.test(s)", "/ab+c/gi")).toBe("regexp");
  expect(kindOf("ts", "return /[/]x/", "/[/]x/")).toBe("regexp");
  expect(flat("ts", "a / b / c").filter(t => t[1] === "regexp")).toHaveLength(0);
  expect(flat("ts", "(a) / 2 / 3").filter(t => t[1] === "regexp")).toHaveLength(0);
  expect(flat("ts", "x[1] / 2 / y").filter(t => t[1] === "regexp")).toHaveLength(0);
  expect(flat("ts", "f(/x/)")).toContainEqual(["/x/", "regexp"]);
  expect(flat("ts", "i++ / 2 / 3").filter(t => t[1] === "regexp")).toHaveLength(0);
  expect(flat("ts", "x = a /unterminated").filter(t => t[1] === "regexp")).toHaveLength(0);
  expect(flat("ts", "x = /unterminated").filter(t => t[1] === "regexp")).toHaveLength(0);
  // regex flag carried across a line break
  const { rows } = tok("ts", "const r =\n  /a/g;");
  expect(rows[1]).toContainEqual(["/a/g", "regexp"]);
});

test("template literals with nesting and multi-line", () => {
  const src = "const s = `a ${ b + `x ${ c } y` } z`;";
  const { rows, state } = tok("ts", src);
  expect(state).toBe(":0".replace(":0", ":0"));
  const r = rows[0];
  expect(r.filter(t => t[1] === "template").map(t => t[0])).toEqual(["`a ", "`x ", " y`", " z`"]);
  expect(r).toContainEqual(["${", "punctuation"]);
  expect(r).toContainEqual(["c", "identifier"]);
  const ml = tok("ts", "x = `line1\nline2 ${ f({a:1}) } end\n`;");
  expect(ml.rows[1][0]).toEqual(["line2 ", "template"]);
  expect(ml.rows[1]).toContainEqual(["a", "identifier"]);
  expect(ml.rows[1].filter(t => t[1] === "template").pop()).toEqual([" end", "template"]);
  expect(ml.rows[2][0]).toEqual(["`", "template"]);
  expect(ml.state).toBe(":0");
  // unterminated template never throws and stays open
  expect(tok("ts", "x = `abc").state.startsWith("T")).toBe(true);
  expect(tok("ts", "x = `a ${").state.startsWith("TS")).toBe(true);
});

test("strings: unterminated, escapes, backslash continuation", () => {
  const u = tok("ts", "x = 'abc\ny = 1");
  expect(u.rows[0].pop()).toEqual(["'abc", "string"]);
  expect(u.rows[1]).toContainEqual(["y", "identifier"]);
  const c = tok("ts", "x = 'abc\\\ndef' + 1");
  expect(c.rows[1][0]).toEqual(["def'", "string"]);
  expect(c.rows[1]).toContainEqual(["1", "number"]);
  expect(flat("ts", "'a\\'b'")).toEqual([["'a\\'b'", "string"]]);
});

test("JSX: tags, attributes, text, expressions, nesting, fragments", () => {
  const src = "const a = (\n  <div class=\"x\" id={y}>\n    Hello {name} it's\n    <b>bold</b>\n    <Foo.Bar baz='q' />\n  </div>\n);\nconst z = 1 < 2;";
  const { rows, state } = tok("tsx", src);
  expect(rows[1]).toEqual([["<", "jsx-tag"], ["div", "jsx-tag"], ["class", "jsx-attribute"], ["=", "operator"], ["\"x\"", "string"], ["id", "jsx-attribute"], ["=", "operator"], ["{", "punctuation"], ["y", "identifier"], ["}", "punctuation"], [">", "jsx-tag"]]);
  expect(rows[2]).toEqual([["Hello", "jsx-text"], ["{", "punctuation"], ["name", "identifier"], ["}", "punctuation"], ["it's", "jsx-text"]]);
  expect(rows[3]).toEqual([["<", "jsx-tag"], ["b", "jsx-tag"], [">", "jsx-tag"], ["bold", "jsx-text"], ["</", "jsx-tag"], ["b", "jsx-tag"], [">", "jsx-tag"]]);
  expect(rows[4]).toEqual([["<", "jsx-tag"], ["Foo.Bar", "jsx-tag"], ["baz", "jsx-attribute"], ["=", "operator"], ["'q'", "string"], ["/>", "jsx-tag"]]);
  expect(rows[5]).toEqual([["</", "jsx-tag"], ["div", "jsx-tag"], [">", "jsx-tag"]]);
  expect(rows[6]).toEqual([[")", "punctuation"], [";", "punctuation"]]);
  expect(rows[7]).toContainEqual(["<", "operator"]);
  expect(state).toBe(":0");
  // after return / => / && / ? :
  for (const pre of ["return ", "f = () => ", "ok && ", "c ? ", "x = (", "[", "f(a, "]) {
    expect(flat("tsx", pre + "<i>t</i>")).toContainEqual(["<", "jsx-tag"]);
  }
  // fragments
  const fr = flat("tsx", "x = <><a/></>");
  expect(fr.filter(t => t[1] === "jsx-tag").map(t => t[0])).toEqual(["<", ">", "<", "a", "/>", "</", ">"]);
  // JSX in .ts files is not recognised
  expect(flat("ts", "x = <div>")).not.toContainEqual(["<", "jsx-tag"]);
  // comparison and generic call are operators
  expect(flat("tsx", "if (a < b) {}")).toContainEqual(["<", "operator"]);
  expect(flat("tsx", "useState<Foo | null>(null)")).toContainEqual(["<", "operator"]);
  // JSX inside a JSX expression container, `//` and quotes in text
  const nested = tok("tsx", "x = <ul>{items.map(i => <li key={i}>a // b 'c'</li>)}</ul>;");
  expect(nested.rows[0]).toContainEqual(["a // b 'c'", "jsx-text"]);
  expect(nested.state).toBe(":0");
});

test("JSX: multi-line tag with attribute strings and expressions", () => {
  const { rows, state } = tok("tsx", "y = <A\n  s=\"two\n  lines\"\n  f={() => 1}\n/>;");
  expect(rows[1].pop()).toEqual(["\"two", "string"]);
  expect(rows[2]).toEqual([["  lines\"", "string"]]);
  expect(rows[3]).toContainEqual(["f", "jsx-attribute"]);
  expect(rows[4]).toEqual([["/>", "jsx-tag"], [";", "punctuation"]]);
  expect(state).toBe(":0");
});

test("generics <T,> and <T extends> are not JSX", () => {
  expect(flat("tsx", "const f = <T,>(x: T) => x;")).not.toContainEqual(["<", "jsx-tag"]);
  expect(flat("tsx", "const g = <T extends object>(x: T) => x;")).not.toContainEqual(["<", "jsx-tag"]);
});

test("unterminated constructs never throw", () => {
  for (const lang of ["ts", "tsx", "json", "css", "md", "plain"] as Language[]) {
    for (const src of ["`${`${", "<a b={`", "/*", "'\\", "\"", "x = /[", "<<<>>>/>", "}}}}{{", "<div>{<a>{", "@#\\\u0000\uD800", "<", "</", "<a", "<a b=", "a ? . b", "\\"]) {
      expect(() => tok(lang, src + "\n" + src)).not.toThrow();
    }
  }
  // deep nesting is capped
  const deep = "`${".repeat(200);
  expect(tok("ts", deep).state.length).toBeLessThan(80);
});

test("JSON, CSS, Markdown, plain fallbacks", () => {
  const j = flat("json", '{"a": [1, -2.5e3, true, null, "x"]}');
  expect(j).toContainEqual(['"a"', "string"]);
  expect(j).toContainEqual(["true", "keyword"]);
  expect(j).toContainEqual(["null", "keyword"]);
  expect(j).toContainEqual(["1", "number"]);
  expect(flat("json", "{ /* c */ }")).toContainEqual(["/* c */", "comment"]);
  const css = tok("css", "/* c\nd */\n.a:hover, #b > p {\n  color: #fff; margin: -4px 10%;\n  content: 'x' !important;\n}\n@media (x) {}");
  expect(css.rows[0]).toEqual([["/* c", "comment"]]);
  expect(css.rows[1]).toEqual([["d */", "comment"]]);
  expect(css.rows[2]).toContainEqual(["hover", "type"]);
  expect(css.rows[3]).toContainEqual(["color", "identifier"]);
  expect(css.rows[3]).toContainEqual(["#fff", "number"]);
  expect(css.rows[3]).toContainEqual(["-4px", "number"]);
  expect(css.rows[3]).toContainEqual(["10%", "number"]);
  expect(css.rows[4]).toContainEqual(["!important", "keyword"]);
  expect(css.rows[6]).toContainEqual(["@media", "keyword"]);
  expect(css.state).toBe("");
  const md = tok("md", "# Title\ntext `code` and **bold** [l](u)\n- item\n```ts\nconst a\n```\n> quote");
  expect(md.rows[0]).toEqual([["# Title", "keyword"]]);
  expect(md.rows[1]).toContainEqual(["`code`", "string"]);
  expect(md.rows[1]).toContainEqual(["**bold**", "keyword"]);
  expect(md.rows[1]).toContainEqual(["[l](u)", "type"]);
  expect(md.rows[2][0]).toEqual(["-", "punctuation"]);
  expect(md.rows[4]).toEqual([["const a", "string"]]);
  expect(md.rows[6]).toEqual([["> quote", "comment"]]);
  expect(md.state).toBe("");
  expect(tok("plain", "anything `here` 1").rows[0]).toEqual([]);
});

test("theme covers every kind in light and dark", () => {
  for (const t of [lightTheme, darkTheme]) {
    expect(t.colors).toHaveLength(KIND_NAMES.length);
    for (const k of Object.values(Kind)) expect(colorFor(t, k)).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(colorFor(lightTheme, 999)).toBe(lightTheme.colors[Kind.Plain]);
});

function fullTokens(lang: Language, lines: string[]): { tokens: number[][]; states: string[] } {
  const c = new TokenCache(lang);
  c.reset(lines.length, i => lines[i]);
  return { tokens: c.tokens, states: c.states };
}

test("incremental cache: comment open/close ripples and stabilises", () => {
  const b = new TextBuffer("a\nb\nc\nd\ne");
  const c = new TokenCache("ts");
  c.attach(b);
  b.replace(2, 2, "/*"); // line 1 "b" -> "/*b" ... opens a comment
  expect(c.lastRetokenized).toBe(4);
  expect(c.tokens[4].length).toBe(3);
  expect(c.tokens[4][2]).toBe(Kind.Comment);
  b.replace(2, 4, ""); // remove again
  expect(c.lastRetokenized).toBe(4);
  expect(c.tokens[4][2]).toBe(Kind.Identifier);
  b.replace(0, 0, "x"); // plain edit stabilises immediately
  expect(c.lastRetokenized).toBe(1);
});

test("property: random edits on a TSX corpus - incremental equals full", () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const snippets = ["`", "${", "}", "{", "<div>", "</div>", "/>", "/*", "*/", "'", "\"", "/", "//", "<", ">", "=>", "\n", " ", "x", "(", ")", "return ", "<T,>", "\\", "\n  <b a={", "</", "q = /a/g"];
  for (const lang of ["tsx", "ts"] as Language[]) {
    const b = new TextBuffer(TSX_SAMPLE + "\n" + TSX_SAMPLE.slice(0, 600));
    const c = new TokenCache(lang);
    c.attach(b);
    for (let step = 0; step < 300; step++) {
      const from = rnd(b.length + 1);
      const to = Math.min(b.length, from + (rnd(3) === 0 ? rnd(40) : 0));
      let ins = ""; for (let k = rnd(3); k > 0; k--) ins += snippets[rnd(snippets.length)];
      b.replace(from, to, ins);
      if (step % 5 === 0 || step > 280) {
        const lines: string[] = []; for (let i = 0; i < b.lineCount; i++) lines.push(b.line(i));
        const full = fullTokens(lang, lines);
        expect(c.tokens.length).toBe(full.tokens.length);
        expect(c.states.length).toBe(full.states.length);
        for (let i = 0; i < lines.length; i++) {
          if (c.states[i] !== full.states[i] || JSON.stringify(c.tokens[i]) !== JSON.stringify(full.tokens[i])) {
            throw new Error(`${lang} step ${step}: mismatch at line ${i}: ${JSON.stringify(lines[i])} state ${c.states[i]} vs ${full.states[i]}`);
          }
        }
      }
    }
  }
});

test("corpus sanity: the TSX sample ends in the initial state", () => {
  const { states } = fullTokens("tsx", TSX_SAMPLE.split("\n"));
  expect(states[states.length - 1]).toBe(":0");
  expect(states[0]).toBe(":0");
  const big = buildCorpus(5000).split("\n");
  const r = fullTokens("tsx", big);
  expect(r.tokens.length).toBe(5000);
});
