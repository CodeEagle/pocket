# Pocket Studio architecture (M1 shell and transport, M2 editing, M3 build and live preview)

Pocket Studio is a Pocket guest app (TSX on `@pocket/ui`, compiled to QuickJS bytecode by the one pinned
`buildGuest` pipeline) running in a thin Flutter macOS host. The Bun editor service in `sdk/editor` stays the
backend. `studio/` is an SDK consumer exactly like `demo/`: the SDK never imports it
(`sdk/scripts/check_architecture.py` enforces that, and also that `studio/` does not import `demo/`).

## Layers

| Layer | Where | Owns | Must not own |
| --- | --- | --- | --- |
| Studio guest | `studio/js/` (`app.tsx`, `src/pages`, `src/components`, `src/state`) | all UI, state, routing, polling, retry, chunk loops, sha256, settings, preview orchestration | any path, key, socket or token |
| Capability client | `studio/js/src/studio-client.ts` | typed wrappers over `host.request` and streams, chunked read/upload helpers, error mapping | business policy |
| Host | `studio/lib/main.dart` (<= 100 lines) | registers plugins, grants permissions, trusted config, memory tier, `rawTextInputEnabled`, preview child catalog | UI, state machines, navigation |
| Provider | `sdk/packages/pocket_studio` | allowlisted capability -> HTTP route map, CSRF injection, path scrubbing, error mapping, SSE -> stream mapping, service lifecycle helper | project/build/transfer state, policy, retries |
| Service | `sdk/editor/server.ts` | everything the web Studio already does; guards unchanged | |

The Dart provider is one more client of the service. It does not weaken a guard: it sends `x-pocket-csrf`
(never the constant `x-pocket-editor`), talks only to `127.0.0.1`, and the service still applies its Host,
peer, path, symlink, size and admission checks to every request.

## Capability contract (FROZEN in M1)

Names, parameter names and result shapes below are frozen. Additions are allowed; renames and removals need an
owner decision. `project` is a project id (`[a-z][a-z0-9-]{0,47}`); `path`, `from`, `to` are project-relative.
All calls are `request` capabilities except the two `stream` rows. Every call needs the listed host permission.

