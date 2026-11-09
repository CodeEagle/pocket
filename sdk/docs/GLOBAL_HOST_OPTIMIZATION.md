# Global host optimization

## Scope and source-first review

This iteration follows the bootstrap/resource-copy ablations with four independent changes: repair the native Demo acceptance baseline, respond to OS memory pressure through JS policy, remove evidenced frame-processing redundancy, and overlap startup IO / deduplicate observer notifications.

- [Demo acceptance baseline](OPTIMIZATION_BASELINE.md): separately correlated status requests and actual dialog completion; full native guest acceptance passes.
- [Memory pressure policy](MEMORY_PRESSURE_OPTIMIZATION.md): native pressure fact, JS-owned LRU policy and protected resident references.
- [Frame structural sharing](FRAME_REDUNDANCY_OPTIMIZATION.md): reuse the immutable primary operation list for empty PFP1 splices; no new ABI or protocol state.
- Startup and observer publication changes are described below.

For startup and host notifications, the retained parent sources inspected were:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`: native setup followed by lazy first-tab activation; listeners publish runner changes.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart`: passive Flutter timing callbacks and separate theme notifications. Its placeholder performance values and Dart-owned business state are not migrated.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`: runner lifetime and listener-driven host composition.

The parent has no equivalent persisted `PerformanceHistory` bootstrap or SystemUI instance snapshot controller. These are adaptations already implemented by the thin SDK host; this iteration modifies those existing boundaries rather than adding another loader, scheduler, or app-policy state machine. `pocket_host/` was excluded.

## Startup IO and parsing

`PocketSession._initialize` now starts history restoration alongside metadata and manifest loading. All three operations must finish before admission. Both nested waits use non-eager error handling, so a failure does not leave sibling initialization IO outside the session's `close()` lifetime. This overlaps independent IO while retaining the existing history-before-admission guarantee.

The manifest is decoded once; the same decoded document supplies capability admission and the embedded-build check. Inline bootstrap JSON continues to bypass the bundle.

The integration test gates history path resolution and metadata independently. Both asset requests must arrive while history is blocked; admission must remain pending after metadata is released until history is also released. This proves concurrency and preserves the startup barrier without wall-clock speed assertions.

## Host observer notifications

`PocketSystemHostController` compares every public snapshot fact, including session identity, first-frame future identity, runtime generation, readiness, presentation and compositor focus. Repeated host publications with an identical ordered list retain the published list and do not notify observers. New first-frame facts still notify immediately. Session-originated notifications explicitly bypass this filter: the exposed session reference also contains live failure/update state not captured by the immutable snapshot fields. A regression verifies that failure after an offstage first frame still notifies observers. The controller remains fact-only, and native lifecycle/session listeners retain their behavior.

This avoids redundant observer notifications and published-list wrappers, not every temporary snapshot allocation or every host widget rebuild. No general public equality contract or duplicate state ledger is introduced.

## Validation and measurement boundaries

The first focused run of `flutter test --no-pub --reporter expanded test/session_integration_test.dart test/pocket_system_host_test.dart` passed all 10 tests, including the gated startup and duplicate first-frame notification checks.

Negative ablations both failed at the intended assertion, and production code was restored after each experiment:

- Restoring history-before-assets serialization prevents the asset request from arriving while history is blocked; the gated test times out after five seconds. `/tmp/pocket-global-history-serial-ablation.log`.
- Restoring unconditional controller publication makes duplicate first-frame callbacks notify twice instead of once. `/tmp/pocket-global-notify-ablation.log`.

Scoped startup analysis reported no issues. Final integrated validation is recorded below after execution. Machine-local command logs use the `/tmp/pocket-global-*` prefix.

With `POCKET_NATIVE_LIBRARY` pointing to the existing debug native library and `POCKET_ON_DEMAND_FIXTURE_DIR=/tmp/pocket-on-demand-fixture-verify`, the final startup/upgrade/download suite passed **59 tests, zero skipped**:

```sh
cd sdk
flutter test --no-pub --reporter expanded test/session_integration_test.dart test/session_upgrade_test.dart test/session_download_on_open_test.dart
```

This includes a failed asset read while history remains blocked: initialization and `close()` both wait for that history work and then surface the asset error. It also includes a signed QJBC download, rendering, and pointer-driven frame change. Log: `/tmp/pocket-global-session-final.log`.

The changed startup, controller, runtime and associated test files passed scoped Dart analysis with no issues (`/tmp/pocket-global-final-analyze.log`). The Demo baseline and frame workstream reports record their own executed commands, including the full guest acceptance run and 45 frame/invalidation/video tests with no skips.

The host snapshot/lifecycle test pair (`pocket_system_host_test.dart` and `system_host_test.dart`) passed 12 tests combined. The added `pocket_system_memory_pressure_test.dart` passed its single observer/transport test and scoped analysis. The JS kernel suite passed 17 tests, including stale generation rejection, protected references, repeated pressure, and retry through the existing closing queue after a transient destroy failure. The observer test uses a test-only runtime sink; it does not claim device OS-to-QuickJS pressure validation. The initial widget cleanup used the fake-async zone for disk teardown and hung; moving the close operation into `tester.runAsync` before unmount fixed the test lifecycle without a production change.

An independent read-only integration review found no new clear regression in startup draining, session notification forwarding, generation gates, or immutable DrawOps sharing. Memory reclamation remains best effort: a failed close is retained for a later host-event retry, and no process-wide RSS cap is promised.

### Shared-workspace validation boundary

The official-demo integration was being edited concurrently in the shared worktree. Its Dart entry/catalog and generated assets are outside this iteration's file ownership and were preserved. The final global architecture guard currently exits 1 for `demo/lib/main.dart` exceeding its 100-line limit (148 lines at execution) and the new `demo/lib/official_demo_catalog.dart` being outside the allowed thin-host file set. Log: `/tmp/pocket-global-architecture-final.log`. Earlier architecture checks passed before those parallel edits arrived. No guard was weakened to turn this result green.

Acceptance results describe the code snapshot at each command's execution; later parallel changes to the Demo and its artifacts are not implicitly covered by those results. `git diff --check` passed at integration review.

For further device profiling, compare the same pinned bytecode, viewport and input sequence with diagnostics configuration held fixed. Report cold/warm first-visible and first-interactive latency separately; use frame P95/P99, native-to-Dart bytes, idle wake count, process memory and decoded image/texture memory where observable. A QuickJS heap ceiling is not a process RSS or GPU ceiling. Do not infer device speedups from desktop unit tests or operation-count reductions. Heavy computation should use the existing Worker only when measured UI-thread cost justifies the transport; no speculative workload migration is included here.
