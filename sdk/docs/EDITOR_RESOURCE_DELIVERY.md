# Editor package resources

## Source reuse and delivery model

Source-first inspection covered the retained parent's
`lib/core/pocketjs_bundle_runner.dart` (bundle extraction and extracted resource
resolution) and `mini_apps/syslib/pocket_syslib_ota.js`, excluding `pocket_host/`.
Its `LAZY_STREAMING` display is not a verified downloader. This implementation
instead reuses the SDK's validated System catalog, pinned `buildGuest`,
`packageArtifacts`, signed content-addressed files, `PocketUpdateCoordinator`
and complete PAK admission. No alternative resource loader or renderer is added.

Editor lists the main package and every package declared by
`pocket.system.json`. A build produces a single revision snapshot of their
bytecode, PAK, metadata, guest declaration, ordinary assets and delivery policy.
Publication consumes that snapshot, so editing an original asset afterwards
cannot change the bytes of an already-built release.

Eligible static image entries and ordinary signed assets can be assigned to:

- **Base package**: included in the initial archive.
- **Network**: hosted as individually hashed blobs outside the initial archive.

Styles, font/glyph data and other required compiler records are locked. Moving
ordinary media to the base package changes archive membership; it does not
convert an MP4 into a native PAK texture. Identical content is stored once;
content also needed by a required/base resource remains in the archive.

The canonical runtime PAK is preserved. Removing native image entries from it
would break texture registration. On first mini-app open, the existing package
coordinator verifies the base archive, fetches remaining signed blobs, assembles
the exact canonical PAK and verifies its full hash before admitting any code.
This is package-open delivery, not per-image first-paint streaming. Healthy
offline reopen and incremental resource reuse retain their existing behavior.

## Configuration and workflow

`pocket.resources.json` is the single project-owned delivery policy. Keys identify
the package and either a compiled PAK record or an ordinary asset:

```json
{
  "version": 1,
  "packages": {
    "example.profile": {
      "network": ["pak:ui:img.assets/avatar.png", "asset:assets/intro.mp4"]
    }
  }
}
```

Build once to discover actual resources. In Editor's resources panel, select a
package, choose placements, save, then rebuild and publish the new revision.
Saving rejects stale revisions, unknown packages/resources and changes to
required records. A project without a policy preserves full-archive behavior.
Source manifests and asset paths remain subject to Editor's path and symlink
boundaries.

After upgrading an already-running Editor, restart its backend as well as
reloading the page. Older build snapshots without `resources.json` still expose
the actual System catalog (including the System UI); rebuild to generate their
resource details. Missing snapshot compatibility does not bypass validation of
an existing snapshot or permit saving unknown resource placements.

The resource browser uses a scrollable package sidebar and a resource card grid.
`ui:font.*` records are compiled glyph atlases for font slots (different sizes
and weights), not separate font families. They remain required resources.
Image cards use project-owned source images captured in the immutable build
snapshot; loose images reuse the already-copied asset instead of duplicating it.
Required resources use compact cards and a fixed placement badge rather than a
large placeholder and a disabled delivery selector. Editable delivery selectors
reserve space for the dropdown arrow and align consistently within image cards.
Unsupported resource types have an explicit type placeholder. Thumbnail routes
accept only catalogued resource keys in the current build, enforce snapshot
path/symlink boundaries and image types, and serve SVG with a restrictive CSP.
This reuses the existing snapshot/asset-copy boundary and pinned compiler image
keys; no runtime PAK decoder or renderer is added for Editor thumbnails.

Each published mini-app has its own signed manifest and a public `host.json`
setup template (`kind: "pocket-mini-app-host-template"`). It is not a
`--dart-define-from-file` file. Its `bootstrapAssets` map identifies the small
metadata/guest declarations to copy into the consumer's local Flutter assets,
with source URL, size and hash. Add those asset directories to `pubspec.yaml`.
Review/install these files as development inputs; the runtime does not download
unsigned bootstrap declarations into `rootBundle`.

Construct the trusted application registration from the template's `config`:

