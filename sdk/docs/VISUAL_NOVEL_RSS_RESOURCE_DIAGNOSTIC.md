# Visual novel RSS resource diagnosis

The newer 2026-11-09 crossfade-artifact attribution run and separate failure-path
fix are recorded in [memory attribution](VISUAL_NOVEL_MEMORY_ATTRIBUTION.md).
Its 17/20 stable windows still do not pass the performance gate. The runs below
remain historical evidence for their recorded artifacts.

This note records what the 2026-11-08 macOS Profile soak can and cannot say
about its unstable post-release RSS windows. It does not change runtime resource
policy or infer a leak from process RSS alone.

## Existing run evidence

The archived run is `sdk/.pocket-build/novel-stable-rss-fullrun-20261108/`.
It completed seven whole-game windows, five 10-second Live2D windows, and all
20 model entry/exit cycles with the frozen test source SHA
`9c918e0a5ae018be63198f872502d9e2e78a06431f44165a406c7bdce3b211be`, QJBC SHA
`a364702558f5c091b77a8ea679285bfb3ebb1e3affd45e2a48d5b233d9e502ff`, and PAK
SHA `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`.

The stable-RSS gate was `unverified-unstable-sample-window`: cycles 3–8 had
85–109 MiB sample ranges, and the other 14 windows were stable. Several of the
unstable windows contain a one-sample RSS step late in the five one-second
samples. The first-five and last-five medians fell from 638,009,344 to
570,753,024 bytes, so positive growth was zero; the run still failed because
all 20 bounded windows must be stable. See
[`VISUAL_NOVEL_STABLE_RSS_SAMPLING.md`](VISUAL_NOVEL_STABLE_RSS_SAMPLING.md)
for the full gate result.

The old report records `activeModelCount == 0` and zero Hiyori triangle ops
after exit and after every sample in all 20 cycles. It records one audio channel
at entry and exit, which is only a channel-count fact. Clock actor release is
unverified. The old report does not record Flutter decoded-image cache contents
at cycle entry/exit, per-sample image counts, or model native-byte totals; its
RSS steps therefore cannot be attributed to a specific resource.

During the five model windows the harness observed 17 decoded source images
and six additional mesh LOD images. Its RGBA estimate was 48,783,680 bytes in
total, including 11,010,048 bytes estimated for those LOD images. This is a
current-painter estimate, not an RSS breakdown or proof those images remained
resident after returning to the catalog.

## Source-first lifecycle findings

The retained parent outside `pocket_host/` has no VN renderer or model-image
resource lifecycle that explains this run. Its
`lib/render/pocket_ui_components.dart` route compositor retains a bounded set
of page subtrees and evicts route references when the set exceeds four; its
tab viewport explicitly cancels its ticker and timer on dispose. Those are
general UI lifecycle examples, not a Live2D/PAK cache to reuse here.

The current SDK has an explicit image release path:

- `sdk/native/src/lib.rs` derives referenced image assets from the current
  frame's draw ops. When an asset is no longer referenced or its native texture
  has been released, it puts the asset in `releasedResources`; generated image
  pages share this same lifecycle.
- `sdk/packages/pocket_flutter/lib/src/pocket_view.dart` passes frame release
  facts to `_releaseImages`. That method disposes the decoded `ui.Image` and
  its LOD variants, and invalidates in-flight decode work by advancing the
  resource epoch.
- The same `PocketView` scans current repeated-texture mesh ops and prunes LOD
  variants for assets no longer present. Failed/stale decode and LOD results
  are disposed; successful source images and LOD images are disposed on
  release or when the view itself is disposed.
- `sdk/packages/pocket_live2d/lib/src/pocket_live2d_plugin.dart` removes a
  released model slot and calls `dispose()`. The FFI model's dispose calls the
  native destroy function; `sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp`
  releases both Core-aligned MOC and model buffers before deleting the model
  owner.

This establishes that explicit release code exists and the run observed the
model handle and draw ops disappear. It does not establish when the process
returns freed pages to the OS, nor does it prove the decoded-image and LOD maps
were empty during the old run's RSS samples. No specific production leak was
found by this source review. RSS includes the whole Flutter process and is not
an allocation-class counter; delayed RSS drops alone do not identify GC, GPU
cache, allocator behavior, or an SDK leak.

## Passive-observation Profile run

The updated `novel_model_soak_test.dart` was run on macOS Profile with the
typed-buffer Live2D FFI implementation. Its source SHA is
`a798ede9ef6e642b0a04022a2777c45730f0fdf05822b4cb2cfcfd2d49d8db94`. The
compiled guest was QJBC
`a364702558f5c091b77a8ea679285bfb3ebb1e3affd45e2a48d5b233d9e502ff`, PAK
`5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`, and
bytecode metadata SHA
`af7290ac184b7a0baf1fb1e0961269f31e27c1ebeef1edc1ec4d4217702ea707`. The
exact launch command, source snapshots, guest, Flutter log, JSON response, and
observer notes are archived under
[`sdk/.pocket-build/novel-stable-rss-passive-20261108/`](../.pocket-build/novel-stable-rss-passive-20261108/)
with hashes in `run-manifest.json`.

