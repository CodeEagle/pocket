# Flutter Host Diagnostics (`pocket_diagnostics`)

## 1. Source Inspection & Provenance

Before implementing the Dart diagnostics package and Flutter host integration, we inspected the retained parent repository (`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`):

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart`:
  - Retained bounded circular history (`_maxSamples = 120`) and explicit non-blocking metric collection.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`:
  - Retained the pattern of capturing actual runtime execution facts (`runtime.eval`, `runtime.frame`, `runtime.lastError`) at the host execution boundary while delegating UI presentation and policy to the application layer.
- `/Volumes/ORICO/Development/Github/pocket/sdk/lib/src/performance_history.dart` and `/Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_recordings.dart`:
  - Retained the thin-host adapter pattern (`PocketRecordingLibrary.attach(config, controls: ...)`), serialized disk writes, atomic file replacement via temporary `.tmp` files, and `path_provider` application-support directory resolution.
- `/Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_diagnostics/src/{types.ts,normalize.ts,collector.ts,browser.ts,node.ts}`:
  - Aligned the Dart schema and normalization bounds with the sibling TypeScript `@pocket/diagnostics` implementation in the same package directory.

## 2. Architecture & Thin-Host Boundaries

In accordance with `AGENTS.md`:
- **No Second State Machine**: Flutter/Dart captures only actual native/Dart error boundaries (`FlutterError.onError`, `PlatformDispatcher.onError`), `PocketSession` lifecycle/recovery boundaries (`session.ready`, `session.first_frame`, `session.healthy`, `session.mount`, and `_logCandidateFailure` at `onError` / `mount-failure` / `initialize-admission-failure`), and durable local JSONL file I/O.
- **JS Owns Policy**: UI routing, diagnostic filtering, and presentation remain in JS. SystemUI (or any trusted diagnostic surface granted `controls: true`) can query, log, record crashes, export, or clear persisted host diagnostics via the `pocket.diagnostics` capability plugin (`diagnostics.log`, `diagnostics.crash`, `diagnostics.list`, `diagnostics.export`, `diagnostics.clear`).
- **Pre-Fallback Crash Capture**: `PocketSession._logCandidateFailure` invokes `PocketHostDiagnostics.recordSessionCrash` at the exact failure boundary (`runtime-recovery`, `mount-failure`, `initialize-admission-failure`) **before** fallback/rollback replaces `active`, resets `_candidate`, or advances/restores the session generation.
- **No Per-Frame Log Spam**: Session logs are emitted only at discrete lifecycle transitions (`session.ready`, `session.first_frame`, `session.healthy`, `session.mount`), never on every frame.
- **Non-Swallowing Error Chaining**: `attachFlutterErrorCollector` is opt-in, chains to any previously registered `FlutterError.onError` and `PlatformDispatcher.onError` callbacks, and preserves the exact boolean return semantics of `PlatformDispatcher.onError` (returning `false` when no prior handler existed so unhandled fatal exceptions are never silently swallowed).
- **Honest Persistence Guarantees**: Records are serialized and appended to bounded JSONL files (`diagnostics.jsonl` plus rotated `.1`..`.N` segments) with `flushSync()` on crash records and atomic temp-file rewrites on compaction/recovery. Truncated trailing lines from unexpected process termination are healed on reopen. No speculative native `SIGKILL` guarantees are claimed beyond already-flushed journal lines.
- **Fatal Handoff**: File storage also exposes its same append routine through the optional `SynchronousDiagnosticsStorage` boundary. Flutter error hooks call `tryRecordCrashSync` before invoking the previous handler or returning `false` to the engine. This avoids losing a queued crash when the engine terminates immediately. Custom asynchronous stores remain best effort at fatal handoff; queued ordinary logs may not survive termination. No separate crash journal or duplicate write queue is added.

## 3. Package & SDK Integration Summary

### `sdk/packages/pocket_diagnostics` (Dart Side)
- `pubspec.yaml`: Dart/Flutter package metadata (`name: pocket_diagnostics`).
- `lib/pocket_diagnostics.dart`: Public barrel export.
- `lib/src/types.dart`:
  - `DiagnosticRecord` (`DiagnosticLogRecord`, `DiagnosticCrashRecord`) with `schemaVersion: 1`, `id`, `kind: "log" | "crash"`, `timestamp`, `seq`, `severity`, `message`, `tag`, `durationMs`, `source`, `projectId`, `sessionId`, `runtimeId`, `revision`, `context`, `error` (`NormalizedDiagnosticError`), `unhandled`, `data`, `recentLogIds`, `recentLogs`.
  - `DiagnosticExportBundle` (`format: "pocket-diagnostics-export"`, `schemaVersion: 1`, `exportedAt`, `totalRecords`, `logCount`, `crashCount`, `context`, `records`).
