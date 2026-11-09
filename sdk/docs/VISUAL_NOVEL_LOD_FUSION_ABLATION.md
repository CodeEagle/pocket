# Visual novel mesh LOD fusion ablation

## Retained source and SDK adaptation

The retained parent renderer at `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` contains a generic `PocketCanvas2DPainter`: it iterates the legacy primitive `drawList` and uses `frameRevision`, DPR, and list length to decide repainting. It has no texture-triangle mesh path or per-mesh minification selection. The current SDK's mesh painter and repeat-texture LOD are an evidenced adaptation for Live2D geometry, not a duplicate parent renderer.

## Candidate and decision

The candidate fused the repeated-texture batch's density calculation with position/color assembly in `pocket_view_painter.dart`. It reused the three point locals while preserving the area formula and accumulation order, then built texture coordinates with the same `uv * selectedImageDimension` operations after choosing a level. It added no scratch UV array, extra `Offset` allocation, or renderer state. The no-LOD path was left unchanged.

The candidate was withdrawn. Two alternating baseline/candidate pairs produced matching rendered-pixel hashes, while the candidate's recording microbenchmark was consistently slower. Production `pocket_view_painter.dart` is restored byte-for-byte to baseline SHA-256 `8e2227bf0c6b1fbab9d35d5405a5f194bbe6ee0e64effbce1344763f3f07598e`.

## Measurement

The temporary diagnostic rendered the same 329×600 canvas containing 2,844 repeated-texture triangles from a 256×256 checker texture and 128/64/32 LOD images. It used eight warmup paints, then timed 32 `PocketCanvasPainter.paint` calls into a `PictureRecorder`; it did not rasterize the timed picture. Both versions produced raw-RGBA FNV-1a `c76751c5` for the separately rasterized fixture.

| Order | Painter | Elapsed / 32 paints | Mean per paint | Raw-RGBA hash |
|---|---|---:|---:|---|
| First pair | Baseline | 10,812 µs | 337.875 µs | `c76751c5` |
| First pair | Candidate | 12,038 µs | 376.188 µs | `c76751c5` |
| Reverse pair | Candidate | 12,455 µs | 389.219 µs | `c76751c5` |
| Reverse pair | Baseline | 11,128 µs | 347.750 µs | `c76751c5` |

The candidate was 11.3% slower in the first pair and 11.9% slower in the reverse pair. This measures the painter's synchronous canvas-recording path for one synthetic mesh; it is not a raster-time, frame-rate, or whole-game result. The lack of improvement is enough to reject this local fusion candidate, not to attribute the game's full cost to this loop.

The temporary painter source copies, diagnostic test, and exact logs are under ignored `sdk/.pocket-build/novel-lod-fusion-ablation-20261108/`. The test source was removed from the package test tree after the ablation. Existing mesh sampling/effect/group regression results remain the production baseline; root reports the related 24 tests plus the five recent medium-sampling checks passed against the restored source.

## Commands and evidence

Both variants used the pinned Flutter command from `sdk/packages/pocket_flutter`:

```sh
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test --no-pub --reporter expanded test/pocket_mesh_lod_fusion_perf_test.dart
```

The baseline/candidate logs are `perf-baseline.log`, `perf-candidate.log`, `perf-candidate-reverse.log`, and `perf-baseline-reverse.log` in the ignored evidence directory. The saved baseline painter and restored production painter have identical SHA-256 `8e2227bf0c6b1fbab9d35d5405a5f194bbe6ee0e64effbce1344763f3f07598e`.
