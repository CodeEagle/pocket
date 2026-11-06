# Mini-app update before entry

The System kernel checks a mini-app's configured signed update source before
changing the presented page. A newer package is downloaded, verified and mounted
while hidden; only the admitted generation enters the normal presentation and
first-visible-frame flow. The caller stays visible during this work. Network,
signature, admission or boot-lifecycle failure rejects the open instead of
silently entering an old package. The caller can retry.

SystemUI must declare `system.runtime.prepareOpen` alongside its existing
`system.runtime.create` capability and use a matching SDK host. The Showcase and
the native fixture declarations include it. No new child-app capability is
required.

The behavior applies to both paths:

- A cold open sends `system.runtime.create({ appId, prepareForOpen: true })`.
  The native session prepares the package before its bridge is published ready.
  The response must acknowledge `preparedForOpen: true`.
- A resident/prewarmed open sends
  `system.runtime.prepareOpen({ instanceId, generation })`. The host validates
  ownership, the expected generation and hidden state. The response contains
  instance/app identity, previous/current generations and factual `configured`
  and `updated` flags. An unchanged verified active package is reverified without
  a remount, including a hidden candidate that has not completed health promotion.

Apps without an update source retain their local package and generation. Editor
preview and the generated WeChat adapter currently have no trusted OTA resolver;
they report `configured: false, updated: false` rather than claiming an upgrade.
Trusted source URLs and signing keys stay in `PocketAppConfig.updates`; app input
cannot select a download location or weaken admission. A first signed package
at the embedded build can be admitted once; packages below the embedded build
remain blocked, and established remote identities still reject same-build
replacement. This does not add a background timer or a second app-owned refresh
client for launch.

## Lifecycle and state

Explicit prewarming retains the existing healthy-cache bootstrap. Actual entry
always runs its gate afterward, so a release published after prewarm cannot be
missed. A cold open performs one preparation rather than prewarm plus another
immediate check. The preparation uses the existing 20-second overall I/O budget
and cancellation cleanup.

The returned generation is consumed through the kernel's existing generation
handler before presentation. Child event admission requires the native observed
generation to match and that generation's real first frame to be ready. Earlier
lifecycle posts return `accepted: false` and remain ordered in the existing JS
queue until they can be delivered. The corresponding later host event is ignored
as a duplicate. Init/load/frozen lifecycle is replayed once for a replaced realm; an
unchanged realm retains its in-memory state. Failed boot lifecycle removes the
unusable child while leaving the caller visible.

A package mount does not mark it healthy. The existing visible first-frame and
live health window still control promotion and recovery. A hidden prewarm is
allowed to prepare while waiting for that first visible health window; genuine
concurrent downloads, mounts or promotions remain conflicts. The gate does not
wait for visible health while hidden. The coordinator receives the already
mounted package as a trusted native fact: it compares exact-update scopes and
no-op activation against the actual realm, while both memory and disk identities
contribute to downgrade/replay rejection. This neither marks the hidden package
healthy nor creates another store pointer. A failed candidate and failed recovery
clear executable readiness and leave a retryable terminal error.

App-private persistent storage remains the app's normal data store. An updated
realm starts its own JS state and loads its persisted data. The entry gate does
not snapshot a hidden guest's arbitrary in-memory state. Refreshes initiated by
a running app can use the existing versioned/conflict-aware
[guest update state handoff](SYSTEM_UI_SELF_REFRESH.md). Launch does not serialize
native handles or replay child instances.

## Source reuse and ablation

The retained parent was inspected before implementation, excluding `pocket_host/`:

- `lib/core/pocketjs_bundle_runner.dart` supplies the existing mini-app execution,
  resource and prewarm context. Its example lazy-download status is not a signed
  package admission implementation.
- `mini_apps/syslib/pocket_syslib_ota.js` contains in-memory module metadata and a
  SHA-length check, not a trustworthy download-before-entry gate.
- `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` describes a proposed
  hot-update transport rather than an executable signed launch gate.

The evidenced gap was a healthy-cache/prewarm bypass at actual entry. The SDK
reuses `PocketUpdateCoordinator.prepare`, the content-addressed differential
store, final admission, `PocketSession` mounting, the pinned `buildGuest` pipeline
and the existing kernel generation/lifecycle handler. JS owns launch sequencing;
Dart reports native package/instance facts. No second downloader, cache,
compiler, layout engine, mirrored lifecycle state or per-frame update polling was
introduced. Real FFI validation also exposed a transport redundancy: racing each
HTTP operation against an uncancellable delayed timeout retained a 20-second
timer after successful headers/body reads. The existing transport now applies a
cancellable future timeout to its operation/cancellation race. Completed reads
and cancellation release that timer immediately.

## Validation

Kernel regressions hold cold and prewarm preparation pending and verify that the
caller does not disappear. They cover generation adoption, duplicate host
events, unchanged-generation retry, failed verification, a host omitting the
cold-open acknowledgement, failed remounted boot lifecycle, queued-generation
boot failure, transient teardown errors and already-closed native instances.
They also verify that a newly ready controller cannot let later lifecycle
events overtake queued init. Preview and WeChat tests cover the factual unconfigured result and stale generations.

The signed Session tests cover cached and unpromoted prewarm packages, same-build
admission, embedded build floors, final verification, mount rollback and busy
operations. Added cases cover default-bundle reuse before promotion, mounted
replay/downgrade rejection, a different disk-active package and double mount
failure recovery. The real `mini_app_update_ffi_test.dart` runs compiled QJBC with
`PocketSystemHost`, a loopback signed-package server and the existing native
library. All three cases passed without skips:

