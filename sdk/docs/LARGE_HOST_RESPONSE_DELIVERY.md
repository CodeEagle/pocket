# Large host.response delivery and guest turn-budget failures

Report (Studio M2): reading a file above 240 KiB with `studio.fs.readChunk`
(each response is up to 128 KiB raw, about 171 KB of base64 plus the JSON
envelope) never completed. The second large `host.response` looked as if it was
never delivered to the guest.

## Findings

The inbound transport is not the cause. Evidence, all on the real native
runtime:

* `pocket_send` / `pocket_send_binary` apply only the 4 MiB inbound binary cap.
  The 256 KiB message and 1 MiB / 1024-message limits in `lib.rs`
  (`MAX_BRIDGE_*`) apply to the guest to host (outbound) queue, not to inbound
  responses. The probe `send` op and the Dart FFI `send` add no further limit.
* Three back-to-back responses of 100, 180, 200 and 250 KB, in one tick and on
  consecutive ticks, are delivered through the probe, through a live
  `ProbeSession`-style driver that answers each request as its frame arrives,
  and through `FfiPocketRuntime` (`pocket_large_response_ffi_test.dart`).
* In the Studio guest a hook on `__pocketEvent` showed both responses reach the
  guest and `handle()` runs, but no Promise continuation of the second one ever
  runs afterwards.

Root cause (two layers):

1. The guest, not the transport. Studio decodes base64, verifies SHA-256 and
   UTF-8-decodes the file in pure JS inside the Promise continuation that runs
   when the last chunk arrives. For a file above about 170 KB that continuation
   takes longer than the 250 ms per-turn budget
   (`guest-rquickjs`, `begin_turn(Duration::from_millis(250))`, patch
   `guest-execution-budget.patch`). QuickJS interrupts it, the async function
   dies, and the Promise stays pending. The "about 170 KB" threshold is the
   total file size at which that work crosses 250 ms, which is why it looked
   like a size limit on the second message (the first chunk's decode alone
   still fits in a turn). Files up to 240 KiB use the single-call
   `studio.fs.read` path and never do this work, so they were unaffected.
2. The probe hid the failure (`native/src/bin/pocket_probe.rs`,
   `frame_response_mode`). The native runtime reports a failed frame as a valid
   empty frame plus `pocket_last_error` ("Guest: Pocket guest execution
   interrupted by budget ..."), and the Flutter runtime throws
   `PocketRuntimeException` from it after every frame
   (`pocket_runtime.dart`, `lastError` checks). The probe ignored
   `pocket_last_error` and answered `{"ok":true,"frame":<empty>}`, so harness
   tests saw a silent stall instead of an error.

## Fix

* `pocket_probe`: after `pocket_frame_for_probe_json`, a non-empty
  `pocket_last_error` is returned as `{"ok":false,"error":"pocket_frame failed:
  ..."}`, matching the FFI runtime. This is the only product code change.
  `ProbeSession` (studio) drops non-frame lines, so such an error now surfaces
  there as `pocket_probe frame timed out` instead of a silent clean frame; it
  should route `ok:false` lines to its frame waiters.
* No native inbound limit or queue changed. The documented limits stand:
  control message 256 KiB, native outbound queue 1024 messages / 1 MiB, inbound
  binary message 4 MiB.
* The functional fix for Studio is in the Studio guest (the Studio worker landed an incremental `Sha256` and per-turn slicing, after which a 260000-byte chunked read completes end to end): keep each
  continuation under the 250 ms turn budget (decode/hash/decode-UTF-8 per chunk
  as it arrives, or yield between chunks across frames, or raise the threshold
  for the single-call path), or avoid pure-JS SHA-256 on the whole file.

## Validation

* `sdk/native/src/demand.rs`:
  `async_continuation_aborted_by_turn_budget_fails_the_frame` (the budget abort
  is reported through `pocket_last_error`).
* `sdk/packages/pocket_ui/test/large_host_response_native.test.ts` (real
  probe): large back-to-back delivery (100..250 KB, same tick and later ticks),
  live sequential delivery, and "a continuation over the turn budget is an
  explicit probe frame error" (fails without the probe change).
* `sdk/packages/pocket_flutter/test/pocket_large_response_ffi_test.dart`
  (real FFI library): large back-to-back delivery and the explicit
  `PocketRuntimeException` for a budget-aborted continuation.
