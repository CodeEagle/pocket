# Independent author-preview entries

## Scope and source-first boundary

Status: independent-entry SDK, Editor and pinned Guest interaction accepted
(2026-11-09); the full goal remains incomplete.
The full 54-group goal remains active. Live2D clarity is deferred by the user;
this increment does not change model sampling, normal-player assets or saves.

The official [LetsGal debugging guide](https://docs.avg-engine.com/manual/overview/debugging)
was checked on 2026-11-09. It distinguishes project-entry debugging from starting
a current chapter, and explains that chapter-dependent state needs the full path
or explicit setup. An independent author entry must therefore not be described
as reconstruction of an unexecuted mainline history.

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected excluding `pocket_host/`. `mini_apps/app_nav/main.js` and
`mini_apps/syslib/pocket_syslib_router.js` supply named host navigation and page
lifecycle, but no VN replay, entry reconstruction or chapter context to migrate.
This increment adapts the existing JS implementations:

- `packages/pocket_vn/src/replay.ts` and `replay-schema.ts`: declared exact replay
  locations, isolated constructor seeds and normal player-gallery ending gates.
- `packages/pocket_vn/src/blueprint.ts`: real jump entry and call/jump chapter
  instructions, with kind/title annotations that normal execution ignores.
- `packages/pocket_vn/src/preview-context.ts`: bounded canonical execution,
  target/authored breakpoints, real decisions and committed trace collection.
- `editor/client/novel.js`: one engine lifecycle, draft invalidation, original
  source mapping and one bounded trace reconciliation per captured slice.

There is no second story interpreter, stage reconstruction document or Flutter
business state. Existing normal-player replay behavior must stay gated.

## Entry and initialization contract

The existing context API keeps its default main-story behavior. Optional author
roots select the main entry, an explicitly declared replay by ID, or a chapter
blueprint by label. A blueprint root must have entry/chapter metadata and the
matching real instruction shape (one jump, or call plus jump); stale metadata
alone cannot qualify an arbitrary label. The exact original source address is
retained; the story start is not rewritten.

Independent roots use a fresh constructor state by default. They do not copy a
previous preview's stage, audio intents, calls, history or unresolved input. The
existing explicit `initialVariables`, `initialMeta` and preference options remain
available to SDK callers. A replay may instead provide a `NovelReplaySource`,
copying the existing factory's variable/meta/preference seed shape and forcing
manual reading. Conflicting seed sources must be rejected rather than silently
choosing a precedence. The Editor uses fresh defaults in this increment.

Author preview may inspect a declared locked replay without fabricating ending
IDs or changing player progress. This is an explicit debugging policy; the
normal `createNovelReplayEngine` gallery gate remains unchanged. Entries still
need to establish their own scene and state. If the selected root cannot reach
the target, the helper reports the real blocker, ending or execution limit.

The target breakpoint and committed-trace listener must be installed before the
entry executes, including a nonzero replay index or an entry that is itself the
target. Canonical `debug.jump` is only used on a new isolated engine at the chosen
entry; its mechanical pause must not be confused with a real target/author
breakpoint. Subsequent work uses the same bounded advance/tick/resume path.

## API and provenance

`listNovelContextPreviewRoots(story)` returns selector rows with a stable value,
small root identity, exact `location`, title and optional blueprint node kind.
The Editor derives these rows when the workspace changes, not on every animated
preview frame. `createNovelContextPreview` accepts `options.root`; its result
and continuation results report the frozen root identity and `rootLocation`.
Neither result nor the weak session metadata retains a source snapshot.

The first budget negative control reproduced `limit` followed by `reached` on
the main story even though a replay loop was selected. The one-off bootstrap
argument has been removed: an unstarted engine always retries the session's
recorded origin. Both replay and blueprint rollback cases must remain at their
real limit, with no mainline assignment committed. Returned root metadata is
copied so mutating a result cannot change subsequent bootstrap ownership.

## SDK evidence (2026-11-09)

The frozen SDK suite passes **260 tests / 2,174 assertions** and the scoped strict
TypeScript check passes. `preview-context.ts` is `0cc15e25…`; the engine source is
unchanged. The retained red budget probe previously reported a replay root but
executed `main_only=99`; the fixed probe remains at `limit` without executing
main. The suite covers replay and blueprint rollback, result-root mutation,
locked-author preview versus normal gallery gating, explicit source seeds and
entry breakpoint/trace behavior.

The actual Lantern story is checked read-only against independent canonical
engines: both 59/60 replay choices, fresh chapter entry without the preceding
assignment, genuine wrong-root ending, rejection of an assignment node as a
chapter root, and the mainline's actual unresolved choice. The source story and
parked main engine save stay unchanged. This is state/control-flow evidence,
not physical image or audio playback parity.

## Editor and pinned Guest interaction evidence

The new browser scenario runs the actual saved project through pinned
`buildGuest`, Playwright Chromium and the real native Probe. It verifies main
versus replay isolation, a nonzero replay target executed once, an authored
breakpoint preserving a genuinely empty stage despite registered images, real
choice/input continuation and exact committed source navigation. Author preview
of a locked replay leaves `endingIds` empty; ordinary gallery gating is covered
by the SDK suite.

Renaming a label invalidates the context result while the existing unique
instruction-signature mapping can still identify its renamed source. Editing
the scene content clears the prior source claim. Changing the selected root
pauses the old timed-choice engine, disables its choices and preserves its old
origin description beyond three timeout periods. A different valid chapter
root reports its real early ending rather than claiming the target was reached.
Native pointer events and the official text-input protocol exercise the same
selected replay path; a prompt label is not the text field's hit target.

The final read-only review also identified a DOM reuse boundary: label/index/ID
alone do not distinguish text and boolean input controls after author edits.
The reuse key now includes the canonical input type, rebuilding a changed
control kind while retaining stable DOM during ordinary same-input typing.
The actual same-root/address/ID text-to-boolean edit/rebuild/check/submit
regression passes and writes a boolean `true`; the existing composing-input
node-stability and compiled Guest input assertions also pass.

The final `context-root-ui-final4-aed34e64` context-preview target/clock, bounds,
debug-trace and expanded input scenarios pass (5 tests across 4 files). QA commands, exact source hashes, screenshots,
raw frames and retained failed controls live under
`sdk/.pocket-build/context-entry-20261109/`. Consult its final manifest for the
accepted frozen runs. Ordinary Demo PID40085, player store, both copies of all
four Lantern assets, story and localization are unchanged.

This accepts independent author entries only. Full animated-transform/audio and
native-model source inspection, physical-device/platform release gates and
whole-game performance remain open. E04 remains partial, the 54-group totals
remain **9 passed / 34 partial / 11 pending**, and the full goal remains active.

## Frozen acceptance identifiers

The accepted new entry run is `context-entry-browser-final-ui` (1 pass), with
`preview-context.ts` SHA-256 `0cc15e25cea0be33c823c2fa33fa96818628dd47fa401a4ba5cbd20b50c227ef`
and `novel.js` SHA-256 `aed34e641f6e6d5f39261a97ff6425e40cdad9107bfc69fb9e4f2a12cd22e1d0`.
`context-entry-final-manifest.json` records all sources, compiler/probe/package
artifacts, eight screenshots and nine native frames. Browser and Guest agree on
`routeNo=59`, `routeCode=NORTH`, absence of `mainOnly`, background `dawn`, return
to `chapter_entry:1` and active `chapter_body:2`; the wrong root ends at its real
`wrong-ending`. The whole-increment `final-manifest.json` also checks the scoped
SDK/regression runs and unchanged ordinary-player state. Failed initial runs are
retained separately rather than counted as accepted evidence.
