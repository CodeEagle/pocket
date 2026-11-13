# Editor service: filesystem, transfer, watch and build-control routes

Additive routes in `sdk/editor/server.ts` for the Pocket-hosted Studio. The web Studio is unchanged and
keeps using the old routes. All paths below are under `/api/projects/:id/`.

## Source-first record

- The retained parent repo `pocketjs_flutter_demo` is **not available in this environment**, so no
  retained implementation could be inspected or reused. The routes are new, evidenced by the service gaps
  in `studio/docs/M0_REPORT.md` section 3.5.
- Reused `server.ts` helpers (no path policy was duplicated): `safeProjectFile` (relative-only paths, protected
  dirs/files, editable extensions, per-segment lstat symlink checks, `isDirectory`/`mustExist` options),
  `writeProjectFile` (parent creation, `O_NOFOLLOW`, post-write re-validation), `safeChild`,
  `lstatIfExists`, `parseJsonBody`, `asString`, `pathFailure`, `pushLog`, `saveState`, `publicStatus`,
  `validateRequestSecurity` (peer/Host/Origin/fetch-metadata/CSRF), the `projectWrites` admission lock and the
  Codex/WeChat/deploy busy checks, `maxSourceBytes`, `ignoredProjectInputDirectories`,
  `protectedDirectoryNames`, `editableFilePattern`, `protectedFilePattern`, and the preview SSE convention
  `server.timeout(request, 0)`.
- Build code reused: the single `queueBuild` -> `buildProject` -> `runner` (`realBuild` -> `buildGuest`) path.
  There is no second build route.

## Guards (apply to every route)

- Read routes (`GET`) pass the existing read guards. `POST/PUT/DELETE` need `x-pocket-csrf: <token from /health>`
  (a wrong token is always 403) or the existing constant editor header; this is the unchanged
  `validateRequestSecurity` check at the top of `fetch()`.
- File/folder `POST`, `PUT`, `DELETE` and upload `POST/PUT` take the `projectWrites` admission lock (409 if another
  project operation is in flight) and are refused with 409 while Codex, a WeChat build or a device build owns the
  project. `DELETE files/...` and `DELETE folders/...` were added to that admission set; other DELETE routes
  (deploy, wechat, codex) and `DELETE uploads/:id` (memory only) are unchanged.
- Every successful mutation does `revision += 1`, clears `error`, `diagnostics` and `publish`, `pushLog`s
  (`file deleted: ...`, `file moved: a -> b`, `folder created: ...`, `file uploaded: ...`) and `saveState`s.
- Paths: relative only; `..`, `.`, empty segments, NUL, a leading `/` are 400. Backslashes are treated as
  separators. Percent-encoded segments are decoded first (`%2e%2e%2f` becomes `../` and is refused). Protected dirs
  (`assets builds updates keys node_modules .git .pocket-build`), protected files (`editor.json`, `pocket.json`,
  `*.pem`, ...) and non-editable extensions (`ts tsx js jsx json svg css md` only) are refused. A symlink leaf, a
  symlinked parent or a symlink anywhere in the chain is refused.

## Routes

