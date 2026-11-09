# Guest scrolling reuse note

This note records the source-first comparison used for the guest page scroll
implementation. It is intentionally about the thin Flutter host: Flutter
clips and supplies input/IME, while JS owns the page content and scroll state.
The current implementation is in `../demo/js` and `../packages/pocket_ui`; older
`guest/` paths below identify the source tree that was compared.

## Reused upstream contract

The pinned PocketJS examples use the same two-node model:

- `PocketJSKit/.cache/pocketjs/apps/im/thread.tsx:235-243` renders an
  untransformed `overflow-hidden` viewport and a full-height inner canvas with
  `translateY: -scroll()`.
- `PocketJSKit/.cache/pocketjs/apps/clear/app.tsx:88-99,127-136,314-359`
  combines `createScroller`, `createGesture`, measured content extent and a
  vertical pan region.
- `PocketJSKit/.cache/pocketjs/apps/companion-zero/app.tsx:337-350` repeats
  the viewport/canvas translation pattern and optional scroll rail.
- `PocketJSKit/.cache/pocketjs/apps/3ds-demo/app.tsx:296-341,410-423` uses
  `VirtualList` for the narrower fixed-row case (known count, row height and
  viewport height).

The other demo was also checked. Its old Dart renderer uses a Flutter
`ListView` in `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:878-950`.
That is not reused here because it would move business UI/layout ownership
back into Flutter. `PocketJSKit/examples` contains no general scroll
implementation.

## Necessary thin-host adaptations

`guest/ui/index.tsx` keeps the upstream two-node arrangement and official
`createGesture`/`createScroller` primitives, but measures the committed
content node to derive the extent. It does not use a fixed `960` (or any
other guessed) content height; the extent is `max(viewportHeight,
measuredContentHeight)`. This keeps short pages short and allows compact
keyboard/rotation viewports to scroll real content.

The style binding uses the direct reactive expression
`translateY: -scroller.offset()`. Solid's universal renderer observes the
outer style getter. A nested getter such as `style={{ get translateY() {
return -scroller.offset(); } }}` does not cause the parent style object to be
re-read, so the gesture offset can change without a new paint operation.

The native layout ABI reports flex geometry without paint transforms. A
translated input therefore needs a guest `visualRect` (`committedLayout.y -
scroller.offset()`) for Flutter's real TextField overlay, rect-only updates,
and outside-viewport checks. This avoids closing a live IME session merely
because the untransformed layout y-coordinate is below a newly reduced
viewport.

The same `visualTop = committedLayout.y - scroller.offset()` coordinate is used
by `ScrollContourItem` and `useScrollContourReserve` in
`packages/pocket_ui/src/ui.tsx` to implement progressive contour-aware width
adaptation on displays with a top-right occlusion (such as iPhone Duo's camera
and status cluster). `ScrollablePage` exposes `ScrollablePageContext` (`scrollOffset`,
`geometry`, `subscribeContour`) and runs registered contour subscribers before
remeasuring `contentHeight` on drag, kinetic step, and `display.viewport`
updates. Each top-level item computes its right-edge reservation via
`topRightContourReserveForBand()` using a 48px C1-continuous Hermite smoothstep
ramp (`3t^2 - 2t^3`) below `cutoutBottom`, narrowing progressively as it scrolls
into the top-right band and restoring its base width when scrolled back down.

`VirtualList` remains a fixed-row primitive with its own viewport and
`createGesture({ region: { node: () => viewportNode }, axis: "y" })`
(`.cache/pocketjs/framework/src/virtual-list.ts:255-277`). The current app
does have same-axis nesting: `HostPages` wraps its route content in
`ScrollablePage` (`guest/app.tsx:527-550`), while `PerformancePage` and
`UpdatesPage` mount `VirtualList` (`guest/app.tsx:622-637,675-690`). This is
documented reality, not a claim that nesting has been eliminated.

The framework's gesture contract resolves matching owners in reverse
registration order and lets the first owner crossing pan slop claim the
contact (`.cache/pocketjs/framework/src/gesture-core.ts:9-18,432-451`). That
provides deterministic arbitration when both regions match, but the current
native probe covers page scrolling, not every nested `VirtualList` boundary.
Whether a same-axis drag that starts inside one of these lists, at its edge,
or after a parent offset behaves ideally on every device remains **待验证**;
future changes should either preserve this measured behavior or avoid the
outer wrapper for pages whose primary content is a `VirtualList`.

