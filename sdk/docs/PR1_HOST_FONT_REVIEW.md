# PR #1 host-font review and ablation

## Source and retained behavior

Before changing the font integration, inspect the retained parent outside its
`pocket_host/` directory: `lib/core/ffi_bridge.dart` and
`lib/render/pocket_ui_components.dart` (the text node branch around line 1256).
The parent resolves system text styles through Flutter. It has no reusable
host-font PAK admission marker, deterministic native measurement trace, or
TEXT_RUN wire extension. Keep the pinned PocketJS compiler and the SDK's
existing native/Flutter implementation; do not migrate the parent business
widget renderer into the SDK.

The PR's `VISUAL_NOVEL_FONT_RENDERING.md` describes the adapted pipeline.
Explicit custom fonts and Web/WeChat software raster builds retain baked
atlases. The default Flutter host path uses OS metrics and vector text.

## Review fixes

- Host-font generated manifests remove obsolete `text.glyphs.baked` from
  required and optional capabilities while preserving unrelated declarations
  and the consumer's original manifest. A host-only PAK must not require both
  font implementations.
- Recorded `hostTextAdvance` JSON values must fit a finite native `f32`.
  Reject finite `f64` values such as `1e300` before replay can overflow them.
- Installed host metrics must not override explicit baked fonts. Select the
  native measurement and tracked/affine draw path from the admitted PAK font
  marker/atlases, including after host refresh and guest reinitialization.
  A production-load regression verifies PAK advances and glyph images against
  host-table advances and `TEXT_RUN` output.
- Remove the View's duplicate native font refresh after recording. Runtime
  owns deferred metric synchronization; View invalidates its layout cache and
  schedules repaint. This preserves standalone runtime use and one update
  boundary.
- Preview keeps one active table during recording, defers the latest browser
  update until captures stop, and synchronizes a child that was still loading
  when the active table changed before attaching it. Two real native-probe
  regressions cover recording root/child creation and the pending-load race;
  failed refreshes remain observable and retryable.
- Recognize the SDK's optional media capability vocabulary during system-plan
  validation without advertising audio availability in the default target.
- Fix obsolete catalog, direct-value transport and patch-composition fixtures.
  Run JS test files in separate processes so their module mocks cannot replace
  actual motion/routing/accessibility implementations in other tests. Type generation
  checks continue using actual public transport sources and both positive and
  negative consumers.
- CI uses the repository Flutter pin, installs Chromium, and builds the current
  WASM/runtime pair for browser execution. Web game fixtures explicitly bake
  fonts and no longer assume a Darwin-only tool package on Linux.
- UI frame fixtures recognize actual rounded panel commands while retaining
  size, containment, motion, color and input assertions. Complete presence
  transitions before interacting with the next modal. Keep fixture controls
  inside the viewport with the intended column layout.
- Clean-checkout CI builds the ignored Lantern guest from its canonical source
  and the pinned official Hiyori resource tree, then shares that real bundle
  with Flutter asset tests. Reuse the mini-app builder; do not add placeholder
  bytecode, commit generated assets, or download the Cubism Core runtime.
- Linux concurrency exposed a Worker replay stop window: a turn admitted by
  the C runner could precede `turn.begin`, and the runner could exit after the
  stop event was consumed but before the host atomic flag was stored. Use the
  trace mutex's stop fact, admit only the next recorded turn once, and require
  an exact `worker.exit` frontier. Deterministic barriers cover both windows;
  do not skip recorded events or serialize the native test suite to hide them.

## Validation

Focused regressions execute the pinned compiler, inspect real host/baked PAK
contents, and verify original manifests remain unchanged. Browser tests execute
tracked/affine vector text and confirm input changes pixels. The Web game
fixture executes actual QJBC and WASM through a button/axis input sequence.
The native replay regression admits the maximum finite f32 value and rejects
out-of-range recorded values. Final suite and release results are tracked by
GitHub Actions for the reviewed commit.

After merging current main, the local isolated SDK JS run passed all 162 test
files using the rebuilt native probe and matching WebAssembly/runtime. Native
debug tests passed all 124 library tests plus the binary/integration/doc suites
(one manual throughput test is ignored); release library tests also passed
124/124 and release Clippy completed successfully. The original production
Worker recording/replay regression passed 30 consecutive runs after the stop
fix, alongside the deterministic boundary regression.

Real Flutter FFI validation passed 281 host tests (one skip) and 201 SDK tests
(ten fixture-dependent skips); Demo Flutter tests passed 54/54. Release
packaging preflight passed 13 tests with 158 assertions. These runs complement
the Linux CI gate; they do not substitute for its final-commit validation.

Preview font-recording/child-load regressions passed 2/2 with real compiled
guests and native probes; transformed-text tests passed 4/4. Both files are
included explicitly in the isolated CI suite.

The Demo was rebuilt from the merged source and passed guest state, hardware,
video, JS-to-frame ablation, native probe, settings restoration and all three
navigation cases. The arrow-pop regression scrolls its state summary into
view and samples at most three real Guest frames for motion, checking state
retention and non-decreasing x on each frame, then requiring full exit. This
accounts for the event/transform commit boundary without removing the motion
assertion. The tracked root bytecode/metadata were refreshed from this build.

## Standalone upgrade release gate

The standalone upgrade lifecycle fixture now copies the actual editor runtime
tree, excluding tests/caches, as `export_web_sdk.ts` does. Its controlled server
entry still exercises the real detached `editor_service.mjs` upgrade and
rollback flow. This removes a manual import list that omitted the new
`update_endpoint.ts`; the production exporter already included that module.
Linux execution then exposed a real retirement bug: `detached: true` creates
a new session but does not remove the updater from the old server's process
ancestry. Recursive retirement could signal the updater before the old server,
leaving the persisted upgrade in `applying`. Reuse the existing Windows
`protectedRetirementPlan` on every platform, retire other Worker subtrees,
and signal the ancestor chain without signaling the updater. If the updater
was already reparented, require a complete ancestry chain outside the target
before recursive retirement. This adds no second service state machine.
The retained parent has no standalone SDK upgrade manager to migrate; this is
an adaptation of the existing SDK service boundary.

A real Node process-tree regression verifies that a detached updater still
has the server as its parent, survives retirement, and leaves both the old
server and its other Worker stopped. Browser tests wait for the observable
dirty-draft deferral before asserting it; failed fixtures retain logs, process
facts and persisted upgrade status before cleanup.

The release command passed all 27 tests and 165 assertions on macOS with
Playwright Chromium and Bun 1.4.4. The same group is included in Linux CI
before packaging. SDK version 0.1.14 supersedes the unpublished 0.1.13 candidate.

## Native test lifetime ablation

Repeated Linux execution exposed heap corruption in the truncated draw-op
parser regression. AddressSanitizer reproduced a `BorrowRefMut` drop after
`pocket_destroy` had released the last owner of its `CoreState`. The test had
borrowed `handle.ops.core_mut().ui` across destruction of that same handle.
This regression tests parsing, so use a local `Ui::new()` and remove the
unnecessary host/FFI lifecycle entirely. The original test fails under ASan;
the adapted test and full library runs pass under ASan. Keep default parallel
execution rather than masking the error by serializing tests.