| Capability | Params | Result | Route (method path under `/api/projects/:project` unless absolute) | Perm |
| --- | --- | --- | --- | --- |
| `studio.project.list` | `{}` | `{projects: Project[]}` (status without logs) | `GET /api/projects` | read |
| `studio.project.create` | `{id, template?: "app"\|"game", settings?: {name,title,appId,version,build,tickHz,reusePublishedPackages}}` | `Project` | `POST /api/projects` | write |
| `studio.project.open` | `{project}` | `Project` (config + status without logs) | `GET /api/projects/:id` | read |
| `studio.project.settings.get` | `{project}` | `EditorConfig` | `GET …/config` | read |
| `studio.project.settings.set` | `{project, settings}` (same keys as create) | `EditorConfig` + status | `PUT …/config` | write |
| `studio.fs.tree` | `{project, assets?: boolean}` | `{files:[{path,bytes}], revision, assets?: string[]}` (flat; the guest builds the tree) | `GET …/files` (+ `GET …/assets`) | read |
| `studio.fs.read` | `{project, path}` | `{path, content, bytes, revision}`; `too_large` above ~240 KiB: use `readChunk` | `GET …/files/<path>` | read |
| `studio.fs.write` | `{project, path, content}` (<= 192 KiB) | `{path, bytes, revision}` | `PUT …/files/<path>` | write |
| `studio.fs.rename` | `{project, from, to, overwrite?}` | `{from, to, revision}` | `POST …/files-move` | write |
| `studio.fs.delete` | `{project, path}` | `{path, revision}` | `DELETE …/files/<path>` | write |
| `studio.fs.stat` | `{project, path}` | `{path, kind, bytes, mtimeMs, editable}` | `GET …/stat/<path>` | read |
| `studio.fs.mkdir` | `{project, path}` | `{path, created, revision}` | `POST …/folders` | write |
| `studio.fs.rmdir` | `{project, path}` (empty folder) | `{path, revision}` | `DELETE …/folders/<path>` | write |
| `studio.fs.readChunk` | `{project, path, offset, length?}` (length clamped to 131072) | `{path, offset, length, totalBytes, sha256, mtimeMs, data(base64)}` | `GET …/chunks/<path>?offset&length` | read |
| `studio.fs.upload.begin` | `{project, path, totalBytes, sha256}` | `{uploadId, chunkBytes, expiresInMs}` | `POST …/uploads` | write |
| `studio.fs.upload.chunk` | `{project, uploadId, offset, data(base64, <=131072 raw bytes)}` | `{uploadId, received, totalBytes}` | `PUT …/uploads/:uploadId` | write |
| `studio.fs.upload.commit` | `{project, uploadId}` | `{path, bytes, sha256, revision}` | `POST …/uploads/:uploadId/commit` | write |
| `studio.fs.upload.abort` | `{project, uploadId}` | `{uploadId, aborted}` | `DELETE …/uploads/:uploadId` | write |
| `studio.fs.watch` (stream) | `{project}` | batches `{events: WatchEvent[]}` | `GET …/watch` (SSE) | read |
| `studio.build.start` | `{project}` | status (202) | `POST …/build` | build |
| `studio.build.cancel` | `{project}` | `{cancelled, pending?, status}` | `POST …/build/cancel` | build |
| `studio.build.status` | `{project}` | `EditorStatus` (newest log lines within budget) | `GET …/status` | read |
| `studio.build.events` (stream) | `{project}` | batches `{events: BuildEvent[]}` | `GET …/build/events` (SSE) | read |
| `studio.logs.tail` | `{project}` | `{logs, error}` | `GET …/logs` | read |
| `studio.preview.publish` | `{project}` | publish record (`buildId, build, manifestUrl, payloadSha256, …`) | `POST …/preview-publish` | build |
| `studio.preview.devices` | `{}` | `{devices}` | `GET /api/devices` | read |
| `studio.preview.deploy` | `{project, deviceId}` | deployment job | `POST …/deploy` | deploy |
| `studio.preview.deployStatus` | `{project, job}` | job | `GET …/deploy/:job` | read |
| `studio.preview.deployCancel` | `{project, job}` | job | `DELETE …/deploy/:job` | deploy |
| `studio.publish.plan` | `{project, channel?: "test"\|"release"}` | target summary | `GET …/publish-targets?channel=` | read |
| `studio.publish.publish` | `{project, channel?}` | publish result | `POST …/publish` | publish |
| `studio.publish.history` | `{project}` | version backend snapshot | `GET …/versions` | read |
| `studio.publish.offline` | `{project}` | `{archiveUrl, filename}` | `POST …/package-offline` | publish |
| `studio.artifacts.list` | `{project}` | `{revision, builtRevision, artifacts}` | `GET …/status` (projection) | read |
| `studio.artifacts.inspect` | `{project, name}` (one of the 8 fixed artifact names) | `{name, bytes, encoding:"utf8", data, truncated}` for `app.js` and `*.json`; `{name, bytes, encoding:"binary"}` (no data) for `.qjbc`/`.pak` | `GET …/artifacts/<name>` | read |
| `studio.service.health` | `{}` | `{ok, service, version, projectId?, updatePackageVersion?, bluetooth?}` | `GET /health` (scrubbed) | read |
| `studio.service.upgrade.status` | `{}` | upgrade status | `GET /api/studio/upgrade` | read |

Clipboard is not a studio capability: the guest uses the SDK `clipboard.*` plugin (`@pocket/ui/clipboard`).
Reloading the preview child is a guest-side `system.runtime.destroy` + `system.runtime.create` (see
`sdk/docs/STUDIO_SIGNED_PREVIEW.md`); `studio.preview.publish` only produces the signed package. Reserved, not
registered in M1: `studio.service.upgrade.check/apply` (M6), `studio.project.resources.*` (M5),
`studio.logs.diagnostics` (M7).

