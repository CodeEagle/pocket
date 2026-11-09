# Lantern Android physical-device preparation

## Scope and retained-source boundary

The retained parent project at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched with
`pocket_host/` excluded. It has no Cubism/Live2D Core integration and no
high-resolution Pocket IMG upload path to reuse. The Android model path here
therefore combines the existing `pocket_live2d` Core bridge with Pocket's
existing PAK image decoding path; it does not add a second renderer.

The pinned PocketJS source is bootstrapped by
[`prepare_upstream.py`](../scripts/prepare_upstream.py). Its spec distinguishes
`TEX_MAX_DIM = 512` from `IMG_MAX_DIM = 2048`; the core still applies 512 to
generic `upload_texture`, while PAK `upload_img_entry` uses the separate 2048
limit. The high-resolution IMG changes are source patches applied by the
bootstrap process, not an untracked edit to the generated cache.

The V4 Lantern PAK is 69,193,344 bytes, SHA-256
`8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08`.
Its two Hiyori texture pages are 2048×2048. The Lantern host policy allows a
bounded 72 MiB PAK (`demo/lib/main.dart` and `demo/js/pocket.system.json`); that
admission limit is not a process-RSS measurement. Two decoded RGBA8 pages alone
represent about 32 MiB before renderer copies, model buffers, and other game
assets.

## Android native artifacts

The Pocket FFI library targets `aarch64-linux-android`, using the NDK 28.1.13356709
`aarch64-linux-android24-clang` linker and a 16 KiB maximum-page-size linker
argument. The reproducible command used for this checkpoint was:

```sh
cd /Volumes/ORICO/Development/Github/pocket
ANDROID_SDK_ROOT=/Users/lincoln.law/Library/Android/sdk \
POCKET_ANDROID_NDK=/Users/lincoln.law/Library/Android/sdk/ndk/28.1.13356709 \
  sdk/scripts/build_native.sh android
```

It completed successfully. The full log is `/tmp/pocket-v4-android-native-build.log`.
The command recompiled the pinned PocketJS `pocket-spec`, `pocketjs-core`, and
`pocket_flutter` crates with the high-resolution IMG patch present, then copied
the library into the Flutter plugin's JNI directory. Both files have SHA-256
`a3af026174fbb1ff77e4271d55461cb2f2899e0fadf1efd07974f0e39563f423` and
`file` identifies them as ELF64 little-endian AArch64 shared libraries:

- `sdk/native/target/aarch64-linux-android/release/libpocket_flutter.so`
- `sdk/packages/pocket_flutter/android/src/main/jniLibs/arm64-v8a/libpocket_flutter.so`

The build emitted a non-fatal `rust-objcopy` warning because the installed
macOS Rust toolchain could not load `libLLVM.dylib`; the build succeeded, and
the resulting shared library is not stripped. The Profile APK later contains
the Gradle-stripped form of this same library, verified below.

## Cubism Core cache and license boundary

`pocket_live2d`'s Android CMake target is arm64-v8a only and links the official
Cubism Core static library plus Android `log`. It consumes the proprietary
Native SDK R5 archive through
[`bootstrap_cubism_core.sh`](../packages/pocket_live2d/scripts/bootstrap_cubism_core.sh).
The script pins archive SHA-256
`7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12` and
requires the user to accept Live2D's development terms before downloading.

For this machine, the already-approved SDK was present behind a temporary
symlink into `/tmp`. The symlink target was copied, byte-for-byte, into the
package's ignored stable cache; the original temporary directory was left
untouched. The copy contained 1,371 entries / 46,401,317 file bytes. Its
Android arm64 archive
`Core/lib/android/arm64-v8a/libLive2DCubismCore.a` retained SHA-256
`b301d59702f7ac341f6314368d406267d877da6f66458c6eb5b8337580c2742f`.
The stable path is
`sdk/packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5`.

This local cache normalization is not a publication or redistribution
license claim. On a fresh checkout, use the official bootstrap flow and review
the license prompts; do not copy the ignored cache into a distributable
artifact or source archive.

## Profile APK and real-host verification commands

