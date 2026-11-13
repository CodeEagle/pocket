# Code editor core (`@pocket/ui/code`)

Milestone M4 of the Pocket Studio plan, logic part (steps 1, 2 and 5): the pure-TypeScript core of a
Pocket-native code editor. No UI, no dependencies, no DOM/Node APIs. It lives in the SDK
(`packages/pocket_ui/src/code/`, export `"./code"`) so it can be reused by every consumer; M7 moves the
reusable editor widgets into `@pocket/ui`.

## Source-first note

The parent repo `pocketjs_flutter_demo` is not available in this environment (see
`STUDIO_TEXT_INPUT.md`), so nothing could be ported from it. Reused from the SDK: the raw text event
wire format (`STUDIO_TEXT_INPUT.md`), the module/test layout of `packages/pocket_ui`, the
`buildGuest` + native probe harness of `clipboard_native.test.ts`. Everything else is new and is the
evidenced gap named by the plan (no editor logic existed).

## Modules

| File | Purpose |
| --- | --- |
| `buffer.ts` | `TextBuffer`, change events, grapheme/word helpers |
| `selection.ts` | multi-cursor `SelectionSet`, `normalize`, `ChangeMap` |
| `commands.ts` | pure commands returning a `Transaction`; `applyTransaction`; command table |
| `keymap.ts` | raw key name -> command id (`lookupKey`, `parseKey`) |
| `history.ts` | undo/redo, coalescing, bounded memory |
| `ime.ts` | composition reducer |
| `tokenizer.ts`, `theme.ts` | line-incremental highlighting, default light/dark palettes |
| `search.ts` | find / replace with regex guard |
| `viewport.ts` | virtualization, gutter, caret and hit-test math |
| `editor.ts` | `CodeEditor` glue: buffer + selection + history + IME + keymap |
| `index.ts` | public re-exports |

### Buffer (`buffer.ts`)

Data structure: `lines: string[]` (no terminators) plus a lazily extended prefix-sum array of line
start offsets. A piece table was rejected: for 5,000 lines / 2 MiB (about 400 chars per line) a splice
of a 5,000-pointer array costs microseconds, line access is O(1), and the simple model keeps the
tokenizer and history trivial.

| Operation | Cost |
| --- | --- |
| `line(i)`, `lineLength(i)` | O(1) |
| `lineStart(i)`, `offsetAt(line, col)` | O(1) amortised (starts are re-extended from the first edited line) |
| `lineAt(offset)`, `positionAt(offset)` | O(log n) before the edit horizon, O(distance) after it |
| `replace(from, to, text)` | O(k + n) for k inserted units, n lines (array splice) |
| `getRange`, `getText` | O(size) |

All offsets are UTF-16 units in the logical document in which each line break counts as one unit
(`"\n"`). `eol` is detected on load (`"\n"` or `"\r\n"`, the majority wins, `mixedEol` reports mixed
files) and re-applied by `toString()`; `getText()` is always LF. A lone `"\r"` is an ordinary
character. A file with a trailing newline has a final empty line; a last line without newline round
trips unchanged. `version` increments on every change; `onChange` receives a `BufferChange`
(`offset`, `removed`, `inserted`, `startLine`, `oldLineCount`, `newLineCount`).

Grapheme approximation (no `Intl.Segmenter`): a cluster is a code point plus following combining
marks (U+0300-036F, 1AB0-1AFF, 1DC0-1DFF, 20D0-20FF, FE20-FE2F, Hebrew/Arabic/Devanagari/Thai combining
subsets), variation selectors, emoji skin tones, tag characters, keycap, ZWJ joining the next code
point; regional indicators pair up; CRLF is one cluster. Not handled: Hangul jamo composition, Indic
conjunct rules, other scripts' spacing marks (each is its own cluster). Cursor movement, backspace,
delete and hit-test all snap to these boundaries, never inside a surrogate pair.

### Selection and commands

`SelectionSet = { ranges: Range[]; primary }`, `Range = { anchor, head, goal? }` (`goal` is the
remembered column for vertical movement). `normalize` sorts and merges overlapping ranges.

A command is `(ctx: { buffer, selection, options }) => Transaction | null`. A `Transaction` is
`{ edits (sorted, non-overlapping, ORIGINAL coordinates), selection (NEW coordinates), kind }` and is
not applied by the command. `applyTransaction` applies the edits in descending order so one
transaction = one history step, for any number of cursors. `ChangeMap` maps original offsets through
the edits (with `assoc`). Options: `indentUnit` (default two spaces, may be `"\t"`), `lineComment`
(`"//"`, `null` disables), `autoClose`, `pageLines`.

