# Windows Flutter host

Pocket's Windows desktop host uses the existing Flutter runner, the current Rust FFI library, and the same Dart runtime ABI used by the other Flutter targets. Flutter remains the renderer, input/lifecycle host, and native capability transport; guest UI and application behavior remain JavaScript-owned.

## Source-first reuse

The retained parent project was inspected outside `pocket_host/`:

- [`lib/core/ffi_bridge.dart`](../../../pocketjs_flutter_demo/lib/core/ffi_bridge.dart#L896) already has a Windows loader branch that opens `pocket_runtime.dll`. Its Android, Apple, and Windows loader candidates preserve the established `DynamicLibrary.open` boundary.
- [`docs/04_DEVELOPER_GUIDE_AND_VERIFICATION.md`](../../../pocketjs_flutter_demo/docs/04_DEVELOPER_GUIDE_AND_VERIFICATION.md#L7) documents the same native C-FFI boundary and the existing Android/iOS/macOS packaging behavior.
- [`docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md`](../../../pocketjs_flutter_demo/docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md#L14) describes the retained JS-to-Flutter draw command pipeline.
- No Windows runner or native Windows build files are present outside the excluded `pocket_host/` folder. The retained Windows loader therefore supplies the library-loading pattern, but not an implementation to copy.

The current SDK already builds the Rust `pocket_flutter` crate as a `cdylib`; [`scripts/build_native.sh`](../scripts/build_native.sh) packages Android and Apple libraries but has no Windows target. Windows adapts the retained loader pattern to `pocket_flutter.dll`, builds the same crate for `x86_64-pc-windows-msvc`, and lets Flutter's standard FFI-plugin bundle list place that DLL beside the runner. The SDK does not add a second runtime or a method-channel wrapper.

Flutter 3.47.9 generated the Windows runner in a temporary project with the `pocket_host` project name. Only that generated `windows/` directory was migrated into `demo/`; other Demo platform folders were not regenerated.

## Build and bundle

Prerequisites are Flutter 3.47.9 from `.fvmrc`, Rust with the `x86_64-pc-windows-msvc` target, MSVC C++ build tools/Windows SDK, Python for pinned PocketJS preparation, and the repository's normal SDK dependencies.

From PowerShell at the repository root:

```powershell
./sdk/scripts/build_native_windows.ps1
Set-Location demo
flutter pub get --enforce-lockfile
flutter build windows --release --no-pub
```

The script builds the pinned Rust runtime with the static MSVC CRT and installs its output at `sdk/packages/pocket_flutter/windows/bin/pocket_flutter.dll`. That generated binary is ignored and is not source. `pocket_flutter/windows/CMakeLists.txt` checks for this exact file during Windows configuration and fails with a build instruction if it is absent. It registers the DLL as an FFI plugin bundled library; Flutter's runner install step then copies it beside `pocket_host.exe`. `FfiPocketRuntime` loads `pocket_flutter.dll` through `dart:ffi`.

The Windows job in `.github/workflows/toolchain.yml` builds the runtime DLL, verifies its dependencies do not include the Visual C++ runtime DLLs, builds the actual Demo Windows runner with the pinned Flutter SDK, and compares the bundled DLL's SHA-256 with the built SDK DLL. It uploads the Windows DLL and acceptance report as a workflow artifact. CI compilation and bundling do not prove that the GUI app starts or renders on a Windows device; that remains a Windows execution acceptance item.

## Windows audio backend

`pocket_audio` depends on `just_audio_windows` **0.2.3** alongside `just_audio`. The official package identifies itself as the Windows implementation backed by WinRT MediaPlayer and lists file/asset/URL sources, playback controls, position, playlists, looping, and gapless playback among its supported features. Its feature table also identifies unsupported or untested capabilities; callers should follow those platform-specific limits instead of inferring full parity. See the [official `just_audio_windows` package page](https://pub.dev/packages/just_audio_windows) and the [official `just_audio` Windows configuration](https://pub.dev/packages/just_audio#platform-specific-configuration).

The dependency is registered through Flutter's federated plugin metadata. Pocket does not manually register the backend and does not add a Dart playback state machine; JS owns cue and playback policy, and the plugin provides the native playback boundary.

## Acceptance status

On macOS, the generated runner and build scripts can be inspected, but the Windows MSVC DLL and desktop app cannot be natively built or launched. Windows acceptance is pending the `windows-2022` job and, for runtime behavior, a Windows GUI execution. A source-only CMake check or a fake DLL is not a substitute for that acceptance.
