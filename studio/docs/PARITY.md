# Pocket Studio parity inventory (M0)

Source of truth: `sdk/editor/server.ts`, `sdk/editor/preview.ts`, `sdk/editor/novel.ts`,
`sdk/editor/diagnostics.ts`, `sdk/editor/client/index.html` and `sdk/editor/client/editor.js`
at commit `f59d2df`. Every row was read from code, not from the handover brief.

Status column: `[ ]` not started in the Pocket Studio, `[~]` transport/provider done but no Studio UI yet, `[x]` reached parity, `—` deliberately out of
scope for v1 (needs owner sign-off before M6 cutover).

## 1. Transport and security (applies to every route)

| Guard | Where | Behaviour the Pocket Studio client must satisfy |
| --- | --- | --- |
| Peer address | `fetch()` in `startEditor` | Peer must be a local-network address, else 403. |
| Host header | `validateRequestSecurity` | Host must be `127.0.0.1`/`localhost`/`::1` (plus LAN IPs only when bound off-loopback); port must equal the server port. |
| Origin / Referer | `validateRequestSecurity` | If present, must be same-origin; `Origin: null` rejected. A Dart `HttpClient` sends neither, which passes. |
| Fetch metadata | `validateRequestSecurity` | Writes with `sec-fetch-site` cross-site or `sec-fetch-mode` navigate/no-cors rejected. |
| Write credential | `validateRequestSecurity` | `POST/PUT/PATCH/DELETE` need `x-pocket-csrf: <token>` **or** `x-pocket-editor: 1`. A wrong `x-pocket-csrf` is always 403. Asset upload also accepts a `csrfToken` form field. |
| Token source | `GET /health` | Returns `csrfToken` (random UUID per process) unauthenticated. |
| Body limits | `parseJsonBody`, `Bun.serve` | JSON bodies 256 KiB default; source/file bodies 16 MiB; asset upload 32 MiB; `content-type: application/json` required (415). |
| Path policy | `safeProjectFile` | Relative only; no `.`/`..`/empty segments/NUL/leading `/`; protected dirs `assets builds updates keys node_modules .git .pocket-build`; protected files `editor.json pocket.json host.json payload.json latest.json signed-manifest.json build.json app.bytecode.json private.json secret.json *.pem *.key *.qjbc *.pak *.tar *.gz`; editable extensions `ts tsx js jsx json svg css md`. |
| Symlinks | `safeProjectFile`, `writeProjectFile`, `listAssets` | Project dir must not be a symlink; writes use `O_NOFOLLOW` and re-validate after write; symlinked assets rejected. |
| Write admission | `projectWrites`, Codex/WeChat/deploy locks | One mutating request per project at a time (409); writes refused while Codex, WeChat build or device build owns the project. |

Findings to carry into `StudioProvider` (do not change the service):

- `x-pocket-editor: 1` is a constant header and `/health` hands out the CSRF token to any local
  caller. The real protection against browsers is Host/Origin plus the CORS preflight that a custom
  header triggers. The Dart provider must send `x-pocket-csrf` read from `/health`. It must not use
  the constant header. The guest must never receive the token.
- `/health` returns absolute `workspace`, `projectRoot` and `flutterRoot`. The provider must strip
  these before anything reaches the guest (ground rule 3).

## 2. HTTP routes

Auth column: `R` = read guards only; `W` = read guards + write credential.

