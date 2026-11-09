# Mesh minification and full-body aliasing

Status: the narrowed repeat-only implementation is enabled and has final OFF/ON Profile evidence recorded below. The initial broad-eligibility candidate blurred nine-slice UI and was withdrawn. Prefiltered levels reduce texture minification aliasing; full-body geometric edge quality and physical Retina acceptance remain open. Subsequent fixed-LOD diagnostics and current-Guest frame costs are recorded in [the edge ablation](VISUAL_NOVEL_MESH_EDGE_ABLATION.md).

## Source first and observed gap

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected outside `pocket_host/`. Its `lib/render/pocket_ui_components.dart` has generic filtered image fitting, but no retained Live2D mesh renderer or mesh LOD implementation. The current SDK already owns the actual Core float32 geometry, original 2048² atlas textures, premultiplied Flutter image decoding, mesh batching, masking and blend modes. These remain the rendering path.

The user reports large staircase edges in full-body Hiyori and smaller artifacts in close-up. Review of the actual 390×844 DPR2 full-body PNG confirms visible hair/skirt edge aliasing. The preceding framing pass established no body/control overlap, not edge quality.

## Controlled sampling evidence

A 64×64 black/white checker is sampled onto an 8×8 output through the production textured-triangle painter, at a phase that repeatedly selects black source texels. The existing bilinear magnification test passes, but this minification has mean absolute error 128 against the correct 128 gray average. Pixels are opaque; this is not an empty render.

- Existing low filter: center `[0,0,0,255]`, gray error 128. Log `/tmp/pocket-mesh-minification-low.log`.
- Paint medium: unchanged. Log `/tmp/pocket-mesh-minification-medium-valid.log`.
- Explicit ImageShader medium: unchanged. Log `/tmp/pocket-mesh-minification-explicit-medium-valid.log`.
- Equivalent shader-matrix/UV scaling at 1, 1/8 and 1/16: unchanged. The same source reduced by `drawImageRect` with medium yields `[127,127,127,255]`. Log `/tmp/pocket-mesh-minification-image-rect.log`.

The ineffective filter-enum and matrix candidates were withdrawn. This demonstrates a sampling-path difference in the pinned Flutter test renderer; it is not a claim about every GPU backend or the only possible cause of contour aliasing. Core positions/UVs retain float precision; no integer quantization explaining whole-pixel stairs was found.

## Geometry precision and edge coverage

The following early inspection covers the FFI, native PFB and Flutter float path only. A later source review found an earlier integer round in pinned Core DrawList emission, which has since been repaired; see [the subpixel acceptance](VISUAL_NOVEL_RETINA_ACCEPTANCE.md). The FFI/PFB/Flutter portion described here contains no integer snap. Cubism FFI copies `positionsXYPixels` and UVs from `Float*` buffers (`sdk/packages/pocket_live2d/lib/src/pocket_live2d_ffi.dart`, around lines 274–277); the JS transport validates those arrays as float32 (`sdk/packages/pocket_live2d/src/transport.ts`, around lines 335–357); Pocket serializes mesh points and UVs with `f32` (`sdk/native/src/lib.rs`, around lines 695–700), and Dart reads them with `reader.f32` (`sdk/packages/pocket_flutter/lib/src/pocket_model.dart`, around lines 792–797). Flutter's `Vertices` constructor then encodes `Offset` positions and texture coordinates into `Float32List` (`painting.dart`, around lines 6622–6659). Near UV=1, float32 rounding on a 2048px texture is about 0.00025 texel per ULP; at a 2000 logical-pixel position it is about 0.00012 logical pixel per ULP. This precision cannot account for multi-pixel stair steps.

There is a separate edge-coverage limitation in the pinned Flutter path. This machine's Flutter 3.47.9 SDK records framework revision `c197ca5199e9ee5661e865596c9c07294dfab51c` and engine revision `89c39edfdfae2949f6806e4a315c0c08522238b7` in `/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/cache/flutter.version.json`. The local engine source is under `/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/engine/src/flutter/`. In `display_list/dl_op_flags.h` (`kDrawVerticesFlags`, around lines 369–376), the flags include shader, alpha, blend and filters but omit `kUsesAntiAlias`; `lib/ui/painting/canvas.cc` (`Canvas::drawVertices`, around lines 559–574) passes those flags to `paint.paint`. `paint.cc` only transfers the anti-alias bit when the flags request it. Thus setting `Paint.isAntiAlias` does not toggle edge AA for this `drawVertices` display-list path. That flag behavior does **not** establish a lack of AA in the actual macOS window. The pinned macOS embedding defaults to Impeller and this Demo does not opt out; Metal root surfaces use 4× MSAA, and the snapshot path can also allocate multisample targets. The earlier `flutter_tester`/Skia no-intermediate-alpha result is a backend-specific fixture result. Texture LOD addresses minification independently of that geometry coverage. See [the corrected backend scope](VISUAL_NOVEL_MESH_EDGE_ABLATION.md). The local paths and revision above identify the checked source; no external revision link is needed to reproduce this inspection.

