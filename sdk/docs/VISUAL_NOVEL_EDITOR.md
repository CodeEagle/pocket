# Pocket visual novel editor

This document describes the first integrated authoring surface for the Pocket VN core. The editor writes the project's canonical `story.json` and `novel.assets.json`; Guest build and native play continue through Pocket's pinned compiler, baker, runtime and Flutter host.

## Source-first integration

The retained parent project at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected before implementation, excluding `pocket_host/` as required. Its reusable behavior is documented in [VISUAL_NOVEL_RESEARCH.md](./VISUAL_NOVEL_RESEARCH.md): app navigation and screen composition from `mini_apps/app_nav/main.js` and `mini_apps/app_ui_showcase/main.js`, UI conventions from `mini_apps/app_game_detail/main.js`, and JS-to-host boundary practices from `mini_apps/syslib/pocket_syslib_flutter_ui.js`. `mini_apps/syslib/pocket_syslib_router.js` preserves route-stack navigation and page transitions, while `mini_apps/app_nav/main.js` calls `Host.navigateTo` with named destinations. Neither file contains a VN story graph editor or editable story connections. The Editor adapts the retained navigation concepts to the canonical `story.json` labels and instruction targets; it keeps one script as the source of truth and uses the same Pocket VN engine as play.

## Data and routes

The selected project's root is supplied by the trusted Editor server. The route handler is `handleNovelRoute(request, { projectRoot, projectId })` in `sdk/editor/novel.ts`. A request never supplies a filesystem path.

| Route | Behavior |
| --- | --- |
| `GET /novel?project=<id>` | Opens the story editor for the already selected project. |
| `GET /novel.js`, `GET /novel.css` | Serves the editor client and styles. |
| `GET /novel-localization.js`, `GET /novel-localization.css` | Serves the separate locale-catalog panel loaded on demand by the main editor. |
| `GET /preview.js` | Reuses the Editor's existing `PocketEditorPreview.projectTriangle` implementation for model mesh projection. |
| `GET /novel/resource?project=<id>&kind=background&key=<key>` | Reads an image only after looking up its exact key in the canonical registry. `kind=character` additionally accepts an expression; `kind=cg` selects a CG image. No path is accepted from the request. |
| `GET /api/projects/:id/novel/models/source?key=<model>` | Resolves only a registered Spine model key, reads its canonical skeleton and atlas with size/symlink checks, and returns metadata from the official Spine parser. |
| `GET /api/projects/:id/novel/models/resource?key=<model>&page=<atlas-page>` | Reads a texture only through the exact model/page mapping in `novel.assets.json`. Request paths are never accepted. |
| `GET /api/projects/:id/novel/story` | Reads `story.json` and returns schema, label reference, graph, variable and registered-asset diagnostics. |
| `PUT /api/projects/:id/novel/story` | Atomically replaces the fixed `story.json` file after schema validation. Semantic reference errors remain visible so an author can repair an incomplete draft. |
| `GET /api/projects/:id/novel/assets` | Reads `novel.assets.json`, or returns empty maps for a project that has not created it. Reports unsafe and missing project assets. |
| `PUT /api/projects/:id/novel/assets` | Atomically replaces the fixed asset registry after schema and path-safety checks. Missing files remain diagnosable and editable. |
| `GET /api/projects/:id/novel/locales` | Reads the canonical `novel.locales.json` collection, or returns an empty collection, plus current UI defaults and diagnostics. |
| `PUT /api/projects/:id/novel/locales` | Atomically replaces the fixed locale collection after schema and size checks. Locale catalogs remain separate from `story.json`. |
| `POST /api/projects/:id/novel/locales/diagnostics` | Checks a locale against the submitted draft story/assets and locale collection, or the saved files when no draft is supplied. |
| `GET /api/projects/:id/novel/diagnostics` | Recomputes story and asset diagnostics from saved files. |
| `GET /api/projects/:id/novel/export` | Downloads the saved `story.json`. The assets panel can import/export its exact registry JSON. |
| `GET /api/projects/:id/novel/runtime.js` | Bundles the SDK's `createNovelEngine` with the pinned local Bun toolchain for browser preview. |
| `GET /api/projects/:id/novel/spine.js` | Bundles the same `createNovelSpineFactory` and official `@esotericsoftware/spine-core` used by the Pocket runtime. |

