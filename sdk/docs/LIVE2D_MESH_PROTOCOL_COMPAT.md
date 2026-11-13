# Live2D mesh protocol compatibility

Date: 2026-11-12

## Source-first review and regression

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched outside `pocket_host/` for Live2D, Cubism, `positionsXYPixels`, and
drawable mesh transport. It has no Live2D model loader, mesh protocol, or
regression scenario to port. The reusable parent behavior remains its generic
native boundary in `lib/core/ffi_bridge.dart` and Guest lifecycle in
`lib/core/pocketjs_bundle_runner.dart`; neither contains Live2D policy or mesh
shapes. SDK Live2D remains JS-owned for motion and model policy, with Flutter
providing the native capability and rendering surface.

The compatibility regression was introduced by commit
`6035de9a5b78a25dbff5437a631fcbbf84a17407` (`perf(live2d,host): native PMS1
mesh packing, render stage attribution, and pre-first-frame initialEvents`,
2026-11-10). That change replaced the response's
`positionsXYPixels`/`uvs`/`indices` fields with `meshBytes`; the Dart provider
then emitted PMS1 for every Guest, without a request-level format negotiation.
An older compiled Guest still read `drawables[0].positionsXYPixels` as a JS
array and failed when the newer provider omitted it. Rebuilding the current
Showcase Guest alone cannot fix consumers that already ship older bytecode.

## Protocol and retained behavior

- An absent `meshFormat` keeps the legacy response contract. Geometry,
  topology, mask links, and color channels cross the capability boundary as
  ordinary arrays, so Guests using `Array.isArray` can continue to execute.
- A request with `meshFormat: "pms1"` opts into packed output. The native Core
  provider still writes transformed PMS1 bytes directly during update; JS
  forwards those `Uint8Array` buffers without decoding vertices or copying the
  mesh.
- Direct Dart callers of `PocketLive2dDrawable.toJson()` keep its PMS1 default;
  the plugin explicitly selects the representation from each request.
- `cacheStaticTopology` remains independently supported for legacy callers.
  The first frame includes the legacy arrays and later frames retain the
  existing `cached-v1` sparse shape, with positions and dynamic facts updated
  each frame and static UV/index/mask arrays omitted.
- The new JS client explicitly requests PMS1. If an older native provider
  ignores that request and replies in the legacy format, the client packs only
  that compatibility response into the public PMS1 frame. Placement is applied
  during that fallback pack. The native PMS1 route stays single-pass.
- The provider schema describes both optional mesh representations; the
  request field is an optional enum. Unsupported non-empty format values are
  rejected rather than guessed.

This preserves the measured packed path while providing a version boundary
that old Guest bytecode can discover through the original request shape. No
second Dart model state machine or duplicate topology cache was added; the
existing per-model topology cache now records which of the two wire shapes it
is holding.

## Source paths and validation

Implementation is in `packages/pocket_live2d/src/transport.ts`,
`lib/src/pocket_live2d_plugin.dart`, and `lib/src/pocket_live2d_types.dart`.
Regression coverage is in `test/live2d.test.ts`,
`test/pocket_live2d_plugin_test.dart`, and
`test/live2d_drawable_bytes_test.dart`. Direct real-Core PMS1 fixtures in
`test/live2d_core_bridge_test.dart` and `test/live2d_guest_pixels_test.dart`
now explicitly negotiate the packed format.

## Validation performed

- `bun test test/live2d.test.ts`: 12 tests / 40 expectations passed, including
  the legacy-host response conversion, cached-topology reuse, and PMS1
  request negotiation.
- `fvm flutter test --no-pub test/pocket_live2d_plugin_test.dart
  test/live2d_drawable_bytes_test.dart`: 21 tests passed, including the
  unnegotiated legacy array response, cached legacy response, explicit PMS1
  path, and byte-for-byte packing checks.
- The Mac real Cubism Core + freshly compiled QuickJS Guest + Flutter pixel
  regression passed: 1 test in 4 seconds. The model-only output is
  `sdk/packages/pocket_live2d/.cache/hiyori-guest-pixels/hiyori-model.png`;
  the run log is `/tmp/pocket-live2d-compat-pixels-rerun.log`.
- An additional one-off Flutter widget smoke executed Lantern's published
  `0.1.0-test.6` Guest through `PocketGuestSession`, the current
  `PocketLive2dPlugin`, and real macOS Cubism Core. The Guest's QJBC was
  1,241,375 bytes with SHA-256
  `4293e294fc1a018b62321fa2d0298b11f4bff7ed2a33c8799461619af7553dd3`, and
  its PAK was 69,631,776 bytes with SHA-256
  `8f2e5ed95f54d483aa1392cf4502fd759ce8e1f84eba2bcb9d82b17249cc6e2f`;
  both hashes matched the published test6 manifest payload and release blobs.
  Real Guest input navigated from the title through the Hiyori showcase,
  loaded one model, drew 3,384 texture triangles, and showed Core-driven mesh
  position changes on later frames without setting `PocketSession.lastError`.
  The one-off test file was removed after the run. This verifies the current
  local Flutter/Core host against the published Guest artifacts, not the
  Flutter binary or resident Guest installed on the user's iPhone.
- The physical iOS device was not redeployed or retested in this pass. The
  report verifies the cross-version protocol and Mac rendering path; it does
  not claim a new iOS device screenshot.