```dart
PocketAppConfig(
  appId: 'example.profile',
  downloadOnOpen: true,
  metadataAsset: 'assets/apps/example.profile/app.bytecode.json',
  manifestAsset: 'assets/apps/example.profile/guest-manifest.json',
  updates: PocketUpdateConfig(
    url: profileUpdateUrl,
    keyId: profileReleaseKeyId,
    publicKey: profileReleasePublicKeyBase64,
    namespace: profileStoreNamespace,
  ),
)
```

See [ON_DEMAND_MINI_APPS.md](ON_DEMAND_MINI_APPS.md) for the full host contract.
The consumer owns this trust mapping; guest code cannot choose a server or
signing key. Editor resource selection does not rewrite consumer Dart files or
automatically change the existing Run deployment's application registrations.

## Signed partial archive contract

`bundle.blobs`, when present, lists the exact SHA-256 hashes expected in a base
archive. Every hash must be unique and declared in the signed payload's `files`.
The archive descriptor/hash, omitted file hashes/sizes and final PAK hash remain
inside the Ed25519-signed payload. A missing declared archive entry is an error;
only files explicitly outside that subset are fetched individually. Hash/path/
origin/size/ABI/cancellation checks and health-based activation remain in force.
Without `bundle.blobs`, existing full-archive and cache behavior is unchanged.

Consumers need the updated SDK to open partial archives. Older consumers fail
closed on missing archive blobs during a cold install; no unauthenticated fallback is provided.
Publish an ordinary full archive for older host versions.

## Validation

Validation covers real archive contents, signed subset rejection, package
discovery and revision checks, immutable root/child snapshots, resource settings
in the browser, and real downloaded QJBC execution with pointer input. The
Session suite also verifies omitted resource hash failure, missing/corrupt base
entries with both cold and warm caches, unexpected archive entries,
duplicate/unknown subset hashes, cancellation and healthy offline reopen.

Validation on 2026-11-05 in the isolated `codex/on-demand-miniapps-20261105`
worktree:

- `bun test sdk/editor/test/resource_delivery.test.ts sdk/editor/test/resources.test.ts sdk/editor/test/resources_ui.test.ts`: 4 passed, 0 failed, 89 assertions. Uses real child compilation and signed publication, plus Playwright Chromium interactions.
- `bun test sdk/editor/test/resources_system.test.ts`: 1 passed. Builds the real Showcase main package, Profile and Lobby (26/20/20 resources), then opens Profile through native pointer input. Set `POCKET_NATIVE_PROBE` to a built `pocket_probe` when using a worktree.
- Existing Editor server/config/scope/build-generation/browser/media/update/concurrency/hot-reload/cache/WeChat regressions: 25 passed, 0 failed across 11 files.
- `bun test sdk/scripts/tests/package_update.test.ts sdk/scripts/tests/build_guest.test.ts sdk/tests/system_manifest.test.ts`: 44 passed, 0 failed, 476 assertions.
- From `sdk`, `flutter test --no-pub --concurrency=1 --reporter expanded`: 102 passed, 0 failed, 0 skipped. Set `POCKET_NATIVE_LIBRARY`, `POCKET_RECORDING_WORKER_FIXTURE_DIR` and `POCKET_ON_DEMAND_FIXTURE_DIR` to the real native library and generated fixtures. The downloaded native guest decodes the remote SVG and responds to pointer input.
- From `sdk`, `flutter test --no-pub --concurrency=1 packages/pocket_services/test/pocket_package_update_test.dart --reporter expanded`: 13 passed, 0 failed.
- Scoped Flutter analysis, `check_architecture.py`, `prepare_upstream.py --verify-only`, client JavaScript syntax and `git diff --check` pass.

Ablation removed duplicate root artifacts, redundant placement state and unused
snapshot helpers. Publication derives membership from the single policy stored
in the build snapshot and reuses the existing downloader and package admission.

Known baseline failure: `preview_routes.test.ts` with the matching debug probe
fails the Mobile UI idle assertion (`52 !== 46`). The heading has settled but
`__pocketWorkState()` still reports `continuous: true`; Transitions and Hardware
become idle normally. Its direct preview implementation, test and demo assets
are unchanged from tracked commit `9e6f0eb`, which was merged before final
validation. This is not counted as a passing regression test; no assertion was
weakened. The exact source of the remaining continuous work is not yet resolved.
