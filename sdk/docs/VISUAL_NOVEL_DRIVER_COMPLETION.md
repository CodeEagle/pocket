# Visual novel integration driver completion checks

## Why the host driver validates report data

The pinned Flutter 3.47.9 `integrationDriver` implementation in
`packages/integration_test/lib/integration_test_driver.dart` writes the test
response through `responseDataCallback`, then exits with the status represented
by the response. The production Lantern model showcase exposed a gap in this
contract: `/tmp/pocket-v4-fullbody-390-dpr2.log` contained a three-minute
`TimeoutException` and failed tests, while the standard integration driver
printed `All tests passed` and returned success because its received
`Response.allTestsPassed` was true. The app-level checkpoint report was the
available evidence that the mandatory model showcase had not completed.

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was checked outside `pocket_host/`. Its retained tree has no equivalent
`test_driver` or `integrationDriver` wrapper to adapt. This is a thin-host test
reporting gap, not a game SDK or business-state change.

## Optional checkpoint protocol

`demo/test_driver/integration_test.dart` continues to delete stale response
JSON before each run and calls the pinned `integrationDriver` with
`writeResponseOnFailure: true`. Its response callback first writes the current
`reportData` using Flutter's existing `writeResponseData`, then validates an
optional `pocketAcceptance` object:

```json
{
  "pocketAcceptance": {
    "required": ["model-showcase"],
    "completed": ["model-showcase"]
  }
}
```

When `pocketAcceptance` is absent, legacy driver behavior remains unchanged.
When present, it must contain `required` and `completed` arrays of unique,
non-empty strings. If any required checkpoint is missing, or the protocol is
malformed, the response callback throws after preserving the current JSON; this
prevents the driver's subsequent `exit(0)` and returns a nonzero process result.
The existing integration response still determines success when every
declared checkpoint is complete.

The owning model-showcase integration test declares its checkpoint in the app
response and marks it complete only after its full body and cleanup succeed.
The driver does not add another test runner, timeout, SDK state, or platform
policy.

## Focused validation

`demo/test/integration_driver_checkpoint_test.dart` covers a complete
checkpoint, a legacy response without the optional declaration, an incomplete
required checkpoint, and malformed arrays/values. Run only this Dart test with
the pinned Flutter binary, from `demo/`:

```sh
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test test/integration_driver_checkpoint_test.dart
```

Result: 4/4 focused tests passed; Dart analysis of the driver and test passed.
The real 1920 model run subsequently timed out before its completion marker;
the repaired host driver persisted the incomplete response and exited 1
(`/tmp/pocket-v4-fullbody-1920-dpr1.log`). A later complete model run returned
required/completed `model-showcase` and exited 0
(`/tmp/pocket-v4-fullbody-1920-trace.log`). This exercises the actual driver
callback path in addition to the focused validation tests.
