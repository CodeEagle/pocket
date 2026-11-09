# Visual Novel Mesh Block Ablation

## Current rendering and baseline

`_PocketViewState._buildSurface` in `sdk/packages/pocket_flutter/lib/src/pocket_view.dart` emits full-size `CustomPaint` blocks at 32 DrawOps, except that an active mesh layer remains whole until its matching restore. A `PocketHostSurfaceOp` flushes the current block before inserting the host surface, preserving draw order. Each block has its own `RepaintBoundary`.

Within a painter, `PocketCanvasPainter._drawTextureTriangleBatch` in `sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart` coalesces only adjacent textured triangles with the same asset, color, repeat mode, and clip. It selects one mip for that batch using aggregate UV area divided by physical screen area. Consequently, increasing the painter block size changes both batch membership and LOD selection when a matching mesh batch crosses the old 32-op boundary. That is a rendering-semantic change, not only a reduction in retained widgets.

The frozen Guest baseline used Flutter 3.47.9 macOS Profile on the current 32-op implementation. It ran five 10-second Hiyori windows and two model handle cycles. The five windows reported these values:

| Window | Hiyori triangles | Max frame ops | `canvasPaints` | Texture batches | Native p95 (ms) | Build p95 (ms) | Raster p95 (ms) | Over-budget frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `hiyori_idle_0` | 3,183 | 3,475 | 28,554 | 32,441 | 9.996 | 14.932 | 1.019 | 3 |
| `hiyori_idle_1` | 3,199 | 3,518 | 28,986 | 33,678 | 10.371 | 15.380 | 1.059 | 6 |
| `hiyori_idle_1_closeup` | 2,697 | 3,013 | 25,164 | 30,565 | 11.169 | 15.750 | 1.293 | 16 |
| `hiyori_idle_0_repeat` | 3,183 | 3,474 | 27,384 | 31,185 | 10.153 | 15.358 | 1.010 | 6 |
| `hiyori_idle_1_repeat` | 3,199 | 3,518 | 28,766 | 33,384 | 10.477 | 15.547 | 1.171 | 8 |

Across 2,015 frame timing samples, 39 were over budget (1.94%). The archived baseline log, summary, and source snapshots are in `sdk/.pocket-build/mesh-block-ablation-20261108/baseline/`; the original log is `/tmp/pocket-mesh-block-baseline-20261108.log`. The Profile run completed with exit 0. Its two handle cycles both removed the Hiyori triangles and six mesh LOD images on exit. This is a short ablation baseline, not a stable-RSS soak or device acceptance run.

## Mixed-density pixel gate

A one-time synthetic widget test placed 32 high-minification triangles followed by one magnified triangle. All triangles shared one repeated-texture asset and compatible batch keys. At the production 32-op partition, the first batch selected an 8×8 mip and the second retained the 64×64 source. When rendered in one 512-op painter, the aggregate density selected the 16×16 mip for both regions.

The Flutter 3.47.9 test passed both assertions and measured 2,116 differing pixels in a 128×96 RGBA output. FNV-1a-32 hashes were `d9caaf85` for the preserved 32-op partition and `a2cf679d` for the merged candidate. The high-density sample changed from yellow 8×8 to blue 16×16; the low-density sample changed from red source to blue 16×16.

The temporary test source, run log, and hash manifest are archived under `sdk/.pocket-build/mesh-block-ablation-20261108/mixed-density/`. The persistent `pocket_view_mesh_group_test.dart` was restored to its original masked-group coverage after this diagnostic. This fixture proves that a 512-op merge changes LOD and pixels for a mixed-density same-asset batch; it does not prove that Hiyori's current image is visibly degraded. Therefore, 512 is not adopted as a behavior-preserving layer-count optimization.

## Actual Hiyori batch diagnostic

`demo/integration_test/novel_mesh_lod_diagnostics.dart` reads the actual `PocketCanvasPainter` objects independently and in production order. `POCKET_MODEL_LOD_DIAGNOSTICS=true` prints its result at each Hiyori capture in `novel_model_showcase_test.dart`. It preserves every current painter boundary and reports the current aggregate-density mip alongside a candidate selection based on the minimum valid triangle density in that batch.

The DPR2 Profile run passed against the frozen Guest tuple (`app.qjbc` `9c01ae0d…`, `app.pak` `3d775a1f…`) at 329×600 logical pixels, producing 658×1200 captures. Every reported triangle density was valid and every batch minimum was above zero. The candidate selection would choose a higher-resolution existing mip in these batches:

| Framing | Hiyori batches | Higher-resolution candidate | Candidate transition counts | Aggregate density range | Min triangle density range | p50 triangle density range |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| `full` | 110 | 6 | 4× 512→1024, 2× 256→512 | 4.614–9.268 | 2.762–6.846 | 4.934–9.647 |
| `closeup` | 95 | 16 | 16× 1024→2048 | 2.035–2.483 | 1.271–1.998 | 2.025–2.662 |
| `full-idle0` | 114 | 13 | 10× 512→1024, 3× 256→512 | 4.525–8.581 | 3.493–6.582 | 4.827–9.382 |
| `full-tapbody` | 109 | 5 | 3× 512→1024, 2× 256→512 | 4.801–8.640 | 3.820–6.870 | 4.938–8.933 |

