# Visual novel image resource audit

## Finding

The current Lantern v4 package is 69,193,344 bytes (`app.pak`, SHA-256
`8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08`), as
recorded in
[`lantern-v4-scaled-20261108/release-artifacts.json`](../.pocket-build/lantern-v4-scaled-20261108/release-artifacts.json).
The requested four 1024×1536 backgrounds are not all turned into Flutter
`ui.Image`s at startup. The current native loader does, however, upload every
`ui:img.*` PAK entry into the Core texture table during package installation,
including entries that the opening scene never references. Flutter image
conversion is later and demand-driven from the current DrawList.

## Source-first check

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched under `lib/`, `mini_apps/`, and `test/`, excluding
`pocket_host/`. It has no `ui:img.*` PAK admission, native frame-resource
transport, or Flutter `ui.Image` cache matching this SDK path. The nearest
pieces are `lib/core/ffi_bridge.dart`,
`lib/core/pocketjs_bundle_runner.dart`, the UI showcase in
`mini_apps/app_ui_showcase/main.js`, and
`test/pocket_38_components_screenshot_test.dart`; they do not provide a
retained static-image package lifecycle to port.

## Current lifecycle

1. **The normal file-backed Guest path avoids a Dart-side whole-PAK copy.**
   `PocketView._loadPreparedPackage` calls
   `FfiPocketRuntime.loadBytecodeFiles` for QuickJS bytecode packages. Native
   `pocket_load_bytecode_files` reads the bytecode and PAK into temporary
   `Vec`s and calls the normal bytecode loader; those input vectors are freed
   when the FFI call returns. The non-FFI/package-byte fallback paths do read
   and copy package bytes in Dart.
2. **Package admission eagerly materializes all static IMG textures in Core.**
   `runtime/assets.rs` in the pinned SDK cache walks every checked PAK entry
   and passes each `ui:img.*` blob as `AssetKind::Image`. Core
   `Ui::load_assets` calls `upload_img_entry` for every such input. The Core
   copies raw pixels or PackBits-decodes into owned texture storage. The
   native host then registers every returned image name/handle. No scene or
   visibility filter runs at this point. See the pinned source snapshot at
   `sdk/.pocket-build/web-sdk/.cache/pocketjs/engine/runtime/src/assets.rs`
   and `engine/core/src/{assets.rs,lib.rs}`.
3. **The native frame only exports referenced image assets.**
   `referenced_image_assets` collects names from `image` and
   `textureTriangle` DrawOps in the current primary and auxiliary frame.
   `build_frame` skips PAK nodes absent from that set, deduplicates by asset,
   and skips unchanged asset revisions. A first reference or revision change
   copies Core pixels into a `FrameResource`; the PFB1 encoder then writes
   those bytes into the native binary-frame buffer. A release is emitted
   when a previously referenced asset leaves the current DrawList. This is
   DrawList-reference filtering, not occlusion analysis: an asset still named
   by a DrawOp can be exported even if another layer covers it.
4. **Flutter decodes and retains only resources delivered by frames.**
   `_imageAssetsForFrame` finds assets in the current frame. The initial
   loading barrier waits for those first-frame images only. Later
   `_requestResources` calls `_loadImageResource` for native resources and
   uses the PAK fallback only when a frame lacks a resource. `_images` is
   keyed by asset and revision; `_releaseImages` disposes the `ui.Image` on a
   native release. This is why the other PAK images do not all become Flutter
   images on startup.
5. **The current PFB1 Dart path makes one avoidable whole-frame copy.**
   `_readBinaryFullFrame` and binary-v2 delta read the borrowed FFI pointer
   into `Uint8List.fromList` before parsing. `PocketFrame.fromBinary` then
   copies each resource's pixel and palette byte ranges into its own lists.
   The image conversion allocates RGBA output; `PocketPakImage.decode` makes a
   further premultiplied RGBA copy before handing bytes to Flutter. Those
   format-boundary copies have different lifetimes and purposes from the
   whole-frame staging copy.

