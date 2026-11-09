# Visual novel model viewport scaling

## Source-first finding

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched outside `pocket_host/` for Live2D, Cubism, Spine, skeletal, and
model-view implementations. It contains no retained VN mesh/model renderer to
adapt. The closest relevant parent code is the generic image fitting in
`lib/render/pocket_ui_components.dart`; it does not describe retained mesh
vertices or scene-model viewport scaling.

The current VN already has one canonical model frame. In
`packages/pocket_vn/src/live2d.ts`, Core vertices are fitted into an authored
240×350 frame with a 220×330 content area. In `src/spine.ts`, Spine positions
are fitted into the same 240×350 frame before they are encoded. Both produce
PMS1 local-pixel geometry and use the shared `NovelModelView`/`NovelMeshView`
path.

## Gap and minimal adaptation

`src/viewport.ts` computes the character frame as `240 * artScale` by
`350 * artScale` and also scales the authored x/y anchor. `StageCharacters` in
`src/view.tsx` uses those dimensions for the outer node, but applies only the
authored character scale and rotation as transforms. Its static-image branch
is laid out from an image rectangle, so enlarging those bounds also enlarges
that image. A mesh uses different semantics: the pinned native mesh path
applies the node's world transform to each PMS1 vertex; it does not stretch
the vertex coordinates to fill the node's width/height. Thus the larger
responsive model frame changed the layout bounds without changing the model's
local geometry scale.

The model branch now wraps `NovelModelView` in one fixed 240×350 canonical
frame with `scale: layout.artScale` and `originX/Y: -0.5`. In the pinned
framework, `-0.5` anchors the transform at the left/top edge. The existing
outer character frame keeps its responsive bounds, authored position,
character scale, rotation, and z-order. The combined mesh transform is the
existing stage/camera transform, the outer authored character transform, and
one viewport `artScale` transform. There is no second geometry map, renderer,
factory fit, or saved viewport state. The static `Image` fallback remains on
its original bounds/contain path.

This wrapper applies to both Live2D and Spine because both use the shared
PMS1 path. It does not change model factory coordinates, scene instructions,
story/save data, texture assets, mesh effects, or renderer limits.

## Source locations

- `packages/pocket_vn/src/viewport.ts`: responsive 240×350 frame and authored
  anchor calculation.
- `packages/pocket_vn/src/view.tsx`: `StageCharacters` keeps the outer frame
  and wraps only the registered-model branch in the canonical frame.
- `packages/pocket_vn/src/live2d.ts`: Live2D canvas fitting and local PMS1
  vertex generation.
- `packages/pocket_vn/src/spine.ts`: Spine bounds fitting and local PMS1
  vertex generation.
- `packages/pocket_vn/src/model-view.tsx` and `src/mesh-view.tsx`: shared
  retained model-node and geometry submission path.
- `native/patches/image-mesh.patch`: pinned mesh drawing applies the world
  transform to PMS1 local vertex coordinates. The spec copy shipped with the
  pinned compiler documents `originX/Y = -0.5` as the left/top edge.

## Validation boundary

The pocket_vn unit suite passed 154 tests with 1,332 assertions. The strict JSX
check used
`node_modules/typescript/bin/tsc --noEmit --project .pocket-build/tsconfig-vn-view.json`.
Before the subsequent strict JSX fix, it reported 17 diagnostics: 16 in `pocket_ui` and one title-screen `Show`
children error at `src/view.tsx:1048`. A temporary source copy with only this
wrapper hunk reverted reports the same diagnostics (the title error shifts to
line 1046), so the new model branch added none. The subsequent minimal
[strict JSX fixes](VISUAL_NOVEL_STRICT_JSX.md) make this complete shared-source
check pass. The rebuilt Guest's native regression is recorded separately from
the original pixel matrix in [v4 acceptance](LANTERN_V4_ACCEPTANCE.md).

The root then compared an unscaled control with this candidate using the same
v4 story, app source, PAK and native host. The macOS Profile test-view matrix
passed at 390×844 and 1920×1080, each at DPR 1 and 2, using the real Live2D Core
and 2048² sample textures. Candidate QJBC SHA-256 is
`e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176`; unchanged
PAK SHA-256 is
`8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08`. Captures
and measurements are under `sdk/.pocket-build/lantern-v4-scaled-20261108/`.
These are macOS Profile test-view metrics, not physical mobile, OS resize, or
device-DPI acceptance. The test matrix does not close the remaining model-art,
full-body composition, platform, memory, or performance gates.
