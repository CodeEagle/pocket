# Visual novel skin frame

The skin frame stores one registered image and its source-pixel dimensions in the optional `skin.frame` asset metadata. A single uniform source inset describes the corners and edges. `NovelSkinFrame` receives that metadata plus its target local-pixel width, height and border width; it uses the same target dimensions for the existing `Image` node and PMS1 vertices. The destination border is clamped to half the smaller target dimension, while UV coordinates retain the declared source inset.

The Lantern runtime texture is `demo/js/apps/lantern/art/ui/harbor-frame.png`, baked from the retained 1254 × 1254 master to 512 × 512 RGBA by the existing `scripts/prepare_textures.ts` pipeline. Its runtime metadata therefore uses `width: 512`, `height: 512`, `inset: 122` (approximately the master inset of 300 scaled to the baked size), rather than master-source dimensions.

## Source-first boundary

The retained parent was inspected with `pocket_host/` excluded. The only Dart image-widget use found in its renderer is `lib/render/pocket_ui_components.dart`'s camera photo preview (`Image.file`, `BoxFit.cover`). `mini_apps/pocketjs_uikit.js` declares an `Image` tag, but the retained parent has no shared game-frame skin or 9-slice/image-button renderer to migrate. This implementation therefore reuses the SDK's existing decoded image node and retained PMS1 mesh path: `packages/pocket_vn/src/mesh-view.tsx` owns the one `Image` node, and `packages/pocket_vn/src/mesh.ts` encodes its mesh. It adds only the 9-slice source-to-target grid that the parent does not supply.

The SDK native painter currently renders ordinary `PocketImageOp` values with `drawImageRect`; changing that renderer alone would not be a reusable implementation because no 9-slice metadata is present in its image operation, and it would diverge across targets. The skin uses the already-supported PMS1 image mesh instead, so no native ABI, decoder/cache, per-frame state, or second layout/render loop is introduced. `hitPass: 1` leaves the actual parent Focus/Input control as the sole interaction target.

The retained parent's `lib/render/pocket_ui_components.dart` keyboard component
(the `TextField` near line 3584) supplies the real system IME but always paints a
Material fill and outline. The migrated `@pocket/ui` `InputField` already owns
the editing-session/revision protocol and native text overlay; duplicating it
for the game would add a second IME state machine. The necessary adaptation
accepts the explicit color `transparent` in that same appearance contract.
The JS shell emits zero-alpha fill/outline, and the Flutter editor parses the
same value while keeping its existing controller, composing region, clipping,
and text metrics. A transparent focus outline uses the text color for the caret
so editing remains visible. The game's image frame supplies the decoration;
no opaque color match is used to cover the artwork.

## Validation boundary

`packages/pocket_vn/test/skin.test.ts` checks strict metadata shape, source UV inset preservation, narrow-target border clamping, and the encoded 16-vertex/54-index mesh header. `scripts/tests/skin_guest.test.ts` compiles the real helper through pinned `buildGuest` and exercises the native probe: the parent Focusable receives taps through the image layer, and all 18 emitted texture triangles reference the same registered image key. Asset path resolution remains the asset registry's responsibility. The component is static; it recomputes geometry only when frame or target props change.

The transparent native editor adaptation passed all 17 existing Flutter input
widget cases (`/tmp/pocket-image-skin-transparent-input-widget.log`) and Flutter
analysis. The extended IME case changes an already-open Chinese/emoji session
to transparent fill and three transparent outlines, verifies the same controller
and composing region, and verifies that the caret still uses a visible text
color. The independent `flutter_widgets.test.ts` pinned-build/IME script also
passed its assertions; its stale clock mock was updated with the existing
`virtualNow` export. These boundary checks do not replace the complete game's
image and input acceptance.

## `NovelView` surface coverage

The optional `NovelAssets.skin.frame` record supplies the single shared frame
to `Action`, `CompactAction`, volume controls, text-sound control, header and
toolbar targets, slot confirmation and ID entry, and the title/menu/settings,
dialogue, choice, input, ending, gallery, log and notice surfaces. Each target
passes an explicit local-pixel width and height to `NovelSkinFrame`; no native
layout measurement is added. Skin meshes are inserted behind the existing
Focusable parent, with `hitPass: 1`, so pointer ownership remains with the same
JS control. The input field preserves `InputField` and Flutter IME ownership;
the outer frame and the inset editing field share the registered image skin.

