# First-frame image-resource barrier

PocketJS owns the DrawList geometry and the Flutter host owns presentation and
image decoding. Native texture resources can therefore arrive in the same
first `PocketFrame` as `PocketImageOp`/`PocketTextureTriangleOp` records while
their `ui.Image` decode is still asynchronous. The painter intentionally skips
an image operation whose `ui.Image` is not ready; publishing that frame early
shows the underlying rect without its rounded mask until the decode-triggered
scene invalidation completes.

`PocketView` now keeps its existing loading surface visible until the first
DrawList's referenced image resources finish decoding. This is a one-time
startup barrier. Later frames retain the existing non-blocking resource path,
and unrelated resources are still admitted asynchronously. The barrier has a
bounded timeout; decode failure or timeout transitions to the existing error
surface rather than displaying a partially painted first scene. Resource epoch
checks also discard a late decode after widget disposal or timeout.

Frames with no image or texture-triangle DrawOp deliberately keep the previous
synchronous startup ordering (`loading`/`onReady`/event delivery/ticker wake);
they do not pay an async barrier merely because a frame has an empty resource
list or unrelated resource metadata.

While this one-time barrier is pending, a self-owned host resize is coalesced
in the existing pending-size slot instead of applying a new DrawList. After the
first resource set is ready, the latest size is applied and its newly
referenced image resources are awaited before the first visible scene is
published. This protects startup only; later resize/frame resource changes keep
the normal asynchronous path.

The test-only `PocketImageResourceDecoder` seam is used by
`pocket_view_first_frame_test.dart` with a real `PocketImageOp` and
`PocketImageResource` pair. The delayed-decoder assertion is deliberately a
negative check for the old eager-publish behavior: the old implementation
would hide the loading surface and call `onReady` before the decoder completed.

The barrier is limited to image/mask DrawOps. It does not infer radius from
texture geometry, duplicate JS styling, add a ticker, or wait for unrelated
video initialization. Flutter/device integration validation remains a separate
step from the package widget tests.

## Source review

The retained parent was inspected without using its `pocket_host/` directory.
Its `lib/render/pocket_ui_components.dart` renders rounded containers through
Flutter `BorderRadius`/`ClipRRect` (for example, lines 348 and 403). That renderer
does not implement the current native DrawList texture-resource admission path.
Copying those Flutter business widgets would duplicate JS component styling.
This change instead extends the existing `PocketView` resource decoder and
loading/resize state, retaining PocketJS geometry and the existing renderer.

## Verification and limits (2026-11-03)

- Package widget regression: first resource delayed, decode failure, bounded
  timeout, disposal before decode, and resize while decoding. The resize fixture
  uses real changing constraints rather than a tight `MaterialApp.home` size.
- Ablation: an isolated `/tmp` package with premature first-frame publication
  restored failed three of the original four resource tests. No production
  source was replaced for that experiment.
- Related widget regressions: 24 tests passed after preserving the synchronous
  no-image startup path, including pointer FIFO behavior.
- Guest error diagnostics: the pinned upstream patch tests passed 12/12,
  including synchronous throws, a real enqueued QuickJS job throw, and budget
  interruption. Clean pinned-source bootstrap passed on both first application
  and an idempotent second invocation. Device and simulator native libraries
  were rebuilt.
- The intermittent real-device sensor/Push exception has not been reproduced.
  Native pointer/host-response probes passed sensor success and error cases and
  repeated Push/Back. Those probes are not evidence that the phone-specific
  problem is resolved. The diagnostic patch preserves the thrown message/stack
  when available; it does not add an unhandled-Promise-rejection tracker.
- A phone `flutter drive` attempt did not reach test execution because the
  wireless VM Service was unreachable. Flutter 3.35.7 starts drive targets
  paused by default, so this left a white test launch surface. This is distinct
  from first-frame resource loading. The normal `lib/main.dart` Profile build
  was reinstalled and launched; the user confirmed that the home page appeared.
  Future drive commands use `--no-start-paused`, and test completion must restore
  the ordinary Showcase entry. See [Flutter FPS](FLUTTER_FPS.md).

Raw logs and negative-control evidence are kept under the ignored local
`demo/artifacts/regressions/first-open-20261103/` directory. A successful install
or launch is not recorded as a passed device regression test.
