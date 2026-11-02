# Pocket Studio editor reuse

`editor/` is the local scaffold service for `pocket_host`. It keeps the useful
PocketJS Kit editor workflow (project list, local project creation, source and
configuration editing, build diagnostics, preview artifacts and signed
publishing) while removing the Kit server's dependency on the old checkout.

## Provenance and deliberate ablation

The source protocol was reviewed in the old implementation:

- `PocketEditor/src/server/editor_server.ts` — Bun server routes, workspace
  layout, local project lifecycle and build/package actions.
- `PocketEditor/src/server/build_queue.ts` — build diagnostics and revision
  queue behavior.
- `PocketEditor/src/client/index.html`, `editor.css`, `editor.js` and
  `page_graph.js` — the original management UI and its API contract.

The old server invokes `scripts/pocket.ts`, `packages/pocket_sdk`, page
templates, WASM preview assets and a separate generated page model. Those
paths are not present in this host's pinned cache and would make the editor
depend on `/Volumes/ORICO/.../PocketJSKit`. The current editor therefore keeps
one source of truth—the guest `app.tsx` plus `pocket.json`/`manifest.json`—and
removes the redundant page-template/config generator and browser WASM preview.
The served UI still provides a real source editor, build/package controls,
artifact links and diagnostics; the native Flutter host remains the preview
for the generated qjbc + PAK pair.

The scaffold is copied from this repository's `guest/` directory at runtime,
not from the old absolute path. A created project can replace `app.tsx` and
its local `pocket.json`; no source file is silently evaluated as a bytecode
artifact.

## Run

From `pocket_host`:

```sh
bun editor/server.ts
```

For a local preview that must survive the terminal which launched it, use the
temporary per-user launchd job instead:

```sh
scripts/editor_service.sh start
scripts/editor_service.sh status
scripts/editor_service.sh stop
```

The job label contains the SHA-256 prefix of this checkout's absolute path,
so `stop` can remove only this project's service. It is submitted to the
current GUI user session and does not install a persistent plist or LoginItem.
The service log is exposed at `.pocket-build/editor-service.log`; on the
external ORICO volume this path is a generated symlink to a path in `/tmp`
because launchd cannot open a StandardOutPath directly on that volume. The
symlink target is unique to this checkout, and `status` verifies both the
managed job and `/health`.

Open `http://127.0.0.1:8790/` in an existing browser if desired. No browser is
started by the service. For a separate workspace/port:

```sh
POCKET_EDITOR_WORKSPACE=/tmp/pocket-editor-workspace POCKET_EDITOR_PORT=8791 bun editor/server.ts
```

The workspace defaults to the ignored `.pocket-build/editor-workspace/` and
contains `projects/`, immutable revision snapshots under `builds/`, signed
update directories under `updates/`, and a local Ed25519 key under `keys/`.

## API contract

All JSON routes are local-only and use the project id regex
`^[a-z][a-z0-9-]{0,47}$`.

| Route | Behavior |
| --- | --- |
| `GET /api/projects` | List projects and status. |
| `POST /api/projects` | Copy the current guest scaffold. Body: `id`, `name`, optional `appId`, `version`, `build`/`tickHz`; omitted `appId` defaults to the current host's `pocket.host.demo`. |
| `GET/PUT /api/projects/:id/source` | Read/write `app.tsx`; writes increment the revision. |
| `GET /api/projects/:id/files` | List editable guest source files (`.ts/.tsx/.js/.json/.svg/.css/.md`) with byte sizes. |
| `GET/PUT /api/projects/:id/files/:path` | Read/write a source file such as `ui/index.tsx`; traversal, symlink, asset, build and key paths are rejected. |
| `GET/PUT /api/projects/:id/config` | Read/write app id, name, version, build and tick rate; updates `pocket.json`. |
| `GET /api/projects/:id/manifest` | Read the guest manifest copied into the project. |
| `GET/POST /api/projects/:id/assets` | List or upload a safe local asset (the compiler includes it when referenced by guest source). |
| `POST /api/projects/:id/build` | Asynchronously run the pinned compiler and real QuickJS bytecode compiler. |
| `GET /api/projects/:id/status` | Revision, build state, diagnostics and artifact links. |
| `GET /api/projects/:id/artifacts/:name` | Serve `app.qjbc`, metadata, PAK, manifest, build JSON and inspection-only `app.js`. |
| `POST /api/projects/:id/publish` | Sign a quickjs-bytecode payload with the local Ed25519 key and create a tarball. `/package` is an alias. |
| `GET /updates/:id/latest.json` | Signed update envelope; `blobs/<sha256>` are served from the same directory. |
| `GET /updates/:id/host.json` | Ready-to-pass Dart defines containing the manifest URL, key id and raw Ed25519 public key. |
| `GET /releases/:id.tar.gz` | Download the local signed update directory. |

The build command is equivalent to the checked-in guest build path:

1. `scripts/prepare_upstream.py` keeps the pinned compiler available.
2. A missing pinned `node_modules/` is restored with `bun install --frozen-lockfile`.
3. `.cache/pocketjs/tools/build.ts` produces `app.js` and `app.pak`.
4. `native/target/{release,debug}/pocketjs_bytecode` (or `cargo run` when no
   binary exists) serializes the JS with the same QuickJS build as the host,
   producing `app.qjbc` and `app.bytecode.json`.
