# Live2D model touch interaction

Date: 2026-11-12
Status: Live2D controller, Story model-view gestures, and StageCharacter input mapping implemented; the real macOS Guest/Core touch fixture passes.

## Retained source review

The retained parent project `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, was checked before implementation. Its [`lib/render/pocket_ui_components.dart`](../../../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart) contains `_MobileTouchTrackpadSurface` (around lines 705–795): generic Flutter touch down/pan actions are reported to the legacy host with a node ID and normalized coordinates. This is a UI trackpad control, not a Cubism model hit test. The parent runner at [`lib/core/pocketjs_bundle_runner.dart`](../../../pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart) and the retained `lib/`, `test/`, and `docs/` sources contain no Live2D/Cubism model interaction implementation to port.

The current Pocket host already delivers `input.pointer` into the Guest. The retained framework recognizer contract in `@pocketjs/framework/gesture` is used by current Pocket UI components: a gesture can be scoped to a rendered node subtree, gets Guest logical-pixel contacts and pan callbacks, and is disposed with its Solid owner. Its bounds hit fact lets a dialogue or button painted over a model keep input priority.

## Adaptation

The missing behavior was in the reusable JS Live2D/VN path: `NovelModelView` advanced the model but did not register a gesture; `NovelModelInstance` had no interaction entrypoints; the model3 parser discarded `HitAreas`. Hiyori declares the `HitArea` drawable as `Body`, and the bundled source contains the `TapBody` motion group. The old `TapBody` story route only played that motion as an authored scene action.

The SDK now:

- Parses `model3.HitAreas` and exposes a stateless `createCubismInteractionController` from `@pocket/live2d`.
- Uses the current Core drawable PMS1 geometry and model3 drawable ID for triangle hit testing. A declared hit-area helper is tested from its geometry even if its render visibility/opacity is zero; it is a hit-test shape and is not painted by the renderer.
- Maps model-local drag coordinates through the same canvas placement used for PMS1, then writes only recognized `ParamAngleX/Y/Z`, `ParamBodyAngleX/Y/Z`, and `ParamEyeBallX/Y` parameters. Every value is clamped to the actual Core parameter metadata range; models that do not expose these facts do not receive guessed values.
- Adds `interactive?: boolean` to the model registry definition, defaulting off. When opted in, a hit area named `Body` starts the first available `TapBody` motion transiently. The current story intent is unchanged and resumes when the temporary motion completes.
- The model factory exposes only optional `hitTest`, `tap`, `drag`, and `endDrag` entrypoints when a model registry opts in. `NovelModelView` connects them to the existing framework gesture API, owns a single model contact, cancels the gesture when a second model contact arrives, releases overrides on up/cancel, and disposes its recognizer with the Solid owner.
- `StageCharacter` combines the active Story phase with the model registry opt-in. This keeps model input off during title, paused, transition and overlay states; existing focus targets retain priority where they cover the stage.
- Viewport contacts are inverse-mapped through the safe-stage center-pivot camera transform, then the character's top-left anchored scale/rotation and artScale. The helper is regression-tested with camera zoom, translation, character scale 1.5, rotation, and safe insets.

## Validation

Pure SDK regression command:

```sh
bun test sdk/packages/pocket_live2d/test/interaction.test.ts sdk/packages/pocket_vn/test/live2d.test.ts sdk/packages/pocket_vn/test/scene.test.ts
```

Result on 2026-11-12: **11 tests passed, 0 failed**. Coverage includes parsing declared hit areas, hit testing current PMS1 triangles (including a non-rendered helper mesh and degenerate-triangle rejection), placement-adjusted drag values using Core parameter ranges, default-off behavior, transient TapBody motion, drag overrides, return to the authored motion, and camera/character coordinate inversion.

Lantern has opted in through `novel.assets.json` for the official Hiyori model. Its full title/gallery menu path did not reach the Live2D touch screen in three attempts; those navigation-only failures are recorded below and do not count as touch results.

The real Flutter/Core input fixture was built and run with:

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_NATIVE_LIBRARY="$PWD/sdk/native/target/release/libpocket_flutter.dylib" \
FLUTTER_BIN=/Users/lincoln.law/fvm/versions/3.47.9/bin/flutter \
sh sdk/packages/pocket_live2d/scripts/run_macos_hiyori_guest_pixels_test.sh
```

Result: **1 Flutter test passed**. The test ran the generated 718,753-byte QuickJS Guest with the official Hiyori model through `NovelView`, the Pocket host, Flutter, and the real Cubism Core FFI. Its story used camera zoom 1.4 and character scale 1.5 with rotation; a body tap sent the bundled `TapBody` `ParamAngleX=1` value to Core and changed Core mesh geometry without advancing the dialogue. A pointer drag changed Core angle parameters and mesh geometry; releasing the pointer cleared the drag override. The test selected the body hit point at viewport `Offset(222.9, 383.0)`. QuickJS bytecode generation exited successfully; the local build printed a non-blocking `rust-objcopy` warning because `libLLVM.dylib` was unavailable. Full log: `/tmp/pocket-live2d-interaction-core.log`.

Three attempts to reach the same touch step through Lantern's title/gallery menu did not get past stale or culled menu text before reaching Live2D. Their failure summaries are in `/tmp/pocket-novel-model-showcase-navigation-failures-20261112.log`; they are navigation failures, not failed touch assertions. The dedicated Guest/Core fixture covers the production `NovelView` and `StageCharacter` transforms without that menu path. No physical iOS device run was performed.
