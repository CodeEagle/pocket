# Native back navigation and interactive edge-back

## Ownership and fallback

Flutter reports a back action through `PocketSystemHostController.requestBack()`; it does not mirror a guest route stack. The host sends the existing `platform.back.request` to the compositor-focused child guest, if one exists. That guest may pop one of its own JS pages and answer `platform.back.response` with `handled: true`. If it declines or has no listener, the host asks trusted SystemUI. A stale reply from a closed or replaced session is ignored, and concurrent native back callbacks share one request.

SystemUI resolves its own state in JS. `PocketSystemKernel.handleBack()` first cancels one foreground child app call using the existing result/cancellation path. The Showcase then pops `demo/js/state.ts`'s `routeStack`; only when both stacks are at their roots does it call `system.closeContainer()`. If the guest protocol times out or no SystemUI listener is available, the Flutter boundary falls back to the configured `onClose`, the enclosing Navigator route, or the platform root exit.

`PocketSystemHost` owns the loaded-host `PopScope`, so direct embeddings receive native back as well as `PocketSystemHostApplication`. The application shell keeps its immediate exit while remote host configuration is pending; a loaded host delegates to the guest boundary and cannot both pop JS and exit the container for the same platform callback. The enclosing Flutter route is also guarded so its nested Navigator cannot claim the edge drag before the embedded guest.

The helper announces `platform.back.gesture.ready { ready }` when its interactive handler is registered or removed. Native transport records this capability only for the current session generation. A focused child without a current registration is skipped immediately, so SystemUI can preview its existing Mini App call stack without waiting 600 ms for an unsupported child. No route state is added to Dart.

On iOS, the host sends a continuous `platform.back.gesture` event to the focused child or SystemUI and locks that recipient's runtime generation for the gesture. A handled start suppresses the discrete request for that same gesture. An unsupported start or negotiation timeout follows the existing discrete-back threshold fallback. Native code owns pointer recognition, event delivery, focus selection, and generation locking; it does not own JS route policy.

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
back.setGestureHandler((event) => {
  if (event.phase === "start") {
    if (!router.canPop()) return false;
    beginInteractivePop(event);
    return true;
  }
  if (event.phase === "update") updateInteractivePop(event);
  else if (event.phase === "end" || event.phase === "cancel") settleInteractivePop(event);
});
// During guest cleanup:
back.dispose();
```

`router` above is the consumer's existing JS router, not an SDK-provided stack. Only a synchronous `true` from the start callback accepts the gesture. The helper responds immediately with `platform.back.gesture.response { gestureId, handled }`; later phases are delivered only for that accepted ID. A newer start cancels the previous accepted gesture, and cancellation/disposal notify the handler once.

For host-owned back inputs outside the Flutter route, call `await controller.requestBack()` and apply host exit only if it returns `false`. A native UINavigationController or another embedding container that removes Flutter directly must forward its back action through that entry point. The SDK cannot intercept an external container removing its rendering surface. Each discrete guest reply has a 600 ms budget; handlers should dispatch navigation promptly.

## Retained source and adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected with `pocket_host/` excluded:

| Source | Retained behavior |
| --- | --- |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:526-670, 3824-3844` | `PocketPageTransitionCompositor` receives both the outgoing and active page plus a progress listenable. `PocketMultiTabFrameworkViewport` recognizes an edge drag beginning within 36 logical pixels, checks `canPopCurrentStack`, and pops on release above 260 logical px/s. Its Showcase ActionBar also labels the gesture `右滑 / 返回` at `:1729-1744`. |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart:812-901, 950-990` | `pushPageForResult()` freezes and retains the parent page tree. `popPageWithResult()` removes the child, resolves its pending result, and starts the existing reverse transition with the retained outgoing and resumed pages. |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_router.js` | The retained `computeTransitionDescriptor()` defines the reverse page motion, including a positive viewport-width `outTx`; the SDK's `legacy.ts` preserves this math. |

The parent provides a discrete swipe-to-pop but does not expose live progress or a cancelled preview. This adaptation preserves its one-page pop behavior and retained page state while moving the preview and route decision to the JS guest. It does not copy the legacy Dart stack or add a second renderer.

## Interactive route behavior

`createPocketBackNavigation()` keeps the discrete `platform.back.request` lane and adds `setGestureHandler(handler | undefined)`. It tracks only the active gesture ID. The Showcase accepts a start while its route transition is idle and no details modal is open. If the kernel has a foreground Mini App invocation, the gesture binds its existing instance/request IDs; otherwise a previous entry in `routeStack` is required. The kernel remains the source of app-call stack membership.

