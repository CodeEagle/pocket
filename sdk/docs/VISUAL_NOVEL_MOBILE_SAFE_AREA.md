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
