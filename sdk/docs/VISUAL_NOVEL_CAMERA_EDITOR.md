# Visual Novel camera authoring in Studio

## Reuse and boundary

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched with `pocket_host/` excluded. It has no Visual Novel camera instruction or scene-camera authoring UI to migrate. The camera references found there are a Three.js camera in `pocketjs_super_app_demo.html` and the unrelated hardware-style `assets/svg/camera_shutter_ring.svg`; neither represents Pocket VN story data.

Studio reuses the existing scene instruction editor in `sdk/editor/client/novel.js` and its `field`, `checkbox`, and history helpers. Camera values remain on the selected `scene` instruction in `story.json`. `sdk/editor/novel.ts` calls the SDK's `novelCameraInstructionIssue` from `src/camera.ts` for both structural validation and precise diagnostics. The browser editor runtime exposes the same helper for current local diagnostics. No parallel camera draft or persistence path was added.

## Scene controls

The scene editor exposes target X/Y pan in logical stage pixels and scale. When an older scene has no `camera`, the controls display `(0, 0, 1)` but do not write that default into the story until the author edits a value. This preserves the old scene's implicit framing on load and save.

Camera transitions are opt-in. Turning on **镜头过渡** adds a 500 ms transition; omitted easing means the core's `linear` default. The editor can also select `easeInOut`. Shake is separately opt-in and starts at amplitude 18 px for 3 cycles, both editable. Disabling a transition or removing camera settings is an explicit author action.

The form bounds match the SDK validator:

- Pan X/Y: finite values from -4096 to 4096.
- Scale: 0.1 to 8.
- Transition duration: integer milliseconds from 1 to 30000.
- Easing: `linear` or `easeInOut`.
- Shake amplitude: 0 to 512; cycles: integer from 1 to 20.

Edits spread the existing camera, motion, and shake objects before changing a known field. Unknown author metadata on those objects and elsewhere on the scene therefore survives edits, undo/redo, save, and reload. The server rejects an invalid camera instruction atomically instead of replacing the prior story.

## Validation

Targeted Editor tests use the pinned Bun runner and real Playwright Chromium:

```sh
cd sdk
npm exec --yes --package=bun@1.4.4 -- bun test --max-concurrency=1 editor/test/novel.test.ts editor/test/novel_camera_editor_browser.test.ts
```

The run passed 15 tests. Coverage includes shared-core schema bounds, rejected invalid writes preserving the existing file, real form edits, undo/redo, round-tripping unknown metadata, keeping an untouched legacy scene without an explicit `camera`, and save/reload from the same story source. It does not build a Guest or exercise native rendering; runtime camera rendering is covered by the SDK and Demo acceptance work.
