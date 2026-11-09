# PFB1 borrowed-frame parsing

## Scope and source check

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was checked outside `pocket_host/`. Its `lib/core/ffi_bridge.dart` exposes a
borrowed `asTypedList` view for the duplex ring buffer, but its frame path is
JSON-based and has no typed PFB1 frame parser to reuse. The current PFB1
boundary is an SDK adaptation: `pocket_runtime.dart` receives a native frame
pointer and `pocket_model.dart` decodes the typed packet.

This change removes only the Dart staging copy of the complete native frame.
It preserves the owned resource fields in returned `PocketFrame`s and the
existing frame/error behavior. The wider resource lifetime and decode path is
documented in [the image resource audit](VISUAL_NOVEL_IMAGE_RESOURCE_AUDIT.md).

## Change and lifetime guarantees

Both the full-frame PFB1 path and binary-v2 delta path now parse
`pointer.asTypedList(byteLength)` synchronously. The borrowed view is not
retained, passed across an `await`, or used after another native call. After
parsing, the runtime queries `lastError`; a native error still takes priority
over a packet parse error. The delta base is updated only after parsing and
that error check both succeed.

The parser materializes frame objects and owns retained byte values:

- `PocketFrame.fromBinary` uses `reader.bytes()` with its default `copy: true`
  for resource pixels and palettes. Its strings and numeric operations become
  Dart values during synchronous parsing.
- Binary bridge byte values are copied by `readBytesOwned()` during TLV decode.
- The binary-v2 delta decoder uses the same parser for full-frame packets and
  copies resource fields in delta packets before returning.

The real FFI regression constructs a PAK with a 2048×1024 PSM_8888 image
(8,388,608 RGBA bytes) and a PSM_T8 image plus palette. It retains the parsed
frame, replaces the native output with different image/palette bytes, and
checks that the earlier frame still contains its original pixel and palette
values. This guards the boundary where a borrowed packet could otherwise leak
into a saved Flutter frame.

## Focused timing observation

The same focused test measured eight 2048×1024 viewport resynchronizations per
run. It discards the first two samples and reports the median of the remaining
six. On the existing macOS arm64 native library, one baseline run before the
change reported `3206,3937,1786,3027,3931,1953 µs` (median `3116 µs`). One
candidate run reported `1178,930,959,1572,2726,1046 µs` (median `1112 µs`).
These are diagnostic timings for that serialized 8 MiB resource fixture; later
run medians varied, so this is not an FPS or whole-game performance claim and
there is no measured RSS claim.

The source change removes one transient allocation/copy of `byteLength` bytes
per full PFB1 packet—8 MiB for this fixture. It does not remove the owned
resource-pixel copy, native serialized frame buffer, decoded RGBA/premultiply
buffers, retained PAK data, Core texture allocations, or Flutter image cache.

## Validation

Tests used Flutter 3.47.9 and the prebuilt arm64 macOS dylib
`sdk/native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib`
(SHA-256 `2c95ea4522493b44e9a23f8e981d5a8eb190c128ddce93874e18ef899548691c`).
No native library or application build was run.

From `sdk/packages/pocket_flutter`:

```sh
POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib \
  /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test --no-pub \
  test/pocket_model_test.dart \
  test/pocket_frame_binary_ffi_test.dart \
  test/pocket_assets_test.dart
```

Result: **31 tests passed** with the native-library environment set, including
the real 2048×1024 copy-lifetime test and PFB1/binary-v2 parsing, event,
resynchronization, and PAK conversion cases.

```sh
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/dart analyze \
  lib/src/pocket_runtime.dart test/pocket_frame_binary_ffi_test.dart
```

Result: **No issues found.**