Story, asset and locale writes use a same-directory temporary file, `O_NOFOLLOW`, file sync and atomic rename. The handler rejects symbolic links for the project root, canonical JSON files and registered media. The outer Editor server owns project write reservations, busy checks, CSRF checks, revision increments and build invalidation.

## Editing and validation

Scenes can declare independent `objects` using existing background registry
keys. The scene form edits the canonical JSON array, with explicit inherit and
clear actions; the stage paints crop/clip/layers and allows object selection,
position dragging, image/layer edits and removal in the existing inspector.
Optional `aspectRatio` contains a visible frame inside its authored layout box;
dragging commits the layout-box origin with normalized precision. Story history,
save/reopen, diagnostics and the pinned Guest build share that same declaration.
Live preview uses `interactSceneObject` on the running SDK engine, including its
conditions and transaction rules, and preserves actual object source facts
when only a future preview root is selected. Server diagnostics remain source
facts updated by read/save/build responses; rendering a locally merged draft
validation never writes that derived result back. Restoring a valid object
image/crop/condition/effect declaration clears its draft diagnostic and build
gate. Actual preview and invalid-draft recovery have a dedicated Browser test. See
[scene-object scope and acceptance](VISUAL_NOVEL_SCENE_OBJECTS.md).


The story panel edits the `StoryDefinition` instruction union as typed controls. It supports all current core instructions (`say`, `scene`, `audio`, `wait`, `set`, `inc`, `branch`, `jump`, `call`, `return`, `choice`, and `ending`), nested conditions and values, stable IDs, label creation/renaming/deletion, start label selection, instruction and choice reordering, duplicate/delete, and moving instructions across labels. The optional `say.voice` selector uses cue keys from the audio registry; clearing it removes the property instead of writing an empty string. The story map edits the canonical `story.start` value and the existing `jump.target`, `call.target`, `branch.then`/`else`, choice-option targets and timeout target directly on their label cards. Every map edit uses the same bounded story `historyMutation`; undo/redo, diagnostics, save/reopen and Guest build therefore observe the same `story.json` data. The map is an editable connection list on the existing label nodes, not a freeform drag-layout canvas. `set.value` is a JSON value; only condition operands use `ValueExpression`. Text and identifiers are assigned with DOM `textContent` and form fields; imported JSON is parsed as data and never evaluated.

Undo and redo are available for story and asset changes through buttons and `⌘/Ctrl+Z`, `⌘/Ctrl+Shift+Z` or `⌘/Ctrl+Y`. Consecutive keystrokes in the same field form one action until focus leaves it. Structural operations each form their own action. The Editor retains at most 32 in-memory operations; undoing and redoing marks the canonical file dirty so the author explicitly saves the restored data. History is not serialized into the project and does not create a second source of truth.

The asset panel edits the same canonical registry consumed by the app and `buildGuest`:

```json
{
  "backgrounds": { "station": "art/station.png" },
  "characters": { "mira": { "neutral": "art/mira.png" } },
  "cgs": { "memory": { "image": "art/memory.png", "title": "A memory" } },
  "audio": { "theme": "audio/theme.wav" },
  "models": {
    "mira": {
      "kind": "spine",
      "source": "models/mira.spine.json",
      "atlas": "models/mira.atlas",
      "textures": { "mira.png": "art/mira.png" },
      "animations": ["idle", "alert"]
    }
  }
}
```

Background, character and CG paths are project-relative PNG/SVG files. Audio values are loose resource keys resolved from `projectRoot/assets/`, and this version requires WAV keys under `audio/`. Current Guest build validates and bakes every referenced registry image using the existing pinned pipeline; the editor does not synthesize missing image content or accept an empty-image placeholder. Audio cue facts can be inspected in preview, but browser preview deliberately does not claim that an audio cue played.

The localization tab is loaded from `novel-localization.js` and owns a separate `novel.locales.json` document. Its mount contract receives `projectId`, the project API base, an `api` helper, and read-only structured snapshots from `getStory()` / `getAssets()`. Translation changes never mutate `story.json` or enter story undo history; diagnostics can compare catalog entries against unsaved story and asset edits. The main editor disposes the mounted panel when replacing its root subtree, so its timers and global listeners do not survive navigation.

