# App memory limits

The native Pocket Flutter runtime now has an optional, immutable memory policy
per `HostState`. It limits the QuickJS allocator for that runtime and admits a
package by its actual byte length before native assets or a guest realm are
mounted. It is a guest-runtime policy, not a process-wide memory manager.
This path is implemented by the Flutter native SDK (iOS, Android and macOS).
The separate experimental WeChat/WASM export does not currently consume this
memory extension and has not been validated as enforcing these quotas.

## Native constructor

The C ABI is declared in [`sdk/native/include/pocket_flutter.h`](../native/include/pocket_flutter.h):

```c
HostState *pocket_create_with_memory_limits(
    double width,
    double height,
    uint32_t raster_density,
    uint32_t tick_hz,
    uint64_t heap_limit_bytes,
    uint64_t max_pak_bytes);
```

Both values are byte counts. For this low-level C ABI, `0` means that field is
absent: `heap_limit_bytes == 0` keeps the legacy default, and
`max_pak_bytes == 0` adds no package-admission ceiling. Neither value is an
unlimited-memory setting. Higher-level JSON/configuration APIs should preserve
their own nullable-vs-explicit-zero validation before calling this ABI.

Configured values are validated before the requested runtime is created:

| Field | Accepted configured range | Meaning |
| --- | --- | --- |
| `heapLimitBytes` | 64 KiB through 2 GiB, inclusive | Total QuickJS heap budget, including the copied immutable `globalThis.__pak` buffer |
| `maxPakBytes` | 1 byte through 512 MiB, inclusive | Maximum actual PAK length admitted before asset parsing and guest mount |

Values outside those ranges, or values that do not fit the native `usize`,
return the normal destroyable error handle; `pocket_last_error` contains the
field-specific diagnostic. This preserves the existing creation-failure ABI
while avoiding a briefly running runtime with a different policy.

The existing package/file loader still has its independent bounded file-read
ceiling (`256 MiB` in `pocket_load_files` and
`pocket_load_bytecode_files`). A configured `maxPakBytes` above that value is a
valid policy ceiling, but it cannot enlarge that older loader bound.

## Runtime behavior

`GuestEnvironment.heap_limit` is passed to the pinned `RquickjsGuest`, which
calls QuickJS's real `Runtime::set_memory_limit` before mounting the guest.
The value is an allocation ceiling, not a reservation of that many bytes.
There is no synthetic used-byte counter. A configured heap limit is reused for
every reload; the PAK admission check runs before `reset_host_for_load` and
before native asset installation, so a rejected oversized reload leaves the
existing guest generation intact. A configured heap smaller than the PAK is
rejected because the PAK is part of the total heap budget.

When no heap override is configured, the historical native default remains
`16 MiB + actual PAK length`. This is the compatibility behavior of the old
creation entry points. A configured limit never gets automatically increased
by PAK size.

Each `HostState` owns its own `RquickjsGuest` and QuickJS `Runtime`; limits,
OOM failures, and reloads are therefore isolated between simultaneously live
hosts. `pocket_load`/`pocket_load_bytecode` return `-1` with a diagnostic when
admission or the real guest allocator rejects an operation.

These limits do **not** promise a cap on process RSS, native allocations,
decoded image/texture memory, GPU/VRAM, Dart heap, or operating-system memory.
They do not add a GC state machine: QuickJS remains responsible for its own
collection and allocator failure semantics.

## JS system policy and trusted consumer configuration

The JS SystemUI catalog has two declaration forms:

* `memoryPolicy` is a compatibility tier name. The pinned budgets are
  `UI_MINI = 128 MiB`, `GAME_STANDARD = 512 MiB`,
  `VIDEO_GAME_PRO = 1024 MiB`, and `VIDEO_GAME_ULTRA = 2048 MiB` of QuickJS
  heap.
* `memory` carries explicit positive-safe-integer `heapLimitBytes` and/or
  `maxPakBytes`. If both `memoryPolicy` and `memory.heapLimitBytes` are
  present, the heap value must exactly match the tier. `maxPakBytes` remains an
  independent admission setting; the old demo's native/VRAM tier numbers are
  not projected into it.

For example, this JS `pocket.system.json` catalog entry gives an app the
`UI_MINI` heap tier and an 8 MiB PAK admission ceiling:

```json
{
  "package": "com.example.notes",
  "manifest": "apps/notes/pocket.json",
  "required": true,
  "memoryPolicy": "UI_MINI",
  "memory": { "maxPakBytes": 8388608 }
}
```

The SystemUI manager copies that catalog budget into its
`system.runtime.create` request. The trusted Flutter host then applies
`PocketMemoryLimits.admit` before constructing the native runtime. The JS
catalog is therefore a declaration/request path, not a way to raise the
trusted host allowance.

A consumer can set the trusted upper bound directly through
`PocketAppConfig.memoryLimits`:

```dart
import 'package:pocket_sdk/pocket_sdk.dart';

const appConfig = PocketAppConfig(
  appId: 'com.example.notes',
  memoryLimits: PocketMemoryLimits(
    heapLimitBytes: 128 * 1024 * 1024,
    maxPakBytes: 8 * 1024 * 1024,
  ),
);

// runApp(const PocketApp(config: appConfig));
```

This is a monotonic admission boundary. A signed guest may request a smaller
heap or PAK ceiling, or omit a field and inherit the trusted value; it cannot
request a value above `PocketAppConfig.memoryLimits`. If the trusted config
omits the heap field, the guest-manifest fallback is the legacy 16 MiB heap
allowance, not an implicit 128 MiB tier. Explicit zero is rejected by the
JSON/Dart configuration objects; only the native C ABI uses zero as its
internal “field absent” sentinel.

## Signed guest manifest propagation