5. `scripts/package_update.ts` signs the qjbc entry and content-addressed PAK
   parts with `entryFormat: "quickjs-bytecode"` and the embedded `runtimeAbi`.

The service never falls back from qjbc to source at runtime or inside a
published update. `app.js` is retained only as an explicit inspection
artifact, because it is useful when diagnosing compiler errors.

## Applying a published update in the current host

The publish response and the UI expose both `latest.json` and `host.json`.
The latter is the exact configuration consumed by
`packages/pocket_sdk/lib/src/pocket_session.dart:initialize`, which passes the URL and key into
`packages/pocket_services/lib/src/pocket_update.dart`'s
`PocketUpdateCoordinator`. Signature/payload parsing and ABI checks are in
`packages/pocket_services/lib/src/pocket_package.dart`.

```sh
flutter run -d macos --dart-define-from-file=http://127.0.0.1:8790/updates/<id>/host.json
```

Flutter's `--dart-define-from-file` accepts a local file, not an HTTP URL, so
download the small JSON first (or copy its three keys into a local file):

```sh
curl -fsS http://127.0.0.1:8790/updates/<id>/host.json > /tmp/pocket-editor-host.json
flutter run -d macos --dart-define-from-file=/tmp/pocket-editor-host.json
```

For the current `PocketSession`, the signed payload's `appId` must be exactly
`pocket.host.demo` (the fresh-project form defaults to that value), and its
`runtimeAbi` must match `assets/app.bytecode.json`. The host downloads the
manifest and relative `blobs/<sha256>` files directly; it does not consume the
editor's `.tar.gz` archive. The archive is only a convenient offline/export
artifact.

If the guest source contains a compiler error, the build remains failed and
the exact compiler output stays in `/api/projects/:id/status`; it is never
reported as a usable package. The latest responsive Duo guest source now
builds successfully through the same path; a future compiler diagnostic is
still an error, not an editor fallback condition.

## Verification

The service test uses an injected build runner only to exercise HTTP/state and
signed-package plumbing without rebuilding Rust for every unit test:

```sh
bun test editor/test/editor_server.test.ts
```

The reusable production probe performs the full current-showcase build and
publishes an update without touching `host/assets/` or `guest/`; it leaves the
temporary workspace and prints its artifact paths for inspection:

```sh
bun editor/test/editor_live_probe.ts
```

The probe also writes invalid source after a successful build and verifies
that the old build remains the only built revision, publishing is rejected,
and the previously signed `latest.json` is unchanged.

An earlier 2026-11-02 reusable production probe completed with the real
showcase scaffold (not the injected unit-test runner): `runtimeAbi` was
`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`,
the qjbc was 221,572 bytes, and the PAK was 332,816 bytes. The retained probe
workspace is `/Volumes/ORICO/mac-caches/tmp/pocket-editor-live-tnOQmQ`; its
`builds/live-probe-mvytcn26/1/` contains the qjbc, metadata, PAK, guest
manifest, and build record, while `updates/live-probe-mvytcn26/` contains the
signed envelope, content-addressed blobs, and `host.json`. The invalid-source
second revision was rejected without replacing the signed release. This is a
historical probe baseline; the frozen showcase verification is recorded
below.

The editor service is a foreground local process. Keep the command in a
persistent terminal (or a managed PTY) while a Flutter preview is using its
loopback URL. In managed terminal sessions, a background or `nohup` child can
be reaped when the launching session closes; a stale `host.json` then remains
valid while `curl` and the app's update check correctly fail to connect. If
the check fails, inspect the listener and `/health` first, then verify the
signed manifest; do not regenerate a release merely because the service was
stopped. The health endpoint and multi-file API were exercised: `GET
/api/projects/showcase/files` returned the frozen source files, synchronized
through the same safe `PUT /files/:path` API without changing `guest/`.

The final frozen showcase is revision 17 (the last guest change is the
HomeExplore button color/centering update, synchronized as `app.tsx` only).
The real editor build produced a 233,227-byte QuickJS Script bytecode entry
and a 333,536-byte PAK with runtime ABI
`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`.
It was published with key id `editor-showcase` at
`http://127.0.0.1:8790/updates/showcase/latest.json`; the ready host
configuration is at
`http://127.0.0.1:8790/updates/showcase/host.json`.

The final release was independently checked with the local Ed25519 public
key: the 64-byte signature verified, the qjbc and PAK entry hashes and sizes
matched the signed payload, all 20 content-addressed PAK blobs matched, and
reconstructing those blobs reproduced the complete PAK byte-for-byte. The
bytecode metadata's `runtimeAbi` and `bytecodeBytes` also matched the signed
payload and downloaded entry. The editor archive is available for offline
export, but the current host consumes the signed manifest and blob URLs, not
the tarball.

The production runner is covered separately by invoking `POST /build` with a
real workspace; a successful status must contain `entryFormat=quickjs-bytecode`
and a non-empty `runtimeAbi`, and `/publish` must expose the same ABI in the
decoded signed payload. The pinned native compiler can be prebuilt with:

```sh
cargo build --locked --manifest-path native/Cargo.toml --bin pocketjs_bytecode
```

