# First-visible-frame remediation

The SystemUI host keeps the Flutter layer as a surface and lifecycle boundary;
the JS SystemUI still owns application routing and presentation policy. A child
runtime may be initialized and render while its compositor slot is Offstage,
so `awaitFirstFrame` waits for both the native first frame and a non-empty
visible compositor slot.

The retained parent source was inspected at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart:22-35,69-75`
and
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:568-620,637-698`
(the `pocket_host/` archive was intentionally excluded). It keeps lifecycle
cleanup in the host runner and retains JS-owned route/page subtrees, rather
than adding a second Flutter navigation state machine. The necessary adaptation
in this thin host is that a failed child must reject its pending
visible-frame waiter even when it
already rendered an Offstage frame. Previously the failure path only rejected
that waiter before `hasEverProducedFrame`, leaving an `openApp` operation
blocked until the platform timeout. The waiter is now completed with the
runtime failure for every generation; the existing `system.runtime.failed`
notification remains reserved for runtimes that had already produced a frame.

`isPresented` remains `true` for the resident SystemUI. It is the compositor
root beneath child surfaces, while application instances use their actual
non-empty compositor slot visibility. The current multi-app integration
contract records this explicitly and checks child visibility separately. A
child's `isPresented` value therefore cannot be changed to mean “topmost”
without conflating root residency with surface visibility.

Validation was run serially by the root agent.
`sdk/test/system_host_first_visible_ffi_test.dart` exercises the
real SDK host/plugin/session path with the generated Worker fixture's QJBC and
pak: it loads a root and child through a mock asset bundle, invokes the real
registered `system.runtime.configure/create/awaitFirstFrame/destroy` handlers, waits
for the child's genuine Offstage first frame, injects failure through the public
`PocketSession.onError`, and verifies prompt rejection followed by destruction,
a fresh instance, and rejection of a waiter pending during destruction.
The test deliberately removes the fixture's `worker`
metadata because this regression concerns host visibility, not Worker startup;
the real Worker admission path remains covered by the dedicated fixture tests.

That fixture's ordinary `<text>` guest has no `hostSurface` DrawOp, so it cannot
honestly manufacture a compositor-visible slot or an OTA replacement
generation. Visible completion and generation replacement therefore remain
owned by the existing Showcase host integration, where SystemUI JS can emit a
real surface and drive the update lifecycle. The production change itself is
deliberately limited to the existing waiter completion path and adds no debug
API or second Dart state machine.

The final focused run passed 1 test, and the full SDK suite passed 62 tests
with zero skips. Restoring the previous failure branch in the isolated copy
made the focused regression fail with `TimeoutException` instead of the
expected `StateError`; the fixed host was restored before the final suites.
See [the integrated evidence](REMEDIATION_E06720E_VERIFICATION.md).