An app package's guest manifest is part of the Ed25519-signed
`PocketPackageManifest` payload. Its top-level `memory` object is parsed as
`PocketGuestManifest.memoryLimits`, serialized back into the signed payload,
and verified before a cached or updated package is staged. A guest manifest
does not carry `memoryPolicy`; it carries the explicit byte limits.

After verification, `PocketSession` reads the active package's
`guestManifest.memoryLimits`, calls the trusted app config's `admit` method,
and passes the resulting (possibly tightened) limits through `PocketApp` and
`PocketView` to the native constructor. A malformed, over-range, or
over-budget declaration is rejected before the guest generation is mounted.
This is the path that makes signed package metadata useful without allowing
the package to enlarge its host grant.

## Recording and replay

`PocketRecordingMetadata` contains the effective `memory` object alongside
dimensions, density, tick rate, and runtime ABI. `toJson` emits it when a
field is configured; `fromJson` validates the same 64 KiB–2 GiB and
1 B–512 MiB ranges. Older recordings without `metadata.memory` retain the
legacy defaults.

The normal replay runner creates a fresh `FfiPocketRuntime` with
`recording.metadata.memoryLimits`, so replay uses the same per-runtime budget
as capture rather than silently running with a larger heap. A custom replay
factory receives the complete metadata and is responsible for preserving that
contract if it supplies its own runtime.

## Worker realm

Workers are independent QuickJS realms. Their default heap is 16 MiB. When an
app has a smaller admitted heap, the worker heap is reduced to that app value
(with the same 64 KiB floor); when the app heap is absent or larger than
16 MiB, the worker remains at 16 MiB. This keeps a worker from escaping a
smaller app budget without making large app heaps implicitly enlarge workers.

The worker's heap/stack/CPU quotas are separate per-worker settings. There is
no aggregate app-plus-worker, process-wide, Dart, or GPU/VRAM quota promised by
this policy.

## Tier and demo reference

| Compatibility policy | QuickJS heap budget |
| --- | ---: |
| `UI_MINI` | 128 MiB |
| `GAME_STANDARD` | 512 MiB |
| `VIDEO_GAME_PRO` | 1024 MiB (1 GiB) |
| `VIDEO_GAME_ULTRA` | 2048 MiB (2 GiB) |

The checked-in demo's `demo/js/pocket.system.json` uses an explicit
`128 MiB` heap plus `maxPakBytes: 8388608` (8 MiB) for the host app, uses
`memoryPolicy: "UI_MINI"` for the profile app, and uses an 8 MiB PAK ceiling
for the lobby app. The 8 MiB value is an admission ceiling: native checks the
actual PAK byte length and does not pre-allocate or pad every package to 8 MiB.

## Old demo source and what was retained

The retained pre-`pocket_host` demo described memory tiers in
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/native/pocket_runtime_multi.h:39-45`
and exposed mutable tier/custom-limit functions at `:110-118`. Its C
implementation assigned tier numbers (`128 MiB`, `512 MiB`, `1 GiB`, `2 GiB`,
plus an advertised unlimited tier) in
`native/pocket_runtime_multi.c:226-259`; the default field was initialized at
`:139-145`. The same file enforced only the simulated native/VRAM buffer pool
at `:276-304`.

That old C library did not link QuickJS or call a QuickJS allocator limit. Its
`max_js_heap_bytes` field was metadata exposed by getters, and its
`MEMORY_TIER_UNLIMITED` zero sentinel is deliberately not carried into this
SDK. The reusable behavior here is the per-sandbox, constructor-time policy
shape and byte units—not the fake C heap accounting or the unbounded tier.

The actual enforcement source in this SDK is the pinned engine:
`sdk/.cache/pocketjs/engine/guest-rquickjs/src/lib.rs:149-152` applies
`Runtime::set_memory_limit`, while `:434-444` copies the PAK into
`globalThis.__pak`. The native adapter validates and supplies that environment
in `sdk/native/src/lib.rs`.

## Verification (2026-11-03)

- Native: `cargo test --locked -- --test-threads=1` passed 91 tests; the existing
  manual throughput comparison remains ignored. The four memory integration
  tests exercise real ArrayBuffer allocation failure at 4 MiB, success at
  32/64 MiB, an independently running realm, and source/QJBC reload admission.
- Flutter bridge: 130 tests passed with `POCKET_NATIVE_LIBRARY` pointing at
  the rebuilt macOS dylib. The memory FFI test verifies actual allocator
  failures, PAK bounds, metadata/hash preservation, strict replay and rejection
  of a custom replay factory with a different budget.
- Services: 30 tests passed, including guest-memory manifest parsing and signed
  package verification. The SDK regression run passed 67 tests with four
  explicit native/Worker-fixture skips. After consolidating recording attachment
  into `PocketAppConfig.copyWith`, the config/recording subset passed 14 tests.
- JS: the package publisher, system manifest and JS system-kernel suites passed
  30 tests. They verify that memory survives the signed update payload as well
  as the `system.runtime.create` request; malformed and excessive budgets fail.
- iPhone 18 Pro simulator: the real QJBC composing-input/Profile/Lobby recording
  test passed its three-realm memory assertions, teardown, strict replay and
  exported-archive replay. Both recording integration cases passed. Three
  previously captured archives also passed strict offline replay.

This verification exposed and removed a duplicate configuration constructor
in recording attachment that dropped the budget. It also corrected replay's
Continuous-to-Idle transition: elapsed-time credit now resets at the same
boundary as recording, preventing a lost guest tick and asynchronous event.
The native demand/replay suites cover that transition; frame matching was not
relaxed.

macOS, iOS device/simulator and Android arm64 native libraries were rebuilt.
Android compilation is not an Android device or process-memory/power test.
