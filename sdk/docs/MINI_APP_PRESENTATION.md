# Mini app presentation

Showcase mini apps use a shared JS presentation in `SystemAppSurfaces`.
The plain compositor surface mode remains available for consumers that own
multi-surface layouts. The Showcase enables `presentation="mini-app"` once,
so direct launches and nested Profile/Lobby launches use the same entry UI.

Source-first reference: the retained parent
`pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:524`
(`PocketPageTransitionCompositor`) separates retained content from its
transition transform and clipping. `lib/ui/mini_app_host_page.dart` retains
the host rendering surface. This change adapts that composition contract to
the current JS-owned SystemUI: no Dart navigation or animation state is added.

The opening panel travels upward from the bottom and owns the full viewport;
there is no separate 44px navigation strip or 12px top inset around the child
app. The circular close control floats over the child at 8px from the top and
right edges rather than reserving layout space or covering a child-owned
toolbar. Closing uses the existing `platform.apps.cancel` request for the
binding's launch request ID; the kernel remains the sole owner of lifecycle,
stack unwinding, result cancellation, and runtime teardown. There is no second
mini app stack or duplicate native navigation wrapper.

Animation belongs to the official PocketJS virtual clock and demand scheduler.
Only a running transition should request continuous frames. Stable instance IDs
must retain their presentation when unrelated kernel notifications publish new
binding objects.

The `mini-app` presentation requires an `onClose` callback at the public type
boundary. The plain presentation remains the default. Entry uses a 420ms cubic
timeline; every normal return/cancel reverses that same timeline before
stack removal. The close callback requests cancellation first; the kernel’s
`onBeforeDismiss` boundary waits for the renderer, then delivers results and
tears down the dismissed runtime. A close during entry reverses from the current timeline
instead of jumping to a second animation. A rejected cancellation restores the
panel for retry; successful cancellation waits for the kernel to remove the
binding. No perpetual frame loop is added, and unrelated notifications retain
the same keyed instance.

The close control reuses the shared `Button`/`ActionButton` composition for its
official `Focusable` activation and native `active:` pressed style. Its 44×44
round hit target is positioned at `x = viewportWidth - 52 .. -8` and
`y = 8 .. 52`, offset by the display safe insets. A 30px `#F5F6F7` circular
board sits inside that hit target; focus and press feedback remain circular.
The centered icon uses a 14px dark ring, 10px light inset and 6px dark center dot, without an
ellipsis or X. It uses native View shapes, not a font symbol or menu
placeholder. Its surrounding official FocusScope makes the control reachable
outside the underlying page's focus scope and restores focus when the child is
removed.

Native acceptance builds root/Profile/Lobby into temporary directories and
verifies intermediate upward/downward text positions, direct close and nested
cancellation. It waits for cancellation delivery rather than treating the
first offscreen frame as completed teardown. The public plain-surface compiler
regression and portrait/wide/resize NavigationBar probe also pass.
The entry clock starts after the kernel's existing first-frame launch fact,
not when runtime creation starts. `ready: false` is derived from the existing
pending launch and removed when it completes; no second lifecycle state machine
is added. A one-pixel full-viewport surface sliver remains admitted while
preparing, because the native first-frame contract requires a visible
compositor surface. Without this admission the readiness barrier and an
entirely offscreen surface would wait for each other.

Actual Playwright Chromium verification used an isolated native manager and a
CSS-scaled iframe (0.74). Child title y moved from 719.1 to 64.4 during entry,
and from 64.4 through 73.6 to 655.7 during close; Profile disappeared after
cancellation, with zero browser errors. Screenshot:
`/tmp/pocket-editor-preview-page-20261104/mini-circular-close.png`.
The old shared preview session was not used for the final interaction check.

Idle-close correction: a browser run that opened Profile, waited six seconds,
then pressed its close button reproduced a stationary panel even while native frame
numbers increased (82 → 138, demand remained continuous). Native
`before_external` had already settled and credited the six-second idle interval;
the preview's duplicate 1000ms delta clamp dropped most of the corresponding
host delta, leaving future ticks to pay down that credit. The preview now passes
the full elapsed interval through both `tickNow` and `pumpRuntime`; native keeps
ownership of fixed-step catch-up bounds and idle skipping. The same isolated
browser reproduction then observed exit positions 86 → 816, removed Profile,
and returned to idle demand without further input. No timer watchdog or second
animation clock was added.

## Shared safe-area and host-action layout

Independent guests use `SafeAreaScaffold` for system safe-area insets and
`reservedActions="mini-app"` for the host's top-right action. `MobileAppBar`
consumes the shared 60 logical pixel reservation; the background and body retain
the full viewport. The root Showcase shell consumes only its top safe inset,
and its compositor surfaces remain outside that padded shell. This keeps the
host close button floating over a fullscreen child without a second header.

