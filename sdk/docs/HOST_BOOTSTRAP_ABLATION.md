# Bootstrap asset wait ablation (2026-11-06)

Follow-up: [Global host optimization](GLOBAL_HOST_OPTIMIZATION.md) additionally
overlaps history restoration with the two asset reads, preserves the full
admission barrier, and removes duplicate manifest parsing. The results below
describe the preceding two-document ablation; the Demo probe failure is fixed
in [the acceptance-baseline follow-up](OPTIMIZATION_BASELINE.md).

## Source and retained behavior

Inspected the retained parent (excluding `pocket_host/`):

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`, constructor and `_activateTab`: native initialization precedes the first active JS page; other tabs remain lazy.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`, `initState`: the host creates the runner and attaches native performance observation.

The thin SDK adaptation already lives in `sdk/lib/src/pocket_session.dart`. Its metadata and capability manifest are independent asset reads. The retained parent has no equivalent two-document bootstrap routine to copy. This change removes the unnecessary serial wait in that existing adaptation without creating a new loader, runtime, or state machine. JS still owns page composition and routing. Performance restoration remains before bootstrap, and capability admission still follows both documents.

## Change and ablation

`Future.wait<String>` starts both reads together; inline bootstrap JSON still bypasses the asset bundle. The default non-eager error behavior drains both reads before initialization finishes, so `close()` continues to wait for outstanding bootstrap IO.

`session_integration_test.dart` holds metadata pending and requires the manifest request to arrive before releasing metadata. It also verifies that plugin activation and session readiness wait for metadata.

- Temporarily restoring only the previous serial loading block makes this test fail after five seconds waiting for the manifest request. Log: `/tmp/pocket-bootstrap-serial-ablation.log`.
- Restoring parallel loading passes the same test. No wall-clock startup speedup is claimed; this is deterministic evidence that the redundant dependency was removed.

## Validation

- `flutter test test/session_integration_test.dart test/session_upgrade_test.dart test/session_download_on_open_test.dart`: 57 passed, one native test initially skipped without environment configuration.
- With `POCKET_NATIVE_LIBRARY=sdk/native/target/debug/libpocket_flutter.dylib` (absolute path) and `POCKET_ON_DEMAND_FIXTURE_DIR=/tmp/pocket-on-demand-fixture-verify`, focused bootstrap and downloaded QJBC tests: 2 passed, zero skipped. The latter downloads signed bytecode, renders it, and verifies native pointer-driven changes. Log: `/tmp/pocket-bootstrap-final-tests.log`.
- `flutter analyze --no-pub lib/src/pocket_session.dart test/session_integration_test.dart`: no issues found.
- The broader Demo `bash scripts/test_guest.sh` passes its bytecode first-frame mutation ablation and four video tests, but fails the native probe's `updates.status` text checkpoint (`configured=false`). Rebuilding with the pinned pipeline reproduces that failure. This probe runs JS/native directly and never loads the changed Dart session. It is an outstanding broader validation failure, not a passing result. Logs: `/tmp/pocket-host-guest-validation.log`, `/tmp/pocket-host-guest-validation-fresh.log`.

No device cold-start measurements were taken.
