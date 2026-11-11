# iOS edge-back integration regression

This note records the retained FunApp integration path and the regression test for an iOS left-edge swipe in a loaded Pocket SystemUI route.

## FunApp source path checked

| Layer | Source | Observed behavior |
| --- | --- | --- |
| Entry and app overlay | `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/funapp/app_metafun/lib/main_internal.dart` | Calls `runMetafun` and wraps the app with inspector shake/tap helpers. Shake is disabled while the Pocket container route is mounted. |
| Root app and theme | `common_lib/packages/tryfun_app_container/lib/src/app.dart`, `common_lib/packages/tryfun_component/lib/src/ui/themes.dart`, `common_lib/packages/tryfun_component/lib/src/res/light_theme.dart` | `GetMaterialApp` uses `Themes.light()`, which starts from `ThemeData.light().copyWith(...)`; no `platform: TargetPlatform.android` override is present. Flutter derives the unspecified theme platform from `defaultTargetPlatform`. |
| Debug launch | `common_lib/modules/tryfun_debug/lib/pages/debug_page.dart`, `_launchPocketContainer` | Pushes the remote container with an ordinary `MaterialPageRoute`. |
| Pocket page and host | `common_lib/packages/tryfun_pocket/lib/src/pocket_remote_container.dart` | The page supplies a `Scaffold`; after loading, it directly builds `PocketSystemHost.fromHostConfig`. |
| App-wide pointer overlay | `common_lib/packages/funvr_external_display/lib/remote_pointer_controller.dart`, `RemotePointerOverlayHost` | The optional visual pointer overlay is wrapped in `IgnorePointer`, so it does not take the edge touch. |
| SDK back boundary | `sdk/lib/src/pocket_system_host.dart`, `_PocketBackInputBoundary` and `_PocketEdgeBackListener` | `PopScope(canPop: false)` keeps the outer route from popping before the host asks the guest. A raw `Listener` is an ancestor of the loaded `PocketGuestSession` and receives its down, move, up, and cancel events. |

No FunApp ancestor found that forces the Material theme platform to Android. The app-level inspector tap helper is a translucent raw `Listener`; it does not claim a gesture or absorb pointer events. The original `Theme.of(context).platform` suspicion was therefore not supported by the inspected source. The route-level hit path is covered directly by the widget regression below.

## Regression and ablation

`sdk/test/pocket_back_edge_regression_test.dart` mounts a first-frame-ready `PocketSystemHost` in a real `MaterialApp` and `MaterialPageRoute` with a `Scaffold`, and overrides the test platform to iOS. It checks:

- A slow 112 px right swipe requests `platform.back.request` through the distance path.
- A cancelled edge contact issues no additional request.
- A 50 px swipe with continuous timestamped movement samples requests Back through the velocity path, while the host route stays mounted and `onClose` remains at zero after a handled reply.

The distance-only ablation was run in a temporary SDK package copy under `/tmp`; it changed only the copied recognizer predicate to `horizontal && dx >= 88`. The long swipe still passed, while the fast 50 px swipe produced no second request and failed the regression expectation. The working SDK source was not edited for the ablation.

Commands and results:

```sh
cd sdk
flutter test test/pocket_back_edge_regression_test.dart
flutter test test/pocket_system_host_test.dart
flutter test test/pocket_host_loading_test.dart
```

All three test files passed with the velocity path enabled. The test uses multiple move samples over 30 ms; a single move followed by a delayed up can estimate a negative terminal velocity and does not model the continuous short swipe being covered.

## Collecting a device trace without restarting FunApp

On macOS, open **Console**, select the connected iPhone under **Devices**, start streaming, and filter for the installed FunApp process or bundle identifier. Search the stream for `[PocketBack]` while reproducing the swipe. Xcode's **Window → Devices and Simulators → Open Console** provides the same live device log view. This only attaches to the current process; it does not restart the app. The active build's bundle identifier is available in `app_metafun/ios/Runner.xcodeproj/project.pbxproj` (development configurations use `com.lovappen.pulse.TRYFUNLive`; release configurations use `com.lovappen.pulse`).
