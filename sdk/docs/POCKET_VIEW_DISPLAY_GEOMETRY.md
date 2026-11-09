# PocketView display geometry

## Retained source and current boundary

The retained parent demo handled its status bar in Flutter: `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart` puts `_PocketFpsTopBar` before the expanded guest viewport (`61–75`), and `_PocketFpsTopBar` reads `MediaQuery.padding.top` to insert the top safe inset (`107`, `126–133`). That is the behavior to preserve: host system geometry remains a viewport fact, while guest layout consumes it once.

The retained material outside `pocket_host/` has no JS `display.viewport` subscription or late-subscriber cache to reuse; it handled this inset on the Flutter side. The event-ingress snapshot below is therefore a necessary adaptation for the current JS-owned layout path, while keeping one host geometry fact and the existing event lane.

The current host uses the existing `display.viewport` event lane. `PocketView._safeAreaForHost` maps Flutter `MediaQuery.viewPadding` into guest logical coordinates; `_reservedRegionsForHost` adds clipped UIKit ReservedRegions on supported iOS and Flutter `DisplayFeature` cutout/hinge/fold geometry. `PocketSystemHost._buildCompositorSurface` passes a full-screen child's compositor bounds and logical viewport through `PocketGuestSession` to its `PocketView`, which anchors display geometry to the parent viewport during sheet translation. The child reports its own host overlap through the same event rather than copying parent safe-area state.

The system mini-app close affordance is not an OS ReservedRegion and is not sent in `display.viewport`. It is a JS overlay owned by `SystemAppSurfaces`; app-bar reservation is a separate JS `SafeAreaScaffoldContext` fact. Keep these lanes distinct.

## First visible frame

The initial guest `load()` has to execute before the guest can subscribe to `display.viewport`. Previously `PocketView` published that initial frame before its post-frame host geometry report could update the JS layout. Startup now retains the existing loading surface after the initial frame's events and resources have been consumed, sends current geometry through `_reportSafeArea`, and requests one zero-delta frame only when the event was delivered immediately to an active guest. When native returns a changed frame, startup applies it and waits for its newly referenced image resources before calling `onReady` or revealing the guest. A null delta means the native DrawList is unchanged; by itself, that does not prove a guest which should reflow actually did. A failed geometry send remains a startup error and does not call `onReady`. The initial frame's events and resource ledger still pass through their original handlers once; a changed frame uses the existing `_applyFrame` and `_requestResources` paths.

The first geometry report can arrive while app code is still behind an asynchronous startup gate, before its `NovelView` or other display consumer has mounted. A successful HostBridge dispatch only proves that the event reached JS; it does not imply that a display listener existed. `HostBridge` now captures one canonical, merged `display.viewport` fact at that existing event ingress. A late `createDisplayGeometry()` initializes from that fact, and rechecks it when its Solid mount callback subscribes, so viewport updates between signal construction and subscription are not lost. Partial height/keyboard updates preserve the prior safe area and regions according to `parseDisplayGeometry`; ordinary `onEvent` listeners are not replayed and unrelated events are not cached.

An inactive/prewarmed guest keeps the established queued-message behavior. Queue acceptance is not treated as an executed geometry update and does not cause a zero-delta frame while the guest is hidden. The first guest evaluation still precedes host facts; its output is held behind the loading surface until the active startup has applied those facts.

## Validation

`sdk/packages/pocket_flutter/test/pocket_view_viewport_test.dart` verifies the safe-area event arrives before a zero-delta frame and before `onReady`, with the first-frame event delivered exactly once, and that a failed geometry send cannot signal readiness. `sdk/packages/pocket_flutter/test/pocket_view_first_frame_test.dart` verifies the initial image decode barrier remains closed until after the geometry frame.

`sdk/packages/pocket_ui/test/host.test.ts` verifies ingress capture and partial merge with no listeners, no general event replay, and snapshot clearing on disposal. `sdk/packages/pocket_ui/test/display_late_mount.test.ts` verifies a viewport arriving between geometry-signal creation and the mount-time subscription is applied as the complete merged snapshot, followed by a normal live partial update.

Run from `sdk/packages/pocket_flutter`:

```sh
flutter test test/pocket_view_viewport_test.dart test/pocket_view_first_frame_test.dart
```
