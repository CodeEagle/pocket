# Lantern v4 framing and parallax preview

## Source and baseline

The retained parent checkout was checked outside pocket_host. Its
lib/render/pocket_ui_components.dart has generic image fitting, but no VN
scene compositor or Live2D framing behavior to reuse. Lantern continues to
use the SDK's existing scene and character transforms.

The SDK fits a Live2D model canvas to a 220×330 logical frame in
[src/live2d.ts](../packages/pocket_vn/src/live2d.ts). Authored character
position and scale are applied by [src/viewport.ts](../packages/pocket_vn/src/viewport.ts)
and [src/view.tsx](../packages/pocket_vn/src/view.tsx). The earlier v3
framing made Hiyori look small and floated above the dialogue area; the
conservative visible-cheek width was about 90–90.5 logical pixels at phone
and desktop sizes. The same-story, same-PAK v4 unscaled control measured
106 logical pixels at desktop DPR 1.

## Hiyori framing result

Story v4 changes sample_hiyori position and scale in six showcase scene
labels, using the existing 360×640 authored scene coordinates:

| Labels | Previous framing | v4 framing |
| --- | --- | --- |
| model_showcase_hiyori_idle_0, model_showcase_hiyori_idle_1, model_showcase_hiyori_tap_body | centered, scale 1 | position {x: 0, y: 200}, scale 1.5 |
| model_showcase_hiyori_idle_0_closeup, model_showcase_hiyori_idle_1_closeup, model_showcase_hiyori_tap_body_closeup | position {x: -176, y: 70}, scale 3 | position {x: -210, y: 35}, scale 3.5 |

Animation, expression, visibility, model key, ordering, labels, and choices
are unchanged. The Live2D fit algorithm and its texture/canvas handling were
not changed. The unscaled and scaled artifacts use the same story source and
PAK; the scaled candidate QJBC includes the canonical mesh artScale adaptation.

## Actual v4 viewport and density matrix

The tested artifacts are listed in
[release-artifacts.json](../.pocket-build/lantern-v4-scaled-20261108/release-artifacts.json):

- Guest QJBC SHA-256: e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176.
- Guest PAK SHA-256: 8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08
  (69,193,344 bytes).
- Story source SHA-256: aa21d89ce244df20346d55a06afa3664f0a8a511157bd71b02479328d1ce97e9.

The macOS Profile integration matrix passed at 390×844 and 1920×1080, each at
DPR 1 and 2. It captured full-body and closeup poses with the real model
renderer. Closeup visible-cheek measurements use the same conservative
bright-skin component method as the earlier density report:

| Logical viewport | DPR | PNG pixels | Conservative face width |
| --- | ---: | ---: | ---: |
| 390×844 | 1 | 390×844 | 114 logical px |
| 390×844 | 2 | 780×1688 | 115 logical px |
| 1920×1080 | 1 | 1920×1080 | 142 logical px |
| 1920×1080 | 2 | 3840×2160 | 142.5 logical px |

All four measurements exceed the 70 px phone and 100 px desktop targets. The
source captures and measurement JSON are retained under
[lantern-v4-scaled-20261108](../.pocket-build/lantern-v4-scaled-20261108/).
captures.json records PNG hashes and dimensions; face-*.json records the
measured region and component bounds. The actual opened model, mask,
animation, pause/resume, and handle-release behavior were checked by the same
real macOS integration. These test-view dimensions do not establish
physical-device or Windows results.

The previous density measurements remain in
[VISUAL_NOVEL_MODEL_DENSITY.md](VISUAL_NOVEL_MODEL_DENSITY.md). For the actual
v4 PAK admission limit and configured host budgets, see
[LANTERN_V4_RESOURCE_BUDGET.md](LANTERN_V4_RESOURCE_BUDGET.md).

## Isolated parallax preview

The replay entry parallax_showcase starts in its own label and does not write
the parked main engine's progress. Its menu option IDs are parallax_pan,
parallax_zoom, parallax_clear, parallax_restore, and parallax_exit. The scene
uses parallax_station, an alias of the existing station image without a
station atmosphere binding, then layers parallax_lantern at factor 0.42 and
sea_mist at 0.12. The replay can pan and zoom the existing camera, clear the
layer list, restore both planes, and return through the SDK's normal replay
exit.

The lantern overlay's original 1671×941 master is retained. Its registered
runtime image is the existing pipeline's transparent 2048×1024 padded output;
the app registers those runtime dimensions so transparent margins keep their
authored placement. Pixel preservation and padding evidence are in
[LANTERN_PARALLAX_ART.md](LANTERN_PARALLAX_ART.md). This change adds no new
asset manifest, renderer, or game-state map.

The new image's texture preparation and presence in the v4 PAK are not a
real-Flutter display acceptance. Pixel evidence that the foreground is
decoded, visible over the scene, and correctly follows camera changes is still
pending. Do not treat the model matrix or source-level replay checks as proof
of those foreground pixels.

## Save migration

The app selects a direct v1→v4, v2→v4, or v3→v4 map from the save's
storyVersion. The maps preserve old instruction identity and index mapping.
The generator's default remains ordered exact matching. Its explicit
hiyori-framing-labels exception is restricted to the six labels above and
ignores only position and scale on the single sample_hiyori character; all
other scene fields and instructions remain exact. The existing v2 allowlist
for the three reordered memory labels remains explicit and narrow.

Migration changes a saved execution address; it does not rewrite the saved
stage, completed rollback checkpoints, or model transform. A save restored at
an old checkpoint can therefore show its old framing until a v4 scene runs.
The new parallax replay is optional and does not change a main-story save.
Save encoding, rollback capacity, and storage limits are unchanged.

## Verification and remaining acceptance

The source tests cover the v4 story transforms and English catalog, and
regenerate the v3 map while rejecting an unapproved label or unrelated
scene-field change. Native route/gallery acceptance also passed on the v4
Guest: all three endings unlocked naturally, paging used real pointer
scrolling, and gallery interaction left the main autosave unchanged. The
native run reported a largest V4 slot of 58,885 UTF-8 bytes.

The four DPR matrix and the face-width target pass on macOS. These results do
not establish physical-device/Windows behavior, stable whole-game RSS,
cold-start time, or frame-time budgets. The parallax foreground still needs
the real-Flutter pixel acceptance described above.
