# Studio provider (`pocket_studio`)

Optional SDK package for the Pocket-hosted Studio (`studio/`, milestone M1). The contract (frozen capability
table, grant model, scrubbing rules, lifecycle) is in `studio/docs/ARCHITECTURE.md`; this file is the
`AGENTS.md` record: sources reused, necessary changes, validation.

`pocket_sdk` does not depend on `pocket_studio` (`check_architecture.py` lists it among the optional packages),
and nothing under `sdk/` imports `studio/`.

## Source-first record

The retained parent `pocketjs_flutter_demo` is not available in this environment, so no retained implementation
could be inspected. Reused from this repository:

- `pocket_services`: `PocketPlugin`, `PocketPluginDescriptor` (per-capability permissions, schemas, limits),
  `PocketPluginContext.registerRequest/registerStream`, `PocketCapabilityException`, `PocketHost`,
  `PocketStreamBridge` and its 256-item / 256 KiB wire limits; the `pocket_clipboard` plugin as the model for
  the separate read/write grant layout and for the admission tests (`PocketPluginManager.negotiate/invoke`).
- `sdk/editor/server.ts` routes and guards exactly as documented in `EDITOR_FS_AND_BUILD_ROUTES.md` (no service
  change was needed: every capability maps onto an existing route).
- `pocket_dio` was inspected for its IO-worker pattern and deliberately not reused (see ARCHITECTURE.md,
  "Provider design").
- `scripts/tests/studio_preview_service.ts` and `test/studio_preview_ffi_test.dart` for the real-service / real
  native test pattern; `PocketSession`'s host wiring (`PocketHost` + `PocketPluginManager`) for the host test.

## Necessary changes (evidenced gaps)

| Change | Why |
| --- | --- |
| New package `sdk/packages/pocket_studio` | the stateless route map, scrubber, SSE mapping and service lifecycle did not exist (`M0_REPORT.md` C5/C6, 3.4) |
| `PocketAppConfig.rawTextInputEnabled` (field, `copyWith`, `withNativePolicy`, equality, `PocketApp` pass-through) | `PocketView.rawTextInputEnabled` existed (`STUDIO_TEXT_INPUT.md` D) but no consumer could enable it through the SDK config; the Studio host needs it for the M4 editor. Default `false`, additive. Test: `test/pocket_config_test.dart` |
| `check_architecture.py`: `studio/` rules | thin host, no extra Dart in `studio/lib`, no JS source in assets, SDK must not import `studio/`, studio must not import `demo/`, macOS-only |

No change to `sdk/editor/server.ts`.

## What the provider does (and nothing more)

`PocketStudioPlugin` (`lib/src/studio_plugin.dart`) registers 37 capabilities from the fixed table in
`studio_routes.dart`: it validates ids and paths (`studio_paths.dart`), builds the URL with `Uri.pathSegments`
(per-segment encoding), forwards over a loopback-only `dart:io` `HttpClient` (`studio_client.dart`), injects
`x-pocket-csrf` from `/health` on writes (one refresh on 403), scrubs every result, error and stream event
(`studio_scrub.dart`), and maps SSE routes to capability streams with a bounded, batching, gap-marking queue.
`PocketStudioService` (`studio_service.dart`) attaches to or starts `bun <sdk>/pocket.ts editor`, polls `/health`
to a deadline and stops its own child on exit. `PocketStudioConfig` carries the trusted host configuration.

Two result projections exist because the framework caps one response at 256 KiB: project status drops `logs`
(`project.list/open`), and `build.status` / `logs.tail` keep the newest ~100 KiB of log lines. Everything else is
passed through unchanged after scrubbing, or fails with `too_large` rather than truncating.

## Validation

All run on Linux x86_64 with the real native library and the real editor service.

```sh
export PATH=/opt/flutter/bin:$PATH
cd sdk/packages/pocket_studio
flutter analyze
flutter test                      # fake HTTP service tests + real editor service tests
cd ../../.. && python3 sdk/scripts/check_architecture.py
cd sdk && flutter test test/pocket_config_test.dart
cd ../studio/js && POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bash scripts/test_guest.sh
cd .. && POCKET_NATIVE_LIBRARY=$PWD/../sdk/native/target/debug/libpocket_flutter.so flutter test
```

`real_service_test.dart` starts the service through `PocketStudioService` (`bun pocket.ts editor <demo JS project>
--port=<free> --workspace=<tmp>`) and calls the plugin: health scrubbing, project list/open, tree, read, stat,
chunked read with sha256, project create, write, mkdir, rename, 300 KB chunked upload with hash verification,
delete, error mapping, a real `fs.watch` change event. A skip is not evidence: the tests skip only without bun.

## Known limits

- The preview child's public key is read from the trusted workspace after the service's first preview publish;
  catalog refresh and bootstrap metadata are M3.
- Streams reopen on `plugin_stream_quota` (10000 items) or server-side slow-consumer drops; the guest owns that.
- Artifacts: binary artifacts return metadata only.
- Not run here: the macOS app, IME, window compositing (Linux container).