Diagnostics cover invalid instruction schemas, missing labels, duplicate stable IDs, unreachable labels, reachable cycles, read variables with no writer, unreachable endings, invalid/symlinked/missing asset files, unknown background/character/expression/audio/CG keys and missing media references. Cycles and unreachable labels are author warnings/information; dangling references, malformed instructions and unavailable assets block build. A saved incomplete draft remains editable so references can be corrected in later steps.

Model entries support `spine` (`.json` or `.skel` plus `.atlas`) and `live2d` (`.model3.json`). Spine pages are parsed by the pinned official Spine 4.3 atlas reader; the editor lists page names, PMA status, animation names, skins and unsupported draw items. Authors can add/remove/rename model entries, edit skeleton/atlas paths, map each atlas page to a project PNG/SVG, edit the animation allow-list and edit story model intents. Renaming or deleting a model updates matching scene intents in `story.json` in the same undoable project action. The server confines model files to safe project-relative paths, rejects symbolic links and non-regular files, caps skeleton/atlas sizes, and serves page textures only through the saved registry key. Inspection and preview read canonical files, so save model source or mapping changes before loading them.

The Spine inspector loads `createNovelSpineFactory` from `/spine.js`, the same factory used by the game. Each preview frame advances the official Spine rig, decodes its PMS1 positions/UVs/indices, and calls `PocketEditorPreview.projectTriangle` from the existing `preview.js`; there is no second skeleton parser or Canvas texture mapper. This is a browser visualization of the same canonical mesh operation the Guest consumes. Unsupported attachment/blend/two-color items and PMA atlas pages are surfaced as errors; a blank or static substitute is never shown as a successful model preview. Live2D model intents and canonical assets are editable, and Guest playback uses its native model host, but this browser editor has no native host and therefore cannot offer a Live2D frame preview. Story intents can select animation, loop, and Spine skin; the separate Live2D expression field is not aliased to Spine skin.

## Same-core preview and debug controls

The browser imports the bundle from `/runtime.js` and calls the real `createNovelEngine(state.story)`. There is no second interpreter. The preview uses the same immutable snapshots, branch evaluation, variables, stage state, transitions, audio intents and debug API as the game. Registered background/character/CG images are loaded through the registry-only route.

Pause, resume, step, breakpoints and validated label/instruction jumps call `engine.debug`. Variable inspection is read-only and comes from `getSnapshot().variables`. The preview's `requestAnimationFrame` driver calls `engine.tick(deltaMs)` only while the same engine reports a timed or animated state that needs time: text reveal, auto/skip delay, wait, timed choice or scene transition. It clamps long frame gaps and stops while paused or waiting for player input; no idle timer runs continuously. Core audio intent is displayed as a request fact, not browser playback.

## Executable chapter blueprint nodes

The graph toolbar's “＋ 蓝图节点” creates entry, chapter reference, condition,
choice, assignment and ending nodes through the shared `addNovelBlueprintNode`.
It writes ordinary script instructions; `editor.blueprint` stores only role/title
annotations, and route controls retain one source of truth. Start remains an
explicit author action. Chapter bodies retain their original contents and return
through the existing call stack. Creation, history, rename/delete metadata,
save/reopen and pinned native Guest routes are accepted; code-expression nodes,
extension strategies, preprocessing, groups and a visual expression builder are
still absent. See [scope and evidence](VISUAL_NOVEL_CHAPTER_BLUEPRINT.md).

## Current acceptance status

