# Fixed-LOD Live2D edge sampling ablation

## Result and scope

The current Hiyori Guest was exercised through the ordinary player at 329×600, with injected DPR 1 and 2. Both macOS Profile runs passed. Each run captured full body, closeup, idle motion, and body-tap motion. The 48 diagnostic PNGs compare the same frozen operations at 1×, 2×, and 4× raster sampling, with production DPR and texture LOD inputs held constant. Eight additional captures retain the ordinary composition.

The 2× output is closer to the 4× diagnostic reference along the outer silhouette in all eight observations. This establishes a difference between diagnostic sample factors in addition to the previously repaired integer vertex coordinates. It does not prove that the production window has no geometry antialiasing. It does not establish a production performance budget or a physical Retina result, and no per-frame supersampling implementation is enabled by this experiment.

| DPR | Framing | 1× edge PM-RGBA MAE | 2× edge PM-RGBA MAE | Error reduction against 4× diagnostic reference |
| --- | --- | ---: | ---: | ---: |
| 1 | Full | 2.352 | 0.502 | 78.6% |
| 1 | Closeup | 2.241 | 0.459 | 79.5% |
| 1 | Idle | 2.431 | 0.557 | 77.1% |
| 1 | Body tap | 2.563 | 0.498 | 80.6% |
| 2 | Full | 2.476 | 0.509 | 79.4% |
| 2 | Closeup | 1.870 | 0.392 | 79.0% |
| 2 | Idle | 2.499 | 0.493 | 80.3% |
| 2 | Body tap | 2.463 | 0.491 | 80.1% |

These percentages describe this error metric, not an overall percentage improvement in visual quality. The reference itself is a filtered diagnostic rendering. The model's authored detail and the display's physical pixel density remain separate constraints.

## Source and necessary adaptation

The retained parent `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:3917-4005` provides a generic Canvas2D painter and repaint behavior. It has no Live2D mesh or mesh minification path. The SDK's existing `PocketCanvasPainter` remains the rendering implementation; this experiment calls it directly using operations and decoded images captured after real Guest interaction. It adds no substitute runtime, layout engine, or production rendering layer.

The pinned Flutter engine's `display_list/dl_op_flags.h` declares drawVertices flags without `kUsesAntiAlias`; its Canvas recording path applies that mask. Setting Dart `Paint.isAntiAlias` alone therefore cannot toggle this operation's AA. This is not evidence that the actual macOS window lacks AA: the pinned macOS embedding enables Impeller by default, this Demo does not opt out, and its Metal root surface uses 4× MSAA. The `flutter_tester`/Skia geometry fixture cannot be projected onto that production backend. Impeller's texture snapshot path also supports MSAA, so `Picture.toImage` is not inherently a 1× coverage path. See the [Flutter Impeller availability](https://docs.flutter.dev/perf/impeller) and [AA documentation](https://docs.flutter.dev/perf/antialiasing). The current mesh uses bilinear texture sampling and resource-owned filtered LOD images; source atlas and PAK pixels were independently verified lossless in [the texture audit](LIVE2D_TEXTURE_QUALITY_AUDIT.md).

## Isolation and measurement

`demo/integration_test/novel_model_showcase_test.dart` exposes a separate `POCKET_MODEL_EDGE_ABLATION` diagnostic. Its earlier subpixel-coordinate experiment is unchanged. For each frozen framing it produces:

- The model-containing painter blocks, including any adjacent operations already in those blocks.
- Hiyori-only transparent output, retaining complete required mesh layer, mask, and restore groups in original order.

The diagnostic flattens the collected painter operations into one painter. It does **not** preserve the production 32-operation painter partitions: a compatible texture batch can span an old partition boundary, potentially changing its area-based LOD selection. Its 1× image must therefore not be treated as a production-pixel baseline. Within this flattened diagnostic, the painter's DPR, logical size, source image identities, batch partitions, and LOD map identities are constant across sample factors. Only the recording canvas transform and raster target dimensions change. The 2× and 4× images are downsampled with medium filtering to the same physical size as 1×. Transparent exterior, opaque interior, nonempty model bounds, and image disposal are asserted. Context output is diagnostic and is not claimed to reproduce the complete production widget composition.

The analysis uses the transparent output. It flood-fills alpha ≤5/255 from the image border, selects a radius-two Manhattan band around its boundary, and compares premultiplied RGBA against the 4× reference. PNGs emitted as RGBA16 are decoded at eight bytes per pixel before channels are rounded to the common 0–255 measurement scale. The opaque interior is measured separately. The script and all reports remain in the ignored evidence directory.

## Frozen artifacts and evidence

Guest QJBC SHA-256: `9c01ae0def288419adcf5df0244291d15579b68fd614513dd5adfd32e45dfe39`.
PAK SHA-256: `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`.
Metadata SHA-256: `23cd53354ba0efe5e6c4a83b5ec6990d293a80f4e9a4075c8d7259824b390781`.
Diagnostic test SHA-256 recorded at execution: `69e9bcd9f9897b0722506a1a3bf43fd54a26cb61066394c05a027bcc266678dd`. The exact test-source snapshot was not retained before later diagnostic edits. A reconstructed copy does not match that hash and must not be represented as the exact source. The original PNGs, runtime logs and hashes remain available; this limits exact replay of this historical diagnostic. The subsequent actual-partition LOD capture archives its full test and helper sources.

Evidence root: `sdk/.pocket-build/mesh-edge-ablation-20261108/`.
`dpr1/captures.json` and `dpr2/captures.json` contain per-image hashes, operations, LOD dimensions, bounds, release counts, and original logs. Each has 24 diagnostic PNGs and four ordinary captures. `analysis-dpr{1,2}/<framing>/edge-analysis.json` contains the measurements; adjacent `model-comparison.png` shows 1×, 2×, and 4× from left to right.

Both runs reached their final driver checkpoint and reported `All tests passed`. The injected DPR does not change the physical monitor. Foreground activation warnings remain in the logs, so this evidence does not assert OS foreground presentation or true Retina hardware acceptance. Normal Demo PID 15377 and unrelated daemon PID 39062 remained alive after both runs.

## Next production gate

The existing full-body frame contains roughly 97–98 model-containing painter blocks. The plain 32→512 merge was rejected as a behavior-preserving optimization: a color-coded mixed-density fixture changed LOD choices and 2,116 pixels. This is evidence of changed sampling semantics, not actual Hiyori degradation; see [the block ablation](VISUAL_NOVEL_MESH_BLOCK_ABLATION.md). Further grouping experiments must preserve sampling boundaries as well as masks, blending, painter order and host/video boundaries. Any production edge-sampling candidate must then preserve the observed quality benefit while meeting frame and memory budgets. The diagnostic's per-capture image allocation is not accepted as a per-frame production design.
