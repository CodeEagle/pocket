# Video showcase resource validation

This is the initial resource/acceptance matrix for the Showcase video clips.
The clips are local test material, not downloaded media:

| Logical asset | Source of truth | Format facts | Runtime path |
| --- | --- | --- | --- |
| `assets/videos/clip-a.mp4` | `demo/js/assets/videos/clip-a.mp4` | H.264 Constrained Baseline, 320×180, 30fps, 3.0s, yuv420p | Flutter `rootBundle` or a verified package loose asset |
| `assets/videos/clip-b.mp4` | `demo/js/assets/videos/clip-b.mp4` | H.264 Constrained Baseline, 320×180, 30fps, 3.0s, yuv420p | Flutter `rootBundle` or a verified package loose asset |

The moving color bands and block-letter A/B marks make the two clips easy to
distinguish in a recording without relying on a downloaded or copyrighted
source. `demo/assets/videos/` is generated output; it is not a second hand-
maintained copy.

## Resource pipeline

`buildGuest`'s existing `copyAssetsTo` destination now also receives the
project's ordinary `assets/` tree byte-for-byte. This keeps one destination and
one source-of-truth rather than adding a video-specific copy path. It
deliberately does not feed those files to the image baker or `pak.json`: an MP4
remains an MP4, not an image/PAK blob.

The Showcase build uses the same destination for generated runtime artifacts
and project assets:

```sh
cd demo/js
bun run build:system
```

That command leaves the canonical Flutter files under `demo/assets/`, and
`demo/pubspec.yaml` declares `assets/videos/` for `rootBundle`. The Editor and
OTA packaging path uses the existing signed-package `asset-dir`/`loose-assets`
contract; a package source maps the logical name to its admitted file through
`PocketPackageSource.assetPaths` and `pathForAsset`.

## Acceptance matrix

| Check | Command / evidence | Expected result | Status |
| --- | --- | --- | --- |
| Source clips are real, short H.264 files | `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,duration,nb_frames demo/js/assets/videos/clip-{a,b}.mp4` | H.264, baseline, 320×180, yuv420p, 30fps, 3s, 90 frames | PASS |
| Build copies raw files | `bun test sdk/scripts/tests/build_guest.test.ts` | Binary asset bytes are unchanged and no video key is added to PAK | PASS (11/11) |
| Flutter built-in asset | `bun run build:system`; `flutter test integration_test/video_playback_test.dart -d 90B4AA40-E9B8-46B5-B70F-144ADEF9CB32 --no-pub --reporter expanded` | `demo/assets/videos/clip-{a,b}.mp4` is generated and `video_player_avfoundation` initializes both assets | PASS (iOS simulator; build/integration logs: `/tmp/pocket-video-final-build.log`, `/tmp/pocket-video-ios-final.log`) |
| OTA package loose asset | Package with `package_update.ts ... --asset-dir demo/js/assets` | Signed manifest lists each asset; staged `loose-assets/videos/clip-{a,b}.mp4` hashes match source | PENDING package run |
| `PocketPackageSource` path | Prepare/activate the signed package, inspect `assetPaths` and `pathForAsset('assets/videos/clip-a.mp4')` | Resolved regular file is readable without putting MP4 in PAK | PENDING host integration |
| Browser Editor preview | `bun test sdk/editor/test/preview_video_browser.test.ts` and actual 8792 Showcase | Browser decodes local MP4 into Canvas at the native video DrawOp; clock and ROI pixels change, pause and route release work | PASS (Playwright Chromium; see `EDITOR_VIDEO_PREVIEW.md`) |
| Native playback | iOS simulator integration above | `VideoPlayerController.asset` initializes, position advances above zero, A/B asset swap, explicit pause, remove/rebuild, and route release/return keep paused | PASS (iOS `video_player_avfoundation`; Android/macOS and package-file playback remain untested) |

### Extended MiniApp regression gate

The first real iOS decoder run passed the playback/resource checks above.
The suite has since been extended to launch a real Profile MiniApp twice:
first while playing (pause/release under coverage, resume on return), then
while explicitly paused (remain paused after decoder recreation). This
extended gate passed on the iPhone 18 Pro iOS simulator on 2026-11-04
(`+1 All tests passed`, `/tmp/pocket-video-ios-final.log`). It also includes
the release/re-register idle-frame regression discovered during verification.
A retired native controller
can retain its last `isPlaying` value after disposal, so the test inspects the
current mounted player on return rather than a stale controller reference.

Browser playback is now independently verified in `EDITOR_VIDEO_PREVIEW.md`.
It uses a real browser decoder and does not replace native Flutter video texture
acceptance; native playback and resource-path checks remain separate gates.


### Argon review remediation gate (2026-11-04)

The preceding iOS result is historical: its retry check accepted `playing` and
therefore did not prove that an initially paused retry stayed paused. This gate
strengthens the actual installed `video_player_avfoundation` checks rather than
using a guest label as a substitute for playback state.

```sh
cd demo
flutter test integration_test/video_playback_test.dart \
  -d 90B4AA40-E9B8-46B5-B70F-144ADEF9CB32 --no-pub --reporter expanded
```

Latest run: **PASS, +1 All tests passed**, log
`/tmp/pocket-video-remediation-ios-integration-rerun.log`. It verifies real
position advancement, explicit pause, same-id source replacement, remove/rebuild,
missing-asset recovery remaining paused after native work settles, explicit
play/pause after retry, route cleanup, two real MiniApp cover/result cycles, and
an initially culled scroll clip remaining paused on first entry. A real downward
scroll then removes that playing clip's mounted native player, and scrolling back
recreates a playing controller from retained JS intent before an explicit pause.

The first strengthened run failed because the shared test reveal helper only
scrolls forward and could not reveal the tab above the viewport; the test now
uses bounded real downward pointer gestures for that step. No playback assertion
was weakened. That failed run remains at
`/tmp/pocket-video-remediation-ios-integration.log`.

Supporting regressions: Flutter video **30/30**, other affected Flutter
input/first-frame/idle/viewport/compositor **52/52**, independent review
reproductions **4/4** (including **129/129** sequential decoder creations), SDK
JS/native probe tests **15/15**, and Demo JS/native tests **4/4**. See
`VIDEO_DUO_REVIEW_ARGON_HIGH.md` for commands and evidence boundaries. The
simulator does not establish Android decoder behavior, physical high-refresh
performance, battery cost, or Duo hinge-motion behavior.


The final three host regressions additionally cover structured resource keys for
NUL-bearing ids and a first pending initialize returning after retired-history
eviction. The latter explicitly rejects even a transient `ready`/`playing`
event before re-registration. Final suite and strengthened single-test logs:
`/tmp/pocket-video-remediation-final-video-widget.log` and
`/tmp/pocket-video-remediation-stale-final.log`.