## Evidence

The required native probe exercises JS bytecode loading, host request/response,
pointer navigation, a compact-viewport vertical drag, text input and 100/500
node stress frames. It also exercises input open followed by a `360x360`
viewport resize and requires a translated rect-only update with no premature
`textInput.close`.

Verified locally:

```text
bash scripts/build_guest.sh
bun tests/native_guest_probe.ts --required
bun tests/guest_state.test.ts
python3 scripts/check_architecture.py
```

These are static/native-probe and source-boundary results. iOS/Flutter device
verification is separate and is not claimed by this note.

## Desktop wheel and trackpad input

The retained parent was checked again before adding desktop input. In
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:878-950`,
the original `<Screen>` body is a Flutter `ListView.separated` using
`BouncingScrollPhysics` and `AlwaysScrollableScrollPhysics`. It demonstrates a
scrollable body, but it owns that behavior in Flutter and has no reusable
guest wheel/trackpad event contract. A search of the retained parent outside
`pocket_host/` found no `PointerScroll`, `PointerPanZoom`, `WheelEvent`, or
`input.scroll` implementation. The audit evidence is also recorded in
`.pocket-build/lantern-playable-input-lod-20261108/desktop-scroll-protocol-audit.md`.

The SDK keeps `ScrollablePage`'s existing `createScroller`, paint-only
`translateY`, touch gesture, and IME visibility behavior. The necessary thin
host adaptation is the `input.scroll` event consumer in
`packages/pocket_ui/src/ui.tsx`: it subscribes through the shared event lane
in `display.ts`, selects one active viewport by logical x/y, existing
`hitTestBounds`, and the retained `NodeMirror` tree, then calls that page's
existing `Scroller.scrollBy(deltaY, { immediate: true })`. Positive `deltaY`
moves content downward; Flutter reverses trackpad pan delta before sending it.
Only the vertical delta is consumed by `ScrollablePage`.

For nested pages, a child consumes up to its existing scroll bound and passes
only the unconsumed remainder to the nearest active page ancestor in the
existing node tree. Parent scroll translation is included in nested viewport
measurement and clipped against the parent's existing viewport. Wheel events
route independently by pointer position. A trackpad sequence captures the
page at `start`; an outside start remains unclaimed through `end`, and updates
without a start are ignored. Hidden routes and unmounted pages unregister;
the shared host-event subscription is removed when the last active scroll
page leaves. No pointer or click packet is synthesized, and no native scroll
layout operation or second scroll state machine is added.

`InputField` reads `visualRect`, `clipRect`, and `ensureVisible` from the
nearest `ScrollablePageContext` that contains it. The former module-wide
"last active page" pointer was removed: with sibling and nested pages it could
pair an upper input rect with a later page's clip. A page now handles input
visibility only when the input node is its descendant (owner or ancestor),
and evaluates the input's actual context-composed visual rect.

The SDK routing/frame regression is
`packages/pocket_ui/test/flutter_widgets.test.ts`; with the pinned Bun 1.4.4
binary it verifies wheel offset changes, the following guest frame retains
that offset, outside wheel input is ignored, trackpad target locking and
positive-down direction, and no click/IME event is emitted before focus. The
acceptance worker also reported a successful pinned buildGuest → native QJBC
probe covering wheel on an auto-focused title button, outside no-op, a second
trackpad target, touch pan, and IME open/edit/dismiss. Flutter device-level
verification remains the root acceptance step and is not claimed here.

The renewed run after the input ownership correction used the same pinned
buildGuest/QJBC/native probe. It passed nested partial clipping (40px visible
intersection), 20px remainder chaining, sibling isolation, and a focused IME
case. The emitted `textInput.open` rect was `{x:16,y:66,width:328,height:37}`;
its clip `{x:8,y:54,width:344,height:128}` matched the focused fallback's
actual DrawOp clip. A subsequent 4px wheel moved the content exactly 4px and
produced no `textInput.close` event.