Commands: `insertText` (distributes one line per cursor when the line count matches), `typeChar`
(auto-close brackets and quotes, overtype of `) ] }` and quotes, wrap a selection, no auto-close
quote after a word character such as in `don't`), `newline` (copy indentation; extra indent after
`{ ( [` and `=>`; `{|}` expands to three lines), `deleteBackward/Forward` (char, word, line; deletes
an empty pair `()`; smart unindent in leading spaces), `indentSelection` / `outdentSelection`
(Tab at a bare cursor goes to the next tab stop, a selection indents whole lines, a selection ending
at column 0 excludes that line), `moveHorizontal/Vertical/LineBoundary/Document` (with extend; smart
Home toggles first non-blank / column 0; vertical keeps the goal column; Up on line 0 goes to the
start, Down on the last line to the end; a non-empty selection collapses on Left/Right),
`selectAll`, `duplicateLine` (up/down), `moveLines`, `toggleLineComment` (comments at the minimum
common indent, uncomments when every non-blank line is commented), `addCursorVertical`,
`escapeSelection`, `copyText`, `cutTransaction` (an empty selection copies/cuts the whole line).

### Keymap (`keymap.ts`)

Key names come from `STUDIO_TEXT_INPUT.md` (modifiers folded as `Control`, `Alt`, `Shift`, `Meta`;
single letters are lowercased). Platform `"mac"` (default) uses Meta as the shortcut modifier and
ignores Control; `"other"` uses Control and ignores Meta. Printable keys return null (typed text
arrives as `commit`).

| Keys (mac / other) | Id |
| --- | --- |
| `Meta+z` / `Control+z` | `undo` |
| `Meta+Shift+z`, `Control+Shift+z`, `Control+y` | `redo` |
| `Meta+a` | `selectAll` |
| `Meta+c`, `Meta+x`, `Meta+v` | `copy`, `cut` (intent `clipboard.write`), `paste` (intent `clipboard.read`) |
| `Meta+f`, `Meta+g`, `Meta+Shift+g` | `find`, `findNext`, `findPrev` intents |
| `Meta+s` | `save` intent |
| `Meta+/` | `toggleLineComment` |
| `Meta+]`, `Meta+[`, `Tab`, `Shift+Tab` | `indentLines`, `outdent`, `indent`, `outdent` |
| `Alt+ArrowLeft/Right` (other: `Control+`) | word move; with Shift, extend |
| `Meta+ArrowLeft/Right` (mac) | line start / end |
| `Meta+ArrowUp/Down` (mac), `Control+Home/End` (other) | document start / end |
| `Home`, `End`, `PageUp`, `PageDown` | line boundary, page (Shift extends) |
| `Alt+ArrowUp/Down` | `moveLineUp/Down` |
| `Alt+Shift+ArrowUp/Down` | `duplicateLineUp/Down` |
| `Alt+Meta+ArrowUp/Down` (other: `Control+Alt+`) | `addCursorAbove/Below` |
| `Alt+Backspace`, `Alt+Delete` (other: `Control+`), `Meta+Backspace` | delete word back/forward, delete to line start |
| `Enter`, `Escape` | `newline`, `escape` (collapse to the primary cursor) |

Ids are keys of `commandTable` (pure) or editor-level (`undo redo copy cut paste find findNext
findPrev save`), handled by `CodeEditor.handleKey`, which returns `{ handled, changed, intent? }`.
Intents are `{type:"clipboard.write", text, cut}`, `{type:"clipboard.read"}` (answer with
`editor.paste(text)`), `{type:"find"|"findNext"|"findPrev"|"save"}`. Keys that are not shortcuts
return `handled: false` so the host can let the platform have them. While a composition is active key
edges are ignored (the host does not forward them either).

### History (`history.ts`)

Steps hold the applied changes, the selection before/after, kind, time and approximate bytes.
`undo` restores `before`. Coalescing merges a new step into the previous when both are `type` (or both
`delete.back` / both `delete.fwd`), within `coalesceMs` (1000), the selection did not move in
between, nothing called `breakCoalescing()` (cursor moves, undo/redo, `setSelection` do), the text is
a single-line insert at or inside the previous insertion (so typing inside an auto-closed pair stays
one step), and the character class does not go from word to
whitespace (`hello world` undoes as `hello`, ` world`). Paste (`input`), IME commits (`ime`), newline
and every other command are their own steps. Multi-cursor typing is never coalesced. Memory is
bounded by `maxSteps` (500) and `maxBytes` (8 MiB of retained text, counted as 2 bytes per unit); the
oldest steps drop first and the newest step is always kept.