The Android app uses `flutter.ndkVersion` from `demo/android/app/build.gradle.kts`
and has a minimum SDK of at least 24. The Live2D CMake plugin rejects any ABI
other than `arm64-v8a`. A Profile integration APK for
`integration_test/novel_model_showcase_test.dart` has been built and archived
at `sdk/.pocket-build/lantern-v4-android-profile-20261108/app-profile.apk`.
It is 67,749,729 bytes with SHA-256
`b2e4b679763727f86a23dc80b897e65251661457ce48016f5dca73c0421e3692`.
Its APK verification record is
[`apk-verification.json`](../.pocket-build/lantern-v4-android-profile-20261108/apk-verification.json).

The APK contains `lib/arm64-v8a/libpocket_flutter.so` (5,043,944 bytes,
SHA-256 `d4093c2aff0813f16f91a48617943f8617c02d286b741c5d986152b2072ac412`)
and `lib/arm64-v8a/libpocket_live2d.so` (557,376 bytes, SHA-256
`68db30901ae2b3a5d131e5d23d0931b08ce31fdf1e7d5d4380c5639707f2c1bb`). It
also carries the frozen Lantern PAK (`8126d148...`) and QJBC (`8defe742...`).

The Pocket FFI native provenance was checked byte-for-byte: the Android Rust
target, plugin JNI input, and Gradle merged library all hash to
`a3af026174fbb1ff77e4271d55461cb2f2899e0fadf1efd07974f0e39563f423`. The
Gradle Profile stripped output and the `libpocket_flutter.so` extracted from
the APK both hash to `d4093c2aff0813f16f91a48617943f8617c02d286b741c5d986152b2072ac412`.
This proves the APK entry is the stripped result of the new native input; its
hash is expected to differ from the unstripped JNI source. The independent
path/hash evidence is
[`android-native-provenance.json`](../.pocket-build/lantern-v4-android-profile-20261108/android-native-provenance.json).

If rebuilding the integration APK after a source or asset change, use this
command from `demo/`:

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
env -u POCKET_NATIVE_LIBRARY \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter build apk \
  --profile --target-platform android-arm64 \
  --target=integration_test/novel_model_showcase_test.dart
```

To run the archived APK on the physical device, use this driver command from
`demo/` after the device is available and unlocked:

```sh
env -u POCKET_NATIVE_LIBRARY \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive \
  --profile --no-pub \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/novel_model_showcase_test.dart \
  --use-application-binary=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/lantern-v4-android-profile-20261108/app-profile.apk \
  -d 192.168.50.133:5555
```

The APK has not been installed or run on a device. No command in this
preparation task accessed, woke, unlocked, installed to, or ran on the
connected device.

To independently inspect the packaged ABI, library and guest payload:

```sh
cd /Volumes/ORICO/Development/Github/pocket
unzip -l sdk/.pocket-build/lantern-v4-android-profile-20261108/app-profile.apk \
  | rg 'lib/arm64-v8a/lib(pocket_flutter|pocket_live2d)\.so|assets/apps/lantern/app\.(pak|qjbc)'
unzip -p sdk/.pocket-build/lantern-v4-android-profile-20261108/app-profile.apk \
  lib/arm64-v8a/libpocket_flutter.so | shasum -a 256
shasum -a 256 demo/assets/apps/lantern/app.pak demo/assets/apps/lantern/app.qjbc
```

The APK's PAK and QJBC entries were verified against the production files.
For the Pocket library, compare against the Gradle stripped output rather than
the unstripped JNI input. A stale APK or mixed QJBC/PAK pair is not evidence
for the current high-resolution source.

## What the integration can and cannot prove

`novel_model_showcase_test.dart` uses the default `PocketLive2dPlugin`
`fromBundledCatalog` factory, the real FFI/Core library, and the bundled model
and texture assets. It checks that both 2048×2048 pages decode, mask/layer
operations and mesh geometry are present, model geometry changes over time,
the live model pauses/resumes with host lifecycle changes, and replay exit
releases the native handle. It redirects the application-support directory to
a private temporary location and restores the original path-provider state,
so it does not overwrite the user's normal save directory.

On physical Android, a passing driver run would prove those native decoding,
FFI, and storage paths on that Android build. Its `WidgetTester` pointer actions
are automation-generated; they do not prove hardware touchscreen behavior.
Likewise, the existing Flutter IME/widget tests do not prove a physical
keyboard candidate window or device-specific IME behavior. Those require a
separate hands-on check on an unlocked device. No physical Android acceptance,
RSS limit, cold-start budget, or long-duration memory result is claimed here.
