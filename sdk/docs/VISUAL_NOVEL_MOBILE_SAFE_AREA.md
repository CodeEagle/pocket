# Native game interactive safe area

## Contract and retained source

The retained parent `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`
consumes the top system padding around its Flutter-owned toolbar (lines 61–75,
107 and 132). The current thin host instead reports native geometry and lets
JS own game composition. Do not restore a second Flutter game toolbar or add
SafeArea wrappers around every button.

`PocketView._safeAreaForHost` maps the actual guest canvas against Flutter
`MediaQuery.viewPadding`; `_reservedRegionsForHost` maps native display regions
and Flutter cutout/fold features into guest logical coordinates. A child
compositor surface computes its own facts against the untransformed parent
viewport. `createDisplayGeometry` consumes the existing `display.viewport`
event lane, with no polling or second transport.

`NovelView` consumes `pageInsets` once on the shared stage/UI root. All game
controls inherit that origin. Adding the same top padding to each child would
double-count the system safe area.

## Local occlusion correction

`pageInsets` deliberately releases a conservative right inset when a local
corner obstruction and division topology prove that the body can stay wide.
The framework's `SafeAreaScaffold` and mini-app close action already perform
local control avoidance. The game header had omitted that second step.

The VN SDK now reuses `sideContourReservesForBand` for its actual 44px header
band and `avoidDisplayOcclusions` for remaining intersections. It also retains
`MINI_APP_HOST_ACTION_RESERVE` beyond the contour, because the host close action
can move inward around the same obstruction. This replaces the old fixed
`width - 80` rule; it adds no independent layout engine, input clamp or display
state cache. Menus remain drawn and hit-tested by the same real Guest nodes.

## Validation, 2026-11-09

`demo/js/tests/novel_safe_area_native.test.ts` runs the actual compiled Lantern
Guest through the pinned Core/probe. One live session covers iOS-like
390×844 (59/34px system insets), Android-like 412×915 (32/24px), landscape
844×390 (59px side insets), and a return to portrait. Painted header/toolbar
labels remain inside safe bounds and real menu/continue pointer input works.

A localized 100×90 top-right obstruction in an 844×600 viewport reproduces the
old failure: menu text ends at x=749, entering the obstruction at x=744 and the
inward host-action band. With the correction, its right edge is before x=684;
a pointer at the former unsafe menu location no longer opens the menu, and a
pointer on the relocated menu does.

The combined native game, VN viewport and framework contour run passes
13 tests / 84 assertions. Logs and separately compiled Guest artifacts are in
`sdk/.pocket-build/mobile-safe-area-20261109/` and
`sdk/.pocket-build/rich-text-20261109/mobile-safe-area-*.log`.
These injected native facts validate Core layout and pointer behavior; they do
not replace physical iOS/Android safe-area, OS rotation or pixel acceptance.

## First visible native frame

The shared Flutter host also had a separate ordering gap: it first exposed the
frame returned by Guest load, then scheduled the native geometry report after
paint. Startup now keeps that frame behind the existing `_loading` gate while
the existing `display.viewport` event is applied through a zero-time frame.
The original frame's events and resources are consumed once; any additional
resources referenced by the geometry frame use the same resource barrier.
`onReady` follows the resulting frame, and a report failure cannot report a
successful ready state. Hidden queued events do not force background execution.

The targeted Flutter 3.47.9 run passes 16 viewport/first-frame tests, including
image/resize/lifecycle gates and send-failure behavior. Full-package and native
FFI follow-ups are recorded separately in
[host frame contract](POCKET_VIEW_DISPLAY_GEOMETRY.md); these do not
substitute for physical iOS/Android acceptance.

## Late game-view mount race

