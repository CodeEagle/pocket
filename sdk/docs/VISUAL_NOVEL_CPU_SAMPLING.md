# Live2D CPU sampling, 2026-11-08

The final SSAA2 workload still exceeds the model build P95 target. A separate
diagnostic Profile invocation (`session65093`, exit 0) reused the actual frozen
Lantern Guest, the five 10-second model windows and two release cycles. It did
not rebuild Guest bytecode or change the model, painter or schedule. The normal
playable app (PID 46513) remained installed and was not replaced by this test.

## Source-first boundary

The retained parent `pocketjs_flutter_demo/lib/core/perf_monitor.dart` already
uses `SchedulerBinding.addTimingsCallback`. The current integration harness
retains that measurement boundary. The parent outside `pocket_host/` has no
equivalent Live2D mesh pipeline. This diagnosis adds no production profiler,
host business state, alternate runtime or layout implementation.

## Native stack observation

After the first `hiyori_idle_0` window reported, `/usr/bin/sample 55919 10 1`
sampled the actual test process for 10 seconds at a nominal 1 ms interval.
The interval includes the subsequent live model window and transition work;
it is not a fixed-pose benchmark. The report contains 6,489 main-thread
observations, including these nested stack nodes:

| Inclusive node | Observations |
| --- | ---: |
| `Animator::BeginFrame` | 2,999 |
| `pocket_frame_delta_binary_v2` | 1,286 |
| `run_guest_touch_frame` | 1,065 |
| `RquickjsGuest::collect` / pending job execution | 1,035 |
| one nested `js_array_every` subtree | 517 |

The nested counts overlap. They are neither additive durations nor an FPS
measurement. Dart AOT frames appear as unresolved `kDartSnapshotText` offsets.
Sampling overhead also makes this invocation unsuitable as the baseline for
a claimed frame-time improvement. The useful new evidence is the substantial
array-callback work inside the model's JS job; its source must be identified
before changing validation or reactivity.

The pinned `sdk/native/Cargo.lock` selects `rquickjs-sys 0.12.2`. Its retained
registry source `quickjs/quickjs.c` registers **every, some, forEach, map and
filter** against the same `js_array_every` implementation (registration near
line 45240). The C symbol therefore does not identify a JavaScript `.every()`
call or prove that readiness validation is the hotspot. In particular,
`model-view.tsx` runs `frame.forEach`, and `encodeNovelMeshEffect` performs
validation and DataView writes through several of these shared builtins.
That chain matches the sampled DataView descendants and is a candidate for
an isolated, byte-equivalent encoding experiment. It is not uniquely proven
by this stack; Live2D geometry conversion also uses array callbacks.

The normal native capability transport does not expand the packed drawable
buffers into numeric JavaScript arrays: `PocketLive2dDrawable.toJson` emits
`Uint8List`; `PocketHost.handle` checks JSON compatibility without replacing
the response object; `pocket_binary_codec.dart` emits `TAG_BYTES`; and Rust
`binary_bridge.rs` constructs a QuickJS `Uint8Array`. Consequently the
`decodeNumericArray` compatibility branch for ordinary arrays is not an
evidenced production hotspot. Its finite-number validation remains intact.

## MFX1 callback ablation: not adopted

A scratch candidate hoisted the blend lookup and replaced MFX1 `some` and
`forEach` callbacks with index loops. It retained mask resolution order,
duplicate/range checks, sparse-array behavior, error order and reused-buffer
semantics. The official pinned probe loaded the same `9c01ae0d…` Guest and
`3d775a1f…` PAK, then evaluated both source and candidate functions in that
QuickJS runtime. All 39 parity cases matched, including errors and unchanged
buffers on failure.

