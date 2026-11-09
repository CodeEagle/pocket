# Native desktop density and window acceptance

This diagnostic closes a narrower gap than physical Retina acceptance: observe
AppKit and the actual Flutter rendering view, rather than infer window density
from an NSScreen query or a test-view override.

## Retained source and observation boundary

The retained parent `../pocketjs_flutter_demo/macos/Runner/MainFlutterWindow.swift`
uses the stock `FlutterViewController`; its old renderer and mini-app host read
viewport/safe-area facts but contain no reusable Live2D implementation. The
current Demo keeps that stock production window.

The pinned Flutter source at
`.fvm/flutter_sdk/engine/src/flutter/shell/platform/darwin/macos/framework/Source/`
shows that `FlutterViewController.loadView` creates a `FlutterViewWrapper` as
`controller.view`, containing the actual `FlutterView`. `FlutterEngine` emits
window metrics from the latter's `convertRectToBacking(bounds)` and
`layer.contentsScale`. `FlutterView` inherits contents scale from its window
and reshapes after backing-property changes. Therefore reading only
`controller.view.layer` is not evidence of the rendering layer's scale.

An ignored QA-only Runner channel searches that existing hierarchy for the
actual FlutterView and reports its class, layer class, bounds/backing bounds,
layer scale, window/screen scales and foreground/key-window facts. Dart records
Flutter physicalSize/DPR and painter DPR. No production channel, business UI,
DPR override or second renderer is introduced. The temporary Runner/config
are restored byte-for-byte after each process reaches a terminal result.

## Current evidence and limits

The first run in `sdk/.pocket-build/model-density-rss-20261108/attempt1/`
completed seven whole-game windows, then failed before model entry because its
script waited for an action below the journal viewport. That run observes the
outer wrapper layer, not the actual FlutterView layer. Its values must not be
relabelled as a complete native rendering-density chain or a passing soak.
The test now uses the existing actual-drag reveal helper for that menu action.
The corrected diagnostic selects the actual rendering view explicitly.

Physical Retina remains a separate requirement. On a real 2x display the same
frozen scene must show matching screen/window scale, rendering layer scale,
Flutter physicalSize/logicalSize and painter DPR. A software test DPR2 or an
AppKit window on a backing1 display cannot satisfy it. Missing
`NSHighResolutionCapable` in a plist alone is not proof of a defect; a
single-key A/B is useful only with actual 2x backing available.


## Actual NSWindow resize result, 2026-11-08

A macOS Profile test called QA-only `NSWindow.setContentSize`, with no
`tester.view` override or constrained child: 800×600 → 1280×720 → 800×340 →
800×600. At each observed size, native FlutterView bounds/backing bounds,
Flutter physical size and the real Guest canvas matched. The same JS
controller remained mounted; background coverage, dialogue/menu text bounds,
actual pointer journal/resume and final dialogue advance passed. Driver exit0,
+2, required `os-window-resize` completed.

The observation explicitly identifies controller `FlutterViewWrapper`, render
view `FlutterView` and its `NSViewBackingLayer`. This is the layer scale used
by FlutterEngine's window metrics; it is not a direct measurement of every
Metal surface or GPU texture. All three scales and Flutter DPR were 1.0.
The window was non-key and frontmost was loginwindow, so this verifies native
window geometry propagation and injected interaction, not a physical window
drag, foreground presentation or Retina behavior.

Evidence: `sdk/.pocket-build/native-window-resize-20261108/` contains QA source,
Runner observer, byte-restoration manifest, complete log and response JSON.
Final test SHA `cf23041e7ce7b120f9e72a78fcb2e05dae9a82c6cf787b84f0cc670acf4e30c3`.


## Follow-up soak status

Further runs expose harness assumptions that were fixed locally in the normal
soak source: reveal offscreen journal/title actions through the existing real
pointer helper, and explicitly tap the typewriter's reveal control before
continuing a long sample-data notice. In `attempt3/`, all 12 windows completed
and five handle cycles returned to zero, with 1,958 created/disposed snapshot
handles and five stable bounded RSS samples. The sixth cycle stalled at a
partly revealed notice. A later rerun stopped after the first model window
when the game child disappeared following a return action; no cause was
established. Those runs exit1, never complete `model-stable-rss`, and cannot
satisfy the 20-cycle gate. Their exact source/logs and
`incomplete-run-analysis.json` remain in `model-density-rss-20261108/`.

The later run did observe keyWindow=true and frontmost equal to its private
QA bundle, still with actual FlutterView/window/screen/painter DPR1. This
updates the earlier locked-screen observation for that run only. A separate
existing model-showcase Profile regression subsequently passed release,
re-entry, return, background/resume and main-story resume without reporting a
host instance startup error; it did not reproduce the disappearing-child
symptom or establish its cause. Full 20-cycle/RSS and physical Retina remain
unverified. Performance observations are not controlled A/B measurements.


## Actual Idle0 official-renderer comparison

See [same-pose evidence](VISUAL_NOVEL_IDLE0_RENDER_COMPARISON.md). The actual
Profile Guest capture passed; both 2048² atlases and bounded 2× SSAA were active.
Official GL showed no obvious sharper facial detail in the controlled 1×
comparison. Raw dynamic-history flags and full triangle-key coverage retain
explicit limitations. No production quality fix or physical Retina acceptance
is claimed; the user-reported clarity issue remains open. Group totals and
the full Goal scope are unchanged.
