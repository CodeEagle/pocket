# iOS Swift Package Manager migration

## Scope and source provenance

The seven reusable iOS plugins are SwiftPM-only:

- `pocket_biometrics`
- `pocket_bluetooth`
- `pocket_camera`
- `pocket_flutter`
- `pocket_location`
- `pocket_platform`
- `pocket_sensors`

Before migration, the retained parent
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected while
excluding its deprecated `pocket_host/` directory. Its only relevant native
package was `ios/PocketRuntime/pocket_runtime.podspec`, backed by
`ios/PocketRuntime/Classes/pocket_runtime_multi.c` and `.h`. It establishes the
retained thin native boundary but contains no SwiftPM implementation to reuse.
The current plugin behavior therefore remains unchanged; only the Apple package
layout and linker transport were adapted.

## Layout and ablation

Each plugin now has the Flutter-recognized package root:

```text
ios/<plugin>/Package.swift
ios/<plugin>/Sources/<plugin>/*.swift
```

The former `ios/Classes` directories and all seven iOS podspecs were removed.
There is no copied compatibility source tree or CocoaPods wrapper. Generated
hosts and the demo enable SwiftPM through `flutter.config` in `pubspec.yaml`.

`pocket_sensors` keeps its native policy tests in
`ios/pocket_sensors/Tests/pocket_sensorsTests`. The Editor Bluetooth helper was
updated to compile the same canonical `PocketBluetoothCore.swift` source from
the package directory, preserving one CoreBluetooth state machine.

## Native FFI binary

`pocket_flutter` keeps the generated arm64 device and Apple-Silicon simulator
archives in `ios/pocket_flutter/Frameworks/PocketFlutter.xcframework`. The
Swift package declares it as a local binary target. Its linker settings retain
all archive objects and export process symbols because Dart resolves the C ABI
with `DynamicLibrary.process()` rather than direct Swift references.

The native build and cache paths were moved with the package. The XCFramework
remains a generated artifact and is ignored by Git; `build_native.sh ios` or
`build_native.sh ios-sim` reproducibly creates both slices before Flutter links
the application.

## Validation

- All seven manifests pass `swift package dump-package` with Swift tools 5.9.
- An isolated Flutter 3.35.7 app enabled SwiftPM and referenced all seven local
  packages simultaneously.
- `flutter build ios --release --no-codesign` completed for an arm64 device
  target.
- The demo was deintegrated from CocoaPods and rebuilt from a clean state with
  SwiftPM as its only plugin dependency manager.
- The final `Runner` executable exports `_pocket_create`, `_pocket_load`,
  `_pocket_eval`, `_pocket_frame`, and `_pocket_destroy`, confirming that the
  Rust FFI archive survived release dead stripping.

Physical camera, Bluetooth, location, biometric, and sensor behavior still
requires device permissions and is not claimed by the linker/build validation.
