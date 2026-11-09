# Inline rich dialogue

Status: foundational T01 scope accepted on the recorded macOS Profile and native
fixtures. T01 and the full engine goal remain partial. The normal playable Demo
has been replaced with the accepted build. Live2D quality remains deferred by
the user.

## Source-first adaptation

The retained parent was inspected before implementation, excluding
`pocket_host/`. Its `lib/render/pocket_ui_components.dart:1234-1281` builds
one Flutter `Text` with one `TextStyle`; its
`mini_apps/syslib/pocket_syslib_flutter_ui.js:824-842` exposes string-based
`wrapTextPage`. Neither contains styled ranges, ruby, local pauses or note
links to migrate. The existing Core text leaf, measure hooks, font atlas and
TEXT_RUN drawing operations are the retained rendering boundary. The
investigation in [rich-text design](VISUAL_NOVEL_RICH_TEXT_DESIGN.md) explains
why the experimental asynchronous single-style text-layout service cannot
serve as an inline layout substitute.

The implementation adapts that Core boundary and the existing VN clock,
transactions, localization, shared save string pool and Editor history. It
does not introduce a Dart dialogue controller or a JS text layout engine.

Functional references are Ren'Py's official
[text documentation](https://www.renpy.org/doc/html/text.html), including
style ranges, ruby, local waits and hyperlinks. No upstream Ren'Py code is
copied. These references establish the capability target, not Pocket parity.

## One authored body and one layout

`say.text` remains the canonical string. Optional `say.rich` contains two
arrays: disjoint, sorted code-point `[start,end)` spans and ordered pause
markers. A span has a stable ID and can combine a semantic color,
`emphasis: "strong"`, ruby text and an internal `{title,text}` note. A
pause has a stable ID, a code-point `at` boundary and either a positive
`durationMs` or `null` for input. The first version intentionally rejects
overlapping ranges. Notes contain prose, not URLs or executable actions.

The public `@pocket/ui` `InlineText` leaf receives the full resolved source,
style runs, explicit width and a paint-only reveal cursor. Core owns the
full paragraph's height, line breaks, ruby reservation and link rectangles.
`NovelRichTextView` only places focus targets in those returned rectangles;
it does not estimate widths or split styled text into separately laid out
widgets. The old plain-string path remains available for plain dialogue.

Hidden suffixes reserve layout space. Ruby appears only when its entire
base range is revealed. Only fully revealed links are interactive. The
active line and historical entries use the same rich component. The
image-backed journal contains the note reader; opening a note stores a
reference to the active line or backlog entry, rather than another copy of
its body.

## Time, input and persistence

The existing `NovelClock` advances timed pauses. A press while revealing
stops at the next marker. A press at a marker releases that marker only;
it cannot also advance the line. Automatic advancement waits for all
markers and the complete line. Global pause freezes local countdowns.

`activateSayLink(spanId)` returns a `sayLink` event for a fully revealed
span in a running active say. Local manual/timed pauses permit it; global
pause does not. Its only bookkeeping change is the existing ordered event
sequence. It preserves reveal progress, local pause, variables, read state,
backlog and rollback history. The JS note reader then uses the existing
global pause/resume policy. Historical notes return to the same journal
page without resuming the game behind it.

Ranges use source-template code points. They cannot split a `{{variable}}`
token. A span surrounding an entire token maps around the resolved value;
localization supplies ranges for its own translated `lines` through
`StoryLocaleCatalog.sayRich`. A translation without matching annotations
falls back to plain translated text and reports a diagnostic. Source
offsets are never applied to a translated string.

## Playable acceptance target

The isolated replay **信纸上的第二层海 / A Second Sea inside the Letter**
adds three labels while preserving the existing 139. At `RETURN`, the
reader can inspect a pencilled correction without consuming its local
pause. The correction explains why waiting for a reply matters. Two
choices lead to different endings, and replay leaves the parked main
save intact. English has its own ranges, ruby, notes and pause boundaries.

New acceptance sources:

- `demo/js/apps/lantern/rich-letter.test.ts`: actual story, local pause,
  link isolation, JSON save/load, two endings and translated annotations.
- `demo/js/tests/novel_lantern_rich_text_native.test.ts`: actual pinned
  bytecode input at 390×844 and 1920×1080, note/history pointers and replay
  isolation.
- `demo/integration_test/novel_rich_text_test.dart`: actual Flutter drawing,
  image-backed note/history interaction and PNG captures under both
  constraints, with an isolated support directory and ordinary-store check.
- `sdk/scripts/tests/build_guest_rich_text.test.ts`: malformed standalone
  consumers fail before compiling their entry.
- `demo/js/tests/inline_text_native.test.ts`: a public-component consumer
  verifies fixed reveal geometry, ruby gating and pointer delivery through
  the second rectangle of a wrapped link. It also exercises read-after-write
  layout queries during one reactive batch and hidden-link event routing.

## Accepted artifacts and execution

Evidence is retained in `sdk/.pocket-build/rich-text-20261109/`:

- VN SDK: 277 tests / 2,327 assertions; actual-story suites: 36 tests /
  1,750 assertions. Six public sources and the view/InlineText integration
  pass strict TypeScript using actual framework types.
- Final native Probe: generic public InlineText fixture 1/1 and actual Lantern
  story 2/2 (390×844 and 1920×1080). Wrapped-link pointer input, ruby gating,
  stable reveal geometry, source/run replacement with unchanged reveal,
  active/history notes and both replay endings are exercised.
- Real macOS Profile Flutter: 2/2; all six rich/manual-pause, note and history
  checkpoints captured and visually reviewed at phone and wide constraints.
  See `flutter-profile-accepted-result.json` and `flutter-accepted-png.json`.
- Exact accepted bundle input tour: 2/2. Six-CJK preedit, blur, opening first
  frame and native overlay ACK captures were reviewed. The macOS test uses
  pump-driven `fadePointers` to permit progress under an occluded window;
  app/SDK input behavior is unchanged by that test adjustment. A prior hung
  run remains recorded and its cause is not established. This is desktop
  transport/painting acceptance, not physical-device IME acceptance.
- Targeted Editor rich/localization browser tests: 3/3; context provenance
  plus rich/localization: 6/6. Initial broad Editor run: 190 passed / 36 failed.
  Viewport adaptations using actual pointer scrolling pass 4/4 on the final Probe,
  retaining original result-payload assertions (`viewport-adaptation-result.json`).
  Subsequent targeted corrections do not establish a full Editor pass.
- Pristine archive patch replay, second idempotent replay, current-cache
  preparation and official generator zero-diff checks pass. Focused Core
  tests: 4/4 with pinned Rust 1.98.1. Plain font PAK remains byte-identical
  with 13 slots and zero extra atlas bytes; the older compiler's full guest
  build did not pass, so this is a font-only baseline comparison.

The accepted normal `lib/main.dart` Profile app is
`sdk/.pocket-build/lantern-playable-rich-text-20261109/pocket_host.app`, launched
as PID 87428. Main-isolate readiness and an onscreen OS window were verified
before retiring the previous owned process. It is independent of later test
build output. The OS foreground is recorded separately; an onscreen window does
not establish that the user currently sees the game in front.

Accepted Lantern QJBC SHA256:
`bb9062ed6d665bbe1af5dab6378b82af2ecf0c32cac0bafd6e304c87ad0fcd6f`.
PAK SHA256:
`e5f148e7a50f81631b7862b94ea075cd78a9cc6fc5b4d7c32ecf3c97942a2e73`.
Final Probe SHA256:
`13c4f49a78895c957c17d8ef934c668b525eab664f9e10c2ffb9c29419b3e3cc`.
Native archive SHA256:
`c09125b5764660c632da30884aaac11190135b95090fe53d6a88651bd9b5d601`.
Full toolchain provenance is in `native-final-build.json` and
[Core implementation](INLINE_TEXT_IMPLEMENTATION.md).

## Evidence limits

Core's retained atlas metrics are not a complete Unicode shaping engine.
Initial acceptance must state the exact CJK/Latin/non-BMP cases exercised;
it cannot imply full ligature, combining-mark, bidirectional or complex
script support. Browser DOM preview establishes editing and execution
semantics, not pixel equality with Core. Simulated Flutter DPR and test
constraints do not establish physical iOS/Android/desktop typography.
This capability does not establish whole-game performance acceptance.

Overlapping spans, translated-range visual editing, complex-script shaping,
physical-platform typography and whole-game profiling remain open. No Live2D
quality improvement is claimed.

## Independent review and ablation

The first immutable Core review identified two correctness gaps: a source/run
update could reset reveal without restoring an unchanged cursor, and inherited
color shared an internal cache key with explicit white. The public run-table setter
already invalidates its cache; the second regression isolates the internal key
invariant by mutating a warmed same-node spec. It is not evidence of public-setter
color staleness. These have their own regressions;
a passing original scenario does not close them. Duplicate image-limit/RGBA tests
in the inline patch are removed from that patch because earlier patches already
own those regressions. Clean archive replay also exposed missing image-mesh patch
definitions; those definitions were repaired and final replay passed.

The final Flutter rerun passed all six required checkpoints after removing the
redundant outer dialogue clip that cut the negative-offset nameplate. The inner
scroll clip remains. A fixed frame-count assertion was replaced by a bounded
wait for the actual manual-pause hint. Older failed and diagnostic runs remain
retained. The ordinary store is byte-identical after final input acceptance.

The cached layout avoids new paragraph measurement during reveal, but this is not
a claim that the entire paint path is allocation-free. The current rich painter
collects source text and scans codepoint offsets per fragment; long paragraphs
need an explicit profile before any further slicing/copy optimization is claimed.

## Shared original and translated authoring controls (2026-11-09)

`editor/client/novel-rich-editor.js` now owns the existing scalar-range editing
controls for both source and translated dialogue. Source and locale pages pass
adapters for their own canonical data/history and dispose replaced selection
listeners. This removes the duplicate editor path without introducing a second
rich-text schema. The source story remains unchanged when editing translations.

The saved translated catalog was compiled through `buildGuest` using the public
`NovelView`. The focused browser/native run passes 3 tests / 28 assertions: real
ruby paint, pointer-opened translated note, retained manual pause, suffix reveal
and ending. Exact saved inputs, fixture, Guest and hashes are retained in
`sdk/.pocket-build/localized-rich-editor-20261109/acceptance-manifest.json`.
This run explicitly used `POCKET_BUN` with Bun 1.4.4. The default managed Bun
1.3.9 compiler crash was reproduced and preserved; this result does not resolve
that toolchain failure or establish full Editor regression acceptance.
