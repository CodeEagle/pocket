# Lantern parallax foreground art

2026-11-08. This is a new transparent foreground plane for the existing VN
stage, not a replacement background, static model substitute, or UI control.
The reusable layering contract and retained-parent gap are documented in
[background layers](VISUAL_NOVEL_BACKGROUND_LAYERS.md).

## Selected source

- Workspace asset: `demo/js/apps/lantern/art/fx/parallax-lantern.png`.
- Authoring master: `demo/js/apps/lantern/art/masters/fx/parallax-lantern.png`;
  the workspace master copy has the same source SHA-256.
- Built-in GPT Image generation with actual transparent background; final
  selected PNG is 1671×941 with alpha. Original output is preserved in the
  local generated-images directory; the game references the workspace copy.
- SHA-256: `c68f831a72dde2517a0fb6348da5627d40b723b672cb1ced801f6c677d5b2abf`.
- Brief: a wet vintage brass station lantern, warm amber glass, painterly
  midnight harbor style, transparent center and lower area, no text/UI/people.
- The initial right-edge placement was rejected because center-cropped phone
  viewports would hide it. A targeted image edit moved the lantern to 58% of
  the landscape canvas width and removed the old copy. This selected image
  is inspected as a transparent overlay; no raster image was edited by code.

## Reproducible PAK preparation

The retained parent checkout was inspected outside `pocket_host/`. Its
`lib/render/pocket_ui_components.dart` has a high-DPI sample painter, but the
non-host sources have no image-to-PAK preparation step to reuse. Lantern keeps
its existing `scripts/prepare_textures.ts` and `images.json` instead of adding
a second asset manifest or renderer. `images.json` registers this item as
linear-sampled and sets `sourceSize: true`; the texture preparer consumes this
flag and the Guest build consumes the prepared PNG. Whether the pinned compiler
ignores this additional manifest metadata has not yet been confirmed by a
build of this asset revision. The final build must verify that compatibility
and that image options remain unchanged.

The raw PNG is 1671×941, which cannot be placed directly in the pinned static
PAK IMG format: each side must be a power of two and no larger than 2048. The
preparation step therefore makes a 2048×1024 transparent RGBA canvas without
resampling the source: it places all original pixels at x=188, y=0, leaving
188/189 transparent columns left/right and 83 transparent rows below. Top
alignment keeps the hanging chain at the original top edge. Existing regular
PNG entries still bake to 512×512 with `sips`; `.pocket-build/live2d/**`
entries are skipped because `prepare_live2d.ts` owns those original-size
textures.

The master copy retains SHA-256
`c68f831a72dde2517a0fb6348da5627d40b723b672cb1ced801f6c677d5b2abf`. The
prepared runtime PNG SHA-256 is
`a1d2abbd4d3c3781b12446f9851d1cbe0e5ac6b7fef6935645c5abd0c7007c76`.
The reusable preparation command is:

```sh
cd demo/js/apps/lantern
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun scripts/prepare_textures.ts --only=art/fx/parallax-lantern.png
```

For this asset the script invokes FFmpeg 8.1.1 with the equivalent operation:

```sh
ffmpeg -hide_banner -loglevel error -y -i art/masters/fx/parallax-lantern.png \
  -vf 'format=rgba,pad=2048:1024:188:0:color=black@0,format=rgba' \
  -frames:v 1 -c:v png -pix_fmt rgba art/fx/parallax-lantern.png
```

The targeted run produced the expected 2048×1024 RGBA PNG. `framemd5` of the
original and the runtime crop at `(188,0)` matched exactly
(`abaf25ce7d626bb08254517a6f69aaa9`); alpha checks on each padded region
reported min/max zero. These checks prove the preparation preserves source
pixels and transparent padding. They do not prove PAK inclusion, decoded
Guest display, layering, camera transforms, save/load or replay isolation;
the final Guest still needs those acceptance runs. The stage's registered
image dimensions must describe the 2048×1024 packed canvas so its transparent
padding retains its authored placement.
