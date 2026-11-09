# Locale rebinding must preserve the parked autosave

2026-11-08. The letter Profile acceptance failed after the English phone replay.
The diagnostic run preserved before/after JSON rather than weakening the store
comparison. Only the main auto slot changed: arrival_01 revealProgress 0→22.4,
revealedCharacters 0→22, visibleText empty→the first 22 characters, and camera /
transition elapsedMs 0→700. The isolated store grew from 3,177 to 3,277 bytes.
Evidence: `sdk/.pocket-build/lantern-letter-store-diagnostic-20261108/`.

## Cause and retained behavior

The main engine had already advanced before the player paused it and returned
to the title. `changeLocale` captures and loads that same paused in-memory
state into a localized engine. `engine.ts` restore preserves `raw.paused`;
locale save tests independently cover it. It was not a replay ticking main.
The app's autosave effect, however, rebuilt its lexical checkpoint as an empty
string on each engine identity change. Its `emitCurrent` subscription then
mistook the loaded locale snapshot for a new story checkpoint and saved its
partial text and animation progress over the parked auto slot.

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected excluding `pocket_host/`: generic WrapLines and primitive/image
rendering exist, but no VN replay/locale autosave controller was found. This
is an adaptation of the current JS-owned autosave listener, not a new Dart
state machine or a replacement storage provider.

## Ablation

`demo/js/apps/lantern/app.tsx` now computes the existing signature through a
local `checkpointFor` function and initializes it from the current engine
snapshot. The initial synthetic notification is unchanged and simply compares
equal. Subsequent real checkpoint changes still write through the same queue,
slot manager, locale rebase and canonical save codec. No cross-engine cache,
extra pause flag, alternate clock or storage layer was added. Initial engines
are ready; real newGame transitions still change the signature and create the
first auto slot. Existing input draft/error and video token/cue/status fields
remain in the signature.

## Real Guest regression

A new case in `demo/js/tests/novel_letter_native.test.ts` starts a genuine new
game, allows 45 frames, opens the journal, returns to title, changes the actual
language setting, then opens and exits the letter replay. It asserts the auto
slot's serialized bytes and write count remain unchanged at all three stages.
No preloaded save fixture or engine-state mutation hides the initialization
path. On frozen b4e it fails before replay entry: partial reveal and animation
progress is written after the language change. On the new candidate the same
case and five existing letter cases pass (6/6).

The first test-authoring attempt used an unsupported cleanup method and was
corrected to the existing NativeSession.quit; that attempt is not acceptance.
The initial fixed-candidate attempt waited too few frames for the replay's
first typed phrase. It was corrected to the existing bounded visible-body
wait; no storage assertion was relaxed. The final passing log is
`/tmp/pocket-letter-locale-fixed-native-final-20261108.log`.

Final candidate QJBC: `9c01ae0def288419adcf5df0244291d15579b68fd614513dd5adfd32e45dfe39`
(1,081,116B). PAK remains `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`
(69,216,400B). Metadata: `23cd53354ba0efe5e6c4a83b5ec6990d293a80f4e9a4075c8d7259824b390781`.
Pinned buildGuest/new native-only tool package reused; no story, texture or
native-renderer change. Build, test source, baseline and final logs and staged
hashes are retained in `sdk/.pocket-build/lantern-locale-checkpoint-20261108/`.

Targeted repository-aware TypeScript check passed. Full Flutter four-case
acceptance subsequently passed (72 seconds, 20 PNGs, exact store equality and
parked main resume). The broader native scenarios passed across the original
10 passing cases and a pinned-Bun rerun of the two corrected drivers for
wrapped locale text/current catalog and actual title-menu scrolling. Logs:
`/tmp/pocket-locale-checkpoint-native-regression-20261108.log` and
`/tmp/pocket-locale-checkpoint-driver-native-pinned-final-20261108.log`.
This closes the identified save regression, not the overall Goal.

## Delegation and integration record

The App-thread tools required by the optional team skill were unavailable.
The user explicitly required native subagents and 6-Luna Max, so the parent
used three native workers with `gpt-6-luna` / `max` and no child delegation:

| Native task | Responsibility | Adopted result |
| --- | --- | --- |
| `/root/replay_store_audit` | Read-only causal review; then ownership of voice-locale/video native drivers | Confirmed checkpoint fix; updated wrapped/current catalog assertions and actual gallery scrolling. Parent reran both with pinned Bun 1.4.4 after the worker's 1.3.9 run. |
| `/root/mesh_edge_ablation` | Read-only remaining edge-AA audit; then Editor test tool-path parameterization and isolated workflow | Engine AA limit recorded; 46-assertion Editor path passed with new native tools and managed Chromium. Temporary service/browser cleaned up; old tool cache restored. |
| `/root/dialogue_bounds_acceptance` | New ordinary-dialogue native test and its evidence document | Actual route, full text/clip and Continue geometry at two viewports; one test passed. Remaining branches/pixels explicitly unverified. |

All three workers completed. Native worker sessions have no App-thread archive
action. The parent integrated the production change, preserved the failing
baseline and field diff, ran final native/Flutter checks, reviewed actual PNGs,
recounted the 54 groups, and replaced only the ordinary cached Demo after the
new window was observed. Overall Goal remains active.
