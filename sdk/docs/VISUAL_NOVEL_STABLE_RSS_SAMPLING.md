# Visual novel stable RSS acceptance

This protocol extends the existing real Guest / Live2D profile soak with a
bounded post-release observation for each of its 20 model-entry cycles. It
does not change production resource handling or request a garbage collection.

## Sampling protocol

The normal `demo/integration_test/novel_model_soak_test.dart` run first
completes its five real 10-second Hiyori model windows. It then performs 20
authored entry/exit cycles. After the real model handle and Hiyori draw ops
have both reached zero, the test:

1. waits one second for the release to settle;
2. reads `ProcessInfo.currentRss` five times at one-second intervals;
3. reports all five values, their median and range, and checks the real model
   handle and triangle count remain zero after sampling.

The bounded post-release observation is six seconds per cycle. A sample window
is considered stable only when its max-minus-min range is no greater than both
20 MiB and 10% of that window's median. If any of the 20 windows is unstable,
the test reports `unverified-unstable-sample-window` and fails the stable RSS
acceptance; it does not treat that window's median as proof of a stable
resident value.

For the growth comparison, the baseline is the median of the stable RSS
medians from cycles 1–5. The later value is the median from cycles 16–20.
Positive growth is `max(0, later - baseline)`. The gate passes only when all 20
sample windows are stable and positive growth is at most both 20 MiB and 10%
of the baseline. The report also retains signed growth and the two individual
limit results. `ProcessInfo.maxRss` remains a separate process peak and does
not substitute for the stable comparison.

RSS is process-wide and does not attribute Flutter images, native allocations,
or GPU memory to the model. No GC is forced. A failed stability observation
means the bounded measurement was inconclusive; it is not evidence by itself
of a leak. The pre-existing per-window 1-second RSS samples and immediate
entry/exit samples remain diagnostic facts only.

## Incomplete-run protection

The test declares `pocketAcceptance.required` before launching the Guest and
leaves `completed` empty while the workload is running. Only after all 20
cycles, the RSS checks, report creation, and host cleanup succeed does it mark
`model-stable-rss` complete. The existing
`demo/test_driver/integration_test.dart` validates this optional checkpoint
contract and writes the response even on test failure, so a timed-out or
partially executed test cannot be mistaken for a completed acceptance run.

The `POCKET_NOVEL_PROFILE_ABLATION=true` topology comparison is explicitly
separate: it runs five model windows and two entry/exit cycles, skips the seven
whole-game windows, and reports stable RSS as `not-evaluated-ablation-mode`.
It uses a distinct `model-soak-ablation` checkpoint and cannot pass the normal
20-cycle memory gate.

## Reproduction

From `demo/`, run the full Profile soak with the frozen Guest and native host:

```sh
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive --profile --driver=test_driver/integration_test.dart --target=integration_test/novel_model_soak_test.dart -d macos
```

The report is emitted as `POCKET_NOVEL_MODEL_SOAK` and integration response
data. It includes the five model windows, seven one-per-scenario whole-game
windows, 20 cycle records, each post-release RSS sample set, stable-window
status, first-five/last-five medians, positive and signed growth, both memory
threshold results, and the process peak. This is one host/OS measurement; it
does not establish platform-independent or physical-device RSS behavior.

## Full normal run: 2026-11-08

The normal Profile run completed all seven 10-second whole-game windows, five
10-second Live2D windows and all 20 model-entry/exit cycles on macOS Profile.
The exact workload, response, logs, source and Guest artifacts are archived in
`../.pocket-build/novel-stable-rss-fullrun-20261108/`; `run-manifest.json`
records their hashes and the invocation. Test source SHA-256 was
`9c918e0a5ae018be63198f872502d9e2e78a06431f44165a406c7bdce3b211be`, QJBC SHA-256
`a364702558f5c091b77a8ea679285bfb3ebb1e3affd45e2a48d5b233d9e502ff`, and PAK
SHA-256 `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`.
The test used its isolated App Support directory and did not use the ordinary
Demo store.

The real Live2D handle and its Hiyori draw ops were zero both immediately after
exit and after the post-release sample window in all 20 cycles. The real audio
plugin reported one active channel at entry and exit in every cycle; this is a
channel-count fact, not a playing-state measurement or a zero-release
criterion. Clock actor release remains unverified because the Flutter harness
has no Guest clock-count observation.

Cycles 3–8 had unstable bounded RSS windows: their ranges were about 85–109
MiB, above the 20 MiB maximum allowed range. The other 14 windows were stable.
The first-five median was 638,009,344 bytes and the last-five median was
570,753,024 bytes (signed growth −67,256,320 bytes; positive growth 0). Both
growth thresholds individually passed, but the aggregate gate was
`unverified-unstable-sample-window` and did not pass because all 20 windows
must be stable. `ProcessInfo.maxRss` was 797,097,984 bytes and remains a
separate peak value. The Flutter drive exited 1, and the required
`model-stable-rss` checkpoint remained incomplete; this run is not a stable-RSS
acceptance pass and the unstable samples do not by themselves establish a
leak.

The quantitative thresholds come from
[`VISUAL_NOVEL_GOAL.md`](VISUAL_NOVEL_GOAL.md): after 20 model cycles, stable
resident RSS must grow by no more than 10% and no more than 20 MiB relative to
the first-five median. Both limits are required.
