# Mini-app cache-first entry and signed updates

SystemUI sends `cacheFirst: true` when opening a mini-app. A verified healthy
local package or the validated bundled runtime opens without waiting for the
network. The configured signed source is checked and any newer package is fully
verified into the existing package store in the background. It does not replace
the running generation or become healthy during the current open; the next
cache-first open consumes the staged package. A remote-only `downloadOnOpen`
app with no eligible local version still awaits the full signed download and
validation before it can run. Callers that omit `cacheFirst` keep the strict
check-before-entry behavior.

SystemUI must declare `system.runtime.prepareOpen` alongside its existing
`system.runtime.create` capability and use a matching SDK host. Cold creation and
resident preparation both include `cacheFirst: true`; the SDK host passes that
kernel decision into `PocketSession`. The Showcase and native fixture declare
the required capability. No new child-app capability is required.

The behavior applies to both paths:

- A cold open sends
  `system.runtime.create({ appId, prepareForOpen: true, cacheFirst: true })`.
  A healthy cache or bundled app is mounted locally and its bridge becomes ready
  while signed update preparation runs in the background. If a remote-only app
  has no eligible local package, the existing signed preparation is awaited
  before its bridge becomes ready. The response acknowledges
  `preparedForOpen: true`.
- A resident/prewarmed open sends
  `system.runtime.prepareOpen({ instanceId, generation, cacheFirst: true })`.
  The host validates ownership, expected generation and hidden state. A pending
  background HTTP operation does not block presentation. A completed staged
  candidate is locally reverified and mounted before presentation. The response
  contains instance/app identity, previous/current generations and factual
  `configured` and `updated` flags. An unchanged verified active package is
  reverified without a remount, including a hidden candidate that has not
  completed health promotion.

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

Explicit prewarming retains the existing healthy-cache bootstrap. Cache-first
entry consumes an already staged signed version before starting another remote
check. Without a staged candidate, a healthy cache remains presentable while its
update check runs. A cold remote-only open performs one preparation and uses the
the preparation inactivity watchdog and cancellation cleanup: 20 seconds without
network progress, 120 seconds during local verification/preparation, and a
bounded two-second cancellation drain. Continuously advancing downloads can
therefore take longer than 20 seconds in total. Outer SystemHost/JS request
deadlines remain separate.

The returned generation is consumed through the kernel's existing generation
handler before presentation. Child event admission requires the native observed
generation to match and that generation's real first frame to be ready. Earlier
lifecycle posts return `accepted: false` and remain ordered in the existing JS
queue until they can be delivered. The corresponding later host event is ignored
as a duplicate. Init/load/frozen lifecycle is replayed once for a replaced realm; an
unchanged realm retains its in-memory state. Failed boot lifecycle removes the
unusable child while leaving the caller visible.

A package mount does not mark it healthy. The existing visible first-frame and
live health window still control promotion and recovery. Background preparation
reuses `PocketUpdateCoordinator.prepare` and only writes a verified staged
package: it does not mount, advance the healthy pointer, change active generation
or fail a healthy open when the network fails. The next cache-first open checks
the staged bytes against the current trust policy, hashes, embedded build floor,
healthy/active identities and the currently mounted package before executing
them. Active and healthy identities continue to prevent downgrade and same-build
replay; previous versions remain rollback-only. Failed mount candidates use the
existing fallback path and are removed so they cannot be selected repeatedly.
No additional package pointer or update state machine is introduced.

App-private persistent storage remains the app's normal data store. An updated
realm starts its own JS state and loads its persisted data. The entry gate does
not snapshot a hidden guest's arbitrary in-memory state. Refreshes initiated by
a running app can use the existing versioned/conflict-aware
[guest update state handoff](SYSTEM_UI_SELF_REFRESH.md). Launch does not serialize
native handles or replay child instances.

## Source reuse and ablation