| Method | Path | Payload / response | Limits and errors |
| --- | --- | --- | --- |
| GET | `stat/<rel>` | `{path, kind:"file"\|"directory", bytes, mtimeMs, editable}`. `editable:false` only for an existing regular file whose name passes all protection rules but has a non-editable extension (for example `.png`). Directories bytes = 0. | 404 missing or not reportable, 400 policy/dot-prefixed segment. The project root is not addressable. Only editable source files (normal file policy) and plain files below `assets/` (existing `allowAssets` policy, `editable:false`) are reported; any other file (for example `secret.txt`, `ui/pic.png`) is 404, exactly like a missing one. |
| DELETE | `files/<rel>` | `{path, revision}`; deletes one existing editable file. | 404 missing; 400 directory/protected/symlink. |
| POST | `files-move` | `{from, to, overwrite?:false}` -> `{from, to, revision}`. Both ends go through `safeProjectFile`; target parents are created; `rename()`. | 409 if target exists without `overwrite:true`; target directory (cross-type) and non-editable target names are refused (400/409); 404 missing source; `from == to` is 400. Files only. |
| POST | `folders` | `{path}` -> `{path, created, revision}`; recursive mkdir, idempotent (200 if present, 201 if created). | Protected dirs and generated/ignored dirs (`assets builds updates keys node_modules .git .pocket-build build dist out`) at any depth are 400. |
| DELETE | `folders/<rel>` | `{path, revision}`; removes an **empty** directory. | 409 if not empty; same protected-name refusals; the project root cannot be removed. |
| GET | `chunks/<rel>?offset=N&length=M` | `{path, offset, length, totalBytes, sha256, mtimeMs, data}`; `data` is base64, `sha256` is of the whole file. | `length` default and max 131072 (larger values are clamped; `length` in the reply is what was read). `offset == totalBytes` returns an empty chunk, beyond that is 400. Files over 16 MiB are 413. Whole-file hashes are cached by path+size+mtime (64 entries). |
| POST | `uploads` | `{path, totalBytes, sha256}` -> 201 `{uploadId, chunkBytes, expiresInMs}`. | Path validated now and again at commit. `totalBytes` max 16 MiB (413). Max 4 open uploads per project and 8 server-wide (429, distinct messages). A global budget of 64 MiB of buffered, uncommitted upload bytes (`maxBufferedUploadBytes` option) is enforced when a chunk is PUT: over budget is 429 `upload buffer budget exhausted`; bytes are released on commit, abort, expiry and `server.stop()`. `uploadId` is `randomUUID()`. |
| PUT | `uploads/:uploadId` | `{offset, data(base64)}` -> `{uploadId, received, totalBytes}` | Each chunk 1..131072 raw bytes (413); canonical base64 only (400); offset must equal bytes received so far (409); total may not exceed `totalBytes` (413). The 131072 limit keeps the JSON body below the 256 KiB host/JSON cap. |
| POST | `uploads/:uploadId/commit` | `{}` -> `{path, bytes, sha256, revision}` | 409 if incomplete, 422 on sha256 mismatch, 400 for NUL bytes or invalid UTF-8; then `writeProjectFile`. A failed commit keeps the session so it can be aborted or retried. The session is single-use. |
| DELETE | `uploads/:uploadId` | `{uploadId, aborted:true}` | 404 unknown. |
| GET | `watch` | SSE. First `{type:"ready", revision}`; then `{type:"change", path, kind, event:"change"\|"rename"}` and `{type:"revision", revision}`. | Max 16 concurrent watch streams server-wide (429); idle timeout disabled with `server.timeout(request, 0)`. Cross-origin guard and SSE backpressure apply (see below). |
| POST | `build/cancel` | `{}` -> 200 `{cancelled:true, status}` once the build has really settled (waits up to 10 s). If it is still busy after the wait (a shared-cache bootstrap step cannot be interrupted, see Cancellation) the answer is 202 `{cancelled:false, pending:true, status}`; poll `status`/`build/events`. | 409 when no build is queued or running. |
| GET | `build/events` | SSE. First `{type:"status", status}` (with the log tail); then `{type:"status", status}` on every saved state change with `logs: []` (log lines already arrive as `log` events; this keeps events under the provider per-event cap), `{type:"log", line}` per log line, `{type:"done", ok, builtRevision, diagnostics}`. | Max 32 streams (429). Cross-origin guard and SSE backpressure apply. No timer: events are pushed from `pushLog` and `saveState`, which every mutation already calls. |

