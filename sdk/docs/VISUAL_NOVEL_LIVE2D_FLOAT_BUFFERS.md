# Live2D detached float-buffer ablation

Date: 2026-11-08. This removes a small amount of repeated conversion at the
existing native resource boundary. It is not whole-game performance acceptance.

## Source and retained ownership

The retained parent `pocketjs_flutter_demo/lib/core/ffi_bridge.dart` has
typed shared-memory views (`sharedTransformBuffer`, `getZeroCopyTransformView`
and the duplex ring). It has no Cubism drawable transport. The current SDK's
`pocket_live2d_ffi.dart` already copies Core-owned arrays before returning a
drawable; `pocket_live2d_types.dart` serializes their little-endian binary fields.
The adaptation keeps the SDK's detached snapshot lifetime instead of borrowing
a mutable native view from the parent design.

Previously, `_copyFloats` boxed each native float32 component into an
unmodifiable `List<double>`, and `_float32Bytes` subsequently wrote each value
back into float32. The FFI reader now makes one detached, read-only
`Float32List` copy. On little-endian hosts, the encoder copies that typed range
as bytes. The returned packet still owns its bytes; mutable injected providers
cannot change an already-created response. Generic lists and other host
endianness retain the original element-wise encoder. No C ABI, protocol,
model lifecycle, geometry, cache or JS behavior was added.

The receiver rejects non-finite geometry; the finite Core float32 values retain
their existing wire representation. The tests also cover signed zero, normal
NaN/infinity encoding and float32 subviews with nonzero offsets.

## Measurement

Evidence directory: `sdk/.pocket-build/live2d-float-buffer-ablation-20261108/`.
It contains exact old/new source copies, executable benchmark sources, logs,
and `comparison-final.json` / `component-comparison.json`. Binaries are generated
cache, not source dependencies. Dart 3.13.7 AOT, macOS arm64, official Hiyori
Core 6.0.1, 134 drawables; 1,600 updates per process, first 200 excluded.
`ParamAngleX` changes every frame. The timed section includes defaults reset,
parameter application, Core update, complete drawable reading and packet-map
creation. Untimed byte hashing is the same in both variants. No Flutter
renderer, host-response binary codec or JS runtime is measured here.

| Order | Core read + encode mean (µs) | P95 (µs) | Encode mean (µs) |
| --- | ---: | ---: | ---: |
| Old | 142.785 | 161 | 39.551 |
| Typed copy + byte encoder | 87.719 | 116 | 39.372 |
| Typed copy + byte encoder | 86.489 | 103 | 39.164 |
| Old | 142.825 | 161 | 39.369 |

This boundary saves approximately **55–56 µs per update** in this workload.
The tiny absolute result must not be presented as fixing the game's
13–15 ms build time or the approximately 10 ms native-frame call.
The latter includes the complete Pocket runtime frame, not only Core.

A second component ablation retained the typed FFI snapshot but removed the
byte encoder. Its total means were 107.748 / 108.894 µs, versus
87.103 / 86.617 µs with both changes. Encoding means were
60.716 / 61.642 versus 39.619 / 39.190 µs. Thus retaining only the typed copy
leaves an avoidable element-wise pass through the read-only typed view.

All measured variants transported 43,025,564 array bytes with the same
32-bit byte-stream digest `1892444761`; the retained first response's digest
after model disposal was `347924335`. These digests are bounded consistency
checks, not collision-free proof. Directed tests below compare actual bytes
and validate independent lifetimes.

## Validation

- `live2d_drawable_bytes_test.dart` and `pocket_live2d_plugin_test.dart`:
  **18 tests passed**. Typed subviews, packet/provider mutation isolation,
  read-only buffers, generic provider rounding, empty arrays and full/cached
  topology shape are covered, alongside existing lifecycle/protocol cases.
- `live2d_core_bridge_test.dart`: **3 tests passed with real Core**, not skipped.
  Mao and Hiyori deformation and the binary host-response budget passed. The
  added case reads every Hiyori drawable, confirms real subsequent deformation,
  disposes the model, and verifies that all prior arrays and packets still hold
  their original values and that the FFI snapshots reject mutation.
  Log: `/tmp/pocket-live2d-float-buffer-core-20261108.log` (also archived).

The ordinary cached Demo has not been rebuilt for this small change. No new
whole-game FPS, physical-device, pixel or stable-RSS result is claimed.
