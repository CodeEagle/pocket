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

## Validation

`sdk/editor/test/editor_versions.test.ts` exercises a signed owner project and
a second project that reuses its child, checks that an unopted collision still
fails, checks a missing owner fails, verifies the reused descriptor retains
the original immutable release and trust data, and compares the owner's
journal, state, manifest, and bootstrap bytes before and after publication.

The real device install remains a separate integration step after this local
Editor publication path passes.
