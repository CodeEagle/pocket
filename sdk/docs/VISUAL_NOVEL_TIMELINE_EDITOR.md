# Visual novel timeline editor

The shared runtime contract, retained-project review and engine validation are documented in [Visual novel shared timeline](./VISUAL_NOVEL_TIMELINE.md). This note records the Editor-specific reuse and acceptance.

## Retained source review

The retained parent project was inspected at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`. Searches of `lib/core/pocketjs_bundle_runner.dart`, `mini_apps/syslib/pocket_syslib_graphics.js`, `mini_apps/app_game_detail/main.js`, `test/`, and `tests/` found no visual novel tween presets, scene keyframes, or multi-track timeline authoring workflow. The graphics system library contains procedural time-based 3D entity and 2D particle stepping (`compute3dMechaFrame` and `compute2dParticleFrame`); the Flutter bundle runner has a page transition animation state. These behaviors remain in the retained parent and do not define reusable visual novel tracks or serializable scene presets.

The Editor adaptation follows the existing SDK story authoring behavior in `sdk/editor/client/novel.js`: scene controls use the shared `field`, `historyMutation`, draft, save and validation flows. Its existing camera form and regression in `sdk/editor/test/novel_camera_editor_browser.test.ts` establish the scene form, undo/redo and reopen pattern. `sdk/editor/test/novel_instruction_table_browser.test.ts` establishes the Editor `buildGuest` to `NativeSession` acceptance path. The timeline editor keeps one canonical source in `StoryDefinition.timelines` and scene `timeline` references; its selected preset is transient view state only.

## Authoring behavior

The scene form can select a registered preset or clear the active timeline. The Timeline panel edits preset ID, duration, camera keyframes, actor tracks and audio cue events. Its ruler sorts markers by `atMs` and shares the same duration across every row; editing one timestamp updates that marker's position without replacing focused form fields.

Preset creation, rename, deletion, track changes and keyframe changes all use the existing story draft and history. Renaming a preset updates scene references in the same history step. Deletion is disabled while a scene uses that preset. Scene preset references, runtime schema rules and audio catalog references are checked before the Editor reports a buildable story. Timeline schema checks call `novelTimelineStoryIssue` from the SDK runtime bundle; the Editor does not maintain another schema validator. `novel.ts` adds the editor-specific rule that every timeline audio cue must exist in `novel.assets.json.audio`, and rejects that invalid story write with a field path such as `timelines.motion.audio[0].cue`.

The form exposes the camera pose (`x`, `y`, `scale`), actor pose (`position.x`, `position.y`, `scale`, `rotation`), easing, audio cue, action, channel and loop fields. Unsupported and malformed structures remain visible as diagnostics and can be repaired through the structured form. The existing JSON import/export remains available for advanced story data.

Runtime activation checks that every actor target exists in the scene’s effective character set; service schema validation checks preset structure and duplicate actor tracks. Editor audio reference checks establish that cues are registered, not that the native codec or speaker has played them.

## Validation

Service validation covers a valid two-actor preset, an unknown scene preset, duplicate actor IDs, an out-of-range keyframe time and an unregistered timeline audio cue. Invalid timeline structure and timeline audio references are rejected without replacing the last valid story.

The browser acceptance uses the bundled Playwright Chromium, authors a camera track, two actor tracks and an audio event through the Timeline panel, edits a keyframe timestamp, uses undo/redo, assigns the preset in the scene form, saves, reloads and checks the persisted story. It then builds the saved project with the pinned `buildGuest` pipeline and starts the resulting QJBC in `NativeSession`. A real pointer input starts the scene; 24 native frames later both characters have changed draw geometry. The test also captures the authoring screen and guest evidence.

The final joint run executes both the service regressions and browser/native acceptance from `sdk/`, with the accepted tools package supplied by the command environment:

```sh
POCKET_TOOLS_PACKAGE="$PWD/.pocket-build/retina-native-tools-20261108" \
POCKET_NATIVE_PROBE="$PWD/.pocket-build/retina-native-tools-20261108/bin/pocket_probe" \
POCKET_TIMELINE_ARTIFACT_DIR="$PWD/.pocket-build/timeline-20261108" \
npm exec --yes --package=bun@1.4.4 -- bun test editor/test/novel.test.ts editor/test/novel_timeline_editor_browser.test.ts
```

Result: **23 pass, 0 fail** across both files using Bun 1.4.4. The complete final log is `.pocket-build/timeline-20261108/editor-final.log`. Evidence is in `.pocket-build/timeline-20261108/`, including `timeline-editor.png`, the exact built `app.qjbc`/`app.pak`/`app.bytecode.json`, saved `story.json`, `acceptance.json` and `native-frames.json`. The native frame comparison is recorded as Mira `[0, 0, 240, 350]` → `[115, 0, 245, 356]` and Ren `[0, 0, 240, 350]` → `[270, 0, 90, 356]`.

## Subsequent drag acceptance

The later [timeline accessibility increment](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md) adds pointer-captured marker dragging and 10 ms keyboard steps (Shift: 1 ms), transactional cancellation, single-step undo, and shared form synchronization. Its regression includes near-overlapping motion frames, preset changes during a drag and the saved QJBC/native audio/geometry path. The validation above remains the initial authoring checkpoint.