| Area | Status |
| --- | --- |
| Structured `StoryDefinition` editing and all current instruction types | Implemented in the editor client. |
| Typed player input | Text/number/boolean inspector, optional defaults and bounds, cancel map edges, stable IDs and locale prompt/placeholder editing share the runtime schema. |
| Labels, stable IDs, instruction/choice order, add/delete/move | Implemented. |
| Story map start and connection editing | Implemented for jump, call, branch then/else, choice options and timeout routes. Edits use the canonical story and shared undo/redo history. |
| Free label-node canvas | Drag, SVG route ports, pan/zoom and label locating use the same story/history. Layout save/reopen and pinned Guest interaction passed; see [canvas evidence](VISUAL_NOVEL_GRAPH_CANVAS.md). Chapter blueprints remain pending. |
| Bounded story/assets undo and redo | Implemented with 32 in-memory operations and field-level typing groups; save writes the canonical documents. |
| JSON story import/export and atomic project save | Implemented. |
| Canonical background, character/expression, CG and WAV-key registry editing | Implemented. |
| Optional voice cue on dialogue | Implemented from registered audio cue keys; clearing omits the optional `voice` field. |
| Locale catalogs and translation diagnostics | Implemented in a separate on-demand panel and canonical `novel.locales.json`; the story and asset inputs are read-only snapshots. |
| Canonical Spine/Live2D model registry CRUD, page texture mapping and diagnostics | Implemented; Live2D editor preview is unavailable because this browser surface has no native model host. |
| Official Spine metadata inspection and animated textured mesh preview | Implemented with `@esotericsoftware/spine-core` 4.3 and the existing TEX_TRI browser projection helper. PMA and unsupported Spine features fail visibly. |
| Label reference, graph reachability/cycle and registered asset diagnostics | Implemented; details remain visible while correcting drafts. |
| Same-core play, pause/resume, timed tick, step, breakpoint, jump and read-only variables | Implemented against `createNovelEngine` and `engine.debug`. |
| Real Guest bytecode build and native run | The editor offers the existing Guest build route after saving; native launch remains the existing Demo run flow. The route/editor test does not substitute for the pinned Guest/native integration acceptance. |
| Variable watch editing, rollback UI, save-slot editing, screen-reader/accessibility audit, packaging wizard, audio playback in preview | Not yet in this editor. The research and capability matrix tracks these as follow-up acceptance; they are not claimed as complete. |

## Validation

Focused editor route tests are in `sdk/editor/test/novel.test.ts`; official Spine adapter tests are in `sdk/packages/pocket_spine/test/rig.test.ts`. The route suite includes atomic locale-file and symlink checks. `sdk/editor/test/novel_graph_browser.test.ts` edits every supported map connection, checks undo/redo, saves and reloads the story, verifies optional voice cue selection/omission, and opens the on-demand localization panel. The Playwright Chromium acceptance in `sdk/editor/test/novel_authoring_browser.test.ts` additionally changes the start and a jump target on the map, saves/reopens, builds with the pinned current tools and probe, then follows the changed route using native canvas pointer input. Run the focused checks from `sdk/`:

```sh
bun test editor/test/novel.test.ts editor/test/novel_history.test.ts editor/test/novel_graph_browser.test.ts
bun test packages/pocket_spine/test/rig.test.ts
POCKET_TOOLS_PACKAGE=/path/to/current-native-tools POCKET_NATIVE_PROBE=/path/to/current-native-tools/bin/pocket_probe bun test editor/test/novel_authoring_browser.test.ts --test-name-pattern 'author edits and persists'
bun test editor/test/novel_authoring_browser.test.ts --test-name-pattern 'model assets load official Spine data'
```

The edited-route browser acceptance passed against `current-native-tools` and its matching `pocket_probe`; the graph browser test covers branch/call/choice/timeout targets, history, voice cue omission and localization panel mount. The locale backend route tests cover atomic writes and symlink rejection; the edited-route acceptance does not exercise translation import/export. See [VISUAL_NOVEL_RESEARCH.md](./VISUAL_NOVEL_RESEARCH.md) for the broader engine comparison and full editor/game capability matrix.

The localization tab now edits the single `novel.locales.json` collection, imports/exports catalogs, navigates missing stable fields, validates placeholders and resolves registered asset overrides. It uses the same project revision hook; draft diagnostics do not change revisions. See [localization acceptance](VISUAL_NOVEL_LOCALIZATION.md).

## Text and stage authoring

The text and block views edit the same story through the existing history and
validator. Unapplied text drafts survive tab changes in memory; a baseline
conflict prevents silently overwriting block edits. Import/export uses the
lossless Pocket VN text format. See [authoring](VISUAL_NOVEL_AUTHORING.md).

