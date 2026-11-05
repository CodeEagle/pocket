# Showcase route lifetime and state

The Showcase route stack is JS-owned in `demo/js/state.ts`. The former root
used one `Show` per active route, so push unmounted the caller. Its
`ScrollablePage` created a new official kinetic scroller on return, and local
Solid signals (selected section, inputs, toggles and expanded rows) reset too.
Recording only a scroll number would leave the other losses unresolved.

The retained parent is `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
(excluding `pocket_host/`). Its `lib/render/pocket_ui_components.dart:570–704` caches route-id keyed
`RepaintBoundary`/`KeyedSubtree` instances and suppresses input to inactive
slots. We retain the page-instance behavior in JS, reuse the pinned
framework's nodes, focus and kinetics, and dispose popped routes. The old
append-only native layer/texture retention is not copied into the thin host.
No Flutter navigation or second layout engine is added.

## Lifetime rules

| Action | Instance and state |
| --- | --- |
| Push a secondary page | Keep its caller's real JS subtree, signals and scroller; deactivate its rendering and input |
| Back/pop | Dispose the top secondary subtree and reveal the same caller instance |
| Switch primary tabs | Keep visited primary instances and their independent state |
| Reopen a popped secondary | Create a new page instance; explicit shared models retain only their existing documented policy |
| Resize or change appearance | Remeasure the existing page; keep its state and clamp scrolling to the real available extent |
| App restart | Appearance preferences restore through storage; navigation/session forms are not serialized |

`routeStack` remains the only navigation state. `mountedRoutes` adds visited
primary instance cache entries to the stack. It does not keep popped secondary
pages. The old arbitrary eight-route truncation is removed: route IDs are
finite and existing entries are reused, so pushes remain bounded without
silently losing the original caller. Host detail pages receive their fixed
route ID; a hidden Runtime subtree no longer switches branches when another
route becomes active.

The shared SDK `RouteView` supplies activity to route-aware UI. Page scrollers
retain their actual official `createScroller` instance. Inactive pages freeze
measurement/kinetics and stop accepting gestures or keyboard scrolling. Input
sessions close on deactivation, while the value remains owned by its page.
Overlays belong to their route and cannot paint over the next route.

The app uses one root focus scope, including the fixed back arrow and tab bar.
Nested scopes per retained page would capture navigation away from that bar.
The reproducible `focus-display-filter.patch` aligns the pinned framework's
keyboard focus traversal and press dispatch with the native `display:none`
boundary, clearing stale focus before processing keyboard input.

## Resource policy

UI state is distinct from active device work. Video uses the existing media
controller's current-page gate. Camera access is stopped when the hardware
route leaves, including a late camera-start response received after pop.
Hardware streams stop when hidden and are disposed on pop; returning retains
form selections and results and lets the user start a new stream.

## Validation

Verified on 2026-11-05 with actual compiled QuickJS, native frames and pointer
input:

- `demo/js/tests/navigation_native.test.ts`: Home scroll survives primary-tab
  changes and secondary push/Back within two native pixels after settling;
  section, switch, stepper and input state survive push/Back; hidden popup
  isolation, popped-page reset and late camera-start shutdown pass.
- `demo/js/tests/settings_native.test.ts`: preference restore/reset and a
  secondary opened from Settings return to their actual caller.
- `sdk/packages/pocket_ui/test/route_focus_native.test.ts`: stale-focus Enter
  cannot activate a hidden page and D-pad traversal excludes hidden routes.
- The pinned renderer suite passes 59 tests after repeated guest compilation,
  confirming that upstream preparation remains idempotent.
- iPhone 18 Pro simulator integration passes the real icon Back, secondary
  bottom-bar hiding, controls and settings flows.

## Secondary app-bar Back icon

The public `MobileBackButton` lives in `sdk/packages/pocket_ui/src/navigation.tsx`.
It preserves a single 44x44 `Focusable` hit target, `debugName="Back"`, and the
active `useMobileTheme` accent; the visual mark is icon-only and contains no
Unicode/glyph fallback. Its chevron uses two symmetric rotated solid strokes
inside a 24x24 drawing box. The two rotated quads use the pinned `originX` /
`originY` pivot semantics at one shared outer corner, avoiding both a gap and
a doubled left tip after native quantization.

This adapts the retained pinned Clear implementation at
`sdk/.cache/pocketjs/apps/clear/rows.tsx:89-92`, which documents the same
rotated-stroke joint problem. For this chevron we use the exact shared-corner
pivot rather than a broad overlap, preserving one pointed valley. The pinned renderer's
`sdk/.cache/pocketjs/engine/core/src/draw.rs` documents that rotated rounded
boxes degrade to square fills; the old `rounded-full` bars therefore could not
guarantee a clean cap or seam-free join. The component keeps the overlap
joint explicit and does not change the global icon pipeline or Flutter
renderer.

The retained parent implementation at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:1928-1940`
uses a Flutter `IconButton` with `Icons.arrow_back_rounded`. We retain its
app-bar Back action semantics and accessible touch affordance, but the JS-owned
Showcase cannot depend on the parent Flutter glyph; the two native View
strokes are the necessary thin-host adaptation.

The native regression fixture is
`sdk/packages/pocket_ui/test/navigation_icon_native.test.ts`. It compiles the
component through the pinned `buildGuest`, consumes the resulting QuickJS
bytecode with `pocket_probe`, checks the two native TRI quads share one valley
tip, bounds the icon, and taps the real 44x44 target to verify the callback.
Existing `demo/js/tests/navigation_geometry.ts` triangle-count and bounds
hit-point helper remains compatible with the corrected geometry.

The fixture was run on 2026-11-05 with the pinned native probe: it reported a
shared tip at `(17,32)`, 8.00 logical-pixel² interior stroke overlap,
10×16 logical-pixel chevron bounds, and a successful native pointer press
(`Ready` → `Pressed`).
