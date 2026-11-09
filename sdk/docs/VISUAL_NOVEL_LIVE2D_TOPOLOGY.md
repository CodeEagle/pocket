# Live2D static drawable topology

## Source check and reason for the adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched outside `pocket_host/` for Cubism and Live2D model support. It has
no Live2D loader, mesh/topology transport, or model regression to port. The
reusable host patterns remain `lib/core/ffi_bridge.dart` for the native
boundary and `lib/core/pocketjs_bundle_runner.dart` for guest lifecycle. The
existing SDK Live2D route is retained: JS owns motion and model policy, Cubism
Core deforms, and the existing Pocket mesh and painter render the returned
facts.

The optimization addresses a measurable duplicate transfer in that existing
route. On each model update, Core changes positions and dynamic draw facts;
UVs, index lists, and mask links are static for a loaded MOC. The previous
bridge nevertheless copied, packed, serialized, unpacked, and validated all
three static arrays on every frame.

## Evidence from Cubism Core

The [official Cubism Core API Reference, r15](https://cubism.live2d.com/sdk-doc/reference/NativeCoreAPIReference_en_r15.pdf)
states that Drawable data contains static and dynamic information and that
static information can be cached by the application (PDF pages 20–21). Its
Drawable list classifies the vertex UVs, indices, mask counts and mask links
among static fields, while vertex positions and other pose/render facts are
updated as the model parameters change. The official [API reference page](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core-api-reference/)
describes Core as calculating parameter-driven vertex information and
providing rendering data; it does not contain drawing functions.

The Pocket change follows that distinction:

- `native/src/pocket_live2d_core.cpp` copies UVs, indices and mask links while
  creating the model. Each subsequent Core update copies positions and
  current dynamic facts, and rejects changed drawable counts or topology
  lengths rather than mixing generations.
- The Dart FFI adapter still exposes the original full-frame
  `PocketLive2dCoreModel.drawableAt(index)` contract. A separate optional
  `PocketLive2dCoreTopologyReader` lets the built-in provider skip copying the
  static arrays after its first opt-in frame. Old injected providers remain
  source-compatible; an opt-in request to a provider without that extension
  fails before resetting or updating the model.
- `PocketLive2dPlugin` sends one complete frame on first opt-in update and
  retains only drawable identity and topology counts per native model handle.
  Later `cached-v1` replies omit UV/index/mask byte buffers. A new model handle
  starts with a full frame.
- The `@pocket/live2d` transport retains the first frame's static arrays,
  checks each sparse frame against that topology, then returns the same public
  complete `PocketLive2dFrame` used by existing renderers. Release clears the
  per-model cache. A sparse frame before that handle's first full frame is an
  error; there is no invented fallback geometry.
- `createNovelLive2dFactory` accepts the opt-in
  `cacheStaticTopology` option. It defaults off, and the request omits the new
  field unless callers explicitly enable it, preserving the old request shape
  for hosts that have not installed the updated provider.

Positions, IDs, texture index, draw/render order, blend mode, constant and
dynamic flags, opacity, multiply color and screen color remain current per
frame. Mask index lists are static topology and are restored into the complete
JS frame from the first response. The SDK's public frame shape and existing
renderer do not change.

## Verification performed

These checks cover the protocol, provider lifetime, and real Core's static
topology contract. They do not establish a whole-game frame-time improvement.

```sh
cd sdk/packages/pocket_live2d
flutter analyze --no-pub
flutter test --no-pub test/pocket_live2d_plugin_test.dart
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test test
sh scripts/run_macos_core_probe.sh
/tmp/pocket-live2d-core-build/pocket_live2d_core_probe \
  .cache/hiyori-guest-pixels/flutter-assets/native-models/0323f5f377b9afef54318be09e9b4eea2a8cb266190ff9d2f843f95ecb77716c.moc3 \
  --repeat 1
cd ../pocket_vn
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test test/live2d.test.ts
```

Results at this source checkpoint:

- `flutter analyze --no-pub`: clean.
- Native plugin tests: 14 passed, including baseline full-frame output, first
  full then sparse updates, topology-change rejection, release/reload reset,
  and the legacy injected-provider contract.
- `@pocket/live2d`: 13 tests / 61 assertions passed. The sparse merge check
  verifies dynamic flags, colors, ordering, positions and opacity remain
  current while UVs, indices and masks come from the first frame. It also
  verifies a sparse first frame after release/reload is rejected.
- `@pocket/vn` Live2D: 3 tests / 35 assertions passed.
- Official Cubism Core probe on Mao: 262 drawables, 6,020 vertices, 23,829
  indices across eight create/update/destroy repetitions; real position
  deformation occurred and reset restored the initial pose and identical
  UV/index/mask topology.
- Official cached Hiyori MOC3 Core probe: 134 drawables, 2,822 vertices,
  10,278 indices; 2,903 position components changed (maximum 61.8301 px),
  reset restored defaults, and the static topology remained identical.

The Core probes are functional checks, not profile measurements. No Demo
Guest, PAK, Flutter app, or long profile was rebuilt for this checkpoint.

## A/B boundary and remaining performance question

The implementation contains two separable changes. Native Core now copies
static topology into its retained drawable vectors only at model creation;
that behavior is currently ungated. The `cacheStaticTopology` option controls
the Dart/JS bridge path: disabled mode keeps the old full request/response,
Dart copies, packing, and JS unpacking; enabled mode sends one complete frame
and then sparse dynamic frames while preserving the same complete JS result.
An off/on result therefore measures the bridge change on top of Core's
copy-once behavior. It does not measure the independent native copy-once
change.

For a valid performance comparison, both variants must use the same current
Lantern story revision, assets, fonts, toolchain, native host build, route,
model-window order, and profile procedure. The only source/config difference
should be the factory option in `demo/js/apps/lantern/app.tsx`: the baseline
construction currently omits it, and the candidate can pass
`{ cacheStaticTopology: true }`. Use the same `build_mini_apps.ts`/pinned
`buildGuest` pipeline for each variant, preserve each output QJBC and PAK with
its SHA-256 before rebuilding the other, then run the same model soak/profile
route with the same order and durations. Record each QJBC/PAK hash, actual
frame/build P95, raster P95, and over-budget share; do not compare against the
older r3 story or font artifact and attribute its difference to this cache.
The current option is selected when constructing the factory, so the two
variants share the same head and all inputs except that one setting, but are
separate guest artifacts. No runtime UI toggle was added.

Keep the candidate only if the complete profile meets the existing absolute
budget; a smaller bridge packet or faster micro-check alone is not sufficient.
The documented target is build P95 at or below 12 ms, raster P95 at or below
8 ms, and over-budget frames at or below 1%. Until the controlled profile is
run, this optimization has no whole-game speedup claim.

## Same-head OFF/ON guest artifacts

The isolated source and two guest outputs for the first controlled comparison
are preserved under the ignored directory
`sdk/.pocket-build/novel-topology-ablation-20261108/`. Run
`build_variants.ts` there with the pinned high-resolution tools to reproduce
them. The script snapshots the current Lantern consumer and staged Hiyori
files, points all four SDK dependencies at the same local SDK packages, and
builds separate OFF and ON output directories with `buildGuest` at density 1.
It verifies that 93 of 94 project files are byte-identical and that the only
`app.tsx` edit is the factory option shown above. `source-snapshot.json`,
`source-parity.json`, both build logs, and `artifacts.json` record the exact
inputs and outputs.

At this checkpoint the OFF QJBC is 1,037,825 bytes
(SHA-256 `76e60254e251edd35de3f49a53862faea13852727a31c1351aa32aa1316292a2`)
and the ON QJBC is 1,037,832 bytes
(SHA-256 `0457e109c44662bf560d06aa6da9d5d5e1f060f888fe6470f63c4b6b48200c39`).
Both PAKs are 60,750,896 bytes with SHA-256
`d499c3e7152d42d28bfbcefc1dcc970c62e5f58f36216510fea5d404aa19e323`; each
contains 35 entries. The guest manifests are byte-identical. The emitted JS
bundles include incidental project-root and random temporary-wrapper names;
after normalizing only those build paths, their only code difference is the
factory call's `cacheStaticTopology` option. The QJBC hashes therefore differ
as expected for the source change and build paths; these OFF/ON artifacts are
the controlled pair for profiling, not copies of the already-installed
production QJBC. The build script does not install either artifact into the
Demo; profile orchestration selects/stages a variant separately.

These artifact facts establish a controlled input pair, not a performance
result. Record the profile metrics and decision separately after both variants
are measured with the same route and host build.


## Controlled macOS Profile result — 2026-11-08

Both variants above completed the identical five 10-second model windows and
two real enter/exit cycles using `POCKET_NOVEL_PROFILE_ABLATION=true`.
The ordinary playable app ran independently; test storage was isolated.

| Window | OFF build P95 ms | ON build P95 ms | OFF / ON over-budget frames |
| --- | ---: | ---: | ---: |
| hiyori_idle_0 | 19.891 | 15.225 | 146 / 6 |
| hiyori_idle_1 | 19.890 | 15.007 | 151 / 3 |
| hiyori_idle_1_closeup | 19.650 | 14.120 | 149 / 2 |
| hiyori_idle_0_repeat | 19.883 | 14.518 | 156 / 4 |
| hiyori_idle_1_repeat | 19.815 | 15.840 | 128 / 13 |

OFF had 730 / 2,060 frames over 16.67 ms (35.44%); ON had 28 / 2,054
(1.36%). Raster P95 was 0.999–1.067 ms OFF and 0.991–1.124 ms ON.
Each variant ended both handle cycles at zero active models and zero model
triangles. Both retained the real 2048 textures and reported actual deformed
coordinates. The bundled bytecode metadata matches its selected variant.

Logs: `/tmp/pocket-topology-off-profile.log` and
`/tmp/pocket-topology-on-profile.log`; structured reports:
`sdk/.pocket-build/novel-topology-ablation-20261108/{off,on}-profile.json`.
Both commands exited zero with All tests passed. These are two sequential
process runs, not randomized repeated trials or same-pose pixel comparisons.
The reduced frame cost is evidence for this bridge candidate, not proof of
the independent ungated C++ change or all-platform performance.

The absolute build P95 ≤12 ms and over-budget ≤1% gates still fail.
The candidate remains explicit opt-in/default-off pending further optimization
and parity checks; the normal consumer was not enabled. Production guest
assets were restored to QJBC `06656d13ac04a7ceec9931b79c0933dbe6f2b513d48137ca4ba4cb3c6f3e7694`
after the experiment; PAK remained `d499c3e7…aa19e323`. Two cycles do not
replace the separate 20-cycle stabilized-memory, clock and audio acceptance.
