# Reusing an external published package

## Source-first review

The retained parent sources outside `pocket_host/` were checked before this
change:

- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` describes and
  executes the parent's hot-updatable JavaScript bundle. It contains no Editor
  package ownership or cross-project publish flow.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_ota.js` exposes module
  activation and rollback state (`applyHotUpdate` / `rollbackModule`); it does
  not resolve signed application packages from another project.
- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`'s
  `yooTriggerDeltaHotUpdate` action changes the demo module version and stage
  labels. That behavior is retained as a legacy demo scenario, not used as
  evidence of signed package delivery.
- The retained parent has no Editor publish-target selector. This change
  adapts the SDK Editor's existing `selectProject`, `buildProject`, and
  `publishProject` client flow; it does not reuse the excluded `pocket_host`
  implementation.

The SDK keeps the pinned `buildGuest` compile and local Preview path for every
System catalog package. The new Editor option changes only publication
membership: `editor.json` may name catalog children in
`reusePublishedPackages`. Their app IDs and runtime manifests stay unchanged.

## Publish behavior

For each opted-in child, Editor resolves one immutable history owner with the
same host version and channel. It verifies the owner's root release and trust
key, checks the child manifest signature and signed files, and checks the
retained bootstrap metadata. The child's signing key must match the current
Editor signing key; the runtime trust contract is unchanged.

The new root aggregate keeps the child's owner release ID and immutable URL
paths, rebased to the current serving origin, plus its signing key, namespace,
branch namespace, and bootstrap hashes. Mutable root host aliases
preserve that child pin. The root release journal lists only packages it
publishes, so the existing owner's package index, state, signed artifacts, and
history remain authoritative. An unlisted package collision still returns
409. Missing, ambiguous, corrupt, wrong-host, wrong-channel, or differently
signed reuse targets fail closed. Offline archives reject external reuse
because they cannot claim to be self-contained.

The Showcase opts into reuse for `pocket.demo.lantern` in
`demo/js/editor.json`; `demo/js/pocket.system.json` and its runtime contract
remain unchanged. The original Lantern URL and installed app ID are preserved.

When a missing editable child source is recovered from that validated parent
catalog, the Editor keeps its existing internal project ID for build and
publish state, but exposes `parentProjectId`, `sourceProjectTitle`, and the
catalog-relative `sourcePath`. Nested catalog children appear under their
parent in the project switcher, and the editor heading keeps the
`Demo › MiniApp` breadcrumb while that child source is open. This records the
source relationship without moving/copying the child directory or changing
the immutable release owner. Catalog sources outside the parent directory
remain eligible for recovery and are not mislabeled as nested children.

## Choosing what to publish

The Editor's single publish area now lists the current root project and each
explicitly reused MiniApp target. Selecting a reused target navigates to its
unique project owner; the existing build and publish actions then operate on
that owner's project and journal. Ordinary packages built inside the root
project continue to publish with the root. The target list resolves owners by
host and channel, and disables navigation when the current owner is ambiguous
or no unique editable source exists for a first release. An owner that needs a
build remains selectable so it can be rebuilt.
When a channel has no release yet, a single editable project with the reused
app ID is offered as its first-publish owner; multiple source projects remain
disabled until the owner is resolved. If a prior owner directory is missing,
Editor registers its source only when the configured root's validated catalog
declares that package. Restoring that source marks any prior build stale once,
so the old journal remains visible while the registered source must be built
before publishing.

`GET /api/projects/:id/publish-targets?channel=test|release` supplies the
target list and separates `canSelect` from `canPublish`. The root version
snapshot records reused package ID, version, build, owner project, and owner
release ID for each root release; the root `packages` list continues to mean
packages signed by that root project. This keeps the root panel's pinned
version visible even after the owner publishes a newer package.
Publishing the root again after an owner update refreshes that immutable pin.
For a stable root release, increment the root build before republishing so its
new aggregate pin has a new immutable release identity.

## Validation

`sdk/editor/test/editor_versions.test.ts` exercises a signed owner project and
a second project that reuses its child, checks that an unopted collision still
fails, checks a missing owner fails, verifies the reused descriptor retains
the original immutable release and trust data, and compares the owner's
journal, state, manifest, and bootstrap bytes before and after publication.
It also verifies target selection follows the channel-specific owner, an owner
with a stale build is selectable but not publishable, a rebuilt owner publishes
new signed bytecode, root history keeps its older immutable reuse pin, and
missing/ambiguous owners plus a failed owner publish do not partially update
the published journal or fixed package index.

The real device install remains a separate integration step after this local
Editor publication path passes.
