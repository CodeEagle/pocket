# Incremental transport / HMR remediation, 2026-11-05

Both P2 findings from the second review are fixed in the isolated worktree
`/Volumes/ORICO/Development/Github/pocket-worktrees/runtime-incremental-20261104`.
The review candidate before these changes was tree
`56d19d5fcf4e672e0452ba8f250b837b6f587859`. No commit was created and the main
working directory's parallel changes were not modified.

## N1: resource acknowledgement across resize

`sdk/native/src/lib.rs` preserves the published frame sequence across viewport
resize while invalidating DrawOps. A matching caller sequence now confirms
resources independently of whether an operation splice is possible. Dart's
successful `resizeViewport` keeps the already-decoded baseline for that echo;
native still returns full PFB1 operations for the resized viewport. Error
paths retain their existing invalidation behavior.

`sdk/native/tests/frame_delta_cache.rs` reproduces the actual failure: receive
a texture, resize, release it, drop the release packet, and request recovery
using the previously received sequence. The recovered full packet now repeats
the release. The real Native ABI reproducer likewise reports:

```json
{"first":{"seq":1,"resources":["pocket.texture.0"],"released":[]},"dropped":{"seq":2,"resources":[],"released":["pocket.texture.0"]},"recovered":{"seq":3,"resources":[],"released":["pocket.texture.0"]},"missingRelease":false}
```

No second Dart resource ledger or frame history was added. The existing
acknowledged-resource snapshot and decoded baseline are reused. Full transport
details and retained-parent source paths are in
[INCREMENTAL_FRAME_TRANSPORT.md](INCREMENTAL_FRAME_TRANSPORT.md).

## N2: HMR cleanup and replacement intent

`sdk/editor/preview.ts` removes FIFO prefix trimming. Repeated video commands
are coalesced by generation, command name and media id, moving a replacement
to the tail so pause/play/pause finishes in pause. Text input events remain
ordered: a rect-only update cannot overwrite an earlier value/selection
update before the browser observes it.

The queue remains bounded to 512 entries; an additional distinct event raises
an explicit error before insertion. During HMR this uses the existing full
bytecode reload fallback. Outside HMR it reports a preview error, rather than
silently publishing incomplete lifecycle state. This is an explicit limit,
not a guarantee of arbitrary lifecycle bursts.

`sdk/editor/test/hot_reload.test.ts` now checks all 128 old-generation release
identities and all 128 replacement pause identities. The real Chromium fixture
checks old textarea cleanup and subsequent input. Another compiled native
guest verifies value-bearing update followed by rect-only update and repeated
video command ordering. See [EDITOR_HOT_RELOAD.md](EDITOR_HOT_RELOAD.md) for
the retained-parent source review and existing lifecycle boundary reused here.

No browser lifecycle state machine, fallback renderer or unbounded queue was
added. The redundant FIFO eviction path was removed.

## Validation

Commands below ran from this worktree unless another directory is given.
Flutter commands ran serially. Two Luna Max workers implemented independent
modules; another Luna Max worker reviewed them read-only, and the primary
agent inspected the integrated code and reran final acceptance tests.

| Command | Final result |
| --- | --- |
| `cargo build --locked --manifest-path sdk/native/Cargo.toml` | Passed; worktree debug dylib rebuilt |
| `cargo test --locked --manifest-path sdk/native/Cargo.toml` | 113 passed, 0 failed, 1 ignored manual throughput benchmark |
| `cargo test --locked --manifest-path sdk/native/Cargo.toml --test frame_delta_cache -- --nocapture` | 4 passed, included in full Rust count |
| In `sdk/packages/pocket_flutter`: `flutter analyze --no-pub` | No issues |
| Same directory: `flutter test --no-pub --concurrency=1` | 173 passed, 0 failed, 0 skipped |
| `bun test sdk/editor/test/hot_reload.test.ts --timeout 240000` | 4 passed, 0 failed, 47 assertions, includes Chromium |
| `bun test sdk/editor/test/preview_input_browser.test.ts sdk/editor/test/preview_video_browser.test.ts --timeout 240000` | Input passed; video failed at Chromium launch before preview execution |
| `bun test sdk/editor/test/preview_video_browser.test.ts --timeout 240000` | Standalone retry passed, 0 failed |
| `python3 /tmp/pocket-fix-resync-invalidation-20261105.py` | Passed; recovered release present, missingRelease=false |
| `python3 sdk/scripts/check_architecture.py` | Passed |
| `node --check sdk/editor/client/preview.js` | Passed |
| `git diff --check` | Passed |

Environment for Flutter tests:

```text
POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket-worktrees/runtime-incremental-20261104/sdk/native/target/debug/libpocket_flutter.dylib
POCKET_RECORDING_WORKER_FIXTURE_DIR=/Volumes/ORICO/mac-caches/tmp/pocket-incremental-worker-fixture-20261104
```

Environment for editor tests:

```text
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket-worktrees/runtime-incremental-20261104/sdk/native/target/debug/pocket_probe
POCKET_PLAYWRIGHT=/tmp/pocket-playwright-review/node_modules/playwright/index.mjs
```

Final successful test cases total 292, with the one manual Rust benchmark
ignored. The initial video attempt's Chromium debugging-pipe disconnect is
retained as an actual setup failure; its standalone retry succeeded. This is
not a claim that the repository-wide Bun suite was rerun or is entirely green.

Primary-agent logs:

- `/tmp/pocket-fix-native-test-20261105.log`
- `/tmp/pocket-fix-n1-flutter-analyze-20261105.log`
- `/tmp/pocket-fix-n1-flutter-test-20261105.log`
- `/tmp/pocket-fix-hmr-final-20261105.log`
- `/tmp/pocket-fix-editor-input-video-20261105.log`
- `/tmp/pocket-fix-editor-video-retry-20261105.log`
- `/tmp/pocket-fix-resync-invalidation-20261105.log`
- `/tmp/pocket-fix-architecture-20261105.log`
