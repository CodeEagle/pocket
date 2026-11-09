# Visual novel wake deadline audit

This source audit records the finite-deadline scheduling gap, native ingress
accounting and a rejected opt-in Dart transport experiment. The experiment
did not change native or JavaScript scheduling code and is no longer present
in PocketView.

## Finding: finite delays start after the guest turn has already done work

`PocketView._onTick` takes the display delta from Flutter's system frame
timestamps, calls `pocketFrameDeltaAt`, applies the returned frame, and drains
guest events before `_finishGuestOutputDelivery` asks the runtime for its next
wake delay (`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2611-2664,
2026-2049`). The production binary path calls the native frame ABI and parses
the borrowed binary frame before returning (`sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:1121-1175`). When no new work was published during output delivery,
`_finishGuestOutputDelivery` calls `_applyRuntimeScheduleAfterGuestTurn`; that
method obtains a positive delay and arms a Dart `Timer`. When it fires, the
callback starts the ticker, which runs the guest on a subsequent Flutter frame
(`pocket_view.dart:1962-2018`).

Native `pocket_next_wake_delay_ms` returns the cached `Work` deadline. For a
finite timer it calculates `frames * 1000 / hz - tick_remainder_ms`; it does
not subtract elapsed wall time (`sdk/native/src/demand.rs:17-24,80-84`). The
native `capture` currently starts the live `idle_anchor` with `Instant::now()`
at the end of `build_frame`, after guest execution and DrawList decoding
(`sdk/native/src/lib.rs:2905-2925,3227-3232`; `demand.rs:133-140`). Binary
encoding, borrowed-buffer copying/parsing and Flutter frame application happen
after that capture boundary. The delay is therefore still the full nominal
interval when Dart arms its timer; this can push a finite deadline later and
can miss a display refresh. The source proves this scheduling relationship,
not the number of missed refreshes on a device.

This applies to positive finite deadlines. `Work::Continuous` returns zero and
keeps the ticker on vsync; idle with no timer returns negative and parks the
view. The visual-novel clock is a frequent finite-deadline user: while a line,
wait, choice timer, stage transition, camera motion, or model animation needs
time, `attachNovelClock` schedules `after(1 / simulationHz())` and reschedules
after each callback (`sdk/packages/pocket_vn/src/clock.ts:6-42`). At 60 Hz that
is a one-virtual-frame deadline. A parked guest with an external event takes a
different path: the event wakes the ticker directly, and output published
during delivery keeps one following guest turn alive (`pocket_view.dart:917-937,2035-2049`).

## Existing anchors and replay boundary

The same `idle_anchor` also settles wall time before external ingress.
`before_external` takes the anchor, advances idle virtual time, and records
`elapsed_credit_ms`; the next `ticks_for_delta` consumes that credit once
(`sdk/native/src/demand.rs:190-204,279-303`). Replay deliberately has no live
`Instant` anchor: `capture` maintains `trace_idle_pending`, and replay ingress
uses a logical zero elapsed value (`demand.rs:91-98,125-130,284-288`).

This audit does not change that accounting. Any future deadline compensation
must keep “remaining timer delay” separate from advancing or crediting virtual
time. Reusing `before_external` for a timer wake, mutating elapsed credit from
the delay query, or consulting wall time during replay could double count
elapsed time or break replay determinism. The current code and tests do not
establish a safe implementation for such a change.

## Retained parent and test coverage

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected with `pocket_host/` excluded. Its viewport uses a `Ticker` for
transitions and active canvas tabs, derives frame delta from ticker timestamps,
and stops after a 2.5-second interaction timer
(`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:3724-3801`).
It has no equivalent visual-novel deadline snapshot or native wake-delay ABI
to reuse. The JS-owned virtual timer in `pocket_vn/src/clock.ts` remains the
deadline source of truth; this audit identified no need for a Dart narrative
clock.

