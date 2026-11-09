# Mesh LOD density selection ablation

Status: the aggregate per-compatible-batch LOD selector is restored as the only
production path. Both per-triangle Local LOD and Native Mip experiments were
withdrawn after real Hiyori comparisons. The current painter matches the
pre-experiment baseline SHA-256
`8e2227bf0c6b1fbab9d35d5405a5f194bbe6ee0e64effbce1344763f3f07598e`.
Archived experiment sources and logs remain available for review.

## Source provenance and current behavior

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected outside `pocket_host/`. Its
`lib/render/pocket_ui_components.dart` contains generic Canvas image fitting
and mip display UI, but no Live2D mesh renderer, mesh-specific LOD selector,
or mesh supersampling path.
The relevant implementation and regression path therefore remains the SDK's
`sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart`, fed by the
existing Live2D DrawOps. `sdk/packages/pocket_vn/src/live2d.ts` marks those
triangles as repeated-texture; clamped UI meshes continue to bypass mip
selection.

The painter groups adjacent texture triangles with matching asset, color,
repeat mode and clip. Its current selector computes
`sqrt(sum(texture triangle area in source texels²) /
sum(screen triangle area in physical pixels²))`, then chooses one existing mip
for the whole compatible batch. This is suitable when density is uniform, but
may choose too small a mip for a magnified region if other triangles in that
batch are strongly minified.

## Actual Hiyori density evidence

The real-frame, read-only DrawOp diagnostic used the production painter
partitions and the same Hiyori frames as the DPR2 captures. Across the complete
frames, minimum-per-triangle density would choose a higher-resolution mip than
the batch average in:

| Framing | Compatible batches | Batches where minimum density selects higher resolution |
| --- | ---: | ---: |
| Full | 110 | 6 |
| Close-up | 95 | 16 |
| Full Idle0 | 114 | 13 |
| Full TapBody | 109 | 5 |

Every measured minimum density was nonzero. These counts establish that batch
members can differ enough to cross a mip threshold. They do not show that the
current renderer visibly blurred those triangles, or that the per-triangle
candidate improves the real model.

The run and source provenance are retained at
`sdk/.pocket-build/mesh-block-ablation-20261108/actual-lod-dpr2/`:

- `lod-diagnostics.json` SHA-256
  `670c952c358dc744d75e0ac5ef926668410cfe4bccb75aee5b5e05761051d6f4`
- `manifest.json` SHA-256
  `cdcd125023fafb676f006ad8c18f49f239d2a3a1475ec03f98083181df28e429`
- `driver.log` SHA-256
  `56f9afde5869d28aace402e20a3328f911b3077a9f996dd4ef00027ac4b10db8`

The test-view viewport was 329×600 logical at DPR2 (658×1200 output), Flutter
3.47.9. Guest QJBC SHA-256 was
`9c01ae0def288419adcf5df0244291d15579b68fd614513dd5adfd32e45dfe39`, PAK was
`3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`, and
`app.bytecode.json` was
`23cd53354ba0efe5e6c4a83b5ec6990d293a80f4e9a4075c8d7259824b390781`.
The Guest source and payload hashes were
`7b2e4b459218d429e7dd8d80fe2f2ed18a1655b82ba351e2e50d73d96b71e229` and
`6fa7cace758518e5ab7dc4cccf7065fdec49a6cbf3e5a075292b68b7a2c045d5`.
The diagnostic captured actual painter blocks and emitted no pixels of its own.

## Rejected whole-batch minimum

The first candidate replaced the batch-average density with the minimum
triangle density for the entire batch. A same-source 64×64 checker fixture
exposed the tradeoff directly. One compatible batch contains a 16:1 minified
quad and a 2× magnified detail quad; 32×32, 16×16 and 8×8 levels are generated
from that same checker source with the production `drawImageRect` medium filter.

| Selection | Changed pixels in detail region (of 16) | Mixed minified-region error to gray 128 | Isolated filtered error | Original-source error |
| --- | ---: | ---: | ---: | ---: |
| Existing batch average | 16 | 1 | 1 | 128 |
| Whole-batch minimum | 0 | 128 | 1 | 128 |

The values are mean absolute red-channel error in the 4×4 minified region; the
filtered reference is a near-gray checker average. The whole-batch minimum
preserved the detail patch but returned minification error to the original
aliasing result. That candidate is rejected and is not present in the current
source. Its complete painter/test snapshots and both logs are retained in
`sdk/.pocket-build/lod-density-ablation-20261108/rejected-conservative/`.

