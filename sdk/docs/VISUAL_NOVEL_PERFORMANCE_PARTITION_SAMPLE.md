# Partition-construction sample

## Decision

Do not replace `canvasOps.sublist(start, end)` in this pass. Its directly timed
copy cost was 0.001 ms P95 per partition block, 13.649 ms summed over the five
10-second model windows, or about 0.087% of their aggregate Flutter build
duration. The broader partition-construction interval reached only 0.273 ms
P95 per `_buildSurface` call and represented 1.672% of aggregate build time.
Both are below the existing go/no-go gates of 0.5 ms P95 or 5% of build time.
Those gates and the proposed one-variable change are described in the
[next whole-game ablation plan](VISUAL_NOVEL_PERFORMANCE_NEXT_ABLATION.md).

This is candidate attribution for the copied source snapshot. It is not a
whole-game performance acceptance or a claim that the game has no stutter.

## Source path and measurement

The current implementation is in [`pocket_view.dart`](../packages/pocket_flutter/lib/src/pocket_view.dart):

- `_buildSurface` starts at line 7084 and gathers non-video drawing ops into
  `canvasOps`.
- `flushCanvas` starts at line 7098. It preserves order around host surfaces
  and video ops, and groups complete mesh-layer scopes.
- `addCanvasBlock` at line 7131 passes `canvasOps.sublist(start, end)` to a
  `PocketCanvasPainter`; the walk keeps the existing 32-op partition boundary
  and does not split a mesh layer.
- The candidate measured here is only that per-block list copy. Painter
  creation, mesh-span eligibility, rasterization, native model updates, and
  GPU work remain separate costs.

The scratch-only instrumentation used a monotonic `Stopwatch` and integer
microseconds. It recorded each non-empty `flushCanvas`, each partition block,
the `sublist` call, and a surface-build interval. It added no per-op events and
did not change block size, order, pixels, mesh supersampling, or Guest data.
The surface-build timer begins after the size guard and stops after scene,
semantics, and glass composition but before the final gesture, listener, and
`SizedBox` wrappers. Treat that value as a lower-bound interval for the whole
method. Partition timing covers the complete non-empty flush.

The existing harness in
[`novel_model_soak_test.dart`](../../demo/integration_test/novel_model_soak_test.dart)
supplied `FrameTiming` and native frame-call observations. The first timed run
used one 10-second `manual_reading` window and the five 10-second Hiyori model
windows. It ran in Profile mode on the accepted Lantern Guest and accepted
macOS archive:

- Guest `app.qjbc`: `bb9062ed6d665bbe1af5dab6378b82af2ecf0c32cac0bafd6e304c87ad0fcd6f`
- Guest `app.pak`: `e5f148e7a50f81631b7862b94ea075cd78a9cc6fc5b4d7c32ecf3c97942a2e73`
- `libpocket_flutter.a`: `c09125b5764660c632da30884aaac11190135b95090fe53d6a88651bd9b5d601`
- Flutter 3.47.9 stable, Dart 3.13.7; `POCKET_MESH_SUPERSAMPLE=2`; macOS 27.0.1 build 26A434, Mac16,10 / Apple M4; display reported 60 Hz.

The scratch app used bundle identifier
`com.example.pocketHost.partitionSample`, and the test redirected app support
to a temporary directory. The ordinary app and its store were not opened or
modified. Scratch source, dependencies, the two required Live2D macOS
xcframeworks, build output, and logs are under
[`performance-partition-sample-20261109`](../.pocket-build/performance-partition-sample-20261109/).
The scratch lockfile was resolved with Flutter 3.47.9 because the copied root
lockfile did not satisfy the current SDK; no root package configuration or
lockfile was changed. Six transitive dependencies were updated only in the
scratch lockfile.

The measured run was launched from the scratch `demo/` directory with:

```sh
env -u POCKET_NATIVE_LIBRARY \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive \
  --profile --no-pub \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/novel_model_soak_test.dart -d macos \
  --dart-define=POCKET_NOVEL_PROFILE_ABLATION=true \
  --dart-define=POCKET_MESH_SUPERSAMPLE=2
```

## Results

Times are milliseconds. “Partition share” is summed instrumented partition
time divided by summed `FrameTiming.buildDuration` for that same window; it is
a ratio, not per-frame source attribution.