Existing tests establish timer and idle behavior but not this end-to-end
latency:

- `sdk/packages/pocket_flutter/test/pocket_view_test.dart:950-975` uses a fake
  runtime to verify a 100 ms timer wakes once and then parks. It does not model
  the elapsed time between native capture and Dart timer registration.
- `sdk/native/src/demand.rs:393-425,430-453` checks the nominal finite delay,
  fractional tick remainder, and external-ingress idle settlement. It does
  not test a positive-delay query after simulated capture/bridge work.
- `sdk/packages/pocket_vn/test/clock.test.ts` and
  `sdk/scripts/tests/novel_clock_guest.test.ts:54-89` verify virtual-timer,
  engine-update, and model-step behavior with a deterministic clock or fixed
  frame deltas. They do not measure physical wake cadence.

The source inspection does not quantify the runtime effect. `_onTick` calls do
not equal fixed virtual ticks: one native frame can run multiple fixed steps
during catch-up (`sdk/native/src/lib.rs:2887-2900`).
`FrameTiming` is reported asynchronously and may lack a matching PocketView
context or describe a Flutter frame while the view is parked
(`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2066-2119`). Thus
reported counts such as a number of native turns or `FrameTiming` entries in a
ten-second window cannot be derived from the source or treated as a 60 Hz
guarantee.

To quantify it, a real-device trace should correlate one monotonic timeline
across `vsyncStart`, native guest-frame entry/exit, native demand capture,
Flutter binary-frame decode completion, Timer arm/fire, the next vsync, and the
next native guest turn. It should report guest turns, fixed virtual ticks, and
Flutter `FrameTiming` entries separately. No such trace was collected here.

## `onFrame` alternative: rejected as a direct clock replacement

The pinned framework can make a real frame callback continuous: `FrameRegistry`
gates callback delivery and its scheduler hint with `active`, and
`hasContinuousFrameWork()` makes `getPocketWorkState().continuous` true while
the hint is active (`retina-native-tools-20261108/compiler/framework/src/frame-dispatch.ts:68-97,33-43`,
`work-state.ts:19-31`). Native `Work::Continuous` has a zero-millisecond delay
(`sdk/native/src/demand.rs:16-24`). But public `onFrame` returns `void`; its
registration disposer is only passed to Solid `onCleanup` (`frame.ts:94-111`).
Pinned Solid's `onCleanup` does nothing without an owner
(`sdk/node_modules/solid-js/dist/solid.js:488-490`), so an engine-level clock
without a Solid owner cannot use `attachNovelClock`'s disposer to unregister
that callback. A synthetic root or a lower-level disposable registration would
be required.

The timer phase also differs: `after()` timers fire during `__advanceClock()`;
service pumps, effects, text delivery, and `runFrameHooks` follow
(`framework/src/index.ts:294-312`). `onFrame` runs later inside `runFrameHooks`
(`frame.ts:80-91`). Replacing the timer callback would move a novel tick after
same-frame input and async deliveries, changing established ordering. The
single `onFrame` work hint proves that zero-delay transport is available, but
does not preserve the clock's lifecycle and execution phase.

## Rejected near-deadline ticker experiment

`PocketView._onTick` derives `frameDelta` from successive Flutter frame
timestamps and passes it unchanged to `pocketFrameDeltaAt`; the FFI runtime
sanitizes only non-finite or non-positive values (`pocket_view.dart:2611-2623,2642-2645`,
`pocket_runtime.dart:216-224,1121-1125`). Native `ticks_for_delta` consumes
existing `elapsed_credit_ms` once, while `before_external` is the operation
that creates that credit (`sdk/native/src/demand.rs:192-204,276-303`). Merely
leaving the already-running Ticker active for a short finite delay does not
call `before_external` or add elapsed credit. This is compatible with the
existing virtual clock if the host keeps the same idle settlement behavior on
external ingress: `before_external` still runs and settles the idle anchor
before dispatching the input. PocketView sends pointer edges through its
`input.pointer` event path (`pocket_view.dart:5945-5952`); native binary message
dispatch calls `before_external` before queue/dispatch
(`lib.rs:6443-6466`, `demand.rs:279-303`). Duplex delivery uses the same
settlement (`lib.rs:6095-6100`). No
`_settleIdleTimeOnNextExternal` flag exists in the inspected source; the native
`idle_anchor` is the current mechanism. Do not clear/reset that anchor as part
of the Dart Ticker decision.