Actual Android emulator acceptance exposed a separate failure that injected
post-mount viewport tests could not catch. The FlutterView and child both
reported 24dp top padding; the child canvas started at global (0,0). A scratch
trace at the successful native event send recorded top=24 and bottom=23.5714,
yet the menu text stayed at y=22 and the bottom toolbar extended into the
system-safe bottom band. This was a real game layout failure, not a parent
coordinate offset. The original failed runs and screenshot path/size metadata are retained under
`.pocket-build/mobile-safe-area-devices-20261109/`. The screenshot itself was
removed with the isolated test app before extraction; no retained PNG is claimed.

Lantern reads storage before mounting `NovelView`. The first display event can
therefore arrive before its display subscription exists. Previously the UI
bridge forwarded events to current listeners without retaining display facts;
the display adapter's cache only started after its own first subscription.
Native send success also makes Flutter deduplicate identical future geometry,
so the late view could remain at zero safe insets.

The new `storage-delayed` case in `demo/js/tests/novel_safe_area_native.test.ts`
holds real host storage responses, sends one viewport fact while the loading
screen is visible, then releases storage and clicks into the game. Against the
old Guest it reproduces menu y=22 with required top=24. The same final native
library correctly applies both JSON and binary viewport events after mount;
this distinguishes a subscription-timing failure from a codec failure.
Negative evidence: `.pocket-build/mobile-safe-area-20261109/startup-race-negative.log`
and `binary-compare.log`. Final fix and device rerun results follow separately.

The JS fix now retains one merged `display.viewport` snapshot at the existing
HostBridge ingress before notifying live listeners. Late display consumers read
that snapshot; arbitrary events are not replayed. The display adapter's second
cache is removed from the modern-bridge path and retained only for legacy/custom
sources without a snapshot getter. Disposal clears the bridge snapshot.

A separately rebuilt Lantern Guest (`guest-late-mount/`, source SHA-256
`3fffb14cf9f35da8d37b98421ef2a39eca93b460f1f45521a1038ba26ac15267`)
passes both real native tests (2 tests / 72 assertions): post-mount safe-area
updates/local occlusion, and a single early viewport event surviving delayed
storage on Android-like and iOS-like geometries. Real menu/return pointer input
passes after each delayed mount. The PAK remains byte-identical
(`e5f148e7a50f81631b7862b94ea075cd78a9cc6fc5b4d7c32ecf3c97942a2e73`).
This is Core acceptance; the final Android OS rerun is recorded separately.

Focused UI SDK regressions also pass (8 tests): real HostBridge ingress before
any display listener, a partial update between signal creation and mount,
merged snapshot replay, subsequent live partial updates, no generic event
replay, and disposal clearing the snapshot. See the host contract document for
source provenance and the `host.test.ts` / `display_late_mount.test.ts` command.

### Final Android OS acceptance

The fixed Guest passes the actual Android emulator integration test (1 test),
without a post-mount/manual viewport resend. FlutterView/child top and bottom
viewPadding are 24dp; the global child origin remains (0,0), canvas 411×731.
The menu text moves from y=22 to y=46 (height15), and the bottom echo text moves
from y=699 to y=675 (height15), inside the actual OS-safe range. The test also
performs real Flutter pointer input through the menu/return flow. Log:
`.pocket-build/mobile-safe-area-devices-20261109/android-integration-test-final.log`
(`All tests passed`). The new Guest source hash matches the Core-accepted
`3fffb14c…15267`. This is an Android emulator run, not iOS/physical/OS-rotation
acceptance; those remain pending. The first final invocations that failed on
stale test hash and screenshot-list compile typing ran no game assertions and
are retained separately; neither was counted as runtime acceptance.

Compact final device evidence is
`.pocket-build/mobile-safe-area-devices-20261109/android-fixed-acceptance.json`.
Its bounds assertions cover painted menu/toolbar labels and actual tap centers;
the full 44px hit rectangle was not independently exported by DrawOps/semantics.
A final device PNG was captured (1,815,067 bytes), but teardown removed it and
only 50/3,458 log chunks survived, so no complete screenshot is retained.
Full hit-area measurement, durable pixel capture, iOS/physical devices and
rotation are explicitly outstanding evidence, not included in the 1-test pass.
