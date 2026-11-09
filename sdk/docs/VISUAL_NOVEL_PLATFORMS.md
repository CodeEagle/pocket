# Visual novel platform acceptance

The requested targets are iOS, Android, macOS and Windows desktop. A shared story, registry,
save schema and pinned buildGuest/QJBC pipeline serve every native consumer.
This does not imply cloud save synchronization: each OS currently persists its
own application data. Editor source remains the same canonical JSON on every
target.

Typed player input has separate acceptance on the same QJBC: macOS, iPhone 18
Pro / iOS 27.2 simulator, and Android API 35 arm64 emulator all pass the real
Flutter TextInputClient → PocketView → JS story path, including Chinese/emoji
composition, explicit submission, invalid/valid numbers and Boolean consent.
These tests drive Flutter's test text client, not physical IME candidate windows.
See [input artifact hashes and logs](VISUAL_NOVEL_INPUT_ACCEPTANCE.md).

The complete game acceptance below uses the original Mira Spine rig. Live2D
has separate real-model acceptance: the official Hiyori fixture passes macOS,
iOS and Android application default-FFI integration, including
model pixels, masks, deformation and release. Its textures are reduced to 512,
and the strengthened fixture includes physics/pose and checks their real outputs, pause/resume and release. Windows execution and unrestricted
Cubism compatibility are not inferred from these results. See
[Live2D acceptance](VISUAL_NOVEL_LIVE2D.md).

## Source-first integration

The retained parent `pocketjs_flutter_demo/android`, `ios`, `macos`,
`lib/core/ffi_bridge.dart`, and `lib/ui/mini_app_host_page.dart` were inspected,
excluding `pocket_host/`. Reuse the current SDK's migrated native build,
Flutter surface, input mapping, lifecycle events and package admission. There
is no retained Windows or Linux Flutter runner to migrate. Neither a second
story controller in Dart nor platform-specific game scripts are necessary.

`@pocket/vn/view` derives the stage from the full available viewport and safe
insets through `createDisplayGeometry`, `pageInsets` and
`createNovelViewportLayout` (`src/viewport.ts`). The 360×640 values are fallback
geometry and the art-scale reference, not a desktop stage-size cap. Dialogue,
menus and player controls have their own bounded widths within that stage.
There is no second resize poller, layout engine or native orientation controller.
Current per-artifact wide/short/narrow and actual-window evidence, with its
platform limits, is recorded in [responsive layout](VISUAL_NOVEL_RESPONSIVE.md).
It does not establish arbitrary landscape authoring or physical-device rotation.

## Save-preview increment, 2026-11-08

The real compiled Lantern game passes the same six save-thumbnail checkpoints
on macOS Profile, Android API 35 ARM64 emulator Profile, and iPhone 18 Pro
simulator Debug: capture and rendered pixels, narrow/restore without replacing
the texture or decoded image, overwrite cleanup, host recreation and load,
injected lifecycle, and preservation of the normal user store.
This is host recreation within one process and a test-driven lifecycle, not an
OS process restart or physical-device background/rotation test. See
[save-thumbnail evidence](VISUAL_NOVEL_SLOT_THUMBNAILS.md) for exact artifacts.
The older platform matrix below remains evidence for its own game scenarios.

## Observed results, 2026-11-07

| Target | Observed evidence | Remaining acceptance |
| --- | --- | --- |
| Android arm64 | API 35 ARM64 emulator passes WAV transport and the strengthened complete SystemHost game test: launch, varied textured Spine pixels, deformation, pointer progression, manual save/load, background animation suspension, animation and music recovery | Physical-device installation, release packaging and performance remain pending |
| iOS arm64 simulator | iPhone 18 Pro, iOS 27.2, passes WAV transport and the strengthened full SystemHost game test: launch, varied textured Spine pixels, deformation, manual save/load, background animation suspension, animation and music recovery | Physical iPhone and device archive; new model integrations require their own target acceptance |
| macOS arm64 | Full real Flutter game test passes: keyboard start/reveal/menu/return after Save, textured Spine pixels/deformation, manual save/load, background animation suspension, animation and music recovery | Windows and mobile acceptance cannot be inferred from macOS; release packaging and older macOS hardware remain pending |
| Windows x64 | Flutter 3.47.9 runner, MSVC DLL build/bundle/loader, Windows audio backend and CI build/hash checks implemented; local Dart/CMake/YAML checks pass | Execute Windows CI build and actual Windows GUI/game/audio acceptance; macOS cannot substitute for these |

The Android phone `MAA_AN00` was connected, but installation returned
`INSTALL_FAILED_ABORTED: User rejected permissions`. The APK built; the test
never started on that phone. This is not a device pass and is not bypassed by
changing installer security settings.