The run completed all seven 10-second whole-game windows, five 10-second model
windows, and all 20 enter/exit cycles. Every cycle had one active model on
entry, zero after exit, and zero after the final sample. The five-second
post-release observation used five RSS samples one second apart after the
existing settle period. It did not force GC or change the sampler thresholds.

| Check | Observed result |
| --- | --- |
| Stable sample windows | 15/20; cycles 3, 4, 5, 14, and 15 exceeded the allowed spread |
| First five cycle medians | 649,723,904 bytes |
| Last five cycle medians | 698,400,768 bytes |
| Median growth | +48,676,864 bytes (+7.49%); the 10% relative bound passed, the 20 MiB absolute bound failed |
| Peak process RSS | 904,970,240 bytes |
| Result | Gate `unverified-unstable-sample-window`; Flutter drive exited 1 and required checkpoint `model-stable-rss` remained incomplete |

The passive snapshots show a consistent visible-resource transition. On each
model entry, the painter exposed 17 decoded source images (37,773,632 estimated
RGBA bytes), six mesh LOD images (11,010,048 estimated RGBA bytes), and both
Hiyori texture IDs. On each exit and all 100 post-release sample observations,
it exposed 15 source images (4,219,200 estimated RGBA bytes), zero LOD images,
no Hiyori texture IDs, and zero Hiyori triangle ops. These `width * height * 4`
figures estimate the currently observed image maps; they are not measurements
of resident process memory. The Hiyori texture IDs were
`.pocket-build/live2d/Hiyori/Hiyori.2048/texture_00.png` and
`texture_01.png`.

Cycles 3, 4, 5, 14, and 15 had RSS sample spreads of 124,403,712,
90,718,208, 90,357,760, 108,265,472, and 85,082,112 bytes respectively while
the painter image/LOD facts remained at the post-exit values. This rules out a
synchronous change in the *observed painter image maps* as the explanation for
those sample drops. It does not identify allocator, Core, Flutter/GPU, OS
paging, or another process as the cause, and it does not prove that all native
or platform image memory was released.

The harness observed one audio channel at each cycle entry and exit; that is a
channel-count fact, not proof that audio was playing or that the channel was
released. The real Guest clock actor count is not exposed by this harness, so
clock release remains unverified. The Live2D plugin exposes active handle count
but no post-release aggregate native-byte counter.

This was not a controlled foreground Profile run. The activation monitor was
not run; Flutter reported `Failed to foreground app (open returned 1)` before
connecting to VMService and completing the workload, so foreground state is
unverified. One `vmmap -summary` observation ran around cycle 3 for 1.27 seconds
without a paired baseline. Editor work and an independent Flutter unit task
resumed after the first 12 windows. The complete measurements are retained, but
they must not be used as an OS-foreground interaction result or a controlled
FPS/memory A/B comparison. The source snapshots identify the exact compiled
`pocket_view.dart` and `pocket_assets.dart` baselines; later premultiplication
edits were not in the running Profile app.

The typed-buffer FFI source hashes in this run were
`12498a8f3cc8503a00feb52aad7ae3d20e26190d5b4abbfd5c061b4659186765` for
`pocket_live2d_ffi.dart` and
`61a0e82b18f7aba0a0f03ed6f4ecd63b41f0f83795011cce2d1def91f6b645fc20` for
`pocket_live2d_types.dart`. The targeted unit/real-Core checks had passed before
this run; that is not evidence that the RSS gate passed.

The observations support a narrow conclusion: the sampled visible painter
image and LOD maps shrink on model exit and remain absent while RSS sometimes
drops sharply later. They do not establish the underlying memory owner or a
specific production leak. Any further attribution needs paired measurements
from a controlled run and a memory tool that distinguishes the relevant
allocation classes.


### A separate evidenced transient hold

Later [delta-base ablation](VISUAL_NOVEL_DELTA_BASE_RESOURCE_ABLATION.md)
identified the runtime's complete `PocketFrame` baseline as a Dart-side owner
of one-shot resource buffers. The minimal baseline drops those transient
fields; a real native/VM-GC reachability A/B proves removal for an 8 MiB
fixture. This does not retroactively explain the earlier 85–124 MiB RSS drops
or prove an equivalent process-RSS reduction in the animated game.


Current candidate follow-up is **incomplete**, not a stable-RSS pass. The
[native-density diagnostic](VISUAL_NOVEL_NATIVE_DENSITY.md#follow-up-soak-status)
records 12 windows and five completed zero-handle cycles, later harness/UI
interruption, and the independent passing model functional regression.
No threshold, cycle requirement or GC policy was relaxed. The raw transient
hold fixed by the separate reachability ablation is still a valid narrow
finding; it does not explain or close the whole-game memory gate.
