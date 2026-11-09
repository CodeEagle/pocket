# Visual novel mesh SSAA experiment

Status: experimental and opt-in with `POCKET_MESH_SUPERSAMPLE=2`. The default
scale remains 1 and keeps the existing `PocketCanvasPainter` path. Four-pose
same-frame captures show a real sampling difference, and a reviewer found the
2× output visually smoother at hair/collar edges while retaining clothing
detail. The 5-window Profile result does not meet the build-time target and is
not evidence that SSAA is free or suitable as a default.
`POCKET_MESH_GROUP_ONLY=true` enables eligible-span grouping at sample scale 1
to isolate widget/layer grouping from snapshot supersampling.

## Source provenance and scope

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected outside `pocket_host/`. Its `lib/render/pocket_ui_components.dart`
contains generic Canvas image fitting and filtered mip display helpers, but no
Live2D mesh renderer or supersampling path. The existing SDK source of truth is
`sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart`; its
`PocketCanvasPainter` consumes the real mesh DrawOps and performs the current
texture LOD selection. The 4× Hiyori capture differences documented in
`VISUAL_NOVEL_LOD_DENSITY_ABLATION.md` establish a measurable sampling gap, but
do not prove that this SSAA candidate improves perceived quality. One cropped
raster snapshot per compatible mesh span is the narrow adaptation under test.

## Candidate behavior

`PocketMeshSpanPainter` receives the actual ordered
`PocketCanvasPainter` partitions. It keeps each partition intact, so original
DrawOp order and texture batch boundaries remain. At a sample scale above 1, it
accepts only repeated-texture mesh-only spans and complete balanced normal
mesh-layer/mask groups. Non-mesh ops, host/video boundaries, malformed groups,
and non-srcOver layers break the span and use direct painting.

The candidate maps mesh points through the actual surface scale and DPR, rounds
the crop outward to physical pixels, adds a two-pixel margin, and intersects
the viewport. It records one temporary Picture at `DPR × sampleScale`, runs
the original partitions with that sampling DPR for mip selection, then draws
the crop to its exact physical-pixel-aligned destination with medium filtering.
It uses `toImageSync` and disposes the temporary image and Picture after the
canvas draw. It has no readback, image cache, or cross-frame raster state.

Requests above 4096 pixels on either side or 2,097,152 offscreen pixels fall
back to the original partitions. `PocketMeshSpanPainter` exposes actual span
paint calls, created and disposed snapshot handles, sampled-pixel and bypass
counters for tests and profile logs. Disposal counts release of the Dart image
handle; they do not measure GPU in-flight references or peak process memory.

## Same-frame captures

The frozen [source manifest](../.pocket-build/mesh-span-ssaa-ab-20261108/ready-before-profile/manifest.json)
records the Demo harness, Guest tuple and SDK source hashes used for these
captures. The A/B helper reads actual `PocketMeshSpanPainter` instances from
the live widget tree and expands their original partitions for baseline
painting. The `sampleScale=1` group path matched expanded baseline pixels
exactly in all eight framing/DPR pairs. This gates the grouping path against
the existing partition order, including mask and layer controls.

The `sampleScale=2` comparison calls the active widget-tree group painter. It
compares raw RGBA pixels from offscreen painter replays of the same captured
frame; it does not produce a perceptual score. Each pose also has a separate
ordinary `RepaintBoundary` screenshot. DPR 2 below is a 329×600 Flutter
test-view override yielding a 658×1200 replay, not physical Retina acceptance.

| Framing | DPR 1: 800×600 changed pixels | DPR 2: 658×1200 changed pixels |
| --- | ---: | ---: |
| full | 14,279 | 43,696 |
| closeup | 34,807 | 103,133 |
| full-idle0 | 15,335 | 46,243 |
| full-tapbody | 14,237 | 43,528 |

These are direct difference counts between the captured source-painter
sequence and active 2× group replay. The diagnostic replay created and disposed
one snapshot per pose, with zero budget, eligibility or failure bypasses. The
ordinary window capture and source/mip image facts are in
[`actual-desktop-dpr1`](../.pocket-build/mesh-span-ssaa-ab-20261108/actual-desktop-dpr1/manifest.json)
and
[`actual-mobile-dpr2`](../.pocket-build/mesh-span-ssaa-ab-20261108/actual-mobile-dpr2/manifest.json).

## Profile cost comparison

Three macOS Profile conditions used the same frozen Demo/SDK sources and Guest
tuple. Each ran five 10-second model windows and two lifecycle cycles at a
reported 60 Hz. The profile-ablation mode deliberately did not evaluate the
20-cycle RSS gate. All conditions retained the same source partitions and
Hiyori assets; grouping reduced the Pocket painter sequence from roughly
97–113 direct widgets to 18–19 entries with one grouped mesh span.

The build P95 entries below follow this scene order:
`hiyori_idle_0`, `hiyori_idle_1`, `hiyori_idle_1_closeup`,
`hiyori_idle_0_repeat`, `hiyori_idle_1_repeat`.

| Condition | Frame timings / over-budget | Build P95 by scene (ms) | Raster P95 range (ms) | Raster queue P95 range (ms) |
| --- | ---: | --- | ---: | ---: |
| Direct baseline (`GROUP_ONLY=false`, scale 1) | 1,932 / 22 (1.14%) | 15.113, 15.437, 14.646, 14.701, 15.043 | 1.000–1.033 | 0.041–0.045 |
| Group-only (`GROUP_ONLY=true`, scale 1) | 1,985 / 16 (0.81%) | 14.882, 14.937, 14.574, 14.855, 14.967 | 0.907–0.956 | 0.039–0.044 |
| Group SSAA (`GROUP_ONLY=true`, scale 2) | 2,096 / 22 (1.05%) | 15.805, 14.606, 14.697, 14.535, 15.033 | 0.468–0.544 | 0.574–0.683 |

