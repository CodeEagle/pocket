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
Apple buttons, toolbars, compatibility surfaces and navigation expose one
Clear appearance, with zero blur and zero material fill. Their public props
no longer offer a Regular selector. Buttons, toolbars and ordinary surfaces
have local dragging disabled. The bottom navigation retains drag selection,
contact magnification and release rebound; button and tab clicks remain active.
The navigation's outer capsule and selection lens share the zero-blur/fill
appearance. Background
detail remains visible through its center; refraction and highlights stay at
the edge. Shared generic `GlassSurface` rendering capabilities remain available
for other SDK consumers; they are not a second Apple component appearance.
Reduced-transparency and increased-contrast preferences retain the opaque
accessible fallback.
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


Additional user-supplied optical references inspected on 2026-11-06:

| Source | Revision | Relevance to Pocket |
| --- | --- | --- |
| [xhzq233/liquid_glass_example](https://github.com/xhzq233/liquid_glass_example/tree/e40383467214384f86d2d08374848cc4df13afc6) | `e40383467214384f86d2d08374848cc4df13afc6` | Primary visual reference requested by the user. Actual screenshot/video and `shaders/liquidglass.frag` were reviewed: a clear center with stronger narrow-edge background remapping gives a visible glass lens without a milky fill. The demo uses Flutter FragmentProgram/ImageFilter.shader, compatible with Pocket's existing rendering boundary. Its mouse-centered fixed-size lens has no local deformation or spring; keep Pocket's JS-owned shared interaction. Blur, directional shadow and multi-glass behavior are listed as unfinished. MIT license file is present. |
| [jeantimex/liquid-glass-html-in-canvas](https://github.com/jeantimex/liquid-glass-html-in-canvas/tree/51adb13197659ad8ca5d11525814a34903e87b8e) | `51adb13197659ad8ca5d11525814a34903e87b8e` | Secondary GPU pipeline reference: separable blur/downsample, SDF bevel and sharp/blur texture composition. Requires experimental HTML-in-canvas and a WebGPU/WGSL pipeline; its CSS position parser and DOM capture are not compatible with the pinned Pocket layout. Dragging changes a whole window's left/top, with no local jelly field. It crops/uploads per panel per render; target caching is by dimensions, not backdrop content. |

Neither new repository's source or assets were copied into the shipped SDK.
The Flutter example is an optical reference, not a replacement app/component
library. The HTML project's README declares MIT and credits
`ybouane/liquidglass`, but its exact checkout lacks a top-level LICENSE;
source adoption would require preserving confirmed upstream provenance.
Current optical calibration remains Pocket's retained canonical shader, and
these references do not establish Apple renderer equivalence or a new frame
rate claim.

## Rendering adaptation

Flutter continues to use its retained `BackdropFilter` fragment shader.
The explicit `regular` and `clear` materials select a shared optical profile in
that shader. Omitting `material` keeps the legacy recipe and uniform defaults.
The initial 72% appearance fill made controls excessively opaque when combined
with the retained shader's white veil and cushion glow. It was rejected during
visual review. The calibrated profile preserves backdrop hue, uses a narrower
edge lens and directional highlight, and removes that stacked white treatment.
Generic `GlassSurface` defaults to 24% regular tint / 2% clear tint, with blur
radii 12 / 1.5. Regular uses a bounded, radially weighted 48-point disk plus
one center sample, replacing the old Cartesian 7×7 lattice at the same
49-read budget. Clear uses thirteen lightweight taps. Zero blur uses a single
sample; all Apple component compositions explicitly use zero blur and fill
for Clear. Both materials
stay in the existing rendering pass. Native and Web hosts only project the explicit material variant; they do
not select application appearance or own UI state.

The Web transparency review found two separate causes of the old bottom bar:
12-unit Regular frost plus its 24% fill hid the backdrop, and periodic samples
repeated glyph edges into a visible grid. The SDK navigation default removes
the frost/fill rather than adding a second backdrop or a Demo mask. Regular's
non-periodic samples reduce the remaining lattice artifact in other controls.
`preview_liquid_glass_material_artifact.test.ts` freezes the former 49-tap
branch and compares both GPU outputs over decoded glyph images. In the
33×33 dense glyph region, local second-difference energy fell from 6.92 to
6.02, axis energy from 9.19 to 7.65, and diagonal energy from 3.40 to 2.79.
This measures reduced sampling artifacts, not equivalence to Apple's renderer
or a claim that all blurred text is invisible. Clear's center and pixels
outside the lens are separately compared with the no-glass backdrop.

Validation of this change included actual Showcase light/dark, body scrolling
under the fixed bar, pointer-driven lens selection and release in both local
Web previews, plus native shader deformation on the iOS simulator. The native
60-frame measurement restored the original pixels and left pixels outside
the optical halo unchanged. The optical, local-deformation, output-cache and
glyph-artifact Web test files each passed. Two combined Bun runs timed out in
browser waits after the output-cache test, although the same local-deformation
file passed independently; those combined runs are not reported as passing.

Visual review uses Apple's actual reference images, not only API names:

- [HIG controls: glass lensing over colored tracks](https://developer.apple.com/tutorials/images/com.apple.HIG/human-interface-guidelines-page-image-card@2x.png)
- [Regular over light content](https://developer.apple.com/tutorials/images/com.apple.HIG/materials-ios-liquid-glass-over-light@2x.png)
- [Regular over dark content](https://developer.apple.com/tutorials/images/com.apple.HIG/materials-ios-liquid-glass-over-dark@2x.png)
- [Clear over detailed content](https://developer.apple.com/tutorials/images/com.apple.HIG/materials-ios-liquid-glass-clear@2x.png)

These are visual targets for background continuity, thin edge reflection and
refraction, and material hierarchy. Pocket parameters remain an approximation;
Apple's private renderer is not reproduced or claimed.

Web Preview previously projected optical surfaces as frost only. It now embeds
the same shader asset and adapts only GLSL texture/coordinate IO for WebGL.
JS execution, layout, routing and input still use the pinned native PocketJS
runtime and the ordinary buildGuest bytecode pipeline.

The Web renderer keeps one program, buffer and texture per preview canvas.
Capture uses the existing 2D scratch canvas, cropped to the optical sample ROI.
`opticalInset: 36` is already inside the compositor paint quad; only the
additional required sampling halo is captured. Magnification contracts sample
coordinates toward the lens center and needs no extra capture margin.

A bounded LRU retains at most eight projected static output canvases and four
million pixels (16 MiB of RGBA storage). A moving deformation draws directly
from the one GL canvas; it does not copy an additional output bitmap every
spring frame. Resting or unchanged held fields can reuse their projection.
The ordered backdrop key includes only paint intersecting the sample ROI;
an overlapping preceding filter conservatively retains its complete input
prefix so transitive refraction cannot reuse stale pixels. Video inputs remain
uncacheable, and resource updates invalidate the key. No production pixel
array, readPixels, getImageData, DOM snapshot or secondary layout is used.
Closing the preview releases all retained bitmaps and GPU resources. A
missing/lost GPU context uses real backdrop frost and reports `frosted`.

The retained parent's `PocketLiquidGlassSurface` in
`pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` memoizes JS optical
recipes, and its page renderer retains RepaintBoundary subtrees. Pocket keeps
that reuse principle at its existing rendering boundary. Per-surface Web output
retention is a necessary adaptation: the prior single scratch result was
continually evicted when multiple controls alternated through the renderer.
No parent app widget tree, second UI state store or per-control WebGL context
is introduced.

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
- Apple components use one transparent Clear appearance. Check foreground
  contrast over the actual content. Local drag effects are disabled outside
  bottom navigation.
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

`editor/test/preview_glass_output_cache.test.ts` removes only static-output reuse
for its ablation. With five Regular surfaces at 390×844/DPR 2, 60 frames changing
one local field require 60 optical draws and one texture upload; disabling
retention requires 300 draws and 300 uploads. Uploaded pixels fall from
64,911,600 to 216,840. Final full-resolution pixels are identical. An
intersecting backdrop change invalidates the affected result, and a twelve
surface stress verifies count/pixel bounds and disposal. In an exclusive headed ANGLE Metal run, browser callback gap P50/P95 was
16.7/18.6ms with retention and 16.7/17.6ms without it. Canvas submission
P50/P95 was 0.6/2.6ms with retention and 0.4/0.6ms without it. Those small
CPU submission samples do not demonstrate a latency improvement: the proven
benefit is eliminated optical draws/uploads while retaining full-resolution
pixels. Browser callback cadence is not physical display FPS or GPU completion
time; headless callback cadence varied substantially and is not used as an
on-screen FPS claim.

`packages/pocket_ui/test/glass_surface.test.ts` uses the pinned Solid runtime to
verify material updates, descriptor deduplication and instance-local cleanup.
It is bridge lifecycle coverage, not a substitute for real QJBC execution.

`editor/test/liquid_glass_profile.ts` is a real QJBC/native-input Web Preview
profile with two glass surfaces, a moving nonuniform backdrop, a no-glass
ablation and idle parking. It reports delivered frames, browser rAF and canvas
submission cost separately. These are not GPU completion timings.

`editor/test/preview_glass_drag.test.ts` now verifies click actions, fixed
Clear material/pixels during ordinary-control drags, bottom-tab drag/click selection and
route cleanup. The earlier local-deformation acceptance described below is
historical evidence for the retained generic renderer, not the current Apple
interaction: standalone and toolbar glass buttons receive real pointer input,
an edge contact changes only the material's local field while its shell and
label rect remain fixed, release returns the descriptor to zero and parks the
preview, and elastic=false, Reduce Motion, route removal/re-entry, and the
NavigationBar's cross-tab lens/selection path are all exercised. The latest
headless Playwright + ANGLE Metal run passed 1/1 with 4–5 glass surfaces; the
M4 renderer was `ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified
Version)`, and the canvas reported `webgl-refractive`. For that run, active
frame-gap p50/p95 was 16.0/23.7ms, canvas paint p50/p95 was 1.1/6.3ms, and
the settled release parked the native preview timer. The reported
`previewFrameHz` is a preview-frame delivery aggregate that includes idle and
interaction windows, not a physical display-FPS measurement. The test
normalizes the descriptor's optical inset back to the shell for geometry
assertions; the expanded compositor paint halo is not treated as an input
target.

The retained Web optical suite independently passed 4/4 under headless ANGLE
Metal, including the real-frost fallback when a WebGL context is unavailable
or lost and the asynchronous cold-preparation path. No CPU pixel readback was
added to the production renderer.

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

Before the optical-profile calibration, on the Duo iOS 27.1 simulator both
retained refractive surfaces rendered 120
frames in each two-second window (60Hz). Two-glass build p50/p95 was
1.726/3.880ms; raster 1.040/1.423ms. The same moving backdrop without glass had
build 2.112/3.070ms and raster 0.502/0.730ms. Active-gap p95 was 16.670ms with glass and 16.669ms without.
That initial fixture supplies the previous nonzero material-tint uniforms;
its results do not measure the later calibrated optical profiles. Pressed/shape
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

For the optional stationary pull and jelly return, see
[Apple glass interaction](APPLE_GLASS_INTERACTION.md).
