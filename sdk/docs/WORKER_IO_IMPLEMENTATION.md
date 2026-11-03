# Worker, IO, and offload implementation

## Upstream source and runtime boundary

The worker contract is taken from pinned PocketJS revision
99924de47c62fa36f526a8791055d91cbbdb3836:

- contracts/spec/worker.ts defines declarations, resource facts, quotas, and
  channel direction.
- framework/src/worker-runtime.ts, io.ts, and worker-channels.ts own the worker
  turn, resource, and channel semantics.
- engine/worker/src/worker.c, runner.c, quickjs.c, and quickjs_ui.c implement
  the native core, realm runner, and UI channel bridge.
- contracts/spec/offload.ts and framework/src/offload.ts define provider
  request records and the UI service pump.

build_guest.ts asks the pinned compiler to emit its worker bundle, then passes
that bundle to pocketjs_bytecode and publishes app.worker.qjbc. The package
descriptor names the QJBC path, byte length, SHA-256, declaration, required
capabilities, runtime and engine ABI, binding generation, and tick rate. The
native host validates the complete QJBC envelope before starting the worker.
The production runner reads bytecode with JS_ReadObject and executes it with
JS_EvalFunction; it has no JavaScript-source fallback.

native/build.rs copies the pinned worker core, runner, and QuickJS wrapper. It
adapts the pinned runner's source-only entry to load validated QJBC and adds
turn-budget and pause hooks. The wrapper compiles against the rquickjs-sys
QuickJS headers selected from Cargo.lock; the build does not compile another
QuickJS VM. Cargo.toml, Cargo.lock, and the selected quickjs.h are explicit
build-script inputs, so a locked QuickJS ABI change rebuilds the adapter. UI
QuickJS and worker QuickJS contexts are created separately, and
the upstream UI bridge attaches to the UI context before UI guest evaluation.

The sibling legacy checkout `../pocketjs_flutter_demo/` (excluding its
`pocket_host/` subtree) did not contain an independent worker realm or worker
resource service. I checked its `native/pocket_runtime_multi.h` and
`native/pocket_runtime_multi.c` duplex API,
including `pocket_duplex_step_echo`, and `lib/core/ffi_bridge.dart`'s
`runBidirectionalBurstTest` fallback at the old `// Simulate Wasm/JS worker`
branch. That path moves fixed-size scalar records through two shared rings and
computes a synchronous echo transform; the Dart fallback performs the same
transform itself. The old `mini_apps/` tree contains app bundles and syslib
artifacts, but no worker entry declaration, resource facts protocol, or
offload provider. I reused only the general idea of bounded nonblocking
message queues. I did not carry forward its echo step or present the
`Dart Isolate + C Worker Thread` architecture text in
`docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` as an implementation.
The upstream C runner is used because it owns the pinned worker turn, resource,
timer, and channel contracts around the same QuickJS ABI; the legacy scalar
ring has no separate realm, request IDs, I/O deadlines, cancellation, or
backpressure semantics to support those contracts.

## Scheduling and bounds

WorkerRuntime::spawn starts a separate owner thread and QuickJS realm. The
owner blocks on a condition variable until a request, channel ingress,
deadline, or stop signal arrives. It does not poll at 1 ms intervals. A
frame-boundary UI latch copies worker-to-UI channel records before the UI
guest turn. WorkerUiBridge::has_pending_output exposes newly latched records
to demand capture, while each native wake marks one owner-thread zero-delta UI
turn; the host calls mark_frame_consumed after that guest turn. NativeCallable
listener wakes are coalesced by an atomic flag:
the first pending event posts one callback, and `WorkerUiBridge::latch` clears
the flag before it copies records, so a concurrent later event can post one
more callback without a lost edge or unbounded Dart mailbox. Runner failures
and shutdown use the same wake gate.

