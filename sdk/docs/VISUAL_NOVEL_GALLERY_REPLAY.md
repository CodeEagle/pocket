# Pocket VN music and story replay core

The retained parent demo has a generic `Gallery` component at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:1774` that renders a horizontal row of labels/icons. It does not connect gallery items to VN progress, registered music, or a story replay runtime. In Pocket VN, the existing gallery already uses `meta.cgIds` and CGs registered in `NovelAssets`; the story engine and audio adapter already use cue-keyed `audioIntents`, but there was no music unlock metadata or isolated story replay entrypoint.

This change reuses the current `StoryDefinition`, `NovelMetaState`, `createNovelEngine`, its validator, and audio cue keys. It adds no second interpreter, music asset map, or live-engine snapshot mutation path.

## Music unlock metadata

`NovelMetaState.musicIds` records a cue requested by an executed story music instruction. The engine adds a cue only when it executes an `audio` instruction whose action is `play` (the default) and whose explicit channel is `music`. A stop, an unchanneled one-shot, or another channel does not unlock it. This uses the same string key already looked up by the audio adapter, so the gallery can intersect `meta.musicIds` with the consumer's existing audio registry. The engine records the story request; the JS audio adapter remains responsible for real host playback and can report when the host cannot play it.

Music IDs are meta progress: saves serialize them, loads union them with current progress, and rollback and `newGame()` retain them. Legacy metadata without the field is read as an empty list.

The core identifies which cue has been heard. The player view and its audio owner still own the gallery controls and preview playback, including stopping/restoring playback when the preview closes.

## Replay entries

Stories declare stable replay entrypoints in the same root `story.json`:

```json
{
  "id": "memory",
  "title": "The memory",
  "location": { "label": "memory", "index": 0 },
  "unlockEndingId": "proof"
}
```

`replayEntries` is an optional array on `StoryDefinition`. IDs and titles must be non-empty; IDs are unique within the array. The location must point to a real instruction. An optional `unlockEndingId` must refer to an ending in this story; the entry is unavailable until that ending ID appears in the source snapshot's `meta.endingIds`. The exported `novelReplayEntriesIssue(value, script?)` helper shares these checks with the Editor. Unknown author metadata is preserved.

Each replay location starts at its own authored scene setup. The engine does not guess historical stage state from a CG or from the live stage. For example, the replay label can begin with a `scene` instruction before its first dialogue line.

`createNovelReplayEngine(story, sourceSnapshot, entryId)` returns a regular `NovelEngine` at that replay entry. It seeds variables, meta, and preferences from the supplied snapshot through the normal engine constructor, which copies and validates the data. It starts in manual mode so an existing auto/skip preference cannot immediately run past the replay's first line; text speed and other preferences remain copied. The replay engine can update its own variables, endings, CG IDs, and music IDs, but it has no reference to the live engine or its storage. The owner disposes it when the replay closes and does not persist its save as the main story.

## Source-first reuse and validation

The parent `<Gallery>` was a visual carousel only, with no retained VN unlock/replay behavior. Pocket VN keeps the existing CG gallery and extends the existing meta union pattern rather than adding a gallery-owned unlock map. Replay uses the same validated Pocket VN instruction loop, addressing, transaction system, and audio intents in a fresh engine instance.

The core regression tests verify music unlock conditions, save/load/rollback/new-game meta behavior, replay entry schema validation and text round-trip, ending gates, stage setup, typed variable writes, replay-local ending/CG/music unlocks, and that the live snapshot and save remain unchanged.

## Editor authoring validation

The Editor adds a `鉴赏回放` story-authoring tab for replay entry IDs, titles, instruction locations, and optional ending gates. It edits the same `StoryDefinition.replayEntries` data and calls the shared `novelReplayEntriesIssue` validation used by Pocket VN. Renaming a label also updates replay entry locations that pointed at it. Existing unknown author metadata stays on the story and replay entry objects.

The browser regression test exercises the real Editor page, including add/remove, undo/redo, label rename, save/reopen, and preservation of unrelated metadata. It submits an invalid label and an unknown ending gate directly to the Editor story route, then checks both return HTTP 422 without changing `story.json`. It fetches the Editor's bundled shared runtime and runs `createNovelReplayEngine`: the gate is locked before the source reaches the ending, then replay starts at its own scene, receives copied variables, changes only its local variable/meta state, and leaves the source snapshot and save unchanged.

From `sdk/`, the pinned Playwright Chromium runner passed:

```sh
./.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test editor/test/novel_replay_browser.test.ts
```

Result: **1 test passed, 0 failed**. This validates Editor authoring and the shared replay runtime; the Lantern NativeSession and Flutter integration below cover the consumer player flow and native music players.

From `sdk/`, `bun test packages/pocket_vn/test` passed **71 tests, 0 failures, 507 assertions**. Strict TypeScript validation passed with:

```sh
node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --jsx preserve packages/pocket_vn/src/types.ts packages/pocket_vn/src/input.ts packages/pocket_vn/src/variables.ts packages/pocket_vn/src/replay-schema.ts packages/pocket_vn/src/replay.ts packages/pocket_vn/src/engine.ts packages/pocket_vn/src/authoring.ts packages/pocket_vn/src/interchange.ts packages/pocket_vn/src/editor-runtime.ts packages/pocket_vn/src/index.ts
```

## Source-first player integration

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocketjs_super_app_demo.html` uses `playSynthTone` near lines 923–952 for short menu/game feedback. That is Web Audio UI feedback; it has no story-entry registry, ending unlock state, isolated replay engine, or music preview transport. The parent `lib/render/pocket_ui_components.dart` `<Gallery>` around line 1774 is a visual carousel for labels and icons. The F08 integration reuses that gallery idea for collectibles and adds the missing narrative behavior through Pocket VN's existing `NovelView`, engine snapshots, asset registry, and audio adapter. It does not migrate or invoke the parent's Web Audio tone helper.

