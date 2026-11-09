# Pocket VN localization

## Source-first review

Before adding the player switch and Editor workflow, I checked the retained parent project at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` and excluded `pocket_host/` as required. The retained project contains the Flutter demo shell (`lib/main.dart`, `lib/render/pocket_ui_components.dart`, and `lib/ui/mini_app_host_page.dart`), the browser preview, and the `mini_apps/` source tree. Searches for visual novels, language selectors, localization catalogs, story translations, and translation import/export found no corresponding behavior. Matches for “translation” were only rendering/coordinate terminology in `lib/render/pocket_ui_components.dart`, `lib/core/ffi_bridge.dart`, and `mini_apps/syslib/pocket_syslib_router.js`.

There is no parent VN translation system to migrate. The adaptation uses the existing Pocket VN `StoryLocaleCatalog` and `localizeStory()` implementation, whose stable IDs keep translations separate from executable story flow. Player language selection remains JS-owned and replaces the same `NovelEngine` instance through the app owner; Editor persists one canonical locale document alongside the story and asset registry.

## Canonical data and runtime API

Projects store every catalog in `novel.locales.json`:

```json
{
  "format": "pocket-vn-locales",
  "formatVersion": 1,
  "catalogs": {
    "en": {
      "format": "pocket-vn-locale",
      "formatVersion": 1,
      "locale": "en",
      "lines": { "arrival_01": "The harbor is quiet." },
      "speakers": { "Mira": "Mira" },
      "choices": { "arrival_approach": { "prompt": "Where next?", "options": { "listen_mira": "Ask Mira." } } },
      "endings": { "truth_letter": "The letter arrives." },
      "ui": { "player.menu": "Journal" }
    }
  }
}
```

This document is the only translation source. Text maps use stable `say.id`, speaker name, `choice.id`, option ID, ending ID, and Pocket player UI keys. Existing `assets` overrides select other keys in `novel.assets.json`; they do not contain filesystem paths. The editor presents background, character expression, CG, audio, and CG title overrides as structured controls.

`parseStoryLocaleCatalogCollection()` validates the envelope and unique locale tags; `serializeStoryLocaleCatalogCollection()` emits it. Catalog parsing rejects non-JSON values and unknown structure. Blank text is considered missing: it falls back to the source display string and is reported during proofreading. Placeholder diagnostics compare exact names and repetition counts for dialogue, choices, endings, UI text, and explicit CG titles.

`NOVEL_UI_DEFAULT_MESSAGES` exports the Pocket player shell's 69 required UI keys and Chinese fallback copy. `localizeStory(story, catalogs, locale, options)` returns the localized `story`, `assetOverrides`, full fallback-resolved `ui` map, and diagnostics. The view receives `locale`, `{ id, label }[]` in `locales`, `onLocale(locale)`, and the resolved `ui` map. The owner changes locale, creates the same engine over the localized definition, rebases its existing save, and replaces the engine. The view does not keep a separate locale or story state.

The Demo English catalog has translations for all 69 required player UI keys. App-provided title and subtitle remain owner-supplied strings, so each application can localize its own branding without adding app-specific keys to the shared player catalog.

## Save rebase on language change

`rebaseNovelSaveDataForLocale(save, sourceStory, targetStory)` returns a new save and keeps story ID/version, execution location, variables, meta progress, stage, audio intents, preferences, pause state, timers, choices, call stack, backlog cursors, and rollback state. It replaces active dialogue, backlog, choices, ending text, and completed rollback dialogue with strings from the target definition. Partial dialogue reveal progress is kept as a fraction of the old and new code-point lengths; a fully revealed line stays complete. Choice timer and auto-advance remaining time are preserved.

Backlog entries predate per-line variable snapshots. The rebase helper recovers placeholder values by matching each rendered entry against the current locale's stable source template, which preserves historical values when that match is unambiguous. If a template has ambiguous placeholder boundaries, it falls back to the save's current variable values. Adding historical variable snapshots would require a save-format change and is not part of this locale-only adaptation. Rollback checkpoints already retain their own variable snapshot, so their translations use the exact checkpoint values.

Transient voice playback facts are not part of saves. The engine reconstructs the current voice request from the localized story, and the view shows “replay voice” only while the matching voiced line is active. Changing locale does not restart unrelated BGM intents.

## Editor workflow and API

The `文本本地化` panel is an independent module mounted by the existing editor. It reads the main editor's current `StoryDefinition` and asset registry for diagnostics, but translation edits do not enter story undo history or mutate `story.json`. It supports adding locales, fallback selection, stable-ID editing for dialogue/speakers/choices/endings/UI strings, registered media-key overrides, CG title overrides, diagnosis, and JSON import/export for either one catalog or the complete collection. Clicking a diagnostic scrolls to and focuses its matching field.

The backend exposes:

- `GET /api/projects/:id/novel/locales`: canonical collection, player UI defaults, and per-locale diagnostics.
- `PUT /api/projects/:id/novel/locales`: atomically replaces only `novel.locales.json` after strict structural validation. Missing or placeholder-mismatched translations are returned as diagnostics and remain editable; invalid JSON/catalog structure does not replace the last valid file.
- `POST /api/projects/:id/novel/locales/diagnostics`: checks the client's current unsaved story, assets, and locale collection. It is read-only and does not increment the project revision.
- `GET /api/projects/:id/novel/novel-localization.js`: the panel module loaded by the editor.

The route accepts no caller-selected file path. `novel.locales.json` must be a regular, confined project file, and writes use a same-directory temporary file plus atomic rename. The existing server project-write reservation and revision hook applies to successful collection writes; diagnostics do not mark source as changed.

## Validation

Executed in the SDK workspace with Bun 1.3.9:

```sh
cd sdk
bun test packages/pocket_vn/test/localization.test.ts packages/pocket_vn/test/localization_save.test.ts editor/test/novel.test.ts editor/test/novel_localization_browser.test.ts
```

Result: **18 tests passed, 0 failed, 56 assertions**. Coverage includes strict collection parsing, UI fallback/placeholders, real `createNovelEngine.load()` after locale rebase, partial reveal progress, historical backlog placeholders, variables/meta/timers/choice/ending/rollback preservation, atomic canonical writes, symlink rejection, invalid import preservation, read-only draft diagnostics, revision changes, and a real Playwright Chromium edit/save/export/import/missing-field navigation workflow. The browser test confirms that `story.json` remains byte-for-byte unchanged.

`novel_graph_browser.test.ts` additionally exercised the tab's dynamic module import, mount, disposer, and CSS loading in Chromium. The Demo's actual QJBC/native test exercised the player locale switch and English UI, preserved the same dialogue line and auto-wait, replayed the current voice with a fresh playback token, and confirmed unrelated music did not restart; that integration test is owned by the Demo/root workflow.

## Current boundaries

- Catalog warnings do not silently block authoring: semantic translation defects remain visible and can be saved for later correction. Structural invalid imports are rejected without replacing the canonical file.
- Localization chooses only assets already registered in `novel.assets.json`; it does not copy or discover arbitrary files.
- Historical backlog text cannot always reconstruct old placeholder values because existing saves do not store a variable snapshot per line. Unambiguous values are preserved from rendered text; ambiguous cases use current save variables as described above.
- The title/subtitle, voice playback facts, media host behavior, and per-app language persistence remain the application owner's responsibility. The Pocket view only exposes the callback and current engine facts.

## Fresh guest and input recovery

The final QJBC acceptance starts a fresh guest with a canonical autosave and
English locale preference, clicks Continue, restores the same line in English,
and confirms that a keyboard CIRCLE press reveals the whole line. Title and
journal overlays share a single open-to-closed focus restoration effect using
the existing remembered FocusTarget. This replaces the duplicate imperative
menu-close restoration and covers both title Continue and in-game Load; it
does not add a keyboard listener or a per-frame focus poll. The native full
story, keyboard and viewport regressions also pass after this change.
