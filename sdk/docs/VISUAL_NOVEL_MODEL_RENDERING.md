# Model rendering integration and ablation

## Retained source inspected first

The retained parent `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`,
`lib/core/pocketjs_bundle_runner.dart`, and `mini_apps/` were inspected, excluding
`pocket_host/`. They contain image/graphics specifications, but no Cubism/MOC3 or
Spine skeletal runtime implementation. The graphics “Mesh” label in the parent
is not an implementation. This is an evidenced capability gap.

The pinned PocketJS core already emits CPU-clipped `TEX_TRI`; the existing
`sdk/native/src/lib.rs` decoder, Flutter `PocketTextureTriangleOp`, and
`pocket_view_painter.dart` already preserve triangle positions and texture UVs.
We extend this path instead of introducing another layout engine, canvas game
runtime, WebView, or bitmap animation fallback.

## Retained geometry boundary

`native/patches/image-mesh.patch` adds append-only UI operation 62:
`setMesh(imageNode, textureHandle, PMS1Bytes) -> boolean`. Compiler, QuickJS,
ordinary PAK image loading, layout, transforms, painter order and CPU clipping
remain the pinned Pocket pipeline. The unchanged native frame ABI carries
ordinary `textureTriangle` records. Default prebuilt compilers can compile the
JS SDK; the native host must include the mesh patch. Unsupported hosts fail
explicitly. Rebuild platform native libraries before running a new model guest.

PMS1 is little endian: magic `0x31534d50`, vertex count, index count, ABGR
modulation color; then interleaved f32 local x/y/u/v, then u32 triangle indices.
Vertices are limited to 16,384, indices to 98,304, finite local coordinates to
±1,000,000, and finite texture UVs to ±1,000,000. UVs may cross atlas edges; the
per-triangle sampling flag distinguishes Repeat from the ordinary Clamp path. Invalid input leaves previous geometry
unchanged. Retained allocations across a UI realm have an 8 MiB budget.
Same-size frame updates reuse native storage. Clearing/replacing an image or
sprite, destroying its subtree, or destroying the UI releases mesh storage.

`@pocket/vn/mesh` validates and encodes geometry. `./mesh-view` borrows a texture
from the official native PAK handle table, uses an existing image node, and
submits geometry. It never uploads the texture again per frame. A version prop
makes reuse of a mutable geometry buffer visible to Solid without copying it.

## Story and runtime ownership

`scene.characters[].model` contains a model key, animation, loop, Spine skin
and Live2D expression intent;
`null` returns to the PNG expression. Save/load and rollback retain these small
intents, never native pointers, meshes or another narrative state machine.
The official model runtime owns its animation state. The JS view retains one
instance until its resource key changes; a fresh story snapshot does not reload
the model. A shared animation driver extends the existing virtual deadline
clock. Story/menu/lifecycle pause also pauses models. Removing the last model
releases the animation wake when no narrative timer remains.

`novel.assets.json.models` is the authoring source. For Spine, buildGuest reads
confined JSON or binary `.skel` plus atlas files, validates byte budgets and
injects one temporary data module before evaluating the guest entry. It removes
this module after compilation. The official Spine runtime parses exported data
at execution time. Textures use the existing JSON image collector and PAK baker.
No generated model source is maintained beside the canonical files.

For Live2D, the same temporary module carries model3/motion3/exp3 JSON under
`__pocketNovelModelSources`; a `kind` discriminator separates source formats.
MOC3 stays a validated, confined native asset, copied once by content hash into
`native-models/<sha256>.moc3` in the explicit output and host asset directory.
`novel.native-assets.json` maps the original request key (without a leading
`assets/`) to that bundled path. Rebuilds remove only previously catalogued
hash files; unrelated consumer files survive. Model paths and JSON references
cannot escape the project. The native provider reads this exact trusted
allowlist; JavaScript cannot turn model3 references into filesystem access.

The Showcase game dispatches by model kind through the same factory boundary
and declares native Live2D capabilities as optional. Its shipped original Mira
rig uses Spine. Adding Live2D models also requires the host to opt into the
`pocket_live2d` Flutter provider, bootstrap licensed Cubism Core, register
`PocketLive2dPlugin.fromBundledCatalog` with the generated catalog, and include
the `native-models/` directory in Flutter assets. Proprietary Core or sample
models are not silently added to a consumer or redistributed with this game.

`@pocket/vn/live2d` selects JS motions, evaluates parameters, applies named
expressions against the official parameter defaults supplied by Core, requests
native deformation, and converts the resulting meshes into PMS1. Following the
official Cubism Native 5 R5 Metal shader (`MetalShaders.metal`), it flips raw
Core UV Y once. It resolves masks against the original drawable indices before
sorting by render order. Hidden drawables remain retained mask sources. The
native Core provider resets parameter/part defaults before applying a complete
JS frame so removed expressions do not accumulate state in the native model.