Lantern declares three replay entries at the first instruction of each existing ending scene. `truth_ending_replay` unlocks after `truth_letter`; `train_ending_replay` unlocks after `last_train`; `shelter_ending_replay` unlocks after `keep_the_light`. The English titles use `novel.locales.json`'s stable-ID `replays` map. `localizeStory` carries the declarations through the localized story so the replay factory receives the same unlock and location data in both languages. The existing ending routes and first dialogue location are unchanged.

The Demo keeps one durable main engine and one temporary replay engine. Autosave, slot management, locale replacement, and new-game reset observe only the main engine. The existing view clock and audio subscription follow the active engine. Starting replay uses `createNovelReplayEngine` with the public main snapshot; leaving disposes the replay engine and restores the view's prior title/gallery state. Replay updates never write the main autosave.

The gallery intersects the main metadata's `musicIds` with the consumer's registered audio cue IDs. The shared `music-preview` overlay carries both replay soundtrack intents and explicit user previews. It pauses the existing `music` player, starts the overlay through the same native adapter, then stops the overlay and resumes the original `music` player. Resuming never calls `media.audio.play` for the main cue, so it keeps the main playhead. An explicit preview temporarily takes priority over replay music; stopping it restores the latest replay cue. Both music channels use the music gain group and count as two native channels at most.

The audio adapter assigns a monotonically unique transport playback ID for each voice start and maps accepted host facts back to the engine's voice token. This rejects a delayed completion from the main engine if that same main voice token becomes current again after a replay. Transient effects, glyph sounds, voice play requests, and explicit preview starts send `restart: true` so a reused decoded native player starts the sample at its beginning. Persistent loop music and volume/resume requests do not send that flag.

## Player acceptance

`packages/pocket_vn/test/audio.test.ts` exercises the JS adapter's main-pause / replay-music / user-preview / main-resume sequence, verifies that main music receives no replay `play` request, and proves stale voice transport IDs are rejected even when a core token is reused. `packages/pocket_vn/test/localization.test.ts` verifies stable replay-title localization and diagnostics. `demo/js/apps/lantern/story.test.ts` plays the last-train ending through the real engine, starts an isolated ending replay, and compares the main save before and after. `demo/js/tests/novel_replay_native.test.ts` drives the compiled Lantern guest through a reachable ending, gallery replay, and music preview using painted controls and the NativeSession host protocol.

`demo/integration_test/novel_replay_music_test.dart` uses the real `PocketAudioPlugin` in the running Demo host. It checks the decoded `music` and `music-preview` players, verifies the main player stays present and paused at the same position during preview, then confirms that the same main player resumes and advances after the overlay is stopped. It does not stand in for a physical-device audio-listener test; those platform runs must be reported separately from JS unit or NativeSession request evidence.