The upstream worker limits remain in force: 8 resources, requests, events,
timers, and channels; 1024-byte facts; 16 facts and 8192 payload bytes per
turn; and 64 Promise jobs per step. The host supplies bounded heap and stack
limits, a per-turn CPU budget, and a CPU quota window. set_paused parks the
owner before it advances a turn and freezes the worker's virtual clock.
Teardown stops the runner, detaches its UI bridge, and joins the owner thread.
Generation checks discard late results.

HTTP is an asynchronous host driver using the locked ureq 2.12.1 TLS
configuration. A declaration must include an HTTP node and the signed
net.http requirement; the host separately supplies exact origin grants.
Network access defaults to denied. Redirects are followed manually, limited to
three, and each destination is checked against the grants. Credentials are
removed across origin changes. Request bodies are capped at 64 KiB, response
bodies at 256 KiB, headers at 32 entries and 8 KiB, chunks/facts at 1024
bytes, and request timeouts at 120 seconds. Backpressure stops response reads;
cancel and close terminate outstanding requests before reclaiming the core.

The native driver currently implements HTTP. i2c and uart declarations are
validated against io.i2c and io.uart, but their open operation returns
unsupported until a board provider is installed. Such a node must not be
presented as a usable hardware capability on this host.

## Artifact admission and recording

The worker descriptor is admitted only when its requiredCaps exactly match
runtime.worker plus the declared node capabilities. The signed guest manifest
must also require runtime.worker. The package file list must cover the worker
bytecode descriptor path and hash; OTA/package verification remains the
authority for the signed metadata and file bytes. Host origin grants are
supplied separately and are not taken from worker JavaScript.

Worker execution now uses the shared native trace lane. The offload broker
also has a traced constructor that records submit/admission, provider dequeue
and completion, timeout/cancellation, session changes, reply reads, and
shutdown events in that same sequence. Its Replay-only facts thread
waits on the lane condition variable and applies recorded provider results and
deadlines through the original bounded broker state machine. Replay creates no
Dart provider, network task, notification callback, or real deadline thread.
Guest submit/cancel/reply operations still execute and compare their observed
results. Record-to-Live ends capture while keeping the original provider and
deadline thread running. Replay-to-Live is offline finalization: it stops the
facts executor and closes the replay broker/Worker domains, without resuming
real providers or network requests.

The shared lane keeps the existing v2 envelope and limits: 8192 events and
8 MiB total, with a 16 KiB maximum event. Short submit records and normalized
provider results are inline. Oversized rejected submit inputs are represented
by their byte length because their contents do not affect the broker result.
Timeout events carry a broker token so a delayed deadline scan cannot expire a
new request after a provider session is reused. Event encoding is lazy: live
and incomplete-record transitions do not build trace JSON or copy provider
payloads. The callback-side `has_replies` probe is a lock-protected read and
does not enter this lane; the owner scheduler's existing external-work entry
records the wake that causes a reply frame.

The production C ABI and Session recording gates have been removed after
real Worker HTTP archive verification. The final native suite passed 68
library tests and 6 duplex tests. It covers broker timeout, queued provider
cancellation, late completion rejection, session change, and the existing
50,000-operation bounded-queue stress case. Worker HTTP record/destroy/offline
replay passed 10 consecutive runs; the idle broker shutdown regression passed
50. The actual Dart FFI archive test closes the HTTP server and destroys the
original runtime before replaying twice in fresh isolates, with no further
HTTP requests. This does not prove the full streaming/backpressure/mixed-domain
matrix; see WORKER_RECORDING_REPLAY_PLAN.md for the remaining boundaries.

## Offload provider boundary

io.offload remains separate from duplex. A disconnected host installs a
session-zero operation table and starts no deadline thread. A configured
provider receives bounded {v,id,method,payload} requests through the native
broker. It returns a completion only after its asynchronous operation
finishes; the broker validates generation, provider session, and ID, and
rejects late results. Cancellation, timeout, close, and disposal are forwarded
to active provider work.

