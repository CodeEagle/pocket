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