Six alternating AB/BA pairs each encoded 1,000 synthetic frames with 98
effects per frame and steady buffer reuse. External host timing around each
probe command gave medians of 270.85 ms source and 228.91 ms candidate. A
separate 200-frame checksum check returned 2,920,400 for both. The timing
difference is approximately **42 microseconds
per synthetic model frame**. It includes fixed command/eval overhead and does
not measure full-game frame time. The absolute reduction is too small to
justify adopting this longer implementation as a performance repair; no MFX1
production code or new cache was added.

The existing separate `mesh_effect_native.test.ts` regression passed (one
test, 21 assertions), using temporary `buildGuest` output. It does not convert
the scratch timing result into a full-game performance claim. Reproduction
source and `raw-results.json` are in
`sdk/.pocket-build/mfx-effect-scratch-20261108/`.

The run's two release cycles do not establish RSS stability. The independent
20-cycle run and its failed sample-stability gate remain authoritative; see
[SSAA ablation](VISUAL_NOVEL_MESH_SSAA_ABLATION.md).

Exact source hashes, sample, complete driver log and the five window reports
are retained under `sdk/.pocket-build/model-cpu-sampling-20261108/`.

## PMS1 static-topology serialization candidate: blocked on alias ownership

The shipped Lantern Guest enables `cacheStaticTopology: true`
(`demo/js/apps/lantern/app.tsx:88`; Guest `9c01ae0d…`, PAK
`3d775a1f…`). In the client, `parseFrame` stores the first full frame's UV,
index and mask arrays and reuses those same references for `cached-v1`
responses (`sdk/packages/pocket_live2d/src/transport.ts:324-366`). The VN
factory still transforms UVs into its reusable interleaved `Float32Array` and
calls the generic PMS1 encoder every frame
(`sdk/packages/pocket_vn/src/live2d.ts:127-138`). That encoder validates all
vertex components and indices, then writes the complete payload, including
static UV and index sections (`sdk/packages/pocket_vn/src/mesh.ts:18-32`).
This identifies repeated JS-side work after the existing native topology
cache; it does not show that this work is a material frame cost.

Reference identity is not an immutability guarantee. The public drawable
interface is TypeScript `readonly` (`transport.ts:14-29`), but the decoder
returns an input JavaScript array without copying it (`transport.ts:432-437`),
and the `PocketLive2dHost` contract accepts any provider
(`transport.ts:10-12`). The cached arrays are ordinary mutable arrays and the
public client's `update()` returns the frame containing those references.
Therefore a reference-equality fast path cannot safely skip validation or
serialization for all supported hosts; a provider or consumer may mutate an
array while retaining its identity. The production Flutter binary path
converts packed buffers into JS arrays, but that narrower path does not define
the ownership contract for custom providers or clients.

Any future PMS1 ablation must also preserve two encoder contracts. First,
`live2d.ts` writes transformed positions and UVs into a `Float32Array` before
calling `encodeNovelMesh`; validation therefore sees Float32-rounded values,
including overflow/non-finite results, rather than the original JS numbers.
Second, `encodeNovelMesh` validates every vertex and index before modifying a
same-sized reused byte buffer. An in-place dynamic update that writes bytes
before validating the complete frame could expose partially changed geometry
after an invalid frame. A safe candidate would need an explicit immutable
topology ownership boundary and preserve Float32 rounding, full validation,
and no-partial-publication behavior. No such boundary is established here, so
the identity-based skip candidate is blocked; no production change, new cache,
or performance claim is made.

## PMS1 typed-write ablation: candidate retained for host A/B

This candidate replaces per-component PMS1 `DataView` writes only when the
source vertices are a standard, unshadowed `Float32Array`, the runtime is
little-endian, the output offset is 4-byte aligned, and input/output backing
buffers are distinct ordinary `ArrayBuffer`s. It keeps the original count,
color, finite/range and index validation before touching reused output bytes;
all positions, UVs and indices are still serialized on every call. Header and
vertex blocks use typed-array stores, while indices use the original captured
`m` count and an indexed `Uint32Array` loop. Other ArrayLike inputs, aliases,
shadowed properties, unaligned targets, shared buffers and non-little-endian
hosts use the original `DataView` path. This does not depend on topology
immutability or add a topology cache.