### 2.1 Service

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | R | `{ok, service, pid, version, csrfToken, bluetooth, workspace, projectRoot?, projectId?, flutterRoot?, updatePackageVersion?}` | host-internal (lifecycle) | [x] (`PocketStudioService`, token and paths never reach the guest) |
| GET | `/` , `/<name>.css|js` | R | web client static files | — (web only) | — |
| GET | `/api/studio/upgrade` | R | upgrade status | `studio.service.upgrade.status` | [ ] deferred: capability reserved, no UI (SDK checkout upgrade stays in the web Studio) |
| POST | `/api/studio/upgrade/check` | W | `{autoApply?, forceApply?}` | `studio.service.upgrade.check` | [ ] deferred (as above) |
| POST | `/api/studio/upgrade/apply` | W | → 409 in source checkouts | `studio.service.upgrade.apply` | [ ] deferred (as above) |
| GET | `/api/preview/device` | R | preview device profile | `studio.preview` | [ ] not needed: the child is sized by its compositor surface |
| GET | `/api/devices` | R | `flutter devices --machine` list | `studio.preview.devices` | [~] UI done (Preview page), not exercised against a real device here |
| GET | `/api/codex/status`, `/api/codex/models` | R | Codex availability | — (UI removed from web Studio) | — |

### 2.2 Projects, config, files

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects` | R | project list with status | `studio.project.list` | [x] |
| POST | `/api/projects` | W | `{id, template: app|game, ...config}` → 201 | `studio.project.create` | [x] |
| GET | `/api/projects/:id` | R | config + status | `studio.project.open` | [x] |
| GET/PUT | `/api/projects/:id/config` | R/W | `EditorConfig` merge; bumps revision | `studio.project.settings.get/set` | [~] |
| GET/PUT | `/api/projects/:id/source` | R/W | `{path:"app.tsx", source, bytes, revision}`; ≤16 MiB, no NUL | `studio.fs.read/write` (alias) | [x] |
| GET | `/api/projects/:id/files` | R | `{files:[{path, bytes}], revision}` editable text files only | `studio.fs.tree` | [x] |
| GET/PUT | `/api/projects/:id/files/<rel>` | R/W | `{path, content, bytes, revision}`; ≤16 MiB, UTF-8, no NUL | `studio.fs.read/write` | [~] |
| GET/PUT | `/api/projects/:id/manifest` | R/W | raw `manifest.json`; PUT ≤256 KiB | `studio.fs.read/write` (manifest) | [x] |
| GET | `/api/projects/:id/assets` | R | `{assets: string[]}` flat names under `assets/` | `studio.fs.tree` (assets) | [x] |
| POST | `/api/projects/:id/assets` | W | multipart `file`, ≤32 MiB, safe flat name | `studio.fs.write` (asset, chunked) | [ ] |
| GET/PUT | `/api/projects/:id/resources` | R/W | resource inventory / placements `{revision, packageId, placements}` | `studio.artifacts.resources` | [ ] |
| GET | `/api/projects/:id/resources/preview?revision&package&key` | R | thumbnail image | `studio.artifacts.resources` | [ ] |

**Added on the service (see `sdk/docs/EDITOR_FS_AND_BUILD_ROUTES.md`):** `GET stat/<rel>`,
`DELETE files/<rel>`, `POST files-move`, `POST folders`, `DELETE folders/<rel>` (empty only),
`GET chunks/<rel>?offset&length` (base64, 131072 max), chunked upload `POST uploads`, `PUT uploads/:id`,
`POST uploads/:id/commit`, `DELETE uploads/:id`, and `GET watch` (SSE). All reuse `safeProjectFile` /
`writeProjectFile`, the write credential, the `projectWrites` lock and the Codex/WeChat/deploy busy checks.
**Still missing:** nested asset folders (assets stay flat).

### 2.3 Build, logs, artifacts

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/projects/:id/build` (alias `/compile`) | W | `{}` → 202 + status; queued `buildGuest` | `studio.build.start` | [x] |
| GET | `/api/projects/:id/status` | R | `EditorStatus` (revision, builtRevision, busy, error, last 200 logs, artifacts, publish) | `studio.build.status` | [x] |
| GET | `/api/projects/:id/logs` | R | `{logs: string[≤200], error}`; lines ≤4096 chars | `studio.logs.tail` | [x] |
| GET | `/api/projects/:id/artifacts/<name>` | R | one of `app.js app.qjbc app.bytecode.json app.pak guest-manifest.json build.json resources.json app.worker.qjbc app.worker.bytecode.json` (`resources.json` allowed in M5) | `studio.artifacts.inspect` | [x] (产物 page) |
| GET/POST | `/api/projects/:id/diagnostics` | R/W | diagnostics export / record | `studio.logs.diagnostics` | [ ] deferred: capability reserved; "Export diagnostics" button not built |

