# Resource RGBA ownership ablation

Date: 2026-11-08. This removes a full-size intermediate allocation during
native-frame image decoding. It does not claim that RSS or game FPS has passed.

## Source-first and existing boundary

The retained parent `pocketjs_flutter_demo/lib/core/ffi_bridge.dart` provides
the typed-byte FFI boundary; its ordinary image widgets in
`lib/render/pocket_ui_components.dart` do not decode PAK pixels. The retained
behavior and the SDK's earlier sublist-view adaptation are documented in
[RESOURCE_DECODE_ABLATION.md](RESOURCE_DECODE_ABLATION.md).

The current host already uses `PocketPakImages.fromResource` to convert a
frame resource into a new, owned, straight-RGBA array. Its public
`PocketPakImage.decode` must preserve that array, so it makes another full-size
copy before premultiplying alpha for Flutter. In the host's resource-loading
path the intermediate `PocketPakImage` was private and immediately discarded;
preserving its newly allocated straight-RGBA array served no consumer.

`PocketPakImages.decodeResource` now reuses the same conversion, premultiplies
that exclusively owned result in place, and uses the shared Flutter decoder.
`PocketView` calls it at its existing resource boundary. Public
`PocketPakImage.rgba` and `.decode()` keep their straight-RGBA and repeat-decode
semantics, and the source resource/palette remain unchanged. Custom decoders,
unsupported-resource handling, epoch checks, revisions and LOD selection are
unchanged. There is no additional resource cache or business state.

The shared image decoder also disposes its descriptor and immutable buffer
when codec creation fails, as well as after successful frame creation.

## What has been eliminated

For each 2048×2048 resource, the host no longer allocates a second
16,777,216-byte Dart RGBA array just to premultiply it. For two such pages,
the eliminated array allocations total 33,554,432 bytes per decode batch.
The required resource snapshot, format-conversion output, Flutter immutable
buffer and decoded image remain. This is an allocation budget derived from
the two code paths, not a measurement of concurrent peak RSS, GPU residency,
allocator return-to-OS behavior or cold-start latency.

The earlier normal20 Profile app was already compiled when this change was
made. Its results do not cover this new decode path.

## A/B validation

`pocket_resource_decode_test.dart` executes both the unchanged public
conversion→decode path and the owned resource path through actual Flutter
image decoding, then compares output pixels. It covers 5650, 4444, 8888 and
indexed T8, transparent-white edges, partial alpha, repeated decode, source
and palette ownership, unsupported/truncated resources, and every pixel of
a 2048² RGBA image with varying channels and alpha. The original straight
RGBA output is also checked after public decoding.

Together with `pocket_assets_test.dart`,
`pocket_view_invalidation_test.dart` and `pocket_view_first_frame_test.dart`,
**34 tests passed** on pinned Flutter 3.47.9. Targeted analysis of the changed
host/decoder/test reported no issues. Log:
`/tmp/pocket-resource-owned-decode-20261108.log`.

Old/new source copies and the validation log are retained under
`sdk/.pocket-build/resource-premultiply-ablation-20261108/`. Generated evidence
is not a source dependency. Actual game pixels, startup and RSS still require
a new application build; the ordinary cached Demo was not modified by these
unit tests.
