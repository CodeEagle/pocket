# Independent Apple Glass components

The opt-in `@pocket/ui/apple` entry adds Apple-style controls alongside the
existing UI vocabulary. It does not change the default Showcase shell.
Components can be imported individually; the Showcase route is a consumer,
not part of the SDK.

```tsx
import { AppleGlassButton, AppleGlassToolbar } from "@pocket/ui/apple";

// A standalone control owns one material.
<AppleGlassButton label="Play" onPress={play} />;

// Actions in a toolbar share the toolbar's one material.
<AppleGlassToolbar
  title="Now playing"
  actions={() => <AppleGlassButton label="Pause" onPress={pause} />}
/>;
```

`AppleGlassNavigationBar` accepts `items`, `active` and `onChange`. It reuses
the shared NavigationBar's icon, safe-area and focus behavior. Local tab state
stays with its consumer; this library adds no second router. Light/dark and
accent styling use the existing MobileThemeProvider.
The toolbar action slot is lazy so the pinned renderer creates those controls
inside the shared material scope; no manual grouping flag is needed.

## Source-first decision

Inspected retained parent sources (excluding `pocket_host/`):

- `pocketjs_flutter_demo/shaders/liquid_glass.frag`: rounded/circular SDF,
  finite-difference normal, Snell refraction, five-sample frost and optical rim.
