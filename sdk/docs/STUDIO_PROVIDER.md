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

M5 (publish and inspect) changes, each evidenced by the Studio pages that needed them:

| Change | Why |
| --- | --- |
| `sdk/editor/server.ts` `readArtifact`: `resources.json` joins the artifact allow-list (read-only, same guards) | the pack contents summary needs the build's resource snapshot (key, kind, bytes, placement per resource); the `.pak` itself is binary and metadata-only. Test: `editor/test/editor_server.test.ts` |
| Provider: `resources.json` in `pocketStudioArtifactNames`; oversized pretty-printed JSON artifacts are re-encoded compactly before the 128 KiB cut (`bytes` stays the real size) | the snapshot of a larger project would otherwise be truncated and unparseable |
| Provider: `studio.publish.publish` drops the signed envelope's base64 `payload` (keeps `keyId`, `signature`, `payloadBase64Bytes`) | the payload lists every blob and can exceed the 256 KiB result quota for large projects, which would report a failure for a publish that already happened; the signed bytes are served at `manifestUrl` |
| Provider scrubber rule 5: key-like JSON fields (`privateKey`, `private_key`, `privateKeyPem`, `privateKeyBase64`, `secretKey`, `signingKey`, `signingSeed`, `seed`) are dropped and PEM/OpenSSH private-key blocks in any string become `<redacted-key>` | keys stay in the service (`keys/editor-dev-key.json` is never served); this is a provider-side backstop. Tests: `studio_plugin_test.dart` (all publish routes, errors, artifacts), `real_service_test.dart` (real publish, no field of the real key file in any result) |

Otherwise no service change: plan, publish, history, offline, artifacts.list/inspect all map onto existing routes.

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
- Artifacts: binary artifacts return metadata only; text artifacts are cut at 128 KiB (`truncated: true`).
- Version history has no trial/promoted/rolled-back state: the service journal records publications and slot pointers only; those states live in each device's update coordinator.
- Not run here: the macOS app, IME, window compositing (Linux container).

## M6: text cache, trusted extra roots, update key, self-update slot

Source-first note: the retained parent `pocketjs_flutter_demo` is not available in this environment (as in the earlier Studio
records), so nothing was inspected there. Everything reuses current SDK code: `PocketAppConfig` fields added the way
`rawTextInputEnabled` was, the catalog-source map of `editor/server.ts`, `editorUpdateTrust`, `PocketUpdateConfig`,
`PocketUpdateCoordinator`, `PocketPackageStore`, the session health trial/rollback and `createPocketUpdateClient`
(`SYSTEM_UI_SELF_REFRESH.md`, `PACKAGE_UPDATE_MODES.md`, `RELEASE_TRUST_POLICY.md`).

* `PocketAppConfig.textLayoutCacheCapacity` (default 256, copyWith/withNativePolicy/equality/hashCode) -> `PocketView`.
  Tests: `test/pocket_config_test.dart`, `test/pocket_font_family_fallback_test.dart` (widget level).
* Service: `StartEditorOptions.extraProjectRoots` / `--extra-project-root=DIR` (repeatable; also accepted by
  `pocket.ts editor`) lists additional trusted external projects; `provisionUpdateKey` / `--provision-update-key` creates the
  update signing key at startup (idempotent, never rotated; keyId `editor-<primary project id>`). Guarded exactly like the
  primary root; no HTTP route can add roots. Tests: `editor/test/editor_extra_roots.test.ts`.
* Provider config: `PocketStudioConfig.extraProjectRoots`, `updateChannel` (`test` default), `selfUpdateUrl`, `readUpdateKey()`
  (public half only), `studioAppId`; the lifecycle helper passes `--provision-update-key` and the extra roots. Tests:
  `test/studio_config_test.dart`, `test/real_service_test.dart`.
* Launcher: `bun pocket.ts editor --pocket` (`scripts/pocket_studio_launcher.ts`, tests in `scripts/tests`).
