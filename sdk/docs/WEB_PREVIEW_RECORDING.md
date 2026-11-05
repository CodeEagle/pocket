# Web preview recording

The retained parent was inspected first (`mini_apps/`, `lib/`, and its public
Flutter integration, excluding `pocket_host/`). It has no portable Editor
recording transport to reuse. The format and lifecycle remain the existing
`sdk/lib/src/pocket_recordings.dart` library and
`sdk/packages/pocket_flutter/lib/src/pocket_recording.dart` /
`pocket_runtime.dart` implementation: explicit start arms a fresh guest, native
transactions carry trace-clock facts, and replay creates an independent guest.

The evidenced gap was `sdk/editor/preview.ts`: the web host rejected every
`diagnostics.recording.*` request as unsupported. The preview now implements
start/status/stop/replay/export through that existing capability bridge. The
Showcase uses the same RecordingPanel requests on both hosts.

## Native boundary adaptation

`sdk/native/src/bin/pocket_probe.rs` exposes the existing trace ABI without
changing the pinned engine: `traceMode`, per-command `traceClock`, and a
`traceBoundary` transaction. `load`, `loadBytecode`, and `eval` optionally render
their initial frame in the same native transaction, matching the Flutter FFI
boundary. Explicit compositor configuration can also carry its native envelope.
An unconsumed/malformed replay envelope fails; the probe never substitutes
synthetic clock/random facts.

The Editor records only after an explicit Start request. It waits for the old
serialized response turn to finish, restarts the existing runtime lifecycle,
and enables tracing before bytecode load. Ordinary preview frames do not clone
recording payloads, hash frames, or maintain a parallel history. Entry bytes are
counted incrementally. Stop disables native trace mode and leaves the preview
interactive.

## Archive compatibility

Export writes `pocket.recording.archive` version 1 with content-addressed assets
and canonical `pocket.runtime.recording` entries. Runtime creation belongs in
metadata; it is never encoded as an invented auxiliary entry. Pure UI traces
retain the existing version 1 contract; actual version 2 native fact envelopes
select version 2. Missing native facts make capture incomplete.

Frame digests adapt the native JSON to the canonical Flutter decoded fields,
including image tint, surface descriptors, null fields, and Dart's distinction
between geometry doubles and colour/resource integers. Upstream input tapes
remain optional archive metadata and are not injected again during native
transaction replay.

The preview's replay projection drives a new pinned native probe. An independent
cross-host check also loads the exported file with
`PocketRecordingLibrary.replayArchive` and the existing FFI replay runner; a
self-consistent TypeScript replay alone is insufficient evidence.

## Validation (2026-11-05)

- `cargo test --manifest-path sdk/native/Cargo.toml --bin pocket_probe`: native
  clock/random record/replay matches; surplus replay facts fail.
- `bun test editor/test/preview_recording.test.ts` (from `sdk/`): real
  host-request handling, fresh runtime, input capture, post-stop input,
  native replay and on-disk archive export pass.
- `sdk/test/preview_recording_archive_ffi_test.dart`: the resulting archive
  passes the canonical SDK loader and native replay runner. Set
  `POCKET_PREVIEW_RECORDING_ARCHIVE` to the exported `recordings.json` and
  `POCKET_NATIVE_LIBRARY` to the matching built native library, then run
  `flutter test test/preview_recording_archive_ffi_test.dart` from `sdk/`.
- `preview_recording_browser.test.ts`: two Chromium cases pass with the real
  Showcase, covering visible controls, Start, fresh-runtime resource delivery,
  replay/export and a destroyed child capture. The exported child/root archive
  also passes the independent SDK FFI replay check with the matching optimized
  native library.
- The native release library suite passes 90 tests; the probe's trace-clock
  regression passes separately. The optimized probe is available through the
  existing freshness resolver, with the same pinned engine/bytecode ABI.

Browser hardware without a registered real host provider remains unsupported;
recording does not manufacture successful camera/Bluetooth/platform results.
