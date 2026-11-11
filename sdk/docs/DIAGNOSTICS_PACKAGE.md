# Pocket Diagnostics Package (`@pocket/diagnostics`)

## Windows journal creation

Build 42978280004 passed macOS consumer acceptance but Windows Studio startup
failed when Bun 1.3.9 opened a missing journal with numeric `O_CREAT` flags.
The Windows adapter uses portable Node modes `a`, `wx` and `r+`; POSIX retains
numeric `O_NOFOLLOW`. Existing directory/file symlink checks, exclusive temporary
files, rotation and crash fsync remain. The release workflow now runs the actual
diagnostics disk suite on both platforms before packaging. A fresh nested Studio
workspace regression covers first append, exclusive rewrite, close and reopen.

## Source-first review and retained behavior

Before implementing `@pocket/diagnostics`, the retained parent repository at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`) and the current SDK storage/logging modules were inspected:

1. **Retained parent demo (`pocketjs_flutter_demo`)**:
   - [`lib/core/perf_monitor.dart`](file:///Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart) and [`lib/ui/mini_app_host_page.dart`](file:///Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart) implement `PocketPerfLogEntry` and `PocketPerfMonitor.recordLog({tag, detail, durationMs, isJank})`, keeping a rolling in-memory 50-entry list (`historyLogs`) with `clearHistory()`. It does not persist logs across restarts or capture structured JS/Studio crash records.
   - [`lib/core/pocketjs_bundle_runner.dart`](file:///Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart) keeps an in-memory `lifecycleEvents` list and forwards selected timings to `PocketPerfMonitor`.
2. **Current SDK (`sdk/`)**:
   - [`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts) maintains per-project `state.logs` (200 lines) and `state.error` in `workspace/states/<id>.json`.
   - [`sdk/editor/novel-history.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/novel-history.ts) and [`sdk/editor/novel-backups.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/novel-backups.ts) establish the SDK's workspace file-safety patterns: `O_NOFOLLOW` symlink refusal, real-directory verification, bounded UTF-8 byte budgets, and exclusive `.tmp` write + `fsync` + atomic `rename`.
   - [`sdk/packages/pocket_ui/src/value_snapshot.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/value_snapshot.ts) and [`sdk/packages/pocket_ui/src/recording.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/recording.ts) establish bounded JSON value snapshots and `RecordedError` (`{name, message, code}`).

**Necessary adaptation**:
Neither the retained parent nor the existing SDK had a reusable, runtime-neutral JS/TS package for structured crash collection and durable bounded log/crash persistence across restarts. `@pocket/diagnostics` (`sdk/packages/pocket_diagnostics`) fills this gap with a portable core and an explicit Node/Bun JSONL journal adapter so Pocket Studio (`editor/server.ts`, `editor/preview.ts`), browser clients, and tools can record, query, export, and persist logs and crash records without duplicating state machines or adding external dependencies.

---

## Package architecture & entrypoints

`sdk/packages/pocket_diagnostics` exposes clean, separated entrypoints in [`package.json`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_diagnostics/package.json):