The Flutter replay-music harness now reuses `IsolatedNovelSupportDirectory`
from `novel_performance_support.dart`. It records the normal AppSupport path,
redirects the real `path_provider` AppSupport call to a fresh system temporary
directory, and checks the actual auto-save file appears there before playback
assertions. After unmounting the complete host, it checks the public
`PocketAudioPlugin.activeChannelCount` reaches zero. Teardown restores the
original path provider and deletes the test directory, so the integration run
does not write the normal Demo save store. The video overlay integration uses
the same isolation for its disk-backed quick-save and load checks. On
2026-11-08, the isolated replay-music test passed on macOS against QJBC
`9f43216420f00233df74bbf8bbb45ab75d6abc26aa19e679209d98091102bf54` and PAK
`6e5c872a953ada2bea145dca7fcabb4dc716522fbb6784fa1adaa32826fe7128`.
`/tmp/pocket-isolated-replay-music-macos.log` records the decoded main and
preview players, background/foreground resume, the main player resuming at
3356 ms, preview release, and zero audio channels after host unmount. This is
macOS evidence only, not a physical-device audio-listener result.

```sh
cd demo
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test integration_test/novel_replay_music_test.dart -d macos
```

The current focused source tests pass: `bun test packages/pocket_vn/test/audio.test.ts packages/pocket_vn/test/localization.test.ts packages/pocket_vn/test/replay.test.ts` reports **30 passed / 0 failed**, and the Lantern `story.test.ts` reports **9 passed / 0 failed**. NativeSession and Flutter integration require a freshly built final Lantern QJBC/PAK that contains the replay and preview UI; report only the platforms actually run against that artifact.

## Public model theater and title shortcut

A replay entry without `unlockEndingId` is public. Lantern uses that existing
semantics for `model_showcase`, with authored scene/choice/jump instructions
for its model menu and animation selection. The original ending routes and
instruction indices are preserved. `NovelView.featuredReplayId` optionally
promotes one declared, unlocked replay to a title-page image button; its
label comes from the same localized replay title and its action is the same
`onReplayStart(entry.id)` used by the gallery. Invalid or locked IDs produce
no shortcut. Consumers that omit the prop retain their existing title menu.

There is no new model-gallery document, unlock store, interpreter, paused
presentation clock or native animation policy. `NovelAssets.models`, the
existing Editor replay-entry editor and scene model inspector remain the
single authoring path. The browser Editor still cannot render the live
Cubism model; the actual Guest is the model-preview acceptance surface.

The retained parent `mini_apps/app_ui_showcase.js` gallery index and
`lib/render/pocket_ui_components.dart:1774` carousel do not provide model
lifetime or isolated replay behavior. This feature adapts the existing Pocket
VN replay integration described above instead of migrating another UI tree.

Hiyori is explicitly an official sample, separate from the original Lantern
cast. Its local preparation, exact source and terms are documented with the
Demo's `scripts/prepare_live2d.ts`; the original model is generated into an
ignored project cache, with the MOC copied only into generated native model
outputs. Its inclusion for local evaluation does not establish publication
rights for a game or an expandable engine/container.


The model theater now puts each of its six selected motions into an ordinary
short `say` display state before returning to the action directory. This
prevents the four-action choice panel from covering the actor's body while
it animates. The six stable dialogue IDs are `model_showcase_{mira_idle,
mira_alert,mira_settle,hiyori_idle_0,hiyori_idle_1,hiyori_tap_body}_display`,
with Chinese and English text. They use the same replay engine, stage intent,
clock and tap-to-continue interaction; no separate showcase controller is
introduced. The original main narrative remains unchanged.


On the frozen final QJBC `f4b9e519…` / PAK `0dafa7fa…`, all six new display
lines and return-to-catalog controls also pass actual NativeSession pointer
input in `sdk/.pocket-build/novel_display_action_acceptance.ts`. This validates
compiled story/text flow only; NativeSession does not supply Cubism Core.
The separate macOS and iOS full-Demo default-FFI tests validate actual model
rendering, motion, lifecycle, release and main-save isolation. Final existing
full-route/viewport/replay native regressions pass as well (3 tests / 96
assertions); the main-route maximum save payload is 52,845 bytes.
