# UI layer (`CodeView`)

Milestone M4 steps 2-6 (UI) and the "CodeEditor into `@pocket/ui`" part of M7. The pure core
(`CODE_EDITOR_CORE.md`) is reused unchanged: `CodeEditor` owns buffer, selection, history, IME and
keymap; this layer only renders it and feeds it raw input.

## Source-first note

The retained parent `pocketjs_flutter_demo` is not available here (see `STUDIO_TEXT_INPUT.md`).
Reused: `InlineText` (one Core text leaf with coloured runs), the framework gesture layer,
`onTextEvent`, the virtual-clock `after()` timer, `createPocketClipboardClient`, the `host.request`
bridge, the raw text session wire protocol, the `buildGuest` + native probe harness. New code is only
the evidenced gap (no editor UI existed).

## Files and exports

| File | Purpose |
| --- | --- |
| `src/code/view.tsx` | `CodeView` component (export `@pocket/ui/code-view`) |
| `src/code/raw-text.ts` | `RawTextSession`: guest side of `textInput.rawOpen/rawUpdate/rawClose`, `rawOpened/rawDismiss`, `onTextEvent` delivery (pure, injectable; exported from `@pocket/ui/code`) |
| `src/code/view-model.ts` | pure helpers: line model (tab expansion, NBSP, colour runs), calibration, click tracker, range spans, ring slots, diagnostics |
| `src/code/find.ts` | `FindModel` over `search.ts` (next/prev/replace/replace all/label) |

`CodeView` is a separate export (`"./code-view"`) instead of being re-exported by `"./code"`: it
needs the JSX runtime, and `./code` is imported by plain bun unit tests (and by `code_bench.test.ts`
inside QuickJS) that must stay free of framework modules. Note: `<InlineText>` / `inlineFontSlot(`
callsites make the pinned compiler bake the inline font atlases (`INLINE_TEXT_IMPLEMENTATION.md`),
so `view.tsx` references `inlineFontSlot` indirectly and the app passes
`fontSlot={inlineFontSlot("body")}` (an app-side callsite). Plain consumers pay nothing; forgetting it
throws a descriptive error.

## Props (summary)

`editor` (a `CodeEditor`) or `value` + `onChange`; `path` / `language`; `theme` (`"light" | "dark" |
TokenTheme`); `width`/`height` (else the parent size is measured); `lineHeight`, `tabSize`, `readOnly`,
`gutter`, `diagnostics: {line, column?, severity, message}[]`, `platform`, `onIntent`, `onCursorChange`,
`host` or `clipboard`, `charWidth` / `measure(codePoint)`, `fontSlot`, `dragScrolls` (touch mode),
`debug` (counters object), `ref` (`CodeViewHandle`: `focus/blur/refresh/scrollToLine/openFind`).
No wrapping in v1 (horizontal scroll).

## Rendering strategy

* One `InlineText` leaf per line, with the tokenizer's token colours as inline runs (the Core path
  emits one positioned fragment per run). Chosen over one `Text` per token: node count is the number
  of visible lines, not tokens, and an edit re-sends one source string + run table per changed line.
* Virtualisation by `viewport.ts` `visibleRange` (overscan 4). Rows live in a ring of
  `slots = ceil(viewportHeight / lineHeight) + 10` nodes with slot = `line % slots`
  (`slotLine`). Scrolling by one line recycles one row; the other rows keep their node, content and
  position. The scroll offset is applied as a paint-only `translateX/translateY` on two content
  layers (text, gutter), so no row moves when scrolling.
* Layers (back to front): line bands (diagnostic tint, current line), find matches, selection,
  text rows, IME marked underline, carets. Overlay rectangles use `<Index>` pools (nodes reused by
  position; the pool only grows/shrinks with the number of rectangles).
* Per-line models (`display`, `colMap`, `runs`) are cached per line, keyed by (text, token array
  identity, theme, NBSP mode, tab size); only a changed key rebuilds. Models are shared by rows,
  overlays and hit testing.
* Tabs are expanded to spaces in the displayed string; `colMap` maps source columns to display
  columns so caret/selection/hit-test math stays exact. Lines are rendered up to 4,000 display columns.
* The long-line horizontal extent is `longestLine * cellWidth` (recomputed lazily after edits).

### Monospace font and metrics

