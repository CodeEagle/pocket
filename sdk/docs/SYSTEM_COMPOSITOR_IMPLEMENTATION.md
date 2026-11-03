# System compositor integration

## Source contract

This integration follows the framework compositor contract and the existing
Pocket multi-app policy implementation:

- `docs/MULTI_APP_IMPLEMENTATION.md` describes the trusted SystemUI and guest
  runtime boundary.
- `docs/POCKETJS_FEATURE_PARITY_UI.md` records the UI and compositor surface
  behavior to preserve.
- The pinned upstream `sdk/.cache/pocketjs/programs/web/system-engine.js`
  consumes SystemUI DrawOps for child visibility, focus, draw order, and
  scheduling. The Flutter host uses those same emitted surface facts; it does
  not add a second layout engine or app scheduler.
- The retained `pocketjs_flutter_demo/mini_apps/syslib` sources demonstrate the
  previous compositor UI contract. `pocket_host/` is excluded from this
  reference path.

## Runtime flow

1. The trusted SystemUI `PocketAppConfig` supplies a stable
   `appId -> surfaceHandle` registry. Handles are unique integers from 2
   through 63; legacy texture handle 1 stays reserved. Each registry key must
   name a trusted child in `PocketSystemHost.applications`. Child configs may
   not install their own compositor registry or self-grant compositor access.
   The host supplies `ui.compositor-surfaces` only to its trusted SystemUI.
2. Native pre-evaluation setup publishes that same registry as
   `ui.__surfaces`. The SystemUI JS kernel reads and validates it without
   sorting or assigning new handles. The JS package/build catalog remains the
   source for the mapping. `sdk/scripts/build_system.ts --target=pocket-flutter`
   emits the resolved upstream plan together with `compositorSurfaces`; it
   excludes SystemUI, assigns child ids in catalog order from 2 through 63,
   and reserves positions for cataloged but uninstalled optional apps.
   Consumers pass that generated map as trusted config. The same native map
   may contain legacy `pocket.flutter.surface: 1` and dynamic glass/platform
   handles from 100 onward; the System registry validates only application
   handles and still rejects unknown ids in the reserved app range.
3. SystemUI owns app launch, resident policy, and focus decisions. Its surface
   UI emits ordinary `application` compositor DrawOps with a stable handle,
   bounds, clip, and focused flag. A JS subscription wakes the UI when those
   policy bindings change. Geometry, clipping, and Z order stay in the
   SystemUI DrawOps stream.
4. `PocketSystemHost` mounts only the SystemUI guest at the root. It resolves
   each `PocketCompositorSlot.surfaceHandle` to the matching live guest
   instance and returns that child using an instance-stable `GlobalKey`. The
   child is a separate Pocket session and runtime.
5. `PocketView` places the returned guest at the DrawOps position, clips it to
   the inherited clip and local viewport, and preserves DrawOps order. A slot
   carries both full bounds and the visible clip, so clipping does not change
   the child's local coordinate origin or viewport. Resize and pointer
   projection follow the child surface's own layout constraints.
6. Only a visible focused slot enables child input. Visible unfocused slots
   can continue rendering; absent, fully clipped, or hidden resident slots are
   retained Offstage with input and advancement disabled. The host changes
   session activity from slot visibility facts and does not infer a stack.
7. `system.runtime.create` returns after session initialization. After JS
   presents the runtime in DrawOps, `system.runtime.awaitFirstFrame` waits on
   the child's actual ready callback. Prewarm does not wait for a visible
   frame. Destroy and SystemUI generation replacement retire the slot, cancel
   pending first-frame waits, unmount the keyed widget, and close the session;
   stale generation callbacks are ignored.

## Retained and removed designs

Retained: independent child Pocket sessions, the JS-owned System stack,
catalog policy and bounded resident scheduler, the native frame/DrawOps
transport, renderer-owned clipping and pointer routing, and the existing
Canvas/Flutter widget composition.

Removed: the Dart `_presentedOrder` list, the host-side
`system.runtime.present` mirror, and the root Stack that placed every child
full-screen. No child screenshot is rasterized for composition. Dart keeps no
second app stack, LRU policy, layout algorithm, or JS frame scheduler.

## Flutter target resolution

