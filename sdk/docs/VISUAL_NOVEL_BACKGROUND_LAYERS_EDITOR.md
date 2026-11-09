# Visual Novel Background Layers in the Editor

## Retained source and the adaptation

The retained parent project has a generic horizontal gallery, not authorable scene depth. `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` renders `<Gallery>` as a horizontal scroll row, while `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js` forwards gallery items. Neither path stores a background cue, a parallax factor, scene inheritance, or an authored layer order. There was no retained VN background-layer editor or renderer to copy.

The Editor therefore adds controls to the existing scene instruction form and reuses the Pocket VN scene and camera helpers. It does not add another renderer or another source of scene state. Both existing DOM previews resolve layer poses with `resolveNovelBackgroundLayerPose` from `pocket_vn/src/background-layers.ts` and the same `resolveNovelCameraPose` used by the Guest. Each DOM layer gets that helper's final stage pose directly.

## Authoring behavior

The scene form lists layers from back to front. Each row selects a registered background cue, edits its 0–1 parallax factor, changes order, or removes the layer. The Add button is bounded by the shared eight-layer limit. These edits use the Editor's existing story undo/redo and save history.

The form distinguishes the canonical field states:

- Missing `backgroundLayers` means inherit the prior scene's layer list. The Editor leaves the field absent when this mode is saved.
- `backgroundLayers: []` explicitly clears inherited layers.
- A nonempty array replaces the prior layer list with the authored order.

“Clear and stop inheriting” writes an empty array. “Inherit previous scene” deletes the field. Removing the last row leaves the explicit empty array. Editing a row spreads its existing object so custom layer metadata survives cue and parallax changes; story-level metadata is kept by the existing editor document flow.

The cue selector includes a missing current key when the story references an unregistered cue, so the value remains visible and can be repaired. Validation uses the shared `novelBackgroundLayersInstructionIssue` helper and checks each cue against `novel.assets.json`'s existing `backgrounds` registry.

## Validation evidence

Run the isolated browser acceptance with the repository's pinned Bun 1.4.4:

```sh
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --max-concurrency=1 editor/test/novel_background_layers_browser.test.ts
```

The test starts a temporary Editor project and a Playwright Chromium browser. It covers cue/parallax edits, reorder, add/remove, undo/redo, deleting all rows to `[]`, switching between empty and inherited modes, preserving custom layer/story metadata, and keeping an omitted legacy field omitted through save and reload. It also verifies that the stage authoring preview and live preview produce the same resolved transforms.

The same browser test builds the saved temporary project through the pinned `buildGuest` pipeline, then starts that QJBC with `NativeSession` and the repository's pinned `pocket_probe`. It checks the native draw order and real source-UV crops: parallax 0 stays fixed, parallax 0.5 moves partway with the camera, and parallax 1 matches the base background camera geometry. All project files and Guest artifacts are created under a temporary directory; no Demo assets are staged or overwritten.

## Recorded artifact proof

The final isolated run used pinned Bun 1.4.4 on 2026-11-08 and passed 1/1 test (`/tmp/pocket-background-layers-editor-final.log`). It saved story revision 3 with SHA-256 `cbec269e6c026ebb72ecea993299f2c6b5d421fad47eb20e4e8cdc833b7e8ba3` (1,596 bytes). The generated `app.js` was 705,320 bytes and matched metadata `sourceSha256` `73938bf4d4e3a00374cce76fa83ba98d1404c74dfb6bb8431f49d746e098a0fe`. The 389,147-byte QJBC payload matched metadata `payloadSha256` `1fb120a74a1aa3638d5e720462b053d29ecf4c54d6678eeda7c3a84955e8d7e2`; complete QJBC was 389,271 bytes with SHA-256 `8f72e142278d583d4d5a84075bf6a5c901b91ff77cc27a6a7827b16d8f5f7343`. The PAK was 5,386,752 bytes with SHA-256 `7e9e4399185d5924ab0acb48e1cfeebf265808dfc8ab40d897730d179bf228b7`. Runtime ABI: `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`. The run removed its temporary project and output after verifying the hashes.