The SDK ships no monospace face; the host renders whatever font slot `body` maps to
(`SYSTEM_PROJECT_FONT_EXTENSION.md`: a project may bake `fonts.regular` in `pocket.json`). CodeView
therefore calibrates at runtime: a hidden `InlineText` measures (through one link rectangle, the only
Core measurement exposed to JS) 20 digits, 20 spaces, 20 NBSP and 10 CJK ideographs, then the node is
removed. Results: `charWidth`, space/CJK cell ratios, and whether NBSP is closer to one cell than a
space (the probe font's space is 5/9 of a digit but its NBSP is a full cell, so spaces are rendered
as NBSP there and everything lines up). `measure(cp)` (cells per code point) and `charWidth`
override the calibration. If digits/letters of the host font are not equal width (a proportional
font) column math is approximate; `debug.monospace` reports the space/NBSP check only. Declare a
monospace face for exact caret placement. Font size is the baked `body` slot (16 px in the probe;
the Flutter test font Ahem measures 16 px per cell); arbitrary sizes need another baked slot
(`fontSlot` prop).

## Input flow

1. Pointer: `createGesture` over the root rectangle (`pocket.getLayout`). Down in the text
   area focuses (opens the raw session with the caret rectangle) and places the caret
   (shift = extend using Shift key edges seen on the raw session; double click = word, triple = line
   via `ClickTracker`; drag extends by char/word/line unit with edge auto-scroll while the pointer
   moves). Down in the gutter: tap selects the line and shows its diagnostic, drag scrolls
   (both axes). `dragScrolls` makes text drags pan instead (touch). Wheel/trackpad:
   `input.scroll` `deltaY` (and `deltaX` when the host sends it) scroll the view under the pointer.
2. Keyboard/IME: `RawTextSession` registers `onTextEvent` only while open and feeds
   `CodeEditor.handleInput`. `rawOpened` is recorded, `rawDismiss` (`replaced`, `blur`, ...) closes
   the session and the caret stops. A second guest session closes the first locally; the host does
   the same between InputField and raw sessions. `rawUpdate` follows the caret on every caret/scroll
   change.
3. Intents from the keymap: `clipboard.write` (copy/cut) -> `clipboard.writeText` through
   `createPocketClipboardClient` (pass `host` or `clipboard`) and always stored in an internal
   clipboard; `clipboard.read` -> `readText`, falling back to the internal clipboard when no client
   is given or the host rejects (`capability_unavailable`, permission denied); `find*` opens/steps the
   find bar; `save` only emits. `onIntent` sees every intent first and can return `false` to take
   over. Read-only mode allows only navigation/selection/copy/find/save.
4. Find bar (Meta/Control+F, Meta+G / Shift+Meta+G): two single-line fields (each a tiny
   `CodeEditor`, same IME/key path), count label, prev/next/case/close and Replace/All buttons;
   Enter = next (Shift+Enter prev) in the query field and replace-one in the replace field, Tab switches
   field, Escape closes. Match highlights are drawn for visible lines only; replace all is one undo step.
5. Caret blink: one repeating `after(0.5)` virtual-clock deadline while focused (restarted by
   typing/moving); no per-frame callback and no busy loop (a blinking focused editor wakes the host
   at 2 Hz).
6. Cursor reporting: `onCursorChange({line, column, offset, anchor, selections})` when the primary
   range changes. Diagnostics: gutter dot (severity colour), tinted line band, and a one-line tip
   (severity, line:col, message) at the bottom when the caret line or the tapped gutter line has one.

## Counters (`debug`)

`nodesMounted`, `nodesLive`, `linesBuilt` (render models built == rows whose InlineText content
changed), `runsCreated`, `lastEditLines`, `lastScrollLines`, `lastEditMs`/`editMsTotal`/`edits`
(guest `Date.now()` per handled input event), `slots`, `firstLine`/`lastLine`, `scrollTop/Left`,
`calibrated`, `monospace`, `charWidth`, `focused`, `rawDismiss`, `lastEmit`.

## Tests and measured numbers

Real guest on the real probe (`buildGuest` + `native/target/debug/pocket_probe`, persistent probe
process driven by `test/code_view_harness.ts`), 5,000-line TSX corpus (170,161 chars):

```sh
cd sdk
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun test packages/pocket_ui/test/code_view*.test.ts      # 19 tests
```

