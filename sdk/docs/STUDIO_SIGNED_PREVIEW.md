# Studio signed preview (option a)

Pocket Studio previews a project in a **child guest** that runs the project's
freshly built bytecode through the **existing signed update path**. There is no
unsigned loading path, no second downloader, verifier or package store, and no
change to trust policy, anti-downgrade or signature checks. This record covers
the SDK/service pieces and the Linux end-to-end proof. The Studio host app
itself (M1) does not exist yet.

## Flow

```text
Studio guest (JS)            editor service (Bun)               Studio host + preview child
-----------------            --------------------               ---------------------------
save file  ───────────────▶  PUT  /api/projects/:id/files/...
build      ───────────────▶  POST /api/projects/:id/build  (pinned buildGuest)
poll status ◀───────────────  GET  .../status  (builtRevision == revision)
preview-publish ──────────▶  POST .../preview-publish
                               packageArtifacts(appId = fixed preview id)
                               sign with the preview key (never leaves the service)
                               swap into  .preview/pocket/<host>/<previewId>/preview/
            ◀──────────────  { build, version, manifestUrl, payloadSha256, ... }
reload ─────────────────────────────────────────────────▶  system.runtime.destroy(old child)
                                                           system.runtime.create(prepareForOpen: true)   // no cacheFirst
                              GET /preview/pocket/.../latest.json  ◀── PocketUpdateCoordinator.prepare
                              GET /preview/pocket/.../blobs/<sha>  ◀── only changed blobs
                                                           verify signature + hashes + ABI + build floor
                                                           mount, first frame, guest runs the new bytecode
```

## Decisions

### App id binding

A signed payload carries `appId`, and `PocketManifestVerifier` rejects a payload
whose `appId` differs from the child's `PocketAppConfig.appId`
(`pocket_package.dart`, `manifest appId ... does not match`). The preview child
therefore has ONE fixed id, `dev.pocket.studio.preview`
(`PREVIEW_APP_ID` in `editor/preview_publish.ts`), known to the trusted host
catalog at startup, so `PocketSystemHost`'s fixed catalog and compositor handle
registry are unchanged. The service packages the build with
`packageArtifacts({ appId: PREVIEW_APP_ID, ... })`. The project's own `appId` in
`pocket.json` and in source is never touched; it is not part of the bytecode or
PAK. The least invasive mechanism is just that one option.

### Preview key at service startup (M3)