### Permissions

`read`, `write`, `build`, `deploy`, `publish` are the permission names `studio.read`, `studio.write`,
`studio.build`, `studio.deploy`, `studio.publish`. They are separate grants like `clipboard.read/write`.

### Errors

A failure is a structured capability error `{code, message}`; the guest bridge rejects with `error.code`.
Provider codes: `invalid_params` (validation, before any request), `too_large` (result/params over budget),
`capability_not_found`, `plugin_disposed`, `service_unreachable`, `service_timeout`, `invalid_response`,
`service_stream_error`. Service statuses map to: 400 `invalid_request`, 403 `forbidden`, 404 `not_found`,
409 `conflict`, 413 `too_large`, 422 `checksum_mismatch`, 429 `too_many_requests`, 501 `unsupported`, other 5xx
`service_error`. The message is the service's `error` text (scrubbed) plus ` (HTTP n)`. Framework codes
(`capability_denied`, `permission_denied`, `plugin_payload_quota`, `plugin_stream_quota`) can also appear.

### Streams and limits

Stream items are `{events:[...]}` batches, at most 200 events / 128 KiB each, one batch per 25 ms at most.
The provider keeps a queue of at most 1024 events / 512 KiB between the SSE reader and the guest. On overflow it
drops the oldest `log` events (then the oldest of any type) and puts `{type:"gap", dropped:n}` first in the next
batch; the guest must then re-read `studio.build.status` / `studio.fs.tree`. A service-side drop of a slow
consumer, or an error, ends or errors the stream; the guest reopens it (JS owns reconnection). The framework
quota of 10000 items per stream (`plugin_stream_quota`) also means "reopen". Every control message stays below
256 KiB: file transfers use `readChunk` / `upload.chunk` with <= 131072 raw bytes (base64 <= ~175 KB), and the
JS client (`readBytes`, `writeText`) splits and verifies sha256 itself.

## Permission and grant model

1. Host scope (`PocketAppConfig.allowedPermissions`): only the Studio app id `dev.pocket.studio` is given
   `studio.*` and `clipboard.read/write`, and only it has `PocketStudioPlugin` / `PocketClipboardPlugin` in its
   `pluginFactories`.
2. Guest manifest (`studio/js/manifest.json`): declares the capabilities (optional) and permissions it uses. A
   test compares this list with the provider's capability names.
3. The preview child `dev.pocket.studio.preview` has no `allowedPermissions` and no plugin factories, so it
   cannot request any `studio.*` or clipboard capability (tested; see also the isolation proof in
   `sdk/docs/STUDIO_SIGNED_PREVIEW.md`).
4. Trusted configuration (service port, SDK root, project root, workspace, bun path) comes from the host run
   configuration (`--dart-define` or `--dart-define-from-file`), never from the guest: `POCKET_STUDIO_PORT`
   (default 8795), `POCKET_STUDIO_SDK_ROOT`, `POCKET_STUDIO_PROJECT_ROOT`, `POCKET_STUDIO_WORKSPACE`,
   `POCKET_STUDIO_BUN`, `POCKET_STUDIO_AUTOSTART`.

## Path and secret scrubbing

Applied to every response, error message, and stream event (`StudioPathScrubber`):

1. JSON keys `workspace`, `projectRoot`, `flutterRoot`, `sdkRoot`, `csrfToken`, `absolutePath` are dropped at any depth.
2. Roots learned from `/health` (workspace, project root, flutter root) and from host config (SDK root, project
   root, workspace, optional extra temp roots) are replaced by `<workspace>`, `<project>`, `<flutter>`, `<sdk>`,
   `<tmp>`; `<workspace>/projects/<id>` becomes `<project>`; the `/private` alias of `/var`, `/tmp`, `/etc` is covered.