The broker bounds pending requests and replies at 8 each, and cancellation
records at 8. Admission reserves a cancellation slot for each in-flight
request, so an actual timeout can queue both a provider cancellation and an
error reply. The combined live limit is 16. The pinned service pump advertises
eventDriven support: unsent work keeps the service active, but a sent request
waits for a native wake instead of scheduling an empty UI frame every frame.
Native reply-ready state is part of demand capture.
The broker also coalesces provider-listener wakes with an atomic flag. Both
`take_cancellation` and `take_request` re-arm it before locking and reading,
so a concurrent new request posts a fresh event while repeated synchronous
submits cannot fill the Dart mailbox. The native QuickJS stress test checks
that 50,000 submit/cancel pairs queue one callback before provider drain, and
that taking work re-arms the callback for a later request.

PocketBoundedOffloadProvider provides optional http.request for trusted hosts.
Pure computation runs in the original JS Worker; the unused Dart sum/Fibonacci
isolate implementation was removed to keep a single computation path. Custom
providers remain available for explicit native capabilities. HTTP uses dart:io, has no default
origin grants, revalidates every redirect, enforces body and response limits,
and aborts an in-flight request on cancellation.

## TLS dependency selection

The native dependency is pinned to ureq 2.12.1, default-features=false, with
its tls feature enabled. Its published manifest declares Rust 1.71 MSRV; the
PocketJS native workspace currently uses Rust 1.93. The tls feature uses
rustls with bundled WebPKI roots. This dependency version is older than ureq
3.x so it remains compatible with the SDK's current Rust edition/MSRV choices.
The host macOS build and local HTTP tests pass. Android and iOS target builds
still require CI verification; the upstream crate does not provide a PocketJS
target matrix that establishes those mobile builds by itself.

## Verification commands

From sdk/:

~~~sh
python3 -m py_compile scripts/prepare_upstream.py
python3 scripts/prepare_upstream.py
cargo check --manifest-path native/Cargo.toml --bins
cargo test --locked --manifest-path native/Cargo.toml offload::tests --lib
cargo test --locked --manifest-path native/Cargo.toml --lib worker::tests::worker_wakes_coalesce_until_the_ui_latch_rearms -- --exact
bun test ./scripts/tests/build_guest.test.ts
bun test ./scripts/tests/worker_native.test.ts
bun test ./scripts/tests/offload_cancel.test.ts
~~~

The upstream bootstrap was also checked from a deleted generated cache: all
eight pinned patches applied, and a second invocation verified the already
applied patch set. The patch helper checks each file section in the requested
direction and rejects skipped hunks; final checks require the two-argument
service-pump contract, `hasPendingServiceWork`, and the event-driven offload
cancel contract. `offload_cancel.test.ts` bootstraps once before registering
tests so patch validation does not consume each test's short execution timeout.

Verified in this implementation run: clean and repeat bootstrap passed;
`bun test ./scripts/tests/build_guest.test.ts` passed (9 tests, 106
expectations); `bun test ./scripts/tests/offload_cancel.test.ts` passed (4
tests, 20 expectations); and Dart analysis of the worker/offload Dart APIs
passed with no issues. The atomic worker-wake test passed. A native worker
probe passed QJBC execution, local HTTP, bounded channels, and cancellation;
the host integrator is rerunning it after the wake-coalescing change.

From sdk/packages/pocket_flutter/, Dart-only analysis is:

~~~sh
dart analyze lib/src/pocket_offload_runtime.dart test/pocket_offload_runtime_test.dart
~~~

The native worker probe runs generated worker QJBC through the pinned C runner,
exercises compute and a local HTTP server, checks both directions of the
bounded UI channel, and verifies cancellation. The Rust offload pressure test
runs a 50,000-iteration submit/cancel loop in a real QuickJS context and
asserts the native queues stay bounded. Flutter tests are run by the host
integrator; this implementation task does not invoke Flutter commands.