## Candidate adaptation

Retain the existing original image map for ordinary image ops and magnified meshes. Generate bounded 1/2, 1/4 and 1/8 filtered variants only for images referenced by `repeatTexture` triangles, once at the resource boundary. A level never goes below 64 pixels per dimension; at most three variants use fewer than one-third additional original-image pixels. The painter may select a level only for a repeated-texture batch, using its texture area / physical screen area and device-pixel ratio. Ordinary image ops and clamped mesh batches keep the original image, even if the same image is also used by a repeated-texture batch. Normalized UVs are unchanged. There is no new model renderer, model clock, geometry source or business state.

This is a generic sampling-mode boundary, not an asset-name test. The SDK Live2D factory sets `repeatTexture: true` on its drawable mesh effects (`sdk/packages/pocket_vn/src/live2d.ts`); the skin nine-slice uses `NovelMeshView` without a mesh effect (`sdk/packages/pocket_vn/src/skin-view.tsx`), and `PocketTextureTriangleOp` defaults the repeat flag to false (`sdk/packages/pocket_flutter/lib/src/pocket_model.dart`). `PocketMeshLayerBeginOp` is not a reliable classifier: the native mesh patch emits a layer only when a mesh effect needs compositing, so ordinary unmasked/default-blend model triangles can be outside a layer (`sdk/native/patches/image-mesh.patch`, `emit_mesh` and `MeshEffect::needs_layer`). This eligibility does not claim that minification for every clamped mesh has been fixed.

Variant ownership must follow the existing resource epoch/revision/release lifecycle, including disposal on replacement, stale completion and view teardown. This work is a quality/memory tradeoff; it is not reported as a speed or RSS optimization.

The implementation reuses `PocketView`'s existing image epochs rather than adding another image owner. `_requestResources` collects the current `PocketTextureTriangleOp` asset set during its existing op scan and publishes that set to `_activeMeshImageAssets`; later loader/completion checks use O(1) membership instead of rescanning the roughly 2,700-triangle Hiyori frame for each resource and each generated level. Startup assigns `_frame` before its first `_requestResources`; normal `_applyFrame` does likewise before requesting resources. The in-flight resize ticket must still be the current map entry, and the source image identity and epoch must match before a level is installed. Release/revision replacement removes the levels and ticket; a late result is disposed. View disposal disposes all derived images and clears the active-asset set. A failed LOD attempt is recorded as an empty level list for that source revision, reports through `onError`, and leaves the original image usable; release/revision replacement clears the failure record.

For a same-Guest OFF/ON measurement, compile-time `POCKET_MESH_IMAGE_LEVELS=false` skips derived-level generation while preserving original image loading and JS behavior. Default is true. Current `pocket_view.dart` source SHA-256 is `55c8808f40eec8d05c7ee3e89d647daf7ea78c63587b53e5e1d5fe4ff8ae6c9b`.

## Verification and limits

The production sampling test now compares the original aliasing result with a prefiltered level and requires a near-gray minification result. A magnified checker must remain byte-identical with a lower-resolution level available. Repeat sampling, hidden mask geometry, transparent/opaque masking, blending/tint and mesh group atomicity remain covered. The first broad-eligibility screenshots showed that applying these levels to clamped nine-slice UI softened its frame; the repeat-only eligibility and painter gate address that regression, but still need a fresh OFF/ON visual comparison.

