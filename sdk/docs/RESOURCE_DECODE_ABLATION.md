# Resource decode copy ablation

## Source-first review

The retained parent project was inspected without entering `pocket_host/`.
In `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`, the old
`Image`/`Sprite` nodes register native texture handles with
`uiSetImageSprite`; `_PocketHighDpiImagePainter` draws a generated preview and
does not decode PAK pixels into a Flutter image. The parent therefore has no
pixel decoder to transplant. Its intended typed-byte boundary is described in
`pocketjs_flutter_demo/docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md`;
its audit report also calls out the previous JSON pixel-array copying cost in
`pocketjs_flutter_demo/POCKET_SDK_AUDIT_REPORT.md`.

The current SDK already adapts the actual image-resource path to the thin host:
`sdk/packages/pocket_flutter/lib/src/pocket_model.dart` carries owned
`PocketImageResource` bytes, `pocket_view.dart` manages image revisions and
release epochs, and `pocket_assets.dart` converts the native formats before
creating `ui.Image`s. Those behaviors stay in place.

## Change and retained behavior

The synchronous resource and PAK decoders used `Uint8List.sublist` several
times to make temporary byte copies before writing the final RGBA buffer. The
decoder now reads bounded `Uint8List.sublistView` slices for packed pixels,
palette indices, PAK names and PAK entries. This removes intermediate byte
copies while retaining the same PSM 0/2/3/5 conversion, PackBits handling,
asset aliases, and malformed-entry rejection.

Each returned `PocketPakImage.rgba` remains a newly allocated buffer. This is
needed because the source resource may be mutated or reused after frame
decoding. `PocketPakImage.decode` also keeps the straight-to-premultiplied
conversion copy required by Flutter's `rgba8888` image boundary and the
transparent-edge behavior it preserves.

## Validation

`pocket_assets_test.dart` covers PSM 0/2/3/5 for both resource and PAK paths,
compressed and uncompressed PAK entries, offset input views, trailing padding,
and output ownership after mutating the source. `pocket_glyph_render_test.dart`
continues to verify T8 page decode, glyph UV reuse, tint, alpha coverage and
clipping.

Validation command:

```sh
cd sdk/packages/pocket_flutter
flutter test test/pocket_assets_test.dart test/pocket_glyph_render_test.dart
```

Result: all 13 tests passed.
