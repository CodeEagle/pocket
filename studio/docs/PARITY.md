# Pocket Studio parity inventory (M0)

Source of truth: `sdk/editor/server.ts`, `sdk/editor/preview.ts`, `sdk/editor/novel.ts`,
`sdk/editor/diagnostics.ts`, `sdk/editor/client/index.html` and `sdk/editor/client/editor.js`
at commit `f59d2df`. Every row was read from code, not from the handover brief.

Status column: `[ ]` not started in the Pocket Studio, `[x]` reached parity, `—` deliberately out of
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
| GET | `/health` | R | `{ok, service, pid, version, csrfToken, bluetooth, workspace, projectRoot?, projectId?, flutterRoot?, updatePackageVersion?}` | host-internal (lifecycle) | [ ] |
| GET | `/` , `/<name>.css|js` | R | web client static files | — (web only) | — |
| GET | `/api/studio/upgrade` | R | upgrade status | `studio.service.upgrade.status` | [ ] |
| POST | `/api/studio/upgrade/check` | W | `{autoApply?, forceApply?}` | `studio.service.upgrade.check` | [ ] |
| POST | `/api/studio/upgrade/apply` | W | → 409 in source checkouts | `studio.service.upgrade.apply` | [ ] |
| GET | `/api/preview/device` | R | preview device profile | `studio.preview` | [ ] |
| GET | `/api/devices` | R | `flutter devices --machine` list | `studio.preview.devices` | [ ] |
| GET | `/api/codex/status`, `/api/codex/models` | R | Codex availability | — (UI removed from web Studio) | — |

### 2.2 Projects, config, files

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects` | R | project list with status | `studio.project.list` | [ ] |
| POST | `/api/projects` | W | `{id, template: app|game, ...config}` → 201 | `studio.project.create` | [ ] |
| GET | `/api/projects/:id` | R | config + status | `studio.project.open` | [ ] |
| GET/PUT | `/api/projects/:id/config` | R/W | `EditorConfig` merge; bumps revision | `studio.project.settings.get/set` | [ ] |
| GET/PUT | `/api/projects/:id/source` | R/W | `{path:"app.tsx", source, bytes, revision}`; ≤16 MiB, no NUL | `studio.fs.read/write` (alias) | [ ] |
| GET | `/api/projects/:id/files` | R | `{files:[{path, bytes}], revision}` editable text files only | `studio.fs.tree` | [ ] |
| GET/PUT | `/api/projects/:id/files/<rel>` | R/W | `{path, content, bytes, revision}`; ≤16 MiB, UTF-8, no NUL | `studio.fs.read/write` | [ ] |
| GET/PUT | `/api/projects/:id/manifest` | R/W | raw `manifest.json`; PUT ≤256 KiB | `studio.fs.read/write` (manifest) | [ ] |
| GET | `/api/projects/:id/assets` | R | `{assets: string[]}` flat names under `assets/` | `studio.fs.tree` (assets) | [ ] |
| POST | `/api/projects/:id/assets` | W | multipart `file`, ≤32 MiB, safe flat name | `studio.fs.write` (asset, chunked) | [ ] |
| GET/PUT | `/api/projects/:id/resources` | R/W | resource inventory / placements `{revision, packageId, placements}` | `studio.artifacts.resources` | [ ] |
| GET | `/api/projects/:id/resources/preview?revision&package&key` | R | thumbnail image | `studio.artifacts.resources` | [ ] |

**Missing on the service (needed by M2):** file rename, file delete, folder create/delete, `stat`,
watch/notify, ranged (chunked) read/write, nested asset folders. Add them to `server.ts` with the
same `safeProjectFile` guards and tests in `editor_server.test.ts`. The web Studio will gain them too.

### 2.3 Build, logs, artifacts

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/projects/:id/build` (alias `/compile`) | W | `{}` → 202 + status; queued `buildGuest` | `studio.build.start` | [ ] |
| GET | `/api/projects/:id/status` | R | `EditorStatus` (revision, builtRevision, busy, error, last 200 logs, artifacts, publish) | `studio.build.status` | [ ] |
| GET | `/api/projects/:id/logs` | R | `{logs: string[≤200], error}`; lines ≤4096 chars | `studio.logs.tail` | [ ] |
| GET | `/api/projects/:id/artifacts/<name>` | R | one of `app.js app.qjbc app.bytecode.json app.pak guest-manifest.json build.json app.worker.qjbc app.worker.bytecode.json` | `studio.artifacts.inspect` | [ ] |
| GET/POST | `/api/projects/:id/diagnostics` | R/W | diagnostics export / record | `studio.logs.diagnostics` | [ ] |

**Missing on the service (needed by M3):** build cancel, a build-event stream (today clients poll
`/status`), structured diagnostics (file, line, column, message). Logs are plain strings.