The existing retained `RouteView` instances keep their page signals, scroll state, and content mounted. Each route owns its own `SafeAreaScaffold`, `MobileAppBar`, content, and (for primary routes) `NavigationBar`; route views are layered in existing stack order. During a drag the current page follows `dx`, while the previous page follows `-0.3 * width * (1 - progress)`. Each page uses an opaque background. This preserves the current page's viewport and vertical layout through start, update, and cancel while revealing the actual previous page and its chrome.

The route stack is unchanged while dragging and settling. Both page and Mini App back use `shouldCommitPocketBackGesture`: only an `end` whose latest `progress > 0.5` commits. Exactly 50%, a smaller distance, or pointer cancellation settles to zero. Velocity never bypasses this distance rule. Dragging past 80% and then back to 30% before release cancels. The cubic settle runs for 180–260 ms from the current position. This is Pocket's chosen product rule, not a numerical requirement from Apple HIG. Apple's [HIG Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures/) gives no fixed completion percentage; the [UIKit update documentation](https://developer.apple.com/documentation/uikit/uipercentdriveninteractivetransition/update%28_%3A%29) leaves the threshold to the application.

For Showcase routes, reaching one dispatches a single `popRoute` after advancing the existing route observer, avoiding a second reverse animation. For Mini Apps, `SystemAppSurfaces` translates the existing matching `MiniAppSurface`, including its compositor surface and chrome. It does not clone or replace the child. Cancelling leaves the invocation untouched. Reaching one calls `system.handleBack()` once; the existing kernel cancellation/result path reports reason `back`. Its existing before-dismiss boundary skips the second exit animation only when the completed preview's instance/request IDs match the kernel's top frame. External stack changes clear an obsolete preview. Continuous guest frames run during settle, rather than an idle drag.

Android system back and root/child routes that decline an interactive start keep their existing discrete behavior. The device platform selects iOS input; the consumer's visual theme does not.

## Arrow-triggered route pop

The retained parent already kept an outgoing page alive through its reverse transition. In the Showcase, the secondary app-bar arrow calls `popRoute`, whose reducer immediately removes the top route. Before this fix, the reverse descriptor moved only the destination page; the popped route was absent from `mountedRoutes()` and therefore could not slide out. The descriptor was also bypassed when neither route was one of the five Showcase pages.

The arrow path now seeds the existing `routeTransition` with `from`, `to`, reverse direction and zero progress **before** reducing the JS route stack. This keeps the original `RouteView` subtree, local signals and scroll position mounted while the stack points to its destination. The outgoing route is appended above that destination and follows the existing reverse descriptor's `outTx`, `outTy` and `outScale`, using the current content width. Forward transitions between ordinary primary routes retain their previous behavior. When the shared transition reaches its end, the outgoing route leaves `mountedRoutes()` and is disposed normally.

Interactive route completion passes `animatePop: false` because its existing drag already moved the page fully offscreen; it therefore does not start a second arrow transition. The same route transition state owns timing and cleanup, with no second stack or Dart route state.

On native release, `_onMove` already cancels a vertical-dominant pointer. The redundant `_onUp` `abs(dy) <= 72` guard incorrectly cancelled a long, mostly horizontal release even when its rightward distance exceeded half the viewport. The release check now keeps the same horizontal-dominance rule and the existing recognizer's distance/velocity thresholds. Pointer cancellation and early vertical arbitration remain unchanged.

## Validation and delivery

- Helper unit tests: 5 pass, including 49%, 50%, 51%, reverse travel and unconditional cancellation. Readiness registration/removal and gesture-ID gating share the existing event lane.
- Flutter host tests: 20 pass across `pocket_system_host_test.dart`, `pocket_host_loading_test.dart`, and `pocket_back_edge_regression_test.dart`. New tests exercise real host/pointer routing with probe runtimes: unregistered child and stale generation go directly to root; current-generation registered child receives start first. Host and test analysis are clean.
- Actual Editor-built QuickJS bytecode: both navigation regressions pass, retaining page scroll/local state and Apple Glass secondary-route behavior. All three back regressions pass. The new root Mini App case feeds official runtime create/first-frame facts to the real JS kernel, checks its compositor binding moves by 49% width, cancels without a result, cancels after 80%→30% reversal despite high velocity, and completes at 51% with exactly one `platform.result` carrying reason `back`. A root-only native probe cannot establish actual child-content state; that requires the child runtime or physical-device validation.
- Arrow-pop validation used the actual Studio Guest bytecode bundle `sdk/.pocket-build/editor-workspace-8791/builds/pocket-host-showcase/19/app.{qjbc,pak,bytecode.json}`: `bun test tests/navigation_native.test.ts` passed 3/3 and `bun test tests/back_navigation_native.test.ts` passed 3/3. The new 390×760 native Guest regression changes the Mobile UI Controls level to 5, taps the app-bar arrow, checks that the same control state remains on the outgoing page, samples its app-bar title on consecutive frames as `x` moves right, and confirms the route is removed when the transition ends.
- `cd sdk && flutter test test/pocket_back_edge_regression_test.dart` passed. Its pointer test releases a right swipe beyond half width with 80 logical pixels of vertical drift (above the removed 72-pixel cutoff), while preserving vertical-dominant and pointer-cancel cases.
- `bun tests/mobile_ui.test.ts` was also attempted and fails at its pre-existing source assertion for `visible={isPrimaryRoute(state().route)}`; `git show HEAD:demo/js/app.tsx` contains no `visible=` spelling. This static source check is unrelated to the route transition and remains unmodified.
- The direct `bun run build` command could not use the locally installed pinned compiler because its tool binary reports an ABI/version mismatch. The Studio source build produced revision 19 without errors, and the navigation regressions above ran against those freshly compiled QuickJS bytecode artifacts.
- Existing JS kernel tests: 21 pass, including the retained cancellation/result and before-dismiss paths.
- Native release build and strict code-signature verification pass. Installing the new build was blocked because CoreDevice reported the physical iPhone unavailable (error 4016). The prior test.11 build remains the last confirmed installed release.

The retained parent source was reused for edge recognition and one-page result semantics. The adaptation reuses the current JS kernel stack and MiniAppSurface dismissal boundary. Ablation removed the tentative 45%/velocity shortcut, duplicate stack policy, duplicate presentation wrappers, and temporary device-file tracing. No generated compiler/runtime artifacts are source.

The user confirmed Apple Glass follows the finger on the physical device. Lobby was the uncovered app-call path. Local host and native-engine checks supplement, but do not replace, confirmation of the new Lobby feel on the phone.

Release `0.1.0-test.12/build12` is published. The signed index payload digest, entry bytecode, pak, and runtime ABI match the tested `sdk/.pocket-build/back-phone-20261110/lobby-final` artifact; evidence is `lobby-validation.json` in that evidence directory. The consolidated Argon Medium review was requested after validation, but its 180-second print deadline expired without returning a review result. It is not recorded as a passed review; the request/timeout is in `lobby-medium-review.log`. The newly built native package is ready for installation once the physical iPhone reconnects.

## Flutter container edge preview

The retained parent project was inspected with `pocket_host/` excluded. Its `PocketMultiTabFrameworkViewport` and `PocketPageTransitionCompositor` already provide JS-owned page-stack swipe/pop with a retained outgoing page (see the source paths above); they do not preview the Flutter route containing a Pocket surface. This adaptation uses Flutter's public `TransitionRoute.handleStartBackGesture`, `handleUpdateBackGestureProgress`, and `handleCancelBackGesture` APIs to preview that existing route only after the guest declines its gesture. It adds no host route stack or transition controller.

`PocketSystemHostApplication` captures its enclosing route before creating its nested `MaterialApp` and passes that route to the host. This covers FunApp's `debug_page.dart` embedding chain (`MaterialPageRoute` → `RemoteContainerPage` → `PocketSystemHost`); the external FunApp repository was not edited. A directly embedded `PocketSystemHost` falls back to its own enclosing route. If the guest accepts the gesture, Flutter's route never moves. If it declines, Flutter follows pointer progress while the existing `requestBack()` arbitration runs. A handled request cancels the preview; an unhandled request calls the existing exit callback only while the route captured at gesture start is still current. Loading and error views use the same input boundary.

`nativeEdgeExitEnabled` defaults to `true` on both public host widgets. Set it to `false` when the embedding app must not leave its Flutter route through an edge swipe; guest `platform.back.gesture` delivery and guest page navigation remain enabled. System Back and explicit close keep their existing behavior.

The focused `pocket_back_edge_regression_test.dart` and `pocket_host_loading_test.dart` suite passed on Flutter 3.35.7 / Dart 3.9.2 and Flutter 3.47.9. It exercises actual widget-test pointer input, handled and declined replies, opt-out, loading state, cancellation, and a late reply after the captured route was externally popped. These tests validate the route API integration, not platform-specific edge recognition on a physical device.
