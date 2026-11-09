# Visual novel background layers and parallax

## Source-first findings

The retained parent repository has page-to-page parallax, but no authored VN scene layer stack. The closest reusable behavior is the transition coefficient in `lib/core/ffi_bridge.dart` and `mini_apps/syslib/pocket_syslib_router.js`: each page receives its own translation during a transition. `native/pocket_runtime_multi.h` describes the iOS spring transition's background parallax. Those routines animate whole-page navigation; they do not persist scene image planes, script references, or per-layer depth. No VN implementation was found in the retained parent outside the excluded `pocket_host/` directory.

The current SDK already has the persistent and deterministic parts this feature needs:

- `packages/pocket_vn/src/types.ts` models a single `StageState.background`, stage camera, characters, and a transition's frozen `StageComposition`.
- `packages/pocket_vn/src/engine.ts` applies scene instructions, advances camera motion with the existing virtual tick, snapshots completed dialogue for rollback, and validates restored stage data.
- `packages/pocket_vn/src/camera.ts` resolves pan, zoom, shake, and reduced-motion behavior from canonical camera state.
- `packages/pocket_vn/src/view.tsx` paints one registered background `Image` below video, atmosphere, and characters.
- `packages/pocket_vn/src/localization.ts` maps stable background keys through the existing `assets.backgrounds` locale override.
- `sdk/editor/novel.ts` validates project-relative background assets and scene background references. The Editor's scene inspector and both previews currently show only one background.
- `scripts/build_guest.ts` discovers registered VN PNG/SVG image paths from `novel.assets.json`; adding a background key to the existing registry therefore uses the established Guest/PAK pipeline.

## Canonical layer contract

The existing `scene.background` remains the base image and its key remains the atmosphere binding. A scene can additionally declare:

```ts
backgroundLayers?: readonly {
  background: string; // existing novel.assets.json backgrounds key
  parallax: number;   // finite 0..1
}[];
```

The base is drawn first. Layer entries are drawn in array order, back to front, above that base and below the existing video/atmosphere/character/UI order. Layers should normally be transparent PNG/SVG planes. A factor of `0` keeps a plane fixed to the viewport, `1` follows the full stage camera, and intermediate values follow that fraction of the resolved camera's x/y translation and zoom. The shared pure `resolveNovelBackgroundLayerPose` helper calls `resolveNovelCameraPose`; it adds no clock, pointer sensor, random movement, or duplicate camera state. Invalid factors are rejected, never clamped.

The instruction field is optional. Omission keeps the current layer list, while `[]` clears it. To avoid increasing saves for ordinary single-background stories, empty lists normalize to an omitted `StageState.backgroundLayers` property. Layer count is capped at eight; each layer needs a non-empty background key and finite factor in range. The engine validates layer shape. The Editor validates that each key exists in the single background registry and reuses its project path, PNG/SVG, symlink, containment, and file checks.

## Save, rollback, transitions, and locale behavior

Layer definitions are stored once in `StageState.backgroundLayers`; their current transforms are derived from `StageState.camera`. No independent layer map or animation time is stored. Existing `tick` advances the camera motion exactly as before. Stage transitions copy the previous layer list into `StageComposition.from` together with the already-resolved frozen camera pose, so the old composition does not snap to the new stack. Rollback already restores a complete stage snapshot, including the layer list.

Older V1 saves and compact V2/V3/V4 saves without `backgroundLayers` remain valid and restore the old single-background composition. The additive field travels in the existing JSON stage pool; the compact save version and rollback/backlog limits do not change. `newGame()` continues to use the existing empty-stage reset.

Story instructions contain stable background keys, never locale-specific disk paths. Locale catalogs continue to use the existing `catalog.assets.backgrounds` map to replace the registered image behind each key. No localization schema or catalog version change is required.

## Editor handoff and validation

The shared SDK module `src/background-layers.ts` exports `novelBackgroundLayersInstructionIssue` and `resolveNovelBackgroundLayerPose`. The same instruction helper is available from the package root and `editor-runtime.ts`, so the engine, Editor server, and browser validation can share the 0..1/count/shape rules. The Editor authoring change should keep layers on the existing scene instruction and background registry, and use the existing story history/store for reorder, add/remove, save, undo/redo, and reopen. The live and scene-context previews should consume the engine's `StageComposition.backgroundLayers`, rather than maintain a second preview stack.

The SDK tests cover bounds and resolved poses, authored validation, legacy saves, save codec round trips, atomic load rejection, transition source capture, rollback restoration, clearing layers, and locale asset-key resolution:

```sh
cd sdk/packages/pocket_vn
bun test test/background-layers.test.ts test/localization.test.ts
```

The [Editor integration checkpoint](VISUAL_NOVEL_BACKGROUND_LAYERS_EDITOR.md) passes a real Chromium edit/history/save/reopen → pinned `buildGuest` → NativeSession route, including draw order and UV gradients at parallax 0/0.5/1. The SDK test above covers active-layer save/load, transition capture, rollback, legacy saves, and explicit `[]` clearing. Consumer acceptance now also passes a real Lantern parallax replay with registered transparent foreground images, player-selected pan/zoom, clear/restore/exit, and isolated main-save checks in NativeSession, followed by actual Flutter PAK decode and before/after pixel captures at 390×844 logical / DPR2. See [Flutter pixel evidence](LANTERN_PARALLAX_FLUTTER.md) for the frozen artifact, image hashes, screenshot paths, and the separately observed footer-label clipping. The renderer check uses the actual PocketCanvasPainter and decoded PAK images, not a replacement renderer.

## Current limits

Layers are full-stage planes sized by the existing image-cover logic. This addition does not define independent per-layer position, crop, mask, blend mode, opacity, scroll input, gyro parallax, or separately timed motion. Those would require new authoring and runtime semantics beyond S02.1.
