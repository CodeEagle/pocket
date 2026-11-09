# Visual novel video overlay (S10)

This document records the S10 source comparison, core and Editor authoring,
the JS renderer adapter, and platform acceptance. The VN video overlay is
connected to the retained native video surface; a macOS guest build passed
the full player route. Mobile platform runs remain pending acceptance.

## Source-first comparison

The retained parent project was inspected with `pocket_host/` excluded:

- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` keeps a
  `hdrVideoPlaying` boolean and toggles it from `toggleVideoPlay`; this is a
  demo intent switch.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js`
  forwards `videoPlaying` and `videoFps` to an `AuxiliarySurface`.
- `pocketjs_flutter_demo/native/pocket_runtime_multi.c` advances a synthetic
  frame index in `pocket_video_step_decode`, and
  `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` paints that
  auxiliary video surface.

The retained implementation demonstrates a play/pause toggle and video-like
surface, but it has no stable story cue, real decoder position/duration,
seek-range validation, non-loop completion fact, save state, or VN rollback
state. Its synthetic frame counter is not reused as playback evidence.

The current SDK already has a real video boundary in
`sdk/packages/pocket_ui/src/media.ts`: `MediaController.inspect()` returns one
native position/duration snapshot, and `seek()` requires a prior initialized
duration and rejects positions beyond it. The protocol is documented in
[`VIDEO_MEDIA_FACTS.md`](./VIDEO_MEDIA_FACTS.md). S10 reuses that existing
video surface/controller and native `VideoPlayerController`; it does not add
another renderer or decoder. The consumer resolves a stable story `cue` to
the registered/bundled asset. Locale catalogs resolve `assets.videos` cue
aliases through the same registry boundary as audio. Playback is always muted
by the adapter, so the mute policy is not duplicated in story or save state.

The existing Pocket VN stage only contained background, characters, and scene
transition in `sdk/packages/pocket_vn/src/types.ts`. The story instruction
union had audio commands but no video commands. This was the evidenced S10
gap.

## Core contract

`sdk/packages/pocket_vn/src/video-schema.ts` defines a single VN overlay state
and pure validators; `types.ts` and `engine.ts` add the command union and one
stage-owned overlay:

- `play` names a stable `cue` and optional `loop` (default `false`).
- `pause`, `close`, and `seek` operate on that one overlay. `seek` carries an
  integer millisecond position.
- `positionMs` and a known `durationMs` are non-negative safe integers;
  `durationMs` can be null until native initialization reports it.
- Seeking requires a known duration and a position from zero through that
  duration. Out-of-range seeks are rejected instead of silently clamped.
- The saved `status` is only `playing`, `paused`, or `ended`. `playing` and
  `paused` represent VN/player intent. Only a real native non-loop completion
  fact may set `ended`; temporary native pause, visibility, and lifecycle facts
  do not replace the intent. A looping overlay cannot be ended.
- No JS clock infers elapsed media position. Position, duration, and completion
  must be reported by the actual native player.

The schema helpers preserve unrelated instruction author metadata while
rejecting known inapplicable fields, asset paths in place of cues, a mutable
`muted` field, duplicate playback/fact fields, malformed time values, and
non-loop completion inconsistencies.

`EngineSnapshot.videoToken` is a transient per-engine generation identity,
not save data. Each play, pause, or seek command renews it; close clears it.
The engine emits transient `videoCue` command events to the existing video
adapter. `reportVideo()` accepts native facts only for the current token.
Actual playing/paused facts can refresh position/duration without changing
intent; only a real non-loop completion fact sets canonical status to `ended`.
Facts from an older generation are ignored.

The instructions are non-blocking. Auto and skip can pass video commands; no
wait-for-completion instruction is added here. An authored seek requires a
known native duration and fails if the requested position is outside it; it
does not clamp or synthesize position progress.

An absent video field in an older V1 save restores as a closed overlay. The
existing V1/V2 save and rollback paths carry the same stage-owned overlay;
`newGame()` closes and resets it, and locale rebasing preserves the stage. No
second video save map is used.

## Editor authoring boundary

The retained parent project has no VN video cue authoring form or bundled
video registry. Its `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`
toggle is demo-only, while `mini_apps/syslib/pocket_syslib_flutter_ui.js` and
`native/pocket_runtime_multi.c` expose the synthetic surface/frame counter
described above. The adapted SDK keeps authoring in the existing Editor
`story.json` and `novel.assets.json` flow; it does not add a second story
interpreter or project asset copier.