Mask rendering follows `Framework/src/Rendering/Metal/Shaders/MetalShaders.metal`
in the official Cubism Native 5 R5 source: the fragment mask shader samples
texture alpha only. Core therefore emits mask triangles with white PMS1
modulation, preserving geometry, transform and clipping while bypassing the
source mesh color/alpha, model/style opacity, and MFX1 effects. This keeps a
hidden alpha-zero drawable usable as a mask and avoids multiplying the model
opacity into it a second time.
Model motion curves apply EyeBlink/LipSync to the manifest's parameter groups
and Opacity to rendered drawables. Empty ArtMeshes are not replaced by invented
geometry: empty mask unions hide normal targets and pass inverted targets.

MFX1 uses a 40-byte little-endian header: magic `0x3158464d`, blend, mask count,
flags (bit 0 inverted mask, bit 1 Repeat sampling), three multiply RGB
f32s, and three screen RGB f32s, followed by
mask node IDs. The normalized blend values are 0 normal, 1 add, 2 multiply and
3 screen. Model-view resolves stable drawable names to existing native image
node IDs; it does not create another renderer or re-upload textures.
Following `FragShaderSrcSetupMask`, mask passes read only the source texture's
alpha; drawable/model opacity and vertex RGB/alpha must not attenuate coverage.

Support is deliberately bounded. Cubism's packed blend color values
0/3/6/10 with alpha-over map to these four modes. Legacy compatibility values
1/2 preserve destination alpha differently and currently fail explicitly.
The official Mao sample contains 23 compatibility-blend meshes, so successful
MOC3 deformation does **not** establish faithful full Mao rendering. Offscreen
composition, other color/alpha blends, and automatic random eye blinking/lip sync
are not accepted. Physics3 and Pose3 now run in JS using pinned official
Cubism Web Framework algorithms and real Core parameter/part metadata; missing
required JSON or metadata is rejected. See [dynamics provenance and reference
frames](VISUAL_NOVEL_LIVE2D_DYNAMICS.md).
Expression selection is immediate; motion/expression crossfades are not yet a
complete implementation of the Cubism Framework scheduler.

`@pocket/vn/spine` adapts the official Spine runtime to PMS1 and fits the initial
resolved skin/animation pose inside the 240×350 actor stage. It keeps topology buffers, bounds tiny numerical
UV clipping noise, and rejects genuinely out-of-range UVs. Spine currently accepts normal blend and straight-alpha textures; its other
blend modes remain explicitly unsupported. Live2D uses the separate MFX1
acceptance described above.

## Actual validation

- `sdk/native/tests/image_mesh.rs`: actual native geometry changes and CPU
  clipping; invalid NaN/index updates are atomic; fixed topology reuses storage;
  subtree destruction returns mesh allocation to zero. Mask DrawList checks
  verify PMS1 alpha 0 and 0.25 both emit white mask modulation, while target
  modulation is preserved.
- `sdk/scripts/tests/image_mesh_patch.test.ts`: reverse and forward application
  against the pinned predecessor, exact file content and repeat detection.
- `demo/js/tests/mesh_native.test.ts`: pinned compiler → real QJBC → QuickJS
  pointer input → texture triangle moves x=10→40→10, preserving alpha.
- `demo/js/tests/spine_native.test.ts`: the game's original Mira rig runs in
  actual QuickJS, vertices change over virtual time, a menu freezes them and
  closing it resumes movement.
- `sdk/packages/pocket_vn/test/models.test.ts`: model intent save/load/rollback
  and explicit return to PNG; runtime vertex state cannot enter saved intent.
- `sdk/packages/pocket_vn/test/clock.test.ts`: multiple actors share one deadline,
  pause freezes all actors, and removal of the last actor removes the wake.
- `sdk/packages/pocket_vn/test/spine.test.ts`: weighted official geometry flows
  into reused PMS1 buffers; animation changes and disposal are observed.

The original Mira rig in `demo/js/apps/lantern/models/` uses the already
provenanced story textures and adds no duplicate bitmap assets. Official Spine
runtime and Cubism Core licensing are documented separately. Native frame facts
do not establish device FPS, complete Live2D rendering, or cross-platform parity.

## Packaged compiler and preview evidence

The final mesh/mask source was compiled into release `pocket_probe` and
`pocketjs_bytecode`, then packaged with `package_toolchain.ts` into the ignored
`sdk/.pocket-build/current-native-tools` directory. The authoring browser test
ran with `POCKET_TOOLS_PACKAGE` and `POCKET_NATIVE_PROBE` pointing to that exact
artifact. It edited, saved, reopened, built and clicked the compiled Guest, and
required more than ten native `textureTriangle` records after starting the
game. The model authoring test separately passed its fifteen assertions,
including real animated Canvas pixels, CRUD and undo/redo. One combined run
lost the Playwright browser process during a Save click; its isolated rerun
passed without code changes. This is recorded as a browser-process failure,
not silently counted as a passing run.

