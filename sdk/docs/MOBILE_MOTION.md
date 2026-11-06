# Mobile UI motion

## Reference and source reuse

Apple's [Motion HIG](https://developer.apple.com/design/human-interface-guidelines/motion)
recommends purposeful, consistent motion and matching reveal/dismissal behavior.
[Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/)
describes immediate response and interruptible interactions.
[Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/)
explains retaining both position and velocity when a spring changes destination,
including springs without bounce. These principles guide this adaptation;
the timings below are Pocket choices, not published iOS constants.

Source-first inspection retained the parent's
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
(`animateNode`, forwarding native property animation) and
`mini_apps/syslib/pocket_syslib_pages.js` (Modal/Portal composition), plus the
component vocabulary in `mini_apps/syslib/pocket_syslib_flutter_ui.js`.
The pinned engine's `core/src/anim.rs` supplies damped spring node animations.
Existing compiled transitions continue to own native color and press feedback.
The evidenced gap is shared JS scalar animation: a node property animation
cannot also supply the same progress to the registered GlassSurface descriptor.
There is no new Dart animation/state machine or alternate layout engine.

## Shared behavior

`pocket_ui/src/motion.ts` defines state 200ms, selection 240ms, control 280ms
and presentation 300ms response settings. Dialog/Popup use a separate 220ms
overlay phase with ease-out for a prompt reveal. `useAnimatedNumber` uses an exactly
integrated critically damped oscillator for JS scalars. Retargeting retains
position and velocity, rather than restarting a fixed easing curve. Springs
settle to their latest destination and release frame demand. The first resting
control sample is published in the input transaction for immediate feedback.
All subsequent steps use the pinned simulation clock.

`usePresenceTransition` generalizes the existing Dialog/Popup phase helper.
A single phase drives appearance; dismissal reverses that phase, retaining
the subtree until zero. Interrupted open/close continues at the current phase.
Interactive actions stop immediately when closing. Toast, Alert, Accordion,
Checkbox and Radio reuse it instead of independently resetting opacity.
Dialog and Popup retain their colorless backdrop and focus isolation. Their
background paint scales/fades while natural-size text and actions only fade;
the panel no longer scales the glyph tree. Exit reverses the same phase.

Switch (including pending/rollback), slider/stepper, segmented selection,
progress, tags and skeleton state use shared scalar motion. Fractional offsets
remain fractional through native drawing instead of rounding each animation
sample. Default buttons use the pinned native active/opacity transition; enabled
inline `opacity: 1` was removed because it overrode that pressed style.

Accordion reads its natural content height from existing `pocket.getLayout`
committed-layout readback. The outer clip animates height and opacity; its
nonshrinking inner content retains natural layout. At full expansion height is
automatic, so dynamic content is not constrained by an old measurement.
Measurement consumes presence frames with `continuous: false`, avoiding a second
frame-demand owner. Content spacing belongs inside the animated clip to avoid
a final gap jump on unmount.

## Ablation and verification

Removed independent reset-and-fade effects on selected tags/skeletons,
integer rounding of animated offsets, duplicate native opacity transitions on
JS-driven opacity, and a separate continuous height-measurement demand.
The public legacy `useStateTransition` API remains compatible, but its frame
argument is interpreted at nominal 60Hz and advanced by elapsed simulation time.
No business timers or Showcase-only motion policy were added.

Tests execute the real pinned QJBC guest with the release native probe; source
inspection or screenshots alone are not animation evidence. The simulation
clock is deterministic and may also advance at input boundaries: configured
milliseconds must not be equated with a GPU presentation-time guarantee.

- `motion.test.ts`: exact spring integration agrees at 30/60/120Hz; retargeting
  retains position/velocity and settles at the new target.
- `control_motion_native.test.ts`: switch intermediate geometry, rapid retarget,
  pending midpoint, successful result/rollback, manual slider/stepper movement,
  and parked scheduler.
- `mobile_dialog_native.test.ts`: real entrance/exit geometry and blur opacity,
  mid-close reopen and single confirm dispatch at 390px/320px.
- `mobile_motion_native.test.ts`: fractional Toast/Alert/Accordion appearance
  and disappearance, retained exit subtree, rapid reversal, Checkbox/Radio
  markers, clock-rate consistency and parked scheduling (4 passed). Native
  Accordion expansion moves the following Checkbox from y=232 to y=272 through
  15 distinct positions; collapse returns monotonically to y=232. A held button
  changes native alpha through 1, .941, .894, .859, .835, .816 and recovers to 1
  on release. Toast entrance takes approximately 283ms at 60Hz and 300ms at
  30Hz, within one low-rate sample interval.

BuildGuest operations run serially because all consumers share the same pinned
Bun/compiler cache. Browser projection measurements and blur-cache ablation
are recorded in `EDITOR_PREVIEW_RENDERING.md`.

Final source checks and Showcase verification (2026-11-05):

- Spring math: 2 passed; native control: 1 passed; native Dialog: 1 passed;
  native presence/layout/press: 4 passed; Demo mobile contracts: 4 passed.
- Fresh pinned Demo root QJBC: 591,313 bytes. Editor 8792 rebuilt through its
  own build API and reported `build ready`.
- Fresh Playwright Chromium at DPR 2 executes eight Light/Dark changes in
  Settings with 65ms between presses, then UI → For → Close. The dialog reaches
  `effect=blur, tintOpacity=0, opacity=1` and dismisses; no browser exceptions.
  The Dark flow also opens/dismisses successfully. Screenshots are supplementary
  settled-state checks, not proof of intermediate frames or screen FPS.
- Architecture boundary, client syntax and whitespace checks pass. The
  transformed texture/transparent blur/PSM5 browser pixel regression passes.