- `lib/src/normalize.dart`:
  - `normalizeDiagnosticError`, `normalizeDiagnosticData`, `normalizeDiagnosticContext` with circular reference detection, depth/node/array/string/byte bounds, and extraction of `FlutterErrorDetails` and `PlatformException` details.
- `lib/src/collector.dart`:
  - `DiagnosticsCollector`, `MemoryDiagnosticsStorage`, `createDiagnosticsCollector` with serialized async queue, recent log ring buffer (`recentLogIds` / `getCrashRecentLogs`), `list` / `listRecords`, `exportRecords` / `exportJson`, and selective `clear`.
- `lib/src/file_storage.dart`:
  - `FileDiagnosticsStorage`, `FileDiagnosticsCollector`, `createFileDiagnosticsStorage`, `createFileDiagnostics` with symlink rejection, trailing partial-line healing on reopen, size-based segment rotation (`.1`..`.N`), and `maxRecords` compaction.
- `lib/src/flutter_adapter.dart`:
  - `FlutterErrorCollector` / `attachFlutterErrorCollector` for opt-in `FlutterError.onError` and `PlatformDispatcher.onError` capture and `detach()` restoration.

### `sdk/lib` & `demo/lib` Integration
- `sdk/lib/src/pocket_diagnostics.dart`: `PocketHostDiagnostics` and `_DiagnosticsPlugin` (`pocket.diagnostics` capability provider).
- `sdk/lib/src/pocket_config.dart`: Added optional `PocketHostDiagnostics? diagnostics` to `PocketAppConfig`.
- `sdk/lib/src/pocket_session.dart`: Integrated `config.diagnostics` at session initialization, mount, first-frame, health promotion, `_logCandidateFailure` (pre-fallback crash capture), and `close()`.
- `sdk/lib/src/pocket_system_host.dart`: Added `diagnostics` to `PocketSystemHost` and `PocketSystemHostApplication`, automatically wiring a shared `PocketHostDiagnostics` instance across `systemUI` (with `controls: true`) and child runtimes.
- `demo/lib/main.dart`: Added optional `diagnostics` parameter to `pocketHostApp(...)` and wired opt-in Flutter/PlatformDispatcher error capture in `main()`.

## 4. Validation

- `cd sdk/packages/pocket_diagnostics && flutter analyze && flutter test`
  - Verified normalization bounds, schema round-trip, real temp directory JSONL persistence and reopen, partial trailing line recovery, rotation and `maxRecords` pruning, concurrent write serialization, symlink rejection, and `FlutterError.onError` / `PlatformDispatcher.onError` handler chaining.
  - Nine tests pass, including a regression that reads the crash from disk inside the prior unhandled-error callback, before it returns control to the engine. The regression failed with the previous async-only hook.
- `cd sdk && flutter analyze lib test/pocket_diagnostics_integration_test.dart && flutter test test/pocket_diagnostics_integration_test.dart`
  - Verified `PocketSession.onError` pre-fallback crash capture to disk and `PocketSystemHost` `diagnostics.*` capability bridge.
- `cd demo && flutter analyze lib/main.dart test && flutter test`
  - Verified Showcase host compatibility and all existing demo unit/admission/contract tests.

Final review corrections: Showcase resolves the persistent collector and installs its hooks before `runApp`; diagnostics setup failure is reported to the console without blocking app startup. Host `flush()` now waits for an already pending directory lookup. A delayed-directory regression verifies both flush and close retain previously admitted logs and crashes. Removed unused schema alias getters/parser fallbacks and unused package dependencies; one canonical JSON schema and the existing append routine remain.

Final verification uses the repository's `.fvmrc` Flutter 3.47.9 (Dart 3.13.7):
package tests (9), SDK diagnostics/host tests (14), Demo tests (54), and scoped
analyzers. When switching Flutter versions, regenerate SDK `build/unit_test_assets`
and `build/test_cache`; an old compiled ink-sparkle shader is incompatible with
the newer engine's runtime-stage verifier.
