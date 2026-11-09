# Visual novel execution trace

## Purpose and source review

E05.2 adds an optional timeline of operations that the VN engine actually executes. The retained parent checkout `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` contains no VN instruction observer or script debugger outside `pocket_host/`. Its `lib/core/pocketjs_bundle_runner.dart` steps host frames and visual transitions; `mini_apps/syslib/pocket_syslib_pages.js` contains UI scrolling. Neither records story OP execution, so there was no parent behavior to port. The timeline reuses the SDK engine's existing execution loop and the Editor's existing debug preview.

The execution boundary is `runUntilBlocking()` in `sdk/packages/pocket_vn/src/engine.ts`. It reads the current instruction, checks a breakpoint, then runs the operation. `transact()` already owns copy-on-write rollback and controls when updates become visible. The Editor preview in `sdk/editor/client/novel.js` already drives `engine.debug.pause()`, `resume()`, `step()`, `setBreakpoints()` and `jump()` on one engine; the trace observes that engine rather than introducing another runtime.

## SDK API and entry shape

Subscribe through the existing debug API:

```ts
const unsubscribe = engine.debug.subscribeExecutionTrace(entries => {
  for (const entry of entries) {
    // entry.location, entry.op, and optional entry.id are execution facts.
  }
});
```

`NovelExecutionTraceEntry` is exported from `@pocket/vn` and contains:

- `location`: the authored instruction position, except for an implicit return where it is the label's end boundary.
- `op`: the executed instruction type. `implicitReturn` is reserved for an automatic return when a called label falls through its end.
- `id`: the authored ID, when that instruction defines one.
- `returnTo`: present only for `implicitReturn`, giving the call frame's actual continuation address.

Entries contain no inferred duration, evaluated values, rendered text or fabricated instruction ID. An explicit authored `return` is reported as `op: "return"` at its real instruction address. A call fallthrough is `op: "implicitReturn"` at the one-past-end boundary and is never presented as an authored instruction.

## Transaction and observer behavior

The trace collector is a transaction-local array created only while at least one observer is subscribed. With no observer, the run loop does not allocate per-operation payloads. The breakpoint check occurs before recording, so an instruction at which execution stops is absent. On success, the engine freezes and queues a non-empty batch; a transaction that throws or exceeds its execution budget restores state and discards its entire batch. Operations that execute no new script instruction, such as a wait tick, emit no empty batch.

The queue preserves commit order across reentrant callbacks. A batch is queued before ordinary EngineUpdate listeners run, then delivered once the outer update notification completes. If an EngineUpdate listener or trace observer starts another engine transaction, its batch is appended and delivered afterward to all observers captured for that commit. Trace callback exceptions are isolated from the engine and other observers.

Disposal clears registered trace observers and batches still waiting in the queue. If an observer disposes the engine during a batch already being dispatched, the remaining observers captured for that current commit still receive that batch; later queued batches are dropped. Subscription and unsubscription do not emit an update, advance engine time, or change save data. Trace data never enters `EngineUpdate`, snapshots, saves, rollback checkpoints, or audio/video event types.

## Editor timeline

The preview subscribes to its current engine and removes that subscription when the preview engine is replaced or disposed. The timeline shows the newest 200 entries, with a local display ordinal, location, operation, and authored ID when available. It has no duration column. Clearing the list changes only Editor display state. Pause, breakpoint, step and jump controls still call the same engine debug API.

The preview clock updates the live view, variables and current location through `renderPreviewNow()`; it does not render the trace list. A tick with no newly executed OP leaves the existing trace row DOM intact. When a committed trace batch arrives, the renderer reuses rows still inside the 200-entry window, adds new rows and removes expired ones. Its DOM cache key uses the observed trace window plus the existing `historyGeneration` revision. Source locators are re-indexed once for the reconciliation and refreshed after story edits; this avoids a per-clock full-list rebuild and a full-story scan per trace row. Reopening the preview uses the existing workspace render lifecycle to build the list against the current story and engine.

Selecting a trace row opens the corresponding story label and instruction. The Editor checks the source story captured when the engine was created: a stable authored ID is matched first; without an ID, it uses the exact source instruction and only relocates it if the match is unique. If later edits make that source ambiguous or remove it, the row is disabled. For an implicit return, the Editor can locate the last authored instruction before the label-end boundary; it does not create a synthetic story row.

## Validation

`sdk/packages/pocket_vn/test/execution-trace.test.ts` exercises nested calls, authored and implicit returns, branch/jump, wait, choice, ending, debug step, breakpoints, failed-transaction rollback, inert subscriptions, empty ticks, observer exceptions, FIFO ordering under EngineUpdate and trace-observer reentrancy, and disposal during dispatch.

`sdk/editor/test/novel_debug_trace_browser.test.ts` runs the Editor in a temporary project with Playwright Chromium. It validates the 200-entry limit, actual nested execution entries, breakpoint-before-execution, stepping, pause/resume without row replacement, row identity across an appended batch, source navigation, disabled location after the referenced instruction is removed, clear-without-engine-reset, new-engine refresh, and unchanged `story.json`.

The browser test was run with the pinned environment:

```sh
POCKET_TOOLS_PACKAGE="$PWD/sdk/.pocket-build/retina-native-tools-20261108" \
  "$PWD/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun" \
  test --timeout 60000 sdk/editor/test/novel_debug_trace_browser.test.ts
```

Result: one Chromium browser test passed. Captured output: `/tmp/pocket-novel-debug-trace-browser-20261108.log`.

Root independently ran the complete `packages/pocket_vn/test` suite with pinned Bun 1.4.4 against this engine source: **162 passed, zero failed, 1,381 assertions**, covering 34 files. Log: `/tmp/pocket-vn-trace-regression-20261108.log`. The targeted VN/view TypeScript project also passed; this is not a whole-monorepo typecheck.
