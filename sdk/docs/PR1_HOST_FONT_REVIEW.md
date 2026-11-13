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
- Remove the View's duplicate native font refresh after recording. Runtime
  owns deferred metric synchronization; View invalidates its layout cache and
  schedules repaint. This preserves standalone runtime use and one update
  boundary.
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

## Validation

Focused regressions execute the pinned compiler, inspect real host/baked PAK
contents, and verify original manifests remain unchanged. Browser tests execute
tracked/affine vector text and confirm input changes pixels. The Web game
fixture executes actual QJBC and WASM through a button/axis input sequence.
The native replay regression admits the maximum finite f32 value and rejects
out-of-range recorded values. Final suite and release results are tracked by
GitHub Actions for the reviewed commit.
