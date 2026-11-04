# Binary Bridge Protocol (`0xB1` / `0xB2`) & QuickJS Direct Object Transport

## Overview

The Pocket SDK replaces intermediate `JSON.stringify` / `JSON.parse` / `jsonEncode` / `jsonDecode` string serialization across the JS ↔ Rust (QuickJS) ↔ Dart FFI bridge with:

1. **QuickJS Direct Object Boundary (`rquickjs::Value`)**:
   - Outbound (`JS -> Rust`): `pocket._emitValue(packet)` accepts a native JS object (`Record<string, unknown>`, including `Uint8Array` views) directly on the QuickJS stack and encodes it in a single pass into the `0xB1` binary TLV wire format.
   - Inbound (`Rust -> JS`): When `globalThis.__pocketEvent` or `globalThis.__pocketDeliver` declares `__binaryCapable = true` (installed by `createHostBridge`, `createDisplayGeometry`, `createPocketPlatformClient`, and `PocketSystemKernel`), `pocket_send_binary` decodes the `0xB1` binary TLV payload directly into a `rquickjs::Value` (mapping `0x06` byte slices to `Uint8Array`) and invokes the JS handler with zero JSON string parsing.
   - Legacy `pocket._emit(jsonString)`, `pocket_send(jsonCString)`, and non-`__binaryCapable` JS handlers remain supported as automatic fallbacks.

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