The initial iOS attempt used the shell's Flutter 3.35.7 and failed with missing
Swift Package product `flutterframework_FlutterFramework.FlutterFramework`.
The repository `.fvmrc` already pins 3.47.9. Repeating with that installed SDK
built and passed without hand-editing generated Swift packages. Use the pin
for subsequent platform builds and dependency resolution.

## Reusable acceptance

`demo/integration_test/novel_platform_test.dart` boots the actual Showcase
SystemHost and launches the shipped game QJBC by pointer input. SystemHost
provides the existing application-scoped storage transport. It checks:

- decoded model texture availability and actual nontransparent, varied mesh
  pixels produced by `PocketCanvasPainter`;
- official Spine deformation over time;
- pointer-driven story progression and manual save/load through the JS UI;
- OS lifecycle pause stopping the ticker/model and resume restoring animation.

Its Dart analysis passes. The strengthened version passes on macOS, iOS and
Android simulators, including the added real music-recovery assertion.
Platform results are recorded separately above; the test's existence is not
itself an acceptance result. The pause phase waits for real wall time without
requesting a frame: a paused real engine deliberately withholds vsync, so
awaiting `tester.pump()` there stalls the test instead of testing suspension.

An earlier macOS run stalled after Flutter reported `Failed to foreground
app; open returned 1`; it was stopped and was not counted as a pass. The
subsequent bounded run executed the real game despite the same foreground
warning: model pixels, deformation and initial keyboard actions worked. It
then exposed a reproducible focus-restoration failure after Save. The final
rerun after the focus fix passes the complete test, including music recovery
(`/tmp/pocket-novel-macos-complete-final.log`, `All tests passed`). Desktop key tests
hold key-down through a real frame before key-up: the Guest samples held
buttons each frame, so a synthetic down/up pair within one frame cannot
prove a physical-key action.

The macOS build now sets `MACOSX_DEPLOYMENT_TARGET=12.0` as well as Rust link
flags. This makes cc-rs-built QuickJS/ring objects honor the same deployment
floor instead of recording the installed macOS SDK's version. It does not prove
execution on macOS 12 hardware.

The game requires `platform.storage.get/set`. A standalone `PocketApp` does
not provide SystemHost's platform request transport; merely adding the
Flutter platform UI/haptics plugin does not supply storage. The platform test
therefore exercises the production SystemHost launch path instead of declaring
unimplemented capabilities. See [Windows packaging](WINDOWS_FLUTTER.md) for the
desktop runner and pending Windows acceptance.

`demo/js/tests/novel_viewport_native.test.ts` executes the same compiled QJBC at
360×640, 390×844 and 1280×720. All 24 assertions pass: centered controls, real
pointer start, changed safe-area geometry, menu opening and continued reading.
This proves native JS execution and input/layout behavior, not an iOS/Android
GPU or operating-system test.

Run with the repository-pinned Flutter, for example:

```sh
fvm flutter test integration_test/novel_audio_test.dart -d <device>
fvm flutter test integration_test/novel_platform_test.dart -d <device>
```

Both commands run from `demo/`. Prepare the current native library with
`sdk/scripts/build_native.sh macos`, `ios-sim`/`ios`, or `android` first. A
successful build alone does not establish gameplay, model rendering, audio
output, background behavior or production performance.

The strengthened game test also captures the original audio provider through
a native-policy injection and checks actual `playing` facts. Its first Android
run passed game interaction, model pixels and lifecycle animation recovery,
then failed because music remained paused after foregrounding. This is a
separate regression from the already-passing standalone WAV transport test.
The fix keeps the playback intent in JS and forwards only the native provider
activation fact. Post-fix reruns pass on macOS, iOS and Android, including this
assertion. Evidence logs are `/tmp/pocket-novel-macos-complete-final.log`,
`/tmp/pocket-novel-ios-music-final.log` and
`/tmp/pocket-novel-android-music-final.log`; each ends with `All tests passed`.

## Final dialogue-voice combination acceptance

The final `novel_platform_test.dart` passes on macOS, iPhone 18 Pro / iOS 27.2
simulator, and Android API 35 ARM64 emulator. It now checks real dialogue
playback, journal pause/resume, replay from the start, native completion
advancing the JS auto reader, then save/load and the existing model/music
background recovery. Native completion is not inferred from a play request or
from a configured duration. The measured duration only bounds the test wait;
the game advances through the real completion event.

