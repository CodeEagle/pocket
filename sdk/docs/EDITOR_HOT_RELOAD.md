# Editor development root replacement

Production loading and package activation still use the pinned `buildGuest`
QuickJS bytecode pipeline. Editor root replacement is an explicit development
capability, not a second compiler, renderer, general module HMR, or OTA format.

## Source and retained behavior

The retained parent `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
contains `updateTextInPlace`; its Flutter-owned business/widget state is not
ported into the thin host. The parent
`lib/core/pocketjs_bundle_runner.dart` was inspected for update behavior. The
current pinned framework's `framework/src/index.ts` `mount`/`render` disposer
already cleans native nodes, reactive computations, resize, touch, text and
gesture subscriptions. Replacement reuses that disposer instead of adding a
parallel lifecycle manager in Dart.

## Application opt-in

```tsx
import { mountHotRoot, registerHotState } from "@pocket/ui/dev";

// Within a component's existing cleanup lifecycle:
onCleanup(registerHotState("counter", {
  read: () => count(),
  write: value => { if (typeof value === "number") setCount(value); },
}));
mountHotRoot(() => mount(() => <App />));
```

Only explicitly registered JSON UI values survive. Native handles, pending
requests, active application instances and credentials should not be retained.
Checkpoint data is bounded to 64 KiB, depth 16 and 4096 entries; at most 128
bindings are allowed. Module-level side effects outside the mounted root must
provide their own cleanup; arbitrary dependency/module replacement is not
supported.

Editor serializes input, frames and replacement through its existing queue.
Session, base build and next build must match. It snapshots state before
disposing, evaluates the completed compiler-produced source in the same VM,
mounts the new root, restores bindings and commits the new build identity.
Acknowledgements use per-command nonces. Stale commands are rejected.

Resource PAK, runtime ABI, tick rate, guest manifest and project configuration
must remain compatible. Worker builds, live child applications, active pointers
and pending host/plugin operations force complete QJBC loading. A replacement
failure also discards that VM and reloads the completed bytecode artifact.
Diagnostic source must match the compiler metadata's SHA-256; no browser-supplied
code is accepted by this path.

## Verification

`sdk/packages/pocket_ui/test/dev.test.ts` covers state and lifecycle boundaries.
`sdk/editor/test/hot_reload.test.ts` compiles real guests with the pinned compiler
and drives `pocket_probe`: click count 0→1, rebuild increment behavior 1→2,
preserve count 1, click to 3. A changed PAK forces full loading and resets count
to 0. The test also rejects a modified diagnostic source hash. This verifies
input-driven execution rather than a static render placeholder.
The same fixture has a bundled Playwright Chromium acceptance path: it focuses
the real `InputField` textarea, replaces the root, verifies the old DOM editor
is closed, then reopens it and accepts later browser input. The fixture installs
the same `deliverTextInputEvent`/`__pocketEvent` guest bridge used by the
Showcase so the DOM assertion exercises the actual text round-trip.

## Lifecycle generation hand-off

The native frame pump can observe a root disposer edge before the replacement
root is mounted, while the browser projection is published only after the
commit turn. `PreviewRuntime.pendingBrowserEvents` therefore stores the
emitting generation with every `textInput.*` and `video.*` edge. The editor
increments the root generation immediately after a successful `prepare`,
before evaluating the replacement source; old cleanup is consequently emitted
with `system-ui:1`, while the new mount uses `system-ui:2`. The stale-token
guard remains strict for browser text edits and video diagnostics.

The browser projection also scopes video intent/release bookkeeping by
`runtimeToken`. It retains at most one release tombstone per scoped identity,
bounded to 128 identities; an old `video.release` for a reused `(asset,id)` can
dispose the old element, but cannot mark the new generation as permanently
released.
The native compiled lifecycle fixture in
`sdk/editor/test/hot_reload.test.ts` asserts old text/video cleanup tokens,
new video tokens/ops, and a post-replacement text editor open edge.

The publication queue no longer trims its oldest lifecycle edges. A root with
128 media registrations can emit old-generation cleanup and replacement media
intent before the same browser publication; dropping that prefix can leave the
old textarea open or lose the new video's pause intent. Repeated video commands
are coalesced by generation, command name and media id, with the replacement
moved to the tail to preserve the latest command order. Text events retain
their full order, including value-bearing and rect-only updates and their
revision checks. The queue has a hard limit of 512 entries; exceeding it raises
an explicit error rather than publishing a silently truncated projection.
During root replacement that error triggers the existing completed-bytecode
reload fallback; outside replacement it reports a preview failure.

The compiled lifecycle and Playwright acceptance fixtures use 128 actual Video
registrations, an open InputField, root replacement and a subsequent input
round-trip. The native fixture checks all 128 old release identities and all
128 replacement pause identities. Another compiled guest checks that a
value-bearing text update survives a following rect-only update, and that
pause/play/pause ends with play/pause after video coalescing.
This reuses the existing native event/projection boundary instead
of adding a second browser lifecycle state machine.