| Window | Frames | Native call P50 / P95 | Build P95 | Raster P95 | Surface interval P50 / P95 | Partition P50 / P95 | Partition share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Manual reading | 600 | 0.650 / 2.747 | 3.107 | 2.210 | 0.019 / 0.052 | 0.013 / 0.038 | 1.172% |
| Hiyori Idle 0 | 554 | 2.730 / 9.523 | 10.498 | 3.282 | 0.209 / 0.317 | 0.169 / 0.257 | 1.753% |
| Hiyori Idle 1 | 504 | 7.484 / 9.039 | 11.218 | 0.623 | 0.203 / 0.332 | 0.165 / 0.273 | 1.979% |
| Hiyori close-up | 469 | 7.579 / 9.020 | 12.269 | 0.666 | 0.173 / 0.271 | 0.139 / 0.222 | 1.537% |
| Hiyori Idle 0 repeat | 485 | 7.644 / 8.885 | 12.661 | 0.550 | 0.192 / 0.299 | 0.156 / 0.238 | 1.607% |
| Hiyori Idle 1 repeat | 391 | 8.610 / 10.276 | 14.576 | 0.689 | 0.210 / 0.326 | 0.171 / 0.262 | 1.564% |

Across the five model windows, the harness collected 2,403 `FrameTiming`
samples and 1,816 native-call samples. Summed model-window build duration was
15,624.395 ms; surface intervals summed to 320.769 ms; partition intervals
summed to 261.175 ms. The weighted partition share was 1.672%. The highest
per-window partition P95 was 0.273 ms. The separately timed `sublist` calls
copied 4,968,694 op references in 148,971 blocks; their summed measured time
was 13.649 ms across all five model windows. The `sublist` P50 rounds to
0.000 ms at the `Stopwatch` microsecond resolution; treat it as below 1 µs,
not as proof that each copy costs exactly zero.

`FrameTiming` build, raster, and total-span P50 were not emitted by the first
timed run. Their raw per-frame samples were not persisted, so those P50 values
cannot be reconstructed offline. Native-call, surface-interval, and partition
P50/P95 are present in the log. A follow-up that added the missing FrameTiming
P50 fields did not mount an app widget or produce a timing window; it was
stopped without using its output as evidence.

## Run status and provenance

All six timed windows were emitted before the test reached its optional
handle-cycle check. The first native handle release passed; the test then
failed while entering the second optional cycle because the expected `Idle 0`
action was absent after the route had returned to Lantern text. Therefore the
integration test did not produce its final acceptance report. This failure is
after the measured windows and does not invalidate those timed rows, but the
run must not be described as a passing full-suite acceptance.

The scratch tree was copied on 2026-11-09 around 09:28 +08:00. Before
instrumentation, `pocket_view.dart` had SHA-256
`0a39a86c850aff2102c00800c3c6c3b66ee5eb79fd76319476eeaa4c0695b56e` and the
harness had SHA-256
`bf55522530950ccbeb08fc0a355aec0dde9e1e0a2cb2b93128e535bd05041f48`. The
first timed run used instrumented hashes `c43cfc57d5d17e64fec2a42b4387a53c9aa26268e51c3e4839771b0e3f17eb1a` and
`b536544d65a6d9c578cdf28d96b192a8b39875c316490a64323bd8ff41799e3e`,
respectively. The exact scratch instrumentation is retained in
[`pocket_view.instrumentation.diff`](../.pocket-build/performance-partition-sample-20261109/logs/pocket_view.instrumentation.diff)
and
[`novel_model_soak_test.first-run.diff`](../.pocket-build/performance-partition-sample-20261109/logs/novel_model_soak_test.first-run.diff).

The root `pocket_view.dart` later received unrelated safe-area and first-frame
changes. At the 10:00 +08:00 source check its full-file hash was
`edea66e9a7bf6d67954d5053b0bb1722af1d92e562398da7f5662d375c2e52b0`; the
extracted `_buildSurface` method was byte-for-byte equal to the captured source
method. The result is therefore relevant to this partition path, but it is not
a final build measurement of every current app source change.

Evidence: [machine-readable window summary](../.pocket-build/performance-partition-sample-20261109/sample-summary.json),
[scratch setup and hashes](../.pocket-build/performance-partition-sample-20261109/setup.json),
[first-run log](../.pocket-build/performance-partition-sample-20261109/logs/flutter-drive-profile-two-cycle-attempt.log),
[FrameTiming follow-up log](../.pocket-build/performance-partition-sample-20261109/logs/flutter-drive-zero-cycles-preframe-hang.log),
the [follow-up diagnosis](../.pocket-build/performance-partition-sample-20261109/logs/zero-cycle-preframe-diagnosis.json),
the [evidence integrity check](../.pocket-build/performance-partition-sample-20261109/evidence-integrity.json),
and [key artifact hashes](../.pocket-build/performance-partition-sample-20261109/logs/key-hashes.json).
The sample is macOS-only and does not measure GPU completion, memory
bandwidth, or other shipped platforms. `FrameTiming` remains aggregate
Flutter timing, while the partition timer provides the direct source-level
measurement. No runtime optimization was applied.