`code_view_model.test.ts` (9, pure helpers incl. raw session and find model) and
`code_view_native.test.ts` (10): virtualisation and node bound, wheel + gutter-drag scroll, pointer
tap/double/triple/drag, raw keys + commit + IME `ni -> 你` + cancel + undo/redo, diagnostics marker
and tip, find bar (typing, Enter, replace field, "All" button pressed by pointer), clipboard through
`host.request` (`clipboard.writeText` answered, `clipboard.readText` answered, and rejected ->
internal fallback), save intent, `rawDismiss`, caret blink via frames, performance.

Numbers (debug probe build, bun + QuickJS in `pocket_probe`; one run on the Linux dev VM):

| Measure | Value |
| --- | --- |
| Nodes after mount (640 px view, 20 px lines) | 86 live (42 text rows + 42 gutter rows + pools) |
| Nodes after scrolling 4,000 px / 400 px drag | 84-88 (bounded, rows recycled) |
| Row models built mounting | 72 (36 visible rows built twice: once before calibration, once after) |
| Rows rebuilt by a 20 px wheel step | <= 2 |
| Rows re-rendered per keystroke | 1 (60 keystrokes: 60 line builds, 1,260 runs) |
| Guest time per keystroke (Date.now, includes layers update) | about 3 ms (2.9-3.6 over runs) |
| Scroll step | nodes: 0 created; models built: 0-2 |

Flutter end-to-end (`packages/pocket_flutter/test/pocket_view_code_view_ffi_test.dart`, 3 tests, real
`libpocket_flutter.so`, real QuickJS guest in `PocketView(rawTextInputEnabled: true)`): a pointer tap
opens the raw session (the IME client attaches), IME deltas (`ab`, composition `ni`, commit `你`),
a Backspace key edge and Meta+Z reach `CodeView` and change the buffer. Text layout cache (the Linux
half of Spike B), 480x640 view, 16 ms steps, scrolling 1,500 lines in 3-line steps then 100 lines
back, then a jump to line 0:

| Capacity | cached after scroll down | layouts (misses) | evictions | extra layouts after jump to top |
| --- | --- | --- | --- | --- |
| 256 (default) | 256 | 1,621 | 1,365 | 32 (every visible run) |
| 2,048 | 1,621 | 1,621 | 0 | 0 |

Hits were ~103 k vs the same 1,621 first-time layouts: steady-state scrolling is dominated by hits
either way (new lines are layout misses regardless of capacity); the difference is revisits (jump
back, find next across the file). A visible screen is about 36 rows x ~8 runs, which is about
the 256 limit, so 256 thrashes on revisit while 2,048 holds roughly 5 screens. Suggested:
`textLayoutCacheCapacity: 1024-2048` for code editing.

```sh
export PATH=/opt/flutter/bin:$PATH
cd sdk && POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun packages/pocket_ui/test/code_view_flutter_fixture.ts /tmp/cvfix
cd packages/pocket_flutter && POCKET_CODE_VIEW_FIXTURE_DIR=/tmp/cvfix \
  POCKET_NATIVE_LIBRARY=/home/user/pocket/sdk/native/target/debug/libpocket_flutter.so \
  flutter test test/pocket_view_code_view_ffi_test.dart
```

## Limits and macOS checks still needed

* Not measured: profile-mode frame time on a device, release-build keystroke time (the numbers
  above are a debug native build); macOS Apple Silicon profile run of the 5k-line scroll and typing.
* Real IME on macOS (Spike A checklist in `STUDIO_TEXT_INPUT.md`): candidate window position from
  `rawUpdate`, marked-text underline alignment, Japanese clause selection, dead keys, key forwarding
  for Cmd+C/V/F/S. The Linux tests inject IME deltas through the Flutter text-input channel only.
* Real fonts: width calibration was verified on the probe font (NBSP mode, CJK 1.78 cells) and the
  Flutter test font; a proportional production font keeps approximate column positions. Wide glyphs
  and emoji use the calibrated CJK ratio.
* v1 limits: no soft wrap, no code folding, no bracket matching/autocomplete, no kinetic fling or
  drag-edge auto-scroll while the pointer is held still (it advances on pointer move), no
  horizontal wheel unless the host sends `deltaX`, shift-for-extend relies on Shift key edges
  from the raw session, find bar fields are single line with the core's editing (no per-field
  history UI), long lines are cut at 4,000 display columns, selection of a very large range
  allocates one rectangle per visible line only.
* No automatic frame culling of rows outside the clip: rows exist for lines within the overscan only.