The stage tab edits the selected scene's character position, uniform scale,
rotation and layer. Shared SDK placement helpers keep the browser image quad
and native transform origin consistent. One drag is one undo operation.
Scene context is derived by the real core; unreachable paths are reported.
Dynamic model pose preview and camera/timeline authoring remain separate
capabilities. See [stage authoring](VISUAL_NOVEL_STAGE_AUTHORING.md) and
[scene transform evidence](VISUAL_NOVEL_SCENE_TRANSFORMS.md).

All three auxiliary panels share one module lifecycle. The browser runtime
bundles `editor-runtime.ts`, which re-exports the existing engine plus the same
scene and authoring helpers without importing a native provider or UI runtime.

## Context reconstruction and visible-source navigation

The debug panel distinguishes “跳到指令” (a raw jump retaining the existing
stage and variables) from “从故事开始重建上下文”. The latter uses the shared
`createNovelContextPreview` / `continueNovelContextPreview` SDK helpers with
ordinary canonical engine execution. It stops at actual unresolved choices and
inputs; authors answer those before continuing. Explicit waits advance virtual
time. Work is sliced at 256 prior dialogue/wait passages by default, while the
existing engine budget bounds immediate OP transactions.

Pending context previews suppress the Editor clock, including timed choices.
Choice/input engines remain canonically unpaused so their real interaction APIs
work. The ordinary preview clock follows active camera motion and timeline state
as well as dialogue, choices, waits and transitions; a settled or paused stage
must stop scheduling frames.

Visible dialogue and endings locate their active source address. Background,
layer and character buttons identify their configuration source from committed
scene operations on the current route. A small current-composition map retains
those facts beyond the displayed 200-row trace; it does not retain another
engine state. Raw jumps, restart and draft changes invalidate unknown provenance.
Clearing the displayed trace alone does not change the scene's source facts.

The main-story workflow and its evidence are maintained in
[context-preview validation](VISUAL_NOVEL_CONTEXT_PREVIEW.md). The subsequent
[independent-entry increment](VISUAL_NOVEL_CONTEXT_ENTRY.md) covers declared replay
and canonical chapter root selection, with fresh state and original addresses.
Full animated-state/native-model provenance remains open; each increment records
its own actual acceptance status.

## Player input authoring

The input block edits `id`, `variable`, `inputType`, prompt, placeholder,
optional default and cancellation label in the canonical story. Text lengths
count Unicode code points; numeric bounds and integer validation belong to the
same core helper used by the engine and backend. Changing input type removes
the previous type's constraints and default; boolean input omits placeholder.
Clearing an optional default removes it. Unknown author metadata survives edits.

Input cancellation is an optional map edge. Label renaming updates that edge,
and copies receive unique stable IDs even when the original is copied twice.
The localization panel edits `inputs[id].prompt/placeholder` in the same locale
collection. It does not translate variable names, constraints or targets.

The debug preview calls `updateInput`, `submitInput` and `cancelInput` on the
real engine. It retains the actual DOM field through snapshot notifications,
so typing does not rebuild the field or discard a composition. It has no
second draft store, and controls are disabled while the engine is paused.

`editor/test/novel_input_browser.test.ts` verifies Chromium authoring,
type switching, repeated copy IDs, undo, optional cancel map edges, save/reopen,
translations, invalid numeric submission and stable DOM field identity. It then
builds the saved project with pinned `buildGuest`, opens its real native input
by pointer, sends the native edit protocol and commits the number into the
rendered ending. The focused run passed in 5.62 seconds
(`/tmp/pocket-input-editor-browser.log`). That protocol test does not by itself
prove a Flutter TextInputClient or a physical IME; see
[host input acceptance](VISUAL_NOVEL_INPUT_ACCEPTANCE.md).

The strengthened focused test also rejects a 129-character numeric paste,
checks that its native session closes, reopens the canonical draft and rejects
an edit from the stale session before committing `714`. It passed in 7.36
seconds (`/tmp/pocket-input-editor-cap-browser.log`).

## Browser acceptance runtime

### Per-speaker text sound profiles

