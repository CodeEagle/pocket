# Sensor cancellation identity and tracked-asset verification

This change closes N5/P2 and N6/P3 from
`/tmp/POCKET_REMEDIATION_REVIEW_1b39b1a.md`.

## Source reuse

Inspected the retained parent project, excluding `pocket_host/`:

- `pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart`,
  `readRealSensors`: retain the MethodChannel boundary and numeric native
  results. Its short timeout and synthetic fallback are not reused.
- `pocketjs_flutter_demo/ios/Runner/AppDelegate.swift`: retain native Core
  Motion and serial sensor queue ownership. The SDK already adapts this to
  explicit errors, cancellable operations and generation guards.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_hardware.js`: hardware
  policy/computation remains in JS; it has no operation identity mechanism to
  reuse at the native transport boundary.

The parent has no cross-plugin cancellation namespace. Adding that identity
at the existing Dart/native transport boundary is necessary; this change does
not introduce a second runtime, sensor state machine or business UI layer.

## Cancellation contract

The native manager has one process-wide sensor slot. A local operation counter
alone cannot identify its owner: two independent `HardwarePlugin` instances
both start at operation 1. A late timeout cancellation from one instance could
therefore cancel the other instance's current read or permission operation.

Each plugin now generates a 128-bit secure random `ownerToken`. Permission,
read and timeout cancellation carry the same immutable pair
`{ownerToken, operationId}`. The counter remains local; a static Dart counter
would only address a single isolate and is not used as the fix.

The serial native queue matches both fields before changing generation,
stopping a provider or completing its result. A cancellation with a different
owner, different operation, missing identity field, or no pending operation
does not stop a token-owned operation. Legacy reads without an owner token
remain supported; legacy ID-only/no-argument cancellation applies only to
legacy unowned operations. `disposeSession` retains its existing global
shutdown semantics.

Provider cleanup is shared by replacement, cancellation and completion. It
clears the identity/timer and stops both motion and altimeter updates. The
existing generation guard continues to reject late provider callbacks. The
old second matching check in `supersedeSensorOperationOnQueue` is removed;
identity admission happens once on the same serial queue.

Default Dart timeout remains 16 seconds and native first-authorization budget
remains 15 seconds. The change does not alter permission policy or fabricate
samples.

## Required tracked-asset test

`demo/js/tests/guest_state.test.ts` now gives native execution of the tracked
`app.qjbc` its own test. It requires a discoverable `pocket_probe`; absence is
a failure rather than an unreported omission inside the helper test.

For a target stored outside the default native target directory, pass:

```sh
POCKET_NATIVE_PROBE=/absolute/path/to/pocket_probe bun test
```

The test loads existing `demo/assets/app.qjbc` and `app.pak` directly, exercises
the performance page and requires both legacy aggregate and explicit event
rows. Do not rebuild the asset first when checking whether a commit contains
the fix. The helper test remains independent of native execution.

## Validation

Validation uses a detached `1b39b1a` tree at
`/tmp/pocket-fix-sensor-20261104` with only the remediation changes copied in,
so other uncommitted repository work cannot mask the result. Logs are under
`/tmp/pocket-fix-sensor-20261104-logs`.

The two new FIFO regressions fail on the original `1b39b1a` implementation:
read A, read/permission B, timeout-cancel A incorrectly completes B with
`hardware_cancelled`. The provider schedules a valid B response and delays
only A's superseded completion; no request reordering is assumed.

The repaired tests require B to succeed, distinct owner tokens with equal
local operation IDs, and cancellation carrying A's complete identity. The
existing single-instance cancellation/subsequent-read and >3-second provider
response regressions are retained.

Verified results:

| Command / check | Result |
| --- | --- |
| New FIFO tests on original `1b39b1a` Dart implementation | 0 pass / 2 fail: B incorrectly receives `hardware_cancelled` (expected negative control) |
| Five packages `flutter analyze --no-pub` | 5/5 successful, zero issues |
| Serial `flutter test --no-pub --concurrency=1 --reporter expanded` | services 27, hardware 5, Flutter host 126, SDK 67, demo 44: **269 pass / 0 fail / 0 skip** |
| SDK `bun test` with explicit native probe/compiler | **79 pass / 0 fail** |
| Demo JS `bun test` with explicit native probe | **15 pass / 0 fail**, including execution of unchanged tracked `1b39b1a` assets |
| Asset test in isolated fixture without any discoverable probe | 6 pass / 1 fail, explicit missing-probe diagnostic (expected negative control) |
| Swift source parse and final identity control-flow harness | Successful; six scenario groups / 35 state assertions |
| `python3 sdk/scripts/check_architecture.py` and `git diff --check` | Successful |

The serial Flutter matrix uses the `1b39b1a` native library and real Worker
fixture already built during the review. Worker FFI and Session tests execute;
neither is skipped. Rust source is unchanged by this remediation, so the Rust
suite was not repeated for this change. SDK Bun first ran without the explicit
probe environment and failed its two existing required native imports; the
complete run with the correct environment is the successful result above.

Commands with targets outside the standard directory use:

```sh
export POCKET_NATIVE_PROBE=/tmp/pocket-review-1b39b1a-native-target/debug/pocket_probe
export POCKET_BYTECODE_COMPILER=/tmp/pocket-review-1b39b1a-native-target/debug/pocketjs_bytecode
export CARGO_TARGET_DIR=/tmp/pocket-review-1b39b1a-native-target
export POCKET_NATIVE_LIBRARY=/tmp/pocket-review-1b39b1a-native-target/debug/libpocket_flutter.dylib
export POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-worker-fixture-1b39b1a
```

All Flutter commands execute serially. Controlled HardwarePlatform tests and
Swift logic extraction are not evidence of an actual iOS permission prompt or
physical Core Motion sampling; device Allow/Deny acceptance remains separate.
The Swift harness and its output are `/tmp/pocket-sensor-identity-harness.swift`
and `/tmp/pocket-sensor-identity-harness-final.log`.