Logs: `/tmp/pocket-voice-game-macos-final.log`,
`/tmp/pocket-voice-game-ios-final.log`,
`/tmp/pocket-voice-game-android-final.log` (all 1 pass, 0 fail). Same QJBC:
`f68194c067936bd1240ac0cd93d61b644620e9374fee8892b7ca05a0b467cb9f`.
The Android recovery check observes individual deformed frames instead of a
single endpoint, since a looping motion can revisit rounded vertex positions.
Windows and physical-device acceptance remain pending as recorded above.

## Text/stage editor and dynamics revision, 2026-11-07

The game containing authored character scale, rotation and layer order passes
the complete Flutter game test on macOS, iOS arm64 Simulator and Android API 35
arm64 emulator. The same accepted QJBC SHA-256 is
`fddee0e835c246e501397e91ebaad3440c63c56f02777a4c88d24064912593b3`;
PAK SHA-256 is
`4d4a03c48dc2d94fedee95b0e492f20d0720619cb9786355241c95bb13303920`.
Logs: `/tmp/pocket-vn-platform-final-macos.log`,
`/tmp/pocket-vn-platform-final-ios-recheck.log` and
`/tmp/pocket-vn-platform-final-android.log` (each 1 pass).
The same bytecode also passes all four native game/input/viewport/voice-locale
tests, including all three endings and character geometry/draw order
(`/tmp/pocket-vn-platform-final-native.log`, 4 tests, 24 assertions).

An initial concurrent iOS run failed the resumed ticker assertion after
successfully exercising model pixels, voice completion and save/load. A serial
rerun passed with `lifecycle=resumed`, `ticker=true`, `deformed=true`.
The session awaits native plugin reactivation before publishing
`controller.appActive`; the test now observes that actual boundary with a
10-second wall-clock limit. A subsequent diagnostic run proved actual
deformation with `ticker=false`: the demand-driven scheduler intentionally
parks the ticker between positive native deadlines. The test therefore
requires at least three distinct resumed model frames plus music playback,
rather than a continuously active internal ticker. It still requires the
paused ticker and model to remain stopped. No production lifecycle logic was
changed to satisfy this invalid continuous-ticker assumption.
The strengthened iOS rerun passes with `activationMs=190`, `ticker=false`,
`wake=true` and `deformedFrames=3`
(`/tmp/pocket-vn-platform-final-ios-scheduled.log`, 1 pass). This directly
demonstrates deadline-based animation recovery without keeping vsync resident.
These lifecycle checks invoke the ordinary Flutter binding callbacks inside
the real application test; they do not prove a physical OS app-switch or
release-build behavior.

Text authoring and stage authoring each have editor → canonical JSON → pinned
Guest build → actual native input/frame acceptance. The separate default-FFI
Live2D Hiyori fixture now includes Physics3/Pose3 and passes macOS, iOS Simulator
and Android emulator; see [dynamics acceptance](VISUAL_NOVEL_LIVE2D.md).
Windows runtime, physical mobile devices and compact landscape authoring
remain pending.

The final source rebuild after strict Live2D type fixes and solver release-cache
cleanup is 630,055 bytes, QJBC SHA-256
`e7b4be7a3d747a66cb14e4c5f022384bf9979c296dc6d84e8df4c55eaeb18596`.
Its PAK is unchanged. It passes the same four native acceptance tests
(`/tmp/pocket-vn-source-final-native.log`, 4 pass, 24 assertions). The platform
game results above retain their actual tested artifact identity; they are not
silently relabeled as runs of this subsequent bytecode.

## Variable restart and grouped audio acceptance

The subsequent source build adds variable lifetimes, same-engine new game and
grouped audio settings. Its QJBC SHA-256 is
`eff53069db9b967f3d862820bc7caa253f1745bfc2a0651084689d481dedd077`;
PAK SHA-256 is
`16574200309ffbd5f40858ae55a34f7e27a6548a30bd07c6d21b66b15b1201fb`.
The same pinned QuickJS ABI is retained. Five native tests passed, including
all endings, input, voice/locale, audio settings persistence, and new-game
variable reset/read-meta retention/music stop and replay
(`/tmp/pocket-f04-audio-native.log`).

The identical artifact passed `novel_audio_mix_test.dart` on macOS arm64,
iPhone 18 Pro iOS 27.2 simulator and Android API 35 arm64 emulator. Each run
used actual guest pointer settings, then observed gain `0.75`, continuously
advancing playback position and one active native player through a read-only
PocketAudioPlugin snapshot. The observer did not set the volume itself.
Logs, positions and the build identity are recorded in
[grouped audio acceptance](VISUAL_NOVEL_AUDIO_MIX.md). Windows and physical
device audio remain unverified.
