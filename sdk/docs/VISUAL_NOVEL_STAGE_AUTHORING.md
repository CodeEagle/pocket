# Pocket VN stage authoring

## Source review and retained behavior

The retained parent project was inspected outside its `pocket_host/` directory before the editor work. The only parent scene-transform path is a 3D game pipeline:

- `pocketjs_flutter_demo/mini_apps/app_game_detail/main.js` updates a shared entity transform buffer from JS game state and controller input.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js` computes 3D transforms in JS; `lib/core/pocketjs_bundle_runner.dart` invokes the prebuilt module and `lib/core/ffi_bridge.dart` writes those transforms at the native boundary.
- The parent has no visual-novel scene instruction editor, 2D character drag surface, or persisted scale/rotation/layer controls outside the excluded `pocket_host/` tree. The 3D entity buffer is not compatible with the VN image-stage coordinate model.

The reusable behavior is the direction of ownership: input and authoring values stay in JS, and native rendering consumes the resulting transforms. The new editor writes the same selected `story.json` scene instruction that the player executes. It does not add a persistent scene model or copy a layout/scene reducer.

## Implementation

`client/novel-stage.js` is mounted in the independent Stage Editor tab. The selected label and scene index identify the canonical instruction. Dragging uses a temporary DOM position while the pointer is down and commits one position patch on pointer-up, so a multi-event drag produces one undo entry. Numeric scale, rotation, and layer edits each commit one history entry. Inherited characters can be selected when the selected instruction is reachable; an edit promotes that character into the selected instruction's `characters` array.

Stage facts come from the pinned Pocket VN core. The editor creates a short-lived engine, places breakpoints before and after the selected scene, steps the real scene instruction, reads the core snapshot, and disposes the engine. This preserves branch, removal, visibility, and default behavior. If execution cannot reach the selected scene because an earlier choice, wait, or other blocking instruction intervenes, the editor says so and executes only that scene through the same core in isolation. It does not claim the isolated composition inherited earlier characters or backgrounds.

The renderer uses `resolveNovelCharacterPlacement`, `orderedNovelCharacterIds`, and `NOVEL_CHARACTER_TRANSFORM_LIMITS` exported by the core module. It does not calculate a parallel layout or z-order rule. Static images and backgrounds are requested by registered key through `/novel/resource`; arbitrary file paths are never accepted. Registered Spine models now use the same official Spine model factory and mesh projection path as the existing resource preview. Live2D remains unsupported in the browser stage because it requires the native model host; see [Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md).

The browser stage uses the same 360 × 640 coordinate space and 240 × 350 character quad as the Pocket VN view. It stretches registered image textures to that quad, matching the native image renderer's UV behavior. CSS transform origin is the upper-left corner, matching the core's character transform convention.

## Validation

`bun test sdk/editor/test/novel_stage_browser.test.ts` passed with Playwright Chromium. The test dragged an inherited character through multiple pointer moves, changed scale, rotation, and layer order, verified one undo restores the whole drag and redo reapplies it, saved and reopened the project, and checked the stored transform values in `story.json`.

The same browser test then builds that saved temporary project through the pinned `buildGuest` route and starts the resulting QJBC and PAK with the pinned `NativeSession` probe. It sends a pointer tap to the rendered title-screen control to start the actual Guest, then checks native DrawOps: dragged Ren reaches the saved position as the renderer's untransformed `image` quad, scaled/rotated Mira reaches the expected transformed `textureTriangle` point, and native draw order puts Mira above Ren. This proves the editor drag/control → persisted scene instruction → compiled Guest → actual native frame path. The root run separately confirmed the shared renderer helper and passed the four-game native regression suite.

The Spine extension has a separate real Chromium and `NativeSession` check for dynamic model pixels, animation, scene changes, disposal, hidden models, and the saved Guest's real Spine geometry; its scope and unsupported Live2D boundary are recorded in [Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md).
