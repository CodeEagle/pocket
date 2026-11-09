# Lantern Letter Showcase Flutter Acceptance

## Scope

`demo/integration_test/novel_letter_showcase_test.dart` exercises the normal
Showcase entry. It creates a real main-story autosave at `arrival_01`, returns
to the title page, opens the featured `An Unsent Letter` replay by its visible
title, and drives the fullscreen letter, floating echo, and ordinary dialogue
with actual guest-painter targets and Flutter pointers.

The test covers four Flutter constraint combinations: 329×600 at DPR 2 and
1280×900 at DPR 1, each in Chinese and English. These are test-view constraints
inside the integration-test window; they do not claim a physical phone size or
an operating-system window resize. Twenty RepaintBoundary PNGs are written to
the test's printed `Directory.systemTemp` output path, with a SHA-256 for each
capture and QJBC/PAK/metadata fingerprints in the log.

## Reused interaction and source behavior

The test reuses `guest_interaction_test.dart` for clipped DrawOp hit points,
stable guest pointers, and real scroll gestures, plus
`novel_performance_support.dart` for isolated application support. It follows
the existing input, model-showcase, and UI-matrix tests for lifecycle resume,
private auto-save inspection, decoded image-skin checks, screenshots, and
integration checkpoints.

The retained parent outside `pocket_host/` exposes `View.WrapLines` as a list
of explicit lines (`lib/render/pocket_ui_components.dart`, case
`View.WrapLines`) and uses it from `mini_apps/syslib/pocket_syslib_pages.js`.
That behavior preserves authored line breaks, while this SDK also needs to
wrap each long paragraph to its current guest width. `wrapTextLines` now keeps
the authored `\n` boundaries, measures each non-empty paragraph through the
existing `ui.wrapText` bridge, and preserves empty paragraphs. This repairs the
letter's narrow-screen overflow without adding a second text layout engine.

The fullscreen and floating say plates also reserve `toolbarHeight + 12`
logical pixels at the bottom. The test checks the actual `Continue` DrawOp is
visible above the toolbar hit region before tapping that control; it does not
advance the story by tapping the letter background.

## Isolation and restore checks

The main story runs in an `IsolatedNovelSupportDirectory`. The test captures a
non-empty auto-save whose active story location is `arrival_01`, compares the
platform-store bytes before and after every replay, and then resumes that same
main location. At the end it confirms the normal user's app-support store is
byte-for-byte unchanged.

It advances through all three visible letter presentations, taps the actual
rewind toolbar action, and compares the restored floating line's painted
geometry with its earlier position. SDK save/load and rollback derivation from
the active story location are separately covered by
[`VISUAL_NOVEL_SAY_PRESENTATION.md`](VISUAL_NOVEL_SAY_PRESENTATION.md).

## Final validation status

The final staged Guest `9c01ae0d…` / PAK `3d775a1f…` passed the full macOS
Profile matrix: Chinese and English, each at 329×600/DPR2 and 1280×900/DPR1.
The run completed in 72 seconds; driver required/completed `letter-showcase`
checkpoint is complete and all tests passed. Twenty real RepaintBoundary PNGs,
the exact test source, driver log, Guest fingerprints and a file-hash manifest
are archived at `sdk/.pocket-build/lantern-letter-profile-final-20261108/`.
Full-screen scroll to the terminal sentence, floating text visibility, ordinary
dialogue, real Continue, rollback geometry and image skins passed in all four
cases. Each replay kept the complete isolated platform-store bytes unchanged;
the parked main arrival_01 resumed afterward in the selected English locale.
The normal user's support store also remained byte-for-byte unchanged.

The separate NativeSession suite passed 6/6, including a new genuine
new-game→title→language-switch→replay regression. Editor authoring through
pinned buildGuest and actual native pointer execution passed separately;
see [say presentation](VISUAL_NOVEL_SAY_PRESENTATION.md).
These are Flutter test-view constraints and native execution, not physical
phones, OS resize/rotation or proof of all UI/device layouts.

## Preserved failures and cause

The earlier b4e Profile run completed three combinations but failed a store
comparison after English phone playback. The diagnostic r5 preserved the
field-level changes: the main auto slot's reveal and stage motion changed
from the initial checkpoint to its pre-title in-memory progress. Locale
replacement rebuilt the autosave listener's empty signature and triggered a
synthetic initial save before the replay. Pause state was preserved; this was
not a replay clock advancing main. Initializing the existing checkpoint from
the replacement snapshot removed that redundant save. See
[locale checkpoint ablation](VISUAL_NOVEL_LOCALE_CHECKPOINT_ABLATION.md).
The old partial screenshots and failure logs remain diagnostic evidence.

The first fixed-candidate Profile run passed all four store comparisons and
captured all twenty images, but its final resume helper still expected Chinese
after selecting English. The final run corrected that expected localized
text and passed the complete route. No store assertion was weakened.

The repository-aware targeted TypeScript check passed using
`.pocket-build/tsconfig-vn-view.json`, which resolves the pinned framework paths.
An earlier standalone configuration without those aliases failed module
resolution; it is not counted as a passed check.

The direct helper regression for explicit paragraphs, blank-line preservation,
Chinese wrapping, and the fallback path passed with pinned Bun 1.4.4:
`packages/pocket_ui/test/wrap_text_lines.test.ts`, 3 tests / 8 assertions.
