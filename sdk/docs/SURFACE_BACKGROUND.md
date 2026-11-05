# Root surface background and drag artifacts

## Source and scope

Retained source inspected before implementation (no changes to the parent):

- `../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`,
  `PocketCanvas2DPainter.paint`: draws an opaque `0xFF090D16` rectangle before
  its DrawList. The SDK retains the backing-color behavior at the root surface
  boundary rather than copying the old Dart UI renderer or telemetry grid.
- `../pocketjs_flutter_demo/lib/main.dart`: uses the theme surface as the
  scaffold background; the native `macos/Runner/MainFlutterWindow.swift` has
  no custom opacity setup.
- `sdk/packages/pocket_flutter/lib/src/pocket_view.dart`: retained transparent
  blocks of 32 DrawOps, interleaved with native/compositor surfaces. The gap
  was the lack of a public viewport background after startup.
- `sdk/packages/pocket_ui/src/ui.tsx`, `ScrollablePage`: JS owns scrolling,
  clipping and content translation. Its existing `class` supports an optional
  page background. No second scroll state or Dart page policy is introduced.

## SDK contract

`PocketApp.backgroundColor` and `PocketSystemHost.backgroundColor` default to
opaque black. Existing generated projects already use `PocketApp`, so no
generated platform patch or consumer-file rewrite is necessary.

```dart
PocketApp(config: config, backgroundColor: const Color(0xFF000000));

PocketSystemHost(
  systemUI: systemUI,
  applications: applications,
  backgroundColor: const Color(0xFF000000),
);
```

`PocketGuest` and low-level `PocketView` expose nullable `backgroundColor`;
null retains embedded scene transparency. Set an opaque color when using
either as an independent root. An explicitly transparent color remains
supported. The backing color covers the viewport, including blank DrawLists
and letterboxing, without depending on a moving JS content rectangle.

Compositor children keep their default transparency. The background must be
painted once underneath the scene, never inside each 32-op painter: an opaque
fill in later blocks would cover earlier DrawOps and native surfaces.

There is no need to repeat the same solid fill in MaterialApp.builder,
Scaffold, SystemHost, ScrollablePage and its content column. JS pages can still
choose their own backgrounds when visually distinct. No global dark theme or
hardcoded page color is imposed on reusable JS components.

## What this establishes

An opaque backing prevents uncovered pixels from showing the surrounding
Flutter scene. It does **not** establish that Flutter failed to clear a Metal
swapchain, nor does a `ColoredBox` directly select `MTLLoadActionClear`.
`RepaintBoundary` deliberately retains display lists/raster layers; retention
itself is not evidence of an engine defect.

References: [Flutter RepaintBoundary](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html),
[CustomPainter](https://api.flutter.dev/flutter/rendering/CustomPainter-class.html),
[macOS FlutterViewController.backgroundColor](https://api.flutter.dev/macos-embedder/interface_flutter_view_controller.html).

Native NSWindow opacity belongs to the consuming macOS Runner. The SDK does
not rewrite an existing window, whose transparency may be intentional. If
artifacts persist with the SDK backing enabled, reproduce on the affected
Impeller build and capture GPU/frame evidence before changing layer policy
or asserting a swapchain-clear defect.

## Validation

- `sdk`: `flutter test --no-pub test/pocket_background_test.dart`: 3 passed;
  API defaults/overrides, startup/failure backing and transparent child sessions.
- `sdk`: `flutter test --no-pub test/pocket_system_host_test.dart`: 3 passed.
- `sdk/packages/pocket_flutter`: with `POCKET_NATIVE_LIBRARY` set to
  `sdk/native/target/debug/libpocket_flutter.dylib`, `flutter test --no-pub
  test/pocket_view_invalidation_test.dart test/pocket_compositor_view_test.dart
  test/pocket_view_first_frame_test.dart --reporter expanded`: 18 passed.
- Targeted analysis of changed Dart implementation files: no issues.
- `sdk/packages/pocket_flutter`: with the same native library,
  `flutter test --no-pub test/pocket_view_background_ffi_test.dart --reporter
  expanded`: 1 passed, 0 skipped. Real QuickJS creates 40 DrawOps; actual
  pointer MOVE/UP moves and deletes nodes across the 32-op boundary. With the
  backing disabled, uncovered pixels show the host color without trails in
  this raster test. With it enabled, old/deleted positions show the configured
  color; static foreground pixels survive. Changing the color updates exposed
  pixels without per-block fills. This ablation supports one root fill and
  does not justify removing retained blocks or adding duplicate page fills.

Flutter widget raster tests exercise actual JS execution and pixel composition
but do not execute the macOS Impeller Metal swapchain.
