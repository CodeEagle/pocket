# Full logical pointer coordinates

PocketJS pointer coordinates now follow the complete logical viewport above 1023 pixels while keeping the established packed touch words intact.

## Retained behavior and adaptation

The retained parent demo does not define a generic pointer frame protocol. Its touch example is the local trackpad in `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` around `_MobileTouchTrackpadSurface` (roughly lines 715–810): Flutter gesture callbacks normalize local positions and send the trackpad's own `touchPadMove`, `touchPadTap` and `touchPadReset` actions. The pointer wakeup in that file only requests a canvas frame. There is no reusable packed guest-coordinate path there.

The SDK already has one touch snapshot and one gesture state machine. Native `sdk/native/src/lib.rs` resolves down-edge hit facts and surfaces before creating the existing packed words; the pinned framework decodes those words in `framework/src/touch.ts`. The new path keeps that ownership and encoding for coordinates through 1023, and sends exact larger coordinates as an optional sidecar on the same frame call. It does not add another touch state table or change the `GuestFrame` Rust structure.

## Frame contract

The existing nine frame arguments keep their order: buttons, analog, packed touches, hit facts, surfaces, right analog, axis deltas, motion and text events. The native RquickJS adapter appends argument 10 only when at least one active or cancelled coordinate exceeds 1023. It contains one `{x, y}` record per packed contact in the same order as the touches, hit and surface arrays. Coordinates are rounded logical pixels, validated against the selected surface viewport and bounded to unsigned 32-bit values.

For coordinates through 1023, the native host emits the existing 9-bit or 10-bit words and the old 9-argument call. Above that range it keeps the contact ID in the existing wide word, sets the reserved coordinate-sidecar marker, and places the exact coordinate in argument 10. Bit 30 remains the cancel flag; high-coordinate cancellation words also carry the wide and sidecar markers. Low-coordinate cancellation words remain byte-for-byte unchanged. Down-edge native hit tests use the full coordinate before packing.

The optional fourth argument to framework `__setTouches(packed, hits, surfaces, coordinates)` preserves its original three-argument web/test callers. Solid, Vue Vapor and Octane frame entries receive the tenth argument. System-layer filtering carries it with its touch snapshot; the agent input replacement clears it when replay substitutes contacts so live coordinates cannot leak into substituted input.

If a packed word has the sidecar marker but the frame has no valid coordinate at that index, the new decoder drops that contact. It never turns missing sidecar data into a false touch at `(0, 0)`. Older QJBC guests continue to load and continue to decode the old 9/10-bit packed words; they do not understand the sidecar marker and therefore cannot receive correct coordinates above 1023. Rebuild guests with the updated pinned tools to enable large-coordinate input.

The existing DevTools tape schema is v5 and does not store the coordinate sidecar. Replay clears the live sidecar to preserve deterministic ownership; high-coordinate marker contacts are ignored by the new decoder during replay. Full-coordinate DevTools record/replay remains unsupported until the tape schema adds the exact coordinate lane.

## Source patch and validation

`sdk/scripts/prepare_upstream.py` applies `sdk/native/patches/input-touch-coordinate-sidecar.patch` after the other pinned PocketJS patches. The patch includes framework touch decoding, all three frame entries, system-layer/devtools argument forwarding and regression tests. Running bootstrap against the working cache reports the new patch as already present in all ten source/test sections. An isolated temporary pinned-source tree verified a clean application followed by an idempotent second application.

The framework tests pass with the patched cache:

- `cd sdk/.cache/pocketjs && bun test ./tests/touch.test.ts` — 8 tests passed, including legacy words, mixed surfaces, missing-sidecar rejection, hit facts and high-coordinate cancellation.
- `cd sdk/.cache/pocketjs && bun test --conditions=browser ./tests/devtools.test.ts` — 35 tests passed, including optional tenth-argument forwarding and replay isolation.
- `cd sdk && cargo test --manifest-path native/Cargo.toml --lib full_coordinate_pointer_sidecar_preserves_large_viewports_and_surfaces -- --nocapture` — native test passed for simultaneous primary/auxiliary contacts, high-coordinate cancel and the 2560×1440 viewport.

`sdk/scripts/tests/fullcoords_touch_guest.test.ts` builds an actual QJBC guest and probes 1920×1080, 2560×1440 and 1200×2400 viewports. It asserts the exact high coordinates in a framework gesture and activation of a real `Focusable`. Its first run used the previous prebuilt compiler package: the native hit fact activated the button, while the gesture incorrectly reported `(0, 0)`. That exposed that `buildGuest` consumes the packaged compiler, not the developer's prepared source cache. After packaging the patched framework and compiling the native probe, the same QJBC test passed all three viewport cases using `POCKET_TOOLS_PACKAGE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/fullcoords-native-tools-20261107` and `POCKET_FULL_COORDS_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/fullcoords-native-tools-20261107/bin/pocket_probe` (1 test passed, 2.66 s).

The pinned framework patch forwards the optional coordinate lane through Solid, Vue Vapor and Octane frame entries, but the current SDK `buildGuest` wrapper still invokes the compiler with `--framework=solid` (`sdk/scripts/build_guest.ts`). A real Vue SFC passed to this wrapper is rejected with “requires framework `vue-vapor`”; therefore this guest acceptance proves the Solid QJBC path only and does not claim that SDK scaffolds currently build Vue Vapor guests. A direct low-level compiler invocation would bypass the shared scaffold/editor/showcase `buildGuest` pipeline and is not counted as SDK acceptance.
