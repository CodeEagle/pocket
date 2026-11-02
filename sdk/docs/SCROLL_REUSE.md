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