- **`@pocket/diagnostics` ([`src/index.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_diagnostics/src/index.ts))**: Portable core (`types.ts`, `normalize.ts`, `collector.ts`, `browser.ts`). Contains **zero** `node:*` or `bun:*` imports so it can run inside browsers, Web Workers, QuickJS guests, or custom hosts.
- **`@pocket/diagnostics/node` and `@pocket/diagnostics/file` ([`src/node.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_diagnostics/src/node.ts))**: Explicit Node/Bun file persistence adapter providing `createFileDiagnostics()` and `createFileDiagnosticsStorage()`.
- **`@pocket/diagnostics/browser` ([`src/browser.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_diagnostics/src/browser.ts))**: Opt-in browser/worker `error` and `unhandledrejection` listener adapter.

### Ablation & non-duplication of recent log state

When a storage backend sets `preservesLogHistory: true` (such as the JSONL file journal in `createFileDiagnosticsStorage()` or `createMemoryDiagnosticsStorage()`), preceding log entries are already persisted in sequence in the journal. Rather than duplicating full log payloads inside every crash record, `recordCrash()` in `"auto"` mode records only lightweight `recentLogIds` on the crash record and resolves the full `DiagnosticLogRecord` entries on demand via `getCrashRecentLogs(crashOrId)`. When a consumer supplies a crash-only storage (`preservesLogHistory: false`), `recordCrash()` automatically embeds bounded `recentLogs` summaries so crash context is still preserved.

---

## Public API reference

### 1. Portable Core (`@pocket/diagnostics`)

- **`createDiagnosticsCollector(options?: DiagnosticsCollectorOptions): DiagnosticsCollector`**
  - `options.storage`: Custom `DiagnosticsStorage` implementation (defaults to bounded `createMemoryDiagnosticsStorage()`).
  - `options.context`: Default `DiagnosticContext` (`{ source, projectId, sessionId, runtimeId, revision }`) merged into every recorded log or crash unless overridden per call.
  - `options.maxRecords`: Maximum records retained (default `500`).
  - `options.recentLogLimit`: Number of recent logs associated with a crash (default `20`).
  - `options.recentLogMode`: `"auto"` (default) | `"ids"` | `"summaries"` | `"none"`.
  - `options.normalization`: Custom bounds (`maxDepth`, `maxNodes`, `maxArrayLength`, `maxObjectKeys`, `maxStringLength`, `maxStackLength`, `maxCauseDepth`, `maxDataBytes`).
- **Collector methods**:
  - `recordLog(input: DiagnosticLogInput | string): Promise<DiagnosticLogRecord>`
  - `recordCrash(errorOrInput: unknown, overrides?: Omit<DiagnosticCrashInput, "error">): Promise<DiagnosticCrashRecord>`
  - `list(query?: DiagnosticQuery): Promise<readonly DiagnosticRecord[]>`
  - `listLogs(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticLogRecord[]>`
  - `listCrashes(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticCrashRecord[]>`
  - `getCrashRecentLogs(crash: DiagnosticCrashRecord | string, limit?: number): Promise<readonly DiagnosticLogRecord[]>`
  - `exportRecords(query?: DiagnosticQuery): Promise<DiagnosticExportBundle>`
  - `clear(filter?: DiagnosticClearFilter): Promise<number>`
  - `flush(): Promise<void>`
  - `close(): Promise<void>`
  - `getContext()` / `setContext(partialContext)`
- **Safe normalization helpers**:
  - `normalizeDiagnosticError(error, limits?)`: Extracts `name`, `message`, `stack`, `code`, nested `cause` chains (detecting circular cause loops), `AggregateError.errors`, and extra enumerable fields into `details` while catching throwing getters.
  - `normalizeDiagnosticData(value, limits?)`: Produces strictly JSON-serializable bounded data, replacing circular references with `"[Circular]"`, non-finite numbers (`NaN`, `Infinity`) with strings, `BigInt` with `"<n>n"`, binary buffers with byte-length tags, and enforcing node/depth/byte budgets.
- **Portable storage adapters**:
  - `createMemoryDiagnosticsStorage({ maxRecords?, maxBytes?, preservesLogHistory? })`
  - `createKeyValueDiagnosticsStorage({ storage, key?, maxRecords?, maxBytes? })` (for `localStorage` / `sessionStorage` or custom sync key-value stores)
- **Opt-in Browser Collector (`@pocket/diagnostics` or `@pocket/diagnostics/browser`)**:
  - `attachBrowserErrorCollector({ collector, target?, context?, captureWindowErrors?, captureUnhandledRejections?, onCrashRecorded? }): BrowserErrorCollectorHandle`
  - Attaches `error` and `unhandledrejection` listeners without calling `preventDefault()` or swallowing errors, and returns `{ active, detach() }`.

### 2. Node / Bun File Persistence (`@pocket/diagnostics/node`)

- **`createFileDiagnostics(options: FileDiagnosticsOptions): FileDiagnosticsCollector`**
  - Combines `createFileDiagnosticsStorage(options)` and `createDiagnosticsCollector(options)`.
  - `options.directory`: Target directory for the JSONL journal (verified as a real directory, not a symlink).
  - `options.filename`: Journal filename (default `"diagnostics.jsonl"`).
  - `options.maxFileBytes`: Active segment size threshold before rotating to `.1`, `.2`, ... (default `512 KiB`, minimum `1024` bytes).
  - `options.maxRotatedFiles`: Maximum rotated segment files retained (default `3`).
  - `options.maxRecords`: Maximum total records retained across segments (default `500`).
  - `options.syncOnLog`: Whether to `fsync` every log append in addition to crash records (default `false`; crash records always `fsync`).

---

## Durability, rotation, and recovery guarantees & limits

1. **Serialized concurrent writes**: Both `DiagnosticsCollector` and `FileDiagnosticsStorage` serialize operations through an internal promise queue so concurrent `recordLog()` and `recordCrash()` calls never interleave mid-line in the JSONL file.
2. **Crash flush guarantee**: `recordCrash()` passes `{ sync: true }` to storage and invokes `handle.sync()` (`fsync`) before resolving, ensuring crash records reach disk immediately.
3. **Partial final write recovery**: If a previous process died mid-write leaving an unterminated or truncated final JSONL line, opening the journal detects the incomplete trailing line, increments `storage.recoveredPartialLines`, preserves all valid preceding records, and atomically heals the active file before appending new records.
4. **Symlink refusal**: Journal directories and files are checked with `lstat` and opened with `O_NOFOLLOW` where supported. Symlinked journal targets are rejected.
5. **Known operating system limits**:
   - **Abrupt `SIGKILL` / power loss / kernel panic**: An untrapped `SIGKILL` (`kill -9`), native hard abort, or sudden power loss terminates the OS process immediately without giving JavaScript a chance to run an exception handler. Therefore, an **unseen crash** that IS the `SIGKILL` itself cannot be captured in-process by JS.
   - **Survival of prior records**: All crash records and flushed log records written and completed prior to an abrupt `SIGKILL` survive on disk and remain readable when the journal is reopened.
   - **No global process exception swallowing**: `@pocket/diagnostics` does not install `process.on("uncaughtException")` handlers that swallow fatal process errors and leave a corrupted Node/Bun process running. Host entrypoints that choose to log fatal process errors should await `diagnostics.recordCrash(err)` / `diagnostics.close()` and allow normal termination.

---

## Validation

Run from `sdk/packages/pocket_diagnostics` or `sdk/`:

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun test packages/pocket_diagnostics/test/diagnostics.test.ts
python3 scripts/check_architecture.py
```

The test suite (`packages/pocket_diagnostics/test/diagnostics.test.ts`) validates:
- Zero `node:` / `bun:` imports in portable core files.
- Error normalization across nested causes, circular `cause` chains, self-referential objects, `BigInt`, and throwing getters.
- Data depth, array length, string truncation, and UTF-8 byte budget enforcement.
- Consumer-provided `DiagnosticsStorage`, `KeyValueDiagnosticsStorage`, query filters, export bundles, and selective clearing.
- Opt-in browser `error` and `unhandledrejection` collection and clean `detach()` without `preventDefault()`.
- Real disk persistence across reopen, recent log ID linking and resolution, 60 concurrent writes serialization, truncated final line recovery and healing, segment rotation and `maxRecords` retention, selective project clear on disk, and symlink rejection.
