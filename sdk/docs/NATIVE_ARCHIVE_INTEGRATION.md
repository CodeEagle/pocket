# Default native archive extraction

Pocket SDK installs `pocket_archive` as a regular Flutter plugin dependency. `PocketSession` passes its native extractor to the existing package store for 7z bundles; consumers do not register another provider or import FunApp code. The resource IO boundary stays in Dart/native code, while application UI, state and routing remain JS-owned.

## Source and consolidation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` contains simulated YooAsset/AOT update flows, but no reusable production archive extractor outside the excluded `pocket_host/` subtree. Its documented hash-addressed chunks and atomic activation semantics are retained in the current signed package pipeline.

The reusable production ZIP implementation comes from FunApp `common_lib/packages/unzip_kit/ios/Classes/native/`, `ios/Classes/UnzipKitPlugin.m`, and the corresponding Android JNI/plugin bridge. It uses the 7-Zip 26.05 source release. The shared implementation now lives in `sdk/packages/pocket_archive/ios/native` (also exposed through the `native` alias), with its license at the package root; FunApp's `unzip_kit` keeps its public Dart API and delegates native ZIP extraction to this dependency. Do not vendor a second 7-Zip tree in the App.

The prior wrapper selected only the ZIP handler. Supporting the signed game bundle requires a real 7z/LZMA2 handler, rather than assuming the presence of codec source already made `.7z` extraction available.

## Integrity and lifetime

The package store still checks signed archive length and SHA-256 before native extraction, then checks expected paths, file lengths and individual SHA-256 values before admitting blobs. File paths cross the plugin boundary; expanded payload bytes do not cross a MethodChannel or return as a full Dart archive map. Verified staged files on the blob filesystem can be promoted by rename instead of copying their contents again.

Extraction runs away from the Flutter UI thread. The store awaits the actual native operation before deleting its input/output files, including after cancellation. A configured native extraction failure propagates; it does not silently retry through a different decoder. Standalone `pocket_services` users must inject a native extractor to consume 7z bundles. Without one, the store fails explicitly; there is no Dart 7z codec or fallback. Existing legacy ZIP IO remains separate.

Native extraction has a separate observed start/completion stage. Per-file verification and assembly publish their actual byte/file counts. There is no simulated total-startup percentage or timer used as evidence of extraction progress.

## App development and installation

FunApp `app_metafun/pubspec.internal.yaml` overrides the Pocket SDK, runtime, services, archive and Live2D packages to the local Pocket checkout. Its Release profile retains fixed Git dependencies. The existing `tools/flutter_pub_get_fast app_metafun internal` activates Dev resolution; profile regeneration preserves the local overrides, and dependency cache keys include local package manifests.

Dart changes are visible through those local dependencies after hot reload/restart as appropriate. Adding or changing native plugin code requires a full App rebuild and normal CocoaPods/Gradle resolution; hot reload cannot install native code into an already-running App.

## Validation

- Real Flutter/macOS MethodChannel extraction of the signed game archive: two runs at 804 ms and 1,989 ms, each producing 55 files / 76,090,251 bytes with all hashes passed. Including Dart file reads/hash checks: 1,315 ms and 2,646 ms. These are host observations under changing load, not a stable device benchmark. Archive SHA-256: `e46b69e23c5e15c534c0704c19fdded0ca0736d304d8a008e5137b8f506604e8`.
- FunApp iOS native plugin target: device Debug build passed with code signing disabled (deployment target 15.0 for this build). Apple bridge syntax checks also passed for iOS and macOS. The macOS Flutter probe used deployment 12.0 to satisfy the installed Xcode 27 toolchain.
- Android: arm64/API23 CMake build with NDK 28.1.13356709 passed; real FunApp host `:pocket_archive:assembleDebug` passed and packaged the native library.
- Flutter 3.35.7: full Session suite 46/46 passed, including the real QJBC/pointer case without skipping; startup widgets/builders/outer host 15/15 passed; analysis passed.
- Native regression runner: all 10 compressed 7z, encrypted ZIP, wrong-password, traversal, casefold duplicate, symlink, quota and oversized-header allocation cases passed.
- Services: injected native extraction success, digest tampering, symlink, native error propagation and cancellation cleanup tests passed (5). After removing the Dart 7z encoder/decoder/header and LZMA machinery, all 86 service tests passed under Flutter and analysis was clean. The six native-injection cases include fail-fast before stream consumption. A plain `dart test` attempt failed to load the pre-existing Flutter `dart:ui` dependent guest-memory test; the Flutter runner covers it and passed.
- FunApp: Dev fast resolution passed; all five Pocket packages resolve to the local checkout. ZIP compatibility suite 9/9 passed. CocoaPods has one PocketArchive and no UnzipKit native pod; generated registrants match.

The plugin declares Android, iOS and macOS only. Windows/Linux native archive bridges are not delivered by this change. Physical iPhone loading, timeout recovery and startup timing still require a full rebuilt App and device verification. Desktop measurements do not establish iPhone performance.

Evidence: `sdk/.pocket-build/iphone-preparation-20261109/`; App logs are `/tmp/funapp-pocket-native-local-final-20261109.log`, `/tmp/funapp-unzip-kit-tests-20261109.log`, `/tmp/funapp-pocket-pod-install-20261109.log`, and `/tmp/pocket-archive-ios-device-build.log`.

Final removal validation: the combined Session and startup UI suite passed 61/61 after the Dart codec deletion, including real QJBC pointer input. Roughly 1,650 lines of Dart 7z machinery were removed. Compressed fixtures now live beside the sole native codec.

The 7z adapter also bounds metadata allocations to 64 MiB per main/temp allocator while opening headers, rejects folder unpack sizes above the output quota before extraction, and limits extraction allocations to output quota plus 128 MiB decoder slack. This addresses declared encoded-header/folder allocation sizes that the upstream C API can consume before file totals are available. The bounded allocators are owned per call, with no shared mutable quota.

After the allocation limits were added, the actual Flutter/macOS channel extracted the same full package in 1,719 ms (2,350 ms including all file hash checks); the iOS device target also rebuilt successfully. Final native regression count: 10/10.

## Consolidated review follow-up

The local `agy` Argon Medium review identified that native MethodChannel failures could enter the network retry loop. The Session adapter now maps a missing plugin to `native-archive-unavailable` and native extraction errors to deterministic `bundle-format` failures. The updater therefore reports a failed, already-downloaded archive without downloading it again. ZIP keeps its existing Dart route; only 7z uses the injected native extractor.

Follow-up validation passed 28 service tests (including one-download failure, ZIP bypassing the native extractor and cancellation cleanup) and two actual MethodChannel exception mapping tests under Flutter 3.35.7. FunApp's fast updater also handles commented Git dependency blocks, with a production-matcher fixture covering active/commented refs and preserving unrelated dependencies. Its profile synchronization regression passed. These checks do not replace the pending physical iPhone verification.