The rejected implementation source hashes are `pocket_view_painter.dart`
`0acb2c6d07ee44e8b61c62f4ea0c1e930e7a4606aad445b980449744c836d652` and
`pocket_mesh_sampling_test.dart`
`323f571e94e5111a659abc5b3890fa4020e1f274b3b766f5c62089a485d75eb5`.
The default and minimum-mode logs hash to
`e9d62e77349fa7ecb8b569ffd5a90366127a72b0d343f1ac64d2cd1aa7c039f2` and
`59eaed0eb45933d817c5ae3d996b8cdf4589accb30e4726fdf0bfbc9e1e3beb7`.

## Withdrawn per-triangle local candidate

The archived opt-in experiment chose an existing mip for each triangle using
its own squared area ratio, `textureAreaTriangle / screenAreaTriangle`. The
LOD thresholds are compared in squared form, avoiding a square root per
triangle. Consecutive triangles selecting the same image stay in one
`drawVertices` run; an image change flushes the current run before continuing
in source order. It does not reorder operations or cross the original
asset/color/repeat/clip, mask or layer boundaries. Ordinary image operations,
clamped meshes, normalized UVs, tinting and blend mode remain on the existing
path. The compile-time switch was removed when the candidate was withdrawn; no
cache or new runtime state was retained.

The mixed-density fixture measures both local detail and minification:

| Selection | Detail pixels changed vs. original source | Mixed minified-region error | Draw runs |
| --- | ---: | ---: | ---: |
| Existing batch average | 16/16 | 1 | 1 |
| Per-triangle local LOD | 0/16 | 1 | 2 |

The isolated filtered reference error remains 1 and the isolated original
source error remains 128. This controlled fixture showed the expected tradeoff
for that checker input, but did not establish a real-model benefit.

The archived focused sampling runs passed under both modes. These test results
were not treated as proof of a real-model visual improvement.

Pinned Flutter 3.47.9 focused runs (from `sdk/packages/pocket_flutter/`) used:

```sh
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test test/pocket_mesh_sampling_test.dart test/pocket_mesh_effect_render_test.dart test/pocket_mesh_alias_sources_test.dart --reporter expanded
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test test/pocket_mesh_sampling_test.dart test/pocket_mesh_effect_render_test.dart test/pocket_mesh_alias_sources_test.dart --dart-define=POCKET_MESH_LOCAL_LOD=true --reporter expanded
```

Both historical runs passed all 9 focused tests. Their full logs are
`sdk/.pocket-build/lod-density-ablation-20261108/local-lod-final-default-focused.log`
(SHA-256 `8a27f879d90a0e74dde49b61296d06cf362c146c76d2aa6ff50266d1551bacb9`)
and `sdk/.pocket-build/lod-density-ablation-20261108/local-lod-final-candidate-focused.log`
(SHA-256 `cc08e4b2d31293b03721d192dfcdf3600e9bf7d990f5c6384ee0ec2b7e821376`).
The archived candidate source hashes were `pocket_view_painter.dart`
`7a57f3f95188eecf3b009531e27e729c3326011cbfb6ab4108d025110fecba2c` and
`pocket_mesh_sampling_test.dart`
`ac50d307cc2cb5f8ad25482e128656c2e37a40460c6861a38f733516819330af`.

The real Hiyori DPR1/2 comparison showed only small image differences while
increasing mesh batches by 45%. The detail change did not justify the extra
draw count, so Local LOD was rejected and removed from production. Its full
source snapshot is under
`sdk/.pocket-build/lod-density-ablation-20261108/local-lod-before-native-mip/`.

## Withdrawn Native Mip candidate

The Native Mip experiment used the original source image with explicit medium
filtering for repeat meshes that had mip levels; aliases without levels stayed
on the aggregate path. It preserved the aggregate batch layout, but real Metal
Hiyori A/B runs at DPR1 and DPR2 were softer and worse than the aggregate
baseline against the same 4× diagnostic capture in every measured frame. Mean
premultiplied RGBA MAE across four frames was:

| DPR | Aggregate edge / interior | Native Mip edge / interior |
| ---: | ---: | ---: |
| 1 | 3.735 / 1.490 | 5.913 / 2.141 |
| 2 | 3.044 / 1.000 | 5.344 / 1.469 |

The 4× image is a diagnostic reference, not canonical ground truth. This
comparison does not establish a universal perceptual score; it does show that
this candidate failed to improve measured Hiyori edges and interiors. Full
captures, analysis and source snapshots are retained under
`sdk/.pocket-build/mesh-native-mip-ab-20261108/`, including the frozen painter
and test in `ready-before-profile/` and the DPR-specific actual A/B folders.
Native Mip was removed from production.

## Current sampling coverage

The retained sampling tests cover bilinear fractional-UV filtering,
repeat-texture magnification, selected-mip minification, and clamped atlas
sampling. Experimental mixed-density and mode-switch assertions were removed;
the rejected candidate sources and logs remain archived. The actual Hiyori
captures are test-view evidence, not physical-device or OS-resize coverage.
