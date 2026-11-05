# Guest-controlled refresh and UI state handoff

`createPocketUpdateClient` in `@pocket/ui/updates` can check, verify and apply an
update to the guest that is currently running in Flutter:

```ts
const updates = createPocketUpdateClient(bridge, { autoRefresh: true });
await updates.refresh(); // optional explicit check + apply
// Dispose with the guest's component/root lifecycle.
onCleanup(() => updates.dispose());
```

Automatic refresh is opt-in. It checks once at installation, after the host
reports package health readiness, and on resume. There is no polling timer or
frame callback. Hosts without update configuration keep running their embedded
package. Repeated events share one refresh operation; a scheduled replacement
remains latched until the old guest is disposed. An unchanged active package is
reverified and returns `scheduled: false` without incrementing its generation.
Concurrent refresh callers share the first request's scope.
Network/signature failures are reported through `onError`; a later resume can
retry. Check and apply remain available separately.
After a runtime failure and rollback, fallback health does not immediately
reactivate the failed release. A later resume or explicit refresh can retry.
Disposal prevents work that has not been sent; a host activation already
scheduled by `updates.apply` continues under the host's lifecycle rules.

## Compatible state restoration

Updates replace the QuickJS realm. Applications opt in to transferring portable
business/UI values through their existing private `platform.storage`:

```ts
const updates = createPocketUpdateClient(bridge, {
  autoRefresh: true,
  state: {
    key: "update.ui",
    schema: "my-ui/1",
    storage: platform.storage,
    capture: () => ({ draft: draft(), documentRevision: documentRevision() }),
    restore: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          typeof value.draft !== "string" ||
          value.documentRevision !== documentRevision()) return false;
      setDraft(value.draft);
      return true;
    },
  },
});
await updates.ready; // whether a compatible snapshot was restored
```

The state schema and exact package version/build must match. `restore` must
synchronously validate business revisions before committing values, returning
`false` on conflict. The SDK also compares the initial UI state with its state
after asynchronous reads, so input made during startup is not overwritten. A
change during snapshot storage cancels that update attempt. A checkpoint storage
failure also prevents activation. Snapshots use bounded plain data: 64 KiB,
depth 16 and 4096 nodes. Functions, cycles, native handles and non-finite numbers
are rejected. Direct-object transport does not call `JSON.parse/stringify`.
Activation checks the prepared version/build against the snapshot target at the
native boundary. A concurrent check that replaces the candidate rejects the
stale apply instead of activating a different package with the wrong snapshot.

The record includes its source package as well as its target. It stays available
until the receiving host reports a healthy package, allowing the source package
to recover its state if activation rolls back before health readiness. A healthy
receiver acknowledges the record. This is update handoff, not a continuous
autosave service or a general database migration system.
The checkpoint represents the state immediately before apply. Apps that allow
edits during the host's final response/remount interval should persist those
edits in their normal store or suspend editing until replacement; arbitrary
post-checkpoint in-memory changes are not continuously mirrored.

Use a dedicated, app-private key with a single writer. Existing platform storage
serializes writes and atomically replaces its backing file, but offers no CAS or
multi-writer transaction. A reread protects cleanup against an already-observed
replacement; external writers racing the final removal require application-level
coordination. Persistent business data stays in its normal store; the restore
callback owns its revision/conflict policy.

The Showcase enables automatic refresh in `demo/js/system.ts` and transfers its
navigation stack, counter, input draft, transition mode, selected component and UI toggles through
`demo/js/update-state.ts`. Appearance continues to load from its existing saved
preferences. Capability requests, camera resources, recordings and child runtime
instances are not replayed. SystemUI generation changes retain the existing
child teardown and stale-request rejection rules; a child app can implement its
own portable-state policy. Component-local scroll positions are not captured by
the Showcase handoff.

## Source reuse and ablation

Before implementation, the retained parent was inspected, excluding
`pocket_host/`:

- `mini_apps/syslib/pocket_syslib_ota.js:135–197` keeps in-memory module/rollback
  metadata, without a durable cross-QJBC state handoff.
- `lib/core/pocketjs_bundle_runner.dart:61–88` retains pages within a running
  C-FFI context, not across package activation.
- `wechat_host/core/wx_pocket_host.js:7–26` has a shared Map and writes storage,
  but does not hydrate it at construction.

The implementation reuses `PocketSession` package admission, final verification,
health window and recovery; `PocketSystemHost` generation cleanup; the pinned
`buildGuest` QJBC pipeline; and existing app-scoped platform storage. All refresh,
capture and conflict policy lives in JS. No reload capability, second Flutter
state machine, new compiler, mirrored runtime tree or development hot-replacement
path was added. Removing the redundant same-package remount is essential for
event-driven automatic checks. `@pocket/ui/dev` remains development-only.

## Validation

The update-client tests exercise event coalescing, lifecycle readiness, same-package
checks, verification failure/retry, disposal, and direct objects with JSON APIs
disabled. A compiled QJBC native-probe regression verifies repeated health/resume
events do not remount the same package and real pointer input changes `Taps:0`
to `Taps:1`. The session signed-package tests verify the real coordinator returns
a verified no-op without changing the active generation.

`system_ui_update_ffi_test.dart` runs a real `PocketSystemHost` with two compiled
QJBC packages, an Ed25519-signed update served over loopback HTTP, native input
and actual private platform storage. Version 1 receives two input events; version
2 restores the same count-two DrawOps digest, then produces a changed frame on
the next input. Its subsequent same-package check leaves the generation and
recording count unchanged. Session tests also reject a stale version/build
precondition using two real signed candidates.

The FFI test requires an explicit fixture and a matching native library; otherwise
it is skipped. To reproduce from `sdk/` on macOS ARM64 with the library built:

```sh
bun scripts/tests/system_update_fixture.ts /tmp/pocket-system-update
POCKET_SYSTEM_UPDATE_FIXTURE_DIR=/tmp/pocket-system-update \
POCKET_NATIVE_LIBRARY="$PWD/native/target/aarch64-apple-darwin/release/libpocket_flutter.dylib" \
flutter test test/system_ui_update_ffi_test.dart
```

The System kernel storage regression disables `JSON.parse/stringify` while
exercising the real JS forwarding path. A shared bounded value snapshot replaces
the former JSON round trip and the update helper's duplicate clone. Escaped
strings, object separators, excessive depth, and omitted fields are included in
the byte/structural work limits.
