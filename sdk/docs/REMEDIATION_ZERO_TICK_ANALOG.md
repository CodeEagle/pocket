# Zero-tick analog input remediation

## Source and retained behavior

The retained parent checkout was inspected at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding
`pocket_host/`). Its native runtime keeps input sampling at the frame boundary;
this repair preserves that contract in the thin Pocket host rather than adding
a second input scheduler or advancing virtual time from an input callback.

## Gap and change

`HostState::run_virtual_frames` already emitted a zero-tick GuestFrame for text,
external work, relative axes, and motion, but omitted non-neutral left/right
analog samples. A zero-delta poll therefore delayed a joystick update until the
next fixed tick. The zero-tick predicate now includes both packed analog values.
`input.buttons` and `input.axes` also mark the existing
`external_work_pending` one-shot wake marker. That marker is cleared by the
GuestFrame, so a transition back to the neutral `0x8080` center is delivered
once and does not keep an idle guest running.

## Validation

The native regression
`smoke_tests::analog_samples_and_center_release_reach_zero_delta_guest_frames`
uses the real QuickJS GuestFrame path. It verifies a non-neutral left/right
sample at `delta=0`, a neutral release at `delta=0`, and no duplicate event on
the following settled zero-delta frame:

```text
running 1 test
test smoke_tests::analog_samples_and_center_release_reach_zero_delta_guest_frames ... ok
test result: ok. 1 passed; 0 failed; 0 ignored
```

The focused command was:

```text
CARGO_TARGET_DIR=/tmp/pocket-fix-analog-target cargo test --locked \
  --manifest-path sdk/native/Cargo.toml \
  analog_samples_and_center_release_reach_zero_delta_guest_frames -- --nocapture
```

This validates the native frame boundary only; Flutter and device integration
tests remain owned by the root agent's serial validation pass.
