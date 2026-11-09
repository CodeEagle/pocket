# Live2D texture fidelity audit

This read-only audit checks the two official Hiyori atlas PNGs against the
texture payloads in the staged Lantern PAK. It does not measure character
screen size, mesh tessellation, mask quality, or the appearance of a rendered
frame.

## Inputs and reproducible check

The pinned Cubism sample source is cached at
`sdk/packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5/Samples/Resources/Hiyori/Hiyori.2048/`.
The files staged for Lantern are at
`demo/js/apps/lantern/.pocket-build/live2d/Hiyori/Hiyori.2048/`. The current
staged PAK is `demo/assets/apps/lantern/app.pak`.

`demo/js/apps/lantern/scripts/prepare_live2d.ts` pins SHA-256 hashes for both
source pages and rejects a staged atlas unless it remains 2048×2048 and
byte-identical to that source. The audit script then independently decodes
PNG RGBA8 scanlines and compares every resulting pixel byte with the IMG
payload in the PAK:

```sh
python3 sdk/.pocket-build/live2d-retina-texture-audit-20261108/audit_hiyori_pak.py
```

The script and JSON output are under the ignored cache directory:

- `sdk/.pocket-build/live2d-retina-texture-audit-20261108/audit_hiyori_pak.py`
- `sdk/.pocket-build/live2d-retina-texture-audit-20261108/audit-result.json`

At audit time the PAK was 69,216,400 bytes, SHA-256
`3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`.
Both source and staged PNGs are non-interlaced RGBA PNGs with 8 bits per
channel. Their encoded file sizes are 1,814,312 bytes and 2,504,416 bytes.
Each decodes to 2048×2048×4 = 16,777,216 RGBA bytes.

| Atlas | Source/staged PNG SHA-256 | Decoded RGBA SHA-256 | PAK format and pixel SHA-256 |
|---|---|---|---|
| `texture_00.png` | `560aea0d910dc04950d669640b2ef17c0d817969e9909f477f166bb5cbd8ffbe` | `b46027cb785575e4d82f580b11bf717d4f79fff5367ab986f5cfd5cae99ce81f` | PSM 8888, `b46027cb785575e4d82f580b11bf717d4f79fff5367ab986f5cfd5cae99ce81f` |
| `texture_01.png` | `87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84` | `9311a660d4aafc96ecfb2a7700a49c73123f0143086d4272fdd8f597c9828759` | PSM 8888, `9311a660d4aafc96ecfb2a7700a49c73123f0143086d4272fdd8f597c9828759` |

Each PAK IMG blob has an 8-byte header and exactly 16,777,216 pixel bytes.
The PSM value is 3 (`8888`), not `5650` or `4444`. IMG flag value 2 requests
linear/bilinear filtering; bit 0, the PackBits-compression flag, is unset.
The independently decoded source pixels, staged PNG pixels, and PAK pixel
payloads match byte-for-byte for both pages. The original PNGs use lossless
PNG compression on disk; the PAK stores uncompressed RGBA pixels. PAK storage
is larger, but that packaging step did not reduce image detail or bit depth.

## Flutter decode and alpha path

`sdk/packages/pocket_flutter/lib/src/pocket_assets.dart` maps PSM 3 directly
to four RGBA bytes per pixel. At the Flutter image boundary,
`PocketPakImages.decodeResource` premultiplies its owned RGBA buffer once
before constructing a `ui.ImageDescriptor` with `PixelFormat.rgba8888`; it
does not mutate the PAK resource. The accompanying resource-decode tests
compare repeated decodes and check that the input bytes remain unchanged.

`sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart` draws textured
mesh batches using a `ui.ImageShader`, `drawVertices`, and
`BlendMode.modulate`. The mesh tint color filter changes RGB and preserves
alpha; there is no second explicit premultiplication in this shader/draw path.
The 2048 mesh-image levels are derived from the already decoded Flutter image
and do not alter the PAK/source bytes.

## Conclusion and limits

The staged Hiyori textures are 2048×2048 RGBA8 and losslessly preserved in
PSM 8888 PAK entries. Neither lossy compression, 5650/4444 packing, nor a
duplicate premultiply in the Flutter mesh path explains a loss of atlas
detail. This check does not establish how many atlas texels cover Hiyori's
face in a particular viewport, nor does it certify screen-space minification,
mesh density, masks, or composition. Those require the separate rendered
frame evidence for the target viewport and DPR.


## Current ordinary-bundle PAK follow-up (2026-11-08)

The earlier `3d775a…` result above is historical. The identical audit script was copied to a separate archive and rerun against current staged PAK `b08e3f07f3305c495b6f2f2d13ecb5da42778d24718e1a1d6ab82ceb7414b2fd` (69,216,560 bytes), preserving the old result. It exited 0: both original/staged 2048² RGBA8 PNG buffers exactly match the current PSM8888 PAK payloads byte-for-byte. The current ordinary app's six-resource manifest records the same PAK hash; this is file identity, not a screenshot of that process. Script/result/log/hashes are frozen in `sdk/.pocket-build/live2d-current-pak-texture-audit-20261108/`. No texture, decoder, sampler or production renderer changed.

A new attempt to inspect the ordinary app through the supported computer-use API failed at native-pipe startup, before obtaining app state or pixels. Thus the ordinary window's independent pixel check and physical Retina acceptance remain missing. Existing test-view captures and offscreen batch diagnostics must not be attributed to ordinary PID3303.