**Added on the service:** `POST build/cancel` (aborts the compiler process group; final state
`error:"build cancelled"`), `GET build/events` (SSE `status`/`log`/`done`, pushed, no polling) and
`EditorStatus.diagnostics[{file,line,column,severity,message}]` (project-relative, only while a build error is
current). Logs remain plain strings (200 lines, 4096 chars). Caveat: line numbers for `bun` resolve errors refer to
the JSX-lowered intermediate module.

### 2.4 Preview and deploy

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/:id/preview` (`page`) | R | web preview document | — (replaced by child guest) | — |
| GET | `/api/projects/:id/preview/stream` | R | SSE frames from `pocket_probe` | — (replaced) | — |
| POST | `/api/projects/:id/preview/input` | R* | pointer/text/semantic/resize events | — (replaced) | — |
| GET | `/api/projects/:id/preview/status`, `/snapshot` | R | preview session state | `studio.preview.status` | [x] covered by the preview phase facts (`state/preview.ts`) |
| GET/HEAD | `/api/projects/:id/preview/resource`, `/media?asset=` | R | resource bytes | — (child guest reads its own pack) | — |
| POST | `/api/projects/:id/preview-publish` | W | **new**: packages the current successful build into the signed `preview` slot (fixed id `dev.pocket.studio.preview`, dedicated key, monotonic build) → `{buildId, revision, generation, version, build, packageId, manifestUrl, hostConfigUrl, payloadSha256, runtimeAbi, timingsMs}`; 409 without a current successful build | `studio.preview.load/reload` (child close + `create` without `cacheFirst`) | [~] service + Linux FFI proof done; macOS compositing open |
| GET | `/preview/pocket/:host/:id/preview/<artifact>` | R (public) | **new**: signed preview slot served like `/test` and `/stable` | host update coordinator | [~] |
| GET/POST | `/api/projects/:id/deploy` | R/W | `{deviceId}` → 202 deployment job | `studio.preview.deploy` | [~] |
| GET/DELETE | `/api/projects/:id/deploy/:job` | R/W | job status / cancel | `studio.preview.deploy` | [~] |
| GET/POST/DELETE | `/api/projects/:id/wechat` | R/W | WeChat mini-program preview | — (v1 out of scope; ask owner) | — |
| POST/GET/DELETE | `/api/projects/:id/codex/turn[/:turn]` | W/R/W | Codex turn | — (removed from web UI) | — |

`*` preview input is a POST but still passes the write-credential check.

### 2.5 Publish, versions, update hosting

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/:id/publish-targets?channel=test|release` | R | target summary, reusable packages | `studio.publish.plan` | [x] (M5 page) |
| POST | `/api/projects/:id/publish` (alias `/package`) | W | `{channel?: test|release}` → manifest, URLs, packages | `studio.publish.publish` | [x] (M5 page) |
| POST | `/api/projects/:id/package-offline` | W | offline archive URL | `studio.publish.offline` | [x] (M5 page) |
| GET | `/api/projects/:id/versions` | R | version backend snapshot (slots, history) | `studio.publish.history` | [x] (M5 page) |
| GET/HEAD | `/updates/…`, `/pocket/…`, `/test/pocket/…`, `/stable/pocket/…` | R | signed manifests and blobs for clients | not a guest capability (served to devices) | n/a |
| GET | `/releases/:id[/<release>].tar.gz` | R | release archives | `studio.publish.history` (download link) | [x] shown as a URL |

### 2.6 Visual novel editor (`sdk/editor/novel.ts`)