### 2.4 Preview and deploy

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/:id/preview` (`page`) | R | web preview document | — (replaced by child guest) | — |
| GET | `/api/projects/:id/preview/stream` | R | SSE frames from `pocket_probe` | — (replaced) | — |
| POST | `/api/projects/:id/preview/input` | R* | pointer/text/semantic/resize events | — (replaced) | — |
| GET | `/api/projects/:id/preview/status`, `/snapshot` | R | preview session state | `studio.preview.status` | [ ] |
| GET/HEAD | `/api/projects/:id/preview/resource`, `/media?asset=` | R | resource bytes | — (child guest reads its own pack) | — |
| GET/POST | `/api/projects/:id/deploy` | R/W | `{deviceId}` → 202 deployment job | `studio.preview.deploy` | [ ] |
| GET/DELETE | `/api/projects/:id/deploy/:job` | R/W | job status / cancel | `studio.preview.deploy` | [ ] |
| GET/POST/DELETE | `/api/projects/:id/wechat` | R/W | WeChat mini-program preview | — (v1 out of scope; ask owner) | — |
| POST/GET/DELETE | `/api/projects/:id/codex/turn[/:turn]` | W/R/W | Codex turn | — (removed from web UI) | — |

`*` preview input is a POST but still passes the write-credential check.

### 2.5 Publish, versions, update hosting

| Method | Path | Auth | Payload / response | Studio capability | Parity |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/:id/publish-targets?channel=test|release` | R | target summary, reusable packages | `studio.publish.plan` | [ ] |
| POST | `/api/projects/:id/publish` (alias `/package`) | W | `{channel?: test|release}` → manifest, URLs, packages | `studio.publish.publish` | [ ] |
| POST | `/api/projects/:id/package-offline` | W | offline archive URL | `studio.publish.offline` | [ ] |
| GET | `/api/projects/:id/versions` | R | version backend snapshot (slots, history) | `studio.publish.history` | [ ] |
| GET/HEAD | `/updates/…`, `/pocket/…`, `/test/pocket/…`, `/stable/pocket/…` | R | signed manifests and blobs for clients | not a guest capability (served to devices) | n/a |
| GET | `/releases/:id[/<release>].tar.gz` | R | release archives | `studio.publish.history` (download link) | [ ] |

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
| Shell | Project switcher, project title/subtitle/state | `project-switcher`, `projects`, `project-title`, `project-state` | M1 | [ ] |
| Shell | New project dialog with App/Game template | `new-project`, `create-dialog`, `create-form` | M1 | [ ] |
| Shell | Left rail: stage, source, console, resources, settings, versions | `rail-*` | M1 | [ ] |
| Shell | Notice toast | `notice*` | M1 | [ ] |
| Shell | Studio self-upgrade bar | `studio-upgrade-*` | M6 | [ ] |
| Source | File picker, source editor, save, reload, bytes/revision, split toggle, close | `file-picker`, `source`, `save`, `refresh-source`, `source-*` | M2 / M4 | [ ] |
| Preview | Viewport picker, phone bezel toggle, regions overlay, resize height | `viewport-picker`, `preview-bezel-toggle`, `toggle-regions`, `resize-preview-height` | M3 | [ ] |
| Preview | Refresh, capture screenshot, copy preview link | `refresh-preview`, `capture-preview`, `copy-preview-link` | M3 (link is web-only) | [ ] |
| Preview | Child app surfaces | `preview-surfaces` | M3 | [ ] |
| Preview | Local Bluetooth (Noble) toggle | `web-bluetooth-toggle`, `bluetooth-provider` | — (ask owner) | — |
| Console | Build tab: build button, state, log, clear | `build`, `build-state`, `log`, `clear-log` | M3 | [ ] |
| Console | Deploy tab: device picker, deploy, cancel, log | `device-picker`, `deploy`, `deploy-cancel`, `deploy-log` | M3 | [ ] |
| Console | Signing tab: publish test, target picker, channel, reused packages | `publish-test`, `publish-target-*` | M5 | [ ] |
| Console | Artifacts tab: artifact list, runtime ABI | `artifacts`, `runtime-abi` | M5 | [ ] |
| Inspector | Resources: package picker, placement list, save | `resource-*`, `save-resources` | M5 | [ ] |
| Inspector | Settings: name, title, appId, version, build, tickHz | `config-*` | M1 | [ ] |
| Inspector | Versions: backend origin, slots, history, host guide, app config | `version-*` | M5 | [ ] |
| Tools | Export diagnostics | `export-diagnostics` | M7 | [ ] |
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
| Self-upgrade | `studio_upgrade` (12) | M6 |
| Visual novel | 50 `novel_*` files | Out of v1 scope unless owner says otherwise |
| WeChat | `wechat` (4), `wechat_routes` (1), `wechat_ui` (1), `wechat_inline_browser` (1) | Out of v1 scope |
| Codex / Bluetooth | `codex` (11), `local_bluetooth` (6), `noble_bluetooth` (6) | Out of v1 scope |
| Layout | `studio_workbench_layout` (1) | Web-only |
