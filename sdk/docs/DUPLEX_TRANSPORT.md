# Lock-free binary duplex transport

The legacy demo's useful design was a pair of fixed-size shared rings. Its
Dart `ByteData` cursor writes and C echo did not provide atomic publication or
actual JS execution. ABI v2 replaces that design with two native SPSC queues;
it keeps the 16-byte numeric message format and the existing QuickJS runtime.

## Scope

Each direction has exactly one producer and one consumer:

```text
Dart host endpoint             QuickJS owner thread
 ingress producer  ----------> ingress consumer / JS handler
 egress consumer   <---------- egress producer / pocket.duplex.emit
```

The queue data path is lock-free: it does not wait on a mutex, spinlock, or
another participant. Full/empty/busy/closed operations return a result instead
of waiting. This does not make QuickJS execution, GC, callbacks, endpoint
allocation/destruction, or the entire Flutter frame lock-free. It is SPSC,
not MPMC; adding multiple producers requires a different algorithm.

## Atomic publication

- Producer loads its own write cursor relaxed and the reader cursor with
  acquire semantics, then writes only slots it owns.
- Producer publishes completed payload with a release write-cursor store.
- Consumer acquires the write cursor before accessing payload, and publishes
  released slots with a release read-cursor store.
- Producer must acquire the read cursor before reusing those slots.
- Diagnostic counters are not synchronization barriers.

Dart never reads or writes the native atomic header through `ByteData`.
Native reserve/commit operations establish slot ownership; only the granted
payload span is mapped into Dart. Low-level payload views are synchronous
borrows, invalid after publish/consume or endpoint close; callers must not
retain them. The high-level `PocketDuplexChannel` does not expose these views. Batches reduce FFI crossings and cursor
publication frequency. Each record is little-endian:

| Byte | Field |
| ---: | --- |
| 0 | `u16 msgType` |
| 2 | `u16 flags` |
| 4 | `u32 targetId` |
| 8 | `f32 arg0` |
| 12 | `f32 arg1` |

The native header is opaque and versioned. Consumers must not rely on the old
8,216-byte layout. Unsupported native ABI must fail explicitly rather than
silently substituting an in-memory transport.

## Ownership and lifecycle

Native endpoints retain the shared allocation independently of `HostState`.
The runtime and endpoint role claims enforce one producer/consumer per side.
Reload closes the old channel and creates a new allocation; it does not reset
an actively shared ring. Old leases keep memory alive until release and
observe closure. A close racing with an already reserved span must not free
or reuse that span. New ingress reservations after close fail; already published egress remains drainable.
After reload, discard the old Dart channel and acquire a new one from the
runtime. An old channel never silently switches to the new generation.

Each endpoint handle belongs to one thread/isolate and must not be called
concurrently or released while a call/borrow is active. Native retained-channel
and split-role attachment APIs are for embeddings that implement explicit
role transfer; the Dart SDK does not expose cross-isolate endpoint transfer.

Only the runtime owner may execute `pocket_duplex_step` or the QuickJS frame.
Sharing a transport endpoint is not permission to share `HostState` or a
QuickJS context across threads. Dart external typed lists must not be sent
between isolates; any endpoint transfer must use an explicitly supported
native ownership protocol.

The existing guest API remains:

```js
globalThis.__pocketDuplexEvent = (type, flags, target, a0, a1) => {
  const accepted = pocket.duplex.emit(type, flags, target, a0, a1);
  // Handle egress backpressure explicitly when accepted is false.
};
```

Missing/throwing handlers leave the current ingress message uncommitted. The
application must handle persistent errors; queue lock-freedom does not remove
application-level head-of-line blocking. A retry can repeat callback side
effects, so handlers should use message identifiers where required.

“Zero-copy” refers to mapped Dart/native transport storage, not to arbitrary
JS TypedArrays sharing a native pointer. JS receives scalar arguments; Dart
may allocate event objects when consuming records. No JSON is needed for this
numeric transport.

## Verification and performance

Required checks cover concurrent sequence integrity, wrap-around, full/empty,
role exclusivity, reserve/commit, close/reload races and actual QuickJS
round-trips. Throughput comparisons must separate queue work from JS/GC/frame
work, use equal payload/capacity, and report single-message versus batched
operations. Serial legacy access is a reference, not a valid concurrent queue.
No device frame-rate gain follows from a host queue benchmark alone.

Cursor padding follows the architecture-aware conservative spacing used by
[Crossbeam CachePadded](https://docs.rs/crossbeam-utils/latest/src/crossbeam_utils/cache_padded.rs.html).
This avoids hot cursors sharing a cache region; no padding-specific speedup
is claimed without a separate measurement.

References: [Rust atomic memory model and lock-free portability](https://doc.rust-lang.org/std/sync/atomic/),
[Dart leaf FFI call restrictions](https://api.dart.dev/dart-ffi/Native/isLeaf.html).
Only short native operations without VM callbacks qualify for leaf calls;
QuickJS dispatch is not one of them.

## Local validation (2026-11-02)

On the aarch64 macOS development host:

- Native queue tests: 6 passed, plus one explicitly ignored manual benchmark.
  Includes 1,000,000 ordered records across two threads, wrap/full protection,
  exclusive roles, exact consumer reservation and concurrent close.
- Native QuickJS/FFI tests: 5 passed, including real callback/emit, missing or
  throwing handler, full egress and actual runtime reload with retained old
  endpoints.
- Dart protocol/exception tests: 8 passed; a separate real dylib FFI round-trip
  test passed, including duplicate-role rejection and ABI assertions. Targeted
  Dart analysis passed. Native queue/ABI lookup calls use short leaf FFI calls;
  endpoint allocation/release and QuickJS dispatch do not.
- Android arm64 release and iOS arm64 simulator release libraries rebuilt;
  the ABI v2 endpoint symbols are present in both artifacts.

Three consecutive release runs of the manual queue benchmark used 1,000,000
16-byte records, two threads, 255 usable slots, sequence validation and the
same partial-batch/backpressure policy. Results below are elapsed ranges in
milliseconds; thread startup and scheduling are included.

| Maximum batch | Atomic SPSC | Mutex VecDeque |
| ---: | ---: | ---: |
| 1 | 21.35–22.99 | 161.72–173.78 |
| 16 | 5.73–5.86 | 18.71–19.95 |
| 64 | 1.99–2.12 | 15.34–17.40 |
| 255 | 2.68–2.84 | 15.22–16.60 |

This is a local throughput ablation, not a device/FPS result. Full queues retry
in the harness instead of dropping messages. The benchmark does not measure
FFI/JS callbacks, p95 latency, allocations, cache-padding alternatives or mobile
power consumption. A maximum batch of 255 was slower than 64 here, so the Dart
read default remains 64 rather than assuming the largest batch is best.

```sh
cd sdk/native
cargo test --locked --lib binary_duplex
cargo test --locked --test duplex_layout
cargo test --locked --release --test duplex_layout -- --ignored --nocapture
```

```sh
cd sdk/packages/pocket_flutter
POCKET_NATIVE_LIBRARY=/absolute/path/to/libpocket_flutter.dylib \
  flutter test test/pocket_duplex_test.dart test/pocket_duplex_ffi_test.dart
```

The real FFI fixture is skipped when `POCKET_NATIVE_LIBRARY` is unset; a skipped
fixture is not a native validation pass. Mobile artifacts were cross-built and
inspected here, not revalidated as running apps on mobile devices. No TSAN or
model-checking result is claimed.
