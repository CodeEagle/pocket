# Live2D native mip ablation

## Experiment

The experimental `POCKET_MESH_NATIVE_MIP` branch kept each original Hiyori texture image and passed `FilterQuality.medium` to its `ImageShader` when the texture had non-empty `meshImageLevels`. The comparison baseline preserved the old aggregate-density mip choice by aliasing each original painter batch to that already-owned mip image and giving the alias an empty level list. The comparison retained the production painter partitions, mesh groups, source images, and draw order.

The frozen Lantern Guest was `app.qjbc` SHA-256 `9c01ae0d…` and `app.pak` SHA-256 `3d775a1f…`, using Cubism Core 6.0.1. Flutter 3.47.9 macOS Profile rendered four Hiyori framings at a 329×600 logical test view. DPR1 matched the Mac’s actual system DPR; DPR2 was a test-view override and is not physical Retina acceptance. Both captures used the actual Impeller backend.

## Results

| Test-view DPR | Framing | Changed pixels | Baseline edge MAE vs 4× | Native edge MAE vs 4× | Baseline interior MAE vs 4× | Native interior MAE vs 4× |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Full | 15,722 | 3.564 | 6.029 | 1.472 | 2.292 |
| 1 | Closeup | 32,436 | 4.647 | 6.135 | 1.604 | 1.903 |
| 1 | Idle pose | 15,646 | 3.353 | 5.686 | 1.459 | 2.162 |
| 1 | Tap pose | 15,593 | 3.376 | 5.801 | 1.426 | 2.207 |
| 2 | Full | 47,338 | 3.031 | 5.685 | 1.047 | 1.610 |
| 2 | Closeup | 99,775 | 2.904 | 4.153 | 0.829 | 1.041 |
| 2 | Idle pose | 47,065 | 3.100 | 5.663 | 1.056 | 1.587 |
| 2 | Tap pose | 47,462 | 3.141 | 5.874 | 1.068 | 1.636 |

Changed-pixel counts are direct raster differences between the old aggregate-mip baseline and the native-mip candidate. MAE is premultiplied RGBA error for the alpha-defined edge band or opaque interior against the same-pose 4× diagnostic image. The candidate had higher measured edge and interior MAE in all eight comparisons. These values describe raster differences; they are not a perceived-quality score.

The 4× image uses the same candidate policy with painter DPR multiplied by four, followed by `Canvas.drawImageRect` with `FilterQuality.medium`. It can therefore sample a different mip level than the production-DPR candidate. On Impeller, `snapshot_controller_impeller.cc` calls `DisplayListToTexture` with `generate_mips=true`, and `dl_dispatcher.cc` computes `size.MipCount()`, so the `Picture.toImage` reference has an Impeller mip chain. It is still a medium-filter diagnostic, not a CPU box average or canonical ground truth.

In visual review of the full-frame comparison, the aggregate baseline retained more detail but had jagged edges; native mip output looked softer; the 4× diagnostic appeared smoother while retaining detail. The pixel measurements and visual review do not support adopting native mip for this model. Keep the normal aggregate selector as the production default. The candidate must remain disabled and is being removed after this experiment.

## Evidence and limits

The frozen source snapshot and Guest hashes are in `sdk/.pocket-build/mesh-native-mip-ab-20261108/ready-before-profile/`. DPR1 and DPR2 logs, four-pose A/B PNGs, raw JSON, manifests, Impeller snapshot source, alpha-edge reports, and comparison strips are archived under `sdk/.pocket-build/mesh-native-mip-ab-20261108/actual-ab-dpr1/`, `actual-ab-dpr2/`, `analysis-dpr1/`, and `analysis-dpr2/`.

No native-mip performance run was performed. DPR2 is not device-DPI validation. The next separate experiment may capture the complete model surface in one offscreen pass; per-painter `toImage` work and its frame cost remain unmeasured.
