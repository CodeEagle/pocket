# Visual novel mesh alias source diagnostic

## Scope and source reuse

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected outside `pocket_host/`. Its `lib/render/pocket_ui_components.dart`
contains a general Canvas2D painter; around line 3937 it sets
`Paint.isAntiAlias = true` and `FilterQuality.high` for ordinary drawing. It has
no retained Cubism mesh renderer, textured-triangle op or model LOD path to
reuse. The existing SDK mesh path remains the baseline under test.

In the SDK, `PocketView` creates filtered image levels at the image-resource
boundary, while `PocketCanvasPainter._drawTextureTriangleBatch` keeps the
original mesh points and changes only which `ui.Image` is sampled. It builds
vertex positions from `op.points`, scales normalized UVs by the selected image
size, and issues one `Canvas.drawVertices` call for the compatible batch
(`sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart`, around lines
618–653). This makes texture sampling and geometric coverage independently
observable without adding a renderer.

## Bounded pixel experiment

Added `sdk/packages/pocket_flutter/test/pocket_mesh_alias_sources_test.dart`.
It uses the production `PocketCanvasPainter` on 32×32 surfaces, with two
fixtures:

1. A fractional-coordinate triangle mapped to a solid opaque 4×4 image. Its
   edge coverage cannot be explained by a transparent texture contour.
2. A full quad mapped to a 256×256 diagonal 4-pixel opaque/transparent checker.
   The source phase deliberately makes the original point sampler alias to
   opaque texels. A 32×32 filtered image level tests the existing repeat-mesh
   LOD path without changing positions or renderer state.

Pinned Flutter test command:

```sh
cd sdk/packages/pocket_flutter
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test --no-pub test/pocket_mesh_alias_sources_test.dart
```

Observed result: `1` test passed. Pixel diagnostics printed by the test:

- Solid textured triangle: `geometry-intermediate-alpha=0`.
- Direct `drawVertices` with `Paint.isAntiAlias=false` versus `true`: the two
  32×32 RGBA images are byte-identical.
- High-frequency texture alpha before LOD: unique alpha `[255]`, mean `255`,
  `0` intermediate-alpha pixels.
- Same alpha texture with the filtered level: unique alpha `[127]`, mean `127`,
  `1024` intermediate-alpha pixels.

This fixture shows two separate effects in the same Flutter renderer: the
existing LOD removes the deliberately phase-locked texture-alpha alias, while
triangle coverage still has hard edges. The fixture is diagnostic, not a
quantitative estimate of Hiyori's total silhouette error.

## Real model image comparison

The available 329×600 DPR2 OFF/ON captures are in
`sdk/.pocket-build/mesh-lod-final-ablation-20261108/{off,on}/`. For example,
`model-Hiyori-full-329x600-dpr2.png` and
`model-Hiyori-closeup-329x600-dpr2.png` show the real repeat-texture LOD path.
The ON captures visibly retain finer hair, cardigan and skirt texture detail;
the outer hair and clothing contour still shows stepped edges. The poses are
not registered frame-for-frame, so these captures support visual diagnosis
only, not a pixel-error score. Existing same-source performance and sampling
limits are recorded in
[`VISUAL_NOVEL_MESH_MINIFICATION.md`](VISUAL_NOVEL_MESH_MINIFICATION.md).

An opt-in actual-Core comparison now uses the existing
`sdk/packages/pocket_live2d/test/live2d_guest_pixels_test.dart` fixture. It
captures one real Hiyori Core draw-list, then freezes that same list and paints
it offscreen with the official original 2048×2048 PNGs substituted for the
fixture's packed images. The normal-size render, current 1/2–1/8 medium-filtered
mips, and a 4× render all use the production `PocketCanvasPainter`; the 4×
image is downsampled with `FilterQuality.medium`. No Core update or frame pump
occurs between these variants. A second control replaces visible model
textures with opaque white while retaining masks, to expose hard geometric
coverage in isolation. Since that changes the visible material and keeps the
mask path, it is only a geometry control, not a quantitative attribution of
the live Hiyori silhouette.

The fixture test passed with one real Hiyori model. The frozen render target was
1013×1800 physical pixels at test DPR 3.0. Against the same-frame 4× reference,
the no-LOD image had mean absolute RGBA error 0.23115 and alpha error 0.14706;
the 2048-derived LOD image had 0.14840 and 0.10816. Its partial-alpha pixels
increased from 2020 to 6222, consistent with filtered texture-alpha sampling.
The opaque-visible-texture geometry control had alpha error 0.16453 and no
partial-alpha pixels in its native-size image. This proves that both texture
sampling and hard triangle coverage are present in this renderer. It does not
show that geometry is the main source of the remaining edge steps in the
production Lantern screenshot.