`novel.assets.json` accepts an optional `videos` map from stable cue IDs to
paths relative to `projectRoot/assets`. For example, `video/loop.mp4` is
copied byte-for-byte by `build_guest.ts` to `assets/video/loop.mp4`; there is
no required `assets/videos` directory. The Editor validates cue IDs, safe
relative segments, the local `.mp4` extension, the real `assets` directory,
regular files, symlinks, missing files, and project containment through its
existing registered-asset checks. Other formats are not accepted in this
stage. `storyAssetDiagnostics` verifies `video play` cue references against
that same registry. `video-schema.ts` remains the shared instruction-shape
validator, including action-specific fields and integer seek positions. The
structured instruction form exposes play/pause/close/seek, removes known
fields from the previous action when changing branches, and keeps unrelated
author metadata. The text authoring pane shows the video cue count and the
shared core parser accepts `video { ... }` as a lossless opcode.

The structured instruction editor and text authoring pane both use the core
`video` opcode. Text formatting keeps the complete instruction payload,
including unrelated author metadata. The Editor form does not add a second
preview player; the game runtime renders this same instruction and asset
registry through the `NovelView` integration below.

The optional `novel.assets.json` skin schema has one reusable `skin.frame`
image with positive integer `width`/`height` and a non-negative integer
`inset` smaller than half the shorter dimension. Its image path uses the
existing project-relative PNG/SVG validation and image-literal collection
used by `build_guest.ts`. Unknown skin fields are rejected so Editor saves
cannot silently strip a future frame policy; projects without a skin remain
valid. The Lantern source master is kept at `art/masters/ui/harbor-frame.png`;
`scripts/prepare_textures.ts --only=art/ui/harbor-frame.png` bakes the 512px
runtime copy admitted by the existing PAK limit. Its runtime skin metadata is
512×512 with a 122px source inset (the original 300px inset scales to this
copy).

The Editor Chromium UI, registry validation, Guest bundle, and VN core were
exercised with the following targeted tests:

```sh
cd sdk
./.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --timeout 180000 editor/test/novel_video_browser.test.ts editor/test/novel_service.test.ts packages/pocket_vn/test/authoring.test.ts
```

The Chromium regression creates, edits, and removes video cues, switches
instruction branches, tests undo/redo, saves and reopens the project, rejects decimal seek positions,
invalid skin insets/unknown skin fields, and verifies that editing the video
registry preserves the shared skin. The pinned `buildGuest` invocation
produced a 229,163-byte QJBC artifact, baked the 512×512 skin image into its
PAK, and copied `video/loop.mp4` byte-for-byte to the host `assets/video/`
tree. The actual VN core snapshot advanced through the video cue to the
ending. This Editor-specific fixture validates authoring and bundling; native
playback evidence is recorded separately below.

## Validation

Run the schema/core regression suites with the pinned Bun binary:

```sh
cd sdk
./.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test packages/pocket_vn/test/video-schema.test.ts packages/pocket_vn/test/video.test.ts
```

The tests cover action-specific validation, canonical overlay state, safe
integer time bounds, loop/completion invariants, native-fact generation
rejection, pause-intent preservation, seek bounds, V1/V2 save/load, rollback,
locale rebase, new-game reset, and authoring text round-trip. These tests cover
the core contract; the actual rendered playback result is recorded below.

## Lantern story reel source, 2026-11-07

The optional archive-room branch uses an original game-art reel rather than
the Showcase's diagnostic color-band clips. Its source is
`demo/js/apps/lantern/assets/videos/archive-route-reel.mp4`, derived from the
already retained original `art/archive.png`. `ASSETS.md` records the source
artwork provenance and reproducible FFmpeg command; it is an authored game
pan/zoom, not live-action footage or a replacement decoder.

Independent `ffprobe` inspection found one silent H.264 Constrained Baseline
stream, 512×512, yuv420p, 25 fps, 75 frames and 3.000 seconds. Decoding frames
0, 37 and 74 produced three different MD5 values
(`/tmp/pocket-s10-reel-frame-facts.log`). The MP4 SHA-256 is
`9224db6d0c66f62cde09ce94a7be5e5824803e08bd53613554957fea9cab4cb8`.
These facts establish the source media. The compiled-guest/macOS playback
acceptance for this clip is recorded below; the final artifact and other
platforms still require their own acceptance.

The registry path remains relative to the consumer's `assets/` tree. The
existing `buildGuest` ordinary-asset copy places it under the selected host
output directory without putting MP4 bytes in the PAK. Lantern's built-in
consumer resolves that path to `assets/apps/lantern/videos/...`, declared in
`demo/pubspec.yaml`; the reusable SDK does not import that Demo prefix.

A source-data audit compared the previous accepted build's literal
`story_default` in Lantern's retained `.pocket-build/app.js` against the new
canonical `story.json` without executing that bundle. All 52 existing labels
and their 207 instruction positions were unchanged. The sole permitted
existing-instruction edit adds `watch_archive_reel` to the `archive_read`
choice; the reel itself occupies one new label. This protects old locations
and stable dialogue/input IDs, but is separate from runtime save/restore
acceptance. The audit's extracted baseline is
`/tmp/pocket-s10-previous-story.json`.

