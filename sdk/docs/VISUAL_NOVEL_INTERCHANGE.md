# Pocket VN CSV and Markdown interchange

## Source-first review

I searched the retained first-layer parent project at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` for story-definition
tables, CSV import/export, and related tests, excluding `pocket_host/`. The
nearest retained UI examples are `mini_apps/app_ui_showcase/main.js` and
`mini_apps/app_ui_showcase.js`; they demonstrate generic JS-owned component
state and rendering, but contain no visual-novel authoring/import/export flow
or regression scenario. There is no parent CSV implementation to port.

The reusable behavior is in the current SDK sources:
`sdk/packages/pocket_vn/src/authoring.ts` provides the canonical
`formatStoryText()` / `parseStoryText()` normalization path, and
`sdk/packages/pocket_vn/src/interchange.ts` already provides the shared CSV
tokenizer, size bounds, metadata reconstruction, ordering checks, and atomic
v1 import. `sdk/packages/pocket_vn/test/interchange.test.ts` preserves the
roundtrip, malformed-input, and size-limit scenarios. The necessary adaptation
is a readable table projection over that same StoryDefinition: retain v1
unchanged, place common first-class strings in columns, and keep all remaining
or non-string data in JSON parameters. No second story parser or runtime was
added.

The current SDK already has a lossless authoring language in sdk/packages/pocket_vn/src/authoring.ts: formatStoryText() and parseStoryText() preserve all current instructions, quoted labels, and custom JSON metadata, including unknown future instruction objects. sdk/packages/pocket_vn/test/authoring.test.ts records those roundtrip cases. Before the friendly CSV integration, the Editor in sdk/editor/client/novel.js exposed JSON import/export and the separate dialogue projection; v2 adds a table file path through this shared codec and the existing draft/history path rather than adding another story interpreter.

## Public API

sdk/packages/pocket_vn/src/interchange.ts exports:

- formatStoryCsv(story) and parseStoryCsv(text).
- formatStoryTableCsv(story) and parseStoryTableCsv(text) for friendly CSV v2.
- formatStoryMarkdown(story) and parseStoryMarkdown(text).

`parseStoryCsv()` automatically accepts CSV v1 and friendly table CSV v2.
`parseStoryTableCsv()` accepts v2 only. `src/index.ts` already re-exports the
interchange module, so these functions are public without another wrapper.

Formatters return text. Parsers return { story, diagnostics }; any malformed or conflicting input returns story: null, so callers never receive a partially imported script. Diagnostic messages identify the bad CSV row or Markdown line when available. The Editor runs its draft validation after import and receives the existing core validation result when saving.

## CSV v1 schema

CSV uses RFC-style comma separation, double-quote escaping, and CRLF output. Imports accept CRLF, LF, standalone CR, an optional UTF-8 BOM, Unicode, and quoted multiline fields.

The header is record,label,index,type,payload. It is followed by:

1. One format row: format,pocket-vn-csv,1,,.
2. One document row whose payload is a JSON object containing all story fields except script.
3. Ordered label rows. A label row declares a label, including labels with no instructions.
4. Instruction rows containing the label, canonical zero-based index, type, and the complete instruction as canonical JSON. The type column must equal the JSON object's type.

Every instruction payload remains authoritative and can contain custom fields. Labels are declared before their instruction rows. Indexes must be unique and contiguous from zero. Duplicate labels/indexes, a missing index, an undeclared label, a type mismatch, or any malformed JSON rejects the entire file.

This is lossless machine interchange; the JSON payload column is not a spreadsheet-friendly translation column. Editing only the visible type or payload cells creates a conflict that import rejects.

## Friendly CSV v2

`formatStoryTableCsv()` writes `record,label,index,type,id,speaker,text,target,asset,parameters,present` and a `pocket-vn-csv,2` format row. Document metadata stays as one JSON object in `parameters`; label and instruction rows remain ordered exactly as in the source story, including empty labels. The v1 header, writer, and parser behavior are unchanged.

The first-class string columns are `id`, `speaker`, `text`, `target`, and
`asset`. `asset` maps to `say.portrait`, `scene.background`, `ending.cg`, or
`audio/video.cue` for those instruction types, and to a literal `asset` field
for other types. `parameters` contains every other instruction field, including
nested choice options, custom extensions, nullable values, and values whose
type is not string. A string-valued first-class field is promoted into its
column; if the same property is stored in `parameters`, import rejects the
conflict. This makes the first-class columns convenient to edit while keeping
the remaining data lossless; nested choice strings are retained as JSON and
are not presented as separate table columns.

`present` is a JSON array naming promoted columns that were present as strings
in the original instruction. A non-empty cell is treated as present even if a
spreadsheet user types into a previously absent column, so adding a value does
not require a second edit to `present`. A marked empty cell means the field is
the explicit string `""`; an unmarked empty cell means the field is absent.
Nullable or other non-string first-class fields remain in `parameters`, so
they keep their original JSON type. Removing a marked field requires removing
its name from `present` as well as leaving the cell empty.

V2 preserves unknown instruction objects as data; importing one does not assert
that the engine can execute that future instruction. Duplicate labels or
indices, index gaps, duplicate presence names, conflicting promoted fields,
incorrect row shapes, and malformed JSON reject the whole import. The parser
uses the existing bounded CSV tokenizer and canonical StoryDefinition path.

## Markdown v1 schema

Markdown is an ordered outline with the marker <!-- pocket-vn-interchange:markdown:1 -->, one fenced JSON metadata object, then numbered label sections. Each label section contains one fenced JSON object with exactly label and instructions. The data block, not the heading text, holds the label name and every instruction. The formatter emits no second display copy of story text.

The Markdown remains a structured JSON interchange document. It is readable as a section outline but is not prose-only Markdown or a Word export. Import requires this schema and rejects additional conflicting content.

## Validation and limits

Both formats pass the reconstructed StoryDefinition through the existing authoring formatter/parser, which enforces JSON-safe values and preserves current and future instruction payloads. Core semantic validation remains with the existing Editor/engine path after import; this codec does not reinterpret commands.

Each interchange document is limited to 8 MiB. CSV is capped at 110,003 records; Markdown at 250,000 lines. Both are limited to 10,000 labels, 20,000 instructions per label, and 100,000 total instructions. These bounds keep malformed or oversized exports from creating unbounded parser work.

## Ablation and validation

The codec adds no duplicate story state, second interpreter, translation database, archive dependency, or hidden full-story JSON copy. CSV instruction rows and Markdown label blocks are the sole payload; both use the same StoryDefinition and authoring parser as the block/text Editor. Supported imports are also instantiated by createNovelEngine() in the tests. V2 retains only one explicit presence array per instruction to distinguish an empty first-class string from an absent property; all other properties use the existing parameters object.

Run `bun test packages/pocket_vn/test/authoring.test.ts packages/pocket_vn/test/interchange.test.ts` from `sdk/`. The interchange tests also run with the pinned Bun at `.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun`. They cover current instructions, custom metadata, unknown future records, multiline/quoted/Unicode CSV, BOM and newline variants, Markdown roundtrip, duplicate/gapped/conflicting rows, malformed payloads, atomic rejection, and size limits. CSV v2 tests verify every current instruction type, nested/custom fields, nullable and non-string values, absent versus empty fields, user entry into a previously blank cell, and rejection of duplicate columns/indices/presence and conflicting parameters.

The Editor integration test, run with bun test editor/test/novel_interchange_browser.test.ts from sdk/, passed through the actual browser and pinned build path. It exported CSV, changed/imported/saved it, did the same with Markdown, rejected a malformed CSV without changing the draft or disk, reopened the project, built the edited story into a real Guest, and observed the imported line through native pointer input. The strengthened run also executed all four format/parse functions inside pinned QuickJS Guest bytecode before constructing the story engine, confirming they do not depend on Web TextEncoder; it rejected a malformed JSON script array before draft mutation and cleared the old replay-target validation issue after importing the correction. The latest run completed in 3.40 seconds with 1 pass / 0 failures; its captured output was /tmp/pocket-interchange-editor-browser.log.


## Editor dialogue table

The Editor's **对白表格** tab projects all `say` instructions from the existing
`story.json` into columns: original `label:index`, stable ID, speaker and text.
The location and stable ID are read-only. Stable IDs are also locale lookup keys
and participate in saved progress; this table does not rename them or maintain a
second locale catalog. Speaker and multiline text edit the original instruction
object through the existing `field()` history/dirty/validation path.

Search matches label, original index, ID, speaker or text when the user applies
it. Pages mount at most 25 dialogue rows; typing does not rebuild the table or
move the edited row. Filtering and pagination are temporary presentation state.
The table never reconstructs a script from visible rows, so non-dialogue
instructions, empty labels, unknown fields and instruction order are retained.
CSV v1 and Markdown interchange formats remain unchanged.

Source-first inspection of the retained parent (excluding `pocket_host/`)
found no story table/CSV authoring implementation to migrate. This adapts the
current Editor's authoritative story, input helpers and persistent edit history;
it adds no parser, runtime or parallel draft store. Stable-ID renaming, translation
editing and instruction insertion remain separate workflows.


Validation on 2026-11-08: `novel_dialogue_table_browser.test.ts` passed 1/1
(5.27 seconds). It used managed Playwright Chromium, searched across labels,
exercised 25-row pagination, verified the ID is read-only, typed through multiple
input events, undid/redid that edit in one step, saved/reopened, compared the full
story and unchanged locale file, built through pinned buildGuest, and displayed
the exact edited dialogue after real NativeSession title input. The existing
`novel_interchange_browser.test.ts` also passed 1/1 (4.80 seconds).
Logs: `/tmp/pocket-i02-dialogue-table-browser-20261108.log` and
`/tmp/pocket-i02-interchange-regression-20261108.log`. Screenshot:
`sdk/.pocket-build/novel-dialogue-table-20261108/dialogue-table-filtered.png`.
The Editor server, browser and native probe were closed in test cleanup. This
verifies the table workflow, not Ren'Py/Word export or other target devices.


## Friendly CSV Editor-to-Guest acceptance (2026-11-08)

Editor now offers “表格 CSV（可编辑列）” in the existing export selector. The same import action detects v1/v2; it uses the existing canonical draft, history, validation, save and buildGuest paths. No parallel document store or parser was added.

Managed Playwright Chromium `novel_interchange_browser.test.ts` exited 0 (1 pass, 7.03 seconds). In addition to the retained v1/Markdown malformed-file and semantic-diagnostic checks, it exported v2, filled a previously absent speaker cell with `Mira`, and edited a text cell containing an ASCII comma, quotes and a newline. It imported, undid/redid, saved and reopened, then compared the entire story including empty labels, metadata and custom instruction data. The generated Guest itself performs v2→v1→Markdown roundtrips in pinned QuickJS before starting the engine; real title pointer input produced the edited Chinese dialogue and speaker. The reopening screenshot was inspected. The temporary Editor server, browser and native session were cleaned; the ordinary player app was not rebuilt or replaced for this authoring-only change.

Source snapshots/hashes, original/edited CSV, full saved story, screenshot, exact QJBC/PAK/metadata, rendered Guest text and driver log are frozen under `sdk/.pocket-build/novel-friendly-csv-20261108/`. Full SDK `pocket_vn` regression exited 0: 187 tests, 1,539 assertions, 38 files. Targeted authoring/interchange and strict codec type checks also passed.

This closes the friendly CSV file workflow; it does not claim general inline instruction-table columns, Ren'Py export, Word export, physical-device rendering or the whole I02 group is complete. Nested parameters remain structured JSON, while common string fields are directly editable columns.


Independent review found one import-byte boundary defect: `File.text()` silently replaces malformed UTF-8 before JSON/CSV/Markdown parsing. A real browser baseline injected `0xff` into an otherwise valid v2 text cell; the import accepted `���格编辑` into the draft. The baseline regression exited 1 as expected, before saving corrupt data. Story import now reuses manuscript import's `TextDecoder("utf-8", { fatal: true })` boundary. The same test exits 0 (1 pass, 6.13 seconds), rejects the bad file while preserving the draft and saved story, then completes undo/redo, save/reopen and actual Guest execution. The final evidence/source hashes are under `sdk/.pocket-build/novel-friendly-csv-20261108/utf8-candidate/`; the reproduced failing baseline is under sibling `invalid-utf8-baseline/`. The earlier 7.03-second pass is explicitly historical before byte-boundary hardening, not the final source snapshot. The pure string SDK parser does not decode file bytes; strict decoding is owned by the browser IO boundary.


## Word script review export (2026-11-08)

The existing export selector now includes **Word 审阅稿**. It POSTs the current in-memory story draft to `/api/projects/:id/novel/export?format=docx` and downloads a real DOCX; saving first is unnecessary. It does not write the story, create history, or change revision/build state. Legacy GET JSON export is unchanged. This is a script review document, not a Word import format or a lossless exchange of all story-level settings.

The writer reuses the canonical authoring parser/formatter and existing ZIP writer. Dialogue, all labels, source locations, instruction IDs, choices/targets and complete non-dialogue instruction JSON remain reviewable. Input is strictly decoded as UTF-8 and bounded while streaming; exceeding 8 MiB cancels the stream. Native WordprocessingML text elements preserve source tabs/newlines; invalid XML scalars are rejected explicitly.

Final validation: 28 core/route/legacy/history tests passed; the real managed-Chromium download retained the unsaved draft without touching disk/history/revisions, then the existing save/reopen→pinned buildGuest→native input sequence passed (1 browser test, exit0). The system Office reader opened the downloaded DOCX. LibreOffice converted the complete Lantern script to 113 A4 PDF pages, and PDFKit extracted all 531 instruction positions in source order and all 255 complete dialogue bodies (whitespace-normalized for PDF extraction). All-page contact sheets and full-size first/middle/last pages were inspected. Microsoft Word application rendering itself was not available for testing. Source, tool provenance, artifacts, limits and source-first rationale are in [Word export](VISUAL_NOVEL_WORD_EXPORT.md).


## General inline instruction-table acceptance (2026-11-08)

The same dialogue table now has an **全部指令** scope for all fifteen current
opcodes, sharing 25-row pagination, applied source/field search and canonical
story/history. Common typed fields and nested JSON edit in place; structural
video/input variant changes and omitted optional-field creation remain in the
linked complete forms. The previous “general inline table missing” statement
above describes the earlier CSV checkpoint, not the current implementation.

New browser→pinned buildGuest→NativeSession acceptance passed 1/1, including
cross-label typed/nested edits, invalid JSON save rejection, undo/redo,
save/reload and changed variables/jump/ending execution. Existing dialogue,
camera and interchange regressions passed 3/3. See [instruction table evidence](VISUAL_NOVEL_INSTRUCTION_TABLE.md)
for exact scope, artifacts, source provenance and remaining limits. This does
not complete Ren'Py export, Word import or the full I02 group.