`sdk/scripts/flutter_target.ts` defines the actual `pocket-flutter` target on
the Flutter platform. `build_system.ts` passes its registry as the upstream
`validateAndResolveSystemPlan` third argument; the pinned PocketJS manifest
resolver remains the sole source of resolved package plans. The target
declares tested touch, baked text, live viewport, Pocket System
app/storage/message, and SystemUI compositor contracts. It leaves pointer,
hardware text, and IME capabilities out until the host provides hover and the
complete framework text-event/caret contracts. Its display class is explicitly
`composited`; it does not inherit the pinned resolver's repaint default for
unknown `flutter`. It does not advertise `io.offload`, network, camera, audio,
or worker capabilities. Touch viewports are capped at 1024 logical pixels per
axis to stay within the framework's 10-bit touch coordinate contract.

The build output's `compositorSurfaces` property is a trusted consumer
configuration derived from the same validated catalog used for the resolved
plan. Dart validates and forwards it; Dart does not allocate handles. The
current demo config still supplies this consumer map explicitly, so automatic
catalog-to-config packaging remains a follow-up integration step.

## Implementation and test status

The host and JS changes are in:

- `sdk/lib/src/pocket_system_host.dart`
- `sdk/packages/pocket_flutter/lib/src/pocket_compositor.dart`
- `sdk/scripts/flutter_target.ts`
- `sdk/scripts/build_system.ts`
- `sdk/packages/pocket_ui/src/system.ts`
- `sdk/packages/pocket_ui/src/platform.ts`

The renderer integration contract is `PocketCompositorSlot` and
`PocketHostSurfaceBuilder`. Configuration validation and system kernel tests
cover trusted registry bounds, distinct child bindings, focused input facts,
first-frame waiting, generation recovery, removal after close, and event-driven
updates. The injected-runtime `pocket_compositor_view_test.dart` exercises
DrawOps Z order, clipping, local pointer coordinates, focus arbitration, resize,
fully clipped residency, keyed subtree disposal, and parent pointer continuity
while a focused child remains unchanged. A focus switch to another child must
cancel the in-progress parent route.

Verification completed in this worktree:

- `bun test packages/pocket_ui/test/system_kernel.test.ts packages/pocket_ui/test/platform_client.test.ts`
  passed (2 tests), including legacy texture and glass/platform registry
  coexistence plus rejection of unknown app handles.
- `bun test ./scripts/tests/flutter_target.test.ts` passed all three target
  tests: target profile, resolved plan handles 2/3, and stable reservation for
  an uninstalled optional app.
- `bun test --timeout 60000 ./scripts/tests/flutter_target.test.ts ./tests/system_manifest.test.ts`
  passed all 13 tests. The web negative case uses a minimal valid manifest so
  it tests the missing compositor role capability directly; the demo also
  resolves through the Flutter target with handles 2 and 3.

The main agent's serialized Flutter validation passed six compositor/model
tests and the SDK host suite (52 tests), including the factory-copy test. A
later full Flutter run reached the new pointer-continuity case and failed while
reading its event payload; this test now reads the `input.pointer` payload
field, and the updated compositor and surface-key assertions still need a
serialized rerun. The 13 Bun target/manifest tests passed earlier in the work;
the later build bootstrap changes still need a fresh full target/manifest run.
Rust validation was not run in this review. The real A/B QJBC integration run
on a device remains an end-to-end check for the trusted registry and SystemUI
compositor DrawOps.

## Remaining checks

- Re-run the targeted compositor and host tests after the focus and
  recorded-offload regression changes are included in the serialized suite.
- Run the Rust compositor registry and external-work tests after the final
  native build; they have not been verified in this review.
- Run the System demo with two real QJBC children; verify side-by-side and
  overlap rendering, clip and Z order, focused-only input, resize, teardown
  during an outstanding first-frame wait, and zero idle child ticking. Device
  and power behavior remain unverified.
- The demo now clears child focus while its root-level `DetailModal` is open by
  passing `systemUIFocused` to `SystemAppSurfaces`. This keeps the child visible
  while the modal owns input. The source change still needs a built guest/device
  interaction check.
- Keep the target and system-plan Bun suites passing as the demo catalog or
  target capability set changes.
- Wire the generated `compositorSurfaces` output into the demo consumer config
  (currently still explicit) and verify it is the exact map injected into
  SystemUI.
