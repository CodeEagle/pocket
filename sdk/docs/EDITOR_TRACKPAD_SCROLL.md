# Editor trackpad scroll contract

This note records the source-first comparison and browser acceptance for the
Studio preview's two-finger trackpad path. The retained parent project was
inspected outside `pocket_host/`: its old Flutter renderer uses
`lib/render/pocket_ui_components.dart:878-950` (`ListView.separated` with
`BouncingScrollPhysics`), and `lib/main.dart:56` keeps the root `MaterialApp`
out of the scroll/drag rebuild path. That implementation is a comparison
source only; the current SDK keeps page content and scroll state in JS.

The current preview receives trackpad input as browser `wheel` events. A burst
is one synthetic native pointer contact: the first event sends `DOWN`, later
events send `MOVE`, and 120 ms of silence sends `CANCEL`. `CANCEL` reuses the
existing `ScrollablePage` cancellation path (`endDrag(0)`), so the browser
does not add a second release velocity on top of the operating system's
trackpad momentum. A real pointer drag still uses its normal `DOWN/MOVE/UP`
path and retains fling behavior.

Native pointer coordinates are bounded by the input ABI. When a long wheel
delta reaches that coordinate edge, the preview may send a `CANCEL` followed by
another `DOWN` for the same reserved contact id and continue with the remaining
delta. The test treats this as a re-anchor, rather than requiring one contact
for an arbitrarily long burst. Browser `pointerdown`, runtime rebuild, resize,
blur/hidden, and page teardown end the synthetic contact and clear its timer.
For a focused `hostSurface` child, the preview uses that child's input bounds
for the anchor and re-anchor calculations. The initial wheel anchor remains
fixed while the burst runs; this prevents the composite canvas edge (or a
cursor leaving a smaller child surface) from silently dropping the remaining
delta after the manager clamps coordinates into the child's viewport.

The regression in `editor/test/preview_scroll.test.ts` builds the public scroll
fixture and drives the real Playwright Chromium page through the native probe.
It checks top-edge wheel overscroll and spring return, one-contact in-bounds
wheel accumulation with a decaying `[48, 32, 16, 8, 4]` tail and terminal
`CANCEL`, no post-cancel fling, and the existing real pointer
drag/fling/bottom-edge spring checks. A larger top-edge burst crosses the
bounded native coordinate range and verifies that a re-anchor can continue the
scroll without losing its delta. The mixed-contact
coverage in `editor/test/preview_pointer.test.ts` checks that two browser
contacts keep their `UP` terminals while the wheel contact uses `CANCEL` and
does not emit a post-terminal move.

The pre-change client was run without replacing the worktree by injecting
`/tmp/pocket-preview-before-trackpad-20261104.js` through the test's
`POCKET_PREVIEW_CLIENT` option. The new wheel assertion failed with three
synthetic `UP` packets and no `CANCEL`, demonstrating the old one-contact-per-
wheel behavior. With the current client, these commands pass:

```text
POCKET_PLAYWRIGHT=/tmp/pocket-playwright-review/node_modules/playwright/index.mjs \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe \
bun test sdk/editor/test/preview_scroll.test.ts --timeout 60000

POCKET_PLAYWRIGHT=/tmp/pocket-playwright-review/node_modules/playwright/index.mjs \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe \
bun test sdk/editor/test/preview_pointer.test.ts --timeout 60000
```

The observed scroll acceptance retained the existing pointer evidence (top
overshoot `39 -> 76.89238 -> 39`, fling movement after release, and bottom
spring `329 -> 281 -> 329`) while adding the wheel burst/cancel assertions.
The decaying wheel tail moved a visible guest marker by exactly 108 logical
pixels; its final y stayed at 170 after the input stopped.
`preview_timing.test.ts` also passed its two clock/back-pressure regressions,
and `sdk/scripts/check_architecture.py` passed the SDK/demo boundary check.

## macOS two-finger trackpad momentum & overscroll jitter remediation

On macOS, a two-finger trackpad swipe continues emitting passive momentum
`wheel` events with sub-pixel deltas and minor cross-axis wobble for 800–1200 ms
after the fingers lift. Four interacting behaviors previously caused visible
jitter and prolonged edge pinning in the Studio preview:

