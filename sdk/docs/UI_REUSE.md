# Mobile UI reuse

当前实现位于 `../packages/pocket_ui`，Showcase 页面位于 `../demo/js`。本文中的
`guest/` 是来源工程的历史路径；它只用于说明复用来源，不是当前目录入口。

This guest keeps the mobile layer deliberately thin. The app still renders
through the pinned PocketJS Solid primitives; Flutter only receives the normal
retained frame and host capability messages.

## Sources and adaptations

- `../../mini_apps/syslib/pocket_syslib_flutter_ui.js` was inspected for the
  `Scaffold`, `AppBar`, `Card`, `ListTile`, `FilledButton`,
  `ElevatedButton`, and `OutlinedButton` vocabulary. The old file also emits
  the previous VDOM/Dart integration shape, so it is not imported at runtime.
  `packages/pocket_ui/src/mobile.tsx` keeps the useful slots and callback
  semantics while composing `View`, `Text`, `Focusable`, `Modal`, and
  `CompositorSurface`. The `demo/js/ui/mobile.tsx` path was a compatibility
  re-export; pages import the public `@pocket/ui` package directly.
- `../../mini_apps/syslib/pocket_syslib_router.js` supplied
  `TRANSITION_MODES` and `computeTransitionDescriptor`. The local pure adapter
  is `packages/pocket_ui/src/legacy.ts`; the reducer owns the route stack and
  selected mode. `demo/js/legacy.ts` was a compatibility re-export only.
- `../../mini_apps/pocketjs_uikit.js` supplied the SDF, smooth-step, gradient,
  rim, and refraction parameter math. `buildLiquidGlassRecipe` preserves that
  math as a local, testable recipe.
- The actual shader source is the old demo's
  `../../shaders/liquid_glass.frag`; the guest does not duplicate a renderer
  shader. The host-side generic surface implementation is the place where
  that shader can be selected.
- The pinned upstream examples under `.cache/pocketjs/apps/` supplied the
  Solid context/official component composition pattern. No old Dart widget
  tree, VDOM host, game config, or sibling project import is a runtime
  dependency.

## What is mounted

`demo/js/mobile-pages.tsx` (or `demo/js/app.tsx`) adds real JS-owned pages for Mobile UI, Transitions,
and Hardware. The Demo's former Liquid Glass page and entry are temporarily
removed; `GlassSurface` and the shared glass surface bridge remain SDK
capabilities covered by standalone tests. The Mobile UI page exercises themed
AppBar/Card/ListTile/buttons, segmented controls, a switch, a stepper, and an
official Modal. Transitions samples the three Demo-available descriptors and
pushes/pops the guest route stack; the shared Liquid Glass descriptor remains
available in the SDK but is not a selectable Demo option. App route changes
drive an on-frame 220ms incoming transition for these showcase routes. Existing
Home, Gallery, Runtime, Updates, Plugins, Stress, FPS, and system-input paths
remain intact.

Hardware uses the registered host plugin contract. The page sends actual
requests for permissions, camera preview/capture, photos, BLE, sensors,
biometrics, location, and weather; an unavailable provider renders the
returned error. Camera preview registers the returned texture through
`platformTexture` and releases it when leaving the page. Photo deletion always
requires an explicit confirmation.

The runtime page also displays the host's `runtime.info.glassRenderer`
(`refractive` or `frosted`) and `hostSurfaces` result; these values are not
hard-coded in the guest.

## Display geometry integration

`@pocket/ui/display` exports `createDisplayGeometry()`. It subscribes to the
existing `display.viewport` event lane, chains any prior `globalThis.__pocketEvent`
callback, and restores that callback on cleanup. The signal exposes the live
viewport, safe area, keyboard inset, and ReservedRegion frames to an external
app or the showcase. `deriveResponsiveLayout()` then maps the data to bottom
navigation or a rail while treating a central division as a layout landmark.
`MobileScaffold` does not silently subscribe to host events; an app opts into
the adapter where it owns navigation and page composition.

## Liquid Glass boundary

The public style ABI can draw gradients and rings but cannot honestly provide
backdrop blur/refraction by itself. `GlassSurface` therefore first tries the
generic host bridge:

```text
pocket.registerSurface(packageId, "glass", JSON.stringify({
  radius, blur, edgeIntensity, rimIntensity, baseIntensity,
  tintOpacity, cornerBoost, rippleEffect, warp, pressed, shape
}))
```

When registered, the guest mounts an official `CompositorSurface` beneath its
children and releases it on cleanup. If the bridge is unavailable, it shows a
gradient recipe and labels the surface as a fallback; it does not call that
fallback native glass. The actual shader/effect implementation remains a
generic renderer concern, not a Dart business widget.

## Ablation

There is one public implementation in `packages/pocket_ui` for each mobile
primitive. There is one mobile button implementation (`MobileButton`) with named aliases
(`FilledButton`, `ElevatedButton`, `OutlinedButton`, and `TextButton`),
one theme context, and one GlassSurface adapter. The old UIKit is not copied
as a second runtime library, and no static “38 components” catalogue is
claimed. Unimplemented upstream primitives stay outside this showcase.