All five build P95 values in every condition exceed the 12 ms target. The
baseline and SSAA2 over-budget ratios also exceed the 1% target; group-only is
below 1% for this run. Do not read the lower SSAA2 raster P95 in isolation:
its raster-queue P95 increased to 0.574–0.683 ms, while total-span P95 ranged
25.489–26.855 ms. `toImageSync` schedules snapshot work on the raster runner,
and `FrameTiming.rasterDuration` may not include all of that task's cost.
FrameTiming total span is not used as a jank gate because UI and raster phases
can overlap. The 33.334 ms adjacent `vsyncStart` interval P95 describes timing
sample cadence, not presented FPS.

Across the five SSAA2 windows, `snapshotCount` equaled
`disposedSnapshotCount` (294–326 snapshots per window), with zero bypasses.
This counts Dart `ui.Image` handle disposal, not GPU in-flight completion.
Decoded source/mip image counts exclude those temporary snapshots. The two
cycle run does not measure stable RSS, peak GPU memory or memory bandwidth.
No cost result establishes a performance win; the experiment remains opt-in.

Raw timing logs and per-window JSON are under
[`cost-baseline`](../.pocket-build/mesh-span-ssaa-ab-20261108/cost-baseline/manifest.json),
[`cost-group1`](../.pocket-build/mesh-span-ssaa-ab-20261108/cost-group1/manifest.json)
and
[`cost-ssaa2`](../.pocket-build/mesh-span-ssaa-ab-20261108/cost-ssaa2/manifest.json).
These measurements refer to painter SHA
`713e80a58de77dc0f7f4e2d8bdcb04b111c1688fe772bb328ce66f879fad8abe` and view
SHA `ce4c4ff9a0b92983475684184baa4ad44b50946744a0d272e3fcf59cdee891fa` in the
frozen source manifest. Later source changes are not covered by this result.

## Rejected near-deadline ticker variation

A separate five-window Profile run added the opt-in
`POCKET_NEAR_DEADLINE_TICKER` branch to `pocket_view.dart`. It kept the existing
vsync ticker active when a positive guest wake delay fit within one display
interval. The painter and four Demo harness files were unchanged; this run has
a separate
[source snapshot](../.pocket-build/mesh-span-ssaa-ab-20261108/near-deadline-ready/manifest.json)
and
[cost archive](../.pocket-build/mesh-span-ssaa-ab-20261108/cost-near-deadline/manifest.json).

| Scene | `nativeCalls`, prior SSAA2 → ticker flag | Build P95 ms, prior → ticker flag | Total-span P95 ms, prior → ticker flag |
| --- | ---: | ---: | ---: |
| `hiyori_idle_0` | 355 → 333 | 15.805 → 15.327 | 26.855 → 26.574 |
| `hiyori_idle_1` | 397 → 320 | 14.606 → 15.552 | 25.489 → 26.753 |
| `hiyori_idle_1_closeup` | 384 → 361 | 14.697 → 14.743 | 25.784 → 26.185 |
| `hiyori_idle_0_repeat` | 393 → 345 | 14.535 → 15.056 | 25.737 → 26.308 |
| `hiyori_idle_1_repeat` | 395 → 346 | 15.033 → 15.311 | 25.703 → 26.601 |

`nativeCalls` fell in every window, but the delivered `FrameTiming` count also
changed from 2,096 to 1,712 across the five windows. Build P95 improved in two
scenes and worsened in three; total-span P95 improved only in `hiyori_idle_0`.
The new build P95 values remain above 12 ms. These are single five-window runs
with different view-source hashes, not a randomized or repeated causal test.
They do not establish a latency or efficiency win. The root task rejected this
variation and will remove its flag; the SSAA experiment remains opt-in and no
near-deadline policy should be retained based on these observations.

## Full 20-cycle result

The final production-source run used `POCKET_MESH_SUPERSAMPLE=2` without the
rejected ticker flag. It captured 12 timed windows and completed 20 real model
re-entry/release cycles. The source and Demo harness are frozen in
[`final-production-ready`](../.pocket-build/mesh-span-ssaa-ab-20261108/final-production-ready/manifest.json);
the complete log, report, 12 windows and 20 cycle records are in
[`final-full20`](../.pocket-build/mesh-span-ssaa-ab-20261108/final-full20/manifest.json).

The per-cycle SSAA allocation check passed: every cycle produced snapshots at
entry, created and disposed counts matched at entry and return, all 20 cycles
accounted for 8,075 created and 8,075 disposed snapshot handles, and there
were zero budget, ineligible or snapshot-failure bypasses. Every cycle also
returned with zero active Live2D handles and zero Hiyori draw ops.

The overall run **failed** the unchanged RSS stability gate. Post-release
windows for cycles 7–10 were unstable. The first-five versus final-five RSS
medians grew by 180,224 bytes (0.028679%), which passed both the 20 MiB and
10% growth limits, but all per-cycle windows must also be stable. The driver
exited with the required `model-stable-rss` checkpoint incomplete. The result
does not establish stable RSS or a leak-free SSAA path; the gate has not been
weakened.