The asset panel edits optional `novel.assets.json.textSounds`: a default audio
cue, exact speaker-to-cue overrides and a 40–1000 ms integer minimum interval.
Clearing a speaker override uses the default; clearing the default disables
unmatched speakers. Author configuration does not enable the player's optional
text sounds. Profiles use the same pure schema and registered-cue validation
as the runtime adapter, with no editor-only profile document.

Real Chromium added a profile, edited the interval and Ren override, undid a
removal, saved and reopened it. The service rejected an unknown cue and a 39 ms
interval without changing the registry. The saved project built through pinned
buildGuest; actual native start input and text progress requested the selected
speaker asset with effects gain through the bounded four-channel pool. The test
passed in 3.69 seconds (`/tmp/pocket-a04-editor-browser.log`). Its WAV fixture is
the deterministic 45 ms narrator sample from Lantern's existing audio generator.
This is native-request evidence; real decoding and lifecycle require the
separate Flutter text-sound acceptance.

### Structured CSV and Markdown interchange

The existing story import control accepts JSON, `.csv`, `.md` and `.markdown`.
The export format selector downloads JSON, Pocket VN CSV or Pocket VN Markdown
from the current draft. CSV and Markdown use the shared interchange parser and
formatter exported by the same browser runtime; no second story document is
stored. Imports replace the editor draft only after successful parsing, enter
the existing undo history, and require explicit Save before writing story.json.
Files over 8 MiB are rejected before reading their contents.

CSV stores canonical instruction JSON in quoted payload cells; Markdown stores
canonical metadata and label blocks. These are lossless structured exchange
formats, not spreadsheet-oriented dialogue columns or Word documents. Newlines,
quotes, empty labels, variable declarations and custom metadata survive.

Real Chromium exported CSV, changed a line in its payload, imported/saved it,
then repeated that path for Markdown. A malformed CSV left both the current
draft and saved source intact. The reopened document built through pinned
buildGuest, and real native pointer input painted the edited line. The focused
test passed in 2.58 seconds (`/tmp/pocket-interchange-editor-browser.log`). See
[format contract](VISUAL_NOVEL_INTERCHANGE.md). A later full combination must
revalidate this alongside other subsequent source changes.

The strengthened run passed in 3.40 seconds with all four codec operations
executed inside the actual QuickJS Guest before engine creation. This caught
and removed a Web `TextEncoder` dependency unsupported by that runtime. It also
corrected a previously invalid replay target through CSV import, verified that
old server diagnostics disappeared, and rejected malformed JSON instruction
arrays before replacing the live draft. Unicode UTF-8 size accounting now
follows the existing JS SDK code-point counting precedent without an encoder
or IO bridge.

### Variable declarations and complete source backups

The variable declarations tab edits `story.json.variableDefinitions` directly:
add/remove declarations, select save/session/persistent lifetime, and set/remove
JSON defaults. Undo/redo retains unknown author metadata. The server validates
the same schema through the core `novelVariableDefinitionsIssue` helper. Real
Chromium save/reopen and execution through the bundled shared engine verified
that a submitted persistent value survives `newGame()`
(`/tmp/pocket-variables-editor-browser.log`). See
[variable lifetimes](VISUAL_NOVEL_VARIABLE_LIFETIMES.md).

The project backup tab creates and restores complete saved source/asset trees
outside the project. Restore creates a recovery checkpoint, increments the
existing Editor revision and requires a fresh Guest build; the page reloads to
discard stale in-memory editor documents. Unsaved story/assets and unapplied
text drafts block manual create/restore. A persisted 1/5/10/30/60-minute policy
runs in the existing server, using the same project-write reservation as edits,
builds and AI work; busy projects retry after 30 seconds. Opening a project
after a service restart resumes its timer; stopping the server clears timers.
Unchanged automatic checkpoints reuse a verified prior snapshot.

The Chromium acceptance rejected an unsaved draft backup, restored story and binary model bytes, removed a new
custom source, verified the recovery copy and revision, restarted the service,
then waited a real minute and verified a new custom file in the automatic
snapshot. It passed in 61.58 seconds
(`/tmp/pocket-backup-editor-browser.log`). Service tests additionally reject
corrupt payloads, traversal and symlinks before changing source. See
[source backups](VISUAL_NOVEL_BACKUPS.md). These local snapshots do not provide
cloud backup or multi-user collaboration.

