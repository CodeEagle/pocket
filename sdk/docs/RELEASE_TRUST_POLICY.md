# Pocket release trust policy

Pocket keeps the existing signed package envelope and healthy-first activation
flow. Release trust is an optional, host-owned admission layer for apps that
need key rotation or emergency revocation.

## Source-first decision

The retained parent demo was inspected before implementation:

- `pocketjs_flutter_demo/docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md`
  describes content-addressed chunks, integrity checks and atomic activation.
  The current SDK package store supplies the signed-manifest and healthy-first
  contract that this remediation preserves.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_ota.js` and
  `tests/verify_architecture.py` describe a JS-only version gate and rollback
  snapshot for system libraries.

Those sources are useful regression evidence, but they do not contain a
host-owned release certificate chain or a persistent revocation store. The
version manager is an in-memory JS demonstration and therefore cannot safely
authorize a release key or survive a restart. Pocket adapts the retained
package-store activation points instead of adding a second JS/Dart update
state machine.

The NSH comparison source (`/tmp/pocket-nsh-reference-20261104/crates/nsh-package`)
provided the narrow ideas worth retaining: root-signed release certificates,
app/time scope, signed revocations, and a persistent monotonic trust state. It
is not format-compatible with Pocket and no NSH serialization is required.

## Policy format

The root signs the exact UTF-8 bytes in a small JSON payload. The envelope is:

```json
{"keyId":"host-root-1","payload":"<base64 policy bytes>","signature":"<base64 Ed25519 signature>"}
```

The payload has `schemaVersion: 1`, a monotonic `epoch`, and a `releaseKeys`
array. Each release key contains `keyId`, raw Ed25519 `publicKeyBase64`, an
`appScope` list (`app.id`, `prefix.*`, or `*`), and Unix-second `notBefore` /
`notAfter` bounds. Optional policy-level `appId`, `notBefore`, and `notAfter`
further restrict the policy. `revokedKeys` and `revokedPackages` are cumulative
sets; package identities may be the exact payload SHA-256 or the manifest
content hash.

`PocketSignedTrustPolicy` verifies the root over the received `payloadBytes`.
It never serializes the parsed map and never accepts a release key supplied by
the guest package. In trust-policy mode a package also needs a signed `signedAt`
Unix timestamp; legacy packages without this field remain valid only in the
legacy public-key mode.

At package admission the host clock must be inside the selected release key's
validity interval, and `signedAt` must be non-future and inside that same
interval. A cached package cannot keep using an expired release key merely by
reporting an earlier `signedAt`; the policy must continue to certify a current
key (or the app must explicitly remain in legacy mode). This keeps the package
timestamp as a signed release fact, rather than treating a guest-provided time
as a trusted current-time source.

## Host configuration and persistence

`PocketUpdateConfig` accepts the existing `url`/`keyId`/`publicKey` fields, or
the new host-owned fields:

- `trustRootKeyId`
- `trustRootPublicKey` (base64 raw 32-byte Ed25519 key)
- `trustPolicyUrl`

The three new fields plus the update URL explicitly enable trust-policy mode.
The coordinator then passes an app-scoped `PocketTrustStore` to the existing
`PocketManifestVerifier`; `trustedKeys` is ignored in this mode, so an old
configured release key cannot bypass rotation. Missing, malformed, expired or
unsigned policy state fails closed. `trustPolicyUrl` is host configuration and
uses the same HTTPS/loopback/debug transport boundary as the manifest; it may
be a separate HTTPS origin, while package blobs remain restricted to the
manifest origin.

The store writes an atomic `trust-policy.json` beside the package store. It
persists the latest root-signed policy envelope, its epoch and exact payload
hash, and the union of all revocations observed. A lower epoch is rejected; a
different payload at the same epoch is rejected; a higher epoch replaces the
active keyring while retaining revocations. On restart every package load,
fallback and rollback re-verifies this state and applies the current keyring
and revocations. Acceptance of policies sharing one state path is serialized
inside the service, so concurrent store instances cannot write a lower epoch
after a higher one has been accepted.

Final package admission now shares the policy-install lock. `commitHealthy`,
`rollback`, `fallbackFor`, and the low-level `activate` verify current trust and
write activation pointers under that lock, after cached file/hash validation.
The fixed lock order is package store then policy; policy installation never
acquires a package-store lock. `verify()` does not take a nested lock. Admission
callbacks must not install policy or acquire another package-store lock.

`PocketPackageStore.activate` now requires a `PocketManifestVerifier`; direct
consumers must pass it explicitly. Coordinator `activate` / `commitHealthy`
call signatures and the normal healthy-first flow are unchanged. Hosts can use
`withVerifiedPrepared` to validate cached bytes and publish a candidate under
current policy without marking it healthy. The prepared `source` and
`readArtifact` accessors expose cached data, not an ongoing trust grant; custom
low-level hosts must use that final boundary when publishing a runnable guest. Session checks before native bridge
setup, and checks again after its asynchronous work before publishing an initial,
updated, rollback, recording-restart or restored guest. Revocation after an
already completed admission does not terminate an already running guest.

The final shared boundary prevents a policy installation from completing
between final verification and pointer publication. A policy that wins before
this boundary causes rejection; one queued behind an admission completes only
after it. No epoch/CAS shadow cache or second update state machine is added.

Installing a policy does **not** advance `minimumBuild` or the package
rollback floor. The floor still advances only when the existing
`commitHealthy` path confirms a healthy package. This leaves a previously
healthy package available for fault recovery while still refusing a package
that the new policy explicitly revokes.

For a normal rotation, keep both release keys certified and valid until a
package signed with the replacement key has become healthy. Removing, expiring
or revoking the old key also rejects cached fallback packages signed by it;
emergency revocation deliberately takes precedence over fallback availability.
The epoch/revocation file assumes app-private storage. The in-service lock does
not coordinate separate Dart isolates or processes, and does not protect against
an attacker restoring a complete older snapshot of that private storage.

## Publishing and tests

`sdk/scripts/package_update.ts` emits `signedAt` for new packages and exposes
`signTrustPolicy`, `signTrustPolicyPayload`, `verifySignedTrustPolicy`, and
`writeTrustPolicy` for root-policy tooling. Tests generate Ed25519 pairs in
memory or in a temporary directory and only use public key bytes for
verification; no user private key is read as test output.

Focused Dart test command (run by the parent agent in its serial Flutter/Dart
validation pass):

```sh
cd sdk/packages/pocket_services
dart test test/pocket_trust_test.dart test/pocket_trust_admission_test.dart
```

The admission regression covers valid control, key/package revocation during
commit, revoked rollback/fallback targets, expired/revoked prepared use, and
low-level activation. `sdk/test/session_upgrade_test.dart` additionally installs
a revocation while a real Session waits for plugin activation; the rejected
cache is never published and the embedded guest remains available. The existing
package/update tests remain the compatibility and healthy-fallback coverage. TypeScript package tooling can be checked independently with:

```sh
cd sdk
bun test scripts/tests/package_update.test.ts
```
