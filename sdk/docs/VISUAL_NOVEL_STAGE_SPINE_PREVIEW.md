# Editor stage Spine preview

## Scope

The Stage Editor now previews registered Spine characters with their authored animation and skin, while keeping each character in the same logical stage frame and applying the saved position, scale, rotation, visibility, and layer. This is a Spine-only browser preview. Live2D remains available in the native Guest, but the Editor browser has no Live2D host and shows that limitation directly. This closes only the Spine portion of E07.3; it does not complete the item or S09.

## Source-first review and reuse

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, contains a JS-owned 3D transform/input pipeline in `mini_apps/app_game_detail/main.js` and `mini_apps/syslib/pocket_syslib_graphics.js`. It has no 2D visual-novel stage authoring surface, no selected-scene transform editor, and no browser Spine canvas preview. The 3D entity buffer is not compatible with the VN's 360 × 640 logical stage or 240 × 350 character frame.

The implementation reuses working Pocket code instead of adding a new Spine renderer:

- `sdk/editor/client/novel.js` already loaded canonical Spine sources, mapped atlas pages to project textures, and previewed real animated meshes on the model-resource page.
- That page and the Stage Editor now share the private `createNovelSpineCanvasPreview()` lifecycle helper in `sdk/editor/client/novel.js`. It calls the bundled `@pocket/spine` factory and the existing `PocketEditorPreview.projectTriangle` projection path. There is no new window-global preview API.
- `sdk/editor/client/novel-stage.js` obtains the actual selected scene through the existing Pocket VN core helpers and keeps the model canvas inside the normal 240 × 350 actor frame. The surrounding actor still uses the core-authored stage position, transform origin, and z-order.
- Stage teardown, hidden characters, changed model intents, and resource edits invalidate pending work and dispose the controller. Disposal cancels its animation frame, releases decoded texture canvases, and clears the preview backing store.

## Validation

`sdk/editor/test/novel_stage_spine_browser.test.ts` runs in pinned Bun 1.4.4 with Playwright-managed Chromium. It creates an isolated temporary Editor project from the registered Mira Spine JSON, atlas, and textures; no staged Demo Guest assets are replaced. The browser checks real non-transparent mesh pixels and frame changes, edits Mira's position/scale/layer, saves and reopens, switches to another animation/skin, hides the model, and leaves the Stage tab. Disposed previews retain no backing pixels and stop advancing after teardown.

The same test builds the saved isolated project through the Editor's pinned `buildGuest` flow, starts those exact QJBC/PAK artifacts in `NativeSession`, and sends the new-game pointer input. The native draw list contains Mira's actual Spine triangles and Ren's image. Mira's animated triangle coordinates change between frames; scene 0 draws edited Mira after Ren, scene 1 draws Ren after Mira, and the hidden third scene contains no Mira triangles. This is a functional JS→buildGuest→Guest input/render check, not a Flutter or physical-device preview test.

The test also retains [the edited stage capture](../.pocket-build/stage-spine-preview-20261108/edited-stage.png) in the ignored build cache. It shows the official Spine preview, Ren, the station background, and the actor frame at once.

The existing resource-page regression `sdk/editor/test/novel_authoring_browser.test.ts` was also run for its `model assets load official Spine data and paint animated PMS1 meshes through the shared TEX_TRI projector` case to check that extraction did not break the original preview.

## Limits

This does not provide Live2D browser rendering, full Cubism editor support, or a rendered Native Guest surface inside the Stage Editor. Live2D needs the native model host, so its stage node still states that boundary instead of drawing a placeholder. The native test confirms the saved Spine pose and layer instructions reach the existing Guest renderer, but does not claim physical-device parity or certify every Spine feature.
