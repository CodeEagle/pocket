# Visual novel atmosphere layers

`NovelAssets.atmospheres` maps an existing background ID to optional `mist` and
`rain` project image paths, `intensity` (0–1), and `lightning` (boolean). These
are cosmetic presentation layers. Narrative camera motion remains in the
canonical engine stage; weather phase does not affect decisions or saves.
Loading a game can restart this cosmetic phase rather than pretending to
restore an exact rain drop position.

## Source-first adaptation

The retained parent, excluding `pocket_host/`, implements pure-JS bounded
particles in `mini_apps/syslib/pocket_syslib_graphics.js` at
`compute2dParticleFrame` and demonstrates them in `mini_apps/app_canvas_lab`.
Its particle sample returns a fresh binary DrawList command collection each
frame. The current SDK already provides retained PMS1 geometry through
`mesh.ts`/`mesh-view.tsx` and the existing native image node. We retain the
JS-owned bounded simulation, adapting it to those retained meshes rather than
adding another Dart renderer, protocol or simulation loop.

`createNovelRainMesh` allocates 40 drops by default (64 maximum), one vertex
array, one index array, and one serialized buffer. Each update reuses these
buffers. The renderer uses one mesh node for all drops, plus two shared fog
image instances. Missing rain does not calculate rain geometry. Both fog
instances borrow one registered texture.

`NovelAtmosphereView` registers with the existing `NovelAnimationDriver`.
`attachNovelClock` already advances that driver; no separate timer or
animation frame callback is introduced. Weather updates at at most 30 Hz,
while the existing driver remains free to animate models at its normal rate.
Leaving the scene unregisters the actor; menus, pause and lifecycle suspension
stop its progression. No narrative state or settings store is duplicated.

The layer is inside the camera art group, before characters, so weather gives
portraits depth without covering their faces or moving dialogue/HUD hit areas.
A distant lightning illumination is limited to a single low-opacity 260 ms
pulse every 11 seconds. Inactive scenes suppress illumination immediately,
including if pause occurs during a pulse. Reduce-motion preferences disable
rain movement and illumination and retain static fog. This uses the shared
accessibility context; each Guest app must provide its own actual host fact
accessor, since launcher contexts do not cross Guest runtimes.

## Asset and validation evidence

Lantern's mist was created using the built-in GPT Image tool. Its original,
prompt, runtime bake and hashes are retained under
`demo/js/apps/lantern/art/fx/PROVENANCE.md`. ImageIO inspection of the 512×512
runtime image found alpha 0–253, 204,615 fully transparent pixels and no fully
opaque pixels. The rain image is an original deterministic solid-fill SVG tapered streak (the pinned SVG baker does not support gradient fills).
All image paths go through the existing canonical asset collector and pinned
PAK baker.

`test/atmosphere.test.ts`: two tests / 16 assertions verify malformed paths and
scalar bounds, bounded real PMS1 vertex/index counts, changed positions,
serialized-buffer reuse, and invalid simulation input rejection. These pure
checks do not prove native rendering, platform decoding, lifecycle or frame
performance. `demo/js/tests/novel_atmosphere_native.test.ts` subsequently passed one test /
73 assertions using its own temporary pinned buildGuest QJBC/PAK and
NativeSession: native rain vertices and fog bounds move, menu pause freezes
and resume continues, bounded scanning observes the illumination pulse,
actual host reduce-motion events remove rain/flash and retain fixed fog, and
a clear background unmounts the animation actor while dialogue remains
painted. This does not certify Flutter GPU performance or platform lifecycle.
The atmosphere Editor browser/Guest-asset check is recorded below. Integrated
game and platform checks remain separate from the NativeSession proof.

This implementation does not claim a general particle editor, arbitrary
shaders, physical raindrop collisions, weather audio, or a multitrack timeline.

## Editor registry authoring

The retained parent has a JS particle sample, but no VN background-to-weather
asset authoring surface. The Editor keeps the adaptation in the existing
`novel.assets.json` registry: `atmospheres` is an optional map keyed by an
already registered background ID. The `novel.ts` service calls the same
`novelAtmosphereIssue` helper as the runtime and checks `mist`/`rain` through
the existing image-path containment, regular-file and symlink boundary. A
configuration for a missing background is diagnosed and rejected on save.
Direct previews use the same project-local image route as skin previews.

The Assets panel edits mist and rain paths, shows each actual image preview,
and edits intensity and lightning in place. It leaves other atmosphere
metadata intact, participates in the shared asset undo/redo history, follows a
background rename, and removes its entry with a deleted background. An
untouched legacy registry does not gain an empty `atmospheres` field. The pure
validator is exported from both the headless and Editor runtime barrels; the
browser editor calls that helper rather than maintaining another intensity or
path schema.

`editor/test/novel_atmosphere_browser.test.ts` uses pinned Bun 1.4.4 and real
Playwright Chromium. It verifies PNG/SVG previews, intensity/lightning history,
background rename with undo/redo, metadata retention after save/reopen,
atomic rejection of a missing-background reference, invalid intensity and a
traversal image path, and real `buildGuest` PAK entries for Lantern's registered
mist/rain files. The successful pinned build collected `art/fx/sea-mist.png`
(512×512) and `art/fx/rain-streak.svg` (32×32) into a 16-entry PAK. Command
from `sdk/`:

```sh
.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test editor/test/novel_atmosphere_browser.test.ts
```

The browser test proves authoring, local preview, validation and pinned asset
collection; it does not measure the native atmospheric animation itself. The
separate `demo/js/tests/novel_atmosphere_native.test.ts` is the QJBC/NativeSession
evidence described above. Flutter GPU performance and physical-device results
remain separate platform evidence.
