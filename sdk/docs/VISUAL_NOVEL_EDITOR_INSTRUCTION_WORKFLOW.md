# Visual Novel Editor Instruction Workflow

This note records the E01 instruction workflow acceptance path in the Pocket VN Editor. It covers authoring an instruction through the Editor UI, recovering it with the existing history controls, rebuilding the same project, and executing the result in the pinned Guest.

## Source reuse

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no visual-novel instruction authoring or CRUD/reorder implementation outside its excluded `pocket_host/` tree. The closest reusable behavior is its generic Pocket UI mapping in `lib/render/pocket_ui_components.dart`: `Focusable` dispatches real tap actions (around lines 1410–1517), while the native keyboard component keeps a Flutter `TextField` synchronized with the JS-owned node value (around lines 3507–3618). `test/pocket_38_components_screenshot_test.dart` exercises rendered component interactions and screenshots.

The Editor keeps instruction data and editing state in JS. Add, duplicate, move, delete, undo and redo use the existing `historyMutation`/undo-redo path in `sdk/editor/client/novel.js`; this workflow does not add a parallel history store or mutate the source story outside the Editor UI. The current Editor browser test uses stable instruction IDs to find and verify cards after ordering changes.

## Acceptance path

`sdk/editor/test/novel_authoring_browser.test.ts` drives a temporary Lantern project through Playwright Chromium:

1. Add a `say` instruction using the Editor controls, assign its stable ID and text, and verify the rendered instruction.
2. Copy it, edit the copy, move it, and delete the original. Exercise undo and redo on the deletion, then move the surviving copy into the target position.
3. Add the English translation for the new stable line through the Editor localization controls.
4. Save and reopen. Verify the new instruction order and confirm the existing tour input and surrounding instruction IDs and payloads remain unchanged.
5. Build the temporary project with the pinned high-resolution tool package, then boot the resulting QJBC and PAK in `NativeSession`. Enter the declared feature-tour replay through its title action, use real pointer input to reach the edited line and original tour input, open `textInput`, send a native edit, submit, and verify the interpolated Guest dialogue.

The fixture copies the Lantern project's registered source files and recursively copies `art/`. It runs the existing `scripts/prepare_live2d.ts` against the installed Cubism SDK into the temporary project so model resources are generated for that isolated build; no generated model cache or test output is copied into the Demo source project. The three imported revision map JSON files are copied alongside `app.tsx`.

The NativeSession input acceptance uses a 360×640 frame and explicitly sets the Lantern memory admission limits: heap 134,217,728 bytes and PAK 75,497,472 bytes. This is a test-host surface, not a physical device claim. Its purpose is to execute the built Guest's real input protocol and story flow.

## Model character validation

The Editor's asset diagnostics distinguish model-backed characters from static character images. A visible model-backed character must reference a registered model and a declared animation when one is named; it does not also need an image entry in `assets.characters`. A visible static character still requires its image registry entry. A hidden character used to clear a previous character does not require a static image. Unknown model keys and invalid named animations remain errors.

This distinction is covered by `sdk/editor/test/novel.test.ts` with valid and unknown model keys, a missing visible static character, and a hidden clear placeholder. It fixes a false diagnostic for Lantern's `sample_hiyori`, whose appearance comes from the registered `hiyori_sample` Live2D model rather than a static character image.

## Validation record

The targeted Editor validator suite passed 15 tests with 0 failures (`/tmp/pocket-e01-novel-editor-unit.log`). It covers model-backed and static characters, missing model/static resources, hidden clear placeholders, route checks, and Editor server behavior.

The complete Chromium/Guest run passed **3 tests, 0 failures, 63 assertions** in 25.37 seconds (`/tmp/pocket-e01-novel-authoring-browser-final.log`). It ran with Bun 1.4.4, `POCKET_TOOLS_PACKAGE=sdk/.pocket-build/highres-native-tools-20261107`, and that package's `bin/pocket_probe`. Both the prior structured-story workflow and E01.2 add/edit/copy/reorder/delete→undo/redo→save/reopen→pinned build→NativeSession input/execution passed. The third model authoring test passed. The test-source SHA-256 is `6d51b7c190ed8592752d18665ddd7fbecf9f5300ec4cb6bdfa9414135776e9b1`.

The E01.2 built story SHA-256 is `cba36207322657f388aed21067a6b071bbc23b560f716c74ce7eee23ffff6da9`; QJBC is `865befb0ab40cf5bf5a976a9a145409209091c7b6d2d742401b4ed4da0a6d047`; PAK is `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`. The PAK SHA matches the staged Lantern package, whose file size is **69,193,360 bytes**. The build console's 69,178,016-byte value was the asset payload tally, not the final PAK file size. NativeSession created the probe runtime with the configured 128 MiB heap and 72 MiB PAK limit; the 69,193,360-byte PAK loaded and executed below that limit.

The browser fixture lives under a temporary project root. The Editor test does not stage or modify the Demo Guest. Previous failures were fixture/driver issues and are retained only as debugging history: the fixture initially omitted imported revision-map JSON files, and later pointer steps missed the title replay entry or failed to advance through the preserved `tour_05` line. Those runs are not counted as acceptance.