### IME reducer (`ime.ts`)

Events: `composition{text, selectionStart, selectionEnd}`, `compositionEnd`, `commit{text}`.
Composition is a transient overlay and never touches history.

- First `composition`: the primary range (text and the whole selection set) is saved and replaced by
  the marked text; later events replace the marked range. The selection becomes
  `[from + selectionStart, from + selectionEnd]` (clamped, snapped off a surrogate half), so a
  Japanese clause selection inside the composition works. `marked` is exposed (`editor.marked`) for the UI to underline.
- `compositionEnd`: the marked text is removed and the pre-composition text and selection are
  restored exactly (cancel stops here).
- `commit` right after `compositionEnd` (or while still composing) is an IME commit: a plain insert
  (no auto-close) at the restored selection, so it replaces the original selection, is one undo step
  (`kind: "ime"`) and undo restores the original selection.
- Any other `commit` is ordinary typing (`typeChar`, or `insertText` for longer text; `"\n"` is
  `newline`).
- A pointer/selection change or any transaction while composing cancels the composition first.
- Extra cursors are kept in the saved selection and get the final commit; only the primary shows the
  marked text.
- UI contract: process all text events of a frame before rendering, otherwise the restore between
  `compositionEnd` and `commit` is visible for one frame.

### Tokenizer (`tokenizer.ts`)

Flat `number[]` per line `[start, end, kind, ...]` (UTF-16 columns; whitespace gaps are not emitted).
Kinds (`Kind`/`KIND_NAMES`): plain, keyword, identifier, type (PascalCase with a lowercase letter, or a
single capital), number, string, template, regexp, comment, punctuation, operator, jsx-tag,
jsx-attribute, jsx-text. Languages by `languageForPath`: ts, tsx, js, jsx, json, css, md, plain (JSX is
recognised in tsx/jsx/js).

