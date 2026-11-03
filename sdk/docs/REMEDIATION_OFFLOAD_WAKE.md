# Offload wake rearming remediation

The native Offload broker uses one level-triggered `wake_pending` bit for
provider requests, cancellation records, and JS-visible replies. A notify sets
the bit; provider and reply drains may clear it only while the broker mutex is
held and all three queues are empty. This keeps a request admitted after the
last reply drain from being coalesced behind an already-delivered callback.

## Source and retained behavior

The retained parent checkout was inspected at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding its
`pocket_host/` directory. It contains the earlier Flutter canvas wake behavior
in `lib/render/pocket_ui_components.dart:3731-3830`, but no reusable native
Offload broker. The implementation therefore keeps the current SDK's native
`OffloadHost` as the sole broker and adapts only its existing FFI notification
boundary; no second scheduler or provider state machine was introduced.

## Change

`sdk/native/src/offload.rs` now centralizes the three-queue emptiness predicate
in `work_queues_empty`. `take_request` and `take_cancellation` use that helper,
and `take_reply` calls `rearm_wake` after discarding stale replies or returning
the current-session reply whenever all queues are empty. The call occurs inside
the existing `transition` closure, so the state mutation and wake-gate update
remain serialized by the broker mutex.

The regression test
`offload::tests::reply_drain_rearms_wake_for_later_submit_and_cancel` covers:

- a completion reply followed by a second submit;
- a dispatched cancellation followed by a new submit; and
- two replies, asserting only the final dequeue reopens the callback gate.

## Verification

With an isolated copy of the target checkout (the concurrent scheduler worker
was editing another native test helper in the shared worktree) and an isolated
Cargo target:

```text
CARGO_TARGET_DIR=/tmp/pocket-fix-offload-isolated.J6mNrq/target cargo test --locked \
  --manifest-path /tmp/pocket-fix-offload-isolated.J6mNrq/native/Cargo.toml \
  offload::tests -- --nocapture
test offload::tests::reply_drain_rearms_wake_for_later_submit_and_cancel ... ok
test result: ok. 7 passed; 0 failed
```

The real FFI notification probe was run twice. The pre-fix temporary copy
(`/tmp/pocket-remediation-e06720e`) reported `notify_count=2` and suppressed the
second submit. The fixed source reported:

```text
notify_count=3 analog_zero_events=0 analog_next_events=1
```

The latter probe also exercises native frame delivery after the wake sequence;
the analog counts are retained as evidence for the separate scheduler issue,
not as part of this Offload fix.
