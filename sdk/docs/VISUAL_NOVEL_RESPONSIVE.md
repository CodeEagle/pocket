# Visual novel responsive layout

## Source-first findings

The retained parent demo has no visual-novel layout that can be migrated. Its Flutter renderer already reads `MediaQuery` width for route transitions in `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`, and its bottom navigation spans the viewport while consuming the bottom safe inset. `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart` similarly reads the top safe inset for the host status HUD. Those behaviors establish that usable width and edge insets are viewport facts; the migrated VN keeps their interpretation in the existing JS `display.viewport` lane.

The VN also reuses Pocket UI's existing `createDisplayGeometry()` and `pageInsets()` helpers. The old native QJBC baseline kept a 360×640 centered portrait stage at 1280×720: the station image was painted at x=460, y=40, w=360, h=640, and the dialogue at x=490, y=484, w=300, h=60. That is the evidenced gap addressed here.

## Layout behavior

`createNovelViewportLayout()` derives a safe content rectangle from the live display width, height, safe insets, and keyboard inset. It fills that rectangle, scales authored scene coordinates from the original 360×640 design while keeping touch controls and type natural-sized, and centers readable UI within caps (dialogue 960 px, paragraph 720 px, panel 860 px). At short heights, dialogue, choice, title/menu, log, settings, gallery, and ending content use `ScrollablePage` with a bounded viewport so their controls remain available.

When an asset consumer supplies its actual intrinsic dimensions, backgrounds and CG thumbnails use proportional cover bounds and character art uses contain bounds. No framework `Image.fit` API is available in this pinned renderer. String-only legacy assets keep their former box bounds. Lantern supplies a map for its runtime PNG paths; each packaged `art/*.png` was checked with `file` and is 512×512. Its higher-resolution `art/masters/*.png` are authoring sources and are not the files referenced by the runtime registry.

## Validation

- `sdk/packages/pocket_vn/test/viewport.test.ts` checks 360×640, safe-area/keyboard geometry, 1280×720 panel bounds, low-height control reservations, character spread, and image cover/contain behavior.
- `demo/js/tests/novel_viewport_native.test.ts` boots the compiled Lantern QJBC and uses the real `pocket_probe` `op:resize` to resize the same native session. It starts through the painted title button, opens and closes the player menu at phone/tablet/desktop/short-height sizes, then advances through painted dialogue and selects the first visible choice.
- The NativeSession helper asserts the returned frame width and height after native resize; it does not synthesize a `display.viewport` event in place of resizing.
- Final native-QJBC and Flutter integration evidence is recorded below; geometry unit tests alone are not treated as platform acceptance.

### macOS live-constraint baseline, 2026-11-07

`demo/integration_test/novel_large_screen_test.dart` passed on the actual macOS
Flutter renderer with Lantern QJBC
`cacde1f90d937d953dcea4d076c29290628d6c2c867f499c3944795a7e9ca601`.
The same child controller remained mounted while its available Flutter layout
constraints changed from 390×600 to 800×600, 800×340, and back to 390×600.
The real decoded station image covered the canvas; paragraph widths were 720,
720, and 334 pixels respectively. At every size, native pointer input opened
and closed the menu, and the final pointer advanced the dialogue. The test
waits for the actual child frame dimensions after both compositor and child
post-layout resize commits; retained text alone is not a resize barrier.

Whole-subtree `RepaintBoundary` PNG captures were inspected under the macOS
app's temporary directory (`pocket-novel-wide.png`, `pocket-novel-short.png`,
`pocket-novel-narrow.png`). They capture the actual composed game rather than
repainting one of its individual retained layers. This run precedes the new
image skin. It changes real Flutter constraints within the existing OS window;
it does not claim an OS-window drag, a 1920-pixel pointer result, or mobile-device
validation. Log: `/tmp/pocket-large-screen-whole-capture-macos.log`.

### Final image-skin and large-screen acceptance, 2026-11-07

The final native regression log `/tmp/pocket-image-skin-final-native-regression.log`
reports 6 passing tests across 5 files (91 assertions) against compiled QJBC
and the real native probe. At 1920×1080, the painted `手札` button was at
`x=1360`, width 24, and was pressed at `x=1372`; the menu opened and its
`继续阅读` action returned to the story. The viewport test also exercised
phone, tablet, desktop and short-height sizes. Full-coordinate gesture delivery
above 1023 is separately covered by the pinned-QJBC test in
[INPUT_COORDINATE_SIDECAR.md](INPUT_COORDINATE_SIDECAR.md); this report does not
claim Windows, physical-device, gamepad or accessibility coverage.

The final Flutter integration run in
`/tmp/pocket-image-skin-final-large-ipad-safe.log` used the same running game
and retained child controller while the iPad simulator's Flutter constraints
changed to 1032×1376, 1032×340 and 390×1376. The corresponding dialogue widths
were 720, 720 and 334 logical pixels. The test verified the decoded station
image, decoded registered frame-skin texture triangles, and used pointer taps
to open the menu, continue reading, and advance the dialogue. These were
in-app layout constraints, not OS rotation/window resizing or a physical iPad
run. The test source is
[`novel_large_screen_test.dart`](../../demo/integration_test/novel_large_screen_test.dart).
Its original desktop-only assertion expected the background to fill the
complete frame. On iPad, the intended stage excludes the 32/20-pixel safe
edges. The assertion now checks the actual safe content rectangle; this
correction changed the test only, not the production layout.

The final build identities are Lantern QJBC
`ca609bad1a6c1a98a534dfb572a2a725e8ded3b5ec8118ca2c56be7970054a26`, Lantern
PAK `58b404e232d517e2225152da4169211d4adf0bd7cbdc8abb1a27ef1c1e09f6b9`, and
System QJBC `9ab6952b2f79700308e00f15de31c3bdb78e999aeed9e0448a7aa9dd14a56813`.
The earlier macOS Flutter constraint run above used its separately recorded,
pre-skin QJBC and remains historical evidence; it does not identify the final
skin build.


### Actual macOS window sizing, 2026-11-08

The [native window acceptance](VISUAL_NOVEL_NATIVE_DENSITY.md) now covers
`NSWindow.setContentSize` through 1280×720, 800×340 and restored 800×600,
with real Flutter/Guest dimension barriers, retained controller and pointer
journal/resume/advance. Profile driver exit0/+2. This is OS window sizing,
not the earlier child-constraint test. Non-key/locked-screen limits and
physical 2x/mobile rotation coverage remain explicit in that report.

Saved-thumbnail width changes were also exercised on the already mounted host
surface on macOS, Android and iOS. They are separate from OS window resizing or
rotation; the exact widths and retained-resource evidence are in
[slot thumbnails](VISUAL_NOVEL_SLOT_THUMBNAILS.md).