These are candidate LOD transitions computed from DrawOps. The run did not rerender with the candidate mip or compare candidate Hiyori pixels, so it does not establish that the current Hiyori frame is blurred or that the candidate improves its appearance. The complete raw JSON, four production-partition PNGs, test source, helper source, and driver log are archived under `sdk/.pocket-build/mesh-block-ablation-20261108/actual-lod-dpr2/`. The manifest records their hashes and the run tuple.

The whole-batch minimum-density rule was not adopted: its synthetic mixed-density test improved one local detail while substantially worsening a strongly minified gray area. This is a synthetic sampling tradeoff, not evidence of Hiyori image degradation. The separate per-triangle local-LOD candidate preserved triangle order and mesh mask/clip operations, but later same-frame captures and the one cost pass did not justify retaining it. It remained opt-in and default-off; the experimental local-LOD and native-mip branches are rejected, with the aggregate selector retained as the production policy.

A frozen-frame A/B ran in Flutter 3.47.9 macOS Profile at DPR2 with `POCKET_MESH_LOCAL_LOD=true`. Its baseline aliases each original production Hiyori batch to the existing image selected by the old aggregate rule; its candidate uses the original Hiyori ops and shared source/mip map through the per-triangle candidate painter. It preserves original painter partitions and complete mesh groups, then records raw pixel differences and both PNGs. The alias fixture passed: separate 32-op high- and low-density batches sampled the expected 8×8 yellow mip and 64×64 red source through the aliases.

The four per-capture comparisons reported these raw differences at 658×1200 pixels:

| Framing | Differing pixels | Max channel delta | Sum absolute channel delta |
| --- | ---: | ---: | ---: |
| `full` | 83 | 62 | 2,424 |
| `closeup` | 9,090 | 80 | 100,816 |
| `full-idle0` | 147 | 122 | 6,303 |
| `full-tapbody` | 78 | 48 | 1,886 |

These counts show that the candidate changes actual Hiyori raster output in these captured poses. They do not measure perceived quality or establish an overall sharpness improvement. The 4× candidate raster is included as a separate medium-filtered reference and is not a performance result. All 12 diagnostic images, four ordinary captures, four JSON records, alias fixture, driver checkpoint, log, and source manifest are archived under `sdk/.pocket-build/mesh-conservative-lod-ab-20261108/actual-ab-dpr2/`.

The per-triangle candidate advances individual triangles to a higher mip only where their local density allows it. The affected batches can sample up to the original 2048² source instead of a 1024² or lower mip, increasing the nominal image area by 4× for those triangles. Its separate five-window Flutter 3.47.9 macOS Profile run completed with `POCKET_MESH_LOCAL_LOD=true`, the same frozen Guest tuple, and two model handle cycles. The paired 32-op baseline run is archived under `sdk/.pocket-build/mesh-block-ablation-20261108/baseline/`; candidate log and summary are under `sdk/.pocket-build/mesh-conservative-lod-ab-20261108/local-lod-cost-profile/`.

| Window | Native p95 (ms), baseline→candidate | Build p95 (ms), baseline→candidate | Raster p95 (ms), baseline→candidate | Over-budget frames, baseline→candidate | Texture triangle batches, baseline→candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hiyori_idle_0` | 9.996→9.742 | 14.932→14.845 | 1.019→1.038 | 3→2 | 32,441→35,386 |
| `hiyori_idle_1` | 10.371→9.784 | 15.380→15.114 | 1.059→1.060 | 6→5 | 33,678→38,032 |
| `hiyori_idle_1_closeup` | 11.169→9.747 | 15.750→14.612 | 1.293→1.243 | 16→3 | 30,565→87,854 |
| `hiyori_idle_0_repeat` | 10.153→9.999 | 15.358→13.760 | 1.010→1.030 | 6→3 | 31,185→33,361 |
| `hiyori_idle_1_repeat` | 10.477→9.771 | 15.547→14.568 | 1.171→1.052 | 8→5 | 33,384→39,855 |

The baseline recorded 2,015 frame timings with 39 over-budget frames (1.94%); the candidate recorded 2,063 timings with 18 (0.87%). Across the windows, texture triangle batches increased from 161,253 to 234,488 (+45.3%). The closeup window rose from 30,565 to 87,854 batches (2.87×), while its raster p95 moved from 1.293 ms to 1.243 ms in this run. These are single, non-randomized short runs, so the lower candidate p95 and over-budget counts do not establish a repeatable performance gain. This test did not measure GPU texture bandwidth. Both runs used two cycles against a 20-cycle stable-RSS gate, which remains unevaluated. The candidate does not add decoded image levels in this run; its risk is more triangle draw batches and potentially greater sampling traffic for triangles that use larger existing mips.

## Next decision gate and constraints

The local-LOD same-frame A/B and one cost pass are complete. Keep the aggregate selector as the production policy. The candidate’s timing observations were one short, unbalanced run and do not establish a performance gain; no candidate performance acceptance was run. The native-mip rejection and its different reference limits are recorded separately in `sdk/docs/VISUAL_NOVEL_NATIVE_MIP_ABLATION.md`.

The archived `POCKET_MODEL_EDGE_ABLATION` diagnostic created and disposed full raster images; at DPR2 each framing recorded four temporary supersample images and six output images. It was evidence about edge samples only, not a production SSAA implementation. A future single model-surface raster experiment is separate and has no performance acceptance evidence yet. No second renderer, fake source-texture upscaling, or physical Retina acceptance is claimed here.