The per-line start state is a string: a frame stack plus `:0`/`:1` (previous token ends an
expression: regex vs divide). Frames: `B` block comment, `T` template text, `S` `${`, `X` JSX `{}`, `b`
brace inside S/X, `J` JSX children, `G` opening tag, `C` closing tag, `D d` string continued by `\`,
`Q q` multi-line JSX attribute string. Top-level braces are not tracked, so ordinary states are `:0` /
`:1`. Stack depth is capped at 48.
`TokenCache.update(change)` splices the per-line arrays, re-tokenizes from the first changed line and stops when a line's end
state equals the stored start state of the next line (`lastRetokenized` reports how many lines ran);
`attach(buffer)` wires it to `onChange`. A property test applies 600 random edits (backticks, `${`,
tags, comments, quotes) to a TSX corpus and compares the incremental cache with a full
re-tokenization line by line.

Limits (best effort): `}` is not an expression end; TypeScript types are not parsed (`a < b > (c)` is
operators); `<` starts JSX after operators, opening punctuation and `return`-like keywords unless it
looks like `<T,>` or `<T extends`; contextual keywords (`type`, `of`, `from`, `get`, ...) are coloured
as keywords only when not followed by `: , ) = ; . }`; ASI line breaks do not reset the regex flag;
CSS and Markdown are shallow (selectors vs properties, headings, fences, inline code).
Unterminated strings, comments and templates never throw.

### Search (`search.ts`)

Plain (escaped), case-sensitive, whole-word (manual boundary check, no lookbehind) or regex
(`gm` flags). Guards: invalid pattern -> `error` instead of throwing; patterns with nested
quantifiers such as `(a+)+` are refused (one `exec` cannot be interrupted, so they are prevented);
patterns over 500 chars refused; matches capped (10,000; replace-all 100,000) and a time budget
(50 ms; replace-all 250 ms) checked between matches, reported as `truncated` / `timedOut`.
`findNext`/`findPrev` wrap; `countMatches`; `replaceAllTransaction` builds one transaction (one undo
step; regex replacement supports `$&`, `$1..$99`, `$$`); `replaceOneTransaction` replaces when the
primary selection is exactly a match, otherwise selects the next match.

### Viewport (`viewport.ts`)

`visibleRange` (lines plus overscan, offset, content height), `gutterDigits/gutterWidth` (at least two
digits), `columnToX` / `xToColumn` (rounds at half a glyph, snaps to cluster boundaries), `caretPosition`,
`hitTest` (clamped to the document), `scrollToReveal`. The caller provides `charWidth`. Default cell
widths: 0 for combining marks and ZWJ, 2 for CJK/fullwidth/most emoji, 1 otherwise, tabs to the next
`tabSize` stop. For measured widths (fallback fonts, proportional CJK) pass `measure(codePoint) =>
cells`; fractional cells are allowed. Column math is O(column) per call.

## QuickJS constraints honoured

No `Intl`, no regex lookbehind or `\p{}` (checked by grep), no Node/DOM/timers, no BigInt, no
`structuredClone`; only `String.prototype.codePointAt/startsWith/indexOf/slice`, `Set`, `Date.now`.
Hot paths use `charCodeAt` and flat number arrays; the only per-keystroke allocations are one token
array per re-tokenized line, a transaction object and a few small edit objects.

## Measured timings

Corpus: `test/code_corpus.ts` TSX sample repeated to 5,000 lines (170,161 chars). Commands run from
`/home/user/pocket/sdk`:

```
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp ~/.bun/bin/bun test packages/pocket_ui/test/code_*.test.ts
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp ~/.bun/bin/bun test packages/pocket_ui/test/code_bench.test.ts   # prints CODE_BENCH lines
```

| Measure | Bun 1.4.4 | QuickJS (release `pocket_probe`) |
| --- | --- | --- |
| full tokenise, 5,000 lines (median of 5) | about 5-7 ms | 55 ms (54-59) |
| one keystroke mid-document, buffer + incremental retokenise (lines re-tokenized: 1) | about 0.01-0.02 ms | 0.055 ms |
| `CodeEditor.handleInput` commit (typeChar -> transaction -> history) | about 0.02-0.03 ms | 0.02 ms |
| `visibleRange` + `hitTest` + `caretPosition` per call set | 2-5 us | 19.6 us |
| `positionAt` + `offsetAt` | about 1 us | 1.4 us |

The QuickJS run compiles a guest with the real `scripts/build_guest.ts` (`@pocket/ui/code` imported from
the guest), loads the bytecode in the native probe, and the guest reports its `Date.now()` timings through
a `code.bench` event (`_emitValue`) read from `frame.events`; the test also asserts tokens of the JSX
line. The probe is `native/target/release/pocket_probe`; the debug probe (`POCKET_NATIVE_PROBE`) is
slower (unoptimised QuickJS). `Date.now()` has 1 ms resolution, so the QuickJS per-keystroke numbers are
averages over 200 iterations. Asserted bounds are generous (Bun full tokenise < 1.5 s, QuickJS < 15 s).

## What the UI layer must do (next step)

1. Own a `CodeEditor`, a `TokenCache.attach(editor.buffer)` and the scroll state. Render only
   `visibleRange` lines; colour tokens with `theme.ts`; draw selections from `editor.selection`,
   carets from `caretPosition`, and underline `editor.marked`.
2. Open a raw text session (`textInput.rawOpen`) when focused and keep the host caret rectangle in
   sync with `rawUpdate` after every caret or scroll change.
3. Route `onTextEvent` (`keyDown`, `commit`, `composition`, `compositionEnd`) to
   `editor.handleInput`; render once per frame after the whole batch. Return `handled` to decide
   whether the host should swallow the key. Do not handle `keyUp`.
4. Pointer: `hitTest` -> `editor.setSelection`; drag extends; double/triple click and Shift+click are UI
   policy (use `wordLeft/wordRight`, line ranges).
5. Execute intents: clipboard plugin for `clipboard.write` / `clipboard.read` -> `editor.paste`,
   find bar on `find*` (with `search.ts`), file save on `save`.
6. Provide `charWidth` from a measured glyph and, for CJK, a `measure` hook from the host text layout;
   set `command.pageLines` from the viewport height; keep the caret visible with `scrollToReveal`.
7. Call `editor.history.breakCoalescing()` on save and focus loss.

## Open items

- Hangul jamo and complex-script clusters are approximated; swap in a table when Intl is available.
- Multi-cursor typing is not coalesced; word-wise multi-cursor delete merges overlapping edits.
- Tokenizer does not parse TypeScript types or template-literal types; the regex flag is not reset by ASI.
- Soft-keyboard Backspace on mobile does not arrive as a key edge (host limitation, desktop target).

## UI layer

The component that renders this core (`CodeView`, virtualised rows, raw text session, find bar,
clipboard/save intents, measured numbers and open macOS checks) is documented in
`CODE_VIEW.md`.