Upload sessions live in memory (max 8 x 16 MiB), are bound to the project id (another project gets 404), expire
after 10 minutes without activity (a per-session unref'd timeout reset on activity, not a polling timer), and are
dropped on `server.stop()`.

### Watch behaviour

- One `fs.watch(projectDir, {recursive:true, persistent:false})` per project is shared by all its watch clients and
  closed when the last client disconnects or when the server stops.
- Events are debounced 100 ms and coalesced per path (any `rename` in the window wins). Hidden entries
  (`.something`), `node_modules`, `.git`, `.pocket-build`, build/output dirs, `assets`, `keys`, `updates`, protected
  files, non-editable files and symlinks are filtered with the same policy as the file API.
- Directory entries are reported only for `rename` (create/remove/move); directory `change` is entry churn and is dropped.
- A deleted path no longer exists, so it is classified by name: editable-looking leaf = file; a dotted non-editable
  leaf is dropped; an undotted leaf = directory. A deleted directory whose name contains a dot is therefore not reported.
- The `revision` event is sent when the Studio service itself saves state with a new revision (any of its mutation
  routes, including the old PUT routes).
- Platforms: macOS (FSEvents) and Windows support `recursive`; Linux supports it on Node >= 20 and Bun (tested on
  Bun 1.4.4/Linux, inotify). Where recursive watching is not available the route answers 501 instead of silently
  watching only the top directory. Network and some container mounts may drop events; clients should re-list on
  reconnect. File editors that save by replace report `rename`.

### Cancellation

The compiler pipeline is `buildGuest`, which used to run each step with `spawnSync`. That blocked the whole editor
process (no request, including a cancel, could be served during a compile). `sdk/scripts/build_guest.ts` now runs
the same commands with async `spawn`, streams their output line by line to the log, and accepts an optional
`signal: AbortSignal`. On abort the step's process group is sent `SIGTERM` (then `SIGKILL` after 2 s; `child.kill`
on Windows), so a `cargo run` parent and its compiler child both die, and the build rejects with `build cancelled`.
`queueBuild` owns one `AbortController` per project; `buildProject` also checks the signal before and after the
runner and before the artifact swap, so a cancelled build never publishes. Final state: `busy:false`,
`error:"build cancelled"`, `builtRevision` unchanged, `diagnostics:[]`, a `build cancelled` log line and a `done`
event with `ok:false`. A cancel that arrives after the artifact swap has no effect (the build already succeeded).
Side effect: two projects can now compile concurrently instead of being serialized by the blocking spawn.

Hardening added after the consolidated review:

- **Abort while queued.** `buildGuest` serializes builds through an in-process queue (shared pinned cache). A build
  queued behind another project's build now rejects with `build cancelled` as soon as its signal aborts; its queue
  slot is still released only after the slot ahead of it, so a later build can never start before the earlier running
  one finishes. The cancel route only reports `cancelled:true` (200) once `busy` is false.
- **Catalog sub-packages.** The build `AbortSignal` is passed through `buildResourceSnapshot` into the sub-package
  `buildGuest` calls, so cancel/timeout/stop reach them.
- **Shared-cache bootstrap is never killed.** `prepare_upstream.py` and the frozen `bun install` of the pinned cache
  mutate state shared by every project. An abort during one of them lets the step finish, then the build rejects with
  `build cancelled` before the compile step. Only per-project compiler/bytecode steps are killed. Consequently a cancel
  can stay `pending` (202) for the duration of such a step.
- **Server stop.** `server.stop()` aborts every in-flight build `AbortController`, so detached compiler process groups
  are terminated instead of orphaned.
- **Build timeout.** Each build attempt is aborted after `buildTimeoutMs` (`startEditor` option; env
  `POCKET_EDITOR_BUILD_TIMEOUT_MS`; default 15 minutes). The final state is `busy:false`, `error:"build timed out"`,
  `diagnostics:[]`, a `build timed out` log line and `done` with `ok:false`. The timeout aborts like a cancel, so the
  same bootstrap rule applies.
- **Output decoding.** Compiler stdout/stderr are read with `setEncoding("utf8")`, so multi-byte characters split
  across pipe chunks (CJK messages) are not corrupted.

### Request guards specific to the new routes

- **Editor workspace guard.** When the editor workspace lives inside the project (the default `<project>/.pocket-editor`,
  or a custom `--workspace` directory under it), `files` (GET/PUT/DELETE), `chunks`, `stat`, `folders`, `files-move`
  (both ends) and `uploads` (path) fail 400 `path is inside the editor workspace`, checked lexically and via the
  workspace realpath. `.pocket-editor` is also a protected directory name, and `chunks` rejects dot-prefixed segments
  like the other routes. The workspace holds trusted host config, preview slots and build state.
- **Cross-origin reads.** `GET watch`, `GET build/events`, `GET chunks/...` and `GET stat/...` answer 403 when an
  `Origin` header is present and is not the server's own origin (same comparison as the write guard, including
  `Origin: null`), or when `Sec-Fetch-Site` is `cross-site` or `same-site`. Header-less clients (the Pocket host,
  curl) are unaffected. Pre-existing GET routes are unchanged.
