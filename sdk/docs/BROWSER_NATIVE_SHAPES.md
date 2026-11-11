# Studio browser projection of native shapes

## Sources and retained behavior

Inspected the retained parent at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`,
excluding `pocket_host/`. Its rounded fills, borders and gradients are behavior to
preserve; its Flutter widget composition is not copied into the JS-owned Showcase.
Canonical thin-host geometry comes from
`packages/pocket_flutter/lib/src/pocket_view_painter.dart`: rounded rings, signed
arcs and `_gradientAlignment`. The pinned Core contracts remain in
`native/patches/native-rounded-rects.patch`, `native-arcs.patch` and
`native-rounded-gradients.patch`.

Commit `6035de9a5b78a25dbff5437a631fcbbf84a17407` enabled native shape emission.
Studio's Canvas2D projection still understood only the older rectangle/image
composition and silently skipped `rounded`, `arc` and `roundedGradient`. This
removed Showcase backgrounds and made white labels disappear against the page.

## Necessary adaptation and ablation

`editor/client/preview.js` projects these operations directly. Rounded rings use
an even-odd inner hole and collapse to a fill when the hole has no area. Arcs use
top-origin degrees, signed sweeps, round caps and closed full circles. Native JSON
carries arc stroke width as `borderWidth`. Existing clipping remains active, and
arc stroke state is saved/restored locally.

A shared rounded path also serves glass clipping, using `arcTo` when `roundRect`
is unavailable. A shared linear-gradient constructor replaces the duplicate
gradient branch and follows Flutter's direction ordinals: 0 bottom-to-top,
1 top-to-bottom, 2 right-to-left, 3 left-to-right. Rounded gradients retain their
shader coordinates under clipping and support a middle stop. No additional
runtime, layout engine, UI state or Flutter policy is introduced.

`editor/preview.ts` includes border width, arc geometry and gradient stops in the
recording frame summary, using canonical Dart field names.

## Validation

- `bun test editor/test/preview_rounded_ops_browser.test.ts`: two passing browser
  regressions cover rounded corners, hollow rings, clipping, gradient stops and
  direction, signed arcs and hollow full circles. The second test executes real
  JS in the native probe, sends pointer events and projects the resulting frames
  through the actual preview client. Removing just the three new shape kinds
  makes their pixels white again, providing a negative control.
- `bun test editor/test/preview_mesh_effect.test.ts`: existing mesh/mask test passes.
- `bun test editor/test/preview_liquid_glass.test.ts`: all four tests pass as a
  separate file. A combined mesh/glass invocation timed out; both files pass
  independently, so independent runs are the reported acceptance checks.
- Real Showcase assets were loaded in Playwright Chromium at 375 x 812 using
  the existing arm64 release probe. The dark hero sampled `[250,250,250,255]`
  before the fix and `[24,24,27,255]` after. Its title, cards, input border and
  `+1` button are visible. A real canvas click changes `00` to `01`.
- The installed prebuilt tools package has a version mismatch in this checkout.
  Source-based builds use the pinned cache through `POCKET_SOURCE_BUILD=1`,
  `POCKET_COMPILER_PATH=$PWD/.cache/pocketjs/tools/build.ts` and
  `POCKET_BYTECODE_BIN=$PWD/native/target/release/pocketjs_bytecode`.

Scope is Studio's Canvas2D preview. The separate Web SDK raster backend is outside
this change.