For the FFI file path, the packed source PAK is retained in two places after
mount: `OpContext::install_assets` stores `Rc::from(pak)` for the native
`loadTileTexture` operation, and QuickJS `mount_ui` makes an owned immutable
`__pak` ArrayBuffer copy. The file-read vector is transient. This means a
25 MiB PAK increase implies roughly 50 MiB more retained packed PAK bytes in
this path, plus up to another 25 MiB during file loading. The four backgrounds
are PSM_8888 by the compiler's image-entry default; when encoded that way,
their Core texture allocation is 4 × 1024 × 1536 × 4 = 24 MiB, regardless of
the compressed PAK payload size. These are separate costs. Flutter's decoded
images add memory only after their assets are referenced by frames. The
actual extra peak also depends on which enlarged image is in the first frame
and on Flutter/Skia's internal buffer allocations.

## Live2D texture distinction

The Live2D plugin loads the MOC3 model bytes into Cubism Core and stores the
registered texture asset names. It does not separately load or decode the
texture PNG pixels into the Cubism model. Live2D drawables point at the same
PAK image names used by ordinary image DrawOps; the native frame deduplicates
these resources by asset name, and Flutter's image cache uses that same name.
The MOC3 model allocation and changing drawable facts are separate from the
static texture pixels. The existing real-Core test
`packages/pocket_live2d/test/live2d_guest_pixels_test.dart` checks that both
model texture names resolve to images decoded from the generated PAK.

## Small ablation candidate

Test one boundary-only change: parse the `pointer.asTypedList(byteLength)`
view synchronously instead of first copying the entire PFB1 packet with
`Uint8List.fromList`. `PocketFrame.fromBinary` currently copies resource
pixel/palette fields by default and materializes operation/event values, so
the returned frame must remain independent of the native output buffer. The
borrowed view must not cross an `await` or any other FFI call; today `lastError`
is queried before parsing, so the candidate must parse first, retain any
parse exception, then query/translate the native error without changing error
precedence. Apply the same ordering to the binary-v2 path. Do not remove the
resource-field copies or let a returned frame reference native memory.

This removes one transient full-frame copy when large image resources arrive;
it does **not** reduce the two retained PAK copies, Core's eager image table,
the native serialized output buffer, the resource-specific owned arrays, or
the RGBA/premultiplication work. It is a narrow measurement candidate, not a
claim that startup memory or frame time will meet a budget.

## Focused evidence and validation plan

Existing tests that exercise the adjacent contracts:

- `packages/pocket_flutter/test/pocket_model_test.dart`: PFB1 parsing and
  resource pixel/palette fields.
- `packages/pocket_flutter/test/pocket_frame_binary_ffi_test.dart`: real FFI
  PFB1 and binary-v2 resource resynchronization; it skips unless
  `POCKET_NATIVE_LIBRARY` points at a built native library.
- `packages/pocket_flutter/test/pocket_view_first_frame_test.dart` and
  `pocket_view_invalidation_test.dart`: first-frame resource barrier,
  asynchronous decode, and release-driven image disposal.
- `packages/pocket_flutter/test/pocket_assets_test.dart`: PAK and PSM
  conversion copies and pixel correctness.
- `packages/pocket_live2d/test/live2d_guest_pixels_test.dart` and
  `integration_test/live2d_mobile_guest_test.dart`: real model mesh image
  assets resolve from the PAK.

The native resource tests currently found in `native/src/lib.rs` use generated
font/glyph textures for first-reference, revision, and release coverage; they
are not a static `ui:img.*` package-admission fixture. A focused copy ablation
should use `FfiPocketRuntime` with a PAK image, decode a real binary frame,
advance the native frame buffer, then assert the returned resource pixels and
palette remain byte-identical and the painted image is unchanged. Compare
allocation/peak-memory measurements for the same high-resolution first-frame
resource before and after; do not infer a win from source structure alone.
Separately, if the goal is to cut the eager Core allocation for unused art,
that requires a real lazy Core admission/request path; the current reference
filter only avoids frame transfer and Flutter decoding, so it is not proof
that the Core texture table is lazy.
