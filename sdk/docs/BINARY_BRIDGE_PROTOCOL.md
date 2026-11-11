# Binary Bridge Protocol (`0xB1` / `0xB2`) & QuickJS Direct Object Transport

## Overview

The Pocket SDK replaces intermediate `JSON.stringify` / `JSON.parse` / `jsonEncode` / `jsonDecode` string serialization across the JS ↔ Rust (QuickJS) ↔ Dart FFI bridge with:

1. **QuickJS Direct Object Boundary (`rquickjs::Value`)**:
   - Outbound (`JS -> Rust`): `pocket._emitValue(packet)` accepts a native JS object (`Record<string, unknown>`, including `Uint8Array` views) directly on the QuickJS stack and encodes it in a single pass into the `0xB1` binary TLV wire format.
   - Inbound (`Rust -> JS`): When `globalThis.__pocketEvent` or `globalThis.__pocketDeliver` declares `__binaryCapable = true` (installed by `createHostBridge`, `createDisplayGeometry`, `createPocketPlatformClient`, and `PocketSystemKernel`), `pocket_send_binary` decodes the `0xB1` binary TLV payload directly into a `rquickjs::Value` (mapping `0x06` byte slices to `Uint8Array`) and invokes the JS handler with zero JSON string parsing.
   - The shared JS SDK requires `_emitValue`; Dart requires `pocket_send_binary`, `pocket_frame_binary`, and `pocket_frame_delta_binary_v2`. Missing symbols fail with a rebuild-native error. They never select JSON automatically.
   - Legacy `_emit`/`pocket_send` and JSON frame exports are diagnostic interfaces for probes and explicitly old callers. They are not selected by the SDK. Binary input and duplex pointers reject a stale unmarked guest handler with a rebuild-guest error; they cannot stringify a fallback packet.

2. **Binary TLV Message Envelope (`0xB1`)**:
   - Magic byte: `0xB1` (`pocketBinaryMessageMagic`).
   - Value tags:
     - `0x00`: `null`
     - `0x01`: `false`
     - `0x02`: `true`
     - `0x03`: `int64` (little-endian `i64`)
     - `0x04`: `float64` (little-endian finite IEEE-754 `f64`)
     - `0x05`: `string` (`u32` LE byte length + UTF-8 bytes)
     - `0x06`: `bytes` (`u32` LE byte length + raw bytes; `Uint8Array` in JS ↔ `Uint8List` in Dart)
     - `0x07`: `array` (`u32` LE item count + encoded items)
     - `0x08`: `object` (`u32` LE entry count + (`u32` LE key byte length + UTF-8 key + encoded value)*)
   - Enforces the same structural safety invariants as the legacy bridge: max nesting depth `16`, finite floats only, acyclic objects, and `64 KiB` maximum wire payload size.

3. **Full Binary Frame FFI (`pocket_frame_binary`)**:
   - `pocket_frame_binary(host, delta_ms, out_byte_length)` returns the full `PFB1` binary frame buffer (carrying `0xB1` binary event slices) on initial `eval` / `load` / `loadBytecode` / `frameAt`, eliminating full-frame JSON serialization.

4. **Binary Offload Records (`0xB2`)**:
   - `pocket_offload_take_binary(host, cancel, out_byte_length)` and `pocket_offload_complete_binary(host, data, len)` exchange `0xB2`-prefixed binary offload request, cancellation, and completion records between Rust and Dart without JSON string allocation.

## Source Paths

- Native Rust:
  - `sdk/native/include/pocket_flutter.h`
  - `sdk/native/src/binary_bridge.rs`
  - `sdk/native/src/lib.rs`
- JS SDK (`@pocket/ui`):
  - `sdk/packages/pocket_ui/src/host.ts`
  - `sdk/packages/pocket_ui/src/ui.tsx`
  - `sdk/packages/pocket_ui/src/display.ts`
  - `sdk/packages/pocket_ui/src/platform.ts`
  - `sdk/packages/pocket_ui/src/system.ts`
- Dart SDK (`pocket_flutter`):
  - `sdk/packages/pocket_flutter/lib/src/pocket_binary_codec.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_model.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart`

## Native object decoding

The retained parent demo dispatches action maps in
`pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` and uses JSON
strings at the native boundary in
`pocketjs_flutter_demo/native/pocket_runtime_multi.c`. The SDK reuses its
existing TLV decoder and the pinned rquickjs/QuickJS property-definition
operation to deliver those values directly to the guest.

Each object entry becomes a writable, enumerable, configurable own data
property. Duplicate keys keep the last value. The decoder calls
`JS_DefineProperty` with borrowed values to avoid building rquickjs descriptor
wrappers for every field. ASCII keys use length-aware atom lookup, including
embedded NUL bytes. Other keys become QuickJS strings before atomization to
avoid matching UTF-8 bytes against an existing Latin-1 atom.

The native tests cover inherited setters, `__proto__`, UTF-8 key collisions,
embedded NUL bytes, numeric key ordering and duplicate keys. On Apple M4, six
alternating release-build batches through `pocket_send_binary` measured median
dispatch times of 1.82 → 1.66 µs for an eight-field payload and 9.18 → 7.95 µs
for an 80-field payload, compared with the previous `Object::prop` decoder.

## Typed host surfaces (2026-11-05)

`PFB1` version 1 flags are bit 0 (text alignment and compositor handle/focus)
and bit 1 (typed surface descriptors). Current native frames set flags to 3.
After tag 7's common geometry the wire is:

1. length-prefixed UTF-8 `id`
2. length-prefixed UTF-8 `kind`
3. length-prefixed `0xB1` object containing the parameters
4. signed handle encoded as `u32`, followed by `u8` focused (bit 0)

The Dart decoder rejects old JSON surface descriptors, unknown flags and JSON
event slices. `registerSurface` receives a JS object; the binary descriptor is
retained in node metadata instead of being stringified and parsed every frame.
Diagnostic JSON frame serialization alone reconstructs the historical `asset`
descriptor for the editor/probe contract.

The pinned offload client uses `submitValue(request)` and `takeValue()` for
QuickJS/native envelopes. The broker retains typed replies and constructs JS
objects directly; its Dart provider boundary uses B2. Capability payload strings
remain opaque provider data. Old `submit`/`take` strings are explicit legacy
adapters, and persisted trace compatibility is handled only in trace/replay.

The WeChat adapter copies the same native object codec into its reproducible
Wasm build. Its JS adapter implements the same `0xB1` tags for host events,
responses, input facts and scheduler state. It does not retain a second guest
runtime or a string fallback. Build metadata, storage snapshots, recordings,
update signatures and editor HTTP APIs still have intentional JSON formats;
this protocol does not claim those files or formats were removed.

See [the rendering and transport review](RENDER_PIPELINE_REVIEW_20261105.md)
for provenance, ablation and measured limitations.
