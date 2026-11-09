# Visual novel registry diagnostics

## Source-first findings

The retained parent project at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no reusable visual-novel story or asset-registry validator outside the excluded `pocket_host/` directory. The inspected parent sources (`mini_apps/app_game_detail/main.js`, `mini_apps/app_ui_showcase/main.js`, `lib/main.dart`, and `lib/render/pocket_ui_components.dart`) are generic mini-app, host, and component examples. They do not define stable VN asset keys or report story-resource references, so this work adapts the current Pocket VN registry contract instead of migrating a second validator.

## Shared checks

`packages/pocket_vn/src/asset-references.ts` is the single pure StoryDefinition-to-registry reference check. The public SDK entry and browser editor runtime export it. It does not inspect disk paths or decide which optional resources a story must contain.

The Editor uses that helper for cross-document references and keeps `validateAssetRegistry()` responsible for registry shape, safe project paths, file existence, symlink rejection, and field locations. The pinned `buildGuest()` path uses the same helper only when the project declares `@pocket/vn`. Existing image and model file checks remain at their prior build boundaries (`novelImageLiterals()` and `novelModelSources()`); no directory-wide asset inclusion was added.

The diagnostic `location.field` is the concrete field inside the source instruction or registry document. Story instruction locations also include `label` and `index`. The checks cover:

- Scene background keys, background-layer keys, scene-object image keys, static character keys, requested expressions, model keys, and explicitly requested model animations.
- Dialogue `say.voice` and authored audio cue keys against `assets.audio`; play-video cues against `assets.videos`; ending CG keys against `assets.cgs`; and timeline audio cues against `assets.audio`.
- Choice-surface story choice and option coverage, and atmosphere background keys.
- Registered image/audio/video/model paths through Editor path diagnostics, including Spine source/atlas/texture and Live2D source/texture fields.
- Branch, choice-option, and scene-object interaction conditions through the existing SDK `novelConditionIssue()` validator, with locations such as `when`, `options[0].when`, and `objects[0].interaction.when`.

Optional semantics remain intact: omitted or `null` backgrounds do not require assets; hidden static characters do not require a character image; a model-backed actor does not need a static character image; an expression can fall back to a registered `neutral` image; model animations are checked only when the model declares an animation list; and non-play video commands have no cue reference. A line's historical `say.portrait` string remains plain metadata. Live2D preview support remains a warning, not a story-reference error.

## Save and build boundaries

Malformed story conditions are structural errors, so `PUT /story` returns 422 with the field-level diagnostic and leaves `story.json` and durable history untouched. An unsafe registry path is rejected atomically. A registry entry that uses a safe path to a file that is not present stays editable: the existing workflow returns `assets.missing` at its precise registry field and permits authors to correct the path or add the file.

Dangling story-to-registry references remain visible diagnostics in the Editor while authors work. BuildGuest rejects unresolved references in declared VN projects before compiling or writing Guest artifacts. Story and registry saves are not turned into a blanket gate for every incomplete reference.

`editor/test/novel_registry_diagnostics.test.ts` exercises field locations, valid-reference controls, unsafe-path atomicity, editable missing-file behavior, precise condition diagnostics, rejected story writes, and unchanged history. `scripts/tests/build_guest_registry_references.test.ts` calls the real `buildGuest()` function and verifies that missing voice/background keys and malformed conditions fail before a Guest bytecode or manifest is emitted.

## Ablation

The earlier split had an Editor-only `storyAssetDiagnostics()` walk and a separate build-time check for scene-object images. The shared helper now owns the story-to-registry walk for Editor and declared VN builds. Disk validation remains at the existing IO boundaries, and non-VN builds do not acquire new VN reference rules.
