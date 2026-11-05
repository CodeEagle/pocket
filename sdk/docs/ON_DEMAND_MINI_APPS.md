# Download mini-app packages on first open

## Scope and source reuse

The retained parent `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`
(bundle extraction / `_resolveExtractedPath`) and
`mini_apps/syslib/pocket_syslib_ota.js` were inspected. The parent's example
`LAZY_STREAMING` status is not a verified downloader and is not reused as one.
This implementation reuses the current SDK's `PocketUpdateCoordinator`, signed
package manifest, content-addressed blob store and health-based activation.
There is no second downloader, cache, JS interpreter or installation state machine.

A mini-app is one independently signed package. Opening it creates its existing
`PocketSession`; only then does `downloadOnOpen` resolve its package. Registering
it with `PocketSystemHost` or listing the catalog does not download it. Explicit
prewarming also creates a session and therefore can download the package.

## Host configuration

```dart
final profile = PocketAppConfig(
  appId: 'example.profile',
  downloadOnOpen: true,
  metadataAsset: 'assets/apps/profile/app.bytecode.json',
  manifestAsset: 'assets/apps/profile/guest-manifest.json',
  updates: PocketUpdateConfig(
    url: 'https://updates.example.com/profile/latest.json',
    keyId: 'release-key',
    publicKey: profileReleasePublicKeyBase64,
  ),
);
```

The small bootstrap metadata and guest declaration remain bundled. The metadata
pins the compatible runtime ABI, required positive build floor and Worker binding contract. The
mini-app's `app.qjbc`, `app.pak` and signed loose assets need not be embedded.
Publish them with the existing `sdk/scripts/package_update.ts` pipeline; publish
all immutable `blobs/` and `bundles/` alongside the signed manifest. Package URLs
and trust anchors are host configuration; guest arguments cannot choose them.

The normal JS catalog / allowed-open-app policy and `platform.launchApp` call
remain in use. A catalog entry is host-authorized and available to open; it need
not have downloaded bytes yet. Existing configurations default to embedded
startup and retain their behavior.

## Admission, cache and failure behavior

- First open without a healthy cached package downloads and verifies the signed
  package, all content hashes, PAK assembly and runtime ABI before exposing it
  to the guest surface. The existing automatic bundle/granular selection applies.
- Subsequent opens reuse only the verified `lastGood` cache without a manifest request,
  so cached mini-apps can open offline. An `active` pointer alone is insufficient.
  Updates remain explicit through the
  existing update API; newer releases reuse unchanged content blobs.
- Downloading or preparing a package does not mark it healthy. The existing
  first-frame plus live health window controls promotion.
- No embedded code fallback is attempted for this configuration. Startup,
  download and verification failures reach the normal open error path; runtime
  failure can recover only to a verified healthy package. Rollback without a
  previous healthy package fails explicitly.
- Closing the session cancels its in-flight download. Cold download has an
  20-second overall preparation deadline in addition to transport timeouts. JS create/open deadlines
  allow this I/O and the existing first-frame wait without lengthening ordinary
  shared-bridge requests.

## Deferred Editor work

Editor will list all mini-app subpackages and allow choosing which resources
stay in each PAK and which are hosted on the network. That resource placement
UI, build configuration and individual first-use resource loading are not
implemented here. This change downloads a complete selected mini-app package;
it does not fetch individual images on first paint. Host/system fonts are not
remote assets. Actually packaged custom glyph data remains part of the signed
resource contract.

## Validation and review

The regression suite uses a real loopback HTTP server and test-generated
Ed25519 keys. Embedded qjbc/PAK asset access is an error in these tests.
It covers cold-open deduplication, healthy offline reopen, signature/hash/app ID/
ABI rejection, first-install build floors, bootstrap upgrades over old caches, rejection of active-only unproven caches,
close during a streaming download, and recovery failure without restarting the
failed candidate. The independent mounted fixture is compiled with `buildGuest`;
after HTTP download and admission, the native runtime renders its text and a
native pointer down/up changes `Downloaded count 0` to `Downloaded count 1`.

Reproduce from the worktree root (reuse the existing shared native target):

```sh
CARGO_TARGET_DIR=/Volumes/ORICO/Development/Github/pocket/sdk/native/target \
  bun sdk/scripts/tests/on_demand_fixture.ts /tmp/pocket-on-demand-fixture-verify

cd sdk
POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib \
POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-worker-fixture-verify \
POCKET_ON_DEMAND_FIXTURE_DIR=/tmp/pocket-on-demand-fixture-verify \
  flutter test --no-pub --concurrency=1 --reporter expanded
flutter analyze --no-pub lib test packages/pocket_services/lib/src/pocket_update.dart

bun test tests/system_manifest.test.ts \
  packages/pocket_ui/test/host.test.ts \
  packages/pocket_ui/test/system_kernel.test.ts \
  packages/pocket_ui/test/updates.test.ts \
  packages/pocket_ui/test/media.test.ts \
  packages/pocket_ui/test/platform_experience.test.ts \
  scripts/tests/package_update.test.ts
```

The Worker fixture for existing tests is generated separately with
`bun sdk/scripts/tests/worker_recording_fixture.ts /tmp/pocket-worker-fixture-verify`.
Analysis is scoped to the SDK's `lib` and `test`; independent leaf packages
require their own dependency bootstrap. Architecture and pinned-upstream
verification are also checked. Editor resource-placement settings remain deferred.

Validated on 2026-11-05: SDK tests **93 passed, 0 failed, 0 skipped**;
package-update regressions **13 passed**; the seven JS suites above **57 passed,
0 failed** (271 assertions). Scoped analysis reported no issues. Architecture,
pinned-upstream verification and the staged whitespace check passed. An
independent read-only review found no remaining blockers after the floor,
recovery and strict healthy-cache fixes.
