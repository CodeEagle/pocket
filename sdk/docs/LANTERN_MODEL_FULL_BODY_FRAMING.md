# Lantern full-body framing correction candidate

Status: rendered framing checked in two macOS Profile test views (2026-11-08);
physical-device acceptance remains pending.

## Evidence and change

The strict v4 Android Profile model case passed in the ARM64 emulator, but its
actual full-body PNG shows the feet extending behind the footer. The image is
preserved in `sdk/.pocket-build/lantern-v4-android-profile-20261108/` with hashes
in `emulator-model-acceptance.json`. Passing the native model test therefore
does not establish the full-body composition gate.

The three existing full-body Hiyori scenes (`model_showcase_hiyori_idle_0`,
`model_showcase_hiyori_idle_1`, `model_showcase_hiyori_tap_body`) move their
authored actor Y from 200 to 130. Scale remains 1.5; the three close-ups, all
mainline instructions, labels, addresses, motion references and textures are
unchanged. This moves the actor upward without reducing face detail or adding
a renderer-specific placement override. The existing animation and replay
paths remain the source of state.

Story version stays 4 because there is no instruction-address/schema change.
Previously saved v4 stage snapshots retain their saved framing until the next
scene instruction; no save rewrite is introduced. Existing direct v1/v2/v3
maps and their six-label framing exception remain in place.

## Source-first reuse