The Flutter input adaptation retains the parent's canvas/Listener boundary
(`pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`). A sparse root
canvas now hit-tests actual painted operations so uncovered space reaches the
child surface. Root operations painted after a child still receive their own
pointer contact. The compositor widget regression exercises child taps, root
overlay taps, and a child drag/cancel across the overlay; JS remains responsible
for semantic hit testing and button feedback.

Final native geometry checks cover 390px and 320px portrait widths. Profile's
Guest A right edge is respectively 322px and 252px (within the 330px/260px
content limits); Lobby follows the same reservation. The actual browser child
input viewport is `{x:0,y:0,w:390,h:844}`. An isolated scaled-iframe run sampled
entry y positions 852 → 825.7 → 173.1 → 9 and reverse exit positions
9.2 → 219.7 → 801.8 → 852, then removed Profile without further clicks or
browser errors. Nested no-inset scaffolds retain the parent's grow-only,
intrinsic-height layout: adding a bounded clipped body there would collapse
pages inside `ScrollablePage`.


## Retained stack and universal dismissal (2026-11-04)

The retained parent’s `lib/render/pocket_ui_components.dart:571–706`
keeps route order and cached subtrees; `lib/core/pocketjs_bundle_runner.dart:806–989`
uses push/pop navigation. The JS adaptation reads the kernel’s existing stack
with `surfaceBindings({ includeStack: true })`; it adds no second navigation
stack. Covered sheets keep their keyed component and runtime, but only the top
sheet receives input. Profile now handles Lobby’s result without automatically
returning to Showcase, preserving its selected identity.

`completeTopCall` and `cancelStackFrom` await the same presentation boundary.
The renderer reverses its existing entry timeline, in top-to-bottom order for
multi-frame cancellation. Button close, guest `returnResult`, and programmatic
`platform.apps.cancel` therefore share the same animation. Cleanup resolves
pending presentation waits; kernel disposal releases its waiters. Process or
runtime failure cleanup is not a normal interactive dismissal.

The web preview yields pending SystemUI requests to its normal ticker whenever
the official native schedule requests continuous frames. It checks after every
pump, including when the dismissal hook starts after a queued operation. This
removes synchronous animation consumption inside one input request without
adding another clock or timer loop.

Validation: `preview_mini_app_stack.test.ts` builds and executes real root,
Profile and Lobby bytecode with `pocket_probe`. It verifies multiple monotonically
downward exit positions for button, guest return and programmatic cancellation,
plus explicit Profile return. Across nested closes, the original Profile runtime,
selected identity and settled sheet position remain unchanged (1 pass, 0 fail).

Additional focused acceptance passed: idle six-second button close (1),
Playwright Chromium SSE entry/close (1), native preview/counter/nested return
(3), deferred second-pump continuous animation (1), missing-response failure
(1), Demo guest state (7), and kernel contracts (9, including disposal during a pending dismissal). The earlier combined run
exposed an acceptance helper that mistook the slow first pixels of entry for a
settled sheet; it now also requires the title to reach the viewport top, and
its isolated rerun passed. Logs are under
`/tmp/pocket-editor-preview-page-20261104/*dismiss*`.

The 8792 service was restarted and its local Showcase build completed with
`busy: false`, `error: null`, `revision: 1`, `builtRevision: 1`.
This verification uses native execution plus web preview; no physical iOS or
Android device run was performed for this JS presentation change.

## Preview shared identity storage correction

A real native Profile → Lobby launch reproduced `No shared identity yet.` in
Lobby after selecting Lin Mei. The preview keyed even shared storage by app ID,
so Profile's `identity/userInfo` and Lobby's `identity/userInfo` were different
entries. The native Dart implementation already uses a namespace-owned bucket
(`sdk/lib/src/pocket_platform_data.dart`, `_bucketFor`); the JS kernel checks
`sharedNamespaces` before forwarding the operation. No consumer launch-props
fallback is needed. The retained parent has no matching shared namespace storage
implementation to migrate; this corrects the web host adaptation to the existing
SDK contract.

The preview now scopes named buckets by namespace and unnamed private buckets by
app ID, consistently for get/set/remove/keys. System storage remains restricted
to SystemUI. The stack regression now inspects the actual Lobby runtime's own
DrawOps for `Lin Mei` and `USR-LIN-1007`, rather than accidentally accepting text
from the retained Profile underneath. The new assertions failed before the fix
and pass after it across all three nested dismissal/reopen paths.
Logs: `/tmp/pocket-editor-preview-page-20261104/lobby-identity-before.log` (1 fail)
and `lobby-identity-after.log` (1 pass).
The same native regression also closes Profile completely, then opens Lobby
directly from Showcase and verifies Lin Mei without any Profile launch props.
That assertion passes. The acceptance waits for the real Profile teardown and
result delivery before opening a new app. Existing native preview smoke tests
also pass (3/3). The updated 8792 service reports no build error.
`preview_storage.test.ts` additionally passes shared get/set/keys/remove,
namespace separation, private app isolation, and rejection of direct child
`system.storage` calls (1/1). Together with the native stack/identity test and
three preview smoke tests, this correction has 5 passing focused tests.