1. **Cross-axis wobble & sub-pixel `u16` quantization (`sdk/editor/client/preview.js`)**:
   - Minor horizontal deltas (`dx`) during a vertical swipe moved the synthetic
     contact's `x` coordinate toward `minX`/`maxX` or interfered with
     `ScrollablePage`'s `axis: "y"` pan lock, while fractional tail deltas
     (`< 1px`) repeatedly rounded to the same integer coordinate (`sendInput`
     rounds `x`/`y` to `u16`), emitting duplicate `MOVE` HTTP packets and
     resetting the 120 ms silence timer without advancing the scroll offset.
   - **Fix**: Lock `wheelContact` to its dominant axis (`"y"` when
     `|dy| >= |dx|`, else `"x"`), accumulate sub-pixel remainders (`remX`,
     `remY`), step only by integer pixels (`Math.trunc`), and ignore zero-step
     fractional events without resetting the silence timer.

2. **Re-anchor backward jump on `CANCEL -> DOWN -> MOVE` (`sdk/packages/pocket_ui/src/ui.tsx`, `sdk/editor/preview.ts`, `sdk/editor/client/preview.js`)**:
   - When a long swipe reached the viewport boundary and re-anchored (`CANCEL`
     -> `DOWN` -> `MOVE`), `ScrollablePage` stepped its overscroll return spring
     for 1–2 frames before the new contact crossed `panSlop: 1`:
     - First, `ScrollablePage.onFrame` called `scroller.step()` on the same
       `delta = 0` guest turn (`tickNow(0)`) where `onCancel`/`onPanEnd` called
       `scroller.endDrag(0)`.
     - Second, `PreviewSession.sendInput` left the active drag `tickTimer` armed
       across a terminal `cancel`/`up`, allowing a frame tick with the
       accumulated pre-cancel `lastTickAt` delta to fire in the 1–2 ms HTTP gap
       before the re-anchor `down`.
     - Third, a `1px` remainder after a boundary hit emitted `DOWN` + `1px MOVE`,
       which did not cross `ScrollablePage`'s `panSlop: 1` (`dist <= 1`), leaving
       the spring active until the next wheel event.
   - **Fix**:
     - `ScrollablePage` (`sdk/packages/pocket_ui/src/ui.tsx`) tracks
       `endedOnThisTurn` so `onFrame` skips `scroller.step()` on the zero-delta
       gesture-end turn, and restarts the return spring if `onDown` arrests an
       overscrolled spring (`scroller.stop()`) and `onUp`/`onCancel` arrives
       before `onPanStart`.
     - `PreviewSession.sendInput` (`sdk/editor/preview.ts`) resets `lastTickAt`
       and clears any pending drag `tickTimer` before `tickNow(0)` when the last
       active pointer contact ends.
     - `sdk/editor/client/preview.js` anchors and re-anchors using the surface
       midpoint (`midX`, `midY`) so pointers near the top/bottom edge still get
       at least half the viewport of travel room while staying inside
       `ScrollablePage` (avoiding top `AppBar` and bottom `NavigationBar` bars),
       and buffers `1px` remainders across boundary hits so every re-anchor
       `DOWN` is immediately paired with a `>= 2px` `MOVE`.

3. **Passive momentum tail cutoff (`sdk/editor/client/preview.js`)**:
   - Once a wheel burst is in monotonic passive momentum decay (`decaySteps`),
     hitting the viewport boundary after initial contact (or decaying to sub-1.5px
     tail steps after `>= 4` decay steps) immediately finishes the synthetic
     contact with `CANCEL` and suppresses the remaining passive tail until
     direction reverses, delta accelerates (new finger flick), or silence
     expires. This lets `ScrollablePage`'s rubber-band spring settle smoothly
     instead of pinning at the overscroll cap for the entire OS momentum tail.

4. **Validation**:
   - `sdk/editor/test/preview_scroll.test.ts` includes a 40-event macOS trackpad
     swipe trace with horizontal wobble and decaying momentum tail, verifying
     axis locking (`x === 195`), monotonic overscroll across re-anchor (`0.00px`
     backward jump), passive tail cutoff, and non-oscillating spring return to
     `initialMiddleY`.

## Combined-suite limitation

The combined `preview_scroll.test.ts` + `preview_pointer.test.ts` +
`preview.test.ts` run passed the scroll and pointer suites. The three
`preview.test.ts` cases pass when run alone, but under concurrent native-probe
load the mini-app route helper can exceed its hard-coded 5-second wait and
time out while the snapshot remains `ready`; this is a test scheduling limit,
not a reported native budget or status error. The strict Profile status
assertion retains the full `status.error` diagnostic. The captured combined
run log is `/tmp/pocket-combined-60s.log`.