The retained parent `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
and `mini_apps/app_ui_showcase/main.js` contain the earlier layout/rendering
behavior, but no corresponding VN/Cubism actor authoring. This correction
reuses `sdk/packages/pocket_vn/src/viewport.ts::novelCharacterBounds` and
`view.tsx::StageCharacters`, including the already-validated canonical model
viewport scaling. It changes only the Demo's authored scene coordinates,
keeping business state in JS. No parent or `pocket_host/` implementation is
modified or duplicated.

## Validation and limits

`story.test.ts` and `localization.test.ts` pass together: 24 tests, 1,466
assertions, log `/tmp/pocket-v4-framing-source-tests.log`. The existing replay
flow and its rollback assertion now expect Y=130; all old-map checks pass.
This proves story semantics, not visible feet or layout quality.

Before source change, story SHA-256 was
`aa21d89ce244df20346d55a06afa3664f0a8a511157bd71b02479328d1ce97e9`.
Candidate source SHA-256 is
`a83084561a1628db1c19f229cd044fbe50a4c4bae343b4ac27d7ad80dd9c3d36`.
The ordinary cached Demo still contains the former source. The isolated pinned
build is now staged for integration tests: QJBC 1,073,374 B, SHA-256
`c2df4275ea8243270a4638a362d55c503aaa2f56b2e0bc43c00f00bbfb01c643`;
PAK is byte-identical to strict v4 (`8126d148…`, 69,193,344 B).
Build/staging facts and the previous staged files are preserved in
`sdk/.pocket-build/lantern-v4-fullbody-20261108/`. The source view SHA-256 was
`f532cfad486e9ab1271a19fafff38c0f47b7d3fd3acf42f505f816998fa49e84`;
the later UI layout candidate is not part of this Guest.

The four actual native Guest suites passed 9 tests (19.56 seconds): routes,
old-save migration, feature tour and parallax, log
`/tmp/pocket-v4-fullbody-native.log`. Those checks validated story and native
model operations, not visual composition; the later Profile test-view captures
and their limits are recorded below.

The first 390×844 / DPR2 Profile run captured both actual images. The full-body
image shows complete feet with separation from the footer, and the close-up
is retained. PNGs and metadata are archived under the candidate's `captures/`
and `captures-390-dpr2.json`. However, the case timed out at three minutes
after those captures, before the release/resume workflow completed. It is a
failed case, log `/tmp/pocket-v4-fullbody-390-dpr2.log`, even though the standard
Flutter integration driver subsequently printed `All tests passed` and
returned zero. That driver result is not accepted as evidence.

The harness now declares a required completion checkpoint, reached only after
all assertions and final cleanup return, and adds opt-in input tracing for
diagnosis. The driver must reject a missing checkpoint. The next model run
also captures Idle0 and TapBody full-body scenes, so all three authored
placements are checked instead of extrapolating from Idle1.

The diagnostic rerun passed the complete model/Spine/release/resume/save case
in 176 seconds, log `/tmp/pocket-v4-fullbody-diagnostic.log`. Its completion
response explicitly contains required/completed `model-showcase`. It captured
all three full-body motions plus the unchanged close-up; the archive and
hashes are in `captures-390-dpr2-diagnostic.json` and `captures/`. All three
actual full-body PNGs show the shoes fully above the footer at 390×844/DPR2.

That run initially stopped advancing frames with an inactive macOS test
process (CPU idle, live VM isolate). Precisely activating the test PID resumed
pointer/frame progress. The elapsed 176 seconds includes that inactive wait
and is not a game performance measurement. A subsequent `fullyLive` policy
trial also timed out, so that change was withdrawn and the original policy
retained. Its missing completion checkpoint correctly caused the repaired
driver to exit 1 (`/tmp/pocket-v4-fullbody-1920-dpr1.log`). The first timeout
remains a failed run and is not replaced in the record by a successful rerun.

With the original policy, the 1920×1080/DPR1 run passed the full case in
59 seconds (`/tmp/pocket-v4-fullbody-1920-trace.log`), including all three
full-body motions, close-up, lifecycle injection, release/reentry and main
save isolation. Required/completed `model-showcase` are both present in the
saved response. `captures-1920-dpr1.json` records the four actual PNGs and
their Guest fingerprint. An AppKit activation monitor targeted only the exact
temporary test-app bundle, stopping when that process ended, to keep its real
window active during the run. The bounded script and activation log are
preserved in the candidate cache; this does not inject frames, alter business
state or establish OS background-lifecycle acceptance. Physical phones and
the remaining layout/DPR targets are still unverified for the new framing.

## Visual review of the six full-body captures

The UI worker visually reviewed the three full-body actions at both passing
test-view sizes. Idle 1 is the initial `full` capture; the other captures are
Idle 0 and TapBody. In all six images, the head, hands and feet are visible,
with separation from the header and toolbar/footer. This is a visual review of
these captures, not a general guarantee for other poses or viewports.

| Test view | Idle 1 | Idle 0 | TapBody | Approximate bright-body vertical bounds and clearance |
| --- | --- | --- | --- | --- |
| 390×844 logical, DPR 2 (780×1688 PNG) | [`full`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-390x844-dpr2.png) | [`Idle 0`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-idle0-390x844-dpr2.png) | [`TapBody`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-tapbody-390x844-dpr2.png) | y≈462–1350 px (≈231–675 logical); head-to-header ≈179 logical px, feet-to-toolbar ≈123 logical px |
| 1920×1080 logical, DPR 1 (1920×1080 PNG) | [`full`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-1920x1080-dpr1.png) | [`Idle 0`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-idle0-1920x1080-dpr1.png) | [`TapBody`](../.pocket-build/lantern-v4-fullbody-20261108/captures/model-Hiyori-full-tapbody-1920x1080-dpr1.png) | y≈288–841 px; head-to-header ≈236 logical px, feet-to-toolbar ≈191 logical px |

The matching capture metadata, PNG hashes and test-view flags are in
[`captures-390-dpr2-diagnostic.json`](../.pocket-build/lantern-v4-fullbody-20261108/captures-390-dpr2-diagnostic.json)
and
[`captures-1920-dpr1.json`](../.pocket-build/lantern-v4-fullbody-20261108/captures-1920-dpr1.json).
The vertical bounds are approximate bright-body measurements; dark hair and
fine silhouette edges are not included in that threshold. The no-clipping
conclusion comes from visual review of all six PNGs, not from treating those
bounds as complete-person segmentation.

Both are macOS Flutter Profile renders with overridden test-view metrics, not
captures from a physical phone or an OS-resized desktop window. Physical-device
input, rotation and other aspect ratios remain untested. Hiyori is Live2D's
official sample character, not an original Lantern/game character; these
captures are not a licensing or distribution claim.


## Short desktop window follow-up (2026-11-08)

The subsequent 329×600/DPR2 capture revealed that Y=130 could put shoes into
the toolbar even though the earlier 390×844 and 1920×1080 screenshots were
clear. The three full-body scene anchors now use Y=80; scale 1.5, the existing
viewport scaling, close-up anchors and motion timings are unchanged. Story
source SHA-256 is `8143fa4bb2baa7c99af17f310851f413532a9f0c7060978e3d98f4503c1b54b3`.
The final Guest `e0a4a109…` passed actual 329×600/DPR2 Profile OFF/ON runs
(60/59s), with three full-body motions and close-up per side. All three ON
full-body screenshots show complete head, hands and shoes and clearance above
the toolbar. Images and complete driver responses are retained in
`sdk/.pocket-build/mesh-lod-final-ablation-20261108/{off,on}/`.
This closes the observed short-window overlap for these poses; it does not
establish OS resize/physical-phone acceptance or all possible animation bounds.
