/** Micro-benchmark shared by the Bun test and the QuickJS guest probe. `api` is the module namespace of the code core. */
export interface BenchResult {
  runtime: string;
  lines: number;
  chars: number;
  tokenizeFullMs: number;
  tokenizeFullMsAll: number[];
  keystrokeRetokenizeMs: number;
  keystrokeLinesRetokenized: number;
  editorKeystrokeMs: number;
  viewportHitTestUs: number;
  bufferLookupUs: number;
  sample: { line: string; tokens: [string, string][] };
}

export function runBench(api: any, corpus: string, now: () => number, runtime: string): BenchResult {
  const { TextBuffer, TokenCache, CodeEditor, KIND_NAMES, visibleRange, hitTest, caretPosition, gutterWidth, single } = api;
  const buffer = new TextBuffer(corpus);
  const lineCount: number = buffer.lineCount;
  const getLine = (i: number) => buffer.line(i);

  const full: number[] = [];
  let cache: any;
  for (let r = 0; r < 5; r++) {
    cache = new TokenCache("tsx");
    const t0 = now();
    cache.reset(lineCount, getLine);
    full.push(now() - t0);
  }
  const sorted = full.slice().sort((a, b) => a - b);

  // incremental: type one character in the middle of the document, repeatedly
  const b2 = new TextBuffer(corpus);
  const c2 = new TokenCache("tsx");
  c2.attach(b2);
  const mid = Math.floor(lineCount / 2);
  let off = b2.offsetAt(mid, 4), retok = 0;
  const N = 200;
  const t1 = now();
  for (let i = 0; i < N; i++) { b2.replace(off, off, "x"); off++; retok += c2.lastRetokenized; }
  const keyMs = (now() - t1) / N;

  // the whole editor path: handleInput commit -> typeChar -> transaction -> history
  const ed = new CodeEditor(corpus);
  ed.selection = single(ed.buffer.offsetAt(mid, 4));
  const t2 = now();
  for (let i = 0; i < N; i++) ed.handleInput({ kind: "commit", text: "y" });
  const edMs = (now() - t2) / N;

  // viewport + hit-test + caret
  const m = { lineHeight: 20, charWidth: 9, tabSize: 2 };
  const g = gutterWidth(lineCount, m);
  const M = 5000;
  let sink = 0;
  const t3 = now();
  for (let i = 0; i < M; i++) {
    const r = visibleRange(lineCount, 20, 800, (i * 37) % (lineCount * 20), 5);
    const h = hitTest(100 + (i % 300), 50 + (i % 700), lineCount, getLine, m, g, r.offsetY);
    const c = caretPosition(buffer.line(h.line), h.line, h.column, m, g, r.offsetY);
    sink += r.first + h.column + c.x;
  }
  const vpUs = ((now() - t3) * 1000) / M;

  const t4 = now();
  for (let i = 0; i < M; i++) { const o = (i * 7919) % buffer.length; const p = buffer.positionAt(o); sink += buffer.offsetAt(p.line, p.column); }
  const bufUs = ((now() - t4) * 1000) / M;
  if (sink === -1) throw new Error("unreachable");

  const jsxLine = corpus.split("\n")[16];
  const tk = cache.line(16);
  const toks: [string, string][] = [];
  for (let i = 0; i < tk.length; i += 3) toks.push([jsxLine.slice(tk[i], tk[i + 1]), KIND_NAMES[tk[i + 2]]]);
  return {
    runtime, lines: lineCount, chars: corpus.length,
    tokenizeFullMs: sorted[2], tokenizeFullMsAll: full,
    keystrokeRetokenizeMs: keyMs, keystrokeLinesRetokenized: retok / N,
    editorKeystrokeMs: edMs, viewportHitTestUs: vpUs, bufferLookupUs: bufUs,
    sample: { line: jsxLine, tokens: toks },
  };
}
