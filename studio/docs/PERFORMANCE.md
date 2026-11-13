# Pocket Studio performance, memory and leak bounds (M7, Linux part)

All numbers below were measured in the Linux container (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, kernel 6.18) with the **debug**
native library (`sdk/native/target/debug`, unoptimised Rust + QuickJS) and the built Studio bytecode. They are
**regression bounds, not frame budgets**: a release/profile build on Apple Silicon is much faster, and the 16.67 ms frame budget
can only be judged there. macOS profile-build frame budgets are **deferred** (`RELEASE_CHECKLIST.md`, Spike B).

## What is measured and how

`studio/js/tests/studio_profile.test.ts` drives the built guest on the real native probe (`pocket_probe`, real QuickJS) with the
stateful fake `studio.*` service (the guest-side cost is the subject; service latency is not). Scenario script: open project,
open a 5,000-line (about 270 KB, chunked read) file in the code editor, 120 wheel-scroll steps, 100 typed characters
(`input.text` commits), Cmd+S then Cmd+B (shell keymap), Cmd+8 + tap "发布测试包", then six rounds of 6 quick-open
open + Cmd+W close cycles (leak check).

| Measure | Source |
| --- | --- |
| frames, changed frames | frame commands issued; "changed" = draw ops differ from the previous frame (a frame that actually rebuilt output) |
| p50 / p95 / max ms | wall time of one `frame` command = guest turn (JS) + native layout/draw-list build + JSON serialisation by the probe |
| rssMB | `VmRSS` of the probe process after the scenario (QuickJS heap, native caches, draw lists) |
| QuickJS heap high-water | bisected: the smallest `memory.heapLimitBytes` (a real QuickJS allocator ceiling, `APP_MEMORY_LIMITS.md`) under which the whole sequence still completes. The SDK exposes **no** used-bytes counter, so this is the only exact QuickJS measure available; resolution 4 MiB |
| text layout cache stats | Flutter side (`PocketViewController.textLayoutCacheStats`), printed by `studio/test/studio_code_editor_test.dart` as `STUDIO_PROFILE_DART` / `STUDIO_CODE_E2E` |

The per-frame guest turn limit is 250 ms (the probe fails the frame beyond it), so a bound of "p95 < 250 ms" is the hard contract;
the asserted bounds are listed at the end.

## Results (guest, probe)

Command: `cd studio/js && POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bash scripts/test_guest.sh` (or
`bun test tests/studio_profile.test.ts`; `STUDIO_PROFILE_HEAP=0` skips the heap bisection, `STUDIO_PROFILE_LINES=N`,
`STUDIO_PROFILE_CHURN=N` scale it). Output lines start with `STUDIO_PROFILE`.

| scenario | frames | changed | p50 ms | p95 ms | max ms | RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| open project | 4 | 3 | 2.0 | 6.4 | 6.4 | 10 |
| open 5000-line file | 57 | 4 | 5.6 | 51.8 | 92.5 | 22 |
| scroll 120 wheel steps | 120 | 120 | 14.2 | 23.1 | 24.0 | 24 |
| type 100 keys | 100 | 100 | 6.8 | 8.3 | 15.5 | 25 |
| build (Cmd+B) | 17 | 2 | 0.9 | 3.5 | 3.5 | 25 |
| publish (test channel) | 20 | 5 | 0.9 | 14.7 | 14.7 | 25 |
| tab churn 6 x 6 open+close | 900 | 288 | 4.7 | 44.5 | 117 | 31 |

Reading: opening the big file is the only heavy moment (virtualised CodeView mounts about 40 rows; the first frames also
tokenise, 92 ms worst frame, inside the 250 ms budget; `CodeView` slices tokenisation with a 60 ms budget). Scroll and typing are
bounded per frame and do not grow with file length.

**Leak check.** Tab open/close churn: RSS 25 MB before, 28 MB after a 2-round warm-up, 31 MB after 6 more rounds (36 open+close
cycles); a 24-round run ends at 30 MB, so growth is a one-time cache fill, not linear. Unit-level checks
(`keymap.test.ts`, "resources are released"): one watch stream and one build stream after any number of project switches, editor
buffers dropped with their document, toast list <= 4, build log ring <= 2,000 lines. No leak was found, so no production
fix was needed for this.

**Heap.** `STUDIO_PROFILE heap ...`: the whole scenario sequence (2,000-line file, 40 keys) completes under a QuickJS heap of about
13.6 MiB above the PAK (bisection resolution 4 MiB), inside the SDK's historical 16 MiB default and far below the Studio host's 2 GiB
ceiling (`studioSystemUI`).

## Results (host, Flutter + real service)

`cd studio && flutter test --no-pub test/studio_code_editor_test.dart` (5,000-line file through the real PocketView, real service):

```
STUDIO_CODE_E2E  5,001 lines / 355,567 bytes
  textLayoutCache before scroll          capacity 2048, length 126, layouts 126
  textLayoutCache after 40 down + 40 up  length 366, hits 20,103, layouts 366, evictions 0
STUDIO_PROFILE_DART  100 single-character IME commits
  host-observed wall per key (incl. the helper's 150 ms pump)  162 ms  (dominated by the pump, not by the guest)
  process RSS 272 MB before, 271 MB after (Flutter test harness + native runtime + debug build)
  layout cache length 630 / capacity 2048, hits 37,421, layouts 630, evictions 0
```

Capacity 2,048 holds the whole working set of a 5,000-line file (630 distinct layouts after scrolling and typing, zero
evictions); the 256 default would thrash (see `sdk/docs/STUDIO_TEXT_INPUT.md`, section B). Typing 100 keys adds no memory and no
cache growth beyond the lines touched.

## Record/replay cost

`studio/test/studio_recording_test.dart` (about 26 s wall, debug build): one recorded Studio runtime, 355-375 host transactions and
122-130 frame digests per run (the count varies with timing; the checkpoints do not), replayed offline in a fresh guest and again from
the exported archive, all matched.

## Asserted regression bounds (generous on purpose)

| Where | Bound |
| --- | --- |
| every scenario (guest) | p95 frame < 250 ms (the guest turn budget), max < 2,000 ms, RSS < 900 MB |
| typing 100 keys | p50 < 120 ms per frame |
| tab churn after warm-up | RSS growth < 40 MB over 36 open+close cycles |
| tab churn | at least 36 file reads really happened (the churn is not a no-op) |
| QuickJS heap high-water | <= 16 MiB above the PAK (the SDK default) |
| layout cache (host) | length <= capacity, evictions < 20 x capacity |
| host process | +300 MB at most across 100 keys, < 4 GB total |

A bound failing means an order-of-magnitude change (a leak, a quadratic path, cache thrash): investigate, do not just raise it.

## Deferred (macOS)

* Profile-build frame budgets (UI build / raster p95, over-budget frames at 16.67 ms) for open, scroll, typing, build and publish:
  `RELEASE_CHECKLIST.md`, Spike B. The Linux debug numbers above say nothing about them.
* Real-keyboard latency and IME candidate-window timing (Spike A), compositor latency (Spike C).
* Release-build native timings (`pocket_bench`-style) for the Studio bytecode.