- `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`:
  `PocketLiquidGlassSurface`, JS primitive recipes and host rendering boundary.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js`:
  JS-owned composition and opt-in material.

The SDK had already adapted that shader to one generic retained surface,
removed fixed application bodies, and normalized geometry for device density.
This change retains that single canonical asset at
`packages/pocket_flutter/shaders/liquid_glass.frag`; it does not restore the
parent's application-specific tab/player shapes or its claimed FPS constants.

Upstream candidates inspected on 2026-11-06:

| Source | Pinned revision | Decision |
| --- | --- | --- |
| [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21) | `ac48eab18d1f7f444ae30002d240cae29c863a21` | React/DOM, CSS backdrop filtering and SVG displacement. Its shader utility generates an image on the CPU; it is not a portable live GPU material. Do not transplant the runtime. |
| [euv-dev/euv](https://github.com/euv-dev/euv/tree/020264a8255642660525b257317f1cfdb689facf) | `020264a8255642660525b257317f1cfdb689facf` | Rust/WASM DOM UI framework. Its scene ray tracer is not a Liquid Glass control implementation. Do not add a second framework/layout engine. |

Both repositories use MIT licenses. No source code or assets from either
repository were copied. Retained Pocket provenance remains authoritative.

## Rendering adaptation

Flutter continues to use its retained `BackdropFilter` fragment shader.
The regular material opts into a neutral appearance tint in that same shader
pass (72% strength), adapted from the retained parent
`PocketLiquidGlassSurface` material fill. This keeps background text from
competing with foreground labels. Clear and legacy surfaces retain zero
material strength. There is no second tint surface or blur pass.
Web Preview previously projected optical surfaces as frost only. It now embeds
the same shader asset and adapts only GLSL texture/coordinate IO for WebGL.
JS execution, layout, routing and input still use the pinned native PocketJS
runtime and the ordinary buildGuest bytecode pipeline.

The Web renderer keeps one program, buffer, texture and optical output per
preview canvas. Capture uses the existing 2D scratch canvas, cropped to the
surface plus a conservative refraction/blur halo. No pixel array, readPixels,
getImageData, DOM snapshot, secondary layout or historical image cache is used
in production. Foreground-only changes reuse the current output. Background
changes upload the current bounded sample; multiple surfaces share the same
GPU resources rather than retaining a texture for each control. Closing the
preview deletes resources and loses the context. A missing/lost GPU context
uses real backdrop frost and reports `frosted`, never a fabricated optical
success.

Where [KHR_parallel_shader_compile](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/)
is available, compilation/linking is prepared asynchronously. Only its
non-blocking completion query runs while pending; link status, attributes and
uniforms are read after completion. The first frame remains real frost until
the driver is ready, then the existing parked frame redraws once. The bounded
preparation rAF stops on completion, timeout or disposal. Browsers without the
extension keep the ordinary synchronous shader path. No fake glass result or
permanent guest frame loop is used to hide shader preparation.

## HIG design constraints

Reference: Apple's [Materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[Layout](https://developer.apple.com/design/human-interface-guidelines/layout),
[Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
and [custom Liquid Glass guidance](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views).

- Glass belongs to navigation and actions. Ordinary page content stays on
  ordinary surfaces; avoid glass stacked over glass.
- Regular material is the default. Clear material is an explicit choice for
  controls over rich media, with foreground contrast checked by the consumer.
- A toolbar shares one material with its actions. A standalone glass button
  creates its own material.
- Interactive targets have a minimum height and width of 44 logical units.
  Tabs retain familiar icons and visible labels, safe-area handling and stable
  positions. Content can extend behind floating navigation.
- Reuse time-based interruptible motion. Animation durations are Pocket
  choices, not timings mandated by Apple HIG.

These are HIG design constraints, not a claim that a custom cross-platform
shader is Apple's native Liquid Glass implementation. System accessibility
preferences use one `accessibility.preferences` host fact stream. Flutter
reports official reduced-motion, high-contrast, accessible-navigation and
17pt-baseline text-scaling facts; iOS supplies Reduce Transparency through the
existing geometry channel and its UIKit change notification. Unsupported
platforms report unknown transparency as null. The app creates one preference
signal and supplies it with `AccessibilityPreferencesProvider`.

JS owns the response: scalar/state/presence motion settles immediately under
Reduce Motion; high contrast or reduced transparency releases the optical
surface and uses an opaque light/dark material. Restoring preferences reuses
the component's own identity. The Apple typography uses compiled larger font
steps with growing control heights. No Dart UI policy or second state machine
was added.

`AppleSemanticsProvider` supplies explicit labels, button/tab roles, selected
and disabled state, and activation callbacks for the new controls. Geometry
comes from the existing committed native layout and nearest page scroll
transform; it is clipped to that page and gated by route activity. The bounded
store publishes changed snapshots and parks after initial layout admission.
Flutter projects these facts into its semantics tree; Web Preview projects
transparent keyboard/assistive-technology controls using those same rects.
Ordinary pointer input continues to hit the canvas. Activation returns to the
JS callback, with generation and runtime identity checks rejecting stale
controls. No labels are inferred from focus debug names, and this does not
claim semantics coverage for the entire older component collection.

## Ablations and validation

`editor/test/preview_liquid_glass.test.ts` runs Chromium at DPR 2. Removing only
refraction changes more than 1,000 real backdrop pixels; retaining frost/rim
cannot satisfy that assertion. Bounded capture is compared with full-scene
sampling (maximum channel error <= 2), uses less than one third of the full
frame for the tested capsule, and leaves pixels outside the surface unchanged.
Foreground-only updates do not upload or rerun the shader; shape updates use
uniforms without an upload. Tests prohibit production CPU readback and verify
GPU resource release plus missing/lost-context real-frost fallback.

`packages/pocket_ui/test/glass_surface.test.ts` uses the pinned Solid runtime to
verify material updates, descriptor deduplication and instance-local cleanup.
It is bridge lifecycle coverage, not a substitute for real QJBC execution.

`editor/test/liquid_glass_profile.ts` is a real QJBC/native-input Web Preview
profile with two glass surfaces, a moving nonuniform backdrop, a no-glass
ablation and idle parking. It reports delivered frames, browser rAF and canvas
submission cost separately. These are not GPU completion timings.

Measured on this M4 host in headed Playwright Chromium using ANGLE Metal,
390x844 at DPR 2, three-second warm windows: two glass surfaces delivered
59.95 frames/s, canvas submission p50 2.0ms / p95 3.3ms; removing only the
glass delivered 58.98 frames/s, p50 0.3ms / p95 0.4ms. Browser rAF was about
59.0Hz and 57.6Hz respectively in that sample. Each capture uploaded at most 246,480
pixels versus 1,316,640 for the full frame. The stop action parked the native
timer. These are native-to-canvas delivery and browser callback measurements,
**not physical-screen presentation timestamps or an iPhone FPS claim**.
Software SwiftShader results are not used as hardware GPU evidence.

Cold admission is reported separately. An earlier cold driver run measured
40.7ms initial canvas submission,
including 32.2ms creating the first WebGL context/resources; first optical draw
submission after asynchronous preparation was 2.6ms. The remaining context
initialization cost is not hidden in warm averages and remains a cold-start
limitation. The final regular-material run with the driver cache warm measured
11.4ms initial submission, 4.2ms resource creation and 2.5ms first optical draw;
it does not erase the earlier cold result. The profile intercepts synchronous preview.frame announcements,
not the later postMessage event delivery, to avoid counting unrelated message
queue delay as canvas submission time.

The initial timer slept a full frame after work and accumulated wake overshoot
(about 53 frames/s in the same Metal fixture). The continuous-demand timer now
targets a fixed monotonic clock phase while tickNow still receives actual
elapsed time. It does not add a second animation clock or permanent ticker.
`preview_timing.test.ts` injects a 4ms probe cost to cover cadence independently
of the optical material, and still verifies continuous input cannot consume
the elapsed-time baseline. Idle-modal browser acceptance remains separate.

`demo/integration_test/liquid_glass_performance_test.dart` measures real Flutter
FrameTiming separately from optical screenshot assertions. Simulator/debug
results must not be presented as physical-device release performance.

On the Duo iOS 27.1 simulator, both retained refractive surfaces rendered 120
frames in each two-second window (60Hz). Two-glass build p50/p95 was
1.726/3.880ms; raster 1.040/1.423ms. The same moving backdrop without glass had
build 2.112/3.070ms and raster 0.502/0.730ms. Active-gap p95 was 16.670ms with glass and 16.669ms without.
The fixture supplies the nonzero regular material uniforms. Pressed/shape
changes altered 32,874 pixels and removal altered 49,764 pixels, with zero changes outside the glass regions in either check.
This is a small simulator sample, not a universal device budget or evidence
that glass improves build time. The added raster cost is the relevant optical
ablation. Screenshots ran outside the timing windows.

The raw regression guests were updated to the current binary-capable event
ABI and real async startup waits. A virtual-time-only pump loop can time out
before the native startup future receives any wall-clock execution; that was
a test admission problem, not a shader performance measurement.

The explicit semantic store uses an isolated pinned-Solid fixture so test mocks
do not leak into other SDK tests. Flutter helper tests cover parsing, semantic
actions and pointer passthrough; a PocketView test covers snapshot admission,
activation returning to JS and clearing stale nodes. Browser tests cover
preference replay for current/future children, transparent semantic projection,
and actual pinned QJBC keyboard activation and route cleanup.

For the optional anchored drag and jelly return, see
[Apple glass interaction](APPLE_GLASS_INTERACTION.md).