The final narrowed resource/painter implementation passes 24 focused tests across sampling, mesh effects, grouping, first-frame and invalidation suites (`/tmp/pocket-mesh-lod-final-resource-regression.log`). This includes retaining original sampling for clamped UI meshes even when a repeated model mesh shares the same texture. Earlier seven-test evidence is retained in `/tmp/pocket-mesh-lod-regression.log`. The initial broad-eligibility Hiyori Profile completed at 329×600 DPR2 for 60 seconds per variant; it is evidence for the observed model/UI tradeoff, not final proof of repeat-only eligibility. Fresh Hiyori full-body/close-up screenshots, lifecycle cancellation/release for the narrowed path, and whole-game frame/RSS evidence are still required before adopting the candidate in ordinary play. Texture LOD cannot promise to solve all un-antialiased triangle geometry edges or clamped-mesh minification.

The resource-layer Dart analyzer and format checks pass for the source SHA above. They are compile-time checks, not Hiyori rendering or lifecycle runtime evidence. OFF/ON Profile and screenshot comparison for repeat-only eligibility are pending; no frame-rate or overall-game improvement is claimed.

The transparent-mask/repeat-seam LOD test helper was subsequently aligned with the production `drawImageRect` `FilterQuality.medium` setting (it previously used high). Its complete five-test file passed again; this is a test fidelity correction, with no production filter change.


## Final narrowed-path Profile evidence (2026-11-08)

The same final canonical Guest `e0a4a109ec0836ca547bcfab6723e0f2218b0f25e453ab9368d11fa4063a3097`
and PAK `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`
were run with LOD OFF and default ON at 329×600 logical / DPR2. Both real
macOS Profile cases completed (60s OFF, 59s ON), including input-driven motion,
three full-body states, close-up, hidden mask deformation, background/resume,
release/re-entry and main-store isolation. Each saved driver response declares
and completes `model-showcase`. Four PNGs and their hashes per side are in
`sdk/.pocket-build/mesh-lod-final-ablation-20261108/{off,on}/captures.json`.
Logs: `/tmp/pocket-mesh-lod-centered-{off,on}-profile.log`.
The source identities are `pocket_view.dart` `55c8808f…` and
`pocket_view_painter.dart` `8e2227bf…`; exact full hashes are in the final Guest's
`sdk/.pocket-build/lantern-v4-input-lod-centered-20261108/build-inputs.json`.

The final ON screenshots show visibly smoother hair, cardigan details and
skirt edges; image-button frames retain their original sharp sampling. The
three authored full-body states show complete head, hands and shoes with
clearance above the toolbar. Close-up remains usable. These are actual pixels,
with animated poses not registered between runs; no numerical visual-gain or
whole-game FPS claim follows. The screenshot metrics are test-view overrides,
not a physical-phone/OS-resize acceptance. Some un-antialiased geometric mesh
edges can still remain, and arbitrary clamped model meshes remain outside this
conservative repeat-only selection.

Two 2048² Hiyori pages retain their originals and expose 1024², 512² and 256²
levels in the ON capture metadata; OFF exposes no derived images. Their
additional RGBA pixels cost about 10.5 MiB. No stabilized-RSS, cold-start or
60 Hz budget is established by this quality acceptance.

An independent screenshot review agreed that final UI frames stay sharp and all three full-body poses clear the toolbar. It judged contour smoothing modest. Accordingly this result is described as reduced sampling aliasing, never complete removal of mesh-edge stairs.


## Deferred measured optimization candidate

Read-only review found a separate per-repeat-batch triangle area pass in
`pocket_view_painter.dart` (around 581–600) followed by vertex assembly (around
621–633). This is real O(triangle-count) work introduced by the quality fix;
it has not been measured as the dominant frame cost. A next ablation can fuse
area accumulation into vertex assembly, retaining normalized UVs until level
selection and then scaling the assembled coordinates. Preserve the current
formula and image output, then compare paint/build P95 on the same Guest.
No fusion or new cache was adopted in this frozen visual checkpoint. The later fusion candidate was measured slower and withdrawn; see [the completed fusion ablation](VISUAL_NOVEL_LOD_FUSION_ABLATION.md), rather than repeating this proposal as untested work.
Upstream static UV/topology caching is not a ready-made whole-asset area cache:
batch membership/clip/tint and visible drawables change. Resource eligibility
already shares the existing collect-resources pass and uses O(1) membership,
so no second full-frame resource scan is left to remove there.

## Independent lifecycle review, 2026-11-08

A read-only review found no concrete regression in derived-image ticket/source/epoch checks, stale-image disposal or premultiplied-alpha handling. It confirmed the separate geometric edge-coverage limitation in the pinned `drawVertices` path. This is review evidence, not another pixel or performance run, and does not close the whole-body silhouette quality gate.
