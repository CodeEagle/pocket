# Native back navigation

## Ownership

Flutter reports a back action through `PocketSystemHostController.requestBack()`;
it does not mirror a guest route stack. The host sends
`platform.back.request` to the compositor-focused child guest, if one exists.
That guest may pop one of its own JS pages and answer
`platform.back.response` with `handled: true`. If it declines or has no
listener, the host asks trusted SystemUI. A stale reply from a closed or
replaced session is ignored, and concurrent native back callbacks share one
request.

SystemUI resolves its own state in JS. `PocketSystemKernel.handleBack()` first
cancels one foreground child app call using the existing result/cancellation
path. The Showcase then pops `demo/js/state.ts`'s `routeStack`; only when both
stacks are at their roots does it call `system.closeContainer()`. If the guest
protocol times out or no SystemUI listener is available, the Flutter boundary
falls back to the configured `onClose`, the enclosing Navigator route, or the
platform root exit.

`PocketSystemHost` owns the loaded-host `PopScope`, so direct embeddings receive
native back as well as `PocketSystemHostApplication`. The application shell
keeps its immediate exit while remote host configuration is still pending; a
loaded host delegates to the guest boundary and cannot both pop JS and exit the
container for the same platform callback.

The application also guards its enclosing Flutter route: its nested Navigator
cannot otherwise stop the outer Cupertino route from claiming the edge drag.
Both route boundaries delegate to the same controller rather than owning stacks.

## Consumer integration

Register the page-stack policy once in the guest and dispose it with the app:

```ts
import { createPocketBackNavigation } from "@pocket/ui/back-navigation";

const back = createPocketBackNavigation(host);
back.setHandler(() => {
  if (!router.canPop()) return false;
  router.pop();
  return true;
});
// During guest cleanup: back.dispose();
```

`router` above is the consumer's existing JS router, not an SDK-provided stack.
For host-owned back inputs outside the Flutter route, call
`await controller.requestBack()` and apply the host's exit only if it returns
`false`. A native UINavigationController or another embedding container that
removes Flutter directly must forward its back action through that entry point.
The SDK cannot intercept an external container removing its rendering surface.
Each guest reply has a 600 ms budget; handlers should dispatch navigation promptly.

## Retained behavior and adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected with `pocket_host/` excluded. Its
`lib/render/pocket_ui_components.dart:3828–3846` handles an edge drag beginning
within 36 logical pixels and a positive primary velocity above 260, then calls
the legacy Dart runner's `canPopCurrentStack` / `popPageWithResult` in
`lib/core/pocketjs_bundle_runner.dart:477,901`. We preserve its user-visible
behavior that one successful back gesture pops one page, but route policy now
stays in the JS guest and mini-app kernel. No copy of the legacy Dart stack is
introduced.

Android system back enters through Flutter's `PopScope`. On iOS, a lightweight
pointer listener covers the embedded left-edge gesture: it records a start in
the first 36 logical pixels. On pointer-up it accepts either at least 88
horizontal logical pixels or a short horizontal fling beyond Flutter's touch
slop with release velocity above 260 logical pixels/s. Vertical travel must
remain within 72 logical pixels and smaller than horizontal travel. Cancelled
drags are ignored. One raw-pointer velocity tracker avoids competing with
`PocketView`'s gesture arena; there is no second drag recognizer or route stack.
The device platform, rather than the consumer's visual theme, selects iOS input.
It commits the existing JS transition on release; it
does not implement an interactive transition that tracks the finger.

The first phone build rejected all short flings below 88 logical pixels,
including fast edge swipes that the retained parent accepts. The follow-up
restores that retained velocity path and adds `[PocketBack]` input/dispatch
facts for phone diagnosis. This is an evidenced recognizer gap; it does not
by itself prove the cause of any individual phone gesture without a trace.

## Validation

- `sdk/packages/pocket_ui/test/back_navigation.test.ts` — 2 passing tests for
  handled, unhandled, throwing, and disposed JS back handlers (reviewed and run
  by the parent agent).
- `bun test sdk/packages/pocket_ui/test/system_kernel.test.ts` — 21 passing
  tests, including a regression that calls `handleBack()`, verifies one child
  app call is cancelled, its pending caller receives one `platform.result`
  with reason `back`, and a second call at the root is unhandled.
- `demo/js/tests/back_navigation_native.test.ts` — built through pinned
  `buildGuest` into `/tmp/pocket-back-validation-20261110`; real QuickJS/native
  frames verify pointer-pushed Mobile UI returns to Home on the back request
  without a close RPC, then root back sends exactly one close RPC (run by the
  parent agent).
- `demo/js/tests/navigation_native.test.ts` — 2 passing cases against the same
  compiled guest for retained route state and secondary-route Back (run by the
  parent agent).
- `cd sdk && flutter test test/pocket_system_host_test.dart
  test/pocket_host_loading_test.dart --reporter expanded` — 15 passing widget
  tests, including the loaded host system-pop path, handled/unhandled protocol
  replies, concurrent back request deduplication, and pending-configuration
  immediate exit, cancelled/completed iOS edge input, and the outer route guard
  (run by the parent agent). These are widget tests, not an iPhone device run.
- Targeted Flutter analysis reported no issues. One consolidated Argon Medium
  review was requested after implementation and validation; the CLI timed out
  after five minutes without a conclusion. No review approval is claimed.
