# Bounded scene capture for save thumbnails

This document records the first rendering-boundary increment and its isolated acceptance. The subsequent JS capability, app-private persistence and save-screen integration are documented in [real slot thumbnails](VISUAL_NOVEL_SLOT_THUMBNAILS.md); that integration has a separate native acceptance requirement. F06.3 remains incomplete until that requirement passes.

## Retained source and necessary adaptation

The retained parent `../pocketjs_flutter_demo/test/pocket_38_components_screenshot_test.dart` (`_captureScreenPng`, lines 43–60 and its boundary around lines 109–113) uses `RenderRepaintBoundary.toImage`, PNG encoding and a file write. That is a test screenshot of the whole Flutter application. Parent production code outside `pocket_host/` has no scene-export API: `lib/ui/mini_app_host_page.dart` uses boundaries for host UI; `lib/render/pocket_ui_components.dart` uses them for rendering retention. The hardware camera capture path supplies camera pixels, not game pixels.

The SDK must capture the existing rendered PocketView subtree rather than redraw its DrawOps in a new renderer. Canvas partition boundaries and mesh downsampling already in `pocket_view.dart` are internal rendering mechanisms, not a complete game screenshot. The new boundary therefore belongs in the renderer and carries no slot, story, routing, or persistence policy.

## Integration constraints identified at the boundary stage

The existing JS slot manager keeps one opaque record per slot and uses the existing atomic storage batch for move and swap. Preserve that design. Native JSON storage is limited to 65,536 bytes per value and 1,048,576 bytes per app bucket; embedding PNG base64 in each save is not an appropriate general solution.

The remaining integration needs app-private binary image persistence, a negotiated JS capability bound to the correct child guest and generation, and a real dynamic image presentation route. The current `_loadImage` only reads packaged assets or `rootBundle`; a file URI is not supported by that loader. The pinned engine already exposes `uploadImgEntry` and `freeTexture`, so investigate reusing that resource ownership before introducing another image cache or loader. This is a candidate route, not an implemented thumbnail path.

External image files and a JSON save commit are not automatically one atomic transaction. Define failure recovery, reference ownership and garbage collection before wiring save/copy/move/swap/delete. Avoid a second Dart slot state machine or a separate mutable thumbnail catalog.

The current Lantern V4 codec already preserves unknown top-level fields during encode/decode (`sdk/packages/pocket_vn/src/save-codec.ts`), locale rebasing (`localization.ts`) and story revision migration (`save-revision.ts`). A future typed image reference on the encoded record can therefore travel through raw slot operations. This does not by itself implement reference validation or file lifetime management. The read-only boundary audit is retained at `.pocket-build/save-thumbnail-20261108/boundary-audit.md`.

## Implemented boundary

`PocketView(enableSceneCapture: true)` enables one subtree `RepaintBoundary`. The option is fixed for the mounted view; changing it requires a remount so capturing never inserts a wrapper around an active IME or guest subtree. With the default `false`, that additional boundary does not exist.

`PocketViewController.captureScene(maxWidth:, maxHeight:, maxPixels:)` waits for the composed Flutter frame and returns PNG bytes and actual dimensions. It caps each side at 4,096 pixels and total output at 1,048,576 pixels, also bounding rounded allocation dimensions. It does not upscale beyond the view's device pixel ratio. Calls are single-flight. Loading, disabled and detached views return no capture; the controller's existing generation rejects stale results after reload/detach. The temporary `ui.Image` is disposed in `finally`; returned bytes reuse the independently owned PNG `ByteData` without an additional byte copy.

This captures the view's own subtree, including any enabled debug FPS or native IME overlay. Consumers should disable diagnostic overlays when requesting a player thumbnail. Visible initialized video textures, authorized platform textures and host application surfaces are rejected with `UnsupportedError`, since a partial or platform-dependent external texture snapshot would not prove the game image was captured completely. No support is claimed for these contents.

## Acceptance

The isolated boundary acceptance below did not modify ordinary Demo resources or user saves. Live2D clarity remains deferred at the user's request.

The real pinned `buildGuest` fixture executes QJBC through `FfiPocketRuntime` inside PocketView. A Flutter pointer tap changes its panel from red to green. The capture test checks both PNG pixels, exact 80×64 dimensions, transparent uncovered pixels and absence of the surrounding host color. Root also inspected the two saved PNGs. This is real bytecode and the real Flutter rendering/capture path in a widget test; it is not physical device, process-restart, save-slot or performance evidence.

Input/IME, scene invalidation, pointer wake and viewport regressions passed 42 tests across four files. Final test commands, source hashes, generated fixture assets and before/after PNGs are retained under `.pocket-build/save-thumbnail-20261108/`. Initial compile failures are retained separately; they are not passing evidence.

Capture boundary tests passed 3/3, including single-flight rejection, rounded output bounds, invalid hard limits, default-disabled boundary absence, retained child identity, in-flight detach and unsupported host content. Together with the native test and regressions, this increment has 46 passing tests and no skipped native test in the opted-in run. These ablations establish tree/lifetime behavior; they do not establish a measured FPS or memory improvement.

Final `pocket_view.dart` SHA-256: `0a39a86c850aff2102c00800c3c6c3b66ee5eb79fd76319476eeaa4c0695b56e`. Fresh fixture QJBC: `14a6ee0a2c11c9618391555f6698e68ae134180c8b04ba8edf948d5cfef8d6ce`; PAK: `46f243ca609b20ca1e70e1b2ad1f33a0d33749fd336918cdd1db8aba48a92419`. The final source/artifact hash manifest covers the actual FFI library too. Logs: `native-final.log`, `unit-attempt3.log`, `regression.log`; result JSON records commands, source hashes and exit codes.

The fixture source is retained under `packages/pocket_flutter/test/fixtures/scene_capture/`; its generator is `scripts/tests/build_scene_capture_fixture.ts`. From the repository root, using the current pinned tool package:

```sh
POCKET_TOOLS_PACKAGE="$PWD/sdk/.pocket-build/retina-native-tools-20261108" \
  sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  sdk/scripts/tests/build_scene_capture_fixture.ts \
  --out-dir sdk/.pocket-build/save-thumbnail-20261108/final-fixture
```

Then from `sdk/packages/pocket_flutter`, with Flutter 3.47.9 and the matching native library:

```sh
POCKET_VIEW_CAPTURE_FIXTURE_DIR=../../.pocket-build/save-thumbnail-20261108/final-fixture \
POCKET_NATIVE_LIBRARY=../../native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib \
  flutter test --no-pub test/pocket_view_capture_native_test.dart
flutter test --no-pub test/pocket_view_capture_test.dart \
  test/pocket_view_input_test.dart test/pocket_view_invalidation_test.dart \
  test/pocket_view_pointer_wake_test.dart test/pocket_view_viewport_test.dart
```

Without fixture/native environment variables the native test reports a skip reason and skips; such a run is not native acceptance. Generated bytecode, caches and screenshots are evidence, not source.
