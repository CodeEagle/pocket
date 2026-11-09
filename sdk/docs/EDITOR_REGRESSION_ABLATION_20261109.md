# Editor regression configuration ablation, 2026-11-09

The earlier full Editor run had 214 passing and 12 failing top-level tests,
with sources changing during the run. It is retained as a failing mixed-source
baseline, not a frozen final acceptance.

The retained current SDK already owns canonical System discovery in
`editor/preview.ts::compositorSurfacesFromProject`. Five browser tests had copied
a Profile/Lobby-only surface registry. The actual System now also installs
Lantern, and the upstream runtime rejects incomplete registries. Removing those
overrides lets the same production discovery populate every installed child.
No production catalog or runtime invariant was relaxed.

The five-test rerun passes density seams, input/IME and mini-app browser launch.
Two tests initially proceeded beyond Guest boot but failed later: rounded Profile
button geometry sampling, and Video Lab navigation. Follow-up results appear
below; catalog ablation alone does not establish complete acceptance.
Log: `.pocket-build/rich-text-20261109/editor-catalog-ablation.log`.

`preview_idle_mini_app.test.ts` now honors `POCKET_NATIVE_PROBE`, retaining its
old debug-path fallback. Its original full-run failure used the old hardcoded
debug Probe despite the explicit final Probe environment. With the final pinned
Probe it passes unchanged launch/clock assertions (1 test).

`resources_system.test.ts` compares exact inventory IDs with the authored System
catalog, replacing the obsolete count of three. After the strict shared-font
schema adaptation, the full actual build/resource/pointer test passes: root,
Lantern, Profile and Lobby inventories all contain resources, and a native
pointer opens Profile. The authored System remains the single source of truth.
Log: `.pocket-build/rich-text-20261109/editor-resources-regions-adapted.log`.

`preview_regions.test.ts` captured all POST /input packets starting at page
load. The extra packet was recorded and identified as the browser's startup
`accessibility` preference fact. The test now waits for that fact and snapshots
the settled packet baseline before toggling overlays. It still asserts unchanged
Guest ops/frame number, no added overlay packets, changed capture pixels, and
exact subsequent pointer down/up with actual counter increment. It passes (1
test), without suppressing accessibility transport or dropping input assertions.
Log: `.pocket-build/rich-text-20261109/editor-regions-final.log`.

The source-provenance follow-up removed an unnecessary
`invalidateStageSourceFacts()` when selecting only a future preview root. The
still-visible committed stage retains its exact old source facts. Cancelling
the old choice/input continuation remains separate: it stays paused/disabled
and cannot auto-select. Source navigation only selects and scrolls the authored
instruction; it does not execute an engine instruction. Scene-object, root-entry
and adjacent contextual preview/bounds runs pass 5 tests, including real Guest
compile/replay. Logs are in `.pocket-build/scene-objects-20261109/` with suffixes
`scene-object-source-regression-final`, `context-entry-source-retained-final`,
and `context-preview-source-regression-explicit`. An initial combined-run
page-navigation timeout is retained; isolated final runs pass.

A further isolated rerun passes `preview_mini_app.test.ts`.

`preview_page.test.ts` waited for the obsolete English `Ready` string after the
page had been localized. It now waits for the semantic ready class and still
requires an actual runtime frame, visible iframe, resizing, captures, regions,
clipboard and no Codex traffic. The title must exactly match project config.
The isolated complete flow passes (1 test).
Log: `.pocket-build/rich-text-20261109/editor-page-semantic-ready.log`.

`preview_rounded_seam.test.ts` filtered for corner masks sized 10–16 px, excluding
the current public MobileButton's correct 8 px masks. The matcher now derives
four corner positions from the actual three blue fill rectangles and their
outer bounds. All pixel alpha, AA, interior seam and clip-leak assertions remain.
Rounded and density seam tests both pass (2 tests); no renderer was changed.

`preview_video_browser.test.ts` also passes (1 test). Back is an icon-only
chevron, and Home's actual title is `POCKET SHOWCASE`; both old text predicates
were stale. The test derives the click target from actual chevron DrawOps and
asserts route pop, `video.state=disposed`, and detached HTML media. It waits for a
bounded settled playing window before measuring, with real playback progression
required: time advanced 0.8126→1.5215 during the 700 ms measurement, with zero
extra FrameResults, stream/snapshot requests, or other input posts. Legitimate
video-state facts remain observable. No video production code changed.
Log: `.pocket-build/video-back-20261109/video-back-final.log`.

The earlier timing threshold miss remains open. There is no frozen final full
Editor pass.