3. Other absolute paths below `/Users /home /var /private /tmp /opt /usr /Volumes /root /mnt /srv /nix /snap /run
   /Library /Applications /System /proc /etc /workspace`, Windows drive paths and `file://` URIs become
   `<path>/<last segment>` (so `build_guest: source=/tmp/x/app.tsx` reads `source=<path>/app.tsx`).
4. The CSRF token value is replaced by `<redacted>` wherever it occurs; it is never returned by any call.
5. Artifacts: text artifacts are scrubbed; binary artifacts (`.qjbc`, `.pak`) are returned as metadata only
   because their embedded debug paths cannot be scrubbed.

Project-relative paths (`src/tmp/x.ts`) and loopback URLs are unaffected. Rule 3 is a safety net with a fixed
list of system top-level directories; it is not a general path parser. Tests: `sdk/packages/pocket_studio/test`.

## Provider design

* HTTP client: plain `dart:io` `HttpClient` (async, `findProxy: DIRECT`, no redirects, 3 s connect timeout,
  30 s request timeout, 2 MiB response cap, loopback `http` origin enforced in the constructor). `pocket_dio`'s
  worker isolate was not reused: it exists for arbitrary-origin Dio traffic and quota policy; here the origin is
  one trusted loopback port and every body is bounded, so socket IO is already off the UI thread and an isolate
  would only add a second message hop.
* Statelessness: no project, build, transfer or retry state. The only cached value is the CSRF token from
  `GET /health`, refreshed once on a 403 (service restart). SSE streams are per-subscription and own only a
  bounded queue.
* Route map: `studioCalls` (`studio_routes.dart`) is a fixed table; a call builds URL segments and a body from
  allowlisted, validated params. Unknown settings keys are rejected rather than forwarded.

## Service lifecycle (host only)

`PocketStudioService.start()`: if `GET http://127.0.0.1:<port>/health` already answers
`{ok:true, service:"pocket-editor"}` it attaches and never starts a second service; otherwise (and only with
`autoStart`) it runs `bun <sdk>/pocket.ts editor <projectRoot> --port=<port> --update-host-version=studio
--workspace=<workspace>` with `workingDirectory` = SDK root, polls `/health` every 200 ms until a 90 s deadline and
fails with the child's last log lines if it exits early. `stop()` (also on app exit via `AppLifecycleListener`)
sends SIGTERM, then SIGKILL after 5 s, only for a process this helper started. `bun pocket.ts editor` was chosen
over `editor_service.mjs`: the latter is the fixed-port (8791), LAN-bound, launchd-style manager for the web
Studio; the former takes an explicit port and loopback bind. The service needs a project root (a directory with
`pocket.json`); Studio-created projects live in its workspace.

## Guest structure (M2/M3)

```
studio/js/app.tsx            shell only: theme, rail, active page, dialog/toast hosts, host-event routing
src/state/                   plain TypeScript stores (no Solid import, unit-testable in bun)
  store.ts env.ts            observable store, injected Timers (guest: frame-driven `after`)
  workspace.ts               files, tabs, dirty, save, create/rename/delete, fs.watch reconcile, assets
  build.ts ring.ts           build control, build.events, 2,000-line ring buffer, diagnostics
  preview.ts system-link.ts  build -> publish -> destroy/create -> first frame; the only System capability user
  deploy.ts settings.ts      devices/deploy jobs; Studio-local settings via system.storage
  projects.ts toasts.ts dialogs.ts resilient.ts studio.ts (composition root, auto-build wiring)
src/pages/                   projects source console preview resources settings + placeholder (artifacts, publish, versions)
src/components/              rail, file-tree, tabs, editor-pane (swappable), preview-surface, toasts, dialog-host
src/ui/bind.ts               Store -> Solid accessor; the only bridge between stores and the renderer
```