The handover brief did not mention this. It is the largest single web UI (`client/novel.js` 7.3k lines
plus stage/localization/authoring/backups modules).

| Method | Path | Notes | Parity |
| --- | --- | --- | --- |
| GET | `/novel`, `/novel/resource`, static `novel*.js/css`, `live2d-core.js` | separate editor page | — (ask owner) |
| GET/PUT | `/api/projects/:id/novel/story` | story document | — |
| GET/PUT/POST | `/api/projects/:id/novel/assets` | asset registry | — |
| GET/PUT | `/api/projects/:id/novel/locales`, POST `locales/diagnostics` | localization | — |
| GET/POST | `/api/projects/:id/novel/backups`, `backups/restore`, `backups/schedule` | backups | — |
| GET | `/api/projects/:id/novel/diagnostics` | registry diagnostics | — |
| GET/POST | `/api/projects/:id/novel/export` | Word export | — |
| GET | `/api/projects/:id/novel/runtime.js`, `spine.js`, `live2d.js`, `models/*` | runtime assets | — |

## 3. Web Studio UI features (`client/index.html`, `client/editor.js`)

| Area | Feature | Element ids | Pocket Studio milestone | Parity |
| --- | --- | --- | --- | --- |
| Shell | Project switcher, project title/subtitle/state | `project-switcher`, `projects`, `project-title`, `project-state` | M1 | [x] (list + open + 暂无项目 state; subtitle/state chips later) |
| Shell | New project dialog with App/Game template | `new-project`, `create-dialog`, `create-form` | M1 | [x] (App/Game, id, name, appId; version/tickHz fields later) |
| Shell | Left rail: stage, source, console, resources, settings, versions | `rail-*` | M1 | [x] (项目/源码/控制台/预览/资源/设置 and, since M5, 产物/发布/版本 are real pages) |
| Shell | Notice toast | `notice*` | M1 / M2 | [x] (bottom-right toast stack, tone, auto-dismiss, tap to dismiss) |
| Shell | Studio self-upgrade bar | `studio-upgrade-*` | M6 | [~] The Studio's *own guest* updates itself through the signed OTA path (Settings: 检查 Studio 更新 / 应用更新, state handoff, automatic rollback; `studio/test/studio_self_update_test.dart`). The web bar's other job, upgrading the SDK checkout (`/api/studio/upgrade/check|apply`, `studio.service.upgrade.*`), stays reserved and is not built |
| Source | File picker, source editor, save, reload, bytes/revision, split toggle, close | `file-picker`, `source`, `save`, `refresh-source`, `source-*` | M2 / M4 | [x] M2: tree, tabs with dirty state, multi-line InputField, Save button, unsaved prompts, create/rename/delete/mkdir/rmdir, fs.watch reconcile, chunked IO, 1 MiB cap for the InputField. [x] M4: `CodeView` (default `editor: "code"`; the InputField stays as the `input` fallback): syntax colours, gutter diagnostics, find/replace, undo, system clipboard, Cmd+S/Cmd+Z through the raw key session, dirty from the buffer version, files up to 4 MiB through the sliced chunked read/upload. Linux proof: `studio/test/studio_code_editor_test.dart` (5,000-line file); macOS IME and profile frame budget are deferred. [~] folder rename unsupported (service moves files only) |
| Preview | Viewport picker, phone bezel toggle, regions overlay, resize height | `viewport-picker`, `preview-bezel-toggle`, `toggle-regions`, `resize-preview-height` | M3 | [~] the Source dock width is resizable with a drag handle (M7 `SplitPane`); viewport picker, bezel and regions overlay are not built |
| Preview | Refresh, capture screenshot, copy preview link | `refresh-preview`, `capture-preview`, `copy-preview-link` | M3 (link is web-only) | [~] refresh = "构建并刷新预览"/"重新加载"; screenshot and link not built |
| Preview | Child app surfaces | `preview-surfaces` | M3 | [x] signed child composited by `CompositorSurface` (Source dock and Preview page); phases building/publishing/loading/running/error are real facts. Linux proof with the real library + service: `studio/test/studio_preview_loop_test.dart`; on-screen behavior on macOS not verified |
| Preview | Local Bluetooth (Noble) toggle | `web-bluetooth-toggle`, `bluetooth-provider` | — (ask owner) | — |
| Console | Build tab: build button, state, log, clear | `build`, `build-state`, `log`, `clear-log` | M3 | [x] start/cancel, status, build.events stream with JS reconnect, 2,000-line ring buffer with gap markers, clickable diagnostics (open file at line:column; CodeView scrolls and puts the caret there, the InputField shows the line context) |
| Console | Deploy tab: device picker, deploy, cancel, log | `device-picker`, `deploy`, `deploy-cancel`, `deploy-log` | M3 | [x] on the Preview page (device list, deploy builds first, polling, log, stop). Not exercised against a real device/simulator here |
| Console | Signing tab: publish test, target picker, channel, reused packages | `publish-test`, `publish-target-*` | M5 | [x] 发布 page: test/release channel, plan (root target, reused packages and their slot owners), gated signed publish with progress, release confirmation, result facts (key id, ABI, payload sha256, manifest/host.json/App/archive URLs), offline package, copy buttons. Target *picker* for another project's mini app is not built (a reused package is shown with its owner; publishing it needs opening the owner project, as in the web Studio) |
| Console | Artifacts tab: artifact list, runtime ABI | `artifacts`, `runtime-abi` | M5 | [x] 产物 page: file list with sizes, bytecode metadata, guest manifest (capabilities, permissions, memory), pack contents summary (from `resources.json`), build.json, raw text view, copyable hashes. Downloads are not offered (no file dialog): binaries are metadata only |
| Inspector | Resources: package picker, placement list, save | `resource-*`, `save-resources` | M5 | [ ] deferred (the "资源" page is the M2 asset browser: list + metadata; image preview unavailable, see ARCHITECTURE) |
| Inspector | Settings: name, title, appId, version, build, tickHz | `config-*` | M1 | [ ] deferred: `studio.project.settings.*` transport done, no project-settings form (the Settings page holds Studio-local settings only) |
| Inspector | Versions: backend origin, slots, history, host guide, app config | `version-*` | M5 | [x] 版本 page: origin, host/compat version, LAN flag, App entry URL, test/stable slots, release history with details and archive URLs. Trial/promoted/rolled-back is device state the service does not record, so it is explained, not shown. The web "host guide" prose and per-row one-click archive download are not reproduced |
| Tools | Export diagnostics | `export-diagnostics` | M7 | [ ] deferred: `studio.logs.diagnostics` stays reserved; build diagnostics are shown in the Console and the gutter |
| Tools | Open visual novel editor | `novel-open` | — (ask owner) | — |
| Tools | WeChat preview pane | `wechat-*` | — (ask owner) | — |

