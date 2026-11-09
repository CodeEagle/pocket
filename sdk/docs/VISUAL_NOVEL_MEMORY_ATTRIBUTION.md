# Whole-game memory attribution, 2026-11-09

The instrumented macOS Profile baseline completed seven whole-game pages,
five 10-second model windows, and 20 model entry/exit cycles. The performance
gate remains **unverified**: only 17/20 RSS windows were stable (cycles 5, 13,
and 15 were unstable). A falling RSS median is not an accepted improvement.
Live2D clarity, texture resolution, sampling and LOD policy were unchanged.

## Reproducible evidence and measured limits

Evidence is under `sdk/.pocket-build/game-memory-20261109/`: frozen
`baseline/pocket_host.app`, `baseline-build-result.json`,
`baseline-native-artifacts.json`, `baseline-response.json`, `baseline-drive.log`,
`baseline-memory/`, `environment-before.json`, `system-memory-after.json`, and
`attribution-summary.json`. The app used the accepted crossfade Guest, whose
QJBC SHA is `01c520daf1e44885bf7c91e8aa2f859036e571d819ebf65b04c0d18a7699b9ce`
and PAK SHA is `172e83a1c6de6f22e668d1e27e4277b58ee9ad72929a2f7571525e6b2d2fa505`.
The build records identify the compiler/source inputs and the actual linked
native archive separately; rebuilding Flutter does not prove that an existing
archive was rebuilt from current Rust source.

First-five and last-five RSS medians were 641,744,896 and 446,054,400 bytes
(signed change −186.625 MiB). All 20 stable windows are required, so positive
growth of zero does not pass the gate. After every cycle the harness observed
zero active model handles and zero model triangles; visible decoded image
counts returned from 17 to 15, with a 4,219,200-byte decoded RGBA estimate after
exit. This estimate excludes allocator overhead, GPU residency and snapshots.

Model build P95 remained 13.538–16.172 ms; native P95 was 10.882–12.216 ms.
There were 46 build/raster budget overruns among 2,009 timing samples. These
are instrumented diagnostic figures, not presented FPS or a comparable
uninstrumented A/B speedup. Whole-game page windows are included in the JSON;
low activity on idle pages cannot establish sustained frame rate.

Read-only VM memory queries observed a non-monotonic Dart heap of roughly
12.34–35.09 MiB. No GC or allocation counter reset was requested. Five vmmap
captures showed approximately 251–282 MiB of DefaultMalloc allocated bytes,
while empty MALLOC_LARGE regions varied approximately 32–263 MiB. System swap
usage was about 4.66 GiB. These observations show why RSS cannot be treated as
live SDK object bytes; they do not identify a precise allocator or GPU cause.

The external observer starts after each cycle log, without a barrier before
the next cycle. Its VM/allocation/vmmap samples are therefore **not atomic
post-release snapshots**. Use the harness's own release facts for that boundary.
`ps pcpu` is a lifetime average, not instantaneous idle CPU. Do not infer an
idle CPU regression from it or attribute all physical footprint to the SDK.

## Source-first review and minimal lifecycle correction

The retained parent outside `pocket_host/` has no model bridge to copy. Its
`lib/core/ffi_bridge.dart` synchronous borrowed-buffer handling and
`lib/render/pocket_ui_components.dart` route reset/recycling are relevant
ownership precedents, not a replacement model runtime. The current Dart
image/LOD stale-result disposal, codec finally blocks, native model destroy,
and JS transport release paths were inspected before adding code.

A separate failure-path defect was found in
`sdk/packages/pocket_vn/src/model-view.tsx`: the mounted error view retained its
instance and animation unregister closure after disposal, then disposed the
instance again when its key changed. The fix clears those references and the
failure callback, unregisters the actor, and disposes once. Existing mesh-state
cleanup handles effect buffers; no extra cache, state layer or timer was added.

