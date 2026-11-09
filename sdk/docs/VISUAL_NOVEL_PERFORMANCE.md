# Visual novel whole-game performance

The review scope is the entire game: launch, text reveal and manual reading,
Spine/Live2D, the image-skinned player, menus, log, gallery/replay, storage,
IME, video, lifecycle, and phone/large-screen layouts. Functional acceptance
and performance observations are separate evidence; a passing interaction test
does not establish a frame-rate improvement.

## Source-first integration

Reviewed the retained parent
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart`
(excluding `pocket_host/`). Retained the passive
`SchedulerBinding.addTimingsCallback` measurement boundary and demand-driven
rendering. The new game workload uses the existing
`demo/integration_test/render_pipeline_profile_test.dart` FFI timing hook and
actual painted-text pointer driver, without adding a production profiler,
business UI in Dart, or another scheduler. The parent has no visual-novel
narrative/model clock to migrate; this is an evidenced SDK-specific gap.

## Model-only narrative transaction ablation

`attachNovelClock` previously called `engine.tick` for every model wake, even
when a manual dialogue was fully revealed and had no narrative deadline.
`engine.tick` executes a transaction and publishes a snapshot to subscribers.
That repeatedly invoked view, audio, and consumer autosave-signature observers
while only model geometry needed to advance.

The shared virtual clock and model advance remain intact. The callback now
checks `novelNeedsClock(engine.getSnapshot())` after advancing models, and
executes the narrative tick only when narrative time is needed. There is no
new state, timer, cache, or alternate animation loop.

Evidence on 2026-11-07:

- The added regression fails on the original implementation: 60 model frames
  caused 60 unnecessary narrative notifications. The optimized implementation
  causes zero notifications while retaining all 60 model frames.
- `clock.test.ts`: 5 tests / 34 assertions pass, covering manual reading,
  unread skip, voice waiting/wakeup, timed choice pause/resume, model lifetime,
  text reveal, and automatic advance.
- `sdk/scripts/tests/novel_clock_guest.test.ts` compiles both variants using
  the pinned `buildGuest` pipeline and runs their actual QuickJS bytecode with
  `pocket_probe`. After 65 host frames the original has 64 model steps and 64
  narrative notifications; optimized has the same 64 model steps and zero
  notifications. A real pointer selects auto mode and reaches the ending in
  both variants. The negative control changes only the conditional tick in a
  temporary vendored copy; production source is never temporarily reverted.
- Logs: `/tmp/pocket-game-clock-before.log`,
  `/tmp/pocket-game-clock-after.log`, `/tmp/pocket-game-clock-native.log`.

These are work-elimination and behavior facts, not a claimed percentage
reduction in game frame time or physical-device power consumption.

## Whole-game timing workload

`demo/integration_test/novel_performance_test.dart` records actual Flutter
build/raster timings and native frame-call durations. Its windows include
launch/title, scene reveal, three manual-reading/model windows, menu,
log/settings/gallery, save/load, story advance and rollback. It observes
natural wall-clock vsync between real inputs. The Flutter FPS HUD is disabled
in both variants. Reports include platform, build mode, display refresh rate,
elapsed time, native call count/total/P50/P95/max, build/raster P95, frames over
the display budget and painted operation counts.

On 2026-11-07 the entire 13-window workload passed through `flutter drive
--profile` on macOS, 60 Hz, with the pinned native library. The clock comparison
used one frozen copy of Lantern and vendored VN sources. Its two builds differ
only by replacing the conditional narrative tick with the original
unconditional call. Their PAK SHA-256 is identical:
`babcda6eb53516b593c407f7f2697902a31b72e245737edbc276cf47c36ce9bd`.
QJBC SHA-256: original
`7a904d3a37e9ce406ab4b10e9c9606e1ad2f921b546a00ade7bf5c4ce17c65c7`;
optimized `28d0cdb08912d5432d73f7bb5c6f3273b2df0eab9baae1727773c56dc4670f1a`.
Both runs used the same native host, including the unused resource-scan removal
below. These artifacts precede the subsequent UI visual refinement.

| Three 1.6-second manual-reading/model windows | Original | Optimized |
| --- | --- | --- |
| Native call P50, per window (ms) | 3.448 / 3.267 / 3.383 | 1.797 / 1.910 / 1.948 |
| Native call P95, per window (ms) | 6.535 / 6.796 / 4.444 | 2.610 / 2.656 / 2.663 |
| Flutter build P95, per window (ms) | 7.962 / 8.097 / 6.406 | 4.073 / 3.943 / 3.865 |
| Raster P95, per window (ms) | 2.565 / 2.731 / 2.587 | 2.836 / 2.806 / 3.085 |
| Native calls across the three windows | 261 | 176 |
| Native total duration across the three windows (ms) | 937.385 | 327.382 |
| Frames over display budget in these windows | 0 | 0 |

This single ordered A/B observation supports eliminating the narrative work;
it is not a whole-game average speedup, an FPS guarantee, or a mobile result.
Raster time did not improve. Reveal and menu P95 varied in both directions;
do not generalize the manual-reading gain to them. Both variants completed
launch/title, reveal, reading, menu, log, settings, gallery, save/load, advance,
and rollback through actual game controls. The separate fixed-frame QJBC
negative control establishes unchanged model step counts.

Reports: `sdk/.pocket-build/novel-performance-20261107/clock-{original,optimized}-profile.json`
and `ablation-artifacts.json`. Logs:
`/tmp/pocket-game-clock-{original,optimized}-profile.log`. Reproduce the workload
with `flutter drive --profile --driver=test_driver/integration_test.dart
--target=integration_test/novel_performance_test.dart -d macos
--dart-define=NOVEL_PROFILE_VARIANT=<variant>` from `demo/`, after selecting
the corresponding built artifacts. Do not mutate production clock code for
the negative control; use the temporary vendored source technique in
`novel_clock_guest.test.ts` and the same pinned `buildGuest` toolchain.

The harness does not time every game path. The Hiyori replay soak below is a
measured model-replay workload; video, IME and large-layout functional tests
remain functional evidence only. Simulator/debug results must retain their
mode and device qualification and cannot establish physical-device cold-start
or shipping FPS improvements.

## High-resolution Live2D soak results

`demo/integration_test/novel_model_soak_test.dart` is the long-window
measurement target for the high-resolution Hiyori model and the whole game. It
uses the normal Demo host, pinned Guest, actual bundled 2048px Hiyori texture
pages, Live2D FFI plugin and authored story choices. The model workload records
five distinct 10-second natural-vsync windows: Idle 0, Idle 1, Idle 1 close-up,
Idle 0 again, and Idle 1 again. It also records seven distinct 10-second
whole-game windows for title, manual reading, journal, backlog, settings,
gallery and save-slot page; this is one window per scenario, not five repeated
windows for every whole-game category. Twenty additional authored entry/exit
cycles check that every entry reaches one live model with the two decoded
texture pages and every exit returns the real plugin's active model count to
zero.

Each window records actual `FrameTiming` build/raster durations and the
`debugPocketFrameDeltaAtOverride` wall time around `pocketFrameDeltaAt` (the
native frame call plus its existing byte transfer/decode boundary; these are
not separated by the current public probe). The harness samples
`ProcessInfo.currentRss` once per second and records `ProcessInfo.maxRss` when
available. The reported decoded-image byte estimate is width × height × 4 for
Flutter `ui.Image` objects observed in the current painter. RSS includes the
host process but does not include a separately attributable GPU allocation;
the image estimate is not a measurement of GPU memory. Process CPU attribution
is collected externally because another normal Demo process can be open at the
same time.

Every test redirects only the real path-provider app-support directory to its
own temporary filesystem directory, restores the prior provider, and unmounts
the host before deleting that directory. This protects the user's existing
Demo save files.

The r3 Profile drive passed on macOS arm64 at a reported 60 Hz on 2026-11-07.
It used Lantern QJBC SHA-256
`748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc` and PAK
SHA-256 `9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1`.
The complete report is
`sdk/.pocket-build/novel-highres-20261107/soak-profile-r3.json`; the Flutter
drive log is `/tmp/pocket-highres-model-soak-profile-r3.log`.

| Model window (10 s each) | FrameTiming entries | Guest frame calls | Guest-call P95 (ms) | Build P95 (ms) | Raster P95 (ms) | Over 16.67 ms budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle 0 | 401 | 347 | 11.577 | 19.965 | 0.994 | 131 / 401 (32.7%) |
| Idle 1 | 405 | 347 | 11.637 | 20.117 | 1.023 | 130 / 405 (32.1%) |
| Idle 1 close-up | 389 | 341 | 11.614 | 20.032 | 1.040 | 139 / 389 (35.7%) |
| Idle 0 repeat | 405 | 338 | 11.773 | 20.347 | 1.012 | 138 / 405 (34.1%) |
| Idle 1 repeat | 400 | 348 | 11.831 | 20.144 | 1.066 | 131 / 400 (32.8%) |

All five windows saw both real 2048×2048 Hiyori texture pages and 2,671–2,866
Hiyori texture-triangle ops in the captured paint stream. Shared UV triangles
changed coordinates during each 10-second interval. The FFI-call P95 values
include `pocketFrameDeltaAt` and its existing byte-transfer/decode work; they
are not native-only times. Raster P95 stayed near 1 ms, while build P95 was
above the 16.67 ms display budget in all five model windows. Across those
windows, 669 of 2,000 delivered `FrameTiming` entries were over budget. The
observed 389–405 entries per 10-second interval are recorded counts, not an
assumed 600 frames or a claim that the 60 Hz budget was met.

The seven whole-game windows recorded 596/550/4/7/7/4/2 `FrameTiming`
entries for title/manual-reading/journal/backlog/settings/gallery/save-slots.
The manual-reading window made 391 guest calls with native-call P95 6.350 ms,
build P95 7.303 ms, raster P95 2.968 ms, and no budget overruns. The six other
windows were mostly static: the journal and four player panels each made zero
guest frame calls and zero painter calls during the window; their 2–7 Flutter
timings are not 60 FPS evidence.

All 20 model cycles reached active model count 1 with 2,838–2,860 real triangle
ops, then returned to active count 0 and zero Hiyori triangle ops. At the end
of the run `ProcessInfo.maxRss` reported 855,408,640 bytes (about 815.8 MiB).
The per-cycle entry RSS samples ranged 472.0–657.5 MiB and exit samples ranged
465.3–648.7 MiB; the final cycle's exit sample was 614.6 MiB. These are
instantaneous samples. They do **not** establish a stable post-release
residency delta, prove a leak, or pass the Goal's ≤10% / ≤20 MiB memory
threshold. The harness sampled `currentRss` once per second in the longer
windows, not in a steady-state period after every release. It also cannot
attribute GPU memory; its decoded RGBA estimate during model playback was
37,773,632 bytes for the `ui.Image`s visible in painters, not a GPU allocation
measurement. A stable post-release memory window is still required before
judging the memory gate.

Reproduce from `demo/` with the frozen assets and pinned Flutter executable:

```sh
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive --profile --driver=test_driver/integration_test.dart --target=integration_test/novel_model_soak_test.dart -d macos
```

This is one macOS Profile result. It does not establish iOS, Android, Windows,
physical-device, shipping-mode or whole-game memory-threshold acceptance.

## Previously completed ablations

Avoid duplicating the existing changes documented in
`FRAME_REDUNDANCY_OPTIMIZATION.md`, `GLOBAL_HOST_OPTIMIZATION.md`,
`HOST_BOOTSTRAP_ABLATION.md`, `RESOURCE_DECODE_ABLATION.md` and
`MEMORY_PRESSURE_OPTIMIZATION.md`. In particular: immutable empty frame-splice
reuse, parallel independent host initialization, manifest reuse, redundant
session notification removal and intermediate resource byte-copy elimination
already exist. New caches or wrappers require a new measured gap.

## Resource-request frame scan

`PocketView._applyFrame` requests resource reconciliation for each changed
frame. The non-startup path in `_requestResources` already scans the primary
and auxiliary operations to find package images and video surfaces. It also
constructed `_imageAssetsForFrame` unconditionally, although that set is only
read while `waitForInitialImages` is true. Ordinary changed frames therefore
performed a second complete operation scan and allocated an unused set.

The set is now computed only for the initial image barrier; startup failure,
timeout and resize gating retain their existing behavior. The retained parent
has no matching typed-resource admission path: its draw-list painter consumes
already-authored map commands (`pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`).
This is an SDK boundary adaptation, not a parent implementation to copy.

The targeted first-frame tests cover decode failure, timeout, late decode
cancellation, resize coalescing until both resource sets are ready, and guest
activity remaining paused until decode completes. This removes one
`O(primary ops + auxiliary ops)` scan and one temporary asset set per changed
non-startup frame. It does not claim a wall-clock frame-time improvement; the
whole-game profile remains the measurement boundary.

## Build-source copy ablation

The real two-variant build exposed `buildGuest({outDir, keepSource:
outDir + '/app.js'})` attempting to copy the generated source onto itself.
On this host it failed with `ENOENT` at the same source/destination path.
The retained build pipeline remains unchanged; `buildGuest` now skips that
redundant copy when the resolved paths are identical. Rebuilding the frozen
Lantern project with exactly that output/source combination passed
(`/tmp/pocket-build-same-source-path.log`). This is a build correctness fix,
not a game frame-time optimization.

## Remaining measured-work candidates

The GPT Image UI refinement admits three shared 512×512 RGBA textures
(frame, primary frame, and a 4×4 icon atlas), about 3.15 MB of raw PAK image
payload. The final primary-font-aligned refinement PAK is 22,638,368 bytes with 16 unique images;
the obsolete ornate frame is not admitted. This is a package-size observation,
not a startup-time measurement. The build collector deduplicates image keys,
and the host decodes by asset/revision rather than by control instance.
Static skin geometry is memoized on metadata/dimensions, and contiguous
compatible texture triangles are batched by the existing painter. There is
no evidence warranting another skin cache, per-icon files, or a new renderer.
The whole-game harness now records actual texture-triangle batch counts too.

Reducing these textures to 256px or using RGBA4444 remains an experiment,
not an accepted optimization: inspect high-DPI corners, alpha and 18–24px
icons against the retained 512px images before accepting a smaller format.
The existing masters and provenance must remain intact.

The independent source audit also reviewed model, audio and painter paths.
The audio plugin uses native event streams rather than a per-frame polling
loop; no replacement audio scheduler is warranted. The retained parent has
no feature-equivalent Spine or Cubism provider to migrate.

- Spine `frame()` creates world/output position, UV and triangle arrays before
  `pocket_vn/src/spine.ts` copies/transforms them into reused PMS1 buffers.
  Measure allocation bytes and model frame latency before adding a one-pass
  encoding path; retain the public stable-copy frame API and exact geometry.
- Live2D updates move parameter and drawable data across JS, Dart, FFI and
  Cubism Core. The FFI currently copies native arrays to Dart lists, then packs
  byte arrays. Measure update latency and returned bytes, then ablate that
  concrete double conversion before considering a static-topology protocol.
- The canvas painter constructs drawing objects and triangle-batch vertex
  lists on actual repaints. Measure paint/raster allocations first; the older
  map-command painter is not a feature-equivalent replacement.

These are source-backed candidates, not demonstrated jank findings or completed
optimizations. None justify another runtime, speculative cache, duplicated
model state, or an alternative layout engine.

## Camera and atmosphere profile checkpoint (2026-11-07)

The actual macOS Profile runner completed all 13 windows in
`demo/integration_test/novel_performance_test.dart`, variant
`camera-atmosphere-spatial`. This checkpoint used QJBC `ce1f8dc2dbcf6bda457fed5a96e94f9e55eb42d48d630c9c8fd38fab03f0d0cc`
and PAK `3ead2ebe1661858f7b790e0d9ed932d907ea0246da6bce7e2d673fac8e6ca1a2`.
It precedes the stable choice-layout memo and final V3 save compaction; it is
not a performance result for the final playable artifact. Raw window summaries
and captured frames are retained in `.pocket-build/novel-camera-atmosphere-profile-20261107/`.

| Manual reading window | Native P95 | Flutter build P95 | Raster P95 | Over-budget frames |
| --- | ---: | ---: | ---: | ---: |
| 0 | 4.470 ms | 6.572 ms | 3.076 ms | 0 |
| 1 | 4.341 ms | 6.567 ms | 3.000 ms | 0 |
| 2 | 4.170 ms | 6.155 ms | 2.845 ms | 0 |

Launch/title, reveal, gallery, save and load windows contained ten over-budget
frames in total. Those windows combine input, resource and route work; the
summary does not identify a single allocation or component as their cause.
No additional cache or scheduler was introduced from this summary alone.
The measurements are one local macOS run, with different content and viewport
from the earlier clock ablation. They do not establish a speedup over that
baseline or Android/iOS/Windows frame-rate guarantees.


## Ordinary Demo Live2D measurement and reader ablation, 2026-11-07

The ordinary Lantern title now exposes an isolated model-theater replay. This
measurement used QJBC `444c68c09780c9d80d4645b225f459a00f396343eb55c2313d3a8319bc86deda`
and PAK `0dafa7fa07056c90b6966af9e43d7443487f0f72398bae8683c1d0be8fa411cc`,
macOS arm64 Profile, 60 Hz, 329×600 window. The default native Live2D FFI
plugin loads the local official Hiyori sample, with its two 512×512 texture
pages, actual Core deformation, repeat sampling and masks. The frame-call
metric includes native execution **and Dart binary copy/decode**.

The original run recorded all three model windows, but failed afterward on
an incorrect test navigation label. Its 16 recorded windows are observations,
not a passed end-to-end workload. The corrected reader-only run passed all
17 windows, including a log that pauses the model. In that paused 1.6-second
window there were zero native frame calls and zero Canvas repaints.

| Three 1.6-second Hiyori windows | Original reader | Reused ByteData view |
| --- | --- | --- |
| Frame-call P95 (ms) | 13.763 / 14.431 / 13.537 | 12.668 / 12.914 / 12.649 |
| Flutter build P95 (ms) | 22.696 / 22.876 / 22.222 | 22.074 / 21.397 / 21.222 |
| Raster P95 (ms) | 1.009 / 0.979 / 1.005 | 0.977 / 0.982 / 0.978 |
| Frames exceeding the 60 Hz budget | 16 / 21 / 18 | 17 / 17 / 17 |

`_PocketBinaryReader` formerly constructed a `ByteData.sublistView` for each
u16/u32/u64/f32. It now owns one bounded view of the supplied Uint8List and
reads at its current offset. Bounds checks, finite-float rejection, little
endianness, pixel-buffer ownership, and the binary ABI are unchanged. The
retained parent renderer uses maps and has no corresponding PFB reader to
reuse; this is a necessary SDK boundary adaptation. The new regression checks
a nonzero-offset, unaligned input slice and rejects a truncated slice even
when its backing buffer contains more bytes. The model and mesh pixel suites
pass together (16 tests).

A source-extracted Dart AOT scalar-reader experiment alternates both exact
reader implementations across nine rounds of 100 frames, with 60,000 f32
reads per frame and equal checksums. Median per-frame scalar-read time was
0.53670 ms original / 0.19047 ms reused. This isolates scalar reads, not full
frame decoding or a game FPS improvement. The whole-game observation above
shows a modest reduction, with model build time **still above budget**.

Reports and exact source/artifact hashes:
`sdk/.pocket-build/novel-model-performance-20261107/{original-profile,reader-profile,reader-artifacts,reader-ablation}.json`.
The same directory retains the original reader and generated AOT experiment.
Logs: `/tmp/pocket-model-showcase-profile.log`,
`/tmp/pocket-model-reader-profile.log`, `/tmp/pocket-model-reader-tests.log`.

These measurements precede the subsequently identified cross-block mesh-mask
rendering repair and the six unobscured action-display dialogues. Neither
variant proves correct complete-model pixels or acceptance of those later
changes; the final integrated artifact requires its own functional and timing
verification. Do not interpret the old low raster time as correct masking.


## Atomic model-frame commit ablation

`NovelModelView` receives an asynchronous model frame and publishes both the
mesh array and a version for reused in-place PMS1 buffers. Publishing them
separately caused each mesh render effect to submit the same new frame twice.
The existing two writes now share one Solid `batch`; neither state is removed,
and no model clock, cache, or scheduler is added.

`sdk/scripts/tests/novel_model_commit_guest.test.ts` vendors the production
sources into a temporary consumer and removes only that batch for its negative
control. Both variants use pinned buildGuest and actual QuickJS/native mesh
operations. Across 48 host frames and four model advances, unbatched
`setMesh`/`setMeshEffect` counts are 10/10, batched counts 5/5. Every frame's
native texture-triangle output is equal between variants; the same vertex's
position changes across frames while the fixture reuses its geometry buffer.
The test passed. Its small deterministic model provider is test input, not a
production fallback or evidence of official Core compatibility. Complete
Hiyori acceptance remains the separate default-FFI workload.

## Preserve mesh compositing groups across retained Canvas blocks

The ordinary Demo screenshot revealed incorrect white eye/face regions even
though model-only painter tests passed. `PocketView._buildSurface` split every
32 operations into independent painters, including inside a
`meshLayerBegin → target triangles → meshMaskBegin → mask triangles → restore`
group. Painter-local Canvas saveLayer state cannot cross those boundaries.
The painter defensively closes its open layer at the end of a block; the next
block then paints remaining triangles without that layer/mask context.

The retained host now splits only after a complete group. Ordinary operations
retain the existing 32-operation block target; a compositing group can exceed
it. Host surfaces retain their ordered flush boundary. This repairs rendering
semantics, rather than dropping masks or substituting a static model. It may
also reduce block construction, but timing claims require the integrated
measurement after the repair. The retained parent's map-based renderer has no
corresponding mesh/group renderer to migrate. No second renderer is added.


The focused `pocket_view_mesh_group_test.dart` passes with 66 target triangles
and 66 mask triangles spanning multiple old block boundaries. Its explicit
legacy fixed-32 negative control produces an incorrect mask pixel. The actual
PocketView then produces the expected red masked region, blue background
outside it, and green host surface layered afterward; both meshes are asserted
to belong to one painter. This tests the retained-surface composition, in
addition to the existing isolated painter tests. The ordinary final Demo's
macOS default-FFI functional test also passes on QJBC `f4b9e519…` / PAK
`0dafa7fa…`, with the corrected actual Hiyori screenshot and native motion,
lifecycle, release and save-isolation assertions (see the Live2D report).


## Final integrated model workload

The corrected 17-window macOS Profile workload passes on final QJBC
`f4b9e519dc9af416734f9b136d294b9d8d3a6fa0727c33f8b6a2826e644b2e2a`
and unchanged PAK `0dafa7fa…`. It includes reader reuse, the atomic JS model
commit and complete Canvas mask groups. It uses the same 329×600 / 60 Hz
setup and the initial Hiyori action directory as the earlier measurements.

| Final three Hiyori windows | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Frame-call P95 (ms) | 11.888 | 12.079 | 11.969 |
| Flutter build P95 (ms) | 21.437 | 21.123 | 20.918 |
| Raster P95 (ms) | 1.012 | 0.988 | 0.981 |
| Frames over budget | 24 | 25 | 27 |
| Canvas paints | 4,144 | 4,182 | 3,945 |

This is **not evidence of an overall frame-rate improvement**: the frame-call
and build percentiles decreased, but 76 frames exceeded budget across these
windows, versus 55 in the earlier incorrect-mask baseline. Rendering is now
correct and build time remains above the 16.67 ms budget. The single ordered
runs, asynchronous model sampling, and corrected mask semantics do not isolate
an FPS benefit for each change. The independent QJBC negative control proves
the duplicate submissions were removed without changing its mesh output.

The final paused-log window again has zero native calls / Canvas repaints;
its build P95 is 0.351 ms. Reports: `final-profile.json` and
`final-artifacts.json` in the same ignored model-performance directory; log
`/tmp/pocket-model-showcase-final-profile.log` (all tests passed, one minute).
Further work should measure large animated-triangle decoding and retained
Canvas block construction; blindly dropping masks, reducing model motion or
increasing block size without a new comparison is not an accepted fix.


## Remove phantom model-relative image entries

The pinned compiler's source-image collection treats matching PNG/SVG string
literals as image inputs. Injecting model3 documents as raw JS object literals
therefore admitted two relative texture-reference **lookup keys** as missing
image paths and produced unused 32×32 placeholder PAK pages. Actual resolved
model textures were already admitted separately by the existing VN registry
image literals.

`build_guest.ts` now injects the same model document as one JSON data string
and parses it once at startup. This preserves reference data without asking
the pinned compiler to interpret those keys as source files. It does not alter
the compiler, create a second image pipeline, or hide missing registered
textures. The real build regression in `build_guest_vn.test.ts` unpacks the PAK
and checks that the registered scene image is present while the relative
model lookup key is absent (1 test / 26 assertions passed).

On the initial model-theater checkpoint, PAK entries went from 37 to 35 and
bytes from 27,014,544 to 27,006,192 (8,352 bytes removed). QJBC grew from 945,961
to 985,605 bytes with the data-string encoding. Subsequent display dialogues
and the model batch produce the final 986,801-byte QJBC. This removes bogus
resources but is **not a net total package-size or startup-speed claim**.
The retained parent has no model3 resource importer to reuse; its general
resource/FFI ownership remains unchanged.


## Rejected larger-block experiment, 2026-11-07

The next controlled experiment re-ran the complete 17-window workload with
the corrected mask groups and unchanged QJBC `f4b9e519…` / PAK `0dafa7fa…`.
It changed only `_canvasBlockSize` from 32 to 128. Both Profile runs passed,
on macOS arm64 / 60 Hz / 329×600. The previously launched normal Demo remained
idle at observed 0% CPU; it was not terminated during these measurements.

| Hiyori idle windows | Canvas 32 | Canvas 128 candidate |
| --- | --- | --- |
| Build P95 (ms) | 20.688 / 21.656 / 21.224 | 20.972 / 20.584 / 20.677 |
| Raster P95 (ms) | 0.969 / 1.241 / 1.067 | 1.030 / 0.839 / 0.907 |
| Frames over budget | 20 / 20 / 21 | 18 / 28 / 29 |
| Actual Canvas paints | 4,240 / 4,034 / 3,806 | 1,192 / 1,156 / 1,064 |
| Painted operations | 141,039 / 133,489 / 125,379 | 151,674 / 146,594 / 134,966 |

The candidate is **rejected**. Fewer painters did not establish a frame-time
benefit; total over-budget frames rose from 61 to 75 and painted operations
increased. Production returns to 32, retaining complete mesh groups. This also
preserves the existing focused-input block-count and real-JS cross-block
background tests without weakening their fixtures to fit a tuning constant.

Snapshots, source hashes and observations are retained in the ignored
`sdk/.pocket-build/novel-canvas-ablation-20261107` directory. Reports are
`canvas32-profile.json`, `canvas128-profile.json` and `artifacts.json`; logs
are `/tmp/pocket-novel-canvas{32,128}-profile.log`. This single ordered A/B
rejects this candidate on the measured workload, rather than proving a
universal best block size.


## Remove redundant painter fingerprint scans, 2026-11-07

`PocketCanvasPainter.shouldRepaint` previously scanned new and old operation
lists to compute fingerprints, then performed full structural equality when
the fingerprints matched. Structural equality already checks paint fields,
clip, order, output size, DPR, font fallback and image-identity snapshots.
The implementation now performs that comparison directly, removing duplicate
scans and hash helpers without adding state or a cache. Video and host surfaces
retain their separate invalidation path.

The renderer/FFI regression suite passes 33 tests covering QuickJS-driven
move/delete pixels, retained static clones, image decoding/release, focused
input/IME, DPR, transforms, complete mask groups and mesh effects.
Log: `/tmp/pocket-painter-structural-regression.log`.

An isolated macOS arm64 Profile harness uses the production painter, real
`ui.Image` textures and 32-operation lists. Its legacy comparison retains the
old fingerprint implementation from the source snapshot. New delegates are
created per call; only the old delegate's cached fingerprint is warmed, and
fixture setup is outside the measured interval. Nine alternating rounds make
2,304 calls per method in each case, checking equal decisions, counts and
checksums. All three cases pass.

| Case | Old hash + comparison, μs/call | Direct comparison, μs/call |
| --- | --- | --- |
| Equal cloned operations | 9.0668 | 1.2018 |
| First operation changed | 6.8086 | 0.0299 |
| Last operation changed | 6.8633 | 1.1363 |

This proves reduced comparison work, **not whole-game FPS**. The complete
17-window candidate workload also passes, but its three Hiyori build P95
values are 21.922 / 22.286 / 29.848 ms, with 23 / 26 / 25 over-budget frames.
It does not demonstrate an end-to-end improvement over the 32-op baseline.
The separate normal Demo became active during this measurement period
(observed CPU up to 62.4%), so this run is also unsuitable for attributing a
whole-frame regression to the comparison change alone. The 60 Hz target
remains unmet. A subsequent full model integration attempt timed out at title
readiness before model checks; it is a failed run, not model validation.

Harness and source snapshots are in the ignored
`sdk/.pocket-build/novel-canvas-ablation-20261107` directory; logs are
`/tmp/pocket-painter-structural-micro.log` and
`/tmp/pocket-novel-canvas32-structural-profile.log`. Guest hashes remain
`f4b9e519…` / `0dafa7fa…`. Recheck the full model flow after isolating its
persistent storage from the user's normal Demo.


The later 2048² Hiyori model Profile result and its explicit memory limits are
recorded in “High-resolution Live2D soak results” above. Earlier 512-atlas
Profile observations remain specific to their older Guest and are not
comparisons against the high-resolution build.

## Static Live2D topology cache off/on Profile comparison — 2026-11-08

The controlled pair uses the same frozen Lantern/source snapshot and staged
2048px Hiyori model. The only project change between OFF and ON was the
`cacheStaticTopology` factory option in `demo/js/apps/lantern/app.tsx`; 93 of
94 project files were byte-identical. Both PAKs are identical: 35 entries,
60,750,896 bytes, SHA-256
`d499c3e7152d42d28bfbcefc1dcc970c62e5f58f36216510fea5d404aa19e323`.

The artifacts were compiled separately through pinned `buildGuest`:

| Variant | QJBC SHA-256 | `app.bytecode.json` source SHA-256 | Payload SHA-256 | Bytecode bytes |
| --- | --- | --- | --- | ---: |
| OFF | `76e60254e251edd35de3f49a53862faea13852727a31c1351aa32aa1316292a2` | `4434b0a3d67c4a9cc043b5be8c30ef0d59bf839b603632054dc7148faef062b2` | `57bd487c591ebe37fa36c05780acf153980fad6df6ce93f80bcb83f72ac45092` | 1,037,825 |
| ON | `0457e109c44662bf560d06aa6da9d5d5e1f060f888fe6470f63c4b6b48200c39` | `5fbf79672d85342869d602a21cc36e12d5f2cb325d5abc4f22f8284c7020d5fc` | `9d03db1322bc85205bd401c4ed38bf384535cd4d8b11578e158134291b1fa6c1` | 1,037,832 |

Each macOS arm64 Profile run used the same 60 Hz route and measured five
distinct 10-second model windows in the same order. Whole-game sampling was
disabled for this ablation (`wholeWindowCount: 0`); it is not a whole-game
profile. Each run performed only two real model enter/exit cycles, not the
usual 20-cycle soak. Both cycles in both runs returned active model count and
Hiyori triangle ops to zero. The reports also confirm both 2048 texture pages
and changed model coordinates in every window.

| Model window | OFF / ON build P95 (ms) | OFF / ON raster P95 (ms) | OFF / ON frames over 16.67 ms |
| --- | ---: | ---: | ---: |
| `hiyori_idle_0` | 19.891 / 15.225 | 1.027 / 1.080 | 146 / 6 |
| `hiyori_idle_1` | 19.890 / 15.007 | 0.999 / 0.991 | 151 / 3 |
| `hiyori_idle_1_closeup` | 19.650 / 14.120 | 1.008 / 1.036 | 149 / 2 |
| `hiyori_idle_0_repeat` | 19.883 / 14.518 | 0.999 / 1.014 | 156 / 4 |
| `hiyori_idle_1_repeat` | 19.815 / 15.840 | 1.067 / 1.124 | 128 / 13 |

OFF recorded 730 of 2,060 frames over budget (35.44%); ON recorded 28 of
2,054 (1.36%). This reduces the measured frame cost, but ON still fails the
absolute build P95 ≤12 ms and over-budget ≤1% gates. The option remains
opt-in/default-off; the production Guest was restored to QJBC
`06656d13ac04a7ceec9931b79c0933dbe6f2b513d48137ca4ba4cb3c6f3e7694` with the
same PAK. Two cycles do not replace the separate 20-cycle memory/lifecycle
acceptance.

The runs were sequential separate processes (OFF PID 1004, ON PID 5821), not
randomized repeated trials and not same-pose pixel comparisons. The result is
specific to this macOS Profile workload; it does not establish an all-platform
improvement. Full reports are
`sdk/.pocket-build/novel-topology-ablation-20261108/{off,on}-profile.json`;
logs are `/tmp/pocket-topology-off-profile.log` and
`/tmp/pocket-topology-on-profile.log`. Both drives exited successfully.

## Scratch variable-projection ablation — 2026-11-08

This experiment did not change production `engine.ts`. The retained parent
outside `pocket_host/` has no VN engine or immutable variable-snapshot
projection to reuse. Scratch baseline and candidate copies used the same SDK
source; the candidate only reused the already cloned and frozen effective
variable projection while its copy-on-write source-map references were
unchanged. It kept cloning and freezing after runtime/persistent writes, load,
rollback, input submission and `newGame`, and did not expose mutable engine
maps.

Pinned Bun 1.4.4 passed 2 tests / 48 expectations for semantic equivalence,
copy-on-write invalidation, and nested snapshot immutability. A fixed workload
used 22 initial variables (21 scalar values plus nested JSON) and 600 ticks of
a 20-second wait. Baseline changed the projection reference on all 600 ticks;
candidate changed it on zero ticks, with matching checksum 21,600. Three
independent invocations each used five paired samples with alternating order:

| Run | Baseline median, 600 ticks (ms) | Candidate median, 600 ticks (ms) |
| --- | ---: | ---: |
| 1 | 3.727 | 0.518 |
| 2 | 3.414 | 0.434 |
| 3 | 3.070 | 0.411 |

The median of the three medians is 3.414 ms baseline and 0.434 ms candidate,
about 2.980 ms saved over 600 ticks (4.97 μs/tick; 87.3% in this isolated
loop). This workload excludes story execution, UI, native calls, storage,
camera, video and models; it is not an FPS result. The absolute work removed
does not justify an identity cache for the current Lantern profile, so the
candidate remains scratch-only. Raw reports:
`/tmp/pocket-variable-projection-ablation-20261108.json`,
`/tmp/pocket-variable-projection-ablation-20261108-run2.json`, and
`/tmp/pocket-variable-projection-ablation-20261108-run3.json`; scratch source
and tests are under the ignored
`sdk/.pocket-build/novel-variable-ablation-20261108/` directory.

## Model frame list-copy ablation — 2026-11-08

This source-only change removes two redundant list copies in
`PocketView._buildSurface`. Each canvas block still takes its own snapshot via
`canvasOps.sublist(start, end)`; the extra `List.of` around that snapshot was
removed. A span still takes an immutable snapshot in the
`PocketMeshSpanPainter` constructor (`List.unmodifiable(partitions)`); the
extra `List.of` at the call site was removed before that constructor copy.
Therefore clearing the builder lists after flush does not change painter data
or ordering.

The captured widget-tree inventory contains 112 canvas partitions and one
supersampled span. Each newly built canvas block removes one intermediate
list allocation while retaining its per-partition op snapshot; each newly
built span removes one intermediate allocation while retaining its
constructor's immutable partition snapshot. If all 112 blocks and the one
span represented by that inventory are rebuilt in a given build path, that
path removes 113 list allocations. This is not a fixed per-frame count:
retained widgets/surfaces may be reused and rebuild scope varies. It does not
change draw batching, LOD, crop, sampling, or paint order. The baseline source
pair is preserved in the ignored
`sdk/.pocket-build/model-list-copy-ablation-20261108/baseline/` directory:
`pocket_view.dart` SHA-256
`511c50b9666a1861accc4ce7ca28e515e1d9e2714a0e200663bab9174e56af42` and
`pocket_view_painter.dart` SHA-256
`a61542912180f8073116ee81816b04fc0985106b7c90b7c447b5ddd5de9704f4`.

The root's unified focused run passed 26/26 tests across three files; log:
`/tmp/pocket-model-list-copy-focused-20261108.log`. The actual 9c Guest
model-showcase A/B completed successfully in 59 seconds (session 19754).
Across four poses, group1 had zero pixel difference; the run also verified
that SSAA drew, inputs changed the model, and derived snapshot handles were
released. Its manifest is
`sdk/.pocket-build/model-list-copy-ablation-20261108/actual-profile/manifest.json`.

This is an allocation-count reduction inferred from source and captured
partition inventory, not a measured allocation-byte, frame-time, or RSS
improvement. The ordinary Demo process (PID 46513) was not redeployed with
this source change, so these results apply to the isolated candidate run, not
that currently running app. The SDK tests exercise span drawing and grouping,
but do not have a separate assertion that mutating the builder list after
construction leaves the span's immutable partition snapshot intact.


## Transient delta-base ownership ablation — 2026-11-08

The [resource-retention experiment](VISUAL_NOVEL_DELTA_BASE_RESOURCE_ABLATION.md)
found and removed a full-frame hold that is unnecessary for PFP1 splicing.
An actual native 8 MiB resource survived three full-GC probes in the baseline
but became unreachable in the candidate while the runtime remained alive.
This is direct reachability evidence, not an RSS or frame-time improvement
claim. The final public returned-resource/empty-splice contract is covered by
the focused native binary regression; whole-game performance and stable-RSS
requirements remain independently gated.


## 2026-11-09 current-package recheck and rejected float-copy ablation

The current fd670 QJBC / 54c923 PAK baseline completed seven whole-game page windows, five 10-second model windows and twenty entry/release cycles. Build P95 was 12.957–14.536 ms; model over-budget samples were 35/1941 (1.803%). All model handles/triangles released, but RSS grew 36.77 MiB and only16/20 sample windows were stable. The float-copy candidate passed21 functional tests but showed no consistent end-to-end improvement and also failed RSS (+35.34 MiB,18/20 stable). It was rejected and runtime source restored; this is not a performance success or a whole-game60Hz claim. See [full source, frozen A/B evidence and limits](VISUAL_NOVEL_FLOAT_SNAPSHOT_ABLATION.md).

After the frozen A/B finished, the harness reporting was corrected to distinguish `sampleWindowCount` from the actual `stableWindowCount`; acceptance thresholds and gate behavior are unchanged. Raw historical responses were not rewritten. Session teardown now awaits the actual native/storage close boundary instead of a fixed sleep, and ordinary-storage preservation is checked.