## 4. Existing Editor tests

148 files in `sdk/editor/test/` (run with `TMPDIR=/tmp bun test` from `sdk/`). Grouped by the area
the Pocket Studio must keep green. Test counts are `test(`/`it(` calls per file.

| Group | Files (tests) | Relevance |
| --- | --- | --- |
| Service and security | `editor_server` (11), `config_preservation` (2), `scope_admission` (1), `studio_concurrency` (1), `cache_busting` (1), `input_cache` (1) | Must stay green; new fs routes add cases to `editor_server.test.ts`, including the CSRF/Host/symlink test at line 568. |
| Templates | `project_templates` (3), `project_templates_live_probe.ts` | M1 `studio.project.create` |
| Versions / publish | `editor_versions` (5), `update_endpoint` (3), `version_management_ui` (1) | M5 |
| Resources | `resources` (2), `resources_system` (1), `resources_ui` (1), `resource_delivery` (2) | M5 |
| Preview (web, probe) | 75 `preview_*` files | Web preview stays until M6; the child-guest preview needs its own tests. |
| Hot reload | `hot_reload` (4) | Pattern for M3 reload of the child guest. |
| Devices | `devices` (8) | M3 deploy |
| Diagnostics | `diagnostics` (3) | M7 |
| Self-upgrade | `studio_upgrade` (12) | M6: covers the service-side SDK checkout upgrade (still web-only); the guest OTA self-update has its own tests (`studio_self_update_test.dart`, `state_m6.test.ts`, `studio_guest_update.test.ts`) |
| Visual novel | 50 `novel_*` files | Out of v1 scope unless owner says otherwise |
| WeChat | `wechat` (4), `wechat_routes` (1), `wechat_ui` (1), `wechat_inline_browser` (1) | Out of v1 scope |
| Codex / Bluetooth | `codex` (11), `local_bluetooth` (6), `noble_bluetooth` (6) | Out of v1 scope |
| Layout | `studio_workbench_layout` (1) | Web-only |