The property is optional for source compatibility. An older consumer without
`skin.frame` still gets working controls and IME, but no skin image and no
CSS-painted card or button fallback. It must register image metadata to request
the image-chrome appearance. Lantern's nested `skin.frame.image` points at the
same asset registry tree consumed by build guest, so it enters the ordinary app
PAK with no separate texture loader or copy step.

The integrated image skin was rebuilt and accepted as described below. The
viewport-only screenshots taken before skin integration remain layout evidence
only.

## Editor authoring

The retained parent has no VN skin authoring form. A source search excluding
`pocket_host/` found only the generic `Image` tag in
`mini_apps/pocketjs_uikit.js`; the old renderer's image use is a camera photo
preview, not a reusable game-frame registry or editor. The current Editor had
background, character, CG, audio, video and model sections but no way to edit
the already-supported optional `novel.assets.json` `skin.frame`. This is the
new authoring gap; the adaptation keeps the skin in that single registry and
does not add an app-level fallback or a separate style document/state.

The Editor skin group now adds/removes the optional frame and edits its image
path, runtime source-pixel width/height and uniform inset. For projects without
`skin`, merely opening the panel leaves the legacy document unchanged and shows
that the game must register a real image to use a skin; it does not substitute
an App component default. The image preview uses the existing `/novel/resource`
handler and `registeredImage`/`assetFileProblem` path boundary, with one
`kind=skin` query for the in-progress frame image. A button reads the browser's
actual decoded image dimensions into the fields, avoiding accidental use of
the 1254px Lantern master instead of its 512px runtime bake. Save uses the
existing `isNovelAssetSkin` validator; the Editor does not implement a second
skin validator. Undo/redo, save/reopen, and removal use the existing
`assets` history scope and `novel.assets.json` save route.

`editor/test/novel_skin_editor_browser.test.ts` exercises the real Chromium
form against the 512 × 512 runtime frame. It checks missing-image preview
feedback, reads the actual pixel dimensions, rejects fractional fields and an
inset equal to half the shorter side, confirms rejection leaves the legacy
file untouched, and then exercises undo/redo, save/reopen and removal. Its
app imports the saved `skin.frame` into the existing `NovelSkinFrame`; pinned
`buildGuest` emits QJBC and the same registry image appears in the PAK as
`ui:img.art/ui/harbor-frame.png`. `scripts/tests/skin_guest.test.ts` separately
checks native 9-slice geometry and hit-pass behavior using the shared renderer.

The targeted Editor regression was run with the pinned Bun 1.4.4 binary:

```sh
cd sdk
./.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --max-concurrency=1 editor/test/novel_skin_editor_browser.test.ts editor/test/novel_service.test.ts editor/test/novel_history_persistence_browser.test.ts
```

It passed 4 tests across 3 files (29 assertions). The browser test compiled
166,144 bytes of QJBC and found the saved image resource in its 15-entry PAK.

## Integrated image acceptance, 2026-11-07

Actual macOS whole-subtree captures exposed a pinned-compiler constraint that
the geometry and pointer tests alone did not catch: dynamically concatenating
the `relative` class with the control's class prevented its layout rules from
being registered, leaving text at the top-left of image frames. Controls now
retain static class literals, and the skin uses one static absolute class with
explicit numeric insets. The unsupported `flex-none` utility was replaced with
the pinned renderer's existing `shrink-0`. The added class concatenation and
unused skin class prop were removed rather than introducing another wrapper.
The real compiled skin helper regression checks its image bounds as well as
its 18 texture triangles and parent hit-pass behavior.

The corrected macOS image capture was visually inspected at wide, short and
narrow sizes. Its wide capture is retained at
`sdk/.pocket-build/novel-skin-acceptance/wide.png`; this run used the corrected
view source before the final full-coordinate framework package. It verifies
the image grain, frame corners, centered button text and paragraph layout,
not the final bytecode identity.

The final toolchain is generated by `scripts/package_toolchain.ts` at
`sdk/.pocket-build/fullcoords-native-tools-20261107`; both the guest compiler
and probe come from that package. Final Lantern QJBC SHA-256 is
`ca609bad1a6c1a98a534dfb572a2a725e8ded3b5ec8118ca2c56be7970054a26`,
and its PAK is
`58b404e232d517e2225152da4169211d4adf0bd7cbdc8abb1a27ef1c1e09f6b9`.
The system QJBC is
`9ab6952b2f79700308e00f15de31c3bdb78e999aeed9e0448a7aa9dd14a56813`.

