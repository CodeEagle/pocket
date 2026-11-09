# Actual Idle0 pose: production painter and official Native renderer

## Outcome and acceptance boundary

The ordinary Demo's real Hiyori Idle:0 pose was frozen through the existing
Core factory injection point, then rendered by both the production Flutter
painter and the pinned official Native GL renderer. This is a QA-only experiment;
no production sampling, asset, DPI, or model-placement change was adopted.
The user's report of insufficient Retina clarity remains **open**.

The actual Profile capture used the normal Guest bytecode pipeline, natural
800×600 Flutter geometry and DPR 1, with no test-view override. Both original
2048×2048 atlases were present. The production sample-2 replay executed one
178,304-pixel snapshot and disposed it; budget, eligibility and failure bypass
counts were zero. Sample 1 used the direct painter. The full model showcase
completed with exit 0, +2 tests and the required model-showcase checkpoint.

The two production samples and official output were inspected at native size
and in nearest-neighbor enlarged, identical face/hair, cardigan/bow and skirt/
leg regions. No obvious additional detail loss relative to the official GL
output was observed in this 1× case. This is a visual observation, not a
physical Retina acceptance, pixel-identity claim or perceptual score. The
character occupies approximately 386 pixels of image height, limiting the
number of pixels available for facial detail.

## Source-first reuse and diagnostic ablation

The retained parent `../pocketjs_flutter_demo`, excluding `pocket_host/`, has no
Live2D/Cubism renderer or Idle:0 scenario to reuse. Its generic FFI and render
boundaries remain the retained foundation; the Live2D gap/provenance is recorded
in `demo/js/apps/lantern/LIVE2D_SAMPLE.md`.

This experiment reuses `PocketLive2dPlugin.fromBundledCatalog(coreFactory:)`,
the real FFI Core and its topology/metadata interfaces. A diagnostic wrapper
records every complete post-update drawable and the full effective float32
parameter/part input vectors, then suppresses further writes/updates during
capture. No production freeze API, alternate runtime, renderer or state
machine was added. The helper is confined to ignored build artifacts.

The real CustomPaint's PocketMeshSpanPainter and partitions are captured,
including all mesh effects, rather than reconstructing an approximate mesh.
After the stream reaches three stable observations it is painted on black at
sample scales 1 and 2. The final stream has 95 partitions, 3,161 Hiyori texture
triangles and 8 layer/mask/restore groups; no other texture assets are present.

A copy of the existing official Native reference sample consumes a strict PCF1
file containing the complete Core inputs, model opacity multiplier 1, derived
MVP and expected drawable count. It calls Core reset-dynamic-flags before
update, matching the Pocket bridge, then uses the existing official renderer.
The pinned SDK, old official reference and production sources remain intact.

## Correspondence and limits

A texture/UV triangle correspondence derives the global affine from Core model
units to the actual PMS1 screen geometry. 2,705 unique triangle correspondences
and 2,054 unique vertices yield a maximum 0.0000625-pixel residual and RMS
0.0000156 pixels. No PMS1 UV triangle keys lack a Core key. Full triangle-key
coverage is **not passed**: 493 Core keys are absent from the visible stream
and 152 keys are ambiguous, including repeated mask geometry. These counts
are retained in the fit report; they are not silently converted into matches.

All 134 regenerated Core drawable rows match the captured pose's positions,
UVs, indices, masks, render/draw order, texture, constant flags, visible flags,
opacity and multiply/screen colors within the recorded float tolerance. The
maximum reconstructed Core-position difference is 4.12e-8 model units.
The verifier reports `rasterPosePass:true` and strict `pass:false`.
Strict raw dynamic-flag equality is **not passed**: 15 rows have different
`csmOpacityDidChange` / `csmVisibilityDidChange` notification flags because the Native replay has a different preceding
pose. The visibility bits and the actual render inputs match. Raw flag
differences are recorded separately rather than changing the float tolerance.

Official GL and Flutter use different mask/sampling implementations; no claim
of final pixel identity is made. No FPS, presented-frame or memory improvement
is inferred from this capture. The raw Native exporter does not supply a poseClaim field for this run.
The actual captured input/output comparison, command and copied source
establish the scope of this experiment; old default-pose enrichment metadata
is not reused.

Attempts 1 and 2 failed to obtain a stable operation stream and were rejected.
Their logs/source manifests remain preserved; their cause is not established.
Attempt 3 passed. Do not treat an assumed disposed-handle or atmosphere cause
as proven by the earlier failures.

## Reproducible artifacts and next gate

All artifacts are under `sdk/.pocket-build/live2d-idle0-pose-20261108/`:

- `capture/capture.json`, production-sample1/2 PNGs, `capture/frozen.pcf1`
  and `capture/fit.json` contain the actual frozen production state.
- `idle0-native-facts.json`, RGBA/PNG, `native-run.log`, build logs and the
  isolated sample/patch capture the official run (bounded to 30 seconds).
- `match.json` preserves per-row comparisons; `idle0-contact-sheet.png`
  contains identical image regions at nearest-neighbor ×2 display size.
- `actual-core-source.dart`, `actual-production-source.dart`, `test-source.dart`,
  `source-hashes.json`, `final-artifacts.json`, Profile log, response and run manifest preserve the
  exact executable test inputs. The reusable helper was subsequently hardened
  to reject disposed models; the copied actual source remains authoritative.
- `attempt1/` and `attempt2/` retain failed runs. Both restored the mirror
  Runner configuration; the final run also restored it.

The next acceptance requires an actual 2× backing display: AppKit screen,
window and inner FlutterView scales must agree with Flutter DPR, with the
ordinary Demo captured on that display. A test-view DPR override cannot close
that gate. Full-body clarity must also be reviewed in the actual large-screen
composition. The ordinary Demo PID 85465 was preserved and reactivated after
the diagnostic app exited; no editor backend was opened.