The PNG inputs came directly from the pinned cached Cubism SDK 5-r.5 sample
resource tree, at
`sdk/packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5/Samples/Resources/Hiyori/Hiyori.2048/`:

| Source | Size | SHA-256 |
| --- | --- | --- |
| `texture_00.png` | 2048×2048 RGBA8 | `560aea0d910dc04950d669640b2ef17c0d817969e9909f477f166bb5cbd8ffbe` |
| `texture_01.png` | 2048×2048 RGBA8 | `87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84` |

An alpha-channel scan of these originals found transparent texels in both
atlases (minimum alpha 0; mean alpha 83.2966 for texture 00 and 136.26 for
texture 01). This confirms texture alpha can contribute to the visible contour;
the test does not map those transparent texels back to a silhouette-edge
classification.

The fixture Guest hashes used by the test were QJBC `fa475e4cfc46dd2d6b9f44572b61281674c3fdd80968d8434e861f7a24187cbe` and PAK `bcbc6a180b2d79b5cd179ca8f18f2831a6419b5833390d6a1a1d73b46a38f6d5`.
It used `pocket_live2d.framework` SHA-256
`f1b0639f05f4c8a2cf61bc9fd78e2c3b91cd1b6a55d22148ac92151ff6e827e8` and the
arm64 `libpocket_flutter.dylib` SHA-256
`2c95ea4522493b44e9a23f8e981d5a8eb190c128ddce93874e18ef899548691c`. PNGs
and `report.json` are in the ignored
`sdk/.pocket-build/hiyori-alias-diagnostic-20261108/` directory.

The diagnostic is reproducible without building the Guest:

```sh
cd sdk/packages/pocket_live2d
POCKET_LIVE2D_GUEST_ASSETS="$PWD/.cache/hiyori-guest-pixels/flutter-assets" \
POCKET_LIVE2D_CORE_LIBRARY="../../.pocket-build/lantern-playable-v4-strict-20261108/pocket_host.app/Contents/Frameworks/pocket_live2d.framework/Versions/A/pocket_live2d" \
POCKET_NATIVE_LIBRARY="../../native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib" \
POCKET_LIVE2D_ALIAS_DIAGNOSTIC=1 \
POCKET_LIVE2D_HIGHRES_TEXTURE_ROOT="$PWD/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5/Samples/Resources/Hiyori" \
POCKET_LIVE2D_ALIAS_OUTPUT="../../.pocket-build/hiyori-alias-diagnostic-20261108" \
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test --no-pub test/live2d_guest_pixels_test.dart
```

This is a package test render, not the Lantern Guest's current PAK or scene
composition, and not a native-device capture. The 2048 image substitution keeps
the fixture's QJBC, MOC, Core-generated mesh positions, normalized UVs, and
mask/draw order; only the painter image map changes. The comparison therefore
isolates sampler behavior for a real model frame but cannot establish the
dominant cause of contour alias in every pose, target size, or renderer backend.

## Why the geometric edge remains

The app's pinned Flutter 3.47.9 engine revision is
`89c39edfdfae2949f6806e4a315c0c08522238b7`. In its local source,
`engine/src/flutter/display_list/dl_op_flags.h` defines `kDrawVerticesFlags`
without `kUsesAntiAlias` (around lines 369–376). `Canvas::drawVertices` passes
those flags into `Paint::paint` (`engine/src/flutter/lib/ui/painting/canvas.cc`,
around lines 559–574); `paint.cc` transfers the antialias bit only when the
flags request it (around lines 157–159). The byte-identical direct pixel test
confirms that toggling the Dart `Paint.isAntiAlias` bit does not affect this
draw-vertices path in the pinned test renderer.

The next bounded production experiment, if geometric smoothing is still
required, is to test an engine-side `drawVertices` AA flag change on a textured
triangle and on a two-triangle opaque quad. The quad must prove that enabling
edge coverage does not introduce a seam along the shared diagonal before any
change is considered for the roughly 2,700-triangle model. No production code
or engine patch was changed for this diagnostic.

## Limits

This is a Flutter package pixel test plus visual inspection of existing
macOS-profile captures. It does not establish behavior on every GPU backend,
physical device, or Flutter engine revision, and does not prove that geometric
edge aliasing is the only remaining visual issue.
