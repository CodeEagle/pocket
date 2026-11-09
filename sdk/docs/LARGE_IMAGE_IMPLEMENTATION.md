# Large image assets

The current pinned Pocket PAK compiler rejects an image whose dimensions are
not powers of two or exceed 512 pixels per side. That is a constraint of this
pinned compiler/PAK path; this document does not infer that every future
Pocket renderer has the same maximum. Authoring images may remain at their
original resolution, but those files must not be sent directly to this PAK
compiler.

Before adding the preparation step, the source-first check inspected the
retained parent checkout `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
(excluding its `pocket_host/` directory). Its non-host sources contain image,
sprite and DeepZoom/TILESET usage references (`lib/render/pocket_ui_components.dart`
and `tests/verify_architecture.py`), but no reusable compiler-side large-image
preparer. The implementation therefore reuses the pinned source contracts and
resource paths (`sdk/.cache/pocketjs/tools/build.ts`,
`framework/src/pak.ts`, `framework/src/deepzoom.ts`) and keeps the app's existing
`scripts/prepare_textures.ts` as the one authoring-to-runtime conversion step.

Lantern keeps the original artwork in `demo/js/apps/lantern/art/masters/` and
the generated runtime variants in `demo/js/apps/lantern/art/`. The single
preparation script, `scripts/prepare_textures.ts`, uses macOS `sips` to create
512×512 runtime images from every entry in `images.json`. It never overwrites
the masters. The runtime draw geometry supplies the intended aspect ratio, so
the PAK texture remains within the pinned hardware limit without changing the
source composition.

`demo/js/scripts/build_mini_apps.ts` invokes this preparation step immediately
before building Lantern. This matters because staging calls `buildGuest`
directly and therefore does not execute the app's `package.json` scripts. A
missing preparation step previously allowed a 1024×1536 master to reach the
compiler and fail with a texture-dimension error.

For a direct Lantern build:

```sh
cd demo/js/apps/lantern
bun run prepare:art
bun ../../../../sdk/scripts/build_guest.ts --project-root=. --outdir=/tmp/pocket-lantern-build
```

For the Showcase staging path, use `bun demo/js/scripts/build_mini_apps.ts`;
the preparation is automatic. The generated PAK remains the only runtime
image source; ordinary audio and other binary files continue to be copied as
loose assets. If a future app needs zoomable artwork beyond 512 pixels, use
the existing DeepZoom/TILESET resource path rather than bypassing this
constraint or changing the pinned compiler in `node_modules`.

Validation on 2026-11-07 used these commands:

```sh
bun demo/js/apps/lantern/scripts/prepare_textures.ts
bun sdk/scripts/build_guest.ts \
  --project-root=demo/js/apps/lantern \
  --outdir=/tmp/pocket-lantern-build
```

The packaged compiler produced a valid QJBC and a 19,150,880-byte PAK with
all 13 declared images at 512×512; the build log is retained at
`/tmp/pocket-lantern-build.log`. This is compilation/PAK validation only. It
does not prove Flutter, Editor Preview, Web Canvas, GPU sampling, aspect-ratio
layout, or real-device visual display. The source masters are retained
separately and were not modified.

## Native Guest runtime evidence

The same generated artifacts were then executed by the release
`sdk/native/target/release/pocket_probe` (no source-eval fallback). The probe
created a 360×640 runtime, loaded `app.qjbc` plus `app.pak`, answered the real
`platform.storage.get` request with an empty result, sent a real pointer
down/up on the title-screen start control, and advanced fixed frames. The
summary is retained at `/tmp/pocket-lantern-runtime-evidence.json`.

At frame 8 the native frame contained 33 draw operations and 12 image operations
for `art/station.png`, `art/mira-worried.png`, and `art/ren-neutral.png`.
All three resources were uploaded as 512×512 RGBA textures. The first pixel
of the opaque background was `[38,29,24,255]` and all 262,144 background
pixels were non-zero; the character resources had transparent first pixels as
expected and were referenced with clipped UVs. This demonstrates that the
compiled PAK is decoded and referenced by actual Guest state after input, but
it is still not a Flutter/Editor screenshot or GPU/display acceptance test.

The only new staging change for this fix is
`prepareMiniAppAssets` at `demo/js/scripts/build_mini_apps.ts:127-147`, plus
its call immediately before the Lantern `buildGuest` invocation at line 424.
It runs the existing preparation script; it does not add another image cache,
renderer, or compiler.