## 5. M1 status (shell and transport)

`[~]` in the tables above means: the capability is implemented and tested in the provider/client
(`studio/docs/ARCHITECTURE.md`, frozen table) but the Studio UI for it is not built yet. `[x]` is reserved for
rows with working guest UI. M1 reached: provider with all 37 capabilities, scrubbing, CSRF, SSE streams, service
lifecycle, JS client with verified chunked transfer, shell with rail, project list/open/create, read-only file
tree and viewer. Exit test: `studio/test/studio_host_test.dart` ("the Studio window lists the files of the demo
JS project using capabilities only") passes on the real native library and the real editor service. Not
verified (needs macOS): the app window, IME, on-screen compositing.

## 6. M2 and M3 status (editing, build, logs, live preview)

Exit tests (real native library, real editor service, both on temp copies, never the real `demo/js`):

* M2: `studio/test/studio_edit_test.dart` edits `release.ts` of a temp copy of the Showcase project through the
  Studio guest (tap project, tap file, `textInput.open`/`textInput.edit`, Save) and asserts the bytes on disk.
* M3: `studio/test/studio_preview_loop_test.dart` drives the Studio by pointer taps and the Flutter text overlay
  with auto-build switched on in Settings; each Save produces build -> preview-publish -> child reload and the
  child's frame digests change. It prints `STUDIO_SAVE_TO_PREVIEW_LATENCY`.

Open: asset image preview (no byte capability for `assets/`, no PNG/JPEG decoder in the SDK), asset upload (needs a
file-dialog capability), folder rename, screenshot/copy-link, Cmd/Ctrl+S inside a focused InputField, macOS
verification of compositing, focus and health promotion of the preview child.

## 7. M5 status (publish and inspect)

Pages 发布, 产物, 版本 (stores `publish.ts`, `artifacts.ts`, `versions.ts`; `ARCHITECTURE.md` "Publish and inspect (M5)").

Exit test (Linux part), `studio/test/studio_publish_test.dart`, real native library + real editor service + real signing, on a
TEMP project: the Studio guest builds (Console), publishes a signed **test** update (发布测试包) by pointer taps; the
Studio shows the version, key id, payload digest and the copy button puts the key id on the clipboard; the 版本 page lists the
entry; a client (`PocketHostConfig.load` on the service's test slot -> `PocketSession.initialize` -> `FfiPocketRuntime`)
downloads, verifies and activates that package, its guest output (`PUBLISHED_V1 count 0`) is drawn and an input tap changes
the frame (`count 1`); a second publish (source changed through the service, rebuilt and published by taps) shows two
entries and the same client session activates build N+1 and draws `PUBLISHED_V2`. No byte of the service's key file and no
absolute workspace path appears in anything the host sent to the guest.

Not done / open: the macOS app itself (Linux container); stable-channel publish is covered by guest tests with the fake
service (confirmation, slot) but the real-service exit test publishes only `test`; the web Studio's publish-target picker for
mini apps owned by other projects; one-click archive download; a Resources inspector with placement editing
(`studio.project.resources.*`, still reserved); the 128 KiB inspect limit means a resource snapshot above it is not summarised.

## 8. M6 status (self-hosting, self-update, launcher)

* The Studio opens, edits, builds and publishes its own project (`studio/js`) as a trusted extra root of the service
  (`--extra-project-root`, host configuration only; `sdk/editor/test/editor_extra_roots.test.ts`).
* The Studio SystemUI is configured with its own signed slot (test channel by default) and replaces itself on the user's
  tap through `PocketUpdateCoordinator` and the session health trial; a broken build is rolled back by the SDK
  (`studio/test/studio_self_update_test.dart`, Linux, real library and service).
* `bun pocket.ts editor --pocket [<project>]` launches the macOS host (argument handling and the non-macOS error are
  tested without Flutter: `sdk/scripts/tests/pocket_studio_launcher.test.ts`).
* **Web Studio is legacy** for everything the Pocket Studio covers. The visual novel editor, WeChat preview, Noble Bluetooth
  and Codex stay web-only (owner decision). `--pocket` becomes the default of `bun pocket.ts editor` only after macOS
  acceptance; until then plain `editor` is the web Studio.
* Not verified (needs a Mac): the launcher end to end (`flutter run -d macos`), the macOS app update/replace on screen,
  the IME checklist, compositing and profile frame budgets (unchanged from M3/M4/M5).

## 9. M7 status (hardening) and final parity summary

Done in M7 (Linux, real native library, real service where stated):

* **Record-and-replay UI regression** (`studio/test/studio_recording_test.dart`): the SDK's `PocketRecordingLibrary` records a
  real open -> edit -> save -> build -> publish journey of the real Studio guest against the real service on a temp project;
  the capture is replayed offline in fresh guests (every frame digest must match) and again from the exported archive.
  Semantic checkpoints (normalised; no timestamps, ids, hashes, ports or paths) are compared with
  `studio/test/fixtures/journey_checkpoints.json`.
* **Profiling and leak bounds** (`studio/js/tests/studio_profile.test.ts`, `studio_code_editor_test.dart`): see `PERFORMANCE.md`.
* **Keyboard map** (`studio/js/src/keymap.ts`): Cmd/Ctrl+S, F, B, Shift+B, P (quick-open), W, Shift+[ / ], 1..9, Shift+P, Esc;
  quick-open fuzzy finder; help list in Settings.
* **Shared components** moved to `@pocket/ui` (`Tree`, `SplitPane`, `TabsBar`, `ToastHost`); the Source page is now
  tree | editor | preview dock with two resizable splits whose sizes persist in the Studio settings.

Final status by area (web Studio feature -> Pocket Studio):

| Area | Status |
| --- | --- |
| Projects, create (App/Game), open | [x] |
| Source: tree, tabs, CodeView, find/replace, undo, clipboard, diagnostics, save, conflicts, chunked IO up to 4 MiB | [x] Linux; [~] macOS IME and profile frame budget deferred (`RELEASE_CHECKLIST.md`) |
| Build, cancel, logs, diagnostics jump | [x] |
| Live preview child (signed slot, reload, dock) | [~] proven on the real library; on-screen compositing on macOS deferred |
| Deploy to device | [~] UI and polling done, no real device exercised |
| Publish (test/release), versions, artifacts, offline package | [x] |
| Self-update with rollback | [~] proven on Linux; macOS on-screen replace deferred |
| Keyboard shortcuts, quick-open | [x] Linux (injected key batches); real keyboard on macOS deferred |
| Project settings form, resources placement editor, asset upload, image preview, screenshot/copy-link, diagnostics export, SDK-checkout upgrade | [ ] deferred, see rows above |
| Visual novel editor, WeChat preview, Noble Bluetooth, Codex | — owner decision: web Studio only |