Adding a page (M5) is one line in `src/pages/index.tsx` plus a store; `app.tsx` does not change. The editor is
an `EditorPane` (`{path, text, onChange, onSave, diagnostics, jump}`) selected by the `editor` setting; M2 registers
the multi-line `InputField`, M4 registers `code` (CodeView) in `editorPanes` without touching the Source page.

Rules the stores follow: JS owns reconnection (`resilient.ts`: backoff 0.5 s to 15 s, a resync callback on the
first event after a drop; `gap` events and quota errors take the same path), per-project epochs drop late results
after a project switch, and every service error becomes a toast (`code: message`), never a silent success.

### Editing (M2)

* Open reads through `readText`; files above 240 KiB go straight to verified chunked reads, writes above 192 KiB use
  the sha256-checked upload; files above 1 MiB are not opened in the InputField editor (clear message; CodeView lifts
  the cap in M4).
* Dirty = `text !== saved`. Closing a dirty tab, switching project and saving over an external change ask in a
  modal. `fs.watch`: a clean tab reloads silently, a dirty tab gets a conflict banner (keep mine / load disk), a
  deleted file closes a clean tab or flags a dirty one. The tab's own saves are recognized by content (disk ==
  saved), so no flag races.
* Tree actions: new file/folder, rename/move (files only; the service has no folder move), delete (folders must be
  empty). Empty folders are tracked locally because the service's flat list cannot show them.
* Assets: listed from `studio.fs.tree` with `assets: true`, metadata via `studio.fs.stat`. **Image preview is not
  available**: the chunk route refuses `assets/` and the SDK has no PNG/JPEG decoder for guest-side bytes
  (`@pocket/ui/images` shows host-captured thumbnails only), so the page says "预览不可用". New asset upload needs a
  file-dialog capability (not in scope); text files are created or replaced from the Source page.
* Save: toolbar button. Cmd/Ctrl+S is registered through `onTextEvent`; a focused `InputField` is a Flutter text
  field that keeps its keys, so reliability needs the M4 raw-text CodeView.
* The guest now routes `textInput.*` host events to `deliverTextInputEvent` (the M1 shell never did, so its create
  dialog could not be typed in).

### Build, console, logs (M3)

`studio.build.events` feeds the status, the log ring buffer (gap marker + authoritative `build.status` read on a
gap) and structured diagnostics; a build whose `done` was lost with the stream is finished from the next status.
Diagnostics are listed in the Console; tapping one opens the file with a recorded jump target `{line, column}`
(the InputField shows a context strip; CodeView will scroll to it).

### Preview flow (M3)

1. `preview.run`: build if needed (`build.run`, waits for `done`) -> `studio.preview.publish` (a 409 means the source
   changed during the build: rebuild, at most 3 attempts) -> `system.runtime.destroy` of the old child ->
   `system.runtime.create({appId:"dev.pocket.studio.preview", prepareForOpen:true})` WITHOUT `cacheFirst` ->
   `system.runtime.awaitFirstFrame` -> phase `running`. A failure at any step is phase `error` with the code and a toast.
2. The child is composited by `CompositorSurface` in the Source dock (setting) or the Preview page; only one is
   mounted at a time. `awaitFirstFrame` is requested only while the surface is on screen (a hidden child cannot
   produce a visible frame); `focused` is dropped while a modal is open. Presenting the child also lets it reach the
   health window (see `sdk/docs/STUDIO_SIGNED_PREVIEW.md`).