Run browser combinations through `npm run test:editor`, whose test executor is
fixed to Bun 1.4.4. npm caches the official runtime on first use; this does not
change the production Bun 1.3.9 dependency, pinned PocketJS compiler/engine or
Guest ABI. A focused equivalent from `sdk/` is:

```sh
POCKET_TOOLS_PACKAGE=/path/to/current-native-tools \
POCKET_NATIVE_PROBE=/path/to/current-native-tools/bin/pocket_probe \
npm exec --yes --package=bun@1.4.4 -- bun test --max-concurrency=1 \
  editor/test/novel_localization_browser.test.ts \
  editor/test/novel_graph_browser.test.ts \
  editor/test/novel_stage_browser.test.ts \
  editor/test/novel_text_browser.test.ts \
  editor/test/novel_input_browser.test.ts \
  editor/test/novel_authoring_browser.test.ts
```

The five-file run passed all 6 tests and 50 assertions in 30.64 seconds
(`/tmp/pocket-vn-editor-final-bun-1.4.4-serial.log`). It includes both saved
stage geometry and edited-story progression through actual compiled Guest
pointer input. The test observer retains at most 16 native frames, and failure
diagnostics use bounded page/status requests rather than unbounded waits.

After adding player input, the six-file combination passed all 7 tests in
26.93 seconds (`/tmp/pocket-input-editor-all-browser.log`), including the
saved input Guest's genuine native edit and typed submission. The compiler and
runtime pins remain unchanged.

After adding variable declarations, the seven-file combination passed all 8
tests and 50 assertions in 33.84 seconds
(`/tmp/pocket-f04-editor-browser.log`). The focused variable declaration test
also checks valid prototype-like variable names without altering object
prototypes (`/tmp/pocket-variables-editor-browser.log`).

After adding replay declarations, structured CSV/Markdown interchange,
per-speaker text cue profiles and full project backups, the twelve-file
combination passed all 13 tests in 111.62 seconds
(`/tmp/pocket-a04-editor-all-browser.log`). This includes the real one-minute
backup scheduler after server restart, disk restore with recovery snapshot,
and edited CSV/Markdown and speaker profiles compiled into QJBC and exercised
with native pointer input. Replay here covers the Editor/core factory; player
gallery and native music audition remain separate acceptance work.

After persisting the existing undo/redo stacks and current draft in the Editor
workspace, the thirteen-file combination passed all 14 tests in 122.78 seconds
(`/tmp/pocket-v2-editor-all-browser.log`). It covers server restart, saved and
unsaved undo/redo heads, unparseable Pocket VN text drafts, identical-source
backup restore invalidation, direct external source changes and rejection of
an older window's journal write. It also interrupts an assets write after a
successful story write, reopens the remaining asset draft and saves it without
a false history conflict. Recovery does not implicitly write project source.
The existing browser actions wait for the visible undo/redo context
check via `aria-busy`; there are no fixed delays pretending to prove an edit.

The history uses the same 32-entry stacks, with a 16 MiB total bound; older
steps are dropped with a notice when that byte bound is reached. Story/asset
content hashes and a backup-restore epoch protect the recovery context, while
a journal revision prevents older tabs overwriting newer history. It covers
the two editable JSON documents and raw authoring text, rather than binary
resource contents. Full source/asset recovery remains the project backup
workflow. See [persistent draft and history](VISUAL_NOVEL_HISTORY.md).

The same suite under the installed Bun 1.3.9 intermittently lost Chromium or
hung after successful Guest compilation. Official Bun reports describe
extra-pipe descriptor lifetime bugs with matching Playwright symptoms in
[issue 47956](https://github.com/oven-sh/bun/issues/47956) and a fix in
[issue 47561](https://github.com/oven-sh/bun/issues/47561). Those reports cover
Linux and later 1.3.x versions; they do not establish the exact cause on this
macOS/1.3.9 host. A single-browser synchronous-child experiment remained
connected, while the complete suite passed with the newer parent test runtime.
No compiler or editor business logic was changed based on that inference.
