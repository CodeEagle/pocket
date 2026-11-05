# Rendering and transport review, 2026-11-05

## Scope and retained source

This review covers the shared SDK render/input/event paths, current native ABI,
and the WeChat adapter affected by shared SDK bridge changes. JSON configuration,
package metadata, canonical update signatures, replay archives, storage snapshots
and editor HTTP/probe formats remain explicit formats. Removing those files
would not reduce render-loop work and would break their public contracts.

Source-first inspection used the retained parent
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/`. Its `lib/main.dart` avoids root rebuilds from performance
sampling and defers prewarming until after the first frame;
`lib/core/pocketjs_bundle_runner.dart` retains and lazily mounts page trees;
`lib/render/pocket_ui_components.dart` documents JS-owned visual recipes;
`wechat_host/core/wx_pocket_host.js` flushes a DrawList batch to canvas. These
behaviors inform the retained thin-host architecture and demand-driven redraw.
The predecessor's Flutter business-widget composition is deliberately not copied:
the current architecture requires JS-owned UI and the pinned PocketJS layout
engine. The existing SDK `pocket_view.dart`, `pocket_runtime.dart`, native
`lib.rs` and pinned upstream `programs/web/wasm/src/browser.rs` are adapted;
input capture ordering, real GuestFrame transactions and resource ownership
remain intact. No substitute runtime or Dart route/state machine was added.

## Changes

- Pointer validation occurs before wakeup. A successful duplex publish wakes
  once through the existing callback. Pointer maps are constructed only when
  the fixed-size ring is unavailable/full, and the FIFO retains event ordering.
- Current FFI frame/event/message transport requires binary entry points. Missing
  binary ABI symbols are errors, rather than silent JSON fallbacks.
- Shared JS capability, text-input, display, media, platform, and system event
  bridges pass objects. Surface registrations pass objects as well.
- The pinned framework offload client and native broker exchange request/reply
  objects through `submitValue`/`takeValue`; replies are retained as typed data.
  The existing B2 provider boundary and trace/replay semantics are retained.
  WeChat explicitly reports a disconnected offload provider and preserves the
  pinned coverage uploader instead of claiming native provider support.
- Stream batch admission counts exact B1 TLV bytes without allocating JSON
  text. Surface memos compare their small flat objects to preserve the former
  string memo's suppression of equal registrations.
- PFB1 host-surface parameters are retained as `0xB1` typed data. The production
  decoder no longer parses a JSON descriptor or event segment per frame.
- WeChat uses the same native `0xB1` codec and a JS codec at its Wasm boundary,
  including pointer input facts and scheduler queries. Native offload `0xB2`
  record helpers were separated from the shared object codec to permit reuse.
- Diagnostic JSON APIs are explicit tooling APIs. They cannot become a fallback
  for the canonical SDK runtime.
- Binary/duplex dispatch rejects unmarked legacy Guest callbacks rather than
  silently stringifying their packets. Explicit `pocket_send` diagnostics retain
  their own legacy text contract.
- Paragraph measurement invalidates stale widths on viewport changes and reads
  parent changes on existing active frames. Pending initial measurement alone
  requests continuous frames; the invalid `self-stretch` class was removed.

Native input validation and the pinned WeChat input adapter still use
`serde_json::Value` as a generic in-memory value tree before the official input
schema consumes it. This is not JSON text parsing or serialization. The review
does not claim that every generic value allocation has been eliminated; a second
special-purpose input decoder was not added without measured justification.

## NSH provenance and effective batching

The retained NSH reference uses a JS turn → native `OpContext` →
`Core::commit()` → deduplicated `MountBatch` → one platform submission.
Relevant source is `crates/nsh-js/src/host_channel.rs`,
`crates/nsh-core/src/host_channel.rs`, `crates/nsh-engine/src/host_channel.rs`,
`crates/nsh-engine/src/lib.rs` and Android `encode.rs` in the inspected reference
at commit `932e4aebca34723d386cf5ad0095f5c0184c0b2d`.

Pocket already has an equivalent coarse boundary: QuickJS invokes the pinned
`OpContext` in process; a frame produces a DrawList which crosses Flutter FFI
once as PFB1 or PFP1. Adding another op queue would duplicate that boundary.
The 16-byte SPSC pointer ring, `0xB1`/`0xB2` codec, PFB1 and PFP1 are Pocket
implementations. The repository's explicit NSH provenance records concern guest
sandbox hardening. There is no source evidence that these Pocket transport
protocols were transplanted from NSH; this review does not claim otherwise.

## Ablation

`demo/js/scripts/render_pipeline_ablation.ts` boots the actual Showcase bytecode
and compares 15 consecutive frame pairs per route at block sizes 16/32/64/128.
The final run uses the isolated staged native runtime with its ordinary 16 MiB
default heap and the rebuilt Demo QJBC. At 32 ops, the mobile transition repaints
about 157 ops per pair, transitions about 150, and home about 210. Increasing to
128 repaints 157/150/220 respectively.
There is no evidence for increasing the production block size. The new UI
changes most operation coordinates during transitions; splitting into smaller
retained blocks cannot make a whole-scene geometry change static.

`pocket_view_transform_ablation_test.dart` uses real JS and native DrawOps to
compare 128 individually moved rectangles with an identical retained scene
under a Flutter ancestor translation. Pixel output is identical at offsets
0/1/2/3. Moving all JS coordinates repaints 128 ops each step; the retained
ancestor transform repaints zero operations. This is evidence for possible
future explicit transform metadata, not an implemented production feature.

The profiler `demo/integration_test/render_pipeline_profile_test.dart` uses the
actual Showcase QJBC under macOS profile mode. It samples frame build/raster,
native calls, painted operations and an input burst. Its fully-live test binding
produces heartbeat frames, so sample frame counts are not natural idle FPS.
Cold/warm route samples must be distinguished from end-user device guarantees.

## Verification

- Isolated staged native patch: `cargo test --tests`, 118 passed (95 library
  tests); one manual throughput benchmark remains intentionally ignored. This
  separately checks that the commit does not depend on unrelated preview/trace edits in
  the shared working tree.
- Rebuilt macOS release native library: 63 distinct related Flutter tests passed
  across model/FFI/input/offload/replay and transform ablation. Guest JSON helpers
  are disabled in binary input/delta/surface/offload regression cases. The B1
  input case verifies malformed text rejection followed by valid input.
- JS bridge suites pass in isolated processes (44 tests plus the vocabulary
  assertion script); this avoids the existing cross-file Bun mock leakage.
  Pinned framework/offload related suites pass 47 tests, and WeChat codec and
  lifecycle suites pass 10 tests. The offload patch bootstraps idempotently.
- `python3 sdk/scripts/probe_frame_transport.py <native-library>` measured the
  actual ABI: 100-op initial frame 3741 B, idle 0 B, one changed operation
  PFP1 106 B, stale-baseline full recovery 3741 B. The probe also disables guest
  JSON helpers. This proves the delta path is active, not just exported.
- Pinned Demo SystemUI/Profile/Lobby QJBC artifacts were rebuilt. Generated
  binaries/caches are verification outputs, not part of the source patch.
- Actual Node WebAssembly probes passed for single Guest touch changes and a
  three-Guest System build. All three Guests boot; Lobby touch changes both
  count and framebuffer; SystemUI opens Profile and uploads its focused
  compositor surface. Scheduler, events, responses, input facts and compositor
  frames use B1. This exercises the generated bundle with a WX/canvas boundary
  adapter; it is not a claim of WeChat device/DevTools coverage.

The full JS SDK suite initially exposed geometry regressions in the dirty UI
work and an existing safe-area expectation. HEAD UI with the same rebuilt native
library passes the paragraph/progress scenarios; the safe-area test also fails
with HEAD (it expects a transparent app bar while the default draws white).
This baseline distinction is preserved rather than masking the failing test.
The current uncommitted component UI also still fails a PopupSheet interaction
assertion after the progress checks. This review does not report the whole UI
suite as green or attribute that assertion to a verified HEAD baseline.

The desktop profiler explicitly resumes the test lifecycle before each sample:
macOS focus loss otherwise deliberately suspends PocketView and produces
invalid zero-work samples. Its heartbeat frame counts are not idle FPS.

The final actual macOS profile run passed at 60 Hz: 565 sampled Flutter frames
across idle, nine route windows, and a 96-move input burst; none exceeded the
16.67 ms build or raster budget. Per-route native P95 ranged 0.312–1.640 ms.
The first mobile sample's maximum build/raster durations were 15.913/11.181 ms;
the other route windows peaked at 5.177/4.544 ms. The input burst's native P95
was 0.630 ms, with 22 text DrawOps observed moving. The idle window issued no
native frame calls and painted no canvas blocks. These numbers describe the
current Showcase UI workload on this desktop; they do not isolate each patch's
contribution or establish physical mobile-device performance.

The retained parent contains no offload broker to migrate. The new reproducible
`offload-direct-value.patch` adapts the existing pinned
`framework/src/offload.ts` and `contracts/spec/offload.ts`, with their regression
fixtures, rather than adding a second client or scheduling queue. Payload
strings remain the provider's opaque business contract. Native typed and legacy
trace replay tests both pass.
