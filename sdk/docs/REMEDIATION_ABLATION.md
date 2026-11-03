# Remediation ablation

This change removes compatibility layers that had no production caller while
keeping the pinned PocketJS execution and the JSON trace contract unchanged.

## Removed layers

- `sdk/native/src/lib.rs` no longer exports the scalar trace-clock
  `pocket_trace_clock_begin`, `pocket_trace_clock_end`, or the mutable
  `pocket_trace_clock_last_json` follow-up ABI. The Dart bridge already binds
  only `pocket_trace_clock_begin_json`/`end_json`; the JSON envelope preserves
  idle intervals, scalar samples, and Worker/offload facts.
- `sdk/native/src/replay.rs` serializes the completed envelope directly from
  `end_json`. The previous `last_completed`, `last_scalars`,
  `last_worker_events`, and `last_offload_events` copies are gone, so a
  completed transaction is not retained solely for a second getter call.
- The raw-ring `pocket_duplex_get_ring` stub was removed. The live bridge uses
  the v2 endpoint ABI (`pocket_duplex_endpoint_acquire` and its message
  operations), and no Dart or native caller referenced the null-returning
  stub.
- `pocket_bytecode_actual_abi` was removed as a three-line alias. Probes and
  Dart now use the canonical `pocket_bytecode_runtime_abi` symbol.
- `PocketRecordingLimitException` and the unused `PocketRecordingController`
  `completed` getter were removed. Recording quota failures are represented by
  `markIncomplete`, and no constructor/catch site existed for the exception.
- `BuildGuestOptions.target` and the unused string/output overload of
  `buildGuest` were removed. Platform resolution belongs to
  `resolveSystemDocument`; the guest compiler has one option-object entry
  point.
- `_ensureSystemCaps` no longer reconstructs `PocketAppConfig` with a second
  fifteen-field list. `PocketAppConfig.copyWith` is the single
  field-preserving copy boundary used by both plugin attachment and trusted
  capability composition, and snapshots supplied declaration lists.

## Deliberately retained

`PocketRecordingController.recordedBytes` and `stop()` remain because the SDK
recording library and existing public tests use them. The former `demo/js/host.ts`
compatibility barrel was deleted; the small set of Showcase imports now targets
the canonical `@pocket/ui/host` package export directly. No second bridge or
wrapper was introduced.

## Provenance and validation

The retained parent checkout was inspected under
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` with its
`pocket_host/` directory excluded. It contains no implementation of the
removed endpoint or trace aliases; its native bridge uses independent legacy
symbols and is not imported into the SDK. Validation is performed by the
parent agent with the locked Rust, Bun, and serial Flutter suites. The
ablation-specific Rust build uses `CARGO_TARGET_DIR=/tmp/pocket-fix-ablation-target`.