## JS/native renderer integration and platform acceptance, 2026-11-07

`@pocket/vn/video` now exports `createNovelVideoAdapter`. It reuses one
`@pocket/ui` `MediaController` and the retained `Video` component; the adapter
owns no decoder, media clock, or second saved-state map. Its native surface ID
is stable for the adapter lifetime, while the engine's current `videoToken`
correlates each request and native fact. Restore waits for a matching `ready`
fact, then seeks using native duration/position. Save capture waits for
same-token restore/seek work, inspects once, reports the real facts to the
captured engine, and returns that engine's save. A changed engine or token
rejects stale capture/results.

`NovelView` accepts the adapter and optional cue-to-bundled-asset map. Draw
order is background, video, characters, then dialogue/choice/input and player
controls, keeping the movie behind the interactive skin. Pause, resume, seek,
restart, and close controls call `NovelEngine.controlVideo`; temporary menu or
lifecycle gating does not rewrite the saved playback intent. The
`video.seekStart` action seeks to zero while preserving pause; the ended-state
replay action seeks to zero and resumes.

The retained parent behavior and schema adaptation are documented above.
The final macOS integration run passed in 1m48s against QJBC
`cb698f14eac2239213c3670565aa64e7242557a973194e5dbb047780405c1042`
(818,802 bytes) and PAK
`3ead2ebe1661858f7b790e0d9ed932d907ea0246da6bce7e2d673fac8e6ca1a2`
(24,793,712 bytes). `/tmp/pocket-novel-spatial-flutter-final-ending.log`
records the actual three-second decoder, mute, pause/seek, quick-save disk
position, load/restore, rollback release, natural completion without plot
advance, ended-state UI, close, image-based 7-1-4 puzzle, truth ending OS
autosave and isolated gallery replay without changing the main autosave.
The decoded dial capture is retained at
`sdk/.pocket-build/novel-ui-camera-weather-20261107/dial-final.png`.

The first final-build attempt stopped at `truth_01` because its test helper
waited for a rewritten pre-ending sentence while the assertion expected
`truth_letter`. Reading the actual OS file established successful persistence
at that earlier dialogue. The helper now advances to the actual ending text;
the complete run above passes. Earlier over-quota codec failures are separate
historical results, documented in `VISUAL_NOVEL_SAVE_FORMAT.md`.

iOS, Android, Windows and physical-device video acceptance for this final
artifact remains pending; macOS results are not extrapolated to those targets.

## Integration-test storage isolation

`demo/integration_test/novel_video_test.dart` uses the shared
`IsolatedNovelSupportDirectory` helper from `novel_performance_support.dart`.
It records the normal AppSupport path, redirects only the real
`path_provider` AppSupport call to a newly created `Directory.systemTemp`
directory, and asserts the two paths differ. The test reads its actual quick
save, auto-save, and restored video position from the platform store in that
temporary directory. Teardown restores the original path provider and removes
the temporary directory. `novel_replay_music_test.dart` applies the same
isolation and waits for the real auto-save file there before checking playback;
it also checks the public audio channel count reaches zero after the host is
unmounted. Neither test uses the normal AppSupport store.

On 2026-11-08, the isolated video integration passed on macOS against QJBC
`9f43216420f00233df74bbf8bbb45ab75d6abc26aa19e679209d98091102bf54` and PAK
`6e5c872a953ada2bea145dca7fcabb4dc716522fbb6784fa1adaa32826fe7128`.
`/tmp/pocket-isolated-video-macos.log` records the actual 3-second asset
decoder, seek, quick-save/load position, rollback, close, and gallery replay
isolation. The neighboring real-audio tests passed 2/2 and the replay-music
test passed 1/1 against the same artifact hashes; their logs are
`/tmp/pocket-isolated-audio-macos.log` and
`/tmp/pocket-isolated-replay-music-macos.log`. These results cover macOS only;
they do not establish iOS, Android, Windows, or physical-device playback.

Run the targets sequentially so they do not contend over the shared Demo
build directory:

```sh
cd demo
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test integration_test/novel_video_test.dart -d macos
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test integration_test/novel_replay_music_test.dart -d macos
```

```sh
cd sdk
./.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test packages/pocket_vn/test
node_modules/typescript/bin/tsc --noEmit --project .pocket-build/tsconfig-vn-video.json
```

The final pinned Bun VN suite passed 141 tests with 1,158 assertions across 29 files. The
strict TypeScript check covers engine/types/adapter; the Solid `view.tsx` is
compiled by the pinned `buildGuest` pipeline. A separate strict JSX check now
clears the VN view/audio files but still reports existing `pocket_ui` errors;
the whole SDK strict check is not claimed as passing.
