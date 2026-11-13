# M0 report: audit and spikes

Date: 2026-11-13. Branch: `ccr-0ab29827-46orrx`, based on `main` at `f59d2df`.

**Status: M0 is not complete.** The audit is done: `PARITY.md`, the capability audit and the
conflict list below. The approved SDK prerequisites for the spikes have landed (section 10). None
of the three spikes has a measured result yet, because they need macOS, so the M0 exit test fails.
M1 must not start yet (ground rule 1).

## 1. Why the spikes have no measurements

This work ran in a Linux cloud container. All three spikes need things it does not have:

| Need | State in this container |
| --- | --- |
| macOS Apple Silicon + Flutter (`.fvmrc` pin) | Linux x86_64, no `flutter` or `fvm`. Pocket has no Linux host, so `PocketView` cannot run here at all. |
| Pinned PocketJS upstream (`scripts/prepare_upstream.py`) | Resolved later: GitHub serves only attached repos to the codeload tarball endpoint. The pinned commit was fetched with git and exported into `sdk/.cache/pocketjs`, then `prepare_upstream.py` applied its patches and contract checks. |
| Native library | Resolved later: builds once the upstream cache exists. |
| CJK IME, hardware keyboard | No display or IME. |

Spike results were not estimated or simulated (ground rule 10, AGENTS.md "validate actual JS
execution"). They must run on a Mac. Section 4 gives each spike a written procedure and a pass
criterion. Section 3 lists the code findings that already change what the spikes must prove.

## 2. Conflicts between AGENTS.md and the handover brief (AGENTS.md wins)

| # | AGENTS.md says | Handover says / reality | Resolution |
| --- | --- | --- | --- |
| C1 | Delegate execution work to Argon Low via `agy`; if that model is unavailable, report it and get a model choice instead of substituting. | `agy` is not installed in this container. | **Waiting on owner.** Only read-only audit and docs were done here. Before M1 code, the owner must say which agent or model runs execution work. |
| C2 | Work inside `/Volumes/ORICO/Development/Github/pocket`. | The checkout here is `/home/user/pocket`. | Paths in docs are repo-relative. `check_architecture.py` already rejects `/Volumes/` in source. |
| C3 | Source first: inspect the retained parent `pocketjs_flutter_demo` before implementing a capability. | That repo is not available here. | Must happen on the owner's machine before M1 (`StudioProvider`) and M4 (editor). Record the findings in `sdk/docs/`. |
| C4 | Record source paths, retained behaviour and validation for new capabilities in `sdk/docs/`. | The brief puts docs in `studio/docs/`. | Studio planning docs stay in `studio/docs/`. Every SDK change (multi-line `InputField`, raw key input, clipboard, fs routes) gets its own `sdk/docs/` record. |
| C5 | Dart is limited to Flutter/FFI/IO boundaries, with no second Dart state machine. | The brief proposes a `StudioProvider` Dart plugin. | Keep the provider a stateless route map: an allowlisted capability name maps to a fixed HTTP route, credential injection, and stripping of absolute paths. Polling, retry and orchestration live in the Studio guest (JS). |
| C6 | Hosts are thin. `check_architecture.py` caps `demo/lib/main.dart` at 100 lines and forbids extra Dart files. | The Studio host needs a provider. | Put the provider in an SDK package (`sdk/packages/pocket_studio`, which does not import `studio/`) and keep `studio/lib/main.dart` as thin as the demo. Extend `check_architecture.py` with the same rules for `studio/`. |
| C7 | The editor already ships a web-preview **and** a self-upgrade path. | The brief's M6 "Studio updates itself through OTA" | There are two upgrade systems: the npm SDK self-upgrade (`studio_upgrade.mjs`) and guest OTA. M6 means guest OTA for the Studio bytecode; the service keeps the npm upgrade. |

## 3. Findings that change the plan

### 3.1 Text input (affects Spike A, M2 and M4; highest risk)

1. **Hardware keys never reach `GuestFrame.text` in the Flutter host.** `PocketView._handleKeyboardEvent`
   (`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1189`) maps keys only to a gamepad-style
   button bitmask through `keyboardButtonMap`. `PocketController.sendTextEvent` (`:241`) exists, but
   nothing in the SDK or the demo calls it. On Flutter, only the web preview (`editor/preview.ts:4871`)
   produces `keyDown`/`keyUp` events.
2. **The native text event has no modifiers.** `TextEvent::Key { key, pressed, repeat }`
   (`sdk/native/src/lib.rs:3111`) has no Shift/Ctrl/Alt/Meta field. A guest-drawn editor therefore
   cannot tell Cmd+S, Cmd+Z or Shift+Arrow apart. `commit` and `composition` text is capped at 4096
   bytes per event, which is fine for typing but rules out large paste through `commit`.
3. **`InputField` is single-line only.** `@pocket/ui` hard-codes `maxLines: 1` in its `textInput.open`
   payload (`sdk/packages/pocket_ui/src/ui.tsx:1748`), although the host already parses
   `maxLines`/`minLines`. The M2 "multi-line `InputField`" needs an SDK change first (ground rule 6).

So Spike A has to start with an SDK change: a host-side raw text-input mode on `PocketView`. It
would forward `KeyEvent` and a `TextInputClient`/`DeltaTextInputClient` composition into
`input.text`, and add a modifier mask to `TextEvent::Key` in Rust and to the upstream event type.
The upstream type is not inspectable here: `.cache/pocketjs` is missing. Check
`framework/src` for an existing modifiers field before adding one.

### 3.2 Text rendering (Spike B)

- `PocketTextLayoutCache` capacity is fixed at 256 per `PocketView`
  (`pocket_view.dart:913`, `pocket_text_cache.dart:12`). It is not configurable per guest yet. A
  60-line viewport with 5–10 tokens per line needs 300–600 distinct runs, so the default **will**
  thrash. Making it configurable is an SDK change, and Spike B should measure both 256 and ~2048.
- QuickJS heap is configurable up to 2 GiB (`docs/APP_MEMORY_LIMITS.md`), so Studio's heap tier is
  not a blocker.

### 3.3 Preview child guest (Spike C)

- `PocketSystemHost` (`sdk/lib/src/pocket_system_host.dart`) mounts children from a **trusted
  catalog fixed at startup** (`appId → surfaceHandle` 2–63, `docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md`).
  Children load from bundled assets or signed OTA (`downloadOnOpen`, `docs/ON_DEMAND_MINI_APPS.md`).
  There is no API to load an unsigned, freshly built `app.qjbc` + `app.pak` into a child slot and
  reload it per build.
- Two options for Spike C. Pick after measuring.
  - (a) Publish each preview build through the existing local version backend (test slot, dev key)
    and let the child pick it up through the signed update path. It reuses everything and adds no
    new trust path, but adds per-build signing latency.
  - (b) Add an SDK API for a Studio-only "dev child". It loads bytes handed over by the host for a
    `build id`, never for a path. This needs a security review because it bypasses signing.
  - Fallback from the brief: a second window with its own `PocketView`.
- The preview child must not inherit Studio capabilities. Child configs cannot self-grant
  compositor access today, which matches what is needed. Capabilities must be granted per app id.

### 3.4 Host capabilities audit

| Capability | Present? | Evidence | Gap |
| --- | --- | --- | --- |
| Clipboard | No | No clipboard code in `sdk/lib`, `sdk/packages`, `@pocket/ui` | New `studio.clipboard` provider (text), or better a general `pocket.clipboard` SDK plugin |
| File/folder dialog | No | No `file_selector`/`file_picker` dependency | Needed for "open project from disk" and asset import; the service limits projects to its workspace or `--project-root` anyway |
| Window menu bar | No | No `PlatformMenuBar` usage | macOS menu (File/Edit) needed for M7 shortcut map |
| Keyboard shortcuts | Only Esc-to-exit in `PocketSystemHost` (`:696`) | see 3.1 | Depends on modifier support |
| Generic HTTP to service | Yes: `pocket_dio` with exact `allowedOrigins` | `sdk/packages/pocket_dio` | Using it directly would hand the guest `/health`'s CSRF token and absolute paths, which breaks ground rule 3. Reuse its IO-worker pattern inside the provider instead. |
| Capability streams | Yes | `pocket_services/lib/src/pocket_stream.dart`, `docs/JS_HOST_STREAMS.md` | none |

### 3.5 Service gaps (fix in `sdk/editor`, with tests, without weakening guards)

- No routes for file rename/delete, folder create/delete, `stat`, ranged read/write or watch.
- No build cancel. No build event stream (clients poll `/status`). No structured diagnostics with
  file and line. Logs are capped at 200 lines of up to 4096 chars.
- Assets are a flat `assets/` directory with a filename pattern; no subfolders.

### 3.6 Scope the brief did not know about

The web Studio also contains a visual-novel editor (≈10k lines of client JS plus `novel.ts`),
WeChat mini-program preview, Noble Bluetooth preview, Codex integration (UI already removed),
device deploy, resource placement and version management. `PARITY.md` marks VN, WeChat,
Bluetooth and Codex as out of v1 scope. **The owner must confirm this before M6 cutover**, because the
brief says not to delete the web Studio without asking. Keeping the web Studio for those tools after
M6 is the default.

## 4. Spike procedures (to run on Apple Silicon)

All timings from `flutter run --profile -d macos`, never debug. Record the machine, macOS version and Flutter version.

**Spike A: input events.** Prerequisite: SDK raw text-input mode plus modifiers (3.1). Throwaway
guest that logs every `onTextEvent`. Checklist: letters, Shift, Cmd/Ctrl/Alt combos, arrows, key
repeat (hold 2 s), Backspace/Delete, Pinyin (Squirrel or system), Japanese Kana, composition cancel
(Esc), dead keys (Option+E then e), selection replace during composition. Pass: every item yields
the expected ordered events with correct UTF-16 selection, and none is lost or doubled.

**Spike B: text rendering.** Guest renders a 5,000-line TSX file as virtualized `text` nodes, about
60 visible lines with per-token colours. Measure p50/p95/p99 frame build+raster time while scrolling
continuously for 10 s, and text-cache `hitCount`, `layoutCount` and `evictionCount` (`PocketTextLayoutCache`),
with capacity 256 and 2048. Pass: p95 < 8.3 ms at 120 Hz, or < 16.6 ms at 60 Hz, and no steady-state evictions with the larger cache.

**Spike C: preview.** Load a second guest's bytecode into a child `CompositorSurface` and reload it
after a rebuild, via option (a), then (b) if (a) is too slow. Measure save → first new child frame
latency. Pass: reload works without restarting Studio; latency < 1.5 s for the counter fixture
(`sdk/editor/test/fixtures/counter`).

## 5. Capability names: provisional, not frozen

The handover says to freeze them at the end of M0. They are **not frozen**: Spikes A and C can still
change `studio.fs` chunking and the `studio.preview` shape. Current mapping to real routes:

| Capability.call | Route |
| --- | --- |
| `studio.project.list/create/open` | `GET/POST /api/projects`, `GET /api/projects/:id` |
| `studio.project.settings.get/set` | `GET/PUT /api/projects/:id/config` |
| `studio.fs.tree` | `GET /api/projects/:id/files` + `GET …/assets` |
| `studio.fs.read/write` | `GET/PUT /api/projects/:id/files/<rel>`, `POST …/assets` (multipart) |
| `studio.fs.rename/delete/stat`, `watch` | **new routes needed** |
| `studio.build.start/status` | `POST …/build`, `GET …/status` |
| `studio.build.cancel`, `events` | **new route / stream needed** (stream can start as provider-side poll of `/status`, but polling belongs in the guest per C5) |
| `studio.logs.tail` | `GET …/logs` |
| `studio.preview.deploy` / `devices` | `POST/GET/DELETE …/deploy[/:job]`, `GET /api/devices` |
| `studio.preview.load/reload/close` | host-side (Spike C), keyed by build id |
| `studio.publish.plan/publish/history` | `GET …/publish-targets`, `POST …/publish`, `GET …/versions` |
| `studio.artifacts.list/inspect` | `GET …/status` (artifacts) + `GET …/artifacts/<name>` |
| `studio.clipboard.read/write` | host-side, new |

## 6. Decisions taken on defaults

- Repo location: top-level `studio/` (this commit creates `studio/docs/` only).
- Host target: macOS only.
- Backend: Bun service unchanged so far. Additive routes are planned (3.5).
- Language features: tokenizer highlighting only.
- Code surface: no decision possible until Spikes A and B run. The fallback (a native widget in a `surface`) was **not** chosen and needs owner approval.

## 7. Validation commands run

Initial M0 run: only `check_architecture.py` and `bun install` could run (upstream blocked, no
Flutter). After the environment was fixed (section 8) the full suite ran twice: on clean `main`
(`f59d2df` plus docs) and on the branch after all SDK changes. Results below are the branch; every
failure is also present on `main` unless stated.

Environment notes: Linux x86_64, Flutter 3.47.9, `POCKET_SOURCE_BUILD=1` (the prebuilt
`@pocket/tools-linux-x64` package is not installed, so `pocket_probe`/`pocketjs_bytecode` are built
from the pinned source), and Playwright's expected `chromium_headless_shell-1248` pointed at the
installed 1243 build.

| Command | Result |
| --- | --- |
| `python3 sdk/scripts/check_architecture.py` | Pass |
| `sdk/native`: `cargo test --locked` | Pass |
| `sdk`: `flutter test` | Pass |
| `sdk`: `flutter analyze` | No errors outside `packages/pocket_vn/node_modules` (a `bun install` copy of a Dart package) |
| `sdk/packages/pocket_flutter`: `POCKET_NATIVE_LIBRARY=… flutter test` | 305 pass, 1 skip (needs a capture fixture dir) |
| `sdk/packages/pocket_services`: `flutter test` | Pass |
| `sdk/packages/pocket_clipboard`: `flutter test` | 13 pass |
| `sdk`: `TMPDIR=/tmp bun test` | Fails on `main` too (59 tests with the browser fix). The branch run's extra failures all pass when the file is run alone on the branch; they were load flakiness or a missing debug `pocket_probe` binary. |
| `demo`: `flutter test` | Fails on `main` too: `official_demo_catalog_test.dart` |
| `demo`: `flutter analyze` | 1 error on `main` too: `integration_test/novel_performance_test.dart:79` |
| `demo/js`: `bun test` | 34 failures, identical on `main` |
| `demo/js`: `bash scripts/test_guest.sh` | Pass |

## 8. Owner decisions (2026-11-13)

1. Execution work is delegated to **Sonnet** workers in place of Argon Low (C1). Workers do not
   spawn agents and do not revert each other's edits.
2. Environment access: a personal `pocket` cloud environment now allows `codeload.github.com`
   (pinned PocketJS) and `storage.googleapis.com` (pinned Flutter). Validation is repeated there.
   Profile timings and IME checks for the spikes still need a Mac.
3. **Confirmed out of v1 scope:** VN editor, WeChat preview, Noble Bluetooth, Codex. The web
   Studio keeps serving them after M6. It is not deleted.
4. **Approved SDK changes:** raw text input with modifiers, multi-line `InputField`, configurable
   text-cache size, clipboard plugin, new fs/build service routes, preview child loading path.
   Each lands in `sdk/` with tests and an `sdk/docs/` record (C4).

## 9. Re-cut estimate

M2 and M4 each grow by about one week for the SDK text-input work in 3.1, which has to land before
either can start. M3 grows by about one week if Spike C needs option (b). The other estimates stand until the spikes report.

## 10. SDK prerequisites landed on this branch

Implemented by Sonnet workers, then a consolidated Sonnet review with fixes. Each has an
`sdk/docs/` record.

| Commit | Change | Doc |
| --- | --- | --- |
| `38ab9b9`, `f43bcd2` | Optional `pocket_clipboard` plugin (`clipboard.readText/hasText/writeText`, separate read/write grants, 192 KiB bound) and `@pocket/ui/clipboard` | `sdk/docs/CLIPBOARD_PLUGIN.md` |
| `5480400`, `f43bcd2` | Multi-line `InputField`; `PocketView(textLayoutCacheCapacity:)` with cache stats; `modifiers` on `input.text` keys folded into key names; guest-requested raw key/IME sessions (`textInput.rawOpen/rawUpdate/rawClose`) | `sdk/docs/STUDIO_TEXT_INPUT.md` |
| `ea90f56`, `6de1d65` | Service routes: stat, file delete/move, folders, chunked read and uploads, watch SSE, build cancel, build events SSE, structured diagnostics; async cancellable `buildGuest` (still serialised in-process) with a 15 min timeout | `sdk/docs/EDITOR_FS_AND_BUILD_ROUTES.md` |

Still open before Spike C: the preview child loading path (option a or b in 3.3) is approved but
not implemented. It needs the Spike C measurement on macOS to choose between them.
Still open for Spike A: the macOS IME checklist in `sdk/docs/STUDIO_TEXT_INPUT.md`.
Known residual weakness (unchanged, documented): the constant `x-pocket-editor: 1` header passes
the write credential check; `status.error`/`logs` can carry absolute paths and must be scrubbed by
the Studio host provider.