3. Runs requested while one is active coalesce into exactly one follow-up run.
4. Auto-build (Settings): a save starts a debounce (300 ms / 800 ms / 2 s); when it fires, `preview.run({build:true})`
   runs. Settings persist as `studio.settings.v1` through `system.storage.*` with `appId: dev.pocket.studio` (the
   host's SystemUI storage; no Dart state). If storage fails the page says changes are session-only.
5. Deploy (Preview page): `studio.preview.devices` / `deploy` (builds first when stale) / `deployStatus` polling
   (stops at a terminal state or `running`) / `deployCancel`.

### Preview child and the catalog (resolved in M3)

The catalog contains `dev.pocket.studio.preview` with `downloadOnOpen` and signed `updates` pointing at
`<origin>/preview/pocket/studio/dev.pocket.studio.preview/preview/latest.json`, namespace `studio-preview`. Previously the key
existed only after the first `preview-publish`, so the child could not be configured at host start. Fix, in the
service (`sdk/editor/server.ts`): `startEditor` creates the dedicated preview key (`previewTrust`, idempotent, never
rotated; the private half stays in the service) before it serves, covered by `editor_preview_publish.test.ts`.
The host (`studio/lib/main.dart`) starts the service, then reads only the public key from the trusted workspace
(`readPreviewKey`), so `downloadOnOpen` and `updates` are always set. The bootstrap metadata the child needs before
any package exists is built by `previewBootstrap` from the Studio's own runtime ABI with a build floor of 1 (previews
are always build >= 2); the signed package carries the real manifest and bytecode. No Dart state machine was added.

## Studio-local settings

`studio.settings.v1 = {autoBuild, debounceMs, dockPreview, editor}` in the Studio's SystemUI storage. `studio.project.settings.*`
only accepts the project's own configuration keys, so it is not used for Studio preferences. The manifest declares
`system.storage.get/set/remove/keys` and `system.runtime.awaitFirstFrame` as optional capabilities.

## Building and running on macOS

```sh
cd studio/js && bun install && bun run build      # writes studio/assets/{app.qjbc,app.pak,...}
cd .. && flutter pub get
flutter run -d macos \
  --dart-define=POCKET_STUDIO_SDK_ROOT=/path/to/pocket/sdk \
  --dart-define=POCKET_STUDIO_PROJECT_ROOT=/path/to/a/pocket/project \
  --dart-define=POCKET_STUDIO_WORKSPACE=/path/to/studio-workspace
# or: flutter run -d macos --dart-define-from-file=studio.config.example.json (after editing the paths)
```

The macOS target is the only platform (`studio/macos`). The app runs without the App Sandbox
(`macos/Runner/*.entitlements`) because it starts `bun` and reads the trusted workspace; this is a developer-tool
host. This container is Linux, so the macOS app itself was not launched here; the tests below run the same host
configuration on the real native library.

## Tests

* `sdk/packages/pocket_studio/test/studio_plugin_test.dart`: real loopback HTTP fake: routing of every call,
  validation, CSRF, scrubbing, error mapping, SSE batching/gap/cancel, admission and permission denial, lifecycle.
* `sdk/packages/pocket_studio/test/real_service_test.dart`: the real editor service started by the lifecycle helper.
* `studio/js/tests/studio_client.test.ts`, `tree.test.ts`: client request shapes, chunk splitting, sha256, errors.
* `studio/js/tests/state.test.ts`: ring buffer, resilient streams, toasts/dialogs, workspace (save, dirty prompts, watch
  reconcile, tree operations), build, preview orchestration (phases, 409 rebuild, coalescing, failures), settings.
* `studio/js/tests/studio_guest_{native,workflows,preview}.test.ts`: the built bytecode on the real `pocket_probe`
  with the stateful `fake_studio.ts` (studio.* and System host): input-driven frame changes for every flow above.
* `studio/test/studio_host_test.dart`: M1 exit test (real native library, real service on the demo JS project).
* `studio/test/studio_edit_test.dart`: M2 exit test (temp copy of the Showcase project, edit + Save on disk).
* `studio/test/studio_preview_loop_test.dart`: M3 exit test (auto-build, signed preview child reloads, latency).

Known gaps found while testing: (1) in the probe harness a second large (>~170 KB) inbound `host.response` right after
another is not delivered to the guest, so chunked reads are verified by bun unit tests and the verified client, not by
a probe test; the real-host path for files above 240 KiB is unverified. (2) The multi-line InputField shapes the whole
text, which is slow for ~100 KiB files on the debug native build (fine on release).
