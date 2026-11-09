# Desktop wheel and trackpad scrolling

This work connects desktop scroll input to the existing JS `ScrollablePage`.
It covers vertical pages used by the launcher, VN title menu, long dialogue,
journal and other game panels. It does not introduce another layout engine or
a Flutter scroll controller. Runtime acceptance is recorded below as it is
completed; this document alone is not evidence of a passing interaction.

## Source-first integration

The retained parent at `../pocketjs_flutter_demo`, excluding `pocket_host/`, was
searched for wheel, pan/zoom, pointer-signal and scroll protocol handling. Its
`lib/render/pocket_ui_components.dart` owns old Flutter Screen/ListView bodies,
but provides no reusable wheel-to-JS protocol. Reusing those Flutter business
widgets would violate the current thin-host boundary.

The pinned PocketJS framework already provides `createScroller`,
`Scroller.scrollBy` and `scrollTo`. Current `pocket_ui/src/ui.tsx` uses them for
touch, D-pad and IME visibility, with measured content extent, clipping and
paint-only translation. These remain the single scrolling implementation.
The native layout ABI needs no scroll-offset operation: its existing generic
host-event transport delivers `input.scroll` to JS.

The prior audit and baseline resource copies are retained in ignored QA
directories `sdk/.pocket-build/lantern-playable-input-lod-20261108/` and
`sdk/.pocket-build/desktop-scroll-20261108/before-assets/`. The former audit
observed that Flutter previously only woke its ticker for pointer signals;
the real Demo diagnostic's scroll event did not move its JS content.

## Boundary and behavior

Flutter's surface listener translates `PointerScrollEvent` and
`PointerPanZoomStart/Update/EndEvent` into the existing host event lane:

```ts
{
  method: "input.scroll",
  params: {
    x, y, deltaX, deltaY, // guest logical coordinates and distances
    phase: "start" | "update" | "end",
    source: "wheel" | "trackpad",
    surface?: number
  }
}
```

Positive `deltaY` advances the vertical content offset. Flutter converts
trackpad pan deltas to that sign and transforms position and distances into
the same guest coordinate space as pointer input. Pure zoom/rotation updates
are not scrolls. No pointer down/up or click is synthesized.

JS selects the active page under the input and drives that page's existing
Scroller. Nested pages consume their own available range before forwarding
remaining vertical distance to an ancestor. Fixed chrome and overlying
controls outside the page are excluded. Trackpad target ownership lasts for
the gesture rather than following subsequent pointer positions.

## Acceptance status

2026-11-08: final isolated SDK regressions passed (host, widget, native focus,
original full safe-area and native widget suites). Flutter boundary tests: 22
passed. The pinned compiler/probe test in `scripts/tests/desktop_scroll_guest.test.ts`
executed actual 200489-byte QJBC with 54 assertions: wheel, trackpad ownership,
nested remaining-distance transfer, inactive targets and input ownership.

A real macOS Profile driver completed both required checkpoints `desktop-scroll`
and `tour-input`, exit 0, +3 tests. Injected Flutter pointer-signal/panZoom events
moved launcher content and the VN title start item from y245 to y125 while
fixed chrome stayed fixed and no accidental game start occurred. Null intro
coordinates after scrolling mean the item left the viewport; they are not a
measured final offset. Physical hardware input is explicitly false.

The input tour captured CJK/emoji, composition, blur and six-character opening.
First-frame native text alpha was 0 with one Guest fallback; ACK transfers
ownership. Root inspected the six-character first frame. Native OS IME and
physical wheel/trackpad behavior remain unverified.

This also removed two redundant layers: global last-mounted-page input ownership
was replaced with existing lexical page context, and MobileAppBar stopped drawing
its own background over the scaffold, honoring the documented transparent-bar
contract. Parent sources are recorded in SCROLL_REUSE and DUO_ADAPTATION.

Final evidence, logs, resource hashes and captures are under ignored
`sdk/.pocket-build/desktop-scroll-20261108/`. Tested Lantern QJBC SHA256 is
`ceb1faf828fd4b273fed650fde8c792a2fb2de4a8e88b53fe071be5edb20bbcb`;
PAK `212b5f26bd4ad787779a21e6d2174db52470d8315581747f9527fd1dd27479ed`.
Both Hiyori 2048² atlases were decoded from this final PAK and match original
RGBA pixels exactly. This does not resolve the Live2D visual-quality gate.


Ordinary Demo deployment: Profile `lib/main.dart`, SSAA2, build exit0,
ad-hoc deep/strict signature verification exit0. Final app is
`sdk/.pocket-build/lantern-playable-desktop-scroll-20261108/pocket_host.app`,
PID32713. Its VM main isolate was observed runnable and all 12 bundled
QJBC/PAK/metadata resources match current Demo assets. Only after this check
was old owned PID3303 stopped. No Editor was launched and user stores were
retained. OS observation reports 800×632 window, backingScale1, frontmost
loginwindow; an open request is not proof of foreground visibility.
