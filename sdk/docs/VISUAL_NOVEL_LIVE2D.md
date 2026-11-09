# Live2D Cubism support

## Current high-resolution checkpoint, 2026-11-07

2026-11-08 update: the real Core Profile matrix at 390×844 / 1920×1080,
DPR 1/2 passes all four runs. The desktop framing and full-body composition
still need correction; see [density evidence](VISUAL_NOVEL_MODEL_DENSITY.md).
The older checkpoints below do not supersede this finding.

Lantern now stages both pinned Hiyori PNGs byte-for-byte at 2048×2048.
The reproducible [static IMG adaptation](VISUAL_NOVEL_HIGH_RES_TEXTURES.md)
raises only PAK IMG admission to 2048; ordinary raw textures remain limited
to 512. Flutter mesh sampling explicitly requests bilinear filtering.
The 512-pixel checkpoints below remain historical evidence, not validation of
this newer high-resolution guest on iOS/Android/Windows/Web.

The first macOS Debug high-resolution integration passes (50 seconds,
`/tmp/pocket-highres-model-macos-static.log`): both actual decoded images are
2048², two-page masked Core geometry changes with motion, lifecycle pause/resume
preserves the handle, exit releases it and the main disk autosave is unchanged.
The test redirects AppSupport to a real temporary directory and restores it
on teardown, isolating it from the normal Demo. It uses the SDK's packaged
macOS static archive; an earlier attempt with an external dylib override was
rejected by the application sandbox and is recorded as failed.

Hiyori motion previews now use the existing scene + 2600 ms wait + framing
choice. This removes the dialogue/choice plate during the preview. Face closeups
reuse authored character position/scale; no alternate viewer runtime is added.
The first real closeup screenshot at 329×600 was too low; the final candidate
moves its authored y from 185 to 70, keeping x=-176 and scale=3. Its final revalidation also passes (50 seconds,
`/tmp/pocket-highres-model-macos-y70.log`), with both captures at 329×600 / DPR 1.
The inspected closeup has the face centered more comfortably; screenshots and
source/artifact hashes are retained under
`sdk/.pocket-build/novel-highres-20261107`.
Final QJBC: 988,548 bytes / `748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc`;
PAK: 58,463,472 bytes / `9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1`. Face-width thresholds at 390/1920, DPR 1/2, whole-game
frame time and high-resolution memory budgets remain unverified. The sample
is still official Hiyori, not an original Lantern cast member.

The normal `demo/lib/main.dart` app was rebuilt and cached separately at
`sdk/.pocket-build/lantern-playable-highres-20261107/pocket_host.app`, then
started as PID 73488. Metal and the VM service are observed in
`/tmp/pocket-lantern-highres-normal-running.log`; the replaced old normal
instance was stopped only after this startup. Editor port 8791 is closed.
The desktop automation connection remains unavailable, so foreground window
position and navigation were not independently observed.

## Scope and upstream source check

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside `pocket_host/` for `Cubism`, `Live2D`, `model3.json`, and `Spine`; the search returned no matches. Its reusable host groundwork is in `lib/core/ffi_bridge.dart` (explicit native C FFI), `lib/core/pocketjs_bundle_runner.dart` (QuickJS app lifecycle and routing), and `lib/render/pocket_ui_components.dart` (the former Dart-owned UI renderer). The old project does not contain a Live2D integration to migrate.

This package reuses the parent’s native-boundary and lifecycle lessons while keeping app policy out of Dart. It does not port the former Dart page tree. JS parses Cubism model, motion, expression, physics and pose JSON, selects motions, runs the official physics/pose algorithms, and sends parameter/part updates. A thin Flutter FFI provider owns only the trusted MOC asset, Core model handle, and facts returned by Cubism Core. The existing PocketJS binary frame, `PMS1` mesh geometry, `MFX1` effect, and `PocketCanvasPainter` remain the rendering path; there is no second model renderer.

## SDK acquisition and license

`scripts/bootstrap_cubism_core.sh` downloads the official Cubism SDK for Native R5 archive from `https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.5.zip` only after a local confirmation. It checks SHA-256 `7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12`. The SDK is extracted into the ignored package `.cache/`; no Core binary, Native Framework source, or official sample model is checked into Pocket. The licensed Cubism Web Framework physics source is separately pinned and adapted in `src/cubism-web/`; see [dynamics provenance](VISUAL_NOVEL_LIVE2D_DYNAMICS.md).