The same-pinned-QuickJS scratch harness compared the original encoder with
that guarded candidate. All 16 cases matched byte-for-byte or matched the
same validation error and unchanged reused bytes: 12 valid cases exercised
eligible and fallback routes, including a throwing generic `ArrayLike.buffer`
getter, own `Float32Array.buffer`/`length` overrides, a stateful index-length
getter, aliases, and forced endian fallback; four invalid cases covered
non-finite/Float32-overflow values, bad indices and bad color. The runtime's
little-endian byte probe passed. Six alternating AB/BA pairs encoded 98
synthetic meshes per frame for 500 frames per trial; every trial checksum was
3,920,000. Median host time was 2,309.624 ms for the original and 1,520.402 ms
for the candidate, a difference of **1.578 ms per synthetic 98-mesh frame**.
The measurement includes probe/eval command overhead and synthetic mesh sizes;
it is not a full-game frame-time or FPS result. The raw trials, hashes,
parity and branch counts are retained in
`sdk/.pocket-build/pms1-bulk-write-scratch-20261108/timing-results.json`.

Baseline and candidate Guests were both built from the current
`demo/js/apps/lantern` project using the pinned
`sdk/.pocket-build/retina-native-tools-20261108` compiler/tool package and Bun
1.4.4. The source manifest reports exactly one build-input change:
`sdk/packages/pocket_vn/src/mesh.ts`. Both PAK files are byte-identical
(SHA-256 `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`);
baseline QJBC is `4024f59c6025f4ebe18cafc72282730c7a2db38723d61d4934699da0eba5b756`
and candidate QJBC is
`396b07fcebbfc2c74915b220fd685f3fa276fb4f2b3ec900d51a5987158b6329`. The
default SDK tools package was also tried and rejected the real 2048×2048
Hiyori texture at its 512px limit; that failed log is retained, and neither
app assets nor staged Demo bytes were changed. Build reports, baseline source,
source delta and both Guests are under
`sdk/.pocket-build/pms1-production-ab-20261108/`.

Focused verification passed: the mesh, Live2D, Spine and skin SDK tests passed
16/16 with 126 expectations. Native pointer-driven mesh and MFX tests passed
1/1 each (6 and 21 expectations), and the original Spine animation/pause test
passed against the isolated candidate Guest (1 test, 4 expectations). The
isolated copy changes only artifact/probe paths and retains the test body.
Logs and fixture Guest hashes are under `.../logs/` and `.../native-tests/`.
The probe's `NativeSession` has no registered Live2D Core provider, so actual
Live2D native capability transport was not exercised in this non-Flutter run;
the JS Live2D factory path was exercised by the SDK tests. This ablation is a
candidate used in the isolated real-host A/B below, not a claim that the
synthetic encoder reduction equals the observed application-frame change.

## Isolated real-host A/B result

The subsequent sequential Flutter Profile pair loaded the isolated baseline
and candidate Guests, collected five 10-second model windows per condition,
and restored the staged Guest assets; both drivers exited zero. The median of
the five window P95 values changed as follows:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Native P95 | 9.964 ms | 9.547 ms |
| Build P95 | 14.462 ms | 14.039 ms |
| Raster P95 | 0.485 ms | 0.524 ms |
| Total span P95 | 25.126 ms | 24.973 ms |
| Frames over budget | 5 | 5 |

The 12 ms build-P95 target was not met. This is one sequential A/B pair, not a
repeatability, stability, FPS or GPU-completion claim. Per-window values and
the restoration check are in
`sdk/.pocket-build/pms1-real-profile-20261108/comparison.json`.

After that pair, the isolated candidate Guest was staged for the separate
20-cycle check. The ordinary main app has not been rebuilt with this encoder;
its current Guest remains the original `9c01ae0d…`. A staged test Guest is not
a delivery build.
