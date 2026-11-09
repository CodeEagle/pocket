# Visual novel Editor history

The Editor persists its existing JavaScript undo and redo stacks so a browser
reload or Editor restart can reopen the same draft and continue undoing or
redoing. The journal does not write project source. It stores the current draft
head because the existing stack entries contain restore snapshots and assume
the head that was active when the stack was made.

## Source and retained behavior

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
has no visual novel Editor or browser undo implementation outside its excluded
`pocket_host/` tree. Its `lib/core/perf_monitor.dart` history is a separate
runtime performance log and does not apply to authoring. The behavior being
preserved is the SDK Editor's existing client history in
`sdk/editor/client/novel.js`: story/assets/project snapshots, grouped field
typing, and at most 32 entries in each stack.

The new backend keeps that client stack model. It does not add another history
engine, a project-file journal, or a Flutter state store. A saved entry contains
only its existing `scope`, `key`, and `restore` snapshot. Typing-group identity
belongs to a DOM field, so it is cleared on persistence and hydrate.

## Workspace journal and API

Journals live at `workspace/novel-history/<projectId>.json`, outside the
consumer project, backup tree, and Guest build inputs. Each record contains a
format version, the source token, a CAS revision, the current draft, and the
existing `undo` and `redo` arrays. The draft preserves `story`, `assets`, and an
optional raw PocketVN authoring draft `{text, baseline}`. The authoring text is
not parsed so incomplete or conflicted text can be recovered.

`GET /api/projects/:id/novel/history` returns the draft and stacks only when
the stored source token matches current source. `GET .../history?head=1`
returns just the current token, history revision, and an optional stale or
corrupt status. `PUT .../history` requires the expected source token and
history revision. A source-token or revision mismatch returns HTTP 409 with
`code: "novel_history_conflict"`; generic project-write reservation conflicts
remain separate. History requests never save story or asset files.

The source token is SHA-256 over the raw bytes of `story.json` and
`novel.assets.json` (with a distinct marker when the registry file is absent),
plus the project id and `novelRestoreEpoch`. The Editor server increments that
epoch only after a successful project backup restore. Direct edits to either
canonical document change the content digest. A stale record is reported and
not hydrated; the next accepted journal write can replace it using the new
token. Hashing is limited to the two documents the current history scopes can
restore; binary resources and unrelated custom consumer files are not part of
the history snapshots.

## Bounds and failure behavior

- Each undo/redo stack is limited to 32 entries.
- The complete request and sidecar are limited to 16 MiB.
- Story snapshots are limited to 2 MiB; asset registries to 512 KiB.
- Each raw authoring `text` or `baseline` is limited to 2 MiB UTF-8.
- History keys are limited to 1024 UTF-8 bytes.
- Story/assets shapes are structurally checked while missing labels,
  contradictory input bounds, replay locations, and partial resource paths
  remain editable draft values.
- The workspace directory, sidecar, and canonical source files are checked for
  symlinks. Sidecars are written to an exclusive temporary file, flushed, then
  atomically renamed and the directory flushed.
- Missing history starts with empty stacks. Corrupt and stale history is
  reported explicitly and never applied. Storage errors do not turn into a
  successful save or mutate project source.

## Validation

`cd sdk && bun test editor/test/novel_history_store.test.ts editor/test/novel.test.ts editor/test/novel_backups.test.ts`
passed 22 tests with no failures. It covers reopen serialization, malformed raw
authoring text, semantic draft errors, source hash invalidation, identical-source
backup epoch invalidation, history CAS, corrupt and oversized records, and
symlink refusal. The Chromium acceptance in
`sdk/editor/test/novel_history_persistence_browser.test.ts` exercises restart,
undo/redo of a saved state, restoration of an unsaved undo head, external source
changes, stale second-window writes, and backup restore invalidation.
It passed with `cd sdk && bun test editor/test/novel_history_persistence_browser.test.ts`
(1 test, 0 failures).

The browser scenario also interrupts the assets PUT after a successful story
PUT. The history status becomes pending as soon as the first source write
completes, then the existing journal is anchored to the files actually written.
Reopening restores the unsaved assets draft, marks it dirty, and a later Save
commits it. Previously the status could still say saved while that reanchor was
in flight, allowing the test to close the page before recovery was durable.
The corrected persistence scenario and the existing undo/preview browser test
pass together: 2 tests, 0 failures, 10.84 seconds using the side-by-side Bun
1.4.4 Playwright Chromium runner. Recovery does not make the two source-file
PUTs a transaction; partial source success remains visible and recoverable.