The retained parent was inspected before implementation, excluding
`pocket_host/`:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`
  and `lib/core/pocketjs_bundle_runner.dart` supply the mini-app host surface,
  execution, bundled resource and prewarm context. They do not contain a signed
  package cache-first policy.
- `mini_apps/syslib/pocket_syslib_ota.js` and the system catalog modules such as
  `mini_apps/syslib/pocket_syslib_pages.js` contain in-memory AOT metadata and
  update showcase behavior, not a verified staged-package store.
- The retained parent’s hot-update design note describes a proposed transport,
  not an executable signed launch gate.

The SDK adapts JS's existing open sequence by passing its explicit
`cacheFirst` decision through the native SystemHost boundary. It reuses
`PocketUpdateCoordinator.prepare`, the content-addressed differential store,
final package admission, health-based promotion and the existing generation/
lifecycle handler. The store's health cleanup now revalidates packages and keeps
at most two complete signed non-pointer stages so a background candidate survives
promotion of the currently running healthy version; invalid or excess unpointed
versions are removed. It reuses the existing `active`/`previous`/`lastGood`
pointers and `_loadVersion(verifier:)`, adding no stage pointer or second cache.
No downloader, compiler, layout engine or parallel update workflow was added.

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
operations. Added cache-first cases use a held loopback response to show a healthy
cache opens immediately, background preparation leaves the active generation
and healthy pointer unchanged, the next open consumes the staged version, cold
remote-only startup waits, background failure preserves the ready cache,
cancellation drains cold I/O, and a bundled app remains presentable during a
blocked check. One case promotes the old healthy version after staging and then
reopens to catch store pruning that could delete the new candidate. A separate
bundled-floor case confirms a first signed package at exactly the embedded build
can be consumed on the following open.

### Cache-first validation (2026-11-09)

Flutter 3.35.7 / Dart 3.9.2 ran the complete signed Session suite: **44 passed,
0 failed, 0 skipped**, including real QJBC execution and native pointer-driven
frame changes with `POCKET_ON_DEMAND_FIXTURE_DIR` and `POCKET_NATIVE_LIBRARY`.
The store suite passed **18 tests**. The staged-candidate/old-health-promotion
case first failed with the legacy prune rule, then passed after preserving the
verified unpointed stages. Host and upgrade regressions passed **17 tests**;
System kernel and Showcase capability contracts passed **18 tests**. The native
JS loading/pointer acceptance and plain-surface compiler regression passed
**2 tests**. Targeted Session/host analysis and the SDK architecture boundary
check also passed.

Session/host tests used `/tmp/pocket-cache-first-verify` to avoid another
in-progress Flutter loading-builder change in the shared workspace. That
verification directory copied the current Session/tests, used the existing
native packages, and retained the baseline unrelated `pocket_app.dart`; no
cache, package admission, JS execution or assertions were replaced.

All **4 current FFI scenarios passed with no skips**, verified in separate
runs: the first three passed together against the regenerated fixture; the
remote-cache background-failure case then passed individually after explicitly
configuring `downloadOnOpen: true`. Its original bundled configuration correctly
had no signed `active` package pointer and was not evidence of a cache failure.
The other cases cover unchanged signed build without remount and the retained
strict root update/remount path.

The refreshed `mini_app_update_ffi_test.dart` compiles the actual SystemUI and
child QJBC through pinned `buildGuest`, serves signed v1/v2 packages over loopback,
and runs them in `PocketSystemHost` with the existing native library. The cache-first
case holds the remote v2 manifest while v1 is already presented, verifies that
background completion leaves active version/generation unchanged, invokes the
real JS `platform.apps.return`, then reopens the staged v2. Native controller
pointer input changes actual DrawOps in both versions. The root remains a live
compositor, so its native `foreground` flag is not treated as child-page
visibility. Actual child presentation, package identity and rendered frames are
used instead. This is native QuickJS/controller execution, not OS gesture
injection or a physical-device run.

### Historical strict-gate native fixture (2026-11-06)

The following native fixture result records the earlier strict check-before-entry
behavior. It is historical evidence; the cache-first FFI regression above now
verifies immediate local presentation and next-open staged activation. The fixture runs compiled QJBC with `PocketSystemHost`, a loopback
signed-package server and the existing native library. The three historical
strict-gate cases passed without skips:

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
