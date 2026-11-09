# Multi instance memory pressure

## Source first review and ablation

The retained parent demo has a manual LRU trim action in
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_pages.js:555`.
It routes through `lib/core/pocketjs_bundle_runner.dart:1680` and
`lib/core/ffi_bridge.dart:916` to
`native/pocket_runtime_multi.c:300`. That native function halves one
sandbox's accounted off heap VRAM value. It does not observe OS pressure or
reclaim resident JS runtimes, and it is scoped to the old demo's per sandbox
resource model.

The SDK already has the matching multi instance policy in
`sdk/packages/pocket_ui/src/system.ts`: capacity pressure selects the least
recently used runtime only after excluding SystemUI, stack frames, pending
call references, presented surfaces, closing runtimes and failed runtimes.
Capacity admission and memory pressure reuse the same candidate selection and
eviction path. This adds no Dart eviction state, RSS counter or second memory
budget.

## Change

Flutter's `didHaveMemoryPressure` callback sends the current root generation
to SystemUI as `system.runtime.memoryPressure`. It sends only after the root
has produced its first frame, has no session failure, and still matches the
mounted signed catalog generation. The host does not choose runtimes to evict.

The JS kernel processes the event on its existing serialized event queue and
ignores events whose root generation is stale. It repeatedly applies the
shared LRU candidate selection until no unreferenced background runtime is
left. Each eviction uses the existing `onWillDisappear`, `onUnload`, and
`system.runtime.destroy` flow, with `reason: "memory_pressure"`. The SystemUI
runtime remains pinned. Pending calls and visible compositor presentations
remain protected.

This reclaims eligible resident runtimes; it is not a process RSS or total
memory hard limit. Per runtime QuickJS heap limits remain independent limits.

## Validation

The Flutter widget test invokes `WidgetsBinding.handleMemoryPressure` and
captures the outgoing packet at a test `PocketRuntime` transport. It verifies
that the host sends only after the root first frame, carries the active
generation, and stops after failure or disposal. The Pocket UI kernel test
sends stale and current generation events through the real JS event handler.
With a pending launch result, an active stack frame, and a presented background
surface, it verifies that only detached background runtimes receive unload
and destroy requests. It also injects one failed destroy, checks that a second
pressure event uses the existing closing retry lane, and confirms repeated
pressure does not destroy a runtime twice.

The Flutter test transport is a runtime test double; it does not execute
QuickJS bytecode. The JS kernel test executes the real SystemUI policy in Bun
with a test host. Together they validate both sides of the event boundary, but
they are not an end-to-end QJBC or real OS device pressure test. No hardware
memory pressure or aggregate RSS limit was tested.
