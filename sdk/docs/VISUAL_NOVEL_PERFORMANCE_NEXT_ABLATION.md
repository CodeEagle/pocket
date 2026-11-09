# Next whole-game performance ablation

## Recommendation

The strongest source-backed candidate is the remaining per-block
`canvasOps.sublist(start, end)` copy in `PocketView._buildSurface`. Replace it
only if a small Profile trace confirms that partition construction is a
material part of UI-thread build time. This is a measurement proposal, not a
claim that this copy currently causes the game's stutter.

The 2026-11-09 scratch sample measured the largest model-window partition P95
at 0.273 ms and weighted partition share at 1.672%, below both gates; keep this
candidate deferred unless new evidence changes those figures. See the
[partition sample](VISUAL_NOVEL_PERFORMANCE_PARTITION_SAMPLE.md).

The current 2026-11-09 baseline shows that animated model windows have a high
Flutter build phase: five 10-second Hiyori windows have build P95 of
12.957–14.536 ms (median 13.629 ms), raster P95 of 0.507–0.570 ms, and native
frame-call P95 of 10.156–11.427 ms. The live model has 2,697–3,199 texture
triangle ops and 97–113 Canvas partitions in those windows. Manual reading is
lower at build P95 8.484 ms with 2/570 frames over budget; the mostly static
menu windows make no guest frame calls. The model build phase is the best
measured area to investigate, but these observations do not establish
whole-game stutter. The five model windows recorded 35/1,941 over-budget
FrameTiming samples (1.8%). The existing report does not attribute build time
to any Dart function.

This proposal concerns a copy in the shared typed Canvas path. It does not
change Live2D geometry, sampling scale, texture resolution, or pixels as a
performance tradeoff.

## Source-first review

The retained parent was reviewed outside `pocket_host/`:

- `pocketjs_flutter_demo/lib/core/perf_monitor.dart:84-115` passively collects
  Flutter `FrameTiming` and reports aggregate build/raster durations. Reuse
  that passive measurement boundary; it cannot identify an individual build
  function.
- `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:3913-4008` paints
  the parent’s map-based `DrawList` through one `PocketCanvas2DPainter`. It has
  no typed `PocketOp` partitions, texture-triangle groups, or range-backed
  painter input to migrate. The new SDK path therefore needs its own typed-list
  adaptation; the old painter is not a feature-equivalent replacement.

The current SDK ownership point is
[`pocket_view.dart`](../packages/pocket_flutter/lib/src/pocket_view.dart):

- `_buildSurface` creates `canvasOps` at line 7076. `addCanvasBlock` passes
  `canvasOps.sublist(start, end)` to each painter at lines 7110–7121.
- The block walk preserves the 32-op boundary and complete mesh-layer groups
  at lines 7131–7148. `flushCanvas` then clears the builder list at line 7150.
- Non-video drawing ops, including `PocketTextureTriangleOp`, enter
  `canvasOps` at lines 7351–7353. A block's `sublist` copies each of its op
  references into a new list.
- The 2026-11-08 list-copy ablation already removed the outer `List.of`
  wrappers around these snapshots. This proposal examines only the remaining
  `sublist` copy; it does not repeat the removed wrapper work.

`PocketCanvasPainter` accepts a `List<PocketOp>` and reads it by index and
iteration. A read-only range view can satisfy that contract without changing
the painter or rendering operations. The source builder must be sealed after a
flush: because `flushCanvas` can occur before a host surface or video op, a
range view must retain its own backing list while later Canvas ops go into a
new builder list. Clearing and reusing the same backing list would invalidate
old painter ranges.

## Existing evidence and its limits

The frozen baseline report is
[`profile-evidence.json`](../.pocket-build/performance-next-20261109/profile-evidence.json).
The underlying run used the pinned Flutter 3.47.9 Profile build, macOS at a
reported 60 Hz, and `POCKET_MESH_SUPERSAMPLE=2`. The `pocket_view.dart` and
`pocket_view_painter.dart` hashes match the inspected SDK sources. The run
recorded seven whole-game windows and five 10-second model windows, but its
drive exited 1 because the stable-RSS gate failed: 16/20 cycle windows were
stable, and positive growth was about 38.6 MB, beyond the existing 20 MiB
limit. Treat its frame metrics as recorded observations, not an accepted
performance result. The ordinary store was preserved.

In each Hiyori model window, the painter inventory reports 97–113 Canvas
partitions and 2,697–3,199 Hiyori triangle ops. `canvasOps` is divided among
those partitions without overlap, so one complete surface reconstruction
copies each Canvas op reference once through the per-block `sublist` calls and
allocates one list per partition. At minimum, the Hiyori triangle ops are part
of that copied Canvas list. The exact `canvasOps.length`, number of
`_buildSurface` calls, and number of range snapshots built per window are not
currently recorded; multiplying these inventory counts by native frame calls
would overstate what the trace proves.

