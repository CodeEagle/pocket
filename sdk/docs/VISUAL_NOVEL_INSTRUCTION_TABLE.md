# Canonical instruction table authoring

## Source-first review and required behavior

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected excluding `pocket_host/`. Its `mini_apps/app_ui_showcase/main.js`,
`mini_apps/app_nav/main.js`, `mini_apps/app_login/main.js` and
`lib/ui/mini_app_host_page.dart` retain ordinary JS event/state and host render
behavior, but no VN instruction schema, authoring table or regression scenario.
There is no parent VN table implementation to migrate.

The current SDK's `editor/client/novel.js` already owns the canonical story,
validated fields, grouped persistent undo/redo, save and pinned build actions.
Its dialogue table supplies source-position rows, applied search and bounded
25-row pagination. The general table must extend those facilities, editing
original objects directly rather than keeping a second spreadsheet document.
The existing engine schema and validator remain authoritative; the table must
not interpret commands or invent another script format.

Required acceptance covers original cross-label source indices, literal JSON
value types including false/zero/empty string, immutable stable IDs, nested and
unknown-field preservation, invalid JSON rejection, grouped history, saving,
reopening, pinned compilation and input-driven native execution of the changed
variables and route. Table scope/search/page state must not dirty the story.

## Shared table implementation

Open **对白表格 → 指令范围 → 全部指令**. The existing table, search,
source-row projection and 25-row pagination are shared with dialogue mode.
The default dialogue mode and its existing selectors remain available.

All fifteen current instruction types are listed: say, scene, audio, video,
wait, input, set, inc, trade, branch, jump, call, return, choice and ending.
Original label/index, type and stable ID remain read-only. Common string,
number, Boolean and target fields edit the original instruction object.
Nested characters, conditions, options and other structured values reuse the
existing JSON field and its invalid-input save guard. Unknown types are shown
as read-only data; showing them does not assert runtime support.

Video action and input type remain read-only in the compact table because
switching their variants also changes other fields. Their existing complete
forms own those transitions; each row links to its source instruction there.
Absent optional structured/numeric fields are not materialized merely by
viewing the table. Adding omitted fields and changing structural modes remain
in the complete form. This is not a spreadsheet column for every nested leaf.

The only additional table state is the presentation scope. No second story,
interpreter, parser, history stack, persisted search index or table import step
was added. The opcode-to-field map describes presentation only; the existing
engine/server schema validates the same canonical document. JSON and checkbox
helpers accept optional explicit history keys so cross-label cells cannot share
an edit group accidentally. Old helper call sites retain their prior behavior.

Root review removed an unsupported expression path for inc.amount (the engine
requires a finite number), restored visible captions hidden by dialogue-only
CSS, reused full forms for structural changes, and made source-position search
match the displayed label:index. Numeric bounds cover wait/seek/trade fields;
semantic validation remains with the existing engine.

## Executed acceptance (2026-11-08)

Pinned Bun 1.4.4 and managed Playwright Chromium ran
`editor/test/novel_instruction_table_browser.test.ts`: **1 pass / 0 fail**,
6.67 seconds, exit 0. The isolated project contains 39 instructions in five
labels, including all fifteen supported types. The browser verifies bounded
25/14 row pages, original cross-label locations, typed JSON zero/false/empty
string display, structural read-only fields, nested JSON edits and invalid JSON
save rejection. Grouped text undo/redo, save/reload and whole-document equality
preserve stable IDs, absent speaker, custom/nested data and exact locale bytes.

The Editor builds the saved document through the pinned buildGuest pipeline.
Actual NativeSession title pointer input then executes edited set/inc/wait/jump
instructions and renders `score=12; flag=true; word=Typed value`. Pointer input
on the visible Continue action reaches the expected edited-target ending; the
old decoy route is absent. Raw dialogue and ending frames preserve the actual
line breaks. Nested scene/choice edits in this fixture are source/save/build
checks; the native path does not execute those unreachable instructions.

The first run passed the browser and build stages but failed a test assertion
that assumed the wrapped words `Typed value` occupied one text line. The final
test normalizes whitespace while checking the exact values and route and uses
the actual Continue action for progression. No production change was needed
for that test correction. The failed attempt remains archived.

Regression command ran the existing dialogue-table, camera-editor and
interchange browser suites: **3 pass / 0 fail**, 12.11 seconds, exit 0. These
retain grouped history, metadata, imports/exports and actual changed-line Guest
execution. `node --check editor/client/novel.js` also exited 0. Root inspected
the mixed-table screenshot and verified every executed source hash against the
final worktree. No claim of performance or physical-device acceptance follows
from these Editor tests.

## Reproduction and artifact ownership

From `sdk/`, use pinned Bun with:

```sh
POCKET_TOOLS_PACKAGE="$PWD/.pocket-build/retina-native-tools-20261108" \
POCKET_NATIVE_PROBE="$PWD/.pocket-build/retina-native-tools-20261108/bin/pocket_probe" \
.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --max-concurrency=1 editor/test/novel_instruction_table_browser.test.ts
```

Unset POCKET_NATIVE_LIBRARY when using this pinned probe. Tests create private
project/workspace paths, ephemeral Editor ports and managed Chromium, then close
the native session, browser and server and remove the project in finally.

Evidence is under `sdk/.pocket-build/instruction-table-20261108/`: acceptance
and regression logs/results with source hashes, before/candidate source copies,
final-source-manifest.json, failed attempt1, and captures/ containing the full
saved story/locales, mixed-table screenshot, raw Guest text, QJBC, PAK, metadata
and their manifest. The final ordinary game story/QJBC/PAK hashes equal the
baseline; no player rebuild or model test was needed for this authoring change.
Live2D work is deferred at the user's request. The ordinary Demo remains open.

This closes the bounded common-field instruction-table workflow. Structural
mode transitions, absent optional-field creation, instruction insertion and
stable-ID renaming still belong to their existing full forms. Ren'Py export,
Word import, other device/platform gates and the full engine Goal remain open.
