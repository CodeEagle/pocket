# Apple glass interaction: local deformation, release, and navigation

Research and implementation note: 2026-11-06. Pocket's Apple glass controls
are an opt-in approximation of the public Liquid Glass interaction model. They
do not claim parity with private iOS 27 parameters.

## Decision

`GlassSurface` is the shared source of truth for Apple material interaction.
Apple material variants enable the one shared `createGlassElasticity`
controller in `sdk/packages/pocket_ui/src/mobile.tsx` by default; `elastic=false`
and accessibility preferences are the explicit opt-outs.
`AppleDraggableGlass` in `apple.tsx` is a thin compatibility composition: it
passes its extents and content to `GlassSurface` and owns no second spring,
gesture loop, or layout transform.

The control's layout frame, center, clip, and foreground identity remain fixed.
Contact changes a local deformation field in the surface paint; it does not
move the node or create a second layout tree. This is the useful Pocket
approximation of the stationary, touch-responsive glass effect. Apple's
private deformation kernel, refraction coefficients, and physics constants are
not available to copy and are not inferred here.

## Apple public surface and its boundary

Apple's public Liquid Glass APIs are opt-in interaction/material APIs, not a
published physics specification:

- SwiftUI exposes `glassEffect(_:in:)`, `Glass.interactive(_:)`,
  `GlassEffectContainer`, and `glassEffectID`. The interactive modifier gives
  custom controls the system response; the container coordinates shared glass
  sampling and morphing. See [Glass.interactive](https://developer.apple.com/documentation/swiftui/glass/interactive%28_%3A%29)
  and [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views).
- UIKit exposes `UIGlassEffect.isInteractive` and
  `UIGlassContainerEffect` through `UIVisualEffectView`. See
  [UIGlassEffect](https://developer.apple.com/documentation/uikit/uiglasseffect)
  and [isInteractive](https://developer.apple.com/documentation/uikit/uiglasseffect/isinteractive).
- The iOS 27 release refreshes the appearance automatically for apps that use
  standard components and lets custom elements opt into interactive glass.
  Apple's public pages do not expose the internal deformation amplitude,
  refraction coefficients, spring constants, or release velocity. Treat every
  such value in Pocket as a Pocket tuning choice. See [What's new in SwiftUI
  (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/269/) and
  [Platforms State of the Union (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/102/).

The iOS 27 SwiftUI drag APIs (`reorderable`, `reorderContainer`,
`dragContainer`, preview formations, and drag/drop configuration) cover data
movement, reordering, previews, and move-versus-copy semantics. They do not
provide custom Liquid Glass shape physics. They are therefore an independent
optional native-UI capability, not a reason to add a native layout tree to
Pocket. See [Build powerful drag and drop in SwiftUI (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/271/)
and [reordering in lists, stacks, grids, and custom layouts](https://developer.apple.com/documentation/swiftui/reordering-items-in-lists-stacks-grids-and-custom-layouts).

## HIG interaction rules

The [Motion HIG](https://developer.apple.com/design/human-interface-guidelines/motion)
asks for purposeful, optional, cancellable motion and warns against frequent
gratuitous animation. The [Drag and drop HIG](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop)
also calls for continuous feedback, a reversible failure/cancel treatment, and
a stable representation while a contact is active. This control is local
elastic feedback, not a data-transfer drag session: it has no destination,
drop acceptance state, or data-transfer preview.

The interaction therefore follows this contract:

1. `pointer down` records the current surface geometry and contact anchor. A
   re-grab starts from the current local shape instead of jumping to rest.
2. `pointer move` updates a compact anchor/radius deformation kernel around the
   contact. The center, layout frame, clip, and foreground identity stay put.
3. `pointer up` retargets the local field to zero and carries its current
   velocity into the return spring.
4. `pointer cancel`, route deactivation, or unmount clears the contact and
   returns the field without a release-velocity kick.

The saturating local offset is bounded to ±12 logical pixels per axis. It is a
paint-space displacement, not an interaction translation or whole-node scale.
Holding the pointer keeps the deformation target stable. Once the field settles,
its animation work hint parks; the native touch scheduler intentionally retains
vsync while a contact remains down. The scheduler parks after release settles.

## Shared motion model

`createGlassElasticity` owns one phase (`idle`, `pressed`, `dragging`, or
`returning`), one target, and one velocity pair for a surface. It advances both
axes through the shared `stepMotionSpring` implementation:

- During contact, the target follows the local anchor with a 180 ms critical
  response.
- On release, the same state returns with a 560 ms response and a 0.62 damping
  ratio. The carried velocity allows a small, purposeful rebound before the
  field settles at zero.
- The controller retains the velocity when a target changes and tests both
  position and velocity before settling. This prevents an underdamped crossing
  from being mistaken for a completed animation.

These are Pocket parameters, not Apple constants. `elastic=false` disables the
field while retaining the original geometry. Reduced Motion disables the
elastic warp and settles immediately. Reduced Transparency and increased
contrast select the existing opaque material policy and also settle any active
deformation; a preference change does not create another animation clock.

## Renderer contract and source provenance

Business UI, state, and routing remain in JS. Flutter/Dart transports the
registered surface descriptor and renders the shader; it does not own a second
interaction state machine. The relevant paths are:

- `sdk/packages/pocket_ui/src/mobile.tsx` — `GlassSurface`, the shared
  `createGlassElasticity` controller, and one `registerSurface` descriptor per
  retained surface.
- `sdk/packages/pocket_ui/src/apple.tsx` — the thin Apple compositions and the
  navigation selection overlay.
- `sdk/packages/pocket_flutter/lib/src/pocket_surface.dart` — the native
  surface boundary, including paint padding and deformation/magnification
  transport.
- `sdk/packages/pocket_flutter/shaders/liquid_glass.frag` — the single
  retained optical program.
- `sdk/editor/client/liquid-glass.js` and `sdk/editor/client/preview.js` — the
  existing WebGL preview path; one shared GPU program is retained; no DOM snapshot or secondary UI tree is introduced.

The base optical shader is source-first adapted from the retained parent:
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/shaders/liquid_glass.frag`.
That parent source provides the surface SDF, bevel/refraction, frost, rim, and
material concepts, but it did not retain the local contact kernel used here.
The local deformation is a necessary Pocket adaptation evidenced by the
stationary, touch-pulled glass reference; it is not an Apple private shader
parameter and is not a replacement optical path.

The renderer transport is deliberately explicit:

- deformation uniforms 24–28 carry the local anchor, local offset, and compact
  influence radius;
- uniform 29 carries optional local magnification, with `1.0` meaning disabled;
- `opticalInset: 36` reserves a halo inside an expanded compositor paint quad for the outward bulge while
  preserving the same layout rectangle and hit rectangle. Native hit facts and
  clipping remain authoritative.

This keeps the local field, material, clip, and foreground in one retained
surface. There is no per-frame optical velocity uniform, CPU backdrop readback,
whole-scale position spring, or duplicate native layout tree.

## Apple navigation bar

`AppleGlassNavigationBar` keeps a fixed outer bar and reuses the existing
`NavigationBar` layout, semantic nodes, and selection overlay slot:

- Its outer capsule and foreground lens default to Clear with no blur or
  neutral fill, preserving the center backdrop. `material="regular"` opts the
  outer capsule into the shared frosted profile. Accessibility can still
  select the opaque material and ordinary selection indicator.
- While dragging, the selection capsule follows the finger continuously. On
  release it chooses the nearest tab and snaps the route to that item.
- The foreground icon overlay is composited after the base icon. Contact lift
  magnifies it from `1.0` to `1.22` and applies the same local deformation
  surface; the icon's layout box, hit target, and semantic identity do not
  change.
- Navigation uses the shared `useAnimatedNumber` motion primitive. Its optional
  damping-ratio argument keeps the default critical behavior for existing
  callers while tuning this bar's Pocket response: `lensX` uses 400 ms / 0.72,
  `lift` uses a 260 ms critical response, and `localPullY` uses 560 ms / 0.62.

The four primary Showcase tabs are still Home, UI, Host, and Settings. The Apple showcase is a secondary route; its back chevron returns to UI
and restores all four primary tabs. Its component entry points remain available.

## Accessibility

SwiftUI documents `accessibilityReduceMotion` as a request to avoid large
animations, especially motion that simulates depth. When
`accessibilityPrefersCrossFadeTransitions` is true, use a cross-fade instead
of a slide. See [accessibilityReduceMotion](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion)
and [accessibilityPrefersCrossFadeTransitions](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilitypreferscrossfadetransitions).
Apple's Liquid Glass presentation also says Reduced Motion lowers effect
intensity and disables elastic properties automatically.

Pocket keeps these preferences in JS as the source of truth. The control has a
minimum-size hit target, no data-transfer semantics, and no required motion for
understanding its label or action. Cross-fade/opaque fallback policy belongs to
the surrounding consumer; the glass field never overrides it.

## Public API

```tsx
import { AppleDraggableGlass } from "@pocket/ui/apple";

<AppleDraggableGlass class="w-[176] h-[68]" maxX={80} maxY={56}>
  <Text class="text-sm font-bold text-[#152238]">Pull the glass</Text>
</AppleDraggableGlass>;
```

`maxX` and `maxY` describe the finger distance needed to reach the bounded
local response; they do not permit control travel. The component is
independently importable, and its material still registers through the same
`GlassSurface` shell. Showcase exposes it at UI Collection → Apple Glass.

## Validation status

Validated with the final pinned buildGuest Demo and real JS execution:

- `demo/js/tests/navigation_native.test.ts`: 2/2, including Apple secondary
  route → back chevron → the four main tabs, plus route scroll/state retention.
- `demo/js/tests/mobile_ui.test.ts`, shared glass lifecycle and motion tests:
  8/8 combined, with the existing default motion behavior preserved.
- `editor/test/preview_glass_drag.test.ts`: real QJBC pointer input across
  buttons, toolbar actions and tab navigation; fixed shell/label geometry,
  local pull/hold/release, accessibility and route cleanup, magnification,
  nearest-tab selection, and idle parking passed under headless ANGLE Metal.
- `editor/test/preview_glass_local_deformation.test.ts`: padded outward
  shoulder, unchanged remote part, reset and crop/full sample parity passed.
- The native local shader test in
  `demo/integration_test/glass_transform_test.dart` changed 6,613 pixels,
  including 2,901 outside the original shape at the pulled edge. Remote,
  outside-halo and restored differences were all zero.
- The retained optical suite passed 4/4, including context-loss frost fallback
  and nonblocking shader preparation. Five-surface output-cache ablation is
  recorded in [Apple Glass rendering](APPLE_GLASS.md).

The native optical test paints through the real Flutter/FFI surface. The continuous local-field window produced 60 Flutter FrameTimings in one
second: build P50/P95 0.906/1.647ms, raster 0.558/0.747ms, and active-gap P95
16.668ms on the iOS simulator. Screenshot sampling is outside that window;
simulator/debug timing is not an on-device release FPS claim.

No private iOS 27 shader or exact system-physics parity is claimed. Pocket's
implementation uses the retained optical material plus the one JS-owned local
deformation controller and adds no SwiftUI/UIKit overlay, Dart interaction
state machine, CPU readback, or permanent animation ticker.

## Public motion references

The public motion primitives used as design references are
`DragGesture.Value`, `Transaction.tracksVelocity`, `interactiveSpring`,
`UISpringTimingParameters`, and `UIViewPropertyAnimator`: [DragGesture.Value](https://developer.apple.com/documentation/swiftui/draggesture/value),
[Transaction.tracksVelocity](https://developer.apple.com/documentation/swiftui/transaction/tracksvelocity),
[interactiveSpring](https://developer.apple.com/documentation/swiftui/animation/interactivespring),
[UISpringTimingParameters](https://developer.apple.com/documentation/uikit/uispringtimingparameters),
and [UIViewPropertyAnimator](https://developer.apple.com/documentation/uikit/uiviewpropertyanimator).

They establish the public concepts of interactive replacement, velocity
continuity, interruption, and accessibility—not Pocket's numeric tuning.

For comparison only, [rdev/liquid-glass-react source](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/src/index.tsx)
and its [MIT license](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/LICENSE)
show a DOM/CSS elasticity approach. Pocket does not import that runtime,
filter, or layout model.
