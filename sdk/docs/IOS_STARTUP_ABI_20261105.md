# iPhone Duo startup ABI regression

## Observed failure

On the booted iPhone Duo simulator (`4D366210-290E-46DB-8BC6-3C5233700409`,
iOS 27.1), the installed Showcase displayed:

```text
Pocket startup failed: Bad state: Guest did not produce its first frame within 15 seconds
```

The installed `Runner.debug.dylib` and the pre-rebuild simulator archive exported
`pocket_frame_binary` and `pocket_send_binary`, but lacked
`pocket_frame_delta_binary_v2`. The iOS archive predated the mandatory binary ABI
change. `FfiPocketRuntime.open` correctly rejected it before creating a guest.

The first bounded `LayoutBuilder` constraints synchronously entered
`PocketView._start`. Its ABI check failed before the first `await`; the catch
called `setState` during layout. Flutter rejected that update before `onError`
could reach `PocketSession`, leaving its 15-second startup watchdog to report a
secondary timeout. The simulator log contained the corresponding
`PocketView` / `LayoutBuilder-[… pocket-host]` build-phase exception.

## Retained source and adaptation

- Retained parent `pocketjs_flutter_demo/lib/main.dart` mounts the real app first
  and schedules native prewarming with `addPostFrameCallback`.
- Retained parent `pocketjs_flutter_demo/ios/PocketRuntime/pocket_runtime.podspec`
  contains the original C Pod integration, not the current Rust XCFramework.
  There is no parent `PocketView` implementation to copy. Neither inspection
  used the parent's `pocket_host/` directory.
- Retain the current mandatory PFB1/PFP1/direct-object ABI, native slice selection,
  first-frame resource barrier, and startup timeout. The necessary adaptation is
  to enter the existing one-shot startup after layout. Reuse `_started` rather
  than add another startup state or error-retry layer; read the latest constraints
  when that callback runs and skip it after disposal.
- `pocket_flutter.podspec` already force-loads the CocoaPods-selected archive from
  the correct XCFramework slice. No extra CocoaPods build layer is required.

## Native preparation

From the repository root:

```sh
bash sdk/scripts/build_native.sh ios-sim
cd demo
flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409
```

This rebuilds both device and Apple Silicon simulator slices. Both now export
`pocket_frame_delta_binary_v2` and contain `submitValue` / `takeValue` with the
strict direct-object guest ABI marker. The relinked simulator Runner also exports
all three mandatory frame/input symbols. Generated libraries remain ignored.

Direct `flutter run` does not compile Rust. External consumers should rerun
`pocket.ts build --platform=ios-sim|ios` after native changes, using its existing
source fingerprint. Hot reload/restart cannot replace a statically linked archive.

## Validation

- Ablation: the new synchronous-factory-failure regression fails against the
  original inline startup with `setState during build` and no `onError` delivery;
  the deferred implementation reports the original ABI error immediately.
- `pocket_flutter`: first-frame, view, and viewport suites: **34 passed**;
  focused analyzer: **no issues**. The existing startup-resize resource barrier
  regression also verifies one runtime creation and the final `322x480` viewport.
- SDK background and SystemHost suites: **6 passed**.
- A normal `flutter run` on Duo reached the Home screen, retained it beyond the
  15-second watchdog window, and emitted no Flutter runtime exception. Installed
  Runner symbols were checked independently of the generated XCFramework.
- Duo `duo_resize_test.dart`: **passed** with the real compiled JS guest. Input
  changed `00 → 01`, three viewport changes retained the same controller and
  counter state, another input produced `02`, and UI/Home navigation preserved
  that value. The test helper stops dragging when the target becomes pointable
  and holds contact briefly before release, avoiding an unintended test fling.
  Analyzer for the two affected integration-test files: **no issues**.

The pre-existing `guest_interaction_test.dart` probe reached a real first frame,
changed `00` to `01` via Flutter pointer input, and navigated between Home/UI/Host.
Its full legacy scenario still expects the old `Gallery` label and a formerly
visible package-info row; it is not a passing full-suite result. The focused Duo
resize scenario uses the current `UI` label.
