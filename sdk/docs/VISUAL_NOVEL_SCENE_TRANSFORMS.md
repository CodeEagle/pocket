# Scene character transforms

`SceneCharacterUpdate` supports `scale`, `rotation` (clockwise degrees) and
`layer`, alongside the existing `position`. The runtime, editor controls and
browser preview share `scene.ts` placement, ordering and validation limits.
These are character transforms; camera movement and a timeline remain separate
unimplemented capabilities.

## Retained source and necessary adaptation

The retained parent was inspected excluding `pocket_host/`.
`pocketjs_flutter_demo/mini_apps/app_game_detail/main.js:8` obtains the native
transform array; its `onUpdate` writes JS-owned position, rotation and scale.
It contains no reusable visual-novel 2D stage authoring workflow. We retain the
ownership boundary, rather than copying its unrelated 3D scene protocol.

The pinned compiler's `framework/src/deepzoom.ts` already uses `originX: -0.5`
and `originY: -0.5` for a top-left transform origin. Its `contracts/spec/spec.ts`
defines `rotate` in degrees and the existing uniform `scale` property. The
novel view applies those existing properties to the 240×350 character parent;
image expressions, Spine and Live2D share this placement. No Dart story policy,
new renderer or alternate layout engine is introduced.

## State and compatibility

- Valid scale: 0.05–8; rotation: −360–360; integer layer: −1024–1024.
- Omission retains an existing character's transform. Defaults for a new
  character are scale 1, rotation 0 and layer 0, resolved at rendering time.
- Explicit 1/0/0 resets the transform. Old stories and saves keep their absent
  optional fields and original rendering defaults.
- Ascending layer is back-to-front; equal layers retain insertion order.
- Save, load, rollback and the prior transition composition preserve authored
  transforms. Invalid save transforms fail atomically through `SaveDataError`.

`scene.ts` centralizes geometry and limits. The editor retains one canonical
`story.json` and one history. Its mutually exclusive localization, text and
stage panels use one module loader/disposer, removing duplicated panel
lifecycle handling. Pointer drags commit a single history operation.

## Actual execution evidence

- `sdk/packages/pocket_vn/test/scene.test.ts`: inheritance, reset, stable layer
  order, save/load, rollback, transition composition and invalid input.
- `/tmp/pocket-vn-scene-core-editor.log`: 54 tests pass, 314 assertions across
  the VN core and existing editor route/history tests.
- `/tmp/pocket-vn-dynamics-bundle.log`: the pinned `buildGuest` pipeline test
  passes, including bundled motion/physics/pose JSON and native MOC copying.
- `/tmp/pocket-vn-scene-native.log`: all four complete-game native QJBC input
  tests pass. The game checks the actual native triangle vertices for Ren's
  scale 0.92 and rotation 2°, and confirms Mira draws after Ren despite the
  opposite story insertion order. It also completes all three endings,
  save/load, rollback, keyboard, viewport and voice/locale interactions.

The original showcase uses these fields in canonical `story.json`. Browser
stage authoring has its own detailed evidence and boundaries in
[stage authoring](VISUAL_NOVEL_STAGE_AUTHORING.md).

The final combined VN/Live2D, editor route/history and model-bundling run passed
72 tests with 421 assertions (`/tmp/pocket-vn-final-unit.log`). The final source
Guest rebuild passes all four native acceptance tests again
(`/tmp/pocket-vn-source-final-native.log`). Platform game and Live2D fixture
artifact identities are recorded separately in
[platform acceptance](VISUAL_NOVEL_PLATFORMS.md).
