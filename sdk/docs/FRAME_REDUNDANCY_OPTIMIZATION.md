# Frame redundancy optimization

## Source first

Inspected the retained parent project `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` without entering `pocket_host/`:

- `lib/core/pocketjs_bundle_runner.dart:456-461` exposes each tab's retained `List<Map<String, dynamic>>` draw list.
- `lib/render/pocket_ui_components.dart:3913-3927, 4002-4008` keeps a frame revision and device-pixel ratio, and its painter avoids repaints when those values and the list length are unchanged. Its commands are map based and are painted directly; it has no PFB1/PFP1 splice decoder to reuse.
- `lib/core/ffi_bridge.dart:683-703, 918-923` retains the sandbox draw list and binds the native step/dirty-frame entry points.

The current SDK already adapts the retained draw-list behavior to typed PFB1 frames and optional PFP1 operation splices. This change reuses a fact already decoded from that splice; it adds no protocol, native symbol, host state machine, or fallback renderer.

## Change and retained behavior

Before this change, `FfiPocketRuntime._decodeBinaryDeltaV2` rebuilt an unmodifiable primary-op list for every PFP1 packet, including a packet with no primary-op changes. `PocketView._surfaceVisualEquals` then missed its existing `identical(firstOps, secondOps)` fast path and compared each operation again. This was redundant for an event/resource-only frame whose PFP1 prefix covers the base list, delete count is zero, and inserted operation list is empty.

The decoder now reuses the immutable `base.ops` list for exactly that empty splice. PFB1 decoding already returns unmodifiable operation lists. `PocketView` passes the same list through `_visualFrame`, so its existing identity check skips the O(n) primary-op comparison. Changed splices still construct and validate a new full list.

Viewport dimensions and operation-list lengths are still checked. Auxiliary operations remain independently decoded and compared. Events, resources, releases, video commands, and the resource scan still run from the complete incoming frame; zero-length unchanged markers still return `null`. Full-frame resynchronization and decode failures keep their existing behavior. Borrowed FFI bytes are still copied before the next native call.

## Validation

`pocket_frame_binary_ffi_test.dart` now covers an actual JS event-only frame: the event is delivered, the frame sequence advances, the primary operation list is the identical immutable base list, and the next stable probe returns the native unchanged marker. Its existing changed-op and viewport-resynchronization cases remain in place. `pocket_view_invalidation_test.dart` covers auxiliary changes, resource decode/release invalidation, and host-surface focus changes.

Validation command:

```sh
cd sdk/packages/pocket_flutter
POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib \
  flutter test test/pocket_frame_binary_ffi_test.dart \
    test/pocket_view_invalidation_test.dart \
    test/pocket_video_lifecycle_test.dart
```

Result: 45 passed, zero skipped. This includes the native JS event frame, changed-op splice, viewport resynchronization, auxiliary surface invalidation, image resource decode/release, and video lifecycle cases. No wall-clock performance claim was measured; the ablation is the eliminated list construction and repeat traversal on an empty primary splice.

Negative ablation: temporarily restored the previous `take`/`skip` list reconstruction and ran only `event-only PFP1 frame reuses its unchanged primary operation list`. It failed at the identity assertion (`Expected: true`, `Actual: false`, exit 1). The shared-list implementation was restored immediately; it is the version covered by the 45 passing tests above.
