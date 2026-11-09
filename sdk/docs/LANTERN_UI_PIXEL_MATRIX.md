# Lantern eight-screen UI pixel matrix

Status: both integration cases passed in a macOS Profile run on 2026-11-08.
This records real Guest rendering and input in a constrained Flutter test view;
it is not a physical phone or operating-system resize result. The screenshots
were visually reviewed and exposed two English layout defects listed below.

## Coverage

`demo/integration_test/novel_ui_visual_test.dart` keeps its existing live
viewport test and adds one focused run at 390×844 logical pixels and DPR 2
(780×1688 output PNGs). The matrix captures eight real Guest screens in Chinese
and English, for 16 `RenderRepaintBoundary` images:

| Screen class | Chinese capture | English capture | Real route |
| --- | --- | --- | --- |
| Title | `zh-title` | `en-title` | Lantern launcher to title; English title after returning from the story |
| Dialogue | `zh-dialogue` | `en-dialogue` | Start story; English capture follows loading the saved opening line |
| Choice | `zh-choice` | `en-choice` | Advance the same main story to its first real player choice |
| Journal / menu | `zh-menu` | `en-menu` | Open the in-game `手札` / `Journal` panel |
| Settings | `zh-settings` | `en-settings` | Open the settings panel and change locale through its real control |
| Save / load | `zh-save-load` | `en-save-load` | Save slot 1 in Chinese; read and load `Letter 1` in English |
| Reading log | `zh-log` | `en-log` | Open `沿途回声` / `Reading log` with actual story backlog |
| Gallery | `zh-gallery` | `en-gallery` | Open the real `雾港纪念` / `Memories` panel without fabricating an ending unlock |

“Journal / menu” is the in-game handout panel, not a second host navigation
screen. Its real actions lead to save/load, log, settings, gallery, and title.
The save/load screen is captured after a real write and before a real load; the
test checks the slot in isolated on-disk app storage and then loads it through
the English UI.

## What the run records

The test reuses `guest_interaction_test.dart`'s actual pointer and
clipping-aware reveal helpers and the existing `pocketHostApp` flow. It waits
for repeated stable Guest text and image-skin geometry samples before capture.
The viewport case uses explicit down/move/up Guest pointer events for scrolls;
the earlier `tester.dragFrom` form generated no Guest scroll offset and was
replaced after its trace showed unchanged title row positions. Both tests use
isolated app-support storage and verify the ordinary platform store is
byte-identical after the run.

Each capture emits `LANTERN_UI_PIXEL_SCREEN` JSON with the screen and locale,
text draw-op bounds plus their global painted rects, decoded `art/ui/` texture paths and
dimensions, the screenshot path/dimensions/SHA-256, and the bundled Lantern
QJBC/PAK and bytecode metadata/source/payload hashes. `PocketTextureTriangleOp`
and the matching decoded `PocketCanvasPainter.images` entry establish which
skin image was actually decoded and painted.

The text list filters each `PocketTextOp` against its draw clip and the painter
canvas, but it does not model occlusion between stacked app-shell and game
surfaces. Some launcher text remains in the draw-op list while the game covers
it, so the list is geometry evidence and not proof that every listed label is
visible in the PNG. The actual PNG is the visual source of truth.

The integration run isolates the app-support path, verifies that slot 1 was
written there, and compares the normal app-support data file byte-for-byte
before and after. It leaves the 16 PNGs in a temporary output directory and
prints that directory for review. This uses 390×844 Flutter constraints inside
the macOS test view; it is not a physical phone, operating-system resize, or
rotation result.

## Recorded run

Command (run from `demo/`):

```sh
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive --profile --driver=test_driver/integration_test.dart --target=integration_test/novel_ui_visual_test.dart -d macos --no-pub
```

The full file passed 3/3 tests in 02:14, including its desktop/phone-like/short
viewport case and all 16 matrix captures. Each matrix PNG is 780×1688. The
actual images and full log are retained under
`sdk/.pocket-build/lantern-ui-pixel-matrix-20261108/`.

| Artifact | Fingerprint |
| --- | --- |
| Lantern QJBC | 1,073,374 bytes, SHA-256 `8defe742d93c066cabbaf7e2c8f665f854c05c8ee03c40e706f1578cae9cb962` |
| Lantern PAK | 69,193,344 bytes, SHA-256 `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` |
| Bytecode metadata | SHA-256 `336d26be321196f53a8dbfa7a15ae7dffe199b263eb455b066ec5acfffc2f93f` |
| Guest source | SHA-256 `54ad660d9eab2aff0b655e0c6533d92eadace00083aa863bd928dd9a45469dfa` |
| Guest payload | SHA-256 `93eb6a83b31dd5b3afd3f917394991ebed41961f97f521d353d1ba79efabfcdd` |
| Flutter runtime source | `pocket_runtime.dart` SHA-256 `af67e338e533f0ade60579ba9a926a7d9f97ce4b22dfc978c36a7667d9a9b82b` |

The Profile dependency cache at `.dart_tool/flutter_build/0080340915317ff4a9d8181c97b3c141/.filecache` recorded the runtime file's matching MD5 `d76700b331720382e0dd3478e0dc7227`; the resulting AOT `App` binary contains `_borrowedIngress`, `_borrowedEgress`, and `_parseBorrowedBinaryFrame`. This confirms the runtime parser change was compiled into this Flutter build.

Visual review found two English layout defects in this build: the `Echoes
along the way` heading crowds the `Back` action at the right edge in `en-log`,
and long replay labels are cut off at the right edge of their cards in
`en-gallery`. The text draw-op list does not detect occlusion, and the PNGs do
not prove every long label is readable. These captures are evidence for those
issues, not a blanket visual acceptance of the current UI.

## Source-first reuse

The retained parent was checked without entering its `pocket_host/` directory.
Its `test/pocket_38_components_screenshot_test.dart` demonstrates a generic
`RepaintBoundary.toImage` screenshot path, but is tied to an older FFI app,
fixed host paths and fonts, and does not drive Lantern VN screens. The parent
`lib/render/pocket_ui_components.dart` contains generic Gallery rendering, not
the current Lantern story or its settings/save/log/gallery routes. The existing
Pocket VN integration harness already owns the needed `pocketHostApp`, live
Guest painters and actual clipped pointer interactions, so this acceptance
extends it instead of adding another renderer or navigation driver.

## Long English labels: follow-up fix pending Guest capture

The first matrix exposed two concrete defects in the captured 390×844 screen:
the `Echoes along the way` panel heading crowded its `Back` button, and long
replay labels ran past the right edge of their cards. The JS `Action` now uses
the existing `@pocket/ui` `wrapTextLines` measurement for label and detail
text, gives each text node its available width, and sizes the existing skin
frame from the resulting line count. The panel heading now reserves the
existing 88px Back control before wrapping. This changes only the existing
`Action`/header composition; it adds no state, renderer, or duplicate layout
system.

The retained parent `lib/render/pocket_ui_components.dart` uses bounded text
and ellipsis for generic components; this adaptation keeps full VN labels and
uses the existing pinned PocketJS wrapping helper so the visible label remains
readable. `novel_ui_visual_test.dart` now asserts that the English log heading
wraps before Back and that the long English replay action wraps inside the game
canvas. These assertions are ready for the next isolated Guest build and pixel
capture. They are not evidence that the follow-up source has passed a rebuilt
Guest; the earlier QJBC/PAK fingerprints above describe the pre-fix capture.