The packaged MFX1 test passed four real pointer-driven phases, including
Repeat-only without a composite layer and preservation of UVs outside [0,1].
The same fresh tool package edited, saved, rebuilt and ran an Editor preview with
actual Spine mesh triangles. This verifies the locally assembled package, not
an already published npm release. Consumers need a release containing this
native patch; old installed tools must not be treated as proof of new rendering
support.

## Real Core transport ablation

The same official Mao frame passed through the real Dart Core provider and
`PocketBinaryCodec`: 262 drawables, with 5,879 position components changing
after ParamAngleX input. Encoding that exact frame as packed little-endian
buffers used 235,065 bytes; equivalent scalar arrays used 533,073 bytes, a
55.9% reduction. The packed response passed the actual 1 MiB host-to-guest
pending-response limit. This measures encoded payload size, not allocation
counts, FPS or end-to-end latency. The 256 KiB guest-to-host request limit is
a different direction and is not used as a response limit.

## Official texture-edge evidence

The official Hiyori MOC emits raw UVs outside [0,1]: ArtMesh100 reaches
−0.0003222227 and ArtMesh68 reaches 1.00095987. These exceed numerical epsilon
and must survive the geometry encoder. The official Native R5
`Framework/src/Rendering/Metal/CubismShader_Metal.mm:880-888` uses Repeat for
drawable sampling, as does OpenGL `CubismShader_OpenGLES2.cpp:1099-1100`.
Clamping the vertices would change interpolation and conceal an unsupported
sampling mode.

MFX1's word-12 flags use bit 0 for inverted masking and bit 1 for repeated
texture sampling. Repeat selects append-only TEX_TRI_REPEAT DrawOp 14 and PFB1
tag 14; both carry the same triangle geometry payload as TEX_TRI. PMS1 UVs are
preserved when finite and within ±1,000,000, which keeps the observed Hiyori
coordinates intact without accepting unbounded input. Mask sources keep their
own sampler flag and continue to use texture alpha only; the mask draw bypasses
mesh color, opacity and tint modulation, matching Cubism's sampling contract.

Flutter batches only triangles with matching asset, clip, color and sampler
mode, and uses `TileMode.repeated` for repeat triangles. The test suite now
checks periodic pixels from a two-color texture and repeated alpha in hidden
mask geometry, including separation from the target mesh's clamp batch. A
Repeat-only effect emits no composite layer; real masks, RGB tints and
non-normal blends retain their existing layers. Sending an identical, fully
validated MFX1 value is a no-op and clearing an effect sends empty bytes to
release it.

The software rasterizer exposes `validate_supported_draw_list` and returns an
explicit unsupported error from surface rendering before mutating the target;
Web and WeChat presentation/capture preflight through that boundary. GPUI
preflights before painting. The Editor's Canvas2D preview reports an explicit
unsupported status for MFX and repeat records instead of drawing them as
clamped triangles. The direct allocation-free `render_scaled*` raster helpers
cannot return an error, so callers that consume arbitrary DrawLists must call
the validator first. Core/native geometry and transport regressions preserve
the Hiyori UV values. Pinned Flutter 3.47.9 model and painter tests pass (15
tests), including two-color periodic pixels and hidden-mask sampler/batch
checks. Native `image_mesh.rs` passes all four integration cases, and the
focused native serializer test passes JSON and PFB1 version 2. The pinned predecessor
patch test passes exact forward application and repeatability checks; the
Editor test reports MFX and repeat as unsupported. Cargo checks pass for GLES,
Vita, Web, ESP-IDF PPA, SiFli and Web/WASM consumers, with existing workspace
dependency and deprecation warnings. GPUI compilation remains unverified:
its build script requires the unavailable Metal Toolchain. Its preflight
source is present, but the other consumer checks do not prove that build.
The separately assembled macOS game
pipeline also passed an actual Hiyori frame; iOS/Android device-level Hiyori
results remain with the platform acceptance run.

A final fresh-package run also passes the MFX pointer test and both Editor
browser tests (3 tests, 43 assertions). The four MFX phases verify mask/blend
changes, clearing, and a Repeat-only triangle with UV −0.25/1.25 and no
unnecessary composite layer. This uses the rebuilt local tool package rather
than an older installed compiler or probe.

The rebuilt arm64 dylib also passes the actual Flutter FFI binary-frame suite
(6 tests) and recording/replay suite (11 tests), covering duplex frames,
recording replay, fingerprints and asset hashes after the sampler/decoder changes.

The official Hiyori QJBC passes the real Core provider → PMS1/MFX1 → Flutter
painter test on macOS. The model-only PNG was also visually inspected for an
upright character and correct texture orientation. This fixture downsamples
the two official textures from 2048 to 512. The strengthened fixture includes
physics/pose and passes default-FFI integration on iOS and Android simulators
and in an actual macOS application, including model pixels, deformation,
physics parameter and pose part updates, pause/resume and release. The macOS app loads the packaged Core through
the plugin's default `DynamicLibrary.process()` path, with no injected dylib.
These results do not establish unrestricted Cubism compatibility or Windows
execution. See [Live2D acceptance](VISUAL_NOVEL_LIVE2D.md) for platform evidence.