`sdk/scripts/tests/novel_model_commit_guest.test.ts` compiles a pre-fix negative
control and production Guest through pinned buildGuest and drives native input.
Both advance rejection and setIntent exceptions dispose twice before the fix,
once after it. Error UI stays mounted with zero animation actors; changing key
restores one actor and produces 37 frames of changing PMS1 textured triangles.
The two-test run passed; `guest-lifecycle.log` preserves root verification.
This establishes lifecycle behavior, not heap collection or a fix for the
normal 20-cycle RSS instability.

Same-runtime package replacement exposed a second, independent defect in
`sdk/native/src/lib.rs`: loading the same 1×1 package twice and then a package
with changed pixels grew live Core texture counts/bytes from 1/4 to 2/8 to
3/12, and retained two old image DrawOps. Both source and bytecode controls
reproduced it. The minimal fix admits the new package before resetting the
realm, destroys prior guest children on the existing primary/auxiliary roots,
and frees deduplicated old `from_pack` handles through `Ui::free_texture`.
Existing metadata is reused; no ownership map or Core patch was introduced.
Font metrics are parsed before installation, so invalid package admission
leaves the prior guest tree, textures, metrics and realm intact. Script
execution failures after successful admission are not transactional rollback.

The source/bytecode regressions now retain one live texture and four live
pixel bytes, matching a fresh runtime. Old-generation handles return no pixels;
only the replacement image draws, publishes new resource pixels and reacts to
pointer input. Texture slot capacity is bounded at two because installation
stages the new package before retiring the previous one; this is not a claim
that slot capacity or process RSS returns to a fresh runtime. Invalid PAK,
invalid/oversized bytecode and existing font-resource reload checks also pass.
Red/green commands, outputs, before source and root review diff are archived
under `reload/`. Official macOS native library and release Probe were rebuilt. The complete
Rust lib suite passed 103 tests after correcting one pre-existing smoke-test
header assertion from protocol v1 to the already implemented v2 (flags and
DrawOp assertions retained). The release build source SHA is
`8a6434db996dd3e5ea0d85fbb2574df96bdfe80fee79ec39f1d92120f4124c18`;
final tested source SHA is
`dadcb266aefa195a5a92a9f9b230d339dcd76d55f2699b889a67354957927115`, differing
only by that test correction. The production change is identical.

The new `sdk/scripts/tests/package_reload_guest.test.ts` additionally compiles
both colored-image fixtures through pinned buildGuest and loads A→B→A on one
release Probe handle. Each generation exports the expected red/blue/red
pixels, records releases after replacement and changes the image width from
20 to 40 through a visible button. Root also verified both model Guest tests
and four Lantern crossfade/audio/new-game regressions against that new Probe.
The existing VN suite passed 240 tests/2,003 assertions. Strict view TypeScript
checks include model-view transitively; coverage is archived separately.

Neither the reload path nor an error-only model fix is credited as a normal
gameplay speedup without matching measurements. The earlier Float32 copy candidate remains reverted;
see [the ablation](VISUAL_NOVEL_FLOAT_SNAPSHOT_ABLATION.md).

## Remaining acceptance

The whole-game performance gate remains open. No unstable samples were removed,
no RSS limits were relaxed, and no image quality was reduced. This run is macOS
Profile only; it does not validate physical mobile devices or Windows. The updated ordinary Demo is
`sdk/.pocket-build/lantern-playable-memory-20261109/pocket_host.app`, PID72925,
Profile with normal `lib/main.dart`. Signature, all four embedded Lantern
artifacts, runnable main isolate and an 800×632 onscreen window were checked
before retiring owned prior PID17165. The ordinary macOS save remained
53,569 bytes with SHA
`038051b6cf43be9ef0a41b811308e6738e8c1d496d7b092a8e6a8374176007de`.
The system still reports loginwindow foreground and no screen-capture access;
this does not claim the user has seen or interacted with the new window.
The image PAK is byte-for-byte unchanged; the QJBC now includes model failure
cleanup. Android/iOS/Windows have not been revalidated with these SDK fixes. See the
[goal tracker](VISUAL_NOVEL_GOAL_TRACKER.md) for the full feature scope.