- Download signed v1 with the default bundle archive during prewarm, then hold
  the v2 update request: the caller
  stays visible and the old child generation is not presented. Releasing it
  mounts and presents signed v2 in the same child instance. HTTP records confirm
  that unchanged content-addressed blobs are reused without another download. The v2 JS reports its version/count through an explicitly registered
  test capability; it must receive init/load/frozen/appear lifecycle exactly once
  in order. Controller pointer input changes count to one and changes the actual
  DrawOps digest.
- A downloaded but unpromoted v1 checks again at entry without remounting or
  downloading the bundle again.
- A failed check returns an explicit JS error acknowledgement before retry;
  retry succeeds against the same resident child.

The recorder's initial DrawOps are in the `loadBytecode` result as well as later
frame results. The test reads both; a paused prewarm need not schedule another
frame for observation. This validates the Dart-controller/native-QuickJS input
bridge, not OS gesture injection. The test-only capability observes actual JS
facts and does not supply package, mount or presentation success.

Reproduce from `sdk/` on macOS ARM64 with the matching native library built.
Use the pinned Flutter toolchain that generated `.dart_tool/package_config.json`;
a global Flutter pointing at a different engine cannot compile these tests:

```sh
bun scripts/tests/mini_app_update_fixture.ts /tmp/pocket-mini-app-update-fixture
POCKET_MINI_APP_UPDATE_FIXTURE_DIR=/tmp/pocket-mini-app-update-fixture \
POCKET_NATIVE_LIBRARY="$PWD/native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib" \
  flutter test --no-pub --concurrency=1 test/mini_app_update_ffi_test.dart

bun test packages/pocket_ui/test/system_kernel.test.ts \
  packages/pocket_ui/test/update_refresh.test.ts
flutter test --no-pub --concurrency=1 test/session_download_on_open_test.dart \
  test/session_upgrade_test.dart test/pocket_system_host_test.dart
```

Without its fixture/native-library environment the FFI suite skips explicitly;
that is not native execution evidence. The recorded 2026-11-06 run used the
fixture generated from the current sources and passed **3 tests, 0 skipped**.
Kernel/update-client regressions, preview/WeChat contracts, SDK analysis and the
architecture boundary check also passed. Transport regressions additionally
exercise successful read, cancellation and timeout cleanup without advancing a
spare 20 seconds to hide retained timers.


## Independent review (2026-11-06)

The user-requested reviewer was `agy gemini-4-argon-high`, effort `high`,
conversation `3555540b-49c2-419c-a228-a54d1c8f4f20`. It reviewed a fixed 20-file
snapshot based on `0ff6d12`; the first print call timed out and the same
conversation subsequently returned its complete report. Inputs, SHA256 manifest
and raw response are retained in
`/tmp/pocket-mini-entry-argon-review-20261106-f3hak7j3/`.
The reviewer inspected source rather than running tests; its findings were
independently checked before adoption.

The stronger native fixture reproduced two failures in the reviewed code:
new v2 JS observed load/frozen/appear but missed `onInit`, and reopening the
unpromoted signed v1 downloaded its `.7z` bundle again. The earlier granular-only
fixture did not cover that default bundle branch. The failing run is recorded in
`/tmp/pocket-mini-entry-argon-red-ffi-matching-sdk.log`. A separate JS regression
also reproduced later lifecycle events overtaking a queued init when the new
controller became ready between posts; it passes after reusing the existing
lifecycle queue to preserve order.


All three review findings were addressed. Child posts reuse the host's existing
observed-generation and first-frame facts plus the kernel's existing ordered
lifecycle queue. The coordinator uses `mountedPackage ?? currentActive` for
actual-runtime diffs/no-op activation, with all trusted identities contributing
to the build floor; no hidden health promotion is introduced. Double mount
failure clears the stale executable/readiness state and does not restore a
permanent busy flag. Signed regressions also cover another session changing the
disk-active pointer without changing this realm.

Final native validation used Flutter **3.47.9 / Dart 3.13.7**, the matching
existing native library and newly compiled standard-bundle fixtures. To avoid
concurrent commands changing the shared package resolution between Flutter
3.35.7 and 3.47.9, only the temporary verification directory's pubspec/dependency
metadata were isolated; its `lib`, `packages` and `test` entries link to the actual
SDK sources. No production source, runtime or assertion was replaced. The
source hashes stayed unchanged during the run.

`/tmp/pocket-mini-entry-reviewed-isolated-final-ffi.log` records **3 passed,
0 skipped**, including exact v2 init/load/frozen/appear ordering, no repeated
bundle or unchanged-blob downloads, failure/retry and actual input-driven JS/
DrawOps changes. The temporary dependency lock and test configuration remain in
`/tmp/pocket-mini-entry-verify-ujhw9gjv/`. Session signed tests passed **36 tests**
with **1 pre-existing optional FFI skip**; the dedicated FFI run above supplies
actual native execution separately. Kernel/refresh tests passed **27**, and
adapter/demo/manifest tests passed **31**.

Final rollback/host/transport regressions passed **19 tests** using the same
isolated toolchain (`/tmp/pocket-mini-entry-reviewed-native-regressions.log`).
SDK analysis and the architecture boundary check passed as well.
