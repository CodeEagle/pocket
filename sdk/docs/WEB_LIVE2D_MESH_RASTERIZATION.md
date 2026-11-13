# Small Live2D mesh rasterization in Studio Web Preview

2026-11-12. Follow-up to `LIVE2D_WEB_PREVIEW_OPTIMIZATION.md` after the actual
small-character Demo still showed dark triangle seams and stutter.

## Source and retained behavior

Inspected retained `../pocketjs_flutter_demo/web_wasm_preview/index.html` and
`../pocketjs_flutter_demo/lib/render/` (excluding `pocket_host/`). They provide
Canvas preview/rendering boundaries but no Cubism/WebGL mesh implementation.
The necessary adaptation lives in the existing SDK preview compositor,
`sdk/editor/client/preview.js`, using its existing PMS1/effect decoder and native
DrawOps. It does not add an engine, layout implementation, Dart policy, or demo
imports. Existing texture tint, layer blend, masks, inversion, draw order, clips
and mutable canvas resources remain covered by regression scenarios.

## Observed cause and implementation

The former Canvas path clipped and composited every triangle independently.
Antialiased shared edges lost coverage and showed the background through the
mesh, particularly when many triangles occupied only a few physical pixels.
A dense white grid regression measured minimum interior alpha **129** instead of
255. The new path measures **255**, without expanding overlapping triangles.
Actual captured Hiyori before/after images also show the internal grid removed.

One lazy WebGL2 scratch surface rasterizes eligible consecutive triangles from
the same atlas, with shared-edge triangle coverage and premultiplied blending.
The existing Canvas compositor still applies layers, masks and blend modes.
Both PMS1 models and native Preview's plain repeat-textured triangle runs use
the path. Nonwhite vertex tints, unsupported context composition, unavailable
WebGL2, or context loss use the existing Canvas path. That compatibility path
retains its original triangle-edge limitation.

Texture sampling uses mipmaps for minification. Immutable decoded textures and
bounded tint outputs use a 64 MiB LRU including mip levels; source disposal and
tint eviction delete corresponding GPU textures. Dynamic canvas-only sources
upload to one reusable texture so in-place mutations remain visible. Oversized
textures use that same nonretained slot. Scratch canvas, vertex buffer and GL
program are shared within the preview script rather than allocated per mesh.

Only a batch's physical bounds are cleared/copied, with scissoring and a one
pixel bounds margin. Draw order is never changed across intervening operations.
The source canvas retains the target dimensions instead of reallocating its GL
drawing buffer for each different batch size. Unsupported native batches are
scanned once before Canvas fallback, avoiding a quadratic rescan of every tail;
the forced-fallback regression verifies exactly one batch slice for 800 triangles.

## Ablations and measured limits

Measurements are local Chromium observations, not timing assertions in CI.
Official local licensed Hiyori/Core caches were used without modifying atlases.
Headful Playwright Chromium used the Apple M4 hardware GPU.

| Scenario | Canvas baseline | GPU batch path |
| --- | ---: | ---: |
| Actual saved small Demo frame, 375×812, 3,519 operations, median of 12 warmed submissions | 8.8 ms | 6.4 ms |
| Official Hiyori, 240×340, 130 nonempty / 125 visible meshes, median of 12 warmed submissions | 16.9 ms | 3.0 ms |
| Dense grid minimum interior alpha | 129 | 255 |

These measure synchronous parsing/draw submission (saved Demo) or projection
submission (model), not GPU completion or end-to-end FPS. Pixel equality is
intentionally no longer required: removal of transparent seams and mipmap
filtering change coverage and colors.

Rejected experiments: resizing the GL drawing buffer for each batch's bounds
was slower; full-viewport copies were replaced by bounded copies. MSAA added
considerable software-GPU cost and is disabled; shared-edge coverage does not
require it. Headless Chromium's SwiftShader remains slower for the saved frame
(approximately 27 ms versus Canvas 11 ms). Hardware measurements must not be
presented as a software-GPU speed guarantee.

Reproduce official model measurement from the repository root:

```sh
POCKET_BENCH_HEADFUL=1 node sdk/scripts/benchmark_live2d_canvas.mjs /path/to/baseline-preview.js
```

Local Core/model locations and the baseline are described in the earlier audit
document. `POCKET_BENCH_EXPECT_IDENTICAL=1` is only appropriate for cache-only
ablations, not this seam correction.

## Child timing and remaining stutter

The child frame pump previously consumed newly queued display time during a
zero-time asynchronous response settlement. That can start another model host
request before the current result is published. It now retains that time until
the next display pump, after publication. The regression injects ticks during
settlement, verifies the first publication follows deltas `[16, 0, 0]`, and
verifies subsequent positive deltas `[16, 48, 16]` consume elapsed time once.

The actual local Demo runs with an explicitly selected release native probe.
A fresh debug probe had previously been selected by source-mode discovery;
release selection reduces native CPU cost but is not a source-code change.

Actual embedded Demo measurement after the timing change still observed only
43–44 distinct Hiyori geometry updates in four seconds (about 11 Hz), with
86–88 received frame objects. Switching Canvas/GPU alone did not improve this
producer cadence. Do not count the root frame counter as child animation FPS.
The native JSON/child frame pipeline remains a material performance limitation;
this change fixes seams and reduces drawing cost, but does not establish 60 FPS
or claim to eliminate all stutter. No new transport protocol is introduced.

## Validation

- `preview_mesh_seams.test.ts`: dense fractional shared edges, native plain
  repeat triangles, fully opaque interior, reduced per-triangle clipping.
- `preview_mesh_effect.test.ts`: both GPU and forced Canvas fallback; normal and
  inverted masks, repeat UVs, tint, blending, shared-mask reuse, changed mask
  geometry and mutable texture updates.
- Existing tint and triangle-alpha browser tests pass.
- `preview_child_settle_time`, `preview_child_frame_nonblocking`,
  `preview_generation`, `preview_barrier`, `novel_stage_live2d_browser`: 9 pass.
- Mesh/effect/tint/alpha, delayed system requests and actual Live2D Guest preview:
  9 pass across six files, including actual pinned bytecode/native execution.

Argon Medium consolidated review completed with no blocking defects. It noted
that top-level `textureTriangleRepeat` aliases retain Canvas rendering (native
Live2D actually emits `textureTriangle` plus `repeatTexture: true`), and that
logical clips constrain the Canvas copy after GL rasterization. Both preserve
correctness; no additional wrapper or duplicate renderer was added for them.
