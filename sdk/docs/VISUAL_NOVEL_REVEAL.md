# Directional scene reveals

## Source and adaptation

The retained parent was inspected outside `pocket_host/`: `../pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_router.js` (`computeTransitionDescriptor`), `lib/core/pocketjs_bundle_runner.dart` (route transition progress/modes), and `lib/render/pocket_ui_components.dart:524-695` (`PocketPageTransitionCompositor`). Those implement navigation transitions between route subtrees, not authored VN scene reveals. Their existing progress/composition principle is retained; the migrated VN engine's existing `transition.from/id/elapsedMs`, `StageArt`, camera resolution and animation driver provide the actual scene implementation. No Flutter route state machine or second renderer is added.

## Authoring and lifetime

`scene.transition` accepts `{kind:"reveal", durationMs, direction?}`. Direction defaults to `left` and names the starting edge: left→right, right→left, up→down, down→up. `cut`, `fade` and `dissolve` remain available. Unknown directions, directions on another transition kind, and invalid durations are rejected in both the engine and editor; save restoration validates the same contract.

A reveal paints the retained previous scene, then clips the incoming scene through a growing rectangle. The inner scene retains the complete stage dimensions; a compensating inner offset keeps cover UVs, models and camera geometry stationary as the aperture changes. The player HUD stays outside the aperture. The existing engine tick advances the transition, while pause, skip, save/load and rollback use the same canonical state. Completion retires the transition and its outgoing scene. Ordinary scenes do not retain the extra clipping subtree after completion.

The editor uses its existing scene form, draft, history, save/reopen and pinned buildGuest pipeline. It adds a reveal option and four direction choices; leaving reveal removes its direction field. There is no parallel transition editor document or clock.

## Showcase and compatibility

Lantern adds the independent “穿雾换景” / “Through the Fog” replay, using station, archive, roof and dawn with four 1,200 ms reveals. It uses the existing replay engine and image-skinned player controls. Existing script labels and instructions are unchanged, so their v6 cursor locations and v1–v5 revision maps remain valid. This is additive content, not a relaxed migration comparison. Main-story progress remains parked while the replay runs. English and Chinese dialogue/title catalogs cover the new entry. Nine already missing English inventory UI messages were also filled from the SDK's existing English catalog; no new localization fallback was added.

## Verification

Evidence is retained under `sdk/.pocket-build/reveal-transition-20261108/`. Final results and target limits are recorded below. Earlier failed build/harness attempts remain available and are not acceptance.

The default installed prebuilt compiler still limits textures to 512, whereas the current accepted Lantern resources include the original 2048² Hiyori atlases. This increment uses the same generated pinned tools package as the preceding accepted build via `POCKET_TOOLS_PACKAGE=sdk/.pocket-build/retina-native-tools-20261108`; it does not reduce those resources or substitute another compiler/runtime. Native/package refresh remains necessary when reproducing from an older installed tools package. Live2D clarity is deferred.


| Layer | Observed evidence |
| --- | --- |
| Engine and SDK | `vn-regression-final.log`: 204 tests / 1,639 assertions pass, including interrupted reveal→new reveal→cut, resolved outgoing camera, one retained composition, clock wake release, validation, pause/skip/save/load/rollback. Strict core TypeScript check passes. |
| Lantern content | `lantern-unit-final.log`: 27 story/locale tests / 1,584 assertions pass, including parked main save and unchanged strict migration comparison. |
| Editor | `editor-acceptance.json`: 21 schema/service tests pass; one Playwright bundled-Chromium → undo/redo → save/reopen → pinned buildGuest/NativeSession workflow passes 42 assertions. The two other tests in that browser file were filtered, not claimed as passed. |
| Native draw stream | `reveal-native-cut-control.log`: one isolated compiled Guest passes real pointer-driven four-direction start/mid/end clip, inverse UV/no stretch, outgoing removal, HUD hit/position, paused menu, seen-only skip, quick save/load and rollback. The cut control shows full incoming art and no retained old image immediately; this is a lifetime/geometry ablation, not an FPS measurement. Storage in this fixture is NativeSession's injected map, not OS disk. |
| Existing Lantern interactions | `lantern-feature-regression.log`: all four feature-tour NativeSession cases pass against the exact final QJBC/PAK, preserving the existing eight-category tour. |
| macOS rendering | `macos-reveal-midpoint.log` / response: one functional Profile test plus framework teardown passes all three declared checkpoints. Actual decoded station/archive/roof/dawn art, four directional clips, fixed HUD in the active child's separate paint partitions and disposal are checked. Four 800×600 application-boundary PNGs were visually inspected. |

Final mid-reveal clip rectangles `(x,y,w,h)` are left `(0,0,433,600)`, right `(478,0,322,600)`, up `(0,0,800,242)` and down `(0,342,800,258)`. The screenshots are application layer captures, not proof of user-visible foreground while the OS is locked. Earlier Flutter attempts incorrectly expected art and HUD in one painter; the renderer partitions them inside the same active PocketView. The final test checks that surface's full set of partitions and retains the HUD containment assertion.

The final ordinary `lib/main.dart` Profile app is archived at `sdk/.pocket-build/lantern-playable-reveal-20261108/pocket_host.app`. Signature, exact bundled assets, runnable main isolate and an onscreen 800×632 window are verified; new PID 63535 replaced the owned old PID 56715 only after readiness. No editor opened and no normal store was cleared. AppKit still reports `com.apple.loginwindow` frontmost, so user foreground visibility is not verified. An initial readiness probe checked the wrong VM protocol field (`isRunnable`); the same live process was re-observed using the actual `runnable` field, without restarting it.

Exact final artifacts: QJBC 1,139,889 bytes, SHA-256 `6f0fb10eb7f6abe4a6739316b6518e6a66594aa256ff5c3f889134a1ea4c4f7c`; PAK 69,216,560 bytes, SHA-256 `54c923d8507e1131263ad3c1e3f705c0386d46faea74f352d60a7a93ac2f3f5e`; metadata SHA-256 `358d0718e81e0ea4dae2bcfa8d34ed315978caf29d965c8c8f3ea453daa67cd9`. These replace the preceding thumbnail artifacts in `demo/assets/apps/lantern`; earlier mobile packages are not relabelled as this reveal build.

This does not establish iOS/Android/Windows rendering of this final reveal scene, physical-device input/lifecycle, external-video clipping, arbitrary Cubism models, frame-time/RSS improvements, or other styled effects such as radial masks/shaders. S05 and the complete project Goal remain partial. Live2D image clarity remains explicitly deferred.