Live2D’s [Native SDK download page](https://www.live2d.com/en/sdk/download/native/) requires reading and accepting the [Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) and [Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html). Live2D’s [SDK Release License page](https://www.live2d.com/en/sdk/license/) describes separate publication licensing. This integration records those terms and does not claim an Editor, expandable-application, or commercial-release exemption. Developers must review the terms for their own use before downloading, bundling, or publishing.

The implementation was checked against the official [Cubism Core overview](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/) and [Core API reference](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core-api-reference/): Core calculates parameter-driven vertices and supplies rendering facts, while drawing and compositing remain the host renderer’s responsibility. The official Native R5 Framework’s `Framework/src/Rendering/Metal/CubismShader_Metal.mm` sets drawable texture sampling to Repeat; `Framework/src/Rendering/OpenGL/CubismShader_OpenGLES2.cpp` also uses `GL_REPEAT`. UVs therefore cannot be clamped to `[0,1]` as a generic cleanup step.

## Runtime boundary and resource admission

The public JS package is `@pocket/live2d`; the reusable Flutter FFI plugin is `pocket_live2d`. `createNovelLive2dFactory` in `@pocket/vn/live2d` consumes the buildGuest-generated `__pocketNovelModelSources` records and a trusted `media.live2d.model.*` host. Native model loading is governed by the bundled catalog `{version:1,assets:{requestMocKey:relativeMocPath}}`; guest input cannot add MOC files. `assetPrefix` prefixes catalog values only. Texture keys are validated as safe relative identifiers and resolve through the existing PAK texture registry, not through a second Flutter asset allowlist.

Admission bounds are:

- At most 4 live/pending Core model loads per plugin instance.
- At most 32 MiB per MOC3 input.
- At most 16 texture pages per model.
- At most 128 MiB aggregate provider-accounted Core/model storage, including MOC bytes, Core model allocation, and retained adapter buffers.

`nativeBytes` is a bounded provider fact, not process memory. It does not include Flutter images, GPU allocations, allocator fragmentation/overhead, or temporary codec/bridge copies, so the limit is not a total RSS cap. Dispose waits for in-flight JS model loads and releases a late Core handle rather than leaving it behind.

The C ABI copies MOC bytes into Core-aligned storage, creates/destroys actual `csmMoc` and `csmModel` objects, resets parameters to official defaults before each update, applies absolute values, runs `csmUpdateModel`, and returns draw order, render order, texture index, position, UV, index, mask, opacity, flags, and blend facts. Geometry crosses Dart/JS as little-endian typed byte buffers instead of expanded scalar arrays. Empty Core meshes stay empty; no triangle is synthesized. Models with Core offscreen blending are rejected until the renderer can reproduce that compositing path.

## Feature support and limits

| Feature | Current behavior |
| --- | --- |
| MOC3 loading and parameter deformation | Real official Cubism Core through the C ABI. |
| Textures and ordinary meshes | Existing Pocket PAK and mesh renderer. JS preserves Cubism's Repeat UV sampling; native `TEX_TRI_REPEAT` and model compositing run through the existing painter. The Hiyori model-only pixel check passes on macOS, iOS Simulator, and Android arm64 emulator. |
| Masks | Uses Pocket mesh mask/effect ops and the Flutter painter. Empty masks retain Core facts and visibility semantics. |
| Blend modes | Modern Core modes are passed as facts; the JS adapter accepts only modes implemented by Pocket’s renderer and rejects unsupported color/alpha combinations. |
| Motion3 parameters, part opacity, and model EyeBlink/LipSync/Opacity values | Parsed and sampled in JS; the VN factory applies model values to groups from the model manifest. |
| Expressions | Add, Multiply, and Overwrite are applied to Core parameter defaults in JS. |
| Motion selection, elapsed time, loop state, and model lifetime | JS VN animation driver owns these policies. Dart has no animation state machine. |
| Physics3 and Pose3 simulations | JS uses pinned official Cubism Physics and Pose algorithms with real Core parameter ranges and part defaults. Referenced JSON must be bundled; missing facts are rejected. Official reference-frame comparisons pass. See the target-specific [dynamics evidence](VISUAL_NOVEL_LIVE2D_DYNAMICS.md). |
| Automatic blinking and microphone lip-sync | Not implemented; model motion EyeBlink/LipSync curves remain supported. |
| Core offscreen render targets | Rejected; Core facts are not silently treated as ordinary drawables. |

Mesh texture triangles now request Flutter `FilterQuality.low` (bilinear), matching the existing ordinary-image sampling path. The retained parent has a generic Canvas2D painter with high filtering, but no Live2D mesh renderer to migrate. `pocket_mesh_sampling_test.dart` compares the production painter with nearest-neighbor output using the same checker texture, fractional UVs, and scaled geometry; existing mesh effect and grouped-mask pixel tests still pass. This verifies the Flutter sampling path, not a rebuilt Hiyori app on every target.

Motions retain `Meta.FadeInTime` and `FadeOutTime` as data. The current simple evaluator does not yet blend motion transitions by those durations. No automatic eye blink or microphone-driven lip movement is claimed.

## Platform packaging

The pinned official Native R5 archive provides Core archives for Android `arm64-v8a`, iOS arm64 device and arm64 simulator, macOS arm64/x86_64, and Windows x86_64. Android links the official archive and Android `log`; its Gradle plugin filters to the shipped `arm64-v8a` slice. The iOS Podspec vendors the official static-library XCFramework. Since the simulator slice only supports arm64, the pod target excludes i386 and x86_64 so CocoaPods' Copy XCFrameworks phase selects the arm64 simulator slice. macOS links a locally assembled Core XCFramework. Windows has an x86_64 CMake entry point and official import library/DLL, but its runtime has not been device-tested. Linux is not wired.

The real Cubism Core-to-Dart bridge and typed-frame codec test passed on macOS arm64. The compiled Hiyori QJBC guest also passed the model-only Flutter pixel test on macOS arm64, iOS Simulator arm64, and the Android arm64 emulator. The iOS Xcode log shows the `pocket_live2d` pod target's `[CP] Copy XCFrameworks` phase selecting `ios-arm64-simulator` and copying `libLive2DCubismCore.a` into `PODS_XCFRAMEWORKS_BUILD_DIR/pocket_live2d`; that same directory is in `LIBRARY_SEARCH_PATHS`, and the target links `-lLive2DCubismCore`. The iOS test uses the default plugin FFI library and demonstrates the ordinary CocoaPods path, not a manually copied archive.

These tests prove macOS arm64 on the current host, iOS arm64 Simulator, and Android arm64 emulator only; no physical iOS or Android device has been tested. The macOS default-plugin consumer uses `fromBundledCatalog` and the packaged FFI library, with no injected Core factory or dylib. Its host reported `sw_vers` 27.0.1. Link output warned that Core archive objects were built for macOS 15.7 while the temporary consumer linked with deployment target 12.0. The test proves the current host works; macOS 12 and other older releases remain unverified, and this package does not raise the main SDK's minimum version. Windows has not been run. The latest default-FFI Hiyori fixture includes Physics3 and Pose3 and verifies their real parameter/part updates, journal pause/resume, and handle release on all three accepted targets. The official Hiyori source textures are 2048×2048, above Pocket's current 512×512 PAK image limit. For these tests only, the two temporary textures are scaled to 512×512; the MOC geometry and UV values are unchanged. This is not evidence that the source-size images are supported. No official sample model or texture is checked into the repository.

## Verification evidence

The reusable Core-to-Dart bridge test runs against an actual Mao MOC3 from the local official sample archive, the compiled Pocket FFI adapter, `PocketLive2dPlugin`, and `PocketBinaryCodec`:

```sh
cd sdk/packages/pocket_live2d
FLUTTER_BIN=/path/to/flutter-3.47.9 scripts/run_macos_core_bridge_test.sh
```

The runner accepts `FLUTTER_BIN`, otherwise chooses `fvm flutter` or `flutter`, and checks the version against the repository `.fvmrc`; it does not use a developer-machine path as its default. The verified Mao frame had 262 drawables and 5,879 changed position components for `ParamAngleX`. Encoding the same frame in the host-response envelope was 235,065 bytes with packed typed buffers versus 533,073 bytes with scalar arrays (55.9% smaller). This is an encoded-size comparison, not an FPS claim; the typed packet was decoded under the actual 1 MiB Pocket host-response budget.

The optional local Hiyori test builds a genuine QJBC guest, runs it in `PocketGuestSession` with the native Core plugin, taps New Game, and checks the PAK-decoded texture mesh, mask/effect ops, painted model-only pixels, animated vertex changes, and model release:

```sh
cd sdk/packages/pocket_live2d
FLUTTER_BIN=/path/to/flutter-3.47.9 scripts/run_macos_hiyori_guest_pixels_test.sh
```

The macOS script requires the local official Cubism SDK cache and a built Pocket native dylib (`POCKET_NATIVE_LIBRARY` can override its default). It writes its ignored model-only output to `sdk/packages/pocket_live2d/.cache/hiyori-guest-pixels/hiyori-model.png`; this artifact is generated evidence, not source. The PNG has a black background because the test paints only Hiyori's texture triangles and mask/layer operations. This check exercises the locally compiled guest and Core path, while the mobile checks below use the platform plugin's default FFI library.

The Core-only Hiyori probe measured 134 drawables, 2,822 vertices, 10,278 indices, 8 masked drawables, no inverted masks, no non-normal blends, 2,903 changed position components (maximum delta 61.8301 px), and 683,438 bytes of provider-accounted Core/model storage. The passing macOS, iOS, and Android guest tests each confirm model texture-triangle ops, nonempty mask/layer ops, texture decode, animated vertex changes, and release. The iOS Simulator test measured 10,849 opaque model pixels and 64 sampled colors; Android measured 10,790 and 64 respectively. These are renderer checks on the temporary 512×512 Hiyori texture fixture, not performance measurements.

The mobile runner reuses an ignored consumer under `.cache/hiyori-mobile-consumer` so Xcode Pods and Gradle outputs remain available between runs; `--clean` explicitly recreates it. It builds the same guest fixture, bundles QJBC, PAK, and the trusted MOC catalog, then uses the default native FFI plugin. On iOS hosts it refreshes CocoaPods after `flutter pub get`; Xcode's `[CP] Copy XCFrameworks` phase selects and stages the official Core slice. Tests run serially in the order of the supplied device IDs. The test reads no fixture paths from process environment variables.

The strengthened iOS Simulator and Android arm64 emulator acceptance passes serially in one runner invocation. Reproduce with:

```sh
cd sdk/packages/pocket_live2d
FLUTTER_BIN=/path/to/flutter-3.47.9 \
POCKET_TOOLS_PACKAGE=/path/to/current-native-tools \
scripts/run_mobile_hiyori_guest_test.sh <ios-simulator-udid> emulator-5554
```

The iOS Simulator and Android emulator each reported `1 passed`. The package test analyzes cleanly with the pinned Flutter version. Consumers must register generated guest files themselves; `buildGuest` copies these files but does not edit consumer `pubspec.yaml`. For example, declare `assets/app.qjbc`, `assets/app.pak`, `assets/guest-manifest.json`, `assets/novel.native-assets.json`, and `assets/native-models/` (or the corresponding configured prefix). Flutter's `assets/` directory declaration does not recursively include nested files, so the trusted catalog can exist while its MOC3 path is absent from the runtime `AssetBundle` unless the nested directory is registered.

The macOS default-plugin consumer was independently rebuilt and run on the same host:

```sh
cd sdk/packages/pocket_live2d
FLUTTER_BIN=/path/to/flutter-3.47.9 \
scripts/run_macos_hiyori_guest_test.sh --clean
```

That test reported `1 passed`, with 10,820 opaque model pixels and 64 sampled colors. Its CocoaPods build staged the macOS Core archive into `PODS_XCFRAMEWORKS_BUILD_DIR/pocket_live2d` and linked it through the default plugin. The archive's macOS 15.7 object deployment markers and temporary app's 12.0 target produce linker warnings; this result does not establish compatibility with macOS 12.


## Physics and pose target acceptance, 2026-11-07

The rebuilt default-FFI guest includes the referenced Hiyori physics and pose
JSON. All three consumers pass actual QJBC execution, decoded texture pixels,
mask/deformation checks, bounded physics output observation, part opacity
updates, journal pause/resume and final model release. The test observes the
real provider; it does not inject a fake Core or simulated deformation.

| Target | Actual Core metadata | Observed hair parameter range | Result |
| --- | --- | --- | --- |
| macOS arm64 | 70 parameters, 24 parts | 0.5403402 | 1 pass |
| iOS arm64 Simulator | 70 parameters, 24 parts | 0.3436862 | 1 pass |
| Android API 35 arm64 emulator | 70 parameters, 24 parts | 0.5412045 | 1 pass |

The range varies with actual frame scheduling; these are evidence of changing
physics output, not a cross-device deterministic timing or performance claim.
Logs: `/tmp/pocket-live2d-dynamics-macos-rebuilt.log` and
`/tmp/pocket-live2d-dynamics-mobile.log`. The shared rebuilt fixture QJBC SHA-256
is `e32be96a1e9507efa869301189764e8bc7f0ec8af6c694260dfeb73321c170c1`.
The macOS runner now always rebuilds the fixture, matching the mobile runner;
it cannot silently reuse bytecode generated when physics/pose were omitted.
Official-reference numerical comparisons and provenance are recorded in
[Live2D dynamics](VISUAL_NOVEL_LIVE2D_DYNAMICS.md).

After strict-type adaptation and removal of retained solver output/cache
references during release, the final source was rebuilt and the macOS
default-FFI consumer passed again (`/tmp/pocket-live2d-source-final-macos.log`).
It reported 70 parameters, 24 parts, 127 updates and hair range `0.6245489`,
and completed model release. Its QJBC SHA-256 is
`fa475e4cfc46dd2d6b9f44572b61281674c3fdd80968d8434e861f7a24187cbe`.
The mobile results above refer to their explicitly recorded earlier artifact;
the subsequent cleanup changes release retention, not the physics algorithm.


## Ordinary Lantern Demo model theater, 2026-11-07

The normal `demo/lib/main.dart` Lantern policy now registers
`PocketLive2dPlugin.fromBundledCatalog` at the native transport boundary. The
JS app uses its existing `createBundledNovelLive2dFactory`, model registry,
shared animation driver, scene intent and isolated replay engine. The title's
public **立绘试映 / Model theater** shortcut and gallery replay expose original
Mira Spine and official Hiyori Live2D without an ending unlock. Six actions
enter a short normal dialogue display so the choice menu does not obscure the
actor. Hiyori is expressly identified as the official sample, separate from
the original main cast, and the exact required attribution is a dialogue.

`scripts/prepare_live2d.ts` in the Lantern consumer validates the 18 referenced
files against pinned SHA-256 hashes in the existing local official SDK cache.
It stages them under ignored `.pocket-build/live2d/Hiyori`, scales only the two
textures to 512×512 and retains MOC geometry/UVs. It performs no download or
publication. Both Lantern's package build and the existing mini-app build
invoke this staging before the same buildGuest pipeline. The trusted catalog
and hash-named MOC are bundled through the explicit native-model asset folder;
model-relative texture lookup keys do not create phantom PAK images. See
`demo/js/apps/lantern/LIVE2D_SAMPLE.md` for the source/terms pins and local
sample scope. This acceptance grants no distribution clearance.

The final ordinary Demo QJBC is
`f4b9e519dc9af416734f9b136d294b9d8d3a6fa0727c33f8b6a2826e644b2e2a`
(986,801 bytes), PAK
`0dafa7fa07056c90b6966af9e43d7443487f0f72398bae8683c1d0be8fa411cc`
(27,006,192 bytes). Its macOS arm64 default-FFI integration passed in 45 seconds:
`demo/integration_test/novel_model_showcase_test.dart`, log
`/tmp/pocket-model-showcase-final-macos-stable.log`. It exercised the title
shortcut, Mira animation selection, both decoded Hiyori pages, mask/layer ops,
actual shared-UV triangle position changes (maximum common-vertex delta 2 px),
real host lifecycle pause/resume, release at the catalog, a fresh reentry and
release at replay exit. The OS-file main autosave remained equal, and Continue
restored `arrival_01`. This is the full Demo evidence, distinct from earlier
model-only fixtures. Its screenshot is
`sdk/.pocket-build/novel-model-showcase-20261107/Hiyori-display-macos.png`.

That full-app screenshot also exposed and then confirmed the repair of a
host renderer defect: fixed-size retained Canvas blocks had cut mesh masks
across separate painters. Complete compositing groups now stay in one painter;
mask geometry is no longer painted as white eye/face regions. Model-only
painter tests could not establish this whole-PocketView property. Performance
measurements and their limits are recorded in [performance](VISUAL_NOVEL_PERFORMANCE.md).

This final full-Demo artifact also passes the same test on iPhone 18 Pro /
iOS 27.2 arm64 Simulator (45 seconds, `/tmp/pocket-model-showcase-final-ios.log`),
with both motion deltas (5 / 2 px), real lifecycle resume, release and unchanged
main autosave. The iOS screenshot was visually inspected during the test; its
simulator temporary file was removed after teardown. The same final-Demo test also passes on Android API 35 arm64 emulator
(`emulator-5554`, Debug, 48 seconds,
`/tmp/pocket-model-showcase-final-android-pinned.log`). It exercises the same
real FFI model, decoded pages/masks, motion, lifecycle, release/reentry and
main-save isolation. Demo Android required the pinned-toolchain compatibility
repair recorded in [toolchain notes](TOOLCHAIN_NOTES.md). Earlier standalone
fixture results above retain their own hashes; no physical-device, Windows or
mobile shipping-performance acceptance is implied. Full Cubism compatibility,
sequence-frame actors, Windows execution and dynamic model posture preview in
the Editor remain open.
