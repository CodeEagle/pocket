# Context reconstruction and visible-source navigation

## Reference and source-first boundary

The official [LetsGal debugging guide](https://docs.avg-engine.com/manual/overview/debugging)
was checked on 2026-11-09. It describes inheriting prior performance state and
locating the executed source of a currently displayed scene or actor. It also
warns that source facts describe the current preview route, not unexecuted
branches. Pocket must preserve that distinction rather than infer an execution
history from a reverse search of authored labels.

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected excluding `pocket_host/`. `mini_apps/app_nav/main.js` exposes
named `Host.navigateTo` destinations; `mini_apps/syslib/pocket_syslib_router.js`
provides navigation-stack lifecycle and transitions. Those are retained host
navigation behaviors, not a VN contextual-preview interpreter. The necessary
adaptation belongs in the migrated JS SDK and Editor:

- `packages/pocket_vn/src/engine.ts`: real instruction validation, transaction
  boundaries, variables, call stack, stage, audio intents, breakpoint/step/tick.
- `packages/pocket_vn/src/types.ts`: committed OP source addresses and immutable
  snapshots, including the actual active instruction's location.
- `editor/client/novel.js`: existing engine subscription/disposal, preview clock,
  bounded committed trace, and source navigation that validates current source.
- `editor/test/novel_debug_trace_browser.test.ts`: real browser pause/step,
  breakpoints, trace bound, source selection and stale-source regression.

No Flutter business state, alternative interpreter, route guesser or project
save is required to inspect a story. A raw debug jump retains old state by
contract; it must remain distinguishable from rebuilding prior context.

## Shared API and preview policy

`createNovelContextPreview(story, target, options)` creates an isolated ordinary
engine. `continueNovelContextPreview(engine, sameTarget, options)` resumes the
same preview after the author has made a real choice or submitted typed input.
Results contain `engine`, `snapshot`, `status` (`reached`, `blocked`, `ended`,
`limit`), a committed-OP `steps` count and an optional blocker reason.

The helper uses the engine's target breakpoint and ordinary start/resume,
advance and tick operations. It has no instruction interpreter or host clock.
Prior dialogue is revealed and committed without waiting for a reading delay or
voice playback; the reached dialogue is revealed once and remains active. An
explicit wait uses `tick(remainingMs)`, preserving elapsed camera, transition,
timeline and audio-gain semantics. Unknown choices and inputs are never guessed.

The default work slice advances at most **256** prior dialogue/wait passages;
it can return `limit` and continue another slice. This is a passage limit, not
an exact OP interruption point. Each canonical engine transaction retains its
own `maxStepBudget`; a failed transaction's operations do not appear in the
committed count. An immediate loop can remain at its rolled-back state and
requires a story fix, rather than pretending that repeated Continue makes progress.

A temporary trace subscription counts committed operations and optionally sends
them to the Editor's existing collector. It is removed after each call. A weak
session association retains only the target, authored breakpoints and completion
flag; variables, stage, calls, history, audio and saves remain owned by the one
engine. Session metadata is not a new game-save format. Callers own returned
engines and must dispose them; failed creation disposes its candidate.

Choice/input results retain the engine's canonical unpaused state, because its
real interaction methods require that state. The helper attaches no clock.
The Editor must distinguish waiting for a decision from an authored breakpoint
pause and must suppress its RAF clock while reconstructing, rather than silently
let a choice timeout select a route. Preview policy is not evidence of physical
audio playback, natural reading time or model rendering parity.

## Debugger correction and ablation

An immediate loop with a breakpoint reproduced a canonical debugger defect:
`resume()` ignored the same source address for the entire transaction. The loop
hit the engine step budget and rolled back instead of pausing on its next visit.
The engine now consumes that exception at the first instruction boundary only.
`step()` uses the same corrected path. Replacing the breakpoint set preserves a
current stop key only when the paused address remains in the new set.

Context reconstruction retains its temporary target during the one real target
execution and then restores the authored set. A nonblocking target loop can
therefore pause on a revisit without running to the budget, and a temporary stop
is not described as an authored breakpoint. No extra scheduler or interpreter
was added. Resume/step self-loops, temporary/authored target loops and ordinary
no-breakpoint budget rollback have red/green regression coverage.

A Browser limit→pause→continue regression found a second ambiguity: while a
previous say/wait remains active, the engine cursor may already point to the
target. A paused active passage is now resumed through the ordinary engine
before reconstruction continues; only a paused state with no active passage
can represent the target instruction breakpoint. Red/green say and wait tests
and the default 256-passage Browser continuation prove the actual target active
address and ID, rather than accepting a status string alone.

Alternate-branch acceptance also exposed a stale trace DOM after installing
a captured slice. The UI now reconciles the bounded list once after capture
installation. Engine replacement clears old rows and revision caches before
adopting its new sequence, so identical sequence numbers cannot reuse a previous
engine's row closures or content. Both the real alternate scene and the helper's
reached target must appear in the final displayed trace.

The Editor collector uses a temporary bounded capture during a reconstruction
slice and installs it once, suppressing duplicate trace collection and per-OP
DOM work. Configuration provenance retains only current scene facts rather than
a second unbounded execution log. These remove redundant observation work; they
are not evidence that the whole-game frame-time or RSS gate has passed.

## Remaining scope

The original increment below starts from `story.start`. The subsequent
[independent-entry increment](VISUAL_NOVEL_CONTEXT_ENTRY.md) adds declared replay
and canonical chapter roots; consult its acceptance status separately. An
independent root begins with fresh state or explicit SDK seeds, not invented
mainline history. A target outside the chosen route still stops at a real
decision, ending or execution limit.

Source controls describe visible dialogue, ending, background/layer image and
character configuration from committed source. They do not yet inspect every
animated transform, camera/timeline track, audio state or unsupported native
model-preview surface. Browser source navigation does not validate Live2D
quality or replace its missing native Editor preview. These limits remain
explicit in E04.3/E07 and the full goal.

## Accepted increment and evidence

The frozen SDK suite passes **255 tests / 2,119 assertions**; the relevant
Editor schema, graph and history unit selection passes **36 tests**. Strict
TypeScript checks of the helper and Editor runtime exports and the architecture
check pass. Tests cover canonical calls/returns, timed scene/audio state,
unresolved choices and inputs, resume, authored target breakpoints, limits and
invalid addresses. The actual Lantern first dialogue, post-wait dialogue and target
choice match an independently driven engine projection; an off-route replay
stops at the unresolved mainline choice. A raw jump is retained as a negative
control because it does not create the earlier scene. Those read-only checks
do not write the Demo story or normal player store.

Visible dialogue must locate its actual active address. Background/actor source
navigation uses committed scene operations and must become unavailable when its
provenance is unknown or stale. Configuration-source controls describe the
background image or actor configuration, not every later animated transform.
Navigation cannot write story data or claim an unexecuted branch produced the
current image.

The final combined browser run passes **2 tests**: actual context rebuilding,
source navigation, draft/undo isolation and the pinned Guest input round trip;
and regular-preview camera/timeline progress, pause and idle-clock behavior.
The Guest directly imports the shared helpers. Real pointer selection and the
registered `textInput.open` / edit / submit protocol produce the same variables,
background, actor configuration, camera, call stack, audio intent and active
source address as the browser. This proves the helper's bytecode compatibility,
not a Flutter physical-IME or model-quality acceptance. The existing debug-trace
and input browser regressions also pass; the final UI-only notice correction is
covered by the new combined run.

The separate bounds Browser test passes **1 test**. After 210 prior OPs,
the 200-row display no longer contains the scene, while its actual configuration
source remains locatable even after clearing the display trace. A 60 ms timed
choice remains unresolved after 180 ms. The default 256-passage slice returns
`limit`, and continuing reaches the actual `long_route:258` target dialogue,
including its correct ID, complete text and retained variables. The earlier
false-reached failure remains in the red run. The main Browser test also selects
the alternate branch for real: it returns through the call stack and ends before
the other branch's target, with the archive source and exact committed scene row
from that executed branch.

The final compiler is the pinned `retina-native-tools-20261108/compiler/tools/build.ts`
(SHA `b3e25736…`), and the release native probe is `a7bad801…`. Implementation
hashes are frozen: engine `88f7a40d…`, helper `0e1c847b…`, Editor JS `f308c796…`.
Raw test output, compiler/probe/package hashes, native input-driven frame facts,
seven browser captures and failed fixture runs are retained in
`sdk/.pocket-build/context-preview-20261109/`. `final-manifest.json` validates the
passing run against those frozen sources; the full browser/native run is under
`run-2026-11-08T20-26-38.854Z-33629/`, with its regular-clock evidence under
`clock-run-2026-11-08T20-26-48.240Z-33629/`.

The ordinary Demo remains PID40085. Player-store SHA `038051b6…`, staged and
embedded four-asset hashes, and Demo story/localization sources are unchanged.
No normal-player restart or package replacement was needed for this Editor
increment. This does not claim the user saw a foreground window; the earlier
loginwindow limitation remains. E04.2/E04.3 remain partial for the scope above;
54-group totals stay **9 passed / 34 partial / 11 pending**, and the full goal
remains active. Live2D clarity and the whole-game performance gate remain open.