The temporary opt-in experiment used `POCKET_NEAR_DEADLINE_TICKER` (default
`false`). For
finite `0 < delay <= 1000 / actualDisplayRefreshRate + 0.001ms`, it cancels the
Dart wake Timer and keeps or starts the existing Ticker for the next vsync. It
does not call `_markRuntimeSleeping()` while the Ticker remains active. The
refresh rate must be finite and positive. Farther finite delays keep the Timer
path; zero/invalid remains continuous and negative remains parked. This host
transport choice does not change `after()`, virtual time, replay, or native
idle-credit accounting.

The one-interval bound is not a general fix. `_refreshHz` comes from the
Flutter display and is independent of the runtime's fixed simulation rate
(`pocket_view.dart:1878-1881,1500-1505`). At a 120 Hz display with a 60 Hz
simulation, a one-step deadline with near-zero tick remainder is about 16.67 ms
while one display interval is about 8.33 ms, so this rule leaves that case on
the Timer path. With roughly 8.33 ms already in `tick_remainder_ms`, the native
remaining delay can fit the threshold. The rule therefore covers only some
120/60 phase alignments; it does not generally cover a deadline that needs two
display pulses. Exact equality and variable-refresh scheduling also need care
because a Timer firing at a vsync boundary may still schedule the next pulse.

Pinned Flutter 3.47.9 validation on 2026-11-08:

- `flutter analyze --no-pub lib/src/pocket_view.dart test/pocket_view_test.dart`:
  no issues.
- `pocket_view_test.dart` with the default flag: 23/23 passed; log
  `/tmp/pocket-view-near-deadline-default-20261108.log`, SHA-256
  `a5bbac9708e3035492f9a3c671c5c95cf2681ff0a57380580bfd0933ecf9c581`.
- The same file with `--dart-define=POCKET_NEAR_DEADLINE_TICKER=true`: 23/23
  passed; log `/tmp/pocket-view-near-deadline-enabled-20261108.log`, with the
  same SHA-256 because the expanded test output is identical.

The added widget test supplies a 16.67 ms scheduling hint through the existing
`PocketRuntimeScheduling` seam. With the flag enabled it observes the existing
Ticker active, a guest frame on the next pumped vsync and then parking after a
negative/no-work hint. With the default flag it observes the prior Timer path.
Existing tests continue to cover the 100 ms Timer, negative idle, zero-delay
continuous work, pause and runtime replacement. This is Flutter widget
scheduler coverage, not a native FFI integration or device refresh-rate test.

The later five-window macOS profile did not show a meaningful benefit, so the
near-deadline branch, flag and dedicated widget test were withdrawn. The
candidate's five `nativeCalls` counts were 333, 320, 361, 345 and 346 (1,705
total); the earlier SSAA2 comparison total was 1,924. These totals are
recorded as observations only and do not establish a causal cadence change.
The retained log is `/tmp/pocket-mesh-span-near-deadline-cost-20261108.log`,
archived with the SSAA2 comparison under
`sdk/.pocket-build/mesh-span-ssaa-ab-20261108/cost-near-deadline/`.

The temporary widget test established only fake-runtime scheduling behavior.
The Profile measurements used a 60 Hz macOS display and do not cover 120 Hz
display timing, native `elapsed_credit_ms` under this Dart change, or other
physical devices. The experiment was rejected and makes no latency or
performance claim.
