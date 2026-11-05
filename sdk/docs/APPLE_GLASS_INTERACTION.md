# Apple glass interaction: drag, release, and motion boundary

Research and validation date: 2026-11-06. `AppleDraggableGlass` is an opt-in
anchored drag component, alongside the existing Apple and Mobile components.

## Decision in one paragraph

Pocket keeps interaction ownership in JS and keeps Flutter/Metal/WebGL as the
existing rendering boundary. A drag follows the pointer directly while the
contact is active. On release, this anchored component returns to its source
with the existing velocity-carrying spring. Data-transfer and reordering destinations remain a
separate application capability. Bounded velocity-driven
paint scale and translation deform the same retained surface and its content.
The visual hit region follows that transform; flex layout stays unchanged.
Reduced Motion removes the elastic/depth deformation and settles the state without a bounce. No private
iOS 27 Liquid Glass parameter is inferred.

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
  refraction coefficients, spring constants, or release velocity used by the
  system. Treat any such value in Pocket as a Pocket parameter, never as an
  Apple constant. See [What's new in SwiftUI (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/269/)
  and [Platforms State of the Union (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/102/).

The new iOS 27 SwiftUI drag APIs (`reorderable`, `reorderContainer`,
`dragContainer`, preview formations, and drag/drop configuration) cover data
movement, reordering, previews, and move-versus-copy semantics. They do not
provide custom Liquid Glass shape physics. They are therefore an independent
optional native-UI capability, not a reason to add a native layout tree to
Pocket. See [Build powerful drag and drop in SwiftUI (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/271/)
and [reordering in lists, stacks, grids, and custom layouts](https://developer.apple.com/documentation/swiftui/reordering-items-in-lists-stacks-grids-and-custom-layouts).

## HIG interaction rules to preserve

The [Motion HIG](https://developer.apple.com/design/human-interface-guidelines/motion)
asks for purposeful, optional, cancellable motion and warns against frequent
gratuitous animation. It also notes that system Liquid Glass can emphasize
direct touch more than trackpad interaction. The [Drag and drop HIG](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop)
provides the concrete interaction rules used here:

- Show a translucent drag representation shortly after movement begins and
  keep feedback continuous.
- Indicate whether the current destination accepts the item; remove the cue
  when the item leaves it.
- For an invalid drop, return the item to its source or use a clear failure
  treatment; do not leave it at an ambiguous position.
- Do not make the drag image constantly and radically change. Offer a
  non-drag alternative and make an accidental move reversible where possible.

For Pocket this maps to one state sequence, without a second layout engine:

1. `pointer down`: capture the existing contact and remember the source
   position.
2. `pointer move`: apply the pointer translation directly. Estimate velocity
   from the existing contact timestamps/deltas; clamp it before it reaches the
   paint transform.
3. `pointer up`: retarget the existing spring to the anchored source. Keep
   the item interactive during its return, then park the demand scheduler.
   This local component does not initiate a system data-transfer drag session.
4. `pointer cancel`: use the source fallback with zero release velocity.

## Spring and velocity provenance

Apple provides the following public concepts for a native SwiftUI/UIKit
implementation:

- `DragGesture.Value` exposes `velocity` and `predictedEndTranslation`; see
  [DragGesture.Value](https://developer.apple.com/documentation/swiftui/draggesture/value).
- Gesture updates automatically track velocity in a SwiftUI transaction, and
  `interactiveSpring` is intended for interactive animations while preserving
  velocity when a successor spring replaces the current one; see
  [Transaction.tracksVelocity](https://developer.apple.com/documentation/swiftui/transaction/tracksvelocity)
  and [interactiveSpring](https://developer.apple.com/documentation/swiftui/animation/interactivespring).
- UIKit's `UISpringTimingParameters` accepts initial velocity and damping/
  mass/stiffness values, while `UIViewPropertyAnimator` supports interrupting,
  pausing, scrubbing, and continuing an animation; see
  [UISpringTimingParameters](https://developer.apple.com/documentation/uikit/uispringtimingparameters)
  and [UIViewPropertyAnimator](https://developer.apple.com/documentation/uikit/uiviewpropertyanimator).

Pocket's equivalent source paths already exist:

- `sdk/packages/pocket_ui/src/motion.ts` defines `stepMotionSpring`. Critical
  damping is the default; velocity is carried when a scalar target changes,
  and underdamping is an explicit optional argument. `MOBILE_MOTION` values
  are Pocket choices inspired by Apple guidance, not Apple-published timings.
- `sdk/packages/pocket_ui/src/mobile.tsx` uses `useAnimatedNumber` for
  state/selection/control values and parks the animation when settled. It
  already resolves Reduced Motion by assigning the target immediately.
- `sdk/packages/pocket_ui/src/ui.tsx` passes release velocity through
  `ScrollablePageContext.chainEndDrag`, `scroller.endDrag(velocityY)`, and
  `contact.vy`. The new component reuses the same gesture contact facts.

The optional release “jelly” is local to the direct-manipulation component.
It preserves the shared default spring. A real drag enables an underdamped
return with bounded amplitude and a terminal zero-velocity state.

## Existing Pocket renderer boundary

The source-first optical implementation and its retained paths are:

- `sdk/packages/pocket_flutter/shaders/liquid_glass.frag` — one retained
  surface SDF, bevel normal, Snell refraction, bounded frost taps, rim and
  material uniforms. It is adapted from the retained parent
  `pocketjs_flutter_demo/shaders/liquid_glass.frag`; application-specific
  player/tab bodies were removed.
- `sdk/packages/pocket_ui/src/mobile.tsx` — JS-owned `GlassSurface`, one
  `registerSurface` descriptor per retained surface, and `pressed`/material
  state. It is the JS-to-native surface boundary; it is not a layout engine.
- `sdk/editor/client/liquid-glass.js` and `sdk/editor/client/preview.js` — the
  existing WebGL preview optical path and its bounded backdrop capture. The
  component reuses this program/resource path without a second canvas or a
  DOM snapshot.
- `sdk/docs/APPLE_GLASS.md` — retained parent shader provenance, surface
  resource model, HIG material constraints, and existing accessibility facts.

The retained parent shader already has `uVelocity` and clamps each axis to
±0.32 before applying an axis stretch with cross-axis compression. That is the
source for the bounded directional-deformation idea. Its fixed player/tab/orb
bodies are not restored.

Ablation decision: do not reintroduce a per-frame velocity descriptor and new
shader uniform. The pinned renderer already transforms `SURFACE_QUAD` full
bounds, clip and foreground together under axis-aligned `scaleX/scaleY` and
translation. The prototype can drive those existing paint properties directly
from JS. The shader derives its optical geometry from the resulting quad, so
refraction and rim follow the shape through the existing rendering path. This
removes a redundant parameter transport and keeps one material instance. It
also works with the existing opaque accessibility fallback.

The deformation is limited to the direct-manipulation component, not shared
layout or default control motion. The recognizer delegates hit geometry to the
pinned native hit fact
(`resolveTouchHit` / `hitTestBounds`), which already includes paint transforms,
ancestor clipping and occlusion. Removing the additional JS rectangle fallback
still passes a real re-grab outside the original layout bounds. This eliminates
a duplicate geometry calculation and keeps native facts authoritative. Native
pixel and QJBC validation below check both parts of that boundary.

## Accessibility policy

SwiftUI documents `accessibilityReduceMotion` as a request to avoid large
animations, especially motion that simulates depth. When
`accessibilityPrefersCrossFadeTransitions` is true, use a cross-fade instead
of a slide. See [accessibilityReduceMotion](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion)
and [accessibilityPrefersCrossFadeTransitions](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilitypreferscrossfadetransitions).
Apple's Liquid Glass presentation also says Reduced Motion lowers effect
intensity and disables elastic properties automatically.

The existing Pocket preference transport is the source of truth for JS:

- `reduceMotion=true`: keep direct manipulation necessary to understand the
  contact, but remove scale, elastic warp, parallax, and underdamped rebound;
  settle immediately or use a short fade/highlight for state communication.
- `reduceTransparency=true` or increased contrast: use the existing opaque
  material policy. Drag behavior still follows the separate motion preference;
  this adds no optical velocity effect to that fallback.
- A preference change must retarget the active state without creating a second
  animation clock or leaving a permanent frame demand.

## rdev comparison (not a runtime dependency)

The current upstream `rdev/liquid-glass-react` source uses DOM `mousemove`
position, distance from the glass bounds, an `elasticity` scalar, axis-specific
scale/translation, and a CSS `ease-out 0.2s` transition. It also applies a
pressed scale, but it does not expose a drag-release velocity or spring model.
See the [source](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/src/index.tsx)
and its [MIT license](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/LICENSE).

The only portable idea worth retaining is the bounded direction/axis response.
Do not transplant its React/DOM, CSS filter, or DOM layout assumptions into
PocketJS. The retained Pocket renderer remains the single optical path.

## API and implementation

```tsx
import { AppleDraggableGlass } from "@pocket/ui/apple";

// Place in a bounded parent, leaving room around the anchored control.
<AppleDraggableGlass class="w-[176] h-[68]" maxX={40} maxY={20}>
  <Text class="text-sm font-bold text-[#152238]">Drag the glass</Text>
</AppleDraggableGlass>;
```

The snippet uses light-theme ink; choose foreground color from the consumer
theme, as Showcase does. The Showcase consumer is `demo/js/apple-page.tsx`,
under UI Collection → Apple Glass. The component is independently importable. Its regular pill material
uses the same `GlassSurface`, and its nodeRef reaches that existing shell; no
extra wrapper or second glass surface was introduced for gesture registration.

One JS phase (`idle`, `pressed`, `dragging`, `returning`) owns the contact and
return. Pointer velocity is bounded before producing a <=12% directional scale
target. The existing `useAnimatedNumber` eases that target with a 200ms response
so a velocity change does not pop the shape. Release uses the existing scalar
spring extended with an optional damping ratio, response 560ms / ratio 0.62.
Exact integration carries velocity and is independent of host frame rate;
critical damping remains the default for every existing caller. These are
Pocket tuning choices, not published Apple physics constants.

Travel defaults to ±96/72 logical units and accepts `maxX`/`maxY`. `elastic=false`
removes shape response while retaining drag and return. Reduced Motion retains
direct pointer tracking and immediately settles release, including when the
preference changes during a return. Cancel returns to source with zero input
velocity. A retained inactive route resets transient drag state and stops frame
demand; unmount detaches the recognizer. Native hit facts include the consumer's
axis-aligned transform and clipping. This component does not implement a system data-transfer or reordering session.

## Validation and limits

- `packages/pocket_ui/test/motion.test.ts`: default critical motion remains
  monotonic; underdamped and overdamped states agree at equal elapsed times at
  30/60/120Hz; release crosses rest, settles and preserves velocity on retarget.
- `editor/test/preview_glass_drag.test.ts`: actual pinned buildGuest QJBC,
  native PocketJS and Chromium optical rendering; real pointer input changes
  surface and foreground, bounded shape changes ease instead of popping,
  release crosses rest, a moving surface can be grabbed again, cancel returns,
  `elastic=false` removes only deformation, Reduced Motion preserves direct
  drag and clears return, retained route/unmount clear frame demand.
- `demo/integration_test/glass_transform_test.dart`: raw JS input through the
  real Flutter/FFI rendering boundary. On the iPhone 18 Pro iOS 27.2 simulator,
  a 200×180 surface became 224×169.2 under scale 1.12/0.94 and translation; its
  foreground followed. 7,632 expanded-edge pixels changed, zero pixels outside
  the union changed, and restoration matched the baseline exactly. No old clip
  truncated the stretched glass.

That simulator's one-second dynamic transform window produced 60 FrameTiming
samples at 60Hz, build p50/p95 1.191/3.285ms and raster 0.955/1.317ms; active gap
p95 was 16.669ms. Screenshots were outside the timing window. This validates the
existing paint-transform path, not a new optical velocity uniform, and is a
debug simulator sample rather than physical-device release performance.

The headed Chromium M4 Metal QJBC release sample at 390×640/DPR2 delivered about
60 frames/s with canvas submission p95 4.2ms, then parked with no page errors.
The full Showcase also passed Light/Dark navigation, drag/release, transformed
hit regions after page scrolling, and isolation from parent scrolling. Canvas
submission is not GPU completion or a physical presentation timestamp.
The base material's cold WebGL initialization limitation remains documented in
`APPLE_GLASS.md`; the drag component reuses that same renderer and resources.

No private iOS 27 shader or exact system-physics parity is claimed. The prototype
uses the retained Pocket optical material and ordinary transformed content. It
adds no SwiftUI/UIKit layout overlay, new shader uniform, Dart interaction state
machine, CPU backdrop readback, or permanent animation ticker.