The final native game regression passed 6 cases across 5 files, covering the
story endings, save/load/rollback, input, isolated replay, slot controls and
same-session resizing (`/tmp/pocket-image-skin-final-native-regression.log`).
The final actual iPad Simulator test decoded the registered image and emitted
at least 18 texture triangles while resizing the same child session to
1032×1376, 1032×340 and 390×1376. Menu input and dialogue progression passed
at those sizes (`/tmp/pocket-image-skin-final-large-ipad-safe.log`). This is
Flutter constraint resizing within the simulator window, not OS rotation or
physical-device acceptance. See `VISUAL_NOVEL_RESPONSIVE.md` for the geometry
and full-coordinate input boundaries.

The final game's native IME route passed independently on macOS, Android
(`emulator-5554`) and iOS (the same iPad Simulator), asserting transparent fill,
all three transparent outlines,
and a visible caret before exercising validation, cancel, save/load and
rollback. Logs: `/tmp/pocket-image-skin-final-input-macos.log`,
`/tmp/pocket-image-skin-final-input-android.log`, and
`/tmp/pocket-image-skin-final-input-ipad.log` (1 passing case on each platform).
The final Android image-skinned slot manager also passed real OS-file
copy/move/swap/delete and quick-load after fresh-host creation; its driver
waits for the observed enabled paint rather than treating a storage commit as
UI readiness. See `VISUAL_NOVEL_SLOTS.md` for the artifact and evidence boundary.
Final Flutter analysis of the three updated game integration files passed
without issues (`/tmp/pocket-image-skin-final-integration-analyze.log`).

The original artwork, exact generation prompt, master/runtime hashes and bake
command are retained in
`demo/js/apps/lantern/art/ui/PROVENANCE.md`. One 9-sliced image supplies the
decoration; text remains separately editable and localizable. No App button
or card appearance is used as a visual fallback.

## GPT Image refinement, 2026-11-07

The user requested a generated effect mockup as the implementation target.
`demo/js/apps/lantern/art/reference/ui-refinement.png` shows gameplay, title,
and journal layouts. It is a design reference, not a screenshot of the engine.
The retained parent outside `pocket_host/` has no VN skin/editor screen; the
current reusable PMS1 image mesh and focus/input implementation are retained.

The shared `NovelAssetSkin` keeps the original required `frame` and adds two
optional image roles: `accentFrame` has the same nine-slice metadata for a
primary action; `icons` contains `image`, actual source `width`/`height`,
`columns`, `rows` and unique semantic `names` in row-major order. Grids are
bounded to 16×16 cells. The renderer uses one quad per named atlas cell through
the existing image/PMS1 pipeline. Missing optional names render nothing;
legacy frame-only registries remain valid. Text is separate from all textures.

The project uses a quiet ink-teal frame, a warm brass primary frame and one
4×4 image icon atlas. This replaces repeatedly stretching the same ornate
frame across every control. The obsolete frame is retained as source art but
removed from runtime texture admission. `skin.test.ts` has 4 passing cases /
39 assertions, including old registry compatibility, atlas shape bounds,
duplicate names, precise cell UVs and actual PMS1 encoding.

Image masters, runtime hashes, exact GPT Image prompts and bake commands are
recorded in `demo/js/apps/lantern/art/ui/REFINEMENT.md`. The game font source
and fixed subset recipe are recorded in `demo/js/apps/lantern/ASSETS.md`.
The expanded Editor form reuses the same validator and assets history for
both frames and the atlas. It previews each actual PNG, reads source sizes,
edits unique icon names, and checks all three image paths at the existing
project boundary. The targeted route and Chromium regressions passed 14/14
(`editor/test/novel.test.ts` and `novel_skin_editor_browser.test.ts`), including
undo/redo, save/reload, metadata removal/restoration, atomic invalid-path
rejection, and pinned `buildGuest` QJBC/PAK registration. No second schema or
theme state was added. Runtime screenshot comparison and cross-platform
checks for this refinement are pending; the preceding acceptance section
describes the earlier skin build.