The older `model-cpu-sampling-20261108` sample is explicitly marked as a native
call-stack diagnosis, not a controlled frame-cost comparison. It includes
unresolved AOT Dart offsets and cannot attribute time to `_buildSurface` or
`List.sublist`. The current profile reports aggregate frame timings and paint
inventories, not Dart allocation bytes or source-level CPU samples. Therefore
there is not enough evidence to claim that removing this copy will materially
reduce stutter.

## Minimum sample before changing runtime code

In an isolated scratch build, add the same temporary counters and timeline
scopes to both baseline and candidate. Do not ship the instrumentation. Capture
these values during the existing whole-game workload and the five animated
model windows:

- `_buildSurface` invocation count and total/P50/P95 synchronous duration;
- `flushCanvas` count, `canvasOps.length` per flush, and Canvas partition count;
- baseline `sublist` calls and `sum(end - start)` copied op references;
- existing `FrameTiming` build/raster durations, native-call durations,
  over-budget count, painted ops, and RSS.

Use a trace marker around a whole surface build and around partition creation;
avoid a per-op event that would dominate the work being measured. The first
gate is whether partition construction itself reaches either 0.5 ms P95 per
surface build or 5% of cumulative Flutter build duration during animated
windows.
If neither threshold is reached, stop and keep the current code. That result
would show that the source-level copies are too small to justify another
runtime abstraction.

## One-variable A/B

If the sample passes the gate, change only the per-block list representation:

| Baseline | Candidate |
| --- | --- |
| `sublist(start, end)` copies op references into one new list per block | A read-only range view indexes a sealed backing list; each flush hands off its builder and starts a fresh builder for later Canvas ops |

Keep the block size, draw order, mesh-layer grouping, painter count, hit
testing, assets, Guest bytecode, compiler, native library, and supersampling
setting identical. Do not add a cache, alter the Flutter render schedule, or
change any geometry. Instrumentation is identical in both variants.

The structural expectation is specific: baseline copies `canvasOps.length`
op references per completed Canvas sequence and creates one copied list per
partition; the candidate copies zero op references for those ranges and still
creates one lightweight range view per partition. Report the observed flush
and partition counts rather than inferring a per-frame multiplier from native
calls.

## Behavior and visual regression

Require all of the following before accepting the candidate:

1. In `pocket_view_mesh_group_test.dart` and `pocket_view_input_test.dart`,
   preserve block order, balanced mesh grouping, pointer hit behavior, and
   painter invalidation. Add a case with multiple Canvas flushes separated by
   a host surface and video op; mutating a later builder must not change an
   already-mounted earlier range.
2. For a fixed `PocketFrame`, compare the full ordered op sequence and captured
   PNG pixels between the copied-list and range-view variants. Include a mesh
   mask group and a texture-triangle batch. Pixel output must be identical.
3. Run the actual game controls in `novel_performance_test.dart` and
   `novel_model_showcase_test.dart`: enter the chapter, reveal and manually
   advance dialogue, open/close player panels, and use real taps to change the
   Hiyori pose. Compare the same fixed-state captures and check that active
   model/resource counts return to zero after exit.
4. Repeat the whole-game and model profile workloads below in three paired,
   alternating-order Profile runs from isolated copies. Keep all non-Dart
   source and asset hashes identical. Require every pair to complete the
   existing storage and RSS gates.

The performance result is acceptable only if the copied-reference counter
falls to zero, the five-window median build P95 improves by at least 0.5 ms and
5% in all three pairs, the manual-reading and other game windows do not regress
by more than 0.5 ms P95, and over-budget frames do not increase. Report raster and
native-call timings alongside build time; they are separate boundaries. If
allocation counts fall but timing does not meet this bar, reject the change as
a whole-game performance optimization.

## Reproduction commands

Run the commands from an isolated `demo/` copy for each variant. The same
Profile command measures the authored launch, reveal, reading, menu, save/load,
advance, and rollback inputs:

```sh
env -u POCKET_NATIVE_LIBRARY \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive \
  --profile --no-pub \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/novel_performance_test.dart -d macos \
  --dart-define=NOVEL_PROFILE_VARIANT=range-view-ablation \
  --dart-define=POCKET_MESH_SUPERSAMPLE=2
```

The long-window run measures the same seven game windows, five animated model
windows, and 20 model entry/exit cycles:

```sh
env -u POCKET_NATIVE_LIBRARY \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive \
  --profile --no-pub \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/novel_model_soak_test.dart -d macos \
  --dart-define=POCKET_MESH_SUPERSAMPLE=2
```

These are macOS measurements only. Before generalizing the result to the
all-platform SDK, repeat the accepted single-variable comparison on every
shipped host, including Android/iOS and any supported Windows/Linux paths.
`FrameTiming` build/raster duration is not presented FPS, and the native-call
stopwatch includes the existing bridge transfer/decode boundary.

## Work performed in this review

This review read the retained parent, source, and existing profile files. It
did not start Flutter, edit runtime code, alter the native library, touch an
accepted artifact, or modify the running Demo or its store.