- **Dot-prefixed segments.** `stat`, `DELETE files`, `files-move` (`from` and `to`), `POST/DELETE folders` and
  `uploads` (`path`) answer 400 for any path segment starting with `.` (`.ssh`, `.env`, `a/.cache`).
- **SSE backpressure.** Each stream has a queue of 256 unread events (`CountQueuingStrategy`). A consumer that lets
  the queue fill is dropped: the stream is closed (after delivering the backlog) and its slot released. Clients
  must reconnect and re-list/`status` (the first event of each stream is a fresh `ready`/`status`).
- **Watch cost.** `fs.watch` has no ignore option in Bun/Node, so the recursive watcher still installs inotify
  watches on every directory including `node_modules` and `.git` (a per-project inotify cost). Events from hidden,
  generated and protected trees are discarded at once, before debouncing/pending storage.

### Sensitive data: sanitize before forwarding to a guest

Only `diagnostics` is sanitized (project-relative `file`, project directory stripped from messages, outside paths
dropped). `status.error`, `status.logs` and the SSE `status`/`log` events carry raw compiler output and pre-existing
log lines, which can contain **absolute filesystem paths** of the editor machine (workspace, SDK checkout, toolchain
cache). Their contents are intentionally unchanged. The Pocket Studio host provider must scrub them (or forward only
`diagnostics`) before handing anything to a guest.

### Error codes (new routes)

| Code | Meaning |
| --- | --- |
| 400 | path policy, dot-prefixed segment, path inside the editor workspace, bad base64/JSON |
| 403 | cross-origin/cross-site read, missing or wrong credential |
| 404 | missing or unreportable path, unknown upload, project |
| 409 | busy/conflict, non-contiguous chunk, no active build to cancel |
| 413 | chunk/total/file over limit |
| 422 | sha256 mismatch |
| 429 | open-upload cap (4 per project / 8 global), upload byte budget, watch/event stream cap |
| 202 | cancel requested but build still busy (`pending:true`) |

### Structured diagnostics

`EditorStatus.diagnostics?: Array<{file, line, column, severity, message}>` is present only while `error` was set by
a failed build. It is parsed from the complete compiler output of that build (not from the 200-line `logs` window)
by `parseBuildDiagnostics`. Real formats observed from the pinned toolchain:

1. Babel parse errors from the JSX transformer: `SyntaxError: <abs file>: Unterminated JSX contents. (2:15)`.
   Babel prints a 0-based column, so 1 is added.
2. `bun build` errors: `error: Could not resolve: "./nope"` followed by `    at <abs file>:3:25` (1-based).
3. A generic `<file>:<line>:<col>: error|warning: message` line.

`file` is project-relative with `/` separators; absolute paths outside the project are dropped (project and
real-path roots are both accepted) and the project directory is stripped from messages. Logs are unchanged.
Known limit: for `bun` resolution errors the reported line is the position in the JSX-lowered intermediate module,
which can be offset from the original source (the file and message are exact). Babel syntax errors point at the
original source line.

## Validation

Run from `sdk/` (the source-built tools are used, `POCKET_SOURCE_BUILD=1`):

```
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun test editor/test/editor_fs_routes.test.ts
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun test editor/test/editor_build_control.test.ts
POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bun test editor/test/editor_server.test.ts
```

They start the real editor service. `editor_fs_routes.test.ts` covers every FS/transfer/watch route plus traversal
(`..`, absolute, backslash, `%2e%2e`), protected files/dirs, symlink leaf and symlinked parent, missing/wrong
credential, oversize chunk/upload, sha mismatch, non-contiguous chunk, NUL and invalid UTF-8, non-empty folder
delete, upload binding/bounds/abort, and an external write producing a watch event (plus filtering, debounce,
watcher bound and slot release on disconnect). `editor_build_control.test.ts` uses the real `buildGuest` for the
syntax-error and unresolved-import diagnostics, the successful build event sequence and a real mid-compile cancel
(asserting that no compiler process for the project survives), and a deterministic injected slow runner for the
abort/event semantics. It also covers the queue (a build queued behind another is cancelled promptly without letting
a third overtake), the timeout, abort on stop, UTF-8 chunk decoding and the uninterruptible bootstrap rule.