`startEditor` now calls `previewTrust` before serving, so `keys/editor-preview-key.json` exists as soon as the
service is up (idempotent; an existing key is never rotated; the private key never leaves the service). A trusted
host can therefore configure the preview child (`downloadOnOpen`, `updates`, public key) at its own startup instead
of waiting for the first `preview-publish`. Test: `editor/test/editor_preview_publish.test.ts` ("the preview signing
key exists right after startup"). Studio use: `studio/docs/ARCHITECTURE.md`, "Preview child and the catalog".

### Slot, key and build numbers

- **Slot.** Preview packages live in their own `preview` slot under
  `<workspace>/updates/.preview/pocket/<hostVersion>/<previewId>/preview/`. They
  are never written to the `test`/`stable` directories, `.history`, the version
  journal (`<project>.versions.json`), `state.publish`, the test build counter,
  or the package-slot ownership checks. Because the preview id is fixed, the slot
  is per `(hostVersion, previewId)` and shared by whichever project was
  published last (Studio previews one project at a time).
- **Hosting.** `readPublishedResponse` serves `/preview/pocket/<host>/<id>/preview/<artifact>`
  next to `/test/...` and `/stable/...`, on the loopback editor and on the LAN
  version backend (`update_endpoint.ts` accepts the `preview` prefix). Only the
  public artifact set (`latest.json`, `signed-manifest.json`, `payload.json`,
  `host.json`, `blobs/`, `bootstrap/`) is reachable; nothing else.
- **Key.** A dedicated Ed25519 key `keys/editor-preview-key.json`, generated like
  the editor dev key (`generateDevKey`, key id `editor-preview`). The private key
  never leaves the service. The host gets the public key from the slot's
  `host.json` (`POCKET_UPDATE_KEY_ID`, `POCKET_UPDATE_PUBLIC_KEY`). A dedicated
  key keeps the preview trust anchor separate from the test/stable signing key:
  a host that trusts only the preview key cannot be fed test/stable packages and
  vice versa.
- **Build numbers.** `build = max(config.build, bootstrap metadata build, last
  preview build for (hostVersion, previewId)) + 1`, persisted atomically in
  `states/preview-slots.json`, so numbers strictly increase across publishes,
  server restarts and projects. Version string: `<config.version>-preview.<build>`.
  Deleting the workspace state resets the counter; clear the host's preview
  package store in that case.
- **No bundle.** Previews are published with `includeBundle: false`: a save
  republishes every time, the granular update downloads only changed blobs, and
  the host needs no native archive extractor. (A first download is granular too.)
- **Old blobs.** The previous publish's content-addressed files stay readable
  until the next publish, so a host mid-download is not broken by the pointer
  move; older blobs are pruned.

### Route contract

`POST /api/projects/:id/preview-publish` (body ignored, `{}`)

- Same guards as the other mutating routes: write credential (`x-pocket-csrf`,
  403 without it), `projectWrites` admission, Codex/WeChat/deploy busy checks, and
  `409 build is still running` while a build runs.
- `409` unless the current source has a successful build
  (`builtRevision === revision`). A failed or stale build never publishes.
- Response `200`:

```json
{
  "buildId": "<projectId>@<revision>",
  "revision": 7,
  "generation": "<build generation uuid>",
  "version": "0.1.0-preview.4",
  "build": 4,
  "packageId": "dev.pocket.studio.preview",
  "manifestUrl": "http://127.0.0.1:PORT/preview/pocket/<host>/dev.pocket.studio.preview/preview/latest.json",
  "hostConfigUrl": "http://127.0.0.1:PORT/preview/pocket/<host>/dev.pocket.studio.preview/preview/host.json",
  "payloadSha256": "<hex>",
  "runtimeAbi": "quickjs-bytecode-v1:...",
  "keyId": "editor-preview",
  "timingsMs": { "package": 1.9, "sign": 0.15, "total": 5.4 }
}
```

URLs use the request origin; there are no absolute filesystem paths. `host.json`
(`kind: pocket-studio-preview-host`) carries the update URL, key id, public key,
store namespace, version, build and runtime ABI; `bootstrap/app.bytecode.json`
and `bootstrap/guest-manifest.json` are the small public bootstrap files the
host passes as `bootstrapMetadataJson` / `bootstrapManifestJson`.

### Reload mechanism (existing APIs only)

The Studio SystemUI (trusted parent) closes the child and creates it again with
strict check-before-entry:

1. `system.runtime.destroy({ instanceId })`
2. `system.runtime.create({ appId: previewId, prepareForOpen: true })` with
   **no `cacheFirst`**. `PocketSession.initialize(prepareForOpen: true)` then
   runs the signed `PocketUpdateCoordinator.prepare` before the guest can run.

Why not the alternatives:

- `platform.openApp` / the kernel's `openApp` always sends `cacheFirst: true`
  (`system.ts` `createRuntime`), which would run the cached older preview and
  stage the new one for the next open. The Studio therefore calls the two
  `system.runtime.*` host requests directly; no SDK change was needed. (A
  `strict` option on the JS kernel's `openApp` would be a small JS-side
  convenience for M3, not a Dart change.)
- `system.runtime.prepareOpen` without `cacheFirst` also checks strictly and
  keeps the previous child running if the check fails, but it requires a hidden
  runtime, so a presented preview would have to be hidden first.
- Guest-controlled refresh (`createPocketUpdateClient`) needs the preview guest
  to import update code and declare `updates.*`. The project's source should not
  have to.

Failure behaviour: if the signed check fails (forged signature, corrupted blob,
replayed older build, network) `system.runtime.create` fails with a clean error
and no child is left; the Studio guest reports it and can retry. The last
verified package stays in the package store.

Health caveat: a package is promoted to healthy (and therefore raises the
anti-downgrade floor) only after a foreground first frame plus a one-second live
window (`PocketSession.onReady`). A preview that is replaced before that window
is rolled back to the previous healthy package on the next start, so replay
protection only covers builds below the last healthy one. That is acceptable for
a developer loop whose trust anchor is the service's key.

### Capability isolation

- The child is created from its own `PocketAppConfig` in
  `PocketSystemHost.applications`; `PocketSystemHost` does not copy the parent's
  plugins, grants or compositor access to children (SYSTEM_COMPOSITOR_IMPLEMENTATION.md).
- A guest request is admitted only if the signed guest manifest declares the
  capability **and** the host registered a provider for that child. The preview's
  manifest comes from the project's `manifest.json`, so a project cannot widen what
  the host granted, and the host can grant less than the manifest declares.
- Verified by the FFI test: the parent calls `studio.secret` successfully; the
  child, whose host config even registers `studio.secret` but whose signed
  manifest does not declare it, is refused, as are `clipboard.readText` (granted to
  the parent only) and an unknown `studio.fake`; the secret never reaches the child.

## Source reuse (source-first note)

The retained parent `pocketjs_flutter_demo` is not available in this
environment, so nothing was inspected there. All code reuses the current SDK:
`scripts/package_update.ts` (`packageArtifacts`, `verifySignedManifest`,
`generateDevKey`, `pocketReleaseDirectory`; one optional `onSignTiming` hook was
added), `editor/server.ts` (build gate, `readResourceSnapshot` /
`resourceArtifactDirectory`, write guard, `readPublishedResponse`),
`editor/update_endpoint.ts`, `PocketUpdateCoordinator`, `PocketPackageStore`,
`PocketSession` (`prepareForOpen`), `PocketSystemHost` (`system.runtime.create` /
`destroy`, trusted catalog) and the patterns of `mini_app_update_ffi_test.dart`,
`session_download_on_open_test.dart` and `system_ui_update_ffi_test.dart`. New code:
`editor/preview_publish.ts` (slot packaging/serving, about 270 lines), the route,
and the tests/harness below. No Dart production code changed.

## Validation

```sh
cd sdk
# service: 8 tests, real compiler and signing
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun test editor/test/editor_preview_publish.test.ts

# end to end on the real native runtime (Linux x86_64)
export PATH=/opt/flutter/bin:$PATH
POCKET_NATIVE_LIBRARY=$PWD/native/target/release/libpocket_flutter.so \
  flutter test --no-pub test/studio_preview_ffi_test.dart
```

`test/studio_preview_ffi_test.dart` starts a real editor service
(`scripts/tests/studio_preview_service.ts`), creates a project, builds and
preview-publishes v1, runs it in a `PocketSystemHost` with a Studio stand-in
SystemUI and the fixed preview child (`downloadOnOpen`, update URL = the preview
slot, key from `host.json`), then: edits and publishes v2 and reloads (v2 runs, v1
digest differs); replays the genuine older signed manifest (rejected: "Refusing
downgrade or replay"); forges a signature (rejected: `manifest-signature`);
corrupts blobs (rejected: `download-hash`); recovers and runs v3; then runs a
probe build that tries `studio.secret`, `clipboard.readText` and `studio.fake`
(all denied). Tampering and replay go through a loopback front in the test; the
service and signing are real. It skips explicitly without `POCKET_NATIVE_LIBRARY`
or `bun`; a skip is not evidence.

What the Linux run does not cover: the child is **hidden** (not composited), and
the test foregrounds its session to stand in for presentation (needed for health
promotion and for the child to receive host responses, which are delivered per
frame).

### Measured on Linux (x86_64 container, release `libpocket_flutter.so`, counter-sized project)

| Step | Wall clock |
| --- | --- |
| Service `preview-publish` (HTTP round trip) | 7 to 14 ms (service-reported: package about 2 to 3 ms, sign 0.15 to 0.2 ms, total 4 to 10 ms) |
| Build (pinned `buildGuest`, not part of preview) | about 1.2 s |
| Cold open of v1 (create, full granular download, verify, native load, first frame) | about 2.2 s |
| Reload to v2 (pointer to child first frame) | about 1.3 s: 150 ms close + check start, 360 ms fetch (manifest + 1 changed blob), 770 ms verify/store/native load, 70 ms to first frame observed |

The reload breakdown is an upper bound: the test advances Flutter fake time in
16 ms pump steps, so each await adds some harness latency. The debug native
library gave the same order (about 1.3 s). The service cost is negligible; the
time is in the client-side check, store and native load. Save to first frame is
therefore about build (1.2 s) + reload (1.3 s) on this machine, over the 1.5 s
Spike C target; a published profile-mode figure on Apple Silicon is still needed.

## Still to measure in Spike C (macOS, Apple Silicon, `--profile`)

- On-screen compositing of the preview child in `CompositorSurface` (presented,
  focused, resized), and that the presented child reaches healthy on its own.
- Save-to-first-frame latency on a profile build with the real Studio, including
  the native archive plugin if bundles are ever re-enabled for previews.
- Whether the 1.3 s reload needs trimming (for example skipping `destroy` by
  using strict `prepareOpen` on a hidden resident child, or keeping the store
  warm), and behaviour with large resource packs and child catalogs (the preview
  is a single root package; child mini-apps of the project are not published).
