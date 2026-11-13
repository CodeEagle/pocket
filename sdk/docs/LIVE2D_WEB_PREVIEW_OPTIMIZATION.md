# Live2D Web preview audit follow-up

Historical cache-only results below precede the mesh rasterization fix. See
[Web Live2D mesh rasterization](WEB_LIVE2D_MESH_RASTERIZATION.md) for the current
GPU path, changed seam coverage, and hardware/software GPU measurements.

2026-11-12. Reviewed `pocket-live2d-web-preview-optimization.md` (static review of
`9fddb84`); implementation baseline is `2aa2db8`.

## Source-first integration

Inspected the retained parent `../pocketjs_flutter_demo`, excluding `pocket_host/`.
`web_wasm_preview/index.html` supplies the original Canvas/ring-buffer preview;
`lib/core/ffi_bridge.dart`, `lib/core/pocketjs_bundle_runner.dart` and
`lib/render/pocket_ui_components.dart` retain the thin-host boundaries. There is
no Cubism/ArtMesh implementation in the retained parent JS/Dart preview sources.
The existing SDK Live2D provider, PMS1/MFX1 contracts and shared Canvas compositor
are therefore the applicable source, rather than a new renderer/runtime.

Retained behavior: JS owns models, animation and effect policy; the pinned guest
compiler/engine own execution and retained geometry. Full and `cached-v1`
responses keep the same wire format. No Dart changes or consumer imports added.

## Changes and ablations

| Finding | Decision in this change |
| --- | --- |
| 1, per-triangle Canvas rendering | Remains; WebGL requires a separate renderer acceptance project. Mask triangle decoding is reused within one model projection. |
| 2, isolated layers/masks | Preserve layers. Reuse the most recent identical ordered mask list in the existing scratch canvas, within one frame only; inversion remains a content-composite operation. |
| 3, repeat patterns | Cache patterns by immutable texture canvas and drawing context, using weak keys. Dynamic canvas-only resources remain uncached. Invalidate on tint eviction/resource disposal. |
| 4, full-atlas tint | Preserve bounded tint cache; additionally dispose its canvases/pattern entries with the source. Changing tint math is deferred. |
| 5, provider hot-loop allocations | Numeric validation constructs error text only on failure; remove per-vertex temporary array/closure and color subarray views. Write PMS1 through typed views on little-endian platforms, with explicit DataView fallback. Validate every update, including in-place Core mutations. |
| 6, static geometry/delta protocol | Deferred. No `cached-v2`, topology alias cache, flag-only skip or packed parameter protocol added. |
| 7, Guest effect submissions | Encode separately from last successfully committed bytes and submit only on byte changes. Resolve mask node IDs before comparison. Effect removal still sends an empty payload. Replace repeated membership scans with one Set. Geometry updates remain versioned. |
| 8–11, transport/worker/present/assets | Deferred. Need separate measurements and compatibility work; this patch does not solve JSON frame size, worker ownership, full-frame uploads or atlas size. |

The review's proposed `drawImage` fast path was tested against the existing
repeat-pattern path using official Hiyori. It changed pixels (maximum component
delta 76) and was slower than caching patterns while preserving repeat rendering.
Bypassing plain layers changed pixels too (maximum delta 6). Both were removed.
The combined pattern/mask cache produced **zero differing RGBA components**.
These are observations for this browser/model, not a general proof about all
possible rendering implementations.

Do not assume an unchanged array reference means unchanged UV/index contents.
Also, existing `VISUAL_NOVEL_LIVE2D_GEOMETRY_ABLATION.md` records native Hiyori/Mao
reporting position-change flags for byte-identical geometry. A delta protocol
must be measured and verified independently before using flags to skip updates.

## Measurements

Playwright Chromium, official Hiyori MOC3/Core, two original 2048×2048 atlases,
`ParamAngleX=20`, 240×340 surface: 130 nonempty meshes, 125 visible. Three warm-up
draws followed by 12 measured draws. Same input PMS1/resources for both versions.

| Metric over 12 warmed frames | Baseline | Optimized |
| --- | ---: | ---: |
| `createPattern` calls | 44,040 | 0 |
| `clearRect` calls, including target | 1,608 | 1,536 |
| `drawImage` calls | 1,596 | 1,596 |
| RGBA differences | — | 0 (14,227 covered pixels) |
| Median submission time, representative repeat | 17.6 ms | 15.5 ms |

Submission timings varied between runs (another repeat: 17.8 → 15.2 ms).
These synchronous JS timings exclude deferred GPU completion and are **not FPS
or end-to-end animation latency**. No flaky timing threshold is imposed in CI.

Reproduce from repository root, with local licensed caches and Playwright ready:

```sh
git show 2aa2db8:sdk/editor/client/preview.js > /tmp/pocket-preview-baseline.js
node sdk/scripts/benchmark_live2d_canvas.mjs /tmp/pocket-preview-baseline.js
```

Override `POCKET_CUBISM_WEB_CORE` and `POCKET_HIYORI_ROOT` for other cache locations.
The script fails on empty output; `POCKET_BENCH_EXPECT_IDENTICAL=1` additionally
requires identical pixels for cache-only experiments. The GPU seam fix deliberately
changes pixels. Set `POCKET_BENCH_HEADFUL=1` to measure the hardware GPU locally.
The script never downloads Core.

Additional real-Core comparison against the baseline provider checked all mesh,
mask-index and color bytes over four updates (angles 0, 20, -15, 20): **368,704
bytes identical** across 134 drawables, including `cached-v1` responses.

## Validation

- `preview_mesh_effect.test.ts`: normal/inverted masks, repeat UV, tint, blend,
  warmed pattern reuse, shared mask raster, mask geometry mutation and mutable
  canvas texture updates. Existing tint/triangle-alpha tests pass.
- `live2d_web_provider.test.ts`: little-endian golden PMS1, changed UV/index
  contents, rejection of NaN/negative/out-of-range values; real Hiyori deformation.
- `novel_model_commit_guest.test.ts`: actual pinned QJBC/native execution. Six
  advances retain changing geometry; both batched and unbatched controls submit
  exactly three effects: initial, in-place tint mutation, removal. Existing
  failure/recovery input scenarios also pass.
- `novel_stage_live2d_browser.test.ts` and `live2d_preview_guest.test.ts`: 3 pass,
  real stage playback, deformed Guest Preview meshes and retained child assets.
- `live2d_web_browser.test.ts`: real Hiyori QJBC animates through both main and
  render Worker, using freshly bundled JS and the published 0.1.12 WASM engine.

The local Rust toolchain reports a pre-existing `rust-objcopy`/`libLLVM.dylib`
debug-stripping warning; bytecode builds and executable checks still succeed.

Argon Medium consolidated review reported no blocking defect. Its suggested
repeated-empty-effect concern is prevented by the existing early return
`!mesh.effect && !effectBuffers.has(node)`. The Guest fixture additionally
continues two advances after removal to verify the count stays at three.
