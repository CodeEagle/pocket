# Worker HTTP deadline remediation

The Worker HTTP adapter retains the pinned `ureq` transport and the existing
origin, redirect, cancellation, response-size, and backpressure checks. The
retained parent project (`pocketjs_flutter_demo/native/pocket_runtime_multi.c`,
outside `pocket_host/`) only provides the historical native-host boundary; it
does not provide an HTTP implementation to copy. This change therefore stays
at the official native Worker HTTP boundary.

`perform_http` already computed one absolute deadline and recomputed the
remaining budget before each manually followed redirect. The missing part was
the `ureq` overall request timeout: only connect/read/write operation limits
were configured. A peer could return response bytes often enough to stay below
the individual read timeout while the body read continued after the Worker
deadline. `http_agent` now applies the same remaining duration to
`AgentBuilder::timeout`, while retaining the per-operation limits and disabled
automatic redirects.

The native regression uses a local TCP server with delayed headers and delayed
body bytes. Each delay is below the individual read budget, but the combined
headers-plus-body time exceeds the total budget; the old configuration reads
the body successfully while the fixed configuration times out. A second
fixture consumes part of the budget in a 302 hop and drips the redirected body
in sub-timeout chunks, proving that every manually followed redirect inherits
the reduced remaining budget.

Validation is intentionally separate from Flutter and the full workspace
suite:

```text
CARGO_TARGET_DIR=/tmp/pocket-fix-http-target \
  cargo test --locked --manifest-path sdk/native/Cargo.toml \
  'worker::tests::http_agent_'
```

This verifies the transport-level deadline on the pinned `ureq` version. It
does not claim that DNS resolution can be interrupted, since `ureq` documents
that limitation; the Worker deadline is still checked before each hop, before
each body read, and while emitting backpressured facts. The isolated ablation
probe without `.timeout(remaining)` returned the delayed body successfully
after 492 ms for a 300 ms budget and failed its deadline assertion; the fixed
probe returned a timeout at 301 ms.
